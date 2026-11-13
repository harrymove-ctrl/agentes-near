import { type AgentScope, DESKTOP_TEXT_PROTOCOL } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { recordOperatorEvent } from "./operator-events";
import type { Stream } from "./streams";

/**
 * Screening of people in control of an agent's screen on agentes.chat Cloud (ADR 0076), made only with
 * `SESSION_SCREENING`. While a control stream is open, the computer reads the screen's text every
 * `SESSION_SCREEN_MS` (`desktop.text`: tesseract there, never an image). The text stays in this process's memory,
 * in segments of at most `SESSION_SEGMENT_MS`, each dropped `SESSION_KEEP_MS` after it ends, read or not; nothing
 * of it goes to the database. A segment that read something ends with a `desktop_control.ended` event (ids,
 * times, a count), and its text leaves only through the operator API's review door (`operator-review.ts`).
 */

export const SESSION_SCREEN_MS = 30_000;
export const SESSION_SEGMENT_MS = 10 * 60_000;
export const SESSION_KEEP_MS = 10 * 60_000;
/** A segment keeps its first screen and the latest ones, this much text at most. */
export const SESSION_SEGMENT_MAX_BYTES = 48_000;
/** A capture, tesseract's 10 s at most, and the desktop helper's start after a while unused. */
const READ_TIMEOUT_MS = 30_000;
/** Refusals that say a computer can't read its screen (no tesseract, desktop use off, its desktop helper down). */
const CANT_READ = new Set(["desktop_unavailable", "not_allowed", "exec_disabled"]);

export interface ScreenText {
  at: number;
  text: string;
}

/** One screened stretch of a person's control. */
export interface SessionSegment {
  id: string;
  orgId: string;
  agentId: string;
  /** Who was in control. */
  userId: string;
  startedAt: number;
  endedAt: number | null;
  /** The first screen, then the latest ones. */
  screens: ScreenText[];
  /** Screens read, those let go to stay within `SESSION_SEGMENT_MAX_BYTES` included. */
  read: number;
  bytes: number;
}

export interface SessionScreeningDeps {
  db: Database;
  hub: Pick<MachineCaller, "call" | "status">;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
  /** Tests: the clock, and the timer (what it runs is awaited). */
  now?: () => number;
  later?: (ms: number, run: () => Promise<void>) => () => void;
}

/** A control stream being screened. */
interface Watch {
  stream: Stream;
  machineId: string;
  agent: AgentScope;
  segment: SessionSegment;
  /** The read in flight, which the stream's close waits for. */
  reading: Promise<void> | null;
  cancel: (() => void) | null;
}

const timer = (ms: number, run: () => Promise<void>) => {
  const t = setTimeout(() => void run(), ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export function createSessionScreening(deps: SessionScreeningDeps) {
  const now = deps.now ?? Date.now;
  const later = deps.later ?? timer;
  const watches = new Map<string, Watch>();
  const segments = new Map<string, SessionSegment>();
  /** Computers already logged as unable to read their screens. */
  const told = new Set<string>();

  function tell(machineId: string, message: string, reason?: string) {
    if (told.has(machineId)) return;
    told.add(machineId);
    deps.log?.warn(message, { machineId, ...(reason ? { reason } : {}) });
  }

  function begin(stream: Stream): SessionSegment {
    const segment: SessionSegment = {
      id: Bun.randomUUIDv7(),
      orgId: stream.orgId,
      agentId: stream.agentId,
      userId: stream.userId,
      startedAt: now(),
      endedAt: null,
      screens: [],
      read: 0,
      bytes: 0,
    };
    segments.set(segment.id, segment);
    return segment;
  }

  /**
   * One that read nothing goes at once; the others `SESSION_KEEP_MS` from now, after their event. Never throws:
   * a read that ends a segment must still schedule the next one.
   */
  async function end(segment: SessionSegment) {
    const endedAt = now();
    segment.endedAt = endedAt;
    if (segment.read === 0) {
      segments.delete(segment.id);
      return;
    }
    later(SESSION_KEEP_MS, async () => {
      segments.delete(segment.id);
    });
    try {
      await recordOperatorEvent(deps.db, {
        type: "desktop_control.ended",
        orgId: segment.orgId,
        userId: segment.userId,
        data: {
          agentId: segment.agentId,
          segmentId: segment.id,
          startedAt: new Date(segment.startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          screens: segment.read,
        },
      });
    } catch (error) {
      deps.log?.warn("session screening: a segment's event wasn't recorded", {
        segmentId: segment.id,
        error: String(error),
      });
    }
  }

  /** A screen's text unless it is the last one kept; past the size, the ones after the first go. */
  function keep(segment: SessionSegment, raw: string) {
    const text = raw.trim();
    if (!text || segment.screens.at(-1)?.text === text) return;
    segment.screens.push({ at: now(), text });
    segment.read++;
    segment.bytes += Buffer.byteLength(text);
    while (segment.bytes > SESSION_SEGMENT_MAX_BYTES && segment.screens.length > 2) {
      const [gone] = segment.screens.splice(1, 1);
      if (gone) segment.bytes -= Buffer.byteLength(gone.text);
    }
  }

  function schedule(w: Watch) {
    // The stream can close while a read waits for the ended segment's event: no read after the close.
    if (!watches.has(w.stream.id)) return;
    w.cancel = later(SESSION_SCREEN_MS, () => {
      w.cancel = null;
      w.reading = read(w).finally(() => {
        w.reading = null;
      });
      return w.reading;
    });
  }

  async function read(w: Watch) {
    try {
      const reply = await deps.hub.call<"desktop.text">(
        w.machineId,
        { op: "desktop.text", agent: w.agent },
        { timeoutMs: READ_TIMEOUT_MS },
      );
      if ("text" in reply) keep(w.segment, reply.text);
    } catch (error) {
      // A failure misses this screen only, and the reads go on: a refusal can pass (the desktop helper starts again
      // on the next use), and only a read ends a segment on time.
      if (error instanceof MachineRequestError && CANT_READ.has(error.code)) {
        tell(w.machineId, "session screening: this computer can't read its screens", error.message.slice(0, 300));
      }
    }
    // Closed meanwhile: the close ends the segment, with what this read kept.
    if (!watches.has(w.stream.id)) return;
    if (now() - w.segment.startedAt >= SESSION_SEGMENT_MS) {
      const ended = w.segment;
      w.segment = begin(w.stream);
      await end(ended);
    }
    schedule(w);
  }

  return {
    /** The broker's `onReady`: a control stream starts its first segment; anything else is never read. */
    async ready(stream: Stream) {
      if (stream.request.kind !== "desktop" || stream.request.mode !== "control" || !stream.machineId) return;
      const machineId = stream.machineId;
      const [status, agent] = await Promise.all([
        deps.hub.status(machineId),
        getAgentCached(deps.db, stream.orgId, stream.agentId),
      ]);
      if (stream.closed || !status || !agent) return;
      if (status.protocol < DESKTOP_TEXT_PROTOCOL) {
        return tell(machineId, "session screening: this computer's runner is too old to read its screens");
      }
      const w: Watch = {
        stream,
        machineId,
        agent: { id: agent.id, handle: agent.handle, name: agent.name },
        segment: begin(stream),
        reading: null,
        cancel: null,
      };
      watches.set(stream.id, w);
      schedule(w);
    },

    /** The broker's `onClosed`: the stream's segment ends, once the read in flight is in. */
    async closed(stream: Stream) {
      const w = watches.get(stream.id);
      if (!w) return;
      watches.delete(stream.id);
      w.cancel?.();
      await w.reading;
      await end(w.segment);
    },

    /** A segment still kept (open, or ended less than `SESSION_KEEP_MS` ago), else null. */
    segment(id: string): SessionSegment | null {
      const s = segments.get(id);
      if (s && s.endedAt !== null && now() - s.endedAt >= SESSION_KEEP_MS) {
        segments.delete(id);
        return null;
      }
      return s ?? null;
    },
  };
}

export type SessionScreening = ReturnType<typeof createSessionScreening>;

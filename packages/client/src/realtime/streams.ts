import type { ActiveRun, BrowserProfileWait, ChannelEvent, Message, RunStatus } from "../api/types";
import { isMediaAfterReply } from "../lib/media";
import { NO_AI } from "../lib/no-ai";

/** Failures whose card in the conversation is all there is to say: no AI, or the person at their limit (ADR 0141). */
const carded = (error: string | undefined) => error === NO_AI || error === "person_limit";

/**
 * Live agent runs per channel, from `agent.run`, `agent.thinking` / `agent.typing` (`running`: it writes),
 * `agent.tool`, `agent.idle` and `run.finished`. What it writes never shows while it works: its reply shows whole,
 * once, when `message.created` (with `agentRunId`) posts it, so nothing on screen appears and then changes. A server
 * from before that still sends `agent.delta`: it only says the agent writes.
 *
 * A row can also start *before* the server says anything: right after you
 * mention an agent, `expectReply` adds a provisional "thinking" row that the
 * first real event for that agent and thread replaces.
 */
export type LiveStatus = RunStatus | "thinking";

/** `agent.run.steered`: a new message went into this run (one active run per agent and conversation). */
export interface RunSteeredEvent {
  type: "agent.run.steered";
  channelId: string;
  runId: string;
  /** The run's agent (receipts: it is on this message now). */
  agentId?: string;
  messageId: string;
  /** Sent with "Parar e mandar": the run stops its current step and reads it now. */
  now?: boolean;
  /** The new message asked it to stop: the run is wrapping up (may come in a second event). */
  stop?: boolean;
  /** Into a run waiting for its computer: in line for room (`queued`) or for it to come back (`away`). */
  computer?: "queued" | "away" | "line";
  /** Into a run waiting on its plan's limit or its budget. */
  usage?: "plan" | "budget";
}

/** `agent.run.read`: the run read these messages sent while it worked ("Leu seu recado"). */
export interface RunReadEvent {
  type: "agent.run.read";
  channelId: string;
  threadId: string | null;
  runId: string;
  agentId: string;
  messageIds: string[];
}

/** `run.continued`: "Continuar" under the stopped reply `messageId`; `newRunId` picks up where `runId` stopped. */
export interface RunContinuedEvent {
  type: "run.continued";
  channelId: string;
  threadId: string | null;
  agentId?: string;
  runId: string;
  newRunId: string;
  messageId: string;
}

/** `run.canceled` (expected from the backend with `POST …/runs/{id}/cancel`). */
export interface RunCanceledEvent {
  type: "run.canceled";
  channelId: string;
  threadId: string | null;
  runId: string;
  agentId: string;
  /** Who stopped it. */
  byUserId?: string | null;
}

/** Pressed "Parar": "Parando…" until the event, and who stopped it ("Interrompido por Walter"). */
export function markStopping(state: StreamsState, runId: string, byUserId: string): StreamsState {
  const r = state.runs[runId];
  if (!r) return state;
  return { ...state, runs: { ...state.runs, [runId]: { ...r, stopping: true, canceledBy: byUserId } } };
}

/** The cancel failed: back to running. */
export function unmarkStopping(state: StreamsState, runId: string): StreamsState {
  const r = state.runs[runId];
  if (!r) return state;
  return { ...state, runs: { ...state.runs, [runId]: { ...r, stopping: false, canceledBy: null } } };
}

/** Stopped: its row goes. What it wrote, and who stopped it, come whole in the message the server posts for it. */
function cancel(state: StreamsState, runId: string): StreamsState {
  if (!state.runs[runId]) return state;
  const { [runId]: _gone, ...runs } = state.runs;
  return { ...state, runs };
}

/**
 * How much later than a row's own count the server's must be for the row to take it: more than a slow read's delay
 * or two clocks' drift within one stretch of work, less than any wait worth counting again.
 */
export const WORK_MISSED_MS = 5000;

/** When the work a run is doing now began, by this device's clock: what "thinking for …" counts from. */
export const workingSinceOf = (run: Pick<LiveRun, "startedAt" | "workingSince">): number | undefined =>
  run.workingSince ?? run.startedAt;

export interface LiveRun {
  /** When a provisional row was added (for the safety timeout). */
  since?: number;
  /** When this client first saw the run (places the live row by time in the timeline). */
  startedAt?: number;
  /**
   * When the work it is doing now began, by this device's clock: what "thinking for …" counts from
   * (`workingSinceOf`). Set when its row opens (and again each time it reopens: after it posted, waited, was approved)
   * and never moved back by a later read of the server (`reconcileRuns`), so leaving the conversation and coming back
   * keeps the count.
   */
  workingSince?: number;
  /** The message that started it (its live row goes right after it). */
  triggerMessageId?: string | null;
  /** Last event seen for this run (a run silent for minutes may be orphaned on the server). */
  lastEventAt?: number;
  runId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  status: LiveStatus;
  error?: string;
  /** `run.finished`'s code for the error (`run.org_paused`…) and its values. */
  errorCode?: string;
  errorParams?: Record<string, string>;
  /** Added by the client on send; no server event yet. */
  provisional?: boolean;
  /** The tool it is calling right now ("github_list_prs"), from `agent.tool`. */
  tool?: string | null;
  /** The app of that tool, when the event names it ("GitHub"). */
  connector?: string | null;
  /** Its service and a custom server's own icon, when the event names them (see `toolActivity`). */
  service?: string | null;
  serviceIcon?: string | null;
  /** What the tool works on, when the event says (the skill name for `load_skill`). */
  toolDetail?: string | null;
  /**
   * Its step as the brain says it: the words it wrote before its latest call (`said`), or a call of the computer
   * brain's own that no `agent.tool` told (`tool`, `agent.step`). The next call replaces it.
   */
  step?: LiveStep;
  /** "Parar" was pressed and the server hasn't confirmed yet. */
  stopping?: boolean;
  /** Its browser command waits for a shared profile someone else has (ADR 0110). */
  browserWait?: BrowserProfileWait | null;
  /** Who pressed "Parar" (user id), until the server confirms. */
  canceledBy?: string | null;
  /** The code the agent is running (`run_code`, a skill script), from `agent.tool`. */
  code?: LiveCode | null;
  /**
   * The run's live work, in order: each tool call (with its code and output) and each message sent while it worked
   * that it read. Never its words: its saved reply keeps these steps where the reply shows them.
   */
  work?: LiveWork[];
  /** That call's output so far (`agent.tool.output`), in order. */
  output?: LiveOutput[];
  /** Messages sent with "Parar e mandar" it hasn't read yet. */
  steerNow?: string[];
}

export interface LiveStep {
  said?: string;
  tool?: string;
}

export type LiveWork =
  /**
   * The running task read a message sent while it worked ("Leu seu recado"); `now`: it stopped
   * to read it ("Parou para ler seu recado").
   */
  | { kind: "steer"; messageId: string; now?: boolean }
  | {
      kind: "call";
      id: string;
      tool: string;
      connector: string | null;
      service?: string | null;
      serviceIcon?: string | null;
      detail: string | null;
      code: LiveCode | null;
      output: LiveOutput[];
      running: boolean;
      /** When the call started (the stop confirmation says "rodando código há 2 min"). */
      since?: number;
      /** How long it took, once it ended (its line says "1,2 s"). */
      ms?: number;
      /** The tool answered with an error (`agent.tool` end with `failed`). */
      failed?: boolean;
      /** That error was its arguments refused: a later call may make it right (`toolItemsLive`). */
      slip?: boolean;
      /** It didn't run: it waits on a person (an approval, a question, a secret). */
      held?: boolean;
      /** A permission check: the whole command it checked (its line opens on it). */
      command?: string;
      /** A command the permission check refused: the policy's reason, and its code for the person's words. */
      why?: string;
      refusal?: string;
      /** A permission check waiting on a person: its request, which the person's answer names. */
      requestId?: string;
      /** A rule ("Aprovar sempre") let it run without asking: whose person, a reads one or not. */
      autoApproved?: { by: string | null; reads: boolean };
    };

export interface LiveCode {
  language: string;
  source: string;
}

export interface LiveOutput {
  stream: "stdout" | "stderr";
  text: string;
}

/** Kept per call: the newest characters of the output (older ones scroll away). */
export const OUTPUT_LIMIT = 20_000;

/** The PC's output while code runs (expected from the backend). */
export interface AgentToolOutputEvent {
  type: "agent.tool.output";
  channelId: string;
  threadId: string | null;
  runId: string;
  agentId: string;
  toolUseId?: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** Appends output, merging with the last chunk of the same stream and keeping the last OUTPUT_LIMIT chars. */
export function appendOutput(list: LiveOutput[], chunk: LiveOutput, limit = OUTPUT_LIMIT): LiveOutput[] {
  const last = list[list.length - 1];
  const next =
    last && last.stream === chunk.stream
      ? [...list.slice(0, -1), { stream: last.stream, text: last.text + chunk.text }]
      : [...list, chunk];
  let total = next.reduce((n, o) => n + o.text.length, 0);
  while (total > limit && next.length > 0) {
    const first = next[0] as LiveOutput;
    const over = total - limit;
    if (first.text.length <= over) {
      next.shift();
      total -= first.text.length;
    } else {
      next[0] = { stream: first.stream, text: first.text.slice(over) };
      total = limit;
    }
  }
  return next;
}

/**
 * "Theo está consultando o GitHub…": the tool an agent is calling. Not sent
 * by the backend yet (packages/engine/src/events.ts has no tool event); the
 * client handles it as soon as it exists. `tool: null` = the call ended.
 */
export interface AgentToolEvent {
  type: "agent.tool";
  channelId: string;
  threadId: string;
  runId: string;
  agentId: string;
  tool: string | null;
  connector?: string | null;
  /** The service it works in (`gmail`, `github`, `postgres`…) and a custom server's own icon, for its logo. */
  service?: string | null;
  serviceIcon?: string | null;
  /** E.g. the skill being opened by `load_skill`. */
  detail?: string | null;
  /** On the start: what the agent wrote right before this call, as one short line. */
  said?: string | null;
  /** The code it runs (`run_code`, skill scripts), expected from the backend. */
  code?: LiveCode | null;
  /** `permission_prompt`: the whole command it checks (credentials masked). */
  command?: string | null;
  toolUseId?: string;
  /** On the end (`tool: null`): the tool answered with an error. */
  failed?: boolean;
  /** On a failed end: its arguments were refused, the tool never ran. */
  slip?: boolean;
  /** On the end: it didn't run, it waits on a person. */
  held?: boolean;
  /** On the end: a rule ("Aprovar sempre") let it run without asking. */
  autoApproved?: { by: string | null; reads: boolean } | null;
  /** On the end of a permission check that refused its command: the policy's reason, and its code. */
  why?: string | null;
  refusal?: string | null;
  /**
   * A permission check waiting on a person: on its `held` end, its request; with no `toolUseId`, the person's
   * answer to that request (`failed` when they said no), which ends the line that waited for it.
   */
  requestId?: string | null;
}

/** A computer brain's own call (Claude Code's Read, Codex's shell) that ended with no `agent.tool`: its step line. */
export interface AgentStepEvent {
  type: "agent.step";
  channelId: string;
  threadId: string;
  runId: string;
  agentId: string;
  tool: string;
  said?: string | null;
}

export interface StreamsState {
  runs: Record<string, LiveRun>;
  /** Runs heard to stop, and when: late deltas for them are ignored. */
  finished: Record<string, number>;
  /** A routine's runs working in the background: never a row, never "trabalhando" (`isBackgroundEvent`). */
  background?: Record<string, true>;
  /** Runs whose message came without its body (too big for its event): it is on its way over HTTP. */
  landing?: Record<string, true>;
}

export const emptyStreams: StreamsState = { runs: {}, finished: {} };

const provisionalId = (agentId: string, threadId: string) => `pending:${agentId}:${threadId}`;

/** The message a "pensando…" answers: the one that asked in a thread, or the top-level one it hangs off. */
export const guessedFrom = (r: Pick<LiveRun, "threadId" | "triggerMessageId">) => r.triggerMessageId ?? r.threadId;

/**
 * Shows "Ada está pensando…" right away for an agent that was mentioned or picked. `messageId`: a reply, whose row
 * lives in its thread (`threadId`) and hangs off the message that asked.
 */
export function expectReply(
  state: StreamsState,
  event: { channelId: string; threadId: string; agentId: string; messageId?: string },
  now = Date.now(),
) {
  const input = { channelId: event.channelId, threadId: event.threadId, agentId: event.agentId };
  const runId = provisionalId(input.agentId, input.threadId);
  const alreadyLive = Object.values(state.runs).some(
    (r) => !r.provisional && r.agentId === input.agentId && r.threadId === input.threadId,
  );
  if (alreadyLive || state.runs[runId]) return state;
  const run: LiveRun = {
    ...input,
    runId,
    status: "thinking",
    provisional: true,
    since: now,
    startedAt: now,
    workingSince: now,
    ...(event.messageId && event.messageId !== input.threadId ? { triggerMessageId: event.messageId } : {}),
  };
  return { ...state, runs: { ...state.runs, [runId]: run } };
}

/** Drops the provisional row of an agent/thread once the server reports on it. */
function settleProvisional(state: StreamsState, agentId: string, threadId: string): StreamsState {
  const id = provisionalId(agentId, threadId);
  if (!state.runs[id]) return state;
  const { [id]: _p, ...runs } = state.runs;
  return { ...state, runs };
}

/**
 * A run of this agent stopped (idle, finished): its "pensando…" goes too. A
 * flat reply (DMs: no thread) answers the latest messages, whatever thread we
 * guessed, so every provisional row of the agent in that channel goes.
 */
function settleAfterRun(
  state: StreamsState,
  event: { agentId: string; channelId: string; threadId: string | null },
): StreamsState {
  if (event.threadId) return settleProvisional(state, event.agentId, event.threadId);
  const runs = Object.fromEntries(
    Object.entries(state.runs).filter(
      ([, r]) => !(r.provisional && r.agentId === event.agentId && r.channelId === event.channelId),
    ),
  );
  return Object.keys(runs).length === Object.keys(state.runs).length ? state : { ...state, runs };
}

function upsert(
  state: StreamsState,
  event: { runId: string; agentId: string; channelId: string; threadId: string },
  patch: Partial<LiveRun>,
) {
  // A flat run (DMs: thread null) answers whatever message we guessed: any "pensando…" of the agent
  // there is its own. Kept, it held the first block and hid this run's (its browser card) all run long.
  const provisional = event.threadId
    ? state.runs[provisionalId(event.agentId, event.threadId)]
    : Object.values(state.runs).find(
        (r) => r.provisional && r.agentId === event.agentId && r.channelId === event.channelId,
      );
  let base = settleAfterRun(state, event);
  // A new run of the same agent in the channel: its earlier failure is old news, not the latest word.
  if (!base.runs[event.runId] && patch.status !== "failed") {
    for (const r of Object.values(base.runs)) {
      if (r.status === "failed" && r.agentId === event.agentId && r.channelId === event.channelId) {
        base = finish(base, r.runId);
      }
    }
  }
  // Partial: under some tsconfigs the index type isn't `| undefined`, and the spread below must stay optional.
  const current: Partial<LiveRun> | undefined = base.runs[event.runId];
  const next: LiveRun = {
    runId: event.runId,
    agentId: event.agentId,
    channelId: event.channelId,
    threadId: event.threadId,
    status: "running",
    startedAt: provisional?.startedAt ?? Date.now(),
    // A row that opens now counts from now, or from the message I sent that it answers; one already open keeps its
    // count (`current`, below).
    workingSince: provisional?.workingSince ?? provisional?.startedAt ?? Date.now(),
    // A "pensando…" row hangs off the message I sent: that message started the run.
    ...(provisional ? { triggerMessageId: guessedFrom(provisional) } : {}),
    ...current,
    ...patch,
  };
  return { ...base, runs: { ...base.runs, [event.runId]: next } };
}

/** A run resumed after an approval streams again, from a fresh text. */
function reopen(state: StreamsState, runId: string): StreamsState {
  if (!state.finished[runId]) return state;
  const { [runId]: _f, ...finished } = state.finished;
  return { ...state, finished };
}

type StreamEvent =
  | ChannelEvent
  | AgentToolEvent
  | AgentStepEvent
  | AgentToolOutputEvent
  | RunCanceledEvent
  | RunSteeredEvent
  | RunReadEvent
  | RunContinuedEvent;

/**
 * A routine's background run holds no conversation: the events that say so (`background: true`)
 * mark its run, and nothing about a marked run makes or keeps a row. Null: not a background run's.
 */
function backgroundRun(state: StreamsState, event: StreamEvent): StreamsState | null {
  const runId = "runId" in event && typeof event.runId === "string" ? event.runId : null;
  if ((event as { background?: unknown }).background !== true) {
    return runId && state.background?.[runId] ? state : null;
  }
  // Announced at post time (no run yet): no "pensando…" for it either.
  if (!runId || state.background?.[runId]) return state;
  const { [runId]: _row, ...runs } = state.runs;
  return { ...state, runs, background: { ...state.background, [runId]: true } };
}

export function applyChannelEvent(state: StreamsState, event: StreamEvent, now = Date.now()): StreamsState {
  const quiet = backgroundRun(state, event);
  if (quiet) return quiet;
  const next = applyEvent(state, event);
  // Any news about a run keeps it "alive" (see `isQuiet`).
  const runId = "runId" in event && typeof event.runId === "string" ? event.runId : null;
  const r = runId ? next.runs[runId] : undefined;
  if (!runId || !r || r.provisional || (next === state && r.lastEventAt !== undefined)) return next;
  return { ...next, runs: { ...next.runs, [runId]: { ...r, lastEventAt: now } } };
}

function applyEvent(state: StreamsState, event: StreamEvent): StreamsState {
  switch (event.type) {
    case "agent.run.steered": {
      // It joined a run under way, one that may be waiting with no row of its own: no new reply comes, so no
      // "pensando…" for it. By channel: the guess may still hang off the optimistic message.
      const s = event.agentId
        ? settleAfterRun(state, { agentId: event.agentId, channelId: event.channelId, threadId: null })
        : state;
      // Only noted here: it shows in the work once read (`agent.run.read`), under the message until then.
      const r = s.runs[event.runId];
      if (!r) return s;
      if (event.stop) return { ...s, runs: { ...s.runs, [event.runId]: { ...r, stopping: true } } };
      if (!event.now || r.steerNow?.includes(event.messageId)) return s;
      const steerNow = [...(r.steerNow ?? []), event.messageId];
      return { ...s, runs: { ...s.runs, [event.runId]: { ...r, steerNow } } };
    }
    case "agent.run.read": {
      const r = state.runs[event.runId];
      if (!r) return state;
      const seen = new Set((r.work ?? []).flatMap((w) => (w.kind === "steer" ? [w.messageId] : [])));
      const fresh = event.messageIds.filter((id) => !seen.has(id));
      if (fresh.length === 0) return state;
      // What it wrote stays where it is: the reply goes on from it, and the saved message holds both.
      const work: LiveWork[] = [
        ...(r.work ?? []),
        ...fresh.map((messageId) => ({
          kind: "steer" as const,
          messageId,
          ...(r.steerNow?.includes(messageId) ? { now: true } : {}),
        })),
      ];
      const steerNow = (r.steerNow ?? []).filter((id) => !fresh.includes(id));
      return { ...state, runs: { ...state.runs, [event.runId]: { ...r, work, steerNow } } };
    }
    case "run.continued": {
      // The stopped row (if still here) gives way to the run that picks up, a normal live run.
      const s = state.runs[event.runId] ? finish(state, event.runId) : state;
      if (s.runs[event.newRunId] || s.finished[event.newRunId] || !event.agentId) return s;
      // Flat conversations (DMs) have no thread: `null`, like the run's other events.
      const where = { channelId: event.channelId, threadId: event.threadId as string, agentId: event.agentId };
      return upsert(s, { ...where, runId: event.newRunId }, { status: "thinking", triggerMessageId: event.messageId });
    }
    case "run.canceled":
      return cancel(state, event.runId);
    case "agent.tool": {
      if (state.finished[event.runId]) return state;
      const current = state.runs[event.runId];
      // A new call starts fresh; `tool: null` (the call ended) keeps the last code and output on screen.
      const newCall = event.tool !== null;
      let work = current?.work ?? [];
      const end = (
        w: Extract<LiveWork, { kind: "call" }>,
        how: Pick<AgentToolEvent, "failed" | "slip" | "held" | "why" | "refusal" | "requestId" | "autoApproved"> = {},
      ) => ({
        ...w,
        running: false,
        ...(w.since !== undefined ? { ms: Math.max(0, Date.now() - w.since) } : {}),
        ...(how.failed ? { failed: true } : {}),
        ...(how.slip ? { slip: true } : {}),
        ...(how.held ? { held: true } : {}),
        ...(how.why ? { why: how.why } : {}),
        ...(how.refusal ? { refusal: how.refusal } : {}),
        ...(how.requestId ? { requestId: how.requestId } : {}),
        ...(how.autoApproved ? { autoApproved: how.autoApproved } : {}),
      });
      if (!newCall && event.requestId && !event.toolUseId) {
        // A person's answer to a command that waited on them: the line that waited ends as they decided.
        const waited = (w: LiveWork) => w.kind === "call" && w.held === true && w.requestId === event.requestId;
        if (!work.some(waited)) return state;
        work = work.map((w) => (w.kind === "call" && waited(w) ? end({ ...w, held: false }, event) : w));
        return upsert(state, event, { work });
      }
      if (newCall) {
        // A new call means the previous ones ended.
        work = [
          ...work.map((w) => (w.kind === "call" && w.running ? end(w) : w)),
          {
            kind: "call" as const,
            since: Date.now(),
            id: event.toolUseId ?? `call-${work.length}`,
            tool: event.tool ?? "",
            connector: event.connector ?? null,
            ...(event.service ? { service: event.service } : {}),
            ...(event.serviceIcon ? { serviceIcon: event.serviceIcon } : {}),
            detail: event.detail ?? null,
            code: event.code ?? null,
            ...(event.command ? { command: event.command } : {}),
            output: [],
            running: true,
          },
        ];
      } else {
        // The call ended: that one (by id), else the last running one.
        const named = event.toolUseId && work.some((w) => w.kind === "call" && w.id === event.toolUseId);
        let done = false;
        work = [...work].reverse().map((w) => {
          if (!done && w.kind === "call" && w.running && (!named || w.id === event.toolUseId)) {
            done = true;
            return end(w, event);
          }
          return w;
        });
        work.reverse();
      }
      return upsert(state, event, {
        // At a call or between calls, not writing: its next `agent.typing` says it writes.
        status: "thinking",
        work,
        tool: event.tool,
        connector: event.connector ?? null,
        service: event.service ?? null,
        serviceIcon: event.serviceIcon ?? null,
        toolDetail: event.detail ?? null,
        ...(newCall ? { code: event.code ?? null, output: [] } : {}),
        // A new call is the step now: its own words, or none (the call's verb says it).
        ...(newCall ? { step: event.said ? { said: event.said } : undefined } : {}),
      });
    }
    case "agent.step": {
      if (state.finished[event.runId] || !state.runs[event.runId]) return state;
      return upsert(state, event, { step: { tool: event.tool, ...(event.said ? { said: event.said } : {}) } });
    }
    case "agent.tool.output": {
      if (state.finished[event.runId]) return state;
      const current = state.runs[event.runId];
      if (!current) return state;
      const chunk = { stream: event.stream, text: event.text };
      const output = appendOutput(current.output ?? [], chunk);
      // Into its call (by id, else the last running one).
      const work = [...(current.work ?? [])];
      let at = -1;
      for (let i = work.length - 1; i >= 0; i--) {
        const w = work[i];
        if (w?.kind === "call" && (event.toolUseId ? w.id === event.toolUseId : w.running)) {
          at = i;
          break;
        }
      }
      const call = work[at];
      if (call?.kind === "call") work[at] = { ...call, output: appendOutput(call.output, chunk) };
      return { ...state, runs: { ...state.runs, [event.runId]: { ...current, output, work } } };
    }
    case "message.created": {
      const m = event.message;
      // Too big for its event, it comes as its run and thread only (read over HTTP), and ends the run all the same: its
      // block waits for that read (`landing`) instead of going blank.
      const runId = m ? m.agentRunId : event.agentRunId;
      // The sticker or GIF an agent adds after its reply (ADR 0091) ends nothing: its reply already did, and a new
      // "pensando…" stays.
      if (!runId || postedOnTheWay(state, { agentRunId: runId, meta: m?.meta }) || isMediaAfterReply(m?.meta))
        return state;
      const ended = finish(state, runId);
      const next = m ? ended : { ...ended, landing: { ...state.landing, [runId]: true as const } };
      const agentId = m ? (m.author?.type === "agent" ? m.author.id : null) : state.runs[runId]?.agentId;
      const threadId = m ? m.threadId : event.threadId;
      if (!agentId) return next;
      if (threadId) return settleProvisional(next, agentId, threadId);
      // Flat reply (DMs): it answers the latest message, whatever thread we guessed.
      const runs = Object.fromEntries(
        Object.entries(next.runs).filter(
          ([, r]) => !(r.provisional && r.agentId === agentId && r.channelId === event.channelId),
        ),
      );
      return { ...next, runs };
    }
    case "agent.run": {
      // A status update that says canceled works like `run.canceled`.
      if ((event.status as string) === "canceled") return cancel(state, event.runId);
      let s = state;
      if (s.finished[event.runId]) {
        if (event.status !== "running") return state;
        s = reopen(s, event.runId);
      }
      // Waiting (an answer, or its computer to come back) isn't working: the row goes, the avatar rests.
      if ((event.status as string) === "waiting_input") return s.runs[event.runId] ? finish(s, event.runId) : s;
      if (event.status === "done") {
        const settled = settleProvisional(s, event.agentId, event.threadId);
        return settled.runs[event.runId] ? finish(settled, event.runId) : settled;
      }
      // No AI to think with, or its person at their limit: nothing ran, and its card says why.
      if (event.status === "failed" && carded(event.error)) return finish(settleAfterRun(s, event), event.runId);
      // Started, and not writing yet (`agent.typing`): thinking.
      const current = s.runs[event.runId];
      const status: LiveStatus =
        (event.status === "running" || event.status === "queued") && current?.status !== "running"
          ? "thinking"
          : event.status;
      return upsert(s, event, {
        status,
        error: event.error,
        // Its reason in words from the first event that says it failed, never its stored code until `run.finished`.
        ...(event.errorCode ? { errorCode: event.errorCode, errorParams: event.errorParams } : {}),
        ...(event.triggerMessageId ? { triggerMessageId: event.triggerMessageId } : {}),
        ...(event.startedAt ? { startedAt: Date.parse(event.startedAt) } : {}),
        // An event that says when it started opens the row counting from there; a row already open keeps its count.
        ...(event.startedAt && !current ? { workingSince: Date.parse(event.startedAt) } : {}),
      });
    }
    case "agent.thinking": {
      // Announced at post time, before the run exists.
      if (event.runId === null) return expectReply(state, event);
      const s = reopen(state, event.runId);
      return upsert(s, { ...event, runId: event.runId }, { status: "thinking" });
    }
    case "agent.browser.waiting": {
      if (!state.runs[event.runId]) return state;
      return upsert(state, event, { browserWait: event.wait });
    }
    case "agent.typing": {
      const s = reopen(state, event.runId);
      if (s.finished[event.runId]) return state;
      return upsert(s, event, { status: "running" });
    }
    case "agent.idle": {
      const settled = settleAfterRun(state, event);
      // A failure is reported by run.finished; keep a failed row visible.
      if (settled.runs[event.runId]?.status === "failed") return settled;
      return settled.runs[event.runId] ? finish(settled, event.runId) : settled;
    }
    case "agent.passed":
      // It had nothing to add: its "pensando…" goes at once, and nothing of it comes after.
      return finish(settleAfterRun(state, event), event.runId);
    case "run.finished": {
      const settled = settleAfterRun(state, event);
      if (event.status === "failed" && carded(event.error)) return finish(settled, event.runId);
      if (event.status === "failed") {
        const { error, errorCode, errorParams } = event;
        return upsert(settled, event, { status: "failed", error, errorCode, errorParams });
      }
      // done: the message replaces the row; waiting_approval: the approval card does.
      return settled.runs[event.runId] ? finish(settled, event.runId) : settled;
    }
    case "message.routed": {
      // Agents the router didn't pick won't answer: drop their "pensando…".
      const picked = new Set(event.pickedBy);
      const runs = Object.fromEntries(
        Object.entries(state.runs).filter(
          ([, r]) => !(r.provisional && guessedFrom(r) === event.messageId && !picked.has(r.agentId)),
        ),
      );
      return Object.keys(runs).length === Object.keys(state.runs).length ? state : { ...state, runs };
    }
    case "agent.delta": {
      // From a server that still streams: its words wait for the message, the delta only says the agent writes.
      if (state.finished[event.runId]) return state;
      return upsert(state, event, { status: "running" });
    }
    default:
      return state;
  }
}

function finish(state: StreamsState, runId: string): StreamsState {
  const { [runId]: _done, ...runs } = state.runs;
  return { ...state, runs, finished: { ...state.finished, [runId]: Date.now() } };
}

/**
 * A message its run posts while it goes on working, never its reply: a fast reply (`meta.talker`), and anything posted
 * while one of its calls runs, since a tool posts inside its call (`invokeWithChip` sends the call's start before the
 * tool runs, on every brain): a card (an agent's proposal, Connect, an event), a DM, a post in another
 * channel. Taken for the run's end, it froze the row with that call still running, and dropped every later event of the
 * run. A pause (an approval, a question) ends the row with its own event.
 */
const postedOnTheWay = (state: StreamsState, m: Pick<Message, "agentRunId" | "meta">) =>
  Boolean(m.meta?.talker) ||
  Boolean(m.agentRunId && state.runs[m.agentRunId]?.work?.some((w) => w.kind === "call" && w.running));

/** No event for this long: the row says "sem notícias há 3 min · Atualizar". */
export const QUIET_AFTER_MS = 3 * 60_000;

/**
 * A live run that went silent (orphaned by a server restart, a lost socket…). One whose last call waits on a person
 * (a command's card, an approval) isn't: nothing happens until they answer, and the answer ends that call.
 */
export const isQuiet = (r: LiveRun, now = Date.now()) =>
  !r.provisional &&
  r.status !== "failed" &&
  (r.work ?? []).filter((w) => w.kind === "call").at(-1)?.held !== true &&
  now - (r.lastEventAt ?? r.startedAt ?? now) >= QUIET_AFTER_MS;

/** "Atualizar" found the run still active: quiet again for another while. */
export function touchRun(state: StreamsState, runId: string, now = Date.now()): StreamsState {
  const r = state.runs[runId];
  return r ? { ...state, runs: { ...state.runs, [runId]: { ...r, lastEventAt: now } } } : state;
}

const ACTIVE: ReadonlySet<string> = new Set(["queued", "running", "waiting_approval"]);
export const isActiveStatus = (status: string) => ACTIVE.has(status);

/**
 * The server's list of active runs in a channel is the truth: live rows it
 * doesn't know are dropped (a failed row stays until seen), and active runs
 * we never heard of get a "pensando…" row.
 *
 * "Thinking for …" (`workingSince`) never goes back for a row already here: the server's `startedAt` is the run's
 * first start, minutes before the work it is doing now when it posted or waited on the way, so taking it made the
 * count jump on every return to the conversation. A row keeps its own count, unless the server says the work began
 * well after it (`WORK_MISSED_MS`) and nothing was heard from the run since then: a new stretch began while this
 * device wasn't listening (a conversation is listened to only while it is open). A row made here counts
 * from the server's length of the work (`workingMs`), turned into this device's clock at the middle of the read.
 */
export function reconcileRuns(
  state: StreamsState,
  channelId: string,
  active: ActiveRun[],
  now = Date.now(),
  askedAt = now,
): StreamsState {
  // A routine's background runs show nowhere in the conversation.
  const known = new Set(active.filter((a) => isActiveStatus(a.status) && !a.background).map((a) => a.runId));
  let s = state;
  for (const r of runsInChannel(state, channelId)) {
    if (r.provisional || r.status === "failed" || known.has(r.runId)) continue;
    // News after we asked: the list may be older than this run.
    if ((r.lastEventAt ?? 0) > askedAt) continue;
    s = finish(s, r.runId);
  }
  for (const a of active) {
    if (!known.has(a.runId) || a.channelId !== channelId) continue;
    // Heard to stop, yet listed by a read asked since: it stopped to wait, and went on while we weren't listening.
    const stopped = s.finished[a.runId];
    if (stopped) {
      if (stopped >= askedAt || a.status === "waiting_approval") continue;
      s = reopen(s, a.runId);
    }
    const startedAt = a.startedAt ? Date.parse(a.startedAt) : undefined;
    const heartbeat = a.heartbeatAt ? Date.parse(a.heartbeatAt) : undefined;
    const served =
      typeof a.workingMs === "number" ? Math.round((askedAt + now) / 2) - Math.max(0, a.workingMs) : undefined;
    const r = s.runs[a.runId];
    if (r) {
      const mine = workingSinceOf(r);
      // Heard from the run after the moment the server counts from: this device was listening when that stretch
      // began and chose its own count (a message it took for one posted on the way), so it keeps it.
      const heardSince = served !== undefined && (r.lastEventAt ?? 0) >= served;
      const missed = served !== undefined && (mine === undefined || (served - mine > WORK_MISSED_MS && !heardSince));
      const workingSince = missed ? served : mine;
      // What the server knows better: where it started, and that it's alive.
      const lastEventAt = Math.max(r.lastEventAt ?? 0, heartbeat ?? 0) || r.lastEventAt;
      s = {
        ...s,
        runs: {
          ...s.runs,
          [a.runId]: {
            ...r,
            ...(a.triggerMessageId ? { triggerMessageId: a.triggerMessageId } : {}),
            ...(startedAt ? { startedAt } : {}),
            ...(workingSince !== undefined ? { workingSince } : {}),
            ...(lastEventAt ? { lastEventAt } : {}),
          },
        },
      };
      continue;
    }
    // Waiting for an approval: the card shows it, not a live row.
    if (a.status === "waiting_approval") continue;
    s = upsert(s, a, {
      status: "thinking",
      startedAt: startedAt ?? now,
      // A server from before `workingMs` only knows the run's first start.
      workingSince: served ?? startedAt ?? now,
      lastEventAt: now,
      ...(a.triggerMessageId ? { triggerMessageId: a.triggerMessageId } : {}),
    });
  }
  return s;
}

/** Forget a failed run after the person has seen it. */
export function dismissRun(state: StreamsState, runId: string): StreamsState {
  return finish(state, runId);
}

/**
 * Shown in the channel itself, not in a thread: a run asked there (it answers
 * there: its events carry no thread), or a "pensando…" the app guessed
 * for a message sent there (`topLevelIds`: the channel's own messages).
 */
export const inMainTimeline = (
  r: { threadId: string | null; provisional?: boolean; triggerMessageId?: string | null },
  topLevelIds: ReadonlySet<string>,
) => r.threadId === null || Boolean(r.provisional && topLevelIds.has(r.triggerMessageId ?? r.threadId));

/** Runs to show in a channel, oldest first. */
export const runsInChannel = (state: StreamsState, channelId: string) =>
  Object.values(state.runs).filter((r) => r.channelId === channelId);

/** Agents currently executing anywhere we listen to (sidebar ring). */
export const runningAgents = (state: StreamsState) =>
  new Set(
    Object.values(state.runs)
      .filter((r) => r.status === "running" || r.status === "queued" || r.status === "thinking")
      .map((r) => r.agentId),
  );

/** Provisional rows older than `maxAgeMs` (no server event since): their message ids, to resync. */
export function staleProvisional(state: StreamsState, now: number, maxAgeMs: number) {
  return Object.values(state.runs).filter((r) => r.provisional && now - (r.since ?? now) >= maxAgeMs);
}

/** Drops provisional rows of these threads. */
export function dropProvisional(state: StreamsState, threadIds: Set<string>): StreamsState {
  const runs = Object.fromEntries(
    Object.entries(state.runs).filter(([, r]) => !(r.provisional && threadIds.has(r.threadId))),
  );
  return { ...state, runs };
}

/**
 * The optimistic message got its server id: its "pensando…" rows move there. The server's run can be
 * faster than the POST answer (the run starts with the insert); then the real run already shows and the
 * guess just goes, or the conversation would show the agent twice.
 */
export function retargetProvisional(state: StreamsState, fromId: string, toId: string): StreamsState {
  const runs: Record<string, LiveRun> = {};
  for (const [id, r] of Object.entries(state.runs)) {
    if (!(r.provisional && guessedFrom(r) === fromId)) {
      runs[id] = r;
      continue;
    }
    if (r.threadId !== fromId) {
      runs[id] = { ...r, triggerMessageId: toId };
      continue;
    }
    const answered = Object.values(state.runs).some(
      (o) =>
        !o.provisional &&
        o.agentId === r.agentId &&
        o.channelId === r.channelId &&
        (o.triggerMessageId === toId || o.threadId === toId || (o.startedAt ?? 0) >= (r.since ?? 0) - 2000),
    );
    if (answered) continue;
    const moved = { ...r, threadId: toId, runId: provisionalId(r.agentId, toId) };
    runs[moved.runId] = moved;
  }
  return { ...state, runs };
}

/**
 * The living avatar of one run: writing (`running`, its words on their way) → writing; queued/thinking → thinking;
 * else idle. Waiting (an approval, an answer, or its computer to come back) is not working: idle.
 */
export function agentStateOfRun(r: LiveRun): "idle" | "thinking" | "writing" {
  if (r.status === "running") return "writing";
  if (r.status === "queued" || r.status === "thinking") return "thinking";
  return "idle";
}

/** Where the agent is working now (a run thinking or writing), or null. */
export function agentWorkingIn(state: StreamsState, agentId: string): string | null {
  for (const r of Object.values(state.runs))
    if (r.agentId === agentId && agentStateOfRun(r) !== "idle") return r.channelId;
  return null;
}

/** An agent's state across its live runs (optionally in one channel): writing beats thinking beats idle. */
export function agentStateIn(
  state: StreamsState,
  agentId: string,
  channelId?: string,
): "idle" | "thinking" | "writing" {
  let best: "idle" | "thinking" | "writing" = "idle";
  for (const r of Object.values(state.runs)) {
    if (r.agentId !== agentId || (channelId && r.channelId !== channelId)) continue;
    const s = agentStateOfRun(r);
    if (s === "writing") return "writing";
    if (s === "thinking") best = "thinking";
  }
  return best;
}

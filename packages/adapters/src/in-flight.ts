/**
 * What this process is busy with (its jobs and tool calls), in memory another thread can read while this one is
 * stuck in synchronous work: the server's freeze watch (`apps/server/src/freeze-watch.ts`). One line per operation,
 * written again on every change, so the list is whole whenever the event loop stops.
 */

/** Bytes of the list: operations past them are left out. */
const LIST_BYTES = 16 * 1024;

export interface InFlight {
  /** `job agent.run`, `tool browser_do`. */
  what: string;
  runId?: string;
  /** When it started (epoch ms). */
  since: number;
}

/** A beat (`beatInFlight`) and the list's length in bytes, as two Int32s, then the list: hand it to the reader. */
export const inFlightMemory = new SharedArrayBuffer(8 + LIST_BYTES);
const head = new Int32Array(inFlightMemory, 0, 2);
const bytes = new Uint8Array(inFlightMemory, 8);
const running = new Map<number, InFlight>();
let next = 0;

function publish() {
  let n = 0;
  for (const op of running.values()) {
    const line = `${op.since}\t${op.what}\t${op.runId ?? ""}\n`;
    if (n + line.length > LIST_BYTES) break;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      bytes[n++] = c < 128 ? c : 63;
    }
  }
  Atomics.store(head, 1, n);
}

/** `what` runs from now until the returned function is called. */
export function startInFlight(what: string, runId?: string | null): () => void {
  const id = next++;
  running.set(id, { what: what.replace(/\s+/g, " "), ...(runId ? { runId } : {}), since: Date.now() });
  publish();
  return () => {
    if (running.delete(id)) publish();
  };
}

/** One beat of this thread's event loop: a reader that sees the beats stop knows the loop is stuck. */
export function beatInFlight() {
  Atomics.add(head, 0, 1);
}

/** The beat and the list in `memory`, from any thread. */
export function readInFlight(memory: SharedArrayBuffer): { beat: number; running: InFlight[] } {
  const h = new Int32Array(memory, 0, 2);
  const text = new TextDecoder().decode(new Uint8Array(memory, 8, Atomics.load(h, 1)).slice());
  const ops = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [since = "", what = "", runId = ""] = line.split("\t");
      return { what, since: Number(since), ...(runId ? { runId } : {}) };
    });
  return { beat: Atomics.load(h, 0), running: ops };
}

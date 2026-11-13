import type { StreamSocket } from "../src";

/** An in-memory socket for the stream broker: what was sent to it, how it was closed, its backlog. */
export function fakeSocket() {
  const s = {
    sent: [] as (string | Uint8Array)[],
    closed: null as { code?: number; reason?: string } | null,
    backlog: 0,
    socket: undefined as unknown as StreamSocket,
  };
  s.socket = {
    send: (data) => {
      s.sent.push(data);
    },
    close: (code, reason) => {
      s.closed ??= { code, reason };
    },
    buffered: () => s.backlog,
    ping() {},
  };
  return s;
}
export type FakeSocket = ReturnType<typeof fakeSocket>;

export async function until(done: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 400; i++) {
    if (await done()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

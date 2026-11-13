import type { SocketFactory, SocketLike } from "../src/index";

/** A WebSocket stand-in: records what the client sends, lets tests push server frames. */
export class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  /** Server side: */
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

export function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  return { sockets, factory, last: () => sockets[sockets.length - 1] as FakeSocket };
}

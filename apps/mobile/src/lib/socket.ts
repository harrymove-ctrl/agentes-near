import type { SocketFactory, SocketLike } from "@agenteschat/client";

/** React Native's WebSocket takes a third argument with headers (not in the browser's type). */
type NativeWebSocket = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers: Record<string, string> },
) => SocketLike;

/**
 * The WebSocket factory for `RealtimeConnection`: the upgrade carries the session cookie and the app
 * header (no `Origin`), like every API request. `cookie` is read at each (re)connect.
 */
export function createSocketFactory(cookie: () => string, Ctor?: NativeWebSocket): SocketFactory {
  return (url) => {
    const WS = Ctor ?? (globalThis as unknown as { WebSocket: NativeWebSocket }).WebSocket;
    const headers: Record<string, string> = { "X-Agentes-Client": "mobile" };
    const value = cookie();
    if (value) headers.Cookie = value;
    return new WS(url, undefined, { headers });
  };
}

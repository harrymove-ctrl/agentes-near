import { isTerminalSize, STREAM_CLOSE, type StreamRequest } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import type { RunnerLink, Stream, StreamBroker, StreamInput, StreamSocket } from "@agenteschat/engine";
import type { Auth } from "../auth";
import { allowedOrigins } from "../routes/app/context";
import { personUpgrade, UUID } from "./ws";

/**
 * Agents' desktops and terminals (ADR 0058 §11), relayed by the engine's
 * stream broker:
 *
 * - `GET /api/desktop?orgId&agentId&mode=watch|control` (raw RFB, binary; an
 *   older app's `keyboard` is ignored; `switch=1`: its mode may change in place,
 *   ADR 0058 §17; `preview=1`: a browser card's view, watch only, never
 *   switched, ADR 0058 §7) and
 *   `GET /api/terminal?orgId&agentId&cols&rows` (the shell's bytes; text
 *   frames: `resize` out, `exit` in) and
 *   `GET /api/phone-screen?orgId&phoneId&mode=watch|control` (a phone's screen: its pictures, binary or with
 *   `text=1` base64 text for the phone app; text frames: `ack`, and in control `tap`, `swipe`, `text`, `key`)
 *   are a person's sockets, refused before
 *   the upgrade like `/api/ws` (401 without a session, 403 for a foreign
 *   Origin or a non-member, 400 for bad parameters). After it, a refusal is a
 *   close code the panel turns into a state (`STREAM_CLOSE`).
 * - `GET /api/machines/stream` is the runner's data socket for one stream: a
 *   request with an Origin is refused, so no web page opens one. Its first
 *   frame, `stream.hello`, carries the machine's token and the stream's id.
 *
 * Matched exactly: the desktop app's own downloads live under `/api/desktop/…`.
 */
export const STREAM_PATHS = {
  desktop: "/api/desktop",
  terminal: "/api/terminal",
  phone: "/api/phone-screen",
  data: "/api/machines/stream",
} as const;

/** A person's desktop or terminal socket. */
export interface ViewerSocketData {
  kind: "stream.viewer";
  input: StreamInput & { sessionToken: string };
  stream: Stream | null;
  sessionValidatedAt: number;
  sessionCheckInFlight: Promise<boolean> | null;
  sessionCheckStartedAt: number;
  sessionTimer: ReturnType<typeof setInterval> | null;
}

/** A runner's data socket. */
export interface DataSocketData {
  kind: "stream.data";
  link: RunnerLink | null;
}

export type StreamSocketData = ViewerSocketData | DataSocketData;
type Socket = Bun.ServerWebSocket<StreamSocketData>;

const socketOf = (ws: Socket): StreamSocket => ({
  send: (data) => {
    ws.send(data);
  },
  close: (code, reason) => ws.close(code, reason),
  buffered: () => ws.getBufferedAmount(),
  ping: () => {
    ws.ping();
  },
});

const upgraded = (ok: boolean) => (ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 }));
const SESSION_RECHECK_MS = 15_000;
const SESSION_FRAME_RECHECK_MS = 2_000;

/** What a viewer's address asks for; null when it is malformed. */
function viewerRequest(path: string, q: URLSearchParams): StreamRequest | null {
  const mode = q.get("mode");
  if (path === STREAM_PATHS.desktop) return mode === "watch" || mode === "control" ? { kind: "desktop", mode } : null;
  if (path === STREAM_PATHS.phone) {
    const phoneId = q.get("phoneId") ?? "";
    return UUID.test(phoneId) && (mode === "watch" || mode === "control") ? { kind: "phone", mode, phoneId } : null;
  }
  const cols = Number(q.get("cols"));
  const rows = Number(q.get("rows"));
  return isTerminalSize(cols, rows) ? { kind: "terminal", cols, rows } : null;
}

export function createStreamSockets(deps: { db: Database; auth: Auth; config: Config; broker: StreamBroker }) {
  const origins = allowedOrigins(deps.config);
  const { broker } = deps;

  const closeViewer = (ws: Socket, code: number, reason: string) => {
    if (ws.data.kind !== "stream.viewer" || ws.readyState !== 1) return;
    if (ws.data.stream) broker.close(ws.data.stream, code, reason);
    if (ws.readyState === 1) ws.close(code, reason);
  };

  async function liveViewerSession(ws: Socket, force = false): Promise<boolean> {
    const data = ws.data;
    if (data.kind !== "stream.viewer" || ws.readyState !== 1) return false;
    if (!force && Date.now() - data.sessionValidatedAt < SESSION_FRAME_RECHECK_MS) return true;
    if (data.sessionCheckInFlight) {
      if (force && Date.now() - data.sessionCheckStartedAt >= SESSION_RECHECK_MS) {
        closeViewer(ws, STREAM_CLOSE.internal, "session unavailable");
        return false;
      }
      return data.sessionCheckInFlight;
    }
    data.sessionCheckStartedAt = Date.now();
    const check = (async () => {
      try {
        const { internalAdapter } = await deps.auth.$context;
        const found = await internalAdapter.findSession(data.input.sessionToken);
        if (!found || found.session.userId !== data.input.userId || found.session.expiresAt <= new Date()) {
          closeViewer(ws, STREAM_CLOSE.forbidden, "session revoked");
          return false;
        }
        data.sessionValidatedAt = Date.now();
        return true;
      } catch {
        closeViewer(ws, STREAM_CLOSE.internal, "session unavailable");
        return false;
      }
    })();
    data.sessionCheckInFlight = check;
    try {
      return await check;
    } finally {
      data.sessionCheckInFlight = null;
      data.sessionCheckStartedAt = 0;
    }
  }

  return {
    paths: new Set<string>(Object.values(STREAM_PATHS)),

    async upgrade(req: Request, server: Bun.Server<StreamSocketData>): Promise<Response | undefined> {
      const url = new URL(req.url);
      if (url.pathname === STREAM_PATHS.data) {
        if (req.headers.get("origin")) return new Response("Browsers can't connect here", { status: 403 });
        return upgraded(server.upgrade(req, { data: { kind: "stream.data", link: null } }));
      }
      const q = url.searchParams;
      const orgId = q.get("orgId") ?? "";
      const user = await personUpgrade(deps, origins, req, orgId);
      if (user instanceof Response) return user;
      const request = viewerRequest(url.pathname, q);
      // A phone's screen is no agent's.
      const agentId = request?.kind === "phone" ? "" : (q.get("agentId") ?? "");
      if (!request || (request.kind !== "phone" && !UUID.test(agentId))) {
        return new Response("agentId and a mode (or a terminal's cols and rows, or a phoneId) are required", {
          status: 400,
        });
      }
      // A browser card's view of the screen (ADR 0058 §7) only watches, so it never takes a mode change either.
      const preview = request.kind === "desktop" && q.get("preview") === "1";
      if (preview && request.mode !== "watch") return new Response("A preview only watches", { status: 400 });
      const switches = !preview && request.kind === "desktop" && q.get("switch") === "1";
      const data: ViewerSocketData = {
        kind: "stream.viewer",
        input: {
          userId: user.id,
          orgId,
          agentId,
          request,
          sessionToken: user.sessionToken,
          ...(switches ? { switches } : {}),
          ...(preview ? { preview } : {}),
          ...(request.kind === "phone" && q.get("text") === "1" ? { text: true } : {}),
        },
        stream: null,
        sessionValidatedAt: 0,
        sessionCheckInFlight: null,
        sessionCheckStartedAt: 0,
        sessionTimer: null,
      };
      return upgraded(server.upgrade(req, { data }));
    },

    async open(ws: Socket) {
      if (ws.data.kind === "stream.data") ws.data.link = broker.accept(socketOf(ws));
      else {
        if (!(await liveViewerSession(ws, true))) return;
        if (ws.readyState !== 1) return;
        ws.data.stream = broker.open(socketOf(ws), ws.data.input);
        ws.data.sessionTimer = setInterval(() => void liveViewerSession(ws, true), SESSION_RECHECK_MS);
      }
    },

    async message(ws: Socket, raw: string | Buffer) {
      if (ws.data.kind === "stream.viewer") {
        if (ws.data.stream && (await liveViewerSession(ws))) broker.fromViewer(ws.data.stream, raw);
      } else if (ws.data.link) await broker.fromRunner(ws.data.link, raw);
    },

    close(ws: Socket, code: number) {
      if (ws.data.kind === "stream.viewer") {
        if (ws.data.sessionTimer) clearInterval(ws.data.sessionTimer);
        ws.data.sessionTimer = null;
        if (ws.data.stream) broker.close(ws.data.stream, STREAM_CLOSE.normal, "the viewer left");
      } else if (ws.data.link) broker.runnerClosed(ws.data.link, code);
    },
  };
}

export type StreamSockets = ReturnType<typeof createStreamSockets>;

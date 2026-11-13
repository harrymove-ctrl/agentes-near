import type { MachineConnection, MachineHub } from "@agenteschat/engine";

/**
 * `GET /api/machines/connect`: the runner's WebSocket (ADR 0025). No cookie
 * and no Origin: it is not a browser, and the first frame (`hello`) carries
 * the machine token. A request with an Origin header is refused, so a web
 * page can't open it from someone's browser. Everything after the upgrade
 * is the hub's (`@agenteschat/engine` `createMachineHub`).
 */
export interface MachineSocketData {
  kind: "machine";
  conn: MachineConnection | null;
}

export const MACHINE_CONNECT_PATH = "/api/machines/connect";

export function createMachineSockets(hub: MachineHub) {
  return {
    path: MACHINE_CONNECT_PATH,

    upgrade(req: Request, server: Bun.Server<MachineSocketData>): Response | undefined {
      if (req.headers.get("origin")) return new Response("Browsers can't connect here", { status: 403 });
      const data: MachineSocketData = { kind: "machine", conn: null };
      return server.upgrade(req, { data }) ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    },

    open(ws: Bun.ServerWebSocket<MachineSocketData>) {
      ws.data.conn = hub.open({
        send: (text) => {
          ws.send(text);
        },
        close: (code, reason) => ws.close(code, reason),
      });
    },

    async message(ws: Bun.ServerWebSocket<MachineSocketData>, raw: string | Buffer) {
      if (ws.data.conn) await hub.message(ws.data.conn, raw);
    },

    async close(ws: Bun.ServerWebSocket<MachineSocketData>) {
      if (ws.data.conn) await hub.close(ws.data.conn);
    },
  };
}

export type MachineSockets = ReturnType<typeof createMachineSockets>;

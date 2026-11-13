import { randomBytes } from "node:crypto";
import { STREAM_CLOSE } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { computerDrivers } from "@agenteschat/engine";
import { ByteReader } from "../runner/rfb";
import type { Auth } from "../src/auth";
import { desktopChallenge, HANDOFF_PREFIX } from "../src/desktop-sign-in";
import { NO_TERMINAL } from "../src/engine";
import { STREAM_PATHS } from "../src/realtime/streams";
import { UUID } from "../src/realtime/ws";

/**
 * `bun run smoke --desktop-agent <handle>` (ADR 0058): an agent's desktop and
 * terminal through a running server, as a person in the web app reaches them.
 * The smoke signs in as someone who may use the agent's computer as the agent
 * (`computerDrivers`), through the server's own sign-in for the Mac app
 * (`/api/auth/desktop/redeem`), so the session and its cookie are the server's
 * own; it signs out at the end.
 */

/** Each wait on a stream (the server, the computer and the desktop all answer within a few seconds). */
const WAIT_MS = 20_000;

export interface DesktopSmokeSession {
  /** Where the smoke connects (the server's address), and the `Origin` it sends (its PUBLIC_URL's). */
  base: string;
  origin: string;
  cookie: string;
  orgId: string;
  agentId: string;
  handle: string;
  /** Who the smoke is signed in as. */
  person: string;
  signOut(): Promise<void>;
}

/** The agent (its handle, or its id when several workspaces have that handle), and a session of who may drive its computer. */
export async function signInForDesktop(
  deps: { db: Database; auth: Auth; base: string; origin: string },
  agent: string,
): Promise<DesktopSmokeSession> {
  const { db, auth, base, origin } = deps;
  const { agents, users } = schema;
  const which = UUID.test(agent) ? eq(agents.id, agent) : eq(agents.handle, agent.replace(/^@/, "").toLowerCase());
  const found = await db
    .select({ id: agents.id, orgId: agents.orgId, handle: agents.handle })
    .from(agents)
    .where(and(which, isNull(agents.archivedAt)));
  if (found.length > 1) {
    throw new Error(
      `${found.length} workspaces have an agent ${agent}; pass its id: ${found.map((a) => a.id).join(", ")}`,
    );
  }
  const [target] = found;
  if (!target) throw new Error(`No agent ${agent}`);
  const [userId] = await computerDrivers(db, target.orgId, target.id);
  if (!userId) throw new Error(`Nobody may use @${target.handle}'s computer: is the agent on a connected computer?`);
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const verifier = randomBytes(32).toString("base64url");
  const { internalAdapter } = await auth.$context;
  // The browser's half of the hand-over (`/desktop/handoff`): redeem requires that person's live session. Only the
  // window's session that redeem makes stays.
  const source = await internalAdapter.createSession(userId, true);
  let res: Response;
  try {
    await internalAdapter.createVerificationValue({
      identifier: HANDOFF_PREFIX + desktopChallenge(verifier),
      value: source.token,
      expiresAt: new Date(Date.now() + 60_000),
    });
    res = await fetch(`${base}/api/auth/desktop/redeem`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ verifier }),
    });
  } finally {
    await internalAdapter.deleteSession(source.token);
  }
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const answer = res.ok ? ((await res.json()) as { signedIn?: boolean }) : null;
  if (!answer?.signedIn || !cookie) throw new Error(`signing in at ${base} failed (HTTP ${res.status})`);
  return {
    base,
    origin,
    cookie,
    orgId: target.orgId,
    agentId: target.id,
    handle: target.handle,
    person: person?.name ?? userId,
    signOut: async () => {
      await fetch(`${base}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: "{}",
      });
    },
  };
}

/**
 * The agent's desktop watched as noVNC would until its first framebuffer
 * update (RFB 3.8, security None, shared; opening it starts one that isn't
 * running), and its terminal asked who it runs as (never root), or refused
 * where sessions are screened. Throws on the first failure.
 */
export async function checkDesktop(s: DesktopSmokeSession, step: (line: string) => void) {
  const headers = { cookie: s.cookie, origin: s.origin };
  const status = async () => {
    const res = await fetch(`${s.base}/api/app/organizations/${s.orgId}/agents/${s.agentId}/desktop`, { headers });
    if (!res.ok) throw new Error(`GET …/desktop: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { available: boolean; reason: string | null; detail: string | null; running: boolean };
  };
  const socket = (path: string, query: Record<string, string>) => {
    const url = new URL(path, s.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ orgId: s.orgId, agentId: s.agentId, ...query }).toString();
    return url.toString();
  };

  const desktop = await status();
  if (!desktop.available) {
    throw new Error(
      `@${s.handle}'s desktop can't be shown: ${desktop.reason}${desktop.detail ? ` (${desktop.detail})` : ""}`,
    );
  }
  if (!desktop.running) step("desktop: not running; watching it starts it");
  const rfb = await watchDesktop(socket(STREAM_PATHS.desktop, { mode: "watch" }), headers);
  step(
    `desktop: RFB 003.008, security None, ${rfb.width}×${rfb.height} "${rfb.name}"; its version after ${rfb.versionMs} ms, a framebuffer update after ${rfb.updateMs} ms`,
  );
  const shell = await terminalUser(socket(STREAM_PATHS.terminal, { cols: "80", rows: "24" }), headers);
  if (!shell) {
    step("terminal: refused on this server, sessions are screened");
    return;
  }
  if (shell.user === "root") throw new Error(`@${s.handle}'s terminal runs as root`);
  step(`terminal: as ${shell.user}; the shell's first output after ${shell.firstMs} ms`);
}

/** Bun's WebSocket takes headers (the session cookie, our Origin); the DOM's type doesn't say so. */
const openSocket = (url: string, headers: Record<string, string>) => {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  return ws;
};

/** A watcher's RFB handshake, then one framebuffer update of the whole screen; the timings from the socket's start. */
async function watchDesktop(url: string, headers: Record<string, string>) {
  const started = performance.now();
  const since = () => Math.round(performance.now() - started);
  const ws = openSocket(url, headers);
  const bytes = new ByteReader();
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") bytes.push(new Uint8Array(e.data as ArrayBuffer));
  };
  ws.onclose = (e) => bytes.fail(new Error(`the desktop's stream closed: ${e.code} ${e.reason}`));
  const timer = setTimeout(
    () => bytes.fail(new Error(`the desktop's stream stalled for ${WAIT_MS / 1000} s`)),
    WAIT_MS,
  );
  try {
    const version = await bytes.read(12);
    const versionMs = since();
    if (version.toString("latin1") !== "RFB 003.008\n") {
      throw new Error(`the desktop said ${JSON.stringify(version.toString("latin1"))}, not RFB 003.008`);
    }
    ws.send(version);
    const security = [...(await bytes.read(2))];
    if (security.join() !== "1,1") throw new Error(`security types [${security}], not None alone`);
    ws.send(Uint8Array.of(1));
    if ((await bytes.read(4)).readUInt32BE(0) !== 0) throw new Error("security None wasn't accepted");
    // ClientInit: shared, as noVNC asks.
    ws.send(Uint8Array.of(1));
    const init = await bytes.read(24);
    const [width, height] = [init.readUInt16BE(0), init.readUInt16BE(2)];
    const name = (await bytes.read(init.readUInt32BE(20))).toString("utf8");
    // SetEncodings [Tight], then a FramebufferUpdateRequest for the whole screen, not incremental.
    ws.send(Uint8Array.of(2, 0, 0, 1, 0, 0, 0, 7));
    const request = Buffer.alloc(10);
    request.writeUInt8(3, 0);
    request.writeUInt16BE(width, 6);
    request.writeUInt16BE(height, 8);
    ws.send(request);
    for (;;) {
      const type = (await bytes.read(1))[0];
      if (type === 0) break;
      // A Bell, or the desktop's clipboard: skipped.
      if (type === 2) continue;
      if (type === 3) {
        await bytes.read((await bytes.read(7)).readUInt32BE(3));
        continue;
      }
      throw new Error(`the desktop sent message type ${type} before a framebuffer update`);
    }
    return { width, height, name, versionMs, updateMs: since() };
  } finally {
    clearTimeout(timer);
    ws.close(1000);
  }
}

/**
 * Who the agent's terminal runs as (its shell's `id -un`), and how soon the shell first printed; null where the
 * server opens no terminal (sessions are screened).
 */
async function terminalUser(url: string, headers: Record<string, string>) {
  const started = performance.now();
  const ws = openSocket(url, headers);
  const decoder = new TextDecoder();
  let out = "";
  let firstMs: number | null = null;
  let ended: string | null = null;
  let screened = false;
  let wake = () => {};
  ws.onmessage = (e) => {
    // Text frames are the stream's own (the shell's exit).
    if (typeof e.data === "string") return;
    firstMs ??= Math.round(performance.now() - started);
    out += decoder.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true });
    wake();
  };
  ws.onclose = (e) => {
    ended = `${e.code} ${e.reason}`;
    screened = e.code === STREAM_CLOSE.notFound && e.reason === NO_TERMINAL;
    wake();
  };
  const until = async <T>(found: () => T | null | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const value = found();
      if (value !== null && value !== undefined) return value;
      if (ended !== null) throw new Error(`the terminal closed (${ended}) before ${what}`);
      if (Date.now() > deadline) throw new Error(`no ${what} within ${WAIT_MS / 1000} s`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 250);
      });
    }
  };
  try {
    const first = await until(() => firstMs, "output from the shell").catch((error: unknown) => {
      if (screened) return null;
      throw error;
    });
    if (first === null) return null;
    // Quoted apart, so the shell's echo of the line never matches what it prints.
    ws.send(new TextEncoder().encode(`echo "SMOKE""USER=$(id -un)"\r`));
    const user = await until(() => /SMOKEUSER=([\w.$-]+)/.exec(out)?.[1], "answer to id -un");
    ws.send(new TextEncoder().encode("exit\r"));
    return { user, firstMs: first };
  } finally {
    ws.close(1000);
  }
}

import { BROWSER_DEVICE_SIZES, type BrowserViewport, isObject } from "@agenteschat/adapters/machine-protocol";
import type { StreamSocket } from "./browser";
import { urlCarries } from "./vault";

/**
 * What one agent's Chrome sends and receives (protocol 23), from its own
 * DevTools network events: one connection to its browser endpoint, attached
 * (flat sessions) to every page, frame and worker it opens, Chrome's own UI
 * left out and nothing paused, with network events on and no bodies kept for
 * us. Never the rest of the computer, never a URL or a header kept or logged.
 *
 * - Received: each finished response's encoded size (headers included); for
 *   one that failed, what had arrived; nothing for a response a service worker
 *   served (the worker's own fetch is counted on its target).
 * - Sent: each request's headers and its `Content-Length`.
 * - WebSocket frames: their payload (UTF-8 text, or binary).
 * - Not seen: a file Chrome saves as a download (only its request: its body
 *   reaches no network event).
 *
 * Measured 2026-10-27 on Chrome for Testing 155 against local servers: within
 * 0.2% of the bytes they sent and received (the headers). Chrome keeps no byte
 * count of its own to read instead: its histograms moved for neither way.
 *
 * The same connection says when a tab's page died (`Inspector.targetCrashed`
 * on its session: Chrome's sad tab) and opens it again or shows another page
 * there (`onCrash`), and asks Chrome to quit (`quit`), so each Chrome has one
 * socket of ours.
 *
 * It also holds the page size the agent asked for (`emulate`, protocol 52) on every tab.
 *
 * It also guards a password about to be typed (ADR 0144, `guard`): for a
 * while, every request of that Chrome pauses (`Fetch.enable` on each of its
 * sessions, new ones too) and one whose address carries the password fails
 * (`Fetch.failRequest`) instead of leaving; the rest go on at once. The guard
 * is ready once Chrome acknowledged `Fetch.enable` on every session it has
 * then (ones that attached since the last guard too), and the runner types only
 * then. An error in answer leaves that session unpaused, so the guard isn't
 * ready, unless the session is gone. Only while armed: nothing is paused
 * otherwise. A dedicated worker has no `Fetch` of its own ("'Fetch.enable' wasn't
 * found"), and what it requests pauses on its page's session (measured on Chrome
 * for Testing 155 and 157, nested workers too): it isn't asked. reCAPTCHA starts
 * one, so a sign-in page with it could never be guarded otherwise.
 */

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "browser_ui", exclude: true }, { type: "tab", exclude: true }, {}],
};
/**
 * Under a page, frame or worker: its frames and dedicated workers. Service and shared workers are the
 * browser's own targets, attached once above: attached again under each page they serve, their bytes would
 * count twice (a service worker's fetch did).
 */
const AUTO_ATTACH_RELATED = {
  ...AUTO_ATTACH,
  filter: [{ type: "service_worker", exclude: true }, { type: "shared_worker", exclude: true }, {}],
};
/** Bodies never cross the socket, and Chrome buffers none of them for this client. */
const NETWORK = { maxPostDataSize: 1, maxResourceBufferSize: 1, maxTotalBufferSize: 1 };
/** The GET guard pauses every request before it is sent (its address is all it reads). */
const FETCH = { patterns: [{ urlPattern: "*", requestStage: "Request" }] };
/** How long a guard waits for Chrome to acknowledge `Fetch.enable` on its sessions before it gives up. */
export const GUARD_READY_MS = 3_000;

/** One guarded value set (ADR 0144): until when, and who hears of a request it stopped. */
interface Guard {
  values: string[];
  until: number;
  onBlocked: () => void;
}

/** A guard just armed: `ready` once Chrome paused every session's requests (false: it couldn't), `release` to undo. */
export interface ArmedGuard {
  /**
   * True once Chrome acknowledged `Fetch.enable` on every session it had when the guard was armed (including ones
   * that attached after an earlier guard's); false when a session still there answered with an error, the socket
   * closed or no answer came within `readyMs`. Type nothing before it is true.
   */
  ready: Promise<boolean>;
  /** Takes these values back out (a fill that was refused); the guard ends when no value is left. */
  release(): void;
}

export interface TrafficCounter {
  /** Settles once Chrome answered the first auto-attach, or the socket failed. */
  attached: Promise<void>;
  /** The bytes counted since the last call. */
  take(): { up: number; down: number };
  /** Asks Chrome to quit as a person quits it (`Browser.close`): it writes what it holds to its profile first. */
  quit(): void;
  /**
   * For `ms` from now, fails every request whose address carries one of `values` (raw or encoded) and calls
   * `onBlocked` for each (ADR 0144). Arm it before typing and type once `ready` is true.
   */
  guard(values: string[], ms: number, onBlocked: () => void, readyMs?: number): ArmedGuard;
  /**
   * Sends `commands` (`emulationCommands`) to every tab now and to each tab that opens later, on this connection's
   * own session with it, which stays attached while Chrome runs: Chrome drops a session's overrides when it detaches.
   * Null ends it on every tab.
   */
  emulate(commands: CdpCommand[] | null): void;
  close(): void;
}

export interface CdpCommand {
  method: string;
  params: Record<string, unknown>;
}

/** An empty user agent is no override: the one Chrome started with again. */
const NO_USER_AGENT: CdpCommand = { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } };
const CLEAR_EMULATION: CdpCommand[] = [
  { method: "Emulation.clearDeviceMetricsOverride", params: {} },
  { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
  NO_USER_AGENT,
];

/**
 * What makes a tab show its page as `viewport` (`agentes:viewport`, protocol 52). A phone or a tablet is mobile
 * (the page's `<meta name="viewport">` applies, scrollbars overlay), takes touch, and says it is Chrome on Android of
 * this Chrome's major version (`version`), as Chrome on Android reduces its user agent, with the client hints to
 * match; without the version only its size changes. A desktop size changes the size alone.
 */
export function emulationCommands(viewport: NonNullable<BrowserViewport>, version: string | null): CdpCommand[] {
  const mobile = viewport.device !== "desktop";
  const scale = viewport.device === "desktop" ? 0 : BROWSER_DEVICE_SIZES[viewport.device].scale;
  const { width, height } = viewport;
  const commands: CdpCommand[] = [
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: { width, height, deviceScaleFactor: scale, mobile, screenWidth: width, screenHeight: height },
    },
    {
      method: "Emulation.setTouchEmulationEnabled",
      params: mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
    },
  ];
  const major = version ? /^(\d+)\./.exec(version)?.[1] : undefined;
  if (!mobile || !major) return [...commands, NO_USER_AGENT];
  const phone = viewport.device === "phone";
  return [
    ...commands,
    {
      method: "Emulation.setUserAgentOverride",
      params: {
        userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 ${phone ? "Mobile " : ""}Safari/537.36`,
        platform: "Linux armv8l",
        userAgentMetadata: {
          brands: [
            { brand: "Google Chrome", version: major },
            { brand: "Chromium", version: major },
            { brand: "Not_A Brand", version: "24" },
          ],
          platform: "Android",
          platformVersion: "10.0.0",
          architecture: "",
          model: "K",
          mobile: phone,
        },
      },
    },
  ];
}

/** A tab whose page died. */
export interface CrashedPage {
  targetId: string;
  /**
   * Goes to the address it was on again: a page that was a form's answer is fetched again, never sent again (a
   * reload would post the form a second time without asking, as Chrome's own Reload asks).
   */
  reopen(): void;
  /** Shows `url` there instead. */
  show(url: string): void;
}

type Params = Record<string, unknown>;
/** One session's `Fetch.enable` while armed: `ok` null until Chrome answers (true: paused there; false: it isn't). */
interface FetchState {
  ok: boolean | null;
  acked: Promise<boolean>;
}
/** Chrome's byte counts: a component extension's worker says -1. */
const bytes = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** A WebSocket frame's payload: text as UTF-8, binary as Chrome hands it (base64). */
function framePayload(response: unknown): number {
  if (!isObject(response) || typeof response.payloadData !== "string") return 0;
  const data = response.payloadData;
  if (response.opcode === 1) return Buffer.byteLength(data);
  if (response.opcode !== 2) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** A request's headers as they go out, `name: value` lines, plus the body its `Content-Length` says. */
function requestBytes(headers: unknown): number {
  if (!isObject(headers)) return 0;
  let n = 0;
  for (const [name, value] of Object.entries(headers)) {
    const text = String(value);
    n += Buffer.byteLength(name) + Buffer.byteLength(text) + 4;
    if (name.toLowerCase() === "content-length") n += bytes(Number(text));
  }
  return n;
}

/** Counts the Chrome whose browser endpoint is `wsUrl` (`ws://127.0.0.1:<port>/devtools/browser/<id>`). */
export function countChromeTraffic(
  wsUrl: string,
  open: (url: string) => StreamSocket = (url) => new WebSocket(url) as unknown as StreamSocket,
  onCrash?: (page: CrashedPage) => void,
): TrafficCounter {
  let up = 0;
  let down = 0;
  let nextId = 1;
  /** Per session (`""`: the browser's own): each unfinished response's bytes so far, and whether a service worker served it. */
  const sessions = new Map<string, Map<string, { bytes: number; fromWorker: boolean }>>([["", new Map()]]);
  /** The tabs' own sessions (pages attached at the browser's level), with their target. */
  const pages = new Map<string, string>();
  /** What waits on an answer, by the id it was asked under. */
  const answers = new Map<number, (result: Params) => void>();
  /** What waits only for Chrome to answer, told whether it was an error, by the id it was asked under. */
  const acks = new Map<number, (failed: boolean) => void>();
  /** Guards waiting on acknowledgements: told when the socket closes (they never come then). */
  const closeWaiters = new Set<() => void>();
  let closed = false;
  let settle = () => {};
  const attached = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let socket: StreamSocket | null = null;
  /** The GET guard's value sets while armed (empty: disarmed), and whether `Fetch` is on for every session. */
  let guards: Guard[] = [];
  let fetchOn = false;
  /** Each session's `Fetch.enable` while armed. One that failed (or never answered) is asked again by the next guard. */
  const fetchStates = new Map<string, FetchState>();
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  /** What each new tab gets (`emulate`), while a size is emulated. */
  let emulation: CdpCommand[] | null = null;
  const send = (
    method: string,
    params: Params,
    sessionId?: string,
    then?: (result: Params) => void,
    ack?: (failed: boolean) => void,
  ) => {
    const id = nextId++;
    if (then) answers.set(id, then);
    if (ack) acks.set(id, ack);
    try {
      socket?.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch {
      // closing: what was counted stays
    }
    return id;
  };
  const crashed = (sessionId: string, targetId: string): CrashedPage => ({
    targetId,
    reopen: () =>
      send("Page.getNavigationHistory", {}, sessionId, (history) => {
        const entries = Array.isArray(history.entries) ? history.entries : [];
        const current: unknown = entries[typeof history.currentIndex === "number" ? history.currentIndex : -1];
        if (isObject(current) && typeof current.url === "string" && current.url) {
          send("Page.navigate", { url: current.url }, sessionId);
        }
      }),
    show: (url) => send("Page.navigate", { url }, sessionId),
  });
  let first = 0;
  /** Dedicated workers: no `Fetch` to enable there. */
  const workers = new Set<string>();
  const targets = () => [...sessions.keys()].filter((id) => id !== "" && !workers.has(id));
  const live = () => guards.filter((g) => g.until > Date.now());
  const disarm = () => {
    guards = [];
    clearTimeout(guardTimer);
    if (!fetchOn) return;
    fetchOn = false;
    fetchStates.clear();
    for (const id of targets()) send("Fetch.disable", {}, id);
  };
  /** Ends the guard when its last value set expires. */
  const schedule = () => {
    clearTimeout(guardTimer);
    guards = live();
    if (guards.length === 0) {
      disarm();
      return;
    }
    const last = Math.max(...guards.map((g) => g.until));
    guardTimer = setTimeout(schedule, Math.max(0, last - Date.now()));
    (guardTimer as { unref?: () => void }).unref?.();
  };
  /**
   * `Fetch.enable` on one session, tracked: paused once Chrome answers with a result. An error leaves it unpaused,
   * unless the session is gone meanwhile (nothing left there to pause); a closed socket, too.
   */
  const enableFetchOn = (sessionId: string): FetchState => {
    const state: FetchState = { ok: null, acked: Promise.resolve(false) };
    state.acked = new Promise<boolean>((resolve) => {
      const onClose = () => {
        state.ok = false;
        resolve(false);
      };
      closeWaiters.add(onClose);
      send("Fetch.enable", FETCH, sessionId, undefined, (failed) => {
        closeWaiters.delete(onClose);
        state.ok = !failed || !sessions.has(sessionId);
        resolve(state.ok);
      });
    });
    fetchStates.set(sessionId, state);
    return state;
  };
  /**
   * Every session paused: each one's `Fetch.enable` asked (again, for one that failed or never answered) and waited
   * for. True once Chrome acknowledged each; false on an error, on close or after `readyMs`.
   */
  const fetchReady = (readyMs: number): Promise<boolean> => {
    if (closed || !socket) return Promise.resolve(false);
    const states = targets().map((id) => {
      const known = fetchStates.get(id);
      return known && known.ok !== false ? known : enableFetchOn(id);
    });
    if (states.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Still unanswered: asked again by the next guard.
        for (const state of states) if (state.ok === null) state.ok = false;
        resolve(false);
      }, readyMs);
      (timer as { unref?: () => void }).unref?.();
      void Promise.all(states.map((state) => state.acked)).then((oks) => {
        clearTimeout(timer);
        resolve(oks.every(Boolean));
      });
    });
  };
  const entry = (sessionId: string, requestId: unknown) => {
    const requests = sessions.get(sessionId);
    if (!requests || typeof requestId !== "string") return null;
    let e = requests.get(requestId);
    if (!e) {
      e = { bytes: 0, fromWorker: false };
      requests.set(requestId, e);
    }
    return e;
  };
  const end = (sessionId: string, requestId: unknown) => {
    const e = entry(sessionId, requestId);
    sessions.get(sessionId)?.delete(String(requestId));
    return e;
  };

  const onMessage = (raw: unknown) => {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    if (msg.id === first) settle();
    if (typeof msg.id === "number") {
      const then = answers.get(msg.id);
      answers.delete(msg.id);
      const ack = acks.get(msg.id);
      acks.delete(msg.id);
      ack?.(msg.error !== undefined);
      if (then && isObject(msg.result)) then(msg.result);
      return;
    }
    const p = isObject(msg.params) ? msg.params : {};
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
    switch (msg.method) {
      case "Target.attachedToTarget": {
        if (typeof p.sessionId !== "string") return;
        sessions.set(p.sessionId, new Map());
        const target = isObject(p.targetInfo) ? p.targetInfo : {};
        if (!sessionId && target.type === "page" && typeof target.targetId === "string") {
          pages.set(p.sessionId, target.targetId);
          for (const c of emulation ?? []) send(c.method, c.params, p.sessionId);
        }
        if (target.type === "worker") workers.add(p.sessionId);
        send("Network.enable", NETWORK, p.sessionId);
        // A page or frame that opens while a password is guarded is guarded too; the next guard waits for it.
        if (fetchOn && target.type !== "worker") enableFetchOn(p.sessionId);
        send("Target.setAutoAttach", AUTO_ATTACH_RELATED, p.sessionId);
        return;
      }
      case "Fetch.requestPaused": {
        if (typeof p.requestId !== "string") return;
        const url = isObject(p.request) && typeof p.request.url === "string" ? p.request.url : "";
        const hits = live().filter((g) => g.values.some((v) => urlCarries(url, v)));
        if (hits.length > 0) {
          send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId);
          for (const g of new Set(hits.map((h) => h.onBlocked))) {
            try {
              g();
            } catch {
              // the request is stopped either way
            }
          }
          return;
        }
        // Every paused request goes on, also one paused just before the guard ended.
        send("Fetch.continueRequest", { requestId: p.requestId }, sessionId);
        return;
      }
      case "Target.detachedFromTarget":
        if (typeof p.sessionId === "string") {
          sessions.delete(p.sessionId);
          pages.delete(p.sessionId);
          workers.delete(p.sessionId);
          fetchStates.delete(p.sessionId);
        }
        return;
      case "Inspector.targetCrashed": {
        const targetId = pages.get(sessionId);
        if (targetId) onCrash?.(crashed(sessionId, targetId));
        return;
      }
      case "Network.requestWillBeSentExtraInfo":
        up += requestBytes(p.headers);
        return;
      case "Network.responseReceived": {
        const e = entry(sessionId, p.requestId);
        if (e && isObject(p.response) && p.response.fromServiceWorker === true) e.fromWorker = true;
        return;
      }
      case "Network.dataReceived": {
        const e = entry(sessionId, p.requestId);
        if (e) e.bytes += bytes(p.encodedDataLength);
        return;
      }
      case "Network.loadingFinished": {
        const e = end(sessionId, p.requestId);
        if (e && !e.fromWorker) down += bytes(p.encodedDataLength);
        return;
      }
      case "Network.loadingFailed": {
        const e = end(sessionId, p.requestId);
        if (e && !e.fromWorker) down += e.bytes;
        return;
      }
      case "Network.webSocketFrameSent":
        up += framePayload(p.response);
        return;
      case "Network.webSocketFrameReceived":
        down += framePayload(p.response);
        return;
    }
  };

  try {
    socket = open(wsUrl);
    socket.onopen = () => {
      first = send("Target.setAutoAttach", AUTO_ATTACH);
    };
    socket.onmessage = (event) => onMessage(event.data);
    socket.onerror = () => settle();
    socket.onclose = () => {
      settle();
      closed = true;
      guards = [];
      fetchOn = false;
      clearTimeout(guardTimer);
      for (const waiter of [...closeWaiters]) waiter();
      closeWaiters.clear();
      fetchStates.clear();
      sessions.clear();
      pages.clear();
      answers.clear();
      acks.clear();
    };
  } catch {
    settle();
  }

  return {
    attached,
    take() {
      const out = { up, down };
      up = 0;
      down = 0;
      return out;
    },
    quit() {
      send("Browser.close", {});
    },
    guard(values, ms, onBlocked, readyMs = GUARD_READY_MS) {
      const kept = [...new Set(values.filter((v) => v.length >= 4))];
      // Too short to tell apart from ordinary addresses: nothing to guard (redaction leaves them too).
      if (kept.length === 0 || ms <= 0) return { ready: Promise.resolve(true), release: () => {} };
      if (closed) return { ready: Promise.resolve(false), release: () => {} };
      const entry: Guard = { values: kept, until: Date.now() + ms, onBlocked };
      guards = [...live(), entry];
      fetchOn = true;
      // Every session now, those already paused included: one that attached since, or failed, is waited for too.
      const ready = fetchReady(readyMs);
      schedule();
      return {
        ready,
        release: () => {
          if (!guards.includes(entry)) return;
          guards = guards.filter((g) => g !== entry);
          schedule();
        },
      };
    },
    emulate(commands) {
      emulation = commands;
      for (const id of pages.keys()) for (const c of commands ?? CLEAR_EMULATION) send(c.method, c.params, id);
    },
    close() {
      try {
        socket?.close();
      } catch {
        // already closed
      }
    },
  };
}

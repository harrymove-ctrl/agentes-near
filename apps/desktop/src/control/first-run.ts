/**
 * The first run's decisions as pure state (FirstRun.tsx draws them): which screen comes next, what
 * discovery found, what a typed address or a connect link leads to. Nothing here changes the server
 * the app opens; the window does that only after the person confirmed (`chooseServer`).
 */
import {
  type ConnectLink,
  isLoopback,
  isTailnet,
  type ServerCheck,
  type ServerProblem,
  serverHost,
} from "@agenteschat/client/lib/server";
import { appServer, serverName } from "./server";

export type FirstScreen = "choose" | "own" | "connect" | "here" | "link" | "pair";

/**
 * Esc in the first run: back a screen, or the window closes (when a server is open already); never while
 * agentes.chat is being set up here (`busy`), which keeps going whatever the window shows.
 */
export const escapeAction = (screensBack: number, busy: boolean): "stay" | "back" | "close" =>
  busy ? "stay" : screensBack > 0 ? "back" : "close";

/**
 * Where "Use your own server ›" goes: the two ways where both exist (`canRunHere`: this build carries the
 * server), else straight to Connect.
 */
export const ownServerScreen = (canRunHere: boolean): FirstScreen => (canRunHere ? "own" : "connect");

/** The one-command setup, for a server without a screen. */
export const INSTALL_COMMAND = "curl -fsSL https://agentes.chat/install | sh";

/**
 * Whether the one-command setup works from a clean machine: it needs the repository, the setup package and the
 * image to be public. Until then Connect's "Run this on it" stays hidden, since the command
 * would fail for anyone outside.
 */
export const INSTALL_COMMAND_LIVE = false;

/**
 * Discovery: how long the app may take to list the candidates (this computer's ports, and `tailscale status`, which
 * alone can take 2 s), then how long each candidate's own check may take. Each found server shows as soon as its
 * check answers; past both, the search ends with what it found.
 */
export const LOOK_MS = 4000;
export const CHECK_MS = 6000;

/** Where discovery found a server: this computer, or the person's Tailscale network (`discover` in Rust). */
export interface Candidate {
  server: string;
  where: "here" | "tailnet";
}

/** A server discovery found, and what keeps it from being used yet when it answered with a problem. */
export interface Found extends Candidate {
  problem?: ConnectProblem;
}

/** Problems an agentes.chat server answers with: such a server is listed with its problem, never hidden. */
const LISTED_PROBLEMS: ReadonlySet<ServerProblem> = new Set(["server-too-old", "app-too-old", "certificate"]);

/**
 * The candidates that answered as agentes.chat servers, listed by their own address, once each: usable, or with what
 * keeps them from being used (an update on either side, a certificate, no owner yet). Those that didn't answer, or
 * aren't agentes.chat, aren't listed.
 */
export function foundServers(candidates: readonly Candidate[], checks: readonly (ServerCheck | null)[]): Found[] {
  const out: Found[] = [];
  candidates.forEach((c, i) => {
    const check = checks[i];
    if (!check || out.some((f) => f.server === check.server)) return;
    if (check.ok) {
      out.push({ server: check.server, where: c.where, ...(check.instance.ownerClaim ? { problem: "no-owner" } : {}) });
    } else if (LISTED_PROBLEMS.has(check.problem)) {
      out.push({ server: check.server, where: c.where, problem: check.problem });
    }
  });
  return out;
}

/** What can go wrong with an address, in the words of `desktop.connect.*`. */
export type ConnectProblem =
  | ServerProblem
  | "invalid"
  | "http"
  | "no-owner"
  | "unreachable-here"
  | "unreachable-tailnet";

/** Each problem's sentence (`desktop.connect.*`, each takes `{ host }`). */
export const PROBLEM_TEXT: Record<ConnectProblem, string> = {
  invalid: "desktop.connect.invalid",
  http: "desktop.connect.httpRefused",
  "no-owner": "desktop.connect.noOwner",
  unreachable: "desktop.connect.unreachable",
  "unreachable-here": "desktop.connect.unreachableHere",
  "unreachable-tailnet": "desktop.connect.unreachableTailnet",
  certificate: "desktop.connect.certificate",
  "not-agentes": "desktop.connect.notAgentes",
  "server-too-old": "desktop.connect.serverTooOld",
  "app-too-old": "desktop.connect.appTooOld",
};

/** A typed address: the server to check, or why it can't be one (plain http off this computer). */
export function typedServer(
  input: string,
): { ok: true; server: string } | { ok: false; problem: "invalid" | "http"; host: string } {
  const server = appServer(input);
  if (server) return { ok: true, server };
  const raw = input.trim();
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" && url.hostname) return { ok: false, problem: "http", host: url.host };
  } catch {
    // Not a URL at all.
  }
  return { ok: false, problem: "invalid", host: raw };
}

/**
 * After the check of an address the person typed or picked: use it, confirm it in large type first (the
 * server's own address is another host), or say what's wrong.
 */
export type ConnectOutcome =
  | { kind: "use"; server: string }
  | { kind: "confirm"; server: string }
  | { kind: "problem"; problem: ConnectProblem; host: string };

/**
 * A failed check's problem: nothing answering on this computer itself has nothing to do with Tailscale, and only a
 * server on a Tailscale network is talked about as one.
 */
const problemOf = (check: Extract<ServerCheck, { ok: false }>): ConnectProblem => {
  if (check.problem !== "unreachable") return check.problem;
  if (isLoopback(check.server)) return "unreachable-here";
  return isTailnet(check.server) ? "unreachable-tailnet" : "unreachable";
};

/**
 * `own`: the addresses of the agentes.chat this computer runs (its loopback and, with reach on, its Tailscale one).
 * Picked there, it opens at once at the address people use: no sheet about another host, which is still this one.
 */
export function connectOutcome(asked: string, check: ServerCheck, own: readonly string[] = []): ConnectOutcome {
  if (!check.ok) return { kind: "problem", problem: problemOf(check), host: serverHost(check.server) };
  if (check.instance.ownerClaim) return { kind: "problem", problem: "no-owner", host: serverHost(check.server) };
  if (own.includes(asked) || own.includes(check.server)) return { kind: "use", server: check.server };
  return serverHost(check.server) === serverHost(asked)
    ? { kind: "use", server: check.server }
    : { kind: "confirm", server: check.server };
}

/** The addresses of the agentes.chat this computer runs, from its status (`connectOutcome`'s `own`). */
export const ownAddresses = (status: { url: string | null; publicUrl: string | null } | null): string[] =>
  status ? [status.url, status.publicUrl].filter((u): u is string => !!u) : [];

/**
 * How to start the agentes.chat installed from the terminal in `dir`, for a person to copy: the default folder in
 * the home (`~/.agentes` on a Mac or Linux, `%USERPROFILE%\.agentes` on Windows) needs no `--data`.
 */
export const terminalStartCommand = (dir: string) =>
  !dir || /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|~)\/\.agentes$|^[A-Za-z]:\\Users\\[^\\]+\\\.agentes$/.test(dir)
    ? "agentes-server"
    : `agentes-server --data "${dir}"`;

/** The page the main window opens on a server for a link's one-time sign-in or owner claim. */
export const handoverPath = (token: string) => `/desktop/handover#token=${token}`;
export const ownerPath = (claim: string) => `/owner#claim=${claim}`;

/**
 * A connect link's sheet. `front`: the server already open, nothing to ask (the main window comes forward).
 * `ask`: the question, the button, the page to open there (`page`), and the server being left, if any.
 */
export type LinkView =
  | { kind: "notALink" }
  | { kind: "checking"; server: string }
  | { kind: "problem"; server: string; problem: ConnectProblem }
  | { kind: "front"; server: string }
  | {
      kind: "ask";
      server: string;
      question: "question" | "questionSignIn" | "questionClaim";
      button: "connect" | "continue";
      page?: string;
      leave: string | null;
    };

export function linkView(link: ConnectLink | null, check: ServerCheck | "checking", current: string | null): LinkView {
  if (!link) return { kind: "notALink" };
  if (check === "checking") return { kind: "checking", server: link.server };
  if (!check.ok) return { kind: "problem", server: check.server, problem: problemOf(check) };
  const server = check.server;
  const leave = current && current !== server ? serverName(current) : null;
  if (check.instance.ownerClaim) {
    return link.claim
      ? { kind: "ask", server, question: "questionClaim", button: "continue", page: ownerPath(link.claim), leave }
      : { kind: "problem", server, problem: "no-owner" };
  }
  if (link.token) {
    return {
      kind: "ask",
      server,
      question: "questionSignIn",
      button: "connect",
      page: handoverPath(link.token),
      leave,
    };
  }
  if (server === current) return { kind: "front", server };
  return { kind: "ask", server, question: "question", button: "connect", leave };
}

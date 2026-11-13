import { CLOUD_SERVER, isLoopback, isTailnet, normalizeServer, serverHost } from "@agenteschat/client/lib/server";
import type { Home } from "./store";

/** The servers this app opens (Rust keeps them in `servers.json`, `servers_get`). */
export interface ServerList {
  /** Where the main window opens; null until the first run chose one. */
  current: string | null;
  servers: string[];
}

/** A workspace of a server, as the app read it with that server's session (`workspaces.rs`, ADR 0154). */
export interface ServerWorkspace {
  id: string;
  name: string;
  /** A data URL; null shows the workspace's mark. */
  logo: string | null;
  unread: number;
  waiting: number;
  /** The person may pair a computer with it (`pair_computers`). Absent in older apps. */
  pair?: boolean;
}

/** A server's workspaces; `signedIn` false lists none (signed out there). */
export interface ServerWorkspaces {
  server: string;
  signedIn: boolean;
  orgs: ServerWorkspace[];
  /** It didn't answer since this time (milliseconds since 1970): its last answer, kept. Absent: it answered. */
  offlineSince?: number;
  /** The server the app runs on this computer (also at its Tailscale address). Absent in older apps. */
  here?: boolean;
  /** Agents of its workspaces may work on this computer (not a server on this computer itself). */
  agentsHere?: boolean;
}

/** agentes.chat, a server on this computer, one on the person's Tailscale network, or one elsewhere. */
export type ServerKind = "cloud" | "here" | "tailnet" | "own";

export function serverKind(server: string): ServerKind {
  if (server === CLOUD_SERVER) return "cloud";
  if (isLoopback(server)) return "here";
  return isTailnet(server) ? "tailnet" : "own";
}

/** An address as the app takes it: https, or plain http on this computer only. */
export const appServer = (input: string) => normalizeServer(input, { allowHttp: "loopback" });

/** How a server reads in the app: "agentes.chat" for the Cloud, its host otherwise. */
export const serverName = (server: string) => (server === CLOUD_SERVER ? "agentes.chat" : serverHost(server));

/** The server a home is paired with, as an origin. */
export const homeServer = (h: Home) => (h.status?.server ? appServer(h.status.server) : null);

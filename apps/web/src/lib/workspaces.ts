import { CLOUD_SERVER, serverHost } from "@agenteschat/client/lib/server";

/**
 * The workspace menu's "Your workspaces" in the desktop app (ADR 0154): this server's workspaces and every other
 * server's the app reads with its own session (`thisMac.workspaces`), grouped by server, each with its unread count.
 */

/** A workspace of another server, as the desktop app read it (`workspaces.rs`). */
export interface DesktopWorkspace {
  id: string;
  name: string;
  /** A data URL; null shows the workspace's mark. */
  logo: string | null;
  unread: number;
  waiting: number;
}

export interface DesktopServerWorkspaces {
  server: string;
  signedIn: boolean;
  orgs: DesktopWorkspace[];
  /** It didn't answer since this time (milliseconds since 1970): its last answer, kept. Absent: it answered. */
  offlineSince?: number;
  /** The server the app runs on this computer (also at its Tailscale address). Absent in older apps. */
  here?: boolean;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  logo: string | null;
  unread: number;
  /** The workspace open now. */
  current: boolean;
}

export interface WorkspaceGroup {
  /** The server's origin. */
  server: string;
  /** "agentes.chat" for the Cloud, its host otherwise (the app's own server is named by what it is instead). */
  name: string;
  cloud: boolean;
  /** The server this page is on. */
  here: boolean;
  /** The server the app runs on this computer, at whichever address: named as such, never by its address. */
  thisComputer: boolean;
  /**
   * `signedOut`: the app has no session there (no workspaces listed, Sign in); `offline`: it didn't answer since
   * `offlineSince`, its last workspaces shown dimmed.
   */
  state: "ok" | "signedOut" | "offline";
  offlineSince: number | null;
  rows: WorkspaceRow[];
}

/** How a server reads in the menu: agentes.chat for the Cloud, its host otherwise. */
export const serverLabel = (server: string) => (server === CLOUD_SERVER ? "agentes.chat" : serverHost(server));

/**
 * This server's group first (its workspaces from `me`, its counts from `/me/unread` when it answered), then each other
 * server of the app, in its order: signed in with workspaces, signed out there (to sign in again), or not answering
 * (its last workspaces, marked). One signed in with no workspace isn't listed. `thisComputer`: this page's server is
 * the one the app runs on this computer.
 */
export function workspaceGroups(input: {
  here: string;
  thisComputer?: boolean;
  orgs: { id: string; name: string; logo?: string | null }[];
  currentOrgId: string;
  unread: { orgId: string; unread: number }[] | null;
  others: DesktopServerWorkspaces[];
}): WorkspaceGroup[] {
  const counts = new Map((input.unread ?? []).map((u) => [u.orgId, u.unread]));
  const mine: WorkspaceGroup = {
    server: input.here,
    name: serverLabel(input.here),
    cloud: input.here === CLOUD_SERVER,
    here: true,
    thisComputer: input.thisComputer === true,
    state: "ok",
    offlineSince: null,
    rows: input.orgs.map((o) => ({
      id: o.id,
      name: o.name,
      logo: o.logo ?? null,
      unread: counts.get(o.id) ?? 0,
      current: o.id === input.currentOrgId,
    })),
  };
  const others = input.others
    .filter((s) => s.server !== input.here && (!s.signedIn || s.orgs.length > 0))
    .map(
      (s): WorkspaceGroup => ({
        server: s.server,
        name: serverLabel(s.server),
        cloud: s.server === CLOUD_SERVER,
        here: false,
        thisComputer: s.here === true,
        state: s.offlineSince !== undefined ? "offline" : s.signedIn ? "ok" : "signedOut",
        offlineSince: s.offlineSince ?? null,
        rows: s.signedIn
          ? s.orgs.map((o) => ({ id: o.id, name: o.name, logo: o.logo, unread: o.unread, current: false }))
          : [],
      }),
    );
  return [mine, ...others];
}

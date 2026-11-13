import type { OrgSummary } from "@agenteschat/client";
import { CLOUD_SERVER, serverHost } from "@agenteschat/client/lib/server";

/** A server's workspaces in Workspaces (ADR 0154), each with its unread count. */
export interface ServerWorkspaces {
  server: string;
  /** Its header: "agentes.chat" for the Cloud, the address for any other. */
  host: string;
  /** The server the app is on now. */
  current: boolean;
  orgs: (OrgSummary & { unread: number })[];
  /** It didn't answer and nothing is known of it. */
  failed: boolean;
  /** It didn't answer this time, but its workspaces are known: they stay in the list, faded. */
  quiet: boolean;
}

/** The servers Workspaces lists (pure): the ones signed in to, in the order added, and the current one if it isn't yet. */
export const orderedServers = (signedIn: readonly string[], current: string): string[] =>
  signedIn.includes(current) ? [...signedIn] : [current, ...signedIn];

/** One server's group (pure): its workspaces with their unread counts (0 when the server didn't say). */
export function workspacesOf(input: {
  server: string;
  current: boolean;
  orgs: readonly OrgSummary[];
  unread: readonly { orgId: string; unread: number }[];
  failed: boolean;
}): ServerWorkspaces {
  const counts = new Map(input.unread.map((u) => [u.orgId, u.unread]));
  return {
    server: input.server,
    host: input.server === CLOUD_SERVER ? "agentes.chat" : serverHost(input.server),
    current: input.current,
    orgs: input.orgs.map((o) => ({ ...o, unread: counts.get(o.id) ?? 0 })),
    failed: input.failed && input.orgs.length === 0,
    quiet: input.failed && input.orgs.length > 0,
  };
}

/** What's unread outside the workspace open now (pure): Você's "Workspaces · N". */
export const unreadElsewhere = (groups: readonly ServerWorkspaces[], openOrgId: string | null): number =>
  groups.reduce((sum, g) => sum + g.orgs.reduce((n, o) => n + (g.current && o.id === openOrgId ? 0 : o.unread), 0), 0);

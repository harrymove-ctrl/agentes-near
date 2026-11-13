import type { PubSub } from "@agenteschat/adapters";
import { type Executor, eq, schema } from "@agenteschat/db";
import { caches } from "./cache";
import { publishOrgEvent } from "./events";

/**
 * Who a workspace is for (ADR 0159): `team` (the default) or `personal`. The mode changes defaults, words and what is
 * in sight, never what exists or who may do what, so nothing here gates a permission.
 */
export const WORKSPACE_MODES = ["team", "personal"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const isWorkspaceMode = (v: unknown): v is WorkspaceMode => WORKSPACE_MODES.includes(v as WorkspaceMode);

/** The cache key `updateOrgSettings` drops when the mode changes. */
export const workspaceModeCacheKey = (orgId: string) => `${orgId}:mode`;

/** The workspace's mode, `team` when it has no settings row yet. */
export async function workspaceMode(db: Executor, orgId: string): Promise<WorkspaceMode> {
  return caches.orgs.getOrLoad(workspaceModeCacheKey(orgId), async () => {
    const [row] = await db
      .select({ mode: schema.organizationSettings.mode })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, orgId));
    return isWorkspaceMode(row?.mode) ? row.mode : "team";
  }) as Promise<WorkspaceMode>;
}

/** Whether the workspace is personal: one person (and maybe their family) with their agents. */
export const isPersonalWorkspace = async (db: Executor, orgId: string) =>
  (await workspaceMode(db, orgId)) === "personal";

/** The mode changed: every member's apps read `GET /me` and the settings again and reshape at once. */
export type WorkspaceModeEvent = { type: "org.mode"; orgId: string; mode: WorkspaceMode };

export const publishWorkspaceMode = (pubsub: PubSub | undefined, orgId: string, mode: WorkspaceMode) =>
  publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "org.mode", orgId, mode } satisfies WorkspaceModeEvent,
  });

/**
 * Tools as the agents of a personal workspace read them (ADR 0159): a description in `words` replaces the tool's own,
 * so they speak of one person and their agents instead of a company and its team. Names and schemas never change: a
 * tool works the same in both modes.
 */
export async function inWorkspaceWords<T extends { name: string; description: string }>(
  db: Executor,
  orgId: string,
  tools: T[],
  words: Readonly<Record<string, string>>,
): Promise<T[]> {
  if (!tools.some((t) => words[t.name])) return tools;
  // Only words: a read that fails never fails the listing, which then keeps the team's.
  if (!(await isPersonalWorkspace(db, orgId).catch(() => false))) return tools;
  return tools.map((t) => {
    const description = words[t.name];
    return description ? { ...t, description } : t;
  });
}

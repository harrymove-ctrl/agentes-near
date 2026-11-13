import { and, asc, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { ForbiddenError, NotFoundError } from "./errors";
import { can, getMembership, requirePermission } from "./organizations";

const { agents, approvalRules, connectorConnections, customTools, routines, users } = schema;

/**
 * "Aprovar sempre" (docs/adr/0015): someone who decides an agent's approvals approves a kind of call for good, and
 * the Tool Gateway runs the next calls of that kind without asking. The kind is the agent, the connection, the
 * server's own tool name and, for a tool that runs other actions, each action (`''`: the tool itself); never the
 * params. A rule only skips the question: access, the run policy and the arguments' checks still decide first. A
 * command on the agent's computer has no connection: its tool is `COMMAND_RULE_TOOL` and its one action the command's
 * kind (`commandKind`: `gh issue create`), on every brain and wherever the agent works.
 */

/** The tool of a command rule (`approval_rules.tool`, no connection). Mirrored in `@agenteschat/client` `lib/approval-words.ts`. */
export const COMMAND_RULE_TOOL = "command";

/** What "Aprovar sempre" covers on one approval (`approvals.approve_always`). */
export interface RememberedKind {
  tool: string;
  /** The wrapped actions; none: the tool itself. */
  actions: string[];
  /**
   * "Sempre nesta rotina": kept as this routine's own actions (`addRoutineOwnActions`, `actions` are their names),
   * never as a rule of the agent.
   */
  routineId?: string;
}

/** How many connected-app actions a routine may do on its own. */
export const MAX_OWN_ACTIONS = 20;
/** What `routines.own_actions` holds: a tool name or a Composio action's slug. */
export const OWN_ACTION_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The action of an "Aprovar sempre leituras" rule (`ToolDefinition.sqlReads`): the prefix, then the call's other
 * arguments (`project_id=abc`). Mirrored in `@agenteschat/client` `lib/approval-kind.ts`.
 */
export const SQL_READS = "sql-read:";

/** A SQL call's other arguments as one target (`project_id=abc · schema=public`): a rule covers only the same ones. */
export function sqlReadsTarget(input: Record<string, unknown>, sqlArg: string): string {
  return Object.keys(input)
    .filter((k) => k !== sqlArg)
    .sort()
    .map((k) => {
      const v = input[k];
      return `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`;
    })
    .join(" · ");
}

export interface RuleScope {
  orgId: string;
  agentId: string;
  /** Null: a command rule. */
  connectionId: string | null;
}

const actionsOf = (kind: RememberedKind) => (kind.actions.length > 0 ? kind.actions : [""]);

/** The stored kind of an approval, read safely; null when it wasn't offered. */
export function rememberedKindOf(value: unknown): RememberedKind | null {
  const v = value as Partial<RememberedKind> | null | undefined;
  if (!v || typeof v.tool !== "string" || !v.tool || !Array.isArray(v.actions)) return null;
  if (!v.actions.every((a) => typeof a === "string" && a)) return null;
  return { tool: v.tool, actions: v.actions, ...(typeof v.routineId === "string" ? { routineId: v.routineId } : {}) };
}

/** Whether `userId` decides an agent's approvals: its owner, or who holds `approve_actions`. */
export async function decidesAgentApprovals(
  db: Executor,
  orgId: string,
  userId: string,
  agentOwnerUserId: string | null,
): Promise<boolean> {
  return agentOwnerUserId === userId || can(await getMembership(db, userId, orgId), "approve_actions");
}

/** The ids of the rules that cover this call, or null when one is missing. Read fresh: a removed rule asks at once. */
export async function coveringRules(db: Executor, at: RuleScope, kind: RememberedKind): Promise<string[] | null> {
  const wanted = actionsOf(kind);
  const rows = await db
    .select({ id: approvalRules.id, action: approvalRules.action })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.orgId, at.orgId),
        eq(approvalRules.agentId, at.agentId),
        at.connectionId ? eq(approvalRules.connectionId, at.connectionId) : isNull(approvalRules.connectionId),
        eq(approvalRules.tool, kind.tool),
        inArray(approvalRules.action, wanted),
      ),
    );
  const have = new Set(rows.map((r) => r.action));
  return wanted.every((a) => have.has(a)) ? rows.map((r) => r.id) : null;
}

/** Keeps a kind for good (in the decision's transaction); rules already there stay as they are. */
export async function addApprovalRules(tx: Executor, at: RuleScope, kind: RememberedKind, createdByUserId: string) {
  await tx
    .insert(approvalRules)
    .values(actionsOf(kind).map((action) => ({ ...at, tool: kind.tool, action, createdByUserId })))
    .onConflictDoNothing();
}

/**
 * "Sempre nesta rotina" (in the decision's transaction): these actions join the routine's own, and its runs do them
 * without asking (`ownJobCovers`). False when it can't: the routine is gone, moved to another agent or full. Undone
 * in the routine's settings. Locked, so two people approving at once both land.
 */
export async function addRoutineOwnActions(
  tx: Executor,
  at: { orgId: string; agentId: string; routineId: string },
  actions: readonly string[],
  actorId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ ownActions: routines.ownActions })
    .from(routines)
    .where(
      and(
        eq(routines.id, at.routineId),
        eq(routines.orgId, at.orgId),
        eq(routines.agentId, at.agentId),
        isNull(routines.deletedAt),
      ),
    )
    .for("update");
  if (!row) return false;
  const ownActions = [...new Set([...row.ownActions, ...actions])];
  if (ownActions.length > MAX_OWN_ACTIONS) return false;
  await tx.update(routines).set({ ownActions }).where(eq(routines.id, at.routineId));
  await recordAudit(tx, {
    orgId: at.orgId,
    actor: { type: "person", id: actorId },
    action: "routine.own_actions_added",
    target: { type: "routine", id: at.routineId },
    details: { before: row.ownActions, after: ownActions },
  });
  return true;
}

/** Who made the first of these rules, by name, for the quiet line of a call they let run; null when unknown. */
export async function rulesApprover(db: Executor, ruleIds: string[]): Promise<string | null> {
  if (ruleIds.length === 0) return null;
  const [row] = await db
    .select({ name: users.name })
    .from(approvalRules)
    .innerJoin(users, eq(users.id, approvalRules.createdByUserId))
    .where(inArray(approvalRules.id, ruleIds))
    .orderBy(asc(approvalRules.createdAt))
    .limit(1);
  return row?.name ?? null;
}

/**
 * Drops every rule of these agents (their owner changed): the new owner decides afresh. Each removal is audited as
 * one removed by hand, so what the git proxy granted through a rule ends too (`pushGrants`).
 */
export async function dropAgentRules(
  tx: Executor,
  orgId: string,
  agentIds: string[],
  actor: { type: "person"; id: string },
) {
  if (agentIds.length === 0) return;
  const gone = await tx
    .delete(approvalRules)
    .where(and(eq(approvalRules.orgId, orgId), inArray(approvalRules.agentId, agentIds)))
    .returning();
  for (const rule of gone) {
    await recordAudit(tx, {
      orgId,
      actor,
      action: RULE_REMOVED_AUDIT,
      target: { type: "agent", id: rule.agentId },
      details: { connectionId: rule.connectionId, tool: rule.tool, action: rule.action, reason: "owner_changed" },
    });
  }
  // "Merge without asking" is the same kind of word, and goes with it.
  const cleared = await tx
    .update(agents)
    .set({ mergeRepos: [] })
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds), sql`${agents.mergeRepos} <> '[]'::jsonb`))
    .returning({ id: agents.id });
  for (const agent of cleared) {
    await recordAudit(tx, {
      orgId,
      actor,
      action: "agent.merge_repositories_changed",
      target: { type: "agent", id: agent.id },
      details: { repositories: [], reason: "owner_changed" },
    });
  }
}

export interface ApprovalRuleView {
  id: string;
  /** Null: a command on the agent's computer (`COMMAND_RULE_TOOL`). */
  connectionId: string | null;
  /** The connection's name ("Composio"); null for a command. */
  server: string | null;
  /** The server's own tool name. */
  tool: string;
  /** How the workspace labelled that tool (its review), else the tool's name. */
  toolLabel: string;
  /** The wrapped action; `''`: the tool itself. */
  action: string;
  createdByUserId: string | null;
  createdAt: string;
}

/** An agent's rules, oldest first, for anyone in the workspace (its page lists them). */
export async function listApprovalRules(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
): Promise<ApprovalRuleView[]> {
  await requirePermission(db, actorId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  const rows = await db
    .select({
      id: approvalRules.id,
      connectionId: approvalRules.connectionId,
      server: connectorConnections.label,
      tool: approvalRules.tool,
      toolLabel: customTools.label,
      action: approvalRules.action,
      createdByUserId: approvalRules.createdByUserId,
      createdAt: approvalRules.createdAt,
    })
    .from(approvalRules)
    .leftJoin(connectorConnections, eq(connectorConnections.id, approvalRules.connectionId))
    .leftJoin(
      customTools,
      and(eq(customTools.connectionId, approvalRules.connectionId), eq(customTools.name, approvalRules.tool)),
    )
    .where(and(eq(approvalRules.orgId, orgId), eq(approvalRules.agentId, agentId)))
    .orderBy(asc(approvalRules.createdAt), asc(approvalRules.id));
  return rows.map((r) => ({ ...r, toolLabel: r.toolLabel || r.tool, createdAt: r.createdAt.toISOString() }));
}

/** The audit row of a removed rule, `details` `{ connectionId, tool, action }`: the git proxy reads it too (`pushGrants`). */
export const RULE_REMOVED_AUDIT = "agent.approval_rule_removed";

/** Removes one rule: the next call of that kind asks again. Whoever decides its approvals (`approve_actions`, the agent's owner). */
export async function removeApprovalRule(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  ruleId: string,
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "approve_actions") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only the agent's owner or an admin can change this");
  }
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(approvalRules)
      .where(and(eq(approvalRules.id, ruleId), eq(approvalRules.orgId, orgId), eq(approvalRules.agentId, agentId)))
      .returning();
    if (!gone) throw new NotFoundError("Rule not found");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: RULE_REMOVED_AUDIT,
      target: { type: "agent", id: agentId },
      details: { connectionId: gone.connectionId, tool: gone.tool, action: gone.action },
    });
  });
}

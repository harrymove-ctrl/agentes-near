import { and, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { decidesAgentApprovals } from "../approval-rules";
import { type AuthorityRun, type RunAuthority, runAuthority } from "../authority";
import { caches, rulesPresenceKey } from "../cache";
import { cutText } from "../format";
import { routineCreatorOf } from "../requester";

const { contextItems, users } = schema;

/** One rule's text in the prompt, at most (characters). */
const RULE_CHARS = 600;

/**
 * Whose rules a run follows: the person it acts for (the trigger's chain, `runAuthority`), else the creator of the
 * routine that feeds it. Never message text: another agent's "they approved" names nobody here.
 */
export const ruleReaderOf = (authority: RunAuthority) => authority.personId ?? routineCreatorOf(authority);

const activeRulesOf = (orgId: string, agentId: string) =>
  and(
    eq(contextItems.orgId, orgId),
    eq(contextItems.agentId, agentId),
    eq(contextItems.kind, "rule"),
    eq(contextItems.status, "active"),
    eq(contextItems.createdByKind, "person"),
    isNull(contextItems.supersededBy),
  );

/** Most agents hold no rule: their runs pay one cached lookup, no statement on the hot path. */
const holdsRules = (db: Executor, orgId: string, agentId: string) =>
  caches.contextPresence.getOrLoad(rulesPresenceKey(orgId, agentId), async () => {
    const [row] = await db
      .select({ id: contextItems.id })
      .from(contextItems)
      .where(activeRulesOf(orgId, agentId))
      .limit(1);
    return Boolean(row);
  });

/**
 * The rules people gave this agent that hold in a run for `personId` (ADR 0120, rules people gave): their own,
 * and those of whoever decides the agent's approvals (its owner, `approve_actions`), which hold for all its work.
 */
export async function rulesForPerson(
  db: Executor,
  input: { orgId: string; agentId: string; ownerUserId: string | null; personId: string | null },
) {
  const rows = await db
    .select({
      id: contextItems.id,
      content: contextItems.content,
      by: contextItems.createdById,
      at: contextItems.createdAt,
      name: users.name,
    })
    .from(contextItems)
    .leftJoin(users, eq(users.id, contextItems.createdById))
    .where(activeRulesOf(input.orgId, input.agentId))
    .orderBy(contextItems.createdAt)
    .limit(30);
  const givers = [...new Set(rows.map((r) => r.by ?? ""))];
  const holds = new Map(
    await Promise.all(
      givers.map(
        async (by) =>
          [by, by === input.personId || (await decidesAgentApprovals(db, input.orgId, by, input.ownerUserId))] as const,
      ),
    ),
  );
  return rows.filter((r) => holds.get(r.by ?? ""));
}

/** "# Rules people gave you" for a run, or "" when none holds in it. */
export async function rulesForRun(
  db: Executor,
  run: AuthorityRun,
  agent: { id: string; ownerUserId: string | null },
): Promise<{ text: string; itemIds: string[] }> {
  if (!(await holdsRules(db, run.orgId, agent.id))) return { text: "", itemIds: [] };
  const authority = await runAuthority(db, run);
  const rules = await rulesForPerson(db, {
    orgId: run.orgId,
    agentId: agent.id,
    ownerUserId: agent.ownerUserId,
    personId: ruleReaderOf(authority),
  });
  if (rules.length === 0) return { text: "", itemIds: [] };
  const lines = rules.map(
    (r) =>
      `- ${r.name ?? "A person"}, ${r.at.toISOString().slice(0, 10)}: ${cutText(r.content.replace(/\s+/g, " "), RULE_CHARS)} (id ${r.id})`,
  );
  return {
    text: [
      "# Rules people gave you",
      "Lasting instructions people gave you, recorded with who and when; they hold wherever the work reaches you (a DM, a channel, another agent's request, a routine). A permission here is that person's approval for that kind of action: act on it, don't ask again. Payments, deletions, merges and deploys still ask each time.",
      ...lines,
    ].join("\n"),
    itemIds: rules.map((r) => r.id),
  };
}

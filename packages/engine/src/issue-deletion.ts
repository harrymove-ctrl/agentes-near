import { and, eq, inArray, isNull, or, schema } from "@agenteschat/db";
import type { AgentDeletionDeps } from "./agent-deletion";
import { recordAudit } from "./audit";
import { stopRun } from "./cancel";
import { endChannelWork, markChannelDeleted } from "./channel-deletion";
import { ForbiddenError } from "./errors";
import { canSee, findVisible, publishToTaskReaders, taskAudienceOf, tiedPeople } from "./issues";
import { clearIssueNotifications } from "./notifications";
import { can, requireActiveMembership } from "./organizations";
import { ACTIVE_RUN_STATUSES } from "./run-inbox";
import { enqueueIndex } from "./search";

const { agentRuns, agentWorks, calendarEvents, channels, issues, wikiLinks } = schema;

type IssueRow = typeof issues.$inferSelect;

/**
 * Who may delete a task they can see: who created it, an administrator, and, as a task an agent or an integration
 * made has no person behind it, whoever may give agents work. Mirrors `canDeleteIssue` in
 * packages/client/src/lib/issues.ts.
 */
function mayDelete(membership: Parameters<typeof can>[0], issue: IssueRow, userId: string) {
  if (issue.createdByType === "person" && issue.createdById === userId) return true;
  if (issue.createdByType !== "person" && can(membership, "assign_work")) return true;
  return can(membership, "administrator");
}

/** Its steps, all the way down, that `userId` can see; a step they can't see stays, as a task of its own. */
async function visibleSteps(deps: AgentDeletionDeps, userId: string, root: IssueRow) {
  const found: IssueRow[] = [];
  let parents = [root.id];
  while (parents.length > 0) {
    const rows = await deps.db
      .select()
      .from(issues)
      .where(and(eq(issues.orgId, root.orgId), inArray(issues.parentIssueId, parents)));
    const seen = new Set([root.id, ...found.map((r) => r.id)]);
    const next: IssueRow[] = [];
    for (const r of rows)
      if (!seen.has(r.id) && (await canSee(deps.db, { type: "person", userId }, r.orgId, r))) next.push(r);
    found.push(...next);
    parents = next.map((r) => r.id);
  }
  return found;
}

/**
 * Deletes a task for good, with its steps and its conversation (`channel.delete` takes what that held). What an agent
 * is doing on it stops first, as if the person pressed stop, so the work's end still reaches where it was asked. Its
 * number is never given again. The audit log keeps who deleted it and its title.
 */
export async function deleteIssue(deps: AgentDeletionDeps, userId: string, orgId: string, issueId: string) {
  const { db } = deps;
  const membership = await requireActiveMembership(db, userId, orgId);
  const issue = await findVisible(db, { type: "person", userId }, orgId, { id: issueId });
  if (!mayDelete(membership, issue, userId))
    throw new ForbiddenError("Only who created this task or an administrator can delete it", "issue.delete_forbidden");
  const gone = [issue, ...(await visibleSteps(deps, userId, issue))];
  const ids = gone.map((r) => r.id);
  const rooms = gone.flatMap((r) => (r.conversationChannelId ? [r.conversationChannelId] : []));

  const works = await db
    .select({ id: agentWorks.id })
    .from(agentWorks)
    .where(and(eq(agentWorks.orgId, orgId), inArray(agentWorks.issueId, ids), isNull(agentWorks.finishedAt)));
  const live = await db
    .select({ run: agentRuns, kind: channels.kind })
    .from(agentRuns)
    .leftJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        or(
          inArray(agentRuns.issueId, ids),
          inArray(agentRuns.channelId, rooms),
          inArray(
            agentRuns.workId,
            works.map((w) => w.id),
          ),
        ),
      ),
    );
  for (const { run, kind } of live)
    await stopRun(deps, orgId, run, kind, { type: "person", id: userId }, { forAll: true }).catch(() => null);

  await db.transaction(async (tx) => {
    for (const room of rooms) await markChannelDeleted(tx, orgId, room);
    await tx
      .update(agentRuns)
      .set({ issueId: null })
      .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.issueId, ids)));
    await tx
      .update(calendarEvents)
      .set({ issueId: null })
      .where(and(eq(calendarEvents.orgId, orgId), inArray(calendarEvents.issueId, ids)));
    await tx
      .delete(wikiLinks)
      .where(and(eq(wikiLinks.orgId, orgId), eq(wikiLinks.fromType, "issue"), inArray(wikiLinks.fromId, ids)));
    await tx.delete(issues).where(and(eq(issues.orgId, orgId), inArray(issues.id, ids)));
    for (const id of ids) await enqueueIndex(tx, { orgId, kind: "issue", sourceId: id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "issue.deleted",
      target: { type: "issue", id: issue.id },
      details: { number: issue.number, title: issue.title, steps: ids.length - 1 },
    });
  });
  for (const room of rooms) await endChannelWork(deps, userId, orgId, room);
  await clearIssueNotifications(deps, orgId, ids);
  const tied = await tiedPeople(db, gone);
  for (const r of gone)
    await publishToTaskReaders(
      deps,
      orgId,
      { channelId: r.channelId, audience: taskAudienceOf(r, tied) },
      { type: "issue.deleted", issueId: r.id, number: r.number },
    );
}

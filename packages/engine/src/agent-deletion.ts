import { and, eq, inArray, isNull, like, ne, or, schema, sql } from "@agenteschat/db";
import { deletedHandle } from "./agents";
import { recordAudit } from "./audit";
import { invalidateOrg } from "./cache";
import { stopOrgWork } from "./cancel";
import { NotFoundError } from "./errors";
import { publishAgentsChanged, publishChannelsChanged, publishOrgEvent } from "./events";
import { announceReleasedAccounts, releaseAgentLogin } from "./machine-accounts";
import { publishMachineAgentsChanged } from "./machines";
import { concludeMission, type MissionDeps, OPEN_MISSION_STATUSES } from "./missions";
import { resolveNotifications } from "./notifications";
import { recordOperatorEvent } from "./operator-events";
import { requirePermission } from "./organizations";
import { refuseRightHand } from "./right-hand";
import { deleteAgentRoutines, type RoutineDeps } from "./routines";
import { removeAgentSecrets } from "./secrets";

const {
  agentBudgetPeriods,
  agentRepositories,
  agentScopes,
  agentSkills,
  agents,
  approvalRules,
  approvals,
  browserHandoffs,
  budgetReservations,
  channelMembers,
  channels,
  contextItems,
  contextProposals,
  dbAgentPolicies,
  mailAgentPolicies,
  missions,
  notifications,
  outcomes,
  searchDocuments,
} = schema;

export type AgentDeletionDeps = MissionDeps & Pick<RoutineDeps, "pubsub" | "mail">;

/**
 * Deletes an agent for good (ADR 0082): owners and admins, archived or not. It is archived first, so nothing new
 * starts while its missions close, its routines go and its work stops; then, in one transaction, what it had goes
 * and its row stays as a tombstone (name, role and look; its handle freed) for its messages, runs, usage and audit.
 */
export async function deleteAgent(deps: AgentDeletionDeps, actorId: string, orgId: string, agentId: string) {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "manage_agents");
  await refuseRightHand(db, orgId, agentId, "deleted");
  const [agent] = await db
    .update(agents)
    .set({ archivedAt: sql`coalesce(${agents.archivedAt}, now())` })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)))
    .returning({ name: agents.name, handle: agents.handle });
  if (!agent) throw new NotFoundError("Agent not found");
  invalidateOrg(orgId);

  const open = await db
    .select()
    .from(missions)
    .where(
      and(eq(missions.orgId, orgId), eq(missions.agentId, agentId), inArray(missions.status, OPEN_MISSION_STATUSES)),
    );
  for (const mission of open) {
    await concludeMission(deps, mission, actorId, true, { outcome: "canceled" }).catch(() => null);
  }
  await deleteAgentRoutines(deps, actorId, orgId, agentId);
  await stopOrgWork(
    { db, pubsub: deps.pubsub, hub: deps.hub ?? undefined },
    orgId,
    "agent_archived",
    "deleted",
    agentId,
  );
  // Before the tombstone: the runner finds a secret's file by the agent's handle.
  await removeAgentSecrets({ db, machines: deps.hub ? { hub: deps.hub } : null }, actorId, orgId, agentId);

  const now = new Date();
  const { released, dms } = await db.transaction(async (tx) => {
    const released = await releaseAgentLogin(tx, orgId, agentId);
    // Only its name, role and look stay: every other setting goes back to its default.
    const [gone] = await tx
      .update(agents)
      .set({
        deletedAt: now,
        handle: deletedHandle(agentId),
        previousHandles: [],
        instructions: "",
        model: "",
        credentialId: null,
        ownerUserId: null,
        monthlyBudgetNanoUsd: null,
        audienceMode: "everyone",
        audienceUserIds: [],
        audienceRoleIds: [],
        machineId: null,
        missionCommandApproval: null,
        brain: "model",
        brainModel: null,
        brainFallback: true,
        brainAccountId: null,
        brainEffort: null,
        brainSpeed: "standard",
        browserAllowedDomains: null,
        browserMachineId: null,
        operatorHoldAt: null,
        operatorHoldReason: null,
        updatedAt: now,
      })
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .returning({ id: agents.id });
    if (!gone) throw new NotFoundError("Agent not found");
    const memory = tx
      .select({ id: contextItems.id })
      .from(contextItems)
      .where(and(eq(contextItems.orgId, orgId), eq(contextItems.agentId, agentId)));
    await tx
      .delete(searchDocuments)
      .where(and(eq(searchDocuments.kind, "context_item"), inArray(searchDocuments.sourceId, memory)));
    // A decided card's rows stay: the card that deleted it (or changed it before) still reads how it ended.
    await tx
      .delete(contextProposals)
      .where(
        and(
          eq(contextProposals.orgId, orgId),
          eq(contextProposals.agentId, agentId),
          or(ne(contextProposals.target, "agent_settings"), eq(contextProposals.status, "pending")),
        ),
      );
    for (const table of [
      contextItems,
      outcomes,
      agentSkills,
      agentScopes,
      approvalRules,
      agentRepositories,
      mailAgentPolicies,
      dbAgentPolicies,
      agentBudgetPeriods,
      budgetReservations,
      channelMembers,
    ]) {
      await tx.delete(table).where(and(eq(table.orgId, orgId), eq(table.agentId, agentId)));
    }
    await tx
      .update(approvals)
      .set({ status: "canceled", decidedAt: now })
      .where(and(eq(approvals.orgId, orgId), eq(approvals.agentId, agentId), eq(approvals.status, "pending")));
    await tx
      .update(browserHandoffs)
      .set({ status: "cancelled", resolvedAt: now })
      .where(and(eq(browserHandoffs.agentId, agentId), inArray(browserHandoffs.status, ["pending", "active"])));
    const dms = await tx
      .update(channels)
      .set({ archivedAt: now })
      .where(
        and(
          eq(channels.orgId, orgId),
          eq(channels.kind, "dm"),
          isNull(channels.archivedAt),
          like(channels.dmKey, `%a:${agentId}%`),
        ),
      )
      .returning({ id: channels.id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.deleted",
      target: { type: "agent", id: agentId },
      details: { name: agent.name, handle: agent.handle },
    });
    await recordOperatorEvent(tx, { type: "agent.deleted", orgId, userId: actorId, data: { agentId } });
    return { released, dms };
  });
  invalidateOrg(orgId);
  // What it waited on people for (approvals, questions, handoffs, secrets) leaves their inboxes, as a closed source
  // does.
  const waiting = await db
    .selectDistinct({ groupKey: notifications.groupKey })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, orgId),
        isNull(notifications.doneAt),
        eq(notifications.waiting, true),
        inArray(notifications.kind, ["approval", "agent_question", "browser_handoff", "secret_request"]),
        sql`${notifications.actors} @> ${JSON.stringify([{ type: "agent", id: agentId }])}::jsonb`,
      ),
    );
  for (const { groupKey } of waiting) await resolveNotifications(deps, orgId, { groupKey });
  await announceReleasedAccounts(deps.pubsub, released);
  for (const dm of dms) await publishOrgEvent(deps.pubsub, { type: "channel.archived", orgId, channelId: dm.id });
  await publishAgentsChanged(deps.pubsub, orgId);
  await publishChannelsChanged(deps.pubsub, orgId);
  // Its computer lists its agents again without it: the runner stops its desktop and takes back lent folders.
  await publishMachineAgentsChanged(deps.pubsub, orgId);
}

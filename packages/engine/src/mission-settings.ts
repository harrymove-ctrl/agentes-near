import { and, eq, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import {
  type MissionRuleView,
  missionAllowRuleRows,
  missionCommandStats,
  removeMissionAllowRule,
} from "./mission-command-rules";
import {
  agentMissionApproval,
  type CommandApproval,
  getMission,
  isCommandApproval,
  type MissionDeps,
  publishMissionEvent,
  recordMissionEvent,
  requireAct,
  requireMission,
  requireOpen,
} from "./missions";
import { can, requirePermission } from "./organizations";

/**
 * "Configurações da missão" (ADR 0029): what the
 * dialog reads in one call (the rules allowed for the whole mission, what
 * happened to its commands, the agent's default for new missions) and the
 * writes it makes besides the autonomy itself (`setCommandApproval`):
 * taking a rule back, "Retomar sozinho quando ele voltar" (`resume_tasks`)
 * and "Usar como padrão" for the agent's next missions.
 */

/** Who may set an agent's defaults: an admin (`manage_agents`) or the agent's owner. */
async function mayManageAgent(deps: Pick<MissionDeps, "db">, userId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(deps.db, userId, orgId, "read");
  const agent = await getAgent(deps.db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  return { agent, allowed: can(membership, "manage_agents") || agent.ownerUserId === userId };
}

export interface MissionSettingsView {
  missionId: string;
  /** "O que já foi liberado": the rules in force, oldest first. */
  rules: MissionRuleView[];
  /** "Nesta missão: N liberados automaticamente · N perguntados · N bloqueados". */
  stats: { auto: number; asked: number; blocked: number };
  /** "Próximas missões do <agente>". */
  agentDefault: {
    commandApproval: CommandApproval;
    /** The caller may change it (an admin or the agent's owner). */
    canSet: boolean;
    /** Who to ask otherwise. */
    ownerId: string | null;
  };
}

/** The dialog's data, for whoever reads the mission's conversation. */
export async function getMissionSettings(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
): Promise<MissionSettingsView> {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  const [rules, stats, agent] = await Promise.all([
    missionAllowRuleRows(deps.db, mission.id),
    missionCommandStats(deps.db, mission.id),
    mayManageAgent(deps, userId, orgId, mission.agentId).catch(() => null),
  ]);
  return {
    missionId: mission.id,
    rules,
    stats,
    agentDefault: {
      commandApproval: agentMissionApproval(agent?.agent),
      canSet: agent?.allowed === true,
      ownerId: agent?.agent.ownerUserId ?? null,
    },
  };
}

/**
 * The × on a rule in "O que já foi liberado" (owner or someone who decides):
 * the command no longer runs by itself in this mission; the runner gets the
 * new list with its next task. Audited.
 */
export async function removeCommandRule(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  ruleId: string,
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "change what is allowed");
  requireOpen(mission);
  const removed = /^[0-9a-f-]{36}$/i.test(ruleId)
    ? await removeMissionAllowRule(deps.db, mission, ruleId, { userId })
    : null;
  if (!removed) throw new NotFoundError("That rule isn't allowed in this mission", "mission.rule_not_found");
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "mission.command_rule_removed",
    target: { type: "mission", id: mission.id },
    details: { ruleId, rule: removed.rule },
  });
  await publishMissionEvent(deps, mission, "command", { ruleId });
  return { rules: await missionAllowRuleRows(deps.db, mission.id) };
}

/**
 * "Se o computador desligar → Retomar sozinho quando ele voltar" (owner or
 * someone who decides): interrupted tasks start again by themselves, or wait
 * for a person in the chat. Audited.
 */
export async function setMissionResumeTasks(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  value: unknown,
) {
  if (typeof value !== "boolean") throw new ValidationError("resumeTasks is on or off", "mission.invalid");
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "change this");
  requireOpen(mission);
  if (mission.resumeTasks !== value) {
    await deps.db.transaction(async (tx) => {
      await tx
        .update(schema.missions)
        .set({ resumeTasks: value, updatedAt: new Date() })
        .where(sql`${schema.missions.id} = ${mission.id}::uuid`);
      await recordMissionEvent(tx, mission, "resume_tasks", { by: userId, to: value });
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: userId },
        action: "mission.resume_tasks",
        target: { type: "mission", id: mission.id },
        details: { from: mission.resumeTasks, to: value },
      });
    });
    await publishMissionEvent(deps, mission, "settings", { resumeTasks: value });
  }
  return getMission(deps, userId, orgId, missionId);
}

/**
 * "Usar como padrão": the autonomy the agent's next missions start with (its
 * current ones don't change). An admin or the agent's owner. Audited, with
 * `options.audit` added to the entry.
 */
export async function setAgentMissionApproval(
  deps: Pick<MissionDeps, "db">,
  userId: string,
  orgId: string,
  agentId: string,
  value: unknown,
  options: { audit?: Record<string, unknown> } = {},
): Promise<{ commandApproval: CommandApproval }> {
  if (!isCommandApproval(value)) {
    throw new ValidationError("Choose always, low_risk_auto or never", "mission.invalid_command_approval");
  }
  const { agent, allowed } = await mayManageAgent(deps, userId, orgId, agentId);
  if (!allowed) {
    throw new ForbiddenError("Only an admin or the agent's owner can change its default", "agent.not_owner");
  }
  const from = agentMissionApproval(agent);
  await deps.db
    .update(schema.agents)
    .set({ missionCommandApproval: value, updatedAt: new Date() })
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)));
  caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "agent.mission_command_approval",
    target: { type: "agent", id: agentId },
    details: { from, to: value, ...options.audit },
  });
  return { commandApproval: value };
}

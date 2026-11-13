import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, eq, gte, inArray, isNull, lt, schema, sql } from "@agenteschat/db";
import { MODEL_TIERS, type ModelTier } from "@agenteschat/providers";
import { getAgent } from "./agents";
import { decidableBySql } from "./approvals";
import { recordAudit } from "./audit";
import type { AutoModels } from "./auto-model";
import { caches } from "./cache";
import {
  announceChannelLeavers,
  CHANNEL_NAME_PATTERN,
  channelRoleIds,
  dropRoleLeavers,
  managesChannel,
  placesAgentsIn,
  readableChannelIds,
} from "./channels";
import { proposalsWaitingFor } from "./context/proposals";
import { invalidateDefaults, modelInfoFor } from "./credentials";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishChannelsChanged } from "./events";
import { agentBudgetState } from "./gateway";
import {
  AGENT_MEDIA_LEVELS,
  type AgentMediaLevel,
  GIF_RATINGS,
  type GifRating,
  type MediaSettings,
  mediaSettingsCacheKey,
  mediaSettingsFrom,
} from "./media";
import { can, lockOrgMembers, requireActiveMembership, requirePermission } from "./organizations";
import { isRightHand, rightHandPermanent } from "./right-hand";
import {
  agentBudgetsThisMonth,
  budgetPercent,
  DEFAULT_AGENT_BUDGET_NANO_USD,
  effectiveAgentBudget,
  monthStartUtc,
  orgDefaultAgentBudget,
  workspaceBudgetPercent,
} from "./usage";
import { resumeBudgetWaits } from "./usage-pause";
import { isWorkspaceMode, WORKSPACE_MODES, type WorkspaceMode, workspaceModeCacheKey } from "./workspace-mode";

const {
  organizations,
  organizationSettings,
  organizationMembers,
  agents,
  channels,
  channelMembers,
  agentRuns,
  agentRunSteps,
  usageRecords,
  messages,
  approvals,
  providerCredentials,
  users,
} = schema;

// ── Organization settings ────────────────────────────────────────────────────

/**
 * With the GIF and sticker switches (ADR 0091 §5): `gifs`, `gifRating`, `agentStickers`, `agentMedia`.
 */
export interface OrgSettings extends MediaSettings {
  name: string;
  context: string;
  defaultCredentialId: string | null;
  /** Default key per provider. */
  defaultCredentialIds: Record<string, string>;
  routerModel: string | null;
  summaryModel: string | null;
  timezone: string;
  /** From onboarding: `solo`, `small`, `medium` or `large`. */
  teamSize: TeamSize | null;
  /** Monthly budget of agents without their own (nano-USD). Routes show it to admins only. */
  defaultAgentBudgetNanoUsd: number;
  /** Agents check what the team already did before an outside action (ADR 0064). On by default. */
  actionCheck: boolean;
  /** People can send voice messages (ADR 0100); they also need `voiceAvailable`. On by default. */
  voiceMessages: boolean;
  /** Per provider, the models "Automático" picks per tier where the workspace chose its own (ADR 0087). */
  autoModels: AutoModels;
  /** Who the workspace is for (ADR 0159): `team` or `personal`. */
  mode: WorkspaceMode;
}

export const TEAM_SIZES = ["solo", "small", "medium", "large"] as const;
export type TeamSize = (typeof TEAM_SIZES)[number];

export async function getOrgSettings(db: Database, actorId: string, orgId: string): Promise<OrgSettings> {
  await requirePermission(db, actorId, orgId, "read");
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new NotFoundError("Organization not found");
  const [s] = await db.select().from(organizationSettings).where(eq(organizationSettings.orgId, orgId));
  return {
    name: org.name,
    context: org.context,
    defaultCredentialId: s?.defaultCredentialId ?? null,
    defaultCredentialIds: (s?.defaultCredentialIds ?? {}) as Record<string, string>,
    routerModel: s?.routerModel ?? null,
    summaryModel: s?.summaryModel ?? null,
    timezone: s?.timezone ?? "UTC",
    teamSize: TEAM_SIZES.includes(s?.teamSize as TeamSize) ? (s?.teamSize as TeamSize) : null,
    defaultAgentBudgetNanoUsd: s?.defaultAgentBudgetNanoUsd ?? DEFAULT_AGENT_BUDGET_NANO_USD,
    actionCheck: s?.actionCheck ?? true,
    voiceMessages: s?.voiceMessages ?? true,
    autoModels: (s?.autoModels ?? {}) as AutoModels,
    mode: isWorkspaceMode(s?.mode) ? s.mode : "team",
    ...mediaSettingsFrom(s),
  };
}

export const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Updates name, context (goes into every agent's prompt) and settings. Admins (`configure`). */
export async function updateOrgSettings(
  db: Database,
  actorId: string,
  orgId: string,
  input: Partial<Omit<OrgSettings, "defaultCredentialIds" | "autoModels">> & {
    defaultCredentialIds?: Partial<Record<string, string | null>>;
    /** Per provider and tier, a model of that provider; null puts the tier back on the default. */
    autoModels?: Partial<Record<string, Partial<Record<ModelTier, string | null>>>>;
  },
): Promise<OrgSettings> {
  await requirePermission(db, actorId, orgId, "configure");
  if (input.name !== undefined && input.name.trim() === "") throw new ValidationError("name can't be empty");
  for (const model of [input.routerModel, input.summaryModel]) {
    if (!model) continue;
    const info = await modelInfoFor(db, model, orgId);
    if (!info) throw new ValidationError(`Unknown model ${model}`);
    // Routing and summaries answer through a JSON schema.
    if (info.structuredOutput === false) throw new ValidationError(`${model} can't follow a JSON schema`);
  }
  for (const [provider, tiers] of Object.entries(input.autoModels ?? {})) {
    for (const [tier, model] of Object.entries(tiers ?? {})) {
      if (!MODEL_TIERS.includes(tier as ModelTier)) throw new ValidationError(`autoModels has no tier ${tier}`);
      if (model === null) continue;
      if ((await modelInfoFor(db, model, orgId))?.provider !== provider)
        throw new ValidationError(`autoModels.${provider}.${tier} must be one of ${provider}'s models`);
    }
  }
  if (input.teamSize && !TEAM_SIZES.includes(input.teamSize)) throw new ValidationError("invalid teamSize");
  if (input.mode !== undefined && !isWorkspaceMode(input.mode))
    throw new ValidationError(`mode must be one of ${WORKSPACE_MODES.join(", ")}`);
  if (input.defaultAgentBudgetNanoUsd !== undefined && !(input.defaultAgentBudgetNanoUsd > 0)) {
    throw new ValidationError("the default agent budget must be above zero");
  }
  if (input.timezone !== undefined && !isValidTimeZone(input.timezone))
    throw new ValidationError("timezone must be an IANA time zone");
  if (input.gifRating !== undefined && !GIF_RATINGS.includes(input.gifRating as GifRating))
    throw new ValidationError(`gifRating must be one of ${GIF_RATINGS.join(", ")}`);
  if (input.agentMedia !== undefined && !AGENT_MEDIA_LEVELS.includes(input.agentMedia as AgentMediaLevel))
    throw new ValidationError(`agentMedia must be one of ${AGENT_MEDIA_LEVELS.join(", ")}`);
  for (const [provider, id] of Object.entries(input.defaultCredentialIds ?? {})) {
    if (!id) continue;
    const [cred] = await db
      .select({ provider: providerCredentials.provider })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, id),
          eq(providerCredentials.orgId, orgId),
          isNull(providerCredentials.revokedAt),
        ),
      );
    if (!cred) throw new ValidationError(`defaultCredentialIds.${provider} does not belong to this organization`);
    if (cred.provider !== provider)
      throw new ValidationError(`defaultCredentialIds.${provider} is a ${cred.provider} key`);
  }
  if (input.defaultCredentialId) {
    const [cred] = await db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, input.defaultCredentialId),
          eq(providerCredentials.orgId, orgId),
          isNull(providerCredentials.revokedAt),
        ),
      );
    if (!cred) throw new ValidationError("defaultCredentialId does not belong to this organization");
  }
  await db.transaction(async (tx) => {
    // The mode before this change, read in the transaction: a switch is audited with where it came from.
    const modeBefore =
      input.mode === undefined
        ? undefined
        : ((
            await tx
              .select({ mode: organizationSettings.mode })
              .from(organizationSettings)
              .where(eq(organizationSettings.orgId, orgId))
          )[0]?.mode ?? "team");
    const storedAutoModels = async () => {
      const [row] = await tx
        .select({ autoModels: organizationSettings.autoModels })
        .from(organizationSettings)
        .where(eq(organizationSettings.orgId, orgId));
      return (row?.autoModels ?? {}) as AutoModels;
    };
    if (input.name !== undefined || input.context !== undefined) {
      await tx
        .update(organizations)
        .set({
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
        })
        .where(eq(organizations.id, orgId));
    }
    const settings = {
      ...(input.defaultCredentialId !== undefined ? { defaultCredentialId: input.defaultCredentialId } : {}),
      ...(input.defaultCredentialIds !== undefined
        ? {
            defaultCredentialIds: Object.fromEntries(
              Object.entries(input.defaultCredentialIds).filter(([, v]) => Boolean(v)),
            ) as Record<string, string>,
          }
        : {}),
      ...(input.routerModel !== undefined ? { routerModel: input.routerModel } : {}),
      ...(input.summaryModel !== undefined ? { summaryModel: input.summaryModel } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.teamSize !== undefined ? { teamSize: input.teamSize } : {}),
      ...(input.defaultAgentBudgetNanoUsd !== undefined
        ? { defaultAgentBudgetNanoUsd: Math.round(input.defaultAgentBudgetNanoUsd) }
        : {}),
      ...(input.actionCheck !== undefined ? { actionCheck: input.actionCheck } : {}),
      ...(input.voiceMessages !== undefined ? { voiceMessages: input.voiceMessages } : {}),
      ...(input.gifs !== undefined ? { gifs: input.gifs } : {}),
      ...(input.gifRating !== undefined ? { gifRating: input.gifRating } : {}),
      ...(input.agentStickers !== undefined ? { agentStickers: input.agentStickers } : {}),
      ...(input.agentMedia !== undefined ? { agentMedia: input.agentMedia } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.autoModels !== undefined
        ? { autoModels: mergeAutoModels(await storedAutoModels(), input.autoModels) }
        : {}),
    };
    if (Object.keys(settings).length > 0) {
      await tx
        .insert(organizationSettings)
        .values({ orgId, ...settings })
        .onConflictDoUpdate({ target: organizationSettings.orgId, set: { ...settings, updatedAt: new Date() } });
    }
    if (input.mode !== undefined && modeBefore !== input.mode) {
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "organization.mode_changed",
        target: { type: "organization", id: orgId },
        details: { from: modeBefore, to: input.mode },
      });
    }
  });
  caches.orgs.delete(`${orgId}:`);
  caches.orgs.delete(`${orgId}:agent-budget`);
  // Agents on the default budget whose runs wait for it look again now (the rest park again quietly).
  if (input.defaultAgentBudgetNanoUsd !== undefined) await resumeBudgetWaits(db, orgId, null);
  caches.orgs.delete(`${orgId}:action-check`);
  caches.orgs.delete(`${orgId}:auto-models`);
  caches.orgs.delete(mediaSettingsCacheKey(orgId));
  caches.orgs.delete(workspaceModeCacheKey(orgId));
  caches.zones.deletePrefix(`${orgId}:`);
  invalidateDefaults(orgId);
  return getOrgSettings(db, actorId, orgId);
}

/** The stored tiers with a change applied: a model sets its tier, null clears it, a provider left with none goes. */
function mergeAutoModels(
  stored: AutoModels,
  change: NonNullable<Parameters<typeof updateOrgSettings>[3]["autoModels"]>,
): AutoModels {
  const out: AutoModels = { ...stored };
  for (const [provider, tiers] of Object.entries(change)) {
    const next: Partial<Record<ModelTier, string>> = { ...out[provider] };
    for (const [tier, model] of Object.entries(tiers ?? {}) as [ModelTier, string | null][]) {
      if (model === null) delete next[tier];
      else next[tier] = model;
    }
    if (Object.keys(next).length > 0) out[provider] = next;
    else delete out[provider];
  }
  return out;
}

/** Counts for the sidebar: people, agents, the workspace's budget use, approvals and proposals waiting for me. */
export async function orgOverview(db: Database, actorId: string, orgId: string, now = new Date()) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [people] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const [agentCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agents)
    // Every agent, the right hand (ADR 0137) included: the sidebar lists it under this count with the others.
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)));
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending"), decidableBySql(actorId)));
  return {
    name: membership.orgName,
    role: membership.role,
    people: people?.n ?? 0,
    agents: agentCount?.n ?? 0,
    /** This month's spend of the workspace's agents over the sum of their budgets (no money). */
    budgetUsedPercent: await workspaceBudgetPercent(db, orgId, now),
    approvalsWaitingForMe: pending?.n ?? 0,
    proposalsWaitingForMe: await proposalsWaitingFor(db, actorId, orgId),
  };
}

// ── Agents ───────────────────────────────────────────────────────────────────

/** An agent with its spend, runs and channels this month (Agent screen). */
export async function agentDetail(db: Database, actorId: string, orgId: string, agentId: string, now = new Date()) {
  await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const since = monthStartUtc(now);
  const [usage] = await db
    .select({
      // What its budget paid: its own calls, as `agentBudgetsThisMonth` counts them.
      cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}) filter (where ${usageRecords.kind} = 'agent'), 0)`,
      tokens: sql<string>`coalesce(sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens}), 0)`,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.orgId, orgId), eq(usageRecords.agentId, agentId), gte(usageRecords.createdAt, since)));
  // Runs and failures per day of the month (UTC, like the month itself): the Atividade tab draws them.
  const byDay = await db
    .select({
      day: sql<number>`extract(day from ${agentRuns.createdAt} at time zone 'UTC')::int`,
      runs: sql<number>`count(*)::int`,
      failed: sql<number>`(count(*) filter (where ${agentRuns.status} = 'failed'))::int`,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, agentId), gte(agentRuns.createdAt, since)))
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(approvals)
    .where(and(eq(approvals.agentId, agentId), eq(approvals.status, "pending")));
  const channelsOf = await listAgentChannels(db, actorId, orgId, agentId);
  const budget = await agentBudgetState(db, orgId, agentId, now);
  const budgetNanoUsd = await effectiveAgentBudget(db, agent);
  const spentNanoUsd = Number(usage?.cost ?? 0);
  return {
    agent,
    month: {
      since,
      spentNanoUsd,
      reservedNanoUsd: budget.reservedNanoUsd,
      /** Its own budget, else the organization's default. */
      budgetNanoUsd,
      budgetUsedPercent: budgetPercent(spentNanoUsd, budgetNanoUsd),
      tokens: Number(usage?.tokens ?? 0),
      runs: byDay.reduce((n, d) => n + d.runs, 0),
      failures: byDay.reduce((n, d) => n + d.failed, 0),
      /** Only the days with runs. */
      byDay,
    },
    pendingApprovals: pending?.n ?? 0,
    channels: channelsOf,
  };
}

export async function listAgentChannels(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [rows, ownChannels] = await Promise.all([
    db
      .select({
        id: channels.id,
        name: channels.name,
        autoReply: channelMembers.autoReply,
        kind: channels.kind,
        visibility: channels.visibility,
      })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.agentId, agentId), isNull(channels.archivedAt)))
      .orderBy(asc(channels.name)),
    db
      .select({ channelId: channelMembers.channelId })
      .from(channelMembers)
      .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, actorId))),
  ]);
  const visible = new Set(ownChannels.map((row) => row.channelId));
  const admin = can(membership, "manage_agents");
  return rows
    .filter((row) => visible.has(row.id) || (row.kind === "channel" && (row.visibility === "public" || admin)))
    .map(({ id, name, autoReply }) => ({ id, name, autoReply }));
}

/**
 * Sets where an agent works: the channels it belongs to and, per channel, whether the router may pick it without a
 * mention. Its owner or who may manage every agent (`manage_agents`) sets it, and puts it in or takes it out of a
 * channel only where they're a member who may post, or that they manage (`placesAgentsIn`, the rule a channel's
 * members follow too). The list replaces the channels `listAgentChannels` shows them: a private channel they can't
 * see, a DM or an archived channel stays as it is.
 */
export async function setAgentChannels(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  input: { channelId: string; autoReply?: boolean }[],
  options: { pubsub?: PubSub } = {},
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  const admin = can(membership, "manage_agents");
  if (!admin && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can change where it works");
  }
  if (input.length > 0 && isRightHand(agent)) throw rightHandPermanent("added to a channel");
  const wanted = new Map(input.map((c) => [c.channelId, c.autoReply]));
  const ids = [...wanted.keys()];
  const columns = {
    id: channels.id,
    kind: channels.kind,
    visibility: channels.visibility,
    createdByUserId: channels.createdByUserId,
  };
  const [current, found, mine] = await Promise.all([
    db
      .select({ ...columns, autoReply: channelMembers.autoReply })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.agentId, agentId), isNull(channels.archivedAt))),
    ids.length > 0
      ? db
          .select(columns)
          .from(channels)
          .where(and(eq(channels.orgId, orgId), inArray(channels.id, ids), isNull(channels.archivedAt)))
      : [],
    db
      .select({ id: channelMembers.channelId })
      .from(channelMembers)
      .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, actorId))),
  ]);
  if (found.length !== ids.length) throw new ValidationError("Every channel must belong to this organization");
  const inIt = new Set(current.map((c) => c.id));
  const adding = found.filter((c) => !inIt.has(c.id));
  if (adding.some((c) => c.kind === "dm")) throw new ValidationError("A direct conversation keeps its participants");
  const actorIn = new Set(mine.map((c) => c.id));
  const removing = current.filter(
    (c) => c.kind === "channel" && !wanted.has(c.id) && (actorIn.has(c.id) || c.visibility === "public" || admin),
  );
  if ([...adding, ...removing].some((c) => !placesAgentsIn(membership, actorId, c, actorIn.has(c.id)))) {
    throw new ForbiddenError("An agent joins or leaves only the channels you're in or manage");
  }
  const retuned = current.flatMap((c) => {
    const autoReply = wanted.get(c.id);
    return c.kind !== "dm" && autoReply !== undefined && autoReply !== c.autoReply ? [{ id: c.id, autoReply }] : [];
  });
  await db.transaction(async (tx) => {
    if (removing.length > 0) {
      await tx.delete(channelMembers).where(
        and(
          eq(channelMembers.orgId, orgId),
          eq(channelMembers.agentId, agentId),
          inArray(
            channelMembers.channelId,
            removing.map((c) => c.id),
          ),
        ),
      );
    }
    for (const c of adding) {
      await tx
        .insert(channelMembers)
        .values({ orgId, channelId: c.id, agentId, autoReply: wanted.get(c.id) ?? true })
        .onConflictDoNothing();
    }
    for (const c of retuned) {
      await tx
        .update(channelMembers)
        .set({ autoReply: c.autoReply })
        .where(and(eq(channelMembers.channelId, c.id), eq(channelMembers.agentId, agentId)));
    }
  });
  caches.channelMembers.deletePrefix(`${orgId}:`);
  caches.scopes.deletePrefix(`${orgId}:${agentId}:visible`);
  // Each channel's members column follows, as when it is added or taken out from the channel itself.
  const member = (autoReply?: boolean) => ({
    type: "agent" as const,
    id: agentId,
    ...(autoReply === undefined ? {} : { autoReply }),
  });
  for (const c of adding)
    await publishChannelEvent(options.pubsub, {
      type: "channel.member_added",
      channelId: c.id,
      member: member(wanted.get(c.id) ?? true),
    });
  for (const c of removing)
    await publishChannelEvent(options.pubsub, { type: "channel.member_removed", channelId: c.id, member: member() });
  for (const c of retuned)
    await publishChannelEvent(options.pubsub, {
      type: "channel.member_updated",
      channelId: c.id,
      member: member(c.autoReply),
    });
  if (adding.length + removing.length + retuned.length > 0) await publishChannelsChanged(options.pubsub, orgId);
  return listAgentChannels(db, actorId, orgId, agentId);
}

// ── Channels ─────────────────────────────────────────────────────────────────

/**
 * Renames a channel or changes its topic or who may join (creator or admin). `audienceRoleIds` limits a private
 * channel to departments or roles (ADR 0125; empty: invite only); dropping a role takes out the people who were
 * there through it alone.
 */
export async function updateChannel(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  input: { name?: string; topic?: string; visibility?: "public" | "private"; audienceRoleIds?: string[] },
  options: { pubsub?: PubSub } = {},
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId), isNull(channels.archivedAt)));
  if (!channel) throw new NotFoundError("Channel not found");
  if (!(await managesChannel(db, membership, actorId, channel))) {
    throw new ForbiddenError("Only the channel's creator or an admin can change it");
  }
  const name = input.name?.trim().toLowerCase();
  if (name !== undefined && !CHANNEL_NAME_PATTERN.test(name))
    throw new ValidationError("channel name: lower-case letters, digits, - or _ (max 80)");
  if (channel.name === "general" && name !== undefined && name !== "general")
    throw new ValidationError("#general can't be renamed");
  if (channel.kind === "dm") throw new ValidationError("A direct conversation keeps its participants");
  const accessChanges = input.visibility !== undefined || input.audienceRoleIds !== undefined;
  const visibility = input.visibility ?? channel.visibility;
  const asked =
    visibility === "public" || input.audienceRoleIds === undefined
      ? undefined
      : await channelRoleIds(db, orgId, visibility, input.audienceRoleIds);
  try {
    const { row, leavers } = await db.transaction(async (tx) => {
      let access = {};
      let dropped: string[] = [];
      if (accessChanges) {
        // Under the lock deleteRole and joinChannel take, on the roles as they are now: a role deleted meanwhile is
        // neither written back nor missed by the leavers.
        await lockOrgMembers(tx, orgId);
        const [now] = await tx
          .select({ audienceRoleIds: channels.audienceRoleIds })
          .from(channels)
          .where(eq(channels.id, channelId));
        const before = now?.audienceRoleIds ?? [];
        const audienceRoleIds = visibility === "public" ? [] : (asked ?? before);
        // Turned invite only, whoever is in stays; still limited to roles, only the dropped roles' people go.
        dropped = audienceRoleIds.length > 0 ? before.filter((id) => !audienceRoleIds.includes(id)) : [];
        access = { visibility, audienceRoleIds };
      }
      const [row] = await tx
        .update(channels)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(input.topic !== undefined ? { topic: input.topic } : {}),
          ...access,
        })
        .where(eq(channels.id, channelId))
        .returning();
      return { row, leavers: row ? await dropRoleLeavers(tx, orgId, { channelId, roleIds: dropped }) : [] };
    });
    if (!row) throw new NotFoundError("Channel not found");
    caches.channels.delete(`${orgId}:${channelId}`);
    // What agents may search depends on visibility (agentSearchChannels).
    if (input.visibility !== undefined) caches.scopes.deletePrefix(`${orgId}:`);
    await announceChannelLeavers({ db, pubsub: options.pubsub }, orgId, leavers);
    await publishChannelsChanged(options.pubsub, orgId);
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`#${name} already exists`);
    throw error;
  }
}

/** Members of a channel with names, for the channel details panel. */
export async function channelMembersDetail(db: Database, orgId: string, channelId: string) {
  return db
    .select({
      userId: channelMembers.userId,
      agentId: channelMembers.agentId,
      autoReply: channelMembers.autoReply,
      userName: users.name,
      agentName: agents.name,
      agentHandle: agents.handle,
      joinedAt: channelMembers.createdAt,
    })
    .from(channelMembers)
    .leftJoin(users, eq(users.id, channelMembers.userId))
    .leftJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), isNull(agents.archivedAt)))
    .orderBy(asc(channelMembers.createdAt));
}

// ── Runs and usage ───────────────────────────────────────────────────────────

/** Who may see runs and usage: admins (`view_usage`), or the agent's owner for that agent. */
async function requireUsageAccess(db: Database, actorId: string, orgId: string, agentId?: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  if (can(membership, "view_usage")) return;
  if (agentId) {
    const agent = await getAgent(db, orgId, agentId);
    if (agent?.ownerUserId === actorId) return;
  }
  throw new ForbiddenError();
}

export interface RunSummary {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string;
  trigger: string;
  status: string;
  error: string | null;
  /** First part of the message that started the run; empty when `private`. */
  what: string;
  /**
   * The viewer doesn't read the run's conversation: its message and steps stay out, only its numbers (tokens, cost,
   * duration, status) show. Owners, usage viewers and admins included.
   */
  private: boolean;
  /** Started by one of the agent's routines (its trigger carries `meta.routine`), shown even when `private`. */
  routine: boolean;
  turns: number;
  /** Every input token, cache included. */
  inputTokens: number;
  /** How much of `inputTokens` was read from the prompt cache. */
  cachedTokens: number;
  outputTokens: number;
  costNanoUsd: number;
  createdAt: Date;
  finishedAt: Date | null;
  /** The GitHub repository it worked in (`owner/name`), if any. */
  repo: string | null;
  /** A GitHub repository it was refused (not in the agent's list), if any. */
  deniedRepo: string | null;
}

/** Run history, newest first, with tokens and cost from the usage records of each run. */
export async function listRuns(
  db: Database,
  actorId: string,
  orgId: string,
  options: { agentId?: string; runId?: string; status?: string; before?: Date; since?: Date; limit?: number } = {},
): Promise<RunSummary[]> {
  await requireUsageAccess(db, actorId, orgId, options.agentId);
  const limit = Math.min(options.limit ?? 50, 200);
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        options.agentId ? eq(agentRuns.agentId, options.agentId) : undefined,
        options.runId ? eq(agentRuns.id, options.runId) : undefined,
        options.status ? sql`${agentRuns.status}::text = ${options.status}` : undefined,
        options.before ? lt(agentRuns.createdAt, options.before) : undefined,
        options.since ? gte(agentRuns.createdAt, options.since) : undefined,
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const usage = await db
    .select({
      runId: usageRecords.runId,
      input: sql<string>`sum(${usageRecords.inputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens})`,
      cached: sql<string>`sum(${usageRecords.cacheReadTokens})`,
      output: sql<string>`sum(${usageRecords.outputTokens})`,
      cost: sql<string>`sum(${usageRecords.costNanoUsd})`,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.orgId, orgId), inArray(usageRecords.runId, ids)))
    .groupBy(usageRecords.runId);
  const byRun = new Map(usage.map((u) => [u.runId, u]));
  const triggers = await db
    .select({ id: messages.id, body: messages.body, meta: messages.meta })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        inArray(
          messages.id,
          rows.map((r) => r.triggerMessageId),
        ),
      ),
    );
  const bodies = new Map(triggers.map((t) => [t.id, t.body]));
  const routineTriggers = new Set(triggers.filter((t) => t.meta?.routine != null).map((t) => t.id));
  const readable = await readableChannelIds(
    db,
    orgId,
    actorId,
    rows.map((r) => r.channelId),
  );
  return rows.map((r) => {
    const u = byRun.get(r.id);
    const hidden = !readable.has(r.channelId);
    return {
      id: r.id,
      agentId: r.agentId,
      channelId: r.channelId,
      threadId: r.threadRootId,
      trigger: r.trigger,
      status: r.status,
      error: r.error,
      what: hidden ? "" : (bodies.get(r.triggerMessageId) ?? "").slice(0, 200),
      private: hidden,
      routine: routineTriggers.has(r.triggerMessageId),
      turns: r.turns,
      inputTokens: Number(u?.input ?? 0),
      cachedTokens: Number(u?.cached ?? 0),
      outputTokens: Number(u?.output ?? 0),
      costNanoUsd: Number(u?.cost ?? 0),
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      repo: typeof r.transcript?.repo === "string" ? r.transcript.repo : null,
      deniedRepo: typeof r.transcript?.deniedRepo === "string" ? r.transcript.deniedRepo : null,
    };
  });
}

/** One run with its steps (audit trail). */
export async function getRun(db: Database, actorId: string, orgId: string, runId: string) {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!run) throw new NotFoundError("Run not found");
  await requireUsageAccess(db, actorId, orgId, run.agentId);
  const [summary] = await listRuns(db, actorId, orgId, { agentId: run.agentId, runId });
  if (!summary || summary.private) return { run: summary, steps: [] };
  const steps = await db
    .select({
      seq: agentRunSteps.seq,
      kind: agentRunSteps.kind,
      data: agentRunSteps.data,
      createdAt: agentRunSteps.createdAt,
    })
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(asc(agentRunSteps.seq));
  return { run: summary, steps };
}

/**
 * Usage of the organization since `since` (default: this month): totals by
 * kind (agent, router, embedding, summary) and per agent with budgets.
 */
export async function usageReport(db: Database, actorId: string, orgId: string, options: { since?: Date } = {}) {
  await requirePermission(db, actorId, orgId, "view_usage");
  const since = options.since ?? monthStartUtc(new Date());
  const byKind = await db
    .select({
      kind: usageRecords.kind,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<string>`sum(${usageRecords.inputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens})`,
      outputTokens: sql<string>`sum(${usageRecords.outputTokens})`,
      cost: sql<string>`sum(${usageRecords.costNanoUsd})`,
      partial: sql<number>`count(*) filter (where ${usageRecords.partial})::int`,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.orgId, orgId), gte(usageRecords.createdAt, since), eq(usageRecords.billedTo, "org")))
    .groupBy(usageRecords.kind);
  // Calls the server's own keys pay for (Jev) are reported apart, never in the org's total.
  const [platform] = await db
    .select({ calls: sql<number>`count(*)::int`, cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)` })
    .from(usageRecords)
    .where(
      and(eq(usageRecords.orgId, orgId), gte(usageRecords.createdAt, since), eq(usageRecords.billedTo, "platform")),
    );
  const perAgent = await db
    .select({
      agentId: agents.id,
      handle: agents.handle,
      name: agents.name,
      budget: agents.monthlyBudgetNanoUsd,
      calls: sql<number>`count(${usageRecords.id})::int`,
      inputTokens: sql<string>`coalesce(sum(${usageRecords.inputTokens} + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${usageRecords.outputTokens}), 0)`,
      cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`,
    })
    .from(agents)
    .leftJoin(
      usageRecords,
      and(eq(usageRecords.agentId, agents.id), gte(usageRecords.createdAt, since), eq(usageRecords.orgId, orgId)),
    )
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .groupBy(agents.id, agents.handle, agents.name, agents.monthlyBudgetNanoUsd)
    .orderBy(asc(agents.handle));
  const budgets = await agentBudgetsThisMonth(db, orgId);
  const kinds = byKind.map((k) => ({
    kind: k.kind,
    calls: k.calls,
    partialCalls: k.partial,
    inputTokens: Number(k.inputTokens),
    outputTokens: Number(k.outputTokens),
    costNanoUsd: Number(k.cost),
  }));
  return {
    since,
    defaultAgentBudgetNanoUsd: await orgDefaultAgentBudget(db, orgId),
    totalNanoUsd: kinds.reduce((n, k) => n + k.costNanoUsd, 0),
    byKind: kinds,
    platformBilled: { calls: platform?.calls ?? 0, costNanoUsd: Number(platform?.cost ?? 0) },
    agents: perAgent.map((a) => {
      const budget = budgets.get(a.agentId);
      const budgetNanoUsd = budget?.budgetNanoUsd ?? a.budget ?? DEFAULT_AGENT_BUDGET_NANO_USD;
      return {
        agentId: a.agentId,
        handle: a.handle,
        name: a.name,
        calls: a.calls,
        inputTokens: Number(a.inputTokens),
        outputTokens: Number(a.outputTokens),
        costNanoUsd: Number(a.cost),
        /** Its effective budget (own or default); `budgetIsDefault` tells which. */
        monthlyBudgetNanoUsd: budgetNanoUsd,
        budgetIsDefault: a.budget === null,
        budgetUsedPercent: budgetPercent(budget?.spentNanoUsd ?? 0, budgetNanoUsd),
      };
    }),
  };
}

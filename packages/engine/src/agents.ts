import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  arrayContains,
  asc,
  type Database,
  type Executor,
  eq,
  inArray,
  isNotNull,
  isNull,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { AUTO_MODEL, isAutoModel, MODEL_CATALOG, parseCustomModel } from "@agenteschat/providers";
import { isIdHandle } from "@agenteschat/ui/names";
import type { AgentAppearance } from "./appearance";
import { dropAgentRules } from "./approval-rules";
import { answersOthers, audienceOf, canTalkTo, speakerFor } from "./audience";
import { recordAudit } from "./audit";
import { type AutonomySettings, autonomySettings, chosenAutonomy } from "./autonomy-settings";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { modelInfoFor } from "./credentials";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged } from "./events";
import type { CommandApproval } from "./missions";
import { recordOperatorEvent } from "./operator-events";
import { can, getMembership, type Membership, requirePermission } from "./organizations";
import { isRightHand, RIGHT_HAND_EDITABLE, refuseRightHand, rightHandPermanent } from "./right-hand";
import { newSetup, type SetupExtras, setupOf } from "./setup-checklist";
import {
  CONNECTOR_ALL,
  DEFAULT_AGENT_SCOPES,
  dropForeignMailGrants,
  grantScopes,
  PERSONAL_AGENT_SCOPES,
} from "./tools/scopes";
import { resyncBudgetCounter } from "./usage";
import { resumeBudgetWaits } from "./usage-pause";
import { isPersonalWorkspace } from "./workspace-mode";

const { agents, connectorConnections, importItems, machines, organizationMembers, providerCredentials } = schema;

export type Agent = typeof agents.$inferSelect;

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Every handle an agent can't take: the other agents' (archived and deleted ones too), the ones they had, people's. */
export async function takenHandles(db: Executor, orgId: string, exceptAgentId?: string): Promise<Set<string>> {
  const [bots, people] = await Promise.all([
    db
      .select({ id: agents.id, handle: agents.handle, previous: agents.previousHandles })
      .from(agents)
      .where(eq(agents.orgId, orgId)),
    db
      .select({ handle: organizationMembers.handle })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId)),
  ]);
  return new Set([
    ...bots.flatMap((b) => (b.id === exceptAgentId ? [] : [b.handle, ...b.previous])),
    ...people.flatMap((p) => (p.handle ? [p.handle] : [])),
  ]);
}

/** `base` with the first free number after a dash (`scout` → `scout-2`) in 32 characters, as the apps suggest. */
export function freeHandle(base: string, taken: Set<string>) {
  for (let n = 2; ; n++) {
    const handle = `${base.slice(0, 31 - String(n).length).replace(/[-_]+$/, "")}-${n}`;
    if (!taken.has(handle)) return handle;
  }
}

/** "@ada is taken", with the first free one (`ada-2`) for the apps to offer. */
const handleTaken = (handle: string, taken: Set<string>) => {
  const suggestion = freeHandle(handle, taken);
  return new ConflictError(`@${handle} is already taken. How about @${suggestion}?`, "agent.handle_taken", {
    handle,
    suggestion,
  });
};

export interface AgentInput {
  name: string;
  handle: string;
  role?: string;
  instructions?: string;
  model?: string;
  credentialId?: string | null;
  ownerUserId?: string | null;
  monthlyBudgetNanoUsd?: number | null;
  /** It may follow a light reply with a sticker or a GIF (ADR 0091), as often as the workspace allows. */
  mediaReplies?: boolean;
  /** Its autonomy brakes (ADR 0131), stored as `autonomySettings` reads them. */
  autonomyBrakes?: Partial<AutonomySettings>;
}

/** An agent's fields as the API takes them: its handle, model, key (of the model's provider), budget and owner. */
export async function validateAgentFields(db: Database, orgId: string, input: Partial<AgentInput>) {
  if (input.handle !== undefined && !HANDLE_PATTERN.test(input.handle)) {
    throw new ValidationError("handle must be 2–32 characters: lower-case letters, digits, - or _");
  }
  // An id-shaped handle is how mentions written before migration 0132 still name an imported agent (`currentHandles`).
  if (input.handle !== undefined && isIdHandle(input.handle)) {
    throw new ValidationError("handle can't look like an id. Pick one from the agent's name");
  }
  // "auto": each run picks the model from the line of the agent's key (any provider).
  const model = input.model && !isAutoModel(input.model) ? await modelInfoFor(db, input.model, orgId) : undefined;
  if (input.model !== undefined && !isAutoModel(input.model) && !model) {
    throw new ValidationError(
      `model must be ${AUTO_MODEL}, one of: ${Object.keys(MODEL_CATALOG).join(", ")}, or one OpenRouter lists`,
    );
  }
  if (input.monthlyBudgetNanoUsd != null && input.monthlyBudgetNanoUsd < 0) {
    throw new ValidationError("budget can't be negative");
  }
  if (input.credentialId) {
    const [cred] = await db
      .select({ id: providerCredentials.id, provider: providerCredentials.provider })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, input.credentialId),
          eq(providerCredentials.orgId, orgId),
          isNull(providerCredentials.revokedAt),
        ),
      );
    if (!cred) throw new ValidationError("credentialId does not belong to this organization");
    const pinned = input.model ? parseCustomModel(input.model)?.credentialId : undefined;
    if (pinned && pinned !== cred.id) throw new ValidationError("An endpoint's model runs only on its own endpoint");
    if (model && model.provider !== cred.provider) {
      throw new ValidationError(
        `The model ${input.model} is from ${model.provider}, but this key is from ${cred.provider}`,
      );
    }
  }
  if (input.ownerUserId && !(await getMembership(db, input.ownerUserId, orgId))) {
    throw new ValidationError("ownerUserId must be a member of this organization");
  }
}

/** What a person's new agent thinks with when nobody picks a model: "Automático". */
export const NEW_AGENT_DEFAULTS = { model: AUTO_MODEL } as const;

/**
 * An agent's "Quem pensa" and its Autonomia as new agents take them (ADR 0094). Who it answers stays out: a new agent
 * on a plan answers only its owner (ADR 0059 §5).
 */
export function setupOfAgent(a: Agent): schema.AgentSetup {
  const autonomy = a.missionCommandApproval;
  if (!isComputerBrain(a.brain)) {
    return { brain: "model", model: a.model, key: a.credentialId, contextTokens: a.contextTokens, autonomy };
  }
  return {
    brain: a.brain,
    model: a.brainModel,
    machineId: a.machineId,
    account: a.brainAccountId,
    effort: a.brainEffort,
    contextTokens: a.contextTokens,
    fallback: a.brainFallback,
    autonomy,
  };
}

/**
 * What the workspace's new agents start with from now on: the "Quem pensa" someone just saved or used on others.
 * Only whoever creates agents sets it (they start from it), and one on the API only an admin: only admins change an
 * agent's API model and key.
 */
export async function rememberAgentSetup(db: Executor, membership: Membership, setup: schema.AgentSetup) {
  if (!can(membership, "create_agents") || (setup.brain === "model" && !can(membership, "manage_agents"))) return;
  await db
    .insert(schema.organizationSettings)
    .values({ orgId: membership.orgId, agentSetup: setup })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { agentSetup: setup, updatedAt: new Date() },
    });
}

export async function createAgent(
  db: Database,
  actorId: string,
  orgId: string,
  input: AgentInput & {
    autonomy?: CommandApproval;
    audienceMode?: Agent["audienceMode"];
    /**
     * The ready-made role it starts from, for its setup checklist's suggestions (ADR 0155 §2); null: none. From its
     * card (ADR 0164): how it introduced itself, the personal starter it began as and the apps it was made to use.
     */
    setup?: { role: string | null } & SetupExtras;
  },
  defaults: { model: string },
  /** `via`: the agent whose card it was created from (the audit's "via"). */
  options: { remember?: boolean; via?: string; pubsub?: PubSub } = {},
): Promise<Agent> {
  const membership = await requirePermission(db, actorId, orgId, "create_agents");
  const { autonomy, audienceMode, setup, ...fields } = input;
  // `create_agents` makes the creator's own agent (ADR 0085 §5): another owner, or none, is for who edits any agent.
  // So whoever gets this far may also set its Autonomia (ADR 0094): an admin or the new agent's owner.
  if (input.ownerUserId !== undefined && input.ownerUserId !== actorId && !can(membership, "manage_agents")) {
    throw new ForbiddenError("Only an admin can create an agent for someone else or with no owner");
  }
  const values = { ...fields, handle: fields.handle.toLowerCase(), model: fields.model ?? defaults.model };
  await validateAgentFields(db, orgId, values);
  const ownerUserId = input.ownerUserId === undefined ? actorId : input.ownerUserId;
  // A personal workspace's new agent answers only its owner until someone says otherwise (ADR 0159): who joins later
  // (family) isn't answered, nor shown its details, by every agent made while the person was alone. Only a default:
  // an audience given wins (the apps send theirs), agents already there keep theirs, and the right hand, made
  // elsewhere, answers everyone. With no owner nobody would be answered: everyone, as in a team's.
  const personal = await isPersonalWorkspace(db, orgId);
  const audience = audienceMode ?? (ownerUserId && personal ? ("owner" as const) : undefined);
  // Another agent's old handle still names that agent.
  const [held] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), arrayContains(agents.previousHandles, [values.handle])));
  if (held) throw handleTaken(values.handle, await takenHandles(db, orgId));
  // An agent born on "Automático" is automatic on every brain: switched to Claude Code or Codex later, it
  // starts with the model and effort picked per run (written here, so agents made before Automático keep theirs).
  const brainAuto = isAutoModel(values.model) ? { brainModel: AUTO_MODEL, brainEffort: AUTO_MODEL } : {};
  // The workspace's own computer (managed, else the server's own) once it has connected (ADR 0056 §10); one
  // still being prepared gives itself to the agents with none when it is ready.
  const [home] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(
      and(
        eq(machines.orgId, orgId),
        inArray(machines.kind, ["managed", "host"]),
        isNotNull(machines.tokenHash),
        isNull(machines.deletedAt),
      ),
    )
    .orderBy(sql`${machines.kind} = 'managed' desc`, asc(machines.createdAt))
    .limit(1);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        ...values,
        ...brainAuto,
        machineId: home?.id ?? null,
        orgId,
        ownerUserId,
        // Every new agent starts with its setup checklist, whichever way it was made (ADR 0155 §2).
        setup: newSetup(setup?.role, setup),
        ...(autonomy ? { missionCommandApproval: autonomy } : {}),
        ...(audience ? { audienceMode: audience } : {}),
        // The moment of this insert, not its transaction's start (`now()`): agents made together (a template team)
        // keep the order they were made in, which the agents' list and every screen after it follow.
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    if (!agent) throw new Error("agent insert returned nothing");
    // Every agent may read context, keep its own notes and use its computer; everything else is granted explicitly.
    await grantScopes(
      db,
      orgId,
      agent.id,
      DEFAULT_AGENT_SCOPES.map((scope) => ({ connectionId: null, scope })),
    );
    // A personal workspace's agent starts with broad access (ADR 0159 §3a): every app connected there and its
    // calendar. Only from someone who may give access, so a family member's own agent starts as a team's does.
    // Sensitive tools still ask a person on every call; mail, databases and the computer keep their own switches.
    const broad = personal && can(membership, "manage_agents");
    if (broad) {
      const apps = await db
        .select({ id: connectorConnections.id })
        .from(connectorConnections)
        .where(eq(connectorConnections.orgId, orgId));
      await grantScopes(
        db,
        orgId,
        agent.id,
        [
          ...PERSONAL_AGENT_SCOPES.map((scope) => ({ connectionId: null, scope })),
          ...apps.map((c) => ({ connectionId: c.id, scope: CONNECTOR_ALL })),
        ],
        actorId,
      );
    }
    // Skills the org marked "default for new agents".
    const defaults = await db
      .select({ id: schema.skills.id })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.orgId, orgId),
          eq(schema.skills.defaultForNewAgents, true),
          isNull(schema.skills.deletedAt),
        ),
      );
    if (defaults.length > 0) {
      await db
        .insert(schema.agentSkills)
        .values(defaults.map((s) => ({ orgId, agentId: agent.id, skillId: s.id, enabled: true })))
        .onConflictDoNothing();
    }
    // Every agent has a budget (its own or the org's default): the month's counter exists
    // from the start, so the first call reserves in one statement.
    caches.agents.delete(`${orgId}:team`);
    await resyncBudgetCounter(db, orgId, agent.id);
    await recordOperatorEvent(db, { type: "agent.created", orgId, userId: actorId, data: { agentId: agent.id } });
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.created",
      target: { type: "agent", id: agent.id },
      details: {
        name: agent.name,
        handle: agent.handle,
        model: agent.model,
        ...(autonomy ? { autonomy } : {}),
        ...(broad ? { access: "broad" } : {}),
        ...(options.via ? { via: options.via } : {}),
      },
    });
    // A model or key the creator picked is their latest choice; "Automático" with the default key is no choice.
    if (options.remember && (!isAutoModel(agent.model) || agent.credentialId)) {
      await rememberAgentSetup(db, membership, setupOfAgent(agent));
    }
    await publishAgentsChanged(options.pubsub, orgId);
    return agent;
  } catch (error) {
    if (isUniqueViolation(error)) throw handleTaken(values.handle, await takenHandles(db, orgId));
    throw error;
  }
}

/** Whose plan the agent's computer brain thinks with: its account's owner, else whoever connected its computer. */
async function planOwner(db: Database, agent: Agent): Promise<string | null> {
  if (!agent.machineId) return null;
  const { machineAccounts, machines } = schema;
  const [row] = agent.brainAccountId
    ? await db
        .select({ owner: machineAccounts.createdBy })
        .from(machineAccounts)
        .where(and(eq(machineAccounts.orgId, agent.orgId), eq(machineAccounts.id, agent.brainAccountId)))
    : await db
        .select({ owner: machines.pairedByUserId })
        .from(machines)
        .where(and(eq(machines.orgId, agent.orgId), eq(machines.id, agent.machineId)));
  return row?.owner ?? null;
}

/**
 * An agent's new owner decides its approvals (those waiting or approved ahead move to them, inbox included), and one
 * who couldn't talk to it before takes it out of the mailboxes other people gave it (`dropForeignMailGrants`).
 */
export async function handOver(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  before: Agent,
  ownerUserId: string | null,
) {
  // Loaded here: approvals build on this module.
  const { repointApprovals } = await import("./approvals");
  const newcomer = ownerUserId && !canTalkTo(before, ownerUserId, await speakerFor(deps.db, before.orgId, ownerUserId));
  if (newcomer) await dropForeignMailGrants(deps.db, before.orgId, before.id, ownerUserId, actorId);
  await repointApprovals(deps, before.orgId, [before.id], ownerUserId);
}

/** The right hand's instructions, role, owner and the rest are the product's (ADR 0137): only `RIGHT_HAND_EDITABLE` changes. */
async function refuseRightHandFields(db: Database, orgId: string, agentId: string, patch: Partial<AgentInput>) {
  const fixed = Object.keys(patch).filter(
    (k) => patch[k as keyof AgentInput] !== undefined && !RIGHT_HAND_EDITABLE.has(k),
  );
  if (fixed.length > 0 && isRightHand(await getAgent(db, orgId, agentId)))
    throw rightHandPermanent(`changed this way (${fixed.join(", ")})`);
}

export async function updateAgent(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  patch: Partial<AgentInput>,
  options: { remember?: boolean; pubsub?: PubSub } = {},
): Promise<Agent> {
  const membership = await requirePermission(db, actorId, orgId, "manage_agents");
  await refuseRightHandFields(db, orgId, agentId, patch);
  const cleaned =
    patch.handle === undefined ? patch : { ...patch, handle: patch.handle.trim().replace(/^@/, "").toLowerCase() };
  // Only what people set is stored (normalized): the rest follows the defaults (`chosenAutonomy`).
  const input =
    cleaned.autonomyBrakes === undefined
      ? cleaned
      : {
          ...cleaned,
          autonomyBrakes: chosenAutonomy({
            ...(await getAgent(db, orgId, agentId))?.autonomyBrakes,
            ...cleaned.autonomyBrakes,
          }),
        };
  await validateAgentFields(db, orgId, input);
  const handle = input.handle;
  if (handle !== undefined) {
    const taken = await takenHandles(db, orgId, agentId);
    if (taken.has(handle)) throw handleTaken(handle, taken);
  }
  const owner = input.ownerUserId;
  const before = owner !== undefined ? await getAgent(db, orgId, agentId) : null;
  // A plan thinks only for its owner's agents (ADR 0059 §3): a new owner who doesn't own it sends the agent back
  // to the API; one who does decides for themselves whether anyone else talks to it.
  const handover =
    before && before.ownerUserId !== owner && isComputerBrain(before.brain)
      ? owner && (await planOwner(db, before)) === owner
        ? answersOthers(audienceOf(before), owner)
          ? { audienceMode: "owner" as const }
          : {}
        : { brain: "model", brainAccountId: null }
      : {};
  // The handle it leaves joins the ones it had, so what names it there still reaches it; taking one back takes it out.
  const previous =
    handle === undefined
      ? {}
      : {
          previousHandles: sql`case when ${agents.handle} = ${handle} then ${agents.previousHandles}
            else array_append(array_remove(${agents.previousHandles}, ${handle}::text), ${agents.handle}) end`,
        };
  let agent: Agent | undefined;
  try {
    [agent] = await db
      .update(agents)
      .set({ ...input, ...handover, ...previous, updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)))
      .returning();
  } catch (error) {
    if (handle !== undefined && isUniqueViolation(error))
      throw handleTaken(handle, await takenHandles(db, orgId, agentId));
    throw error;
  }
  if (!agent) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  if (before && before.ownerUserId !== agent.ownerUserId) {
    // What its old owner approved for good was theirs to decide: the new owner is asked again.
    await dropAgentRules(db, orgId, [agentId], { type: "person", id: actorId });
    await handOver({ db, pubsub: options.pubsub }, actorId, before, agent.ownerUserId);
  }
  if (input.name !== undefined || handle !== undefined) {
    // What other runs read of it (who is in a channel, archived and old handles) names it as it is now.
    caches.agents.delete(`${orgId}:archived`);
    caches.agents.delete(`${orgId}:old-handles`);
    caches.channelMembers.deletePrefix(`${orgId}:`);
  }
  if (before && "brain" in handover) {
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.brain",
      target: { type: "agent", id: agentId },
      details: {
        from: { brain: before.brain, account: before.brainAccountId },
        to: { brain: "model", account: null },
        reason: "owner_changed",
      },
    });
  }
  // Which fields changed, not the instructions' text (they can be long and say anything); the rest as set.
  const changed = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
  if (changed.length) {
    const { instructions: _, ...shown } = input;
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.updated",
      target: { type: "agent", id: agentId },
      details: { name: agent.name, changed, ...shown },
    });
  }
  if (input.monthlyBudgetNanoUsd !== undefined) {
    await resyncBudgetCounter(db, orgId, agentId);
    // Its runs that wait for the budget look again now: one that still doesn't fit parks again quietly.
    await resumeBudgetWaits(db, orgId, agentId);
  }
  // Its API model or key is "Quem pensa" only while it thinks through the API.
  const thinking = input.model !== undefined || input.credentialId !== undefined;
  if (thinking && options.remember !== false && !isComputerBrain(agent.brain)) {
    await rememberAgentSetup(db, membership, setupOfAgent(agent));
  }
  await publishAgentsChanged(options.pubsub, orgId);
  return agent;
}

export async function archiveAgent(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  pubsub?: PubSub,
  /** The caller already checked who may (the right hand's Desfazer, ADR 0139: the person it created it for). */
  checked = false,
) {
  if (!checked) await requirePermission(db, actorId, orgId, "manage_agents");
  await refuseRightHand(db, orgId, agentId, "archived");
  const [gone] = await db
    .update(agents)
    .set({ archivedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .returning({ name: agents.name, handle: agents.handle });
  if (gone) {
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.archived",
      target: { type: "agent", id: agentId },
      details: { name: gone.name, handle: gone.handle },
    });
    // What waits on its plan or budget won't run: its notes say so now. Loaded here: the usage pause loads agents.
    const { stopAgentUsageWaits } = await import("./usage-pause");
    await stopAgentUsageWaits({ db, pubsub }, orgId, agentId).catch(() => null);
  }
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  caches.agents.delete(`${orgId}:archived`);
  caches.agents.delete(`${orgId}:old-handles`);
  // Its channel memberships stay: what runs read of a channel's members leaves it out from now on.
  caches.channelMembers.deletePrefix(`${orgId}:`);
  if (gone) await publishAgentsChanged(pubsub, orgId);
}

/**
 * Brings an archived agent back (an archive's Undo, ADR 0137): its handle was kept for it all along (`takenHandles`
 * holds archived agents'), so nothing else took it meanwhile. Not a deleted one.
 */
export async function unarchiveAgent(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  options: { pubsub?: PubSub } = {},
) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const [back] = await db
    .update(agents)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)))
    .returning({ name: agents.name, handle: agents.handle });
  if (!back) throw new NotFoundError("Agent not found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.unarchived",
    target: { type: "agent", id: agentId },
    details: { name: back.name, handle: back.handle },
  });
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  caches.agents.delete(`${orgId}:archived`);
  caches.agents.delete(`${orgId}:old-handles`);
  caches.channelMembers.deletePrefix(`${orgId}:`);
  await publishAgentsChanged(options.pubsub, orgId);
}

export async function listAgents(db: Database, actorId: string, orgId: string): Promise<Agent[]> {
  await requirePermission(db, actorId, orgId, "read");
  // As they were made. A team made before each insert had its own time shares one: by name among them.
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt), asc(agents.name));
}

/** An agent, archived or not; null for a deleted one (its tombstone only names what it left, `listFormerAgents`). */
export async function getAgent(db: Database, orgId: string, agentId: string): Promise<Agent | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  return agent ?? null;
}

/**
 * Agents no longer in the team (archived or deleted) as what they left behind shows them: name, role and look,
 * so their old messages, threads and reports still say who wrote them. Never offered anywhere an agent is picked.
 */
export async function listFormerAgents(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      appearance: agents.appearance,
      deletedAt: agents.deletedAt,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNotNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt));
  return rows.map(({ deletedAt, ...a }) => ({
    ...a,
    appearance: (a.appearance ?? null) as AgentAppearance | null,
    deleted: deletedAt !== null,
  }));
}

/** A deleted agent's handle: longer than `HANDLE_PATTERN` allows, so nobody's and never mentioned. */
export const deletedHandle = (agentId: string) => `deleted-${agentId}`;

/** Public view of an agent (no credential id, which is admin-only detail). */
export const agentView = (a: Agent) => ({
  id: a.id,
  name: a.name,
  handle: a.handle,
  role: a.role,
  instructions: a.instructions,
  model: a.model,
  ownerUserId: a.ownerUserId,
  hasCredential: a.credentialId !== null,
  monthlyBudgetNanoUsd: a.monthlyBudgetNanoUsd,
  /** Its look (color, eyes, accessory); null = the default. */
  appearance: (a.appearance ?? null) as AgentAppearance | null,
  /** It may follow a light reply with a sticker or a GIF (ADR 0091). */
  mediaReplies: a.mediaReplies,
  /** A built-in agent the product ships (ADR 0137): `right_hand`, the team's right hand. Null for the others. */
  builtin: a.builtin ?? null,
  /** "Responde a" (ADR 0148 addendum): the agent it reports to; null = its owner, else its setor's lead. */
  reportsToAgentId: a.reportsToAgentId ?? null,
  /** Its setup checklist (ADR 0155 §2): the role it started from and the steps confirmed; null = none. */
  setup: setupOf(a.setup),
  /** Its autonomy brakes (ADR 0131), with the defaults filled in. */
  brakes: autonomySettings(a.autonomyBrakes),
  createdAt: a.createdAt,
});

/** A handle as a tool's input names it ("@Ada ") → as stored ("ada"). */
export const handleOf = (raw: unknown) => String(raw).replace(/^@/, "").trim().toLowerCase();

/**
 * `handles` with the import ids they were written as read as their agents' handles now. An import gave an agent the other app's id
 * cut to 32 characters (`agent-e9665a97-c8d5-423f-ae59-25`, OpenBot.run's) until migration 0132 named it, and
 * routines, memory and messages written before still cite it: that handle is read again from the import's key
 * (`import_items.key`), never stored, and names the agent while no agent here has it as its own.
 */
async function importedHandles(db: Executor, orgId: string, handles: string[]): Promise<string[]> {
  const old = handles.filter((h) => HANDLE_PATTERN.test(h) && isIdHandle(h));
  if (old.length === 0) return handles;
  const key = sql<string>`left(lower(${importItems.key}), 32)`;
  const rows = await db
    .selectDistinctOn([key], { old: key, handle: agents.handle })
    .from(importItems)
    .innerJoin(agents, and(eq(agents.id, importItems.targetId), eq(agents.orgId, importItems.orgId)))
    .where(
      and(
        eq(importItems.orgId, orgId),
        eq(importItems.kind, "agent"),
        isNull(agents.archivedAt),
        inArray(key, old),
        sql`not exists (select 1 from ${agents} held where held.org_id = ${orgId}::uuid and held.handle = ${key})`,
      ),
    )
    // Two people who imported the same file: the first import held the handle (the second got a suffix).
    .orderBy(key, asc(importItems.createdAt));
  const now = new Map(rows.map((r) => [r.old, r.handle]));
  return handles.map((h) => now.get(h) ?? h);
}

type Named = { id: string; handle: string };

/**
 * Every handle that names an agent besides its own, with that agent and its handle now: the ones it had before a
 * rename (`previous_handles`), not an archived agent's, and not one an agent or a person has as their own (that @ is
 * theirs). The one place an old handle is read as an agent's: `currentHandles` maps by it, and the agent list gives
 * the apps each agent's (`oldHandlesByAgent`) for the mentions in old messages. Per process: a rename or an archive
 * here drops it, another replica's within the cache's TTL.
 */
function loadOldHandles(db: Executor, orgId: string): Promise<Map<string, Named>> {
  return caches.agents.getOrLoad(`${orgId}:old-handles`, async () => {
    const rows = rowsOf<Named & { old: string }>(
      await db.execute(sql`select distinct on (u.old) u.old, ag.id, ag.handle
        from ${agents} ag cross join unnest(ag.previous_handles) as u(old)
        where ag.org_id = ${orgId}::uuid and ag.archived_at is null
          and not exists (select 1 from ${agents} held where held.org_id = ${orgId}::uuid and held.handle = u.old)
          and not exists (select 1 from ${organizationMembers} om
            where om.org_id = ${orgId}::uuid and om.handle = u.old)
        order by u.old, ag.created_at`),
    );
    return new Map(rows.map((r) => [r.old, { id: r.id, handle: r.handle }]));
  }) as Promise<Map<string, Named>>;
}

/**
 * `handles` (lower case, without the @) as their agents have them now, in the same order (`loadOldHandles`, then
 * `importedHandles`). What
 * reads a handle someone wrote asks here (a message's mentions, a tool's input, a routine's or a note's text), so an
 * agent renamed from @ada to @claudio still answers to @ada.
 */
export async function currentHandles(db: Executor, orgId: string, handles: string[]): Promise<string[]> {
  if (handles.length === 0) return handles;
  const old = await loadOldHandles(db, orgId);
  return importedHandles(
    db,
    orgId,
    handles.map((h) => old.get(h)?.handle ?? h),
  );
}

/** The old handles that still name each agent (`loadOldHandles`), by its id. */
export async function oldHandlesByAgent(db: Executor, orgId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const [old, a] of await loadOldHandles(db, orgId)) out.set(a.id, [...(out.get(a.id) ?? []), old]);
  return out;
}

/** `@handles` (a tool's input, old ones too) → the organization's agents that aren't archived; the missing ones by handle. */
export async function agentsByHandle(db: Executor, orgId: string, raw: unknown, options: { archived?: boolean } = {}) {
  const written = (Array.isArray(raw) ? raw : []).map(handleOf);
  const current = await currentHandles(db, orgId, written);
  const handles = [...new Set(current)];
  const rows =
    handles.length === 0
      ? []
      : await db
          .select({ id: agents.id, handle: agents.handle, name: agents.name })
          .from(agents)
          .where(
            and(
              eq(agents.orgId, orgId),
              inArray(agents.handle, handles),
              isNull(options.archived ? agents.deletedAt : agents.archivedAt),
            ),
          );
  const missing = handles.filter((h) => !rows.some((r) => r.handle === h));
  /** The row a handle as written names, an old one included. */
  const rowOf = (h: unknown) => {
    const now = current[written.indexOf(handleOf(h))] ?? handleOf(h);
    return rows.find((r) => r.handle === now);
  };
  return { handles, rows, missing, rowOf };
}

/** `getAgent` through the per-process cache (run path). */
export function getAgentCached(db: Database, orgId: string, agentId: string): Promise<Agent | null> {
  return caches.agents.getOrLoad(`${orgId}:${agentId}`, () => getAgent(db, orgId, agentId)) as Promise<Agent | null>;
}

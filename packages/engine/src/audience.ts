import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { type Agent, getAgent } from "./agents";
import { recordAudit } from "./audit";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { can, getMembership, type Membership, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { channelMaySql, maySql } from "./permissions";
import { dropForeignMailGrants, type ForeignMailbox, foreignMailboxes } from "./tools/scopes";

const { agents, users, organizationMembers, orgRoles } = schema;

/** Who can talk to an agent. */
export type AudienceMode = "everyone" | "people" | "owner";
export const AUDIENCE_MODES: readonly AudienceMode[] = ["everyone", "people", "owner"];

export interface AgentAudience {
  mode: AudienceMode;
  /**
   * For `people`; the owner can always talk to the agent. Under `owner`, the
   * people a plan kept out (ADR 0059 §5), who come back when it is let out.
   */
  userIds: string[];
  /** For `people`: whoever holds one of these roles at the time (not `everyone`); kept under `owner` like `userIds`. */
  roleIds: string[];
  /** Other agents may consult it for people outside it (ADR 0085 addendum); absent (older apps) = keep. */
  consultable?: boolean;
}

type AudienceFields = Pick<
  Agent,
  "audienceMode" | "audienceUserIds" | "audienceRoleIds" | "ownerUserId" | "consultable" | "brain"
>;

export const OWNER_ONLY: AgentAudience = { mode: "owner", userIds: [], roleIds: [] };

/** Who the agent answers: what the gate reads, what a change starts from and what the audit records. */
export const audienceOf = (a: AudienceFields): AgentAudience => ({
  mode: a.audienceMode,
  userIds: a.audienceMode === "everyone" ? [] : a.audienceUserIds,
  roleIds: a.audienceMode === "everyone" ? [] : a.audienceRoleIds,
  consultable: a.consultable,
});

/** Whether `to` lets someone talk to the agent whom `from` didn't (its owner always can), or consult it for them. */
export function widensAudience(from: AgentAudience, to: AgentAudience, ownerUserId: string | null): boolean {
  if (to.mode === "owner" || from.mode === "everyone") return false;
  if (to.mode === "everyone" || (to.consultable && from.consultable === false)) return true;
  const people = new Set(from.mode === "people" ? from.userIds : []);
  const roles = new Set(from.mode === "people" ? from.roleIds : []);
  return to.userIds.some((id) => id !== ownerUserId && !people.has(id)) || to.roleIds.some((id) => !roles.has(id));
}

/**
 * An agent's audience changed from `before` to `after`: if someone new can talk to it, it loses the mailboxes others
 * gave it (`dropForeignMailGrants`), `actorId`'s own aside. Consultations never reach someone else's mailbox (the mail
 * tools check the person), so only people count here.
 */
export async function dropMailIfWidened(
  db: Executor,
  orgId: string,
  agentId: string,
  ownerUserId: string | null,
  before: AgentAudience,
  after: AgentAudience,
  actorId: string,
) {
  if (widensReach(before, after, ownerUserId)) await dropForeignMailGrants(db, orgId, agentId, actorId, actorId);
}

const widensReach = (before: AgentAudience, after: AgentAudience, ownerUserId: string | null) =>
  widensAudience({ ...before, consultable: true }, { ...after, consultable: true }, ownerUserId);

/**
 * The mailboxes saving `audience` would take from the agent (`dropMailIfWidened`), taking nothing: the apps ask the
 * person first. Empty when it lets nobody new in, or every mailbox it holds is the actor's own.
 */
export async function audienceMailLoss(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  audience: Omit<AgentAudience, "roleIds"> & { roleIds?: string[] },
): Promise<ForeignMailbox[]> {
  const agent = await audienceEditable(db, actorId, orgId, agentId);
  const people = audience.mode === "people";
  const to: AgentAudience = {
    mode: audience.mode,
    userIds: people ? audience.userIds : [],
    roleIds: people ? (audience.roleIds ?? agent.audienceRoleIds) : [],
  };
  if (!widensReach(audienceOf(agent), to, agent.ownerUserId)) return [];
  return foreignMailboxes(db, orgId, agentId, actorId);
}

/** The agent, when `actorId` may change who talks to it: its owner or admins (with no owner, admins only). */
async function audienceEditable(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && !(agent.ownerUserId && agent.ownerUserId === actorId)) {
    throw new ForbiddenError("Only the agent's owner or an admin can change who talks to it");
  }
  return agent;
}

/**
 * `userId` now holds `added` roles: every agent those roles newly let them talk to loses the mailboxes others gave it
 * (theirs aside), as if its audience had widened to them. A mailbox's owner gave it for the people it answered then.
 */
export async function dropMailForNewRoleMember(
  db: Executor,
  orgId: string,
  userId: string,
  rolesBefore: readonly string[],
  added: readonly string[],
  actorId: string,
) {
  if (added.length === 0) return;
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.audienceMode, "people")));
  const speaker: Speaker = { talks: true, roleIds: [...rolesBefore] };
  for (const agent of rows) {
    if (!agent.audienceRoleIds.some((id) => added.includes(id))) continue;
    if (canTalkTo(agent, userId, speaker)) continue;
    await dropForeignMailGrants(db, orgId, agent.id, userId, actorId);
  }
}

/** Someone besides its owner can talk to the agent. */
export const answersOthers = (a: AgentAudience, ownerUserId: string | null) =>
  widensAudience(OWNER_ONLY, a, ownerUserId);

/** What the audience rule needs of a person: whether their roles let them talk to agents, and which roles they hold. */
export interface Speaker {
  talks: boolean;
  roleIds: readonly string[];
  /**
   * Another agent asks for them (ask_agent, tell_agent, a mention or a hand-off between agents): an agent that
   * takes consultations answers it even outside its audience (`consultable`, ADR 0085 addendum).
   */
  viaAgent?: true;
}

/** No person (a routine's run): talks, holds no role. */
export const NO_PERSON: Speaker = { talks: true, roleIds: [] };

export const speakerOf = (membership: Pick<Membership, "permissions" | "roleIds"> | null): Speaker => ({
  talks: can(membership, "talk_to_agents"),
  roleIds: membership?.roleIds ?? [],
});

/** The same person, as another agent asking for them. */
export const viaAgent = (s: Speaker): Speaker => ({ ...s, viaAgent: true });

/**
 * Whether other agents may consult it for people outside its audience: its switch, unless it thinks with a plan
 * that answers nobody but its owner, `owner` or `people` with nobody else picked (ADR 0059 §5): answering for
 * someone else is answering others.
 */
export const takesConsultations = (a: AudienceFields) =>
  a.consultable &&
  !(isComputerBrain(a.brain) && !answersOthers({ ...audienceOf(a), consultable: false }, a.ownerUserId));

/** The `Speaker` for a person in a workspace (`NO_PERSON` for none). */
export async function speakerFor(db: Database, orgId: string, userId: string | null): Promise<Speaker> {
  return userId ? speakerOf(await getMembership(db, userId, orgId)) : NO_PERSON;
}

/**
 * Can this person's message start a run of the agent? (`null` = no person: routines and webhooks check their
 * creator.) Its owner always can; anyone else needs the agent's audience (named, or holding one of its roles now)
 * and, through their roles, to talk to agents at all (`talk_to_agents`, ADR 0085). Asked by another agent
 * (`viaAgent`) for a person, one that takes consultations is enough (with nobody behind it, nobody's reach widens). `audienceSql` is the same rule for a person (mentions
 * between agents never dispatch in SQL: their agents' DM wakes nobody, `settleReach` asks the rest by note).
 */
export function canTalkTo(a: AudienceFields, userId: string | null, person: Speaker): boolean {
  if (userId && a.ownerUserId === userId) return true;
  if (!person.talks) return false;
  if (person.viaAgent && userId && takesConsultations(a)) return true;
  if (a.audienceMode === "everyone") return true;
  if (!userId || a.audienceMode !== "people") return false;
  return a.audienceUserIds.includes(userId) || a.audienceRoleIds.some((id) => person.roleIds.includes(id));
}

/**
 * Whether a person sees how an agent works (its instructions, tools and access, memory, usage and activity): its
 * owner, who manages agents, and whoever it answers. Everyone else sees its public card: face, name, role, owner,
 * where it works and who it answers.
 */
export const seesAgentDetails = (
  a: AudienceFields,
  userId: string,
  membership: Pick<Membership, "permissions" | "roleIds"> | null,
) => can(membership, "manage_agents") || canTalkTo(a, userId, speakerOf(membership));

/** The agent, for someone who sees how it works (`seesAgentDetails`); 403 `agent.details_hidden` for anyone else. */
export async function requireAgentDetails(db: Database, userId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, userId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!seesAgentDetails(agent, userId, membership)) {
    throw new ForbiddenError(`Only who talks to ${agent.name} sees how it works`, "agent.details_hidden", {
      agentName: agent.name,
    });
  }
  return agent;
}

/**
 * The agent's playbook (ADR 0120 addendum): how-tos, lessons and notes it wrote for its own work. Quiet in the chat
 * (no receipt), never a proposal for a person to confirm, its technical text only for the agent's owner and admins.
 */
export const isPlaybook = (i: { kind: string; agentId: string | null; scopeType: string; createdByKind: string }) =>
  !!i.agentId && i.scopeType === "agent" && i.createdByKind === "agent" && (i.kind === "note" || i.kind === "lesson");

/** Who reads an agent's playbook (`isPlaybook`, ADR 0120 addendum): its owner and who manages agents. */
export const readsPlaybook = (
  a: { ownerUserId: string | null },
  userId: string,
  membership: Pick<Membership, "permissions" | "roleIds"> | null,
) => a.ownerUserId === userId || can(membership, "manage_agents");

/** The ids of the workspace's agents whose details this person sees (`seesAgentDetails`). */
export async function agentIdsWithDetails(db: Database, userId: string, orgId: string) {
  return (await agentIdsSeen(db, userId, orgId)).details;
}

/** `agentIdsWithDetails`, plus the agents whose playbook this person reads (`readsPlaybook`). */
export async function agentIdsSeen(db: Database, userId: string, orgId: string) {
  const [membership, rows] = await Promise.all([
    getMembership(db, userId, orgId),
    db.select().from(agents).where(eq(agents.orgId, orgId)),
  ]);
  return {
    details: new Set(rows.filter((a) => seesAgentDetails(a, userId, membership)).map((a) => a.id)),
    playbook: new Set(rows.filter((a) => readsPlaybook(a, userId, membership)).map((a) => a.id)),
  };
}

/**
 * The same rule in SQL, for an `agents` row aliased `alias` and a person id expression. An agent with no owner
 * compares to null: `coalesce` makes that a no, so `not allowed` holds for it too (the blocked person's notice).
 * In a channel (`channelId`), `talk_to_agents` is the person's in that channel, with its exceptions (ADR 0134).
 */
export function audienceSql(alias: string, userId: SQL, options: { channelId?: SQL } = {}): SQL {
  const a = sql.raw(alias);
  const talks = options.channelId
    ? channelMaySql(sql`${a}.org_id`, options.channelId, userId, "talk_to_agents")
    : maySql(sql`${a}.org_id`, userId, "talk_to_agents");
  return sql`coalesce((${userId} is not null and ${a}.owner_user_id = ${userId})
    or ((${a}.audience_mode = 'everyone'
        or (${userId} is not null and ${a}.audience_mode = 'people' and (${userId} = any(${a}.audience_user_ids)
          or exists (select 1 from organization_member_roles amr where amr.org_id = ${a}.org_id
            and amr.user_id = ${userId} and amr.role_id = any(${a}.audience_role_ids)))))
      and (${userId} is null or ${talks})), false)`;
}

/** Whom it answers by name: its roles first, then its owner and the people of its audience (only what still exists). */
async function answered(db: Database, a: Agent) {
  const { mode, userIds, roleIds } = audienceOf(a);
  const ids = [...new Set([...(a.ownerUserId ? [a.ownerUserId] : []), ...(mode === "people" ? userIds : [])])];
  const picked = mode === "people" ? roleIds : [];
  const [people, roles] = await Promise.all([
    ids.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [],
    picked.length
      ? db
          .select({ id: orgRoles.id, name: orgRoles.name })
          .from(orgRoles)
          .where(and(eq(orgRoles.orgId, a.orgId), inArray(orgRoles.id, picked)))
      : [],
  ]);
  const inOrder = <T extends { id: string }>(order: string[], rows: T[]) =>
    order.flatMap((id) => rows.filter((r) => r.id === id));
  return { roles: inOrder(picked, roles), people: inOrder(ids, people) };
}

/** Who the agent answers, as a stable code and params (the app says it in the person's language). */
export async function audienceDetail(db: Database, a: Agent) {
  const { roles, people } = await answered(db, a);
  const names = [...roles, ...people].map((r) => r.name);
  const code = names.length === 0 ? "audience.nobody" : "audience.only";
  const params = {
    agentId: a.id,
    agentName: a.name,
    userIds: people.map((p) => p.id),
    roleIds: roles.map((r) => r.id),
    names,
  };
  return { code, params, english: englishNotice(a.name, names) };
}

const englishNotice = (agentName: string, names: string[]) => {
  if (names.length === 0) return `${agentName} isn't replying to anyone right now.`;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${agentName} only replies to ${list}.`;
};

/** The ForbiddenError for someone the agent doesn't answer, with code and params. */
export async function audienceError(db: Database, a: Agent) {
  const d = await audienceDetail(db, a);
  return new ForbiddenError(d.english, d.code, d.params);
}

/** "Theo only replies to Suporte, Walter and Ana." (English text for agents' context and old clients; the app uses `audienceDetail`). */
export async function audienceNotice(db: Database, a: Agent): Promise<string> {
  return (await audienceDetail(db, a)).english;
}

/**
 * Tells only that person that the agent won't answer them (ephemeral: their
 * own topic, never stored as a message).
 */
export async function notifyBlocked(
  deps: { db: Database; pubsub: PubSub },
  orgId: string,
  userId: string,
  input: {
    agentIds: string[];
    channelId: string;
    threadId: string | null;
    messageId: string;
    /** The channel's exceptions took `talk_to_agents` from them (ADR 0134), not the agents' audience. */
    deniedHere?: boolean;
  },
) {
  const out: { agentId: string; text: string; code: string; params: Record<string, unknown> }[] = [];
  for (const agentId of input.agentIds) {
    const agent = await getAgent(deps.db, orgId, agentId);
    if (!agent) continue;
    const detail = input.deniedHere
      ? {
          code: "channel.agents_denied",
          params: { agentId, agentName: agent.name },
          english: "You don't call agents in this channel.",
        }
      : await audienceDetail(deps.db, agent);
    const text = detail.english;
    out.push({ agentId, text, code: detail.code, params: detail.params });
    await publishUserEvent(deps.pubsub, orgId, userId, {
      type: "agent.unavailable",
      agentId,
      channelId: input.channelId,
      threadId: input.threadId,
      messageId: input.messageId,
      text,
      code: detail.code,
      params: detail.params,
    });
  }
  return out;
}

type PlanAgent = Pick<Agent, "id" | "brain" | "ownerUserId"> &
  Partial<Pick<Agent, "brainAccountId" | "brainAccountLentBy">>;

/**
 * Whose plan an agent on a computer brain thinks with: its owner's, or the owner of the plan someone else gave it
 * (`brainAccountLentBy`, ADR 0059 §3). Null on the API.
 */
async function planOwnerOf(db: Executor, orgId: string, agent: PlanAgent): Promise<string | null> {
  if (!isComputerBrain(agent.brain)) return null;
  if (!agent.brainAccountLentBy || !agent.brainAccountId) return agent.ownerUserId;
  const [row] = await db
    .select({ ownerId: schema.machineAccounts.createdBy })
    .from(schema.machineAccounts)
    .where(and(eq(schema.machineAccounts.orgId, orgId), eq(schema.machineAccounts.id, agent.brainAccountId)));
  return row?.ownerId ?? null;
}

/** The outbox job telling a plan's owner that someone else let more people talk to their agent (`queuePlanOpenedEmail`). */
export const PLAN_OPENED_JOB = "agent.plan_opened";

/**
 * Who may talk to the agent changed from `from` to `to`, saved as `after`. Audited, naming whose plan it is when it
 * thinks with its owner's (ADR 0059 §5), and told to that owner (`planOpened`, from `planFrom`: who its plan answered).
 */
export async function audienceChanged(
  db: Executor,
  orgId: string,
  actorId: string,
  after: PlanAgent,
  from: AgentAudience,
  to: AgentAudience,
  planFrom = from,
): Promise<boolean> {
  const planOwner = await planOwnerOf(db, orgId, after);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.audience_changed",
    target: { type: "agent", id: after.id },
    details: { from, to, ...(planOwner ? { planOwner } : {}) },
  });
  return planOpened(db, orgId, actorId, after, planFrom, to);
}

/**
 * Someone other than its owner let more people talk to an agent that thinks with its owner's plan (ADR 0059 §5): that
 * owner hears it by email, once per change, since their plan pays for those conversations.
 */
export async function planOpened(
  db: Executor,
  orgId: string,
  actorId: string,
  after: PlanAgent,
  from: AgentAudience,
  to: AgentAudience,
): Promise<boolean> {
  const planOwner = await planOwnerOf(db, orgId, after);
  if (!planOwner || planOwner === actorId || !widensAudience(from, to, planOwner)) return false;
  await enqueue(db, {
    orgId,
    kind: PLAN_OPENED_JOB,
    payload: { agentId: after.id, actorId, from, to },
    dedupeKey: `plan-opened:${crypto.randomUUID()}`,
  });
  return true;
}

/**
 * Changes who can talk to the agent: its owner or admins (with no owner,
 * admins only), on a plan too (ADR 0059 §5): its owner hears by email when someone else lets more people in.
 * `mailLossSeen`: the mailboxes the person agreed it loses (`audienceMailLoss`); losing any other refuses the save
 * (409 `agent.mail_loss_changed`), so a mailbox given after they were asked is never taken unasked.
 * Audited.
 */
export async function setAgentAudience(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  audience: Omit<AgentAudience, "roleIds"> & { roleIds?: string[] },
  mailLossSeen?: readonly string[],
): Promise<Agent> {
  const agent = await audienceEditable(db, actorId, orgId, agentId);
  if (!AUDIENCE_MODES.includes(audience.mode)) throw new ValidationError("Unknown audience mode");
  const requested = audience.mode === "people" ? [...new Set(audience.userIds)] : [];
  if (requested.length > 500) throw new ValidationError("At most 500 people");
  // Older apps don't send roles: adding a person there keeps the roles picked.
  const requestedRoles = audience.mode === "people" ? [...new Set(audience.roleIds ?? agent.audienceRoleIds)] : [];
  if (requestedRoles.length > 100) throw new ValidationError("At most 100 roles");
  // One transaction holding FOR SHARE on the member rows it read: a removeMember (which deletes the member row,
  // then takes the id off agents' lists) either waits for this save or is seen by it, never overwritten by it.
  const updated = await db.transaction(async (tx) => {
    let userIds = requested;
    if (userIds.length > 0) {
      const members = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)))
        .for("share");
      // Someone no longer in the workspace drops out rather than failing the save: the apps' list may still hold them.
      const known = new Set(members.map((m) => m.userId));
      userIds = userIds.filter((id) => known.has(id));
    }
    let roleIds = requestedRoles;
    if (roleIds.length > 0) {
      // `everyone` is the "everyone" mode, not a role to pick.
      const known = new Set(
        (
          await tx
            .select({ id: orgRoles.id })
            .from(orgRoles)
            .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, roleIds)))
        ).map((r) => r.id),
      );
      if (audience.roleIds && roleIds.some((id) => !known.has(id)))
        throw new ValidationError("Every role must be one of the workspace's");
      roleIds = roleIds.filter((id) => known.has(id));
    }
    if (audience.mode === "people" && userIds.length === 0 && roleIds.length === 0 && !agent.ownerUserId) {
      throw new ValidationError("Pick at least one person or role");
    }
    // Under "owner" the lists are who a plan kept out (ADR 0059 §5), back once it is let out: staying "owner" keeps them.
    if (audience.mode === "owner" && agent.audienceMode === "owner") {
      userIds = agent.audienceUserIds;
      roleIds = agent.audienceRoleIds;
    }
    const consultable = audience.consultable ?? agent.consultable;
    const [updated] = await tx
      .update(agents)
      .set({
        audienceMode: audience.mode,
        audienceUserIds: userIds,
        audienceRoleIds: roleIds,
        consultable,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .returning();
    if (updated) {
      if (mailLossSeen && widensReach(audienceOf(agent), audienceOf(updated), agent.ownerUserId)) {
        const lost = await foreignMailboxes(tx, orgId, agentId, actorId);
        if (lost.some((m) => !mailLossSeen.includes(m.accountId))) {
          throw new ConflictError("It holds a mailbox you weren't asked about", "agent.mail_loss_changed");
        }
      }
      await dropMailIfWidened(tx, orgId, agentId, agent.ownerUserId, audienceOf(agent), audienceOf(updated), actorId);
      await audienceChanged(tx, orgId, actorId, updated, audienceOf(agent), audienceOf(updated));
    }
    return updated;
  });
  if (!updated) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  return updated;
}

import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gte, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ConflictError, ForbiddenError, PersonLimitError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import { messageView } from "./messages";
import { notify, resolveNotifications } from "./notifications";
import { can, requireActiveMembership, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { maySql } from "./permissions";
import { monthStartUtc } from "./usage";

const { personUsageMonths, organizationSettings, organizationMembers, organizationMemberRoles, orgRoles } = schema;

/**
 * Monthly AI limits per person (ADR 0141), in nano-USD; null: no limit. Off by default: nobody has one until an
 * admin sets the workspace's default, a role's or a person's.
 */
export interface PersonLimits {
  default: number | null;
  /** A role's limit; a role not here uses the default. */
  roles: Record<string, number | null>;
  /** A person's own limit (an exception), over their roles'. */
  people: Record<string, number | null>;
  /** At the limit: agents stop starting work for the person (`block`), or admins only hear it (`notify`). */
  onLimit: "block" | "notify";
  /** The person hears it at 80%. */
  warn: boolean;
}

export const PERSON_LIMIT_WARNING = 0.8;
/** "Aumentar para US$ X este mês": half again the limit, in whole dollars. */
export const RAISE_FACTOR = 1.5;
/** The job that tells people a limit was neared or reached (`notifyPersonLimit`). */
export const PERSON_LIMIT_JOB = "usage.person_limit";

const nano = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : v === null ? null : null;

const limitMap = (v: unknown): Record<string, number | null> => {
  const out: Record<string, number | null> = {};
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      if (x === null || nano(x) !== null) out[k] = nano(x);
  return out;
};

/** What `organization_settings.person_limits` holds, whatever it was saved with. */
export function personLimitsOf(v: unknown): PersonLimits {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    default: nano(o.default),
    roles: limitMap(o.roles),
    people: limitMap(o.people),
    onLimit: o.onLimit === "notify" ? "notify" : "block",
    warn: o.warn !== false,
  };
}

/** Whether any limit is set at all: with none, the gateway reads nothing more for a person. */
export const anyPersonLimit = (l: PersonLimits) =>
  l.default !== null ||
  Object.values(l.roles).some((v) => v !== null) ||
  Object.values(l.people).some((v) => v !== null);

const periodOf = (at: Date) => monthStartUtc(at).toISOString().slice(0, 10);

/** The workspace's limits (cached; dropped when saved). */
export async function orgPersonLimits(db: Executor, orgId: string): Promise<PersonLimits> {
  return (await caches.orgs.getOrLoad(`${orgId}:person-limits`, async () => {
    const [row] = await db
      .select({ limits: organizationSettings.personLimits })
      .from(organizationSettings)
      .where(eq(organizationSettings.orgId, orgId));
    return personLimitsOf(row?.limits);
  })) as PersonLimits;
}

/** Where a person's limit comes from: a raise this month, their own, a role's, the default, or none (owners). */
export type LimitSource = "raised" | "person" | "role" | "default" | "owner" | "none";

export interface ResolvedLimit {
  limitNanoUsd: number | null;
  source: LimitSource;
  /** `role`: the role it comes from. */
  roleId?: string;
}

/**
 * The rule of ADR 0141: owners have none; a raise for this month wins; then the person's own; then the highest of
 * their roles' (one with no limit: none); then the default.
 */
export function resolveLimit(
  limits: PersonLimits,
  member: { userId: string; owner: boolean; roleIds: readonly string[] },
  raisedNanoUsd: number | null,
): ResolvedLimit {
  if (member.owner) return { limitNanoUsd: null, source: "owner" };
  if (raisedNanoUsd !== null) return { limitNanoUsd: raisedNanoUsd, source: "raised" };
  if (member.userId in limits.people) return { limitNanoUsd: limits.people[member.userId] ?? null, source: "person" };
  let best: ResolvedLimit | null = null;
  for (const roleId of member.roleIds) {
    if (!(roleId in limits.roles)) continue;
    const v = limits.roles[roleId] ?? null;
    if (v === null) return { limitNanoUsd: null, source: "role", roleId };
    if (!best || (best.limitNanoUsd ?? 0) < v) best = { limitNanoUsd: v, source: "role", roleId };
  }
  if (best) return best;
  return limits.default === null
    ? { limitNanoUsd: null, source: "none" }
    : { limitNanoUsd: limits.default, source: "default" };
}

export interface PersonMonth {
  spentNanoUsd: number;
  raisedNanoUsd: number | null;
  requestedAt: Date | null;
  reachedAt: Date | null;
}

async function memberOf(db: Executor, orgId: string, userId: string) {
  const [m] = await db
    .select({
      role: organizationMembers.role,
      roleIds: sql<string[]>`coalesce((select array_agg(r.role_id::text) from ${organizationMemberRoles} r
        where r.org_id = ${organizationMembers.orgId} and r.user_id = ${organizationMembers.userId}), '{}')`,
    })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return m ? { userId, owner: m.role === "owner", roleIds: m.roleIds ?? [] } : null;
}

async function monthRow(db: Executor, orgId: string, personId: string, at: Date): Promise<PersonMonth> {
  const [row] = await db
    .select()
    .from(personUsageMonths)
    .where(
      and(
        eq(personUsageMonths.orgId, orgId),
        eq(personUsageMonths.personId, personId),
        eq(personUsageMonths.periodStart, periodOf(at)),
      ),
    );
  return {
    spentNanoUsd: row?.spentNanoUsd ?? 0,
    raisedNanoUsd: row?.raisedLimitNanoUsd ?? null,
    requestedAt: row?.requestedAt ?? null,
    reachedAt: row?.reachedAt ?? null,
  };
}

export interface PersonLimitState extends ResolvedLimit, PersonMonth {
  onLimit: PersonLimits["onLimit"];
  warn: boolean;
}

/** A person's month against their limit. Null when they aren't a member. */
export async function personLimitState(
  db: Executor,
  orgId: string,
  personId: string,
  at = new Date(),
): Promise<PersonLimitState | null> {
  const member = await memberOf(db, orgId, personId);
  if (!member) return null;
  const limits = await orgPersonLimits(db, orgId);
  const month = await monthRow(db, orgId, personId, at);
  return { ...month, ...resolveLimit(limits, member, month.raisedNanoUsd), onLimit: limits.onLimit, warn: limits.warn };
}

/** At or past a limit that blocks. */
export const blocks = (s: Pick<PersonLimitState, "limitNanoUsd" | "spentNanoUsd" | "onLimit">) =>
  s.onLimit === "block" && s.limitNanoUsd !== null && s.spentNanoUsd >= s.limitNanoUsd;

/**
 * The Model Gateway's check before a call made for a person (and the executor's before a plan brain's turn): throws
 * `PersonLimitError` when they are at a limit that blocks. Nothing is read past the cached settings while no limit
 * is set anywhere.
 */
export async function assertPersonUnderLimit(db: Executor, orgId: string, personId: string, at = new Date()) {
  if (!anyPersonLimit(await orgPersonLimits(db, orgId))) return;
  const state = await personLimitState(db, orgId, personId, at);
  if (state && blocks(state)) throw new PersonLimitError(personId, state.spentNanoUsd, state.limitNanoUsd as number);
}

/**
 * Adds what a call made for a person cost (or would have cost through the API, for a plan) to their month, and
 * queues their 80% and the admins' 100% notices when it crossed one. Never throws: the call already happened.
 */
export async function addPersonSpend(
  db: Executor,
  input: { orgId: string; personId: string; amountNanoUsd: number; at?: Date },
) {
  const at = input.at ?? new Date();
  const amount = Math.max(0, Math.round(input.amountNanoUsd));
  if (amount === 0) return;
  try {
    const [row] = await db
      .insert(personUsageMonths)
      .values({ orgId: input.orgId, personId: input.personId, periodStart: periodOf(at), spentNanoUsd: amount })
      .onConflictDoUpdate({
        target: [personUsageMonths.orgId, personUsageMonths.personId, personUsageMonths.periodStart],
        set: { spentNanoUsd: sql`${personUsageMonths.spentNanoUsd} + ${amount}`, updatedAt: at },
      })
      .returning({ spent: personUsageMonths.spentNanoUsd });
    if (row) await personSpendAdded(db, { ...input, amountNanoUsd: amount, at }, row.spent);
  } catch {
    // A member who left mid-run has no month to add to (its foreign key): nothing to count.
  }
}

/**
 * After `amountNanoUsd` was added to a person's month (now `after`): queues their 80% and the admins' 100% notices
 * when it crossed one. Nothing is read past the cached settings while no limit is set anywhere.
 */
export async function personSpendAdded(
  db: Executor,
  input: { orgId: string; personId: string; amountNanoUsd: number; at?: Date },
  after: number,
) {
  const at = input.at ?? new Date();
  const amount = input.amountNanoUsd;
  try {
    const limits = await orgPersonLimits(db, input.orgId);
    if (!anyPersonLimit(limits)) return;
    const state = await personLimitState(db, input.orgId, input.personId, at);
    const limit = state?.limitNanoUsd ?? null;
    if (!state || limit === null || limit <= 0) return;
    const before = after - amount;
    const period = periodOf(at);
    const queue = (level: "warning" | "reached") =>
      enqueue(db, {
        orgId: input.orgId,
        kind: PERSON_LIMIT_JOB,
        payload: { personId: input.personId, level, period, limitNanoUsd: limit },
        dedupeKey: `${PERSON_LIMIT_JOB}:${input.personId}:${period}:${level}:${limit}`,
      });
    if (before < limit && after >= limit) {
      await db
        .update(personUsageMonths)
        .set({ reachedAt: at })
        .where(
          and(
            eq(personUsageMonths.orgId, input.orgId),
            eq(personUsageMonths.personId, input.personId),
            eq(personUsageMonths.periodStart, period),
          ),
        );
      await queue("reached");
    } else if (state.warn && before < limit * PERSON_LIMIT_WARNING && after >= limit * PERSON_LIMIT_WARNING) {
      await queue("warning");
    }
  } catch {
    // The call already happened: a notice that fails to queue never fails it.
  }
}

/** Percent of a limit, one decimal; null without a limit. */
export const limitPercent = (spent: number, limit: number | null) =>
  limit === null || limit <= 0 ? null : Math.round((spent / limit) * 1000) / 10;

/** "Aumentar para US$ X": half again the limit, rounded up to whole dollars. */
export const suggestedRaise = (limitNanoUsd: number) => Math.ceil(nanoUsdToUsd(limitNanoUsd) * RAISE_FACTOR) * 1e9;

/** Who may raise or refuse a person's limit and set limits: who configures the workspace and sees money. */
async function deciders(db: Executor, orgId: string) {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        maySql(orgId, organizationMembers.userId, "configure"),
        maySql(orgId, organizationMembers.userId, "view_usage"),
      ),
    );
  return rows.map((r) => r.userId);
}

const requestGroup = (personId: string, period: string) => `usage_limit:request:${personId}:${period}`;

interface NoticeDeps {
  db: Database;
  pubsub?: PubSub;
}

/** The job: the person hears 80%; who decides hears 100% (with "Só avisar os admins", also the person). */
export async function notifyPersonLimit(
  deps: NoticeDeps,
  orgId: string,
  payload: { personId: string; level: "warning" | "reached"; period: string },
) {
  const state = await personLimitState(deps.db, orgId, payload.personId);
  if (!state || state.limitNanoUsd === null) return;
  const percent = limitPercent(state.spentNanoUsd, state.limitNanoUsd) ?? 0;
  if (payload.level === "warning") {
    await notify(deps, {
      orgId,
      userIds: [payload.personId],
      kind: "usage_limit",
      groupKey: `usage_limit:mine:${payload.personId}:${payload.period}`,
      source: { userId: payload.personId },
      latest: { statusTo: "warning", percent },
    });
    return;
  }
  const facts = await personFacts(deps.db, orgId, payload.personId, payload.period);
  await notify(deps, {
    orgId,
    userIds: await deciders(deps.db, orgId),
    kind: "usage_limit",
    groupKey: `usage_limit:reached:${payload.personId}:${payload.period}`,
    actor: { type: "user", id: payload.personId },
    source: { userId: payload.personId, ...(facts.roleName ? { label: facts.roleName } : {}) },
    latest: {
      statusTo: "reached",
      percent,
      limitUsd: nanoUsdToUsd(state.limitNanoUsd),
      limitFrom: state.source,
      runs: facts.runs,
      ...(facts.top ? { title: facts.top.name, share: facts.top.share } : {}),
    },
  });
  if (state.onLimit === "block") return;
  await notify(deps, {
    orgId,
    userIds: [payload.personId],
    kind: "usage_limit",
    groupKey: `usage_limit:mine:${payload.personId}:${payload.period}`,
    source: { userId: payload.personId },
    latest: { statusTo: "reached_notify", percent },
  });
}

/** This month's requests and the agent most used, for the admins' notice ("64 pedidos este mês, 80% com a Zara"). */
async function personFacts(db: Executor, orgId: string, personId: string, period: string) {
  const since = new Date(`${period}T00:00:00Z`);
  const rows = rowsOf<{ agent_id: string | null; name: string | null; runs: number; cost: string }>(
    await db.execute(sql`select u.agent_id, a.name, count(distinct u.run_id)::int as runs, sum(u.cost_nano_usd) as cost
      from ${schema.usageRecords} u left join ${schema.agents} a on a.id = u.agent_id
      where u.org_id = ${orgId}::uuid and u.person_id = ${personId} and u.created_at >= ${since.toISOString()}::timestamptz
      group by u.agent_id, a.name order by count(distinct u.run_id) desc`),
  );
  const runs = rows.reduce((n, r) => n + Number(r.runs), 0);
  const first = rows[0];
  const top =
    first?.name && runs > 0 ? { name: first.name, share: Math.round((Number(first.runs) / runs) * 100) } : null;
  const state = await personLimitState(db, orgId, personId);
  let roleName: string | null = null;
  if (state?.source === "role" && state.roleId) {
    const [r] = await db.select({ name: orgRoles.name }).from(orgRoles).where(eq(orgRoles.id, state.roleId));
    roleName = r?.name ?? null;
  }
  return { runs, top, roleName };
}

/**
 * "Pedir mais" (ADR 0141): the person at their limit asks; who decides hears it with "Aumentar para US$ X este mês"
 * and "Recusar". Once per month while unanswered.
 */
export async function requestMoreUsage(deps: NoticeDeps, actorId: string, orgId: string, at = new Date()) {
  await requireActiveMembership(deps.db, actorId, orgId);
  const state = await personLimitState(deps.db, orgId, actorId, at);
  if (!state || state.limitNanoUsd === null) throw new ConflictError("You have no usage limit to raise");
  // Asked already and nobody answered: who decides isn't told again.
  if (state.requestedAt) return { requestedAt: state.requestedAt.toISOString() };
  const period = periodOf(at);
  await deps.db
    .insert(personUsageMonths)
    .values({ orgId, personId: actorId, periodStart: period, requestedAt: at })
    .onConflictDoUpdate({
      target: [personUsageMonths.orgId, personUsageMonths.personId, personUsageMonths.periodStart],
      set: { requestedAt: at, updatedAt: at },
    });
  const facts = await personFacts(deps.db, orgId, actorId, period);
  // The request answers the "reached" notice.
  await resolveNotifications(deps, orgId, { groupKey: `usage_limit:reached:${actorId}:${period}` });
  await notify(deps, {
    orgId,
    userIds: await deciders(deps.db, orgId),
    kind: "usage_limit",
    groupKey: requestGroup(actorId, period),
    waiting: true,
    actor: { type: "user", id: actorId },
    source: { userId: actorId, ...(facts.roleName ? { label: facts.roleName } : {}) },
    latest: {
      statusTo: "request",
      percent: limitPercent(state.spentNanoUsd, state.limitNanoUsd) ?? 0,
      limitUsd: nanoUsdToUsd(state.limitNanoUsd),
      raiseToUsd: nanoUsdToUsd(suggestedRaise(state.limitNanoUsd)),
      limitFrom: state.source,
      runs: facts.runs,
      ...(facts.top ? { title: facts.top.name, share: facts.top.share } : {}),
    },
  });
  return { requestedAt: at.toISOString() };
}

/** The person's at-limit cards this month (`meta.actionCard.kind` `person_limit`) move to `state`. */
async function moveLimitCards(
  deps: NoticeDeps,
  orgId: string,
  personId: string,
  state: "raised" | "refused",
  byUserId: string,
  at: Date,
) {
  const { messages } = schema;
  const rows = await deps.db
    .update(messages)
    .set({
      meta: sql`jsonb_set(jsonb_set(${messages.meta}, '{actionCard,state}', ${JSON.stringify(state)}::jsonb),
        '{actionCard,byUserId}', ${JSON.stringify(byUserId)}::jsonb)`,
    })
    .where(
      and(
        eq(messages.orgId, orgId),
        gte(messages.createdAt, monthStartUtc(at)),
        sql`${messages.meta}->'actionCard'->>'kind' = 'person_limit'`,
        sql`${messages.meta}->'actionCard'->>'userId' = ${personId}`,
        sql`${messages.meta}->'actionCard'->>'state' in ('limited', 'refused')`,
      ),
    )
    .returning();
  if (deps.pubsub) for (const row of rows) await publishMessageCreated(deps.pubsub, messageView(row));
}

/** "Aumentar para US$ X este mês": the person's limit for this month only. Their cards say they may go on. */
export async function raisePersonLimit(
  deps: NoticeDeps,
  actorId: string,
  orgId: string,
  personId: string,
  limitNanoUsd: number,
  at = new Date(),
) {
  const actor = await requirePermission(deps.db, actorId, orgId, "configure");
  if (!can(actor, "view_usage")) throw new ForbiddenError();
  if (!(limitNanoUsd > 0)) throw new ValidationError("the limit must be above zero");
  const state = await personLimitState(deps.db, orgId, personId, at);
  if (!state) throw new ValidationError("not a member of this workspace");
  const period = periodOf(at);
  const limit = Math.round(limitNanoUsd);
  await deps.db
    .insert(personUsageMonths)
    .values({ orgId, personId, periodStart: period, raisedLimitNanoUsd: limit, raisedByUserId: actorId })
    .onConflictDoUpdate({
      target: [personUsageMonths.orgId, personUsageMonths.personId, personUsageMonths.periodStart],
      set: { raisedLimitNanoUsd: limit, raisedByUserId: actorId, requestedAt: null, reachedAt: null, updatedAt: at },
    });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "usage.limit_raised",
    target: { type: "person", id: personId },
    details: { period, limitNanoUsd: limit, fromNanoUsd: state.limitNanoUsd },
  });
  await resolveNotifications(deps, orgId, { groupKey: requestGroup(personId, period) });
  await resolveNotifications(deps, orgId, { groupKey: `usage_limit:reached:${personId}:${period}` });
  await notify(deps, {
    orgId,
    userIds: [personId],
    kind: "usage_limit",
    groupKey: `usage_limit:answer:${personId}:${period}`,
    actor: { type: "user", id: actorId },
    source: { userId: personId },
    latest: { statusTo: "raised", percent: limitPercent(state.spentNanoUsd, limit) ?? 0 },
  });
  await moveLimitCards(deps, orgId, personId, "raised", actorId, at);
}

/** "Recusar": the request closes and the person hears it. */
export async function refuseMoreUsage(
  deps: NoticeDeps,
  actorId: string,
  orgId: string,
  personId: string,
  at = new Date(),
) {
  const actor = await requirePermission(deps.db, actorId, orgId, "configure");
  if (!can(actor, "view_usage")) throw new ForbiddenError();
  const period = periodOf(at);
  await deps.db
    .update(personUsageMonths)
    .set({ requestedAt: null, updatedAt: at })
    .where(
      and(
        eq(personUsageMonths.orgId, orgId),
        eq(personUsageMonths.personId, personId),
        eq(personUsageMonths.periodStart, period),
      ),
    );
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "usage.limit_refused",
    target: { type: "person", id: personId },
    details: { period },
  });
  await resolveNotifications(deps, orgId, { groupKey: requestGroup(personId, period) });
  await notify(deps, {
    orgId,
    userIds: [personId],
    kind: "usage_limit",
    groupKey: `usage_limit:answer:${personId}:${period}`,
    actor: { type: "user", id: actorId },
    source: { userId: personId },
    latest: { statusTo: "refused" },
  });
  await moveLimitCards(deps, orgId, personId, "refused", actorId, at);
}

/** The settings as Settings › Orçamento e uso › Pessoas › Limites edits them (nano-USD), for who may see money. */
export async function getPersonLimits(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "view_usage");
  return orgPersonLimits(db, orgId);
}

/** Saves the limits (`usage.limit_changed` in Auditoria). Roles and people no longer in the workspace are dropped. */
export async function setPersonLimits(db: Database, actorId: string, orgId: string, input: PersonLimits) {
  const actor = await requirePermission(db, actorId, orgId, "configure");
  if (!can(actor, "view_usage")) throw new ForbiddenError();
  const clean = personLimitsOf(input);
  const roleIds = Object.keys(clean.roles);
  const userIds = Object.keys(clean.people);
  const roles = roleIds.length
    ? new Set(
        (
          await db
            .select({ id: orgRoles.id })
            .from(orgRoles)
            .where(and(eq(orgRoles.orgId, orgId), inArray(orgRoles.id, roleIds)))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const people = userIds.length
    ? new Set(
        (
          await db
            .select({ id: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const saved: PersonLimits = {
    ...clean,
    roles: Object.fromEntries(Object.entries(clean.roles).filter(([k]) => roles.has(k))),
    people: Object.fromEntries(Object.entries(clean.people).filter(([k]) => people.has(k))),
  };
  const value = saved as unknown as Record<string, unknown>;
  await db
    .insert(organizationSettings)
    .values({ orgId, personLimits: value })
    .onConflictDoUpdate({ target: organizationSettings.orgId, set: { personLimits: value, updatedAt: new Date() } });
  caches.orgs.delete(`${orgId}:person-limits`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "usage.limit_changed",
    target: { type: "organization", id: orgId },
    details: { default: saved.default, roles: saved.roles, people: saved.people, onLimit: saved.onLimit },
  });
  return saved;
}

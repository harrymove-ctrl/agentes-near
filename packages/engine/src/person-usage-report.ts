import { and, type Database, eq, gte, inArray, isNull, lt, rowsOf, schema, sql } from "@agenteschat/db";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { accountablePerson, runAuthority } from "./authority";
import { readableChannelIds } from "./channels";
import { ForbiddenError, NotFoundError } from "./errors";
import { can, requireActiveMembership } from "./organizations";
import {
  anyPersonLimit,
  type LimitSource,
  limitPercent,
  orgPersonLimits,
  PERSON_LIMIT_WARNING,
  resolveLimit,
  suggestedRaise,
} from "./person-usage";
import { apiNano } from "./plan-usage";
import { monthStartUtc } from "./usage";

const {
  usageRecords,
  personUsageMonths,
  organizationMembers,
  organizationMemberRoles,
  users,
  agents,
  agentRuns,
  channels,
  messages,
  routines,
  routineRuns,
  auditLog,
} = schema;

/** A period of the report (ADR 0141): from `since` (default this month, UTC) to `until` (default now). */
export interface UsagePeriod {
  since?: Date;
  until?: Date;
}

const periodOf = (at: Date) => monthStartUtc(at).toISOString().slice(0, 10);
const nextMonth = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
const usd = (nano: number) => Math.round(nanoUsdToUsd(nano) * 1e4) / 1e4;

/** Where a run was, as an admin may see it: a channel they read (with its name and the work's title), or not. */
export type WorkPlace =
  | { kind: "channel"; channelId: string; channelName: string }
  /** A DM with the agent: never its content (ADR 0141). */
  | { kind: "private" }
  /** A private channel the viewer isn't in: "num canal privado". */
  | { kind: "hidden" }
  | { kind: "routine"; routineName: string };

interface UsageGroup {
  personId: string;
  agentId: string | null;
  plan: boolean;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  last: Date;
}

/** API cost, or a plan's tokens at API prices ("≈ … pela API"): one unit for everything. */
const amountOf = (g: Pick<UsageGroup, "plan" | "model" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost">) =>
  g.plan ? (apiNano(g.model, g) ?? 0) : g.cost;

async function usageGroups(db: Database, orgId: string, since: Date, until: Date, personId?: string) {
  const rows = await db
    .select({
      personId: usageRecords.personId,
      agentId: usageRecords.agentId,
      plan: sql<boolean>`${usageRecords.billedTo} = 'plan'`,
      model: usageRecords.model,
      input: sql<string>`sum(${usageRecords.inputTokens})`,
      output: sql<string>`sum(${usageRecords.outputTokens})`,
      cacheRead: sql<string>`sum(${usageRecords.cacheReadTokens})`,
      cacheWrite: sql<string>`sum(${usageRecords.cacheWriteTokens})`,
      cost: sql<string>`sum(${usageRecords.costNanoUsd})`,
      last: sql<string>`max(${usageRecords.createdAt})`,
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.orgId, orgId),
        personId ? eq(usageRecords.personId, personId) : sql`${usageRecords.personId} is not null`,
        gte(usageRecords.createdAt, since),
        lt(usageRecords.createdAt, until),
      ),
    )
    .groupBy(usageRecords.personId, usageRecords.agentId, sql`${usageRecords.billedTo} = 'plan'`, usageRecords.model);
  return rows.map(
    (r): UsageGroup => ({
      personId: r.personId as string,
      agentId: r.agentId,
      plan: r.plan === true,
      model: r.model,
      input: Number(r.input),
      output: Number(r.output),
      cacheRead: Number(r.cacheRead),
      cacheWrite: Number(r.cacheWrite),
      cost: Number(r.cost),
      last: new Date(r.last),
    }),
  );
}

async function runCounts(db: Database, orgId: string, since: Date, until: Date, personId?: string) {
  return (
    await db
      .select({
        personId: usageRecords.personId,
        agentId: usageRecords.agentId,
        runs: sql<number>`count(distinct ${usageRecords.runId})::int`,
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.orgId, orgId),
          personId ? eq(usageRecords.personId, personId) : sql`${usageRecords.personId} is not null`,
          gte(usageRecords.createdAt, since),
          lt(usageRecords.createdAt, until),
        ),
      )
      .groupBy(usageRecords.personId, usageRecords.agentId)
  ).map((r) => ({ personId: r.personId as string, agentId: r.agentId, runs: Number(r.runs) }));
}

async function membersOf(db: Database, orgId: string, userId?: string) {
  return db
    .select({
      userId: organizationMembers.userId,
      name: users.name,
      email: users.email,
      image: users.image,
      owner: sql<boolean>`${organizationMembers.role} = 'owner'`,
      roleIds: sql<string[]>`coalesce((select array_agg(r.role_id::text) from ${organizationMemberRoles} r
        where r.org_id = ${organizationMembers.orgId} and r.user_id = ${organizationMembers.userId}), '{}')`,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), userId ? eq(organizationMembers.userId, userId) : undefined));
}

async function monthsOf(db: Database, orgId: string, at: Date, personId?: string) {
  const rows = await db
    .select()
    .from(personUsageMonths)
    .where(
      and(
        eq(personUsageMonths.orgId, orgId),
        eq(personUsageMonths.periodStart, periodOf(at)),
        personId ? eq(personUsageMonths.personId, personId) : undefined,
      ),
    );
  return new Map(rows.map((r) => [r.personId, r]));
}

/** Who created which agent, from the audit log (`agent.created` by a person), agents still there. */
async function creators(db: Database, orgId: string) {
  const rows = await db
    .select({ userId: auditLog.actorId, agentId: auditLog.targetId, at: auditLog.createdAt })
    .from(auditLog)
    .innerJoin(agents, and(eq(agents.orgId, orgId), sql`${agents.id}::text = ${auditLog.targetId}`))
    .where(
      and(
        eq(auditLog.orgId, orgId),
        eq(auditLog.action, "agent.created"),
        eq(auditLog.actorType, "person"),
        isNull(agents.archivedAt),
      ),
    );
  return rows.filter((r) => r.userId && r.agentId) as { userId: string; agentId: string; at: Date }[];
}

/** A person's limit and where it stands this month. */
function limitView(
  limits: Awaited<ReturnType<typeof orgPersonLimits>>,
  member: { userId: string; owner: boolean; roleIds: string[] },
  month: typeof personUsageMonths.$inferSelect | undefined,
) {
  const resolved = resolveLimit(limits, member, month?.raisedLimitNanoUsd ?? null);
  const spent = month?.spentNanoUsd ?? 0;
  const percent = limitPercent(spent, resolved.limitNanoUsd);
  const state =
    percent === null ? "none" : percent >= 100 ? "at" : percent >= PERSON_LIMIT_WARNING * 100 ? "near" : "ok";
  return {
    monthUsd: usd(spent),
    limitUsd: resolved.limitNanoUsd === null ? null : usd(resolved.limitNanoUsd),
    limitFrom: resolved.source as LimitSource,
    limitRoleId: resolved.roleId ?? null,
    raiseToUsd: resolved.limitNanoUsd === null ? null : usd(suggestedRaise(resolved.limitNanoUsd)),
    percent,
    state: state as "none" | "ok" | "near" | "at",
    requested: !!month?.requestedAt,
    reachedAt: month?.reachedAt?.toISOString() ?? null,
  };
}

/** First line of a thread's root message, short: the work's title. */
async function titles(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: messages.id, body: messages.body })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), inArray(messages.id, [...new Set(ids)])));
  // The mentions that called the agents in aren't part of what was asked.
  const line = (body: string) => (body.split("\n").find((l) => l.trim()) ?? "").replace(/^(\s*@[\w.-]+)+\s*/, "");
  return new Map(rows.map((r) => [r.id, line(r.body).trim().slice(0, 120)]));
}

/** Where each run happened, as `viewerId` may see it (ADR 0141's privacy rule), with its title when readable. */
async function placesOf(
  db: Database,
  orgId: string,
  viewerId: string,
  runs: { id: string; channelId: string; threadRootId: string; background: boolean }[],
) {
  const channelIds = [...new Set(runs.map((r) => r.channelId))];
  const chans = channelIds.length
    ? await db
        .select({
          id: channels.id,
          name: channels.name,
          kind: channels.kind,
          visibility: channels.visibility,
          archivedAt: channels.archivedAt,
        })
        .from(channels)
        .where(and(eq(channels.orgId, orgId), inArray(channels.id, channelIds)))
    : [];
  const byId = new Map(chans.map((c) => [c.id, c]));
  // A public channel is the viewer's to join and read, so its work is named even before they join.
  const readable = await readableChannelIds(db, orgId, viewerId, channelIds);
  for (const c of chans) if (c.kind === "channel" && c.visibility === "public" && !c.archivedAt) readable.add(c.id);
  const routineNames = new Map<string, string>();
  const bg = runs.filter((r) => r.background).map((r) => r.id);
  if (bg.length)
    for (const r of await db
      .select({ runId: routineRuns.agentRunId, name: routines.name })
      .from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .where(and(eq(routineRuns.orgId, orgId), inArray(routineRuns.agentRunId, bg))))
      if (r.runId) routineNames.set(r.runId, r.name);
  const visible = runs.filter((r) => {
    const c = byId.get(r.channelId);
    return c && c.kind !== "dm" && readable.has(r.channelId);
  });
  const named = await titles(
    db,
    orgId,
    visible.map((r) => r.threadRootId),
  );
  const out = new Map<string, { place: WorkPlace; title: string | null }>();
  for (const r of runs) {
    const c = byId.get(r.channelId);
    const routine = routineNames.get(r.id);
    if (routine) out.set(r.id, { place: { kind: "routine", routineName: routine }, title: null });
    else if (!c || c.kind === "dm") out.set(r.id, { place: { kind: "private" }, title: null });
    else if (!readable.has(r.channelId)) out.set(r.id, { place: { kind: "hidden" }, title: null });
    else
      out.set(r.id, {
        place: { kind: "channel", channelId: c.id, channelName: c.name },
        title: named.get(r.threadRootId) || null,
      });
  }
  return out;
}

export interface LiveWork {
  personId: string | null;
  agentId: string;
  /** A routine's run: its creator, who is accountable for it. */
  routine: boolean;
  place: WorkPlace;
  title: string | null;
  startedAt: string;
}

/** "Agora": who is using which agent right now, from the runs at work (ADR 0141 §Atividade agora). */
export async function liveWork(db: Database, orgId: string, viewerId: string): Promise<LiveWork[]> {
  const runs = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      agentId: agentRuns.agentId,
      channelId: agentRuns.channelId,
      threadRootId: agentRuns.threadRootId,
      triggerMessageId: agentRuns.triggerMessageId,
      background: agentRuns.background,
      transcript: agentRuns.transcript,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.status, "running")))
    .limit(100);
  const places = await placesOf(db, orgId, viewerId, runs);
  const out: LiveWork[] = [];
  for (const r of runs) {
    const authority = await runAuthority(db, r).catch(() => null);
    const personId = authority ? accountablePerson(authority) : null;
    const where = places.get(r.id) ?? { place: { kind: "private" as const }, title: null };
    out.push({
      personId,
      agentId: r.agentId,
      routine: authority?.kind === "routine",
      place: where.place,
      title: where.title,
      startedAt: r.createdAt.toISOString(),
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function requireUsageViewer(db: Database, actorId: string, orgId: string) {
  const m = await requireActiveMembership(db, actorId, orgId);
  if (!can(m, "view_usage")) throw new ForbiddenError();
  return m;
}

/**
 * Uso › Pessoas (ADR 0141): every member's use in the period (API cost, or a plan's at API prices), their requests,
 * the agents they use most, where they stand on this month's limit, the agents they look after and created, and
 * what they are doing now. For who may see money (`view_usage`). Never a message's text but the titles of work in
 * channels the viewer reads.
 */
export async function peopleUsage(db: Database, actorId: string, orgId: string, period: UsagePeriod = {}) {
  await requireUsageViewer(db, actorId, orgId);
  const at = new Date();
  const since = period.since ?? monthStartUtc(at);
  const until = period.until ?? at;
  const [members, groups, counts, months, limits, owned, made, live] = await Promise.all([
    membersOf(db, orgId),
    usageGroups(db, orgId, since, until),
    runCounts(db, orgId, since, until),
    monthsOf(db, orgId, at),
    orgPersonLimits(db, orgId),
    db
      .select({ id: agents.id, owner: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt))),
    creators(db, orgId),
    liveWork(db, orgId, actorId),
  ]);
  let total = 0;
  let anyPlan = false;
  let anyApi = false;
  const people = members.map((m) => {
    const mine = groups.filter((g) => g.personId === m.userId);
    let amount = 0;
    let last: Date | null = null;
    const byAgent = new Map<string, number>();
    for (const g of mine) {
      const a = amountOf(g);
      amount += a;
      if (g.plan) anyPlan = true;
      else anyApi = true;
      if (g.agentId) byAgent.set(g.agentId, (byAgent.get(g.agentId) ?? 0) + a);
      if (!last || g.last > last) last = g.last;
    }
    total += amount;
    const runsBy = counts.filter((c) => c.personId === m.userId);
    const runs = runsBy.reduce((n, c) => n + c.runs, 0);
    const top = runsBy
      .filter((c) => c.agentId)
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 3)
      .map((c) => ({ agentId: c.agentId as string, share: runs > 0 ? Math.round((c.runs / runs) * 100) : 0 }));
    const now = live.find((w) => w.personId === m.userId) ?? null;
    return {
      userId: m.userId,
      name: m.name,
      image: m.image,
      owner: m.owner,
      roleIds: m.roleIds ?? [],
      runs,
      costUsd: usd(amount),
      estimated: mine.some((g) => g.plan),
      agents: top,
      ...limitView(limits, { ...m, roleIds: m.roleIds ?? [] }, months.get(m.userId)),
      caresFor: owned.filter((a) => a.owner === m.userId).map((a) => a.id),
      created: made.filter((c) => c.userId === m.userId).length,
      lastActiveAt: last?.toISOString() ?? null,
      now: now ? { agentId: now.agentId, place: now.place, title: now.title, startedAt: now.startedAt } : null,
    };
  });
  people.sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));
  return {
    month: periodOf(at).slice(0, 7),
    since: since.toISOString(),
    until: until.toISOString(),
    totalUsd: usd(total),
    /** Only plans were used: amounts are API-equivalents that compare people, not money spent. */
    plansOnly: anyPlan && !anyApi,
    limitsOn: anyPersonLimit(limits),
    people,
    live,
  };
}

/**
 * One person's month (the drawer, and "Seu uso"): the limit, use per day by agent, which agents, what they did
 * recently and the agents they created. Their own: always, in percentages; anyone else's: with `view_usage`, in
 * money. A DM's work is a count and its cost, never a title (ADR 0141).
 */
export async function personUsageDetail(
  db: Database,
  actorId: string,
  orgId: string,
  personId: string,
  period: UsagePeriod = {},
) {
  const actor = await requireActiveMembership(db, actorId, orgId);
  const money = can(actor, "view_usage");
  if (personId !== actorId && !money) throw new ForbiddenError();
  const [member] = await membersOf(db, orgId, personId);
  if (!member) throw new NotFoundError("Not a member of this workspace");
  const at = new Date();
  const since = period.since ?? monthStartUtc(at);
  const until = period.until ?? at;
  const limits = await orgPersonLimits(db, orgId);
  const month = (await monthsOf(db, orgId, at, personId)).get(personId);
  const limit = limitView(limits, { ...member, roleIds: member.roleIds ?? [] }, month);
  // Members see shares: of their limit, else of their own month.
  const daily = rowsOf<{
    day: string;
    agent_id: string | null;
    plan: boolean;
    model: string;
    i: string;
    o: string;
    cr: string;
    cw: string;
    cost: string;
  }>(
    await db.execute(sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, agent_id,
        billed_to = 'plan' as plan, model, sum(input_tokens) as i, sum(output_tokens) as o,
        sum(cache_read_tokens) as cr, sum(cache_write_tokens) as cw, sum(cost_nano_usd) as cost
      from ${usageRecords}
      where org_id = ${orgId}::uuid and person_id = ${personId} and created_at >= ${since.toISOString()}::timestamptz
        and created_at < ${until.toISOString()}::timestamptz
      group by 1, 2, 3, 4`),
  );
  const amounts = daily.map((r) => ({
    day: r.day,
    agentId: r.agent_id,
    nano: amountOf({
      plan: r.plan === true,
      model: r.model,
      input: Number(r.i),
      output: Number(r.o),
      cacheRead: Number(r.cr),
      cacheWrite: Number(r.cw),
      cost: Number(r.cost),
    }),
  }));
  const totalNano = amounts.reduce((n, a) => n + a.nano, 0);
  const base = limit.limitUsd !== null ? limit.limitUsd * 1e9 : totalNano;
  const show = (nano: number) => (money ? usd(nano) : base > 0 ? Math.round((nano / base) * 1000) / 10 : 0);
  const days = new Map<string, Record<string, number>>();
  for (const a of amounts) {
    if (!a.agentId) continue;
    const d = days.get(a.day) ?? {};
    d[a.agentId] = (d[a.agentId] ?? 0) + a.nano;
    days.set(a.day, d);
  }
  const counts = await runCounts(db, orgId, since, until, personId);
  const byAgent = new Map<string, number>();
  for (const a of amounts) if (a.agentId) byAgent.set(a.agentId, (byAgent.get(a.agentId) ?? 0) + a.nano);
  const agentRows = [...byAgent]
    .map(([agentId, nano]) => ({
      agentId,
      runs: counts.find((c) => c.agentId === agentId)?.runs ?? 0,
      amount: show(nano),
    }))
    .sort((a, b) => b.amount - a.amount);

  // What they did: their runs, newest first, each with what it cost (or would through the API).
  const perRun = rowsOf<{
    run_id: string;
    plan: boolean;
    model: string;
    i: string;
    o: string;
    cr: string;
    cw: string;
    cost: string;
    first: string;
    last: string;
  }>(
    await db.execute(sql`select run_id, billed_to = 'plan' as plan, model, sum(input_tokens) as i,
        sum(output_tokens) as o, sum(cache_read_tokens) as cr, sum(cache_write_tokens) as cw,
        sum(cost_nano_usd) as cost, min(created_at) as first, max(created_at) as last
      from ${usageRecords}
      where org_id = ${orgId}::uuid and person_id = ${personId} and run_id is not null
        and created_at >= ${since.toISOString()}::timestamptz and created_at < ${until.toISOString()}::timestamptz
      group by 1, 2, 3`),
  );
  const runNano = new Map<string, { nano: number; first: Date; last: Date }>();
  for (const r of perRun) {
    const nano = amountOf({
      plan: r.plan === true,
      model: r.model,
      input: Number(r.i),
      output: Number(r.o),
      cacheRead: Number(r.cr),
      cacheWrite: Number(r.cw),
      cost: Number(r.cost),
    });
    const prev = runNano.get(r.run_id);
    const first = new Date(r.first);
    const last = new Date(r.last);
    runNano.set(r.run_id, {
      nano: (prev?.nano ?? 0) + nano,
      first: prev && prev.first < first ? prev.first : first,
      last: prev && prev.last > last ? prev.last : last,
    });
  }
  const recentIds = [...runNano].sort((a, b) => b[1].last.getTime() - a[1].last.getTime()).map(([id]) => id);
  const runRows = recentIds.length
    ? await db
        .select({
          id: agentRuns.id,
          agentId: agentRuns.agentId,
          channelId: agentRuns.channelId,
          threadRootId: agentRuns.threadRootId,
          background: agentRuns.background,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.id, recentIds.slice(0, 200))))
    : [];
  const places = await placesOf(db, orgId, actorId, runRows);
  type Recent =
    | {
        kind: "work";
        agentId: string;
        place: WorkPlace;
        title: string | null;
        startedAt: string;
        minutes: number;
        amount: number;
      }
    | { kind: "private" | "hidden"; agentId: string; runs: number; amount: number; lastAt: string };
  const recent: Recent[] = [];
  const grouped = new Map<string, Extract<Recent, { kind: "private" | "hidden" }>>();
  const byRun = new Map(runRows.map((r) => [r.id, r]));
  for (const id of recentIds) {
    const run = byRun.get(id);
    const used = runNano.get(id);
    if (!run || !used) continue;
    const where = places.get(id);
    if (!where) continue;
    if (where.place.kind === "private" || where.place.kind === "hidden") {
      const key = `${where.place.kind}:${run.agentId}`;
      const g = grouped.get(key);
      if (g) {
        g.runs++;
        g.amount += used.nano;
      } else {
        const row = {
          kind: where.place.kind,
          agentId: run.agentId,
          runs: 1,
          amount: used.nano,
          lastAt: used.last.toISOString(),
        };
        grouped.set(key, row);
        recent.push(row);
      }
      continue;
    }
    recent.push({
      kind: "work",
      agentId: run.agentId,
      place: where.place,
      title: where.title,
      startedAt: used.first.toISOString(),
      minutes: Math.max(1, Math.round((used.last.getTime() - used.first.getTime()) / 60_000)),
      amount: used.nano,
    });
  }
  const made = (await creators(db, orgId)).filter((c) => c.userId === personId);
  return {
    userId: personId,
    name: member.name,
    image: member.image,
    roleIds: member.roleIds ?? [],
    owner: member.owner,
    money,
    estimated: daily.some((r) => r.plan === true),
    renewsAt: nextMonth(at).toISOString(),
    since: since.toISOString(),
    until: until.toISOString(),
    limit: money
      ? limit
      : { percent: limit.percent, state: limit.state, requested: limit.requested, reachedAt: limit.reachedAt },
    total: show(totalNano),
    days: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, byAgentId]) => ({
        date,
        agents: Object.fromEntries(Object.entries(byAgentId).map(([k, v]) => [k, show(v)])),
      })),
    agents: agentRows,
    recent: recent.slice(0, 30).map((r) => ({ ...r, amount: show(r.amount) })),
    created: made.map((c) => ({ agentId: c.agentId, createdAt: c.at.toISOString() })),
  };
}

const csvCell = (v: string | number) => {
  // A name starting with = + - @ would run as a formula in a spreadsheet: a leading ' keeps it text.
  const s = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * The export (ADR 0141): one row per person per day, never a message's text. Amounts in US$; a plan's at what its
 * tokens would cost through the API, apart.
 */
export async function peopleUsageCsv(db: Database, actorId: string, orgId: string, period: UsagePeriod = {}) {
  await requireUsageViewer(db, actorId, orgId);
  const at = new Date();
  const since = period.since ?? monthStartUtc(at);
  const until = period.until ?? at;
  const rows = rowsOf<{
    person_id: string;
    day: string;
    agent_id: string | null;
    plan: boolean;
    model: string;
    runs: number;
    i: string;
    o: string;
    cr: string;
    cw: string;
    cost: string;
  }>(
    await db.execute(sql`select person_id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, agent_id,
        billed_to = 'plan' as plan, model, count(distinct run_id)::int as runs, sum(input_tokens) as i,
        sum(output_tokens) as o, sum(cache_read_tokens) as cr, sum(cache_write_tokens) as cw, sum(cost_nano_usd) as cost
      from ${usageRecords}
      where org_id = ${orgId}::uuid and person_id is not null and created_at >= ${since.toISOString()}::timestamptz
        and created_at < ${until.toISOString()}::timestamptz
      group by 1, 2, 3, 4, 5`),
  );
  const members = new Map((await membersOf(db, orgId)).map((m) => [m.userId, m]));
  const roleNames = new Map(
    (
      await db
        .select({ id: schema.orgRoles.id, name: schema.orgRoles.name })
        .from(schema.orgRoles)
        .where(eq(schema.orgRoles.orgId, orgId))
    ).map((r) => [r.id, r.name]),
  );
  const agentNames = new Map(
    (await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.orgId, orgId))).map((a) => [
      a.id,
      a.name,
    ]),
  );
  const days = new Map<
    string,
    { personId: string; day: string; runs: number; tokens: number; api: number; plan: number; agents: Set<string> }
  >();
  for (const r of rows) {
    const key = `${r.person_id}|${r.day}`;
    const d = days.get(key) ?? {
      personId: r.person_id,
      day: r.day,
      runs: 0,
      tokens: 0,
      api: 0,
      plan: 0,
      agents: new Set<string>(),
    };
    const counts = { input: Number(r.i), output: Number(r.o), cacheRead: Number(r.cr), cacheWrite: Number(r.cw) };
    d.runs += Number(r.runs);
    d.tokens += counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
    if (r.plan) d.plan += apiNano(r.model, counts) ?? 0;
    else d.api += Number(r.cost);
    if (r.agent_id) d.agents.add(agentNames.get(r.agent_id) ?? r.agent_id);
    days.set(key, d);
  }
  const lines = [["person", "email", "roles", "day", "requests", "tokens", "cost_usd", "plan_estimate_usd", "agents"]];
  for (const d of [...days.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.personId.localeCompare(b.personId),
  )) {
    const m = members.get(d.personId);
    lines.push([
      m?.name ?? d.personId,
      m?.email ?? "",
      (m?.roleIds ?? [])
        .map((id) => roleNames.get(id) ?? "")
        .filter(Boolean)
        .join("; "),
      d.day,
      String(d.runs),
      String(d.tokens),
      nanoUsdToUsd(d.api).toFixed(4),
      nanoUsdToUsd(d.plan).toFixed(4),
      [...d.agents].sort().join("; "),
    ]);
  }
  return `${lines.map((l) => l.map(csvCell).join(",")).join("\n")}\n`;
}

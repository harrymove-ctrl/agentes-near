import { isSafeRule, PERMISSION_WAIT_MS, TASK_LIMITS, type TaskDenial } from "@agenteschat/adapters";
import { type Executor, rowsOf, type SQL, schema, sql } from "@agenteschat/db";

const { missionEvents, missions } = schema;

/**
 * The stored side of command approvals (ADR 0029): kept in the mission's
 * feed (`mission_events`), no table of their own. `command_rule`: a command
 * a person allowed for the whole mission ("Aprovar sempre nesta missão");
 * `command_rule_removed`: a person took one back ("O que já foi liberado" ×);
 * `command_blocked`: commands a task was refused with nobody to ask (its end
 * notice lists them). The prompts themselves live in `mission-commands.ts`.
 */

/**
 * How many command cards (`command_prompt`, see `mission-commands.ts`) of
 * the mission `missionId` (an SQL expression: `m.id`) wait for an answer:
 * nobody decided and its `PERMISSION_WAIT_MS` hasn't passed (the runner
 * stopped asking then). A scalar subquery (`int`).
 */
export const pendingCommandsSql = (missionId: SQL) => sql`(select count(*)::int from ${missionEvents} ce
    where ce.mission_id = ${missionId} and ce.kind = 'command_prompt'
      and ce.created_at > now() - ${sql.raw(`interval '${Math.round(PERMISSION_WAIT_MS / 1000)} seconds'`)}
      and not exists (select 1 from ${missionEvents} cd where cd.mission_id = ce.mission_id
        and cd.kind = 'command_decided' and cd.data->>'promptId' = ce.data->>'promptId'))`;

/** Open command cards per mission (missions without one are left out). */
export async function pendingCommandCounts(db: Executor, missionIds: string[]): Promise<Map<string, number>> {
  if (missionIds.length === 0) return new Map();
  const rows = rowsOf<{ id: string; n: number | string }>(
    await db.execute(sql`select m.id, ${pendingCommandsSql(sql`m.id`)} as n from ${missions} m
      where m.id in (${sql.join(
        missionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`),
  );
  return new Map(rows.filter((r) => Number(r.n) > 0).map((r) => [r.id, Number(r.n)]));
}

/** A rule allowed for the whole mission ("O que já foi liberado"): its event id, who and when. */
export interface MissionRuleView {
  id: string;
  rule: string;
  by: string | null;
  createdAt: string;
}

/**
 * The rules still in force, oldest first: every `command_rule` not taken
 * back by a later `command_rule_removed` (which names the rule's event id).
 * The same rule allowed twice shows once (the first).
 */
export async function missionAllowRuleRows(db: Executor, missionId: string): Promise<MissionRuleView[]> {
  const rows = rowsOf<{ id: string; kind: string; data: Record<string, unknown> | string; created_at: Date | string }>(
    await db.execute(sql`select id, kind, data, created_at from ${missionEvents}
      where mission_id = ${missionId}::uuid and kind in ('command_rule', 'command_rule_removed')
      order by created_at, id limit 1000`),
  );
  const removed = new Set<string>();
  const added: { id: string; data: Record<string, unknown>; at: Date | string }[] = [];
  for (const r of rows) {
    const data = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
    if (r.kind === "command_rule_removed") {
      if (typeof data.ruleId === "string") removed.add(data.ruleId);
    } else added.push({ id: r.id, data, at: r.created_at });
  }
  const out: MissionRuleView[] = [];
  for (const a of added) {
    const rule = typeof a.data.rule === "string" ? a.data.rule : "";
    if (removed.has(a.id) || !rule || !isSafeRule(rule) || out.some((x) => x.rule === rule)) continue;
    out.push({
      id: a.id,
      rule,
      by: typeof a.data.by === "string" ? a.data.by : null,
      createdAt: (a.at instanceof Date ? a.at : new Date(a.at)).toISOString(),
    });
    if (out.length >= 200) break;
  }
  return out;
}

/** Every rule a person allowed for the whole mission, oldest first (sent with each work turn). */
export async function missionAllowRules(db: Executor, missionId: string): Promise<string[]> {
  return (await missionAllowRuleRows(db, missionId)).map((r) => r.rule);
}

/**
 * Takes a rule back (`command_rule_removed`): the command asks again (or
 * goes by the mission's autonomy). Returns the removed rule, or null when it
 * isn't in force.
 */
export async function removeMissionAllowRule(
  db: Executor,
  mission: { id: string; orgId: string },
  ruleId: string,
  by: { userId: string },
): Promise<MissionRuleView | null> {
  const found = (await missionAllowRuleRows(db, mission.id)).find((r) => r.id === ruleId);
  if (!found) return null;
  await db.insert(missionEvents).values({
    orgId: mission.orgId,
    missionId: mission.id,
    kind: "command_rule_removed",
    data: { ruleId, rule: found.rule, by: by.userId },
  });
  return found;
}

/**
 * "Nesta missão: N liberados automaticamente · N perguntados · N
 * bloqueados": commands allowed without a card (`command_auto`), cards
 * (`command_prompt`), and refusals (a card answered Recusar, or a command a
 * task was refused with nobody to ask, `command_blocked`).
 */
export async function missionCommandStats(
  db: Executor,
  missionId: string,
): Promise<{ auto: number; asked: number; blocked: number }> {
  const rows = rowsOf<{
    auto: number | string;
    asked: number | string;
    denied: number | string;
    refused: number | string;
  }>(
    await db.execute(sql`select
        (count(*) filter (where kind = 'command_auto'))::int as auto,
        (count(*) filter (where kind = 'command_prompt'))::int as asked,
        (count(*) filter (where kind = 'command_decided' and data->>'decision' = 'deny'))::int as denied,
        coalesce(sum(case when kind = 'command_blocked' and jsonb_typeof(data->'denials') = 'array'
          then jsonb_array_length(data->'denials') else 0 end), 0)::int as refused
      from ${missionEvents}
      where mission_id = ${missionId}::uuid
        and kind in ('command_auto', 'command_prompt', 'command_decided', 'command_blocked')`),
  );
  const r = rows[0];
  return {
    auto: Number(r?.auto ?? 0),
    asked: Number(r?.asked ?? 0),
    blocked: Number(r?.denied ?? 0) + Number(r?.refused ?? 0),
  };
}

/** Adds rules a person allowed for the mission (the ones already there are skipped). */
export async function addMissionAllowRules(
  db: Executor,
  mission: { id: string; orgId: string },
  rules: string[],
  by: { userId: string; promptId?: string | null },
) {
  const have = await missionAllowRules(db, mission.id);
  const fresh = [...new Set(rules)].filter((r) => isSafeRule(r) && !have.includes(r));
  for (const rule of fresh) {
    await db.insert(missionEvents).values({
      orgId: mission.orgId,
      missionId: mission.id,
      kind: "command_rule",
      data: { rule, by: by.userId, ...(by.promptId ? { promptId: by.promptId } : {}) },
    });
  }
  return fresh;
}

/** A task's refused commands (`task.done.denials`), kept for its end notice. */
export async function recordTaskDenials(
  db: Executor,
  task: { id: string; orgId: string; missionId: string | null },
  denials: TaskDenial[] | undefined,
) {
  if (!task.missionId || !denials?.length) return;
  await db.insert(missionEvents).values({
    orgId: task.orgId,
    missionId: task.missionId,
    kind: "command_blocked",
    data: { taskId: task.id, denials: denials.slice(0, TASK_LIMITS.denials) },
  });
}

/** What a task was refused (latest report). */
export async function blockedOfTask(db: Executor, missionId: string, taskId: string): Promise<TaskDenial[]> {
  const rows = rowsOf<{ denials: TaskDenial[] | string | null }>(
    await db.execute(sql`select data->'denials' as denials from ${missionEvents}
      where mission_id = ${missionId}::uuid and kind = 'command_blocked' and data->>'taskId' = ${taskId}
      order by created_at desc limit 1`),
  );
  const raw = rows[0]?.denials;
  const list = typeof raw === "string" ? (JSON.parse(raw) as TaskDenial[]) : (raw ?? []);
  return Array.isArray(list)
    ? list.filter((d) => d && typeof d.command === "string").slice(0, TASK_LIMITS.denials)
    : [];
}

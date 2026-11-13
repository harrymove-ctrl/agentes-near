import { and, type Database, eq, inArray, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { caches, rulesPresenceKey } from "../cache";
import { isAgentOnlyDm } from "../dms";
import { unaskedDestination } from "../outside";
import { enqueueIndex } from "../search";
import { howToChannels, howToSql, isVerified } from "./items";

const { channels, contextItems, messages } = schema;

/** How `remember` refused a rule in a run that read outside content, before ADR 0167. */
const RULE_REFUSED = "Not saved: this run read content from outside%";
/** A message that asks for a rule in so many words. */
const ASKS_FOR_RULE = /(?<![\p{L}\p{N}])(?:rules?|regras?|reglas?|règles?|regeln?)(?![\p{L}\p{N}])/iu;

type KindCounts = Record<string, { trusted: number; untrusted: number }>;

export interface TrustBackfill {
  /** Active items per kind, before and after. */
  before: KindCounts;
  after: KindCounts;
  /** Items made trusted, per kind (before any became a rule). */
  changed: Record<string, number>;
  /** Preferences that became the rule their person asked for. */
  rules: number;
}

/**
 * One-off (ADR 0167), run at boot: trust re-derived for each untrusted item from its own recorded sources, never all
 * at once. An item saved from a member's own message (`remember`, `update_memory`: a person's evidence, `created_by`
 * them) that relays nothing from outside becomes trusted, that message staying linked as its quote, unless it names
 * an address the message doesn't (`unaskedDestination`). Such a preference becomes a rule only where `remember`
 * refused that rule for outside content and the message asked for a rule in so many words. Anything else (outside
 * sources, agents' claims, how-tos) stays as it is. Idempotent: a second run changes nothing.
 */
export async function backfillMemoryTrust(db: Database): Promise<TrustBackfill> {
  const before = await trustCounts(db);
  const items = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        eq(contextItems.trust, "low"),
        eq(contextItems.createdByKind, "person"),
      ),
    );
  const refOf = (item: (typeof items)[number]) =>
    item.evidence.filter((e) => e.type === "human" && /^[0-9a-f-]{36}$/i.test(e.ref)).map((e) => e.ref);
  const refs = [...new Set(items.flatMap(refOf))];
  const said = refs.length
    ? await db
        .select({ id: messages.id, orgId: messages.orgId, userId: messages.authorUserId, body: messages.body })
        .from(messages)
        .where(
          and(
            inArray(messages.id, refs),
            eq(messages.authorType, "person"),
            isNull(messages.deletedAt),
            sql`coalesce(${messages.meta}->>'readOutside', '') <> 'true'`,
          ),
        )
    : [];
  const byId = new Map(said.map((m) => [m.id, m]));
  const refused = new Set(
    rowsOf<{ id: string }>(
      await db.execute(sql`select distinct r.trigger_message_id as id from agent_run_steps s
        join agent_runs r on r.id = s.run_id and r.org_id = s.org_id
        where s.kind = 'tool_result' and s.data->>'name' = 'remember' and s.data->>'content' like ${RULE_REFUSED}`),
    ).map((r) => String(r.id)),
  );
  const changed: Record<string, number> = {};
  let rules = 0;
  for (const item of items) {
    const m = refOf(item)
      .map((ref) => byId.get(ref))
      .find((x) => x && x.orgId === item.orgId && x.userId === item.createdById);
    if (!m || unaskedDestination(`${item.title}\n${item.content}`, m.body)) continue;
    const rule = item.kind === "preference" && item.agentId !== null && refused.has(m.id) && ASKS_FOR_RULE.test(m.body);
    await db
      .update(contextItems)
      .set({
        trust: "high",
        verified: item.kind === "note" || isVerified(item.evidence),
        confidence: Math.max(item.confidence, 0.95),
        ...(rule
          ? { kind: "rule" as const, scopeType: "agent", scopeId: item.agentId, channelIds: [] as string[] }
          : {}),
      })
      .where(and(eq(contextItems.id, item.id), eq(contextItems.trust, "low")));
    changed[item.kind] = (changed[item.kind] ?? 0) + 1;
    if (rule && item.agentId) {
      rules++;
      caches.contextPresence.delete(rulesPresenceKey(item.orgId, item.agentId));
      await enqueueIndex(db, { orgId: item.orgId, kind: "context_item", sourceId: item.id });
    }
  }
  return { before, after: await trustCounts(db), changed, rules };
}

async function trustCounts(db: Database): Promise<KindCounts> {
  const rows = await db
    .select({ kind: contextItems.kind, trust: contextItems.trust, n: sql<number>`count(*)::int` })
    .from(contextItems)
    .where(and(eq(contextItems.status, "active"), isNull(contextItems.supersededBy)))
    .groupBy(contextItems.kind, contextItems.trust);
  const out: KindCounts = {};
  for (const r of rows) {
    const k = out[r.kind] ?? { trusted: 0, untrusted: 0 };
    out[r.kind] = k;
    if (r.trust === "high") k.trusted += Number(r.n);
    else k.untrusted += Number(r.n);
  }
  return out;
}

/**
 * One-off (ADR 0167), run at boot: how-tos worked out in agents' DMs before they could leave them reach the agent's
 * other work when they name nobody (`howToChannels`). Idempotent: one already widened is in no channel.
 */
export async function widenDmHowTos(db: Database): Promise<number> {
  const rows = await db
    .select({
      id: contextItems.id,
      orgId: contextItems.orgId,
      title: contextItems.title,
      content: contextItems.content,
      channel: { id: channels.id, kind: channels.kind, dmKey: channels.dmKey },
    })
    .from(contextItems)
    .innerJoin(
      channels,
      and(eq(channels.orgId, contextItems.orgId), sql`${contextItems.channelIds} = array[${channels.id}]::uuid[]`),
    )
    .where(
      and(eq(contextItems.status, "active"), isNull(contextItems.supersededBy), howToSql(), eq(channels.kind, "dm")),
    );
  let widened = 0;
  for (const row of rows) {
    if (!isAgentOnlyDm(row.channel)) continue;
    if ((await howToChannels(db, row.orgId, row.channel, `${row.title}\n${row.content}`)).length > 0) continue;
    await db.update(contextItems).set({ channelIds: [] }).where(eq(contextItems.id, row.id));
    await enqueueIndex(db, { orgId: row.orgId, kind: "context_item", sourceId: row.id });
    widened++;
  }
  return widened;
}

import { and, asc, type Database, desc, eq, gte, inArray, lt, rowsOf, schema, sql } from "@agenteschat/db";
import { contentWords } from "./stopwords";

export type SearchKind = "message" | "context_item" | "issue" | "file" | "wiki" | "action";

export interface SearchDocument {
  orgId: string;
  kind: SearchKind;
  sourceId: string;
  /**
   * Visibility travels with the document (ADR 0017): a reader must see EVERY
   * channel listed (most restrictive of the sources). Empty = whole org.
   */
  channelIds: string[];
  title?: string;
  body: string;
  /** Words it is also found by, never shown (a memory's English key, ADR 0167): matched like its title. */
  keywords?: string;
  /** Optional vector (EMBEDDING_DIMENSIONS); without it the doc is full-text only. */
  embedding?: number[] | null;
  embeddingModel?: string | null;
  createdAt: Date;
}

export interface SearchQuery {
  text: string;
  /** Query vector, when an embedding provider is configured. */
  embedding?: number[] | null;
  /** The model that made `embedding`: only documents it embedded are compared, so a reindex half done never mixes two. */
  embeddingModel?: string;
  /** Channels the reader can see. Enforced by every implementation. */
  visibleChannelIds: string[];
  /** Scopes the reader sees on tasks' documents only: a DM's id here reaches its tasks, never its messages. */
  visibleIssueScopes?: string[];
  /** Files' documents the reader sees by their own id (`sourceId`), past their channels: shared with them (ADR 0157). */
  visibleFileScopes?: string[];
  kinds?: SearchKind[];
  limit?: number;
  /**
   * `all` (default): every word must match (websearch syntax). `any`: at least one word that says something (stopwords
   * left out), ranked by how dense the matches are in the document, with a match in its title first (retrieval).
   */
  match?: "all" | "any";
  /**
   * With `any`, for retrieval that must say nothing when nothing fits (a run's context): a full-text hit is kept only
   * when its matches' density (`ts_rank_cd` normalization 2|32) reaches this and it matches two of the words or one in
   * its title. Vector hits then only reorder those: alone they bring nothing.
   */
  minTextRank?: number;
  /** Vector hits farther than this cosine distance are dropped (default 0.75, i.e. similarity < 0.25). */
  maxDistance?: number;
  /** Only documents whose source was created at or after `after` and before `before` (ADR 0123). */
  after?: Date;
  before?: Date;
  /** Only message documents whose message passes every filter (ADR 0123). */
  messages?: MessageFilter;
  /**
   * `relevance` (default): text and vector ranks fused. `newest` / `oldest`: full-text matches by date, or every
   * document that passes the filters when there is no text (no text and `relevance` lists the newest).
   */
  sort?: "relevance" | "newest" | "oldest";
}

/** What a message has (ADR 0123): a link in its text, a file, an image (an image file, a GIF or a sticker), a card. */
export type MessageHas = "link" | "file" | "image" | "card";
export const MESSAGE_HAS: readonly MessageHas[] = ["link", "file", "image", "card"];

/** Message filters (ADR 0123). Within `from` and within `mentions` any one matches; everything else must match. */
export interface MessageFilter {
  fromUserIds?: string[];
  fromAgentIds?: string[];
  authorType?: "person" | "agent";
  mentionsUserIds?: string[];
  mentionsAgentIds?: string[];
  has?: MessageHas[];
  pinned?: boolean;
}

export interface SearchHit {
  kind: SearchKind;
  sourceId: string;
  channelIds: string[];
  title: string;
  snippet: string;
  /** Fused rank score (higher is better); comparable only within one query. */
  score: number;
  createdAt: Date;
}

/** A search backend for one organization: Postgres (core) or Turbopuffer (Cloud). */
export interface SearchIndex {
  readonly backend: string;
  upsert(docs: SearchDocument[]): Promise<void>;
  delete(refs: { kind: SearchKind; sourceId: string }[]): Promise<void>;
  query(q: SearchQuery): Promise<SearchHit[]>;
}

/**
 * Picks the search backend per organization (ADR 0002). The core always answers
 * Postgres and knows nothing about plans; the Cloud billing module replaces
 * this resolver.
 */
export interface SearchIndexResolver {
  forOrg(orgId: string): Promise<SearchIndex>;
}

/** `meta` keys of the messages that carry a card (approvals, questions, proposals, mission and browser cards). */
const CARD_META_KEYS = [
  "approvalId",
  "questionId",
  "secretRequest",
  "actionCard",
  "browserHandoff",
  "missionPlan",
  "missionCommand",
  "missionDelivery",
  "missionReport",
  "longWork",
];

const uuids = (ids: string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/** The SQL condition on `messages m` for a filter, or null when it filters nothing. */
function messageConditions(f: MessageFilter) {
  const m = schema.messages;
  const parts = [];
  const from = [
    f.fromUserIds?.length ? sql`${m.authorUserId} = any(${sql`${`{${f.fromUserIds.join(",")}}`}::text[]`})` : null,
    f.fromAgentIds?.length ? sql`${m.authorAgentId} = any(${uuids(f.fromAgentIds)})` : null,
  ].filter((x) => x !== null);
  if (from.length) parts.push(sql`(${sql.join(from, sql` or `)})`);
  if (f.authorType) parts.push(sql`${m.authorType} = ${f.authorType}`);
  const mentions = [
    f.mentionsUserIds?.length
      ? sql`${m.mentionedUserIds} && ${sql`${`{${f.mentionsUserIds.join(",")}}`}::text[]`}`
      : null,
    f.mentionsAgentIds?.length ? sql`${m.mentionedAgentIds} && ${uuids(f.mentionsAgentIds)}` : null,
  ].filter((x) => x !== null);
  if (mentions.length) parts.push(sql`(${sql.join(mentions, sql` or `)})`);
  for (const has of new Set(f.has ?? [])) {
    if (has === "link") parts.push(sql`${m.body} ~* 'https?://'`);
    // A deleted file stays in `meta.artifacts` (only `artifacts.deleted_at` says it is gone). Polls, choice cards
    // and blocks ride in `meta.artifacts` too, and they are not files.
    if (has === "file") {
      const a = schema.artifacts;
      parts.push(sql`exists (select 1 from jsonb_path_query(${m.meta}, '$.artifacts[*].id') as f(id)
        where not exists (select 1 from ${a} where ${a.orgId} = ${m.orgId} and ${a.id}::text = f.id #>> '{}'
          and (${a.deletedAt} is not null or ${a.kind} in ('block', 'poll', 'choices'))))`);
    }
    if (has === "card") {
      const a = schema.artifacts;
      parts.push(sql`(jsonb_exists_any(${m.meta}, ${sql`${`{${CARD_META_KEYS.join(",")}}`}::text[]`}) or exists (
        select 1 from ${a} where ${a.orgId} = ${m.orgId} and ${a.deletedAt} is null and ${a.kind} in ('poll', 'choices')
          and ${a.id}::text in (select jsonb_path_query(${m.meta}, '$.artifacts[*].id') #>> '{}')))`);
    }
    if (has === "image") {
      const a = schema.artifacts;
      const v = schema.artifactVersions;
      parts.push(sql`(jsonb_path_exists(${m.meta}, '$.media.kind') or exists (
        select 1 from ${a} join ${v} on ${v.artifactId} = ${a.id} and ${v.version} = ${a.currentVersion}
        where ${a.orgId} = ${m.orgId} and ${a.deletedAt} is null and ${v.contentType} like 'image/%'
          and ${a.id}::text in (select jsonb_path_query(${m.meta}, '$.artifacts[*].id') #>> '{}')))`);
    }
  }
  if (f.pinned) {
    const p = schema.messagePins;
    parts.push(sql`exists (select 1 from ${p} where ${p.channelId} = ${m.channelId} and ${p.messageId} = ${m.id})`);
  }
  return parts.length ? sql.join(parts, sql` and `) : null;
}

/** Reciprocal-rank fusion constant: dampens the weight of top ranks. */
const RRF_K = 60;

const vectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

/**
 * One HNSW index holds every workspace's vectors, and by default pgvector takes the 40 nearest before any filter: a
 * small workspace could get almost none of its own. An iterative scan (pgvector 0.8) reads on until enough rows pass.
 */
const ITERATIVE_SCAN = sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true),
  set_config('hnsw.ef_search', '100', true)`;

/**
 * Hybrid search on Postgres (`search_documents`): full-text with
 * `websearch_to_tsquery('simple', …)` and, when vectors exist, cosine
 * distance with pgvector; the two rankings are fused with reciprocal-rank
 * fusion, plus a small recency bonus. Every query is scoped to the org and
 * filtered by visibility in SQL (`channel_ids <@ visible`).
 */
export function createPostgresSearchResolver(db: Database): SearchIndexResolver {
  const t = schema.searchDocuments;
  // Older pgvector (0.7 and before) has no iterative scans: its vector queries run without them.
  let iterative: Promise<boolean> | undefined;
  const iterativeScans = () =>
    (iterative ??= db
      .execute(sql`select string_to_array(extversion, '.')::int[] >= array[0, 8] as iterative
        from pg_extension where extname = 'vector'`)
      .then(
        (r) => rowsOf<{ iterative: boolean }>(r)[0]?.iterative === true,
        () => {
          iterative = undefined;
          return false;
        },
      ));
  return {
    async forOrg(orgId) {
      return {
        backend: "postgres",
        async upsert(docs) {
          for (const d of docs) {
            if (d.orgId !== orgId) throw new Error("document belongs to another organization");
            const values = {
              orgId,
              kind: d.kind,
              sourceId: d.sourceId,
              channelIds: d.channelIds,
              // Keywords ride on the title's second line: indexed and ranked as the title, cut off every hit.
              title: d.keywords?.trim()
                ? `${(d.title ?? "").replace(/\n/g, " ")}\n${d.keywords.trim()}`
                : (d.title ?? ""),
              body: d.body,
              embedding: d.embedding ?? null,
              embeddingModel: d.embedding ? (d.embeddingModel ?? null) : null,
              sourceCreatedAt: d.createdAt,
              updatedAt: new Date(),
            };
            await db
              .insert(t)
              .values(values)
              .onConflictDoUpdate({ target: [t.kind, t.sourceId], set: values });
          }
        },
        async delete(refs) {
          for (const r of refs) {
            await db.delete(t).where(and(eq(t.orgId, orgId), eq(t.kind, r.kind), eq(t.sourceId, r.sourceId)));
          }
        },
        async query(q) {
          const limit = Math.min(q.limit ?? 20, 100);
          const text = q.text.trim();
          const filtered = Boolean(q.messages || q.after || q.before);
          if (!text && !q.embedding && !filtered) return [];
          const issues = q.visibleIssueScopes?.length
            ? [sql`(${t.kind} = 'issue' and ${t.channelIds} <@ ${uuids(q.visibleIssueScopes)})`]
            : [];
          const files = q.visibleFileScopes?.length
            ? [sql`(${t.kind} = 'file' and ${t.sourceId} = any(${uuids(q.visibleFileScopes)}))`]
            : [];
          const visible = sql`(${sql.join([sql`${t.channelIds} <@ ${uuids(q.visibleChannelIds)}`, ...issues, ...files], sql` or `)})`;
          const kinds = q.messages
            ? eq(t.kind, "message")
            : q.kinds && q.kinds.length > 0
              ? inArray(t.kind, q.kinds)
              : undefined;
          const m = schema.messages;
          const onMessage = q.messages ? messageConditions(q.messages) : null;
          const pins = schema.messagePins;
          const scope = and(
            eq(t.orgId, orgId),
            visible,
            kinds,
            q.after ? gte(t.sourceCreatedAt, q.after) : undefined,
            q.before ? lt(t.sourceCreatedAt, q.before) : undefined,
            // `messages` is partitioned on `created_at` (ADR 0009): bounding it prunes the probe to one partition.
            // The document's copy went through a JS Date, so it is the message's time cut to the millisecond.
            onMessage
              ? sql`exists (select 1 from ${m} where ${m.orgId} = ${t.orgId} and ${m.id} = ${t.sourceId}
                  and ${m.createdAt} >= ${t.sourceCreatedAt}
                  and ${m.createdAt} < ${t.sourceCreatedAt} + interval '1 millisecond' and ${onMessage})`
              : undefined,
            // Pins are few: the search starts from them instead of walking every message document.
            q.messages?.pinned
              ? sql`${t.sourceId} in (select ${pins.messageId} from ${pins}
                  where ${pins.channelId} = any(${uuids(q.visibleChannelIds)}) and ${pins.orgId} = ${orgId})`
              : undefined,
          );
          const anyWords = contentWords(text);
          const useAny = q.match === "any" && anyWords.length > 0;
          const tsQuery = useAny
            ? sql`to_tsquery('simple', ${anyWords.join(" | ")})`
            : sql`websearch_to_tsquery('simple', ${text})`;
          // Retrieval: matches per word of the document (a long one mentioning a word in passing doesn't outrank a
          // short one about it), doubled when the title has one. The title only multiplies: a common word in many
          // titles ("empresa") doesn't lift a page that barely mentions it.
          const density = sql`ts_rank_cd(${t.tsv}, ${tsQuery}, 2|32)`;
          // "Pasta/Título" would parse as one path token: the slash goes, so the title's first word counts.
          const inTitle = sql`(to_tsvector('simple', replace(${t.title}, '/', ' ')) @@ ${tsQuery})`;
          const anyRank = sql`(${density} * (1 + ${inTitle}::int))`;
          const relevant =
            useAny && q.minTextRank
              ? sql`(${density} >= ${q.minTextRank} and (${inTitle} or (${sql.join(
                  anyWords.map((w) => sql`(${t.tsv} @@ to_tsquery('simple', ${w}))::int`),
                  sql` + `,
                )}) >= 2))`
              : undefined;
          const toHit = (row: typeof t.$inferSelect, score: number): SearchHit => ({
            kind: row.kind as SearchKind,
            sourceId: row.sourceId,
            channelIds: row.channelIds,
            title: row.title.split("\n")[0] ?? "",
            snippet: row.body.slice(0, 300),
            score,
            createdAt: row.sourceCreatedAt,
          });
          // By date: the full-text matches (or everything the filters let through), no vectors.
          if ((!text && !q.embedding) || (q.sort && q.sort !== "relevance")) {
            if (text && q.match === "any" && !useAny) return [];
            const rows = await db
              .select()
              .from(t)
              .where(and(scope, text ? sql`${t.tsv} @@ ${tsQuery}` : undefined))
              .orderBy(q.sort === "oldest" ? asc(t.sourceCreatedAt) : desc(t.sourceCreatedAt))
              .limit(limit);
            return rows.map((row) => toHit(row, 0));
          }

          const ranks = new Map<string, { score: number; row: typeof t.$inferSelect }>();
          const add = (rows: (typeof t.$inferSelect)[]) => {
            rows.forEach((row, i) => {
              const hit = ranks.get(row.id) ?? { score: 0, row };
              hit.score += 1 / (RRF_K + i + 1);
              ranks.set(row.id, hit);
            });
          };
          // Full-text and vector rankings run in parallel (one round trip each, not in sequence).
          const textRows =
            text && (q.match !== "any" || useAny)
              ? db
                  .select()
                  .from(t)
                  .where(and(scope, sql`${t.tsv} @@ ${tsQuery}`, relevant))
                  .orderBy(desc(useAny ? anyRank : sql`ts_rank_cd(${t.tsv}, ${tsQuery})`), desc(t.sourceCreatedAt))
                  .limit(50)
              : Promise.resolve([]);
          const vectorRows = q.embedding
            ? (async () => {
                const vec = sql`${vectorLiteral(q.embedding ?? [])}::vector`;
                // pgvector's shape for a filtered search with a distance cut: the filters inside, the cut outside.
                // `+ 0`: Postgres 17+ would trust the relaxed scan's order and skip the sort.
                const nearest = sql`with nearest as materialized (
                    select ${t.id} as id, ${t.embedding} <=> ${vec} as distance from ${t}
                    where ${scope} and ${t.embedding} is not null
                      ${q.embeddingModel ? sql`and ${t.embeddingModel} = ${q.embeddingModel}` : sql``}
                    order by distance limit 50
                  ) select id from nearest where distance < ${q.maxDistance ?? 0.75} order by distance + 0`;
                const ids = rowsOf<{ id: string }>(
                  (await iterativeScans())
                    ? await db.transaction(async (tx) => {
                        await tx.execute(ITERATIVE_SCAN);
                        return tx.execute(nearest);
                      })
                    : await db.execute(nearest),
                ).map((r) => r.id);
                if (ids.length === 0) return [];
                const full = await db.select().from(t).where(inArray(t.id, ids));
                const byId = new Map(full.map((r) => [r.id, r]));
                return ids.flatMap((id) => (byId.get(id) ? [byId.get(id) as typeof t.$inferSelect] : []));
              })()
            : Promise.resolve([]);
          const [byText, byVector] = await Promise.all([textRows, vectorRows]);
          add(byText);
          const passed = new Set(byText.map((r) => r.id));
          add(q.minTextRank ? byVector.filter((r) => passed.has(r.id)) : byVector);
          const now = Date.now();
          return [...ranks.values()]
            .map(({ score, row }) => {
              // Up to +10% for recent items (half-life ~30 days).
              const ageDays = (now - row.sourceCreatedAt.getTime()) / 86_400_000;
              return { score: score * (1 + 0.1 * 0.5 ** (ageDays / 30)), row };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ score, row }) => toHit(row, score));
        },
      };
    },
  };
}

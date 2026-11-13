import { and, desc, type Executor, eq, inArray, isNull, schema } from "@agenteschat/db";
import { cutText } from "../format";
import type { Judge, JudgeQuestion } from "../judge";
import { type ContextItem, type ContextKind, evidenceWeight, type NewContextItem, normalizeSubject } from "./items";

const { contextItems } = schema;

/**
 * Semantic consolidation (docs/adr/0028-memory-judgments-with-jev.md §1):
 * code finds the candidates, the judge says how a new item relates to each,
 * and the policy here decides. The judge never sees permissions and its
 * answer only picks between moves the code already allows; low confidence
 * never merges or archives anything.
 */

/** How a new item relates to an existing one. */
export const RELATIONS = {
  same: "Says the same thing as the existing item, maybe in other words or another language.",
  refines: "The same claim, made more precise or more complete; nothing in the existing item becomes false.",
  updates:
    "The world changed: the new item replaces the existing one (a new value, a new decision, a reversed preference).",
  contradicts: "Both can't be true at the same time, and nothing says the existing item is outdated.",
  related: "The same topic, but a different claim; both stay true.",
  unrelated: "A different topic.",
} as const;

export type Relation = keyof typeof RELATIONS;

/**
 * Minimum probability for each move; below it the items are only linked (`related_ids`).
 * From `bun run eval:memory` (2026-10-16, Jev, 46 cases): no false "contradicts" at any
 * probability, while true ones came in at 0.56–0.68, so conflicts start at 0.55; a wrong
 * "refines" at 0.59 keeps `change` at 0.7; `merge` stays strict (a miss only links).
 */
export const THRESHOLDS = { merge: 0.75, change: 0.7, conflict: 0.55, related: 0.5 };

/** Candidates the judge compares against (one Choice each, in one request). */
export const MAX_CANDIDATES = 8;
/** Recent items of the same scope scanned for candidates (indexing lags behind writes, so no search index). */
const SCAN_LIMIT = 200;

/** Kinds that describe the world consolidate together; an agent's notes and lessons only with their own kind. */
const WORLD_KINDS: ContextKind[] = ["decision", "fact", "preference", "open_question"];
export const kindFamily = (kind: ContextKind): ContextKind[] => (WORLD_KINDS.includes(kind) ? WORLD_KINDS : [kind]);

/** Words of 3+ letters (accents and case aside). No word lists: nothing here depends on the language. */
const terms = (text: string) =>
  new Set(
    normalizeSubject(text)
      .split(" ")
      .filter((w) => w.length >= 3),
  );

/** Shared words over the smaller set: paraphrases keep their nouns ("Railway", "deploy") even when the rest differs. */
export function overlap(a: string, b: string) {
  return shared(terms(a), terms(b));
}

/** Words found in more than half of `texts` (only with enough texts to tell). */
function commonTerms(texts: string[]) {
  const common = new Set<string>();
  if (texts.length < 6) return common;
  const counts = new Map<string, number>();
  for (const t of texts) for (const w of terms(t)) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const [w, n] of counts) if (n > texts.length / 2) common.add(w);
  return common;
}

const shared = (ta: Set<string>, tb: Set<string>) => {
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
};

const sameChannels = (a: string[], b: string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((c) => sb.has(c));
};

const textOf = (i: { title?: string | null; content: string }) => `${i.title ?? ""} ${i.content}`;

/**
 * Active items the new one could duplicate, refine, update or contradict:
 * same org, kind family, owner agent and scope type, ranked by shared words,
 * plus an exact subject match (today's rule). Read straight from the table,
 * so items written moments ago (one reflection writes several) see each other.
 */
export async function findCandidates(db: Executor, input: NewContextItem, limit = MAX_CANDIDATES) {
  const subjectKey = normalizeSubject(input.subject ?? input.title ?? input.content.slice(0, 120));
  const rows = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, input.orgId),
        inArray(contextItems.kind, kindFamily(input.kind)),
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        input.agentId ? eq(contextItems.agentId, input.agentId) : isNull(contextItems.agentId),
        eq(contextItems.scopeType, input.scopeType),
        // A rule holds by its giver (`rulesForPerson`): the same words from someone else are their own rule.
        input.kind === "rule" ? eq(contextItems.createdById, input.createdById ?? "") : undefined,
      ),
    )
    .orderBy(desc(contextItems.updatedAt))
    .limit(SCAN_LIMIT);
  const text = textOf(input);
  // Words in most of the scope's items ("the", "que", the team's name) say nothing about the topic.
  const common = commonTerms(rows.map(textOf));
  const own = (t: string) => new Set([...terms(t)].filter((w) => !common.has(w)));
  const mine = own(text);
  return rows
    .map((row) => ({ row, score: row.subjectKey === subjectKey ? 2 : shared(mine, own(textOf(row))) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.row);
}

export interface Judged {
  candidate: ContextItem;
  relation: Relation;
  /** Probability of that relation (the LLM fallback answers 1). */
  p: number;
}

/** One request: a Choice per candidate ("how does the new item relate to this one?"). */
export async function judgeRelations(
  judge: Judge,
  input: NewContextItem,
  candidates: ContextItem[],
): Promise<Judged[]> {
  if (candidates.length === 0) return [];
  const questions: Record<string, JudgeQuestion> = {};
  candidates.forEach((_, i) => {
    questions[`rel_${i}`] = {
      type: "choice",
      instructions: `A team's shared memory is about to store \`new_item\`. How does it relate to \`existing_items[${i}]\`? Judge only what the texts say; \`new_item\` is the most recent.`,
      criteria: RELATIONS,
    };
  });
  const answers = await judge.ask({
    orgId: input.orgId,
    kind: "memory_relation",
    calibrated: true,
    state: {
      new_item: { kind: input.kind, title: input.title || null, content: cutText(input.content, 2000) },
      existing_items: candidates.map((c) => ({
        kind: c.kind,
        title: c.title || null,
        content: cutText(c.content, 2000),
        recorded_at: c.updatedAt.toISOString().slice(0, 10),
      })),
    },
    questions,
  });
  return candidates.map((candidate, i) => {
    const a = answers[`rel_${i}`];
    const relation = (a?.choice && a.choice in RELATIONS ? a.choice : "unrelated") as Relation;
    return { candidate, relation, p: a?.probabilities?.[relation] ?? 0 };
  });
}

export type Plan =
  | { action: "create"; related: string[] }
  | { action: "merge"; target: ContextItem }
  | { action: "supersede"; target: ContextItem; relation: "refines" | "updates" }
  /**
   * A contradiction resolves itself: the stronger evidence wins (a person's word over an agent's
   * claim), and on a tie the newer one (the latest word is how things are now). The loser stays as
   * history, linked, and a person can bring it back.
   */
  | { action: "resolve"; target: ContextItem; winner: "new" | "old" };

const best = (list: Judged[], relations: Relation[], min: number) =>
  list
    .filter((j) => relations.includes(j.relation) && j.p >= min)
    .sort((a, b) => b.p - a.p || b.candidate.updatedAt.getTime() - a.candidate.updatedAt.getTime())[0];

/**
 * The policy. A move that changes an item (merge, supersede, conflict) needs
 * the same visibility on both sides: merging or archiving across channels
 * would show the item to people who can't see its source, or hide it from
 * people who can. Across channels, items are only linked.
 */
export function decide(input: NewContextItem, judged: Judged[]): Plan {
  const channels = input.channelIds ?? [];
  const movable = judged.filter((j) => sameChannels(j.candidate.channelIds, channels));
  const same = best(movable, ["same"], THRESHOLDS.merge);
  if (same) return { action: "merge", target: same.candidate };
  const change = best(movable, ["refines", "updates"], THRESHOLDS.change);
  if (change)
    return { action: "supersede", target: change.candidate, relation: change.relation as "refines" | "updates" };
  const conflict = best(movable, ["contradicts"], THRESHOLDS.conflict);
  if (conflict) {
    const old = conflict.candidate;
    const strength = (evidence: ContextItem["evidence"], trust: string | undefined) =>
      evidenceWeight(evidence) - (trust === "low" ? 10 : 0);
    const fresh = strength(input.evidence ?? [], input.trust);
    return { action: "resolve", target: old, winner: fresh >= strength(old.evidence, old.trust) ? "new" : "old" };
  }
  const related = judged
    .filter((j) => j.relation !== "unrelated" && j.p >= THRESHOLDS.related)
    .map((j) => j.candidate.id);
  return { action: "create", related };
}

/**
 * Candidates, judgment and plan; null when the judge fails or is sure of
 * nothing about any candidate (no answer, all below `THRESHOLDS.related`):
 * then the caller falls back to words, so a repeat still merges.
 */
export async function planConsolidation(db: Executor, judge: Judge, input: NewContextItem): Promise<Plan | null> {
  const candidates = await findCandidates(db, input);
  if (candidates.length === 0) return { action: "create", related: [] };
  try {
    const judged = await judgeRelations(judge, input, candidates);
    if (!judged.some((j) => j.p >= THRESHOLDS.related)) return null;
    return decide(input, judged);
  } catch {
    return null;
  }
}

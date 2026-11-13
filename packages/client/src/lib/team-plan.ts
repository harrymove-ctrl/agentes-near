import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type { Message, ReplyChips, TeamPlan, TeamProposalCard } from "../api/types";
import { errorText } from "./errors";

/**
 * The right hand's team setup (ADR 0137 §10), platform-neutral: the business types, the answers tapped
 * under its questions (each one the person's own message), and what the team card counts and lists.
 */

/** What the business does, the first run's row 1 (ADR 0155 §6): `other` asks for a sentence. */
export const BUSINESS_TYPES = ["agency", "store", "clinic", "software", "support", "services", "other"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];
/** Every business type but `other` is a team template's id too (the server's `BUSINESS_TEMPLATES`). */
export const isTemplateBusiness = (b: BusinessType): b is Exclude<BusinessType, "other"> => b !== "other";

/** The template the onboarding's team step shows: the one picked, else the business's, else the first. */
export const templateFor = <T extends { id: string }>(
  templates: readonly T[],
  picked: string | null,
  business: BusinessType | null,
): T | undefined => {
  const wanted = picked ?? (business && isTemplateBusiness(business) ? business : null);
  return templates.find((x) => x.id === wanted) ?? templates[0];
};

/**
 * A personal workspace's row 1 (ADR 0159): the areas of life the person wants help with, several at once, labelled
 * `teamPlan.lifeArea.{id}`; `other` asks for a sentence.
 */
export const LIFE_AREAS = [
  "routine",
  "money",
  "health",
  "studies",
  "home",
  "travel",
  "work",
  "writing",
  "other",
] as const;
export type LifeArea = (typeof LIFE_AREAS)[number];

/** The personal template (the server's `PERSONAL_TEMPLATES`) that fits each area; none for `other`. */
export const LIFE_AREA_TEMPLATE: Record<LifeArea, string | null> = {
  routine: "life",
  money: "life",
  health: "health",
  studies: "studies",
  home: "home",
  travel: "travel",
  work: "freelance",
  writing: "studies",
  other: null,
};

/** The template the gallery opens on after row 1: the first picked area's, in the list's order; null for none. */
export const lifeAreaTemplate = (areas: Iterable<LifeArea>): string | null => {
  const picked = new Set(areas);
  for (const a of LIFE_AREAS) if (picked.has(a) && LIFE_AREA_TEMPLATE[a]) return LIFE_AREA_TEMPLATE[a];
  return null;
};

/**
 * What row 1 saves as a personal workspace's context, in the person's language: the areas picked as one sentence,
 * then theirs. Empty when there is neither (only `other` with no sentence).
 */
export function aboutYouContext(tr: TFunction, areas: Iterable<LifeArea>, line: string): string {
  // Keys built from the area's id, so read through an untyped `t`.
  const t = tr as unknown as (key: string, o?: Record<string, unknown>) => string;
  const picked = new Set(areas);
  const named = LIFE_AREAS.filter((a) => a !== "other" && picked.has(a)).map((a) => t(`teamPlan.lifeArea.${a}`));
  const lead = named.length > 0 ? t("teamPlan.lifeAreaContext", { areas: named.join(", ") }) : "";
  return [lead, line.trim()].filter(Boolean).join(" ");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Row 1 opened again: the areas and the sentence a saved context was made of (`aboutYouContext`), so saving it again
 * doesn't repeat them. Any other text is the sentence as a whole, with no area picked.
 */
export function readAboutYou(tr: TFunction, context: string): { areas: LifeArea[]; line: string } {
  const t = tr as unknown as (key: string, o?: Record<string, unknown>) => string;
  const whole = { areas: [] as LifeArea[], line: context };
  const [before = "", after = ""] = t("teamPlan.lifeAreaContext", { areas: "\u0000" }).split("\u0000");
  if (!after) return whole;
  const found = new RegExp(`^${escapeRe(before)}(.+?)${escapeRe(after)}`).exec(context);
  if (!found?.[1]) return whole;
  const listed = found[1].split(", ");
  const areas = LIFE_AREAS.filter((a) => a !== "other" && listed.includes(t(`teamPlan.lifeArea.${a}`)));
  if (areas.length !== listed.length) return whole;
  return { areas, line: context.slice(found[0].length).trim() };
}

/** Several answers tapped together go as one message, in this order. */
export const ANSWER_JOINER = " · ";

/**
 * The context the onboarding's step 2 saves (ADR 0162): the business type's words, then the sentence, joined as tapped
 * answers are ("Loja online · Vendemos cerâmica"), so a later visit on any device reads both back (`aboutOf`).
 */
export const aboutContext = (t: TFunction, business: BusinessType | null, line: string) =>
  [business && isTemplateBusiness(business) ? t(`teamPlan.business.${business}`) : "", line.trim()]
    .filter(Boolean)
    .join(ANSWER_JOINER);

/** Step 2's answers in a workspace's context (`aboutContext`): the business type its words start with, the sentence. */
export function aboutOf(t: TFunction, context: string): { business: BusinessType | null; line: string } {
  const text = context.trim();
  for (const b of BUSINESS_TYPES) {
    if (!isTemplateBusiness(b)) continue;
    const words = t(`teamPlan.business.${b}`);
    if (text === words) return { business: b, line: "" };
    if (text.startsWith(`${words}${ANSWER_JOINER}`))
      return { business: b, line: text.slice(words.length + ANSWER_JOINER.length).trim() };
  }
  return { business: null, line: text };
}

export function replyChipsOf(meta: Record<string, unknown> | null | undefined): ReplyChips | null {
  const raw = meta?.replyChips as Partial<ReplyChips> | undefined;
  if (!raw || !Array.isArray(raw.choices)) return null;
  const of = typeof raw.of === "number" && raw.of > 0 ? raw.of : 1;
  return {
    choices: raw.choices.filter((c): c is string => typeof c === "string" && c.length > 0),
    multiple: raw.multiple === true,
    step: typeof raw.step === "number" ? Math.min(of, Math.max(1, raw.step)) : 1,
    of,
  };
}

const byTime = (a: Pick<Message, "createdAt">, b: Pick<Message, "createdAt">) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt);

/**
 * The person's answer to a question: their first message after it (`afterId`; none: the conversation's first, which
 * the first run's "O que a Acme faz?" starts from). Null while nobody answered.
 */
export function answerAfter(
  messages: readonly Pick<Message, "id" | "createdAt" | "author" | "body" | "local">[] | undefined,
  afterId: string | null,
): string | null {
  if (!messages) return null;
  const sorted = [...messages].sort(byTime);
  const from = afterId === null ? 0 : sorted.findIndex((m) => m.id === afterId) + 1;
  if (afterId !== null && from === 0) return null;
  return sorted.slice(from).find((m) => m.author.type === "person" && m.local !== "failed")?.body ?? null;
}

/** The answers of `choices` an answer holds: what the card shows checked once it was answered. */
export const answerPicks = (choices: readonly string[], answer: string | null) => {
  if (answer === null) return [];
  const parts = new Set(answer.split(ANSWER_JOINER).map((p) => p.trim()));
  return choices.filter((c) => parts.has(c));
};

/** Taps put together in the order the answers are listed. */
export const answerText = (choices: readonly string[], picked: ReadonlySet<string>) =>
  choices.filter((c) => picked.has(c)).join(ANSWER_JOINER);

/** "3 agentes · 2 canais novos · 3 rotinas": what the card's footer counts. */
export const teamCounts = (plan: TeamPlan) => ({
  agents: plan.agents.length,
  newChannels: plan.newChannels.length,
  routines: plan.agents.reduce((n, a) => n + a.routines.length, 0) + (plan.weekly ? 1 : 0),
});

/** Every routine on the card, each with its agent and channel; the right hand's weekly check last (`agent` null). */
export const teamRoutines = (plan: TeamPlan) => [
  ...plan.agents.flatMap((a) => a.routines.map((routine) => ({ agent: a, routine }))),
  ...(plan.weekly ? [{ agent: null, routine: plan.weekly }] : []),
];

/** Where a team card stands for its viewer. `open` includes a failed try (its `error`). */
export function teamStatus(card: TeamProposalCard, now = Date.now()) {
  if (card.state === "pending" || card.state === "creating") {
    return Date.parse(card.expiresAt) <= now ? ("expired" as const) : ("open" as const);
  }
  return card.state;
}

/** Desfazer on the receipt: whoever created it, or an admin, within a day. */
export const TEAM_UNDO_MS = 24 * 3600_000;
export const teamUndoable = (card: TeamProposalCard, viewer: { userId: string; admin: boolean }, now = Date.now()) =>
  card.state === "created" &&
  !!card.decidedAt &&
  Date.parse(card.decidedAt) + TEAM_UNDO_MS > now &&
  (viewer.admin || card.decidedByUserId === viewer.userId);

/** The agents the receipt offers a first task for, once created: each with its new id. */
export const firstTasks = (card: TeamProposalCard) =>
  card.params.agents.flatMap((a, i) => {
    const agentId = card.created?.agentIds[i];
    return agentId && a.firstTask ? [{ agentId, name: a.name, appearance: a.appearance, task: a.firstTask }] : [];
  });

/**
 * The team as a map ("See as a map"): one column per channel, its agents and their routines. An agent with no channel
 * lives in its DM with the person (a personal template, ADR 0159): a column of its own, `channel` empty.
 */
export function teamColumns(plan: TeamPlan) {
  const columns = new Map<string, { key: string; channel: string; fresh: boolean; agents: TeamPlan["agents"] }>();
  for (const a of plan.agents) {
    const key = a.channel ? `#${a.channel}` : `@${a.handle}`;
    const col = columns.get(key) ?? {
      key,
      channel: a.channel,
      fresh: a.channel !== "" && plan.newChannels.includes(a.channel),
      agents: [],
    };
    col.agents.push(a);
    columns.set(key, col);
  }
  return [...columns.values()];
}

/** Whether every agent on the card lives in its DM with the person, so the card names no channel (ADR 0159). */
export const teamInDms = (plan: TeamPlan) => plan.agents.length > 0 && plan.agents.every((a) => !a.channel);

/** "O time não foi criado: … deu erro (…)": the failed step, with its reason in the reader's language when known. */
export function teamFailureText(t: TFunction, error: NonNullable<TeamProposalCard["error"]>, locale?: string) {
  const reason = errorText(t, new ApiError(error.status ?? 500, error.code ?? "", error.reason, error.params), locale);
  return t("teamPlan.card.failed", { step: error.step, reason });
}

import type { TFunction } from "i18next";
import { formatInt, shortModel } from "./format";

/**
 * Small pure helpers of the chat timeline: the machine numbers behind a
 * reply (shown on hover only), which rows slide in, when to follow the
 * bottom, and first-message suggestions for an empty conversation.
 */

/** `usage` of an agent message in lists (packages/engine/src/messages.ts `MessageUsage`): no money. */
export interface MessageUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function messageUsage(m: object): MessageUsage | null {
  const u = (m as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  if (typeof o.model !== "string") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    model: o.model,
    inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens),
  };
}

/** "sonnet 5.5 · 1.240 tokens" (money only in the admins' usage report). */
export function usageLine(t: TFunction, locale: string, usage: MessageUsage, options: { modelLabel?: string } = {}) {
  return [
    shortModel(options.modelLabel ?? usage.model),
    t("chat.tokens", { value: formatInt(locale, usage.inputTokens + usage.outputTokens) }),
  ].join(" · ");
}

/** Rows newer than this (relative to when the channel opened) may slide in. */
export const ENTER_WINDOW_MS = 60_000;

/**
 * Whether a row slides in: it wasn't in the first load, and it is recent
 * (old thread replies that load a moment later just appear).
 */
export function entersWithMotion(key: string, createdAt: string, initialKeys: ReadonlySet<string>, mountedAt: number) {
  if (initialKeys.has(key)) return false;
  return new Date(createdAt).getTime() >= mountedAt - ENTER_WINDOW_MS;
}

/**
 * Where a row sits in a run of one author's rows that read as one turn (grouped under the first): its bubble squares
 * the corners it shares with its neighbours, and the turn's time goes under its last row.
 */
export type RunPosition = "solo" | "start" | "mid" | "end";
export const runPosition = (grouped: boolean, nextGrouped: boolean): RunPosition =>
  grouped ? (nextGrouped ? "mid" : "end") : nextGrouped ? "start" : "solo";
/** A run cut where something hangs under a bubble (reactions, files, a thread, a status): no corner points at it. */
export const runAround = (run: RunPosition, aboveHangs: boolean, hangs: boolean): RunPosition =>
  runPosition((run === "mid" || run === "end") && !aboveHangs, (run === "start" || run === "mid") && !hangs);

/** Close enough to the bottom to keep following new messages. */
export const NEAR_BOTTOM_PX = 120;
export const nearBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) =>
  el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
/** More than one screen of conversation below what is shown: the round "to the latest" button appears. */
export const screenAboveEnd = (distanceFromEnd: number, viewport: number) => distanceFromEnd > viewport;

/** A key that scrolls a focused list up (Shift+Space is the browser's page up). */
export const isScrollUpKey = (e: { key: string; shiftKey: boolean }) =>
  e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home" || (e.key === " " && e.shiftKey);

export type SuggestionTopic = "dev" | "support" | "marketing" | "data" | "product" | "general";

const TOPICS: [SuggestionTopic, RegExp][] = [
  [
    "dev",
    /\b(dev|desenvolv|engenh|engineer|c[oó]digo|code|software|backend|frontend|front-end|back-end|sre|devops|infra|qa)/i,
  ],
  ["support", /\b(suporte|support|atendimento|cliente|customer|sucesso|success|help ?desk)/i],
  ["marketing", /\b(marketing|growth|conte[uú]do|content|seo|ads|an[uú]ncio|social|copy|campanha|campaign)/i],
  ["data", /\b(dados|data|analytics|anal[ií]tic|analista|analyst|bi\b|m[eé]trica|metric|relat[oó]rio|report)/i],
  ["product", /\b(produto|product|pm\b|design|ux|ui\b|roadmap)/i],
];

/** What an agent with this role is likely asked first. */
export function suggestionTopic(role: string | null | undefined): SuggestionTopic {
  const text = (role ?? "").normalize("NFC");
  for (const [topic, re] of TOPICS) if (re.test(text)) return topic;
  return "general";
}

type SuggestionKey = `chat.suggest.${SuggestionTopic}${1 | 2 | 3}`;

const SUGGESTIONS: Record<SuggestionTopic, readonly SuggestionKey[]> = {
  dev: ["chat.suggest.dev1", "chat.suggest.dev2", "chat.suggest.dev3"],
  support: ["chat.suggest.support1", "chat.suggest.support2", "chat.suggest.support3"],
  marketing: ["chat.suggest.marketing1", "chat.suggest.marketing2", "chat.suggest.marketing3"],
  data: ["chat.suggest.data1", "chat.suggest.data2", "chat.suggest.data3"],
  product: ["chat.suggest.product1", "chat.suggest.product2", "chat.suggest.product3"],
  general: ["chat.suggest.general1", "chat.suggest.general2", "chat.suggest.general3"],
};

/** Three first messages for an agent with this role, in the interface language. */
export function greetingSuggestions(t: TFunction, role: string | null | undefined): string[] {
  return SUGGESTIONS[suggestionTopic(role)].map((key) => t(key));
}

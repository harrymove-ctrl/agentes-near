import type { TFunction } from "i18next";
import type { CustomServer, CustomTool, ToolAccess, ToolDecision } from "../api/types";
import { humanize } from "./custom-tools";
import { catalogLabel, toolKey } from "./tool-labels";

/**
 * The connector tool review: every tool
 * comes classified (the server's hints, the verb in its name, the judge for
 * names that don't say), grouped by subject. People see readable names in
 * their language; the technical name only on hover or when a search matches it.
 * Levels in plain words: Só consulta · Muda coisas · Pede sua aprovação · Desligada.
 */
/** A tool's level, as `@agenteschat/ui`'s `ToolPixels` draws it (same union as its `ToolLevelKind`). */
export type ToolLevelKind = "read" | "write" | "approval" | "off";

export const REVIEW_LEVELS: ToolLevelKind[] = ["read", "write", "approval", "off"];
/** Sensitive tools (delete, send, pay…) may only ask or be off. */
export const SENSITIVE_LEVELS: ToolLevelKind[] = ["approval", "off"];

export interface ReviewTool {
  /** The technical name. */
  name: string;
  /** Readable, in the person's language. */
  label: string;
  description: string;
  subject: string;
  level: ToolDecision;
  /** Our suggestion (what "OK" and "Aceitar as sugestões" keep). */
  suggested: ToolAccess;
  /** Why (pending tools): `toolReview.reason.*`. */
  reason: string | null;
  sensitive: boolean;
  /** Waits in "Precisam da sua decisão". */
  pending: boolean;
  /** The label people had (approval cards); saved back as is. */
  savedLabel: string;
  /** The levels this tool can take, when fewer than the usual (email: reads only Consulta · Desligada). */
  levels?: ToolDecision[];
}

type TT = (key: string, options: { defaultValue: string }) => string;
const tt = (t: TFunction) => t as unknown as TT;

const VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "describe",
  "query",
  "check",
  "estimate",
  "fetch",
  "find",
  "view",
  "show",
  "count",
  "preview",
  "download",
  "lookup",
  "create",
  "update",
  "add",
  "set",
  "upload",
  "bind",
  "copy",
  "edit",
  "patch",
  "insert",
  "rename",
  "assign",
  "apply",
  "duplicate",
  "delete",
  "remove",
  "send",
  "pay",
  "publish",
  "transfer",
  "refund",
  "unbind",
  "share",
  "merge",
  "deploy",
  "rollback",
  "destroy",
  "drop",
  "purge",
  "track",
  "sync",
  "refresh",
  "run",
  "export",
  "import",
  "enable",
  "disable",
  "pause",
  "resume",
  "cancel",
  "close",
  "open",
  "start",
  "stop",
  "archive",
  "restore",
  "revoke",
  "invite",
  "approve",
  "reject",
  "move",
  "execute",
  "write",
  "post",
  "reply",
  "trigger",
]);

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const singular = (w: string) =>
  w.endsWith("ies") && w.length > 4
    ? `${w.slice(0, -3)}y`
    : /(ss|us|is|data|info|news|status|analytics)$/.test(w)
      ? w
      : w.endsWith("s") && w.length > 3
        ? w.slice(0, -1)
        : w;

/**
 * The name's parts when the server didn't send them (older servers, catalog tools); mirrors the backend. `verbFirst`:
 * a name that always leads with its verb (Composio's slugs), so `publish_post` publishes a post, not posts a publish.
 */
export function partsOf(name: string, prefix: string | null = null, verbFirst = false) {
  let w = words(name);
  if (prefix && w[0] === prefix && w.length > 1) w = w.slice(1);
  const last = w.length - 1;
  const v =
    verbFirst && VERBS.has(w[0] ?? "")
      ? 0
      : VERBS.has(w[last] ?? "")
        ? last
        : VERBS.has(w[0] ?? "")
          ? 0
          : w.findIndex((x) => VERBS.has(x));
  const verb = v >= 0 ? (w[v] ?? null) : null;
  const rest = v >= 0 ? w.filter((_, i) => i !== v) : w;
  return { verb, words: rest, subject: rest[0] ? singular(rest[0]) : "other" };
}

/** Verbs whose object reads in the plural ("Listar campanhas"). */
const MANY = new Set(["list", "search", "add", "assign", "export", "sync"]);

/** A word of a tool name in the person's language: [singular, plural, "of" form] (en: the "of" form is the word). */
function noun(t: TFunction, word: string): [string, string, string] | null {
  const raw =
    tt(t)(`toolNames.noun.${word}`, { defaultValue: "" }) ||
    tt(t)(`toolNames.noun.${singular(word)}`, {
      defaultValue: "",
    });
  if (!raw) return null;
  const [s = word, p = s, of = s] = raw.split("|");
  return [s, p, of];
}

/**
 * A readable name: the catalog's words for the tools agents use most (`tool-labels.ts`), else the verb in the
 * person's language, then the words. When every word is known, they're ordered as the language wants
 * ("Ver orçamento da campanha" / "Get campaign budget"); otherwise the words stay as the server wrote them. A name
 * with no verb reads as words, without the app it starts with: the app shows beside it.
 */
export function toolName(t: TFunction, parts: { verb: string | null; words: string[] }, name: string) {
  const worded = catalogLabel(t, name);
  if (worded) return worded;
  const ws = parts.words;
  if (!parts.verb) return humanize(toolKey(name).key || name);
  const verb = tt(t)(`toolNames.verb.${parts.verb}`, { defaultValue: humanize(parts.verb) });
  if (ws.length === 0) return verb;
  const many = MANY.has(parts.verb);
  const known = ws.map((w) => noun(t, w));
  const head = known[known.length - 1];
  if (known.every(Boolean) && head) {
    const order = t("toolNames.order");
    const headWord = many ? head[1] : head[0];
    const mods = known.slice(0, -1) as [string, string, string][];
    // pt-BR: the head first, then "do anúncio"…; en: modifiers before the head; ja, ko: those, then the verb.
    const phrase =
      order === "head-first"
        ? [headWord, ...mods.reverse().map((m) => m[2])].join(" ")
        : [...mods.map((m) => m[2]), headWord].join(" ");
    return order === "verb-last" ? `${phrase} ${verb}` : `${verb} ${phrase}`;
  }
  return `${verb} ${ws.join(" ")}`;
}

/** A subject's name: the word's plural in the person's language ("Campanhas"), else the word. */
export function subjectLabel(t: TFunction, subject: string) {
  if (subject === "other") return t("toolReview.otherSubject");
  const n = noun(t, subject);
  const text = n ? n[1] : humanize(subject);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const isAccess = (v: unknown): v is ToolAccess => v === "read" || v === "write" || v === "approval";

/** A custom server's tools, ready for the review. */
export function reviewToolsOf(t: TFunction, server: CustomServer): ReviewTool[] {
  return server.tools.map((tool) => reviewTool(t, tool));
}

export function reviewTool(t: TFunction, tool: CustomTool): ReviewTool {
  const parts = tool.nameParts ?? partsOf(tool.name);
  const suggested: ToolAccess = isAccess(tool.suggestedAccess)
    ? tool.suggestedAccess
    : tool.readOnlyHint === true
      ? "read"
      : "approval";
  const sensitive = tool.sensitive === true;
  let level: ToolDecision = tool.level ?? tool.access ?? suggested;
  if (sensitive && (level === "read" || level === "write")) level = "approval";
  return {
    name: tool.name,
    label: toolName(t, parts, tool.name),
    description: tool.description,
    subject: tool.subject ?? partsOf(tool.name).subject,
    level,
    suggested,
    reason: tool.suggestionReason ?? null,
    sensitive,
    pending: tool.pending === true,
    savedLabel: tool.label || humanize(tool.name),
  };
}

export type LevelCounts = Record<ToolLevelKind, number>;
export function countLevels(tools: { level: ToolDecision }[]): LevelCounts {
  const c: LevelCounts = { read: 0, write: 0, approval: 0, off: 0 };
  for (const x of tools) c[x.level]++;
  return c;
}

/** "12 consultam · 3 mudam · 1 pede aprovação · 2 desligadas". */
export function levelSummary(t: TFunction, c: LevelCounts) {
  return REVIEW_LEVELS.filter((l) => c[l] > 0)
    .map((l) => t(`toolReview.many.${l}`, { count: c[l] }))
    .join(" · ");
}

/** Tools by subject, subjects by name. */
export function bySubject<T extends { subject: string }>(t: TFunction, tools: T[]) {
  const map = new Map<string, T[]>();
  for (const x of tools) map.set(x.subject, [...(map.get(x.subject) ?? []), x]);
  return [...map.entries()]
    .map(([subject, list]) => ({ subject, label: subjectLabel(t, subject), tools: list }))
    .sort((a, b) => (a.subject === "other" ? 1 : b.subject === "other" ? -1 : a.label.localeCompare(b.label)));
}

export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Search: the readable name, else the technical name (then shown under it). */
export function matchTool(tool: { label: string; name: string }, query: string): { ok: boolean; tech: boolean } {
  const q = norm(query.trim());
  if (!q) return { ok: true, tech: false };
  if (norm(tool.label).includes(q)) return { ok: true, tech: false };
  if (tool.name.toLowerCase().includes(q.replace(/\s+/g, "_"))) return { ok: true, tech: true };
  return { ok: false, tech: false };
}

/** The `PUT …/tools` body: each tool's level; pending ones the person didn't decide stay pending. */
export function reviewDecisions(tools: ReviewTool[], levels: Record<string, ToolDecision>, decided: Set<string>) {
  return tools.map((x) => ({
    name: x.name,
    access: levels[x.name] ?? x.level,
    label: x.savedLabel,
    confirmed: !x.pending || decided.has(x.name),
  }));
}

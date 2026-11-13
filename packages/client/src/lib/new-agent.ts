import type { TFunction } from "i18next";
import type { AgentAudience } from "../api/types";
import type { Level } from "./access-levels";
import { handleFrom, parseAmount } from "./text";

/**
 * "Criar agente" in steps: the pure part
 * (steps, roles and what each one starts with, handle and budget rules, what each step needs). Each
 * platform adds its own icons.
 */

export const NEW_AGENT_STEPS = ["role", "identity", "instructions", "tools", "where", "model", "review"] as const;
export type NewAgentStep = (typeof NEW_AGENT_STEPS)[number];

/**
 * A personal workspace's walk through Criar agente (ADR 0159 §3): the technical steps start filled in (every app it
 * can use, only its owner, Automático) and are passed over; Revisar still opens each one.
 */
export const PERSONAL_SKIPPED_STEPS: readonly NewAgentStep[] = ["tools", "where", "model"];

/** The step after (`dir` 1) or before (-1) `index`, past the skipped ones; never past the first or the last. */
export function stepAfter(index: number, dir: 1 | -1, skipped: readonly NewAgentStep[]): number {
  const last = NEW_AGENT_STEPS.length - 1;
  let i = index + dir;
  while (i > 0 && i < last && skipped.includes(NEW_AGENT_STEPS[i] ?? "review")) i += dir;
  return Math.max(0, Math.min(last, i));
}

export const ROLE_IDS = [
  "dev",
  "ops",
  "qa",
  "pm",
  "support",
  "sales",
  "marketing",
  "content",
  "data",
  "finance",
  "people",
  "research",
  "assistant",
  "custom",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** The role step in groups, in order (titles in i18n: `newAgent.roleGroups.{id}`); "custom" stays apart, last. */
export const ROLE_GROUPS = [
  { id: "tech", roles: ["dev", "ops", "qa", "pm"] },
  { id: "customers", roles: ["support", "sales", "marketing", "content"] },
  { id: "operations", roles: ["data", "finance", "people", "research", "assistant"] },
] as const satisfies readonly { id: string; roles: readonly Exclude<RoleId, "custom">[] }[];
export type RoleGroupId = (typeof ROLE_GROUPS)[number]["id"];

/* ---------- What a role starts with ---------- */

/** A look as the agent engine draws it (names from `@agenteschat/ui`'s `AgentAppearance`). */
export interface RoleLook {
  color: string;
  eyes: string;
  accessory: string;
}

export interface RoleDefaults<L extends RoleLook = RoleLook> {
  look: L;
  /** Levels by catalog connector id ("github"); connectors not listed start at "Sem acesso". */
  levels: Record<string, Level>;
  /** Channels it joins when the workspace has them (by name; only channels you're in). */
  channels: string[];
}

// Keeps each look's literal names, so they type as the engine's colors, eyes and accessories.
const starts = <const L extends RoleLook>(d: RoleDefaults<L>) => d;

/** Picking a role fills the rest (name and instructions come from i18n: `newAgent.roles.{id}`). */
export const ROLE_DEFAULTS = {
  dev: starts({
    look: { color: "green", eyes: "wide", accessory: "headphones" },
    levels: { github: "write", sentry: "read", linear: "read" },
    channels: ["eng", "engenharia", "engineering", "dev", "desenvolvimento"],
  }),
  ops: starts({
    look: { color: "amber", eyes: "round", accessory: "antenna" },
    levels: { sentry: "write", github: "read", "cloudflare-observability": "read", linear: "read" },
    channels: ["ops", "incidentes", "incidents", "infra", "alertas", "alerts"],
  }),
  qa: starts({
    look: { color: "violet", eyes: "round", accessory: "headset" },
    levels: { github: "read", linear: "write", sentry: "read" },
    channels: ["qa", "bugs", "testes", "eng", "engenharia", "engineering"],
  }),
  pm: starts({
    look: { color: "indigo", eyes: "round", accessory: "cap" },
    levels: { linear: "write", notion: "write", github: "read", drive: "read" },
    channels: ["produto", "product", "pm", "roadmap"],
  }),
  // Customers: reads where the customer already is; sending to them asks a person first.
  support: starts({
    look: { color: "teal", eyes: "happy", accessory: "headset" },
    levels: { intercom: "write", notion: "read", linear: "read", stripe: "read" },
    channels: ["suporte", "support", "atendimento", "clientes", "customers", "help"],
  }),
  sales: starts({
    look: { color: "amber", eyes: "wide", accessory: "hat" },
    levels: { notion: "write", drive: "read", stripe: "read" },
    channels: ["vendas", "sales", "comercial", "leads", "clientes", "customers"],
  }),
  marketing: starts({
    look: { color: "rose", eyes: "happy", accessory: "party" },
    levels: { webflow: "write", canva: "write", notion: "read" },
    channels: ["marketing", "growth", "campanhas", "campaigns", "lancamentos", "launches"],
  }),
  content: starts({
    look: { color: "violet", eyes: "round", accessory: "beanie" },
    levels: { notion: "write", drive: "write", webflow: "read", canva: "read" },
    channels: ["conteudo", "content", "blog", "redacao", "writing", "social"],
  }),
  // Operations: numbers are read-only by default; money only moves with approval.
  data: starts({
    look: { color: "sky", eyes: "dots", accessory: "none" },
    levels: { "supabase-readonly": "read", stripe: "read", drive: "read" },
    channels: ["dados", "data", "metricas", "metrics", "analytics", "relatorios", "reports"],
  }),
  finance: starts({
    look: { color: "graphite", eyes: "round", accessory: "hat" },
    levels: { stripe: "read", paypal: "read", square: "read", drive: "read" },
    channels: ["financeiro", "finance", "financas", "pagamentos", "payments", "billing"],
  }),
  people: starts({
    look: { color: "green", eyes: "happy", accessory: "flower" },
    levels: { notion: "write", drive: "read", asana: "read" },
    channels: ["rh", "people", "pessoas", "hr", "contratacao", "hiring", "time", "team"],
  }),
  research: starts({
    look: { color: "indigo", eyes: "wide", accessory: "scarf" },
    levels: { notion: "write", drive: "read" },
    channels: ["pesquisa", "research", "estudos", "insights"],
  }),
  assistant: starts({
    look: { color: "rose", eyes: "round", accessory: "bow" },
    levels: { asana: "write", notion: "read", drive: "read" },
    channels: ["geral", "general", "agenda", "secretaria", "admin"],
  }),
  custom: starts({ look: { color: "sky", eyes: "round", accessory: "none" }, levels: {}, channels: [] }),
} satisfies Record<RoleId, RoleDefaults>;

/**
 * A personal workspace's starting points in Criar agente (ADR 0159 §3), in place of a team's roles: the agents of the
 * right hand's personal templates (the server's `MEMBERS` in team-templates.ts), their words in
 * `teamTemplates.agents.{id}` (`role`, `line`). One starts from scratch with its name, look, role and line filled in.
 */
export const PERSONAL_STARTERS = [
  { id: "clara", name: "Clara", look: { color: "violet", eyes: "happy", accessory: "bow" } },
  { id: "duda", name: "Duda", look: { color: "green", eyes: "round", accessory: "cap" } },
  { id: "leo", name: "Léo", look: { color: "amber", eyes: "wide", accessory: "headphones" } },
  { id: "mel", name: "Mel", look: { color: "rose", eyes: "dots", accessory: "scarf" } },
  { id: "gabi", name: "Gabi", look: { color: "indigo", eyes: "wide", accessory: "antenna" } },
  { id: "lu", name: "Lu", look: { color: "violet", eyes: "sleepy", accessory: "beanie" } },
  { id: "rosa", name: "Rosa", look: { color: "teal", eyes: "happy", accessory: "flower" } },
  { id: "vic", name: "Vic", look: { color: "sky", eyes: "dots", accessory: "hat" } },
  { id: "rui", name: "Rui", look: { color: "graphite", eyes: "round", accessory: "headset" } },
] as const satisfies readonly { id: string; name: string; look: RoleLook }[];
export type PersonalStarter = (typeof PERSONAL_STARTERS)[number];

/**
 * The apps (catalog connector ids) each personal starter uses (ADR 0159; mirror of the personal `MEMBERS` in
 * packages/engine/src/team-templates.ts): a person's calendar, files and lists rather than a team's tools.
 */
export const PERSONAL_STARTER_APPS: Record<string, readonly string[]> = {
  clara: ["google-calendar", "todoist"],
  duda: ["google-sheets", "drive"],
  leo: ["google-calendar"],
  mel: ["todoist", "google-docs"],
  gabi: ["notion", "google-docs"],
  lu: ["google-docs", "notion"],
  rosa: ["todoist", "google-calendar"],
  vic: ["google-calendar", "drive"],
  rui: ["google-calendar", "google-docs", "google-sheets"],
};

/** An app's level on a new agent's card (ADR 0164): it reads, or reads and writes. */
export type CardLevel = "read" | "write";

/**
 * The apps a new agent's card starts with (ADR 0164), at their levels: a personal starter's at write (one person's
 * agent starts with broad access, ADR 0159 §3a), a team role's at its preset levels; none from scratch.
 */
export function starterApps(pick: { role?: RoleId | null; starter?: string | null }): Record<string, CardLevel> {
  if (pick.starter) return Object.fromEntries((PERSONAL_STARTER_APPS[pick.starter] ?? []).map((id) => [id, "write"]));
  if (!pick.role || pick.role === "custom") return {};
  return Object.fromEntries(
    Object.entries(ROLE_DEFAULTS[pick.role].levels).filter((e): e is [string, CardLevel] => e[1] !== "none"),
  );
}

/** How a starter or a ready-made role introduces itself, in its own voice (`newAgent.hello.{id}`, ADR 0164). */
export const helloKey = (id: PersonalStarter["id"] | Exclude<RoleId, "custom">) => `newAgent.hello.${id}` as const;

/** The look a draft starts with (before a role is picked). */
export const BLANK_LOOK = { color: "sky", eyes: "round", accessory: "none" } as const satisfies RoleLook;

/**
 * Each connection's level for a role: the preset's level for its catalog connector, else write, as every agent already
 * has it (`grantToEveryAgent`). A custom server's account starts with none: only its first one is everyone's. In a
 * personal workspace (`broad`) it starts at write too: one person's agents start with everything (ADR 0159 §3a).
 */
export function presetLevels(role: RoleId, items: { id: string; def: { id: string } | null }[], broad = false) {
  const levels: Record<string, Level> = ROLE_DEFAULTS[role].levels;
  const level = (i: (typeof items)[number]): Level =>
    i.def ? (levels[i.def.id] ?? "write") : broad ? "write" : "none";
  return Object.fromEntries(items.map((i) => [i.id, level(i)])) as Record<string, Level>;
}

/** The role's channels among the ones given (by name, accents and case ignored). */
export function presetChannels<C extends { id: string; name: string }>(role: RoleId, channels: C[]) {
  const wanted = new Set(ROLE_DEFAULTS[role].channels);
  return channels.filter((c) => wanted.has(foldName(c.name))).map((c) => c.id);
}

const foldName = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/* ---------- @handle ---------- */

/** Same rule as the server (HANDLE_PATTERN in the engine): 2–32 of a-z, 0-9, - or _, not starting with - or _. */
export const AGENT_HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** What someone types in the @ field, kept to the allowed characters. */
export const cleanHandle = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);

/** The @ that follows the name while nobody edited it ("" for no name yet). */
export const handleForName = (name: string) => (name.trim() ? handleFrom(name) : "");

export type HandleProblem = "empty" | "format" | "taken";

/** Why a handle can't be used, if it can't: empty, the wrong shape, or someone's (agent or person) already. */
export function handleProblem(handle: string, taken: Set<string>): HandleProblem | null {
  if (!handle) return "empty";
  if (!AGENT_HANDLE.test(handle)) return "format";
  if (taken.has(handle)) return "taken";
  return null;
}

/** "ada" → "ada-2" (the first free one). */
export function freeHandle(handle: string, taken: Set<string>) {
  const base = handle.slice(0, 29).replace(/[-_]+$/, "") || "agente";
  for (let n = 2; n < 1000; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
  return base;
}

/**
 * The handles an agent can't take: the other agents' (with the ones they had before a rename, which still name
 * them) and people's. `exceptAgentId`: the agent being renamed, which may take one of its own back.
 */
export function takenHandles(
  agents: readonly { id: string; handle: string; previousHandles?: string[] }[],
  people: readonly { handle?: string | null }[],
  exceptAgentId?: string,
): Set<string> {
  return new Set(
    [
      ...agents.flatMap((a) => (a.id === exceptAgentId ? [] : [a.handle, ...(a.previousHandles ?? [])])),
      ...people.flatMap((p) => (p.handle ? [p.handle] : [])),
    ].map((h) => h.toLowerCase()),
  );
}

/**
 * The @ a renamed agent gets: the one typed in Menções, else the one its new name gives (`handleForName`). With
 * the name as it was, or one with no a-z or digit to make a handle of (an emoji, another script), it keeps its own.
 */
export function handleAfterRename(saved: { name: string; handle: string }, name: string, typed?: string): string {
  if (typed !== undefined) return typed;
  if (name.trim() === saved.name.trim() || !/[a-z0-9]/.test(cleanHandle(name))) return saved.handle;
  return handleForName(name);
}

/** Why the @ can't be used, in words; null when it can. */
export function handleProblemText(t: TFunction, handle: string, taken: Set<string>): string | null {
  const problem = handleProblem(handle, taken);
  if (problem === "taken") return t("newAgent.errors.handleTaken", { handle, suggestion: freeHandle(handle, taken) });
  if (problem === "format") return t("newAgent.errors.handleFormat");
  return problem === "empty" ? t("newAgent.errors.handleEmpty") : null;
}

/* ---------- Budget ---------- */

/** Quick amounts next to the budget field (US$ per month). */
export const QUICK_BUDGETS = [10, 30, 100] as const;

/** Empty = the workspace default (null); otherwise a positive amount, or invalid. */
export function readBudget(text: string): { amount: number | null; invalid: boolean } {
  if (text.trim() === "") return { amount: null, invalid: false };
  const amount = parseAmount(text);
  return { amount, invalid: !(amount > 0) };
}

/* ---------- What each step needs ---------- */

export interface DraftCheck {
  role: RoleId | null;
  name: string;
  handle: string;
  taken: Set<string>;
  ownerUserId: string | null;
  audience: AgentAudience;
  budget: string;
  /** The chosen model can be used (a key for its provider, or the platform key). */
  modelOk: boolean;
}

export type DraftError =
  | { field: "role"; code: "required" }
  | { field: "name"; code: "required" }
  | { field: "handle"; code: HandleProblem }
  | { field: "audience"; code: "noOwner" | "nobody" }
  | { field: "budget"; code: "invalid" }
  | { field: "model"; code: "unavailable" };

/** What keeps a step from going on (empty when it can). */
export function stepErrors(step: NewAgentStep, d: DraftCheck): DraftError[] {
  const out: DraftError[] = [];
  if (step === "role" && !d.role) out.push({ field: "role", code: "required" });
  if (step === "identity") {
    if (!d.name.trim()) out.push({ field: "name", code: "required" });
    const h = handleProblem(d.handle, d.taken);
    if (h) out.push({ field: "handle", code: h });
  }
  if (step === "where") {
    if (d.audience.mode === "owner" && !d.ownerUserId) out.push({ field: "audience", code: "noOwner" });
    const nobody = d.audience.userIds.length === 0 && (d.audience.roleIds?.length ?? 0) === 0;
    if (d.audience.mode === "people" && nobody && !d.ownerUserId) out.push({ field: "audience", code: "nobody" });
  }
  if (step === "model") {
    if (!d.modelOk) out.push({ field: "model", code: "unavailable" });
    if (readBudget(d.budget).invalid) out.push({ field: "budget", code: "invalid" });
  }
  return out;
}

/** The first step that can't go on yet (-1 when everything is ready). */
export const firstInvalidStep = (d: DraftCheck) => NEW_AGENT_STEPS.findIndex((s) => stepErrors(s, d).length > 0);

/* ---------- Once it exists ---------- */

/**
 * One of the saves after the agent is created: what it throws joins `failures` instead of stopping the rest, so a
 * refused part doesn't keep the others (its AI included) from saving. Whether it saved.
 */
export async function savePart(failures: unknown[], save: () => Promise<unknown>) {
  try {
    await save();
    return true;
  } catch (error) {
    failures.push(error);
    return false;
  }
}

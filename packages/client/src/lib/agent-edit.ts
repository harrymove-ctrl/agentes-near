import type { AgentAudience, BrainKind, Run } from "../api/types";
import { readBudget } from "./new-agent";

/*
 * The agent page: one draft over
 * everything that can be edited, one save bar. These are the rules that
 * don't need the agent's look; the draft itself (`Saved`, `Edits`) lives with
 * each platform, which knows the look's types.
 */

export const AGENT_TABS = [
  "overview",
  "instructions",
  "access",
  "memory",
  "files",
  "usage",
  "activity",
  "settings",
  "advanced",
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
export const isAgentTab = (v: unknown): v is AgentTab => AGENT_TABS.includes(v as AgentTab);

/** Configurações' sections, in order. */
export const AGENT_SECTIONS = [
  "identity",
  "brain",
  "budget",
  "owner",
  "audience",
  "channels",
  "computer",
  "danger",
] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];
export const isAgentSection = (v: unknown): v is AgentSection => AGENT_SECTIONS.includes(v as AgentSection);

/** The screens "Quem pensa" can open on from a link, past its first one (ADR 0032 §5, addendum 2026-11-10). */
export const BRAIN_SCREENS = ["model", "more", "switch"] as const;
export type BrainScreen = (typeof BRAIN_SCREENS)[number];
export const isBrainScreen = (v: unknown): v is BrainScreen => BRAIN_SCREENS.includes(v as BrainScreen);

/*
 * A personal workspace's agent page (ADR 0159 §3): the same page, simpler. Its bar keeps what one person uses
 * (Overview, Instructions, Memory, the apps it can use, its name and look) and an Advanced tab holds the rest: who owns
 * it and talks to it, its conversations, computer, brakes and danger zone, its built-in areas, databases, skills and
 * rules, with Activity, Files and Usage a click away. Every tab and section keeps its address.
 */

/** The bar in a personal workspace; Activity, Files or Usage join it while open. */
export const PERSONAL_AGENT_TABS = ["overview", "instructions", "memory", "access", "settings", "advanced"] as const;

/** Configurações' sections that a personal workspace shows in Advanced. */
export const ADVANCED_SECTIONS: readonly AgentSection[] = ["owner", "audience", "channels", "computer", "danger"];

/** The tab that shows for an address: a personal workspace's advanced sections in Advanced; a team's has no Advanced. */
export function shownAgentTab(tab: AgentTab, sec: AgentSection | undefined, personal: boolean): AgentTab {
  if (!personal) return tab === "advanced" ? "settings" : tab;
  return tab === "settings" && sec && ADVANCED_SECTIONS.includes(sec) ? "advanced" : tab;
}

/**
 * `?tab=settings&sec=brain` (unknown values are dropped; the old `sec=model` lands on "Quem pensa"), with `&brain=model`
 * (or `more`, `switch`) opening "Quem pensa" on that screen.
 * `?computer=1` opens the agent's computer; `?browser=1`, `?desktop=1` and `?terminal=1` are older links to it
 * (notifications, the Mac app's tray).
 */
export function agentSearch(search: Record<string, unknown>): {
  tab?: AgentTab;
  sec?: AgentSection;
  brain?: BrainScreen;
  computer?: 1;
} {
  const sec = search.sec === "model" ? "brain" : search.sec;
  const on = (v: unknown) => v === 1 || v === "1" || v === true;
  return {
    tab: isAgentTab(search.tab) ? search.tab : undefined,
    sec: isAgentSection(sec) ? sec : undefined,
    ...(sec === "brain" && isBrainScreen(search.brain) ? { brain: search.brain } : {}),
    ...([search.computer, search.browser, search.desktop, search.terminal].some(on) ? { computer: 1 as const } : {}),
  };
}

/** "Quem pensa": the brain, its model (null = the brain's default) and the fallback to the API. */
export interface BrainChoice {
  brain: BrainKind;
  model: string | null;
  fallback: boolean;
}
export const sameBrain = (a: BrainChoice, b: BrainChoice) =>
  a.brain === b.brain && (a.brain === "model" || a.model === b.model) && a.fallback === b.fallback;

const sorted = (list: string[]) => [...list].sort();
export const sameList = (a: string[], b: string[]) => sorted(a).join("\n") === sorted(b).join("\n");
export const sameAudience = (a: AgentAudience, b: AgentAudience) =>
  (a.consultable ?? true) === (b.consultable ?? true) &&
  a.mode === b.mode &&
  (a.mode !== "people" || (sameList(a.userIds, b.userIds) && sameList(a.roleIds ?? [], b.roleIds ?? [])));

/** The budget typed, as the API takes it (null = the default); undefined when it isn't a valid amount. */
export const budgetValue = (text: string): number | null | undefined => {
  const b = readBudget(text);
  return b.invalid ? undefined : b.amount;
};

/** Lines added and removed between two texts (the instructions' "2 linhas novas, 1 removida"). */
export function lineChanges(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // Longest common subsequence of lines, in one flat table.
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const same = at(0, 0);
  return { added: m - same, removed: n - same };
}

/** The new channel list (PUT replaces it): keeps DMs, private channels and auto-reply; adds and removes. */
export function channelsAfter(
  current: { id: string; autoReply: boolean }[],
  saved: string[],
  wanted: string[],
): { channelId: string; autoReply?: boolean }[] {
  const removed = new Set(saved.filter((id) => !wanted.includes(id)));
  const kept = current.filter((c) => !removed.has(c.id)).map((c) => ({ channelId: c.id, autoReply: c.autoReply }));
  const have = new Set(kept.map((c) => c.channelId));
  return [...kept, ...wanted.filter((id) => !have.has(id)).map((channelId) => ({ channelId }))];
}

/* ---------- Atividade ---------- */

export type RunFilter = "all" | "failed" | "waiting" | "routines";

/**
 * A run started by one of the agent's routines: the server says so (`routine`); older servers only by its text,
 * which starts with the routine's prompt (after `@handle` in a channel).
 */
export function isRoutineRun(run: Pick<Run, "what" | "routine">, prompts: string[], handle: string) {
  if (run.routine) return true;
  const text = run.what.trim().replace(new RegExp(`^@${handle}\\s+`, "i"), "");
  return prompts.some((p) => {
    const head = p.trim().slice(0, 80);
    return head.length > 0 && text.startsWith(head);
  });
}

export function runMatches(
  run: Run,
  filter: RunFilter,
  query: string,
  extra: { where: string; routine: boolean },
): boolean {
  if (filter === "failed" && run.status !== "failed") return false;
  if (filter === "waiting" && run.status !== "waiting_approval" && run.status !== "waiting_input") return false;
  if (filter === "routines" && !extra.routine) return false;
  const q = query.trim().toLowerCase();
  return !q || `${run.what} ${extra.where}`.toLowerCase().includes(q);
}

/** Runs grouped by calendar day (newest first, as the API sends them). */
export function groupByDay<T extends { createdAt: string }>(runs: T[]): { day: string; runs: T[] }[] {
  const out: { day: string; runs: T[] }[] = [];
  for (const r of runs) {
    const d = new Date(r.createdAt);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = out[out.length - 1];
    if (last && last.day === day) last.runs.push(r);
    else out.push({ day, runs: [r] });
  }
  return out;
}

/** Runs since the first day of this month (local time). */
export const thisMonth = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
};

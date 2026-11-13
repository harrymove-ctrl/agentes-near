import type { TFunction } from "i18next";
import type {
  Agent,
  AgentBrainLine,
  AgentUsageSource,
  AiAccounts,
  AiStatus,
  PlanAccountInfo,
  PlanAccountUsage,
  PlanUsage,
  PlanWindowParts,
} from "../api/types";
import { accountTitle, groupPlans, ownSignInName, ownSignIns, ownSignInTitle } from "./ai-accounts";
import {
  daysBetween,
  firstName,
  formatPercent,
  formatShortDate,
  formatTime,
  formatTokensShort,
  relativeTime,
} from "./format";
import { brainName } from "./outages";
import { modelLimitOf, ownLimitsModel, planOf } from "./plans";

/**
 * The words of the plan usage views (ADR 0063), shared by the web and the phone: a plan meter's text, an
 * account's windows with whose use they are, and where an agent's tokens went. Pure, no React.
 */

/** A meter window as `PlanMeter` draws it (the web's and the phone's). */
export interface MeterWindow {
  kind: string;
  label?: string;
  usedPercent: number;
  resetsAt?: string;
  part?: number;
  note?: string;
  segments?: MeterSegment[];
}

/** One agent's estimated piece of a window's bar, in its colours (`light` for the dark theme). */
export interface MeterSegment {
  key: string;
  value: number;
  light: string;
  deep: string;
}

const WINDOW_NAMES = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "monthly"] as const;

/** When a window resets, in the viewer's time zone: the time today, the weekday this week, else the date. */
function resetWhen(locale: string, iso: string, now: Date): { day: string | null; time: string } {
  const time = formatTime(locale, iso);
  const ahead = -daysBetween(iso, now);
  if (ahead <= 0) return { day: null, time };
  const day =
    ahead < 7
      ? new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(iso)).replace(/\.$/, "")
      : formatShortDate(locale, iso);
  return { day, time };
}

/**
 * When a waiting agent goes on, in the reader's zone, as a note says it ("às 15:40", "sexta às 10:00",
 * "em 1º de dezembro"): the time today, the weekday this week, else the date.
 */
export function usageWhen(t: TFunction, locale: string | undefined, iso: string, now = new Date()): string {
  const loc = locale ?? "en";
  const ahead = -daysBetween(iso, now);
  const time = formatTime(loc, iso);
  if (ahead <= 0) return t("chat.usageWhen.at", { time });
  if (ahead < 7) {
    const day = new Intl.DateTimeFormat(loc, { weekday: "long" }).format(new Date(iso)).replace(/-feira$/, "");
    return t("chat.usageWhen.on", { day, time });
  }
  const date = new Intl.DateTimeFormat(loc, { day: "numeric", month: "long" }).format(new Date(iso));
  return t("chat.usageWhen.date", { date: loc.startsWith("pt") ? date.replace(/^1 /, "1º ") : date });
}

/** `usageWhen` where room is short: "às 18:00", "sáb às 18:00", "3 de dez. às 18:00". */
export function usageWhenShort(t: TFunction, locale: string | undefined, iso: string, now = new Date()): string {
  const { day, time } = resetWhen(locale ?? "en", iso, now);
  return day ? t("chat.usageWhen.on", { day, time }) : t("chat.usageWhen.at", { time });
}

/**
 * The brain card's line when the agent's model is at a limit of its own on its plan (`PlanUsage.models`), so the
 * account's meters don't read as room for it: when it resets, the region it needs, or that the plan refused it.
 * Null: none now.
 */
export function modelLimitText(
  t: TFunction,
  locale: string | undefined,
  usage: Pick<PlanUsage, "models"> | null | undefined,
  provider: string | null | undefined,
  value: string | null | undefined,
  now = new Date(),
): string | null {
  const model = ownLimitsModel(provider, value);
  const limit = model ? modelLimitOf(usage?.models, model.id, now.getTime()) : null;
  if (!model || !limit) return null;
  if (limit.region) return t("brain.modelRegion", { model: model.label });
  if (limit.inactive) return t("brain.planInactive");
  if (limit.off) return t("brain.modelOff", { model: model.label });
  return limit.until === null
    ? t("brain.modelLimitUnknown", { model: model.label })
    : t("brain.modelLimit", {
        model: model.label,
        when: usageWhen(t, locale, new Date(limit.until).toISOString(), now),
      });
}

/** When the next month starts (UTC): an agent's monthly budget renews then. */
export function nextMonthIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** What `PlanMeter` says, in the viewer's language. */
export function planMeterText(
  t: TFunction,
  locale: string,
  now = new Date(),
): {
  window(w: Pick<MeterWindow, "kind" | "label">): string;
  short(w: Pick<MeterWindow, "kind" | "label">): string;
  resets(iso: string): string;
  almost: string;
  limited(until: string | null): string;
  updated(iso: string): string;
  ago(iso: string): string;
  stale(iso: string): string;
} {
  const named = (w: Pick<MeterWindow, "kind" | "label">, words: "window" | "short") => {
    const kind = WINDOW_NAMES.find((k) => k === w.kind);
    return kind ? t(`aiAccounts.usage.${words}.${kind}`) : (w.label ?? t(`aiAccounts.usage.${words}.other`));
  };
  return {
    window: (w) => named(w, "window"),
    short: (w) => named(w, "short"),
    resets: (iso) => {
      const { day, time } = resetWhen(locale, iso, now);
      return day ? t("aiAccounts.usage.resetsOn", { day, time }) : t("aiAccounts.usage.resetsAt", { time });
    },
    almost: t("aiAccounts.usage.almost"),
    limited: (until) => {
      if (!until) return t("aiAccounts.usage.limited");
      const { day, time } = resetWhen(locale, until, now);
      return t("aiAccounts.usage.limitedUntil", { when: day ? `${day} ${time}` : time });
    },
    updated: (iso) => t("aiAccounts.usage.updated", { ago: relativeTime(t, locale, iso, now) }),
    ago: (iso) => t("aiAccounts.usage.ago", { ago: relativeTime(t, locale, iso, now) }),
    stale: (iso) => t("aiAccounts.usage.stale", { ago: relativeTime(t, locale, iso, now) }),
  };
}

/** A plan's limits are worth a line once a window is known or the plan refused a request: unknown is nothing. */
const knownLimits = (usage: PlanUsage | null | undefined): usage is PlanUsage =>
  usage != null && (usage.windows.length > 0 || usage.limited === true);

/**
 * What shows of an agent's month where its budget used to (ADR 0063 §5): on a plan, its account's limits while a
 * window is known or the plan refused a request, and its budget only once it spent through the API this month; on
 * the API, its budget.
 */
export function usageShown(
  brain: Pick<AgentBrainLine, "kind" | "account" | "usage"> | undefined,
  budgetUsedPercent: number,
): { plan: { account: string | undefined; usage: PlanUsage } | null; budget: boolean } {
  if (!brain || brain.kind === "model") return { plan: null, budget: true };
  const usage = brain.usage;
  return {
    plan: knownLimits(usage) ? { account: brain.account, usage } : null,
    budget: budgetUsedPercent > 0,
  };
}

/**
 * The workspace's budget is worth a line (the Uso tile, the phone's workspace page) when its agents spent through the
 * API this month or one of them thinks through it: the model brain with a key (`ai-status` ready). On plans alone, no
 * 0% budget (ADR 0063 §5).
 */
export function workspaceUsesApi(
  agents: readonly Pick<Agent, "id" | "brain">[],
  ai: Pick<AiStatus, "agents"> | undefined,
  budgetUsedPercent: number,
) {
  if (budgetUsedPercent > 0) return true;
  const ready = new Set(ai?.agents.filter((a) => a.state === "ready").map((a) => a.agentId));
  return agents.some((a) => (a.brain?.kind ?? "model") === "model" && ready.has(a.id));
}

/** One of the viewer's plans with its limits: its maker's mark (`ProviderLogo`), its name and its usage. */
export interface OwnPlanLine {
  key: string;
  logo: string;
  name: string;
  usage: PlanUsage;
}

/**
 * The viewer's plans that an agent thinks with and whose limits are known (Sua conta, and the profile menu near a
 * limit, ADR 0063 §5): their computers' own sign-ins, then their accounts, as "Seus planos" orders and names them.
 * An account names its agents (`usedBy`) and thinks for nobody once signed out everywhere; a computer's own sign-in
 * thinks for the pairer's agents there that have no account (ADR 0059 §3). Two of one name say which, as "Seus planos"
 * tells them apart: their computers, or on the same computer an account's email (or its key's end).
 */
export function ownPlanLines(
  t: TFunction,
  view: AiAccounts | undefined,
  agents: readonly Pick<Agent, "name" | "ownerUserId" | "brain">[],
  me: string,
): OwnPlanLine[] {
  const groups = groupPlans(view?.accounts ?? []);
  const onAccounts = new Set(groups.flatMap((g) => g.usedBy));
  const own = ownSignIns(view)
    .filter((o) =>
      agents.some(
        ({ name, ownerUserId, brain }) =>
          ownerUserId === me &&
          brain?.kind === o.kind &&
          brain.computer === o.computer &&
          !brain.provider &&
          !onAccounts.has(name),
      ),
    )
    .map((o) => ({
      key: o.key,
      logo: o.kind,
      name: ownSignInTitle(t, o),
      usage: o.usage,
      computer: o.computer,
      detail: null,
    }));
  const accounts = groups.flatMap(({ key, logins, usedBy, usage, signedOut }) => {
    const a = logins[0];
    return a && usedBy.length > 0 && signedOut.length < logins.length
      ? [
          {
            key,
            logo: a.provider ?? a.kind,
            name: accountTitle(a),
            usage,
            computer: a.computer,
            detail: a.email ?? (a.keyHint ? t("aiAccounts.page.keyEnds", { hint: a.keyHint }) : null),
          },
        ]
      : [];
  });
  const lines = [...own, ...accounts].flatMap((p) => (knownLimits(p.usage) ? [{ ...p, usage: p.usage }] : []));
  return lines.map(({ computer, detail, ...p }) => {
    const twins = lines.filter((l) => l.key !== p.key && l.name === p.name);
    if (twins.length === 0) return p;
    const here = twins.some((l) => l.computer === computer);
    return {
      ...p,
      name: here && detail ? `${p.name} · ${detail}` : `${p.name} ${t("aiAccounts.page.on", { computer })}`,
    };
  });
}

/**
 * An account's windows for `PlanMeter` with whose use they are (the usage views): `note` says each
 * window's parts in words; `focus` draws that agent's part in full ink (none where it has no estimate).
 */
export function partedUsage(
  usage: Omit<PlanUsage, "windows"> & { windows: PlanWindowParts[] },
  note: (parts: NonNullable<PlanWindowParts["agents"]>) => string | undefined,
  focus?: string,
): Omit<PlanUsage, "windows"> & { windows: MeterWindow[] } {
  return {
    ...usage,
    windows: usage.windows.map(({ agents, ...w }) => ({
      ...w,
      ...(agents && agents.length > 0 ? { note: note(agents) } : {}),
      ...(agents && focus ? { part: agents.find((a) => a.agentId === focus)?.percent ?? 0 } : {}),
    })),
  };
}

/** How many agents an account's list shows before the rest fold into one row. */
export const SHARES_SHOWN = 5;

/** The rows a list shows before the fold; a single row left over shows as itself, its row costs the same. */
const unfolded = <T>(rows: T[]) => (rows.length > SHARES_SHOWN + 1 ? rows.slice(0, SHARES_SHOWN) : rows);

/**
 * An account's windows with the bar split by agent: the biggest parts (as many as the list shows) each in its
 * agent's colours (`tone`: light, deep), the rest of the use plain, so many small agents never fill more of the bar
 * than they used. A window of unknown length has no parts.
 */
export function splitUsage(
  usage: Omit<PlanUsage, "windows"> & { windows: PlanWindowParts[] },
  tone: (agentId: string) => readonly [string, string],
): Omit<PlanUsage, "windows"> & { windows: MeterWindow[] } {
  return {
    ...usage,
    windows: usage.windows.map(({ agents, ...w }) =>
      agents && agents.length > 0
        ? {
            ...w,
            segments: unfolded([...agents].sort((a, b) => b.percent - a.percent)).map((a) => {
              const [light, deep] = tone(a.agentId);
              return { key: a.agentId, value: a.percent, light, deep };
            }),
          }
        : w,
    ),
  };
}

/**
 * An account's one list of agents: each one's estimated share of the window its bar splits (the week, else the
 * first window with parts; null while none has them or it already renewed) and its tokens this month, biggest share
 * first, then tokens. Past `SHARES_SHOWN` the rest fold into one row with their summed share and tokens; a single
 * agent left over shows as itself, its row costs the same.
 */
export function accountShares(account: Pick<PlanAccountUsage, "usage" | "agents">, now = Date.now()) {
  const windows = account.usage?.windows ?? [];
  const parted = (w: PlanWindowParts) =>
    (w.agents?.length ?? 0) > 0 && !(w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now);
  const window = windows.find((w) => w.kind === "seven_day" && parted(w)) ?? windows.find(parted) ?? null;
  const partOf = new Map((window?.agents ?? []).map((a) => [a.agentId, a.percent]));
  const rows = account.agents.map((a) => ({ ...a, share: partOf.get(a.agentId) ?? 0 }));
  for (const a of window?.agents ?? [])
    if (!rows.some((r) => r.agentId === a.agentId))
      rows.push({ agentId: a.agentId, name: a.name, tokens: 0, now: false, share: a.percent });
  rows.sort((a, b) => b.share - a.share || b.tokens - a.tokens);
  const shown = unfolded(rows);
  const rest = rows.slice(shown.length);
  return {
    window,
    shown,
    rest,
    restShare: rest.reduce((sum, r) => sum + r.share, 0),
    restTokens: rest.reduce((sum, r) => sum + r.tokens, 0),
  };
}

/**
 * What follows an agent's name on its line under an account's bars: " · semana 48% · 4,8 mi tokens". The share only
 * while a window has parts (`window`, its short name); with no tokens yet, "usa agora" for an agent on it right now.
 */
export function shareFacts(
  t: TFunction,
  lang: string,
  window: string | null,
  row: { share: number; tokens: number; now?: boolean },
) {
  return [
    window ? `${window} ${formatPercent(lang, row.share)}` : null,
    row.tokens > 0
      ? t("usageViews.tokens", { tokens: formatTokensShort(t, lang, row.tokens) })
      : row.now
        ? t("usageViews.usesNow")
        : null,
  ]
    .filter(Boolean)
    .map((fact) => ` · ${fact}`)
    .join("");
}

/** Whose a plan account is, in words: "de Ana" (the first name); null where the server names no owner. */
export const accountOwner = (t: TFunction, a: Pick<PlanAccountInfo, "ownerName">) =>
  a.ownerName ? t("usageViews.whose", { name: firstName(a.ownerName) }) : null;

type AccountWindows = NonNullable<PlanAccountUsage["usage"]>;

/** Two logins of one account as one: the newest reading of its windows with both logins' agents, their months summed. */
function mergeLogin(a: PlanAccountUsage, b: PlanAccountUsage): PlanAccountUsage {
  const newest = (x: AccountWindows | null, y: AccountWindows | null) =>
    x && y ? (Date.parse(y.at) > Date.parse(x.at) ? [y, x] : [x, y]) : [x ?? y, null];
  const [usage, other] = newest(a.usage, b.usage);
  const agents = a.agents.map((x) => ({ ...x }));
  for (const x of b.agents) {
    const same = agents.find((y) => y.agentId === x.agentId);
    if (same) Object.assign(same, { tokens: same.tokens + x.tokens, now: same.now || x.now });
    else agents.push({ ...x });
  }
  return {
    ...a,
    signedOut: a.signedOut && b.signedOut,
    usage: usage
      ? {
          ...usage,
          windows: usage.windows.map((w) => {
            const theirs = other?.windows.find((o) => o.kind === w.kind && o.label === w.label)?.agents ?? [];
            const mine = w.agents ?? [];
            const more = theirs.filter((t) => !mine.some((m) => m.agentId === t.agentId));
            return more.length > 0 ? { ...w, agents: [...mine, ...more] } : w;
          }),
        }
      : null,
    agents,
    monthTokens: a.monthTokens + b.monthTokens,
    ...(typeof a.equivalentUsd === "number" || typeof b.equivalentUsd === "number"
      ? { equivalentUsd: (a.equivalentUsd ?? 0) + (b.equivalentUsd ?? 0) }
      : {}),
  };
}

/**
 * The usage views' accounts with the viewer's own logins of one account as one row, as their plans group them
 * (`groupPlans`, from `GET …/ai-accounts`): a plan with a login per agent, or one signed in again and again, is one
 * account to its owner. The row stands where its first login was and goes by it. Anyone else's logins stay as the
 * server lists them: what tells them apart (the address, the key's end) is only their owner's to see.
 */
export function groupUsageAccounts(
  accounts: readonly PlanAccountUsage[],
  mine: Pick<AiAccounts, "accounts"> | undefined,
): PlanAccountUsage[] {
  const groupOf = new Map<string, string>();
  for (const g of groupPlans(mine?.accounts ?? []))
    for (const l of g.logins) groupOf.set(`${l.machineId}:${l.id}`, g.key);
  const out: PlanAccountUsage[] = [];
  const rowOf = new Map<string, number>();
  for (const a of accounts) {
    const group = a.accountId ? groupOf.get(`${a.machineId}:${a.accountId}`) : undefined;
    const row = group === undefined ? undefined : rowOf.get(group);
    const first = row === undefined ? undefined : out[row];
    if (row !== undefined && first) out[row] = mergeLogin(first, a);
    else {
      if (group !== undefined) rowOf.set(group, out.length);
      out.push(a);
    }
  }
  return out;
}

/** What people call a plan account: its label, or the computer's own sign-in's name (`ownSignInName`). */
export const accountName = (t: TFunction, a: Pick<PlanAccountInfo, "label" | "machineName" | "mine" | "kind">) =>
  a.label ?? ownSignInName(t, a.mine, a.machineName, a.kind);

/** Who makes what an account thinks with: a coding plan's maker, else Claude Code or Codex. */
export const brandOf = (a: Pick<PlanAccountInfo, "kind" | "provider">) =>
  planOf(a.provider)?.maker ?? brainName(a.kind);

/** Why an account shows no windows: its maker doesn't tell them here, nobody used it yet, or nobody uses it. */
export function noWindowsText(t: TFunction, account: Pick<PlanAccountUsage, "provider" | "agents">) {
  const plan = planOf(account.provider);
  if (plan && !plan.usage) return t("aiAccounts.usage.notShared", { maker: plan.maker });
  return account.agents.length ? t("usageViews.noWindows") : t("usageViews.unused");
}

/** Where an agent's tokens went, by name: the account, "API", a removed account or the plan before accounts were recorded. */
export function usageSourceName(t: TFunction, s: AgentUsageSource) {
  if (s.type === "api") return t("usageViews.agent.api");
  if (s.account) return accountName(t, s.account);
  if (s.removed) return t("usageViews.agent.removed");
  return t("usageViews.agent.old", { brand: brandOf({ kind: s.kind ?? "claude_code", provider: null }) });
}

/** A source's share of the agent's month in a sentence: "97% na conta que os seus agentes dividem", "3% pela API". */
export function usageSourcePart(t: TFunction, locale: string, s: AgentUsageSource) {
  const percent = formatPercent(locale, s.share);
  if (s.type === "api") return t("usageViews.agent.apiPart", { percent });
  if (s.account?.accountId === null && s.account.kind !== "opencode") {
    return s.account.mine
      ? t("usageViews.agent.sharedPart", { percent })
      : t("usageViews.agent.computerPart", { percent, computer: s.account.machineName });
  }
  if (s.account) return t("usageViews.agent.accountPart", { percent, account: accountName(t, s.account) });
  if (s.removed) return t("usageViews.agent.removedPart", { percent });
  return t("usageViews.agent.oldPart", { percent, brand: brandOf({ kind: s.kind ?? "claude_code", provider: null }) });
}

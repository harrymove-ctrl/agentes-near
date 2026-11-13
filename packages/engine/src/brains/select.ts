import {
  ANTIGRAVITY_PROTOCOL,
  BRAIN_PROTOCOL,
  type BrainEffort,
  CURSOR_PROTOCOL,
  GROK_PROTOCOL,
  isBrainEffort,
  OPENCODE_PROTOCOL,
  type PlanUsage,
} from "@agenteschat/adapters";
import { and, desc, type Executor, eq, isNotNull, ne, schema, sql } from "@agenteschat/db";
import { isAutoModel } from "@agenteschat/providers";
import {
  autoPlanModel,
  claudeCodeModel,
  modelLimitOf,
  ownLimitsModel,
  PLAN_FORBIDDEN_TEXT,
  PLAN_INACTIVE_TEXT,
  planOf,
  speedFits,
} from "@agenteschat/providers/plans";
import { planState, planWindows } from "@agenteschat/ui/plan-state";
import type { Agent } from "../agents";
import type { MachineStatus } from "../machine-hub";
import { pausedMessage } from "../machines";
import { missionTurnFor } from "../missions-engine";
import { isRightHand, rightHandPerson, rightHandPlanRefusal, thinkingAgent } from "../right-hand";
import { runnerUpdateWay } from "../runner-update";
import type { AgentRun } from "../runs";
import { accountUnavailable, brainSessionId, claudeCodeAvailability, toolOff } from "./claude-code";
import { codexVersionOk } from "./codex";
import { BRAIN_NAMES, BRAIN_PLAN_NAMES, type BrainAccount, type BrainKind, type BrainSession } from "./types";

const KINDS: readonly BrainKind[] = ["model", "claude_code", "codex", "cursor", "opencode", "grok", "antigravity"];
const kindOf = (v: unknown): BrainKind => (KINDS.includes(v as BrainKind) ? (v as BrainKind) : "model");

/** A mission's choice for a run in its thread (`missionTurnFor`). */
export interface MissionTurn {
  missionId: string;
  brain: BrainKind;
  model?: string;
  session?: BrainSession;
}

/**
 * Which brain thinks for this run (ADR 0032 §5), by priority: the mission's
 * brain when the run is its main session (`missionTurnFor`), else the
 * agent's stored brain (`agents.brain`, block 3a). Availability is checked
 * separately (`computerBrainUnavailable`); the engine falls back from there.
 */
export function brainFor(
  agent: Pick<Agent, "brain">,
  _run: Pick<AgentRun, "id">,
  mission?: Pick<MissionTurn, "brain"> | null,
): BrainKind {
  return mission?.brain ?? kindOf(agent.brain);
}

/**
 * The brain a run thinks with (ADR 0053 §10): its own (`agent_runs.brain`, stored when the engine resolves
 * it and when a conversation run falls back), else the agent's until its first turn. Shared code (steering,
 * the talker, "Continuar") reads this, never the agent's stored brain alone.
 */
export const runBrainOf = (run: { brain?: string | null }, agent?: { brain?: string | null } | null): BrainKind =>
  kindOf(run.brain ?? agent?.brain);

/** Stores the brain a run thinks with now (`agent_runs.brain`). */
export async function recordRunBrain(db: Executor, runId: string, kind: BrainKind) {
  await db.update(schema.agentRuns).set({ brain: kind }).where(eq(schema.agentRuns.id, runId));
}

/**
 * Whether a run whose computer brain can't answer may hand the turn to the model brain (ADR 0032 §5).
 * Never a background run (ADR 0053 §6.4): a routine thinks with its agent's own brain and waits quietly
 * for its computer instead; the agent's owner may also turn the fallback off. Never the team's right hand on a
 * plan (ADR 0137 §7): its DM says why it can't think, with the way to an API key, and nothing runs on a key unasked.
 */
export const mayFallBack = (
  agent: Pick<Agent, "brainFallback"> & { builtin?: string | null },
  run: Pick<AgentRun, "background"> & { workId?: string | null },
) => !run.background && !run.workId && agent.brainFallback !== false && !isRightHand(agent);

/**
 * Plan limits seen on this process (`limit` events), by machine, brain and account: a cache in front of the
 * stored usage (`storedPlanLimit`), which a deploy or another replica reads too. `until` null: the reset isn't known.
 */
const planLimits = new Map<string, { until: number | null; seen: number }>();
/** No account: the computer's own sign-in. Each account (ADR 0041) has its own plan, so its own limit. */
const limitKey = (machineId: string, kind: BrainKind, accountId?: string) =>
  `${machineId}:${kind}:${accountId ?? "own"}`;

/** How long a limit with no known reset holds after it was seen: then a turn asks the plan again. */
export const UNKNOWN_LIMIT_MS = 30 * 60_000;

/** A computer brain hit its plan limit (until `resetsAt`, or `UNKNOWN_LIMIT_MS` when unknown). */
export function notePlanLimit(
  machineId: string,
  kind: BrainKind,
  resetsAt?: string,
  now = Date.now(),
  accountId?: string,
) {
  const until = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  planLimits.set(limitKey(machineId, kind, accountId), {
    until: Number.isFinite(until) && until > now ? until : null,
    seen: now,
  });
}

/** A turn on this plan went through: the limit seen here no longer holds. */
export function forgetPlanLimit(machineId: string, kind: BrainKind, accountId?: string) {
  planLimits.delete(limitKey(machineId, kind, accountId));
}

/** Tests: forget the plan limits seen. */
export function clearPlanLimits() {
  planLimits.clear();
}

/**
 * When the binding window of a stored reading resets (ms): the latest reset of its full windows, else (a refusal
 * known only from its words, no window full) the first window reset after the reading, while it is still ahead.
 * Later windows didn't refuse anything: once that first reset passed, a turn asks the plan again. Null: none known.
 */
export function bindingReset(usage: PlanUsage | null | undefined, now = Date.now()): number | null {
  if (!usage) return null;
  const { until } = planState(usage, now);
  if (until) return Date.parse(until);
  const at = Date.parse(usage.at);
  const first = Math.min(
    ...usage.windows.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN)).filter((r) => r > at),
  );
  return first > now && Number.isFinite(first) ? first : null;
}

/**
 * Whether a stored reading says the plan is at its limit now (`planState`), and until when (null: unknown).
 * A limit with no known reset holds for `UNKNOWN_LIMIT_MS` after its reading, and never past a window's reset.
 */
export function storedPlanLimit(
  usage: PlanUsage | null | undefined,
  now = Date.now(),
): { until: number | null } | null {
  if (!usage || planState(usage, now).state !== "limited") return null;
  const until = bindingReset(usage, now);
  if (until !== null) return { until };
  const at = Date.parse(usage.at);
  const resetSince = usage.windows.some(
    (w) => w.resetsAt && Date.parse(w.resetsAt) > at && Date.parse(w.resetsAt) <= now,
  );
  return Number.isFinite(at) && now - at < UNKNOWN_LIMIT_MS && !resetSince ? { until: null } : null;
}

/** The plan limit of this sign-in now, from this process's cache or the stored reading. */
function planLimitNow(key: string, usage: PlanUsage | null | undefined, now: number) {
  const seen = planLimits.get(key);
  const cached = seen && (seen.until !== null ? seen.until > now : now - seen.seen < UNKNOWN_LIMIT_MS) ? seen : null;
  const stored = storedPlanLimit(usage, now);
  if (!cached && !stored) return null;
  return { until: cached?.until ?? stored?.until ?? null };
}

/**
 * Whether this sign-in's plan is at its limit now (an agent out of office, ADR 0084 §12), and until when (null:
 * unknown): this process's cache, else the stored reading.
 */
export function planLimitOf(
  machineId: string,
  kind: BrainKind,
  accountId: string | undefined,
  usage: PlanUsage | null | undefined,
  now = Date.now(),
): { until: number | null } | null {
  return planLimitNow(limitKey(machineId, kind, accountId), usage, now);
}

/** The account's windows a refusal's words may name that come back on a fixed day for each model too (OpenCode Go's week and month). */
const MODEL_WINDOW_WORDS: readonly [RegExp, "seven_day" | "monthly"][] = [
  [/week/i, "seven_day"],
  [/month/i, "monthly"],
];

export type RefusalScope = { scope: "account" } | { scope: ModelScope; resetsAt?: string };

/**
 * Whose a plan's refusal is when it's one model's: its own limit, the region it needs, switched off for the key, or
 * no active subscription on the key's workspace (`inactive`, kept on the model it refused like the others).
 */
export type ModelScope = "model" | "region" | "off" | "inactive";

/**
 * A plan refused a model that needs its Global region for that, whatever the status it came with. Only those: the
 * models OpenCode sells in "limited regions" are closed by country, which that setting can't open.
 */
export const regionRefusal = (provider: string | null | undefined, model: string | null | undefined, message: string) =>
  ownLimitsModel(provider, model)?.needs === "globalRegion" && /region/i.test(message);

/**
 * A plan whose models are each switched on or off refused this one for the key (a 403 that names no region, which a
 * setting may not open): the model is off in its workspace, or the account. Never the key itself.
 */
export const offRefusal = (provider: string | null | undefined, model: string | null | undefined, message: string) =>
  ownLimitsModel(provider, model) !== null &&
  (PLAN_FORBIDDEN_TEXT.test(message) || PLAN_INACTIVE_TEXT.test(message)) &&
  !/region/i.test(message);

/**
 * Whose limit a plan's refusal (`message`, the CLI's words) is. On a plan whose models have limits of their own, the
 * model's, unless a window of the account is full (`usage`, the last reading): the region the model needs when its words
 * say region, else its own limit, back when the account's window its words name resets (a 5-hour one is the model's own
 * and its reset isn't known). Any other plan: the account's.
 */
export function refusalScope(
  provider: string | null | undefined,
  model: string | null | undefined,
  message: string,
  usage: PlanUsage | null | undefined,
  now = Date.now(),
): RefusalScope {
  const m = ownLimitsModel(provider, model);
  if (!m) return { scope: "account" };
  if (regionRefusal(provider, model, message)) return { scope: "region" };
  if (offRefusal(provider, model, message)) return { scope: PLAN_INACTIVE_TEXT.test(message) ? "inactive" : "off" };
  if (usage && planWindows(usage, now).some((w) => w.used >= 100)) return { scope: "account" };
  const kind = MODEL_WINDOW_WORDS.find(([words]) => words.test(message))?.[1];
  const at = kind ? usage?.windows.find((w) => w.kind === kind)?.resetsAt : undefined;
  return { scope: "model", ...(at && Date.parse(at) > now ? { resetsAt: at } : {}) };
}

/** An account's models still at their own limit (`modelLimitOf`), for a reading that replaces the last one. */
export function liveModelLimits(usage: PlanUsage | null | undefined, now = Date.now()) {
  const kept = Object.entries(usage?.models ?? {}).filter(([model]) => modelLimitOf(usage?.models, model, now));
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** Keeps a model's own limit on its account (`PlanUsage.models`); a reading with none yet starts empty. */
export async function noteModelLimit(
  db: Executor,
  orgId: string,
  accountId: string,
  model: string,
  limit: { until?: string; region?: true; off?: true; inactive?: true },
  now = Date.now(),
) {
  const { machineAccounts } = schema;
  const at = new Date(now).toISOString();
  const entry = JSON.stringify({ [model]: { at, ...limit } });
  const empty = JSON.stringify({ windows: [], source: "turn", at });
  await db
    .update(machineAccounts)
    .set({
      usage: sql`jsonb_set(coalesce(${machineAccounts.usage}, ${empty}::jsonb), '{models}',
        coalesce(${machineAccounts.usage}->'models', '{}'::jsonb) || ${entry}::jsonb)`,
    })
    .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, accountId)));
}

/** A turn on the model went through with the account's key: "Automático" stands in with it (`autoPlanModel`). */
export async function noteAnswered(db: Executor, orgId: string, accountId: string, model: string) {
  const { machineAccounts } = schema;
  const empty = JSON.stringify({ windows: [], source: "turn", at: new Date().toISOString() });
  await db
    .update(machineAccounts)
    .set({
      usage: sql`jsonb_set(coalesce(${machineAccounts.usage}, ${empty}::jsonb), '{answered}', to_jsonb(${model}::text))`,
    })
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.id, accountId),
        sql`${machineAccounts.usage}->>'answered' is distinct from ${model}`,
      ),
    );
}

/** A turn on the model went through: its own limit no longer holds. True when there was one. */
export async function forgetModelLimit(db: Executor, orgId: string, accountId: string, model: string) {
  const { machineAccounts } = schema;
  const gone = await db
    .update(machineAccounts)
    .set({ usage: sql`${machineAccounts.usage} #- ${`{models,${model}}`}::text[]` })
    .where(
      and(
        eq(machineAccounts.orgId, orgId),
        eq(machineAccounts.id, accountId),
        sql`${machineAccounts.usage}->'models' ? ${model}`,
      ),
    )
    .returning({ id: machineAccounts.id });
  return gone.length > 0;
}

/**
 * What the runner last said about the plan this run would think with: the account's usage, or the computer's own
 * sign-in's (`executors.ownUsage`). Read from the database, so every replica sees the same limit.
 */
export async function storedPlanUsage(
  db: Executor,
  orgId: string,
  machineId: string,
  kind: BrainKind,
  accountId?: string,
): Promise<PlanUsage | null> {
  if (kind === "model") return null;
  const { machineAccounts, machines } = schema;
  if (accountId) {
    const [row] = await db
      .select({ usage: machineAccounts.usage })
      .from(machineAccounts)
      .where(and(eq(machineAccounts.orgId, orgId), eq(machineAccounts.id, accountId)));
    return (row?.usage as PlanUsage | null | undefined) ?? null;
  }
  const [row] = await db
    .select({ executors: machines.executors })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.id, machineId)));
  return (row?.executors.ownUsage?.[kind] as PlanUsage | undefined) ?? null;
}

export interface BrainUnavailability {
  code: string;
  message: string;
  resetsAt?: string;
  /** A `plan_limit` that is one model's (`refusalScope`), not the account's. */
  scope?: ModelScope;
}

/**
 * Why a computer brain can't take the turn now (null: it can): no computer, the computer's own sign-in on a
 * computer nobody connected, someone else's plan, offline, paused by its owner, commands off, a runner older
 * than protocol 8, the CLI missing or not logged in (`hello.executors`), or over the plan limit.
 */
export function computerBrainUnavailable(
  kind: BrainKind,
  machineId: string | null,
  status: MachineStatus | null,
  now = Date.now(),
  /** The agent's account (ADR 0041): it decides the sign-in instead of the computer's own. */
  account?: BrainAccount,
  /** The plan it would think with is the agent's owner's (`planIsOwners`). */
  ownersPlan = true,
  /** What the runner last said about that plan (`storedPlanUsage`). */
  usage?: PlanUsage | null,
  /** The model the turn would run (`BrainPlan.model`): on a plan whose models have their own limits, its own counts. */
  model?: string,
): BrainUnavailability | null {
  if (kind === "model") return null;
  const name = BRAIN_NAMES[kind];
  if (!machineId) return { code: "no_computer", message: `The agent has no computer for ${name}.` };
  // OpenCode's free tier on a computer nobody connected (ADR 0132): no sign-in, nobody's plan, any agent's.
  const freeTier = kind === "opencode" && !account && status?.pairedByUserId === null;
  // The computer's own sign-in thinks only for agents of whoever connected the computer (ADR 0059 §3): on one
  // nobody connected, no person signs in at its terminal, so for its agents it isn't signed in.
  if (!account && status?.pairedByUserId === null && !freeTier) {
    const plan = BRAIN_PLAN_NAMES[kind];
    return {
      code: "not_logged_in",
      message: `${name} isn't signed in on ${status.name}. Connect a ${plan} account on the agent's page.`,
    };
  }
  if (!ownersPlan && !freeTier) {
    return {
      code: "plan_not_owner",
      message: `${name}${status ? ` on ${status.name}` : ""} would think with a plan that isn't the agent's owner's.`,
    };
  }
  const limited = planLimitNow(limitKey(machineId, kind, account?.id), usage, now);
  if (limited) {
    return {
      code: "plan_limit",
      message: account
        ? `The ${name} account "${account.label}"${status ? ` on ${status.name}` : ""} reached its plan limit.`
        : `${name}${status ? ` on ${status.name}` : ""} reached its plan limit.`,
      ...(limited.until !== null ? { resetsAt: new Date(limited.until).toISOString() } : {}),
    };
  }
  const own = ownLimitsModel(account?.provider, model);
  const modelLimit = own ? modelLimitOf(usage?.models, own.id, now) : null;
  if (own && modelLimit) {
    return {
      code: "plan_limit",
      scope: modelLimit.region ? "region" : modelLimit.inactive ? "inactive" : modelLimit.off ? "off" : "model",
      message: modelLimit.region
        ? `${own.label} needs the Global region on in OpenCode (Settings › Privacy).`
        : modelLimit.inactive
          ? `OpenCode Go isn't active on the OpenCode account of the key "${account?.label ?? ""}".`
          : modelLimit.off
            ? `OpenCode refused ${own.label} with this key: the model or the account is turned off there.`
            : `${own.label} reached its own limit on the ${name} account "${account?.label ?? ""}".`,
      ...(modelLimit.until !== null ? { resetsAt: new Date(modelLimit.until).toISOString() } : {}),
    };
  }
  // Paused by its owner (ADR 0036 §6): like offline, until the pause ends (a known end: try again then).
  const pausedUntil = status?.online && status.paused?.until ? { resetsAt: status.paused.until } : {};
  if (kind === "claude_code") {
    const e = claudeCodeAvailability(status, account);
    if (e?.type !== "error") return null;
    return { code: e.code, message: e.message, ...(e.code === "machine_paused" ? pausedUntil : {}) };
  }
  if (!status?.online) {
    return { code: "machine_offline", message: `${name}${status ? ` on ${status.name}` : ""} is offline.` };
  }
  if (status.paused) {
    return {
      code: "machine_paused",
      message: pausedMessage(status.name, status.paused.until, status.paused.timezone),
      ...pausedUntil,
    };
  }
  if (kind === "cursor" || kind === "opencode" || kind === "grok" || kind === "antigravity") {
    const off = toolOff(status, kind);
    if (off) return off;
    if (
      status.protocol <
      {
        cursor: CURSOR_PROTOCOL,
        opencode: OPENCODE_PROTOCOL,
        grok: GROK_PROTOCOL,
        antigravity: ANTIGRAVITY_PROTOCOL,
      }[kind]
    ) {
      return {
        code: "runner_outdated",
        message: `The runner on ${status.name} is too old for ${name} agents. ${runnerUpdateWay(status)}`,
      };
    }
    if (status.executors?.detectedAt && !status.executors[kind]) {
      return { code: `${kind}_missing`, message: `${name}'s CLI is not installed on ${status.name}.` };
    }
    return accountUnavailable(status, account, kind);
  }
  const off = toolOff(status, "codex");
  if (off) return off;
  if (status.protocol < BRAIN_PROTOCOL) {
    return {
      code: "runner_outdated",
      message: `The runner on ${status.name} is too old for Codex agents. ${runnerUpdateWay(status)}`,
    };
  }
  const codex = status.executors?.codex;
  if (status.executors?.detectedAt && !codex) {
    return { code: "codex_missing", message: `Codex is not installed on ${status.name}.` };
  }
  if (codex && !codexVersionOk(codex.version)) {
    return { code: "codex_too_old", message: `Codex on ${status.name} is too old. Update it there.` };
  }
  return accountUnavailable(status, account, "codex");
}

/**
 * Brain errors that mean "not now on this computer": they fall back, or the message waits. `busy`: the
 * computer had no room for the turn, and the run looks again on a timer (`COMPUTER_BUSY_RETRY_MS`).
 */
export const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "busy",
  "no_session",
  "no_computer",
  "machine_offline",
  "machine_paused",
  "exec_disabled",
  "tool_off",
  "runner_outdated",
  "cli_missing",
  "not_logged_in",
  "codex_missing",
  "codex_too_old",
  "cursor_missing",
  "opencode_missing",
  "grok_missing",
  "antigravity_missing",
  "plan_limit",
  "plan_not_owner",
  "plan_not_shared",
  "plan_unattended",
  "tools_not_locked",
]);

/**
 * Unavailable codes that mean the computer brain has nothing to think with (no computer, its command-line
 * tool missing or signed out), not "later": nothing signals a sign-in, so a wait for them would never end.
 */
export const NO_AI_CODES: ReadonlySet<string> = new Set([
  "no_computer",
  "cli_missing",
  "not_logged_in",
  "codex_missing",
  "cursor_missing",
  "opencode_missing",
  "grok_missing",
  "antigravity_missing",
]);

/** What the engine runs a turn with. */
export interface BrainPlan {
  kind: BrainKind;
  /** The brain's model (`opus`, `sonnet`, a Codex model); undefined = the brain's default (model brain: the agent's). */
  model?: string;
  session?: BrainSession;
  missionId?: string;
  /** Set when the computer brain can't take the turn now. */
  unavailable?: BrainUnavailability;
  /** The agent's account for this brain on this computer (ADR 0041); absent: the computer's own sign-in. */
  account?: BrainAccount;
  /** How hard the computer brain thinks; absent: the CLI's default. */
  effort?: BrainEffort;
  /** What the runner last said about the plan it thinks with (`storedPlanUsage`). */
  usage?: PlanUsage;
  /** A mission's main session goes on although the agent's `promptKey` changed since its last run there. */
  settingsChanged?: boolean;
}

/** What a Claude Code brain's model is when nobody chose one (Codex: its own default). */
const DEFAULT_MODELS: Partial<Record<BrainKind, string>> = { claude_code: "sonnet" };

/**
 * The model a computer brain thinks with: the mission's choice, else the
 * agent's own model when the agent thinks with this same brain (an Opus
 * chosen for Claude Code means nothing to Codex), else the brain's default.
 */
export function brainModelFor(
  kind: BrainKind,
  agent: Pick<Agent, "brain" | "brainModel">,
  mission?: Pick<MissionTurn, "model"> | null,
): string | undefined {
  if (kind === "model") return undefined;
  const agentModel = kindOf(agent.brain) === kind ? (agent.brainModel ?? undefined) : undefined;
  return mission?.model ?? agentModel ?? DEFAULT_MODELS[kind];
}

/**
 * The agent's account and effort apply to its own brain on its own computer:
 * not to a mission that thinks with another brain, nor on the mission's
 * computer when it is another one. A removed account is no account.
 */
export async function brainAccountFor(
  db: Executor,
  agent: Pick<Agent, "orgId" | "brain" | "brainAccountId" | "machineId">,
  kind: BrainKind,
  machineId: string | null,
): Promise<BrainAccount | undefined> {
  if (!agent.brainAccountId || !machineId || machineId !== agent.machineId || kindOf(agent.brain) !== kind) {
    return undefined;
  }
  const { machineAccounts } = schema;
  const [row] = await db
    .select({
      id: machineAccounts.id,
      label: machineAccounts.label,
      status: machineAccounts.status,
      kind: machineAccounts.kind,
      provider: machineAccounts.provider,
    })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, agent.orgId),
        eq(machineAccounts.id, agent.brainAccountId),
        eq(machineAccounts.machineId, machineId),
      ),
    );
  if (!row || row.kind !== kind) return undefined;
  // A sign-in still in progress or an account being removed can't think: as good as signed out.
  return {
    id: row.id,
    label: row.label,
    status: row.status === "active" ? "active" : "signed_out",
    ...(row.provider ? { provider: row.provider } : {}),
  };
}

/**
 * A plan thinks only for its owner's agents (ADR 0059 §3): the account's
 * owner, or with the computer's own sign-in the person who connected that
 * computer, must be the agent's owner, still in the organization. The account
 * someone who may use other people's plans gave it (`brainAccountLentBy`)
 * needs only its own owner still there.
 */
export async function planIsOwners(
  db: Executor,
  agent: Pick<Agent, "orgId" | "ownerUserId"> & Partial<Pick<Agent, "brainAccountId" | "brainAccountLentBy">>,
  machineId: string,
  account: Pick<BrainAccount, "id"> | undefined,
): Promise<boolean> {
  const owner = agent.ownerUserId;
  if (!owner) return false;
  const lent = account !== undefined && !!agent.brainAccountLentBy && agent.brainAccountId === account.id;
  const { machineAccounts, machines, organizationMembers: members } = schema;
  const rows = account
    ? await db
        .select({ id: machineAccounts.id })
        .from(machineAccounts)
        .innerJoin(
          members,
          and(eq(members.orgId, machineAccounts.orgId), eq(members.userId, machineAccounts.createdBy)),
        )
        .where(
          and(
            eq(machineAccounts.orgId, agent.orgId),
            eq(machineAccounts.id, account.id),
            lent ? undefined : eq(machineAccounts.createdBy, owner),
          ),
        )
    : await db
        .select({ id: machines.id })
        .from(machines)
        .innerJoin(members, and(eq(members.orgId, machines.orgId), eq(members.userId, machines.pairedByUserId)))
        .where(and(eq(machines.orgId, agent.orgId), eq(machines.id, machineId), eq(machines.pairedByUserId, owner)));
  return rows.length > 0;
}

/** The agent's effort when it thinks with its own brain (a mission's other brain: the CLI's default). */
export function brainEffortFor(agent: Pick<Agent, "brain" | "brainEffort">, kind: BrainKind): BrainEffort | undefined {
  if (kind === "model" || kindOf(agent.brain) !== kind) return undefined;
  return isBrainEffort(agent.brainEffort) ? agent.brainEffort : undefined;
}

/**
 * Fast mode for this turn (ADR 0149): an agent set to it, thinking with its own brain on a sign-in and model that
 * support it, answering in a conversation. A routine, long work, an issue or a mission spends the plan with nobody
 * waiting (`unattended`), so they stay at standard speed, and the right hand has no such setting.
 */
export function brainSpeedFor(
  agent: Pick<Agent, "brain" | "brainSpeed"> & { builtin?: string | null },
  plan: Pick<BrainPlan, "kind" | "model" | "account" | "missionId">,
  run: Pick<AgentRun, "background" | "workId">,
  unattended: boolean,
): "fast" | undefined {
  if (agent.brainSpeed !== "fast" || isRightHand(agent) || kindOf(agent.brain) !== plan.kind) return undefined;
  if (unattended || run.background || run.workId || plan.missionId) return undefined;
  return speedFits({ kind: plan.kind, provider: plan.account?.provider, model: plan.model }) ? "fast" : undefined;
}

/** A conversation's session is picked up again only this soon after its last turn (its prompt cache is gone after). */
export const SESSION_IDLE_MS = 60 * 60_000;
/**
 * …and only while its last turn read less than this (input + cache, summed
 * over the turn's model calls): past it every turn re-reads a huge history,
 * so a fresh session starts with the recent messages instead.
 */
export const SESSION_MAX_INPUT_TOKENS = 150_000;

/** Whether a session already ran on the machine (plan usage recorded for one of its runs): resume it. A hint: the runner checks its own disk. */
async function sessionUsed(db: Executor, run: AgentRun, kind: BrainKind, sessionId: string) {
  const { agentRuns, usageRecords } = schema;
  const [row] = await db
    .select({ id: usageRecords.id })
    .from(usageRecords)
    .innerJoin(agentRuns, eq(agentRuns.id, usageRecords.runId))
    .where(
      and(
        eq(usageRecords.orgId, run.orgId),
        eq(usageRecords.agentId, run.agentId),
        eq(usageRecords.provider, kind),
        eq(agentRuns.brainSessionId, sessionId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The computer brain's session for a run (stored on the run, so a pause
 * resumes the same one): the conversation's previous session while it is
 * recent and small, else a fresh one. A routine or background run always starts fresh
 * (each firing is its own task; resuming made one routine re-read 700k tokens), and its
 * session is never carried to a conversation run.
 */
async function sessionFor(
  db: Executor,
  agent: Agent,
  run: AgentRun,
  kind: BrainKind,
  conversation: string,
  options: { fresh?: boolean; promptKey?: string },
  now: Date,
): Promise<{ id: string; resume: boolean }> {
  if (run.brainSessionId) {
    return { id: run.brainSessionId, resume: await sessionUsed(db, run, kind, run.brainSessionId) };
  }
  let id: string | null = null;
  if (!options.fresh && !run.background) {
    const { agentRuns, usageRecords, messages } = schema;
    const [last] = await db
      .select({
        id: agentRuns.id,
        sessionId: agentRuns.brainSessionId,
        at: sql<Date>`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt})`.mapWith(
          (v: string | Date) => new Date(v),
        ),
        // Qualified by hand: inside the subquery a bare "id" would be usage_records.id. A row's `input_tokens` is
        // only the uncached part (`recordPlanUsage`), so the cache counts here too: a well-cached session reads
        // almost all of its history from the cache.
        input: sql<number>`coalesce((select max(u.input_tokens + u.cache_read_tokens + u.cache_write_tokens)
          from ${usageRecords} u where u.run_id = "agent_runs"."id" and u.provider = ${kind}), 0)`.mapWith(Number),
        promptKey: sql<string | null>`${agentRuns.transcript}->>'promptKey'`,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, run.orgId),
          eq(agentRuns.agentId, run.agentId),
          eq(agentRuns.channelId, run.channelId),
          // A flat conversation (a DM) is the channel itself; a thread is its root.
          ...(conversation === run.channelId ? [] : [eq(agentRuns.threadRootId, conversation)]),
          isNotNull(agentRuns.brainSessionId),
          ne(agentRuns.id, run.id),
          // Never a session a run still going on uses (a paused long job picks up there, ADR 0118), nor background
          // work's (ADR 0121: its process may be mid-turn): whichever row carries it, an earlier finished one included.
          sql`not exists (select 1 from ${agentRuns} r3
            where r3.org_id = "agent_runs"."org_id" and r3.brain_session_id = "agent_runs"."brain_session_id"
              and r3.id <> ${run.id}
              and (r3.work_id is not null or r3.status in ('queued', 'running', 'waiting_input', 'waiting_approval')))`,
          // Never a session background work thought in (a routine's: it was told to answer NO_REPLY, and a
          // conversation that picked it up answered that). Any run that shared it counts, older rows too.
          sql`not exists (select 1 from ${agentRuns} r2
            where r2.org_id = "agent_runs"."org_id" and r2.agent_id = "agent_runs"."agent_id"
              and r2.brain_session_id = "agent_runs"."brain_session_id"
              and (r2.background or exists (select 1 from ${messages} m
                where m.org_id = r2.org_id and m.id = r2.trigger_message_id and m.meta->'routine' is not null)))`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (
      last?.sessionId &&
      now.getTime() - last.at.getTime() < SESSION_IDLE_MS &&
      last.input < SESSION_MAX_INPUT_TOKENS &&
      // A live session keeps the system prompt it started with: after an edit to the instructions (or anything
      // else `promptKey` covers) a new one starts, with the conversation so far in its first prompt.
      (options.promptKey === undefined || last.promptKey === options.promptKey)
    ) {
      id = last.sessionId;
    }
  }
  const sessionId = id ?? brainSessionId(agent.id, `${conversation}:${run.id}`, kind);
  await db.update(schema.agentRuns).set({ brainSessionId: sessionId }).where(eq(schema.agentRuns.id, run.id));
  return { id: sessionId, resume: id ? await sessionUsed(db, run, kind, sessionId) : false };
}

/**
 * The brain, model and session of a run: the mission's when the run is its
 * main session, else the agent's; for a
 * computer brain, its availability on the agent's computer (checked when
 * `machines` is given; the brains check again). `conversation`: the thread
 * the run answers in, or the channel for a flat DM.
 */
export async function resolveBrain(
  deps: {
    db: Executor;
    machines?: { status(machineId: string): Promise<MachineStatus | null> };
  },
  given: Agent,
  run: AgentRun,
  conversation: string,
  /**
   * `fresh`: a new computer session whatever the conversation had (routine runs). `promptKey`: the run's
   * (`Transcript.promptKey`); the conversation's session is picked up only when it started with the same.
   */
  options: { fresh?: boolean; now?: Date; promptKey?: string } = {},
): Promise<BrainPlan> {
  const mission: MissionTurn | null = await missionTurnFor(deps.db, run).catch(() => null);
  // The right hand: the AI of the person whose DM this is, else the workspace's; on a plan, its computer and owner.
  const agent = await thinkingAgent(deps.db, given, await rightHandPerson(deps.db, given, run));
  const kind = brainFor(agent, run, mission);
  const base = mission ? { missionId: mission.missionId } : {};
  if (kind === "model") return { kind, ...base };
  const model = brainModelFor(kind, agent, mission);
  const machineId = mission?.session?.machineId ?? agent.machineId ?? null;
  const [status, account] = await Promise.all([
    machineId && deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    brainAccountFor(deps.db, agent, kind, machineId),
  ]);
  const usage =
    machineId && deps.machines
      ? await storedPlanUsage(deps.db, agent.orgId, machineId, kind, account?.id).catch(() => null)
      : null;
  // A plan's model kept while another account thinks (or none): what that one runs instead, so no turn asks a
  // provider for a model it doesn't have.
  const runs =
    kind === "claude_code" && model && !isAutoModel(model) ? claudeCodeModel(planOf(account?.provider), model) : model;
  const effort = brainEffortFor(agent, kind);
  const unavailable =
    (isRightHand(agent) ? await rightHandPlanRefusal(deps.db, agent, run, status) : null) ??
    (machineId && !deps.machines
      ? null
      : computerBrainUnavailable(
          kind,
          machineId,
          status,
          Date.now(),
          account,
          machineId ? await planIsOwners(deps.db, agent, machineId, account) : true,
          usage,
          // "Automático" runs another model where the one it maps to is held (`autoPlanModel`).
          isAutoModel(runs) ? autoPlanModel(account?.provider, runs, usage) : runs,
        ));
  // A mission's main session stays (its decisions, inbox and items point at it): `settingsChanged` brings the edit.
  const settingsChanged =
    mission?.session?.resume && options.promptKey !== undefined
      ? await deps.db
          .select({ key: sql<string | null>`${schema.agentRuns.transcript}->>'promptKey'` })
          .from(schema.agentRuns)
          .where(
            and(
              eq(schema.agentRuns.orgId, run.orgId),
              eq(schema.agentRuns.agentId, run.agentId),
              eq(schema.agentRuns.threadRootId, run.threadRootId),
              ne(schema.agentRuns.id, run.id),
              sql`${schema.agentRuns.transcript}->>'promptKey' is not null`,
            ),
          )
          .orderBy(desc(schema.agentRuns.createdAt))
          .limit(1)
          .then(([last]) => Boolean(last && last.key !== options.promptKey))
      : false;
  const session: BrainSession | undefined =
    mission?.session ??
    (machineId
      ? {
          ...(await sessionFor(deps.db, agent, run, kind, conversation, options, options.now ?? new Date())),
          machineId,
          cwd: "",
        }
      : undefined);
  return {
    kind,
    ...base,
    ...(runs ? { model: runs } : {}),
    ...(session ? { session } : {}),
    ...(unavailable ? { unavailable } : {}),
    ...(account ? { account } : {}),
    ...(effort ? { effort } : {}),
    ...(usage ? { usage } : {}),
    ...(settingsChanged ? { settingsChanged } : {}),
  };
}

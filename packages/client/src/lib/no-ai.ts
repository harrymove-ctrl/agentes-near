import type { TFunction } from "i18next";
import type {
  Agent,
  AgentBrain,
  AiComputer,
  AiStatus,
  BrainUnavailable,
  ConnectIntent,
  Edition,
  Machine,
  MachineAccount,
  MachineAccountKind,
  OrgStanding,
} from "../api/types";
import { ownSignInReady } from "./ai-accounts";
import { answersOthers, audienceOf } from "./audience";
import { type BillingHold, billingHoldOf } from "./billing";
import { type SetupView, setupPending } from "./computer";
import { toolOffReason } from "./machines";
import { can } from "./permissions";
import { CODING_PLANS, isPlanId, loginPerAgent, PLAN_IDS, type PlanId } from "./plans";
import { isRightHand } from "./right-hand";

/**
 * No AI connected (ADR 0061): an agent's card when it can't answer, and the Connect step a person who
 * met it asked for. Platform-neutral (web and phone).
 */

/** A failed run's error, a routing decision's and a receipt's reason: nobody had an AI to think with. */
export const NO_AI = "no_ai";

/** `meta.noAi` of an agent's card (`bodyCode: "no_ai"`). */
export interface NoAiCard {
  agentId: string;
  /** Who asked: the Connect dialog may open by itself for them only. */
  forUserId: string | null;
  intent: ConnectIntent;
  /** With `api_key`: the provider the message named. */
  provider?: string;
  autoOpen?: boolean;
  /** Its plan's sign-in ended (`reason: not_signed_in`): the agent says so, and signing in again is the way back. */
  signedOut?: boolean;
  /**
   * Instead of `signedOut`: the computer's own sign-in of this CLI isn't there and the agent has no account, so the
   * way is an account of that CLI's plan (`planOfKind`), connected on the agent's page or from the card.
   */
  own?: MachineAccountKind;
  /**
   * The team's right hand on a plan (ADR 0137 §7): why that plan can't think now, said as one line with the way to an
   * API key (its computer away or with a problem, the plan at its limit or its model's own, the region that model needs, commands off
   * there, a plan that answers only its owner, to someone else or to a request no person made, a runner to update
   * there, the plan's CLI offering tools of its own).
   */
  planLine?: RightHandPlanLine;
  /** With `model_limit`, `model_region` and `model_off`: the model's name. */
  model?: string;
  /** With `planLine` `cli_failed`: what the plan's CLI said, the cause its line names. */
  why?: string;
  /** Not "no AI": its computer has no such CLI installed, or it has no computer at all. */
  missing?: "cli_missing" | "no_computer";
  /** A billing hold stopped the run: the message is kept for after the plan (`keptCardState`). */
  held?: boolean;
}

/** Why the right hand's plan can't think for this message (`NoAiCard.planLine`). */
export type RightHandPlanLine =
  | "computer_away"
  | "computer_failed"
  | "cli_failed"
  | "plan_limit"
  | "model_limit"
  | "model_region"
  | "model_off"
  | "plan_inactive"
  | "commands_off"
  | "plan_not_shared"
  | "plan_unattended"
  | "runner_outdated"
  | "plan_tools";
export const RIGHT_HAND_PLAN_LINES: ReadonlySet<string> = new Set<RightHandPlanLine>([
  "computer_away",
  "computer_failed",
  "cli_failed",
  "plan_limit",
  "model_limit",
  "model_region",
  "model_off",
  "plan_inactive",
  "commands_off",
  "plan_not_shared",
  "plan_unattended",
  "runner_outdated",
  "plan_tools",
]);

const INTENTS: ReadonlySet<string> = new Set<ConnectIntent>(["claude", "chatgpt", "api_key", "any", "task"]);
const isIntent = (v: unknown): v is ConnectIntent => typeof v === "string" && INTENTS.has(v);

export function noAiCardOf(meta: Record<string, unknown> | null | undefined): NoAiCard | null {
  const raw = meta?.noAi;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.agentId !== "string") return null;
  const signedOut = o.reason === "not_signed_in";
  const own =
    signedOut &&
    (o.own === "claude_code" ||
      o.own === "codex" ||
      o.own === "cursor" ||
      o.own === "opencode" ||
      o.own === "grok" ||
      o.own === "antigravity")
      ? o.own
      : null;
  return {
    agentId: o.agentId,
    forUserId: typeof o.forUserId === "string" ? o.forUserId : null,
    intent: isIntent(o.intent) ? o.intent : "task",
    ...(typeof o.provider === "string" ? { provider: o.provider } : {}),
    ...(o.autoOpen === true ? { autoOpen: true } : {}),
    ...(own ? { own } : signedOut ? { signedOut: true } : {}),
    ...(typeof o.reason === "string" && RIGHT_HAND_PLAN_LINES.has(o.reason)
      ? { planLine: o.reason as RightHandPlanLine }
      : {}),
    ...(typeof o.model === "string" && o.model ? { model: o.model } : {}),
    ...(o.reason === "cli_failed" && typeof o.why === "string" && o.why ? { why: o.why } : {}),
    ...(o.reason === "cli_missing" || o.reason === "no_computer" ? { missing: o.reason } : {}),
    ...(o.reason === "plan_hold" ? { held: true } : {}),
  };
}

/**
 * Where a kept message stands, from the plan to its answer: the wall (`held`), back from paying with the hold still
 * on (`paid`, the banner speaks), the plan active with no AI yet (`connect`), and an AI there (`answer`: opening the
 * conversation starts the answer, with no click). A key saved before reads as ready, so the hold comes first.
 */
export function keptCardState(s: { hold: BillingHold | null; paid: boolean; ready: boolean }) {
  if (s.hold) return s.paid ? ("paid" as const) : ("held" as const);
  return s.ready ? ("answer" as const) : ("connect" as const);
}

/** The key of a plan line's sentence (`name`, `model` and `why` fill it): the CLI's failure with what it said. */
export const planLineKey = (line: RightHandPlanLine, why?: string) =>
  line === "cli_failed" && why ? ("noAi.rightHand.cli_failedWhy" as const) : (`noAi.rightHand.${line}` as const);

/** A plan line that passes by itself: once the agent can think again, its card offers "Responder agora". */
export const planLinePasses = (line: RightHandPlanLine | undefined) =>
  line === "computer_away" || line === "computer_failed" || line === "cli_failed";

/**
 * The key of a card's line while the agent still can't think (`agentGrammar(name)` fills it): the computer's own
 * sign-in of that CLI missing, its sign-in ended, its computer with no such CLI, no computer, else no AI at all.
 */
export const noAiLineKey = (card: Pick<NoAiCard, "own" | "signedOut" | "missing">) =>
  card.own
    ? (`noAi.notSignedIn.${card.own}` as const)
    : card.signedOut
      ? "noAi.signedOut"
      : card.missing === "cli_missing"
        ? "noAi.cliMissing"
        : card.missing === "no_computer"
          ? "noAi.noComputer"
          : "noAi.agent";

type ConnectingAgent = { ownerUserId?: string | null; builtin?: "right_hand" | null };

/** Who can set an agent's own AI: its owner (a plan), who manages agents (a workspace key) or keys. */
const maySetAgentAi = (
  agent: ConnectingAgent | null | undefined,
  meId: string | null | undefined,
  org: Parameters<typeof can>[0],
) => (!!meId && agent?.ownerUserId === meId) || can(org, "manage_agents") || can(org, "manage_credentials");

/**
 * Who can do something about an agent with no AI: who sets its AI, and on the right hand any member, for their own
 * plan (ADR 0137 §11). Anyone else reads who can (`noAi.locked`) in place of a Connect that leads nowhere. Mirrors
 * `ConnectAiDialog`.
 */
export const mayConnectAi = (
  agent: ConnectingAgent | null | undefined,
  meId: string | null | undefined,
  org: Parameters<typeof can>[0],
) => (!!meId && isRightHand(agent)) || maySetAgentAi(agent, meId, org);

/**
 * The way out of a plan line for this person: their own plan when the workspace's doesn't serve them, or when a key
 * isn't theirs to set (an API key is always the workspace's, §11), else an API key. A request no person made thinks
 * with no one's own plan: only a key helps there. Null: neither is theirs to do.
 */
export function planLineFix(
  line: RightHandPlanLine,
  agent: ConnectingAgent | null | undefined,
  meId: string | null | undefined,
  org: Parameters<typeof can>[0],
): "connectMine" | "useKey" | null {
  if (line === "plan_unattended") return maySetAgentAi(agent, meId, org) ? "useKey" : null;
  if (!mayConnectAi(agent, meId, org)) return null;
  return line === "plan_not_shared" || !maySetAgentAi(agent, meId, org) ? "connectMine" : "useKey";
}

/** The key of an agent's line from its AI status, for a banner with no card (`noAiLineKey`). */
export function noAiStatusKey(status: AiStatus | undefined, agentId: string) {
  const reason = status?.agents.find((a) => a.agentId === agentId)?.reason;
  return noAiLineKey({
    signedOut: reason === "not_signed_in",
    ...(reason === "cli_missing" || reason === "no_computer" ? { missing: reason } : {}),
  });
}

/**
 * The dialog opens by itself only where the server marked it (Jev at 0.9 or more) and at a step: never
 * for `any` or `task`, where a guess opened dialogs nobody asked for.
 */
export const opensByItself = (x: { intent?: string; autoOpen?: boolean }) =>
  x.autoOpen === true && (x.intent === "claude" || x.intent === "chatgpt" || x.intent === "api_key");

/**
 * The brain a plan thinks with, on the agent's computer: a Claude plan through Claude Code, ChatGPT's through Codex,
 * OpenCode's (`zen`: its free tier or an OpenCode key, ADR 0132) through OpenCode's CLI, a SuperGrok or X Premium+ plan
 * through Grok Build (ADR 0142), a Google AI Pro or Ultra plan or Gemini Enterprise through the Antigravity CLI (ADR
 * 0143).
 */
export const PLAN_BRAIN: Record<"claude" | "chatgpt" | "cursor" | "zen" | "grok" | "gemini", MachineAccountKind> = {
  claude: "claude_code",
  chatgpt: "codex",
  cursor: "cursor",
  zen: "opencode",
  grok: "grok",
  gemini: "antigravity",
};
/** The plan a CLI signs in to by itself (`PLAN_BRAIN` the other way): ChatGPT's for Codex, Claude's for Claude Code. */
export const planOfKind = (kind: MachineAccountKind): "claude" | "chatgpt" | "cursor" | "zen" | "grok" | "gemini" =>
  kind === "codex"
    ? "chatgpt"
    : kind === "cursor"
      ? "cursor"
      : kind === "opencode"
        ? "zen"
        : kind === "grok"
          ? "grok"
          : kind === "antigravity"
            ? "gemini"
            : "claude";

type AiState = AiStatus["agents"][number]["state"];

/** An agent's state in the AI status; undefined while it loads or for an agent it doesn't list. */
export const aiStateOf = (status: AiStatus | undefined, agentId: string): AiState | undefined =>
  status?.agents.find((a) => a.agentId === agentId)?.state;

/**
 * A plan a person signs in with, on the agent's computer: Claude's, ChatGPT's, Cursor's (a sign-in or its API key,
 * ADR 0114), OpenCode's (`zen`, its free tier or an OpenCode key, ADR 0132), or a coding plan's key.
 */
export type PlanChoice = "claude" | "chatgpt" | "cursor" | "zen" | "grok" | "gemini" | PlanId;
/** What the picker offers: a plan, or the workspace's API key. */
export type AiChoice = PlanChoice | "key";
/** Every picker's order, the most used first: Claude (chosen first), ChatGPT, Gemini, Grok, Cursor, OpenCode, then the coding plans. */
export const PLAN_CHOICES: readonly PlanChoice[] = [
  "claude",
  "chatgpt",
  "gemini",
  "grok",
  "cursor",
  "zen",
  ...PLAN_IDS,
];
/** The account a plan signs in as: ChatGPT's through Codex, Cursor's and OpenCode's through their CLIs; the rest through Claude Code. */
export const kindOf = (choice: PlanChoice): MachineAccountKind =>
  choice === "chatgpt" || choice === "cursor" || choice === "zen" || choice === "grok" || choice === "gemini"
    ? PLAN_BRAIN[choice]
    : PLAN_BRAIN.claude;
/** The plan an account signs in with: a coding plan's key, ChatGPT's through Codex, Cursor's, else Claude's. */
export const planOfAccount = (a: Pick<MachineAccount, "kind" | "provider">): PlanChoice =>
  isPlanId(a.provider) ? a.provider : planOfKind(a.kind);
/**
 * What an agent's brain view thinks with, as the picker's choice: the API key on the model brain, else the plan of the
 * account it thinks with (the computer's own sign-in: Claude's or ChatGPT's).
 */
export const aiChoiceOf = (view: Pick<AgentBrain, "brain" | "account" | "accounts">): AiChoice =>
  view.brain === "model"
    ? "key"
    : planOfAccount({ kind: view.brain, provider: view.accounts.find((a) => a.id === view.account)?.provider ?? null });
/**
 * The sign-in a row of what the person already has asks for (`existingAi`), in its plan's panel: one more login of
 * that account for the agent (`email`, Claude's hint), or a free login of it signed back in (`again`). `from`: the
 * row's login.
 */
export interface ExistingSignIn {
  choice: PlanChoice;
  from: string;
  again?: string;
  email?: string | null;
}
/** A plan's maker mark (a `ProviderLogo` id): ChatGPT's is OpenAI's, OpenCode's CLI OpenCode's. */
export const planMark = (choice: PlanChoice) =>
  choice === "chatgpt" ? "openai" : choice === "zen" ? "opencode" : choice;
/** A plan's short name, as its tile and its accounts say it: "Claude", "ChatGPT", "GLM Coding"… */
export const planLabel = (t: TFunction, choice: PlanChoice) =>
  isPlanId(choice) ? CODING_PLANS[choice].label : t(`aiAccounts.connect.${kindOf(choice)}`);
/** A plan's name in its panel, as its maker sells it: "Your Claude plan", "GLM Coding Plan"… */
export const planTitle = (t: TFunction, choice: PlanChoice) =>
  isPlanId(choice) ? CODING_PLANS[choice].name : t(`connectAi.plan.${choice}.title`);
/** Other names people search a plan by: the CLIs it goes by ("codex" finds ChatGPT). Product names, not translated. */
const PLAN_SEARCH_NAMES: Partial<Record<PlanChoice, string>> = {
  claude: "Claude Code",
  chatgpt: "Codex",
  gemini: "Gemini CLI Antigravity",
  grok: "Grok Build",
  zen: "OpenCode Zen",
};
export const planSearchNames = (choice: PlanChoice) => PLAN_SEARCH_NAMES[choice] ?? "";
/** What a search for a plan finds it by: its name, its maker, what it is sold as, its tiers and its CLIs. */
export const planPickText = (t: TFunction, choice: PlanChoice) =>
  [
    planLabel(t, choice),
    planMark(choice),
    planTitle(t, choice),
    t(`connectAi.plan.${choice}.tiers`),
    planSearchNames(choice),
  ].join(" ");
/** The marks overlapped on the computer's plan line, and on the API key row. */
export const PLAN_MARKS = ["claude", "openai", "zai", "kimi"] as const;
export const KEY_MARKS = ["claude", "openai", "gemini", "openrouter"] as const;

/**
 * The billing hold that stops a plan: only the Cloud has an agentes.chat plan, so a self-hosted server never has one.
 * Not known yet (`edition` null) it counts: no moment of Connect or "Plano ativo" on a workspace on hold.
 */
export const planHoldOf = (
  edition: Edition | null,
  standing: Pick<OrgStanding, "state" | "reason"> | null | undefined,
) => (edition === "selfhost" ? null : billingHoldOf(standing));

/** What a plan's panel can do now for one agent: sign in, or why not yet. */
export type PlanGate =
  | { state: "loading" }
  /** The Cloud's computer on its way; `view` null: it said ready and the agent gets it on the next refresh. */
  | { state: "preparing"; view: SetupView | null }
  | { state: "offline" }
  /** No computer for the agent: none connected (self-host), or the Cloud's said ready and still gave it none. */
  | { state: "missing" }
  /** `overdue`: on the Cloud, it should have passed by itself by now and didn't. */
  | { state: "unsupported"; reason: BrainUnavailable | "keys"; overdue?: boolean }
  /** `owner`: the viewer doesn't own the agent; `computer`: only whoever connected it adds a sign-in there. */
  | { state: "locked"; who: "owner" | "computer" }
  /** The Cloud's workspace is on a billing hold: it has no computer to sign in on until its agentes.chat plan is active. */
  | { state: "billing"; hold: BillingHold }
  | { state: "ready" };

/**
 * How long past its computer being ready a CLI that isn't there may still be on its way. Nothing tells the apps an
 * install is running: past this, "it changes by itself" would be a guess.
 */
export const CLOUD_INSTALL_WAIT_MS = 20 * 60_000;

/** The same for the Cloud's computer offline: a restart takes minutes, so past this it isn't one. */
export const CLOUD_AWAY_MS = 20 * 60_000;

/** The computer has been ready for longer than an install takes, or nobody knows since when. */
const installOverdue = (setup: SetupView | null, now: number) =>
  !setup?.since || now - setup.since >= CLOUD_INSTALL_WAIT_MS;

/** A plan that can't sign in on the Cloud's computer, and whether that is past waiting for (`CLOUD_INSTALL_WAIT_MS`). */
export const unsupportedGate = (
  reason: BrainUnavailable | "keys",
  edition: Edition | null,
  setup: SetupView | null,
  now = Date.now(),
): PlanGate => ({
  state: "unsupported",
  reason,
  ...(edition === "cloud" && reason !== "tool_off" && installOverdue(setup, now) ? { overdue: true } : {}),
});

/**
 * The gate, first match wins. `brain` is the chosen agent's view (undefined while it loads); `computer` is that
 * computer's `/ai-accounts` row, which says whether it takes a coding plan's key. `caughtUp`: the view was asked
 * again after the Cloud's computer said ready (`catchUp`), so a view with no computer still has none, and nothing is
 * coming.
 */
export function planGate({
  choice,
  edition,
  setup,
  brain,
  computer,
  caughtUp = false,
  standing,
  now = Date.now(),
}: {
  choice: PlanChoice;
  edition: Edition | null;
  setup: SetupView | null;
  brain: AgentBrain | undefined;
  computer: AiComputer | undefined;
  caughtUp?: boolean;
  standing?: Pick<OrgStanding, "state" | "reason"> | null;
  now?: number;
}): PlanGate {
  const hold = planHoldOf(edition, standing);
  if (hold) return { state: "billing", hold };
  if (edition === "cloud" && setupPending(setup)) return { state: "preparing", view: setup };
  if (!brain || !edition) return { state: "loading" };
  if (!brain.canUsePlans) return { state: "locked", who: "owner" };
  if (!brain.computer)
    return edition === "cloud" && !caughtUp ? { state: "preparing", view: null } : { state: "missing" };
  if (!brain.computer.online) return { state: "offline" };
  const option = brain.options.find((o) => o.kind === kindOf(choice));
  if (!option?.available) return unsupportedGate(option?.reason ?? "not_reported", edition, setup, now);
  if (!brain.accountsSupported) return unsupportedGate("runner_old", edition, setup, now);
  if (isPlanId(choice) && !computer?.keys) return unsupportedGate("keys", edition, setup, now);
  if (!brain.canManageAccounts) return { state: "locked", who: "computer" };
  return { state: "ready" };
}

/**
 * `planGate` for a person who owns no agent yet: a plan signs in on a computer they may add accounts to, and the
 * account then thinks for the agents they create there. Read off the computers' `/ai-accounts` rows (no agent, no
 * brain view) and `machines` (who connected each, its switches); `computer`: where it signs in, or the computer the
 * gate is about.
 */
export function planGateWithoutAgent({
  choice,
  edition,
  setup,
  computers,
  machines,
  standing,
  now = Date.now(),
}: {
  choice: PlanChoice;
  edition: Edition | null;
  setup: SetupView | null;
  computers: readonly AiComputer[] | undefined;
  machines?: readonly Pick<Machine, "id" | "pairedBy">[] | undefined;
  standing?: Pick<OrgStanding, "state" | "reason"> | null;
  now?: number;
}): { gate: PlanGate; computer?: AiComputer } {
  const hold = planHoldOf(edition, standing);
  if (hold) return { gate: { state: "billing", hold } };
  if (edition === "cloud" && setupPending(setup)) return { gate: { state: "preparing", view: setup } };
  if (!computers || !edition) return { gate: { state: "loading" } };
  const kind = kindOf(choice);
  const machineOf = (c: AiComputer) => machines?.find((m) => m.id === c.machineId);
  const fits = (c: AiComputer) => c.online && c.brains[kind] === true && (!isPlanId(choice) || c.keys);
  const addable = computers.filter((c) => c.canAdd);
  const computer = addable.find(fits) ?? addable.find((c) => c.online) ?? addable[0];
  if (!computer) {
    // `canAdd` is also false on a runner too old for accounts: one they connected, or nobody did, is that.
    const old = computers.find((c) => c.mine || machineOf(c)?.pairedBy === null);
    if (old)
      return {
        gate: old.online ? unsupportedGate("runner_old", edition, setup, now) : { state: "offline" },
        computer: old,
      };
    const first = computers[0];
    if (!first) return { gate: edition === "cloud" ? { state: "preparing", view: null } : { state: "missing" } };
    return { gate: { state: "locked", who: "computer" }, computer: first };
  }
  if (!computer.online) return { gate: { state: "offline" }, computer };
  if (computer.brains[kind] !== true)
    return { gate: unsupportedGate(computer.off?.[kind] ?? "not_reported", edition, setup, now), computer };
  if (isPlanId(choice) && !computer.keys) return { gate: unsupportedGate("keys", edition, setup, now), computer };
  return { gate: { state: "ready" }, computer };
}

/**
 * The person's account of this plan that can think for one more agent (signed in, and free or made for all of their
 * agents), as "Quem pensa" offers it: what a plan connected with no agent yet left them.
 */
export const freePlanAccount = <
  A extends Pick<MachineAccount, "kind" | "provider" | "mine" | "status" | "shared" | "usedBy">,
>(
  accounts: readonly A[] | undefined,
  choice: PlanChoice,
) =>
  accounts?.find(
    (a) =>
      a.mine && a.status === "active" && (a.shared === true || a.usedBy.length === 0) && planOfAccount(a) === choice,
  );

/**
 * The computer's own sign-in can think for the agent with this plan (`ownSignInReady`): Claude's or ChatGPT's, never
 * a coding plan's, which signs in with its key.
 */
export const ownSignInFor = (choice: PlanChoice, brain: AgentBrain | undefined, computer: AiComputer | undefined) =>
  !isPlanId(choice) && ownSignInReady(brain, computer, kindOf(choice));

/** A plan tile reads dimmed when its plan can't sign in there at all (it still opens its panel, which says why). */
export const gateDims = (gate: PlanGate) =>
  gate.state === "missing" || gate.state === "unsupported" || gate.state === "billing";

/**
 * The gate passes by itself, with nothing for the person to do: the computer reconnecting, or (the Cloud's, which is
 * ours) its programs being installed or updated there, or any computer's runner saying what it has. The panel asks
 * again while it shows, as events may not say it. A program not allowed there is ours to allow, and the rest of
 * self-host's wait for someone (their computers are people's own).
 */
export const gateRechecks = (gate: PlanGate, edition: Edition | null) =>
  gate.state === "offline" ||
  (gate.state === "unsupported" &&
    !gate.overdue &&
    (gate.reason === "not_reported" || (edition === "cloud" && gate.reason !== "tool_off")));

/** The Cloud's line per reason a plan can't sign in on the workspace's computer (`aiAccounts.connect.needsCloud.*`). */
const CLOUD_REASON = {
  no_computer: "preparing",
  exec_off: "execOff",
  runner_old: "runnerOld",
  keys: "runnerOld",
  tool_off: "toolOff",
  not_installed: "installing",
  outdated: "updating",
  // Said only past the wait: before it, the line says the computer is still looking.
  not_reported: "stuck",
} as const satisfies Record<BrainUnavailable | "keys", string>;

/**
 * Why a plan's panel can't sign in yet, in plain words, with what happens next: an offline computer, or a reason the
 * plan can't sign in there (`unsupported`). On the Cloud the computer is ours, so the line says what it's doing (a
 * program being installed or updated, a restart) and that it comes back by itself (`rechecks`), or that it's on our
 * side. The Cloud's computer that never reached this agent has no line of its own: nothing is coming, as past a wait.
 * `hold`: a workspace on hold (`holdText`) waits for that, not for the computer, so it speaks instead. Null for any
 * other gate. `computer`: its name as the panel says it; `machine`: its row, for the way to allow a program on a
 * self-hosted one.
 */
export function gateLine(
  t: TFunction,
  {
    gate,
    edition,
    kind,
    computer,
    machine,
    hold,
    now = Date.now(),
  }: {
    gate: PlanGate;
    edition: Edition | null;
    kind: MachineAccountKind;
    computer: string;
    machine?: (Pick<Machine, "os" | "mode"> & Partial<Pick<Machine, "lastSeenAt">>) | null;
    hold?: string | null;
    now?: number;
  },
): { text: string; rechecks: boolean } | null {
  const rechecks = gateRechecks(gate, edition);
  const program = t(`brain.card.${kind}`);
  if (hold && (gate.state === "offline" || gate.state === "unsupported")) return { text: hold, rechecks: false };
  if (gate.state === "missing" && edition === "cloud")
    return { text: t("aiAccounts.connect.needsCloud.stuck", { computer, program }), rechecks };
  if (gate.state === "offline") {
    const seen = machine?.lastSeenAt ? Date.parse(machine.lastSeenAt) : null;
    if (edition === "cloud" && seen !== null && now - seen >= CLOUD_AWAY_MS)
      return { text: t("aiAccounts.connect.needsCloud.away", { computer }), rechecks };
    return {
      text:
        edition === "cloud"
          ? t("aiAccounts.connect.needsCloud.online", { computer })
          : t("brain.offline", { computer }),
      rechecks,
    };
  }
  if (gate.state !== "unsupported") return null;
  if (gate.reason === "not_reported" && !gate.overdue)
    return { text: t("brain.reasons.not_reported", { computer }), rechecks };
  if (edition === "cloud")
    return {
      text: t(`aiAccounts.connect.needsCloud.${gate.overdue ? "stuck" : CLOUD_REASON[gate.reason]}`, {
        computer,
        program,
      }),
      rechecks,
    };
  if (gate.reason === "keys") return { text: t("aiAccounts.connect.needs.keys"), rechecks };
  if (gate.reason === "tool_off") {
    const off = toolOffReason(machine, kind);
    return { text: t(off.key, { computer, command: off.command, program }), rechecks };
  }
  return { text: t(`brain.reasons.${gate.reason}`, { computer, program }), rechecks };
}

/** Why a plan's rows are dimmed (`gateDims`), in one line under them. */
export function dimmedLine(
  t: TFunction,
  gate: PlanGate,
  where: { edition: Edition | null; kind: MachineAccountKind; computer: string },
) {
  if (gate.state === "billing") return t("connectAi.billing");
  return gateLine(t, { gate, ...where })?.text ?? t("aiAccounts.connect.noComputer");
}

/** What a hold stops, said first on the phone: a plan's sign-in, the keys, or the team the onboarding just made. */
const HOLD_LEAD = {
  plan: "connectAi.billing",
  keys: "connectAi.key.closed",
  team: "standing.billing.teamReady",
} as const;

/**
 * The phone's words for what a billing hold stops: paying has no button or link there (ADR 0079 §6, App Store 3.1.1),
 * so whoever pays reads where, and anyone else who can.
 */
export const planHoldPhoneLine = (t: TFunction, mayPay: boolean, lead: keyof typeof HOLD_LEAD = "plan") =>
  t("common.joinSentences", {
    a: t(HOLD_LEAD[lead]),
    b: t(mayPay ? "connectAi.billingWeb" : "standing.billing.askAdmin"),
  });

/** The longest a plan's panel shows its sign-in loading while the agent's view is asked again (`catchUp`). */
export const CATCH_UP_MS = 8000;

/**
 * The workspace's computer said ready while the agent's view from before has none (`behindComputer`): the reads asked
 * again, done when they settle or after `CATCH_UP_MS`, whichever comes first, so the sign-in never loads with no end.
 */
export const catchUp = (reads: readonly Promise<unknown>[], ms = CATCH_UP_MS): Promise<void> =>
  Promise.race([Promise.allSettled(reads).then(() => undefined), new Promise<void>((done) => setTimeout(done, ms))]);

/**
 * The Cloud's computer is ready and the agent's view says it has none: a view from before it was given that computer.
 */
export const behindComputer = (s: {
  edition: Edition | null;
  setup: SetupView | null;
  brain: Pick<AgentBrain, "computer"> | undefined;
}) => s.edition === "cloud" && s.setup?.phase === "ready" && s.brain !== undefined && !s.brain.computer;

/** The option a message asked for (Jev, a card); null for `any` and `task`. */
export const choiceOfIntent = (intent: ConnectIntent | undefined): AiChoice | null =>
  intent === "claude" || intent === "chatgpt" ? intent : intent === "api_key" ? "key" : null;

/**
 * The option chosen when the picker opens: what was asked for; the API key for someone who owns no agent but may
 * add keys, or where Claude can't sign in at all (no computer); else the plan the agent it's for thinks
 * with (`plan`, `agentPlan`), else Claude.
 */
export function defaultChoice({
  intent,
  ownsAgents,
  mayAddKey,
  claudeGate,
  plan,
}: {
  intent?: ConnectIntent;
  ownsAgents: boolean;
  mayAddKey: boolean;
  claudeGate: PlanGate;
  plan?: PlanChoice | null;
}): AiChoice {
  const asked = choiceOfIntent(intent);
  if (asked) return asked;
  if (!ownsAgents && mayAddKey) return "key";
  return claudeGate.state === "missing" ? "key" : (plan ?? "claude");
}

/** "For which agent": the one asked for, else the first with no AI, else the first. */
export const firstAgent = <A extends { id: string }>(
  agents: readonly A[],
  hasAi: (id: string) => boolean,
  asked?: string,
) => agents.find((a) => a.id === asked) ?? agents.find((a) => !hasAi(a.id)) ?? agents[0];

/** A plan signs in once per agent with the same account (`LOGIN_PER_AGENT`), so it can think for all of them. */
export const signsInPerAgent = (choice: PlanChoice) =>
  // OpenCode's account is its key alone (`zen`), like a coding plan's.
  loginPerAgent(kindOf(choice), isPlanId(choice) || choice === "zen" ? choice : null);

/** A plan's row in a computer's `shares` (`AiComputer`): Claude's and ChatGPT's sign-ins, or a coding plan's key. */
export const shareOf = (choice: PlanChoice): keyof NonNullable<AiComputer["shares"]> =>
  isPlanId(choice) ? "key" : kindOf(choice);

/** One sign-in of this plan on that computer thinks for all of the viewer's agents there (protocol 29). */
export const signsInOnce = (choice: PlanChoice, computer: Pick<AiComputer, "shares"> | undefined) =>
  computer?.shares?.[shareOf(choice)] === true;

/** What an agent thinks with now: a plan, the workspace's API key (`key`), or nothing yet (null). */
export type AgentAi = AiChoice | null;

/** What an agent thinks with (`AgentAi`), from its row's brain and its state in the AI status. */
export function agentAi(agent: Pick<Agent, "brain"> | undefined, state: AiState | undefined): AgentAi {
  const brain = agent?.brain;
  if (brain?.kind === "codex") return "chatgpt";
  if (brain?.kind === "cursor") return "cursor";
  if (brain?.kind === "opencode") return "zen";
  if (brain?.kind === "grok") return "grok";
  if (brain?.kind === "antigravity") return "gemini";
  if (brain?.kind === "claude_code") return isPlanId(brain.provider) ? brain.provider : "claude";
  return state === undefined || state === "no_ai" ? null : "key";
}

/** The plan an agent's computer brain signs in with, where its Connect opens; null on the model brain. */
export function agentPlan(agent: Pick<Agent, "brain"> | undefined): PlanChoice | null {
  const ai = agentAi(agent, undefined);
  return ai === "key" ? null : ai;
}

/**
 * The plan a card's Sign in again opens on: the agent's own, where the card says its sign-in ended and the agent
 * still thinks with a plan; null otherwise (Connect an AI, at the card's step).
 */
export const signInAgainPlan = (card: Pick<NoAiCard, "signedOut">, agent: Pick<Agent, "brain"> | undefined) =>
  card.signedOut ? agentPlan(agent) : null;

/** The "For" select's choice that signs a plan in for every agent of `allAgents`. */
export const ALL_AGENTS = "all";

/**
 * "All agents" for a plan: the viewer's agents that have no AI yet, and those already on this plan (they read as
 * done), on the computer of the first with no AI (else of the first on this plan). An agent on the API key stays
 * out, since a plan makes an agent answer only its owner and one on the key may be answering the team. One on
 * another plan keeps it. Empty where the plan's account thinks for one agent there (neither one sign-in for all,
 * `sharedOn`, nor one login per agent), and below two agents, where the choice is that one agent.
 */
export function allAgents<A extends { id: string }>({
  choice,
  agents,
  aiOf,
  machineOf,
  sharedOn,
}: {
  choice: PlanChoice;
  /** The viewer's agents, in team order. */
  agents: readonly A[];
  aiOf: (agentId: string) => AgentAi;
  /** The computer an agent works on; null or undefined while it has none. */
  machineOf: (agentId: string) => string | null | undefined;
  /** One sign-in of this plan thinks for all of the viewer's agents on that computer (`signsInOnce`). */
  sharedOn?: (machineId: string | null) => boolean;
}): A[] {
  const open = agents.filter((a) => {
    const ai = aiOf(a.id);
    return ai === null || ai === choice;
  });
  const first = open.find((a) => aiOf(a.id) === null) ?? open[0];
  const machine = first ? (machineOf(first.id) ?? null) : null;
  if (!signsInPerAgent(choice) && !sharedOn?.(machine)) return [];
  const set = open.filter((a) => (machineOf(a.id) ?? null) === machine);
  return set.length >= 2 ? set : [];
}

/**
 * Whom a plan's panel is for: the agent picked or asked for, all of `set` (`allAgents`) when picked or while two or
 * more of them have no AI yet, else the first agent with no AI (`host` before the others), else the first. "All
 * agents" picked where the plan signs in once per account is that same agent. With no set it is the agent whose
 * computer the panel reads, the same for "All agents", which is on that agent's computer.
 */
export function defaultTarget<A extends { id: string }>({
  agents,
  set,
  hasAi,
  asked,
  picked,
  host,
}: {
  agents: readonly A[];
  set: readonly { id: string }[];
  hasAi: (agentId: string) => boolean;
  asked?: string;
  /** What the "For" select says (`ALL_AGENTS` or an agent's id), once someone chose. */
  picked?: string;
  /** The agent whose face asks the question (the setup's AI step): the one the panel is for, while it has no AI. */
  host?: string;
}): string | undefined {
  const first = (agents.find((a) => a.id === host && !hasAi(a.id)) ?? firstAgent(agents, hasAi))?.id;
  if (picked === ALL_AGENTS) return set.length >= 2 ? ALL_AGENTS : first;
  for (const id of [picked, asked]) if (id && agents.some((a) => a.id === id)) return id;
  if (set.filter((a) => !hasAi(a.id)).length >= 2) return ALL_AGENTS;
  return first;
}

/**
 * Every agent with an AI is the viewer's and answers only them, so someone invited now has no agent to talk to (the
 * note before inviting). False while no agent has an AI.
 */
export function onlyOwnerReplies(agents: readonly Agent[], hasAi: (agentId: string) => boolean, viewerId: string) {
  const thinking = agents.filter((a) => hasAi(a.id));
  return (
    thinking.length > 0 &&
    thinking.every((a) => a.ownerUserId === viewerId && !answersOthers(audienceOf(a), a.ownerUserId))
  );
}

/**
 * Whether every one of these agents thinks (ready, or waiting for its computer: anything but "no AI"), read alike by
 * the onboarding's AI step and the arrival (ADR 0162, ADR 0160). Undefined while the status loads, and while it
 * doesn't list one of them yet: a status read before an agent was made says nothing about that agent, so the caller
 * waits for a fresh read instead of taking it as unanswered.
 */
export const teamThinks = (agentIds: readonly string[], status: AiStatus | undefined): boolean | undefined => {
  if (status === undefined) return undefined;
  const states = agentIds.map((id) => aiStateOf(status, id));
  if (states.some((s) => s === undefined)) return undefined;
  return states.length > 0 && states.every((s) => s !== "no_ai");
};

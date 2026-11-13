import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import { matchesWords } from "@agenteschat/ui/search";
import i18next, { type TFunction } from "i18next";
import type {
  Agent,
  AgentAudience,
  AgentBrain,
  AiComputer,
  AiStatus,
  ComputerSetup,
  MachineAccount,
} from "../src/api/types";
import { setupView } from "../src/lib/computer";
import { latestText, serverBody } from "../src/lib/message-body";
import {
  type AgentAi,
  type AiChoice,
  ALL_AGENTS,
  agentAi,
  agentPlan,
  aiChoiceOf,
  allAgents,
  behindComputer,
  CLOUD_AWAY_MS,
  CLOUD_INSTALL_WAIT_MS,
  catchUp,
  defaultChoice,
  defaultTarget,
  dimmedLine,
  firstAgent,
  freePlanAccount,
  gateDims,
  gateLine,
  gateRechecks,
  keptCardState,
  kindOf,
  mayConnectAi,
  type NoAiCard,
  noAiCardOf,
  noAiLineKey,
  noAiStatusKey,
  onlyOwnerReplies,
  ownSignInFor,
  PLAN_CHOICES,
  type PlanChoice,
  type PlanGate,
  planGate,
  planGateWithoutAgent,
  planHoldOf,
  planHoldPhoneLine,
  planLineFix,
  planMark,
  planOfAccount,
  planOfKind,
  planPickText,
  signInAgainPlan,
  signsInOnce,
  signsInPerAgent,
} from "../src/lib/no-ai";
import { LOGIN_PER_AGENT, OPENCODE_KEY_PLAN, providerFitsChoice, SHARED_SIGN_INS, signInKey } from "../src/lib/plans";

const enI18n = i18next.createInstance();
void enI18n.init({ lng: "en", resources, initAsync: false });
const enT: TFunction = enI18n.t.bind(enI18n);

const setup = (patch: Partial<ComputerSetup> = {}) =>
  setupView({
    mode: "external",
    state: "preparing",
    step: "installing",
    reason: null,
    since: "2026-10-26T10:00:00.000Z",
    requestedAt: "2026-10-26T10:00:00.000Z",
    expectedReadyAt: null,
    secondsLeft: 240,
    secondsWaited: 60,
    notifyByEmail: true,
    specs: null,
    machineId: null,
    ...patch,
  });

const option = (kind: "claude_code" | "codex", over: Partial<AgentBrain["options"][number]> = {}) => ({
  kind,
  available: true,

  models: [],
  defaultModel: null,
  ...over,
});

/** Ada on the MacBook, hers: every plan can sign in there. */
const brain = (over: Partial<AgentBrain> = {}): AgentBrain => ({
  agentId: "ada",
  speed: "standard",
  brain: "model",
  model: null,
  effectiveModel: null,
  fallback: true,
  extraUsage: true,
  computer: { machineId: "m1", name: "MacBook", online: true },
  options: [option("claude_code"), option("codex")],
  machines: [],
  canEdit: true,
  account: null,
  effort: null,
  accounts: [],
  canManageAccounts: true,
  accountsSupported: true,
  onlyOwner: false,
  canUsePlans: true,
  ownSignIn: false,
  ownUsage: {},
  ...over,
});

const MAC: AiComputer = {
  machineId: "m1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};

const gate = (patch: Partial<Parameters<typeof planGate>[0]> = {}) =>
  planGate({ choice: "claude", edition: "selfhost", setup: null, brain: brain(), computer: MAC, ...patch });

describe("planGate: what a plan's panel can do now", () => {
  test("the Cloud's computer on its way (preparing, a capacity wait, a problem) waits in place, before anything loads", () => {
    for (const view of [setup(), setup({ state: "waiting", reason: "capacity" }), setup({ state: "problem" })]) {
      expect(gate({ edition: "cloud", setup: view, brain: undefined })).toEqual({ state: "preparing", view });
    }
  });

  test("the setup says ready but the agent's computer comes with the next refresh: still preparing, with no view", () => {
    const ready = setup({ state: "ready", machineId: "m1" });
    expect(gate({ edition: "cloud", setup: ready, brain: brain({ computer: null }) })).toEqual({
      state: "preparing",
      view: null,
    });
  });

  test("asked again since and still none: nothing is coming, so it's missing on the Cloud too", () => {
    const ready = setup({ state: "ready", machineId: "m1" });
    expect(gate({ edition: "cloud", setup: ready, brain: brain({ computer: null }), caughtUp: true })).toEqual({
      state: "missing",
    });
  });

  test("behindComputer: the Cloud's computer ready and the view has none", () => {
    const ready = setup({ state: "ready", machineId: "m1" });
    const none = brain({ computer: null });
    expect(behindComputer({ edition: "cloud", setup: ready, brain: none })).toBe(true);
    expect(behindComputer({ edition: "cloud", setup: ready, brain: brain() })).toBe(false);
    expect(behindComputer({ edition: "selfhost", setup: ready, brain: none })).toBe(false);
    expect(behindComputer({ edition: "cloud", setup: setup(), brain: none })).toBe(false);
  });

  test("catchUp ends when the reads settle, failed ones too, or at its limit when one never does", async () => {
    let settled = false;
    await catchUp([Promise.resolve(1), Promise.reject(new Error("down"))]).then(() => {
      settled = true;
    });
    expect(settled).toBe(true);
    const started = Date.now();
    await catchUp([new Promise(() => undefined)], 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("loading until the brain view and the edition are known", () => {
    expect(gate({ brain: undefined })).toEqual({ state: "loading" });
    expect(gate({ edition: null })).toEqual({ state: "loading" });
  });

  test("an agent the viewer doesn't own, before anything about its computer", () => {
    expect(gate({ brain: brain({ canUsePlans: false, computer: null }) })).toEqual({ state: "locked", who: "owner" });
  });

  test("self-host with no computer for the agent: missing", () => {
    expect(gate({ brain: brain({ computer: null }) })).toEqual({ state: "missing" });
  });

  test("its computer is offline", () => {
    expect(gate({ brain: brain({ computer: { machineId: "m1", name: "MacBook", online: false } }) })).toEqual({
      state: "offline",
    });
  });

  test("the plan's program isn't there, the runner is old, or the computer takes no plan key: unsupported", () => {
    const missingCodex = brain({
      options: [option("claude_code"), option("codex", { available: false, reason: "not_installed" })],
    });
    expect(gate({ choice: "chatgpt", brain: missingCodex })).toEqual({ state: "unsupported", reason: "not_installed" });
    // The same computer still takes Claude.
    expect(gate({ brain: missingCodex })).toEqual({ state: "ready" });
    // A server that gives no reason or doesn't know the plan: nothing says it's being installed.
    const unknown = brain({ options: [option("claude_code")] });
    expect(gate({ choice: "chatgpt", brain: unknown })).toEqual({ state: "unsupported", reason: "not_reported" });
    const old = brain({
      options: [option("claude_code", { available: false, reason: "runner_old" }), option("codex")],
    });
    expect(gate({ brain: old })).toEqual({ state: "unsupported", reason: "runner_old" });
    expect(gate({ brain: brain({ accountsSupported: false }) })).toEqual({
      state: "unsupported",
      reason: "runner_old",
    });
    expect(gate({ choice: "zai", computer: { ...MAC, keys: false } })).toEqual({
      state: "unsupported",
      reason: "keys",
    });
    expect(gate({ choice: "zai", computer: undefined })).toEqual({ state: "unsupported", reason: "keys" });
    expect(gate({ choice: "zai" })).toEqual({ state: "ready" });
  });

  test("someone else's connected computer: only they sign a plan in there", () => {
    expect(gate({ brain: brain({ canManageAccounts: false }) })).toEqual({ state: "locked", who: "computer" });
  });

  test("otherwise ready; only missing and unsupported dim a tile", () => {
    expect(gate()).toEqual({ state: "ready" });
    const dims: PlanGate[] = [{ state: "missing" }, { state: "unsupported", reason: "keys" }];
    expect(dims.map(gateDims)).toEqual([true, true]);
    const lit: PlanGate[] = [
      { state: "ready" },
      { state: "loading" },
      { state: "offline" },
      { state: "preparing", view: null },
      { state: "locked", who: "owner" },
    ];
    expect(lit.map(gateDims)).toEqual([false, false, false, false, false]);
  });

  test("the computer's own sign-in, to share: the person connected that computer, and its CLI is signed in there", () => {
    const signedIn: AiComputer = { ...MAC, own: { claude_code: { plan: "max" } } };
    const own = brain({ ownSignIn: true });
    expect(ownSignInFor("claude", own, signedIn)).toBe(true);
    // Claude Code isn't signed in there (or the row isn't in yet): no account to share.
    expect(ownSignInFor("claude", own, MAC)).toBe(false);
    expect(ownSignInFor("claude", own, undefined)).toBe(false);
    // ChatGPT's alike: only once the computer reports Codex's own sign-in (the usage it read with it).
    expect(ownSignInFor("chatgpt", own, signedIn)).toBe(false);
    const codex: AiComputer = { ...MAC, own: { codex: { usage: { windows: [], source: "probe", at: "2026-10-30" } } } };
    expect(ownSignInFor("chatgpt", own, codex)).toBe(true);
    // A coding plan signs in with its key; someone else's computer's sign-in is never the person's, nor is the
    // sign-in of a computer nobody connected (the workspace's), whatever it reports.
    expect(ownSignInFor("zai", own, signedIn)).toBe(false);
    expect(ownSignInFor("claude", brain({ ownSignIn: false }), signedIn)).toBe(false);
    expect(ownSignInFor("chatgpt", brain({ ownSignIn: false }), codex)).toBe(false);
    expect(ownSignInFor("claude", undefined, signedIn)).toBe(false);
  });
});

describe("the Cloud's plan gate tells the truth", () => {
  const NOW = Date.parse("2026-11-05T12:00:00Z");
  const ready = (ago: number) => setup({ state: "ready", step: null, since: new Date(NOW - ago).toISOString() });
  const noCodex = brain({
    computer: { machineId: "m1", name: "Acme", online: true },
    options: [option("claude_code"), option("codex", { available: false, reason: "not_installed" })],
  });
  const codexGate = (ago: number) =>
    planGate({ choice: "chatgpt", edition: "cloud", setup: ready(ago), brain: noCodex, computer: MAC, now: NOW });

  test("a billing hold says so first, for every plan, and offers no sign-in", () => {
    for (const choice of ["claude", "chatgpt", "cursor", "zen", "grok", "gemini", "zai"] as const) {
      const standing = { state: "hold", reason: "payment" } as const;
      expect(gate({ choice, edition: "cloud", standing })).toEqual({ state: "billing", hold: "payment" });
      expect(
        planGateWithoutAgent({ choice, edition: "cloud", setup: null, computers: undefined, standing }).gate,
      ).toEqual({ state: "billing", hold: "payment" });
    }
    expect(gateDims({ state: "billing", hold: "unpaid" })).toBe(true);
    // A review hold isn't about money, and a self-hosted server has no plan to pay.
    expect(gate({ edition: "cloud", standing: { state: "hold", reason: "review" } }).state).not.toBe("billing");
    expect(gate({ standing: { state: "hold", reason: "payment" } }).state).toBe("ready");
    expect(planHoldOf("selfhost", { state: "hold", reason: "payment" })).toBeNull();
    expect(planHoldOf("cloud", { state: "hold", reason: "ended" })).toBe("ended");
    expect(planHoldOf("cloud", { state: "active", reason: null })).toBeNull();
    // Before the edition is known a hold counts: no moment of Connect, and no answer started on a saved key.
    expect(planHoldOf(null, { state: "hold", reason: "payment" })).toBe("payment");
    expect(planHoldOf(null, { state: "active", reason: null })).toBeNull();
  });

  test("the phone's words for a hold: where to pay for whoever pays, who can for anyone else, never a link", () => {
    const t = ((key: string, o?: { a: string; b: string }) => (o ? `${o.a} ${o.b}` : key)) as unknown as TFunction;
    expect(planHoldPhoneLine(t, true)).toBe("connectAi.billing connectAi.billingWeb");
    expect(planHoldPhoneLine(t, false)).toBe("connectAi.billing standing.billing.askAdmin");
  });

  test("a kept message follows the hold first: a key saved earlier reads as ready and changes nothing", () => {
    expect(noAiCardOf({ noAi: { agentId: "a", reason: "plan_hold" } })?.held).toBe(true);
    expect(noAiCardOf({ noAi: { agentId: "a", reason: "no_key" } })?.held).toBeUndefined();
    expect(keptCardState({ hold: "payment", paid: false, ready: true })).toBe("held");
    expect(keptCardState({ hold: "payment", paid: true, ready: false })).toBe("paid");
    expect(keptCardState({ hold: null, paid: true, ready: false })).toBe("connect");
    expect(keptCardState({ hold: null, paid: false, ready: true })).toBe("answer");
  });

  test("on the phone a hold closes keys in words, with the same way out", () => {
    const t = ((key: string, o?: { a: string; b: string }) => (o ? `${o.a} ${o.b}` : key)) as unknown as TFunction;
    expect(planHoldPhoneLine(t, true, "keys")).toBe("connectAi.key.closed connectAi.billingWeb");
  });

  test("on the phone the onboarding's team waits for its plan in words, with the same way out", () => {
    const t = ((key: string, o?: { a: string; b: string }) => (o ? `${o.a} ${o.b}` : key)) as unknown as TFunction;
    expect(planHoldPhoneLine(t, true, "team")).toBe("standing.billing.teamReady connectAi.billingWeb");
    expect(planHoldPhoneLine(t, false, "team")).toBe("standing.billing.teamReady standing.billing.askAdmin");
  });

  test("a dimmed plan's rows always have words: the hold's, the computer's, or that it has none", () => {
    const where = { edition: "cloud", kind: "codex", computer: "Acme" } as const;
    expect(dimmedLine(enT, { state: "billing", hold: "payment" }, where)).toBe(enT("connectAi.billing"));
    expect(dimmedLine(enT, { state: "missing" }, { ...where, edition: "selfhost" })).toBe(
      enT("aiAccounts.connect.noComputer"),
    );
    expect(dimmedLine(enT, { state: "unsupported", reason: "not_installed" }, where)).toBe(
      gateLine(enT, { gate: { state: "unsupported", reason: "not_installed" }, ...where })?.text ?? "",
    );
  });

  test("a CLI missing from a computer ready just now may still be coming; past that it never reads as installing", () => {
    const soon = codexGate(CLOUD_INSTALL_WAIT_MS - 60_000);
    expect(soon).toEqual({ state: "unsupported", reason: "not_installed" });
    expect(gateRechecks(soon, "cloud")).toBe(true);
    const late = codexGate(CLOUD_INSTALL_WAIT_MS + 60_000);
    expect(late).toEqual({ state: "unsupported", reason: "not_installed", overdue: true });
    expect(gateRechecks(late, "cloud")).toBe(false);
    const line = cloudLine(late);
    expect(line?.text).toContain("won't change by itself");
    expect(line?.text).not.toContain("being installed");
    expect(line?.rechecks).toBe(false);
  });

  test("every plan's program gets the same honest line", () => {
    for (const kind of ["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"] as const) {
      const line = cloudLine({ state: "unsupported", reason: "not_installed", overdue: true }, kind);
      expect(line?.text).toContain("Acme");
      expect(line?.text).toContain("API key");
    }
  });

  test("a computer away past a restart stops promising it comes back by itself", () => {
    const seen = (ago: number) =>
      ({ os: "linux", mode: "system", lastSeenAt: new Date(NOW - ago).toISOString() }) as const;
    const line = (ago: number) => cloudLine({ state: "offline" }, "codex", seen(ago))?.text;
    expect(line(60_000)).toContain("reconnecting");
    expect(line(CLOUD_AWAY_MS + 60_000)).toContain("away longer");
  });

  function cloudLine(
    g: Parameters<typeof gateLine>[1]["gate"],
    kind: Parameters<typeof gateLine>[1]["kind"] = "codex",
    machine?: Parameters<typeof gateLine>[1]["machine"],
  ) {
    return gateLine(enT, { gate: g, edition: "cloud", kind, computer: "Acme", machine, now: NOW });
  }
});

describe("planGateWithoutAgent: a plan connected before its owner has any agent", () => {
  const SERVER: AiComputer = { ...MAC, machineId: "m2", name: "Servidor", mine: false };
  const at = (patch: Partial<Parameters<typeof planGateWithoutAgent>[0]> = {}) =>
    planGateWithoutAgent({ choice: "claude", edition: "selfhost", setup: null, computers: [MAC], ...patch });

  test("ready on a computer they may add accounts to, with no agent at all", () => {
    expect(at()).toEqual({ gate: { state: "ready" }, computer: MAC });
    // The first one that runs the plan, online, among those they may add to.
    const off = { ...MAC, online: false };
    const noCodex = { ...SERVER, brains: { claude_code: true, codex: false } };
    expect(at({ choice: "chatgpt", computers: [off, noCodex, SERVER] }).computer).toBe(SERVER);
    expect(at({ computers: [{ ...MAC, canAdd: false }, SERVER] }).computer).toBe(SERVER);
  });

  test("the Cloud's computer on its way waits in place; loading until the computers and the edition are known", () => {
    const view = setup();
    expect(at({ edition: "cloud", setup: view, computers: undefined })).toEqual({ gate: { state: "preparing", view } });
    expect(at({ edition: "cloud", computers: [] })).toEqual({ gate: { state: "preparing", view: null } });
    expect(at({ computers: undefined }).gate).toEqual({ state: "loading" });
    expect(at({ edition: null }).gate).toEqual({ state: "loading" });
  });

  test("never a dead end: no computer offers connecting one, and the reasons are the panel's own", () => {
    expect(at({ computers: [] }).gate).toEqual({ state: "missing" });
    expect(at({ computers: [{ ...MAC, online: false }] }).gate).toEqual({ state: "offline" });
    expect(
      at({
        choice: "chatgpt",
        computers: [{ ...MAC, brains: { claude_code: true, codex: false }, off: { codex: "not_installed" } }],
      }).gate,
    ).toEqual({ state: "unsupported", reason: "not_installed" });
    expect(at({ choice: "zai", computers: [{ ...MAC, keys: false }] }).gate).toEqual({
      state: "unsupported",
      reason: "keys",
    });
    // Someone else's computer: only they sign a plan in there. Theirs on a runner without accounts: too old.
    const theirs = { id: "m2", pairedBy: { id: "u-ana", name: "Ana" }, execAllowed: true };
    expect(at({ computers: [{ ...SERVER, canAdd: false }], machines: [theirs] }).gate).toEqual({
      state: "locked",
      who: "computer",
    });
    expect(at({ computers: [{ ...MAC, canAdd: false }] }).gate).toEqual({ state: "unsupported", reason: "runner_old" });
    // One nobody connected (the server's own) is anyone's to add to: not adding there is its runner, never a lock.
    const old = at({ computers: [{ ...SERVER, canAdd: false }], machines: [{ ...theirs, pairedBy: null }] });
    expect(old).toEqual({
      gate: { state: "unsupported", reason: "runner_old" },
      computer: { ...SERVER, canAdd: false },
    });
  });

  test("a program that can't run says the server's reason, never a guess that it's on its way", () => {
    const noClaude = { ...MAC, brains: { claude_code: false, codex: true } };
    const reasons = ["tool_off", "exec_off", "runner_old", "outdated", "not_installed", "not_reported"] as const;
    for (const reason of reasons)
      expect(at({ computers: [{ ...noClaude, off: { claude_code: reason } }] }).gate).toEqual({
        state: "unsupported",
        reason,
      });
    // An older server gives no reason: nothing says it's being installed.
    expect(at({ computers: [noClaude] }).gate).toEqual({ state: "unsupported", reason: "not_reported" });
  });

  test("a computer that never connected is offline, not a runner to update", () => {
    const paired = { ...MAC, online: false, canAdd: false };
    expect(at({ computers: [paired] })).toEqual({ gate: { state: "offline" }, computer: paired });
  });
});

describe("freePlanAccount: a plan account of theirs that thinks for one more agent", () => {
  const account = (over: Partial<MachineAccount> = {}): MachineAccount => ({
    id: "a1",
    kind: "claude_code",
    label: "Claude",
    email: null,
    plan: null,
    status: "active",
    ownerId: "u1",
    ownerName: "Ana",
    mine: true,
    usedBy: [],
    usage: null,
    provider: null,
    keyHint: null,
    ...over,
  });
  test("theirs, signed in, free or shared, of that plan", () => {
    expect(freePlanAccount([account()], "claude")?.id).toBe("a1");
    expect(freePlanAccount([account({ usedBy: ["Lia"], shared: true })], "claude")?.id).toBe("a1");
    expect(freePlanAccount([account({ usedBy: ["Lia"] })], "claude")).toBeUndefined();
    expect(freePlanAccount([account({ status: "signed_out" })], "claude")).toBeUndefined();
    expect(freePlanAccount([account({ mine: false })], "claude")).toBeUndefined();
    expect(freePlanAccount([account()], "chatgpt")).toBeUndefined();
    expect(freePlanAccount([account({ provider: "zai" })], "claude")).toBeUndefined();
    expect(freePlanAccount(undefined, "claude")).toBeUndefined();
  });
});

describe("defaultChoice: what the picker opens on", () => {
  const ready: PlanGate = { state: "ready" };
  test("an intent picks its option", () => {
    const picks: [Parameters<typeof defaultChoice>[0]["intent"], AiChoice][] = [
      ["claude", "claude"],
      ["chatgpt", "chatgpt"],
      ["api_key", "key"],
      ["any", "claude"],
      ["task", "claude"],
    ];
    for (const [intent, choice] of picks) {
      expect(defaultChoice({ intent, ownsAgents: true, mayAddKey: true, claudeGate: ready })).toBe(choice);
    }
  });

  test("the key for someone who owns no agent but may add keys, and where Claude can't sign in at all", () => {
    expect(defaultChoice({ ownsAgents: false, mayAddKey: true, claudeGate: ready })).toBe("key");
    expect(defaultChoice({ ownsAgents: true, mayAddKey: true, claudeGate: { state: "missing" } })).toBe("key");
  });

  test("Claude otherwise, even while its computer is prepared or the person may not add keys", () => {
    expect(defaultChoice({ ownsAgents: false, mayAddKey: false, claudeGate: ready })).toBe("claude");
    expect(
      defaultChoice({ ownsAgents: true, mayAddKey: true, claudeGate: { state: "preparing", view: setup() } }),
    ).toBe("claude");
  });

  test("for one agent on a plan brain, its own plan (`agentPlan`) instead of Claude; what was asked still wins", () => {
    const on = (kind: "claude_code" | "codex" | "model", provider?: string): Pick<Agent, "brain"> => ({
      brain: { kind, model: null, ...(provider ? { provider } : {}) },
    });
    expect([on("codex"), on("claude_code"), on("claude_code", "kimi"), on("model"), undefined].map(agentPlan)).toEqual([
      "chatgpt",
      "claude",
      "kimi",
      null,
      null,
    ]);
    const plan = agentPlan(on("codex"));
    expect(defaultChoice({ ownsAgents: true, mayAddKey: true, claudeGate: ready, plan })).toBe("chatgpt");
    expect(defaultChoice({ intent: "api_key", ownsAgents: true, mayAddKey: true, claudeGate: ready, plan })).toBe(
      "key",
    );
    expect(defaultChoice({ ownsAgents: true, mayAddKey: true, claudeGate: { state: "missing" }, plan })).toBe("key");
  });
});

describe("the agent a plan starts on, and the order of the plans", () => {
  const agents = [{ id: "ada" }, { id: "theo" }, { id: "lia" }];
  test("the one asked for, then the first with no AI, then the first", () => {
    expect(firstAgent(agents, () => true, "lia")?.id).toBe("lia");
    expect(firstAgent(agents, (id) => id === "ada")?.id).toBe("theo");
    expect(firstAgent(agents, () => true)?.id).toBe("ada");
    expect(firstAgent(agents, () => false, "someone-else")?.id).toBe("ada");
    expect(firstAgent([], () => false)).toBeUndefined();
  });

  test("Claude, ChatGPT, Gemini, Grok, Cursor, OpenCode, then the coding plans; ChatGPT signs in through Codex, the others through their own CLIs", () => {
    expect(PLAN_CHOICES).toEqual([
      "claude",
      "chatgpt",
      "gemini",
      "grok",
      "cursor",
      "zen",
      "zai",
      "kimi",
      "minimax",
      "opencode",
    ]);
    expect(PLAN_CHOICES.map((c: PlanChoice) => kindOf(c))).toEqual([
      "claude_code",
      "codex",
      "antigravity",
      "grok",
      "cursor",
      "opencode",
      "claude_code",
      "claude_code",
      "claude_code",
      "claude_code",
    ]);
  });

  test("a search finds a plan by the CLI it thinks through, in any case", () => {
    const found = (q: string) => PLAN_CHOICES.filter((c) => matchesWords(planPickText(enT, c), q));
    expect(found("codex")).toEqual(["chatgpt"]);
    expect(found("CODEX")).toEqual(["chatgpt"]);
    expect(found("claude code")).toEqual(["claude"]);
    expect(found("Gemini CLI")).toEqual(["gemini"]);
    expect(found("antigravity")).toEqual(["gemini"]);
    expect(found("grok build")).toEqual(["grok"]);
  });
});

describe("All agents: one login per agent, the key pasted once", () => {
  test("every plan signs in once per agent, ChatGPT's and Cursor's too", () => {
    expect(LOGIN_PER_AGENT).toEqual({ claude_code: true, codex: true, cursor: true, key: true });
    expect(PLAN_CHOICES.filter(signsInPerAgent)).toEqual([...PLAN_CHOICES]);
  });

  /** Ada and Theo have no AI, Lia is on GLM Coding, Bo on the API key, Cy on Claude, Di on the other computer. */
  const team = ["ada", "theo", "lia", "bo", "cy", "di"].map((id) => ({ id }));
  const ai: Record<string, AgentAi> = { ada: null, theo: null, lia: "zai", bo: "key", cy: "claude", di: null };
  const machines: Record<string, string> = { di: "m2" };
  const set = (choice: PlanChoice, agents = team, aiOf = (id: string) => ai[id] ?? null) =>
    allAgents({ choice, agents, aiOf, machineOf: (id) => machines[id] ?? "m1" }).map((a) => a.id);

  test("the agents with no AI on the first one's computer and those on this plan; never one on the key or another plan", () => {
    expect(set("zai")).toEqual(["ada", "theo", "lia"]);
    expect(set("kimi")).toEqual(["ada", "theo"]);
    // The first one's computer decides: with Di first, Di's, where nobody else fits.
    expect(set("zai", [...team.filter((a) => a.id === "di"), ...team.filter((a) => a.id !== "di")])).toEqual([]);
    // No computer yet (the Cloud's on its way) is one place for all of them.
    expect(
      allAgents({ choice: "zai", agents: team, aiOf: () => null, machineOf: () => null }).map((a) => a.id),
    ).toEqual(["ada", "theo", "lia", "bo", "cy", "di"]);
  });

  test("Claude's and ChatGPT's like a coding plan's, and none for a single agent", () => {
    expect(set("claude")).toEqual(["ada", "theo", "cy"]);
    expect(set("chatgpt")).toEqual(["ada", "theo"]);
    expect(set("zai", [{ id: "ada" }, { id: "bo" }])).toEqual([]);
  });

  test("one sign-in for all of them where the computer says so: ChatGPT's too", () => {
    // Where each agent is its own OS user, Claude's and ChatGPT's sign-ins and plans' keys think for all.
    expect(SHARED_SIGN_INS).toEqual({ claude_code: true, codex: true, key: true });
    const sharing = { shares: { claude_code: true, codex: true, key: true } };
    expect(signsInOnce("chatgpt", sharing)).toBe(true);
    expect(signsInOnce("zai", { shares: { claude_code: true, codex: false, key: false } })).toBe(false);
    expect(signsInOnce("claude", undefined)).toBe(false);
    const sharedOn = (id: string | null) => id === "m1";
    const once = (choice: PlanChoice) =>
      allAgents({
        choice,
        agents: team,
        aiOf: (id) => ai[id] ?? null,
        machineOf: (id) => machines[id] ?? "m1",
        sharedOn,
      }).map((a) => a.id);
    expect(once("chatgpt")).toEqual(["ada", "theo"]);
    // Elsewhere ChatGPT's signs in once per agent, as Claude's.
    expect(
      allAgents({ choice: "chatgpt", agents: team, aiOf: (id) => ai[id] ?? null, machineOf: () => "m2", sharedOn }).map(
        (a) => a.id,
      ),
    ).toEqual(["ada", "theo", "di"]);
  });

  test("the panel opens on the agent asked for, then all of them while two have no AI, then the first with no AI", () => {
    const agents = team;
    const all = allAgents({
      choice: "zai",
      agents,
      aiOf: (id) => ai[id] ?? null,
      machineOf: (id) => machines[id] ?? "m1",
    });
    const hasAi = (id: string) => ai[id] !== null;
    expect(defaultTarget({ agents, set: all, hasAi, asked: "theo" })).toBe("theo");
    expect(defaultTarget({ agents, set: all, hasAi })).toBe(ALL_AGENTS);
    expect(defaultTarget({ agents, set: all, hasAi, asked: "someone-else" })).toBe(ALL_AGENTS);
    // One left with no AI, or no set at all (Claude): the first with no AI.
    expect(defaultTarget({ agents, set: all, hasAi: (id) => id !== "theo" })).toBe("theo");
    expect(defaultTarget({ agents, set: [], hasAi })).toBe("ada");
    expect(defaultTarget({ agents: [], set: [], hasAi })).toBeUndefined();
  });

  test("the agent whose face asks comes before the first with no AI, while it has none; All agents still comes first", () => {
    const hasAi = (id: string) => ai[id] !== null;
    const zai = allAgents({ choice: "zai", agents: team, aiOf: (id) => ai[id] ?? null, machineOf: () => "m1" });
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "theo" })).toBe("theo");
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "di" })).toBe("di");
    // Once it has an AI, the next plan goes to the first with none.
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "lia" })).toBe("ada");
    expect(defaultTarget({ agents: team, set: zai, hasAi, host: "theo" })).toBe(ALL_AGENTS);
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "theo", picked: ALL_AGENTS })).toBe("theo");
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "theo", picked: "ada" })).toBe("ada");
  });

  test("a pick holds while the plan allows it: All agents elsewhere is the first with no AI", () => {
    const hasAi = (id: string) => ai[id] !== null;
    const zai = allAgents({ choice: "zai", agents: team, aiOf: (id) => ai[id] ?? null, machineOf: () => "m1" });
    expect(defaultTarget({ agents: team, set: zai, hasAi, asked: "theo", picked: ALL_AGENTS })).toBe(ALL_AGENTS);
    expect(defaultTarget({ agents: team, set: [], hasAi, asked: "theo", picked: ALL_AGENTS })).toBe("ada");
    expect(defaultTarget({ agents: team, set: zai, hasAi, asked: "theo", picked: "lia" })).toBe("lia");
    // With no set, whose computer the panel reads: the first with no AI, where All agents is too.
    expect(defaultTarget({ agents: team, set: [], hasAi, picked: ALL_AGENTS })).toBe("ada");
    expect(zai[0]?.id).toBe("ada");
  });

  test("the set is on the first with no AI's computer, even after one on this plan", () => {
    const agents = [{ id: "lia" }, { id: "ada" }, { id: "theo" }];
    const aiOf = (id: string): AgentAi => (id === "lia" ? "zai" : null);
    const machineOf = (id: string) => (id === "lia" ? "m2" : "m1");
    expect(allAgents({ choice: "zai", agents, aiOf, machineOf }).map((a) => a.id)).toEqual(["ada", "theo"]);
  });

  test("what an agent thinks with, from its row and its AI status", () => {
    expect(agentAi({ brain: { kind: "codex", model: null } }, "ready")).toBe("chatgpt");
    expect(agentAi({ brain: { kind: "claude_code", model: null } }, "no_ai")).toBe("claude");
    expect(agentAi({ brain: { kind: "claude_code", model: null, provider: "zai" } }, "ready")).toBe("zai");
    expect(agentAi({ brain: { kind: "model", model: null } }, "ready")).toBe("key");
    expect(agentAi({ brain: { kind: "grok", model: null } }, "ready")).toBe("grok");
    expect([planOfKind("grok"), planMark("grok")]).toEqual(["grok", "grok"]);
    expect(agentAi({ brain: { kind: "antigravity", model: null } }, "ready")).toBe("gemini");
    expect([planOfKind("antigravity"), planMark("gemini"), kindOf("gemini")]).toEqual([
      "gemini",
      "gemini",
      "antigravity",
    ]);
    // A Gemini Enterprise seat is an account of the Gemini plan, as a personal Google one; a coding plan, its key's.
    expect(providerFitsChoice("enterprise", "gemini", false)).toBe(true);
    expect(providerFitsChoice(null, "gemini", false)).toBe(true);
    expect(providerFitsChoice("zai", "claude", false)).toBe(false);
    expect(providerFitsChoice("zai", "zai", true)).toBe(true);
    expect(agentAi({ brain: { kind: "model", model: null } }, "no_ai")).toBeNull();
    expect(agentAi(undefined, undefined)).toBeNull();
  });

  test("what its Quem pensa says pays: the API key, or the plan of the account it thinks with", () => {
    const opencode = { id: "a_oc", kind: "claude_code", provider: "opencode" } as AgentBrain["accounts"][number];
    expect(aiChoiceOf({ brain: "model", account: null, accounts: [] })).toBe("key");
    expect(aiChoiceOf({ brain: "codex", account: null, accounts: [] })).toBe("chatgpt");
    expect(aiChoiceOf({ brain: "claude_code", account: "a_oc", accounts: [opencode] })).toBe("opencode");
    // The computer's own sign-in is Claude's, whatever keys are there.
    expect(aiChoiceOf({ brain: "claude_code", account: null, accounts: [opencode] })).toBe("claude");
  });
});

describe("the note before inviting: no agent would answer anyone else", () => {
  const ME = "u_ana";
  const ONLY_ME: AgentAudience = { mode: "owner", userIds: [] };
  const agent = (id: string, audience: AgentAudience, ownerUserId: string | null = ME): Agent => ({
    id,
    name: id,
    handle: id,
    role: "",
    instructions: "",
    model: "auto",
    ownerUserId,
    hasCredential: false,
    createdAt: "2026-10-27T10:00:00.000Z",
    audience,
  });
  const everyone: AgentAudience = { mode: "everyone", userIds: [] };

  test("every agent with an AI is mine and answers only me", () => {
    const team = [agent("ada", ONLY_ME), agent("theo", ONLY_ME), agent("lia", everyone)];
    // Lia has no AI yet: she answers nobody, whatever her audience says.
    expect(onlyOwnerReplies(team, (id) => id !== "lia", ME)).toBe(true);
  });

  test("not while one on the API key answers everyone, one answers some people, or someone else's agent thinks", () => {
    const hasAi = () => true;
    expect(onlyOwnerReplies([agent("ada", ONLY_ME), agent("bo", everyone)], hasAi, ME)).toBe(false);
    expect(
      onlyOwnerReplies([agent("ada", ONLY_ME), agent("bo", { mode: "people", userIds: ["u_bia"] })], hasAi, ME),
    ).toBe(false);
    expect(onlyOwnerReplies([agent("ada", ONLY_ME), agent("bo", ONLY_ME, "u_bia")], hasAi, ME)).toBe(false);
  });

  test("not while no agent has an AI", () => {
    expect(onlyOwnerReplies([agent("ada", ONLY_ME)], () => false, ME)).toBe(false);
    expect(onlyOwnerReplies([], () => true, ME)).toBe(false);
  });
});

describe("a card whose plan's sign-in ended", () => {
  const meta = (reason: string) => ({
    bodyCode: "no_ai",
    noAi: { agentId: "ada", forUserId: null, reason, intent: "task", runId: "r1" },
  });

  test("the agent says its AI is signed out, not that it has none", () => {
    expect(noAiCardOf(meta("not_signed_in"))?.signedOut).toBe(true);
    expect(noAiCardOf(meta("no_key"))?.signedOut).toBeUndefined();
    const t = ((key: string) => key) as unknown as TFunction;
    expect(serverBody(t, "…", meta("not_signed_in"))).toBe("chat.body.no_ai_signed_out");
    expect(serverBody(t, "…", meta("no_key"))).toBe("chat.body.no_ai");
  });

  test("Sign in again opens on the agent's own plan; with no plan left to sign in to, Connect at the card's step", () => {
    const out = { signedOut: true };
    const on = (kind: "claude_code" | "codex" | "model", provider?: string): Pick<Agent, "brain"> => ({
      brain: { kind, model: null, ...(provider ? { provider } : {}) },
    });
    expect(signInAgainPlan(out, on("claude_code"))).toBe("claude");
    expect(signInAgainPlan(out, on("codex"))).toBe("chatgpt");
    expect(signInAgainPlan(out, on("claude_code", "zai"))).toBe("zai");
    expect(signInAgainPlan(out, on("model"))).toBeNull();
    expect(signInAgainPlan(out, undefined)).toBeNull();
    expect(signInAgainPlan({}, on("codex"))).toBeNull();
  });

  test("the computer's own sign-in isn't there: its own card, Connect on that CLI's plan, never Sign in again", () => {
    const own = (cli: string) => ({ ...meta("not_signed_in"), noAi: { ...meta("not_signed_in").noAi, own: cli } });
    const card = noAiCardOf(own("codex"));
    expect(card?.own).toBe("codex");
    expect(card?.signedOut).toBeUndefined();
    expect(signInAgainPlan(card ?? {}, { brain: { kind: "codex", model: null } })).toBeNull();
    expect(noAiCardOf(own("claude_code"))?.own).toBe("claude_code");
    expect([planOfKind("codex"), planOfKind("claude_code")]).toEqual(["chatgpt", "claude"]);
    // Only with `not_signed_in`, and only a CLI it knows: anything else stays the card it was.
    expect(noAiCardOf(own("gemini"))).toMatchObject({ signedOut: true });
    expect(noAiCardOf({ ...meta("no_key"), noAi: { ...meta("no_key").noAi, own: "codex" } })?.own).toBeUndefined();
    // Its line, above the card and in the lists' previews (`previewMeta` keeps `own`): that CLI isn't signed in
    // there, never that a sign-in ended.
    const t = ((key: string, o?: { brain?: string }) => `${key}:${o?.brain ?? ""}`) as unknown as TFunction;
    expect(serverBody(t, "…", own("codex"))).toBe("chat.body.no_ai_not_signed_in:Codex");
    expect(serverBody(t, "…", { bodyCode: "no_ai", noAi: { reason: "not_signed_in", own: "claude_code" } })).toBe(
      "chat.body.no_ai_not_signed_in:Claude Code",
    );
    expect(serverBody(t, "…", own("gemini"))).toBe("chat.body.no_ai_signed_out:");
  });
});

describe("Cursor (ADR 0114): a plan of its own, signed in through its CLI", () => {
  test("its accounts and agents read as Cursor's plan, signed in once per agent, and a signed-out CLI names Cursor", () => {
    expect(planOfKind("cursor")).toBe("cursor");
    expect(planOfAccount({ kind: "cursor", provider: null })).toBe("cursor");
    // An account made with a Cursor API key is still Cursor's plan.
    expect(planOfAccount({ kind: "cursor", provider: "cursor" })).toBe("cursor");
    expect(agentAi({ brain: { kind: "cursor", model: null } }, "ready")).toBe("cursor");
    expect(signsInPerAgent("cursor")).toBe(true);
    const t = ((key: string, o?: { brain?: string }) => `${key}:${o?.brain ?? ""}`) as unknown as TFunction;
    expect(serverBody(t, "…", { bodyCode: "no_ai", noAi: { reason: "not_signed_in", own: "cursor" } })).toBe(
      "chat.body.no_ai_not_signed_in:Cursor",
    );
  });
});

describe("OpenCode (ADR 0132): its free tier or its key, through its own CLI", () => {
  test("its accounts and agents read as OpenCode, its mark is OpenCode's, a key thinks for several agents", () => {
    expect(planOfKind("opencode")).toBe("zen");
    expect(planOfAccount({ kind: "opencode", provider: "zen" })).toBe("zen");
    // OpenCode Go's key on Claude Code stays the coding plan.
    expect(planOfAccount({ kind: "claude_code", provider: "opencode" })).toBe("opencode");
    expect(agentAi({ brain: { kind: "opencode", model: null } }, "ready")).toBe("zen");
    expect(planMark("zen")).toBe("opencode");
    expect(signsInPerAgent("zen")).toBe(true);
    expect(signInKey(undefined, "opencode", false)).toEqual({ plan: OPENCODE_KEY_PLAN, provider: "zen" });
    const t = ((key: string, o?: { brain?: string }) => `${key}:${o?.brain ?? ""}`) as unknown as TFunction;
    expect(serverBody(t, "…", { bodyCode: "no_ai", noAi: { reason: "not_signed_in", own: "opencode" } })).toBe(
      "chat.body.no_ai_not_signed_in:OpenCode",
    );
  });
});

describe("why a plan can't sign in yet, in plain words (`gateLine`)", () => {
  const instance = i18next.createInstance();
  void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
  const pt = instance.t.bind(instance) as TFunction;
  const computer = "Computador da Acme";
  const line = (gate: PlanGate, edition: "cloud" | "selfhost", kind: "claude_code" | "codex" = "codex") =>
    gateLine(pt, { gate, edition, kind, computer, machine: { os: "linux", mode: "single" } });
  const off = (reason: Extract<PlanGate, { state: "unsupported" }>["reason"]) =>
    ({ state: "unsupported", reason }) as const;

  test("on the Cloud each reason says what the computer is doing, and that it comes back by itself", () => {
    expect(line(off("not_installed"), "cloud")).toEqual({
      text: "O Codex está sendo instalado no Computador da Acme. Isto muda sozinho quando terminar.",
      rechecks: true,
    });
    expect(line(off("outdated"), "cloud")).toEqual({
      text: "O Codex está sendo atualizado no Computador da Acme. Isto muda sozinho quando terminar.",
      rechecks: true,
    });
    const runner =
      "O programa do agentes.chat no Computador da Acme está desatualizado e a atualização já está a caminho. Isto muda sozinho quando ela terminar.";
    expect(line(off("runner_old"), "cloud")).toEqual({ text: runner, rechecks: true });
    expect(line(off("keys"), "cloud")).toEqual({ text: runner, rechecks: true });
    expect(line(off("exec_off"), "cloud", "claude_code")).toEqual({
      text: "O Computador da Acme ainda não consegue rodar o Claude Code. Já estamos cuidando, e isto muda sozinho.",
      rechecks: true,
    });
    expect(line(off("no_computer"), "cloud")?.text).toBe(
      "O Computador da Acme está ficando pronto. Isto muda sozinho quando terminar.",
    );
    expect(line({ state: "offline" }, "cloud")).toEqual({
      text: "O Computador da Acme está reiniciando ou se reconectando. Isto muda sozinho quando ele voltar.",
      rechecks: true,
    });
  });

  test("a program not allowed there says it's on our side, and looks again only when asked", () => {
    expect(line(off("tool_off"), "cloud")).toEqual({
      text: "O Codex ainda não está liberado no Computador da Acme. Isso é do nosso lado: tente de novo mais tarde.",
      rechecks: false,
    });
  });

  test("no Cloud line is the old generic one, and every reason has its own key", () => {
    const reasons = [
      "no_computer",
      "exec_off",
      "runner_old",
      "tool_off",
      "not_installed",
      "outdated",
      "not_reported",
      "keys",
    ] as const;
    for (const r of reasons) {
      const text = line(off(r), "cloud")?.text ?? "";
      expect(text).not.toContain("Ainda não está pronto");
      expect(text).not.toContain("aiAccounts.");
    }
  });

  test("a computer that hasn't said what it has reads as looking, on any setup, and asks again", () => {
    const looking = { text: pt("brain.reasons.not_reported", { computer }), rechecks: true };
    expect(looking.text).not.toContain("instal");
    expect(line(off("not_reported"), "cloud")).toEqual(looking);
    expect(line(off("not_reported"), "selfhost")).toEqual(looking);
    // Past the wait it says nothing is coming, with the other ways on.
    const late = { state: "unsupported", reason: "not_reported", overdue: true } as const;
    expect(line(late, "cloud")?.text).toBe(pt("aiAccounts.connect.needsCloud.stuck", { computer, program: "Codex" }));
    expect(line(late, "cloud")?.rechecks).toBe(false);
  });

  test("the Cloud's computer that never reached the agent offers no computer to connect: nobody connects one there", () => {
    const text = pt("aiAccounts.connect.needsCloud.stuck", { computer, program: "Codex" });
    expect(line({ state: "missing" }, "cloud")).toEqual({ text, rechecks: false });
    expect(line({ state: "missing" }, "selfhost")).toBeNull();
  });

  test("a workspace on hold says the hold, not what the computer would be doing", () => {
    const say = (gate: PlanGate) => gateLine(pt, { gate, edition: "cloud", kind: "codex", computer, hold: "On hold" });
    for (const gate of [off("not_installed"), off("not_reported"), { state: "offline" } as const])
      expect(say(gate)).toEqual({ text: "On hold", rechecks: false });
    expect(say({ state: "ready" })).toBeNull();
  });

  test("self-host keeps its reasons, with the way to allow a program on the person's own computer", () => {
    expect(line(off("not_installed"), "selfhost")).toEqual({
      text: "O Codex não está instalado no Computador da Acme.",
      rechecks: false,
    });
    expect(line(off("tool_off"), "selfhost")?.text).toContain("agentes-runner tools enable codex");
    expect(line(off("keys"), "selfhost")?.text).toBe(pt("aiAccounts.connect.needs.keys"));
    expect(line({ state: "offline" }, "selfhost")).toEqual({
      text: pt("brain.offline", { computer }),
      rechecks: true,
    });
  });

  test("any other gate has no line", () => {
    for (const gate of [{ state: "ready" }, { state: "loading" }] as const) expect(line(gate, "cloud")).toBeNull();
    expect(gateRechecks({ state: "locked", who: "computer" }, "cloud")).toBe(false);
  });
});

describe("a card says the real cause, not that the agent has no AI", () => {
  const instance = i18next.createInstance();
  void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
  const pt = instance.t.bind(instance) as TFunction;
  const meta = (reason: string, extra: Record<string, unknown> = {}) => ({
    bodyCode: "no_ai",
    noAi: { agentId: "ada", forUserId: null, reason, intent: "task", runId: "r1", ...extra },
  });
  const card = (reason: string, extra?: Record<string, unknown>) => noAiCardOf(meta(reason, extra));

  test("Connect is for who can: the agent's owner, who manages agents or keys, nobody else", () => {
    const agent = { ownerUserId: "u1" };
    expect(mayConnectAi(agent, "u1", { permissions: [] })).toBe(true);
    expect(mayConnectAi(agent, "u2", { permissions: ["manage_agents"] })).toBe(true);
    expect(mayConnectAi(agent, "u2", { permissions: ["manage_credentials"] })).toBe(true);
    expect(mayConnectAi(agent, "u2", { permissions: ["post"] })).toBe(false);
    expect(mayConnectAi(null, null, { permissions: [] })).toBe(false);
    // The right hand: any member, for their own plan.
    const lodi = { ownerUserId: "u1", builtin: "right_hand" as const };
    expect(mayConnectAi(lodi, "u2", { permissions: [] })).toBe(true);
    expect(mayConnectAi(lodi, null, { permissions: [] })).toBe(false);
    expect(planLineFix("plan_not_shared", lodi, "u1", { permissions: [] })).toBe("connectMine");
    expect(planLineFix("plan_limit", lodi, "u1", { permissions: [] })).toBe("useKey");
    expect(planLineFix("plan_limit", lodi, "u2", { permissions: ["manage_agents"] })).toBe("useKey");
    expect(planLineFix("plan_limit", lodi, "u2", { permissions: [] })).toBe("connectMine");
    expect(planLineFix("plan_limit", null, "u2", { permissions: [] })).toBeNull();
  });

  test("its computer with no such CLI, or no computer: the card and the agent's note each say so", () => {
    expect(card("cli_missing")?.missing).toBe("cli_missing");
    expect(card("no_computer")?.missing).toBe("no_computer");
    expect(card("no_key")?.missing).toBeUndefined();
    expect(pt(noAiLineKey(card("cli_missing") as NoAiCard), { name: "Ada" })).toBe(
      "Ada não vai responder: o programa da IA não está instalado no computador.",
    );
    expect(pt(noAiLineKey(card("no_computer") as NoAiCard), { name: "Ada" })).toBe(
      "Ada não vai responder: a IA precisa de um computador e não há nenhum.",
    );
    expect(noAiLineKey(card("no_key") as NoAiCard)).toBe("noAi.agent");
    expect(noAiLineKey(card("not_signed_in") as NoAiCard)).toBe("noAi.signedOut");
    const status = (reason: AiStatus["agents"][number]["reason"]) =>
      noAiStatusKey({ any: true, agents: [{ agentId: "a", state: "no_ai", reason }] }, "a");
    expect(status("cli_missing")).toBe("noAi.cliMissing");
    expect(status("not_signed_in")).toBe("noAi.signedOut");
    expect(status("no_key")).toBe("noAi.agent");
    expect(serverBody(pt, "…", meta("cli_missing"))).toBe(
      "Ainda não consigo responder: o programa da minha IA não está instalado no meu computador.",
    );
    expect(serverBody(pt, "…", meta("no_computer"))).toBe(
      "Ainda não consigo responder: minha IA precisa de um computador e não tenho nenhum.",
    );
  });

  test("the right hand: a model's own limit or region, and commands off, each with its cause", () => {
    expect(card("model_limit", { model: "Kimi K2" })).toMatchObject({ planLine: "model_limit", model: "Kimi K2" });
    expect(pt("noAi.rightHand.model_limit", { name: "Lodi", model: "Kimi K2" })).toBe(
      "Lodi não consegue responder agora: o Kimi K2 chegou ao limite dele no plano. Os outros modelos do plano continuam funcionando.",
    );
    expect(serverBody(pt, "…", meta("model_limit", { model: "Kimi K2" }))).toBe(
      "Agora não consigo responder: o Kimi K2 chegou ao limite dele no meu plano.",
    );
    expect(serverBody(pt, "…", meta("model_region", { model: "GLM 5" }))).toBe(
      "Não consigo responder: o GLM 5 precisa da região Global ligada no OpenCode (Settings\u00a0›\u00a0Privacy).",
    );
    expect(card("commands_off")?.planLine).toBe("commands_off");
    expect(serverBody(pt, "…", meta("commands_off"))).toBe(
      "Agora não consigo responder: os comandos estão desligados no computador do meu plano.",
    );
  });

  test("the right hand's run nobody asked for never says to connect your plan: only a key, for who sets its AI", () => {
    expect(card("plan_unattended")?.planLine).toBe("plan_unattended");
    expect(pt("noAi.rightHand.plan_unattended", { name: "Bento" })).toBe(
      "Bento não respondeu: o pedido não veio de uma pessoa, e o plano do workspace só atende o próprio dono.",
    );
    expect(serverBody(pt, "…", meta("plan_unattended"))).toBe(
      "Não respondi: o pedido não veio de uma pessoa, e o plano do workspace só atende o próprio dono.",
    );
    const rightHand = { ownerUserId: "u1", builtin: "right_hand" as const };
    expect(planLineFix("plan_unattended", rightHand, "u1", { permissions: [] })).toBe("useKey");
    expect(planLineFix("plan_unattended", rightHand, "u2", { permissions: ["manage_agents"] })).toBe("useKey");
    // A member's own plan never answers it: no Connect for them.
    expect(planLineFix("plan_unattended", rightHand, "u2", { permissions: [] })).toBeNull();
  });

  test("a wait that doesn't pass by itself names its cause and who fixes it", () => {
    const wait = (code: string) => ({
      bodyCode: "brain_unavailable",
      bodyParams: { brain: "Codex" },
      brainUnavailable: { brain: "codex", code, machineId: "m1", agentId: "ada" },
    });
    expect(serverBody(pt, "…", wait("machine_paused"))).toBe(
      "O computador em que o Codex roda está pausado. Respondo quando ele for retomado.",
    );
    for (const code of ["exec_disabled", "tool_off"])
      expect(serverBody(pt, "…", wait(code))).toBe(
        "O Codex está desligado no meu computador. Respondo quando quem cuida dele ligar.",
      );
    for (const code of ["runner_outdated", "codex_too_old"])
      expect(serverBody(pt, "…", wait(code))).toBe(
        "O programa no meu computador precisa ser atualizado para o Codex responder. Respondo assim que ele for atualizado.",
      );
    expect(serverBody(pt, "…", wait("plan_not_owner"))).toBe(
      "O Codex pensaria com um plano que não é do meu dono, então não uso. Conecte a conta do meu dono na minha página.",
    );
    // Its computer gone still waits for it to come back.
    expect(serverBody(pt, "…", wait("machine_offline"))).toBe(
      "O Codex não está disponível agora. Respondo quando ele voltar.",
    );
  });
});

describe("a notification of a body the server wrote", () => {
  const instance = i18next.createInstance();
  void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });

  test("reads in the person's language; a person's own words stay as they came", () => {
    const text = "I can't answer yet: I have no AI connected.";
    expect(latestText(instance.t, { text, meta: { bodyCode: "no_ai", noAi: { reason: "none" } } })).toBe(
      "Ainda não consigo responder: não tenho uma IA conectada.",
    );
    expect(latestText(instance.t, { text: "olha isso" })).toBe("olha isso");
    expect(latestText(instance.t, {})).toBeUndefined();
  });
});

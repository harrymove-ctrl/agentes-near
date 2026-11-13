import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentBrainLine, AiAccounts, AiComputer, AiStatus, PlanAccountUsage, PlanUsage } from "../src/api/types";
import {
  accountOwner,
  accountShares,
  groupUsageAccounts,
  ownPlanLines,
  planMeterText,
  SHARES_SHOWN,
  shareFacts,
  splitUsage,
  usageShown,
  workspaceUsesApi,
} from "../src/lib/plan-usage";

const usage = (windows: PlanUsage["windows"]): PlanUsage => ({
  windows,
  source: "turn",
  at: "2026-10-30T12:00:00.000Z",
});
const HOURS = usage([{ kind: "five_hour", usedPercent: 12 }]);
const onPlan = (over: Partial<AgentBrainLine> = {}): AgentBrainLine => ({
  kind: "claude_code",
  model: "Sonnet",
  account: "Claude Team",
  usage: HOURS,
  ...over,
});

describe("what an agent's usage shows where its budget did (ADR 0063 §5)", () => {
  test("on a plan: its account's limits, and no budget while it spent nothing through the API", () => {
    expect(usageShown(onPlan(), 0)).toEqual({ plan: { account: "Claude Team", usage: HOURS }, budget: false });
    expect(usageShown(onPlan({ kind: "codex", account: "ChatGPT Plus" }), 0).plan?.account).toBe("ChatGPT Plus");
  });

  test("on the API: its budget, even at 0%", () => {
    expect(usageShown({ kind: "model" }, 0)).toEqual({ plan: null, budget: true });
    expect(usageShown(undefined, 41.5)).toEqual({ plan: null, budget: true });
  });

  test("a plan that also spent through the API (its fallback, or the workspace's model this month): both", () => {
    expect(usageShown(onPlan(), 3.5)).toEqual({ plan: { account: "Claude Team", usage: HOURS }, budget: true });
  });

  test("no window known yet: no limits rather than 0%", () => {
    expect(usageShown(onPlan({ usage: undefined }), 0)).toEqual({ plan: null, budget: false });
    expect(usageShown(onPlan({ usage: usage([]) }), 0)).toEqual({ plan: null, budget: false });
    expect(usageShown(onPlan({ usage: undefined }), 2)).toEqual({ plan: null, budget: true });
  });

  test("a plan that refused a request before any window was known: its line, which says it is at the limit", () => {
    const refused: PlanUsage = { ...usage([]), limited: true };
    expect(usageShown(onPlan({ usage: refused }), 0)).toEqual({
      plan: { account: "Claude Team", usage: refused },
      budget: false,
    });
  });
});

test("the compact line names a window short; a provider's own window by its name", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const text = planMeterText(t, "en");
  expect(text.short({ kind: "five_hour" })).toBe("aiAccounts.usage.short.five_hour");
  expect(text.short({ kind: "seven_day_opus" })).toBe("aiAccounts.usage.short.seven_day_opus");
  expect(text.short({ kind: "other", label: "Extra usage" })).toBe("Extra usage");
  expect(text.short({ kind: "other" })).toBe("aiAccounts.usage.short.other");
  expect(text.window({ kind: "seven_day" })).toBe("aiAccounts.usage.window.seven_day");
});

describe("the workspace's budget only where it uses the API (ADR 0063 §5)", () => {
  const ready = (...ids: string[]): Pick<AiStatus, "agents"> => ({
    agents: ids.map((agentId) => ({ agentId, state: "ready" as const })),
  });
  const onApi = { kind: "model" as const, model: null };

  test("on plans alone, nothing spent through the API: no budget", () => {
    expect(workspaceUsesApi([{ id: "a1", brain: onPlan() }], ready("a1"), 0)).toBe(false);
  });

  test("an agent on the API with a key: the budget, even at 0%", () => {
    expect(
      workspaceUsesApi(
        [
          { id: "a1", brain: onPlan() },
          { id: "a2", brain: onApi },
        ],
        ready("a1", "a2"),
        0,
      ),
    ).toBe(true);
    // A server too old to say who thinks: the API, as an agent's own line reads it.
    expect(workspaceUsesApi([{ id: "a2" }], ready("a2"), 0)).toBe(true);
  });

  test("an agent on the API with no key thinks with nothing: no budget, nor while the AI status loads", () => {
    const noKey: Pick<AiStatus, "agents"> = { agents: [{ agentId: "a2", state: "no_ai", reason: "no_key" }] };
    expect(workspaceUsesApi([{ id: "a2", brain: onApi }], noKey, 0)).toBe(false);
    expect(workspaceUsesApi([{ id: "a2", brain: onApi }], undefined, 0)).toBe(false);
  });

  test("spent through the API this month (a plan's fallback, or a key removed since): the budget", () => {
    expect(workspaceUsesApi([{ id: "a1", brain: onPlan() }], ready("a1"), 1.2)).toBe(true);
    expect(workspaceUsesApi([], undefined, 0.1)).toBe(true);
  });
});

describe("your plans with their limits (Sua conta, the profile menu near a limit)", () => {
  const words: Record<string, string> = {
    "aiAccounts.connect.claude_code": "Claude",
    "aiAccounts.page.on": "on {{computer}}",
  };
  const t = ((key: string, o?: Record<string, string>) =>
    (words[key] ?? key).replace(/{{(\w+)}}/g, (_, k: string) => o?.[k] ?? "")) as unknown as TFunction;
  const ME = "u_ana";
  const computer = (own: AiComputer["own"], machineId = "m1", name = "MacBook"): AiComputer => ({
    machineId,
    name,
    online: true,
    mine: true,
    canAdd: true,
    keys: true,
    brains: { claude_code: true, codex: true },
    own,
  });
  const account = (id: string, over: Partial<AiAccounts["accounts"][number]> = {}): AiAccounts["accounts"][number] => ({
    id,
    kind: "claude_code",
    label: "Claude Team",
    email: `${id}@acme.com`,
    plan: "team",
    status: "active",
    ownerId: ME,
    ownerName: "Ana",
    mine: true,
    usedBy: ["Atlas"],
    usage: HOURS,
    provider: null,
    keyHint: null,
    machineId: "m1",
    computer: "MacBook",
    ...over,
  });
  /** One of Ana's agents on her MacBook's own sign-in (no account, no coding plan). */
  const onOwn = (name = "Ada", over: Partial<AgentBrainLine> = {}, ownerUserId: string | null = ME) => ({
    name,
    ownerUserId,
    brain: onPlan({ account: "Claude Max", computer: "MacBook", ...over }),
  });

  test("the computers' own sign-ins, then the accounts: each with its maker's mark, its name and its limits", () => {
    const glm = account("a2", {
      label: "GLM Coding",
      plan: null,
      provider: "zai",
      email: null,
      keyHint: "MnOp",
      usedBy: ["Iris"],
    });
    const view = {
      computers: [computer({ claude_code: { plan: "max", usage: HOURS } })],
      accounts: [account("a1"), account("a3", { label: "Trabalho" }), glm],
    };
    // Named as "Seus planos" names them: the plan once, after a name that doesn't say it.
    expect(ownPlanLines(t, view, [onOwn()], ME)).toEqual([
      { key: "m1:claude_code", logo: "claude_code", name: "Claude · Max", usage: HOURS },
      { key: "a1", logo: "claude_code", name: "Claude Team", usage: HOURS },
      { key: "a3", logo: "claude_code", name: "Trabalho · Team", usage: HOURS },
      { key: "a2", logo: "zai", name: "GLM Coding", usage: HOURS },
    ]);
  });

  test("no window known yet: nothing; a plan that refused a request before any window: its line", () => {
    const refused: PlanUsage = { ...usage([]), limited: true };
    const view = {
      computers: [computer({ codex: {} })],
      accounts: [
        account("a1", { usage: null }),
        account("a2", { usage: usage([]) }),
        account("a3", { usage: refused }),
      ],
    };
    expect(ownPlanLines(t, view, [onOwn("Ada", { kind: "codex" })], ME).map((p) => p.key)).toEqual(["a3"]);
    expect(ownPlanLines(t, undefined, [], ME)).toEqual([]);
  });

  test("an account's logins are one line, and every plan has its own", () => {
    const view = {
      computers: [],
      accounts: [account("a1"), account("a1b", { email: "a1@acme.com" }), account("a2"), account("a3"), account("a4")],
    };
    expect(ownPlanLines(t, view, [], ME).map((p) => p.key)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("an account no agent thinks with, or signed out on every login, isn't one of the workspace's plans", () => {
    const view = {
      computers: [],
      accounts: [
        account("a1", { usedBy: [] }),
        account("a2", { status: "signed_out" }),
        // One login of a3 is still in: its agent thinks with it.
        account("a3", { status: "signed_out", usedBy: [] }),
        account("a3b", { email: "a3@acme.com" }),
      ],
    };
    expect(ownPlanLines(t, view, [], ME).map((p) => p.key)).toEqual(["a3"]);
  });

  test("a computer's own sign-in: while one of your agents there thinks with it, with no account", () => {
    const view = { computers: [computer({ claude_code: { plan: "max", usage: HOURS } })], accounts: [account("a1")] };
    const lines = (agents: ReturnType<typeof onOwn>[]) => ownPlanLines(t, view, agents, ME).map((p) => p.key);
    expect(lines([onOwn()])).toEqual(["m1:claude_code", "a1"]);
    // Nobody there, someone else's agent (the sign-in thinks only for its pairer's), an agent on one of your accounts
    // there, on a coding plan's key, on another computer, or on Codex.
    expect(lines([])).toEqual(["a1"]);
    expect(lines([onOwn("Ada", {}, "u_bia")])).toEqual(["a1"]);
    expect(lines([onOwn("Atlas", { account: "Claude Team" })])).toEqual(["a1"]);
    expect(lines([onOwn("Iris", { provider: "zai", account: "GLM Coding" })])).toEqual(["a1"]);
    expect(lines([onOwn("Ada", { computer: "iMac" })])).toEqual(["a1"]);
    expect(lines([onOwn("Ada", { kind: "codex" })])).toEqual(["a1"]);
  });

  test("two plans of one name say which: their computers, or on the same computer an account's email", () => {
    const names = (view: AiAccounts, agents: ReturnType<typeof onOwn>[]) =>
      ownPlanLines(t, view, agents, ME).map((p) => p.name);
    const max = { claude_code: { plan: "max", usage: HOURS } };
    const own = { computers: [computer(max), computer(max, "m2", "iMac")], accounts: [] };
    const agents = [onOwn(), onOwn("Bia", { computer: "iMac" })];
    expect(names(own, agents)).toEqual(["Claude · Max on MacBook", "Claude · Max on iMac"]);
    expect(names({ ...own, computers: own.computers.slice(0, 1) }, agents)).toEqual(["Claude · Max"]);

    // The MacBook's own sign-in on Max and an account named "Claude" on Max.
    const claude = account("a1", { label: "Claude", plan: "max", email: "ana@work.com" });
    const onMac = { computers: [computer(max)], accounts: [claude] };
    expect(names(onMac, [onOwn()])).toEqual(["Claude · Max on MacBook", "Claude · Max · ana@work.com"]);
    const onImac = { ...onMac, accounts: [{ ...claude, machineId: "m2", computer: "iMac" }] };
    expect(names(onImac, [onOwn()])).toEqual(["Claude · Max on MacBook", "Claude · Max on iMac"]);
    // The same account signed in on both computers.
    const both = { computers: [], accounts: [claude, { ...claude, id: "a2", machineId: "m2", computer: "iMac" }] };
    expect(names(both, [])).toEqual(["Claude · Max on MacBook", "Claude · Max on iMac"]);
  });
});

describe("a plan account's agents in one list, its bar split by agent (Contas dos planos)", () => {
  const NOW = Date.parse("2026-11-02T12:00:00.000Z");
  const crew = ["ada", "rio", "nova", "lia", "theo", "bia", "caio"];
  const account = (over: Partial<PlanAccountUsage> = {}): Pick<PlanAccountUsage, "usage" | "agents"> => ({
    usage: {
      source: "turn",
      at: "2026-11-02T11:59:00.000Z",
      windows: [
        {
          kind: "five_hour",
          usedPercent: 9,
          resetsAt: "2026-11-02T14:00:00.000Z",
          agents: [{ agentId: "bia", name: "Bia", percent: 9 }],
        },
        {
          kind: "seven_day",
          usedPercent: 20,
          resetsAt: "2026-11-09T10:00:00.000Z",
          agents: crew.map((id, i) => ({ agentId: id, name: id, percent: 7 - i })),
        },
      ],
    },
    agents: crew.map((id, i) => ({ agentId: id, name: id, tokens: (i + 1) * 1000, now: false })),
    ...over,
  });

  test("the week's shares, biggest first; past five the rest fold with their share and tokens", () => {
    const shares = accountShares(account(), NOW);
    expect(shares.window?.kind).toBe("seven_day");
    expect(shares.shown.map((r) => [r.agentId, r.share])).toEqual([
      ["ada", 7],
      ["rio", 6],
      ["nova", 5],
      ["lia", 4],
      ["theo", 3],
    ]);
    expect(shares.rest.map((r) => r.agentId)).toEqual(["bia", "caio"]);
    expect([shares.restShare, shares.restTokens]).toEqual([3, 13_000]);
  });

  test("an agent in the week's parts but not this month's (last month, or archived) has no tokens and is not using it now", () => {
    const shares = accountShares(account({ agents: account().agents.filter((a) => a.agentId !== "ada") }), NOW);
    expect(shares.shown[0]).toMatchObject({ agentId: "ada", share: 7, tokens: 0, now: false });
  });

  test("one agent over five shows as itself; no week, the first window with parts; renewed, no shares", () => {
    const six = account({ agents: account().agents.slice(0, 6) });
    six.usage?.windows[1]?.agents?.splice(6);
    expect(accountShares(six, NOW)).toMatchObject({ rest: [], restShare: 0 });
    expect(accountShares(six, NOW).shown).toHaveLength(6);
    const hours = account();
    hours.usage?.windows.splice(1);
    expect(
      accountShares(hours, NOW)
        .shown.map((r) => [r.agentId, r.share])
        .slice(0, 2),
    ).toEqual([
      ["bia", 9],
      ["caio", 0],
    ]);
    const renewed = accountShares(account(), Date.parse("2026-11-10T00:00:00.000Z"));
    expect(renewed.window).toBeNull();
    expect(accountShares({ usage: null, agents: account().agents }, NOW)).toMatchObject({ window: null });
    // By tokens while no window says shares.
    expect(accountShares({ usage: null, agents: account().agents }, NOW).shown[0]?.agentId).toBe("caio");
  });

  test("each window's bar split by agent, in that agent's colours; a window without parts stays plain", () => {
    const base = account().usage;
    if (!base) throw new Error("no usage");
    const split = splitUsage(
      { ...base, windows: [...base.windows, { kind: "monthly", usedPercent: 3, agents: null }] },
      (id) => [`#light-${id}`, `#deep-${id}`],
    );
    expect(split.windows[0]?.segments).toEqual([{ key: "bia", value: 9, light: "#light-bia", deep: "#deep-bia" }]);
    expect(split.windows[1]?.segments?.map((g) => g.key)).toEqual(crew.slice(0, SHARES_SHOWN));
    expect(split.windows[2]).toEqual({ kind: "monthly", usedPercent: 3 });
  });

  test("15 small agents on a week at 3%: colours only for the ones the list shows, never more than the use", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ agentId: `a${i}`, name: `A${i}`, percent: 0.2 }));
    const split = splitUsage(
      {
        source: "turn",
        at: "2026-11-02T11:59:00.000Z",
        windows: [{ kind: "seven_day", usedPercent: 3, agents: many }],
      },
      () => ["#light", "#deep"],
    );
    const segments = split.windows[0]?.segments ?? [];
    expect(segments).toHaveLength(SHARES_SHOWN);
    expect(segments.reduce((sum, g) => sum + g.value, 0)).toBeLessThanOrEqual(3);
  });
});

describe("an agent's line under an account's bars, and whose the account is", () => {
  const t = ((key: string, o?: Record<string, string>) =>
    `${key}${o ? `(${Object.values(o).join(",")})` : ""}`) as unknown as TFunction;

  test("the share only while a window has parts; tokens, else that it is on it now, else nothing", () => {
    expect(shareFacts(t, "en", "week", { share: 48, tokens: 1200 })).toMatch(/^ · week 48\s?% · usageViews\.tokens\(/);
    expect(shareFacts(t, "en", null, { share: 0, tokens: 0, now: true })).toBe(" · usageViews.usesNow");
    expect(shareFacts(t, "en", null, { share: 0, tokens: 0 })).toBe("");
  });

  test("the owner by first name; no owner named, no words", () => {
    expect(accountOwner(t, { ownerName: "Ana  Souza Lima" })).toBe("usageViews.whose(Ana)");
    expect(accountOwner(t, { ownerName: null })).toBeNull();
  });
});

describe("the viewer's own logins of one account are one row (IA e uso › Contas)", () => {
  type Login = AiAccounts["accounts"][number];
  const login = (id: string, over: Partial<Login> = {}): Login => ({
    id,
    kind: "claude_code",
    label: "GLM Coding",
    email: null,
    plan: null,
    status: "active",
    ownerId: "u-1",
    ownerName: "Bia",
    mine: true,
    usedBy: [],
    usage: null,
    provider: "zai",
    keyHint: "4f2a",
    machineId: "m1",
    computer: "MacBook",
    ...over,
  });
  const row = (accountId: string | null, over: Partial<PlanAccountUsage> = {}): PlanAccountUsage => ({
    key: `m1:claude_code:${accountId ?? "computer"}`,
    machineId: "m1",
    machineName: "MacBook",
    kind: "claude_code",
    accountId,
    label: "GLM Coding",
    plan: null,
    provider: "zai",
    ownerName: "Bia",
    mine: true,
    email: null,
    signedOut: false,
    usage: null,
    agents: [],
    monthTokens: 0,
    ...over,
  });
  const week = (at: string, percent: number, agentId: string): NonNullable<PlanAccountUsage["usage"]> => ({
    source: "turn",
    at,
    windows: [{ kind: "seven_day", usedPercent: percent, agents: [{ agentId, name: agentId, percent: 5 }] }],
  });

  test("a login per agent: one row where the first was, the newest windows with every agent, the months summed", () => {
    const rows = groupUsageAccounts(
      [
        row(null, { label: null }),
        row("a", {
          usage: week("2026-11-02T10:00:00.000Z", 40, "ada"),
          agents: [{ agentId: "ada", name: "Ada", tokens: 1000, now: true }],
          monthTokens: 1000,
          equivalentUsd: 2,
        }),
        row("other", { mine: false, ownerName: "Caio" }),
        row("b", {
          usage: week("2026-11-02T11:00:00.000Z", 62, "theo"),
          agents: [{ agentId: "theo", name: "Theo", tokens: 500, now: false }],
          monthTokens: 500,
          equivalentUsd: 1,
          signedOut: true,
        }),
      ],
      { accounts: [login("a"), login("b")] },
    );
    expect(rows.map((r) => r.accountId)).toEqual([null, "a", "other"]);
    const [, glm] = rows;
    expect(glm?.usage?.at).toBe("2026-11-02T11:00:00.000Z");
    expect(glm?.usage?.windows[0]?.usedPercent).toBe(62);
    expect(glm?.usage?.windows[0]?.agents?.map((a) => a.agentId)).toEqual(["theo", "ada"]);
    expect(glm?.agents.map((a) => [a.agentId, a.tokens])).toEqual([
      ["ada", 1000],
      ["theo", 500],
    ]);
    expect([glm?.monthTokens, glm?.equivalentUsd]).toEqual([1500, 3]);
    // Out only when every login is.
    expect(glm?.signedOut).toBe(false);
  });

  test("two accounts of one name stay two rows, and so does everything while the viewer's plans load", () => {
    const list = [row("a"), row("b")];
    expect(groupUsageAccounts(list, { accounts: [login("a"), login("b", { keyHint: "9z9z" })] })).toHaveLength(2);
    expect(groupUsageAccounts(list, undefined)).toEqual(list);
  });
});

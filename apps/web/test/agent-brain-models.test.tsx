import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Agent, AgentBrain, AgentBrainInput, AiComputer, MachineAccount } from "@agenteschat/client";
import { CODING_PLANS, learnPlanModels } from "@agenteschat/client/lib/plans";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  brainDialog,
  brainLines,
  brainRows,
  brainScreen,
  confirmScreen,
  done,
  mainButton,
  pickRow,
  toScreen,
} from "./ai-picker";
import {
  ADA_ID,
  createFakeApi,
  type FakeState,
  fakeAgentBrain,
  fakeMachinesOf,
  OPENROUTER_KEY,
  OPENROUTER_MODELS,
  ORG_ID,
  seedState,
} from "./fake-api";
import { shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/*
 * "Quem pensa" on its Modelo screen and the Esforço and Velocidade lines of "Mais opções" (ADR 0032 §5, addendum
 * 2026-11-10): the models as rows grouped by maker, Automático first, each saved on its own screen; the effort and the
 * speed saved by "Concluído", only what changed.
 */

afterEach(() => {
  cleanup();
  setSystemTime();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);

async function open(state = seedState(), api = createFakeApi(state)) {
  const { services } = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(8);
  return { state, api, services };
}
/** "Como trabalha" under the name: where, who thinks, the browser. */
const sentence = () => screen().getByRole("region", { name: "Como trabalha" });
/** The "Pensa com" cell: what thinks (and its effort), and what pays (on the value's line in the fact sheet). */
const brainCell = () => {
  const cell = within(sentence()).getByRole("button", { name: "Mudar quem pensa" });
  const value = cell.querySelector(".agp-cell__value")?.cloneNode(true) as HTMLElement | undefined;
  value?.querySelector(".agp-cell__sub")?.remove();
  return {
    label: cell.querySelector("small")?.textContent,
    value: value?.textContent,
    sub: cell.querySelector(".agp-cell__sub")?.textContent,
  };
};
/** The MacBook's row in the AI accounts: the own sign-ins its runner reported there. */
const reportOwn = (api: ReturnType<typeof createFakeApi>, own: AiComputer["own"]) =>
  fakeMachinesOf.get(api)?.setAiAccounts({
    accounts: [],
    computers: [
      {
        machineId: "machine_1",
        name: "MacBook",
        online: true,
        mine: true,
        canAdd: true,
        keys: true,
        brains: { claude_code: true, codex: true },
        own,
      },
    ],
  });
/** A connected MacBook with Claude Code and Codex; its browser as given. */
const pairMac = (api: ReturnType<typeof createFakeApi>, browser: boolean) =>
  fakeMachinesOf.get(api)?.pair({
    id: "machine_1",
    name: "MacBook",
    os: "darwin",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser } },
    browser: { available: browser, version: browser ? "1" : null, chrome: null, reason: null },
  });
/**
 * Ada's brain as the server gives it, following what each screen saves (a static view would show the old model after
 * a save): what thinks, the model, the account, the effort and the speed.
 */
function follow(api: ReturnType<typeof createFakeApi>, first: AgentBrain) {
  let view = first;
  api.agents.brain = async () => structuredClone(view);
  const setBrain = api.agents.setBrain;
  api.agents.setBrain = async (orgId, agentId, input: AgentBrainInput) => {
    const next = await setBrain(orgId, agentId, input);
    const brain = input.brain ?? view.brain;
    const option = view.options.find((o) => o.kind === brain);
    view = {
      ...view,
      brain,
      ...(input.model !== undefined
        ? { model: input.model, effectiveModel: input.model ?? option?.defaultModel ?? null }
        : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      ...(input.onlyOwner !== undefined ? { onlyOwner: input.onlyOwner } : {}),
    };
    return next;
  };
}
/** The rows of the screen, as title and lines. */
const rowsOf = (d: HTMLElement) => brainRows(d).map((r) => [r.title, ...r.lines]);
/** The labels over the rows' groups, in order. */
const groupsOf = (d: HTMLElement) => [...new Set(brainRows(d).map((r) => r.group))].filter(Boolean);
const checkedOf = (d: HTMLElement) => brainRows(d).find((r) => r.checked)?.title;
/** A line of the first screen or of "Mais opções", by its name. */
const lineOf = (d: HTMLElement, label: string) => brainLines(d).find((l) => l.label === label)?.value;

describe("Quem pensa: a coding plan's models", () => {
  /** One of Walter's key accounts of `provider` on the MacBook. */
  const planKey = (provider: string | null, over: Partial<MachineAccount> = {}): MachineAccount => ({
    id: "acct_plan",
    kind: "claude_code",
    label: "Plano",
    email: null,
    plan: null,
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy: ["Ada"],
    usage: null,
    provider,
    keyHint: "4f2a",
    ...over,
  });
  /** Ada thinks with Claude Code on the MacBook, with Walter's key account of `provider`. */
  async function onPlan(
    provider: string,
    patch: Partial<AgentBrain> = {},
    over: Partial<MachineAccount> = {},
    planModels?: FakeState["planModels"],
  ) {
    const state = seedState();
    if (planModels) state.planModels = planModels;
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    follow(
      api,
      fakeAgentBrain(ADA_ID, {
        brain: "claude_code",
        effectiveModel: "sonnet",
        account: "acct_plan",
        accounts: [planKey(provider, over)],
        ...patch,
      }),
    );
    await open(state, api);
    return { state, api };
  }

  test("the agent's model at a limit of its own: said under the plan's meters, which show the account's room", async () => {
    const at = new Date().toISOString();
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await onPlan(
      "opencode",
      { effectiveModel: "deepseek-v4.1-flash" },
      {
        usage: {
          windows: [{ kind: "five_hour", usedPercent: 0 }],
          source: "probe",
          at,
          models: { "deepseek-v4.1-flash": { at, until } },
        },
      },
    );
    const d = await brainDialog();
    expect(d.textContent).toContain("O DeepSeek V4.1 Flash chegou ao limite dele neste plano e renova ");
    expect(d.textContent).toContain("Os outros modelos do plano seguem funcionando.");
  });

  test("every model of the plan as a row, by maker, each with what it's sold as and needs; saved by its id", async () => {
    const { state } = await onPlan("opencode");
    const d = await brainDialog();
    expect(lineOf(d, "Modelo")).toBe("MiniMax M3");
    await toScreen(d, "Modelo");
    expect(brainScreen(d)).toBe("Modelo da Ada");
    expect(within(d).getByRole("radiogroup", { name: "Modelo da Ada" })).toBeTruthy();
    const rows = brainRows(d);
    expect(rows).toHaveLength(32);
    expect(rowsOf(d).slice(0, 4)).toEqual([
      ["Automático", "Escolhe o modelo e o esforço para cada tarefa"],
      ["MiniMax M3"],
      ["MiniMax M3.1 Flash"],
      ["Claude Haiku 5.5"],
    ]);
    expect(checkedOf(d)).toBe("MiniMax M3");
    expect(rowsOf(d)).toContainEqual(["Kimi K3.1 Pro", "Topo de linha"]);
    // Grouped by maker, as the workspace's models are.
    expect(groupsOf(d)).toEqual([
      "MiniMax",
      "Claude",
      "Z.ai",
      "Kimi",
      "Alibaba",
      "DeepSeek",
      "Xiaomi",
      "OpenAI",
      "Gemini",
      "xAI",
      "Meituan",
      "Tencent",
      "StepFun",
      "Meta",
      "Reflection",
      "OpenCode",
    ]);
    // What a model needs from the OpenCode account is its quieter line, under what it's sold as.
    expect(
      brainRows(d)
        .filter((r) => r.group === "DeepSeek")
        .map((r) => [r.title, ...r.lines]),
    ).toEqual([
      ["DeepSeek V4 Pro", "Precisa da região Global no OpenCode."],
      ["DeepSeek V4.1 Flash", "Econômico", "Precisa da região Global no OpenCode."],
    ]);
    // A model that trains on what it's sent: its provider does, never agentes.chat.
    expect(
      brainRows(d)
        .find((r) => r.title === "Iceman Contributor Free")
        ?.lines.at(-1),
    ).toBe("Grátis. O provedor pode usar os pedidos para treinar o modelo. Ligue a permissão no OpenCode.");
    // Nothing to say before a model that needs something is picked.
    expect(within(d).queryByRole("link", { name: "Abrir opencode.ai" })).toBeNull();
    await pickRow(d, "DeepSeek V4.1 Flash");
    // Picked, what it needs is said under the list: how to give it, with the plan's page.
    expect(d.textContent).toContain(
      "Ligue a região Global no OpenCode, em Settings › Privacy. Sem ela, este modelo não responde.",
    );
    expect(within(d).getByRole("link", { name: "Abrir opencode.ai" }).getAttribute("href")).toBe(
      "https://opencode.ai/console",
    );
    expect(mainButton(d)?.textContent).toBe("Usar DeepSeek V4.1 Flash");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: "deepseek-v4.1-flash" }]);
    // Saved, back on the first screen with the model it now thinks with.
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
    expect(lineOf(d, "Modelo")).toBe("DeepSeek V4.1 Flash");
  });

  test("an OpenCode key on OpenCode's CLI: after the computer's free models, OpenCode Go's, DeepSeek V4.1 Flash too", async () => {
    const free = { kind: "opencode" as const, available: true, defaultModel: null };
    const { state } = await onPlan(
      "zen",
      {
        brain: "opencode",
        effectiveModel: "opencode/big-pickle",
        options: [{ ...free, models: [{ value: "opencode/big-pickle", label: "Big Pickle", free: true }] }],
      },
      { kind: "opencode", label: "OpenCode", keyHint: "Q7f2" },
    );
    const d = await brainDialog();
    await toScreen(d, "Modelo");
    // The computer listed its CLI's models with no key: the free tier. The key's Go models follow, by maker.
    expect(brainRows(d)[1]?.title).toBe("Big Pickle");
    expect(
      brainRows(d)
        .filter((r) => r.group === "DeepSeek")
        .map((r) => [r.title, r.lines[0]]),
    ).toEqual([
      ["DeepSeek V4 Pro", "Precisa da região Global no OpenCode."],
      ["DeepSeek V4.1 Flash", "Econômico"],
    ]);
    await pickRow(d, "DeepSeek V4.1 Flash");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
  });

  test("a coding plan's keys are accounts of its own; another plan starts on its own model, one more key keeps it", async () => {
    const { state } = await onPlan("opencode", {
      model: "deepseek-v4.1-flash",
      effectiveModel: "deepseek-v4.1-flash",
      accounts: [
        planKey("opencode"),
        planKey("opencode", { id: "acct_oc2", label: "Plano 2", usedBy: [], keyHint: "9f3c" }),
        planKey("zai", { id: "acct_theirs", mine: false, usedBy: [], keyHint: "1b2c" }),
        planKey(null, { id: "acct_claude", label: "Pessoal", keyHint: null, plan: "Max", usedBy: [] }),
      ],
    });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    const rows = brainRows(d);
    // The key in use with its plan's mark; the viewer's other key of that plan and Claude account, the workspace's key;
    // never someone else's key.
    expect(rows.map((r) => [r.group, r.title, r.lines[0] ?? null, r.mark])).toEqual([
      ["Em uso", "Plano", "chave …4f2a", "opencode"],
      ["Suas", "Plano 2", "chave …9f3c", "opencode"],
      ["Suas", "Pessoal · Max", null, "claude"],
      ["Chave do workspace", "Chave padrão do workspace", "Claude · termina em 7f2a", "claude"],
    ]);
    // One more key of the same plan: the model it has stays.
    await pickRow(d, (r) => r.group !== "Em uso" && r.title === "Plano 2");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", account: "acct_oc2" });
    // Claude: another plan, on its own default model.
    await done(d);
    const again = await brainDialog();
    await toScreen(again, "Trocar de conta");
    await pickRow(again, (r) => r.group !== "Em uso" && r.title.startsWith("Pessoal"));
    await confirmScreen(again);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: null, account: "acct_claude" });
  });

  test("a plan's key made for all of its owner's agents there is picked as it is, though another agent thinks with it", async () => {
    const { state } = await onPlan("opencode", {
      account: null,
      accounts: [planKey("opencode", { id: "acct_oc", usedBy: ["Theo"], shared: true })],
    });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, (r) => r.group !== "Em uso" && r.mark === "opencode");
    expect(mainButton(d)?.textContent).toBe("Trocar para Plano");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", account: "acct_oc" });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("moveAccount");
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("a key its plan refused: said so, and the first screen asks the same account for a new key", async () => {
    const { state } = await onPlan("opencode", {}, { status: "signed_out" });
    const d = await brainDialog();
    expect(shownText(d)).toContain("A chave foi recusada: troque por uma nova.");
    expect(mainButton(d)?.textContent).toBe("Trocar a chave");
    await confirmScreen(d);
    fireEvent.change(within(d).getByLabelText("Chave do OpenCode Go"), {
      target: { value: "oc_sk_fake-key-for-tests" },
    });
    await click(within(d).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { accountId: "acct_plan", provider: "opencode" },
    ]);
  });

  test("a model OpenCode's list added after this build: offered by its maker, and shown by its name once chosen", async () => {
    const table = CODING_PLANS.opencode.claudeCode.models;
    try {
      await onPlan(
        "opencode",
        { model: "nova-2", effectiveModel: "nova-2" },
        {},
        { opencode: [...table, { id: "nova-2", label: "Nova 2", maker: "Acme" }] },
      );
      expect(brainCell().value).toStartWith("Nova 2");
      const d = await brainDialog();
      expect(lineOf(d, "Modelo")).toBe("Nova 2");
      await toScreen(d, "Modelo");
      expect(brainRows(d).find((r) => r.title === "Nova 2")).toMatchObject({ group: "Acme", checked: true });
    } finally {
      learnPlanModels({ opencode: table });
    }
  });

  test("Conectar outra IA, for the agent's owner: Quem pensa closes and Connect an AI opens for this agent", async () => {
    await onPlan("opencode");
    let d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await click(within(d).getByRole("button", { name: /^Conectar outra IA/ }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: /^(Quem pensa|Trocar a conta)/ })).toBeNull();
    expect(screen().getByRole("dialog", { name: "Conectar uma IA para a Ada" })).toBeTruthy();
    cleanup();
    await onPlan("opencode", { canUsePlans: false, canManageAccounts: false });
    d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(within(d).queryByRole("button", { name: /^Conectar outra IA/ })).toBeNull();
  });

  test("an admin moves its owner's agent off the owner's coding plan, onto the owner's other plans or the API", async () => {
    await onPlan("opencode", { canUsePlans: false, canManageAccounts: false }, { mine: false });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    // The computer's own sign-ins, the owner's, and the workspace's key: none of them off.
    expect(brainRows(d).map((r) => [r.title, r.lines[0], r.mark, r.off])).toEqual([
      ["Plano", "De Walter", "opencode", false],
      ["Conta deste MacBook", "De João", "claude", false],
      ["Conta deste MacBook", "De João", "openai", false],
      ["Chave padrão do workspace", "Chave do workspace", "claude", false],
    ]);
    expect(mainButton(d)?.disabled).toBe(false);
    expect(d.textContent).not.toContain("Só João troca");
  });

  test("the cell names the plan's model it runs; models sold with words show them, a plan's only model too", async () => {
    await onPlan("kimi", { model: "k3-256k", effectiveModel: "k3-256k" });
    expect(sentence().textContent).toContain("K3 256K");
    cleanup();
    await onPlan("zai", { model: "opus", effectiveModel: "opus" });
    let d = await brainDialog();
    // An alias the plan leaves out runs its main model: shown as that one (what it's sold as stays in the list).
    expect(lineOf(d, "Modelo")).toBe("GLM-5.3");
    await toScreen(d, "Modelo");
    expect(rowsOf(d)).toEqual([
      ["Automático", "Escolhe o modelo e o esforço para cada tarefa"],
      ["GLM-5.3", "Topo de linha"],
      ["GLM-5.3 Flash", "Econômico"],
    ]);
    expect(checkedOf(d)).toBe("GLM-5.3");
    cleanup();
    await onPlan("minimax");
    d = await brainDialog();
    // The model is its own screen on every brain, a plan of one model too.
    await toScreen(d, "Modelo");
    expect(rowsOf(d)).toEqual([
      ["Automático", "Escolhe o modelo e o esforço para cada tarefa"],
      ["MiniMax M3.1 Flash"],
    ]);
    expect(checkedOf(d)).toBe("MiniMax M3.1 Flash");
  });

  test("the saved model can't be used again; Cancelar goes back and saves nothing", async () => {
    const { state } = await onPlan("opencode");
    const d = await brainDialog();
    await toScreen(d, "Modelo");
    expect(mainButton(d)?.textContent).toBe("Usar MiniMax M3");
    expect(mainButton(d)?.disabled).toBe(true);
    await pickRow(d, "Claude Haiku 5.5");
    expect(mainButton(d)?.disabled).toBe(false);
    await click(within(d).getByRole("button", { name: "Cancelar" }));
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
    expect(lineOf(d, "Modelo")).toBe("MiniMax M3");
    expect(brainCalls(state)).toEqual([]);
  });
});

describe("Quem pensa: Automático", () => {
  /** Ada thinks with Claude Code on the MacBook (as given). */
  async function onClaude(patch: Partial<AgentBrain> = {}) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    follow(api, fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", ...patch }));
    await open(state, api);
    return state;
  }

  test("Claude Code: Automático comes first for the model and picks the effort too; Usar saves both", async () => {
    const state = await onClaude();
    const d = await brainDialog();
    // "Mais opções" names what it holds: with a fixed model, the effort first.
    expect(lineOf(d, "Mais opções")).toBe("Esforço, janela de contexto e quem atende");
    await toScreen(d, "Modelo");
    // Each with what it is for.
    expect(rowsOf(d)).toEqual([
      ["Automático", "Escolhe o modelo e o esforço para cada tarefa"],
      ["Opus", "O mais capaz. Gasta o plano mais rápido."],
      ["Sonnet", "Equilibrado. Bom para quase tudo."],
      ["Haiku", "Rápido e leve. Para tarefas simples."],
    ]);
    await toScreen(d, "Voltar");
    // A fixed model: the effort's four levels, none of them Automático, under "Mais opções".
    await toScreen(d, "Mais opções");
    expect(lineOf(d, "Esforço")).toBe("Médio");
    await toScreen(d, "Esforço");
    const ramp = within(d).getByRole("slider", { name: "Esforço" });
    expect(ramp.getAttribute("aria-valuemax")).toBe("4");
    expect(ramp.getAttribute("aria-valuetext")).toBe("Médio");
    await toScreen(d, "Voltar");
    await toScreen(d, "Modelo");
    await pickRow(d, "Automático");
    expect(mainButton(d)?.textContent).toBe("Usar Automático");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: "auto", effort: "auto" }]);
    // The model picks the effort too: no ramp to set, and the place says so and how to set it.
    expect(lineOf(d, "Modelo")).toBe("Automático");
    expect(lineOf(d, "Mais opções")).toBe("Janela de contexto e quem atende");
    await toScreen(d, "Mais opções");
    expect(lineOf(d, "Esforço")).toBe("Automático");
    await toScreen(d, "Esforço");
    expect(within(d).queryByRole("slider", { name: "Esforço" })).toBeNull();
    expect(d.textContent).toContain(
      "O modelo Automático escolhe o esforço de cada tarefa. Escolha um modelo para fixar o esforço.",
    );
  });

  test("back to a fixed model: the ramp returns at Médio and the effort is saved", async () => {
    const state = await onClaude({ model: "auto", effectiveModel: "auto", effort: "auto" });
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    await toScreen(d, "Esforço");
    expect(within(d).queryByRole("slider", { name: "Esforço" })).toBeNull();
    await toScreen(d, "Voltar");
    await toScreen(d, "Modelo");
    expect(checkedOf(d)).toBe("Automático");
    await pickRow(d, "Opus");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code", model: "opus", effort: "medium" });
    await toScreen(d, "Mais opções");
    await toScreen(d, "Esforço");
    expect(within(d).getByRole("slider", { name: "Esforço" }).getAttribute("aria-valuetext")).toBe("Médio");
  });

  test("a new agent (Automático on every brain) switching to Claude Code starts there on Automático", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Its own Claude Code sign-in is there: Claude Code starts on it, not on a sign-in.
    reportOwn(api, { claude_code: { plan: "max" } });
    // New agents are created with the effort on auto too; the API brain doesn't show it.
    follow(api, fakeAgentBrain(ADA_ID, { effort: "auto" }));
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, (r) => r.group !== "Em uso" && r.mark === "claude");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", model: "auto", account: null });
    expect(brainScreen(d)).toBe("Pronto");
    await done(d);
    expect(lineOf(await brainDialog(), "Modelo")).toBe("Automático");
  });

  test("the organization's model: Automático is the first choice, and Usar saves the agent's model as auto", async () => {
    const { state } = await open();
    const d = await brainDialog();
    await toScreen(d, "Modelo");
    expect(rowsOf(d)[0]).toEqual(["Automático", "Escolhe o modelo e o esforço para cada tarefa"]);
    await pickRow(d, "Automático");
    await confirmScreen(d);
    await settle(6);
    expect(state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2])).toEqual([{ model: "auto" }]);
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
    expect(lineOf(d, "Modelo")).toBe("Automático");
  });

  test("OpenRouter's models: a search over them, its good picks before the rest, each with its price", async () => {
    const seeded = seedState({ extraModels: OPENROUTER_MODELS });
    seeded.credentials.push(OPENROUTER_KEY);
    const { state } = await open(seeded);
    const d = await brainDialog();
    await toScreen(d, "Modelo");
    expect(groupsOf(d)).toEqual(["Claude", "OpenAI", "OpenRouter · Boas escolhas", "OpenRouter"]);
    const search = within(d).getByRole("searchbox", { name: "Buscar modelos" });
    await act(async () => fireEvent.change(search, { target: { value: "glm" } }));
    expect(rowsOf(d)).toEqual([
      ["Z.ai: GLM Latest", "US$ 0,1 / US$ 2,77 por milhão de tokens"],
      ["Z.ai: GLM 5.3", "US$ 0,1 / US$ 2,77 por milhão de tokens"],
    ]);
    // The maker's name finds them too; a free one says so.
    await act(async () => fireEvent.change(search, { target: { value: "nvidia" } }));
    expect(rowsOf(d)).toContainEqual(["NVIDIA: Nemotron 3 Ultra (free)", "Grátis, com limite diário"]);
    await act(async () => fireEvent.change(search, { target: { value: "glm" } }));
    await pickRow(d, "Z.ai: GLM Latest");
    await confirmScreen(d);
    await settle(6);
    expect(state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2])).toEqual([
      { model: "~z-ai/glm-latest" },
    ]);
  });

  test("the search finds a model by several words, its maker's and its own, in any order", async () => {
    const seeded = seedState({ extraModels: OPENROUTER_MODELS });
    seeded.credentials.push(OPENROUTER_KEY);
    await open(seeded);
    const d = await brainDialog();
    await toScreen(d, "Modelo");
    const search = within(d).getByRole("searchbox", { name: "Buscar modelos" });
    // Each word on its own: they aren't side by side in the label.
    for (const value of ["nvidia free", "free nvidia"]) {
      await act(async () => fireEvent.change(search, { target: { value } }));
      expect(rowsOf(d)).toEqual([["NVIDIA: Nemotron 3 Ultra (free)", "Grátis, com limite diário"]]);
    }
    await act(async () => fireEvent.change(search, { target: { value: "nvidia sonnet" } }));
    expect(rowsOf(d)).toEqual([]);
  });

  test("without an OpenRouter key its good picks show, each saying a key opens it, and not the rest of its list", async () => {
    await open(seedState({ extraModels: OPENROUTER_MODELS }));
    const d = await brainDialog();
    await toScreen(d, "Modelo");
    const picks = brainRows(d).filter((r) => r.group === "OpenRouter · Boas escolhas");
    expect(picks.map((r) => [r.title, ...r.lines, r.off])).toEqual([
      ["Z.ai: GLM Latest", "Precisa de uma chave de API OpenRouter", true],
      ["DeepSeek: DeepSeek Flash Latest", "Precisa de uma chave de API OpenRouter", true],
      ["Claude Sonnet Latest", "Precisa de uma chave de API OpenRouter", true],
    ]);
    expect(groupsOf(d)).not.toContain("OpenRouter");
  });
});

describe("Velocidade (ADR 0149)", () => {
  async function onChatGpt(patch: Partial<AgentBrain> = {}, line?: Partial<NonNullable<Agent["brain"]>>) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada && line) ada.brain = { kind: "codex", model: "GPT-6 Sol", ...line };
    follow(api, fakeAgentBrain(ADA_ID, { brain: "codex", effectiveModel: "gpt-6-sol", onlyOwner: true, ...patch }));
    return open(state, api);
  }
  const speed = (d: HTMLElement) => within(d).queryByRole("radiogroup", { name: "Velocidade" });
  /** "Quem pensa", on "Mais opções" with Velocidade open. */
  const speedOpen = async () => {
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    await toScreen(d, "Velocidade");
    return d;
  };

  test("on a ChatGPT plan with a model that has it: Padrão first, Rápida saved with Concluído, the help says what it costs", async () => {
    const { state } = await onChatGpt();
    const d = await brainDialog();
    expect(lineOf(d, "Mais opções")).toBe("Esforço, velocidade, janela de contexto e quem atende");
    await toScreen(d, "Mais opções");
    expect(lineOf(d, "Velocidade")).toBe("Padrão");
    await toScreen(d, "Velocidade");
    const [standard, fast] = within(speed(d) as HTMLElement).getAllByRole("radio");
    expect(standard?.textContent).toBe("Padrão");
    expect(standard?.getAttribute("aria-checked")).toBe("true");
    expect(fast?.textContent).toBe("Rápida");
    expect(d.textContent).toContain(
      "Responde mais rápido nas conversas e gasta o plano 2,5× mais depressa. Rotinas e tarefas longas seguem no padrão.",
    );
    await click(fast as HTMLElement);
    expect(lineOf(d, "Velocidade")).toBe("Rápida");
    await done(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "codex", speed: "fast" }]);
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
  });

  test("Padrão left alone sends nothing; a saved Rápida shows chosen", async () => {
    const { state } = await onChatGpt({ speed: "fast" });
    const d = await speedOpen();
    expect(
      within(speed(d) as HTMLElement)
        .getByRole("radio", { name: "Rápida" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await done(d);
    await settle(4);
    expect(brainCalls(state)).toEqual([]);
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
  });

  test("no control on a model without it or on Claude; a saved Rápida stays saved, and nothing says it", async () => {
    const first = await onChatGpt({ effectiveModel: "gpt-5.5", model: "gpt-5.5", speed: "fast" });
    expect(brainCell().value).not.toContain("Rápida");
    let d = await brainDialog();
    await toScreen(d, "Mais opções");
    expect(lineOf(d, "Velocidade")).toBeUndefined();
    expect(speed(d)).toBeNull();
    await done(d);
    await settle(4);
    expect(brainCalls(first.state)).toEqual([]);
    cleanup();
    await onChatGpt({ brain: "claude_code", effectiveModel: "sonnet" });
    d = await brainDialog();
    expect(lineOf(d, "Mais opções")).not.toContain("velocidade");
    await toScreen(d, "Mais opções");
    expect(lineOf(d, "Velocidade")).toBeUndefined();
    expect(speed(d)).toBeNull();
  });

  test("a save that fails says so and leaves the choice in the open dialog", async () => {
    const { api } = await onChatGpt();
    api.agents.setBrain = async () => {
      throw new Error("offline");
    };
    const d = await speedOpen();
    await click(within(speed(d) as HTMLElement).getByRole("radio", { name: "Rápida" }));
    await done(d);
    await settle(6);
    expect(screen().getByText("Não deu para salvar. Tente de novo.")).toBeTruthy();
    expect(brainScreen(d)).toBe("Mais opções da Ada");
    expect(screen().getByRole("dialog", { name: "Mais opções da Ada" })).toBe(d);
    expect(lineOf(d, "Velocidade")).toBe("Rápida");
  });

  test("Esforço on Mais opções: a level moved on the ramp is saved alone by Concluído", async () => {
    const { state } = await onChatGpt();
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    await toScreen(d, "Esforço");
    const ramp = within(d).getByRole("slider", { name: "Esforço" });
    await act(async () => fireEvent.keyDown(ramp, { key: "ArrowRight" }));
    await settle(2);
    expect(lineOf(d, "Esforço")).toBe("Alto");
    await done(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "codex", effort: "high" }]);
  });
});

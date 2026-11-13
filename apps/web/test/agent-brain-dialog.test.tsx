import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { AgentBrain, AiComputer, MachineAccount } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
import { ADA_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/*
 * "Quem pensa" on the agent's page (ADR 0032 §5, addendum 2026-11-10): a dialog of screens, each saving its own
 * change. Its first screen shows what the agent thinks with; "Trocar de conta" lists every way it can think and
 * switches on its main button, the agent moving to the computer that runs a plan first; "Modelo" saves the model; a row
 * that needs a sign-in opens it in the dialog (ADR 0041), and the switch saves once it signs in.
 */

afterEach(() => {
  cleanup();
  setSystemTime();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
const callOrder = (state: ReturnType<typeof seedState>) =>
  state.calls.map((c) => c.method).filter((m) => m === "sandbox.setTarget" || m === "agents.setBrain");

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
/** The current row of the first screen (`still`): what it thinks with now. */
const inUse = (d: HTMLElement) => brainRows(d).find((r) => r.still);
/** A row on "Trocar de conta" other than the one in use. */
const notInUse = (title: string) => (r: { title: string; group: string }) =>
  r.group !== "Em uso" && r.title.startsWith(title);

describe("Quem pensa (its dialog)", () => {
  test("the first screen, then every way it can think: the key in use, the plans by their makers' marks, where each would run", async () => {
    await open();
    const d = await brainDialog();
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
    // Only for this agent, said by its name at the foot.
    expect(shownText(d)).toContain("Vale só para a Ada.");
    // The key it thinks with, as a row shown alone; the model and "Mais opções" one line each.
    expect(inUse(d)?.mark).toBe("claude");
    expect(brainLines(d).map((l) => l.label)).toEqual(["Modelo", "Mais opções"]);
    // Lines that go on to another screen of this dialog open no popup of their own.
    for (const line of d.querySelectorAll(".bd-line")) expect(line.getAttribute("aria-haspopup")).toBeNull();
    await toScreen(d, "Trocar de conta");
    expect(brainScreen(d)).toBe("Trocar a conta da Ada");
    // The screen that takes the focus is named by its title, which a screen reader says on the move.
    expect(within(d).getByRole("group", { name: "Trocar a conta da Ada" }).classList.contains("bd-screen")).toBe(true);
    const rows = brainRows(d);
    // The agent has no computer: a plan says where it will go, before it is chosen; each by its maker's mark.
    const plan = (title: string) => rows.find(notInUse(title));
    expect(plan("Claude")).toMatchObject({ lines: ["Vai para o MacBook"], mark: "claude", off: false });
    expect(plan("ChatGPT")).toMatchObject({ lines: ["Vai para o MacBook"], mark: "openai", off: false });
    expect(rows[0]?.group).toBe("Em uso");
  });

  test("Cursor (ADR 0114): its mark on the row in use, its models the plan's first, said so", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const base = fakeAgentBrain(ADA_ID);
    const cursor = {
      kind: "cursor" as const,
      available: true,
      models: [
        { value: "grok-5-code", label: "Grok 5 Code", inPlan: true },
        { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
      ],
      defaultModel: null,
    };
    const options = [...base.options, cursor];
    const machines = [{ machineId: "machine_1", name: "MacBook", online: true, options }];
    // On Cursor already: the model screen is the plan in use's (ADR 0032 addendum: each screen saves its own change).
    api.agents.brain = async () => ({ ...base, brain: "cursor", options, machines });
    await open(state, api);
    const d = await brainDialog();
    expect(inUse(d)).toMatchObject({ title: "Cursor", mark: "cursor" });
    await toScreen(d, "Modelo");
    expect(brainScreen(d)).toBe("Modelo da Ada");
    const models = brainRows(d);
    expect(models.find((r) => r.title === "Grok 5 Code")?.lines.join(" ")).toContain("No seu plano do Cursor");
    expect(models.find((r) => r.title === "Claude Opus 5.5")?.lines.join(" ")).toContain(
      "O Cursor cobra pelo preço da API",
    );
  });

  test("on the computer it already works on: no side words on the plans, nothing about the computer", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet" });
    await open(state, api);
    const d = await brainDialog();
    // The computer's own sign-in, by the name the Connect cards give it: nothing about where it runs.
    expect(inUse(d)).toMatchObject({ title: "A conta que os seus agentes dividem", mark: "claude", lines: [] });
    expect(shownText(d)).not.toContain("MacBook");
    await toScreen(d, "Trocar de conta");
    expect(brainRows(d).flatMap((r) => r.lines)).not.toContain("Vai para o MacBook");
    expect(shownText(d)).not.toContain("No MacBook");
  });

  test("Claude: the agent moves to the MacBook first, then thinks there; Pronto says both, and whom it answers now", async () => {
    const { state } = await open();
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, notInUse("Claude"));
    expect(mainButton(d)?.textContent).toBe("Trocar para Claude");
    await confirmScreen(d);
    await settle(6);
    expect(callOrder(state)).toEqual(["sandbox.setTarget", "agents.setBrain"]);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args.slice(1)).toEqual([ADA_ID, "machine_1"]);
    // Choosing a plan asks nothing: it answers only its owner until they say otherwise. Its own default model.
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", model: null }]);
    expect(brainScreen(d)).toBe("Pronto");
    expect(shownText(d)).toContain("A Ada agora trabalha no MacBook, pensa com Claude e só atende você.");
    await done(d);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("from the API onto a plan on the computer it works on: it answers only its owner from now on, said on Pronto", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    reportOwn(api, { claude_code: { plan: "max" } });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, (r) => r.mark === "claude" && r.group !== "Em uso");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code" });
    // It stays where it works: the only move is the one this test set up.
    expect(callOrder(state)).toEqual(["sandbox.setTarget", "agents.setBrain"]);
    expect(shownText(d)).toContain("e só atende você.");
    expect(shownText(d)).not.toContain("trabalha no MacBook");
  });

  test("an admin who isn't its owner moves it from the API onto a plan: the rows and Pronto say whose plan it is and whom it answers", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // An old app on the computer: no accounts there, the plans themselves are the rows.
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { canUsePlans: false, canManageAccounts: false, accountsSupported: false });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    const rows = brainRows(d);
    expect(rows.find(notInUse("Claude"))?.lines).toEqual(["Usa o plano do Claude de Walter"]);
    expect(rows.find(notInUse("ChatGPT"))?.lines).toEqual(["Usa o plano do ChatGPT de Walter"]);
    await pickRow(d, notInUse("Claude"));
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ brain: "claude_code" });
    expect(shownText(d)).toContain("A Ada agora pensa com Claude e só atende Walter.");
  });

  test("the fallback to the API is a switch in Mais opções, its ⓘ saying what it does; with no API key anywhere there is none", async () => {
    const plan = async (state: ReturnType<typeof seedState>) => {
      const api = createFakeApi(state);
      api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet" });
      await open(state, api);
      const d = await brainDialog();
      await toScreen(d, "Mais opções");
      return d;
    };
    const SWITCH = "Usar a chave de API se o plano parar";
    const d = await plan(seedState());
    const fallback = within(d).getByRole("switch", { name: SWITCH });
    expect(fallback.getAttribute("aria-checked")).toBe("true");
    const hint = hintOf(SWITCH, d);
    expect(hint.text).toBe(
      "Responde pela API e conta no orçamento da Ada. Se não, a Ada avisa quem chamou e espera o computador voltar.",
    );
    expect(fallback.getAttribute("aria-describedby")).toBe(hint.button.getAttribute("aria-describedby"));
    expect(shownText(d)).not.toContain("avisa quem chamou");
    cleanup();
    const none = await plan(
      seedState({
        aiStatus: {
          any: true,
          agents: [{ agentId: ADA_ID, state: "ready" }],
          routing: { by: "rules", mine: "rules", model: null, noSmallModel: null },
          apiKey: false,
        },
      }),
    );
    expect(within(none).queryByRole("switch", { name: SWITCH })).toBeNull();
    expect(none.textContent).not.toContain("chave de API se o plano parar");
  });

  test("a saved plan brain changes its model on Modelo: Usar <model> saves only the model", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { brain: "codex", model: null, effectiveModel: "gpt-6-sol" });
    await open(state, api);
    // The plan that pays for it in the label, the model it runs and its effort under it.
    expect(brainCell()).toEqual({ label: "Pensa com ChatGPT", value: "GPT-6 Sol · esforço médio", sub: undefined });
    const d = await brainDialog();
    expect(brainLines(d)[0]).toEqual({ label: "Modelo", value: "GPT-6 Sol" });
    await toScreen(d, "Modelo");
    // What's saved is picked: nothing to save yet.
    expect(mainButton(d)?.disabled).toBe(true);
    await pickRow(d, "GPT-6 Luna");
    expect(mainButton(d)?.textContent).toBe("Usar GPT-6 Luna");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "codex", model: "gpt-6-luna" }]);
    // Saved, it is back on the first screen.
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
  });

  test("a saved plan no computer runs right now still saves its own model (Usar isn't stuck)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const base = fakeAgentBrain(ADA_ID, { brain: "codex", model: null, effectiveModel: "gpt-6-sol" });
    const options = base.options.map((o) =>
      o.kind === "codex" ? { ...o, available: false, reason: "exec_off" as const } : o,
    );
    api.agents.brain = async () => ({
      ...base,
      options,
      machines: [{ machineId: "machine_1", name: "MacBook", online: true, options }],
    });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Modelo");
    expect(mainButton(d)?.disabled).toBe(true);
    await pickRow(d, "GPT-6 Luna");
    expect(mainButton(d)?.disabled).toBe(false);
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "codex", model: "gpt-6-luna" });
  });

  test("what no computer has isn't offered; the plan in use says why", async () => {
    const notInstalled = (patch: Partial<AgentBrain>) => {
      const state = seedState();
      const api = createFakeApi(state);
      const base = fakeAgentBrain(ADA_ID, patch);
      const options = base.options.map((o) =>
        o.kind === "codex" ? { ...o, available: false, reason: "not_installed" as const } : o,
      );
      api.agents.brain = async () => ({
        ...base,
        options,
        machines: [{ machineId: "machine_1", name: "MacBook", online: true, options }],
      });
      return open(state, api);
    };
    // On the key: ChatGPT is no way to think, so it isn't listed (ADR 0032 addendum: the list is every way it can).
    await notInstalled({});
    let d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(brainRows(d).some((r) => r.title.startsWith("ChatGPT"))).toBe(false);
    expect(brainRows(d).some((r) => r.title.startsWith("Claude"))).toBe(true);
    cleanup();
    // On ChatGPT with no sign-in of it there yet, the row in use is the plan itself: it says why it can't think now.
    await notInstalled({ brain: "codex", effectiveModel: "gpt-6-sol", ownSignIn: false });
    d = await brainDialog();
    expect(inUse(d)).toMatchObject({ title: "ChatGPT", lines: ["O Codex não está instalado no MacBook."] });
  });

  test("the plan in use through the computer's own sign-in, its program on no computer: the first screen says why", async () => {
    const onIt = async (kind: "codex" | "claude_code", reason: "not_installed" | "tool_off") => {
      cleanup();
      const state = seedState();
      const api = createFakeApi(state);
      fakeMachinesOf.get(api)?.pair({ id: "machine_1", name: "MacBook", os: "darwin" });
      const computer = { machineId: "machine_1", name: "MacBook", online: true };
      // The computer's own sign-in thinks for it (the default): the row in use is that sign-in, not the plan.
      const base = fakeAgentBrain(ADA_ID, {
        brain: kind,
        effectiveModel: kind === "codex" ? "gpt-6-sol" : "sonnet",
        computer,
      });
      const options = base.options.map((o) => (o.kind === kind ? { ...o, available: false, reason } : o));
      api.agents.brain = async () => ({ ...base, options, machines: [{ ...computer, options }] });
      await open(state, api);
      const d = await brainDialog();
      expect(inUse(d)?.title).toBe("A conta que os seus agentes dividem");
      return shownText(d);
    };
    // Why it can't think there and what to do, never only that no computer has it.
    let text = await onIt("codex", "not_installed");
    expect(text).toContain("O Codex não está instalado no MacBook.");
    expect(text).not.toContain("Nenhum computador tem");
    text = await onIt("claude_code", "tool_off");
    expect(text).toContain(
      "O Claude Code está desligado no MacBook. Ligue lá, no app do agentes.chat: Preferências → Ferramentas.",
    );
    expect(text).not.toContain("Nenhum computador tem");
  });

  test("on the Cloud the plan in use says what the workspace's computer is doing", async () => {
    const reason = async (kind: "codex" | "claude_code") => {
      cleanup();
      const state = seedState();
      const api = createFakeApi(state);
      const machines = fakeMachinesOf.get(api);
      machines?.pair({ id: "machine_1", name: "MacBook", os: "linux", mode: "system" });
      machines?.setSetup({ state: "ready", machineId: "machine_1", since: new Date().toISOString() });
      // The workspace's computer: nobody signs in at its terminal, so the row in use is the plan itself.
      const base = fakeAgentBrain(ADA_ID, {
        brain: kind,
        effectiveModel: kind === "codex" ? "gpt-6-sol" : "sonnet",
        ownSignIn: false,
      });
      const options = base.options.map((o) =>
        o.kind === "codex"
          ? { ...o, available: false, reason: "not_installed" as const }
          : o.kind === "claude_code"
            ? { ...o, available: false, reason: "tool_off" as const }
            : o,
      );
      api.agents.brain = async () => ({
        ...base,
        options,
        machines: [{ machineId: "machine_1", name: "MacBook", online: true, options }],
      });
      await open(state, api);
      return shownText(await brainDialog());
    };
    expect(await reason("codex")).toContain(
      "O Codex está sendo instalado no MacBook. Isto muda sozinho quando terminar.",
    );
    // Never the command for a computer of the person's own.
    expect(await reason("claude_code")).toContain(
      "O Claude Code ainda não está liberado no MacBook. Isso é do nosso lado: tente de novo mais tarde.",
    );
  });

  test("a tool turned off says where it turns on: the app on a Mac, the app or the command on Linux", async () => {
    const reason = async (os: string, name: string) => {
      cleanup();
      const state = seedState();
      const api = createFakeApi(state);
      fakeMachinesOf.get(api)?.pair({ id: "machine_1", name, os, mode: "system" });
      const computer = { machineId: "machine_1", name, online: true };
      // No sign-in of Claude there yet: the row in use is the plan itself.
      const base = fakeAgentBrain(ADA_ID, {
        brain: "claude_code",
        effectiveModel: "sonnet",
        computer,
        ownSignIn: false,
      });
      const options = base.options.map((o) =>
        o.kind === "claude_code" ? { ...o, available: false, reason: "tool_off" as const } : o,
      );
      api.agents.brain = async () => ({ ...base, options, machines: [{ ...computer, options }] });
      await open(state, api);
      return shownText(await brainDialog());
    };
    // The row names the plan; its line names the program on the computer.
    expect(await reason("darwin", "MacBook")).toContain(
      "O Claude Code está desligado no MacBook. Ligue lá, no app do agentes.chat: Preferências → Ferramentas.",
    );
    expect(await reason("linux", "Servidor")).toContain(
      "O Claude Code está desligado no Servidor. Ligue lá, no app do agentes.chat ou com sudo agentes-runner tools enable claude.",
    );
  });
});

describe("Quem pensa: the account on the computer and the effort (ADR 0041)", () => {
  const work: MachineAccount = {
    id: "acct_work",
    kind: "claude_code",
    label: "Trabalho",
    email: "walt@acme.com",
    plan: "Team",
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy: [],
    usage: null,
    provider: null,
    keyHint: null,
  };
  /** Walter's Claude account Theo thinks with: one more login of it is Ada's own (a login per agent). */
  const theos: MachineAccount = {
    ...work,
    id: "acct_theo",
    label: "Pessoal",
    email: null,
    plan: "Max",
    usedBy: ["Theo"],
  };
  /**
   * Ada thinks with Claude Code on the MacBook, which has the given accounts; `own`: the MacBook's own sign-ins its
   * runner reported, as its row of the AI accounts says them.
   */
  async function onMac(patch: Partial<AgentBrain> = {}, own?: AiComputer["own"]) {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    if (own) reportOwn(api, own);
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", accounts: [work], ...patch });
    return open(state, api);
  }
  /**
   * A new login opened in the dialog: "Trocar de conta", the account another agent thinks with, then "Fazer login para
   * a Ada" (ADR 0032 addendum: a row that needs a sign-in opens it in the dialog). The add screen, its region.
   */
  async function addLogin(d: HTMLElement, title: string, region = "Adicionar conta do Claude") {
    await toScreen(d, "Trocar de conta");
    await pickRow(d, notInUse(title));
    expect(mainButton(d)?.textContent).toBe("Fazer login para a Ada");
    await confirmScreen(d);
    await settle(6);
    return within(d).getByRole("region", { name: region });
  }

  test("Adicionar conta: no address asked, Claude's page opens beside, Colar sends only this sign-in's code; Voltar stops it", async () => {
    const { state, api } = await onMac({ accounts: [work, theos] });
    const opened: string[] = [];
    const popup = {
      closed: false,
      opener: {},
      location: {
        href: "",
        replace(url: string) {
          this.href = url;
        },
      },
      close: () => {},
    };
    const realOpen = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return popup;
    }) as unknown as typeof window.open;
    let clip = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => clip, writeText: async () => {} },
    });
    try {
      const d = await brainDialog();
      const block = await addLogin(d, "Pessoal");
      expect(brainScreen(d)).toBe("Adicionar conta do Claude");
      // Nothing runs on the computer before the person goes on.
      expect(fakeMachinesOf.get(api)?.lastLogin()).toBeUndefined();
      // Where the account stays is the sign-in step's ⓘ.
      expect(hintOf("A conta com o seu plano", block).text).toBe(
        "Conta errada? Saia de lá e tente de novo. A conta fica só no MacBook. Você digita a senha na página do Claude.",
      );
      expect(shownText(block)).not.toContain("digita a senha");
      // Still no address to type: Claude's own page picks the account.
      expect(block.querySelector("input")).toBeNull();
      // The sign-in's button is the dialog's main action, at its foot.
      expect(mainButton(d)?.textContent).toBe("Entrar com Claude");
      await click(within(d).getByRole("button", { name: "Entrar com Claude" }));
      await settle(6);
      expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
        ORG_ID,
        "machine_1",
        "claude_code",
      ]);
      // The window opened on the click itself went to Claude's page, cut off from the app.
      expect(opened).toEqual(["/conectando?kind=claude_code"]);
      expect(popup.opener).toBeNull();
      expect(popup.location.href).toBe("https://claude.ai/oauth/authorize?code=true&state=st4te");
      expect(within(block).getByRole("link", { name: "Abrir de novo" }).getAttribute("href")).toBe(
        "https://claude.ai/oauth/authorize?code=true&state=st4te",
      );
      const login = fakeMachinesOf.get(api)?.lastLogin();
      expect(login?.kind).toBe("claude_code");
      // Something else on the clipboard (a password) waits for Send, with a line; Colar goes while the field holds it.
      clip = "hunter2-password";
      await click(within(block).getByRole("button", { name: "Colar" }));
      await settle(4);
      expect(fakeMachinesOf.get(api)?.lastLogin()?.box).toBeNull();
      const field = within(block).getByRole("textbox", { name: "Código do Claude" }) as HTMLInputElement;
      expect(field.value).toBe("hunter2-password");
      expect(shownText(block)).toContain("Isso não parece o código do Claude.");
      expect(within(block).queryByRole("button", { name: "Colar" })).toBeNull();
      // Emptied, Colar is back; this sign-in's code (`…#<state>`) goes at once, sealed: the raw code is in no call.
      await act(async () => fireEvent.change(field, { target: { value: "" } }));
      clip = "c0de-from-claude#st4te";
      await click(within(block).getByRole("button", { name: "Colar" }));
      await settle(6);
      expect(fakeMachinesOf.get(api)?.lastLogin()?.box).not.toBeNull();
      expect(JSON.stringify(state.calls)).not.toContain("c0de-from-claude");
      // Nothing is saved before the account signs in.
      expect(brainCalls(state)).toEqual([]);
      await toScreen(d, "Voltar");
      await settle(4);
      expect(state.calls.find((c) => c.method === "machines.cancelAccountLogin")?.args).toEqual([
        ORG_ID,
        "machine_1",
        login?.loginId,
      ]);
      expect(brainScreen(d)).toBe("Trocar a conta da Ada");
    } finally {
      window.open = realOpen;
    }
  });

  test("a sign-in's popup the browser refused: the sign-in goes on and its link is there to open by hand", async () => {
    await onMac({ accounts: [work, theos] });
    const realOpen = window.open;
    window.open = (() => null) as unknown as typeof window.open;
    try {
      const d = await brainDialog();
      const block = await addLogin(d, "Pessoal");
      await click(within(d).getByRole("button", { name: "Entrar com Claude" }));
      await settle(6);
      expect(within(block).getByRole("link", { name: "Abrir de novo" }).getAttribute("href")).toBe(
        "https://claude.ai/oauth/authorize?code=true&state=st4te",
      );
    } finally {
      window.open = realOpen;
    }
  });

  test("a sign-in that can't get its link: the popup closes and the dialog says why", async () => {
    const { api } = await onMac({ accounts: [work, theos] });
    api.machines.beginAccountLogin = async () => {
      throw new Error("the computer didn't answer");
    };
    let closed = 0;
    const popup = { closed: false, opener: {}, location: { replace: () => {} }, close: () => closed++ };
    const realOpen = window.open;
    window.open = (() => popup) as unknown as typeof window.open;
    try {
      const d = await brainDialog();
      const block = await addLogin(d, "Pessoal");
      await click(within(d).getByRole("button", { name: "Entrar com Claude" }));
      await settle(6);
      expect(closed).toBe(1);
      expect(shownText(block)).toContain("O MacBook não respondeu. Tente de novo em instantes.");
    } finally {
      window.open = realOpen;
    }
  });

  test("Add account: Copy link begins the sign-in with no window, copies its link and shows the code step", async () => {
    const { state, api } = await onMac({ accounts: [work, theos] });
    const opened: string[] = [];
    const realOpen = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as unknown as typeof window.open;
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => "",
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    try {
      const d = await brainDialog();
      const block = await addLogin(d, "Pessoal");
      expect(within(block).queryByRole("textbox", { name: "Código do Claude" })).toBeNull();
      // Beside the main action at the dialog's foot.
      await click(within(d).getByRole("button", { name: "Copiar link" }));
      await settle(6);
      expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(1);
      expect(fakeMachinesOf.get(api)?.lastLogin()?.kind).toBe("claude_code");
      expect(opened).toEqual([]);
      expect(written).toEqual(["https://claude.ai/oauth/authorize?code=true&state=st4te"]);
      expect(within(block).getByRole("button", { name: "Copiado" })).toBeTruthy();
      expect(within(block).getByRole("textbox", { name: "Código do Claude" })).toBeTruthy();
      // Copied again, the same sign-in's link: no second one begins.
      await click(within(block).getByRole("button", { name: "Copiado" }));
      await settle(4);
      expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(1);
      expect(written).toHaveLength(2);
    } finally {
      window.open = realOpen;
    }
  });

  /** Claude's sign-in started from a new login in the dialog, its code field showing; the sign-in window a stand-in. */
  async function codeField() {
    const { state, api } = await onMac({ accounts: [work, theos] });
    const d = await brainDialog();
    const block = await addLogin(d, "Pessoal");
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(d).getByRole("button", { name: "Entrar com Claude" }));
      await settle(6);
    } finally {
      window.open = realOpen;
    }
    const field = within(block).getByRole("textbox", { name: "Código do Claude" });
    // ⌘V: the paste lands in the field as its new value.
    const paste = async (text: string) => {
      await act(async () => {
        fireEvent.paste(field, { clipboardData: { getData: () => text } });
        fireEvent.change(field, { target: { value: text } });
      });
      await settle(6);
    };
    const sealed = () => fakeMachinesOf.get(api)?.lastLogin()?.box ?? null;
    /**
     * The code reached the computer and the block says so. Sealing it is WebCrypto, which runs off the JS thread: on a
     * loaded machine it outlasts any number of ticks, so this waits for it instead of counting them.
     */
    const delivered = () =>
      waitFor(
        () => {
          expect(sealed()).not.toBeNull();
          expect(shownText(block)).toContain("Código enviado. O MacBook está terminando de entrar.");
        },
        { timeout: 10_000 },
      );
    return { state, api, block, paste, sealed, delivered };
  }

  test("while the code goes and the computer signs in, a line stands in for the field and its buttons; a failed send brings them back", async () => {
    const { api, block, paste } = await codeField();
    const real = api.machines.sendAccountCode;
    let answer = (_ok: boolean) => {};
    let sends = 0;
    api.machines.sendAccountCode = (...args) =>
      new Promise<void>((resolve, reject) => {
        sends++;
        answer = (ok) => (ok ? resolve(real(...args)) : reject(new Error("offline")));
      });
    /**
     * The `n`th send has reached the API, so `answer` is its own: the code is sealed first, and sealing is WebCrypto,
     * which runs off the JS thread, so on a loaded machine it can outlast any number of ticks.
     */
    const reached = (n: number) => waitFor(() => expect(sends).toBe(n), { timeout: 10_000 });
    const code = () => within(block).getByRole("textbox", { name: "Código do Claude" }) as HTMLInputElement;
    /** The line, alone in the step with the product's spinner: no field, Colar, Enviar or Esperando beside it. */
    const busy = () => {
      const line = within(block).getByRole("status");
      expect(line.querySelector("canvas.ac-pixspin")).not.toBeNull();
      expect(block.querySelector("input")).toBeNull();
      expect(within(block).queryByRole("button", { name: /^(Colar|Enviar ao MacBook)$/ })).toBeNull();
      expect(shownText(block)).not.toContain("Esperando");
      return line;
    };
    code().focus();
    await paste("c0de-from-claude#st4te");
    const going = busy();
    expect(going.textContent).toBe("Enviando o código ao MacBook…");
    // The focus the field had goes to the line, not to the page.
    expect(document.activeElement === going).toBe(true);
    // The send fails: the field is back with the code in it, the error under it, and the focus.
    await reached(1);
    await act(async () => answer(false));
    await settle(4);
    expect(code().value).toBe("c0de-from-claude#st4te");
    expect(document.activeElement === code()).toBe(true);
    expect(shownText(block)).toContain("Não deu para enviar o código. Confira e tente de novo.");
    expect(shownText(block)).not.toContain("Enviando o código");
    // Sent again: the line says the computer is signing in, until the sign-in ends.
    await click(within(block).getByRole("button", { name: "Enviar ao MacBook" }));
    expect(busy().textContent).toBe("Enviando o código ao MacBook…");
    await reached(2);
    await act(async () => answer(true));
    await settle(6);
    expect(busy().textContent).toBe("Código enviado. O MacBook está terminando de entrar.");
    expect(shownText(block)).not.toContain("Não deu para enviar o código.");
  });

  test("the computer giving up on the code ends the sign-in with its reason, the focus still in the block", async () => {
    const { api, block, paste } = await codeField();
    const machines = fakeMachinesOf.get(api);
    machines?.endLogin(machines.lastLogin()?.loginId ?? "", { state: "failed" });
    (within(block).getByRole("textbox", { name: "Código do Claude" }) as HTMLInputElement).focus();
    await paste("c0de-from-claude#st4te");
    expect(shownText(block)).toContain("Não deu para entrar nessa conta. Tente de novo.");
    expect(within(block).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    expect(within(block).queryByRole("status")).toBeNull();
    expect(document.activeElement === block).toBe(true);
  });

  test("Claude's code pasted into its field with ⌘V goes to the computer by itself, no click", async () => {
    const { state, block, paste, delivered } = await codeField();
    await paste("c0de-from-claude#st4te");
    await delivered();
    expect(JSON.stringify(state.calls)).not.toContain("c0de-from-claude");
    expect(shownText(block)).not.toContain("Isso não parece o código do Claude.");
  });

  test("Colar refused by the browser, then ⌘V: the code goes, and the refusal's line with it", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => {
          throw new Error("denied");
        },
        writeText: async () => {},
      },
    });
    const { block, paste, delivered } = await codeField();
    await click(within(block).getByRole("button", { name: "Colar" }));
    await settle(4);
    expect(shownText(block)).toContain("O navegador não deixou colar.");
    await paste("c0de-from-claude#st4te");
    await delivered();
    expect(shownText(block)).not.toContain("O navegador não deixou colar.");
  });

  test("a code that isn't this sign-in's waits for Enviar, the one action, with a line under it", async () => {
    const { block, paste, sealed, delivered } = await codeField();
    await paste("c0de-from-claude#another-state");
    expect(sealed()).toBeNull();
    expect(shownText(block)).toContain("Isso não parece o código do Claude.");
    expect(within(block).queryByRole("button", { name: "Colar" })).toBeNull();
    const send = within(block).getByRole("button", { name: "Enviar ao MacBook" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await click(send);
    await delivered();
  });

  test("Claude's code sent while the server restarts: the computer didn't answer, not a wrong code; Enviar sends it again", async () => {
    const { api, block, paste, sealed } = await codeField();
    const sendCode = api.machines.sendAccountCode;
    api.machines.sendAccountCode = async () => {
      throw new ApiError(502, "http_502", "Bad Gateway");
    };
    // The code is sealed before it is sent, and sealing (WebCrypto) runs off the JS thread: no number of ticks waits
    // for it on a busy machine.
    const shows = (text: string) => waitFor(() => expect(shownText(block)).toContain(text), { timeout: 10_000 });
    await paste("c0de-from-claude#st4te");
    await shows("O MacBook não respondeu. Tente de novo em instantes.");
    expect(shownText(block)).not.toContain("Confira");
    // The computer refusing it is still about the code.
    api.machines.sendAccountCode = async () => {
      throw new ApiError(400, "account.invalid_code", "The sealed code is malformed");
    };
    // A line stands in for the field and its buttons while the code goes: Enviar is a new button after each send.
    const send = () => within(block).getByRole("button", { name: "Enviar ao MacBook" });
    await click(send());
    await shows("Não deu para enviar o código. Confira e tente de novo.");
    expect(shownText(block)).not.toContain("não respondeu");
    api.machines.sendAccountCode = sendCode;
    await click(send());
    await shows("Código enviado. O MacBook está terminando de entrar.");
    expect(sealed()).not.toBeNull();
  });

  /** Walter's ChatGPT account Theo thinks with, and the new login of it that signs in for Ada. */
  const theosCodex: MachineAccount = {
    ...work,
    id: "acct_theo",
    kind: "codex",
    label: "Pessoal",
    email: null,
    plan: "Plus",
    usedBy: ["Theo"],
  };
  const codex: MachineAccount = { ...theosCodex, id: "acct_codex", usedBy: [] };

  test("Adicionar conta (ChatGPT): its settings first, then the sign-in on its button; signed in, the switch is saved", async () => {
    const { state, api } = await onMac({ brain: "codex", effectiveModel: "gpt-6-sol", accounts: [theosCodex] });
    // The computer finishes the first sign-in as soon as the page asks.
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: codex });
    const d = await brainDialog();
    const block = await addLogin(d, "Pessoal", "Adicionar conta do ChatGPT");
    await settle(8);
    // Showing the steps starts nothing: device code sign-in has to be allowed in ChatGPT first.
    expect(state.calls.some((c) => c.method === "machines.beginAccountLogin")).toBe(false);
    expect(within(block).getByRole("link", { name: "Abrir as configurações do ChatGPT" })).toBeTruthy();
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(d).getByRole("button", { name: "Entrar com ChatGPT" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "codex",
    ]);
    // The account it signed in thinks for Ada at once: the last screen says so.
    expect(within(d).queryByRole("region", { name: "Adicionar conta do ChatGPT" })).toBeNull();
    expect(brainScreen(d)).toBe("Pronto");
    expect(shownText(d)).toContain("A Ada agora pensa com Pessoal · Plus.");
    expect(state.calls.some((c) => c.method === "machines.cancelAccountLogin")).toBe(false);
    expect(brainCalls(state)).toEqual([{ brain: "codex", account: "acct_codex" }]);
  });

  test("Adicionar conta (ChatGPT) while the server restarts: Reconectando, never a failure or an offline computer, then the account, one sign-in", async () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    const { state, api, services } = await onMac({
      brain: "codex",
      effectiveModel: "gpt-6-sol",
      accounts: [theosCodex],
    });
    let online = true;
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => {
      const view = await viewOf(orgId, agentId);
      const on = <T extends { online: boolean }>(m: T) => ({ ...m, online });
      return { ...view, computer: view.computer && on(view.computer), machines: view.machines.map(on) };
    };
    const d = await brainDialog();
    const block = await addLogin(d, "Pessoal", "Adicionar conta do ChatGPT");
    await settle(8);
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(d).getByRole("button", { name: "Entrar com ChatGPT" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    const read = api.machines.accountLogin;
    const ask = async (after: number, error?: Error) => {
      setSystemTime(new Date(start + after));
      api.machines.accountLogin = error
        ? async () => {
            throw error;
          }
        : read;
      await act(() => services.queryClient.invalidateQueries());
      await settle(6);
    };
    // The MacBook drops out with its runner: no answer, then only the proxy's, then the computer still
    // reconnecting, for 20 s. The sign-in's block says so; no brain there reads as offline meanwhile.
    online = false;
    for (const [after, error] of [
      [3_000, new TypeError("Failed to fetch")],
      [10_000, new ApiError(502, "http_502", "Bad Gateway")],
      [20_000, new ApiError(409, "machine.offline", "The computer MacBook is offline.")],
    ] as const) {
      await ask(after, error);
      expect(shownText(block)).toContain("Reconectando…");
      expect(d.textContent).not.toMatch(/Não deu para entrar|não respondeu|está offline/);
    }
    // The sign-in went on there meanwhile: the switch is saved and said.
    online = true;
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: codex });
    await ask(22_000);
    expect(brainScreen(d)).toBe("Pronto");
    expect(shownText(d)).toContain("A Ada agora pensa com Pessoal · Plus.");
    expect(d.textContent).not.toMatch(/Não deu para entrar|não respondeu/);
    expect(state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(1);
    expect(state.calls.some((c) => c.method === "machines.cancelAccountLogin")).toBe(false);
    // With no sign-in under way, an offline computer says so again.
    await done(d);
    online = false;
    await ask(30_000);
    expect(shownText(await brainDialog())).toContain("O MacBook está offline");
  });

  test("Entrar de novo on the first screen: the account in use signs in again with its own address, and is in use again", async () => {
    const { state, api } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, status: "signed_out", usedBy: ["Ada"] }],
    });
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: { ...work, usedBy: ["Ada"] } });
    const d = await brainDialog();
    expect(inUse(d)?.lines.join(" ")).toContain("Saiu da conta, entre de novo");
    expect(mainButton(d)?.textContent).toBe("Entrar de novo");
    await toScreen(d, "Entrar de novo");
    expect(brainScreen(d)).toBe("Entrar de novo");
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    // Its own address goes to Claude's sign-in unasked.
    expect(block.querySelector("input")).toBeNull();
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(d).getByRole("button", { name: "Entrar com Claude" }));
      await settle(8);
    } finally {
      window.open = realOpen;
    }
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { accountId: "acct_work", email: "walt@acme.com" },
    ]);
    // Nothing to switch: back on the first screen, said.
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
    expect(shownText(d)).toContain("A conta Trabalho entrou de novo no MacBook. Já está em uso.");
    expect(brainCalls(state)).toEqual([]);
  });

  test("past three ways to think, the three with most room come first, the one with most room picked; Ver as N contas lists every one under a search", async () => {
    const used = (usedPercent: number) => ({
      windows: [{ kind: "five_hour" as const, usedPercent }],
      source: "probe" as const,
      at: new Date().toISOString(),
    });
    const of = (id: string, label: string, usedPercent: number): MachineAccount => ({
      ...work,
      id,
      label,
      email: `${id}@acme.com`,
      plan: "Max",
      usage: used(usedPercent),
    });
    const { state } = await onMac({
      accounts: [
        of("acct_a", "Trabalho", 70),
        of("acct_b", "Folga", 5),
        of("acct_c", "Pessoal", 40),
        of("acct_d", "Reserva", 90),
      ],
    });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    const best = brainRows(d).filter((r) => r.group === "Com mais folga agora");
    expect(best.map((r) => [r.title, r.room])).toEqual([
      ["Folga · Max", "5%"],
      ["Pessoal · Max", "40%"],
      ["Trabalho · Max", "70%"],
    ]);
    // How full each one is is read with its row, below 80% too: only the bar is hidden from a screen reader.
    expect(within(d).getByRole("radio", { name: /Pessoal · Max.*40\s?%/ })).toBeTruthy();
    for (const pct of d.querySelectorAll(".arrival-have__pct")) expect(pct.closest("[aria-hidden]")).toBeNull();
    expect(best[0]?.checked).toBe(true);
    expect(mainButton(d)?.textContent).toBe("Trocar para Folga · Max");
    await toScreen(d, "Ver as");
    expect(brainScreen(d)).toBe("Todas as contas");
    expect(brainRows(d).some((r) => r.title === "Reserva · Max")).toBe(true);
    await act(async () =>
      fireEvent.change(within(d).getByRole("searchbox", { name: "Buscar conta ou pessoa" }), {
        target: { value: "reserva" },
      }),
    );
    await settle(2);
    expect(brainRows(d).map((r) => r.title)).toEqual(["Reserva · Max"]);
    await pickRow(d, "Reserva");
    await confirmScreen(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", account: "acct_d" }]);
    expect(brainScreen(d)).toBe("Pronto");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, AiComputer, MachineAccount, PlanUsage } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { brainDialog, brainLines, brainRows, brainScreen, done, mainButton, pickRow, toScreen } from "./ai-picker";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, NOW, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/*
 * "Quem pensa" and the accounts on the agent's computer (ADR 0041, ADR 0059; the dialog of ADR 0032 §5, addendum
 * 2026-11-10): "Trocar de conta" lists every way it can think, the one in use first; a row that needs a sign-in signs
 * this agent in on the computer, then thinks with it; at its limit the dialog opens on the accounts with room. "Mais
 * opções" holds the effort, whom it answers and "Usar em outros agentes" (ADR 0094), which takes what is saved.
 */

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(2);
};
const brainCalls = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.setBrain").map((c) => c.args[2]);
const loginArgs = (state: ReturnType<typeof seedState>) =>
  state.calls.find((c) => c.method === "machines.beginAccountLogin")?.args;

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
/** Presses a sign-in's button (in the dialog's footer), the provider's page opening beside. */
async function signIn(d: HTMLElement, name: string, wait = 8) {
  const realOpen = window.open;
  window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
  try {
    await click(within(d).getByRole("button", { name }));
    await settle(wait);
  } finally {
    window.open = realOpen;
  }
}
/** The rows of "Trocar de conta" but the one in use. */
const others = (d: HTMLElement) => brainRows(d).filter((r) => r.group !== "Em uso");

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

  test("the cell names the account when the computer has more than one; the effort and the account each save on their own screen", async () => {
    const { state } = await onMac();
    // The computer's own sign-in by the name the Connect cards give it, never the computer's.
    expect(brainCell()).toEqual({
      label: "Pensa com Claude",
      value: "Sonnet · esforço médio",
      sub: "A conta que os seus agentes dividem",
    });
    expect(sentence().textContent).not.toContain("Conta deste MacBook");
    const d = await brainDialog();
    expect(brainRows(d).map((r) => [r.title, r.still])).toEqual([["A conta que os seus agentes dividem", true]]);
    // Effort, under "Mais opções": the pixel ramp, a slider (Médio → Alto with the arrow key).
    await toScreen(d, "Mais opções");
    await toScreen(d, "Esforço");
    const effort = within(d).getByRole("slider", { name: "Esforço" });
    expect(effort.getAttribute("aria-valuetext")).toBe("Médio");
    await act(async () => fireEvent.keyDown(effort, { key: "ArrowRight" }));
    expect(effort.getAttribute("aria-valuetext")).toBe("Alto");
    expect(d.textContent).toContain("Pensa mais em tarefas difíceis.");
    await done(d);
    await settle(6);
    expect(brainCalls(state)).toEqual([{ brain: "claude_code", effort: "high" }]);
    // Back on the first screen: another account of the same plan, nothing else sent.
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
    await toScreen(d, "Trocar de conta");
    expect(brainRows(d).map((r) => [r.group, r.title, r.lines])).toEqual([
      ["Em uso", "A conta que os seus agentes dividem", []],
      ["Suas", "Trabalho · Team", ["walt@acme.com"]],
      ["Chave do workspace", "Chave padrão do workspace", ["Claude · termina em 7f2a"]],
    ]);
    await pickRow(d, "Trabalho");
    expect(mainButton(d)?.textContent).toBe("Trocar para Trabalho · Team");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", account: "acct_work" });
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("an account made for all of the person's agents there: picked as it is, Also used by Theo, no sign-in, no move", async () => {
    const shared: MachineAccount = {
      ...work,
      id: "acct_all",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Max",
      usedBy: ["Theo"],
      shared: true,
    };
    const { state } = await onMac({ accounts: [work, shared] });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(brainRows(d).find((r) => r.title === "Pessoal · Max")?.lines).toEqual(["Também usada por Theo"]);
    await pickRow(d, "Pessoal");
    expect(mainButton(d)?.textContent).toBe("Trocar para Pessoal · Max");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(within(d).queryByRole("region", { name: "Adicionar conta do Claude" })).toBeNull();
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_all" });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("moveAccount");
    expect(state.calls.find((c) => c.method === "machines.beginAccountLogin")).toBeUndefined();
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("each person's own: a Claude account another agent thinks with signs in again for this one; someone else's only shows while it's this one's", async () => {
    const theo: MachineAccount = {
      ...work,
      id: "acct_theo",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Max",
      usedBy: ["Theo"],
    };
    const hers: MachineAccount = {
      ...work,
      id: "acct_ana",
      label: "Claude Team 2",
      email: null,
      ownerId: "u-ana",
      ownerName: "Ana Lima",
      mine: false,
      usedBy: ["Ada"],
    };
    const other: MachineAccount = { ...hers, id: "acct_ana2", label: "Claude Team 3", usedBy: [] };
    const { state, api } = await onMac(
      { account: "acct_ana", accounts: [work, theo, hers, other] },
      { claude_code: { plan: "max" } },
    );
    // Ada's own login of Pessoal, once Claude's page signs her in.
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: { ...theo, id: "acct_ada", usedBy: [] } });
    const d = await brainDialog();
    // Ana's account thinks for Ada: in use, said whose it is.
    expect(brainRows(d).map((r) => [r.title, r.lines])).toEqual([["Claude Team 2", ["De Ana"]]]);
    await toScreen(d, "Trocar de conta");
    await click(within(d).getByRole("button", { name: /^Ver as/ }));
    const rows = brainRows(d);
    // The computer's own sign-in says its plan under its name, as "Seus planos" titles it; Ana's other account,
    // thinking for nobody here, isn't Ada's to pick.
    expect(rows.find((r) => r.title === "A conta que os seus agentes dividem")?.lines).toEqual(["Claude · Max"]);
    expect(rows.find((r) => r.title === "Pessoal · Max")?.lines).toEqual(["Também usada por Theo"]);
    expect(rows.map((r) => r.title)).not.toContain("Claude Team 3");
    await pickRow(d, "Pessoal");
    expect(mainButton(d)?.textContent).toBe("Fazer login para a Ada");
    await click(mainButton(d) as HTMLElement);
    expect(within(d).getByRole("region", { name: "Adicionar conta do Claude" })).toBeTruthy();
    await signIn(d, "Entrar com Claude");
    // A sign-in of Ada's own, Theo's account named to Claude's page unseen; nothing taken from Theo.
    expect(loginArgs(state)).toEqual([ORG_ID, "machine_1", "claude_code", { email: "walt@pessoal.com" }]);
    // Signed in, it thinks with it at once.
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_ada" });
    expect(brainCalls(state).at(-1)).not.toHaveProperty("moveAccount");
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("her own login signed out, an account another agent uses: a new login of that account, never hers again", async () => {
    const theo: MachineAccount = {
      ...work,
      id: "acct_theo",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Max",
      usedBy: ["Theo"],
    };
    const { state } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, status: "signed_out", usedBy: ["Ada"] }, theo],
    });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, "Pessoal");
    await click(mainButton(d) as HTMLElement);
    expect(within(d).getByRole("region", { name: "Adicionar conta do Claude" })).toBeTruthy();
    await signIn(d, "Entrar com Claude");
    expect(loginArgs(state)).toEqual([ORG_ID, "machine_1", "claude_code", { email: "walt@pessoal.com" }]);
  });

  test("ChatGPT like Claude: an account another agent thinks with signs in again for this one, never moved", async () => {
    const theo: MachineAccount = {
      ...work,
      id: "acct_theo",
      kind: "codex",
      label: "Pessoal",
      email: "walt@pessoal.com",
      plan: "Plus",
      usedBy: ["Theo"],
    };
    const { state } = await onMac({ brain: "codex", effectiveModel: "gpt-6-sol", accounts: [theo] });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(brainRows(d).find((r) => r.title === "Pessoal · Plus")?.lines).toEqual(["Também usada por Theo"]);
    await pickRow(d, "Pessoal");
    expect(mainButton(d)?.textContent).toBe("Fazer login para a Ada");
    await click(mainButton(d) as HTMLElement);
    expect(within(d).getByRole("region", { name: /^Adicionar conta/ })).toBeTruthy();
    expect(brainCalls(state)).toEqual([]);
  });

  test("plan usage: at the limit it opens on its owner's free accounts with room, never another agent's", async () => {
    const now = new Date().toISOString();
    const full: PlanUsage = {
      windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() }],
      limited: true,
      source: "turn",
      at: now,
    };
    const some = (usedPercent: number): PlanUsage => ({
      windows: [{ kind: "five_hour", usedPercent }],
      source: "probe",
      at: now,
    });
    const roomy: MachineAccount = { ...work, id: "acct_roomy", label: "Claude Team 2", usage: some(12) };
    const busy: MachineAccount = { ...work, id: "acct_busy", label: "Claude Team 3", usedBy: ["Theo"], usage: some(3) };
    const { state } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, usedBy: ["Ada"], usage: full }, roomy, busy],
    });
    // The work cell says it, where the account is.
    expect(sentence().textContent).toContain("Trabalho · No limite até");
    const d = await brainDialog(/no limite$/);
    expect(brainScreen(d)).toBe("A conta da Ada está no limite");
    // Opening it looks the plans up again.
    expect(state.calls.some((c) => c.method === "machines.refreshAccountUsage")).toBe(true);
    expect(d.textContent).toContain("Trabalho · Team volta");
    expect(brainRows(d).map((r) => [r.group, r.title, r.room])).toEqual([
      ["Com mais folga agora", "Claude Team 2", "12%"],
    ]);
    expect(within(d).getByRole("button", { name: "Esperar" })).toBeTruthy();
    expect(within(d).queryByRole("button", { name: /^Conectar outra IA/ })).toBeNull();
    expect(mainButton(d)?.textContent).toBe("Usar Claude Team 2");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", account: "acct_roomy" });
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("plan usage to someone who isn't the agent's owner: the limit, no offer", async () => {
    const full: PlanUsage = {
      windows: [{ kind: "seven_day", usedPercent: 100 }],
      source: "turn",
      at: new Date().toISOString(),
    };
    const spare: MachineAccount = { ...work, id: "acct_spare", label: "Claude Team 2", usage: null };
    await onMac({
      account: "acct_work",
      accounts: [{ ...work, usedBy: ["Ada"], usage: full }, spare],
      canUsePlans: false,
      canManageAccounts: false,
    });
    const d = await brainDialog(/no limite$/);
    expect(d.textContent).toContain("Trabalho · Team volta");
    expect(brainRows(d)).toEqual([]);
    expect(mainButton(d)).toBeNull();
    expect(within(d).queryByRole("button", { name: /^Usar Claude/ })).toBeNull();
    expect(within(d).queryByRole("button", { name: /^Conectar outra IA/ })).toBeNull();
    expect(within(d).getByRole("button", { name: "Esperar" })).toBeTruthy();
  });

  test("an admin changes the account among its owner's, told whose they are; an old app on the computer shows nothing about it", async () => {
    await onMac({ canUsePlans: false, canManageAccounts: false });
    let d = await brainDialog();
    // Someone else's agents don't share the viewer's sign-in: to them it is the computer's.
    expect(brainRows(d).map((r) => r.title)).toEqual(["Conta deste MacBook"]);
    expect(d.textContent).toContain(
      "Só contas de João, responsável pela Ada: um plano só pensa pelos agentes do seu dono.",
    );
    expect(d.textContent).not.toMatch(/Só João troca|Entrar de novo/);
    // The admin may still switch it.
    expect(within(d).getByRole("button", { name: "Trocar de conta" })).toBeTruthy();
    cleanup();
    await onMac({ accountsSupported: false });
    expect(sentence().textContent).not.toMatch(/Conta deste MacBook|A conta que os seus agentes dividem/);
    d = await brainDialog();
    // The plan itself, no account of it.
    expect(brainRows(d).map((r) => r.title)).toEqual(["Claude"]);
    await toScreen(d, "Mais opções");
    await toScreen(d, "Esforço");
    expect(within(d).getByRole("slider", { name: "Esforço" })).toBeTruthy();
  });

  test("who may use other people's plans gives Ada a teammate's, named whose it is; one another agent has stays off", async () => {
    const bia: MachineAccount = {
      ...work,
      id: "acct_bia",
      label: "Max da Bia",
      email: null,
      plan: null,
      ownerId: "u-bia",
      ownerName: "Bia Lima",
      mine: false,
    };
    const busy: MachineAccount = {
      ...bia,
      id: "acct_caio",
      label: "Pro do Caio",
      ownerId: "u-caio",
      ownerName: "Caio",
      usedBy: ["Theo"],
    };
    const { state } = await onMac({
      account: null,
      accounts: [bia, busy],
      canUsePlans: false,
      canManageAccounts: false,
      canUseOthersPlans: true,
    });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(d.textContent).toContain(
      "Os planos de outras pessoas mostram de quem são. O dono recebe um e-mail e pode tirar de volta.",
    );
    // Among the ones with most room, each says whose it is.
    expect(brainRows(d).find((r) => r.title === "Max da Bia")).toMatchObject({ lines: ["De Bia"], off: false });
    // All of them, under their owners: the one another agent has can't be picked.
    await click(within(d).getByRole("button", { name: /^Ver as/ }));
    const rows = brainRows(d);
    expect(rows.find((r) => r.title === "Max da Bia")).toMatchObject({ group: "De Bia", off: false });
    expect(rows.find((r) => r.title === "Pro do Caio")).toMatchObject({ group: "De Caio", off: true });
    await pickRow(d, "Max da Bia");
    // Its owner hears of it.
    expect(d.textContent).toContain("Bia recebe um aviso por e-mail.");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_bia" });
  });

  test("a signed-out account says so and offers to sign in again, its own email going to Claude's sign-in unasked", async () => {
    const { state } = await onMac({ account: "acct_work", accounts: [{ ...work, status: "signed_out" }] });
    const d = await brainDialog();
    expect(brainRows(d)[0]?.lines).toContain("Saiu da conta, entre de novo");
    expect(mainButton(d)?.textContent).toBe("Entrar de novo");
    await click(mainButton(d) as HTMLElement);
    expect(brainScreen(d)).toBe("Entrar de novo");
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    expect(block.querySelector("input")).toBeNull();
    await signIn(d, "Entrar com Claude", 6);
    expect(loginArgs(state)).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { accountId: "acct_work", email: "walt@acme.com" },
    ]);
    expect(shownText(block)).not.toContain("walt@acme.com");
  });

  test("signing in again as another account already connected: both addresses said, and Use picks that one for Ada", async () => {
    const pessoal: MachineAccount = { ...work, id: "acct_pessoal", label: "Pessoal", email: "walt@gmail.com" };
    const { state, api } = await onMac({
      account: "acct_work",
      accounts: [{ ...work, status: "signed_out" }, pessoal],
    });
    fakeMachinesOf.get(api)?.endLogin("login_1", {
      state: "failed",
      signedInAs: "walt@gmail.com",
      duplicate: { label: "Pessoal", account: pessoal },
    });
    const d = await brainDialog();
    await toScreen(d, "Entrar de novo");
    const block = within(d).getByRole("region", { name: "Adicionar conta do Claude" });
    await signIn(d, "Entrar com Claude");
    expect(shownText(block)).toContain(
      "O Claude entrou como walt@gmail.com, não como walt@acme.com. Saia na página do Claude e tente de novo.",
    );
    await click(within(block).getByRole("button", { name: "Usar walt@gmail.com" }));
    await settle(6);
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_pessoal" });
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("the computer's own sign-in, chosen again, is the account the agents share, as the Connect cards name it", async () => {
    const { state } = await onMac({ account: "acct_work" }, { claude_code: { plan: "max" } });
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, (r) => r.mark === "claude" && r.group !== "Em uso");
    expect(mainButton(d)?.textContent).toBe("Trocar para A conta que os seus agentes dividem");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", account: null });
    expect(d.textContent).toContain("A Ada agora pensa com A conta que os seus agentes dividem.");
  });

  test("the computer's own sign-in is offered only once its runner says it's signed in there", async () => {
    await onMac({ account: "acct_work" });
    let d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    // The MacBook said nothing of Claude Code's own sign-in: no account of its to choose.
    expect(others(d).map((r) => r.title)).toEqual(["Chave padrão do workspace"]);
    cleanup();
    await onMac({ account: "acct_work" }, { claude_code: { plan: "max" } });
    d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(others(d).map((r) => [r.title, r.lines])).toEqual([
      ["A conta que os seus agentes dividem", ["Claude · Max"]],
      ["Chave padrão do workspace", ["Claude · termina em 7f2a"]],
    ]);
  });

  test("ChatGPT on the workspace's computer, which nobody connected: never that computer's account; another AI is Connect's", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Even with its Codex reported signed in: on a computer nobody connected, no person signs in at its terminal.
    reportOwn(api, { codex: { usage: { windows: [], source: "probe", at: NOW.toISOString() } } });
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { ownSignIn: false });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(d.textContent).not.toMatch(/Conta deste|quem conectou|A conta que os seus agentes dividem/);
    expect(brainRows(d).some((r) => r.mark === "openai")).toBe(false);
    // A plan with nothing there is connected through Connect an AI: this dialog closes for it.
    await click(within(d).getByRole("button", { name: /^Conectar outra IA/ }));
    await settle(4);
    expect(screen().queryByRole("dialog", { name: /^Quem pensa/ })).toBeNull();
    expect(screen().getByRole("dialog")).toBeTruthy();
    // Showing the steps starts nothing.
    expect(state.calls.some((c) => c.method === "machines.beginAccountLogin")).toBe(false);
  });

  test("a computer someone else connected, with no account of hers there: it says who signs a plan in, no empty list", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.pair({
      id: "machine_1",
      name: "MacBook",
      os: "darwin",
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
      browser: { available: true, version: "1", chrome: null, reason: null },
      pairedBy: { id: "u-theo", name: "Theo Lima" },
    });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Ada is Walter's: her plan would be his, and only Theo adds sign-ins on his MacBook.
    api.agents.brain = async () => fakeAgentBrain(ADA_ID, { ownSignIn: false, canManageAccounts: false });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(d.textContent).toContain("Só Theo conecta um plano no MacBook.");
    // Nothing of a plan to pick there: the key Ada has is all there is.
    expect(others(d)).toEqual([]);
  });

  test("onto a plan brain from the API: what can think there, the computer's own sign-in or a free account, never a plan with nothing there", async () => {
    const plus: MachineAccount = { ...work, id: "acct_plus", kind: "codex", label: "Pessoal", plan: "Plus" };
    const usage = { windows: [], source: "probe" as const, at: NOW.toISOString() };
    const { state } = await onMac({ brain: "model", effectiveModel: null, accounts: [plus] }, { codex: { usage } });
    let d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    // Codex's own sign-in is reported on the MacBook its owner connected: the account the agents share. Claude Code's
    // isn't, and nothing of Claude's is there: no row of Claude's.
    const openai = brainRows(d).filter((r) => r.mark === "openai");
    expect(openai.map((r) => r.title).sort()).toEqual(["A conta que os seus agentes dividem", "Pessoal · Plus"]);
    expect(brainRows(d).some((r) => r.mark === "claude" && r.group !== "Em uso")).toBe(false);
    await pickRow(d, (r) => r.mark === "openai" && r.title === "A conta que os seus agentes dividem");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    // From the API another plan starts on its own default model.
    expect(brainCalls(state).at(-1)).toEqual({ brain: "codex", model: null, account: null });
    cleanup();
    // Without Codex's own sign-in reported, a ChatGPT account of hers that thinks for nobody.
    const second = await onMac({ brain: "model", effectiveModel: null, accounts: [plus] });
    d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    expect(
      brainRows(d)
        .filter((r) => r.mark === "openai")
        .map((r) => r.title),
    ).toEqual(["Pessoal · Plus"]);
    await pickRow(d, "Pessoal · Plus");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    expect(brainCalls(second.state).at(-1)).toMatchObject({ brain: "codex", account: "acct_plus" });
  });

  test("the account in use shows its plan's windows on the first screen, each with how much is used", async () => {
    const usage: PlanUsage = {
      windows: [
        { kind: "five_hour", usedPercent: 40 },
        { kind: "seven_day", usedPercent: 86 },
      ],
      source: "probe",
      at: new Date().toISOString(),
    };
    await onMac({ account: "acct_work", accounts: [{ ...work, usedBy: ["Ada"], usage }] });
    const d = await brainDialog();
    expect(brainScreen(d)).toBe("Quem pensa pela Ada");
    const wins = d.querySelector(".bd-wins") as HTMLElement;
    expect(Array.from(wins.querySelectorAll(".bd-win__n")).map((n) => n.textContent)).toEqual(["86%", "40%"]);
    expect(brainLines(d).map((l) => l.label)).toEqual(["Modelo", "Mais opções"]);
  });

  test("at the limit, Esperar closes it and changes nothing", async () => {
    const full: PlanUsage = {
      windows: [{ kind: "five_hour", usedPercent: 100 }],
      limited: true,
      source: "turn",
      at: new Date().toISOString(),
    };
    const { state } = await onMac({ account: "acct_work", accounts: [{ ...work, usedBy: ["Ada"], usage: full }] });
    const d = await brainDialog(/no limite$/);
    expect(d.textContent).toContain("Trabalho · Team volta quando o plano renovar");
    await click(within(d).getByRole("button", { name: "Esperar" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(brainCalls(state)).toEqual([]);
  });
});

describe("Quem pensa: a plan with a login per agent, and plans on the Cloud", () => {
  const glm = (id: string, usedBy: string[]): MachineAccount => ({
    id,
    kind: "claude_code",
    label: "GLM Coding",
    email: null,
    plan: null,
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter Nogueira",
    mine: true,
    usedBy,
    usage: null,
    provider: "zai",
    keyHint: "4f2a",
  });

  test("a coding plan whose logins think for other agents: one more for this one, its key pasted again", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, {
        brain: "claude_code",
        effectiveModel: "sonnet",
        accounts: [glm("acct_theo", ["Theo"]), glm("acct_lia", ["Lia"])],
      });
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: glm("acct_ada", []) });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    // One row for the account, not one per login: Claude's account choice is Claude's alone.
    const rows = brainRows(d).filter((r) => r.title === "GLM Coding");
    expect(rows.map((r) => [r.lines, r.mark])).toEqual([[["Também usada por Theo e Lia"], "zai"]]);
    await pickRow(d, "GLM Coding");
    expect(mainButton(d)?.textContent).toBe("Fazer login para a Ada");
    await click(mainButton(d) as HTMLElement);
    const block = within(d).getByRole("region", { name: "Conectar GLM Coding" });
    fireEvent.change(within(block).getByLabelText("Chave do GLM Coding"), {
      target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
    });
    await click(within(block).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(8);
    expect(loginArgs(state)).toEqual([ORG_ID, "machine_1", "claude_code", { provider: "zai" }]);
    // Signed in, it thinks with it at once.
    expect(brainCalls(state).at(-1)).toMatchObject({ account: "acct_ada" });
    expect(brainScreen(d)).toBe("Pronto");
  });

  test("on the Cloud too, the plan's owner lets it answer other people: the switch, its line and ⓘ", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", onlyOwner: true });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    const replies = within(d).getByRole("switch", { name: "Atende outras pessoas" });
    expect(replies.getAttribute("aria-checked")).toBe("false");
    expect(shownText(d)).toContain("A Ada só atende você, pelo seu plano do Claude.");
    expect(hintOf("os termos do plano", d).text).toContain("Os planos do Claude são para uso pessoal.");
    expect(shownText(d)).not.toContain("Um plano é pessoal");
    await click(replies);
    await done(d);
    await settle(6);
    expect(brainCalls(state).at(-1)).toEqual({ brain: "claude_code", onlyOwner: false });
  });
});

describe("Usar em outros agentes (ADR 0094)", () => {
  const LIA_ID = "00000000-0000-4000-8000-0000000000a9";

  async function withOthers(tweak?: (api: ReturnType<typeof createFakeApi>) => void) {
    const state = seedState();
    const [, atlas] = state.agents;
    if (!atlas) throw new Error("no Atlas");
    state.agents.push({ ...atlas, id: LIA_ID, name: "Lia", handle: "lia" });
    state.setupResults = { [LIA_ID]: { status: "skipped", reason: "other_computer", params: { computer: "PC" } } };
    const api = createFakeApi(state);
    tweak?.(api);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    reportOwn(api, { claude_code: { plan: "max" } });
    await open(state, api);
    return state;
  }
  const copyCalls = (state: ReturnType<typeof seedState>) =>
    state.calls.filter((c) => c.method === "agents.applySetup").map((c) => c.args[1]);
  /** A fake whose agents keep the key they were given, as the server does (its own answers the default key). */
  const withKeys = (state: ReturnType<typeof seedState>) => {
    const api = createFakeApi(state);
    const keys = new Map<string, string | null>();
    const { detail, update } = api.agents;
    api.agents.detail = async (orgId, agentId) => {
      const d = await detail(orgId, agentId);
      return keys.has(agentId) ? { ...d, credentialId: keys.get(agentId) ?? null } : d;
    };
    api.agents.update = async (orgId, agentId, input) => {
      if (input.credentialId !== undefined) keys.set(agentId, input.credentialId);
      return update(orgId, agentId, input);
    };
    return api;
  };

  /** Ada switched onto the MacBook's own Claude sign-in (the dialog closed after), so that is what is saved. */
  async function onClaude() {
    const d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, (r) => r.mark === "claude" && r.group !== "Em uso");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    await done(d);
    await settle(4);
  }
  /** Then Opus saved as its model; the dialog stays open on its first screen. */
  async function onOpus() {
    await onClaude();
    const d = await brainDialog();
    await toScreen(d, "Modelo");
    await pickRow(d, "Opus");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    return d;
  }
  /** "Mais opções", then its "Usar em outros agentes": the dialog over "Quem pensa". */
  async function copyDialog(d: HTMLElement) {
    await toScreen(d, "Mais opções");
    await toScreen(d, "Usar em outros agentes");
    await settle(4);
    return screen().getByRole("dialog", { name: "Usar em outros agentes" });
  }

  test("what is saved: the others with what each would do, Todos picks who can, one call saves them", async () => {
    const state = await withOthers();
    const d = await onOpus();
    expect(brainCalls(state)).toEqual([
      { brain: "claude_code", model: null, account: null },
      { brain: "claude_code", model: "opus" },
    ]);
    const c = await copyDialog(d);
    expect(c.textContent).toContain("Eles passam a pensar com Opus pelo plano do Claude.");
    // What each would do, from the server's preview, Ada first as her own setup is what they take.
    expect(copyCalls(state)).toEqual([
      {
        setup: expect.objectContaining({ brain: "claude_code", machineId: "machine_1", model: "opus" }),
        agentIds: [ADA_ID, ATLAS_ID, LIA_ID],
        preview: true,
      },
    ]);
    expect(within(c).queryByRole("checkbox", { name: /^Ada/ })).toBeNull();
    const atlas = within(c).getByRole("checkbox", { name: /^Atlas/ });
    expect(atlas.closest("label")?.textContent).toContain("Hoje: Claude Sonnet 5.5");
    const lia = within(c).getByRole("checkbox", { name: /^Lia/ });
    expect(lia.closest("label")?.textContent).toContain("Trabalha no PC");
    expect(lia.hasAttribute("disabled")).toBe(true);
    const use = () => within(c).getByRole("button", { name: /^(Usar em|Escolha)/ }) as HTMLButtonElement;
    expect(use().textContent).toBe("Escolha os agentes");
    expect(use().disabled).toBe(true);
    await click(within(c).getByRole("checkbox", { name: /^Todos/ }));
    expect(atlas.getAttribute("aria-checked")).toBe("true");
    expect(lia.getAttribute("aria-checked")).toBe("false");
    expect(use().textContent).toBe("Usar em 1 agente");
    await click(use());
    await settle(6);
    // Ada's own is saved already: only the others, in one call.
    expect(brainCalls(state)).toHaveLength(2);
    expect(copyCalls(state).at(-1)).toEqual({
      setup: expect.objectContaining({ brain: "claude_code", model: "opus", effort: "medium" }),
      agentIds: [ATLAS_ID],
    });
    expect(document.body.textContent).toContain("1 agente agora pensa com Opus pelo plano do Claude.");
    expect(screen().queryByRole("dialog", { name: "Usar em outros agentes" })).toBeNull();
    // No agent picked on someone else's plan: nothing asked.
    expect(screen().queryByRole("dialog", { name: /^Usar o plano/ })).toBeNull();
  });

  test("an agent picked on someone else's plan: one question naming its owner first; Cancelar saves nothing, Continuar once", async () => {
    const state = await withOthers();
    state.setupResults = {
      ...state.setupResults,
      [ATLAS_ID]: { status: "applied", opensPlan: true },
    };
    const d = await onOpus();
    const c = await copyDialog(d);
    await click(within(c).getByRole("checkbox", { name: /^Atlas/ }));
    const saves = () => copyCalls(state).filter((x) => !(x as { preview?: boolean }).preview);
    await click(within(c).getByRole("button", { name: "Usar em 1 agente" }));
    const q = screen().getByRole("dialog", { name: "Usar o plano de João?" });
    expect(q.textContent).toContain(
      "As conversas com Atlas vão usar o plano do Claude de João e os limites dele. João vai receber um email avisando.",
    );
    await click(within(q).getByRole("button", { name: "Cancelar" }));
    await settle(4);
    expect(screen().queryByRole("dialog", { name: /^Usar o plano/ })).toBeNull();
    expect(saves()).toEqual([]);
    await click(within(c).getByRole("button", { name: "Usar em 1 agente" }));
    await click(
      within(screen().getByRole("dialog", { name: "Usar o plano de João?" })).getByRole("button", {
        name: "Continuar",
      }),
    );
    await settle(6);
    // Ada's two saves (the account, the model), none from the copy.
    expect(brainCalls(state)).toHaveLength(2);
    expect(saves()).toEqual([
      { setup: expect.objectContaining({ brain: "claude_code", model: "opus" }), agentIds: [ATLAS_ID] },
    ]);
  });

  test("the Autonomia goes too: said with the setup, each agent's change on its line, even where the AI can't", async () => {
    const state = await withOthers((api) => {
      const brain = api.agents.brain;
      api.agents.brain = async (orgId, agentId) => ({
        ...(await brain(orgId, agentId)),
        ...(agentId === ADA_ID ? { autonomy: "never" as const } : {}),
      });
    });
    state.setupResults = {
      [ATLAS_ID]: { status: "same", autonomy: { from: "always", to: "never" } },
      [LIA_ID]: {
        status: "skipped",
        reason: "other_computer",
        params: { computer: "PC" },
        autonomy: { from: "low_risk_auto", to: "never" },
      },
    };
    const d = await onOpus();
    await toScreen(d, "Mais opções");
    const row = within(d).getByRole("button", { name: /^Usar em outros agentes/ });
    expect(row.textContent).toContain("A mesma IA, o modelo, o esforço e a autonomia");
    await click(row);
    await settle(4);
    const c = screen().getByRole("dialog", { name: "Usar em outros agentes" });
    expect(c.textContent).toContain("Eles passam a pensar com Opus pelo plano do Claude · Autonomia: Não pergunta.");
    expect(copyCalls(state)[0]).toMatchObject({ setup: { autonomy: "never" }, preview: true });
    // Atlas already thinks so and Lia works on another computer: only their Autonomia changes, and they can take it.
    const atlas = within(c).getByRole("checkbox", { name: /^Atlas/ });
    expect(atlas.closest("label")?.textContent).toContain("Já pensa assim · Autonomia: Pergunta sempre → Não pergunta");
    expect(atlas.hasAttribute("disabled")).toBe(false);
    const lia = within(c).getByRole("checkbox", { name: /^Lia/ });
    expect(lia.closest("label")?.textContent).toContain(
      "Trabalha no PC · Autonomia: Só o que é arriscado → Não pergunta",
    );
    expect(lia.hasAttribute("disabled")).toBe(false);
    expect(c.textContent).toContain("2 agentes podem usar");
    await click(within(c).getByRole("checkbox", { name: /^Todos/ }));
    await click(within(c).getByRole("button", { name: "Usar em 2 agentes" }));
    await settle(6);
    expect(copyCalls(state).at(-1)).toEqual({
      setup: expect.objectContaining({ brain: "claude_code", model: "opus", autonomy: "never" }),
      agentIds: [ATLAS_ID, LIA_ID],
    });
    const toasts = document.body.textContent;
    expect(toasts).toContain("1 agente agora pensa com Opus pelo plano do Claude · Autonomia: Não pergunta.");
    expect(toasts).toContain("1 agente mudou só a autonomia.");
    expect(toasts).not.toContain("não mudou");
  });

  test("Levar a autonomia off: each agent keeps its own, and one only its Autonomia would change can't be picked", async () => {
    const state = await withOthers((api) => {
      const brain = api.agents.brain;
      api.agents.brain = async (orgId, agentId) => ({
        ...(await brain(orgId, agentId)),
        ...(agentId === ADA_ID ? { autonomy: "never" as const } : {}),
      });
    });
    state.setupResults = {
      [ATLAS_ID]: { status: "applied", autonomy: { from: "always", to: "never" } },
      [LIA_ID]: {
        status: "skipped",
        reason: "other_computer",
        params: { computer: "PC" },
        autonomy: { from: "low_risk_auto", to: "never" },
      },
    };
    const c = await copyDialog(await onOpus());
    const carry = within(c).getByRole("switch", { name: /^Levar a autonomia/ });
    expect(carry.getAttribute("aria-checked")).toBe("true");
    expect(carry.closest("label")?.textContent).toContain(
      "Não pergunta, como neste agente. Desligado, cada um fica com a sua.",
    );
    expect(c.textContent).toContain("2 agentes podem usar");
    await click(carry);
    await settle(4);
    // Asked again without it: the setup in words and each agent's line leave it out.
    const again = copyCalls(state).at(-1);
    expect(again).toMatchObject({ agentIds: [ADA_ID, ATLAS_ID, LIA_ID], preview: true });
    expect(again).not.toHaveProperty(["setup", "autonomy"]);
    expect(c.textContent).toContain("Eles passam a pensar com Opus pelo plano do Claude.");
    expect(c.textContent).not.toContain("Autonomia:");
    expect(within(c).getByRole("checkbox", { name: /^Lia/ }).hasAttribute("disabled")).toBe(true);
    expect(c.textContent).toContain("1 agente pode usar");
    await click(within(c).getByRole("checkbox", { name: /^Todos/ }));
    await click(within(c).getByRole("button", { name: "Usar em 1 agente" }));
    await settle(6);
    const used = copyCalls(state).at(-1);
    expect(used).toEqual({
      setup: expect.objectContaining({ brain: "claude_code", model: "opus" }),
      agentIds: [ATLAS_ID],
    });
    expect(used).not.toHaveProperty(["setup", "autonomy"]);
    expect(document.body.textContent).toContain("1 agente agora pensa com Opus pelo plano do Claude.");
    expect(document.body.textContent).not.toContain("mudou só a autonomia");
  });

  test("Todos says how many can take it only once the preview says so", async () => {
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    await withOthers((api) => {
      const apply = api.agents.applySetup;
      api.agents.applySetup = async (orgId, input) => {
        await arrived;
        return apply(orgId, input);
      };
    });
    await onClaude();
    const c = await copyDialog(await brainDialog());
    expect(within(c).queryByRole("checkbox", { name: /^Todos/ })).toBeNull();
    expect(c.textContent).not.toContain("0 agente");
    arrive();
    await settle(4);
    expect(c.textContent).toContain("1 agente pode usar");
  });

  test("the API's model and key go too, for an admin; nothing to pick when nobody can take it", async () => {
    const state = seedState();
    state.credentials.push({
      id: "cred-2",
      provider: "anthropic",
      label: "Claude do time",
      keyHint: "9b1c",
      createdAt: NOW.toISOString(),
      revokedAt: null,
    });
    state.setupResults = { [ATLAS_ID]: { status: "same" } };
    await open(state, withKeys(state));
    let d = await brainDialog();
    await toScreen(d, "Trocar de conta");
    await pickRow(d, "Claude do time");
    await click(mainButton(d) as HTMLElement);
    await settle(6);
    await done(d);
    await settle(4);
    d = await brainDialog();
    const c = await copyDialog(d);
    expect(copyCalls(state)[0]).toEqual({
      setup: { brain: "model", model: "claude-sonnet-5-5", key: "cred-2", contextTokens: null },
      agentIds: [ADA_ID, ATLAS_ID],
      preview: true,
    });
    expect(
      within(c)
        .getByRole("checkbox", { name: /^Atlas/ })
        .closest("label")?.textContent,
    ).toContain("Já pensa assim");
    expect(c.textContent).toContain("Nenhum outro agente pode usar agora.");
    expect(c.textContent).not.toContain("0 agente");
    expect(
      within(c)
        .getByRole("checkbox", { name: /^Todos/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  // On the workspace's default key the agent's saved key is the picker's placeholder: the copy sends null, the way the
  // server reads "each agent on the workspace's default key".
  test("on the workspace's default key the copy sends key null, never the picker's placeholder", async () => {
    const state = seedState();
    state.setupResults = { [ATLAS_ID]: { status: "same" } };
    await open(state);
    await copyDialog(await brainDialog());
    expect(copyCalls(state)[0]).toMatchObject({ setup: { brain: "model", key: null }, preview: true });
  });

  test("not offered while it thinks with nothing yet: a plan with no sign-in on its computer", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    pairMac(api, true);
    await api.sandbox.setTarget(ORG_ID, ADA_ID, "machine_1");
    // Claude Code with no account and no sign-in of the MacBook's to think with: the plan itself, nothing to copy.
    api.agents.brain = async () =>
      fakeAgentBrain(ADA_ID, { brain: "claude_code", effectiveModel: "sonnet", account: null, ownSignIn: false });
    await open(state, api);
    const d = await brainDialog();
    await toScreen(d, "Mais opções");
    expect(within(d).queryByRole("button", { name: /^Usar em outros agentes/ })).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, AiAccounts, AiComputer, BrainOption, ComputerSetup, OrgStanding } from "@agenteschat/client";
import { PLAN_CHOICES, type PlanChoice, planLabel, planTitle } from "@agenteschat/client/lib/no-ai";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import i18next from "i18next";
import { brainDialog, brainRows, brainScreen, mainButton, openAiSelect, payWith, toScreen } from "./ai-picker";
import { ADA_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState, withRightHand } from "./fake-api";
import { shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/*
 * The four people a plan's screens answer: a workspace with its agentes.chat plan, one without it for whoever pays and
 * for a member, and a self-hosted server, which has no such plan.
 */
type Who = "paid" | "owner" | "member" | "selfhost";

const WHY = "Um plano entra no computador do workspace, e o computador vem com um plano ativo do agentes.chat.";
const ASK = "Quem administra o workspace pode resolver isso.";
const PAY = "Ver planos do agentes.chat";
const KEY = "Usar uma chave de API";
const HELD = "Os agentes usam a chave quando o plano do agentes.chat do workspace estiver ativo.";
const CLOSED = "As chaves de API abrem com o plano do agentes.chat do workspace.";

const COMPUTER: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true, cursor: true, opencode: true, grok: true, antigravity: true },
};

const EVERY_PROGRAM = (["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"] as const).map((kind) => ({
  kind,
  available: true,
  models: [],
  defaultModel: null,
}));
const NO_COMPUTER = { computer: null, machines: [] };

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};

async function open(who: Who, path: string, accounts: AiAccounts["accounts"] = []) {
  const state = seedState({ authConfig: who === "selfhost" ? {} : { billingUrl: "https://billing.example.com" } });
  if (path.endsWith("right_hand")) withRightHand(state);
  const held = who === "owner" || who === "member" || who === "selfhost";
  const me = state.me;
  if (me)
    me.organizations = me.organizations.map((o) => ({
      ...o,
      ...(who === "member" ? { role: "member" as const } : {}),
      ...(held ? { standing: { state: "hold" as const, reason: "payment" } } : {}),
    }));
  for (const a of state.agents) if (a.id === ADA_ID) a.ownerUserId = state.me?.user.id ?? null;
  if (path.includes("connect=ai"))
    state.aiStatus = { any: false, agents: [{ agentId: ADA_ID, state: "no_ai", reason: "no_key" }] };
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  const paired = who === "paid" || who === "selfhost";
  if (paired)
    machines?.pair({
      id: "machine_1",
      name: "MacBook",
      agents: state.agents.filter((a) => a.id === ADA_ID).map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
    });
  if (who !== "selfhost") machines?.setSetup({ state: paired ? "ready" : null });
  machines?.setAiAccounts({ accounts, computers: paired ? [COMPUTER] : [] });
  const viewOf = api.agents.brain;
  api.agents.brain = async (orgId, agentId) => ({
    ...(await viewOf(orgId, agentId)),
    ownSignIn: false,
    accounts,
    ...(paired ? { options: EVERY_PROGRAM, accountsSupported: true, canManageAccounts: true } : NO_COMPUTER),
  });
  if (path.endsWith("/usage")) {
    const usageOf = api.orgs.planUsage;
    api.orgs.planUsage = async (orgId) => ({ ...(await usageOf(orgId)), accounts: [] });
  }
  await renderApp(path, { api });
  await settle(8);
  return { state, api };
}

async function connect(who: Who, accounts: AiAccounts["accounts"] = []) {
  const opened = await open(who, `/org/${ORG_ID}?connect=ai`, accounts);
  return { ...opened, dialog: screen().getByRole("dialog", { name: /Conectar uma IA/ }) };
}

/** The narrow dialog under the sky: Connect for the team (ADR 0160, addendum), its AIs as cards. */
const inBand = (dialog: HTMLElement) => dialog.querySelector(".arrival-hero") !== null;

/** A card of the team's Connect, from its first screen ("Other plan" opens the rest). */
async function pickCard(dialog: HTMLElement, title: string) {
  const back = within(dialog).queryByRole("button", { name: "Voltar" });
  if (back) await click(back);
  const card = () => within(dialog).queryByRole("button", { name: new RegExp(`^${title}`) });
  if (!card()) await click(within(dialog).getByRole("button", { name: /^Outro plano/ }));
  await click(card() as Element);
}

/** Each plan's card title in Portuguese; a coding plan's is its own name (`planLabel`). */
const CARD: Partial<Record<PlanChoice, string>> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
  grok: "Grok",
  gemini: "Gemini",
  zen: "Começar grátis",
};

async function planPanel(dialog: HTMLElement, choice: PlanChoice) {
  if (inBand(dialog)) await pickCard(dialog, CARD[choice] ?? planLabel(i18next.t, choice));
  else {
    const rows = await openAiSelect(dialog);
    await click(rows[PLAN_CHOICES.indexOf(choice)] as Element);
  }
  await settle(2);
  return within(dialog).getAllByRole("region", { name: planTitle(i18next.t, choice) })[0] as HTMLElement;
}

const disabledButtons = (box: HTMLElement) => Array.from(box.querySelectorAll("button:disabled"));
const buttonNamed = (box: HTMLElement, name: string) => within(box).queryByRole("button", { name });

describe("a plan with no agentes.chat plan in force", () => {
  test("whoever pays: Connect says why with the plans page, and no plan, key or sign-in to pick", async () => {
    const { dialog } = await connect("owner");
    expect(shownText(dialog)).toContain(WHY);
    expect(buttonNamed(dialog, PAY)).not.toBeNull();
    expect(buttonNamed(dialog, KEY)).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "Plano" })).toBeNull();
    expect(dialog.querySelector(".ai-picker")).toBeNull();
  });

  test("a member: Connect says why and who can sort it out, with nothing to press", async () => {
    const { dialog } = await connect("member");
    expect(shownText(dialog)).toContain(WHY);
    expect(shownText(dialog)).toContain(ASK);
    expect(buttonNamed(dialog, PAY)).toBeNull();
    expect(buttonNamed(dialog, KEY)).toBeNull();
  });

  test("with the plan in force: every plan signs in, no word of billing", async () => {
    const { dialog } = await connect("paid");
    for (const choice of PLAN_CHOICES) {
      const panel = await planPanel(dialog, choice);
      expect(shownText(panel)).not.toContain(WHY);
      expect(buttonNamed(panel, PAY)).toBeNull();
      expect(panel.querySelector(".agp-addacct")).not.toBeNull();
      expect(disabledButtons(panel).filter((b) => !b.textContent?.includes("Enviar"))).toEqual([]);
    }
  });

  test("self-hosted: no word of billing, though a hold there carries a billing code", async () => {
    const { dialog } = await connect("selfhost");
    for (const choice of PLAN_CHOICES) {
      const panel = await planPanel(dialog, choice);
      expect(shownText(panel)).not.toContain("agentes.chat");
      expect(buttonNamed(panel, PAY)).toBeNull();
    }
    await pickCard(dialog, "Chave de API");
    expect(shownText(dialog)).not.toContain(HELD);
    expect(shownText(dialog)).toContain("Todo agente sem plano pensa com ela.");
  });

  test("Ver planos goes to the real billing page, minted on the click", async () => {
    const { dialog, state } = await connect("owner");
    await click(buttonNamed(dialog, PAY) as HTMLElement);
    expect(state.calls.filter((c) => c.method === "orgs.billingLink")).toHaveLength(1);
  });

  test("no view of the computer and no hold: the steps it turns off say what they wait for, on every plan", async () => {
    const state = seedState();
    for (const a of state.agents) if (a.id === ADA_ID) a.ownerUserId = state.me?.user.id ?? null;
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: null });
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [], computers: [] });
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await viewOf(orgId, agentId)),
      ownSignIn: false,
      computer: null,
      machines: [],
    });
    await renderApp(`/org/${ORG_ID}?connect=ai`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: /Conectar uma IA/ });
    for (const choice of PLAN_CHOICES) {
      const panel = await planPanel(dialog, choice);
      expect(disabledButtons(panel).length).toBeGreaterThan(0);
      expect(panel.querySelector(".ai-panel__wait")?.textContent).toMatch(/assim que o computador ficar pronto/);
    }
  });
});

describe("the other places a plan is chosen", () => {
  test("IA e uso, by the old address of Contas de IA: why and the plans page in the accounts' card, no key", async () => {
    await open("owner", `/org/${ORG_ID}/settings/keys`);
    const card = screen().getByRole("region", { name: "Contas" });
    expect(shownText(card)).toContain(WHY);
    expect(buttonNamed(card, PAY)).not.toBeNull();
    expect(buttonNamed(card, KEY)).toBeNull();
    // No plan yet: the hold's lines stand alone, no invitation to connect one.
    expect(screen().queryByText("Use o plano de IA que você já paga")).toBeNull();
  });

  test("Uso with no plan: the hold's lines in the plans' card, no invitation to connect one", async () => {
    const card = () => screen().getByRole("region", { name: "Contas" });
    await open("owner", `/org/${ORG_ID}/settings/usage`);
    expect(shownText(card())).toContain(WHY);
    expect(buttonNamed(card(), PAY)).not.toBeNull();
    expect(screen().queryByText("Use o plano de IA que você já paga")).toBeNull();
    cleanup();
    await open("selfhost", `/org/${ORG_ID}/settings/usage`);
    expect(shownText(card())).not.toContain(WHY);
    expect(screen().getByText("Use o plano de IA que você já paga")).toBeTruthy();
  });

  test("IA e uso, with the plan in force or self-hosted: nothing of it", async () => {
    await open("paid", `/org/${ORG_ID}/settings/keys`);
    expect(shownText(screen().getByRole("region", { name: "Contas" }))).not.toContain(WHY);
    cleanup();
    await open("selfhost", `/org/${ORG_ID}/settings/keys`);
    expect(shownText(screen().getByRole("region", { name: "Contas" }))).not.toContain(WHY);
  });

  test("Quem pensa: why and the plans page on its first screen and in Trocar de conta, the key closed, no plan to pick", async () => {
    await open("owner", `/org/${ORG_ID}/agents/${ADA_ID}`);
    const d = await brainDialog("Quem pensa pela Ada");
    expect(shownText(d)).toContain(WHY);
    expect(buttonNamed(d, PAY)).not.toBeNull();
    // Ada thinks with the key, which waits for the plan too.
    expect(shownText(d)).toContain(CLOSED);
    await toScreen(d, "Trocar de conta");
    expect(brainScreen(d)).toBe("Trocar a conta da Ada");
    expect(shownText(d)).toContain(WHY);
    expect(buttonNamed(d, PAY)).not.toBeNull();
    // Only the key in use: no plan to sign in to or switch to while the hold lasts, so nothing to switch to.
    expect(brainRows(d).map((r) => [r.group, r.title])).toEqual([["Em uso", "Chave padrão do workspace"]]);
    expect(mainButton(d)?.disabled).toBe(true);
  });

  test("Lodi's settings: why and the way on in place of the plan row", async () => {
    await open("owner", `/org/${ORG_ID}/settings/right_hand`);
    const body = document.querySelector(".page") as HTMLElement;
    expect(shownText(body)).toContain(WHY);
    expect(buttonNamed(body, PAY)).not.toBeNull();
    expect(buttonNamed(body, KEY)).toBeNull();
    expect(shownText(body)).not.toContain("Conecte um plano em IA e uso para usar aqui.");
  });
});

describe("what a plan's panel never says on the Cloud", () => {
  const INSTALLING = /sendo instalado/;
  const off = (reason: BrainOption["reason"]) =>
    EVERY_PROGRAM.map((o) => (o.kind === "codex" ? { ...o, available: false, reason } : o));

  async function panel(
    view: Partial<AgentBrain>,
    standing?: OrgStanding,
    setup: Partial<ComputerSetup> = { state: "ready", since: new Date().toISOString() },
  ) {
    const state = seedState({ authConfig: { billingUrl: "https://billing.example.com" } });
    if (state.me && standing) state.me.organizations = state.me.organizations.map((o) => ({ ...o, standing }));
    for (const a of state.agents) if (a.id === ADA_ID) a.ownerUserId = state.me?.user.id ?? null;
    state.aiStatus = { any: false, agents: [{ agentId: ADA_ID, state: "no_ai", reason: "no_key" }] };
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup(setup);
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [], computers: [COMPUTER] });
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await viewOf(orgId, agentId)),
      ownSignIn: false,
      accounts: [],
      computer: { machineId: "machine_1", name: "MacBook", online: true },
      accountsSupported: true,
      canManageAccounts: true,
      ...view,
    });
    await renderApp(`/org/${ORG_ID}?connect=ai`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: /Conectar uma IA/ });
    if (!inBand(dialog) && within(dialog).queryByRole("combobox", { name: "Plano" }) === null)
      await click(payWith(dialog, "Com um plano"));
    return planPanel(dialog, "chatgpt");
  }

  test("a computer that hasn't said what it has: it's looking, not installing, and a key is the way on", async () => {
    const box = await panel({ options: off("not_reported") });
    expect(shownText(box)).toContain("ainda está vendo quais programas tem");
    expect(shownText(box)).not.toMatch(INSTALLING);
    expect(buttonNamed(box, "Usar uma chave de API agora")).not.toBeNull();
  });

  test("a CLI the computer looked for and hasn't got, just after it was ready: that one may be on its way", async () => {
    expect(shownText(await panel({ options: off("not_installed") }))).toMatch(INSTALLING);
  });

  test("the same CLI long after the computer was ready: nothing says it's coming", async () => {
    const box = await panel({ options: off("not_installed") }, undefined, { state: "ready", since: null });
    expect(shownText(box)).not.toMatch(INSTALLING);
    expect(shownText(box)).toContain("não vai mudar sozinho");
  });

  test("a computer that never reached the agent: nobody connects one on the Cloud, so no such button", async () => {
    const box = await panel({ computer: null, machines: [], options: EVERY_PROGRAM });
    expect(shownText(box)).toContain("não vai mudar sozinho");
    expect(buttonNamed(box, "Conectar um computador")).toBeNull();
    expect(buttonNamed(box, "Usar uma chave de API agora")).not.toBeNull();
  });

  test("a hold that isn't billing: it speaks, the computer's wait doesn't, and no key is offered as if it ran", async () => {
    const box = await panel({ options: off("not_installed") }, { state: "hold", reason: null });
    expect(shownText(box)).not.toMatch(INSTALLING);
    expect(shownText(box)).toContain("pausados para uma revisão");
    expect(buttonNamed(box, "Usar uma chave de API agora")).toBeNull();
  });
});

describe("a key on a billing hold", () => {
  test("Settings says keys open with the plan, in place of adding one", async () => {
    await open("owner", `/org/${ORG_ID}/settings/keys`);
    expect(document.body.textContent).toContain(CLOSED);
    expect(screen().queryByRole("button", { name: "Adicionar chave" })).toBeNull();
  });

  test("self-hosted keeps the form", async () => {
    await open("selfhost", `/org/${ORG_ID}/settings/keys`);
    expect(document.body.textContent).not.toContain(CLOSED);
    expect(screen().getAllByRole("button", { name: "Adicionar chave" }).length).toBeGreaterThan(0);
  });
});

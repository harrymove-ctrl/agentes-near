import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentBrain, AiStatus, MachineAccount, MachineAccountKind, Message } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadLocale } from "@/i18n";
import { aiSelect, chooseAi, payWith } from "./ai-picker";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  fakeMachinesOf,
  NOW,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

type State = ReturnType<typeof seedState>;

/** Ada and Atlas: the ones listed have no AI; `any` as the organization's. */
const aiStatus = (any: boolean, ...without: string[]): AiStatus => ({
  any,
  agents: [ADA_ID, ATLAS_ID].map((agentId) =>
    without.includes(agentId) ? { agentId, state: "no_ai", reason: "no_key" } : { agentId, state: "ready" },
  ),
});

/** Ada's card in #eng: she can't answer Walter's message (`intent`: what Jev read in it). */
const card = (noAi: Record<string, unknown> = {}): Message => ({
  id: "m-noai",
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent", id: ADA_ID },
  body: "I can't answer yet: I have no AI connected.",
  mentionedAgentIds: [],
  agentRunId: "r-noai",
  meta: {
    bodyCode: "no_ai",
    noAi: { agentId: ADA_ID, forUserId: "u-walter", reason: "no_key", intent: "task", runId: "r-noai", ...noAi },
  },
  createdAt: NOW.toISOString(),
});

/** A plan thinks only for its owner's agents (ADR 0059 §3): these become Walter's, so he may connect his. */
const walters = (state: State, ...agentIds: string[]) => {
  for (const a of state.agents) if (agentIds.includes(a.id)) a.ownerUserId = "u-walter";
  return state;
};

const withCard = (noAi: Record<string, unknown> = {}, status = aiStatus(false, ADA_ID, ATLAS_ID)) => {
  const state = seedState({ aiStatus: status });
  state.messages.push(card(noAi));
  return state;
};

const open = async (state: State = seedState(), path = `c/${ENG_ID}`) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, api, socket, state };
};
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>) =>
  act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
const click = async (el: HTMLElement, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: State, method: string) => state.calls.filter((c) => c.method === method);
const banner = () => document.querySelector(".noai-banner") as HTMLElement | null;
const cardRow = () =>
  screen()
    .getAllByRole("article")
    .find((a) => a.querySelector(".rq-open, .rq-done")) as HTMLElement;
const dialog = (name: string | RegExp) => screen().queryByRole("dialog", { name });
/** The computer's own sign-in isn't Walter's here: a plan signs in from the page. */
const noOwnSignIn = (api: ReturnType<typeof createFakeApi>) => {
  const brain = api.agents.brain;
  api.agents.brain = async (orgId, agentId) => ({ ...(await brain(orgId, agentId)), ownSignIn: false });
};
/** The receipt under my message with this text. */
const receiptOf = (text: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(text))
    ?.querySelector(".ac-receipt") as HTMLElement;
/**
 * Connect for an agent of the person's own is the narrow dialog under the sky from every way in (ADR 0160, addendum):
 * what they already have first, then the choices behind "Conectar outra IA".
 */
const inBand = (box: HTMLElement) => box.querySelector(".arrival-hero") !== null;
/** In the narrow dialog, a new plan's steps: past what the person already has, if anything, its card. */
const toPlan = async (box: HTMLElement, name: string) => {
  const other = within(box).queryByRole("button", { name: "Conectar outra IA" });
  if (other) await click(other);
  await click(within(box).getByRole("button", { name: new RegExp(`^${name}`) }), 8);
};
/** Its sign-in window stubbed while `run` clicks it. */
const withPopup = async (run: () => Promise<void>) => {
  const realOpen = window.open;
  window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
  try {
    await run();
  } finally {
    window.open = realOpen;
  }
};
const sendText = async (text: string) => {
  // The composer in Portuguese, or in German for the worst case.
  const box = screen().getByRole("combobox", { name: /Mensagem para|Nachricht an/ });
  await act(async () => fireEvent.change(box, { target: { value: text } }));
  await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
  await settle(4);
};

describe("no AI connected: above the composer", () => {
  test("the organization has none: everyone sees it in a channel with agents; Connect opens on Claude's sign-in for the first agent with no AI", async () => {
    const jev = { by: "jev", mine: "jev", model: null, noSmallModel: null } as const;
    const { api } = await open(
      walters(seedState({ aiStatus: { ...aiStatus(false, ADA_ID, ATLAS_ID), routing: jev } }), ADA_ID),
    );
    // The MacBook he connected, its Claude Code signed in there.
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
          own: { claude_code: { plan: "max" } },
        },
      ],
    });
    const shown = banner();
    // One line and Connect; that it can also be asked for in the chat is the line's ⓘ, named by its topic (the
    // line is a whole sentence). Jev is what understands that ask.
    expect(shownText(shown as HTMLElement)).toBe("Os agentes ainda não têm uma\u00a0IA.Conectar uma IA");
    expect(hintOf("Conectar uma IA", shown as HTMLElement).text).toBe(
      "Você também pode pedir no chat, como “usar meu plano do Claude”.",
    );
    await click(within(shown as HTMLElement).getByRole("button", { name: "Conectar uma IA" }), 6);
    // For the team (ADR 0160, addendum): Ada is Walter's and has no AI, Atlas isn't his. The AIs are the list.
    const first = dialog("Conectar uma IA para o time") as HTMLElement;
    expect(shownText(first)).toContain("1 agente sem IA");
    for (const name of ["Claude", "ChatGPT", "Outro plano", "Chave de API", "Começar grátis"])
      expect(within(first).getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    await click(within(first).getByRole("button", { name: /^Claude/ }), 6);
    // The plan is for her, on the MacBook he connected.
    const panel = within(first).getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).queryByRole("combobox", { name: "Agentes que usam este plano" })).toBeNull();
    expect(panel.textContent).toContain("A conta que os seus agentes dividem");
  });

  test("a channel with one agent of the person's: Connect for the whole team all the same, its other agents too", async () => {
    const state = walters(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }), ADA_ID, ATLAS_ID);
    state.channelMembers[ENG_ID] = (state.channelMembers[ENG_ID] ?? []).filter((m) => m.id !== ATLAS_ID);
    await open(state);
    await click(within(banner() as HTMLElement).getByRole("button", { name: "Conectar uma IA" }), 6);
    const team = dialog("Conectar uma IA para o time") as HTMLElement;
    expect(inBand(team)).toBe(true);
    expect(shownText(team)).toContain("2 agentes sem IA");
  });

  test("without Jev, nothing in the chat would understand the ask: no ⓘ", async () => {
    for (const routing of [undefined, { by: "rules", mine: "rules", model: null, noSmallModel: null } as const]) {
      await open(seedState({ aiStatus: { ...aiStatus(false, ADA_ID, ATLAS_ID), ...(routing ? { routing } : {}) } }));
      expect(shownText(banner() as HTMLElement)).toBe("Os agentes ainda não têm uma\u00a0IA.Conectar uma IA");
      expect(within(banner() as HTMLElement).queryByRole("button", { name: "Sobre Conectar uma IA" })).toBeNull();
      cleanup();
    }
  });

  test("the ready email's Connect your AI: the picker on Claude, with the computer said ready first; not from the banner", async () => {
    const state = walters(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }), ADA_ID);
    const api = createFakeApi(state);
    noOwnSignIn(api);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    const { router } = await renderApp(`/org/${ORG_ID}?connect=ai`, { api });
    await settle(8);
    expect(router.state.location.search).toEqual({});
    // For the team: Ada, his, has no AI. Claude is a card, and its steps say the computer is ready first.
    const first = dialog("Conectar uma IA para o time") as HTMLElement;
    await click(within(first).getByRole("button", { name: /^Claude/ }), 6);
    const panel = within(first).getByRole("region", { name: "Seu plano do Claude" });
    // Without the computer's name, in a group of its own over a hairline: never read as part of the account.
    expect(panel.querySelector(".ai-panel__ready")?.textContent).toBe("O computador está pronto.");
    expect((within(first).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // Opened from the banner, nothing just got ready: no word about it.
    await act(async () => fireEvent.keyDown(first, { key: "Escape" }));
    await act(async () =>
      router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: ENG_ID } }),
    );
    await settle(6);
    await click(within(banner() as HTMLElement).getByRole("button", { name: "Conectar uma IA" }), 8);
    const team = dialog("Conectar uma IA para o time") as HTMLElement;
    await click(within(team).getByRole("button", { name: /^Claude/ }), 6);
    const again = within(team).getByRole("region", { name: "Seu plano do Claude" });
    expect(again.textContent).not.toContain("está pronto");
  });

  test("an admin with no agent of their own: the API key first; a plan still connects, for the agents they create", async () => {
    await open(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }));
    await click(within(banner() as HTMLElement).getByRole("button", { name: "Conectar uma IA" }));
    const first = dialog("Conectar uma IA") as HTMLElement;
    expect(payWith(first, "Com chave de API").getAttribute("aria-checked")).toBe("true");
    expect(within(first).getByRole("region", { name: "Chave de API" })).toBeTruthy();
    // Every option stays in view, never locked: with no computer yet, the plan's panel offers connecting one.
    await chooseAi(first, "Claude");
    const panel = within(first).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("As contas ficam num computador conectado. Conecte um seu primeiro.");
    expect(within(panel).getByRole("button", { name: "Conectar um computador" })).toBeTruthy();
  });

  test("a workspace with no agent at all: Claude first, signed in on its computer for the agents to come", async () => {
    const account: MachineAccount = {
      id: "acct_1",
      kind: "claude_code",
      label: "Claude",
      email: "walter@acme.com.br",
      plan: "max",
      status: "active",
      ownerId: "u-walter",
      ownerName: "Walter",
      mine: true,
      usedBy: [],
      usage: null,
      provider: null,
      keyHint: null,
      shared: true,
    };
    const state = seedState({ aiStatus: { any: false, agents: [] } });
    state.agents = [];
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({
      accounts: [],
      computers: [
        {
          machineId: "machine_1",
          name: "Servidor",
          online: true,
          mine: false,
          canAdd: true,
          keys: true,
          brains: { claude_code: true, codex: true },
        },
      ],
    });
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account });
    // Settings › AI accounts, where the person was told to go.
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(5);
    await click(screen().getByRole("button", { name: "Conectar uma IA" }), 6);
    const box = dialog("Conectar uma IA") as HTMLElement;
    expect(aiSelect(box).textContent).toBe("Claude");
    const panel = within(box).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Os agentes que você criar pensam com ele.");
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(panel).getByRole("button", { name: "Entrar com Claude" }), 8);
    } finally {
      window.open = realOpen;
    }
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([ORG_ID, "machine_1", "claude_code"]);
    await settle(6);
    // No agent to move onto it: the account waits for the agents they create.
    expect(calls(state, "agents.setBrain")).toEqual([]);
    expect(box.textContent).toContain("Claude está conectado. Os agentes que você criar pensam com ele.");
    await click(within(box).getByRole("button", { name: "Pronto" }));
    expect(dialog("Conectar uma IA")).toBeNull();
  });

  /** Settings › AI accounts, with no agent at all, and these computers and accounts. */
  type Machines = NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  const bareDialog = async (ai: (machines: Machines) => Parameters<Machines["setAiAccounts"]>[0]) => {
    const state = seedState({ aiStatus: { any: false, agents: [] } });
    state.agents = [];
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api) as Machines;
    machines.setAiAccounts(ai(machines));
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(5);
    await click(screen().getByRole("button", { name: "Conectar uma IA" }), 6);
    return { state, machines, box: dialog("Conectar uma IA") as HTMLElement };
  };
  const SERVER = {
    machineId: "machine_1",
    name: "Servidor",
    online: true,
    mine: false,
    canAdd: true,
    keys: true,
    brains: { claude_code: true, codex: true },
  };

  test("no agent, and a Claude account of theirs already: it's connected, no second sign-in", async () => {
    const { state, box } = await bareDialog(() => ({
      accounts: [
        {
          id: "acct_1",
          kind: "claude_code",
          label: "Claude",
          email: "walter@acme.com.br",
          plan: "max",
          status: "active",
          ownerId: "u-walter",
          ownerName: "Walter",
          mine: true,
          usedBy: [],
          usage: null,
          provider: null,
          keyHint: null,
          machineId: "machine_1",
          computer: "Servidor",
        },
      ],
      computers: [SERVER],
    }));
    const panel = within(box).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Claude está conectado. Os agentes que você criar pensam com ele.");
    expect(within(panel).queryByRole("button", { name: "Entrar com Claude" })).toBeNull();
    await click(within(box).getByRole("button", { name: "Pronto" }));
    expect(dialog("Conectar uma IA")).toBeNull();
    expect(calls(state, "machines.beginAccountLogin")).toEqual([]);
  });

  test("no agent, and only someone else's computer: a computer of their own is the way on, or the key", async () => {
    const { box } = await bareDialog((machines) => {
      const mac = machines.pair({ name: "MacBook da Ana", pairedBy: { id: "u-ana", name: "Ana Souza" } });
      return { accounts: [], computers: [{ ...SERVER, machineId: mac.id, name: "MacBook da Ana", canAdd: false }] };
    });
    await chooseAi(box, "Claude");
    await settle(4);
    const panel = within(box).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Só Ana conecta um plano no MacBook da Ana.");
    expect(within(panel).getByRole("button", { name: "Conectar um computador" })).toBeTruthy();
    await click(within(panel).getByRole("button", { name: "Usar uma chave de API agora" }));
    expect(within(box).getByRole("region", { name: "Chave de API" })).toBeTruthy();
  });

  test("a DM with an agent that has none says so for that agent; an organization with AI shows nothing in channels", async () => {
    const state = seedState({ aiStatus: aiStatus(true, ADA_ID) });
    await open(state, `dm/agent/${ADA_ID}`);
    expect(banner()?.textContent).toContain("Ada não vai responder porque não tem uma IA\u00a0conectada.");
    cleanup();
    await open(seedState({ aiStatus: aiStatus(true, ADA_ID) }));
    expect(banner()).toBeNull();
  });

  test("Connect from an agent's DM: for every agent of the viewer's with no AI, or for that one alone", async () => {
    const both = () => walters(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }), ADA_ID, ATLAS_ID);
    await open(both(), `dm/agent/${ADA_ID}`);
    await click(within(banner() as HTMLElement).getByRole("button", { name: "Conectar" }), 6);
    // Atlas has none either: one sign-in is offered for both, and the For can narrow it to Ada.
    const team = dialog("Conecte uma IA para o seu time pensar") as HTMLElement;
    const whom = within(team).getByRole("group", { name: "Agentes que usam este plano" });
    expect(
      within(whom)
        .getByRole("button", { name: /^Todos os agentes/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(whom).getByRole("button", { name: /^Ada/ }).getAttribute("aria-pressed")).toBe("false");
    for (const name of ["Claude", "ChatGPT", "Outro plano", "Começar grátis"])
      expect(within(team).getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    cleanup();
    // Only Ada has none: the dialog is hers, and there is nobody else to choose.
    await open(walters(seedState({ aiStatus: aiStatus(true, ADA_ID) }), ADA_ID, ATLAS_ID), `dm/agent/${ADA_ID}`);
    await click(within(banner() as HTMLElement).getByRole("button", { name: "Conectar" }), 6);
    const hers = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(within(hers).queryByRole("group", { name: "Agentes que usam este plano" })).toBeNull();
    cleanup();
    // Opened from anywhere else, it is for the whole team: both on one line, and the way to pick among them.
    await open(both());
    await click(within(banner() as HTMLElement).getByRole("button", { name: "Conectar uma IA" }), 6);
    const any = dialog("Conectar uma IA para o time") as HTMLElement;
    expect(shownText(any.querySelector(".arrival-forline") as HTMLElement)).toBe("2 agentes sem IAEscolher");
  });

  test("All agents from a DM are the same agents on the first screen and in the plan's panel, the right hand aside", async () => {
    // As a workspace is after its agents were made: the right hand first, on no computer, then two agents on one.
    const state = walters(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }), ADA_ID, ATLAS_ID);
    withRightHand(state);
    state.agents.unshift(state.agents.pop() as (typeof state.agents)[number]);
    state.aiStatus?.agents.push({ agentId: state.agents[0]?.id ?? "", state: "no_ai", reason: "no_key" });
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.pair({
      id: "machine_1",
      name: "MacBook",
      agents: [
        { id: ADA_ID, name: "Ada", handle: "ada" },
        { id: ATLAS_ID, name: "Atlas", handle: "atlas" },
      ],
    });
    const r = await renderApp(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`, { api });
    await settle(5);
    await act(async () => r.sockets.last().open());
    await settle(2);
    await click(within(banner() as HTMLElement).getByRole("button", { name: "Conectar" }), 8);
    const box = screen().getByRole("dialog");
    const whom = within(box).getByRole("group", { name: "Agentes que usam este plano" });
    // The conversation's agent leads, the right hand isn't one of them.
    expect(within(whom).getByRole("button", { name: /^Todos os agentes/ }).textContent).toContain("Atlas e Ada");
    await click(within(box).getByRole("button", { name: /^Claude/ }), 8);
    // The plan's panel signs in for both, one at a time, the conversation's agent first: whose turn in words, their
    // faces in order, and the sign-in as the dialog's own action.
    const steps = screen().getByRole("dialog");
    expect(steps.textContent).toContain("Entre no Claude para o Atlas");
    expect([...steps.querySelectorAll(".ai-strip__face")].map((li) => li.getAttribute("title"))).toEqual([
      "Atlas",
      "Ada",
    ]);
    expect(within(steps).getByRole("button", { name: "Entrar no Claude" })).toBeTruthy();
    expect(steps.querySelector(".ai-panel__who")).toBeNull();
  });

  test("the agent's page: 'Sem IA' by its name opens Connect for that agent", async () => {
    await open(seedState({ aiStatus: aiStatus(true, ADA_ID) }), `agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Sem IA" }));
    expect(dialog("Conectar uma IA para a Ada")).not.toBeNull();
  });

  test("the agent's page: who it thinks with says no AI too, not the model it's set to, and connects one", async () => {
    await open(seedState({ aiStatus: aiStatus(true, ADA_ID) }), `agents/${ADA_ID}`);
    const work = screen().getByRole("region", { name: "Como trabalha" });
    expect(work.textContent).toContain("Pensa comSem IA");
    expect(work.textContent).not.toContain("Pela API");
    await click(within(work).getByRole("button", { name: "Conectar uma IA" }));
    expect(dialog("Conectar uma IA para a Ada")).not.toBeNull();
    cleanup();
    await open(seedState({ aiStatus: aiStatus(true, ATLAS_ID) }), `agents/${ADA_ID}`);
    expect(screen().getByRole("region", { name: "Como trabalha" }).textContent).toContain("Pela API");
  });

  test("the agent's page, for an agent of the person's on Codex: 'Sem IA' and the cell open the narrow dialog for her", async () => {
    const state = walters(seedState({ aiStatus: aiStatus(true, ADA_ID) }), ADA_ID);
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "codex", model: null };
    await open(state, `agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Sem IA" }), 6);
    const chip = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(inBand(chip)).toBe(true);
    await click(within(chip).getAllByRole("button", { name: "Fechar" })[0] as HTMLElement);
    expect(dialog("Conectar uma IA para a Ada")).toBeNull();
    const work = screen().getByRole("region", { name: "Como trabalha" });
    await click(within(work).getByRole("button", { name: "Conectar uma IA" }), 6);
    const cell = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(inBand(cell)).toBe(true);
    // A new plan is picked by its card: ChatGPT's steps, never Claude's.
    await toPlan(cell, "ChatGPT");
    expect(within(cell).getByRole("region", { name: "Seu plano do ChatGPT" })).toBeTruthy();
  });
});

describe("the agent's no-AI card", () => {
  test("its computer with no such CLI, or no computer: the card says that, not that it has no AI", async () => {
    await open(withCard({ reason: "cli_missing" }));
    expect(cardRow().textContent).toContain(
      "Ada não vai responder: o programa da IA não está instalado no computador.",
    );
    expect(cardRow().textContent).not.toContain("não tem uma IA");
    expect(within(cardRow()).getByRole("button", { name: "Conectar" })).toBeTruthy();
  });

  test("the right hand at its model's own limit names the model, with the way to an API key", async () => {
    await open(withCard({ reason: "model_limit", model: "Kimi K2" }));
    expect(cardRow().textContent).toContain(
      "Ada não consegue responder agora: o Kimi K2 chegou ao limite dele no plano. Os outros modelos do plano continuam funcionando.",
    );
    expect(cardRow().textContent).not.toContain("o plano chegou ao limite");
    expect(within(cardRow()).getByRole("button", { name: "Usar uma chave de API" })).toBeTruthy();
  });

  test("in place of its text, with Connect at the step the message asked for; a key saved there answers by itself", async () => {
    const state = withCard({ intent: "api_key", provider: "openai" });
    await open(state);
    const row = cardRow();
    expect(row.textContent).toContain("Ada não vai responder porque não tem uma IA\u00a0conectada.");
    // The pill is that line and Connect, even for whoever asked: nothing under it.
    expect(row.querySelector(".rq-open__below")).toBeNull();
    expect(row.textContent).not.toContain("Depois de conectar");
    expect(row.textContent).not.toContain("Ainda não consigo responder");
    await click(within(row).getByRole("button", { name: "Conectar" }));
    const add = dialog("Conectar uma IA para a Ada") as HTMLElement;
    // The key, on the maker the message named.
    expect(payWith(add, "Com chave de API").getAttribute("aria-checked")).toBe("true");
    expect(aiSelect(add, "Provedor").textContent).toBe("OpenAI");
    expect(within(add).getByRole("link", { name: "Abrir platform.openai.com" }).getAttribute("href")).toBe(
      "https://platform.openai.com/api-keys",
    );
    await act(async () =>
      fireEvent.change(within(add).getByLabelText("Cole aqui"), {
        target: { value: "sk-proj-abcdefghijklmnop1234" },
      }),
    );
    state.aiStatus = aiStatus(true);
    await click(within(add).getByRole("button", { name: "Salvar chave" }), 8);
    expect(calls(state, "agents.addCredential")[0]?.args[1]).toEqual({
      provider: "openai",
      label: "OpenAI",
      apiKey: "[redacted]",
    });
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-noai"]]);
    expect(add.textContent).toContain("Salva. Todo agente sem plano pensa com ela.");
    await click(within(add).getByRole("button", { name: "Pronto" }));
    expect(cardRow().textContent).toContain("Ada está respondendo…");
  });

  test("a Claude plan: signed in on Ada's computer, it becomes her brain at once and she answers", async () => {
    const account: MachineAccount = {
      id: "acct_1",
      kind: "claude_code",
      label: "Walter",
      email: "walter@acme.com.br",
      plan: "max",
      status: "active",
      ownerId: "u-walter",
      ownerName: "Walter",
      mine: true,
      usedBy: [],
      usage: null,
      provider: null,
      keyHint: null,
    };
    const state = walters(withCard({ intent: "claude" }), ADA_ID);
    const api = createFakeApi(state);
    noOwnSignIn(api);
    // The computer finishes the sign-in as soon as the page asks.
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }), 8);
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(inBand(plan)).toBe(true);
    await toPlan(plan, "Claude");
    // Claude's sign-in starts on its button, the dialog's own action, in a window of its own.
    await withPopup(() => click(within(plan).getByRole("button", { name: "Entrar com Claude" }), 8));
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([ORG_ID, "machine_1", "claude_code"]);
    await settle(6);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "claude_code", account: "acct_1" },
    ]);
    expect(plan.textContent).toContain("Ada agora pensa com Walter.");
    // On his plan she answers only him until he turns on Atende outras pessoas (ADR 0059 §5).
    expect(within(plan).getByRole("switch", { name: "Atende outras pessoas" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-noai"]]);
    await click(within(plan).getByRole("button", { name: "Pronto" }));
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  /** Ada thinks with her own login of this kind, signed out, and her card says so; the computer's own isn't Walter's. */
  const signedOutCard = (kind: MachineAccountKind) => {
    const out: MachineAccount = {
      id: "acct_ada",
      kind,
      label: "Pessoal",
      email: "walter@acme.com.br",
      plan: "max",
      status: "signed_out",
      ownerId: "u-walter",
      ownerName: "Walter",
      mine: true,
      usedBy: ["Ada"],
      usage: null,
      provider: null,
      keyHint: null,
    };
    const state = walters(withCard({ reason: "not_signed_in" }), ADA_ID);
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind, model: null };
    const api = createFakeApi(state);
    const brain = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await brain(orgId, agentId)),
      ownSignIn: false,
      ...(agentId === ADA_ID ? { brain: kind, account: out.id, accounts: [out] } : {}),
    });
    return { state, api };
  };

  test("her login signed out: she says so, and Entrar de novo signs that login in once more, its own email unseen", async () => {
    const { state, api } = signedOutCard("claude_code");
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const row = cardRow();
    expect(row.textContent).toContain("Ada não vai responder porque a IA dela saiu da conta.");
    expect(row.textContent).not.toContain("não tem uma IA");
    await click(within(row).getByRole("button", { name: "Entrar de novo" }), 8);
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(aiSelect(plan).textContent).toBe("Claude");
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(plan).getByRole("button", { name: "Entrar com Claude" }), 8);
    } finally {
      window.open = realOpen;
    }
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { accountId: "acct_ada", email: "walter@acme.com.br" },
    ]);
    expect(shownText(plan)).not.toContain("walter@acme.com.br");
  });

  test("her ChatGPT login signed out: Entrar de novo opens on ChatGPT and signs that login in again, never Claude", async () => {
    const { state, api } = signedOutCard("codex");
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow()).getByRole("button", { name: "Entrar de novo" }), 8);
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(aiSelect(plan).textContent).toBe("ChatGPT");
    expect(within(plan).queryByRole("button", { name: "Entrar com Claude" })).toBeNull();
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(plan).getByRole("button", { name: "Entrar com ChatGPT" }), 8);
    } finally {
      window.open = realOpen;
    }
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([
      ORG_ID,
      "machine_1",
      "codex",
      { accountId: "acct_ada" },
    ]);
  });

  test("Codex on its computer's own sign-in, which isn't there: she says so and how, and Conectar opens on ChatGPT", async () => {
    const state = walters(withCard({ reason: "not_signed_in", own: "codex" }), ADA_ID);
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "codex", model: null };
    const api = createFakeApi(state);
    const brain = api.agents.brain;
    // The workspace's computer: nobody connected it, so its own sign-in thinks for nobody.
    api.agents.brain = async (orgId, agentId) => ({
      ...(await brain(orgId, agentId)),
      ownSignIn: false,
      ...(agentId === ADA_ID ? { brain: "codex" as const } : {}),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const row = cardRow();
    expect(row.textContent).toContain(
      "O Codex está sem login neste computador. Conecte uma conta do ChatGPT na página da Ada.",
    );
    expect(row.textContent).not.toMatch(/saiu da|quando ele voltar/);
    expect(within(row).queryByRole("button", { name: "Entrar de novo" })).toBeNull();
    await click(within(row).getByRole("button", { name: "Conectar" }), 8);
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(aiSelect(plan).textContent).toBe("ChatGPT");
    // Nothing of that computer's to share: ChatGPT's own sign-in, from here.
    expect(within(plan).queryByRole("button", { name: /^A conta que os seus agentes dividem/ })).toBeNull();
    expect(within(plan).getByRole("button", { name: "Entrar com ChatGPT" })).toBeTruthy();
  });

  test("Conectar asks the computers for their own sign-ins again: ChatGPT's is known by the usage read with it", async () => {
    const { state } = await open(walters(withCard({ intent: "chatgpt" }), ADA_ID));
    expect(calls(state, "machines.refreshAccountUsage")).toEqual([]);
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }), 8);
    expect(dialog("Conectar uma IA para a Ada")).not.toBeNull();
    expect(calls(state, "machines.refreshAccountUsage").map((c) => c.args)).toEqual([[ORG_ID]]);
  });

  test("a plan while the workspace's computer is on its way: it waits, for the time left; a key meanwhile", async () => {
    const state = walters(withCard({ intent: "claude" }), ADA_ID);
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "preparing", step: "installing", secondsLeft: 330 });
    const brain = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await brain(orgId, agentId)), computer: null });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }), 8);
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    await toPlan(plan, "Claude");
    const panel = within(plan).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Faltam uns 6 min");
    // The well says how far it is and, with no email to promise, when the sign-in under it turns on: once.
    expect(panel.querySelector(".ai-panel__wait")?.lastElementChild?.textContent).toBe(
      "Você entra aqui assim que o computador ficar pronto.",
    );
    expect(panel.textContent?.split("pronto")).toHaveLength(2);
    expect((within(plan).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(true);
    // A key meanwhile: back to the choices, its card.
    await click(within(plan).getByRole("button", { name: "Voltar" }));
    await toPlan(plan, "Chave de API");
    expect(within(plan).getByRole("region", { name: "Chave de API" })).toBeTruthy();
  });

  test("the workspace's computer ready and still none for her after asking again: the sign-in stops loading and says what's needed", async () => {
    const state = walters(withCard({ intent: "claude" }), ADA_ID);
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    const brain = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await brain(orgId, agentId)), computer: null, accounts: [] });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }), 10);
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    await toPlan(plan, "Claude");
    const panel = within(plan).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.querySelector("[aria-busy='true']")).toBeNull();
    expect(panel.textContent).toContain("não vai mudar sozinho");
    expect(within(plan).queryByRole("button", { name: "Conectar um computador" })).toBeNull();
    expect(within(plan).getByRole("button", { name: "Usar uma chave de API agora" })).toBeTruthy();
  });

  test("its views don't load: the plan's panel says so with Tentar de novo, which asks again", async () => {
    const state = walters(withCard({ intent: "claude" }), ADA_ID);
    const api = createFakeApi(state);
    const brain = api.agents.brain;
    let down = true;
    api.agents.brain = async (orgId, agentId) => {
      if (down) throw new ApiError(500, "internal", "down");
      return brain(orgId, agentId);
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }), 10);
    const plan = dialog("Conectar uma IA para a Ada") as HTMLElement;
    await toPlan(plan, "Claude");
    const panel = within(plan).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Não foi possível carregar");
    down = false;
    await click(within(panel).getByRole("button", { name: "Tentar de novo" }), 10);
    expect(within(plan).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
  });

  test("connected elsewhere: 'Responder agora'; still no AI: it says so and keeps Connect", async () => {
    const state = withCard({}, aiStatus(true));
    await open(state);
    expect(cardRow().textContent).toContain("Pronto: Ada já tem uma IA.");
    state.answerNowError = new ApiError(409, "ai.still_missing", "There is still no AI connected");
    await click(within(cardRow()).getByRole("button", { name: "Responder agora" }));
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-noai"]]);
    expect(cardRow().textContent).toContain("Ainda falta conectar uma IA para\u00a0Ada.");
    expect(within(cardRow()).getByRole("button", { name: "Conectar" })).toBeTruthy();
  });

  test("someone without the rights is told who connects it (an admin with a key, the owner with a plan)", async () => {
    const state = withCard();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await open(state);
    // No Conectar that leads nowhere: the card itself says who can.
    expect(cardRow().textContent).toContain(
      "Quem conecta a IA de Ada: um admin, com uma chave de API, ou João, com o próprio plano.",
    );
    expect(within(cardRow()).queryByRole("button", { name: "Conectar" })).toBeNull();
  });

  test("the right hand's plan line offers a key only to who can add one", async () => {
    const state = withCard({ reason: "plan_limit" });
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await open(state);
    expect(cardRow().textContent).toContain("Só um admin pode conectar uma IA.");
    expect(within(cardRow()).queryByRole("button", { name: "Usar uma chave de API" })).toBeNull();
  });
});

describe("Conectar uma IA for an agent with no AI: what the person already has, first", () => {
  /** An account on Ada's computer, as her view lists it: Walter's, unless said otherwise. */
  const acct = (over: Partial<MachineAccount> & { id: string }): MachineAccount => ({
    kind: "claude_code",
    label: "Claude Team",
    email: null,
    plan: "team",
    status: "active",
    ownerId: "u-walter",
    ownerName: "Walter",
    mine: true,
    usedBy: [],
    usage: null,
    provider: null,
    keyHint: null,
    ...over,
  });
  const team = acct({ id: "acct_team", email: "team@example.com" });
  const pessoal = acct({
    id: "acct_pessoal",
    label: "Claude Pessoal",
    plan: "max",
    email: "walter@acme.com.br",
    usedBy: ["Atlas"],
  });
  const plus = acct({
    id: "acct_plus",
    kind: "codex",
    label: "ChatGPT Plus",
    plan: "plus",
    email: "walt@gmail.com",
    usedBy: ["Atlas"],
  });

  /** Ada's row on Claude Code, as the server lists an agent on a plan, whatever her AI status says. */
  const onClaudeCode = (state: State) => {
    for (const a of state.agents) if (a.id === ADA_ID) a.brain = { kind: "claude_code", model: "Sonnet" };
    return state;
  };

  /**
   * Ada's card's Connect, her view over the fake's (`brain`); the computer's own sign-in isn't Walter's. When Ada is
   * his it is the narrow dialog: what he already has for her first (`group`), each picked and then used at the foot.
   * Someone else's agent keeps the plain dialog, its picker first (`picker`).
   */
  const connectAda = async (state: State, brain: Partial<AgentBrain> = {}) => {
    const api = createFakeApi(state);
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await viewOf(orgId, agentId)),
      ownSignIn: false,
      ...(agentId === ADA_ID ? brain : {}),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }), 8);
    const box = dialog("Conectar uma IA para a Ada") as HTMLElement;
    return {
      api,
      box,
      group: () => within(box).getByRole("radiogroup", { name: "Já conectadas" }),
      picker: within(box).queryByRole("group", { name: "Qual IA eles vão usar?" }) as HTMLElement,
    };
  };
  /** The rows of what the person already has, as titled, in order; and the one picked. */
  const haveTitles = (box: HTMLElement) =>
    [...box.querySelectorAll(".arrival-have__row .arrival-have__title")].map((t) => t.textContent);
  const haveRow = (box: HTMLElement, title: string) =>
    [...box.querySelectorAll<HTMLElement>(".arrival-have__row")].find(
      (r) => r.querySelector(".arrival-have__title")?.textContent === title,
    ) as HTMLElement;
  const pickedHave = (box: HTMLElement) =>
    box.querySelector(".arrival-have__row[data-state='checked'] .arrival-have__title")?.textContent;
  /** A row picked, then used at the dialog's foot ("Usar …"). */
  const useHave = async (box: HTMLElement, title: string) => {
    if (pickedHave(box) !== title) await click(haveRow(box, title).querySelector("[role='radio']") as HTMLElement);
    await click(within(box).getByRole("button", { name: `Usar ${title}` }), 8);
  };
  /** "Entrar com Claude", the dialog's own action under the plan's steps, its sign-in window stubbed. */
  const signInWithClaude = (box: HTMLElement) =>
    withPopup(() => click(within(box).getByRole("button", { name: "Entrar com Claude" }), 8));

  test("the free account first, then those other agents use, the workspace's key past them; used, she thinks with it, no sign-in", async () => {
    const state = walters(withCard(), ADA_ID);
    const { box, group } = await connectAda(state, { accounts: [pessoal, plus, team] });
    // Four in all: the three with most room, picked the one used in one click, and the way to every one.
    expect(group().firstElementChild?.textContent).toBe("Com mais folga agora");
    expect(haveTitles(box)).toEqual(["Claude Team", "Claude Pessoal · Max", "ChatGPT Plus"]);
    expect(pickedHave(box)).toBe("Claude Team");
    await click(within(box).getByRole("button", { name: "Ver as 4 contas" }));
    expect(haveTitles(box)).toEqual(["Claude Team", "Claude Pessoal · Max", "ChatGPT Plus", "Claude da Acme"]);
    await click(within(box).getByRole("button", { name: "Voltar" }));
    expect(within(box).getByRole("button", { name: "Conectar outra IA" })).toBeTruthy();
    await useHave(box, "Claude Team");
    expect(calls(state, "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { brain: "claude_code", account: "acct_team" }],
    ]);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
    expect(box.textContent).toContain("Ada agora pensa com Claude Team.");
    // On his plan she answers only him until he lets everyone in (ADR 0059 §5).
    expect(within(box).getByRole("switch", { name: "Atende outras pessoas" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-noai"]]);
    await click(within(box).getByRole("button", { name: "Pronto" }));
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("Só algumas pessoas with nobody picked: Atende outras pessoas lets nobody in, so it goes back off and says why", async () => {
    const state = walters(withCard(), ADA_ID);
    for (const a of state.agents) if (a.id === ADA_ID) a.audience = { mode: "people", userIds: [] };
    const { box } = await connectAda(state, { accounts: [team] });
    await useHave(box, "Claude Team");
    const replies = () => within(box).getByRole("switch", { name: "Atende outras pessoas" });
    await click(replies(), 6);
    expect(calls(state, "agents.setBrain").at(-1)?.args).toEqual([ORG_ID, ADA_ID, { onlyOwner: false }]);
    expect(replies().getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).toContain(
      "A Ada só atende as pessoas escolhidas, e ninguém foi escolhido ainda. Escolha em Quem pode falar.",
    );
  });

  test("an account another agent thinks with: used here too, a sign-in of that account for her, its email Claude's hint", async () => {
    const state = walters(withCard(), ADA_ID);
    const { box } = await connectAda(state, { accounts: [pessoal] });
    await useHave(box, "Claude Pessoal · Max");
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
    // Its plan's steps, for her.
    expect(within(box).getByRole("region", { name: "Seu plano do Claude" })).toBeTruthy();
    await signInWithClaude(box);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [ORG_ID, "machine_1", "claude_code", { email: "walter@acme.com.br" }],
    ]);
  });

  test("a row's sign-in is that sign-in, even with an account of the plan there for all of her owner's agents", async () => {
    const state = walters(withCard(), ADA_ID);
    const forAll = acct({ id: "acct_all", label: "Claude Max", plan: "max", shared: true, usedBy: ["Atlas"] });
    const { box } = await connectAda(state, { accounts: [pessoal, forAll] });
    await useHave(box, "Claude Pessoal · Max");
    expect(within(box).getByRole("region", { name: "Seu plano do Claude" })).toBeTruthy();
    expect(within(box).queryByRole("button", { name: /^Usar Claude Max/ })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Outra conta" })).toBeNull();
    await signInWithClaude(box);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [ORG_ID, "machine_1", "claude_code", { email: "walter@acme.com.br" }],
    ]);
  });

  test("its computer off: the row's steps say so, and Usar uma chave de API agora opens the key", async () => {
    const state = walters(withCard(), ADA_ID);
    const { box } = await connectAda(state, {
      accounts: [pessoal],
      computer: { machineId: "machine_1", name: "MacBook", online: false },
    });
    await useHave(box, "Claude Pessoal · Max");
    await click(within(box).getByRole("button", { name: "Usar uma chave de API agora" }));
    expect(within(box).getByRole("region", { name: "Chave de API" })).toBeTruthy();
    expect(aiSelect(box, "Provedor")).toBeTruthy();
  });

  test("a free login signed out, signed in again from its row: she thinks with it, and its steps say so", async () => {
    const state = walters(withCard(), ADA_ID);
    const out = acct({ id: "acct_out", label: "Claude 08", email: "it@example.org", status: "signed_out" });
    const { api, box } = await connectAda(state, { accounts: [out] });
    const title = haveTitles(box)[0] ?? "";
    expect(title).toStartWith("Claude 08");
    await useHave(box, title);
    expect(within(box).getByRole("region", { name: "Seu plano do Claude" })).toBeTruthy();
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account: { ...out, status: "active" } });
    await signInWithClaude(box);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [ORG_ID, "machine_1", "claude_code", { accountId: "acct_out", email: "it@example.org" }],
    ]);
    expect(calls(state, "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { brain: "claude_code", account: "acct_out" }],
    ]);
    expect(within(box).getByRole("region", { name: "Seu plano do Claude" }).textContent).toContain(
      "Ada agora pensa com Claude 08.",
    );
  });

  test("on Claude Code with no sign-in left she has no AI either: the list shows, the free account hers in one click", async () => {
    const state = onClaudeCode(walters(withCard(), ADA_ID));
    const { box, group } = await connectAda(state, { brain: "claude_code", accounts: [team] });
    expect(group()).toBeTruthy();
    expect(pickedHave(box)).toBe("Claude Team");
    await useHave(box, "Claude Team");
    expect(calls(state, "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { brain: "claude_code", account: "acct_team" }],
    ]);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
    expect(box.textContent).toContain("Ada agora pensa com Claude Team.");
  });

  test("the workspace's API key: used, she thinks with it on the workspace's model", async () => {
    const state = onClaudeCode(walters(withCard(), ADA_ID));
    const { box } = await connectAda(state, { brain: "claude_code" });
    expect(shownText(haveRow(box, "Claude da Acme"))).toBe("Claude da AcmeClaude · termina em 7f2a");
    await useHave(box, "Claude da Acme");
    expect(calls(state, "agents.setBrain").map((c) => c.args)).toEqual([[ORG_ID, ADA_ID, { brain: "model" }]]);
    // Her model runs on that key: it stays.
    expect(calls(state, "agents.update").map((c) => c.args)).toEqual([[ORG_ID, ADA_ID, { credentialId: "cred-1" }]]);
    expect(box.textContent).toContain("Ada agora pensa com Claude da Acme.");
    expect(within(box).queryByRole("switch", { name: "Atende outras pessoas" })).toBeNull();
  });

  test("a stored key out of credit: the provider's reason and the page that fixes it, and she doesn't move to it", async () => {
    const state = onClaudeCode(walters(withCard(), ADA_ID));
    const { api, box } = await connectAda(state, { brain: "claude_code" });
    api.agents.checkCredential = async () => {
      throw new ApiError(400, "provider_key_no_credit", "refused", {
        provider: "Claude",
        said: "Your credit balance is too low",
      });
    };
    await useHave(box, "Claude da Acme");
    expect(box.textContent).toContain("Your credit balance is too low");
    expect(within(box).getByRole("link", { name: "platform.claude.com" })).toBeTruthy();
    expect(calls(state, "agents.update")).toHaveLength(0);
    expect(box.textContent).not.toContain("agora pensa com");
  });

  test("someone else's agent: its owner's account shows, locked, his alone to pick; an admin may still give her a key", async () => {
    const joao = acct({
      id: "acct_joao",
      label: "Claude Max",
      plan: "max",
      ownerId: "u-joao",
      ownerName: "João",
      mine: false,
    });
    // Ada is João's; Walter owns the workspace.
    const state = withCard();
    const { box, picker } = await connectAda(state, { accounts: [joao], canUsePlans: false, canManageAccounts: false });
    const locked = within(picker).getByRole("button", { name: /^Claude Max/ }) as HTMLButtonElement;
    expect(shownText(locked)).toBe("Claude MaxDe João");
    expect(locked.disabled).toBe(true);
    await click(locked);
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
    expect(within(picker).getByRole("button", { name: /^Claude da Acme/ })).toBeTruthy();
    // A plan for her is João's to connect, as his account is his to pick.
    await chooseAi(box, "Claude");
    expect(box.textContent).toContain(
      "Quem conecta a IA de Ada: um admin, com uma chave de API, ou João, com o próprio plano.",
    );
  });

  test("who may use other people's plans picks a teammate's in one click; one another agent has stays locked", async () => {
    const bia = acct({
      id: "acct_bia",
      label: "Claude Max",
      plan: "max",
      ownerId: "u-bia",
      ownerName: "Bia",
      mine: false,
    });
    const busy = acct({
      id: "acct_caio",
      label: "Claude Pro",
      plan: "pro",
      ownerId: "u-caio",
      ownerName: "Caio",
      mine: false,
      usedBy: ["Atlas"],
    });
    const state = withCard();
    const { box, picker } = await connectAda(state, {
      accounts: [bia, busy],
      canUsePlans: false,
      canManageAccounts: false,
      canUseOthersPlans: true,
    });
    const theirs = within(picker).getByRole("button", { name: /^Claude Max/ }) as HTMLButtonElement;
    expect(shownText(theirs)).toBe("Claude MaxDe Bia");
    expect(theirs.disabled).toBe(false);
    expect((within(picker).getByRole("button", { name: /^Claude Pro/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(picker.textContent).toContain(
      "Os planos de outras pessoas mostram de quem são. O dono recebe um e-mail e pode tirar de volta.",
    );
    await click(theirs, 8);
    expect(calls(state, "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { brain: "claude_code", account: "acct_bia" }],
    ]);
    expect(box.textContent).toContain("Ada agora pensa com Claude Max.");
  });
});

describe("receipts and the live block", () => {
  test("routed to nobody for want of an AI: 'Ninguém vai responder: falta uma IA · Conectar' under the message", async () => {
    const { socket, state } = await open(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }));
    await sendText("alguém resume o canal?");
    const mine = state.messages.at(-1) as Message;
    await push(socket, {
      type: "message.routed",
      messageId: mine.id,
      seenBy: [],
      pickedBy: [],
      strategy: "none",
      reason: "no_ai",
      intent: "task",
    });
    const receipt = receiptOf("alguém resume o canal?");
    expect(receipt.textContent).toContain("Ninguém vai responder: falta uma IA·Conectar");
    await click(within(receipt).getByRole("button", { name: "Conectar" }));
    expect(dialog("Conectar uma IA")).not.toBeNull();
  });

  test("a mentioned agent that can't think: its receipt says so, and its block leaves no failure behind", async () => {
    const { socket, state } = await open(seedState({ aiStatus: aiStatus(true, ADA_ID) }));
    await sendText("@ada e o login?");
    const mine = state.messages.at(-1) as Message;
    // Asked in the channel, answered in the channel: its events carry no thread.
    const run = { threadId: null, runId: "r-ada", agentId: ADA_ID, triggerMessageId: mine.id };
    await push(socket, { type: "agent.thinking", ...run });
    await push(socket, { type: "agent.run", ...run, status: "failed", error: "no_ai" });
    await push(socket, { type: "run.finished", ...run, status: "failed", error: "no_ai" });
    await push(socket, { type: "message.handled", messageId: mine.id, ...run, status: "failed", reason: "no_ai" });
    await settle();
    expect(document.querySelector(".ac-msg__error")).toBeNull();
    const receipt = receiptOf("e o login?");
    const check = receipt.querySelector(".ac-receipt__check") as HTMLElement;
    expect(check.getAttribute("aria-label")).toBe("Vista por Ada. Ninguém vai responder: falta uma IA");
    expect(receipt.textContent).toContain("Ninguém vai responder: falta uma IA·Conectar");
    expect(receipt.textContent).not.toContain("Tentar de novo");
  });

  /** Walter's message to Ada, read with her run at `handled`. */
  const asked = (handled: NonNullable<Message["receipts"]>["handled"]): Message => ({
    id: "m-asked",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: "@ada quem são os nossos concorrentes?",
    mentionedAgentIds: [ADA_ID],
    agentRunId: null,
    createdAt: new Date(NOW.getTime() - 1000).toISOString(),
    receipts: { seenBy: [ADA_ID], pickedBy: [ADA_ID], handled, blocked: [] },
  });
  const check = () => receiptOf("quem são os nossos concorrentes?").querySelector(".ac-receipt__check") as HTMLElement;

  test("her card and her run's end, posted while the socket still opened after a page change: they show once the channel's subscription is confirmed", async () => {
    const state = seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) });
    state.messages.push(asked([{ agentId: ADA_ID, runId: "r-noai", status: "running" }]));
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    // Read as her run started.
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada está respondendo");
    // She has no AI: her card and her run's end come before the socket is even open, so no event carries them.
    state.messages = state.messages.map((m) =>
      m.id === "m-asked" ? asked([{ agentId: ADA_ID, runId: "r-noai", status: "failed", reason: "no_ai" }]) : m,
    );
    state.messages.push(card());
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    expect(socket.sent).toContainEqual({ type: "subscribe", channelId: ENG_ID });
    expect(cardRow()).toBeUndefined();
    // The server confirms the subscription: the channel is read again.
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(cardRow().textContent).toContain("Ada não vai responder porque não tem uma IA\u00a0conectada.");
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ninguém vai responder: falta uma IA");
    expect(receiptOf("quem são os nossos concorrentes?").textContent).toContain(
      "Ninguém vai responder: falta uma IA·Conectar",
    );
  });

  test("opened after her no-AI failure, then 'Responder agora': she answers, and her receipt stays answered", async () => {
    const state = seedState({ aiStatus: aiStatus(true) });
    state.messages.push(asked([{ agentId: ADA_ID, runId: "r-noai", status: "failed", reason: "no_ai" }]), card());
    const { socket } = await open(state);
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ninguém vai responder: falta uma IA");
    await click(within(cardRow()).getByRole("button", { name: "Responder agora" }));
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-noai"]]);
    // The server starts her again on Walter's message, in a new run.
    const run = { threadId: null, runId: "r-again", agentId: ADA_ID };
    const frame = (event: Record<string, unknown>) => ({
      type: "event",
      channelId: ENG_ID,
      event: { channelId: ENG_ID, ...event },
    });
    await act(async () => {
      socket.push(frame({ type: "message.claimed", messageId: "m-asked", agentId: ADA_ID, runId: "r-again" }));
      socket.push(frame({ type: "agent.run", ...run, status: "running" }));
    });
    await settle(2);
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada está respondendo");
    // Her answer and her run's end arrive together, before the page draws the answer.
    const answer: Message = {
      id: "m-answer",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Os três maiores são a Orbe, a Lumen e a Quadra.",
      mentionedAgentIds: [],
      agentRunId: "r-again",
      createdAt: new Date().toISOString(),
    };
    await act(async () => {
      socket.push(frame({ type: "message.created", messageId: answer.id, message: answer }));
      socket.push(frame({ type: "agent.run", ...run, status: "done" }));
      socket.push(frame({ type: "run.finished", ...run, status: "done" }));
      socket.push(frame({ type: "message.handled", messageId: "m-asked", ...run, status: "done" }));
    });
    await settle(4);
    const shown = screen()
      .getAllByRole("article")
      .some((a) => a.textContent?.includes("Os três maiores são a Orbe, a Lumen e a Quadra."));
    expect(shown).toBe(true);
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada respondeu");
  });
});

describe("the dialog opens by itself only when Jev is sure, for the author, once", () => {
  const routed = (messageId: string, extra: Record<string, unknown>) => ({
    type: "message.routed",
    messageId,
    seenBy: [],
    pickedBy: [],
    strategy: "none",
    reason: "no_ai",
    ...extra,
  });

  test("my message asking for a Claude plan (≥ 0.9): the plan step opens; never twice, never for someone else's", async () => {
    const { socket, state } = await open(walters(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }), ADA_ID));
    // João's message: not mine.
    await push(socket, routed("m-1", { intent: "claude", autoOpen: true }));
    expect(screen().queryByRole("dialog")).toBeNull();
    await sendText("quero usar meu plano do Claude");
    const mine = state.messages.at(-1) as Message;
    // Below 0.9 the step is only offered, never opened.
    await push(socket, routed(mine.id, { intent: "claude" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    // For the team, on the plan it asked for: its steps at once, the way back to the other AIs on the title's line.
    await push(socket, routed(mine.id, { intent: "chatgpt", autoOpen: true }));
    const plan = screen().getByRole("dialog");
    expect(within(plan).getByRole("region", { name: "Seu plano do ChatGPT" })).toBeTruthy();
    expect(within(plan).getByRole("button", { name: "Voltar" })).toBeTruthy();
    await click(within(plan).getByRole("button", { name: "Fechar" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    await push(socket, routed(mine.id, { intent: "claude", autoOpen: true }));
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("a card: only for who asked, never for `any`, never in a window nobody looks at", async () => {
    const { socket } = await open(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }));
    const created = (id: string, noAi: Record<string, unknown>) =>
      push(socket, { type: "message.created", messageId: id, message: { ...card(noAi), id } });
    await created("c-joao", { forUserId: "u-joao", intent: "api_key", autoOpen: true });
    await created("c-any", { intent: "any", autoOpen: true });
    expect(screen().queryByRole("dialog")).toBeNull();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await created("c-hidden", { intent: "api_key", autoOpen: true });
      expect(screen().queryByRole("dialog")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
    await created("c-mine", { intent: "api_key", autoOpen: true });
    const key = dialog("Conectar uma IA para a Ada") as HTMLElement;
    expect(payWith(key, "Com chave de API").getAttribute("aria-checked")).toBe("true");
  });
});

describe("Tentar de novo under my message an agent couldn't answer", () => {
  const failed = (): Message => ({
    id: "m-failed",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: "@ada resume o canal",
    mentionedAgentIds: [ADA_ID],
    agentRunId: null,
    createdAt: new Date(NOW.getTime() - 1000).toISOString(),
    receipts: {
      seenBy: [ADA_ID],
      pickedBy: [ADA_ID],
      handled: [{ agentId: ADA_ID, runId: "r-failed", status: "failed" }],
      blocked: [],
    },
  });

  test("she answers the same message again: nothing is sent twice", async () => {
    const state = seedState({ aiStatus: aiStatus(true) });
    state.messages.push(failed());
    state.answerNowRuns = [{ agentId: ADA_ID, runId: "r-again" }];
    await open(state);
    const receipt = receiptOf("resume o canal");
    await click(within(receipt).getByRole("button", { name: "Tentar de novo" }));
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-failed"]]);
    expect(calls(state, "chat.post")).toEqual([]);
  });

  test("someone else's message says it failed, without a Tentar de novo they'd be refused", async () => {
    const state = seedState({ aiStatus: aiStatus(true) });
    state.messages.push({ ...failed(), author: { type: "person", id: "u-bia" } });
    await open(state);
    expect(within(receiptOf("resume o canal")).queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });

  test("her computer's error code is said in words, the code only on hover", async () => {
    const { socket } = await open(seedState({ aiStatus: aiStatus(true) }));
    await sendText("@ada e o login?");
    const run = { threadId: null, runId: "r-ada", agentId: ADA_ID };
    await push(socket, { type: "agent.thinking", ...run });
    const failure = { status: "failed", error: "runner_error", errorCode: "run.computer_failed" };
    await push(socket, { type: "agent.run", ...run, status: "failed", error: "runner_error" });
    await push(socket, { type: "run.finished", ...run, ...failure, errorParams: { code: "runner_error" } });
    await settle();
    const line = document.querySelector(".ac-msg__error") as HTMLElement;
    expect(line.textContent).toContain("Ada não conseguiu responder: o computador teve um problema e parou");
    expect(line.textContent).not.toContain("runner_error");
    expect(line.querySelector("[title]")?.getAttribute("title")).toBe("runner_error");
  });

  test("her Claude Code's own failure names it and what it said, never her computer, with nothing more on hover", async () => {
    const { socket } = await open(seedState({ aiStatus: aiStatus(true) }));
    await sendText("@ada e o login?");
    const run = { threadId: null, runId: "r-cli", agentId: ADA_ID };
    await push(socket, { type: "agent.thinking", ...run });
    const failure = {
      status: "failed",
      error: "cli_failed: Claude Code: prompt is too long",
      errorCode: "run.cli_failed",
      errorParams: { brain: "Claude Code", detail: "prompt is too long" },
    };
    await push(socket, { type: "agent.run", ...run, status: "failed", error: failure.error });
    await push(socket, { type: "run.finished", ...run, ...failure });
    await settle();
    const line = document.querySelector(".ac-msg__error") as HTMLElement;
    expect(line.textContent).toContain(
      "Ada não conseguiu responder: o Claude Code parou com um erro: prompt is too long",
    );
    expect(line.textContent).not.toContain("computador");
    expect(line.querySelector("[title]")).toBeNull();
  });

  test("a run that had already done things can't start over: the words go again", async () => {
    const state = seedState({ aiStatus: aiStatus(true) });
    state.messages.push(failed());
    state.answerNowError = new ApiError(409, "run.not_restartable", "already started");
    await open(state);
    await click(within(receiptOf("resume o canal")).getByRole("button", { name: "Tentar de novo" }));
    expect(calls(state, "chat.post").map((c) => (c.args[2] as { body: string }).body)).toEqual(["@ada resume o canal"]);
  });

  test("a voice message that can't start over is never sent again as text: the words say to record it again", async () => {
    const state = seedState({ aiStatus: aiStatus(true) });
    const voice = { clipId: "clip-1", durationMs: 4000, peaks: [] };
    state.messages.push({ ...failed(), body: "resume o canal", meta: { voice } });
    state.answerNowError = new ApiError(409, "run.not_restartable", "already started");
    await open(state);
    await click(within(receiptOf("resume o canal")).getByRole("button", { name: "Tentar de novo" }));
    expect(calls(state, "chat.post")).toEqual([]);
    expect([...document.querySelectorAll(".ac-toast")].at(-1)?.textContent).toContain(
      "Esta resposta já tinha começado, então não dá para recomeçar. Grave a mensagem de novo.",
    );
  });

  test("after the × on her failed line: the cause stays under my message, Tentar de novo says it is trying, and the line moves on once she starts again", async () => {
    const { socket, state, api } = await open(seedState({ aiStatus: aiStatus(true) }));
    await sendText("@ada e o login?");
    const asked = state.messages.at(-1) as Message;
    const failure = { error: "runner_error", errorCode: "run.computer_failed", errorParams: { code: "runner_error" } };
    const fails = async (runId: string) => {
      const run = { threadId: null, runId, agentId: ADA_ID };
      await push(socket, { type: "agent.thinking", ...run });
      await push(socket, { type: "message.claimed", messageId: asked.id, agentId: ADA_ID, runId });
      await push(socket, { type: "agent.run", ...run, status: "failed", ...failure });
      await push(socket, { type: "run.finished", ...run, status: "failed", ...failure });
      await push(socket, {
        type: "message.handled",
        messageId: asked.id,
        agentId: ADA_ID,
        runId,
        status: "failed",
        ...failure,
      });
      await settle(2);
    };
    await fails("r1");
    const reason = "Ada não conseguiu responder: o computador teve um problema e parou";
    const errorLine = () => document.querySelector(".ac-msg__error")?.textContent ?? null;
    expect(errorLine()).toContain(reason);
    // While her line says why, mine doesn't say it twice.
    expect(receiptOf("e o login?").textContent).toBe("Não conseguiu responder·Tentar de novo");

    const row = document.querySelector(".ac-msg__error-row") as HTMLElement;
    await click(within(row).getByRole("button", { name: "Fechar" }));
    expect(errorLine()).toBeNull();
    expect(receiptOf("e o login?").textContent).toBe(`${reason}·Tentar de novo`);

    // Held, to see the click's own feedback while the request is out.
    let answer: (v: { runs: { agentId: string; runId: string }[] }) => void = () => {};
    api.chat.answerNow = (orgId, messageId) => {
      state.calls.push({ method: "chat.answerNow", args: [orgId, messageId] });
      return new Promise((resolve) => {
        answer = resolve;
      });
    };
    await click(within(receiptOf("e o login?")).getByRole("button", { name: "Tentar de novo" }), 2);
    const busy = within(receiptOf("e o login?")).getByRole("button", {
      name: "Tentando de novo…",
    }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.querySelector(".ac-pixspin")).not.toBeNull();

    // What `restartFailedRun` publishes before it answers: the new run claims her message at once.
    await push(socket, { type: "agent.thinking", threadId: null, runId: "r2", agentId: ADA_ID });
    await push(socket, { type: "message.claimed", messageId: asked.id, agentId: ADA_ID, runId: "r2" });
    await act(async () => answer({ runs: [{ agentId: ADA_ID, runId: "r2" }] }));
    await settle(3);
    expect(receiptOf("e o login?").textContent ?? "").not.toContain("Não conseguiu responder");
    expect(receiptOf("e o login?").textContent ?? "").not.toContain("Tentar de novo");
    expect(calls(state, "chat.post").map((c) => (c.args[2] as { body: string }).body)).toEqual(["@ada e o login?"]);

    // It fails again: the line comes back with the button ready.
    await fails("r2");
    expect(errorLine()).toContain(reason);
    expect(within(receiptOf("e o login?")).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  test("Tentar de novo with her failed line still there, clicked twice: one request, and her new run takes the failed one's place", async () => {
    const { socket, state, api } = await open(seedState({ aiStatus: aiStatus(true) }));
    await sendText("@ada e o login?");
    const asked = state.messages.at(-1) as Message;
    const failure = { error: "runner_error", errorCode: "run.computer_failed", errorParams: { code: "runner_error" } };
    const r1 = { threadId: null, runId: "r1", agentId: ADA_ID };
    await push(socket, { type: "agent.thinking", ...r1 });
    await push(socket, { type: "message.claimed", messageId: asked.id, agentId: ADA_ID, runId: "r1" });
    await push(socket, { type: "agent.run", ...r1, status: "failed", ...failure });
    await push(socket, { type: "run.finished", ...r1, status: "failed", ...failure });
    await push(socket, {
      type: "message.handled",
      messageId: asked.id,
      agentId: ADA_ID,
      runId: "r1",
      status: "failed",
    });
    await settle(2);
    expect(document.querySelectorAll(".ac-msg__error-row")).toHaveLength(1);

    let answer: (v: { runs: { agentId: string; runId: string }[] }) => void = () => {};
    api.chat.answerNow = (orgId, messageId) => {
      state.calls.push({ method: "chat.answerNow", args: [orgId, messageId] });
      return new Promise((resolve) => {
        answer = resolve;
      });
    };
    // A double click: both land before the button turns disabled.
    const retry = within(receiptOf("e o login?")).getByRole("button", { name: "Tentar de novo" });
    await act(async () => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await settle(2);
    expect(calls(state, "chat.answerNow")).toHaveLength(1);
    expect(within(receiptOf("e o login?")).getByRole("button", { name: "Tentando de novo…" })).toBeTruthy();

    // The server starts her again: her failed row goes (that run is deleted), her new one shows, my line moves on.
    await push(socket, { type: "agent.thinking", threadId: null, runId: "r2", agentId: ADA_ID });
    await push(socket, { type: "message.claimed", messageId: asked.id, agentId: ADA_ID, runId: "r2" });
    await act(async () => answer({ runs: [{ agentId: ADA_ID, runId: "r2" }] }));
    await settle(3);
    expect(document.querySelector(".ac-msg__error-row")).toBeNull();
    expect(receiptOf("e o login?").textContent ?? "").not.toContain("Tentar de novo");
    expect(calls(state, "chat.answerNow")).toHaveLength(1);
    expect(calls(state, "chat.post")).toHaveLength(1);
  });

  /** The longest name an agent may have (80), and a CLI's reason at its 200 with an address that can't break. */
  const LONG_NAME = "Assistente de Atendimento ao Cliente para Contas Empresariais da América Latina";
  const LONG_DETAIL =
    "Failed to connect to MCP server github: request to https://api.githubcopilot.com/mcp/x/repos/readonly?installation_id=58204931&agent=0b6f2c9e-5d4a-4f7b-9a1e-3c8d2b7f6e10 timed out after 30000 ms";

  /**
   * Ada (the longest name) fails on a CLI's longest reason and her row is closed, so the line under my message says
   * it; Atlas fails on a refused key, his row with its fix and its ×. In German too.
   */
  const worstCase = async (german: boolean) => {
    const seeded = seedState({ aiStatus: aiStatus(true) });
    const ada = seeded.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.name = LONG_NAME;
    const { socket, state, services } = await open(seeded);
    if (german)
      await act(async () => {
        await loadLocale("de", services.i18n);
        await services.i18n.changeLanguage("de");
      });
    const fail = async (agentId: string, runId: string, failure: Record<string, unknown>) => {
      const asked = state.messages.at(-1) as Message;
      const run = { threadId: null, runId, agentId };
      await push(socket, { type: "agent.thinking", ...run });
      await push(socket, { type: "message.claimed", messageId: asked.id, agentId, runId });
      await push(socket, { type: "agent.run", ...run, status: "failed", ...failure });
      await push(socket, { type: "run.finished", ...run, status: "failed", ...failure });
      await push(socket, {
        type: "message.handled",
        messageId: asked.id,
        agentId,
        runId,
        status: "failed",
        ...failure,
      });
      await settle(2);
    };
    await sendText("@ada e o login?");
    await fail(ADA_ID, "r-ada", {
      error: `cli_failed: Claude Code: ${LONG_DETAIL}`,
      errorCode: "run.cli_failed",
      errorParams: { brain: "Claude Code", detail: LONG_DETAIL },
    });
    const row = document.querySelector(".ac-msg__error-row") as HTMLElement;
    // Said whole, never cut: the address too.
    expect(row.textContent).toContain(
      german
        ? `${LONG_NAME} konnte nicht antworten: Das Programm Claude Code wurde mit einem Fehler beendet:`
        : `${LONG_NAME} não conseguiu responder: o Claude Code parou com um erro:`,
    );
    expect(row.textContent).toContain("agent=0b6f2c9e-5d4a-4f7b-9a1e-3c8d2b7f6e10 timed out after 30000 ms");
    await click(within(row).getByRole("button", { name: services.i18n.t("common.close") }));
    // Her row closed: the line under my message says why, in full, with its way out.
    expect(receiptOf("e o login?").textContent).toContain("timed out after 30000 ms");
    expect(
      within(receiptOf("e o login?")).getByRole("button", { name: services.i18n.t("receipts.retry") }),
    ).toBeTruthy();

    await sendText("@atlas e a chave?");
    await fail(ATLAS_ID, "r-atlas", {
      error: "provider_error: invalid_key@Claude: invalid x-api-key",
      errorCode: "run.provider_invalid_key",
      errorParams: { provider: "Claude", detail: "invalid x-api-key" },
    });
    const keyRow = document.querySelector(".ac-msg__error-row") as HTMLElement;
    expect(within(keyRow).getByRole("button", { name: services.i18n.t("noAi.rightHand.useKey") })).toBeTruthy();
  };

  test("worst case: the longest agent name, a CLI's longest reason with an address, a refused key with its fix", () =>
    worstCase(false));

  test("worst case in German: the same, its sentences longer", () => worstCase(true));
});

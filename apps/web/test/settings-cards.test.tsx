import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentAction, AgentProposalCard, Message, Proposal } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  type FakeState,
  LODI_ID,
  meWithRole,
  NOW,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

/** The right hand's cards (ADR 0137): a teammate's settings, a new agent in one click, and "Pedir a um admin". */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const HOUR = 3_600_000;
const DM = `dm-${LODI_ID}`;

/** Lodi's card changing Ada's model and budget, asked for by me (Walter). */
const settingsRow = (over: Partial<Proposal> = {}): Proposal => ({
  id: "set-1",
  agentId: ADA_ID,
  proposedByAgentId: LODI_ID,
  target: { type: "agent_settings", agentId: ADA_ID },
  settings: [
    { field: "model", from: "claude-sonnet-5-5", to: "claude-haiku-5-5" },
    { field: "budget", from: 10_000_000_000, to: 20_000_000_000 },
  ],
  requestedBy: { userId: "u-walter", name: "Walter" },
  askedAt: null,
  undoActionId: null,
  title: "Change Ada's settings",
  why: "A Ada no Haiku, com mais orçamento por mês.",
  evidence: [],
  before: "",
  after: "",
  status: "pending",
  stale: false,
  canDecide: true,
  decider: { type: "admins" },
  createdAt: NOW.toISOString(),
  decidedBy: null,
  decidedAt: null,
  ...over,
});

const lodiMessage = (id: string, meta: Record<string, unknown>, extra: Partial<Message> = {}): Message => ({
  id,
  channelId: DM,
  threadId: null,
  author: { type: "agent", id: LODI_ID },
  body: "",
  mentionedAgentIds: [],
  agentRunId: `r-${id}`,
  meta,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  ...extra,
});

const withCard = (state: FakeState, row: Proposal, extra: Partial<Message> = {}) => {
  withRightHand(state);
  seedDm(state, { type: "agent", id: LODI_ID });
  state.proposals.push(row);
  state.messages.push(
    lodiMessage(
      "m-set",
      { actionCard: { kind: "settings_proposal", forUserId: "u-walter", proposalIds: [row.id] } },
      extra,
    ),
  );
  return state;
};

const agentCard = (over: Partial<AgentProposalCard> = {}): AgentProposalCard => ({
  kind: "agent_proposal",
  forUserId: "u-walter",
  params: {
    draft: {
      name: "Iara",
      handle: "iara",
      role: "Atendimento",
      instructions: "Responde os clientes.",
      appearance: { color: "indigo", eyes: "happy", accessory: "none" },
      channelIds: [],
      access: [],
      ai: { kind: "model" },
    },
    why: "Ela responde sozinha as dúvidas de prazo.",
    firstTask: "Responde o primeiro e-mail da fila.",
  },
  state: "pending",
  agentId: null,
  decidedByUserId: null,
  decidedAt: null,
  expiresAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
  ...over,
});

const withAgentCard = (state: FakeState, card: AgentProposalCard, id = "m-iara") => {
  withRightHand(state);
  seedDm(state, { type: "agent", id: LODI_ID });
  state.messages.push(lodiMessage(id, { bodyCode: "agent_proposal", actionCard: card }));
  return state;
};

const go = async (state: FakeState, path = `dm/agent/${LODI_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = async (el: HTMLElement, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const card = (name: string) => screen().getByRole("group", { name });
const asMember = (state: FakeState) => {
  meWithRole(state, []);
  return state;
};

describe("a teammate's settings, on the right hand's card", () => {
  test("who may decide reads each line then and proposed, and Aplicar applies it as them", async () => {
    const { state } = await go(withCard(seedState(), settingsRow()));
    const c = card("Mudar as configurações da Ada");
    for (const shown of ["Propõe uma mudança", "A Ada no Haiku", "Ada · Configurações", "@ada · Dev"])
      expect(c.textContent).toContain(shown);
    const lines = [...c.querySelectorAll(".rq__setting")].map((l) => [
      l.querySelector("dt")?.textContent,
      l.querySelector("s")?.textContent,
      l.querySelector("b")?.textContent,
    ]);
    expect(lines[0]?.[0]).toBe("Modelo");
    expect(lines[1]?.[0]).toBe("Orçamento mensal");
    expect(lines[1]?.[1]).toContain("10");
    expect(lines[1]?.[2]).toContain("20");
    await click(within(c).getByRole("button", { name: "Aplicar" }));
    expect(state.calls.find((x) => x.method === "proposals.accept")?.args.slice(1, 2)).toEqual(["set-1"]);
    // As the approved card reads it: "Aplicado por você: Ada · modelo … · orçamento mensal US$ 20".
    expect(card("Mudar as configurações da Ada").textContent).toMatch(
      /Aplicado por você: Ada · modelo [^·→]+ · orçamento mensal [^·→]*20/,
    );
  });

  test("Descartar refuses it; once applied, Desfazer on its line undoes it", async () => {
    const receipt: AgentAction = {
      id: "act-1",
      kind: "agent.settings_changed",
      agentId: LODI_ID,
      messageId: "m-set",
      requestedByUserId: "u-walter",
      target: { type: "agent", id: ADA_ID, title: "Ada" },
      params: { proposalId: "set-1", agentName: "Ada", fields: ["model"] },
      createdAt: NOW.toISOString(),
      undoableUntil: new Date(Date.now() + HOUR).toISOString(),
      undoneAt: null,
      undoneByUserId: null,
      redoneAt: null,
    };
    const applied = settingsRow({
      status: "accepted",
      undoActionId: "act-1",
      decidedBy: { userId: "u-walter", name: "Walter" },
      decidedAt: NOW.toISOString(),
      canDecide: false,
    });
    const { state } = await go(withCard(seedState(), applied, { actions: [receipt] }));
    const line = card("Mudar as configurações da Ada");
    // The card says what was applied: no second receipt under it.
    expect(document.querySelectorAll(".ac-receipt").length).toBe(0);
    await click(within(line).getByRole("button", { name: "Desfazer" }));
    expect(state.calls.some((x) => x.method === "actions.undo" && x.args[1] === "act-1")).toBe(true);
    expect(card("Mudar as configurações da Ada").textContent).toContain("Desfeito");
  });

  test("a member who can't decide sends it to an admin, then reads whom it went to", async () => {
    const state = asMember(withCard(seedState(), settingsRow({ canDecide: false })));
    await go(state);
    const c = card("Mudar as configurações da Ada");
    expect(c.textContent).toContain("Só admins fazem essas mudanças");
    expect(within(c).queryByRole("button", { name: "Aplicar" })).toBeNull();
    await click(within(c).getByRole("button", { name: "Pedir a um admin" }));
    expect(state.calls.some((x) => x.method === "proposals.ask" && x.args[1] === "set-1")).toBe(true);
    const sent = card("Mudar as configurações da Ada");
    expect(sent.textContent).toContain("Aguardando um admin");
    expect(sent.textContent).toContain("Enviado para João");
  });

  test("an agent asking for its own skill: the same card, on itself, sent on by a member who can't decide", async () => {
    const state = asMember(seedState());
    const dm = seedDm(state, { type: "agent", id: ADA_ID });
    const row = settingsRow({
      proposedByAgentId: ADA_ID,
      canDecide: false,
      settings: [{ field: "skill", skillId: "s-excel", from: false, to: true, label: { to: "excel" } }],
      why: "Preciso da skill excel para ler a planilha.",
    });
    state.proposals.push(row);
    state.messages.push({
      ...lodiMessage("m-own", {
        actionCard: { kind: "settings_proposal", forUserId: "u-walter", proposalIds: [row.id] },
      }),
      channelId: dm,
      author: { type: "agent", id: ADA_ID },
    });
    await go(state, `dm/agent/${ADA_ID}`);
    const c = card("Mudar as configurações da Ada");
    for (const shown of [
      "Propõe uma mudança",
      "Preciso da skill excel",
      "Ada · Configurações",
      "Só admins mudam as skills de um agente",
    ])
      expect(c.textContent).toContain(shown);
    const lines = [...c.querySelectorAll(".rq__setting")].map((l) =>
      [l.querySelector("dt"), l.querySelector("s"), l.querySelector("b")].map((x) => x?.textContent),
    );
    expect(lines).toEqual([["Skill excel", "Desligada", "Ligada"]]);
    expect(within(c).queryByRole("button", { name: "Aplicar" })).toBeNull();
    await click(within(c).getByRole("button", { name: "Pedir a um admin" }));
    expect(state.calls.some((x) => x.method === "proposals.ask" && x.args[1] === "set-1")).toBe(true);
  });

  test("one line about the model says only admins change it", async () => {
    const row = settingsRow({
      canDecide: false,
      settings: [{ field: "model", from: "claude-sonnet-5-5", to: "claude-haiku-5-5" }],
    });
    await go(asMember(withCard(seedState(), row)));
    expect(card("Mudar as configurações da Ada").textContent).toContain("Só admins mudam o modelo de um agente");
  });

  test("out of date: nothing to apply, and Refazer asks the right hand again", async () => {
    const { state } = await go(withCard(seedState(), settingsRow({ stale: true })));
    const c = card("Mudar as configurações da Ada");
    expect(c.textContent).toContain("Desatualizado");
    expect(c.textContent).toContain("A Ada mudou depois deste card. Nada foi aplicado.");
    expect(within(c).queryByRole("button", { name: "Aplicar" })).toBeNull();
    await click(within(c).getByRole("button", { name: "Refazer" }));
    const sent = state.messages.filter((m) => m.channelId === DM && m.author.type === "person").at(-1);
    expect(sent?.body).toBe("Refaz o card da Ada com os valores de agora");
  });

  test("in the inbox of whoever decides, the same card with Aplicar and Recusar", async () => {
    const state = withCard(seedState(), settingsRow({ requestedBy: { userId: "u-joao", name: "João" } }));
    state.notifications = [
      notification({
        id: "n-ask",
        kind: "change_request",
        waiting: true,
        actors: [{ type: "user", id: "u-joao" }],
        source: { proposalId: "set-1", agentId: LODI_ID, label: "Ada" },
        latest: { text: "A Ada no Haiku" },
      }),
    ];
    await go(state, "notifications");
    const row = document.querySelector('[data-n="n-ask"]') as HTMLElement;
    expect(row.querySelector(".nt-what")?.textContent).toBe("João pede uma mudança em Ada");
    const c = within(row).getByRole("group", { name: "Mudar as configurações da Ada" });
    expect(within(c).getByRole("button", { name: "Aplicar" })).toBeTruthy();
    await click(within(c).getByRole("button", { name: "Recusar" }));
    expect(state.calls.some((x) => x.method === "proposals.refuse" && x.args[1] === "set-1")).toBe(true);
  });
});

/** A removal card (`propose_remove_agents`): one row per agent, each archiving it. */
const withRemoval = (state: FakeState, over: Partial<Proposal> = {}, extra: Partial<Message> = {}) => {
  withRightHand(state);
  seedDm(state, { type: "agent", id: LODI_ID });
  const rows = [ADA_ID, ATLAS_ID].map((agentId, i) =>
    settingsRow({
      id: `rm-${i}`,
      agentId,
      target: { type: "agent_settings", agentId },
      settings: [{ field: "archive", from: false, to: true }],
      why: "Vamos recomeçar o time do zero.",
      ...over,
    }),
  );
  state.proposals.push(...rows);
  state.messages.push(
    lodiMessage(
      "m-rm",
      { actionCard: { kind: "settings_proposal", forUserId: "u-walter", proposalIds: rows.map((r) => r.id) } },
      extra,
    ),
  );
  return state;
};

describe("archiving several agents, on one card", () => {
  test("lists them all, Arquivar todos, and a switch leaves one out", async () => {
    const { state } = await go(withRemoval(seedState()));
    const c = card("Arquivar 2 agentes?");
    for (const shown of ["Vamos recomeçar o time do zero.", "Ada", "Atlas", "@ada"])
      expect(c.textContent).toContain(shown);
    expect(within(c).getByRole("button", { name: "Arquivar todos" })).toBeTruthy();
    await click(within(c).getByRole("switch", { name: "Incluir Atlas" }));
    await click(within(card("Arquivar 2 agentes?")).getByRole("button", { name: "Arquivar 1" }));
    const accepted = state.calls.filter((x) => x.method === "proposals.accept").map((x) => x.args[1]);
    expect(accepted).toEqual(["rm-0"]);
  });

  test("deleting for good asks for how many, typed, before any row is decided", async () => {
    const { state } = await go(withRemoval(seedState(), { settings: [{ field: "delete", from: false, to: true }] }));
    await click(within(card("Apagar 2 agentes para sempre?")).getByRole("button", { name: "Apagar todos" }));
    expect(state.calls.some((x) => x.method === "proposals.accept")).toBe(false);
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain("Ada, Atlas");
    const confirm = within(dialog).getByRole("button", { name: "Apagar" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Digite 2 para confirmar"), { target: { value: "2" } });
    });
    await click(confirm);
    const accepted = state.calls.filter((x) => x.method === "proposals.accept").map((x) => x.args[1]);
    expect(accepted).toEqual(["rm-0", "rm-1"]);
  });

  test("a member who can't archive sends every row to an admin", async () => {
    const state = asMember(withRemoval(seedState(), { canDecide: false }));
    await go(state);
    const c = card("Arquivar 2 agentes?");
    expect(c.textContent).toContain("Só admins arquivam um agente");
    expect(within(c).queryByRole("button", { name: "Arquivar todos" })).toBeNull();
    await click(within(c).getByRole("button", { name: "Pedir a um admin" }));
    const asked = state.calls.filter((x) => x.method === "proposals.ask").map((x) => x.args[1]);
    expect(asked).toEqual(["rm-0", "rm-1"]);
    expect(card("Arquivar 2 agentes?").textContent).toContain("Enviado para");
  });

  test("archived: who did it, and Desfazer brings them all back", async () => {
    const receipt = (id: string, agentId: string, name: string): AgentAction => ({
      id,
      kind: "agent.settings_changed",
      agentId: LODI_ID,
      messageId: "m-rm",
      requestedByUserId: "u-walter",
      target: { type: "agent", id: agentId, title: name },
      params: { proposalId: id, agentName: name, fields: ["archive"] },
      createdAt: NOW.toISOString(),
      undoableUntil: new Date(Date.now() + HOUR).toISOString(),
      undoneAt: null,
      undoneByUserId: null,
      redoneAt: null,
    });
    const state = withRemoval(
      seedState(),
      {
        status: "accepted",
        canDecide: false,
        decidedBy: { userId: "u-walter", name: "Walter" },
        decidedAt: NOW.toISOString(),
      },
      { actions: [receipt("act-a", ADA_ID, "Ada"), receipt("act-b", ATLAS_ID, "Atlas")] },
    );
    for (const p of state.proposals) if (p.id.startsWith("rm-")) p.undoActionId = p.id === "rm-0" ? "act-a" : "act-b";
    await go(state);
    const c = card("Arquivar 2 agentes?");
    expect(c.textContent).toContain("Aplicado por você: Ada, Atlas");
    await click(within(c).getByRole("button", { name: "Desfazer" }));
    expect(state.calls.some((x) => x.method === "actions.undoMessage" && x.args[1] === "m-rm")).toBe(true);
  });
});

describe("a new agent, on the right hand's card", () => {
  test("Criar e testar creates it and opens its DM with the first task in the composer, unsent; Editar antes and Descartar beside it", async () => {
    const { state, router } = await go(withAgentCard(seedState(), agentCard()));
    const c = card("Lodi propõe um novo agente");
    expect(within(c).getByRole("button", { name: "Editar antes" })).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Descartar" })).toBeTruthy();
    await click(within(c).getByRole("button", { name: "Criar e testar" }), 10);
    expect(state.calls.find((x) => x.method === "agents.createProposed")?.args.slice(1)).toEqual([
      "m-iara",
      { test: true },
    ]);
    const made = state.agents.find((a) => a.handle === "iara");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${made?.id}`);
    const box = screen().getByRole("combobox", { name: "Mensagem para Iara" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Responde o primeiro e-mail da fila.");
    expect(state.calls.some((x) => x.method === "chat.post")).toBe(false);
  });

  test("someone it wasn't written for (an admin, from the inbox) gets the plain Criar", async () => {
    await go(withAgentCard(seedState(), agentCard({ forUserId: "u-joao" })));
    const c = card("Lodi propõe um novo agente");
    expect(within(c).queryByRole("button", { name: "Criar e testar" })).toBeNull();
    expect(within(c).getByRole("button", { name: "Criar Iara" })).toBeTruthy();
  });

  test("without a first task it reads Criar; replaced by a newer card, it stays greyed with nothing to do", async () => {
    const state = withAgentCard(
      seedState(),
      agentCard({ params: { ...agentCard().params, firstTask: undefined } }),
      "m-new",
    );
    state.messages.unshift(lodiMessage("m-old", { actionCard: agentCard({ state: "superseded" }) }));
    await go(state);
    const older = document.querySelector<HTMLElement>('[data-ask-id="m-old"]');
    const newer = document.querySelector<HTMLElement>('[data-ask-id="m-new"]');
    expect(older?.classList.contains("rq--muted")).toBe(true);
    expect(older?.textContent).toContain("Trocada pela proposta mais nova");
    expect(within(older as HTMLElement).queryAllByRole("button").length).toBe(0);
    expect(within(newer as HTMLElement).getByRole("button", { name: "Criar Iara" })).toBeTruthy();
  });

  test("a member who can't create agents asks an admin, then reads whom it went to", async () => {
    const state = asMember(withAgentCard(seedState(), agentCard()));
    await go(state);
    const c = card("Lodi propõe um novo agente");
    expect(c.textContent).toContain("Só admins criam agentes");
    expect(within(c).queryByRole("button", { name: "Criar e testar" })).toBeNull();
    await click(within(c).getByRole("button", { name: "Pedir a um admin" }));
    expect(state.calls.some((x) => x.method === "agents.askProposal" && x.args[1] === "m-iara")).toBe(true);
    expect(card("Lodi propõe um novo agente").textContent).toContain("Enviado para João");
  });
});

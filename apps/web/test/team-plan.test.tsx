import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { TeamProposalCard } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  createFakeApi,
  ENG_ID,
  type FakeState,
  fakeMachinesOf,
  LODI_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The right hand's team setup on the web (ADR 0137 §10): answers to tap, the team card, the templates. */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const button = (name: string | RegExp) => screen().getByRole("button", { name });
const click = async (el: Element, rounds = 8) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);

const routine = (name: string) => ({
  name,
  prompt: name,
  schedule: "0 9 * * *",
  rule: null,
  cron: "0 9 * * *",
  timezone: "America/Sao_Paulo",
  description: "Every day at 09:00",
  report: "when_new" as const,
  access: "read" as const,
});

const CARD: TeamProposalCard = {
  kind: "team_proposal",
  forUserId: "u-walter",
  params: {
    lead: "3 agentes para a Acme, cada um no seu canal.",
    agents: [
      {
        name: "Iara",
        handle: "iara",
        role: "Atendimento",
        line: "Responde os clientes no WhatsApp e no e-mail.",
        instructions: "Atendimento",
        appearance: { color: "rose", eyes: "happy", accessory: "flower" },
        channel: "atendimento",
        routines: [routine("Resumo do dia")],
        firstTask: "Responder a última mensagem que espera",
      },
      {
        name: "Ada",
        handle: "ada2",
        role: "Dev",
        line: "Corrige os bugs.",
        instructions: "Dev",
        appearance: null,
        channel: "eng",
        routines: [],
        firstTask: "Olhar o último bug",
      },
    ],
    newChannels: ["atendimento"],
    skills: [{ name: "tom-de-voz", title: "Tom de voz", description: "como a Acme fala", body: "", agents: ["iara"] }],
    weekly: routine("A semana do time"),
    approvals: "As respostas da Iara esperam a sua aprovação.",
    invite: ["Bruno"],
  },
  state: "pending",
  decidedByUserId: null,
  decidedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

/** Lodi's DM with a team card (and a question with answers to tap, when `chips`). */
function lodiDm(chips = false) {
  const state = withRightHand(seedState({ agents: [] }));
  state.members = state.members.slice(0, 1);
  const channelId = seedDm(state, { type: "agent", id: LODI_ID }, { ago: 10, body: "Oi" });
  const base = { channelId, threadId: null, author: { type: "agent" as const, id: LODI_ID }, mentionedAgentIds: [] };
  if (chips) {
    state.messages.push({
      ...base,
      id: "m-question",
      body: "**O que mais toma o seu tempo hoje?**",
      agentRunId: null,
      meta: {
        replyChips: {
          choices: ["Responder clientes", "Cobrar quem atrasou", "Corrigir bugs"],
          multiple: true,
          step: 2,
          of: 3,
        },
      },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
  } else {
    state.messages.push({
      ...base,
      id: "m-team",
      body: "Proposed a team: Iara, Ada.",
      agentRunId: null,
      meta: { bodyCode: "team_proposal", bodyParams: { names: "Iara, Ada" }, actionCard: structuredClone(CARD) },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
  }
  return state;
}

const openDm = async (state: FakeState) => {
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(10);
  return r;
};
const teamCard = () => screen().getByRole("group", { name: "Propõe um time" });

describe("answers to tap", () => {
  test("several picked go as one message, in the order listed; Pergunta 2 de 3", async () => {
    const state = lodiDm(true);
    await openDm(state);
    expect(document.body.textContent).toContain("Pergunta 2 de 3");
    await click(button("Corrigir bugs"), 2);
    await click(button("Responder clientes"), 2);
    await click(button("Enviar 2"), 10);
    expect(calls(state, "chat.post").map((c) => (c.args[2] as { body: string }).body)).toEqual([
      "Responder clientes · Corrigir bugs",
    ]);
    // Answered: what was picked stays checked, nothing more to tap.
    const picked = button("Corrigir bugs") as HTMLButtonElement;
    expect(picked.getAttribute("aria-pressed")).toBe("true");
    expect(picked.disabled).toBe(true);
    expect(screen().queryByRole("button", { name: /^Enviar [0-9]/ })).toBeNull();
  });
});

describe("the team card", () => {
  test("each agent with its channel (new ones marked), the routines, the skills and what waits", async () => {
    await openDm(lodiDm());
    const card = teamCard();
    expect(card.hasAttribute("data-ask-mine")).toBe(true);
    expect(card.textContent).toContain("3 agentes para a Acme, cada um no seu canal.");
    expect(card.textContent).toContain("Responde os clientes no WhatsApp e no e-mail.");
    expect(card.textContent).toContain("atendimentonovo");
    expect(card.textContent).toContain("Tom de voz · como a Acme fala");
    expect(card.textContent).toContain("As respostas da Iara esperam a sua aprovação.");
    expect(card.textContent).toContain("eu conto aqui como foi a semana do time");
    expect(card.textContent).toContain("2 agentes · 1 canal novo · 2 rotinas");
    for (const name of ["Criar o time", "Ver como mapa", "Descartar", "Ajustar Iara", "Ajustar Ada"])
      expect(within(card).getByRole("button", { name })).toBeTruthy();
    // Each agent a MediaRow: the face, the name and the role on one line, its channel and Ajustar at that line's end
    // (under the words in a narrow card), what it does under them at the row's width.
    const iara = within(card).getByRole("button", { name: "Ajustar Iara" }).closest(".tp-agent") as HTMLElement;
    expect(iara.classList.contains("ac-mediarow")).toBe(true);
    expect(iara.querySelector(":scope > .ac-mediarow__head > b")?.textContent).toBe("Iara");
    expect(iara.querySelector(":scope > .ac-mediarow__end--wrap .tp-pill")).toBeTruthy();
    expect(iara.querySelector(":scope > .ac-mediarow__body > .tp-agent__line")?.textContent).toBe(
      "Responde os clientes no WhatsApp e no e-mail.",
    );
  });

  test("Criar o time makes it in one click; the receipt has Desfazer and a first task per agent", async () => {
    const state = lodiDm();
    // Lodi's checklist above it, its asks out once the team can think.
    const lodi = state.agents.find((a) => a.id === LODI_ID);
    if (lodi) lodi.setup = { role: null, done: ["apps"] };
    const { router } = await openDm(state);
    await click(button("Criar o time"), 12);
    expect(calls(state, "agents.createTeam").map((c) => c.args[1])).toEqual(["m-team"]);
    expect(document.body.textContent).toContain("Time criado por você");
    expect(button("Desfazer")).toBeTruthy();
    const first = screen().getByRole("group", { name: "Primeira tarefa" });
    // One offer of a first task, this card's: the checklist's asks above it offer none.
    expect(screen().getByText("Agora me peça algo:")).toBeTruthy();
    expect(screen().queryByRole("button", { name: /Dar a primeira tarefa/ })).toBeNull();
    expect(first.textContent).toContain("Responder a última mensagem que espera");
    // The task under the name at the row's full width, its button at the name's line's end or under the task.
    const task = first.querySelector(".tp-agent.ac-mediarow") as HTMLElement;
    expect(task.querySelector(":scope > .ac-mediarow__body")?.textContent).toBe(
      "Responder a última mensagem que espera",
    );
    expect(task.querySelector(":scope > .ac-mediarow__end--wrap .ac-btn")?.textContent).toBe("Abrir com a tarefa");
    expect(within(first).getByRole("button", { name: "Convidar Bruno" })).toBeTruthy();
    const iara = state.agents.find((a) => a.name === "Iara");
    await click(within(first).getAllByRole("button", { name: "Abrir com a tarefa" })[0] as HTMLElement, 12);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${iara?.id}`);
    const box = screen().getByRole("combobox", { name: "Mensagem para Iara" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Responder a última mensagem que espera ");
    // Typed, never sent.
    expect(calls(state, "chat.post")).toEqual([]);
  });

  test("while the team is being made, Ajustar and Descartar are off and Ver como mapa stays to read", async () => {
    const state = lodiDm();
    const message = state.messages.find((m) => m.id === "m-team");
    (message?.meta?.actionCard as TeamProposalCard).state = "creating";
    await openDm(state);
    expect((button("Ajustar Iara") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Descartar") as HTMLButtonElement).disabled).toBe(true);
    const map = button("Ver como mapa") as HTMLButtonElement;
    expect(map.disabled || map.closest("fieldset[disabled]") !== null).toBe(false);
  });

  test("Ajustar edits one agent's draft on the card", async () => {
    const state = lodiDm();
    await openDm(state);
    await click(button("Ajustar Iara"), 4);
    const dialog = screen().getByRole("dialog");
    await act(async () => fireEvent.change(within(dialog).getByLabelText("Canal"), { target: { value: "suporte" } }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }), 8);
    expect(calls(state, "agents.adjustTeamAgent")[0]?.args.slice(1, 3)).toEqual(["m-team", "iara"]);
    expect((calls(state, "agents.adjustTeamAgent")[0]?.args[3] as { channel: string } | undefined)?.channel).toBe(
      "suporte",
    );
    expect(teamCard().textContent).toContain("suporte");
  });

  test("Ver como mapa: a column per channel, the people on top, Lodi as the weekly reviewer", async () => {
    await openDm(lodiDm());
    await click(button("Ver como mapa"), 4);
    const dialog = screen().getByRole("dialog", { name: "O time como mapa" });
    expect(within(dialog).getByRole("region", { name: "#atendimento" }).textContent).toContain("Iara");
    expect(within(dialog).getByRole("region", { name: "#eng" }).textContent).toContain("Ada");
    expect(dialog.textContent).toContain("Bruno");
    expect(dialog.textContent).toContain("Lodi revisa a semana do time");
  });
});

describe("team templates", () => {
  test("the kept card's Ver modelos de time lists them with a preview; Criar o time makes it at once", async () => {
    const state = withRightHand(seedState({ agents: [] }), { setup: { role: null, done: [] } });
    state.members = state.members.slice(0, 1);
    if (state.me)
      state.me.organizations = state.me.organizations.map((o) => ({
        ...o,
        standing: { state: "hold" as const, reason: "payment" },
      }));
    state.aiStatus = { any: false, agents: [{ agentId: LODI_ID, state: "no_ai", reason: "no_key" }] };
    state.teamTemplates = [
      {
        id: "software",
        name: "Software e apps",
        sub: "Atendimento, cobrança e código",
        description: "Para quem vende um sistema.",
        team: CARD.params,
      },
      {
        id: "clinic",
        name: "Clínica ou consultório",
        sub: "Agenda e retorno",
        description: "Para clínicas.",
        team: { ...CARD.params, agents: [CARD.params.agents[0] as never] },
      },
    ];
    state.messages.push({
      id: "m-kept",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: LODI_ID },
      body: "I kept your message.",
      mentionedAgentIds: [],
      agentRunId: "r-kept",
      meta: {
        bodyCode: "no_ai",
        noAi: { agentId: LODI_ID, forUserId: "u-walter", reason: "plan_hold", intent: "task", runId: "r" },
      },
      createdAt: new Date().toISOString(),
    });
    const api = createFakeApi(state);
    // agentes.chat Cloud, where each workspace's own computer waits for the plan: only there is a hold.
    fakeMachinesOf.get(api)?.setSetup({ state: null });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    await click(button("Ver modelos de time"), 10);
    const dialog = screen().getByRole("dialog", { name: "Modelos de time" });
    expect(dialog.textContent).toContain("Para quem vende um sistema.");
    expect(dialog.textContent).toContain("Responde os clientes no WhatsApp e no e-mail.");
    await click(within(dialog).getByRole("button", { name: /Clínica ou consultório/ }), 4);
    expect(dialog.textContent).toContain("Para clínicas.");
    // The other ways in, under the list.
    for (const name of ["Trazer agentes de outro app", "Criar um agente do zero"])
      expect(within(dialog).getByRole("button", { name }).className).toBe("ac-link");
    await click(within(dialog).getByRole("button", { name: "Criar o time" }), 12);
    expect(calls(state, "agents.applyTeamTemplate").map((c) => c.args[1])).toEqual(["clinic"]);
    expect(screen().queryByRole("dialog", { name: "Modelos de time" })).toBeNull();
  });
});

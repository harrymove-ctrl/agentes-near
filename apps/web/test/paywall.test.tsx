import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus, Message, OrgStanding, TeamProposalCard } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { setDraftFor } from "@agenteschat/client/lib/drafts";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  createFakeApi,
  ENG_ID,
  fakeMachinesOf,
  LODI_ID,
  NOW,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

type State = ReturnType<typeof seedState>;

const KEPT = "Guardei a sua mensagem.";
const PLANS = "Ver planos do agentes.chat";
const HOLD: OrgStanding = { state: "hold", reason: "payment" };
const BILLING = "https://billing.example.com";

const noAi = (id: string): AiStatus => ({ any: false, agents: [{ agentId: id, state: "no_ai", reason: "no_key" }] });
const ready = (id: string): AiStatus => ({ any: true, agents: [{ agentId: id, state: "ready" }] });

const held = (state: State, standing: OrgStanding | null = HOLD, role?: "member") => {
  const me = state.me;
  if (me)
    me.organizations = me.organizations.map((o) => ({
      ...o,
      ...(role ? { role } : {}),
      ...(standing ? { standing } : {}),
    }));
  return state;
};

const wall = (agentId = ADA_ID, channelId = ENG_ID): Message => ({
  id: "m-kept",
  channelId,
  threadId: null,
  author: { type: "agent", id: agentId },
  body: "I kept your message.",
  mentionedAgentIds: [],
  agentRunId: "r-kept",
  meta: {
    bodyCode: "no_ai",
    noAi: { agentId, forUserId: "u-walter", reason: "plan_hold", intent: "task", runId: "r" },
  },
  createdAt: NOW.toISOString(),
});

async function open(state: State, path = `c/${ENG_ID}`) {
  const api = createFakeApi(state);
  fakeMachinesOf.get(api)?.setSetup({ state: null });
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { api, state, socket };
}
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const card = () => document.querySelector(":is(.rq-open, .rq-done)") as HTMLElement;
const calls = (state: State, method: string) => state.calls.filter((c) => c.method === method);

describe("the wall", () => {
  test("whoever pays: kept, what the plan brings, one button, and no key or Connect anywhere near it", async () => {
    const state = held(seedState({ aiStatus: noAi(ADA_ID), authConfig: { billingUrl: BILLING } }));
    state.messages.push(wall());
    await open(state);
    expect(card().textContent).toContain(KEPT);
    expect(card().textContent).toContain("Eu respondo aqui quando o workspace tiver um plano do agentes.chat");
    expect(card().textContent).toContain("A IA é a que você já paga");
    expect(within(card()).getByRole("button", { name: PLANS })).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Conectar" })).toBeNull();
    expect(document.querySelector(".noai-banner")).toBeNull();
  });

  test("a key saved before reads as ready and changes nothing: no answer starts, the wall stays", async () => {
    const state = held(seedState({ aiStatus: ready(ADA_ID) }));
    state.messages.push(wall());
    await open(state);
    expect(card().textContent).toContain(KEPT);
    expect(calls(state, "chat.answerNow")).toHaveLength(0);
  });

  test("a member reads who can sort it out, with no button", async () => {
    const state = held(seedState({ aiStatus: noAi(ADA_ID) }), HOLD, "member");
    state.messages.push(wall());
    await open(state);
    expect(card().textContent).toContain("Quem administra o workspace pode resolver isso.");
    expect(within(card()).queryByRole("button")).toBeNull();
  });

  test("an older no-AI card on a hold is the wall too: its Connect would lead nowhere", async () => {
    const state = held(seedState({ aiStatus: noAi(ADA_ID) }));
    const old = wall();
    old.meta = { bodyCode: "no_ai", noAi: { agentId: ADA_ID, forUserId: null, reason: "no_key", intent: "task" } };
    state.messages.push(old);
    await open(state);
    expect(card().textContent).toContain(KEPT);
  });

  test("the right hand with no team also offers the templates", async () => {
    const state = withRightHand(held(seedState({ aiStatus: noAi(LODI_ID) })));
    state.agents = state.agents.filter((a) => a.id === LODI_ID);
    state.messages.push(wall(LODI_ID));
    await open(state);
    expect(within(card()).getByRole("button", { name: "Ver modelos de time" })).toBeTruthy();
  });
});

describe("after the plan", () => {
  test("hold lifted, no AI: the card says so and Connect is for the whole team", async () => {
    const state = seedState({ aiStatus: noAi(ADA_ID) });
    state.messages.push(wall());
    await open(state);
    expect(card().textContent).toContain("Plano ativo. Conecte uma IA e Ada responde aqui.");
    await click(within(card()).getByRole("button", { name: "Conectar" }));
    expect(screen().getByRole("dialog", { name: /Conectar uma IA/ })).toBeTruthy();
  });

  test("an AI connected from anywhere: opening the conversation starts the answer, once, with no click", async () => {
    const state = seedState({ aiStatus: ready(ADA_ID) });
    state.messages.push(wall());
    await open(state);
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-kept"]]);
    expect(card().textContent).toContain("Ada está respondendo…");
  });

  test("a start that was refused never reads as answering: the button is there", async () => {
    const state = seedState({ aiStatus: ready(ADA_ID) });
    state.answerNowError = new ApiError(403, "No", "forbidden");
    state.messages.push(wall());
    await open(state);
    expect(card().textContent).not.toContain("Ada está respondendo…");
    expect(within(card()).getByRole("button", { name: "Responder agora" })).toBeTruthy();
  });

  test("someone else's kept message promises nothing and starts nothing", async () => {
    const state = held(seedState({ aiStatus: ready(ADA_ID) }), null, "member");
    state.messages.push({
      ...wall(),
      meta: {
        bodyCode: "no_ai",
        noAi: { agentId: ADA_ID, forUserId: "u-other", reason: "plan_hold", intent: "task", runId: "r" },
      },
    });
    await open(state);
    expect(calls(state, "chat.answerNow")).toHaveLength(0);
    expect(card().textContent).not.toContain("Ada está respondendo…");
  });

  const keptHere = (author: string): Message => ({
    id: "m-mine",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: author },
    body: "alguém aí?",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {},
    createdAt: NOW.toISOString(),
    receipts: { seenBy: [], pickedBy: [], handled: [], blocked: [], noAi: true, kept: true },
  });

  test("a channel message kept on the hold: its author opening the conversation routes it, once", async () => {
    const state = seedState({ aiStatus: ready(ADA_ID) });
    state.messages.push(keptHere("u-walter"));
    await open(state);
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-mine"]]);
  });

  test("that start refused, the line promises nothing and the button stays", async () => {
    const state = seedState({ aiStatus: ready(ADA_ID) });
    state.answerNowError = new ApiError(403, "No", "forbidden");
    state.messages.push(keptHere("u-walter"));
    await open(state);
    expect(document.body.textContent).not.toContain("Escolhendo quem responde");
    expect(screen().getByRole("button", { name: "Responder agora" })).toBeTruthy();
  });

  test("anyone else's, or with no AI yet, stays the line with Conectar", async () => {
    const other = seedState({ aiStatus: ready(ADA_ID) });
    other.messages.push(keptHere("u-other"));
    await open(other);
    expect(calls(other, "chat.answerNow")).toHaveLength(0);
    cleanup();
    sessionStorage.clear();
    const none = seedState({ aiStatus: noAi(ADA_ID) });
    none.messages.push(keptHere("u-walter"));
    await open(none);
    expect(calls(none, "chat.answerNow")).toHaveLength(0);
  });

  test("already answered: nothing starts again", async () => {
    const state = seedState({ aiStatus: ready(ADA_ID) });
    const later = {
      ...wall(),
      id: "m-reply",
      meta: {},
      body: "Done.",
      createdAt: new Date(NOW.getTime() + 1000).toISOString(),
    };
    state.messages.push(wall(), later);
    await open(state);
    expect(calls(state, "chat.answerNow")).toHaveLength(0);
  });
});

describe("what stays out of reach on a hold", () => {
  test("a saved key can't be changed, only removed", async () => {
    await open(held(seedState()), "settings/keys");
    expect(screen().queryByRole("button", { name: "Trocar a chave" })).toBeNull();
    expect(screen().getByRole("button", { name: "Apagar" })).toBeTruthy();
    expect(document.body.textContent).toContain("As chaves de API abrem com o plano do agentes.chat");
  });

  test("Membros offers no invitation link that would open on a refusal", async () => {
    await open(held(seedState()), "members");
    expect(screen().queryByRole("button", { name: "Copiar link de convite" })).toBeNull();
  });

  test("an agent's page says neither Sem IA nor Conectar", async () => {
    await open(held(seedState({ aiStatus: noAi(ADA_ID) })), `agents/${ADA_ID}`);
    expect(document.body.textContent).not.toContain("Sem IA");
  });
});

test("a first task opens with the caret at its blank, in the box", async () => {
  setDraftFor(`agent:${ADA_ID}`, "Escreva uma resposta para esta mensagem de cliente: ");
  await open(held(seedState()), `dm/agent/${ADA_ID}`);
  const box = screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
  expect(document.activeElement).toBe(box);
  expect(box.selectionStart).toBe(box.value.length);
  expect(box.value.endsWith(": ")).toBe(true);
  // Until the person types, a line over the box says what the blank is for.
  expect(screen().getByRole("note").textContent).toBe("Complete a frase e envie");
  await act(async () => fireEvent.change(box, { target: { value: `${box.value}Oi, Marina` } }));
  await settle(2);
  expect(screen().queryByRole("note")).toBeNull();
});

describe("Lodi's DM on a hold", () => {
  const dm = `dm/agent/${LODI_ID}`;
  const lodi = (aiStatus: AiStatus = noAi(LODI_ID)) => {
    const state = held(seedState({ aiStatus, authConfig: { billingUrl: BILLING } }));
    withRightHand(state, { setup: { role: null, done: [] } });
    state.agents = state.agents.filter((a) => a.id === LODI_ID);
    state.members = state.members.slice(0, 1);
    state.connections = [];
    return state;
  };
  const row = (text: string) =>
    [...document.querySelectorAll(".setup-row")].find((r) => r.textContent?.includes(text)) as HTMLElement;
  const heads = () =>
    [...document.querySelectorAll(".setup-row")].map((r) => r.querySelector(".ac-mediarow__head")?.textContent);
  const count = () => document.querySelector(".setup-cl__head small")?.textContent;

  test("its lead says the plan up front, the checklist shows, and neither Connect nor the style card", async () => {
    await open(lodi(), dm);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Escolha o que a sua empresa faz e o time aparece aqui.");
    expect(text).toContain("Para o time da Acme começar a trabalhar");
    expect(text).not.toContain("Conecte uma IA para o time");
    expect(text).not.toContain("Como prefere que eu fale com você?");
  });

  test("with a team on a hold, its lead says what it does, not how the team comes", async () => {
    await open(withRightHand(held(seedState()), { setup: { role: null, done: [] } }), dm);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Escolha o que a sua empresa faz");
    expect(text).toContain("Crio os agentes, conecto os apps e convido as pessoas.");
  });

  test("the plan leads with the card's one button, the AI row is next, the rest wait; no asks (ADR 0162)", async () => {
    await open(lodi(), dm);
    expect(heads()).toEqual([
      "Ligue o time.",
      "Conecte uma IA.",
      "Conecte os apps do trabalho.",
      "Chame quem trabalha com você.",
    ]);
    expect(count()).toBe("0 de 4");
    const plan = row("Ligue o time.");
    expect(plan.textContent).toContain("Com um plano do agentes.chat, os agentes começam a trabalhar.");
    expect(row("Conecte uma IA.").textContent).toContain("É o passo seguinte ao plano.");
    for (const waits of ["Conecte os apps do trabalho.", "Chame quem trabalha com você."])
      expect(row(waits).textContent).toContain("Abre com o plano.");
    const buttons = [...(document.querySelector(".setup-cl")?.querySelectorAll("button") ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual(["Ver planos"]);
    expect(within(plan).getByRole("button", { name: "Ver planos" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("Agora me peça algo:");
  });

  test("a saved key on a hold reads as ready, and still the AI row waits for the plan", async () => {
    await open(lodi({ any: true, agents: [{ agentId: LODI_ID, state: "ready" }] }), dm);
    expect(row("Conecte uma IA.").textContent).toContain("É o passo seguinte ao plano.");
    expect(count()).toBe("0 de 4");
  });

  test("with a team, the banner leaves Lodi's DM to the card's plan row and stays everywhere else", async () => {
    const team = () =>
      withRightHand(held(seedState({ authConfig: { billingUrl: BILLING } })), { setup: { role: null, done: [] } });
    await open(team(), dm);
    expect(within(row("Ligue o time.")).getByRole("button", { name: "Ver planos" })).toBeTruthy();
    expect(document.querySelector(".hold-banner")).toBeNull();
    cleanup();
    sessionStorage.clear();
    await open(team());
    const banner = document.querySelector(".hold-banner") as HTMLElement;
    expect(within(banner).getByRole("button", { name: PLANS })).toBeTruthy();
  });

  test("a personal workspace on a hold: the plan first in its own words, one of five", async () => {
    const state = lodi();
    const org = state.me?.organizations[0];
    if (org) org.mode = "personal";
    await open(state, dm);
    expect(heads()).toEqual([
      "Ligue os seus agentes.",
      "Me conte um pouco sobre você.",
      "Escolha os seus agentes.",
      "Conecte uma IA.",
      "Conecte os seus apps.",
    ]);
    expect(count()).toBe("0 de 5");
    expect(within(row("Ligue os seus agentes.")).getByRole("button", { name: "Ver planos" })).toBeTruthy();
    expect(row("Conecte uma IA.").textContent).toContain("É o passo seguinte ao plano.");
  });
});

describe("Primeira tarefa on a hold", () => {
  const params: TeamProposalCard["params"] = {
    lead: "A team",
    agents: [
      {
        name: "Ada",
        handle: "ada",
        role: "Dev",
        line: "Fixes",
        channel: "eng",
        instructions: "",
        appearance: null,
        routines: [],
        firstTask: "Escreva uma resposta para esta mensagem de cliente:",
      },
    ],
    newChannels: [],
    skills: [],
    weekly: null,
    approvals: "",
    invite: ["bia@acme.com"],
    template: "store",
  } as unknown as TeamProposalCard["params"];
  const created: Partial<TeamProposalCard> = {
    kind: "team_proposal",
    forUserId: "u-walter",
    params,
    state: "created",
    decidedByUserId: "u-walter",
    decidedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    created: { agentIds: [ADA_ID], channelIds: [], routineIds: [], skillIds: [], skipped: [], noAi: [ADA_ID] },
  };
  const made = (): Message => ({
    id: "m-team",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: LODI_ID },
    body: "team",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { actionCard: created },
    createdAt: NOW.toISOString(),
  });

  test("it waits for the plan: no task, no example and no plans button on a hold", async () => {
    const state = withRightHand(held(seedState()));
    state.messages.push(made());
    await open(state);
    expect(screen().queryByRole("group", { name: "Primeira tarefa" })).toBeNull();
    expect(document.body.textContent).not.toContain("Exemplo do que");
  });

  test("with a plan in force and an AI: the tasks and the invite, no plans button", async () => {
    const state = withRightHand(seedState());
    state.messages.push(made());
    await open(state);
    expect(screen().getByRole("group", { name: "Primeira tarefa" }).textContent).toContain(
      "Escreva uma resposta para esta mensagem de cliente:",
    );
    expect(screen().queryByRole("button", { name: PLANS })).toBeNull();
  });

  test("with a plan in force but no AI yet, it waits too", async () => {
    const state = withRightHand(seedState({ aiStatus: { any: false, agents: [] } }));
    state.messages.push(made());
    await open(state);
    expect(screen().queryByRole("group", { name: "Primeira tarefa" })).toBeNull();
  });
});

test("the receipt of a channel message nobody mentioned says it is kept, with the way to the plans", async () => {
  const state = held(seedState({ aiStatus: noAi(ADA_ID), authConfig: { billingUrl: BILLING } }));
  const { socket } = await open(state);
  const box = screen().getByRole("combobox", { name: /Mensagem para/ });
  await act(async () => fireEvent.change(box, { target: { value: "alguém aí?" } }));
  await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
  await settle(6);
  const sent = state.messages.at(-1)?.id;
  await act(async () =>
    socket.push({
      type: "event",
      channelId: ENG_ID,
      event: {
        channelId: ENG_ID,
        type: "message.routed",
        messageId: sent,
        strategy: "none",
        seenBy: [],
        pickedBy: [],
        reason: "no_ai",
      },
    }),
  );
  await settle(4);
  const row = screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes("alguém aí?")) as HTMLElement;
  const receipt = row.querySelector(".ac-receipt") as HTMLElement;
  expect(receipt.textContent).toContain("Guardada. Os agentes respondem quando o workspace tiver um plano");
  expect(within(receipt).getByRole("button", { name: PLANS })).toBeTruthy();
  expect(within(receipt).queryByRole("button", { name: "Conectar" })).toBeNull();
});

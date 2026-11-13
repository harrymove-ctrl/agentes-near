import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  type FakeState,
  fakeAgentBrain,
  fakeMachinesOf,
  LODI_ID,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * The right hand's first run (ADR 0155 §6): one checklist card under its greeting, for the workspace's owners, each
 * row from the workspace's data, none needing a model.
 */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const click = async (el: Element, rounds = 8) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
/** A new workspace: nobody else, no agent besides Lodi, nothing connected, Lodi with its checklist and an AI. */
const fresh = () => {
  const state = withRightHand(seedState({ agents: [] }), { setup: { role: null, done: [] } });
  state.members = state.members.slice(0, 1);
  state.connections = [];
  state.aiStatus = { any: true, agents: [{ agentId: LODI_ID, state: "ready" }] };
  return state;
};
const openDm = async (state: FakeState) => {
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(12);
  return r;
};
const card = () => document.querySelector(".setup-cl") as HTMLElement;
const rows = () => [...card().querySelectorAll(".setup-row")] as HTMLElement[];
const row = (text: string) => rows().find((r) => r.textContent?.includes(text)) as HTMLElement;

describe("the first-run checklist", () => {
  test("what the onboarding left, three rows in one order, the next one's button the only primary, nothing posted", async () => {
    const state = fresh();
    state.aiStatus = { any: false, agents: [{ agentId: LODI_ID, state: "no_ai" }] };
    await openDm(state);
    expect(card().getAttribute("aria-label")).toBe("Para o time da Acme começar a trabalhar");
    // Each row's name line (a MediaRow's head).
    expect(rows().map((r) => r.querySelector(".ac-mediarow__head")?.textContent)).toEqual([
      "Conecte uma IA.",
      "Conecte os apps do trabalho.",
      "Chame quem trabalha com você.",
    ]);
    expect(card().querySelector(".setup-cl__head small")?.textContent).toBe("0 de 3");
    const primary = [...card().querySelectorAll(".setup-row__act button")].filter((b) =>
      b.className.includes("primary"),
    );
    expect(primary.map((b) => b.textContent)).toEqual(["Conectar"]);
    // The rows hold the setup: no Connect card, no style question, nothing stored in the chat.
    expect(screen().queryByText("Conectar uma IA para o time")).toBeNull();
    expect(calls(state, "chat.post")).toEqual([]);
  });

  test("the AI row names the AI it thinks with, never Automático: on the workspace's key, its maker", async () => {
    const state = fresh();
    const lodi = state.agents.find((a) => a.id === LODI_ID);
    if (lodi) lodi.model = "auto";
    const api = createFakeApi(state);
    const brain = api.agents.brain;
    const key = { provider: "anthropic", label: "Chave da Acme" };
    api.agents.brain = async (orgId, id, scope) =>
      id === LODI_ID
        ? fakeAgentBrain(id, { brain: "model", workspaceAi: { brain: "model", ownerId: null, servesYou: true, key } })
        : brain(orgId, id, scope);
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api });
    await settle(12);
    const ai = rows()[0]?.querySelector(".ac-mediarow__head")?.textContent ?? "";
    expect(ai).toContain("Penso com Claude");
    expect(ai).not.toContain("Automático");
  });

  test("on a hold the plan leads with the card's one button, the AI row is next, the rest wait", async () => {
    const state = fresh();
    const org = state.me?.organizations[0];
    if (org) org.standing = { state: "hold", reason: "payment" };
    state.authConfig = { billingUrl: "https://billing.example.com" };
    // The link isn't minted: the click is all this test follows, never a page left.
    state.billingLinkError = new ApiError(503, "billing.unavailable", "Billing is down");
    const api = createFakeApi(state);
    // agentes.chat Cloud, where each workspace's own computer waits for the plan: only there is a hold.
    fakeMachinesOf.get(api)?.setSetup({ state: null });
    await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api });
    await settle(12);
    expect(rows().map((r) => r.querySelector(".ac-mediarow__head")?.textContent)).toEqual([
      "Ligue o time.",
      "Conecte uma IA.",
      "Conecte os apps do trabalho.",
      "Chame quem trabalha com você.",
    ]);
    expect(card().querySelector(".setup-cl__head small")?.textContent).toBe("0 de 4");
    expect(row("Ligue o time.").dataset.dim).toBeUndefined();
    expect(
      rows()
        .slice(1)
        .every((r) => r.dataset.dim !== undefined),
    ).toBe(true);
    expect(row("Conecte uma IA.").textContent).toContain("É o passo seguinte ao plano.");
    expect(row("Conecte os apps do trabalho.").textContent).toContain("Abre com o plano.");
    expect([...card().querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Ver planos"]);
    await click(within(row("Ligue o time.")).getByRole("button", { name: "Ver planos" }));
    expect(calls(state, "orgs.billingLink").map((c) => c.args)).toEqual([[ORG_ID, "hold"]]);
  });

  test("the AI row connects the whole team, naming no one, and a key saved there is Lodi's AI too", async () => {
    const state = withRightHand(seedState(), { setup: { role: null, done: [] } });
    state.members = state.members.slice(0, 1);
    state.connections = [];
    // The team the person made: theirs, so it wakes with the right hand (alone, Lodi would get the narrow dialog for it alone).
    for (const a of state.agents) a.ownerUserId = "u-walter";
    state.aiStatus = {
      any: false,
      agents: [LODI_ID, ADA_ID, ATLAS_ID].map((agentId) => ({ agentId, state: "no_ai", reason: "no_key" })),
    };
    await openDm(state);
    await click(within(row("Conecte uma IA.")).getByRole("button", { name: "Conectar" }));
    // For the whole team (ADR 0160, addendum): the key is one of its cards.
    const add = screen().getByRole("dialog", { name: "Conectar uma IA para o time" });
    await click(within(add).getByRole("button", { name: /^Chave de API/ }));
    await act(async () =>
      fireEvent.change(within(add).getByLabelText("Cole aqui"), { target: { value: "sk-ant-api03-abcdefghijklmnop" } }),
    );
    await click(within(add).getByRole("button", { name: "Salvar chave" }), 10);
    // Lodi's DM answers with the key from now on: it is the workspace's AI.
    expect(calls(state, "agents.setBrain").map((c) => c.args.slice(1))).toContainEqual([
      LODI_ID,
      { scope: "workspace", brain: "model" },
    ]);
  });

  test("one address invites from the row, and the row then says who is waiting", async () => {
    const state = fresh();
    await openDm(state);
    const people = row("Chame quem trabalha com você.");
    await act(async () =>
      fireEvent.change(within(people).getByLabelText("E-mail"), {
        target: { value: "joao.lima@example.com" },
      }),
    );
    await click(within(people).getByRole("button", { name: "Enviar" }), 10);
    expect(calls(state, "orgs.inviteMany").map((c) => c.args[1])).toEqual([{ emails: ["joao.lima@example.com"] }]);
    expect(row("Convidei joao.lima · aguardando")).toBeTruthy();
    // Nobody joined yet: it says the invitation went out, and celebrates nothing.
    expect(card().querySelector(".setup-row__say")?.textContent).toBe("Convite enviado.");
    expect(card().textContent).not.toContain("Que bom ter mais gente aqui.");
    // Done: the row's own field is gone with it.
    expect(within(row("Convidei")).queryByRole("button", { name: "Mais opções" })).toBeNull();
  });

  test("Agora não on apps is kept, the row reads done, and nothing is said for it", async () => {
    const state = fresh();
    await openDm(state);
    await click(within(row("Conecte os apps do trabalho.")).getByRole("button", { name: "Agora não" }));
    expect(calls(state, "agents.confirmSetup").map((c) => c.args.slice(1))).toEqual([[LODI_ID, "apps"]]);
    expect(row("Sem apps por enquanto")).toBeTruthy();
    expect(card().querySelector(".setup-row__say")).toBeNull();
  });

  test("the apps row lists the apps to connect with one way out: Fechar, no Cancelar beside it", async () => {
    await openDm(fresh());
    await click(within(row("Conecte os apps do trabalho.")).getByRole("button", { name: "Escolher" }));
    const dialog = screen().getByRole("dialog", { name: "Os apps do trabalho" });
    expect(within(dialog).getAllByRole("button", { name: "Conectar" }).length).toBeGreaterThan(0);
    // The corner X and the footer's Fechar.
    expect(within(dialog).getAllByRole("button", { name: "Fechar" }).length).toBe(2);
    expect(within(dialog).queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  test("complete: Tudo pronto, then how agents talk, and the asks that go to Lodi", async () => {
    const state = withRightHand(seedState(), { setup: { role: null, done: ["apps"] } });
    state.aiStatus = { any: true, agents: [{ agentId: LODI_ID, state: "ready" }] };
    if (state.me?.organizations[0]) state.me.organizations[0].agentStyle = null;
    await openDm(state);
    expect(card().getAttribute("aria-label")).toBe("Tudo pronto.");
    expect(screen().getByText("Como prefere que eu fale com você?")).toBeTruthy();
    expect(card().textContent).toContain("Agora me peça algo:");
    await click(within(card()).getByRole("button", { name: "Quem do time cuida do quê?" }), 10);
    expect(calls(state, "chat.post").map((c) => (c.args[2] as { body: string }).body)).toEqual([
      "Quem do time cuida do quê?",
    ]);
  });

  test("complete before the team answered anything: how agents talk waits, so it never stands beside the first task", async () => {
    const state = withRightHand(seedState(), { setup: { role: null, done: ["apps"] } });
    state.aiStatus = { any: true, agents: [{ agentId: LODI_ID, state: "ready" }] };
    state.agentStatuses = state.agents.map((a) => ({
      agentId: a.id,
      presence: "online" as const,
      status: null,
      activeAt: null,
    }));
    if (state.me?.organizations[0]) state.me.organizations[0].agentStyle = null;
    await openDm(state);
    expect(card().getAttribute("aria-label")).toBe("Tudo pronto.");
    expect(screen().queryByText("Como prefere que eu fale com você?")).toBeNull();
  });

  test("an invited person sees none of it", async () => {
    const state = fresh();
    const org = state.me?.organizations[0];
    if (org) org.role = "member";
    await openDm(state);
    expect(card()).toBeNull();
  });
});

describe("in a personal workspace (ADR 0159)", () => {
  const personal = () => {
    const state = fresh();
    const org = state.me?.organizations[0];
    if (org) org.mode = "personal";
    return state;
  };

  test("four rows in its words, no people row", async () => {
    await openDm(personal());
    expect(card().getAttribute("aria-label")).toBe("Para os seus agentes começarem");
    expect(rows().map((r) => r.querySelector(".ac-mediarow__head")?.textContent)).toEqual([
      "Me conte um pouco sobre você.",
      "Escolha os seus agentes.",
      "Já penso com uma IATrocar",
      "Conecte os seus apps.",
    ]);
    expect(card().querySelector(".setup-cl__head small")?.textContent).toBe("1 de 4");
    expect(screen().getByText("Oi, eu sou o Lodi. Monto os seus agentes com você.")).toBeTruthy();
  });

  test("row 1 asks the areas of life and one sentence, saved as the context; then the agents for them", async () => {
    const state = personal();
    await openDm(state);
    await click(within(row("Me conte um pouco sobre você.")).getByRole("button", { name: "Contar" }));
    const dialog = screen().getByRole("dialog", { name: "Com o que você quer ajuda?" });
    expect((within(dialog).getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
    await click(within(dialog).getByRole("button", { name: "Finanças" }));
    await click(within(dialog).getByRole("button", { name: "Agenda e rotina" }));
    await act(async () =>
      fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Corro duas vezes por semana." } }),
    );
    await click(within(dialog).getByRole("button", { name: "Salvar" }), 12);
    expect(calls(state, "orgs.updateSettings").map((c) => c.args[1])).toEqual([
      { context: "Quero ajuda com: Agenda e rotina, Finanças. Corro duas vezes por semana." },
    ]);
    expect(screen().getByRole("dialog", { name: "Os seus agentes" })).toBeTruthy();
  });
});

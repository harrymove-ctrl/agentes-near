import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentProposalCard, CardDelegate, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  LODI_ID,
  NOW,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const HOUR = 3_600_000;
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const last = (state: FakeState, method: string) => state.calls.findLast((c) => c.method === method)?.args;
const section = () => within(document.querySelector(".page") as HTMLElement);

/** Atlas's proposal of Nina in #eng, as the right hand left it for `forUserId`. */
const proposal = (delegate: CardDelegate, card: Partial<AgentProposalCard> = {}): Message => ({
  id: "p-1",
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent", id: ATLAS_ID },
  body: "Proposed a new agent, Nina: server text",
  mentionedAgentIds: [],
  agentRunId: "r-p-1",
  meta: {
    bodyCode: "agent_proposal",
    bodyParams: { name: "Nina" },
    actionCard: {
      kind: "agent_proposal",
      forUserId: delegate.forUserId,
      params: {
        draft: {
          name: "Nina",
          handle: "nina",
          role: "Designer",
          instructions: "Desenha as telas.",
          appearance: null,
          channelIds: [ENG_ID],
          access: [],
          ai: { kind: "model" },
        },
        why: "Você pediu alguém para o design.",
      },
      state: "pending",
      agentId: null,
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: new Date(Date.now() + 20 * HOUR).toISOString(),
      delegate,
      ...card,
    } satisfies AgentProposalCard,
  },
  createdAt: NOW.toISOString(),
});

describe("Lodi's page: what it does for me without asking (ADR 0139 §2)", () => {
  test("one switch, two kinds, the budget per agent and the guidance, each saved at once; the lock closes it", async () => {
    const state = seedState();
    withRightHand(state);
    await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const card = section().getByRole("region", { name: "Lodi cria e ajusta agentes por você" });
    expect(within(card).getByText(/Sempre com você: dinheiro/)).toBeTruthy();
    expect(within(card).queryByRole("checkbox")).toBeNull();

    await click(within(card).getByRole("switch", { name: "Lodi cria e ajusta agentes por você" }));
    expect(last(state, "approvals.setRightHand")).toEqual([ORG_ID, { enabled: true }]);
    await click(within(card).getByRole("checkbox", { name: "Criar agentes que outros agentes propõem" }));
    expect(last(state, "approvals.setRightHand")).toEqual([ORG_ID, { newAgents: false }]);

    const budget = within(card).getByRole("textbox", { name: "Orçamento a mais, por agente" }) as HTMLInputElement;
    expect(budget.value).toBe("20");
    await act(async () => {
      fireEvent.change(budget, { target: { value: "30" } });
      fireEvent.blur(budget);
    });
    await settle(4);
    expect(last(state, "approvals.setRightHand")).toEqual([ORG_ID, { budgetCapNanoUsd: 30_000_000_000 }]);

    const guidance = within(card).getByRole("textbox", { name: "Como Lodi decide por você" });
    const guidanceRow = guidance.closest(".settings-row") as HTMLElement;
    expect(guidanceRow).not.toBe(budget.closest(".settings-row"));
    expect(within(guidanceRow).queryByRole("textbox", { name: "Orçamento a mais, por agente" })).toBeNull();
    expect(guidance.getAttribute("aria-describedby")).toBe("rh-guidance-help");
    // The last row, right over the card's foot: the rule that gives it its own depth below (stacked-ask-css).
    expect(guidanceRow.nextElementSibling).toBeNull();
    expect(guidanceRow.parentElement?.nextElementSibling?.classList.contains("ac-card__foot")).toBe(true);
    expect(within(guidanceRow).getByText("Lodi lê isto antes de decidir. Opcional.")).toBeTruthy();
    expect(guidance.getAttribute("placeholder")).toContain("Ex.: nada de agente duplicado\n");
    await act(async () => {
      fireEvent.change(guidance, { target: { value: "Nada de agente duplicado." } });
      fireEvent.blur(guidance);
    });
    await settle(4);
    expect(last(state, "approvals.setRightHand")).toEqual([ORG_ID, { guidance: "Nada de agente duplicado." }]);
  });

  test("a kind the person can't decide is greyed, and a pause says why", async () => {
    const state = seedState();
    withRightHand(state);
    state.rightHandApprovals = {
      enabled: true,
      newAgents: true,
      agentChanges: true,
      budgetCapNanoUsd: 20_000_000_000,
      guidance: "",
      pausedAt: null,
      rightHand: { id: LODI_ID, name: "Lodi" },
      mayDecide: { newAgents: false, agentChanges: true },
      caps: { decisionsPerDay: 10, newAgentsPerDay: 2, monthNanoUsd: 50_000_000_000 },
      used: { decisionsToday: 0, newAgentsToday: 0, monthNanoUsd: 0 },
    };
    await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const box = section().getByRole("checkbox", { name: "Criar agentes que outros agentes propõem" });
    expect(box.hasAttribute("disabled")).toBe(true);
    expect(section().getByText("Você não decide isso hoje")).toBeTruthy();
  });
});

describe("a card the right hand looked at", () => {
  test("approved for me: one line, Desfazer, and Por quê? opens its reason and what Desfazer does", async () => {
    const state = seedState();
    withRightHand(state);
    const me = state.me?.user.id ?? "";
    const at = new Date().toISOString();
    state.messages.push(
      proposal(
        {
          agentId: LODI_ID,
          forUserId: me,
          state: "approved",
          reason: "Veio do seu pedido e não há outro igual.",
          decisionId: "d-1",
          at,
          undoUntil: new Date(Date.now() + 24 * HOUR).toISOString(),
        },
        { state: "created", agentId: ATLAS_ID, decidedByUserId: me, decidedAt: at },
      ),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const line = screen().getByRole("group", { name: "Atlas propõe um novo agente" });
    expect(line.textContent).toContain("Nina · Aprovado por Lodi em seu nome");
    await click(within(line).getByRole("button", { name: "Por quê?" }));
    expect(line.textContent).toContain("Veio do seu pedido e não há outro igual.");
    expect(line.textContent).toContain("Desfazer arquiva Nina. Vale até");
    await click(within(line).getByRole("button", { name: "Desfazer" }));
    expect(last(state, "approvals.undoRightHand")).toEqual([ORG_ID, "d-1"]);
  });

  test("passed to me says why on the open card; another person reads nothing of it", async () => {
    const state = seedState();
    withRightHand(state);
    const me = state.me?.user.id ?? "";
    const passed = { agentId: LODI_ID, state: "passed" as const, reason: "Já existe a Ada.", at: NOW.toISOString() };
    state.messages.push(proposal({ ...passed, forUserId: me }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    expect(screen().getByText("Lodi passou para você: Já existe a Ada.")).toBeTruthy();
    cleanup();

    const other = seedState();
    withRightHand(other);
    other.messages.push(proposal({ ...passed, forUserId: "u-someone" }));
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(other) });
    await settle(6);
    expect(screen().queryByText(/passou para/)).toBeNull();
  });
});

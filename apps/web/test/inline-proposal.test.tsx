import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Proposal } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** A proposal Atlas made in the chat: Ada's instructions unless `patch` says otherwise. */
const row = (id: string, patch: Partial<Proposal> = {}): Proposal => ({
  id,
  agentId: ADA_ID,
  proposedByAgentId: ATLAS_ID,
  target: { type: "agent_instructions", agentId: ADA_ID },
  title: "Update Ada's instructions",
  why: "Pedido na conversa.",
  evidence: [],
  before: "Seja breve.",
  after: "Seja breve.\n\n## Learned\n- Responder em português.",
  status: "pending",
  stale: false,
  canDecide: true,
  decider: { type: "admins" },
  createdAt: new Date().toISOString(),
  decidedBy: null,
  decidedAt: null,
  ...patch,
});
const atlas = (id: string, patch: Partial<Proposal> = {}) =>
  row(id, { agentId: ATLAS_ID, target: { type: "agent_instructions", agentId: ATLAS_ID }, ...patch });
const adaRole = (id: string) =>
  row(id, { target: { type: "agent_role", agentId: ADA_ID }, before: "Dev", after: "Revisora de código" });

/** #eng with Atlas's reply carrying the card for `proposals` (`meta.memoryUpdates`). */
async function openCard(proposals: Proposal[], tweak: (api: ReturnType<typeof createFakeApi>) => void = () => {}) {
  const state = seedState();
  state.proposals = proposals;
  const ids = proposals.map((p) => p.id);
  state.messages.push({
    id: "msg-card",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ATLAS_ID },
    body: "Pronto, deixei a proposta.",
    mentionedAgentIds: [],
    agentRunId: "r-card",
    meta: {
      memoryUpdates: [
        {
          action: "proposed",
          itemId: ids[0],
          text: "Responder em português.",
          requestedByUserId: "u-walter",
          proposalId: ids[0],
          proposalIds: ids,
          canDecide: true,
        },
      ],
    },
    createdAt: new Date().toISOString(),
  });
  const api = createFakeApi(state);
  tweak(api);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return state;
}
/** The list holds only the newest proposals, and the card's are past it: only a read by id finds them. */
const pastTheList = (api: ReturnType<typeof createFakeApi>) => {
  const list = api.proposals.list;
  api.proposals.list = async (orgId, filter) => (filter?.ids ? list(orgId, filter) : []);
};
const accepted = (state: { calls: { method: string; args: unknown[] }[] }) =>
  state.calls.filter((c) => c.method === "proposals.accept").map((c) => c.args[1]);
const click = (el: HTMLElement) => act(async () => fireEvent.click(el));

describe("a skill proposed in the chat", () => {
  const skill = (id: string) =>
    row(id, {
      target: { type: "skill", agentId: ADA_ID, skillId: "sk-1", name: "relatorios" },
      before: "# Relatórios\n1. Abrir a planilha.",
      after: "# Relatórios\n1. Abrir a planilha.\n2. Conferir os totais.",
      whyCode: "skill",
    });

  test("its card shows the change and takes it as proposed: Aceitar and Recusar, no Editar", async () => {
    const state = await openCard([skill("p-skill")]);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Atlas" });
    expect(card.textContent).toContain("relatorios");
    expect(card.querySelector(".rq__wt")?.textContent).toContain("Conferir os totais.");
    await click(within(card).getByRole("button", { name: "Ver a mudança" }));
    expect(card.querySelector(".ac-diff__block--add")?.textContent).toContain("Conferir os totais.");
    expect(within(card).queryByRole("button", { name: "Editar" })).toBeNull();
    await click(within(card).getByRole("button", { name: "Aceitar mudança" }));
    await settle(4);
    expect(accepted(state)).toEqual(["p-skill"]);
  });

  test("whoever can't decide it sees whom it waits for and the change", async () => {
    await openCard([{ ...skill("p-skill"), canDecide: false }]);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Atlas" });
    expect(within(card).queryByRole("button", { name: "Aceitar mudança" })).toBeNull();
    expect(card.textContent).toContain("Conferir os totais.");
  });
});

describe("a change proposed for several agents in the chat", () => {
  test("one card: the change shown once, a row per agent, 'Aceitar para todos' accepts each row", async () => {
    const state = await openCard([row("p-ada"), atlas("p-atlas")]);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Atlas para 2 agentes" });
    expect(card.textContent).toContain("Atlas propõe · instruções de 2 agentes");
    // The change once, behind "Ver a mudança", its first line in the well.
    expect(card.querySelector(".rq__wt")?.textContent).toContain("Responder em português.");
    await click(within(card).getByRole("button", { name: "Ver a mudança" }));
    expect(card.querySelectorAll(".ac-diff")).toHaveLength(1);
    // The added lines as Markdown: a list item, not its "- ".
    const added = card.querySelector(".ac-diff__block--add:last-child");
    expect(added?.querySelector("li")?.textContent).toBe("Responder em português.");
    expect(within(card).getByRole("switch", { name: "Incluir Ada" })).toBeTruthy();
    expect(within(card).getByRole("switch", { name: "Incluir Atlas" })).toBeTruthy();
    await click(within(card).getByRole("button", { name: "Aceitar para todos" }));
    await settle(4);
    expect(accepted(state)).toEqual(["p-ada", "p-atlas"]);
    // Decided: one line takes the request card's place.
    const done = screen().getByRole("group", { name: "Proposta de mudança de Atlas para 2 agentes" });
    // What it was and how it ended, the change and its rows when asked for.
    expect(done.textContent).toContain("Aceita: Atlas propõe · instruções de 2 agentes");
    expect(done.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    expect(done.querySelector(".ac-diff")).toBeNull();
    await click(within(done).getByRole("button", { name: "Ver a mudança" }));
    expect(done.querySelector(".ac-diff")).not.toBeNull();
    expect([...done.querySelectorAll(".proposal-row__status")].map((s) => s.textContent)).toEqual(["Aceita", "Aceita"]);
  });

  test("a row the viewer can't decide stays off and says whom it waits for; the button counts the chosen rows", async () => {
    const state = await openCard([
      row("p-ada"),
      atlas("p-atlas", { canDecide: false, decider: { type: "user", userId: "u-joao", name: "João" } }),
      adaRole("p-role"),
    ]);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Atlas para 2 agentes" });
    expect(card.textContent).toContain("Atlas propõe · mudanças em 2 agentes");
    expect(card.textContent).toContain("Papel: Dev → Revisora de código");
    const waiting = within(card).getByRole("switch", { name: "Incluir Atlas" });
    expect(waiting.getAttribute("aria-checked")).toBe("false");
    expect(waiting.hasAttribute("disabled")).toBe(true);
    expect(card.textContent).toContain("Aguardando João");
    expect(within(card).getByRole("button", { name: "Aceitar para 2" })).toBeTruthy();
    const roles = within(card).getAllByRole("switch", { name: "Incluir Ada" });
    await click(roles[1] as HTMLElement);
    await click(within(card).getByRole("button", { name: "Aceitar para 1" }));
    await settle(4);
    expect(accepted(state)).toEqual(["p-ada"]);
  });

  test("a row that went stale meanwhile doesn't stop the others, and a toast says so", async () => {
    const state = await openCard([row("p-ada"), atlas("p-atlas")]);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Atlas para 2 agentes" });
    // Atlas's instructions change after the card was read: the server answers 409 for that row.
    (state.proposals[1] as Proposal).stale = true;
    await click(within(card).getByRole("button", { name: "Aceitar para todos" }));
    await settle(4);
    expect(accepted(state)).toEqual(["p-ada", "p-atlas"]);
    expect(document.querySelector(".ac-toast")?.textContent).toContain(
      "Uma não foi aceita: o texto mudou desde a proposta.",
    );
    const done = screen().getByRole("group", { name: "Proposta de mudança de Atlas para 2 agentes" });
    expect(done.textContent).toContain("1 de 2 aceitas");
    await click(within(done).getByRole("button", { name: "Ver a mudança" }));
    expect([...done.querySelectorAll(".proposal-row__status")].map((s) => s.textContent)).toEqual([
      "Aceita",
      "Ficou velha",
    ]);
  });

  test("a card reads its rows by id: older than the newest proposals the list holds, it still shows whole", async () => {
    await openCard([row("p-ada"), atlas("p-atlas")], pastTheList);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Atlas para 2 agentes" });
    expect(within(card).getByRole("switch", { name: "Incluir Ada" })).toBeTruthy();
    expect(within(card).getByRole("switch", { name: "Incluir Atlas" })).toBeTruthy();
  });

  test("a card of one row reads it by id too", async () => {
    await openCard([adaRole("p-role")], pastTheList);
    expect(screen().getByRole("group", { name: "Proposta de mudança de Atlas" }).textContent).toContain(
      "Papel: Dev → Revisora de código",
    );
  });

  test("an accepted role or app reads the agents again, on a card of several rows or of one", async () => {
    let reads = 0;
    const counting = (api: ReturnType<typeof createFakeApi>) => {
      const list = api.agents.list;
      api.agents.list = async (orgId) => {
        reads += 1;
        return list(orgId);
      };
    };
    await openCard([adaRole("p-role"), atlas("p-atlas")], counting);
    let before = reads;
    const card = screen().getByRole("group", { name: "Proposta de mudança de Atlas para 2 agentes" });
    await click(within(card).getByRole("button", { name: "Aceitar para todos" }));
    await settle(4);
    expect(reads).toBeGreaterThan(before);
    cleanup();

    await openCard([adaRole("p-role")], counting);
    before = reads;
    await click(screen().getByRole("button", { name: "Aceitar mudança" }));
    await settle(4);
    expect(reads).toBeGreaterThan(before);
  });

  test("one row alone keeps the single card: a new role is taken as proposed, with no Editar", async () => {
    const state = await openCard([adaRole("p-role")]);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Atlas" });
    expect(card.textContent).toContain("papel da Ada");
    expect(card.textContent).toContain("Mudar o papel da Ada");
    expect(card.textContent).toContain("Papel: Dev → Revisora de código");
    expect(within(card).queryByRole("button", { name: "Editar" })).toBeNull();
    await click(within(card).getByRole("button", { name: "Aceitar mudança" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "proposals.accept")?.args).toEqual([ORG_ID, "p-role", undefined]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ADMIN_ROLE_ID,
  createFakeApi,
  type FakeState,
  LODI_ID,
  meWithRole,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The right hand's cards for the rest of the app (ADR 0137 §4): approvals, people, and any screen. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const DM = `dm-${LODI_ID}`;

/** A card of Lodi's in its DM, `ago` ms old. A second card joins the same DM: Lodi and the DM are seeded once. */
const withLodiCard = (state: FakeState, actionCard: Record<string, unknown>, id = "m-card", ago = 60_000) => {
  if (!state.agents.some((a) => a.id === LODI_ID)) {
    withRightHand(state);
    seedDm(state, { type: "agent", id: LODI_ID });
  }
  const message: Message = {
    id,
    channelId: DM,
    threadId: null,
    author: { type: "agent", id: LODI_ID },
    body: "",
    mentionedAgentIds: [],
    agentRunId: `r-${id}`,
    meta: { actionCard },
    createdAt: new Date(Date.now() - ago).toISOString(),
  };
  state.messages.push(message);
  return state;
};

const go = async (state: FakeState) => {
  const r = await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = async (el: HTMLElement, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("approvals waiting for you", () => {
  test("each approval as the conversation shows it; the click decides it, sent with the card for the audit", async () => {
    const state = withLodiCard(seedState(), {
      kind: "approvals",
      forUserId: "u-walter",
      params: { approvalIds: ["ap-merge"], why: "O merge da Ada espera você." },
    });
    await go(state);
    const group = screen().getByRole("group", { name: "Aprovações esperando você" });
    expect(group.textContent).toContain("O merge da Ada espera você.");
    expect(group.textContent).toContain("Fazer um merge");
    await click(within(group).getByRole("button", { name: "Aprovar merge" }));
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args.slice(0, 2)).toEqual([ORG_ID, "ap-merge"]);
    expect(state.calls.find((c) => c.method === "via")?.args).toEqual(["m-card"]);
    expect(screen().getByRole("group", { name: "Aprovações esperando você" }).textContent).toContain(
      "Aprovado por você",
    );
  });
});

describe("changing people", () => {
  const card = {
    kind: "member_changes",
    forUserId: "u-walter",
    params: {
      rows: [
        { userId: "u-joao", name: "João", role: "owner" },
        { userId: "u-joao", name: "João", remove: true },
      ],
      why: "O João assume a conta.",
    },
  };

  test("a row per change, applied with the members' own calls; removing asks as the members screen does", async () => {
    const state = withLodiCard(seedState(), card);
    await go(state);
    const c = screen().getByRole("group", { name: "Mudar pessoas" });
    expect(c.textContent).toContain("O João assume a conta.");
    expect(c.textContent).toContain("Ganha Dono");
    expect(c.textContent).toContain("Remover do workspace");
    await click(within(c).getByRole("button", { name: "Aplicar" }));
    expect(state.calls.find((x) => x.method === "orgs.changeRole")?.args).toEqual([ORG_ID, "u-joao", "owner"]);
    expect(state.calls.filter((x) => x.method === "via").map((x) => x.args[0])).toEqual(["m-card"]);
    // Nothing goes before the members screen's confirmation.
    await click(
      within(screen().getByRole("group", { name: "Mudar pessoas" })).getByRole("button", {
        name: "Remover do workspace",
      }),
    );
    expect(state.calls.some((x) => x.method === "orgs.removeMember")).toBe(false);
    const dialog = screen().getByRole("dialog");
    await click(within(dialog).getByRole("button", { name: "Remover João" }));
    expect(state.calls.find((x) => x.method === "orgs.removeMember")?.args).toEqual([ORG_ID, "u-joao"]);
    expect(screen().getByRole("group", { name: "Mudar pessoas" }).textContent).toContain("Feito: João");
  });

  test("a member reads that only owners change who is an owner, with no button", async () => {
    const state = withLodiCard(seedState(), {
      ...card,
      params: { ...card.params, rows: [{ userId: "u-joao", name: "João", role: "owner" }] },
    });
    meWithRole(state, []);
    await go(state);
    const c = screen().getByRole("group", { name: "Mudar pessoas" });
    expect(c.textContent).toContain("Só donos mudam quem é dono");
    expect(within(c).queryByRole("button", { name: "Aplicar" })).toBeNull();
  });

  test("roles given and taken read their names", async () => {
    const state = withLodiCard(seedState(), {
      ...card,
      params: {
        ...card.params,
        rows: [{ userId: "u-joao", name: "João", addRoleIds: [], removeRoleIds: [ADMIN_ROLE_ID] }],
      },
    });
    await go(state);
    const c = screen().getByRole("group", { name: "Mudar pessoas" });
    expect(c.textContent).toMatch(/Perde Admin/);
    await click(within(c).getByRole("button", { name: "Aplicar" }));
    expect(state.calls.find((x) => x.method === "roles.setFor")?.args).toEqual([ORG_ID, "u-joao", []]);
  });
});

describe("opening a screen", () => {
  test("Abrir goes to the screen, which asks what it always asks; an agent's page by its name", async () => {
    const state = withLodiCard(seedState(), {
      kind: "open_page",
      forUserId: "u-walter",
      params: { page: "delete_workspace", why: "Para apagar o workspace, confirme lá." },
    });
    withLodiCard(
      state,
      {
        kind: "open_page",
        forUserId: "u-walter",
        params: { page: "agent", agentId: ADA_ID, why: "As instruções dela." },
      },
      "m-ada",
      // A minute older than the delete card: by a clock alone the two can fall in the same millisecond or not.
      120_000,
    );
    const { router } = await go(state);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Apagar workspace");
    expect(text).toContain("Para apagar o workspace, confirme lá.");
    expect(text).toContain("As instruções dela.");
    // The delete card is the newer one.
    const del = screen().getAllByRole("button", { name: "Abrir" }).at(-1);
    if (!del) throw new Error("no Abrir");
    await click(del);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/general`);
    expect(router.state.location.search).toMatchObject({ delete: 1 });
  });

  test("who can't use the screen reads it, with no button", async () => {
    const state = withLodiCard(seedState(), {
      kind: "open_page",
      forUserId: "u-walter",
      params: { page: "roles", why: "Os papéis." },
    });
    meWithRole(state, []);
    await go(state);
    expect(document.body.textContent).toContain("Você não tem acesso a esta tela");
    expect(screen().queryByRole("button", { name: "Abrir" })).toBeNull();
  });
});

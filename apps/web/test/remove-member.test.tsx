import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Member } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, meAsAdmin, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Remover do workspace (and Sair do workspace on one's own row): who sees it, what the confirmation says, the row
 * gone after it, and the screen of someone taken out while the workspace is open.
 */

afterEach(() => {
  localStorage.clear();
  cleanup();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const text = () => document.body.textContent ?? "";
const bia: Member = {
  userId: "u-bia",
  name: "Bia",
  email: "bia@example.com",
  image: null,
  role: "member",
  roleIds: [],
  joinedAt: new Date().toISOString(),
  handle: "bia",
  timezone: "UTC",
};

async function members(state = seedState()) {
  const r = await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
}

/** A person's name on Members: it opens their card, and Shift+F10 on it (or a right click) opens their menu. */
const nameOf = (name: string) => {
  const found = screen()
    .getAllByRole("button", { name: `Perfil de ${name}` })
    .find((b) => !b.hasAttribute("aria-hidden") && b.closest(".members-person"));
  if (!found) throw new Error(`no row for ${name}`);
  return found;
};

/** The labels of a person's menu on their Members row. */
async function menuOf(name: string) {
  const trigger = nameOf(name);
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "F10", shiftKey: true }));
  await settle(2);
  const items = screen()
    .queryAllByRole("menuitem")
    .map((i) => i.textContent ?? "");
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  await settle(1);
  return items;
}

describe("who may remove whom", () => {
  test("the only owner removes anyone, and can't leave", async () => {
    const state = seedState();
    state.members.push(bia);
    await members(state);
    expect(await menuOf("João")).toContain("Remover do workspace");
    expect(await menuOf("Bia")).toContain("Remover do workspace");
    const mine = await menuOf("Walter");
    expect(mine).not.toContain("Sair do workspace");
    expect(mine).not.toContain("Remover do workspace");
  });

  test("an admin removes those below, not another admin; a member removes nobody and leaves", async () => {
    const state = seedState();
    state.members.push(bia, { ...bia, userId: "u-caio", name: "Caio", handle: "caio", roleIds: ["role-admin"] });
    meAsAdmin(state);
    const org = state.me?.organizations[0];
    if (org) org.rank = 0;
    await members(state);
    expect(await menuOf("Bia")).toContain("Remover do workspace");
    expect(await menuOf("Caio")).not.toContain("Remover do workspace");
    expect(await menuOf("Walter")).not.toContain("Remover do workspace");
    cleanup();

    const plain = seedState();
    plain.members.push(bia);
    if (plain.me) plain.me.user = { ...plain.me.user, id: bia.userId, name: bia.name };
    const mine = plain.me?.organizations[0];
    if (mine) mine.role = "member";
    await members(plain);
    expect(await menuOf("João")).not.toContain("Remover do workspace");
    expect(await menuOf("Bia")).toContain("Sair do workspace");
  });
});

test("the confirmation says what goes with them; removing takes the row away", async () => {
  const state = seedState();
  state.removalLosesPlan = { "u-joao": [{ id: ADA_ID, name: "Ada" }] };
  const { state: s } = await members(state);
  const trigger = nameOf("João");
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "F10", shiftKey: true }));
  await settle(2);
  await click(screen().getByRole("menuitem", { name: "Remover do workspace" }));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Remover João da Acme?" });
  expect(dialog.textContent).toContain("O acesso de João à Acme acaba agora, em todos os aparelhos.");
  expect(dialog.textContent).toContain("Os agentes de João passam a ter você como responsável: Ada e Atlas.");
  expect(dialog.textContent).toContain("Ada pensava com um plano de João e fica sem ele.");
  expect(dialog.textContent).toContain("As mensagens de João ficam onde estão.");

  await click(screen().getByRole("button", { name: "Remover João" }));
  await settle(6);
  expect(s.calls.some((c) => c.method === "orgs.removeMember" && c.args[1] === "u-joao")).toBe(true);
  expect(text()).toContain("João não faz mais parte da Acme.");
  expect(document.querySelector(".members-person")?.closest(".ac-list")?.textContent).not.toContain("João");
  expect(s.agents.filter((a) => a.id === ADA_ID || a.id === ATLAS_ID).map((a) => a.ownerUserId)).toEqual([
    "u-walter",
    "u-walter",
  ]);
});

test("the row: @handle beside the email, a DM button by when they were here, no … of its own", async () => {
  const { router } = await members();
  const row = nameOf("João").closest(".members-person") as HTMLElement;
  expect(row.querySelector(".members-person__ids")?.textContent).toBe("@joaojoao@acme.com.br");
  expect(within(row).queryByRole("button", { name: /^Mais ações/ })).toBeNull();
  await click(within(row).getByRole("button", { name: "Mensagem para João" }));
  await settle(4);
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/person/u-joao`);
});

test("the card a name opens has Remover do workspace in its ⋯, with the same dialog", async () => {
  await members();
  await click(nameOf("João"));
  await settle(4);
  const card = screen().getByRole("dialog", { name: "Perfil" });
  await act(async () => fireEvent.keyDown(within(card).getByRole("button", { name: "Mais" }), { key: "Enter" }));
  await settle(2);
  await click(screen().getByRole("menuitem", { name: "Remover do workspace" }));
  await settle(4);
  expect(screen().getByRole("dialog", { name: "Remover João da Acme?" })).toBeTruthy();
});

test("taken out while the workspace is open: a screen that says so, at once", async () => {
  const state = seedState();
  const { sockets } = await members(state);
  await act(async () => sockets.last().open());
  await settle(4);
  if (state.me) state.me = { ...state.me, organizations: [] };
  await act(async () => sockets.last().push({ type: "error", code: "membership_revoked" }));
  await settle(6);
  expect(text()).toContain("Você não faz mais parte da Acme");
});

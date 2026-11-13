import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { OrgRole } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ADMIN_ROLE_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedRoles, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
});

type State = ReturnType<typeof seedState>;
const [admin, everyone] = seedRoles() as [OrgRole, OrgRole];
const comercial: OrgRole = { ...admin, id: "role-comercial", name: "Comercial", color: "amber", icon: "wallet" };
const diretoria: OrgRole = { ...admin, id: "role-diretoria", name: "Diretoria", icon: "flag", givable: false };

/** A workspace with Comercial (givable) and Diretoria (above the viewer: not givable); João holds Admin and Diretoria. */
function withRoles(state = seedState()): State {
  state.roles = [
    { ...diretoria, position: 0 },
    { ...admin, position: 1 },
    { ...comercial, position: 2, hoist: false },
    { ...everyone, position: 3 },
  ];
  const joao = state.members.find((m) => m.userId === "u-joao");
  if (joao) joao.roleIds = [ADMIN_ROLE_ID, diretoria.id];
  return state;
}

/** Me as someone else: a plain member (no roles), or `userId`. */
function viewAs(state: State, userId = "u-walter", roleIds: string[] = []) {
  const m = state.members.find((x) => x.userId === userId);
  if (!m || !state.me) throw new Error("no member");
  state.me.user = { id: m.userId, name: m.name, email: m.email, image: null };
  const org = state.me.organizations[0];
  if (org) org.role = "member";
  for (const x of state.members) if (x.role === "owner" && x.userId === userId) x.role = "member";
  m.roleIds = roleIds;
}

const go = async (state: State) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
/** Radix menus open on pointer down. */
const press = async (el: Element) => {
  await act(async () => fireEvent.pointerDown(el, { button: 0, ctrlKey: false }));
  await settle(2);
};
const card = () => screen().getByRole("dialog", { name: "Perfil" });
const openCard = async (name: string) => {
  const trigger = screen()
    .getAllByRole("button", { name: `Perfil de ${name}` })
    .find((b) => !b.hasAttribute("aria-hidden"));
  if (!trigger) throw new Error(`no trigger for ${name}`);
  await click(trigger);
  await settle(6);
  return card();
};
const chips = (c: HTMLElement) =>
  [...within(c).getByRole("region", { name: "Papéis" }).querySelectorAll(".ac-token")].map((t) => ({
    name: t.querySelector(".ac-token__label")?.textContent,
    mark: Boolean(t.querySelector(".ac-rolemark")),
    removable: Boolean(t.querySelector(".ac-token__remove")),
  }));
const lines = (c: HTMLElement) =>
  [...within(c).getByRole("region", { name: "Quem pode falar" }).querySelectorAll(".mcard__who > li")].map(
    (li) =>
      `${li.querySelector(".ac-rolemark") ? "◉" : li.querySelector(".ac-avatar") ? "☺" : ""}${[...li.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join("")}`,
  );

describe("a person's card", () => {
  test("the owner sees their roles as chips with round marks, ✕ only on givable ones, and + with the givable ones", async () => {
    const { state } = await go(withRoles());
    const c = await openCard("João");
    expect(chips(c)).toEqual([
      { name: "Diretoria", mark: true, removable: false },
      { name: "Admin", mark: true, removable: true },
    ]);
    await press(within(c).getByRole("button", { name: "Papéis de João" }));
    const picker = screen().getByRole("menu", { name: "Papéis de João" });
    const options = within(picker).getAllByRole("menuitemcheckbox");
    expect(options.map((o) => [o.textContent, o.getAttribute("aria-checked")])).toEqual([
      ["Admin", "true"],
      ["Comercial", "false"],
    ]);
    await click(options[1] as HTMLElement);
    await settle(4);
    expect(state.calls.filter((x) => x.method === "roles.setFor").at(-1)?.args).toEqual([
      ORG_ID,
      "u-joao",
      [ADMIN_ROLE_ID, diretoria.id, comercial.id],
    ]);
  });

  test("✕ takes the role away", async () => {
    const { state } = await go(withRoles());
    const c = await openCard("João");
    await click(within(c).getByRole("button", { name: "Remover Admin" }));
    await settle(4);
    expect(state.calls.find((x) => x.method === "roles.setFor")?.args).toEqual([ORG_ID, "u-joao", [diretoria.id]]);
  });

  test("the owner's card says Dono, a chip that stays; no box on your own card", async () => {
    await go(withRoles());
    const c = await openCard("Walter");
    expect(chips(c)).toEqual([{ name: "Dono", mark: true, removable: false }]);
    expect(within(c).queryByRole("textbox")).toBeNull();
  });

  test("a plain member sees the chips without ✕ or +", async () => {
    const state = withRoles();
    viewAs(state, "u-walter");
    await go(state);
    const c = await openCard("João");
    expect(chips(c).map((x) => x.removable)).toEqual([false, false]);
    expect(within(c).queryByRole("button", { name: "Papéis de João" })).toBeNull();
    expect(c.textContent).toContain("@joao");
    expect(c.textContent).toContain("No workspace desde");
  });

  test("the box opens the DM and sends the text", async () => {
    const { state, router } = await go(seedState());
    const c = await openCard("João");
    const box = within(c).getByRole("textbox", { name: "Mensagem para João" });
    await act(async () => fireEvent.change(box, { target: { value: "Bom dia!" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(6);
    expect(state.calls.find((x) => x.method === "dms.open")?.args).toEqual([ORG_ID, { userId: "u-joao" }]);
    const post = state.calls.find((x) => x.method === "chat.post");
    expect((post?.args[2] as { body: string } | undefined)?.body).toBe("Bom dia!");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/person/u-joao`);
  });

  test("in a workspace being deleted the box says why nothing can be sent there", async () => {
    const state = seedState();
    for (const org of state.me?.organizations ?? [])
      org.deletion = {
        dueAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
        requestedAt: null,
        requestedBy: null,
      };
    await go(state);
    const c = await openCard("João");
    expect(within(c).queryByRole("textbox", { name: "Mensagem para João" })).toBeNull();
    expect(
      within(c).getByText("Você não pode enviar mensagens enquanto este workspace está sendo apagado"),
    ).toBeTruthy();
  });

  test("⋯ lists the right click's entries, Copiar ID last", async () => {
    await go(seedState());
    const c = await openCard("João");
    await press(within(c).getByRole("button", { name: "Mais" }));
    const items = within(screen().getByRole("menu", { name: "Mais" }))
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items).toEqual([
      "Mensagem direta",
      "Fixar no topo",
      "Mencionar",
      "Copiar @joao",
      "Remover do workspace",
      "Copiar ID",
    ]);
    await click(within(screen().getByRole("menu", { name: "Mais" })).getByRole("menuitem", { name: "Copiar ID" }));
    expect(copied.at(-1)).toBe("u-joao");
  });
});

describe("an agent's card", () => {
  test("Quem pode falar: its roles, then its people, as plain lines, and that its owner always can", async () => {
    const state = withRoles();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.audience = { mode: "people", userIds: ["u-walter"], roleIds: [comercial.id, ADMIN_ROLE_ID] };
    await go(state);
    const c = await openCard("Ada");
    expect(lines(c)).toEqual(["◉Admin", "◉Comercial", "☺Walter"]);
    expect(c.textContent).toContain("João sempre pode, como responsável.");
    expect(within(c).getByRole("region", { name: "Quem pode falar" }).querySelector(".ac-token, .ac-chip")).toBeNull();
  });

  test("everyone and only its owner", async () => {
    const state = seedState();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.audience = { mode: "owner", userIds: [] };
    await go(state);
    expect(lines(await openCard("Ada"))).toEqual(["◉Todos do workspace"]);
    cleanup();
    await go(state);
    const c = await openCard("Atlas");
    expect(lines(c)).toEqual(["☺João"]);
    expect(c.textContent).not.toContain("sempre pode");
  });

  test("Editar for who manages agents saves the audience the Settings tab's way", async () => {
    const { state } = await go(seedState());
    const c = await openCard("Ada");
    await click(within(c).getByRole("button", { name: "Editar" }));
    await settle(3);
    const editor = screen().getByRole("dialog", { name: "Quem pode falar com a Ada" });
    await click(within(editor).getByRole("radio", { name: /^Só o responsável/ }));
    await click(within(editor).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((x) => x.method === "agents.update")?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { audience: { mode: "owner", userIds: [], roleIds: [], consultable: true } },
    ]);
  });

  test("Editar for its owner too, not for anyone else", async () => {
    const owner = seedState();
    viewAs(owner, "u-joao");
    await go(owner);
    expect(within(await openCard("Ada")).getByRole("button", { name: "Editar" })).toBeTruthy();
    cleanup();
    const other = seedState();
    viewAs(other, "u-walter");
    await go(other);
    const c = await openCard("Ada");
    expect(within(c).getByRole("region", { name: "Quem pode falar" })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: "Editar" })).toBeNull();
  });

  test("⋯ lists the right click's entries, Copiar ID last", async () => {
    await go(seedState());
    const c = await openCard("Ada");
    await press(within(c).getByRole("button", { name: "Mais" }));
    const items = within(screen().getByRole("menu", { name: "Mais" }))
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(items).toEqual([
      "Mensagem direta",
      "Ver perfil",
      "Abrir o computador",
      "Fixar no topo",
      "Mencionar",
      "Copiar @ada",
      "Editar agente",
      "Copiar link",
      "Copiar ID",
    ]);
  });

  test("Sem IA is a row of its own under the names, the card's gap above it", async () => {
    const state = seedState();
    state.aiStatus = { any: true, agents: [{ agentId: ADA_ID, state: "no_ai", reason: "no_key" }] } as never;
    await go(state);
    const c = await openCard("Ada");
    const chip = within(c).getByText("Sem IA").closest(".noai-chip");
    expect(chip?.parentElement?.classList.contains("profile-card__body")).toBe(true);
    expect(chip?.previousElementSibling?.classList.contains("mcard__names")).toBe(true);
  });

  test("the box sends to its DM", async () => {
    const { state, router } = await go(seedState());
    const c = await openCard("Ada");
    const box = within(c).getByRole("textbox", { name: "Mensagem para a Ada" });
    await act(async () => fireEvent.change(box, { target: { value: "Pode revisar o PR?" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(6);
    expect(state.calls.find((x) => x.method === "dms.open")?.args).toEqual([ORG_ID, { agentId: ADA_ID }]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
  });
});

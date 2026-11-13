import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { NewChannelDialog } from "@/components/NewChannelDialog";
import { ADMIN_ROLE_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const go = async (channel: string) => {
  const state = seedState();
  await renderApp(`/org/${ORG_ID}/c/${channel}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
/** "Quem pode entrar" is a dropdown: open it and pick. */
const access = async (dialog: HTMLElement, option: RegExp) => {
  const trigger = within(dialog).getByRole("combobox", { name: "Quem pode entrar" });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
};
/** "Papéis que veem o canal", its own dialog: tick these and "Pronto". */
const rolesDialog = () => screen().getByRole("dialog", { name: "Papéis que veem o canal" });
const pickRoles = async (...names: RegExp[]) => {
  const d = rolesDialog();
  for (const name of names) await click(within(d).getByRole("checkbox", { name }));
  await click(within(d).getByRole("button", { name: "Pronto" }));
  await settle(3);
};
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args.at(-1));

describe("a channel for departments or roles (ADR 0125)", () => {
  test("Criar canal: the third choice asks for a role, then creates it private and limited to the roles ticked", async () => {
    const state = await go(GENERAL_ID);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    const plus = within(nav).getByRole("button", { name: "Novo canal ou categoria" });
    await act(async () => {
      fireEvent.keyDown(plus, { key: "Enter" });
      fireEvent.keyUp(plus, { key: "Enter" });
    });
    await settle(2);
    await click(screen().getByRole("menuitem", { name: "Novo canal" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    await act(async () => fireEvent.change(within(dialog).getByLabelText("Nome"), { target: { value: "vendas" } }));
    await access(dialog, /Departamentos ou papéis/);
    await settle(3);
    // No role yet: their dialog opens by itself. Closed without one, the channel isn't created.
    await click(within(rolesDialog()).getByRole("button", { name: "Cancelar" }));
    await settle(2);
    await click(within(dialog).getByRole("button", { name: "Criar #vendas" }));
    await settle(3);
    expect(calls(state, "chat.createChannel")).toEqual([]);
    expect(dialog.textContent).toContain("Escolha pelo menos um papel.");

    await click(within(dialog).getByRole("button", { name: "Escolher papéis" }));
    await settle(2);
    await pickRoles(/Admin/);
    // The role picked, under the field, removable.
    expect(within(dialog).getByRole("button", { name: "Remover Admin" })).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Criar #vendas" }));
    await settle(6);
    expect(calls(state, "chat.createChannel")).toEqual([
      { name: "vendas", visibility: "private", audienceRoleIds: [ADMIN_ROLE_ID] },
    ]);
  });

  test("Detalhes do canal: changed later, saved once a role is ticked; back to Público drops the roles", async () => {
    const state = await go(ENG_ID);
    await click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    // "Quem pode entrar" lives under Permissões (ADR 0134).
    await click(within(dialog).getByRole("button", { name: "Permissões" }));
    await settle(2);
    await access(dialog, /Departamentos ou papéis/);
    await settle(3);
    expect(calls(state, "chat.update")).toEqual([]);
    await pickRoles(/Admin/);
    expect(calls(state, "chat.update")).toEqual([{ visibility: "private", audienceRoleIds: [ADMIN_ROLE_ID] }]);

    // Removing the last role saves nothing, and says why.
    await click(within(dialog).getByRole("button", { name: "Remover Admin" }));
    await settle(3);
    expect(calls(state, "chat.update")).toHaveLength(1);
    expect(dialog.textContent).toContain("Escolha pelo menos um papel.");
    await click(within(dialog).getByRole("button", { name: "Escolher papéis" }));
    await settle(2);
    await pickRoles(/Admin/);
    expect(calls(state, "chat.update")).toHaveLength(2);

    // Going public opens every message to the workspace: asked first.
    await access(dialog, /Público/);
    await settle(3);
    expect(calls(state, "chat.update")).toHaveLength(2);
    const ask = screen().getByRole("dialog", { name: "Tornar #eng público?" });
    await click(within(ask).getByRole("button", { name: "Cancelar" }));
    await settle(3);
    expect(calls(state, "chat.update")).toHaveLength(2);

    const again = screen().getByRole("dialog", { name: /^#eng/ });
    await access(again, /Público/);
    await settle(3);
    await click(
      within(screen().getByRole("dialog", { name: "Tornar #eng público?" })).getByRole("button", {
        name: "Tornar público",
      }),
    );
    await settle(3);
    expect(calls(state, "chat.update").at(-1)).toEqual({ visibility: "public" });
  });
});

describe("a group conversation in a personal workspace (ADR 0159)", () => {
  /** The seeded workspace as a personal one; `alone`: Walter its only member. */
  const personal = (alone: boolean) => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.mode = "personal";
    if (alone) state.members = state.members.filter((m) => m.userId === state.me?.user.id);
    return state;
  };
  const openDialog = async (alone: boolean) => {
    await renderPage(<NewChannelDialog open onOpenChange={() => {}} />, {
      api: createFakeApi(personal(alone)),
      org: true,
    });
    await settle(4);
    return screen().getByRole("dialog", { name: "Nova conversa em grupo" });
  };

  test("alone, who can join stays open to everyone here, out of sight; the same channel is created", async () => {
    const dialog = await openDialog(true);
    expect(within(dialog).queryByRole("combobox", { name: "Quem pode entrar" })).toBeNull();
    expect(dialog.textContent).toContain("Quem participa");
  });

  test("with family, plain words and no roles to pick: Admin already sees every group conversation", async () => {
    const dialog = await openDialog(false);
    const trigger = within(dialog).getByRole("combobox", { name: "Quem pode entrar" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    const options = screen()
      .getAllByRole("option")
      .map((o) => o.textContent ?? "");
    expect(options.some((o) => o.startsWith("Todos daqui podem entrar"))).toBe(true);
    expect(options.some((o) => o.startsWith("Só quem eu adicionar"))).toBe(true);
    expect(options.some((o) => o.includes("Departamentos ou papéis"))).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, GENERAL_ID, meWithRole, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Apagar canal in the channel's settings: owners and admins, never #general, its name typed to confirm. */

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const go = async (channel: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${channel}`, { api: createFakeApi(state) });
  await settle(8);
  const header = document.querySelector(".channel__header") as HTMLElement;
  await click(within(header).getByRole("button", { name: "Configurações do canal" }));
  await settle(4);
  return { ...r, state };
};
const details = (name: string) => screen().getByRole("dialog", { name: new RegExp(`^#${name}`) });

describe("who sees Apagar canal", () => {
  test("the owner, beside Arquivar; never on #general", async () => {
    await go(ENG_ID);
    expect(within(details("eng")).getByRole("button", { name: "Arquivar canal" })).toBeTruthy();
    expect(within(details("eng")).getByRole("button", { name: "Apagar canal" })).toBeTruthy();
    cleanup();
    await go(GENERAL_ID);
    expect(within(details("general")).queryByRole("button", { name: "Apagar canal" })).toBeNull();
  });

  test("whoever made the channel archives it, and only owners and admins delete it", async () => {
    const state = seedState();
    meWithRole(state, ["create_channels"]);
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) Object.assign(eng, { createdByUserId: state.me?.user.id, isMember: true });
    await go(ENG_ID, state);
    expect(within(details("eng")).getByRole("button", { name: "Arquivar canal" })).toBeTruthy();
    expect(within(details("eng")).queryByRole("button", { name: "Apagar canal" })).toBeNull();
  });
});

test("the name typed to confirm, then the channel is gone and its page left", async () => {
  const { state, router } = await go(ENG_ID);
  await click(within(details("eng")).getByRole("button", { name: "Apagar canal" }));
  await settle(3);
  const ask = screen().getByRole("dialog", { name: "Apagar o #eng de vez?" });
  expect(ask.textContent).toContain("arquive o canal");
  // A public channel's tasks stay for the whole workspace: only a private one's go.
  expect(ask.textContent).not.toContain("As tarefas dele saem");
  const confirm = within(ask).getByRole("button", { name: "Apagar canal" }) as HTMLButtonElement;
  const field = within(ask).getByLabelText("Digite eng para confirmar");
  await act(async () => fireEvent.change(field, { target: { value: "en" } }));
  expect(confirm.disabled).toBe(true);
  await act(async () => fireEvent.change(field, { target: { value: "#ENG" } }));
  expect(confirm.disabled).toBe(false);
  await click(confirm);
  await settle(6);
  expect(state.calls.find((c) => c.method === "chat.deleteChannel")?.args).toEqual([ORG_ID, ENG_ID, "#ENG"]);
  expect(document.body.textContent).toContain("#eng foi apagado.");
  expect(router.state.location.pathname).not.toContain(ENG_ID);
  expect(screen().queryByRole("dialog", { name: /^#eng/ })).toBeNull();
});

test("Canais arquivados, in Canais' +: the archived channels this person may bring back, each with Restaurar", async () => {
  const state = seedState();
  state.archivedChannels = [
    { id: "ch-old", name: "lancamento", topic: "", visibility: "public", archivedAt: "2026-11-01T12:00:00.000Z" },
    // The worst case the dialog lays out: a name as long as a channel's may be, private.
    {
      id: "ch-long",
      name: "operacoes-de-atendimento-ao-cliente-enterprise-america-latina-e-europa-2026",
      topic: "",
      visibility: "private",
      archivedAt: "2026-10-30T09:00:00.000Z",
    },
  ];
  const r = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
  const plus = within(nav).getByRole("button", { name: "Novo canal ou categoria" });
  await act(async () => {
    fireEvent.keyDown(plus, { key: "Enter" });
    fireEvent.keyUp(plus, { key: "Enter" });
  });
  await settle(2);
  await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Canais arquivados" }));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Canais arquivados" });
  expect(dialog.textContent).toContain("#lancamento");
  await click(within(dialog).getByRole("button", { name: "Restaurar #lancamento" }));
  await settle(6);
  expect(state.calls.find((c) => c.method === "chat.unarchive")?.args).toEqual([ORG_ID, "ch-old"]);
  expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/ch-old`);
  expect(screen().queryByRole("dialog", { name: "Canais arquivados" })).toBeNull();
});

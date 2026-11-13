import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, meAsAdmin, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** Membros › the person › "Gerar link de senha nova", on a server that sends no email (ADR 0158). */

afterEach(() => {
  localStorage.clear();
  cleanup();
});

const click = (el: Element) => act(async () => fireEvent.click(el));

async function members(state: ReturnType<typeof seedState>) {
  await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
  await settle(6);
}

test("an owner makes the link for a member and copies it; their own row has none", async () => {
  const state = seedState();
  state.authConfig = { passwordReset: false };
  await members(state);
  expect(screen().queryByRole("button", { name: "Mais de Wesley" })).toBeNull();
  // Radix opens the menu as the pointer goes down, never on the click.
  await act(async () =>
    fireEvent.pointerDown(screen().getByRole("button", { name: "Mais de João" }), { button: 0, ctrlKey: false }),
  );
  await settle(2);
  await click(screen().getByRole("menuitem", { name: /Gerar link de senha nova/ }));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Link de senha nova para João" });
  expect(within(dialog).getByText("Funciona uma vez, por 1 hora. Mande por onde vocês conversam.")).toBeTruthy();
  expect((within(dialog).getByLabelText("Link") as HTMLInputElement).value).toBe(
    "https://agentes.example.com/reset-password?token=link-for-u-joao",
  );
  expect(state.calls.filter((c) => c.method === "orgs.passwordLink")).toHaveLength(1);
  expect(
    within(dialog)
      .getByRole("button", { name: /Copiar link/ })
      .hasAttribute("disabled"),
  ).toBe(false);
});

test("not where the server emails the person their own link, nor for someone who isn't an owner", async () => {
  const emails = seedState();
  emails.authConfig = { passwordReset: true };
  await members(emails);
  expect(screen().queryByRole("button", { name: "Mais de João" })).toBeNull();
  cleanup();
  const admin = seedState();
  admin.authConfig = { passwordReset: false };
  meAsAdmin(admin);
  await members(admin);
  expect(screen().queryByRole("button", { name: /^Mais de/ })).toBeNull();
});

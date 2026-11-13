import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { OrgRole } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedRoles, seedState } from "./fake-api";
import { endExit, exitsLast, renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

/** A workspace with a third role, "Suporte", holding nothing of the computers. */
async function openRole(name: string) {
  const state = seedState();
  const [admin, everyone] = seedRoles() as [OrgRole, OrgRole];
  state.roles = [
    admin,
    { ...admin, id: "role-support", name: "Suporte", position: 1, permissions: [], hoist: false },
    everyone,
  ];
  const api = createFakeApi(state);
  await renderApp(`/org/${ORG_ID}/settings/roles`, { api });
  await settle(6);
  const row = screen()
    .getAllByRole("button")
    .find((b) => b.className.includes("roles-row") && b.querySelector("b")?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  await click(row);
  await settle(4);
  const saved = () =>
    state.calls
      .filter((c) => c.method === "roles.update")
      .map((c) => (c.args.at(-1) as { permissions: string[] }).permissions);
  return { choice: () => screen().getByRole("radiogroup", { name: "Computadores dos agentes" }), saved, api, state };
}

const checked = (group: HTMLElement) =>
  within(group)
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;

describe("the agents' computers on a role's page: one choice of three", () => {
  test("Todos: the whole computer of their own agents by default; Só o navegador and Nenhum save one key or none", async () => {
    const { choice, saved } = await openRole("Todos");
    expect(
      within(choice())
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Nenhum", "Só o navegador", "Computador inteiro"]);
    expect(checked(choice())).toBe("Computador inteiro");
    expect(
      screen().getByText("A tela inteira e o terminal dos próprios agentes e dos computadores que a pessoa conectou"),
    ).toBeTruthy();
    await click(within(choice()).getByRole("radio", { name: "Só o navegador" }));
    await settle(4);
    expect(saved().at(-1)).toContain("own_browsers");
    expect(saved().at(-1)).not.toContain("own_computers");
    expect(checked(choice())).toBe("Só o navegador");
    await click(within(choice()).getByRole("radio", { name: "Nenhum" }));
    await settle(4);
    expect(
      saved()
        .at(-1)
        ?.filter((k) => k.includes("browsers") || k.includes("computers")),
    ).toEqual(["pair_computers"]);
    expect(
      screen().getByText("Ninguém vê nem usa os computadores ou navegadores dos agentes, nem os pedidos de login"),
    ).toBeTruthy();
  });

  test("another role chooses for every agent: Só o navegador is control_browsers, never the key one by one", async () => {
    const { choice, saved } = await openRole("Suporte");
    expect(checked(choice())).toBe("Nenhum");
    await click(within(choice()).getByRole("radio", { name: "Só o navegador" }));
    await settle(4);
    expect(saved().at(-1)).toEqual(["control_browsers"]);
    await click(within(choice()).getByRole("radio", { name: "Computador inteiro" }));
    await settle(4);
    expect(saved().at(-1)).toEqual(["control_computers"]);
    expect(screen().getByText("A tela inteira, o controle e o terminal de qualquer agente")).toBeTruthy();
    // Item by item, the tools show no separate switch for the computers.
    await click(screen().getByRole("button", { name: /Ajustar Apps e computadores/ }));
    await settle(2);
    expect(screen().queryByText("Usar o navegador dos agentes")).toBeNull();
  });

  test("Admin: the whole computer, shown and not changed there", async () => {
    const { choice } = await openRole("Admin");
    expect(checked(choice())).toBe("Computador inteiro");
    expect(choice().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("Usar planos de outras pessoas (ADR 0059 §3): one key in Apps e computadores", () => {
  test("its line under its name, and another role turns it on by itself", async () => {
    const { saved } = await openRole("Suporte");
    await click(screen().getByRole("button", { name: /Ajustar Apps e computadores/ }));
    await settle(2);
    expect(screen().getByText("Usar planos de outras pessoas")).toBeTruthy();
    expect(
      screen().getByText(
        "Dar aos agentes que pode editar um plano que outra pessoa conectou. O dono recebe um e-mail e pode tirar de volta.",
      ),
    ).toBeTruthy();
    await click(screen().getByRole("switch", { name: /Usar planos de outras pessoas/ }));
    await settle(4);
    expect(saved().at(-1)).toEqual(["use_others_plans"]);
  });
});

describe("Mencionar todos (`@todos`): one key in Conversas", () => {
  test("off for another role until it is turned on by itself", async () => {
    const { saved } = await openRole("Suporte");
    await click(screen().getByRole("button", { name: /Ajustar Conversas/ }));
    await settle(2);
    expect(screen().getByText("Usar @todos para avisar todo mundo de um canal, pessoas e agentes.")).toBeTruthy();
    const toggle = screen().getByRole("switch", { name: /Mencionar todos/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await click(toggle);
    await settle(4);
    expect(saved().at(-1)).toEqual(["mention_everyone"]);
  });
});

describe("Adicionar pessoas to a role", () => {
  test("the ones being added keep their rows, and nobody reads as having it, while it adds and closes", async () => {
    const { api, state } = await openRole("Suporte");
    const setFor = api.roles.setFor;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    api.roles.setFor = async (...args) => {
      const saved = await setFor(...args);
      await answered;
      return saved;
    };
    exitsLast();
    await click(screen().getByRole("button", { name: "Adicionar pessoas" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Adicionar a Suporte" });
    const rows = () => [...dialog.querySelectorAll(".roles-pick__row")].map((r) => r.textContent);
    const listed = rows();
    expect(listed.length).toBeGreaterThan(0);
    for (const row of dialog.querySelectorAll(".roles-pick__row")) await click(row);
    await click(within(dialog).getByRole("button", { name: `Adicionar ${listed.length}` }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "roles.setFor")).toBe(true);
    expect(rows()).toEqual(listed);
    expect(dialog.textContent).not.toContain("Todo mundo já tem");
    await act(async () => answer());
    await settle(6);
    expect(dialog.getAttribute("data-state")).toBe("closed");
    expect(rows()).toEqual(listed);
    expect(dialog.textContent).not.toContain("Todo mundo já tem");
    await endExit(dialog);
    expect(dialog.isConnected).toBe(false);
  });
});

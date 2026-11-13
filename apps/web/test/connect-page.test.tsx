import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { formatUserCode, locationText, normalizeUserCode } from "@agenteschat/client/lib/machines";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const CODE = "K7Q4ZP";

/** `/conectar?code=` with a computer waiting for that code (ADR 0036 §5). */
async function open(path = `/conectar?code=${CODE}`, device = true) {
  const state = seedState();
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  if (device) machines.addDevice(CODE);
  const r = await renderApp(path, { api });
  await settle(6);
  return { ...r, state, api, machines };
}

const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);

describe("/conectar: confirm a computer's code", () => {
  test("signed out: sign in first, then come back with the code", async () => {
    const { router } = await renderApp(`/conectar?code=${CODE}`, { api: createFakeApi(seedState({ me: null })) });
    expect(router.state.location.pathname).toBe("/login");
    expect(String((router.state.location.search as { redirect?: string }).redirect)).toContain(`code=${CODE}`);
  });

  test("shows the code, the computer and the warning; Conectar joins the chosen organization", async () => {
    const { state, router } = await open();
    expect(document.querySelector(".connect-page__code")?.textContent).toBe("K7Q·4ZP");
    const page = document.querySelector(".connect-page") as HTMLElement;
    expect(page.textContent).toContain("MacBook do Walter");
    expect(page.textContent).toContain("macOS · walter-mbp");
    expect(page.textContent).toContain("Perto de Curitiba, PR, Brasil");
    expect(page.textContent).toContain("Pediu agora");
    expect(page.textContent).toContain("Só confirme se você acabou de abrir isso no seu computador.");
    expect(within(page).getByRole("combobox", { name: "Workspace" }).textContent).toContain("Acme");
    const name = within(page).getByLabelText("Nome do computador") as HTMLInputElement;
    expect(name.value).toBe("MacBook do Walter");
    await act(async () => fireEvent.change(name, { target: { value: "Mac do escritório" } }));
    await click(within(page).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(calls(state, "machines.confirmDevice")).toEqual([[ORG_ID, CODE, { name: "Mac do escritório" }]]);
    expect(document.body.textContent).toContain("Pronto. Pode voltar para o computador.");
    expect(document.body.textContent).toContain("Mac do escritório entrou na Acme. Nenhum agente usa ainda");
    const link = screen().getByRole("link", { name: "Ver o computador" });
    await click(link);
    await settle(6);
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${ORG_ID}/settings/devices/.+`));
  });

  test("Não fui eu: the computer isn't connected", async () => {
    const { state } = await open();
    await click(screen().getByRole("button", { name: "Não fui eu" }));
    await settle(4);
    expect(calls(state, "machines.denyDevice")).toEqual([[CODE]]);
    expect(calls(state, "machines.confirmDevice")).toEqual([]);
    expect(document.body.textContent).toContain("O computador não foi conectado.");
  });

  test("an unknown or expired code says so and asks to start again on the computer", async () => {
    await open(`/conectar?code=${CODE}`, false);
    expect(screen().getByText("Código expirado")).toBeTruthy();
    expect(document.body.textContent).toContain("Esse código expirou. Comece de novo no computador.");
    expect(screen().queryByRole("button", { name: "Conectar" })).toBeNull();
  });

  test("a code that expires while the page is open, or is gone when confirming", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
    machines.addDevice(CODE, { expiresAt: new Date(Date.now() + 40).toISOString() });
    await renderApp(`/conectar?code=${CODE}`, { api });
    await settle(2);
    await act(() => new Promise((r) => setTimeout(r, 80)));
    await settle(2);
    expect(document.body.textContent).toContain("Esse código expirou.");
    cleanup();

    const again = await open();
    // Someone used it elsewhere meanwhile.
    await again.api.machines.denyDevice(CODE);
    await click(screen().getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(document.body.textContent).toContain("Esse código expirou. Comece de novo no computador.");
  });

  test("a reconnect: Reconectar o {nome}, no organization or name to pick; the same computer comes back", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
    const mac = machines.pair({ name: "Mac da Ana", online: false });
    machines.addDevice(CODE, {
      reconnect: { machineId: mac.id, name: "Mac da Ana", orgId: ORG_ID, orgName: "Acme" },
    });
    await renderApp(`/conectar?code=${CODE}`, { api });
    await settle(6);
    const page = document.querySelector(".connect-page") as HTMLElement;
    expect(within(page).getByRole("heading", { name: "Reconectar o Mac da Ana?" })).toBeTruthy();
    expect(page.textContent).toContain("Os agentes que usavam este computador voltam a usar.");
    expect(page.textContent).toContain("Na Acme, com o mesmo nome e as mesmas permissões.");
    expect(within(page).queryByRole("combobox", { name: "Workspace" })).toBeNull();
    expect(within(page).queryByLabelText("Nome do computador")).toBeNull();
    await click(within(page).getByRole("button", { name: "Reconectar" }));
    await settle(4);
    expect(calls(state, "machines.confirmDevice")).toEqual([[ORG_ID, CODE, {}]]);
    expect(document.body.textContent).toContain("Computador reconectado");
    expect(document.body.textContent).toContain("Mac da Ana voltou para a Acme.");
    expect(machines.all()).toHaveLength(1);
  });

  test("no code in the link", async () => {
    await open("/conectar", false);
    expect(document.body.textContent).toContain("Falta o código. Abra o link que aparece no computador.");
  });

  test("code helpers: normalized, shown as K7Q·4ZP; location text", () => {
    expect(normalizeUserCode("k7q·4zp ")).toBe("K7Q4ZP");
    expect(normalizeUserCode("K7Q-4ZP")).toBe("K7Q4ZP");
    expect(formatUserCode("k7q4zp")).toBe("K7Q·4ZP");
    expect(locationText({ city: "Curitiba", region: "PR", country: null })).toBe("Curitiba, PR");
    expect(locationText("  ")).toBeNull();
    expect(locationText(null)).toBeNull();
  });
});

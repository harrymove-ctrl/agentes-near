import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ApiClient, keys, type WebhookSetup } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** A GitHub or Sentry event routine: the form sets up that service's webhook in place, Testar turns it green. */

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const pick = async (combobox: HTMLElement, option: RegExp) => {
  combobox.focus();
  await act(async () => {
    fireEvent.keyDown(combobox, { key: "Enter" });
    fireEvent.keyUp(combobox, { key: "Enter" });
  });
  await click(within(screen().getByRole("listbox")).getByRole("option", { name: option }));
  await settle(4);
};

async function newRoutineForm(api: ApiClient) {
  const { services } = await renderApp(`/org/${ORG_ID}/routines`, { api });
  await settle(8);
  await click(screen().getAllByRole("button", { name: "Nova rotina" })[0] as HTMLElement);
  await settle(4);
  const form = screen().getByRole("dialog", { name: "Nova rotina" });
  await click(within(form).getByRole("radio", { name: "Evento" }));
  await settle(6);
  return { form, qc: services.queryClient };
}

describe("Rotinas: a GitHub or Sentry event's webhook", () => {
  test("picking the event makes the webhook and shows where it goes; the Client Secret is pasted in place", async () => {
    const state = seedState();
    const { form } = await newRoutineForm(createFakeApi(state));
    expect(state.calls.some((c) => c.method === "routines.ensureWebhook" && c.args[0] === "sentry")).toBe(true);
    expect(form.textContent).toContain("Webhook do Sentry");
    expect(form.textContent).toContain("No Sentry, crie uma integração interna.");
    // Sentry greys out the issue webhook until the integration may read issues.
    expect(form.textContent).toContain("Em Permissions, deixe Issue & Event em Read.");
    expect(form.textContent).toMatch(/https:\/\/app\.agentes\.test\/api\/webhooks\/sentry\/\S+/);
    const link = within(form).getByRole("link", { name: "Abrir no Sentry" });
    expect(link.getAttribute("href")).toContain("sentry.io");

    const save = within(form).getByRole("button", { name: "Salvar" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await type(within(form).getByLabelText("Client Secret da integração"), "sentry-client-secret-1234");
    await click(save);
    await settle(4);
    expect(state.calls.find((c) => c.method === "routines.setWebhookSecret")?.args).toEqual([
      "sentry",
      "sentry-client-secret-1234",
    ]);
  });

  test("Revisar PRs novos waits on a new PR and shows GitHub's steps, the individual events named", async () => {
    const state = seedState();
    const { form } = await newRoutineForm(createFakeApi(state));
    await pick(within(form).getByRole("combobox", { name: "Começar de um modelo" }), /Revisar PRs novos/);
    expect(within(form).getByRole("combobox", { name: "Evento" }).textContent).toContain("PR aberto no GitHub");
    expect(state.calls.some((c) => c.method === "routines.ensureWebhook" && c.args[0] === "github")).toBe(true);
    expect(form.textContent).toContain("Webhook do GitHub");
    expect(form.textContent).toMatch(/https:\/\/app\.agentes\.test\/api\/webhooks\/github\/\S+/);
    // GitHub's form starts on "Just the push event": the step names the choice that reaches pull requests.
    expect(form.textContent).toContain("Em Which events, escolha Let me select individual events.");
  });

  test("Testar waits for the first call and turns green once it comes", async () => {
    const state = seedState();
    const base = createFakeApi(state);
    let called: string | null = null;
    let lists = 0;
    const api: ApiClient = {
      ...base,
      routines: {
        ...base.routines,
        list: (orgId) => {
          lists += 1;
          return base.routines.list(orgId);
        },
        webhookSetup: async (orgId, provider): Promise<WebhookSetup> => ({
          ...(await base.routines.webhookSetup(orgId, provider)),
          receivedAt: called,
        }),
      },
    };
    const { form, qc } = await newRoutineForm(api);
    const key = keys.webhookSetup(ORG_ID, "sentry");
    const every = () =>
      qc
        .getQueryCache()
        .find({ queryKey: key })
        ?.observers.map((o) => o.options.refetchInterval);
    expect(every()).toEqual([false]);
    await click(within(form).getByRole("button", { name: "Testar" }));
    await settle(4);
    expect(form.textContent).toContain("Esperando o Sentry.");
    expect(within(form).getByRole("button", { name: "Testar" }).hasAttribute("disabled")).toBe(true);
    // Asked again every few seconds while it waits.
    expect(every()).toEqual([3000]);
    called = new Date().toISOString();
    const listed = lists;
    await act(async () => qc.refetchQueries({ queryKey: key, type: "active" }));
    await settle(4);
    expect(form.textContent).toContain("Funcionando. O Sentry já manda os eventos para cá.");
    // The routines waiting on it are read again, out of "Ainda não roda".
    expect(lists).toBe(listed + 1);
    expect(every()).toEqual([false]);
  });
});

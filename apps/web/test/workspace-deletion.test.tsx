import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, keys, type OrgDeletion, type OrgSummary, type Role } from "@agenteschat/client";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, meAsAdmin, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const BETA_ID = "00000000-0000-4000-8000-0000000000b2";
const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** The onboarding's account menu, on its rail (Radix: keyboard), and the menu it opens. */
async function accountMenu() {
  const me = screen().getByRole("button", { name: "Sua conta" });
  me.focus();
  await act(async () => {
    fireEvent.keyDown(me, { key: "Enter" });
    fireEvent.keyUp(me, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu");
}
const meEvery = (qc: QueryClient) =>
  qc
    .getQueryCache()
    .find({ queryKey: keys.me })
    ?.observers.map((o) => o.options.refetchInterval);

/** Acme with this person's role (and its deletion or standing, when there is one), and Beta, at `path`. */
async function open(
  path: string,
  {
    role = "owner",
    name = "Acme",
    deletion,
    standing,
    createdAt,
    beta = { id: BETA_ID, name: "Beta", role: "member" },
    state = seedState(),
  }: {
    role?: Role;
    name?: string;
    deletion?: OrgDeletion;
    standing?: OrgSummary["standing"];
    createdAt?: string;
    /** Null: Acme is their only workspace. */
    beta?: OrgSummary | null;
    state?: ReturnType<typeof seedState>;
  } = {},
) {
  if (!state.me) throw new Error("signed in");
  state.me.organizations = [
    {
      id: ORG_ID,
      name,
      role,
      ...(deletion ? { deletion } : {}),
      ...(standing ? { standing } : {}),
      ...(createdAt ? { createdAt } : {}),
    },
    ...(beta ? [beta] : []),
  ];
  const r = await renderApp(path, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
}

describe("deleting a workspace (Configurações › Geral)", () => {
  test("only its owners get the card", async () => {
    await open(`/org/${ORG_ID}/settings`);
    const card = screen().getByRole("region", { name: "Apagar workspace" });
    expect(card.textContent).toContain(
      "Acme fica só para leitura para todos agora. Ele é apagado de vez depois de 7 dias.",
    );
    expect(within(card).getByRole("button", { name: "Apagar workspace…" })).toBeTruthy();
    for (const admin of [true, false]) {
      cleanup();
      const state = seedState();
      if (admin) meAsAdmin(state);
      // Not even from the address the phone opens.
      await open(`/org/${ORG_ID}/settings/general?delete=1`, { role: "member", state });
      expect(screen().queryByRole("region", { name: "Apagar workspace" })).toBeNull();
      expect(screen().queryByRole("dialog")).toBeNull();
    }
  });

  test("the name, typed with its invisible characters ignored, then the code from the email, before it deletes", async () => {
    // A co-owner put a zero-width space in the name: typing it plainly still confirms.
    const { state, router } = await open(`/org/${ORG_ID}/settings`, { name: "Ac\u200bme" });
    const email = state.me?.user.email ?? "";
    await click(screen().getByRole("button", { name: "Apagar workspace…" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Apagar Ac\u200bme?" });
    expect(dialog.textContent).toContain("Qualquer dono pode restaurar até");
    expect(dialog.textContent).toContain("Todos passam a só ler e recebem um email");
    expect(dialog.textContent).toContain(`Vamos mandar um código para ${email} para confirmar que é você.`);
    const send = within(dialog).getByRole("button", { name: "Enviar código" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Ac\u200bme para confirmar"), "acm");
    expect(send.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Ac\u200bme para confirmar"), " ACME ");
    await click(send);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.deletionCode").map((c) => c.args)).toEqual([[ORG_ID]]);
    expect(dialog.textContent).toContain(`Mandamos para ${email}. Vale por 10 minutos.`);
    // Another code only after a minute.
    expect(
      within(dialog)
        .getByRole("button", { name: /^Enviar outro em \d:\d\d$/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    const submit = within(dialog).getByRole("button", { name: "Apagar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    // Pasted with its space: the digits are what count.
    await type(within(dialog).getByLabelText("Código do email"), "482 913");
    expect(submit.hasAttribute("disabled")).toBe(false);
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.deleteWorkspace")?.args).toEqual([ORG_ID, { code: "482913" }]);
    // The line on top says so at once, over Geral, which has no way to delete it again.
    expect(screen().getByRole("region", { name: "Status do workspace" }).textContent).toContain(
      "Ac\u200bme vai ser apagado em",
    );
    expect(screen().queryByRole("region", { name: "Apagar workspace" })).toBeNull();
    expect(screen().queryByRole("dialog")).toBeNull();
    // Out of the address too: restored, Geral doesn't open the dialog again.
    expect(router.state.location.search).not.toHaveProperty("delete");
  });

  test("a code refused says why under its field, which empties for the next one", async () => {
    const state = seedState({ deletionError: new ApiError(400, "reauth.code_wrong", "That code isn't right.") });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    await click(within(dialog).getByRole("button", { name: "Enviar código" }));
    await settle(4);
    await type(within(dialog).getByLabelText("Código do email"), "111111");
    await click(within(dialog).getByRole("button", { name: "Apagar workspace" }));
    await settle(6);
    expect(dialog.textContent).toContain("Código errado. Tente de novo.");
    expect((within(dialog).getByLabelText("Código do email") as HTMLInputElement).value).toBe("");
    expect(within(dialog).queryByRole("alert", { name: /Código errado/ })).toBeNull();
  });

  test("a server that sends no email asks for the password; an account without one adds it first", async () => {
    const state = seedState({ authConfig: { passwordReset: false } });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state });
    let dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).not.toContain("Vamos mandar um código");
    expect(dialog.textContent).toContain("Todos passam a só ler");
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    const submit = within(dialog).getByRole("button", { name: "Apagar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Sua senha"), "correct horse battery");
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.deleteWorkspace")?.args).toEqual([
      ORG_ID,
      { password: "correct horse battery" },
    ]);

    cleanup();
    const none = seedState({ authConfig: { passwordReset: false } });
    if (!none.me) throw new Error("signed in");
    none.me.user = { ...none.me.user, hasPassword: false };
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: none });
    dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).toContain(
      "Este servidor não manda email. Adicione uma senha para confirmar que é você.",
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar workspace" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Adicionar uma senha" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Adicionar uma senha" })).toBeTruthy();
  });
});

describe("a workspace being deleted opens as ever, read-only, under a line on top", () => {
  const deletion = (dueAt: string | null, by = { id: "u-joao", name: "João" }): OrgDeletion => ({
    dueAt,
    requestedAt: new Date(Date.now() - DAY).toISOString(),
    requestedBy: by,
  });
  const line = () => screen().getByRole("region", { name: "Status do workspace" });

  test("its owners read when it goes and who deleted it, and restore it there before the date", async () => {
    const { state, services } = await open(`/org/${ORG_ID}/settings`, { deletion: deletion(soon(6)) });
    expect(line().textContent).toMatch(/Acme vai ser apagado em \d+ \w+/);
    expect(line().textContent).toContain("João apagou em");
    expect(line().textContent).not.toContain("Só um dono");
    // The page under it is the workspace's own, with no way to delete it again.
    expect(screen().queryByRole("region", { name: "Apagar workspace" })).toBeNull();
    // Nobody hears of a restore: GET /me is asked again every 30 s meanwhile.
    expect(meEvery(services.queryClient)).toContain(30_000);
    await click(within(line()).getByRole("button", { name: "Restaurar workspace" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "orgs.restore")).toHaveLength(1);
    expect(screen().queryByRole("region", { name: "Status do workspace" })).toBeNull();
    expect(meEvery(services.queryClient)).not.toContain(30_000);
  });

  test("the one who deleted it reads that they did; members, that only an owner can restore it", async () => {
    await open(`/org/${ORG_ID}`, { deletion: deletion(soon(6), { id: "u-walter", name: "Walter" }) });
    expect(line().textContent).toContain("Você apagou em");

    cleanup();
    await open(`/org/${ORG_ID}`, { role: "member", deletion: deletion(soon(6)) });
    expect(within(line()).queryByRole("button", { name: "Restaurar workspace" })).toBeNull();
    expect(line().textContent).toContain("Só um dono pode restaurar.");

    // Past the date nobody restores, and no date shows.
    cleanup();
    await open(`/org/${ORG_ID}`, { deletion: deletion(null) });
    expect(line().textContent).toContain("Acme está sendo apagado");
    expect(within(line()).queryByRole("button", { name: "Restaurar workspace" })).toBeNull();
    expect(line().textContent).not.toContain("vai ser apagado");
    expect(line().textContent).not.toContain("Só um dono");
  });

  test("its conversations read as ever, the message box says why nothing can be sent", async () => {
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, { deletion: deletion(soon(6)) });
    expect(screen().getByRole("heading", { name: "eng" })).toBeTruthy();
    expect(
      screen().getByText("Você não pode enviar mensagens enquanto este workspace está sendo apagado"),
    ).toBeTruthy();
    expect(screen().queryByRole("combobox", { name: "Mensagem para #eng" })).toBeNull();
  });

  test("what would change it is greyed out or gone, and the line stays on top in Criar agente; the person's own stays", async () => {
    const frozen = () => document.querySelector("fieldset.settings__frozen");
    const pill = () => screen().queryByRole("group", { name: "Meu Início" });
    // As ever first: Novo agente under the agents, Organizar and Widget on Início, Geral's fields.
    await open(`/org/${ORG_ID}`);
    expect(document.querySelector(".sidebar__new-agent")).toBeTruthy();
    expect(pill()).toBeTruthy();
    cleanup();
    await open(`/org/${ORG_ID}`, { deletion: deletion(soon(6)) });
    expect(document.querySelector(".sidebar__new-agent")).toBeNull();
    expect(pill()).toBeNull();

    cleanup();
    await open(`/org/${ORG_ID}/settings/general`, { deletion: deletion(soon(6)) });
    expect(frozen()?.hasAttribute("disabled")).toBe(true);
    expect(frozen()?.querySelector("input, button")).toBeTruthy();
    cleanup();
    await open(`/org/${ORG_ID}/settings/account`, { deletion: deletion(soon(6)) });
    expect(frozen()).toBeNull();
    // What is read through its rows and tabs stays as ever (the Vault, roles, skills, the agents' access): the server
    // refuses its writes.
    cleanup();
    await open(`/org/${ORG_ID}/settings/roles`, { deletion: deletion(soon(6)) });
    expect(frozen()).toBeNull();
    cleanup();
    await open(`/org/${ORG_ID}/settings/access`, { deletion: deletion(soon(6)) });
    expect(frozen()).toBeNull();
    expect(screen().getByRole("radio", { name: "Nativos" })).toBeTruthy();
    // Importar e exportar keeps the workspace as a file and brings no agent in.
    const card = (name: string) => screen().queryByRole("region", { name });
    cleanup();
    await open(`/org/${ORG_ID}/settings/import`);
    expect([card("Importar") !== null, card("Exportar") !== null]).toEqual([true, true]);
    cleanup();
    await open(`/org/${ORG_ID}/settings/import`, { deletion: deletion(soon(6)) });
    expect([card("Importar") !== null, card("Exportar") !== null]).toEqual([false, true]);

    // Equipe with no agent yet speaks as to someone who can't make one, since no button follows.
    const team = async (deleting: boolean) => {
      cleanup();
      const state = seedState();
      state.agents = [];
      await open(`/org/${ORG_ID}/team`, { state, ...(deleting ? { deletion: deletion(soon(6)) } : {}) });
      return document.querySelector(".team .ac-empty__title")?.textContent;
    };
    expect(await team(false)).toBe("Monte seu time de agentes");
    expect(await team(true)).toBe("Seu time de agentes aparece aqui");

    cleanup();
    await open(`/org/${ORG_ID}/agents/new`, { deletion: deletion(soon(6)) });
    expect(line().textContent).toMatch(/Acme vai ser apagado em/);
  });
});

describe("a workspace being deleted, at its end and in the desktop app", () => {
  const deleted = (dueAt: string | null): OrgDeletion => ({ dueAt, requestedAt: soon(-1), requestedBy: null });

  test("deleted for good, it leaves for the person's start, never a page saying they aren't in it", async () => {
    const { state, services, router } = await open(`/org/${ORG_ID}`, { deletion: deleted(null) });
    if (!state.me) throw new Error("signed in");
    state.me = { ...state.me, organizations: state.me.organizations.filter((o) => o.id !== ORG_ID) };
    await act(async () => {
      await services.queryClient.refetchQueries({ queryKey: keys.me });
    });
    await settle(8);
    expect(router.state.location.pathname).toStartWith(`/org/${BETA_ID}`);
    expect(document.body.textContent).not.toContain("Você não faz parte deste workspace");
  });

  test("in the desktop app, it opens under its title bar as ever, the line on top of the work area", async () => {
    const app = window as { __agentesDesktop?: unknown };
    app.__agentesDesktop = { version: "0.6.0" };
    try {
      await open(`/org/${ORG_ID}`, { deletion: deleted(soon(6)) });
      expect(screen().getByRole("region", { name: "Status do workspace" }).textContent).toContain("vai ser apagado");
      expect(document.querySelector(".titlebar")).not.toBeNull();
    } finally {
      delete app.__agentesDesktop;
    }
  });
});

describe("the workspace menu tells closed and same-named workspaces apart", () => {
  const rows = async () => {
    await act(async () => {
      fireEvent.click(screen().getByRole("button", { name: /^Menu do workspace/ }));
    });
    await settle(4);
    return within(screen().getByRole("menu", { name: "Seus workspaces" })).getAllByRole("menuitem");
  };

  test("one being deleted says so with its date, one on its own looks as ever", async () => {
    await open(`/org/${ORG_ID}/issues`, {
      beta: {
        id: BETA_ID,
        name: "Beta",
        role: "owner",
        deletion: { dueAt: soon(5), requestedAt: soon(-2), requestedBy: null },
      },
    });
    const [acme, beta] = await rows();
    expect(acme?.textContent).not.toContain("Sendo apagado");
    expect(acme?.textContent).not.toContain("Criado em");
    expect(beta?.textContent).toContain("Sendo apagado, some em");
  });

  test("two live ones with the same name read their creation dates", async () => {
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.organizations = [
      { id: ORG_ID, name: "Acme", role: "owner", createdAt: "2026-01-10T12:00:00.000Z" },
      { id: BETA_ID, name: "Acme", role: "owner", createdAt: "2026-03-02T12:00:00.000Z" },
    ];
    await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(state) });
    await settle(8);
    const [first, second] = await rows();
    expect(first?.textContent).toMatch(/Criado em 10 jan/);
    expect(second?.textContent).toMatch(/Criado em 2 mar/);
  });
});

describe("the desktop app lists every server's workspaces (ADR 0154)", () => {
  const OWN = "https://agentes.exemplo.com.br";
  const menuRows = async () => {
    await act(async () => {
      fireEvent.click(screen().getByRole("button", { name: /^Menu do workspace/ }));
    });
    await settle(4);
    return within(screen().getByRole("menu", { name: "Seus workspaces" }));
  };

  test("by server with unread counts; another server's opens there; Adicionar workspace opens the app's window", async () => {
    const app = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
    const asked: Record<string, unknown>[] = [];
    app.__agentesDesktop = { version: "0.6.0", workspaces: true };
    app.__TAURI_INTERNALS__ = {
      invoke: async (_cmd: string, args?: { request?: Record<string, unknown> }) => {
        const request = args?.request;
        if (request) asked.push(request);
        if (request?.kind === "workspaces") {
          return {
            servers: [
              {
                server: OWN,
                signedIn: true,
                orgs: [{ id: "oficina", name: "Oficina", logo: null, unread: 4, waiting: 0 }],
              },
            ],
          };
        }
        return {};
      },
    };
    try {
      await open(`/org/${ORG_ID}/issues`);
      const menu = await menuRows();
      expect(menu.getByText("agentes.exemplo.com.br").parentElement?.textContent).toContain("Seu servidor");
      const items = menu.getAllByRole("menuitem");
      expect(items.map((i) => i.textContent?.replace(/\s+/g, " ").trim())).toEqual([
        expect.stringContaining("Acme"),
        expect.stringContaining("Beta"),
        expect.stringMatching(/Oficina.*4/),
        expect.stringContaining("Adicionar workspace"),
      ]);
      expect(menu.queryByText("Novo workspace")).toBeNull();
      await click(items[2] as Element);
      expect(asked).toContainEqual({ kind: "openWorkspace", server: OWN, orgId: "oficina" });
      const again = await menuRows();
      await click(again.getByText("Adicionar workspace"));
      expect(asked).toContainEqual({ kind: "addWorkspace" });
    } finally {
      delete app.__agentesDesktop;
      delete app.__TAURI_INTERNALS__;
    }
  });

  test("in a browser, the menu is as it was", async () => {
    await open(`/org/${ORG_ID}/issues`);
    const menu = await menuRows();
    expect(menu.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      expect.stringContaining("Acme"),
      expect.stringContaining("Beta"),
      expect.stringContaining("Novo workspace"),
    ]);
    expect(menu.queryByText("Adicionar workspace")).toBeNull();
  });
});

describe("adding a password (the account menu)", () => {
  test("its dialog is kept in the address, so signing in again comes back to it", async () => {
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.user = { ...state.me.user, hasPassword: false };
    await open(`/org/${ORG_ID}/issues?account=password`, { state });
    expect(screen().getByRole("dialog", { name: "Adicionar uma senha" })).toBeTruthy();
  });
});

describe("deleting your account (Configurações › Sua conta)", () => {
  test("Sua conta's last card starts it: a workspace that still needs you comes first, with its two ways out", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [{ id: BETA_ID, name: "Beta", role: "owner" }],
        soleOwner: [{ id: BETA_ID, name: "Beta" }],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    const { router } = await open(`/org/${ORG_ID}/settings/account`, { state });
    const card = screen().getByRole("region", { name: "Apagar conta" });
    // The kit's Tabs wrap the strip and the panel in a box that lays nothing out (`display: contents`).
    const cards = document.querySelectorAll(".settings__body .ac-tabpanel > .ac-card");
    expect(cards[cards.length - 1]).toBe(card);
    expect(card.classList.contains("settings-danger")).toBe(true);
    expect(card.textContent).toContain("a sua conta é apagada de vez 7 dias depois. Até lá, dá para restaurar.");
    await click(within(card).getByRole("button", { name: "Apagar conta…" }));
    await settle(6);
    // Kept in the address: a sign-in again comes back to it.
    expect(router.state.location.search).toMatchObject({ account: "delete" });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    expect(dialog.textContent).toContain("Antes de apagar");
    expect(dialog.textContent).toContain(
      "Você é a única pessoa dona de Beta. Torne outra pessoa dona, ou apague Beta.",
    );
    expect(within(dialog).getByRole("link", { name: "Abrir Pessoas" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/members`,
    );
    expect(within(dialog).getByRole("link", { name: "Apagar Beta" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/general?delete=1`,
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar conta" })).toBeNull();
  });

  test("the account menu doesn't offer it beside Sair", async () => {
    await open(`/org/${ORG_ID}/issues`);
    // A Radix menu opens from the keyboard here (a pointer press, not a click, opens it with a mouse).
    const account = screen().getByRole("button", { name: /^Conta: / });
    account.focus();
    await act(async () => fireEvent.keyDown(account, { key: "Enter" }));
    await settle(2);
    const menu = screen().getAllByRole("menu")[0] as HTMLElement;
    expect(within(menu).getByRole("menuitem", { name: "Sair" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /Apagar/ })).toBeNull();
  });

  test("one still being set up has no People yet: its onboarding finishes it or deletes it", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [{ id: BETA_ID, name: "Beta", role: "owner" }],
        soleOwner: [{ id: BETA_ID, name: "Beta" }],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    const beta: OrgSummary = {
      id: BETA_ID,
      name: "Beta",
      role: "owner",
      onboarding: { step: "agents", generalChannelId: "c-beta" },
    };
    await open(`/org/${ORG_ID}/issues?account=delete`, { state, beta });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    expect(dialog.textContent).toContain(
      "Você é a única pessoa dona de Beta. Termine de configurar para tornar outra pessoa dona, ou apague Beta.",
    );
    expect(within(dialog).getByRole("link", { name: "Terminar a configuração" }).getAttribute("href")).toBe(
      "/onboarding",
    );
    expect(within(dialog).getByRole("link", { name: "Apagar Beta" }).getAttribute("href")).toBe("/onboarding?delete=1");
  });

  test("only for someone with no workspace that opens: under its own heading, apart from Sair", async () => {
    const suspended = { state: "suspended", reason: null } as const;
    const betaClosed: OrgSummary = { id: BETA_ID, name: "Beta", role: "member", standing: suspended };
    const heading = () => screen().getByRole("region", { name: "Sua conta inteira" });
    const { router } = await open(`/org/${ORG_ID}`, { standing: suspended, beta: betaClosed });
    expect(screen().getByRole("heading", { name: "Acme está indisponível" })).toBeTruthy();
    expect(within(heading()).queryByRole("button", { name: "Sair" })).toBeNull();
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();
    await click(within(heading()).getByRole("button", { name: "Apagar conta…" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" })).toBeTruthy();
    // Kept in the address: a sign-in again comes back to it.
    expect(router.state.location.search).toMatchObject({ account: "delete" });

    cleanup();
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.organizations = [];
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(8);
    // The onboarding's account menu (ADR 0162): Apagar conta beside Sair.
    const menu = await accountMenu();
    expect(within(menu).getByRole("menuitem", { name: "Sair" })).toBeTruthy();
    await click(within(menu).getByRole("menuitem", { name: "Apagar conta" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" })).toBeTruthy();
  });

  test("with another workspace that opens, a closed screen never offers it: going there is the main action", async () => {
    const closing = { dueAt: soon(6), requestedAt: soon(-1), requestedBy: null };
    const noAccountDeletion = () => {
      expect(screen().queryByRole("button", { name: /^Apagar conta/ })).toBeNull();
      expect(screen().queryByRole("region", { name: "Sua conta inteira" })).toBeNull();
    };
    // Being deleted, even their only workspace opens: Sua conta is there.
    await open(`/org/${ORG_ID}`, { deletion: closing, beta: null });
    noAccountDeletion();
    expect(screen().getByRole("region", { name: "Status do workspace" })).toBeTruthy();

    cleanup();
    await open(`/org/${ORG_ID}`, {
      standing: { state: "suspended", reason: null },
      beta: { id: BETA_ID, name: "Beta", role: "member", deletion: closing },
    });
    noAccountDeletion();
    expect(screen().getByRole("link", { name: /^Beta/ }).className).toContain("ac-btn--primary");

    // Even from the address: this account's deletion starts in Sua conta.
    cleanup();
    await open(`/org/${ORG_ID}?account=delete`, { standing: { state: "suspended", reason: null } });
    expect(screen().queryByRole("dialog")).toBeNull();

    cleanup();
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.organizations = [{ id: BETA_ID, name: "Beta", role: "owner" }];
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(8);
    noAccountDeletion();
    // Its account menu has Sair and no Apagar conta: Beta opens, and Sua conta there has it.
    const menu = await accountMenu();
    expect(within(menu).getByRole("menuitem", { name: "Sair" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Apagar conta" })).toBeNull();
  });

  test("one still being set up doesn't count as a way to Sua conta", async () => {
    await open(`/org/${ORG_ID}`, {
      standing: { state: "suspended", reason: null },
      beta: { id: BETA_ID, name: "Beta", role: "owner", onboarding: { step: "agents", generalChannelId: "c-beta" } },
    });
    expect(screen().getByRole("region", { name: "Sua conta inteira" })).toBeTruthy();
  });

  test("Sua conta points to Geral for someone who owns this workspace and only meant it", async () => {
    await open(`/org/${ORG_ID}/settings/account`);
    const card = screen().getByRole("region", { name: "Apagar conta" });
    expect(
      within(card).getByRole("link", { name: "Quer apagar só este workspace? Fica em Geral." }).getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/settings/general`);
    cleanup();
    await open(`/org/${ORG_ID}/settings/account`, { role: "member" });
    expect(screen().queryByRole("link", { name: /Quer apagar só este workspace/ })).toBeNull();
    expect(
      screen().getByRole("link", { name: "Quer sair só deste workspace? Fica em Membros." }).getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/settings/members`);
  });

  test("two with the same name in the dialog: told apart in what it says and in its links", async () => {
    const made = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [
          { id: ORG_ID, name: "Acme", role: "owner" },
          { id: BETA_ID, name: "Acme", role: "owner" },
        ],
        soleOwner: [
          { id: ORG_ID, name: "Acme" },
          { id: BETA_ID, name: "Acme" },
        ],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    await open(`/org/${ORG_ID}/issues?account=delete`, {
      state,
      createdAt: made(90),
      beta: { id: BETA_ID, name: "Acme", role: "owner", createdAt: made(30) },
    });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    const links = within(dialog)
      .getAllByRole("link", { name: /^Apagar Acme/ })
      .map((l) => l.textContent);
    expect(new Set(links).size).toBe(2);
    expect(links.every((l) => l?.includes("Criado em"))).toBe(true);
  });

  test("what closes, what you leave, what stays; the code from the email, then out to the sign-in", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [
          { id: ORG_ID, name: "Acme", agents: 12, messages: 340 },
          { id: "00000000-0000-4000-8000-0000000000c3", name: "Rascunho", deletion: { dueAt: soon(3) } },
          { id: "00000000-0000-4000-8000-0000000000c4", name: "Vazio", agents: 0, messages: 0 },
        ],
        leaves: [{ id: BETA_ID, name: "Beta", role: "member" }],
        soleOwner: [],
        computers: [{ orgId: BETA_ID, id: "m1", name: "MacBook" }],
        staysBehind: [
          { orgId: BETA_ID, kind: "mailbox", name: "ana@beta.com" },
          { orgId: BETA_ID, kind: "key", name: "Chave da Ana" },
        ],
        serverOwner: false,
      },
    });
    state.authConfig = { ...state.authConfig, billingUrl: "https://billing.example.com" };
    // Kept in the address: a sign-in again comes back to it.
    const { router } = await open(`/org/${ORG_ID}/issues?account=delete`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta inteira?" });
    for (const line of [
      "Isto apaga a sua conta inteira, não só um workspace.",
      "Sua conta some de vez em",
      // What each one holds, so one with work in it can't be taken for an empty copy.
      "Acme fecha agora, com 12 agentes e 340 mensagens. Só você está lá, então ele é apagado de vez em",
      "Vazio fecha agora, sem agentes nem mensagens.",
      // Being deleted already, on its own date.
      "Rascunho já está sendo apagado. Ele some de vez em",
      "Você sai de Beta.",
      "Seu computador conectado a Beta sai de lá: MacBook.",
      "O que você adicionou em Beta continua lá. Desconecte antes o que for seu.",
      // Where plans are billed.
      "Os planos que você paga param de renovar. Nada é reembolsado.",
      "Suas mensagens ficam nos workspaces sem o seu nome.",
    ])
      expect(dialog.textContent).toContain(line);
    // Each thing that stays behind, to where it's disconnected.
    expect(within(dialog).getByRole("link", { name: "Desconectar ana@beta.com" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/connectors`,
    );
    expect(within(dialog).getByRole("link", { name: "Desconectar Chave da Ana" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/usage`,
    );
    // The way to delete just a workspace, for someone who only meant that.
    expect(dialog.textContent).toContain("Quer apagar só um workspace? A sua conta continua.");
    expect(within(dialog).getByRole("link", { name: "Apagar Acme" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/general?delete=1`,
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar conta" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Enviar código" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "account.deletionCode")).toHaveLength(1);
    const submit = within(dialog).getByRole("button", { name: "Apagar conta" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Código do email"), "482913");
    await click(submit);
    await settle(8);
    expect(state.calls.find((c) => c.method === "account.delete")?.args).toEqual([{ code: "482913" }]);
    expect(router.state.location.pathname).toBe("/login");
    expect(document.body.textContent).toContain("Entre antes disso para restaurar.");
  });
});

describe("an account waiting for its deletion", () => {
  const waiting = (dueAt: string | null) => {
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.user.deletion = { dueAt, requestedAt: soon(-1) };
    state.me.organizations = [];
    return state;
  };

  test("signing in shows one screen in place of the app: when it goes, Restaurar and Sair", async () => {
    const state = waiting(soon(6));
    const { router } = await renderApp("/", { api: createFakeApi(state) });
    await settle(8);
    expect(screen().getByRole("heading", { name: "Sua conta está sendo apagada" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();
    // What happens until then is behind the ⓘ beside when it goes.
    expect(screen().getByRole("button", { name: "Sobre Sua conta está sendo apagada" })).toBeTruthy();
    expect(document.body.textContent).toContain("Até lá ninguém fala com você aqui");
    const restore = screen().getByRole("button", { name: "Restaurar conta" });
    await click(restore);
    await settle(8);
    expect(state.calls.some((c) => c.method === "account.restore")).toBe(true);
    expect(screen().queryByRole("heading", { name: "Sua conta está sendo apagada" })).toBeNull();
    expect(router.state.location.pathname).not.toBe("/login");
  });

  test("past its date there is nothing to press but Sair", async () => {
    await renderApp("/", { api: createFakeApi(waiting(null)) });
    await settle(8);
    expect(screen().getByRole("heading", { name: "Sua conta está sendo apagada" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Restaurar conta" })).toBeNull();
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();
  });
});

describe("an invitation into a workspace being deleted", () => {
  test("reads as closed, as its links do: nobody to join, no form to sign up", async () => {
    const state = seedState({
      previews: {
        tok: { orgName: "Acme", email: "", role: "member", kind: "email", invitedBy: null, agents: [], closed: true },
      },
    });
    state.me = null;
    await renderApp("/invite/tok", { api: createFakeApi(state) });
    await settle(6);
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Este link não funciona mais");
    expect(document.body.textContent).toContain("Peça um novo a quem mandou.");
    expect(screen().queryByLabelText("Seu nome")).toBeNull();
  });
});

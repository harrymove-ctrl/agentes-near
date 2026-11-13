import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type MailAccount, type RoutineInput } from "@agenteschat/client";
import { defaultPolicy } from "@agenteschat/client/lib/mail";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import { pick, service } from "./catalog";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeMailOf, ORG_ID, seedState } from "./fake-api";
import { MAIL_PROVIDERS } from "./fakes/mail";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
/** Opens a select and picks an option. */
const choose = async (combobox: HTMLElement, option: string) => {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
  await settle();
};

/** The routine's agents read these mailboxes (the rest stay "Sem acesso"). */
function reads(
  mail: NonNullable<ReturnType<typeof fakeMailOf.get>>,
  state: ReturnType<typeof seedState>,
  ids: string[],
) {
  for (const agent of state.agents)
    mail.agentMail.set(
      agent.id,
      new Map(
        ids.map((accountId) => [
          accountId,
          { accountId, level: "read" as const, canDelete: false, policy: defaultPolicy() },
        ]),
      ),
    );
}

/** A client with email on (Gmail/Outlook and IMAP), optionally with mailboxes already connected. */
function mailApi(accounts: Partial<MailAccount>[] = []) {
  const state = seedState({ connections: [] });
  const api = createFakeApi(state);
  const mail = fakeMailOf.get(api);
  if (!mail) throw new Error("no mail fake");
  mail.providers = structuredClone(MAIL_PROVIDERS);
  mail.accounts = accounts.map((a, i) => ({
    id: `mail-${i + 1}`,
    provider: "imap",
    via: "imap",
    address: `caixa${i + 1}@acme.com.br`,
    offActions: [],
    askActions: [],
    aliases: [],
    defaultFrom: null,
    label: `caixa${i + 1}@acme.com.br`,
    status: "active",
    lastError: null,
    preset: "icloud",
    createdAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
    ownerUserId: state.me?.user.id ?? null,
    agents: [],
    ...a,
  }));
  return { state, api, mail };
}

const openCatalog = async (api: ReturnType<typeof createFakeApi>, url = `/org/${ORG_ID}/settings/connectors`) => {
  await renderApp(url, { api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  return screen().getByRole("dialog", { name: "Adicionar conector" });
};

describe("Conectores → Email", () => {
  test("the Email group: Gmail, Outlook, iCloud and Outro email, each with how it connects", async () => {
    const { api } = mailApi();
    const dialog = await openCatalog(api);
    // The categories, each with its count ("Email 4").
    const cats = within(dialog).getByRole("radiogroup", { name: "Categorias" });
    await click(within(cats).getByRole("radio", { name: /^Email/ }));
    const names = [...dialog.querySelectorAll(".catalog-tile__name")].map((el) => el.textContent);
    expect(names).toEqual(["Gmail", "Outlook", "iCloud", "Outro email", "Não achou?"]);
    const gmail = within(dialog).getByRole("button", { name: "Gmail" });
    expect(gmail.querySelector(".connector-icon__mark")?.getAttribute("style")).toContain("/connectors/gmail.svg");
    // How it connects lives in the service's dialog, not on the card.
    await click(gmail);
    const google = service("Gmail").textContent;
    expect(google).toContain("Um clique");
    await click(within(service("Gmail")).getByRole("button", { name: "Fechar detalhe" }));
    await click(within(dialog).getByRole("button", { name: "iCloud" }));
    const apple = service("iCloud").textContent;
    expect(apple).toContain("Precisa de uma senha de app");
    // No internal names in the copy.
    expect(`${dialog.textContent} ${google} ${apple}`).not.toMatch(/Composio|IMAP/);
  });

  test("a server without email shows no Email group", async () => {
    const state = seedState({ connections: [] });
    const dialog = await openCatalog(createFakeApi(state));
    expect(within(dialog).queryByRole("button", { name: "Gmail" })).toBeNull();
    expect(
      within(within(dialog).getByRole("radiogroup", { name: "Categorias" })).queryByRole("radio", { name: /^Email/ }),
    ).toBeNull();
  });

  test("Gmail: 'Conectar com Google' leaves for the provider's page", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { api, state } = mailApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Gmail");
    expect(flow().textContent).toContain("Conectar Gmail");
    await click(within(flow()).getByRole("button", { name: "Conectar com Google" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "mail.connectComposio")?.args[1]).toEqual({
      provider: "gmail",
      desktop: false,
    });
    expect(left).toEqual(["https://composio.example/connect/gmail"]);
  });

  test("in the desktop app, Gmail's return comes back to the window: 'O que faz', or why it failed", async () => {
    const win = window as { __agentesDesktop?: unknown };
    win.__agentesDesktop = { version: "0.6.0", connectorReturn: true };
    try {
      setNavigateAway(() => {});
      const { api, state } = mailApi();
      await pick(await openCatalog(api), "Gmail");
      await click(within(flow()).getByRole("button", { name: "Conectar com Google" }));
      await settle(4);
      expect(state.calls.find((c) => c.method === "mail.connectComposio")?.args[1]).toEqual({
        provider: "gmail",
        desktop: true,
      });
      cleanup();

      const back = mailApi([{ provider: "gmail", via: "composio", preset: null, address: "new@example.com" }]);
      await renderApp(`/desktop/connector?org=${ORG_ID}&state=mail&code=connected`, { api: back.api });
      await settle(8);
      expect(screen().getByRole("dialog", { name: "O que new@example.com faz" })).toBeTruthy();
      cleanup();
      await renderApp(`/desktop/connector?org=${ORG_ID}&state=mail&code=failed`, { api: mailApi().api });
      await settle(8);
      expect(screen().getByText("Não deu para conectar o email. Tente de novo.")).toBeTruthy();
    } finally {
      delete win.__agentesDesktop;
    }
  });

  test("iCloud: address and app password; a 422 says why in plain words; then o que faz → quem pode usar", async () => {
    const { api, state, mail } = mailApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "iCloud");
    // What an app password is, the steps and the provider's page; the hint for a dedicated mailbox.
    expect(flow().textContent).toContain("O que é uma senha de app?");
    expect(within(flow()).getByRole("link", { name: "Abrir a página de iCloud" }).getAttribute("href")).toBe(
      "https://account.apple.com/account/manage",
    );
    expect(flow().textContent).toContain("Dica: prefira um email só para os agentes.");
    expect(within(flow()).queryByText("Avançado")).toBeNull();

    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    expect(flow().textContent).toContain("Digite um email válido");
    expect(flow().textContent).toContain("Cole a senha de app.");
    expect(state.calls.some((c) => c.method === "mail.connectImap")).toBe(false);

    await type(within(flow()).getByLabelText("Endereço de email"), "ana@example.com");
    await type(within(flow()).getByLabelText("Senha de app"), "abcd-efgh-ijkl-mnop");
    mail.nextError = "auth";
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    // iCloud's own two things to check: the iCloud Mail address and an app password.
    expect(within(flow()).getByRole("alert").textContent).toBe(
      "O iCloud não aceitou. Confira se o endereço é o do Mail do iCloud, como nome@icloud.com, e se a senha é uma senha de app, não a da sua Conta Apple.",
    );
    // No error toast on top of the inline message.
    expect(screen().queryByText("auth")).toBeNull();

    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    const connect = state.calls.filter((c) => c.method === "mail.connectImap").at(-1);
    expect(connect?.args[1]).toEqual({ preset: "icloud", address: "ana@example.com", password: "[redacted]" });
    // Its other addresses: none found, nothing changed, straight on.
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Endereços de ana@example.com" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "mail.update")).toBe(false);
    // Step 2: what it does, in the standard tool review (nothing to decide: all sorted).
    expect(screen().getByRole("dialog", { name: "O que ana@example.com faz" })).toBeTruthy();
    expect(within(flow()).getByRole("button", { name: /^E-mails/ })).toBeTruthy();
    expect(within(flow()).getByRole("button", { name: /^Pastas/ })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    // Step 3: a level per agent.
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Quem pode usar ana@example.com" })).toBeTruthy();
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Nível de Ada" })).getByRole("radio", {
        name: "Ler e escrever",
      }),
    );
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Nível de Atlas" })).getByRole("radio", { name: "Ler" }),
    );
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    const sets = state.calls
      .filter((c) => c.method === "mail.setAgent")
      .map((c) => [c.args[1], (c.args[3] as { level: string }).level]);
    expect(sets).toEqual([
      [ADA_ID, "read_write"],
      [ATLAS_ID, "read"],
    ]);
    // Step 4: the rules, one agent at a time; Atlas only reads the inbox.
    expect(screen().getByRole("dialog", { name: "Regras em ana@example.com" })).toBeTruthy();
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Agente" })).getByRole("radio", { name: "Atlas" }),
    );
    await settle(4);
    await click(within(flow()).getByRole("checkbox", { name: "Caixa de entrada" }));
    await click(within(flow()).getByRole("button", { name: "Salvar regras" }));
    await settle(6);
    const rules = state.calls.filter((c) => c.method === "mail.setAgent").at(-1);
    expect(rules?.args[1]).toBe(ATLAS_ID);
    expect(rules?.args[3]).toEqual(
      expect.objectContaining({ level: "read", policy: expect.objectContaining({ folders: ["INBOX"] }) }),
    );
    // The new row: the mailbox, active, used by 2 agents.
    const row = screen()
      .getByRole("button", { name: "Quem usa ana@example.com" })
      .closest(".connected-row") as HTMLElement;
    expect(row.textContent).toContain("iCloud");
    expect(row.textContent).toContain("Ativo");
    expect(row.textContent).toContain("Conectado como ana@example.com");
  });

  test("iCloud with a Gmail address: where to find the iCloud Mail one, before sending; other emails keep their copy", async () => {
    const { api } = mailApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "iCloud");
    const address = () => within(flow()).getByLabelText("Endereço de email");
    const hint = () => document.getElementById(address().getAttribute("aria-describedby") ?? "")?.textContent ?? null;
    await type(address(), "Ana@Gmail.com");
    expect(hint()).toBe(
      "Use o endereço do Mail do iCloud, como nome@icloud.com, mesmo que a sua Conta Apple use o Gmail. No iPhone ele está em Ajustes\u00a0›\u00a0seu nome\u00a0›\u00a0iCloud\u00a0›\u00a0Mail do iCloud, ou veja em icloud.com/mail.",
    );
    await type(address(), "ana@hotmail.com");
    expect(hint()).toContain("use o Outlook");
    // Apple's domains and custom ones (iCloud+ domains) get no hint.
    for (const typed of ["ana@icloud.com", "ana@acme.com.br"]) {
      await type(address(), typed);
      expect(hint()).toBeNull();
    }
    cleanup();

    const other = mailApi();
    await pick(await openCatalog(other.api), "Outro email");
    await type(within(flow()).getByLabelText("Endereço de email"), "ana@gmail.com");
    expect(flow().textContent).not.toContain("Mail do iCloud");
    await type(within(flow()).getByLabelText("Senha de app"), "abcd-efgh-ijkl-mnop");
    other.mail.nextError = "auth";
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(within(flow()).getByRole("alert").textContent).toBe(
      "O email ou a senha de app não conferem. Confira e tente de novo.",
    );
  });

  test("iCloud with its own domain: the sent folder's addresses come filled in, then the default From", async () => {
    const { api, state, mail } = mailApi();
    mail.suggested = ["suporte@acme.com.br"];
    const dialog = await openCatalog(api);
    await pick(dialog, "iCloud");
    await type(within(flow()).getByLabelText("Endereço de email"), "ana@icloud.com");
    await type(within(flow()).getByLabelText("Senha de app"), "abcd-efgh-ijkl-mnop");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(6);
    const step = screen().getByRole("dialog", { name: "Endereços de ana@icloud.com" });
    expect(step.textContent).toContain("Os agentes respondem pelo endereço que recebeu o email.");
    expect(step.textContent).toContain("Endereço principal: ana@icloud.com");
    expect(step.textContent).toContain("Achamos estes nos emails que você enviou.");
    const others = () => within(flow()).getByRole("list", { name: "Outros endereços desta caixa" });
    expect(others().textContent).toContain("suporte@acme.com.br");
    // Only addresses (a whole domain isn't an address to send from).
    await type(within(flow()).getByRole("textbox", { name: "Outros endereços desta caixa" }), "@acme.com.br");
    await click(within(flow()).getByRole("button", { name: "Adicionar em Outros endereços desta caixa" }));
    expect(flow().textContent).toContain("Use um email, como contato@suaempresa.com.");
    await type(within(flow()).getByRole("textbox", { name: "Outros endereços desta caixa" }), "Vendas@acme.com.br");
    await click(within(flow()).getByRole("button", { name: "Adicionar em Outros endereços desta caixa" }));
    expect(others().textContent).toContain("vendas@acme.com.br");
    await choose(within(flow()).getByRole("combobox", { name: "Emails novos saem de" }), "vendas@acme.com.br");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "mail.update")?.args.slice(1)).toEqual([
      mail.accounts[0]?.id,
      { aliases: ["suporte@acme.com.br", "vendas@acme.com.br"], defaultFrom: "vendas@acme.com.br" },
    ]);
    expect(screen().getByRole("dialog", { name: "O que ana@icloud.com faz" })).toBeTruthy();
  });

  test("'Endereços' on a connected mailbox; an agent sends as one of them or automatically", async () => {
    const { api, state } = mailApi([{ address: "ana@icloud.com", aliases: ["suporte@acme.com.br"] }]);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Endereços de ana@icloud.com" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Endereços de ana@icloud.com" });
    // Nothing changed yet: nothing to save.
    expect(within(dialog).getByRole("button", { name: "Salvar" }).hasAttribute("disabled")).toBe(true);
    const saved = within(dialog).getByRole("list", { name: "Outros endereços desta caixa" });
    await click(within(saved).getByRole("button", { name: "Remover suporte@acme.com.br" }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "mail.update")?.args.slice(1)).toEqual([
      "mail-1",
      { aliases: [], defaultFrom: null },
    ]);
    expect(screen().getByText("Endereços de ana@icloud.com salvos.")).toBeTruthy();
    cleanup();

    const other = mailApi([{ address: "ana@icloud.com", aliases: ["suporte@acme.com.br"] }]);
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: other.api });
    await settle(10);
    const level = screen().getByRole("radiogroup", { name: "Nível em ana@icloud.com" });
    await click(within(level).getByRole("radio", { name: "Ler e escrever" }));
    const row = level.closest("li") as HTMLElement;
    await click(within(row).getByLabelText("Regras de ana@icloud.com"));
    await settle(4);
    const from = within(row).getByRole("combobox", { name: "Enviar como" });
    expect(from.textContent).toContain("Automático");
    await choose(from, "suporte@acme.com.br");
    await click(within(row).getByRole("button", { name: "Salvar" }));
    await settle(4);
    const call = other.state.calls.find((c) => c.method === "mail.setAgent");
    expect((call?.args[3] as { policy?: { fromAddress: string | null } } | undefined)?.policy?.fromAddress).toBe(
      "suporte@acme.com.br",
    );
  });

  test("each connect error has its own message", async () => {
    const { api, mail } = mailApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "iCloud");
    await type(within(flow()).getByLabelText("Endereço de email"), "ana@example.com");
    await type(within(flow()).getByLabelText("Senha de app"), "x");
    const said: string[] = [];
    for (const code of ["imap_unreachable", "smtp_unreachable", "tls", "blocked_host", "unknown"] as const) {
      mail.nextError = code;
      await click(within(flow()).getByRole("button", { name: "Conectar" }));
      await settle(3);
      said.push(within(flow()).getByRole("alert").textContent ?? "");
    }
    expect(new Set(said).size).toBe(5);
    expect(said[0]).toContain("servidor de entrada");
    expect(said[1]).toContain("servidor de saída");
  });

  test("back from Gmail (`?mail=connected&account=<id>`): that mailbox, even with a newer one and a slow list; then who uses it", async () => {
    const { api, state, mail } = mailApi([
      { address: "old@acme.com.br" },
      { provider: "gmail", via: "composio", preset: null, address: "came@example.com" },
      // Started and left on Microsoft's page: newer, still waiting.
      { provider: "outlook", via: "composio", preset: null, address: "", status: "pending" },
    ]);
    const list = mail.client.accounts;
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    mail.client.accounts = async (orgId) => {
      await arrived;
      return list(orgId);
    };
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=connected&account=mail-2`, { api });
    await settle(8);
    expect(screen().queryByRole("dialog")).toBeNull();
    await act(async () => arrive());
    await settle(8);
    expect(screen().getByRole("dialog", { name: "O que came@example.com faz" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    const who = screen().getByRole("dialog", { name: "Quem pode usar came@example.com" });
    const level = (agent: string) =>
      within(within(who).getByRole("radiogroup", { name: `Nível de ${agent}` }))
        .getAllByRole("radio")
        .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;
    // A new mailbox is nobody's until it's chosen here.
    expect([level("Ada"), level("Atlas")]).toEqual(["Sem acesso", "Sem acesso"]);
    await click(
      within(within(who).getByRole("radiogroup", { name: "Nível de Ada" })).getByRole("radio", { name: "Ler" }),
    );
    await click(within(who).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(
      state.calls
        .filter((c) => c.method === "mail.setAgent")
        .map((c) => [c.args[1], c.args[2], (c.args[3] as { level: string }).level]),
    ).toEqual([[ADA_ID, "mail-2", "read"]]);
    // Then the optional rules.
    expect(screen().getByRole("dialog", { name: "Regras em came@example.com" })).toBeTruthy();
  });

  test("back from Gmail without the account (`?mail=connected`): the newest mailbox; `failed` says so", async () => {
    const { api } = mailApi([
      { address: "old@acme.com.br" },
      { provider: "gmail", via: "composio", preset: null, address: "new@example.com" },
    ]);
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=connected`, { api });
    await settle(8);
    expect(screen().getByRole("dialog", { name: "O que new@example.com faz" })).toBeTruthy();
    cleanup();
    const other = mailApi();
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=failed`, { api: other.api });
    await settle(8);
    expect(screen().getByText("Não deu para conectar o email. Tente de novo.")).toBeTruthy();
  });

  test("'O que faz': the standard review; reads only Consulta · Desligada, sends only Aprovação · Desligada", async () => {
    const { api, state } = mailApi([{ provider: "gmail", via: "composio", preset: null, address: "new@example.com" }]);
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=connected`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "O que new@example.com faz" });
    await click(within(dialog).getByRole("button", { name: /^E-mails/ }));
    const levels = (name: string) =>
      within(within(dialog).getByRole("radiogroup", { name: `Nível de ${name}` }))
        .getAllByRole("radio")
        .map((r) => r.textContent);
    expect(levels("Ler emails")).toEqual(["Consulta", "Desligada"]);
    expect(levels("Enviar")).toEqual(["Aprovação", "Desligada"]);
    expect(levels("Organizar")).toEqual(["Muda", "Aprovação", "Desligada"]);
    const pick = (name: string, level: string) =>
      click(
        within(within(dialog).getByRole("radiogroup", { name: `Nível de ${name}` })).getByRole("radio", {
          name: level,
        }),
      );
    await pick("Enviar", "Desligada");
    await pick("Organizar", "Aprovação");
    await click(within(dialog).getByRole("button", { name: "Continuar" }));
    expect(state.calls.find((c) => c.method === "mail.update")?.args.slice(1)).toEqual([
      "mail-1",
      { offActions: ["send"], askActions: ["organize"] },
    ]);
  });

  test("someone else's mailbox: 'O que faz' read-only, and lowering who uses it ends there, without rules to set", async () => {
    const { api, state, mail } = mailApi([
      {
        address: "joao@example.com",
        ownerUserId: "u-joao",
        agents: [{ agentId: ADA_ID, level: "read_write", canDelete: false }],
      },
    ]);
    mail.agentMail.set(
      ADA_ID,
      new Map([["mail-1", { accountId: "mail-1", level: "read_write", canDelete: false, policy: defaultPolicy() }]]),
    );
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=connected&account=mail-1`, { api });
    await settle(8);
    const actions = screen().getByRole("dialog", { name: "O que joao@example.com faz" });
    expect(actions.textContent).toContain("Só João pode dar acesso: foi quem conectou esta caixa.");
    expect(within(actions).queryByRole("radiogroup", { name: "Nível de Enviar" })).toBeNull();
    await click(within(actions).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "mail.update")).toBe(false);
    const who = screen().getByRole("dialog", { name: "Quem pode usar joao@example.com" });
    await click(
      within(within(who).getByRole("radiogroup", { name: "Nível de Ada" })).getByRole("radio", { name: "Ler" }),
    );
    await click(within(who).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(
      state.calls.filter((c) => c.method === "mail.setAgent").map((c) => (c.args[3] as { level: string }).level),
    ).toEqual(["read"]);
    expect(screen().queryByRole("dialog", { name: "Regras em joao@example.com" })).toBeNull();
  });

  test("'Precisa reconectar': a new app password (PATCH), or Gmail signs in again", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { api, state } = mailApi([
      { address: "ana@example.com", status: "needs_reconnect" },
      { provider: "gmail", via: "composio", preset: null, address: "bia@example.com", status: "needs_reconnect" },
    ]);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const row = screen()
      .getByRole("button", { name: "Quem usa ana@example.com" })
      .closest(".connected-row") as HTMLElement;
    expect(row.textContent).toContain("Precisa reconectar");
    await click(within(row).getByRole("button", { name: "Reconectar ana@example.com" }));
    const dialog = screen().getByRole("dialog", { name: "Reconectar ana@example.com" });
    await type(within(dialog).getByLabelText("Senha de app"), "nova-senha");
    await click(within(dialog).getByRole("button", { name: "Reconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "mail.update")?.args.slice(1)).toEqual([
      "mail-1",
      { password: "[redacted]" },
    ]);
    await click(screen().getByRole("button", { name: "Reconectar bia@example.com" }));
    await settle(4);
    // The same mailbox signs in again (a new one would be refused: the address is taken).
    expect(state.calls.find((c) => c.method === "mail.connectComposio")?.args[1]).toEqual({
      provider: "gmail",
      accountId: "mail-2",
      desktop: false,
    });
    expect(left).toEqual(["https://composio.example/connect/gmail"]);
  });

  test("Desconectar asks first", async () => {
    const { api, state } = mailApi([{ address: "ana@example.com" }]);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Desconectar ana@example.com" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar ana@example.com?" });
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "mail.disconnect")?.args[1]).toBe("mail-1");
  });
});

describe("the agent's email rules", () => {
  test("'Enviar sem pedir aprovação' waits for 'Só enviar para'; Salvar sends level, delete and rules", async () => {
    const { api, state } = mailApi([{ address: "ana@example.com" }]);
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    const level = screen().getByRole("radiogroup", { name: "Nível em ana@example.com" });
    await click(within(level).getByRole("radio", { name: "Ler e escrever" }));
    const row = level.closest("li") as HTMLElement;
    // Sends ask by default.
    expect(row.textContent).toContain("Enviar pede aprovação");
    await click(within(row).getByRole("switch", { name: /Pode apagar emails/ }));
    await click(within(row).getByLabelText("Regras de ana@example.com"));
    await settle(4);
    const auto = within(row).getByRole("switch", { name: /Enviar sem pedir aprovação/ });
    expect(auto.hasAttribute("disabled")).toBe(true);
    expect(row.textContent).toContain("Preencha “Só enviar para” antes.");
    // Folders come from the mailbox.
    await click(within(row).getByRole("checkbox", { name: "Clientes" }));
    // A wrong address is refused; an address and a domain go in.
    await type(within(row).getByLabelText("Só enviar para"), "nada");
    await click(within(row).getByRole("button", { name: "Adicionar em Só enviar para" }));
    expect(row.textContent).toContain("Use um email ou @dominio.com.");
    await type(within(row).getByLabelText("Só enviar para"), "joao@cliente.com, @acme.com.br");
    await click(within(row).getByRole("button", { name: "Adicionar em Só enviar para" }));
    expect(within(row).getByRole("list", { name: "Só enviar para" }).textContent).toContain("@acme.com.br");
    expect(auto.hasAttribute("disabled")).toBe(false);
    await click(auto);
    // Reads from anyone and sends without asking: the warning.
    expect(row.textContent).toContain("um email malicioso pode tentar enganar o agente");
    await type(within(row).getByLabelText("Limite de envios por dia"), "10");
    await click(within(row).getByRole("button", { name: "Salvar" }));
    await settle(4);
    const call = state.calls.find((c) => c.method === "mail.setAgent");
    expect(call?.args.slice(1, 3)).toEqual([ADA_ID, "mail-1"]);
    expect(call?.args[3]).toEqual({
      level: "read_write",
      canDelete: true,
      policy: {
        folders: ["Clientes"],
        senders: [],
        windowDays: null,
        allowedRecipients: ["joao@cliente.com", "@acme.com.br"],
        dailySendCap: 10,
        sendWithoutAsking: true,
        fromAddress: null,
      },
    });
    expect(screen().getByText("Email de Ada salvo.")).toBeTruthy();
  });

  test("someone else's mailbox: read-only, says who gives it, and an admin removes the agent's access", async () => {
    const { api, state, mail } = mailApi([{ address: "joao@example.com", ownerUserId: "u-joao" }]);
    mail.agentMail.set(
      ADA_ID,
      new Map([["mail-1", { accountId: "mail-1", level: "read", canDelete: false, policy: defaultPolicy() }]]),
    );
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    // The level is shown, not picked.
    expect(screen().queryByRole("radiogroup", { name: "Nível em joao@example.com" })).toBeNull();
    const [row] = within(screen().getByRole("list", { name: "Email" })).getAllByRole("listitem") as [HTMLElement];
    expect(row.textContent).toContain("Só João pode dar acesso: foi quem conectou esta caixa.");
    expect(within(row).queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(
      within(row)
        .getByRole("switch", { name: /Pode apagar emails/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    await click(within(row).getByRole("button", { name: "Remover acesso" }));
    await settle(4);
    const call = state.calls.find((c) => c.method === "mail.setAgent");
    expect(call?.args.slice(1, 3)).toEqual([ADA_ID, "mail-1"]);
    expect(call?.args[3]).toEqual({ level: "none", canDelete: false, policy: defaultPolicy() });
    expect(screen().getByText("Ada não tem mais acesso a joao@example.com.")).toBeTruthy();
  });

  test("a Gmail still connecting: its name, 'Conectando' and the way to Conectores, no level to pick", async () => {
    const { api } = mailApi([
      { provider: "gmail", via: "composio", preset: null, address: "", label: "", status: "pending" },
      { address: "ana@example.com", status: "needs_reconnect" },
    ]);
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    const [connecting, reconnect] = within(screen().getByRole("list", { name: "Email" })).getAllByRole("listitem") as [
      HTMLElement,
      HTMLElement,
    ];
    expect(connecting.textContent).toContain("GmailConectando");
    expect(connecting.textContent).toContain("Ainda não terminou de conectar.");
    expect(within(connecting).queryByRole("radiogroup")).toBeNull();
    const link = within(connecting).getByRole("link", { name: "Abrir Conectores" });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/settings/connectors`);
    // Needing reconnection: still a level to pick, and what it means.
    expect(reconnect.textContent).toContain("Precisa reconectar");
    expect(reconnect.textContent).toContain("Os agentes só usam depois de reconectar.");
    expect(within(reconnect).getByRole("radiogroup", { name: "Nível em ana@example.com" })).toBeTruthy();
  });

  test("a failed save says what happened; the generic line only for the unexpected", async () => {
    const { api } = mailApi([{ address: "ana@example.com" }]);
    const refusals = [
      new ApiError(404, "mail.account_not_found", "Mailbox not found"),
      new ApiError(400, "mail.from_not_mailbox", "fromAddress must be one of the mailbox's addresses"),
      new ApiError(403, "forbidden", "You don't have permission to do this"),
      new ApiError(500, "internal", "Something broke"),
    ];
    api.mail.setAgent = async () => {
      throw refusals.shift();
    };
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    const level = screen().getByRole("radiogroup", { name: "Nível em ana@example.com" });
    await click(within(level).getByRole("radio", { name: "Ler e escrever" }));
    const row = level.closest("li") as HTMLElement;
    const said: (string | null)[] = [];
    while (refusals.length > 0) {
      await click(within(row).getByRole("button", { name: "Salvar" }));
      await settle(4);
      said.push(within(row).getByRole("alert").textContent);
    }
    expect(said).toEqual([
      "Esta caixa de email não está mais conectada. Conecte de novo em Conectores.",
      "“Enviar como” precisa ser um endereço desta caixa. Escolha outro.",
      "Você não tem permissão para isso.",
      "Não deu para salvar. Tente de novo.",
    ]);
  });

  test("removing the last recipient turns 'Enviar sem pedir aprovação' off", async () => {
    const { api, mail } = mailApi([{ address: "ana@example.com" }]);
    await mail.client.setAgent(ORG_ID, ADA_ID, "mail-1", {
      level: "read_write",
      canDelete: false,
      policy: {
        folders: [],
        senders: ["@acme.com.br"],
        windowDays: 30,
        allowedRecipients: ["@acme.com.br"],
        dailySendCap: 25,
        sendWithoutAsking: true,
        fromAddress: null,
      },
    });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    const row = screen().getByRole("radiogroup", { name: "Nível em ana@example.com" }).closest("li") as HTMLElement;
    // 4 rules: senders, window, recipients, send without asking.
    expect(within(row).getByLabelText("Regras de ana@example.com").textContent).toContain("4");
    await click(within(row).getByLabelText("Regras de ana@example.com"));
    const auto = within(row).getByRole("switch", { name: /Enviar sem pedir aprovação/ });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    const recipients = within(row).getByRole("list", { name: "Só enviar para" });
    await click(within(recipients).getByRole("button", { name: "Remover @acme.com.br" }));
    expect(auto.getAttribute("aria-checked")).toBe("false");
    expect(auto.hasAttribute("disabled")).toBe(true);
  });
});

describe("Rotinas: quando chegar um email", () => {
  test("mailbox, inbox by default and filters; the card shows the mailbox and 'Precisa reconectar'", async () => {
    const { api, state, mail } = mailApi([{ address: "ana@example.com" }]);
    reads(mail, state, ["mail-1"]);
    const created: RoutineInput[] = [];
    const real = api.routines.create;
    api.routines.create = (orgId, input) => {
      created.push(input);
      return real(orgId, input);
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await click(within(dialog).getByRole("radio", { name: "Email" }));
    await settle(4);
    expect(within(dialog).getByRole("combobox", { name: "Caixa de email" }).textContent).toContain("ana@example.com");
    expect(within(dialog).getByRole("combobox", { name: "Pasta" }).textContent).toContain("Caixa de entrada");
    await type(within(dialog).getByLabelText("De"), "@cliente.com");
    await click(within(dialog).getByRole("button", { name: "Adicionar em De" }));
    await type(within(dialog).getByLabelText("Assunto contém"), " pedido ");
    await type(within(dialog).getByLabelText("O que fazer"), "Responda com o status do pedido.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(6);
    expect(created[0]?.trigger).toEqual({
      type: "email",
      accountId: "mail-1",
      folder: "INBOX",
      filter: { from: ["@cliente.com"], subject: "pedido" },
    });
    expect(state.calls.some((c) => c.method === "mail.folders")).toBe(true);
  });

  test("only the mailboxes the routine's agent reads; none read says so and where its access is given", async () => {
    const { api, state, mail } = mailApi([{ address: "ana@example.com" }, { address: "vendas@example.com" }]);
    reads(mail, state, ["mail-2"]);
    // What the agent reads answers late: until then neither select is an empty box.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const agentMail = api.mail.agent;
    api.mail.agent = async (orgId, agentId) => {
      await held;
      return agentMail(orgId, agentId);
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await click(within(dialog).getByRole("radio", { name: "Email" }));
    await settle(6);
    const loading = within(dialog).getByRole("combobox", { name: "Caixa de email" }) as HTMLButtonElement;
    expect([loading.textContent, loading.disabled]).toEqual(["Carregando…", true]);
    expect(within(dialog).getByRole("combobox", { name: "Pasta" }).textContent).toBe("Caixa de entrada");
    await act(async () => release());
    await settle(6);
    const box = within(dialog).getByRole("combobox", { name: "Caixa de email" });
    expect(box.textContent).toContain("vendas@example.com");
    box.focus();
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(2);
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["vendas@example.com"]);
    await act(async () => fireEvent.keyDown(screen().getAllByRole("option")[0] as HTMLElement, { key: "Escape" }));
    await settle(2);
    cleanup();

    const none = mailApi([{ address: "ana@example.com" }]);
    await renderApp(`/org/${ORG_ID}/routines`, { api: none.api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const again = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await click(within(again).getByRole("radio", { name: "Email" }));
    await settle(6);
    expect(within(again).queryByRole("combobox", { name: "Caixa de email" })).toBeNull();
    const note = within(again).getByText(/ainda não lê nenhuma caixa de email/);
    const link = within(note.closest("p") as HTMLElement).getByRole("link");
    expect(link.getAttribute("href")).toMatch(new RegExp(`/org/${ORG_ID}/agents/[^/?]+\\?tab=access`));
  });

  test("an email routine in the list: mail icon, the mailbox in words, 'Precisa reconectar'", async () => {
    const { api } = mailApi([{ address: "ana@example.com" }]);
    const real = api.routines.list;
    api.routines.list = async (orgId) => {
      const list = await real(orgId);
      const first = list[0];
      if (!first) return list;
      return [
        {
          ...first,
          id: "r-mail",
          name: "Pedidos por email",
          trigger: {
            type: "email",
            accountId: "mail-1",
            folder: "Clientes",
            filter: {},
            status: "needs_reconnect",
          },
          nextRunAt: null,
        },
        ...list.slice(1),
      ];
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    const card = screen().getByRole("article", { name: "Pedidos por email" });
    expect(card.textContent).toContain("Quando chegar um email em ana@example.com (Clientes)");
    expect(card.textContent).toContain("Precisa reconectar");
  });
});

describe("Rotinas: quando chegar um email no MillionSend (ADR 0130)", () => {
  test("offered where MillionSend is connected: the inbox's address and filters, then the card in words", async () => {
    const { api, state } = mailApi([]);
    // The routine's agent reads the connection: a routine can wait on it.
    for (const agent of state.agents)
      state.scopes[agent.id] = [...(state.scopes[agent.id] ?? []), { connectionId: "ms-1", scope: "custom:ms-1:read" }];
    api.customConnectors.list = async () => [
      {
        id: "ms-1",
        serverUrl: "https://api.millionsend.com/mcp",
        label: "MillionSend",
        accountLabel: null,
        authType: "oauth",
        iconUrl: null,
        status: "active",
        tools: [],
        events: ["millionsend.email.received"],
        reviewedAt: null,
        createdAt: "2026-11-01T00:00:00Z",
      },
    ];
    const created: RoutineInput[] = [];
    const real = api.routines.create;
    api.routines.create = (orgId, input) => {
      created.push(input);
      return real(orgId, input);
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await click(within(dialog).getByRole("radio", { name: "Email no MillionSend" }));
    await settle(4);
    await type(within(dialog).getByLabelText("Endereço da caixa"), " Vendas@Loja.example ");
    await type(within(dialog).getByLabelText("Assunto contém"), "pedido");
    await type(within(dialog).getByLabelText("O que fazer"), "Responda o pedido.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(6);
    expect(created[0]?.trigger).toEqual({
      type: "connector",
      connectionId: "ms-1",
      event: "millionsend.email.received",
      inboxId: null,
      filter: { to: "vendas@loja.example", subject: "pedido" },
    });
    await settle(6);
    expect(screen().getByText("Quando chegar um email em vendas@loja.example")).toBeTruthy();
  });

  test("an agent that can't read the connection: it says so and where its access is given, before saving", async () => {
    const { api } = mailApi([]);
    api.customConnectors.list = async () => [
      {
        id: "ms-1",
        serverUrl: "https://api.millionsend.com/mcp",
        label: "MillionSend",
        accountLabel: null,
        authType: "oauth",
        iconUrl: null,
        status: "active",
        tools: [],
        events: ["millionsend.email.received"],
        reviewedAt: null,
        createdAt: "2026-11-01T00:00:00Z",
      },
    ];
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await click(within(dialog).getByRole("radio", { name: "Email no MillionSend" }));
    await settle(6);
    const note = within(dialog).getByText(/ainda não lê o MillionSend/);
    expect(
      within(note.closest("p") as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toMatch(new RegExp(`/org/${ORG_ID}/agents/[^/?]+\\?tab=access`));
  });

  test("never offered without a MillionSend connection", async () => {
    const { api } = mailApi([]);
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    expect(within(dialog).queryByRole("radio", { name: "Email no MillionSend" })).toBeNull();
  });
});

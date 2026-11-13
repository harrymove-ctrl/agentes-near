import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Connection, GitHubAppInstallation, GitHubAppSetup } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import { rowMenu } from "./catalog";
import { createFakeApi, type FakeState, meAsAdmin, meWithRole, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const CONNECTORS = `/org/${ORG_ID}/settings/connectors`;
const go = async (state: FakeState, search = "") => {
  window.history.replaceState(null, "", `${CONNECTORS}${search}`);
  const r = await renderApp(`${CONNECTORS}${search}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const panel = () => screen().getByRole("region", { name: "Repositórios do GitHub" });
const toasts = () => [...document.querySelectorAll(".ac-toast")].map((el) => el.textContent ?? "");

const installation = (login: string, over: Partial<GitHubAppInstallation> = {}): GitHubAppInstallation => ({
  id: `00000000-0000-4000-8000-${String(login.length).padStart(12, "0")}`,
  installationId: 100 + login.length,
  accountLogin: login,
  accountType: "Organization",
  repositorySelection: "all",
  suspended: false,
  manageUrl: `https://github.com/organizations/${login}/settings/installations/${100 + login.length}`,
  createdAt: "2026-11-01T12:00:00.000Z",
  ...over,
});
const ACME = installation("acme");
const OCTO = installation("octo-labs", {
  accountType: "User",
  repositorySelection: "selected",
  manageUrl: "https://github.com/settings/installations/109",
});
/** GitHub through the agentes.chat app alone: the connection the server makes with the first installation. */
const appOnly = (accounts: string): Connection => ({
  id: "conn-gh",
  connector: "github",
  label: "GitHub",
  serverUrl: "https://api.githubcopilot.com/mcp/",
  authType: "github_app",
  accountLabel: accounts,
  tokenExpiresAt: null,
  createdAt: "2026-11-01T12:00:00.000Z",
  revokedAt: null,
});
const NO_APP: GitHubAppSetup = { source: null, slug: null, htmlUrl: null, state: "off", canCreate: true };

describe("Conectores › GitHub with the agentes.chat app", () => {
  test("each account: what it reaches, Gerenciar no GitHub on its page there, and Remover uninstalls it after asking", async () => {
    const { state } = await go(seedState({ githubApp: { installable: true, installations: [ACME, OCTO] } }));
    const section = panel();
    // Installed already: the button installs on another account.
    expect(within(section).getByRole("button", { name: "Instalar em outra conta" })).toBeTruthy();
    const rows = within(section);
    expect(section.textContent).toContain("acmeTodos os repositórios");
    expect(section.textContent).toContain("octo-labsRepositórios escolhidos");
    const manage = rows.getByRole("link", { name: "Gerenciar octo-labs no GitHub" });
    expect(manage.getAttribute("href")).toBe("https://github.com/settings/installations/109");
    expect(manage.getAttribute("target")).toBe("_blank");
    await click(rows.getByRole("button", { name: "Remover acme" }));
    const ask = screen().getByRole("dialog", { name: "Remover o app de acme?" });
    // An account is connected too: GitHub stays, nothing about losing it.
    expect(ask.textContent).toContain(
      "O app agentes.chat é desinstalado de acme no GitHub, e os agentes deixam de usar os repositórios dessa conta por ele.",
    );
    expect(ask.textContent).not.toContain("É a última");
    await click(within(ask).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "githubApp.remove")?.args).toEqual([ORG_ID, ACME.id]);
    expect(toasts()).toContain("App removido de acme e desinstalado no GitHub.");
    expect(panel().textContent).not.toContain("acme");
  });

  test("GitHub doesn't confirm the uninstall: the toast says so and opens the installation's page there", async () => {
    const opened: string[] = [];
    const open = window.open;
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    try {
      await go(seedState({ githubApp: { installable: true, installations: [ACME], uninstallRefused: true } }));
      await click(within(panel()).getByRole("button", { name: "Remover acme" }));
      await click(
        within(screen().getByRole("dialog", { name: "Remover o app de acme?" })).getByRole("button", {
          name: "Remover",
        }),
      );
      await settle(4);
      const toast = document.querySelector(".ac-toast") as HTMLElement;
      expect(toast.textContent).toContain(
        "App removido daqui, mas o GitHub não confirmou a desinstalação de acme. Desinstale lá.",
      );
      await click(within(toast).getByRole("button", { name: "Abrir" }));
      expect(opened).toEqual([ACME.manageUrl as string]);
    } finally {
      window.open = open;
    }
  });

  test("nothing installed: who agents show up as today, and the app installs from GitHub's page", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { state } = await go(seedState({ githubApp: { installable: true, installations: [] } }));
    expect(panel().textContent).toContain(
      "Hoje os agentes aparecem no GitHub como acme. Instale o app para eles aparecerem como o app agentes.chat.",
    );
    await click(within(panel()).getByRole("button", { name: "Instalar o app agentes.chat" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "githubApp.install")?.args).toEqual([ORG_ID, CONNECTORS]);
    expect(left[0]).toStartWith("https://github.com/apps/agentes-chat/installations/new");
  });

  test("GitHub through the app alone: its accounts on the row, no Reconectar, an account connects from the panel", async () => {
    const state = seedState({
      connections: [appOnly("acme, octo-labs")],
      githubApp: { installable: true, installations: [ACME, OCTO] },
    });
    await go(state);
    const conectores = screen().getByRole("region", { name: "Conectores" });
    expect(conectores.textContent).toContain("Pelo app agentes.chat em acme e octo-labs");
    expect(conectores.textContent).not.toContain("Conectado como");
    const menu = await rowMenu("GitHub");
    expect(within(menu).queryByRole("menuitem", { name: "Reconectar" })).toBeNull();
    await act(async () => fireEvent.keyDown(menu, { key: "Escape" }));
    await settle(2);
    await click(within(panel()).getByRole("button", { name: "Conectar uma conta do GitHub" }));
    await settle(2);
    const flow = screen().getByRole("dialog", { name: "Conectar GitHub" });
    // Asked for an account: no app choice, GitHub's sign-in straight away, replacing the app's row.
    expect(within(flow).queryByRole("radiogroup")).toBeNull();
    expect(within(flow).getByRole("button", { name: "Continuar no GitHub" })).toBeTruthy();
    expect(flow.textContent).toContain("Substitui o login atual. Quem usa continua igual.");
  });

  test("the last account of the app alone: removing it says agents lose GitHub", async () => {
    await go(seedState({ connections: [appOnly("acme")], githubApp: { installable: true, installations: [ACME] } }));
    await click(within(panel()).getByRole("button", { name: "Remover acme" }));
    expect(screen().getByRole("dialog", { name: "Remover o app de acme?" }).textContent).toContain(
      "É a última, então os agentes ficam sem GitHub até alguém instalar o app ou conectar uma conta.",
    );
  });

  test("Desconectar says what happens to the app: the app alone is uninstalled, an account goes and the app stays", async () => {
    await go(seedState({ connections: [appOnly("acme")], githubApp: { installable: true, installations: [ACME] } }));
    await click(within(await rowMenu("GitHub")).getByRole("menuitem", { name: "Desconectar" }));
    expect(screen().getByRole("dialog", { name: "Desconectar GitHub?" }).textContent).toContain(
      "O app agentes.chat também é desinstalado de acme no GitHub.",
    );
    cleanup();
    const { state } = await go(seedState({ githubApp: { installable: true, installations: [ACME, OCTO] } }));
    await click(within(await rowMenu("GitHub")).getByRole("menuitem", { name: "Desconectar" }));
    const ask = screen().getByRole("dialog", { name: "Desconectar GitHub?" });
    expect(ask.textContent).toContain("Os agentes continuam no GitHub pelo app agentes.chat em acme e octo-labs.");
    await click(within(ask).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.disconnect")?.args).toEqual([ORG_ID, "conn-gh"]);
    expect(toasts()).toContain("Conta do GitHub desconectada. Os agentes continuam no GitHub pelo app agentes.chat.");
  });

  test("no app on this server: an admin is told its owner makes it, a member sees nothing", async () => {
    const admin = seedState({ githubApp: { installable: false, installations: [], ownerCreates: true } });
    meAsAdmin(admin);
    await go(admin);
    expect(panel().textContent).toContain("O dono deste servidor pode criar o app do GitHub aqui em Conectores.");
    expect(within(panel()).queryByRole("button", { name: /Instalar/ })).toBeNull();
    expect(screen().queryByRole("region", { name: "App do GitHub deste servidor" })).toBeNull();
    cleanup();
    const member = seedState({ githubApp: { installable: false, installations: [], ownerCreates: true } });
    meWithRole(member, []);
    await go(member);
    expect(screen().queryByRole("region", { name: "Repositórios do GitHub" })).toBeNull();
  });
});

describe("Conectar GitHub: the agentes.chat app first", () => {
  const connect = async (state: FakeState) => {
    const r = await go(state);
    await click(screen().getAllByRole("button", { name: "Adicionar conector" })[0] as HTMLElement);
    const add = screen().getByRole("dialog", { name: "Adicionar conector" });
    await click(within(add).getByRole("button", { name: "GitHub" }));
    await click(
      within(screen().getByRole("dialog", { name: "GitHub" })).getByRole("button", { name: "Conectar GitHub" }),
    );
    await settle(4);
    return { ...r, flow: screen().getByRole("dialog", { name: "Conectar GitHub" }) };
  };

  test("the app is the recommended way, installed on GitHub's page; an account is the other, with its key", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { state, flow } = await connect(
      seedState({ connections: [], githubApp: { installable: true, installations: [] } }),
    );
    const how = within(flow).getByRole("radiogroup", { name: "Como os agentes entram no GitHub" });
    const [app, account] = within(how).getAllByRole("radio");
    expect(app?.textContent).toBe(
      "O app agentes.chatRecomendadoOs agentes aparecem como o app, e você escolhe os repositórios no GitHub.",
    );
    expect(app?.getAttribute("aria-checked")).toBe("true");
    expect(account?.textContent).toBe(
      "Uma conta do GitHubOs agentes aparecem como essa conta. O GitHub Projects de uma conta pessoal precisa de uma.",
    );
    expect(flow.textContent).toContain("Você escolhe as contas e os repositórios no GitHub e volta para cá.");
    // The account's key is the account's other way in: not offered for the app.
    expect(within(flow).queryByText("Conectar com uma chave de API")).toBeNull();
    await click(within(flow).getByRole("button", { name: "Instalar o app agentes.chat" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "githubApp.install")?.args).toEqual([ORG_ID, CONNECTORS]);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")).toBeUndefined();
    expect(left[0]).toStartWith("https://github.com/apps/agentes-chat/installations/new");

    await click(account as HTMLElement);
    expect(within(flow).getByText("Conectar com uma chave de API")).toBeTruthy();
    expect(within(flow).queryByRole("button", { name: "Instalar o app agentes.chat" })).toBeNull();
    await click(within(flow).getByRole("button", { name: "Continuar no GitHub" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")?.args.slice(0, 2)).toEqual([ORG_ID, "github"]);
  });

  test("a server without the app: GitHub's sign-in as before", async () => {
    const { flow } = await connect(seedState({ connections: [] }));
    expect(within(flow).queryByRole("radiogroup")).toBeNull();
    expect(within(flow).getByRole("button", { name: "Continuar no GitHub" })).toBeTruthy();
  });
});

describe("Conectores › App do GitHub deste servidor (its owner, off agentes.chat)", () => {
  const card = () => screen().getByRole("region", { name: "App do GitHub deste servidor" });

  test("none yet: Criar o app no GitHub opens this server's page that sends GitHub the manifest", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { state } = await go(seedState({ githubApp: { installable: false, installations: [], setup: NO_APP } }));
    expect(card().textContent).toContain("Desligado");
    expect(card().textContent).toContain(
      "O GitHub cria o app na sua conta com tudo preenchido e volta para cá. Para ele ficar numa organização, transfira depois no GitHub.",
    );
    // The owner makes it: the admins' hint isn't for them, and nothing can be installed yet.
    expect(screen().queryByRole("region", { name: "Repositórios do GitHub" })).toBeNull();
    await click(within(card()).getByRole("button", { name: "Criar o app no GitHub" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "githubApp.startManifest")?.args).toEqual([CONNECTORS]);
    expect(left).toEqual(["https://chat.example.com/api/app/github-app/manifest/start?state=s"]);
  });

  test("made here: its name and page, and Remover o app after asking", async () => {
    const setup: GitHubAppSetup = {
      source: "settings",
      slug: "agentes-chat-example",
      htmlUrl: "https://github.com/apps/agentes-chat-example",
      state: "ok",
      canCreate: false,
    };
    const { state } = await go(seedState({ githubApp: { installable: true, installations: [], setup } }));
    expect(card().textContent).toContain("Ligado");
    expect(card().textContent).toContain("agentes-chat-example");
    expect(within(card()).getByRole("link", { name: "Abrir no GitHub" }).getAttribute("href")).toBe(setup.htmlUrl);
    await click(within(card()).getByRole("button", { name: "Remover o app" }));
    const ask = screen().getByRole("dialog", { name: "Remover o app do GitHub deste servidor?" });
    expect(ask.textContent).toContain("Todos os workspaces daqui deixam de alcançar o GitHub por ele na hora.");
    await click(within(ask).getByRole("button", { name: "Remover o app" }));
    await settle(6);
    expect(state.calls.some((c) => c.method === "githubApp.removeSettings")).toBe(true);
    expect(toasts()).toContain("App do GitHub removido deste servidor.");
    expect(within(card()).getByRole("button", { name: "Criar o app no GitHub" })).toBeTruthy();
  });

  test("from the server's settings: said where, nothing to change here; one it can't open says the way out", async () => {
    const env: GitHubAppSetup = { source: "env", slug: "agentes-chat", htmlUrl: null, state: "ok", canCreate: false };
    await go(seedState({ githubApp: { installable: true, installations: [], setup: env } }));
    expect(card().textContent).toContain("Definido nas configurações deste servidor (GITHUB_APP_ID).");
    expect(within(card()).queryByRole("button")).toBeNull();
    cleanup();
    const broken: GitHubAppSetup = { ...env, source: "settings", slug: "agentes-chat-example", state: "invalid" };
    await go(seedState({ githubApp: { installable: false, installations: [], setup: broken } }));
    expect(card().textContent).toContain("Inválido");
    expect(card().textContent).toContain("Este servidor não consegue abrir o app salvo. Remova e crie de novo.");
    expect(within(card()).getByRole("button", { name: "Remover o app" })).toBeTruthy();
  });
});

describe("worst case (break-ui)", () => {
  test("39-character logins, a 34-character app, twelve accounts, suspended and chosen repositories", async () => {
    const long = "a-very-long-github-organization-name-39";
    const installations = Array.from({ length: 12 }, (_, n) =>
      installation(n === 0 ? long : `${long.slice(0, 30)}-${String(n).padStart(2, "0")}`, {
        id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
        suspended: n % 5 === 1,
        repositorySelection: n % 2 ? "selected" : "all",
      }),
    );
    await go(
      seedState({
        connections: [appOnly(installations.map((i) => i.accountLogin).join(", "))],
        githubApp: {
          installable: true,
          installations,
          setup: {
            source: "settings",
            slug: "agentes-chat-a-very-long-host-name",
            htmlUrl: "https://github.com/apps/agentes-chat-a-very-long-host-name",
            state: "invalid",
            canCreate: false,
          },
        },
      }),
    );
    expect(within(panel()).getAllByRole("link", { name: /^Gerenciar / })).toHaveLength(12);
    expect(panel().textContent).toContain("Suspenso no GitHub");
    expect(screen().getByRole("region", { name: "App do GitHub deste servidor" }).textContent).toContain(
      "agentes-chat-a-very-long-host-name",
    );
    cleanup();
    // The account line with a long login.
    const state = seedState({ githubApp: { installable: true, installations: [] } });
    state.connections = state.connections.map((c) => ({ ...c, accountLabel: long }));
    await go(state);
    expect(panel().textContent).toContain(`Hoje os agentes aparecem no GitHub como ${long}.`);
  });
});

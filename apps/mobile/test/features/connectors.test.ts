import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApiError,
  type Connection,
  type ConnectorDef,
  type CustomServer,
  type GitHubAppInfo,
  type GitHubAppInstallation,
} from "@agenteschat/client";
import { connectedItems, isMcpItem, itemName } from "@agenteschat/client/lib/connected";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import {
  appAccountsText,
  githubAppPanel,
  githubDisconnectNote,
  installationReach,
  missingEventsText,
  removedText,
  removeInstallationText,
} from "@agenteschat/client/lib/github-app";
import type { TFunction } from "i18next";
import {
  accountActions,
  authAnswerOf,
  brandOf,
  capabilityLines,
  connectHow,
  connectionOf,
  doneFinishing,
  galleryTiles,
  iconUri,
  installationIdOf,
  isFinishing,
  isHttpsUrl,
  markFinishing,
  monogram,
  needsKeyText,
  ownMarkUri,
  searchConnectors,
  shownMailboxes,
  stateOf,
  suggestionsOf,
} from "../../src/features/connectors/logic";
import { translator } from "./fixtures";

const def = (id: string, over: Partial<ConnectorDef> = {}): ConnectorDef => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  description: `${id} for Acme`,
  kind: "catalog",
  category: "dev",
  auth: ["oauth", "api_key"],
  oauthConfigured: true,
  available: true,
  serverUrl: `https://mcp.${id}.example/mcp`,
  iconUrl: `/connectors/${id}.svg`,
  brandColor: "#181717",
  scopes: [],
  tools: [],
  ...over,
});

const conn = (connector: string, over: Partial<Connection> = {}): Connection => ({
  id: `c-${connector}`,
  connector,
  label: connector,
  serverUrl: "https://mcp.example.com",
  authType: "oauth",
  accountLabel: null,
  tokenExpiresAt: null,
  createdAt: "2026-10-23T12:00:00.000Z",
  revokedAt: null,
  ...over,
});

const server = (serverUrl: string): CustomServer => ({
  id: "s-1",
  serverUrl,
  label: "Sentry",
  authType: "oauth",
  tools: [],
  reviewedAt: "2026-10-23T12:00:00.000Z",
  createdAt: "2026-10-23T12:00:00.000Z",
});

describe("connectors gallery", () => {
  test("connected as the web counts it: our connector's connection, or a vendor's server by its address", () => {
    const github = def("github");
    const sentry = def("sentry", { kind: "remote_mcp", serverUrl: "https://mcp.sentry.dev/mcp" });
    const catalog = [github, sentry];
    expect(connectionOf(github, connectedItems([conn("github")], [], catalog))?.id).toBe("c-github");
    // Sentry connected on the web lives in the servers' list (its address may differ by a slash or case).
    const items = connectedItems([], [server("https://MCP.sentry.dev/mcp/")], catalog);
    expect(connectionOf(sentry, items)?.id).toBe("s-1");
    expect(connectionOf(github, items)).toBeUndefined();
    const revoked = conn("github", { revokedAt: "2026-10-23T13:00:00.000Z" });
    expect(connectionOf(github, connectedItems([revoked], [], catalog))).toBeUndefined();
  });

  test("the MCPs strip: a server by an address the catalog doesn't list; a vendor's listed server stays a connector", () => {
    const sentry = def("sentry", { kind: "remote_mcp", serverUrl: "https://mcp.sentry.dev/mcp" });
    const items = connectedItems(
      [conn("github")],
      [server("https://mcp.sentry.dev/mcp"), server("https://mcp.acme.dev/mcp")],
      [def("github"), sentry],
    );
    expect(items.filter(isMcpItem).map((i) => i.server?.serverUrl)).toEqual(["https://mcp.acme.dev/mcp"]);
    expect(items.filter((i) => !isMcpItem(i)).length).toBe(2);
  });

  test("suggestions: the first three ready here and not connected, in our order", () => {
    const catalog = ["github", "linear", "notion", "drive", "sentry"].map((id) => def(id));
    catalog[2] = def("notion", { available: false });
    const items = connectedItems([conn("github")], [], catalog);
    expect(suggestionsOf(catalog, items).map((d) => d.id)).toEqual(["linear", "drive", "sentry"]);
  });

  test("'Em breve': a vendor that hasn't approved agentes.chat yet is last, greyed with a lock, and opens nothing", () => {
    const asana = def("asana", { kind: "remote_mcp", available: false, soon: true });
    const slack = def("slack", { available: false });
    expect(
      galleryTiles([asana, def("github"), slack, def("linear")], []).map((x) => [x.def.id, x.opens, x.locked]),
    ).toEqual([
      ["github", true, false],
      ["linear", true, false],
      ["asana", false, true],
      ["slack", false, false],
    ]);
  });

  test("a 'soon' one connected by its address (with a key) is a connection like any other: a check, no lock, it opens", () => {
    const asana = def("asana", {
      kind: "remote_mcp",
      serverUrl: "https://mcp.asana.com/mcp",
      available: false,
      soon: true,
    });
    const list = [def("slack", { available: false }), asana, def("github")];
    const items = connectedItems([], [server("https://mcp.asana.com/mcp")], list);
    // With the ones that open, before what can't connect here.
    expect(galleryTiles(list, items).map((x) => [x.def.id, x.connected, x.opens, x.locked])).toEqual([
      ["asana", true, true, false],
      ["github", false, true, false],
      ["slack", false, false, false],
    ]);
  });

  test("through Composio on a server without it: hidden, unless already connected (ADR 0107)", () => {
    const url = "https://backend.composio.dev/api/v3.1/toolkits/googledrive";
    const drive = def("drive", { kind: "remote_mcp", via: "composio", available: false, serverUrl: url });
    expect(galleryTiles([drive, def("github")], []).map((x) => x.def.id)).toEqual(["github"]);
    const items = connectedItems([], [{ ...server(url), via: "composio" }], [drive]);
    expect(galleryTiles([drive], items).map((x) => [x.def.id, x.connected, x.opens])).toEqual([["drive", true, true]]);
    // Its account shows no address: Composio's means nothing to people.
    expect(items[0]?.account).toBeNull();
  });

  test("a server whose OAuth only lets in apps it approved says so; one with no sign-in just asks for a key", async () => {
    const pt = await translator("pt-BR");
    expect(needsKeyText(pt, { status: "needs_key", reason: "not_approved" }, "Asana")).toBe(
      "Asana só deixa entrar apps que aprovou, e o agentes.chat ainda não foi aprovado. Se ele te der uma chave de API, dá para conectar com ela.",
    );
    expect(needsKeyText(pt, { status: "needs_key" }, "Asana")).toBe("Esse servidor pede uma chave.");
    const en = await translator("en");
    expect(needsKeyText(en, { status: "needs_key", reason: "not_approved" }, "Asana")).toBe(
      "Asana only lets apps it approved sign in, and agentes.chat isn't approved yet. If it gives you an API key, you can connect with that.",
    );
    // The server's own words under ours: which one refused and why.
    const said = { status: "needs_key", reason: "not_approved", detail: "invalid_redirect_uri: not allowed" } as const;
    expect(needsKeyText(pt, said, "Asana")).toBe(
      "Asana só deixa entrar apps que aprovou, e o agentes.chat ainda não foi aprovado. Se ele te der uma chave de API, dá para conectar com ela.\nO servidor respondeu: invalid_redirect_uri: not allowed",
    );
    expect(needsKeyText(en, said, "Asana").split("\n")[1]).toBe(
      "The server answered: invalid_redirect_uri: not allowed",
    );
  });

  test("search covers the name, id, description and the translated text", () => {
    const list = [def("github"), def("stripe", { description: "Payments" })];
    expect(searchConnectors(list, "pay").map((d) => d.id)).toEqual(["stripe"]);
    const shown = (d: ConnectorDef) => (d.id === "stripe" ? "Cobranças" : "");
    expect(searchConnectors(list, "cobrança", shown).map((d) => d.id)).toEqual(["stripe"]);
    expect(searchConnectors(list, "  ")).toHaveLength(2);
  });

  test("how it connects on the phone", () => {
    expect(connectHow(def("github"))).toBe("either");
    expect(connectHow(def("sentry", { oauthConfigured: false }))).toBe("key");
    expect(connectHow(def("drive", { auth: ["oauth"] }))).toBe("signIn");
    expect(connectHow(def("linear", { kind: "remote_mcp" }))).toBe("signIn");
  });

  test("what agents could do: our plain lines when we have them (ask last), else the scopes", () => {
    const words: Record<string, string> = {
      "connectors.can.github.1": "Ler código",
      "connectors.can.github.2": "Abrir PRs",
      "connectors.can.github.ask": "Fazer merge",
    };
    const tr = (k: string) => words[k] ?? k;
    const exists = (k: string) => k in words;
    expect(capabilityLines(tr, exists, def("github"), () => "")).toEqual([
      { text: "Ler código", asks: false },
      { text: "Abrir PRs", asks: false },
      { text: "Fazer merge", asks: true, said: true },
    ]);
    const sentry = def("sentry", {
      scopes: [
        { id: "sentry:issues.read", label: "Read issues", description: "", sensitive: false },
        { id: "sentry:issues.resolve", label: "Resolve issues", description: "", sensitive: true },
      ],
    });
    expect(capabilityLines(tr, exists, sentry, (s) => s.label)).toEqual([
      { text: "Read issues", asks: false },
      { text: "Resolve issues", asks: true },
    ]);
  });

  test("the connected row leaves out sign-ins still pending", () => {
    const boxes = [
      { id: "m1", status: "active", label: "Suporte" },
      { id: "m2", status: "pending", label: "" },
      { id: "m3", status: "needs_reconnect", label: "Vendas" },
    ];
    expect(shownMailboxes(boxes).map((a) => a.id)).toEqual(["m1", "m3"]);
  });
});

describe("several accounts of one service", () => {
  const t = ((key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key) as unknown as TFunction;
  const sentry = def("sentry", { kind: "remote_mcp", serverUrl: "https://mcp.sentry.dev/mcp" });
  const items = connectedItems(
    [conn("github", { label: "Github" })],
    [
      server("https://mcp.sentry.dev/mcp"),
      { ...server("https://mcp.sentry.dev/mcp"), id: "s-2", label: "Sentry 2", createdAt: "2026-10-24T12:00:00.000Z" },
    ],
    [def("github"), sentry],
  );

  test("the connected strip and each screen name every account apart", () => {
    expect(items.map((i) => itemName(t, i))).toEqual(["Github", "Sentry", "Sentry 2"]);
  });

  test("a connected account's screen: rename and sign in again; an MCP server also takes another account", () => {
    expect(items.map((i) => accountActions(i))).toEqual([
      ["rename", "reconnect"],
      ["rename", "reconnect", "add"],
      ["rename", "reconnect", "add"],
    ]);
  });
});

describe("the browser round trip", () => {
  test("the state in the authorize URL, and the answer the browser brings back", () => {
    expect(stateOf("https://github.com/login/oauth/authorize?state=abc&client_id=x")).toBe("abc");
    expect(stateOf("not a url")).toBeNull();
    expect(authAnswerOf("agenteschat://connectors/oauth?state=abc&code=123")).toEqual({
      kind: "code",
      state: "abc",
      code: "123",
    });
    expect(authAnswerOf("agenteschat://connectors/oauth?error=access_denied")).toEqual({
      kind: "error",
      error: "access_denied",
    });
    expect(authAnswerOf("agenteschat://connectors/oauth?state=abc")).toBeNull();
  });

  test("the agentes.chat GitHub app's install comes back with its installation, finished with the app's session", () => {
    expect(authAnswerOf("agenteschat://connectors/oauth?state=abc&code=123&installation_id=42")).toEqual({
      kind: "code",
      state: "abc",
      code: "123",
      installationId: 42,
    });
    // Asked of the account's owner: no installation yet, said as news.
    expect(authAnswerOf("agenteschat://connectors/oauth?error=requested")).toEqual({
      kind: "error",
      error: "requested",
    });
    // Only a whole positive number is an installation.
    for (const bad of ["", "0", "-3", "4.5", "abc", "9007199254740993"]) {
      expect(installationIdOf(bad)).toBeUndefined();
      expect(authAnswerOf(`agenteschat://connectors/oauth?state=s&code=c&installation_id=${bad}`)).toEqual({
        kind: "code",
        state: "s",
        code: "c",
      });
    }
    expect(installationIdOf(undefined)).toBeUndefined();
    expect(installationIdOf("7")).toBe(7);
  });

  test("an authorization the sheet is finishing is left alone by the link route", () => {
    markFinishing("s1");
    expect(isFinishing("s1")).toBe(true);
    doneFinishing("s1");
    expect(isFinishing("s1")).toBe(false);
  });
});

test("icons only from our own path; brand colors only as #rrggbb; monograms; https addresses", () => {
  expect(iconUri("https://app.agentes.chat", "/connectors/github.svg")).toBe(
    "https://app.agentes.chat/connectors/github.svg",
  );
  expect(iconUri("https://app.agentes.chat", "https://evil.example/x.svg")).toBeNull();
  expect(iconUri("https://app.agentes.chat", null)).toBeNull();
  // A mark in its maker's colors (PayPal's, Canva's) is drawn as it is, never tinted, and only a file of ours.
  expect(ownMarkUri("https://app.agentes.chat", "/brands/paypal.svg")).toBe(
    "https://app.agentes.chat/brands/paypal.svg",
  );
  expect(iconUri("https://app.agentes.chat", "/brands/paypal.svg")).toBeNull();
  expect(ownMarkUri("https://app.agentes.chat", "/connectors/github.svg")).toBeNull();
  expect(ownMarkUri("https://app.agentes.chat", "/brands/../x.svg")).toBeNull();
  expect(ownMarkUri("https://app.agentes.chat", "https://evil.example/brands/x.svg")).toBeNull();
  expect(brandOf("#1a2b3c")).toBe("#1a2b3c");
  expect(brandOf("red")).toBeNull();
  expect(monogram("Google Drive")).toBe("GD");
  expect(monogram("acme")).toBe("A");
  expect(isHttpsUrl("https://mcp.acme.dev/sse")).toBe(true);
  expect(isHttpsUrl("http://mcp.acme.dev")).toBe(false);
});

describe("Ferramentas: Salvar stays at hand", () => {
  const read = (path: string) =>
    Bun.file(new URL(`../../src/features/connectors/${path}`, import.meta.url).pathname).text();

  test("Salvar is pinned outside the scroll, and no changed tool waits for an Aceitar", async () => {
    const [screen, review] = await Promise.all([read("ToolsScreen.tsx"), read("ToolReview.tsx")]);
    expect(screen).not.toContain("ChangedTools");
    // Salvar sits in the bar under the scroll, never at the end of a long list.
    expect(screen.indexOf("<BottomBar")).toBeGreaterThan(screen.indexOf("</ScrollView>"));
    expect(review).toContain("{onSaveBar ? null : <Button");
  });
});

describe("GitHub through the agentes.chat app (ADR 0156), as the web shows it", () => {
  const install = (login: string, over: Partial<GitHubAppInstallation> = {}): GitHubAppInstallation => ({
    id: `i-${login}`,
    installationId: login.length,
    accountLogin: login,
    accountType: "Organization",
    repositorySelection: "all",
    suspended: false,
    manageUrl: `https://github.com/organizations/${login}/settings/installations/${login.length}`,
    createdAt: "2026-11-01T12:00:00.000Z",
    ...over,
  });
  const info = (over: Partial<GitHubAppInfo> = {}): GitHubAppInfo => ({
    installable: true,
    installations: [],
    setup: null,
    ownerCreates: false,
    ...over,
  });
  const account = conn("github", { accountLabel: "acme" });
  const appAlone = conn("github", { authType: "github_app", accountLabel: "acme" });

  test("the group: install first or on another account, who agents are today, an account for the app alone", () => {
    expect(githubAppPanel(undefined, true, account)).toBeNull();
    // No app here and nothing installed: nothing to show, but an admin whose server owner can make one is told.
    expect(githubAppPanel(info({ installable: false }), true, account)).toBeNull();
    expect(githubAppPanel(info({ installable: false, ownerCreates: true }), false, account)).toBeNull();
    expect(githubAppPanel(info({ installable: false, ownerCreates: true }), true, account)).toMatchObject({
      ownerHint: true,
      install: null,
    });
    // The owner gets the server's app instead of the hint.
    const owner = info({
      installable: false,
      ownerCreates: true,
      setup: { source: null, slug: null, htmlUrl: null, state: "off", canCreate: true },
    });
    expect(githubAppPanel(owner, true, account)).toBeNull();
    expect(githubAppPanel(info(), true, account)).toEqual({
      installations: [],
      install: "first",
      usingAccount: "acme",
      connectAccount: false,
      ownerHint: false,
    });
    const two = [install("acme"), install("octo-labs")];
    expect(githubAppPanel(info({ installations: two }), true, appAlone)).toEqual({
      installations: two,
      install: "more",
      usingAccount: null,
      connectAccount: true,
      ownerHint: false,
    });
    // Someone who can't manage connectors sees the accounts, never the buttons.
    expect(githubAppPanel(info({ installations: two }), false, appAlone)).toMatchObject({
      install: null,
      connectAccount: false,
    });
  });

  test("GitHub through the app alone has no sign-in to renew: only its name", () => {
    const [github] = connectedItems([appAlone], [], [def("github")]);
    expect(github?.viaGithubApp).toBe(true);
    expect(accountActions(github as NonNullable<typeof github>)).toEqual(["rename"]);
  });

  test("an app made without the events agents hear says which to tick, by GitHub's own names", async () => {
    const pt = await translator("pt-BR");
    const events = {
      missing: ["issue_comment", "pull_request_review"],
      url: "https://github.com/settings/apps/x/permissions",
    };
    expect(missingEventsText(pt, { events })).toBe(
      "Para os agentes ouvirem o que acontece no GitHub, marque estes eventos no app: Issue comment e Pull request review.",
    );
    expect(missingEventsText(pt, { events: { ...events, missing: [] } })).toBeNull();
    expect(missingEventsText(pt, null)).toBeNull();
  });

  test("its words in both languages: the state, the removal and what Desconectar does to the app", async () => {
    for (const lng of ["pt-BR", "en"] as const) {
      const tr = await translator(lng);
      const said = {
        reach: [
          installationReach(tr, install("a")),
          installationReach(tr, install("a", { repositorySelection: "selected" })),
          installationReach(tr, install("a", { suspended: true })),
        ],
        remove: removeInstallationText(tr, "acme", false),
        last: removeInstallationText(tr, "acme", true),
        removed: [removedText(tr, "acme", true), removedText(tr, "acme", false)],
        row: [
          appAccountsText(tr, "acme"),
          appAccountsText(tr, Array.from({ length: 12 }, (_, n) => `org-${n}`).join(", ")),
        ],
        appAlone: githubDisconnectNote(tr, { def: def("github"), viaGithubApp: true }, [install("acme")]),
        account: githubDisconnectNote(tr, { def: def("github") }, [install("acme"), install("octo-labs")]),
        none: githubDisconnectNote(tr, { def: def("github") }, []),
        other: githubDisconnectNote(tr, { def: def("linear") }, [install("acme")]),
      };
      expect(said).toEqual(
        lng === "pt-BR"
          ? {
              reach: ["Todos os repositórios", "Repositórios escolhidos", "Suspenso no GitHub"],
              remove:
                "O app agentes.chat é desinstalado de acme no GitHub, e os agentes deixam de usar os repositórios dessa conta por ele.",
              last: "O app agentes.chat é desinstalado de acme no GitHub, e os agentes deixam de usar os repositórios dessa conta por ele. É a última, então os agentes ficam sem GitHub até alguém instalar o app ou conectar uma conta.",
              removed: [
                "App removido de acme e desinstalado no GitHub.",
                "App removido daqui, mas o GitHub não confirmou a desinstalação de acme. Desinstale lá.",
              ],
              row: ["Pelo app agentes.chat em acme", "Pelo app agentes.chat em org-0, org-1 e mais 10"],
              appAlone: "O app agentes.chat também é desinstalado de acme no GitHub.",
              account: "Os agentes continuam no GitHub pelo app agentes.chat em acme e octo-labs.",
              none: null,
              other: null,
            }
          : {
              reach: ["All repositories", "Selected repositories", "Suspended on GitHub"],
              remove:
                "The agentes.chat app is uninstalled from acme on GitHub, and agents stop using that account's repositories through it.",
              last: "The agentes.chat app is uninstalled from acme on GitHub, and agents stop using that account's repositories through it. It's the last one, so agents lose GitHub until someone installs the app or connects an account.",
              removed: [
                "App removed from acme and uninstalled on GitHub.",
                "App removed here, but GitHub didn't confirm the uninstall from acme. Uninstall it there.",
              ],
              row: [
                "Through the agentes.chat app on acme",
                "Through the agentes.chat app on org-0, org-1, and 10 more",
              ],
              appAlone: "The agentes.chat app is also uninstalled from acme on GitHub.",
              account: "Agents stay on GitHub through the agentes.chat app on acme and octo-labs.",
              none: null,
              other: null,
            },
      );
    }
  });

  test("the sheet offers the app first and finishes its install itself; the link route finishes it with the app closed", async () => {
    const read = (path: string) =>
      Bun.file(new URL(`../../src/features/connectors/${path}`, import.meta.url).pathname).text();
    const [sheet, back, app] = await Promise.all([
      read("ConnectSheet.tsx"),
      read("OAuthReturn.tsx"),
      read("GitHubApp.tsx"),
    ]);
    expect(sheet).toContain("useInstallGitHubAppHere()");
    expect(sheet.indexOf('t("githubApp.install")')).toBeLessThan(
      sheet.indexOf('t("mobile.connectors.githubApp.useAccount")'),
    );
    expect(back).toContain("useCompleteGitHubApp(orgId)");
    expect(back).toContain("installationIdOf(params.installation_id)");
    // The server's own app is made in the browser, on Conectores of the web.
    expect(app).toContain("/settings/connectors`)");
  });

  test("a provider refusing this server's own app: the finish says what's wrong and who fixes it", async () => {
    // What the server answers the app's finish (`…/github-app/complete`, `…/connectors/oauth/complete`), which the
    // sheet and the link route say with knownErrorText.
    const app = new ApiError(500, "github_app.misconfigured", "GitHub refused this server's GitHub App");
    const sentry = new ApiError(500, "connector.misconfigured", "Sentry refused this server's OAuth app", {
      provider: "Sentry",
    });
    for (const lng of ["pt-BR", "en"] as const) {
      const tr = await translator(lng);
      expect([knownErrorText(tr, app), knownErrorText(tr, sentry)]).toEqual(
        lng === "pt-BR"
          ? [
              "O app do GitHub está com a chave secreta errada no servidor, então a instalação não conclui. Quem cuida do servidor precisa trocar a chave nas configurações do app.",
              "A conexão com Sentry está mal configurada no servidor, então ela não conclui. Quem cuida do servidor precisa trocar a chave nas configurações do app.",
            ]
          : [
              "The GitHub app has the wrong secret key on the server, so the install can't finish. Whoever runs the server needs to replace the key in the app's settings.",
              "The connection to Sentry is set up wrong on the server, so it can't finish. Whoever runs the server needs to replace the key in the app's settings.",
            ],
      );
    }
  });
});

describe("a connection that stopped working", () => {
  test("a dead sign-in or unread tools: the strip's tile waits with why, and the screen says so first", () => {
    const def = { id: "github", label: "GitHub", kind: "catalog", tools: [] } as unknown as ConnectorDef;
    const dead = {
      id: "c1",
      connector: "github",
      label: "GitHub",
      createdAt: "2026-11-01T00:00:00Z",
      revokedAt: null,
      status: "needs_reconnect",
    } as unknown as Connection;
    const unread = {
      id: "s1",
      label: "Suporte",
      serverUrl: "https://mcp.suporte.dev",
      createdAt: "2026-11-02T00:00:00Z",
      tools: [],
      toolsError: "upstream timed out",
    } as unknown as CustomServer;
    const [gh, sup] = connectedItems([dead], [unread], [def]);
    expect([gh?.needsReconnect, gh?.toolsError]).toEqual([true, null]);
    expect([sup?.needsReconnect, sup?.toolsError]).toEqual([false, "upstream timed out"]);
    const src = (f: string) => readFileSync(join(import.meta.dir, "../../src/features/connectors", f), "utf8");
    const strip = src("ConnectorsScreen.tsx");
    const tile = strip.slice(strip.indexOf("function ConnectedTile("), strip.indexOf("const TILE_IN"));
    expect(tile).toContain('t("connectors.composio.needsReconnect")');
    expect(tile).toContain('t("connectors.noToolsNow")');
    expect(src("ConnectionScreen.tsx")).toContain('t("mobile.connectors.noTools", { name })');
  });
});

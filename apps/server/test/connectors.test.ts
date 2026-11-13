import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createFakeComposioClient, createFakeErrorReporter, createFakeMailConnector } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { type McpConnect, mcpPreset } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("connectors API: catalog, API-key connection (masked), agent scopes, OAuth start and callback", async () => {
  let challenge = "";
  const http = (async (_url: string, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    const ok =
      createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url") === challenge;
    return ok
      ? Response.json({ access_token: "gho_live", expires_in: 3600 })
      : Response.json({ error: "bad" }, { status: 400 });
  }) as unknown as typeof fetch;
  t = await createTestServer({
    http,
    env: { CONNECTOR_GITHUB_CLIENT_ID: "gh-id", CONNECTOR_GITHUB_CLIENT_SECRET: "gh-secret" },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);

  const catalog = (await (await owner("/api/app/connectors/catalog")).json()) as {
    connectors: { id: string; oauthConfigured: boolean; scopes: { id: string; sensitive: boolean }[] }[];
    builtinScopes: { id: string }[];
  };
  const github = catalog.connectors.find((c) => c.id === "github");
  expect(github?.oauthConfigured).toBe(true);
  expect(github?.scopes.find((s) => s.id === "github:pr.merge")?.sensitive).toBe(true);
  // No Linear OAuth app here: Linear is the one-click MCP server.
  expect(catalog.connectors.find((c) => c.id === "linear")).toMatchObject({ kind: "remote_mcp" });
  expect(catalog.builtinScopes.map((s) => s.id)).toContain("context:read");

  const created = await owner(`/api/app/organizations/${orgId}/connectors`, {
    json: { connector: "sentry", apiKey: "sntrys_secret_value" },
  });
  expect(created.status).toBe(201);
  const sentry = (await created.json()) as { id: string };
  const listed = await (await owner(`/api/app/organizations/${orgId}/connectors`)).text();
  expect(listed).toContain(sentry.id);
  expect(listed).not.toContain("sntrys_secret_value");
  // Connected without the web's dialog (the API, the phone): every agent has it whole, as the dialog starts.
  const access = (await (await owner(`/api/app/organizations/${orgId}/agents/${agentId}/access`)).json()) as {
    connectors: { connectionId: string; state: string }[];
  };
  expect(access.connectors.find((c) => c.connectionId === sentry.id)?.state).toBe("granted");

  const put = await owner(`/api/app/organizations/${orgId}/agents/${agentId}/scopes`, {
    method: "PUT",
    json: {
      scopes: [
        { connectionId: sentry.id, scope: "sentry:issues.read" },
        { connectionId: null, scope: "context:read" },
      ],
    },
  });
  expect(put.status).toBe(200);
  expect(
    (
      await owner(`/api/app/organizations/${orgId}/agents/${agentId}/scopes`, {
        method: "PUT",
        json: { scopes: [{ connectionId: sentry.id, scope: "github:pr.merge" }] },
      })
    ).status,
  ).toBe(400);

  const start = (await (
    await owner(`/api/app/organizations/${orgId}/connectors/github/oauth/start`, { json: { returnTo: "/settings" } })
  ).json()) as { authorizeUrl: string };
  const url = new URL(start.authorizeUrl);
  challenge = url.searchParams.get("code_challenge") ?? "";
  const back = await owner(`/api/app/connectors/oauth/callback?state=${url.searchParams.get("state")}&code=abc`);
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe("http://localhost:3000/settings?connected=github&outcome=connected");
  const conns = (await (await owner(`/api/app/organizations/${orgId}/connectors`)).json()) as {
    connections: { connector: string; authType: string }[];
  };
  expect(conns.connections.map((c) => [c.connector, c.authType]).sort()).toEqual([
    ["github", "oauth"],
    ["sentry", "api_key"],
  ]);
  // Replaying the callback (a reload, Back) fails and says why with a code: the state is used, so it lands on the start.
  const replay = await owner(`/api/app/connectors/oauth/callback?state=${url.searchParams.get("state")}&code=abc`);
  expect(replay.headers.get("location")).toBe("http://localhost:3000/?connector_error=used");
});

test("connectors API: the phone app's OAuth hands the code back to the app, which finishes with its session", async () => {
  let challenge = "";
  const http = (async (_url: string, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    const ok =
      createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url") === challenge;
    return ok
      ? Response.json({ access_token: "gho_live", expires_in: 3600 })
      : Response.json({ error: "bad" }, { status: 400 });
  }) as unknown as typeof fetch;
  t = await createTestServer({
    http,
    // A second person (the stranger below) signs up too.
    env: { ALLOW_SIGNUP: "true", CONNECTOR_GITHUB_CLIENT_ID: "gh-id", CONNECTOR_GITHUB_CLIENT_SECRET: "gh-secret" },
  });
  // The phone app: our cookie, no Origin, the app's header.
  const app = browser(t);
  await signUp(app, "owner@example.com");
  const { orgId } = await seedOrg(app);
  const mobile = { origin: null, headers: { "x-agentes-client": "mobile" } };
  const start = async (returnTo: string) => {
    const res = await app(`/api/app/organizations/${orgId}/connectors/github/oauth/start`, {
      ...mobile,
      json: { returnTo },
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
    challenge = url.searchParams.get("code_challenge") ?? "";
    return url.searchParams.get("state") ?? "";
  };

  // The system browser comes back without our session: the callback only hands state and code to the app.
  const state = await start("app:connectors");
  const systemBrowser = browser(t);
  const back = await systemBrowser(`/api/app/connectors/oauth/callback?state=${state}&code=abc`, { origin: null });
  expect(back.status).toBe(302);
  const deepLink = new URL(back.headers.get("location") ?? "");
  expect(`${deepLink.protocol}//${deepLink.host}${deepLink.pathname}`).toBe("agenteschat://connectors/oauth");
  expect(deepLink.searchParams.get("state")).toBe(state);
  expect(deepLink.searchParams.get("code")).toBe("abc");
  const none = (await (await app(`/api/app/organizations/${orgId}/connectors`, mobile)).json()) as {
    connections: unknown[];
  };
  expect(none.connections).toHaveLength(0);

  // Someone else can't finish it (the state stays bound to who started it, and stays usable).
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  const stolen = await stranger(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state, code: "abc" },
  });
  expect([403, 404]).toContain(stolen.status);

  // The app finishes with its own session.
  const done = await app(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state, code: "abc" },
  });
  expect(done.status).toBe(200);
  expect(((await done.json()) as { connector: string }).connector).toBe("github");
  const conns = (await (await app(`/api/app/organizations/${orgId}/connectors`, mobile)).json()) as {
    connections: { connector: string; authType: string }[];
  };
  expect(conns.connections.map((c) => [c.connector, c.authType])).toEqual([["github", "oauth"]]);
  // Once only.
  const replay = await app(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state, code: "abc" },
  });
  expect(replay.status).toBe(404);

  // A web authorization can't be finished through the app's route.
  const webState = await start("/settings");
  const crossed = await app(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state: webState, code: "abc" },
  });
  expect(crossed.status).toBe(404);

  // Refused at the provider: the app hears why.
  const refused = await start("app:connectors");
  const no = await systemBrowser(`/api/app/connectors/oauth/callback?state=${refused}&error=access_denied`, {
    origin: null,
  });
  expect(no.headers.get("location")).toBe("agenteschat://connectors/oauth?error=access_denied");

  // Started in the desktop app's window: the browser hands it back to the app, with the organization, and the
  // window finishes with its own session, landing where it started.
  const desktop = await start("desktop:/org/x/settings/connectors");
  const toDesktop = await systemBrowser(`/api/app/connectors/oauth/callback?state=${desktop}&code=abc`, {
    origin: null,
  });
  const desktopLink = new URL(toDesktop.headers.get("location") ?? "");
  expect(`${desktopLink.protocol}//${desktopLink.host}${desktopLink.pathname}`).toBe(
    "agenteschat://desktop/connectors/oauth",
  );
  expect(desktopLink.searchParams.get("org")).toBe(orgId);
  expect(desktopLink.searchParams.get("state")).toBe(desktop);
  const stolenDesktop = await stranger(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state: desktop, code: "abc" },
  });
  expect([403, 404]).toContain(stolenDesktop.status);
  const fromWindow = await app(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    ...mobile,
    json: { state: desktop, code: "abc" },
  });
  expect(fromWindow.status).toBe(200);
  expect(await fromWindow.json()).toMatchObject({ connector: "github", returnTo: "/org/x/settings/connectors" });
  const refusedDesktop = await start("desktop:/org/x/settings/connectors");
  const noDesktop = await systemBrowser(
    `/api/app/connectors/oauth/callback?state=${refusedDesktop}&error=access_denied`,
    { origin: null },
  );
  expect(noDesktop.headers.get("location")).toBe(
    `agenteschat://desktop/connectors/oauth?org=${orgId}&error=access_denied`,
  );

  // A web callback without our session: the sign-in page first, which comes back to it to finish.
  const webAgain = await start("/settings");
  const signedOut = await systemBrowser(`/api/app/connectors/oauth/callback?state=${webAgain}&code=abc`, {
    origin: null,
  });
  const signIn = new URL(signedOut.headers.get("location") ?? "");
  expect(signIn.origin + signIn.pathname).toBe("http://localhost:3000/login");
  expect(signIn.searchParams.get("redirect")).toBe(`/api/app/connectors/oauth/callback?state=${webAgain}&code=abc`);
  const finished = await app(signIn.searchParams.get("redirect") ?? "", { origin: null });
  expect(finished.headers.get("location")).toBe("http://localhost:3000/settings?connected=github&outcome=reconnected");
});

test("a connector's return that didn't connect lands where it started, with why as a code, never words", async () => {
  t = await createTestServer({
    http: (async () => Response.json({ error: "bad" }, { status: 400 })) as unknown as typeof fetch,
    env: { ALLOW_SIGNUP: "true", CONNECTOR_GITHUB_CLIENT_ID: "gh-id", CONNECTOR_GITHUB_CLIENT_SECRET: "gh-secret" },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const start = async () => {
    const res = await owner(`/api/app/organizations/${orgId}/connectors/github/oauth/start`, {
      json: { returnTo: `/org/${orgId}/settings/connectors` },
    });
    return new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get("state") ?? "";
  };
  const landing = `http://localhost:3000/org/${orgId}/settings/connectors?connector_error=`;
  const back = async (who: typeof owner, query: string) =>
    (await who(`/api/app/connectors/oauth/callback?${query}`)).headers.get("location") ?? "";

  // The provider said no: cancelled, nothing changed.
  expect(await back(owner, `state=${await start()}&error=access_denied&error_description=The+user+denied`)).toBe(
    `${landing}cancelled`,
  );
  // Neither a code nor a reason.
  expect(await back(owner, `state=${await start()}`)).toBe(`${landing}failed`);
  // Another account in this browser: finish with the one that started it.
  const other = browser(t);
  await signUp(other, "other@example.com");
  expect(await back(other, `state=${await start()}&code=abc`)).toBe(`${landing}other_account`);
  // The provider refused the code (its token endpoint): it failed, and the server logs why.
  expect(await back(owner, `state=${await start()}&code=abc`)).toBe(`${landing}failed`);
  // A state nobody can read any more lands on the start.
  expect(await back(owner, "state=forged&code=abc")).toBe("http://localhost:3000/?connector_error=expired");
});

test("the provider refusing this server's OAuth app: `misconfigured` with the connector, reported as an error", async () => {
  const errors = createFakeErrorReporter();
  t = await createTestServer({
    http: (async () => Response.json({ error: "invalid_client" }, { status: 401 })) as unknown as typeof fetch,
    env: { CONNECTOR_GITHUB_CLIENT_ID: "gh-id", CONNECTOR_GITHUB_CLIENT_SECRET: "not-the-real-secret" },
    errors,
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const start = async (returnTo: string) => {
    const res = await owner(`/api/app/organizations/${orgId}/connectors/github/oauth/start`, { json: { returnTo } });
    return new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get("state") ?? "";
  };
  const logged = () => errors.reports.map((r) => r.tags.log);

  const page = `/org/${orgId}/settings/connectors`;
  const back = await owner(`/api/app/connectors/oauth/callback?state=${await start(page)}&code=abc`);
  expect(back.headers.get("location")).toBe(
    `http://localhost:3000${page}?connector_error=misconfigured&connector=github`,
  );
  expect(logged()).toEqual(["connector oauth failed"]);
  expect(String(errors.reports[0]?.error)).toContain("invalid_client");
  // The phone's (or the desktop window's) finish: its code and the provider's name, reported too.
  const phone = await owner(`/api/app/organizations/${orgId}/connectors/oauth/complete`, {
    json: { state: await start("app:connectors"), code: "abc" },
  });
  expect(phone.status).toBe(500);
  expect(((await phone.json()) as { error: unknown }).error).toMatchObject({
    code: "connector.misconfigured",
    params: { provider: "GitHub" },
  });
  expect(logged()).toEqual(["connector oauth failed", "unhandled error"]);
});

type Listed = {
  id: string;
  kind: string;
  category: string;
  serverUrl: string;
  available: boolean;
  soon: boolean;
  via?: string;
  iconUrl: string | null;
  brandColor: string | null;
};

test("catalog: one list of our connectors and the one-click MCP servers, one entry per service, brand icons", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { connectors } = (await (await owner("/api/app/connectors/catalog")).json()) as { connectors: Listed[] };
  const ids = connectors.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  const byId = (id: string) => connectors.find((c) => c.id === id);
  expect(byId("notion")).toMatchObject({
    kind: "remote_mcp",
    category: "docs",
    serverUrl: "https://mcp.notion.com/mcp",
    available: true,
    iconUrl: "/connectors/notion.svg",
    brandColor: null,
  });
  expect(byId("zapier")).toMatchObject({ category: "automation", brandColor: "#FF4F00" });
  expect(byId("stripe")?.category).toBe("payments");
  // Linear and Sentry are in both lists: without an OAuth app here, the one-click server wins.
  expect(byId("linear")).toMatchObject({ kind: "remote_mcp", serverUrl: "https://mcp.linear.app/mcp" });
  expect(byId("sentry")?.kind).toBe("remote_mcp");
  // Ours: GitHub (API key at least). Google Drive goes through Composio, which this server doesn't have: no address
  // to type, listed as unavailable (the apps hide it).
  expect(byId("github")).toMatchObject({ kind: "catalog", category: "dev", available: true });
  expect(byId("drive")).toMatchObject({
    kind: "remote_mcp",
    via: "composio",
    available: false,
    serverUrl: "https://backend.composio.dev/api/v3.1/toolkits/googledrive",
    iconUrl: "/connectors/googledrive.svg",
  });
  expect(connectors.some((c) => "needsServerUrl" in c)).toBe(false);
  // A one-color mark (Square's black) and two in their makers' colors.
  expect(byId("square")).toMatchObject({ iconUrl: "/connectors/square.svg", brandColor: null });
  expect(byId("paypal")).toMatchObject({ iconUrl: "/brands/paypal.svg", brandColor: null });
  expect(byId("canva")).toMatchObject({ iconUrl: "/brands/canva.svg", brandColor: null });
  // Every connector in the catalog has its mark, a file in the web app: none is left a monogram.
  const publicDir = new URL("../../web/public", import.meta.url).pathname;
  for (const c of connectors) {
    expect([c.id, c.iconUrl !== null && existsSync(`${publicDir}${c.iconUrl}`)]).toEqual([c.id, true]);
  }
});

test("catalog on the Cloud: no API key for Intercom's servers (US and EU), whose terms forbid asking for one; the others keep it", async () => {
  t = await createTestServer({ env: { PUBLIC_URL: "https://app.agentes.chat" } });
  const owner = browser(t);
  const signedUp = await owner("/api/auth/sign-up/email", {
    json: { email: "owner@example.com", password: "correct horse battery", name: "owner" },
    origin: "https://app.agentes.chat",
  });
  expect(signedUp.status).toBe(200);
  const { connectors } = (await (await owner("/api/app/connectors/catalog")).json()) as {
    connectors: { id: string; auth: string[] }[];
  };
  const auth = (id: string) => connectors.find((c) => c.id === id)?.auth;
  expect(["intercom", "intercom-eu", "linear"].map(auth)).toEqual([["oauth"], ["oauth"], ["oauth", "api_key"]]);
});

test("one-click servers that haven't approved agentes.chat: `soon`, refused by id; by address, they say why", async () => {
  const asked: string[] = [];
  // Asana's MCP OAuth, as it answered on 2026-10-31: its registration refuses our redirect URI.
  const http = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === "https://mcp.asana.com/mcp") {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer resource_metadata="https://mcp.asana.com/.well-known/oauth-protected-resource"',
        },
      });
    }
    if (url === "https://mcp.asana.com/.well-known/oauth-protected-resource") {
      return Response.json({ resource: "https://mcp.asana.com/mcp", authorization_servers: ["https://mcp.asana.com"] });
    }
    if (url === "https://mcp.asana.com/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://mcp.asana.com",
        authorization_endpoint: "https://mcp.asana.com/authorize",
        token_endpoint: "https://mcp.asana.com/token",
        registration_endpoint: "https://mcp.asana.com/register",
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === "https://mcp.asana.com/register") {
      return Response.json(
        { error: "invalid_redirect_uri", error_description: "One or more redirect URIs are not allowed" },
        { status: 400 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  t = await createTestServer({ http, resolveHost: async () => ["93.184.216.34"] });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { presets } = (await (await owner(`/api/app/organizations/${orgId}/connectors/presets`)).json()) as {
    presets: { id: string; soon: boolean }[];
  };
  const soon = (id: string) => presets.find((p) => p.id === id)?.soon;
  expect(["asana", "vercel", "figma", "linear", "calendly"].map(soon)).toEqual([true, true, true, false, false]);
  const { connectors } = (await (await owner("/api/app/connectors/catalog")).json()) as { connectors: Listed[] };
  expect(connectors.find((c) => c.id === "asana")).toMatchObject({ available: false, soon: true });
  expect(connectors.find((c) => c.id === "notion")).toMatchObject({ available: true, soon: false });

  // By its id: refused before anything reaches the vendor (an older client still showing it as one click).
  const byId = await owner(`/api/app/organizations/${orgId}/connectors/presets/asana/connect`, { json: {} });
  expect(byId.status).toBe(400);
  expect(((await byId.json()) as { error: { code: string } }).error.code).toBe("connector.not_approved");
  expect(asked).toEqual([]);

  // By its address: the usual path, and the answer says the vendor only lets in apps it approved.
  const byAddress = await owner(`/api/app/organizations/${orgId}/connectors/custom`, {
    json: { serverUrl: "https://mcp.asana.com/mcp", label: "Asana" },
  });
  expect(await byAddress.json()).toEqual({
    status: "needs_key",
    reason: "not_approved",
    detail: "invalid_redirect_uri: One or more redirect URIs are not allowed",
  });
  expect(asked).toContain("https://mcp.asana.com/register");
});

test("catalog: with its OAuth app configured, our Linear connector replaces the one-click server", async () => {
  t = await createTestServer({
    env: { CONNECTOR_LINEAR_CLIENT_ID: "lin-id", CONNECTOR_LINEAR_CLIENT_SECRET: "lin-secret" },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { connectors } = (await (await owner("/api/app/connectors/catalog")).json()) as { connectors: Listed[] };
  const linear = connectors.filter((c) => c.id === "linear");
  expect(linear).toHaveLength(1);
  expect(linear[0]).toMatchObject({ kind: "catalog", category: "product", iconUrl: "/connectors/linear.svg" });
});

test("connector tools API: classified on listing (judge for ambiguous names), sensitive ones can't be freed", async () => {
  const tools = [
    { name: "campaign_list", inputSchema: { type: "object" } },
    { name: "campaign_delete", inputSchema: { type: "object" } },
    { name: "pixel_track", description: "Send a web event to a pixel.", inputSchema: { type: "object" } },
  ];
  const mcpConnect: McpConnect = async () => ({
    listTools: async () => tools,
    callTool: async () => ({ content: "ok", isError: false }),
    close: async () => {},
  });
  t = await createTestServer({
    mcpConnect,
    resolveHost: async () => ["93.184.216.34"],
    judge: (kind, id) =>
      kind === "connector_tool_level" ? (id.startsWith("level_") ? "write" : "changes_undoable") : undefined,
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const res = await owner(`/api/app/organizations/${orgId}/connectors/custom`, {
    json: { serverUrl: "https://ads.example.com/mcp", apiKey: "ads_secret_12345", label: "Ads" },
  });
  expect(res.status).toBe(200);
  const started = (await res.json()) as {
    status: string;
    server: {
      id: string;
      tools: {
        name: string;
        level: string;
        sensitive: boolean;
        pending: boolean;
        suggestionReason: string | null;
        subject: string;
        nameParts: { verb: string | null; words: string[] };
      }[];
    };
  };
  expect(started.status).toBe("connected");
  const by = Object.fromEntries(started.server.tools.map((x) => [x.name, x]));
  expect(by.campaign_list).toMatchObject({ level: "read", sensitive: false, pending: false, subject: "campaign" });
  expect(by.campaign_delete).toMatchObject({ level: "approval", sensitive: true, pending: false });
  expect(by.pixel_track).toMatchObject({
    level: "write",
    pending: true,
    suggestionReason: "changes_undoable",
    nameParts: { verb: "track", words: ["pixel"] },
  });

  const save = (access: string, name = "campaign_delete") =>
    owner(`/api/app/organizations/${orgId}/connectors/custom/${started.server.id}/tools`, {
      method: "PUT",
      json: { label: "Ads", tools: [{ name, access, label: name }] },
    });
  expect((await save("read")).status).toBe(400);
  expect((await save("write")).status).toBe(400);
  expect((await save("off")).status).toBe(200);
  const ok = (await (await save("approval", "pixel_track")).json()) as { tools: { name: string; pending: boolean }[] };
  expect(ok.tools.find((x) => x.name === "pixel_track")?.pending).toBe(false);

  // A changed tool applies itself (ADR 0117): nothing waits, and an installed app that still accepts gets a success.
  const waiting = () =>
    t.db
      .select({ pending: schema.connectorToolPins.pendingFingerprint })
      .from(schema.connectorToolPins)
      .where(
        and(
          eq(schema.connectorToolPins.connectionId, started.server.id),
          eq(schema.connectorToolPins.toolName, "campaign_list"),
        ),
      );
  await t.db
    .update(schema.connectorToolPins)
    .set({ pendingFingerprint: "v2", pendingDescription: "List campaigns, v2", pendingSchema: { type: "object" } })
    .where(eq(schema.connectorToolPins.connectionId, started.server.id));
  const changes = await owner(`/api/app/organizations/${orgId}/connectors/tool-changes`);
  expect(await changes.json()).toEqual({ changes: [] });
  const one = await owner(
    `/api/app/organizations/${orgId}/connectors/${started.server.id}/tools/campaign_list/accept-change`,
    { json: {} },
  );
  expect(one.status).toBe(204);
  const all = await owner(`/api/app/organizations/${orgId}/connectors/${started.server.id}/tool-changes/accept`, {
    json: {},
  });
  expect([all.status, await all.json()]).toEqual([200, { accepted: 0 }]);
  // The endpoints change nothing: the next listing by an agent settles what waited.
  expect(await waiting()).toEqual([{ pending: "v2" }]);
});

/**
 * Stripe's servers as far as accounts go: its MCP OAuth (discovery, registration, a token per code) and an MCP
 * server whose account tool answers with the token's account (`rk_<account>_…`).
 */
function stripeServers() {
  const http = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.toString() === "https://mcp.stripe.com/" && init?.method === "POST") {
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate": 'Bearer resource_metadata="https://mcp.stripe.com/.well-known/oauth-protected-resource"',
        },
      });
    }
    if (url.toString() === "https://mcp.stripe.com/.well-known/oauth-protected-resource") {
      return Response.json({
        resource: "https://mcp.stripe.com/",
        authorization_servers: ["https://access.stripe.com"],
        scopes_supported: ["mcp"],
      });
    }
    if (url.toString() === "https://access.stripe.com/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://access.stripe.com",
        authorization_endpoint: "https://access.stripe.com/authorize",
        token_endpoint: "https://access.stripe.com/token",
        registration_endpoint: "https://access.stripe.com/register",
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.toString() === "https://access.stripe.com/register")
      return Response.json({ client_id: "dcr-1" }, { status: 201 });
    if (url.toString() === "https://access.stripe.com/token") {
      const code = new URLSearchParams(String(init?.body)).get("code");
      return Response.json({ access_token: `rk_${code}_token`, expires_in: 3600 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const names: Record<string, string> = { acme: "Acme", loja: "Loja B" };
  const mcpConnect: McpConnect = async (_connection, headers) => {
    const who = (headers.authorization ?? "").split("_")[1] ?? "";
    return {
      listTools: async () => [
        { name: "list_available_accounts_or_orgs", inputSchema: { type: "object" }, readOnlyHint: true },
        { name: "list_customers", inputSchema: { type: "object" }, readOnlyHint: true },
      ],
      callTool: async (name) =>
        name !== "list_available_accounts_or_orgs"
          ? { content: "[]", isError: false }
          : who === "down"
            ? { content: "Service unavailable", isError: true }
            : {
                content: JSON.stringify({
                  accounts: [{ stripe_context: `acct_${who}`, livemode: true, name: names[who] }],
                }),
                isError: false,
              },
      close: async () => {},
    };
  };
  return { http, mcpConnect };
}

test("connector accounts: another Stripe account, the outcome back from OAuth, Reconectar into another account, renaming", async () => {
  t = await createTestServer({ ...stripeServers(), resolveHost: async () => ["93.184.216.34"] });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const start = async (connectionId?: string) => {
    const res = await owner(`/api/app/organizations/${orgId}/connectors/presets/stripe/connect`, {
      json: { returnTo: "/settings/connectors", ...(connectionId ? { connectionId } : {}) },
    });
    expect(res.status).toBe(200);
    const started = (await res.json()) as { status: string; authorizeUrl: string };
    expect(started.status).toBe("oauth");
    return new URL(started.authorizeUrl).searchParams.get("state") ?? "";
  };
  const signIn = async (state: string, code: string) =>
    (await owner(`/api/app/connectors/oauth/callback?state=${state}&code=${code}`)).headers.get("location") ?? "";
  const servers = async () =>
    (
      (await (await owner(`/api/app/organizations/${orgId}/connectors/custom`)).json()) as {
        servers: { id: string; label: string; accountLabel: string | null }[];
      }
    ).servers;
  const levels = async () =>
    (
      (await (await owner(`/api/app/organizations/${orgId}/agents/${agentId}/access`)).json()) as {
        connectors: { label: string; state: string }[];
      }
    ).connectors.map((c) => [c.label, c.state]);

  const first = await signIn(await start(), "acme");
  const [acme] = await servers();
  if (!acme) throw new Error("Acme didn't connect");
  expect(acme).toMatchObject({ label: "Stripe (Acme)", accountLabel: "Acme" });
  expect(first).toBe(
    `http://localhost:3000/settings/connectors?connected=${encodeURIComponent(`custom:${acme.id}`)}&outcome=connected`,
  );
  // Another account: a row of its own, every agent's as the first.
  expect(await signIn(await start(), "loja")).toContain("&outcome=connected");
  expect((await servers()).map((s) => s.label)).toEqual(["Stripe (Acme)", "Stripe (Loja B)"]);
  expect(await levels()).toEqual([
    ["Stripe (Acme)", "granted"],
    ["Stripe (Loja B)", "granted"],
  ]);
  // The same account again: nothing new.
  expect(await signIn(await start(), "acme")).toContain("&outcome=same_account");
  expect(await servers()).toHaveLength(2);
  // Reconectar signing in to the other account: refused, and the app says why.
  expect(await signIn(await start(acme.id), "loja")).toBe(
    "http://localhost:3000/settings/connectors?connector_error=connector.other_account",
  );
  // Stripe couldn't say which account: refused too, to try again.
  expect(await signIn(await start(acme.id), "down")).toBe(
    "http://localhost:3000/settings/connectors?connector_error=connector.account_unknown",
  );
  expect(await signIn(await start(acme.id), "acme")).toContain("&outcome=reconnected");
  // With a key: the outcome in the answer.
  const keyed = await owner(`/api/app/organizations/${orgId}/connectors/custom`, {
    json: { serverUrl: "https://mcp.stripe.com", apiKey: "rk_loja_secretkey", label: "Stripe" },
  });
  expect(await keyed.json()).toMatchObject({ status: "connected", outcome: "same_account" });

  const rename = (label: string) =>
    owner(`/api/app/organizations/${orgId}/connectors/${acme.id}`, { method: "PATCH", json: { label } });
  const renamed = await rename("Loja Acme");
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({ id: acme.id, label: "Loja Acme" });
  const taken = await rename("stripe (loja b)");
  expect(taken.status).toBe(409);
  expect(((await taken.json()) as { error: { code: string } }).error.code).toBe("connector.label_taken");
});

test("through Composio (ADR 0107): Drive from the catalog, Composio's page with our state, back with its account", async () => {
  const composio = createFakeComposioClient();
  const version = mcpPreset("drive")?.composio?.version ?? "";
  composio.addTools("googledrive", version, [
    {
      slug: "GOOGLEDRIVE_FIND_FILE",
      description: "Find files",
      inputSchema: { type: "object" },
      tags: ["readOnlyHint"],
    },
    { slug: "GOOGLEDRIVE_CREATE_PERMISSION", description: "Share", inputSchema: { type: "object" }, tags: [] },
  ]);
  composio.answer("GOOGLEDRIVE_GET_ABOUT", { user: { emailAddress: "ana@acme.com" } });
  t = await createTestServer({
    mail: { composio: { client: composio.client, connector: createFakeMailConnector().connector }, imap: null },
    env: { COMPOSIO_CALLS_PER_MONTH: "5000" },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { connectors } = (await (await owner("/api/app/connectors/catalog")).json()) as { connectors: Listed[] };
  const drive = connectors.find((c) => c.id === "drive");
  expect(drive).toMatchObject({
    kind: "remote_mcp",
    via: "composio",
    available: true,
    serverUrl: "https://backend.composio.dev/api/v3.1/toolkits/googledrive",
  });
  // A vendor that refuses our registration connects through Composio here.
  expect(connectors.find((c) => c.id === "asana")).toMatchObject({ available: true, soon: false, via: "composio" });

  const start = async (returnTo = "/settings/connectors") => {
    const res = await owner(`/api/app/organizations/${orgId}/connectors/presets/drive/connect`, { json: { returnTo } });
    expect(res.status).toBe(200);
    const started = (await res.json()) as { status: string; authorizeUrl: string };
    expect(started.status).toBe("oauth");
    expect(started.authorizeUrl.startsWith("https://composio.example/connect/")).toBe(true);
    return new URL(started.authorizeUrl).searchParams.get("state") ?? "";
  };
  const state = await start();
  const account = composio.state.links.at(-1)?.connectedAccountId ?? "";
  composio.activate(account, "", null);
  const back = await owner(
    `/api/app/connectors/oauth/callback?state=${state}&status=success&connected_account_id=${account}`,
  );
  const servers = (
    (await (await owner(`/api/app/organizations/${orgId}/connectors/custom`)).json()) as {
      servers: { id: string; label: string; via?: string; status: string; tools: { name: string; access: string }[] }[];
    }
  ).servers;
  const [server] = servers;
  if (!server) throw new Error("Drive didn't connect");
  expect(back.headers.get("location")).toBe(
    `http://localhost:3000/settings/connectors?connected=${encodeURIComponent(`custom:${server.id}`)}&outcome=connected`,
  );
  expect(server).toMatchObject({ label: "Google Drive (ana@acme.com)", via: "composio", status: "active" });
  expect(server.tools.map((x) => [x.name, x.access])).toEqual([
    ["create_permission", "approval"],
    ["find_file", "read"],
  ]);

  // Composio says the sign-in failed: the app says so in the person's language, and its pending account goes away.
  const failed = await start();
  const pending = composio.state.links.at(-1)?.connectedAccountId ?? "";
  const no = await owner(`/api/app/connectors/oauth/callback?state=${failed}&status=failed`);
  expect(no.headers.get("location")).toBe(
    "http://localhost:3000/settings/connectors?connector_error=connector.unfinished",
  );
  expect(composio.state.deletedAccounts).toContain(pending);
  // The phone and the desktop app get the same full code.
  const phoneFailed = await browser(t)(
    `/api/app/connectors/oauth/callback?state=${await start("app:connectors")}&status=failed`,
    { origin: null },
  );
  expect(new URL(phoneFailed.headers.get("location") ?? "").searchParams.get("error")).toBe("connector.unfinished");

  // The phone: the system browser hands Composio's account back to the app as the code.
  const phone = await start("app:connectors");
  const other = composio.state.links.at(-1)?.connectedAccountId ?? "";
  const handed = await browser(t)(
    `/api/app/connectors/oauth/callback?state=${phone}&status=success&connected_account_id=${other}`,
    { origin: null },
  );
  expect(new URL(handed.headers.get("location") ?? "").searchParams.get("code")).toBe(other);

  const usage = await owner(`/api/app/organizations/${orgId}/usage/composio`);
  expect(await usage.json()).toMatchObject({ calls: 0, limit: 5000 });

  // Disconnecting drops the account at Composio, without revoking its grant there.
  expect(
    (await owner(`/api/app/organizations/${orgId}/connectors/custom/${server.id}`, { method: "DELETE" })).status,
  ).toBe(204);
  expect(composio.state.grantsKept).toContain(account);
  expect(composio.state.revokedAccounts).toEqual([]);
});

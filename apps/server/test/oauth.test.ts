import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull, schema } from "@agenteschat/db";
import {
  CURSOR_CALLBACK,
  pinnedLookup,
  purgeApps,
  resetAppDocumentFailures,
  restoreAccount,
  scheduleAccountDeletion,
  sha256,
} from "@agenteschat/engine";
import { authorize, callTool, connectApp, LOOPBACK, mcp, pkce, registerClient, requestIdOf, token } from "./ai-apps";
import { browser, createTestServer, joinByInvitation, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
let docs: Map<string, { body: string; type?: string }>;
let fetched: string[];
beforeEach(async () => {
  docs = new Map();
  fetched = [];
  resetAppDocumentFailures();
  t = await createTestServer({
    appsFetchDocument: async (url) => {
      fetched.push(url.toString());
      const doc = docs.get(url.toString());
      if (!doc) throw new Error("fetch_failed");
      return { body: Buffer.from(doc.body), contentType: doc.type ?? "application/json" };
    },
  });
});
afterEach(() => t.close());

const CONSENT = `${ORIGIN}/autorizar`;

async function owner() {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  return { b, ...seeded };
}

async function register(redirect_uris: string[], extra: Record<string, unknown> = {}) {
  const res = await registerClient(t, { client_name: "Claude Code", redirect_uris, ...extra });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function baseParams(clientId: string, redirect = LOOPBACK) {
  return {
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    state: "xyz",
  };
}

describe("discovery", () => {
  test("both metadata documents at every path, with no offline_access and both CIMD flags", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await t.app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toEqual({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
        scopes_supported: ["read", "write", "manage"],
        bearer_methods_supported: ["header"],
        resource_name: "agentes.chat",
        resource_documentation: "https://agentes.chat/docs/apps-de-ia",
      });
    }
    const as = await (await t.app.request("/.well-known/oauth-authorization-server")).json();
    expect(await (await t.app.request("/.well-known/openid-configuration")).json()).toEqual(as);
    expect(as).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/api/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "write", "manage"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(JSON.stringify(as)).not.toContain("offline_access");
  });

  test("CORS: any origin without credentials, and never x-agentes-client", async () => {
    const res = await t.app.request("/api/oauth/token", {
      method: "OPTIONS",
      headers: {
        origin: "https://vscode.dev",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-agentes-client",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).not.toContain("x-agentes-client");
  });
});

describe("dynamic registration", () => {
  test("Claude Code on loopback, and Cursor's three addresses in one call", async () => {
    const claude = await register([LOOPBACK]);
    expect(claude.status).toBe(201);
    expect(claude.json).toMatchObject({
      client_name: "Claude Code",
      redirect_uris: [LOOPBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(String(claude.json.client_id)).toMatch(/^agcl_[0-9A-Za-z]{32}$/);
    const cursor = await register([
      "http://localhost:8787/callback",
      "https://www.cursor.com/agents/mcp/oauth/callback",
      CURSOR_CALLBACK,
    ]);
    expect(cursor.status).toBe(201);
  });

  test("refuses other schemes, fragments, too many addresses and big bodies", async () => {
    expect((await register(["smb://x/"])).status).toBe(400);
    expect((await register(["intent://x"])).status).toBe(400);
    expect((await register(["https://a.example/cb#frag"])).status).toBe(400);
    expect((await register(["http://evil.example/cb"])).status).toBe(400);
    expect((await register(Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`))).status).toBe(400);
    const big = await registerClient(t, { redirect_uris: [LOOPBACK], client_name: "x".repeat(17_000) });
    expect(big.status).toBe(413);
  });

  test("the name is cleaned and cut, logos and scopes aren't kept, auth is always none", async () => {
    const { json } = await register([LOOPBACK], {
      client_name: `Cl‮aude​ ${"a".repeat(100)}`,
      logo_uri: "https://evil.example/logo.png",
      scope: "read",
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(String(json.client_name)).toStartWith("Claude a");
    expect([...String(json.client_name)].length).toBe(64);
    expect(json.token_endpoint_auth_method).toBe("none");
    expect(json).not.toHaveProperty("logo_uri");
    expect(json).not.toHaveProperty("scope");
    const [row] = await t.db
      .select()
      .from(schema.oauthAppClients)
      .where(eq(schema.oauthAppClients.id, String(json.client_id)));
    expect(row?.name).toBe(String(json.client_name));
  });

  test("limits: 60 an hour per address", async () => {
    for (let i = 0; i < 60; i++)
      expect((await registerClient(t, { redirect_uris: [LOOPBACK] }, "198.51.100.1")).status).toBe(201);
    expect((await registerClient(t, { redirect_uris: [LOOPBACK] }, "198.51.100.1")).status).toBe(429);
    expect((await registerClient(t, { redirect_uris: [LOOPBACK] }, "198.51.100.2")).status).toBe(201);
  });
});

describe("metadata documents (CIMD)", () => {
  const ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
  const doc = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      client_id: ID,
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      ...over,
    });

  test("a good document: the consent page shows it verified, with its mark", async () => {
    const { b, orgId } = await owner();
    docs.set(ID, { body: doc() });
    const { location } = await authorize(t, baseParams(ID, "https://claude.ai/api/mcp/auth_callback"));
    expect(location).toStartWith(`${CONSENT}?req=`);
    const view = (await (await b(`/api/app/authorize/${requestIdOf(location)}`)).json()) as {
      request: { client: Record<string, unknown> };
      workspaces: { id: string }[];
    };
    expect(view.request.client).toEqual({
      displayKind: "verified",
      name: "Claude",
      host: "claude.ai",
      brand: "claude",
      returnsTo: "claude.ai",
      reservedNameWarning: false,
    });
    expect(view.workspaces.map((w) => w.id)).toEqual([orgId]);
  });

  const clientOf = async (b: ReturnType<typeof browser>, id: string, redirect: string) => {
    const { location } = await authorize(t, baseParams(id, redirect));
    const view = (await (await b(`/api/app/authorize/${requestIdOf(location)}`)).json()) as {
      request: { client: Record<string, unknown> };
    };
    return view.request.client;
  };

  test("a known app's document with a return address on this computer is shown as a program there", async () => {
    const { b } = await owner();
    const CODE = "https://claude.ai/oauth/claude-code-client-metadata";
    docs.set(CODE, {
      body: JSON.stringify({
        client_id: CODE,
        client_name: "Claude Code",
        redirect_uris: ["http://localhost/callback"],
      }),
    });
    expect(await clientOf(b, CODE, "http://localhost:51234/callback")).toMatchObject({
      displayKind: "loopback",
      name: "Claude Code",
      host: null,
      brand: null,
      returnsTo: "localhost:51234",
      reservedNameWarning: true,
    });
  });

  test("a document on any other host is shown by its host, its name unverified and checked", async () => {
    const { b } = await owner();
    const FAKE = "https://claude-connect.example/client.json";
    docs.set(FAKE, {
      body: JSON.stringify({
        client_id: FAKE,
        client_name: "Claude",
        redirect_uris: ["https://claude-connect.example/cb"],
      }),
    });
    expect(await clientOf(b, FAKE, "https://claude-connect.example/cb")).toMatchObject({
      displayKind: "https",
      name: "Claude",
      host: "claude-connect.example",
      brand: null,
      reservedNameWarning: true,
    });
  });

  test("private_key_jwt documents connect as public clients with PKCE", async () => {
    docs.set(ID, { body: doc({ token_endpoint_auth_method: "private_key_jwt", jwks_uri: "https://claude.ai/jwks" }) });
    const { location } = await authorize(t, baseParams(ID, "https://claude.ai/api/mcp/auth_callback"));
    expect(location).toStartWith(`${CONSENT}?req=`);
  });

  test("refused: another client_id inside, the wrong type, unknown address, private hosts", async () => {
    docs.set(ID, { body: doc({ client_id: "https://evil.example/x" }) });
    expect((await authorize(t, baseParams(ID, "https://claude.ai/api/mcp/auth_callback"))).location).toBe(
      `${CONSENT}?erro=app_desconhecido`,
    );
    resetAppDocumentFailures();
    docs.set(ID, { body: doc(), type: "text/html" });
    expect((await authorize(t, baseParams(ID, "https://claude.ai/api/mcp/auth_callback"))).location).toBe(
      `${CONSENT}?erro=app_desconhecido`,
    );
    for (const id of ["https://127.0.0.1/x", "https://localhost/x", "https://claude.ai/", "https://u:p@claude.ai/x"]) {
      expect((await authorize(t, baseParams(id, LOOPBACK))).location).toBe(`${CONSENT}?erro=app_desconhecido`);
    }
    expect(fetched.filter((u) => !u.startsWith(ID))).toEqual([]);
  });

  test("a failure is remembered 20 seconds, a good copy is kept for a failed refetch", async () => {
    await authorize(t, baseParams(ID, "https://claude.ai/api/mcp/auth_callback"));
    await authorize(t, baseParams(ID, "https://claude.ai/api/mcp/auth_callback"));
    expect(fetched.length).toBe(1);
    resetAppDocumentFailures();
    docs.set(ID, { body: doc() });
    expect((await authorize(t, baseParams(ID, "https://claude.ai/api/mcp/auth_callback"))).location).toStartWith(
      `${CONSENT}?req=`,
    );
    // Older than the 5-minute cache, younger than a day: a failed fetch still uses it.
    await t.db.update(schema.oauthAppClients).set({ fetchedAt: new Date(Date.now() - 3600_000) });
    docs.delete(ID);
    expect((await authorize(t, baseParams(ID, "https://claude.ai/api/mcp/auth_callback"))).location).toStartWith(
      `${CONSENT}?req=`,
    );
  });

  test("the pinned lookup answers Bun's all:true form with an array", () => {
    const got: unknown[] = [];
    pinnedLookup("93.184.216.34", 4)("example.com", { all: true }, (_e, address) => got.push(address));
    pinnedLookup("93.184.216.34", 4)("example.com", {}, (_e, address, family) => got.push([address, family]));
    expect(got).toEqual([[{ address: "93.184.216.34", family: 4 }], ["93.184.216.34", 4]]);
  });
});

describe("authorize", () => {
  test("an unknown app or a return address it didn't register stays on our page, echoing nothing", async () => {
    const { location } = await authorize(t, { ...baseParams("agcl_nope"), state: "<script>" });
    expect(location).toBe(`${CONSENT}?erro=app_desconhecido`);
    const { json } = await register([LOOPBACK]);
    const bad = await authorize(t, baseParams(String(json.client_id), "https://evil.example/cb"));
    expect(bad.location).toBe(`${CONSENT}?erro=endereco_de_retorno`);
  });

  test("a new app's parameter errors stay on our page: no bounce to an address anyone can register", async () => {
    const { json } = await register(["https://evil.example/login"]);
    const id = String(json.client_id);
    for (const over of [
      { response_type: "x" },
      { code_challenge: undefined },
      { resource: "https://other.example/" },
    ]) {
      const { location } = await authorize(t, { ...baseParams(id, "https://evil.example/login"), ...over });
      expect(location).toBe(`${CONSENT}?erro=pedido_invalido`);
    }
  });

  test("an app that has connected before gets its parameter errors back with state and iss", async () => {
    const { json } = await register([LOOPBACK]);
    const id = String(json.client_id);
    await t.db.update(schema.oauthAppClients).set({ lastUsedAt: new Date() }).where(eq(schema.oauthAppClients.id, id));
    const back = async (over: Record<string, string | undefined>) =>
      new URL((await authorize(t, { ...baseParams(id), ...over })).location).searchParams;
    let q = await back({ response_type: "token" });
    expect([q.get("error"), q.get("state"), q.get("iss")]).toEqual(["unsupported_response_type", "xyz", ORIGIN]);
    expect((await back({ code_challenge_method: "plain" })).get("error")).toBe("invalid_request");
    expect((await back({ code_challenge: "short" })).get("error")).toBe("invalid_request");
    expect((await back({ resource: "https://other.example/mcp" })).get("error")).toBe("invalid_target");
    q = await back({ resource: `${ORIGIN.replace("localhost", "LOCALHOST")}/mcp/` });
    expect(q.get("error")).toBeNull();
  });

  test("a loopback address matches on any port, never another path", async () => {
    const { json } = await register([LOOPBACK]);
    const id = String(json.client_id);
    expect((await authorize(t, baseParams(id, "http://localhost:51234/callback"))).location).toStartWith(
      `${CONSENT}?req=`,
    );
    expect((await authorize(t, baseParams(id, "http://127.0.0.1:1/other"))).location).toBe(
      `${CONSENT}?erro=endereco_de_retorno`,
    );
  });

  test("offline_access and unknown scopes are dropped; none asked means all", async () => {
    const { json } = await register([LOOPBACK]);
    const id = String(json.client_id);
    for (const [scope, want] of [
      ["read offline_access admin", ["read"]],
      [undefined, ["read", "write", "manage"]],
      ["write", ["read", "write"]],
      ["manage", ["read", "write", "manage"]],
    ] as const) {
      const { location } = await authorize(t, { ...baseParams(id), scope });
      const [row] = await t.db
        .select()
        .from(schema.oauthAppRequests)
        .where(eq(schema.oauthAppRequests.id, requestIdOf(location)));
      expect(row?.scopes).toEqual([...want]);
    }
  });
});

describe("consent", () => {
  async function pending(redirect = LOOPBACK, name = "Claude Code") {
    const res = await registerClient(t, { client_name: name, redirect_uris: [redirect] });
    const id = ((await res.json()) as { client_id: string }).client_id;
    return requestIdOf((await authorize(t, { ...baseParams(id, redirect), scope: "read write" })).location);
  }

  test("signed out: 401; not a member: 403; a paused workspace: 409", async () => {
    const { b, orgId } = await owner();
    const req = await pending();
    expect((await browser(t)(`/api/app/authorize/${req}`)).status).toBe(401);
    // Ana is in a second workspace only.
    const ownerId = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
    const [org] = await t.db.insert(schema.organizations).values({ name: "Second" }).returning();
    await t.db.insert(schema.organizationMembers).values({ orgId: org?.id ?? "", userId: ownerId, role: "owner" });
    const second = { organization: { id: org?.id ?? "" } };
    const ana = await joinByInvitation(t, b, second.organization.id, "ana@example.com");
    const refused = await ana(`/api/app/authorize/${req}`, { json: { decision: "allow", orgId } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("not_member");
    await t.db
      .update(schema.organizations)
      .set({ standing: "hold" })
      .where(eq(schema.organizations.id, second.organization.id));
    const view = (await (await ana(`/api/app/authorize/${req}`)).json()) as { workspaces: { paused: boolean }[] };
    expect(view.workspaces.map((w) => w.paused)).toEqual([true]);
    const dueAt = new Date(Date.now() + 86_400_000);
    await t.db
      .update(schema.organizations)
      .set({ deletionDueAt: dueAt })
      .where(eq(schema.organizations.id, second.organization.id));
    const closing = (await (await ana(`/api/app/authorize/${req}`)).json()) as {
      workspaces: { deletion?: { dueAt: string } }[];
    };
    expect(closing.workspaces[0]?.deletion?.dueAt).toBe(dueAt.toISOString());
    await t.db
      .update(schema.organizations)
      .set({ deletionDueAt: null })
      .where(eq(schema.organizations.id, second.organization.id));
    const paused = await ana(`/api/app/authorize/${req}`, {
      json: { decision: "allow", orgId: second.organization.id },
    });
    expect(paused.status).toBe(409);
    expect(((await paused.json()) as { error: { code: string } }).error.code).toBe("workspace_paused");
  });

  test("how each kind of app is shown, and a borrowed name is flagged", async () => {
    const { b } = await owner();
    const show = async (redirect: string, name: string) =>
      (
        (await (await b(`/api/app/authorize/${await pending(redirect, name)}`)).json()) as {
          request: { client: Record<string, unknown> };
        }
      ).request.client;
    expect(await show(LOOPBACK, "Claude Code")).toMatchObject({
      displayKind: "loopback",
      name: "Claude Code",
      host: null,
      brand: null,
      returnsTo: "127.0.0.1:33418",
      reservedNameWarning: true,
    });
    expect(await show(CURSOR_CALLBACK, "whatever")).toMatchObject({
      displayKind: "app_scheme",
      name: "Cursor",
      brand: "cursor",
      returnsTo: "cursor://anysphere.cursor-mcp",
      reservedNameWarning: false,
    });
    expect(await show("https://app.example.com/cb", "**ChatGPT**")).toMatchObject({
      displayKind: "https",
      name: "**ChatGPT**",
      host: "app.example.com",
      brand: null,
      reservedNameWarning: true,
    });
    expect(await show("https://claude.ai/api/mcp/auth_callback", "Claude")).toMatchObject({
      displayKind: "https",
      brand: "claude",
      reservedNameWarning: false,
    });
  });

  test("allow gives a code with iss, deny gives access_denied, a second answer is 409 and revokes nothing", async () => {
    const { b, orgId } = await owner();
    const req = await pending();
    const allowed = await b(`/api/app/authorize/${req}`, { json: { decision: "allow", orgId, access: "write" } });
    const url = new URL(((await allowed.json()) as { redirectTo: string }).redirectTo);
    expect(url.origin + url.pathname).toBe(LOOPBACK);
    expect(url.searchParams.get("code")).toMatch(/^[0-9A-Za-z]{43}$/);
    expect([url.searchParams.get("state"), url.searchParams.get("iss")]).toEqual(["xyz", ORIGIN]);
    const again = await b(`/api/app/authorize/${req}`, { json: { decision: "allow", orgId } });
    expect(again.status).toBe(409);
    expect((await t.db.select().from(schema.appGrants)).map((g) => g.revokedAt)).toEqual([null]);
    const denied = await b(`/api/app/authorize/${await pending()}`, { json: { decision: "deny" } });
    const d = new URL(((await denied.json()) as { redirectTo: string }).redirectTo).searchParams;
    expect([d.get("error"), d.get("state"), d.get("iss")]).toEqual(["access_denied", "xyz", ORIGIN]);
  });

  test("a receipt email once per connection; connecting again after a disconnect sends another", async () => {
    const { b, orgId } = await owner();
    const app = await connectApp(t, b, orgId);
    await connectApp(t, b, orgId, { clientId: app.clientId });
    await t.drain();
    const receipts = () => t.email.sent.filter((m) => /app (was|foi) conectado/.test(m.subject));
    expect(receipts().length).toBe(1);
    const [grant] = await t.db.select().from(schema.appGrants);
    expect((await b(`/api/app/organizations/${orgId}/apps/${grant?.id}`, { method: "DELETE" })).status).toBe(204);
    await connectApp(t, b, orgId, { clientId: app.clientId });
    await t.drain();
    expect(receipts().length).toBe(2);
    expect((await t.db.select().from(schema.appGrants)).length).toBe(1);
    const audit = await t.db.select().from(schema.auditLog);
    expect(audit.filter((a) => a.action === "apps.connected").length).toBe(2);
    expect(audit.filter((a) => a.action === "apps.disconnected").length).toBe(1);
  });

  test("a live connection given write is audited and emailed; given read again, nothing changes", async () => {
    const { b, orgId } = await owner();
    const app = await connectApp(t, b, orgId, { access: "read" });
    await connectApp(t, b, orgId, { clientId: app.clientId, access: "write" });
    await connectApp(t, b, orgId, { clientId: app.clientId, access: "read" });
    await t.drain();
    expect(t.email.sent.filter((m) => /app (was|foi) conectado/.test(m.subject)).length).toBe(2);
    const audit = await t.db.select().from(schema.auditLog);
    expect(audit.filter((a) => a.action.startsWith("apps.")).map((a) => a.action)).toEqual([
      "apps.connected",
      "apps.scopes_changed",
    ]);
  });

  test("a personal token revoked with itself is audited", async () => {
    const { b, orgId } = await owner();
    const created = await b(`/api/app/organizations/${orgId}/tokens`, {
      json: { name: "Script", access: "read", expiresInDays: 30 },
    });
    const { secret } = (await created.json()) as { secret: string };
    await t.app.request("/api/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: secret }).toString(),
    });
    const [row] = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "apps.token_revoked"));
    expect([row?.actorType, (row?.details as { reason?: string } | undefined)?.reason]).toEqual([
      "system",
      "revoked_with_token",
    ]);
  });

  test("a request expires after 30 minutes (410)", async () => {
    const { b } = await owner();
    const req = await pending();
    await t.db.update(schema.oauthAppRequests).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await b(`/api/app/authorize/${req}`)).status).toBe(410);
  });
});

describe("token", () => {
  test("form only, no-store, every error JSON", async () => {
    const json = await t.app.request("/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(400);
    expect(json.headers.get("cache-control")).toBe("no-store");
    expect(json.headers.get("pragma")).toBe("no-cache");
    expect(await json.json()).toMatchObject({ error: "invalid_request" });
    const { res, json: body } = await token(t, { grant_type: "password" });
    expect([res.status, body.error]).toEqual([400, "unsupported_grant_type"]);
  });

  async function codeFor(b: ReturnType<typeof browser>, orgId: string, redirect = LOOPBACK) {
    const res = await registerClient(t, { client_name: "App", redirect_uris: [redirect] });
    const clientId = ((await res.json()) as { client_id: string }).client_id;
    const p = pkce();
    const { location } = await authorize(t, { ...baseParams(clientId, redirect), code_challenge: p.challenge });
    const decided = await b(`/api/app/authorize/${requestIdOf(location)}`, { json: { decision: "allow", orgId } });
    const code = new URL(((await decided.json()) as { redirectTo: string }).redirectTo).searchParams.get("code") ?? "";
    return { clientId, code, verifier: p.verifier };
  }

  test("PKCE, client and redirect checks; redirect_uri optional but exact with its port", async () => {
    const { b, orgId } = await owner();
    let c = await codeFor(b, orgId);
    expect(
      (
        await token(t, {
          grant_type: "authorization_code",
          code: c.code,
          code_verifier: "x".repeat(43),
          client_id: c.clientId,
        })
      ).json.error,
    ).toBe("invalid_grant");
    c = await codeFor(b, orgId);
    expect(
      (
        await token(t, {
          grant_type: "authorization_code",
          code: c.code,
          code_verifier: c.verifier,
          client_id: "agcl_other",
        })
      ).json.error,
    ).toBe("invalid_grant");
    c = await codeFor(b, orgId);
    expect(
      (
        await token(t, {
          grant_type: "authorization_code",
          code: c.code,
          code_verifier: c.verifier,
          client_id: c.clientId,
          redirect_uri: "http://127.0.0.1:1/callback",
        })
      ).json.error,
    ).toBe("invalid_grant");
    c = await codeFor(b, orgId);
    const ok = await token(t, {
      grant_type: "authorization_code",
      code: c.code,
      code_verifier: c.verifier,
      client_id: c.clientId,
    });
    expect(ok.res.status).toBe(200);
    expect(ok.json).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read write" });
    expect(String(ok.json.access_token)).toMatch(/^aga_[0-9A-Za-z]{43}$/);
    expect(String(ok.json.refresh_token)).toMatch(/^agf_[0-9A-Za-z]{43}$/);
    const stored = await t.db.select({ hash: schema.appTokens.tokenHash }).from(schema.appTokens);
    expect(stored.map((s) => s.hash)).toContain(sha256(String(ok.json.access_token)));
    expect(JSON.stringify(stored)).not.toContain(String(ok.json.access_token));
  });

  test("a replayed code is refused and revokes what it minted", async () => {
    const { b, orgId } = await owner();
    const c = await codeFor(b, orgId);
    const form = { grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.clientId };
    const first = await token(t, form);
    expect(first.res.status).toBe(200);
    expect((await token(t, form)).json.error).toBe("invalid_grant");
    expect(
      (await mcp(t, String(first.json.access_token), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status,
    ).toBe(401);
  });

  test("Cursor's callback gets an 8-hour access token", async () => {
    const { b, orgId } = await owner();
    const c = await codeFor(b, orgId, CURSOR_CALLBACK);
    const ok = await token(t, {
      grant_type: "authorization_code",
      code: c.code,
      code_verifier: c.verifier,
      client_id: c.clientId,
    });
    expect(ok.json.expires_in).toBe(8 * 3600);
  });

  test("a refresh keeps the lifetime fixed at the code exchange, whatever else the app registered", async () => {
    const { b, orgId } = await owner();
    const refreshOnce = async (redirectUris: string[], redirectUri: string) => {
      const reg = await registerClient(t, { client_name: "App", redirect_uris: redirectUris });
      const clientId = ((await reg.json()) as { client_id: string }).client_id;
      const app = await connectApp(t, b, orgId, { clientId, redirectUri });
      const next = await token(t, { grant_type: "refresh_token", refresh_token: app.refresh, client_id: clientId });
      return [app.expiresIn, next.json.expires_in];
    };
    expect(await refreshOnce(["https://evil.example/cursor.com/cb"], "https://evil.example/cursor.com/cb")).toEqual([
      3600, 3600,
    ]);
    expect(await refreshOnce(["https://a.example/cb", CURSOR_CALLBACK], "https://a.example/cb")).toEqual([3600, 3600]);
    expect(await refreshOnce([CURSOR_CALLBACK], CURSOR_CALLBACK)).toEqual([28800, 28800]);
  });

  test("refresh: rotation, a retry within the grace, reuse after it, expiry, client binding", async () => {
    const { b, orgId } = await owner();
    const app = await connectApp(t, b, orgId);
    const refresh = (rt: string, client = app.clientId) =>
      token(t, { grant_type: "refresh_token", refresh_token: rt, client_id: client });
    expect((await refresh(app.refresh, "agcl_other")).json.error).toBe("invalid_grant");
    const second = await refresh(app.refresh);
    expect(second.res.status).toBe(200);
    // The access token before the rotation still works until it expires (calls in flight).
    expect((await mcp(t, app.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    // The same old token again, within 60 s and before the new one is used: a sibling pair, the first left alive.
    const retry = await refresh(app.refresh);
    expect(retry.res.status).toBe(200);
    expect(
      (await mcp(t, String(second.json.access_token), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status,
    ).toBe(200);
    // Past the grace: the whole family goes.
    await t.db
      .update(schema.appTokens)
      .set({ usedAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.appTokens.tokenHash, sha256(app.refresh)));
    expect((await refresh(app.refresh)).json.error).toBe("invalid_grant");
    expect(
      (await mcp(t, String(retry.json.access_token), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status,
    ).toBe(401);
    expect((await refresh(String(retry.json.refresh_token))).json.error).toBe("invalid_grant");
  });

  test("an account waiting for its deletion gets no token, and its restore finds the app still connected", async () => {
    const { b, orgId } = await owner();
    const app = await connectApp(t, b, orgId);
    const [person] = await t.db.select({ id: schema.users.id }).from(schema.users);
    const userId = person?.id ?? "";
    const refresh = () =>
      token(t, { grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.clientId });
    await scheduleAccountDeletion({ db: t.db }, userId);
    expect((await refresh()).json.error).toBe("invalid_grant");
    const refused = await callTool(t, app.access, "list_agents", {});
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("can't be used right now");
    await restoreAccount({ db: t.db }, userId);
    const back = await refresh();
    expect(back.res.status).toBe(200);
    expect((await callTool(t, String(back.json.access_token), "list_agents", {})).isError).toBeFalsy();
  });

  test("two refreshes at once: whichever answer the client keeps, its session survives", async () => {
    const { b, orgId } = await owner();
    const refresh = (rt: string, client: string) =>
      token(t, { grant_type: "refresh_token", refresh_token: rt, client_id: client });
    for (const keep of ["first", "last"] as const) {
      const app = await connectApp(t, b, orgId);
      const [a, z] = await Promise.all([refresh(app.refresh, app.clientId), refresh(app.refresh, app.clientId)]);
      expect([a.res.status, z.res.status]).toEqual([200, 200]);
      const kept = keep === "first" ? a : z;
      const dropped = keep === "first" ? z : a;
      expect(
        (await mcp(t, String(kept.json.access_token), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status,
      ).toBe(200);
      const next = await refresh(String(kept.json.refresh_token), app.clientId);
      expect(next.res.status).toBe(200);
      // The answer it dropped can't refresh any more, and presenting it ends nothing.
      expect((await refresh(String(dropped.json.refresh_token), app.clientId)).json.error).toBe("invalid_grant");
      expect(
        (await mcp(t, String(next.json.access_token), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status,
      ).toBe(200);
      expect((await refresh(String(next.json.refresh_token), app.clientId)).res.status).toBe(200);
    }
  });

  test("an expired refresh token is refused and leaves its family alone", async () => {
    const { b, orgId } = await owner();
    const app = await connectApp(t, b, orgId);
    await t.db
      .update(schema.appTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.appTokens.tokenHash, sha256(app.refresh)));
    expect(
      (await token(t, { grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.clientId })).json.error,
    ).toBe("invalid_grant");
    expect((await mcp(t, app.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  test("a disconnected app can't refresh; revoke takes a refresh token's family", async () => {
    const { b, orgId } = await owner();
    const app = await connectApp(t, b, orgId);
    const [grant] = await t.db.select().from(schema.appGrants);
    await b(`/api/app/organizations/${orgId}/apps/${grant?.id}`, { method: "DELETE" });
    expect(
      (await token(t, { grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.clientId })).json.error,
    ).toBe("invalid_grant");
    const other = await connectApp(t, b, orgId, { name: "Other" });
    const revoked = await t.app.request("/api/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: other.refresh, token_type_hint: "refresh_token" }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect((await mcp(t, other.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const unknown = await t.app.request("/api/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=nope",
    });
    expect(unknown.status).toBe(200);
  });
});

describe("what ends a connection", () => {
  test("a password reset revokes every app and token of the person", async () => {
    const { b, orgId } = await owner();
    const app = await connectApp(t, b, orgId);
    await t.drain();
    const anon = browser(t);
    await anon("/api/auth/request-password-reset", {
      json: { email: "owner@example.com", redirectTo: "/reset-password" },
    });
    await t.drain();
    const link = new URL(/https?:\/\/\S+\/reset-password\S*/.exec(t.email.sent.at(-1)?.text ?? "")?.[0] ?? "", ORIGIN);
    const reset = await anon("/api/auth/reset-password", {
      json: { token: link.searchParams.get("token") ?? "", newPassword: "another horse battery" },
    });
    expect(reset.status).toBe(200);
    expect((await mcp(t, app.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
  });

  test("a removed member's next call is 401 and their grant is revoked", async () => {
    const { b, orgId } = await owner();
    const ana = await joinByInvitation(t, b, orgId, "ana@example.com");
    const app = await connectApp(t, ana, orgId);
    const anaId = ((await (await ana("/api/app/me")).json()) as { user: { id: string } }).user.id;
    expect((await b(`/api/app/organizations/${orgId}/members/${anaId}`, { method: "DELETE" })).status).toBe(204);
    expect((await mcp(t, app.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const [grant] = await t.db.select().from(schema.appGrants);
    expect(grant?.revokedAt).not.toBeNull();
  });

  test("removed, invited back and connected again: the tokens from before stay dead", async () => {
    const { b, orgId } = await owner();
    const ana = await joinByInvitation(t, b, orgId, "ana@example.com");
    const before = await connectApp(t, ana, orgId);
    const anaId = ((await (await ana("/api/app/me")).json()) as { user: { id: string } }).user.id;
    expect((await b(`/api/app/organizations/${orgId}/members/${anaId}`, { method: "DELETE" })).status).toBe(204);
    const removed = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "apps.disconnected"));
    expect(removed.map((a) => [a.actorType, (a.details as { reason?: string }).reason])).toEqual([
      ["system", "left_workspace"],
    ]);
    await joinByInvitation(t, b, orgId, "ana@example.com", { as: ana });
    const after = await connectApp(t, ana, orgId, { clientId: before.clientId });
    expect((await mcp(t, before.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const refreshed = await token(t, {
      grant_type: "refresh_token",
      refresh_token: before.refresh,
      client_id: before.clientId,
    });
    expect(refreshed.json.error).toBe("invalid_grant");
    expect((await mcp(t, after.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  test("a grant whose person left on its own is revoked with its tokens at the next call", async () => {
    const { b, orgId } = await owner();
    const ana = await joinByInvitation(t, b, orgId, "ana@example.com");
    const app = await connectApp(t, ana, orgId);
    const anaId = ((await (await ana("/api/app/me")).json()) as { user: { id: string } }).user.id;
    await t.db
      .delete(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, anaId)));
    expect((await mcp(t, app.access, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const live = await t.db.select().from(schema.appTokens).where(isNull(schema.appTokens.revokedAt));
    expect(live).toEqual([]);
  });

  test("deleting the workspace takes its grants with it", async () => {
    const { b, orgId } = await owner();
    await connectApp(t, b, orgId);
    await t.db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(await t.db.select().from(schema.appGrants)).toEqual([]);
    expect(await t.db.select().from(schema.appTokens)).toEqual([]);
  });
});

test("the hourly cleanup: old requests, registrations unused for 90 days, grants unused for 90 days", async () => {
  const { b, orgId } = await owner();
  await connectApp(t, b, orgId);
  const unused = await registerClient(t, { client_name: "Nobody", redirect_uris: [LOOPBACK] });
  const unusedId = ((await unused.json()) as { client_id: string }).client_id;
  const day = 86_400_000;
  await t.db.update(schema.oauthAppRequests).set({ expiresAt: new Date(Date.now() - 2 * day) });
  const abandoned = await registerClient(t, { client_name: "Came back later", redirect_uris: [LOOPBACK] });
  const abandonedId = ((await abandoned.json()) as { client_id: string }).client_id;
  await t.db
    .update(schema.oauthAppClients)
    .set({ createdAt: new Date(Date.now() - 91 * day) })
    .where(eq(schema.oauthAppClients.id, unusedId));
  await t.db
    .update(schema.oauthAppClients)
    .set({ createdAt: new Date(Date.now() - 8 * day) })
    .where(eq(schema.oauthAppClients.id, abandonedId));
  await t.db.update(schema.appGrants).set({ lastUsedAt: new Date(Date.now() - 91 * day) });
  await purgeApps(t.db);
  expect(await t.db.select().from(schema.oauthAppRequests)).toEqual([]);
  expect((await t.db.select().from(schema.oauthAppClients)).map((c) => c.id)).not.toContain(unusedId);
  expect((await t.db.select().from(schema.oauthAppClients)).map((c) => c.id)).toContain(abandonedId);
  expect((await t.db.select().from(schema.oauthAppClients)).length).toBe(2);
  expect((await t.db.select().from(schema.appGrants)).map((g) => g.revokedAt === null)).toEqual([false]);
});

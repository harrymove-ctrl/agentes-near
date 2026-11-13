import { afterEach, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import { setSignupMode } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { createOperatorApp } from "../src/operator/app";
import {
  type Browser,
  browser,
  createTestServer,
  GOOGLE_BACK,
  GOOGLE_ENV,
  googleSignIn,
  signUp,
  type TestServer,
} from "./harness";

const TOKEN = "operator-test-token-".padEnd(48, "x");
const PASSWORD = "correct horse battery";

let current: TestServer | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function server(env: Record<string, string> = {}) {
  current = await createTestServer({ env: { OPERATOR_API_TOKEN: TOKEN, ...env } });
  return current;
}

/** The operator API of `t`, as the Cloud's console calls it. */
function operator(t: TestServer, emails = true) {
  const app = createOperatorApp(
    { db: t.db, config: t.config, version: "test", log: createLogger("error"), emails },
    TOKEN,
  );
  return (method: string, path: string, json?: unknown) =>
    app.request(`/api/operator/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
    });
}

/** The token in the latest early-access link queued for `email`. */
async function accessFor(t: TestServer, email: string) {
  const rows = await t.db
    .select({ payload: schema.outbox.payload })
    .from(schema.outbox)
    .where(eq(schema.outbox.kind, "email.send"));
  const urls = rows
    .map((r) => r.payload as { to: string[]; template: { kind: string; url: string } })
    .filter((p) => p.template.kind === "early_access" && p.to[0] === email)
    .map((p) => new URL(p.template.url));
  const url = urls.at(-1);
  if (!url) throw new Error(`no link for ${email}`);
  expect(url.href.split("?")[0]).toBe(new URL("/signup", t.config.PUBLIC_URL).href);
  expect(url.searchParams.get("email")).toBe(email);
  return url.searchParams.get("access") ?? "";
}

/** The early-access emails queued for `email`, oldest first: their kind and link. */
async function mailed(t: TestServer, email: string) {
  const rows = await t.db
    .select({ payload: schema.outbox.payload })
    .from(schema.outbox)
    .where(eq(schema.outbox.kind, "email.send"));
  return rows
    .map((r) => r.payload as { to: string[]; template: { kind: string; url: string } })
    .filter((p) => p.to[0] === email && p.template.kind.startsWith("early_access"))
    .map((p) => ({ kind: p.template.kind, url: p.template.url }));
}

async function invite(t: TestServer, email: string) {
  const res = await operator(t)("POST", "/early-access/invitations", { emails: [email] });
  expect(res.status).toBe(200);
  return accessFor(t, email);
}

const signUpWith = (b: Browser, email: string, access?: string) =>
  b("/api/auth/sign-up/email", {
    json: { email, password: PASSWORD, name: email.split("@")[0] },
    headers: access ? { "x-early-access": access } : {},
  });

const lookUp = async (b: Browser, email: string, access?: string) => {
  const res = await b("/api/app/sign-in-options", { json: { email, ...(access ? { access } : {}) } });
  expect(res.status).toBe(200);
  return res.json();
};

const invitation = async (t: TestServer, email: string) => {
  const [row] = await t.db
    .select()
    .from(schema.earlyAccessInvitations)
    .where(eq(schema.earlyAccessInvitations.email, email));
  return row;
};

const userId = async (t: TestServer, email: string) =>
  (await t.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)))[0]?.id;

async function me(b: Browser) {
  const res = await b("/api/app/me");
  expect(res.status).toBe(200);
  return ((await res.json()) as { user: { canCreateWorkspace: boolean; emailVerified: boolean } }).user;
}

/** The link that confirms `email`, from the latest confirmation email sent to it. */
async function confirmationLink(t: TestServer, email: string) {
  await t.drain();
  const text = t.email.sent.filter((m) => m.to[0] === email && m.text.includes("/verify-email")).at(-1)?.text;
  const link = new URL(/https?:\/\/\S+\/api\/auth\/verify-email\S*/.exec(text ?? "")?.[0] ?? "");
  return `${link.pathname}${link.search}`;
}

/** Whether the sign-in page and `/api/instance` say anyone may sign up. */
const shown = async (t: TestServer) => ({
  signupOpen: ((await (await browser(t)("/api/app/auth-config")).json()) as { signupOpen: boolean }).signupOpen,
  signup: ((await (await browser(t)("/api/instance")).json()) as { signup: string }).signup,
});

const CLOUD = "https://app.agentes.chat";

/** A browser at agentes.chat Cloud's address: sign-in and writes check the `Origin`. */
function cloudBrowser(t: TestServer): Browser {
  const b = browser(t);
  return Object.assign((path: string, init: Parameters<Browser>[1] = {}) => b(path, { origin: CLOUD, ...init }), {
    cookie: b.cookie,
  });
}

/** Makes a workspace and finishes setting it up (one still being set up comes back instead of a new one). */
async function makeWorkspace(b: Browser, name: string) {
  const res = await b("/api/app/organizations", { json: { name } });
  if (res.status === 201) {
    const { organization } = (await res.clone().json()) as { organization: { id: string } };
    await b(`/api/app/organizations/${organization.id}/onboarding`, { method: "PATCH", json: { finished: true } });
  }
  return res;
}

test("an invitation's link: sign-up for its address, then workspaces (agentes.chat Cloud)", async () => {
  const t = await server({ MACHINE_PROVISIONING: "external", PUBLIC_URL: CLOUD });
  const owner = cloudBrowser(t);
  await signUp(owner, "owner@acme.test");
  // The first account runs the installation: no invitation needed for its workspaces.
  expect((await me(owner)).canCreateWorkspace).toBe(true);
  for (const name of ["Acme", "Acme Labs"]) expect((await makeWorkspace(owner, name)).status).toBe(201);

  const access = await invite(t, "ana@acme.test");
  const anon = cloudBrowser(t);
  expect(await lookUp(anon, "ana@acme.test", access)).toEqual({
    account: false,
    password: false,
    providers: [],
    canSignUp: true,
  });
  // Without the token, exactly like an address nobody invited, there and at sign-up.
  expect(await lookUp(anon, "ana@acme.test")).toEqual(await lookUp(anon, "nobody@acme.test"));
  const without = await signUpWith(anon, "ana@acme.test");
  const stranger = await signUpWith(anon, "nobody@acme.test");
  expect(without.status).toBe(403);
  expect(stranger.status).toBe(403);
  expect(await without.json()).toEqual(await stranger.json());

  const ana = cloudBrowser(t);
  expect((await signUpWith(ana, "Ana@Acme.test", access)).status).toBe(200);
  expect(await invitation(t, "ana@acme.test")).toMatchObject({
    userId: await userId(t, "ana@acme.test"),
    tokenHash: null,
  });
  expect((await invitation(t, "ana@acme.test"))?.usedAt).toBeInstanceOf(Date);
  // The link is spent: it signs nobody else up.
  expect((await signUpWith(cloudBrowser(t), "ana@acme.test", access)).status).not.toBe(200);

  // The link reached her mailbox: her address counts as confirmed.
  expect(await me(ana)).toMatchObject({ canCreateWorkspace: true, emailVerified: true });
  const first = await makeWorkspace(ana, "Ana's");
  expect(first.status).toBe(201);
  const { organization } = (await first.json()) as { organization: { id: string } };
  // As many as she likes: the first is the one recorded.
  expect((await makeWorkspace(ana, "Another")).status).toBe(201);
  expect((await invitation(t, "ana@acme.test"))?.workspaceId).toBe(organization.id);
  expect((await me(ana)).canCreateWorkspace).toBe(true);
});

test("agentes.chat Cloud: a member makes no workspace until the address is allowed and confirmed, then as many as it likes, until revoked", async () => {
  const t = await server({ MACHINE_PROVISIONING: "external", PUBLIC_URL: CLOUD });
  const owner = cloudBrowser(t);
  await signUp(owner, "owner@acme.test");
  const created = await owner("/api/app/organizations", { json: { name: "Acme" } });
  const { organization } = (await created.json()) as { organization: { id: string } };
  const asked = await owner(`/api/app/organizations/${organization.id}/invitations`, {
    json: { email: "bia@acme.test", role: "member" },
  });
  expect(asked.status).toBe(201);
  const token = ((await asked.json()) as { url: string }).url.split("/invite/")[1] ?? "";
  const bia = cloudBrowser(t);
  expect((await signUpWith(bia, "bia@acme.test")).status).toBe(200);
  expect((await bia(`/api/app/invitations/${token}/accept`, { json: {} })).status).toBe(200);
  expect((await me(bia)).canCreateWorkspace).toBe(false);
  const refused = await bia("/api/app/organizations", { json: { name: "Bia's" } });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("org.create_invite_only");

  const op = operator(t);
  const outcome = async (email: string) => {
    const res = await op("POST", "/early-access/invitations", { emails: [email] });
    return ((await res.json()) as { results: { email: string; outcome: string; invitationId: string }[] }).results[0];
  };
  const allowed = await outcome("bia@acme.test");
  expect(allowed?.outcome).toBe("allowed");
  expect(await mailed(t, "bia@acme.test")).toEqual([{ kind: "early_access_allowed", url: `${CLOUD}/onboarding` }]);
  // A workspace invitation let her sign up unconfirmed, as it would anyone typing her address: confirming comes first.
  expect(await me(bia)).toMatchObject({ canCreateWorkspace: false, emailVerified: false });
  expect((await bia("/api/app/organizations", { json: { name: "Bia's" } })).status).toBe(403);
  expect((await bia(await confirmationLink(t, "bia@acme.test"))).status).toBe(302);
  expect((await me(bia)).canCreateWorkspace).toBe(true);
  for (const name of ["Bia's", "Bia Labs"]) {
    expect((await makeWorkspace(bia, name)).status).toBe(201);
  }
  // Allowing again sends nothing.
  expect(await outcome("bia@acme.test")).toEqual({
    email: "bia@acme.test",
    outcome: "signed_up",
    invitationId: allowed?.invitationId ?? "",
  });
  expect(await mailed(t, "bia@acme.test")).toHaveLength(1);

  // Revoked: no more workspaces, and the ones made stay.
  expect((await op("POST", `/early-access/invitations/${allowed?.invitationId}/revoke`)).status).toBe(200);
  expect((await me(bia)).canCreateWorkspace).toBe(false);
  expect((await bia("/api/app/organizations", { json: { name: "More" } })).status).toBe(403);
  const mine = (await (await bia("/api/app/me")).json()) as { organizations: { name: string }[] };
  expect(mine.organizations.map((o) => o.name).sort()).toEqual(["Acme", "Bia Labs", "Bia's"]);
});

test("a link used for another address is refused with its own code, naming no address", async () => {
  const t = await server();
  await signUp(browser(t), "owner@acme.test");
  const access = await invite(t, "ana@acme.test");
  const res = await signUpWith(browser(t), "bia@acme.test", access);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { code: string; message: string };
  expect(body.code).toBe("EARLY_ACCESS_OTHER_EMAIL");
  expect(body.message).not.toContain("ana");
  expect(await userId(t, "bia@acme.test")).toBeUndefined();
  expect((await invitation(t, "ana@acme.test"))?.usedAt).toBeNull();
});

test("accessExpired only for the link's own address, once it expired", async () => {
  const t = await server();
  await signUp(browser(t), "owner@acme.test");
  const access = await invite(t, "ana@acme.test");
  await t.db.update(schema.earlyAccessInvitations).set({ expiresAt: sql`now() - interval '1 second'` });
  const anon = browser(t);
  const none = { account: false, password: false, providers: [], canSignUp: false };
  expect(await lookUp(anon, "ana@acme.test", access)).toEqual({ ...none, accessExpired: true });
  expect(await lookUp(anon, "bia@acme.test", access)).toEqual(none);
  expect(await lookUp(anon, "ana@acme.test")).toEqual(none);
  // Anything else in `access` counts as none.
  expect(await lookUp(anon, "ana@acme.test", "x".repeat(65))).toEqual(none);
  expect((await signUpWith(anon, "ana@acme.test", access)).status).toBe(403);
});

test("the sign-up mode is live: open lets anyone in at once, and back to invitation only closes it", async () => {
  const t = await server();
  const op = operator(t);
  await signUp(browser(t), "owner@acme.test");
  expect(await shown(t)).toEqual({ signupOpen: false, signup: "invite" });
  expect(await (await op("GET", "/signup")).json()).toEqual({
    mode: "invite",
    forcedOpen: false,
    changedAt: null,
    emails: true,
  });

  const opened = await op("PUT", "/signup", { mode: "open" });
  expect(opened.status).toBe(200);
  const body = (await opened.json()) as { mode: string; changedAt: string };
  expect(body).toMatchObject({ mode: "open", forcedOpen: false, emails: true });
  expect(Date.parse(body.changedAt)).toBeGreaterThan(Date.now() - 60_000);
  expect(await shown(t)).toEqual({ signupOpen: true, signup: "open" });
  expect((await signUpWith(browser(t), "anyone@acme.test")).status).toBe(200);
  // Setting it again changes nothing.
  expect(await (await op("PUT", "/signup", { mode: "open" })).json()).toEqual(body);

  expect((await op("PUT", "/signup", { mode: "invite" })).status).toBe(200);
  expect(await shown(t)).toEqual({ signupOpen: false, signup: "invite" });
  expect((await signUpWith(browser(t), "late@acme.test")).status).toBe(403);
});

test("ALLOW_SIGNUP forces it open; a server that is its agents' computer stays by invitation; no email, no invitation", async () => {
  const forced = await server({ ALLOW_SIGNUP: "true" });
  expect(await (await operator(forced)("GET", "/signup")).json()).toMatchObject({ mode: "invite", forcedOpen: true });
  await forced.close();

  const host = await server({ HOST_COMPUTER_TOKEN: "h".repeat(64) });
  await signUp(browser(host), "owner@acme.test");
  const refused = await operator(host)("PUT", "/signup", { mode: "open" });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("signup.host_computer");
  // Saved as open before the server became its agents' computer: it opens nothing, and isn't shown as open.
  await setSignupMode(host.db, "open");
  expect(await (await operator(host)("GET", "/signup")).json()).toMatchObject({ mode: "invite" });
  expect(await shown(host)).toEqual({ signupOpen: false, signup: "invite" });
  expect((await signUpWith(browser(host), "stranger@acme.test")).status).toBe(403);
  await host.close();

  const quiet = await server();
  const op = operator(quiet, false);
  expect(await (await op("GET", "/signup")).json()).toMatchObject({ emails: false });
  const none = await op("POST", "/early-access/invitations", { emails: ["ana@acme.test"] });
  expect(none.status).toBe(409);
  expect(((await none.json()) as { error: { code: string } }).error.code).toBe("early_access.no_email");
  expect(await quiet.db.select().from(schema.earlyAccessInvitations)).toEqual([]);
});

test("sign-ups that don't carry the link leave the invitation alone, and a self-hosted server never asks for one", async () => {
  // A self-hosted server with a provisioner of its own isn't held to agentes.chat Cloud's rule.
  const t = await server({ MACHINE_PROVISIONING: "external" });
  const owner = browser(t);
  await signUp(owner, "owner@acme.test");
  const created = await owner("/api/app/organizations", { json: { name: "Acme" } });
  const { organization } = (await created.json()) as { organization: { id: string } };
  await invite(t, "ana@acme.test");
  // Ana joins through her workspace invitation, without the early-access link.
  const sent = await owner(`/api/app/organizations/${organization.id}/invitations`, {
    json: { email: "ana@acme.test", role: "member" },
  });
  expect(sent.status).toBe(201);
  const ana = browser(t);
  expect((await signUpWith(ana, "ana@acme.test")).status).toBe(200);
  expect((await invitation(t, "ana@acme.test"))?.usedAt).toBeNull();
  expect((await me(ana)).canCreateWorkspace).toBe(true);
  expect((await ana("/api/app/organizations", { json: { name: "Ana's" } })).status).toBe(201);
});

/** GitHub as the provider: its token and its user, with the address `email`, verified or not. */
function fakeGithub(email: string, verified: boolean): typeof fetch {
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://github.com/login/oauth/access_token"))
      return answer({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" });
    if (url === "https://api.github.com/user")
      return answer({ id: 4242, login: "ana", name: "Ana", email: null, avatar_url: "" });
    if (url === "https://api.github.com/user/emails") return answer([{ email, primary: true, verified }]);
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

/**
 * A GitHub sign-in started with `earlyAccess`, as the web does, back through its callback: where it lands, or null
 * when the callback answers without a redirect.
 */
async function githubSignIn(b: Browser, github: typeof fetch, earlyAccess?: string) {
  const start = await b("/api/auth/sign-in/social", {
    json: {
      provider: "github",
      callbackURL: "/",
      errorCallbackURL: "/login",
      ...(earlyAccess ? { additionalData: { earlyAccess } } : {}),
    },
  });
  expect(start.status).toBe(200);
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state");
  const real = globalThis.fetch;
  globalThis.fetch = github;
  try {
    const back = await b(`/api/auth/callback/github?code=c0de&state=${state}`, { origin: null });
    const location = back.headers.get("location");
    return back.status === 302 && location ? new URL(location, "http://localhost:3000") : null;
  } finally {
    globalThis.fetch = real;
  }
}

test("through GitHub: the link signs up only an address the provider verified, and the invitation is used then", async () => {
  const t = await server({ GITHUB_CLIENT_ID: "gh-client", GITHUB_CLIENT_SECRET: "gh-secret" });
  await signUp(browser(t), "owner@acme.test");
  const access = await invite(t, "ana@acme.test");

  const unverified = await githubSignIn(browser(t), fakeGithub("ana@acme.test", false), access);
  expect(unverified?.pathname).toBe("/login");
  expect(unverified?.searchParams.get("error")).toBe("EARLY_ACCESS_EMAIL_UNVERIFIED");
  expect(await userId(t, "ana@acme.test")).toBeUndefined();

  // Without the link, the address is closed like any other, and /login says so.
  const closed = await githubSignIn(browser(t), fakeGithub("ana@acme.test", true));
  expect(closed?.pathname).toBe("/login");
  expect(closed?.searchParams.get("error")).toBe("SIGNUP_CLOSED");
  expect(await userId(t, "ana@acme.test")).toBeUndefined();

  const other = await githubSignIn(browser(t), fakeGithub("bia@acme.test", true), access);
  expect(other?.searchParams.get("error")).toBe("EARLY_ACCESS_OTHER_EMAIL");

  const ana = browser(t);
  const verified = await githubSignIn(ana, fakeGithub("ana@acme.test", true), access);
  expect(verified?.pathname).toBe("/");
  expect(verified?.searchParams.get("error")).toBeNull();
  expect(await invitation(t, "ana@acme.test")).toMatchObject({ userId: await userId(t, "ana@acme.test") });
  expect((await ana("/api/app/me")).status).toBe(200);
});

test("open sign-up through a provider that hasn't verified the address doesn't use the invitation", async () => {
  const t = await server({ GITHUB_CLIENT_ID: "gh-client", GITHUB_CLIENT_SECRET: "gh-secret" });
  await signUp(browser(t), "owner@acme.test");
  const access = await invite(t, "ana@acme.test");
  expect((await operator(t)("PUT", "/signup", { mode: "open" })).status).toBe(200);
  const landed = await githubSignIn(browser(t), fakeGithub("ana@acme.test", false), access);
  expect(landed?.pathname).toBe("/");
  expect(await userId(t, "ana@acme.test")).toBeString();
  expect(await invitation(t, "ana@acme.test")).toMatchObject({ usedAt: null, userId: null });
});

for (const app of ["web", "desktop", "phone"] as const) {
  test(`through Google from the ${app} app: the link's token signs its address up and is used; without it, sign-up is closed`, async () => {
    const t = await server(GOOGLE_ENV);
    await signUp(browser(t), "owner@acme.test");
    const access = await invite(t, "ana@acme.test");

    const closed = new URL((await googleSignIn(t, app, "ana@acme.test")).location, CLOUD);
    expect([closed.pathname, closed.searchParams.get("error")]).toEqual(["/login", "SIGNUP_CLOSED"]);
    expect(await userId(t, "ana@acme.test")).toBeUndefined();

    const { location } = await googleSignIn(t, app, "ana@acme.test", { earlyAccess: access });
    expect(location.startsWith(GOOGLE_BACK[app])).toBe(true);
    // The phone's session comes back to the app in the link that closes its browser.
    if (app === "phone") expect(new URL(location).searchParams.get("cookie")).toContain("session_token");
    expect(await invitation(t, "ana@acme.test")).toMatchObject({
      userId: await userId(t, "ana@acme.test"),
      tokenHash: null,
    });
    expect((await invitation(t, "ana@acme.test"))?.usedAt).toBeInstanceOf(Date);
  });
}

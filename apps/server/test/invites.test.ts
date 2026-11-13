import { afterEach, expect, test } from "bun:test";
import { createMemoryRateLimiter, orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

type Link = { id: string; url: string; expiresAt: string };
type Request = {
  id: string;
  name: string;
  email: string;
  note: string | null;
  verified: boolean;
  confirmed: boolean;
};
const DAY = 86_400_000;

async function start(env: Record<string, string> = {}) {
  t = await createTestServer({ env });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const res = await owner(`/api/app/organizations/${seeded.orgId}/invite-links`, { json: {} });
  const link = (await res.json()) as Link;
  return { owner, ...seeded, status: res.status, link, token: link.url.split("/invite/")[1] ?? "" };
}

const ask = (b: Browser, token: string, json: Record<string, string>, headers?: Record<string, string>) =>
  b(`/api/app/invitations/${token}/requests`, { json, headers });
const requests = async (b: Browser, orgId: string) =>
  ((await (await b(`/api/app/organizations/${orgId}/join-requests`)).json()) as { requests: Request[] }).requests;
const mailTo = (to: string) => t.email.sent.filter((m) => m.to.includes(to));
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const sendCode = (b: Browser, token: string, json: { email?: string } = {}, headers?: Record<string, string>) =>
  b(`/api/app/invitations/${token}/code`, { json, headers });
/** The code the last code email carries (its subject starts with it). */
const lastCode = () => t.email.sent.flatMap((m) => /^(\d{6}) /.exec(m.subject)?.[1] ?? []).at(-1) ?? "";

/** Proves an address the way the page does: a code to it, read from its email and typed back. */
async function codeFor(b: Browser, token: string, email?: string) {
  const sent = await sendCode(b, token, email ? { email } : {});
  if (sent.status !== 202) throw new Error(`code: ${sent.status} ${await sent.text()}`);
  await t.drain();
  const code = lastCode();
  const checked = await b(`/api/app/invitations/${token}/code/check`, { json: { ...(email ? { email } : {}), code } });
  if (checked.status !== 200) throw new Error(`check: ${checked.status} ${await checked.text()}`);
  return code;
}
/** The workspace's role holding `administrator` (its "Admin", ADR 0085), as the members screen reads it. */
async function adminRole(b: Browser, orgId: string) {
  const { roles } = (await (await b(`/api/app/organizations/${orgId}/roles`)).json()) as {
    roles: { id: string; permissions: string[] }[];
  };
  return roles.find((r) => r.permissions.includes("administrator"))?.id ?? "";
}

/** Asks signed out with the address proven. */
async function provenAsk(token: string, json: { name: string; email: string; note?: string }) {
  const b = browser(t);
  return ask(b, token, { ...json, code: await codeFor(b, token, json.email) });
}

test("a link only asks: the same link every time, no sign-up from it, and an approval invites the address", async () => {
  const { owner, orgId, agentId, status, link, token } = await start();
  expect(status).toBe(201);
  expect(new Date(link.expiresAt).getTime() - Date.now()).toBeGreaterThan(29.9 * DAY);
  const again = await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} });
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual(link);
  const [stored] = await t.db.select().from(schema.organizationInviteLinks);
  expect(JSON.stringify(stored)).not.toContain(token);

  // Signed out: who shared it and a few of the workspace's agents, by name and look only.
  const anon = browser(t);
  expect(await (await anon(`/api/app/invitations/${token}`)).json()).toEqual({
    orgName: "Acme",
    email: "",
    role: "member",
    kind: "link",
    invitedBy: "owner",
    mode: "team",
    agents: [{ id: agentId, name: "Dev", appearance: null }],
  });
  // The link's token never opens sign-up, nor joins anyone.
  const header = await anon("/api/auth/sign-up/email", {
    json: { email: "eve@example.com", password: "correct horse battery", name: "Eve" },
    headers: { "x-invite-token": token },
  });
  expect(header.status).toBe(403);

  // This server sends email: a typed address proves itself first, with a code from its mailbox.
  const typed = { name: "  Ana   Souza ", email: "Ana@Example.com", note: "Paula's new designer" };
  const unproven = await ask(anon, token, typed);
  expect(unproven.status).toBe(400);
  expect(await errorCode(unproven)).toBe("join.code_needed");
  const sent = await sendCode(anon, token, { email: typed.email });
  expect(sent.status).toBe(202);
  expect(await sent.json()).toEqual({ email: "ana@example.com", resendIn: 60 });
  const soon = await sendCode(anon, token, { email: typed.email });
  expect(soon.status).toBe(429);
  const wait = (await soon.json()) as { error: { code: string; params: { retryIn: number } } };
  expect(wait.error.code).toBe("join.code_wait");
  expect(wait.error.params.retryIn).toBeGreaterThan(50);
  await t.drain();
  const code = lastCode();
  expect(mailTo("ana@example.com").map((m) => m.subject)).toEqual([`${code} é seu código do agentes.chat`]);
  // Sent, its job's row is gone: the code and the address aren't kept.
  const jobs = await t.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
  expect(jobs.filter((j) => (j.payload.template as { kind?: string }).kind === "join_code")).toEqual([]);
  const check = (json: { email: string; code: string }) => anon(`/api/app/invitations/${token}/code/check`, { json });
  const wrong = await check({ email: typed.email, code: code === "000000" ? "000001" : "000000" });
  expect(wrong.status).toBe(400);
  expect(await errorCode(wrong)).toBe("join.code_wrong");
  expect(await (await check({ email: typed.email, code })).json()).toEqual({ verified: true });
  const res = await ask(anon, token, { ...typed, code });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ status: "pending", email: "ana@example.com", emailed: true });
  expect((await ask(anon, token, { email: "x@example.com" })).status).toBe(400);
  // Proven, it is filed at once.
  const [request] = await requests(owner, orgId);
  expect(request).toMatchObject({
    name: "Ana Souza",
    email: "ana@example.com",
    note: "Paula's new designer",
    verified: true,
    confirmed: false,
  });

  await t.drain();
  const [toOwner] = mailTo("owner@example.com").filter((m) => m.subject === "Alguém pede para entrar no seu workspace");
  expect(toOwner?.text).toContain("Ana Souza · ana@example.com\n");
  expect(toOwner?.text).toContain(`/org/${orgId}/settings/members?request=${request?.id}&do=approve`);
  expect(toOwner?.text).not.toContain("Paula");
  const inbox = (await (await owner(`/api/app/organizations/${orgId}/notifications`)).json()) as {
    items: { kind: string; waiting: boolean; latest: { title?: string; names?: string[] } }[];
  };
  expect(inbox.items).toEqual([
    expect.objectContaining({
      kind: "join_request",
      waiting: true,
      latest: { title: "Ana Souza", names: ["Ana Souza"] },
    }),
  ]);

  const approved = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, { json: {} });
  const answer = (await approved.json()) as { outcome: string; url: string; emailed: boolean };
  expect(answer).toMatchObject({ outcome: "invited", emailed: true });
  expect(await requests(owner, orgId)).toEqual([]);
  await t.drain();
  const toAna = mailTo("ana@example.com").find((m) => m.subject === "Seu pedido para entrar foi aprovado");
  expect(toAna?.text).toContain(answer.url);

  // The invitation opens sign-up for that address only, and joins as a member.
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const invitation = answer.url.split("/invite/")[1] ?? "";
  expect(await (await ana(`/api/app/invitations/${invitation}/accept`, { json: {} })).json()).toEqual({ orgId });
  const me = (await (await ana("/api/app/me")).json()) as { organizations: { id: string; role: string }[] };
  expect(me.organizations).toEqual([expect.objectContaining({ id: orgId, role: "member" })]);
  const [used] = await t.db.select().from(schema.organizationInviteLinks);
  expect(used?.uses).toBe(1);
  const after = (await (await owner(`/api/app/organizations/${orgId}/notifications`)).json()) as {
    items: { kind: string }[];
  };
  // The request's notice went as she joined; the approval sent the invitation, so the owner hears she accepted it.
  expect(after.items.map((n) => n.kind)).toEqual(["invitation_accepted"]);
  // Joining with the link itself is refused: it only asks.
  expect((await (await ana(`/api/app/invitations/${token}/accept`, { json: {} })).json()) as object).toMatchObject({
    error: { code: "invitation.ask_to_join" },
  });
});

test("a server without email keeps the typed ask: no code, and the same answer whatever the address", async () => {
  const { owner, orgId, token } = await start();
  Object.assign(t.email, { delivers: false });
  const anon = browser(t);
  const noEmail = await sendCode(anon, token, { email: "ana@example.com" });
  expect(noEmail.status).toBe(409);
  expect(await errorCode(noEmail)).toBe("join.no_email");
  for (let i = 0; i < 2; i++) {
    const res = await ask(anon, token, { name: "Ana", email: "ana@example.com" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: "pending", email: "ana@example.com", emailed: false });
  }
  // A job files a typed request, apart from the reply. Nobody proved the address.
  expect(await requests(owner, orgId)).toEqual([]);
  await t.drain();
  expect(await requests(owner, orgId)).toEqual([
    expect.objectContaining({ email: "ana@example.com", verified: false, confirmed: false }),
  ]);
});

test("codes are limited per IP (10 an hour) and per link (40 an hour), checks per IP (30 an hour)", async () => {
  const { token } = await start();
  const from = (ip: string, i: number) =>
    sendCode(browser(t), token, { email: `c${i}-${ip}@example.com` }, { "x-forwarded-for": ip });
  for (let i = 0; i < 10; i++) expect((await from("203.0.113.1", i)).status).toBe(202);
  const limited = await from("203.0.113.1", 10);
  expect(limited.status).toBe(429);
  expect(await errorCode(limited)).toBe("join.rate_limited");
  for (const ip of ["203.0.113.2", "203.0.113.3", "203.0.113.4"])
    for (let i = 0; i < 10; i++) expect((await from(ip, i)).status).toBe(202);
  const busy = await from("203.0.113.5", 0);
  expect(busy.status).toBe(429);
  expect(await errorCode(busy)).toBe("join.link_busy");

  const check = (i: number) =>
    browser(t)(`/api/app/invitations/${token}/code/check`, {
      json: { email: `n${i}@example.com`, code: "123456" },
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
  for (let i = 0; i < 30; i++) expect((await check(i)).status).toBe(400);
  expect((await check(30)).status).toBe(429);
});

test("an IPv6 network asks as one address: two addresses in one /64 share its count, another /64 has its own", async () => {
  const { token } = await start();
  const from = (ip: string, i: number) =>
    sendCode(browser(t), token, { email: `v${i}@example.com` }, { "x-forwarded-for": ip });
  for (let i = 0; i < 10; i++) expect((await from(`2001:db8:a:b::${i + 1}`, i)).status).toBe(202);
  const limited = await from("2001:db8:a:b:ffff::1", 10);
  expect(limited.status).toBe(429);
  expect(await errorCode(limited)).toBe("join.rate_limited");
  expect((await from("2001:db8:a:c::1", 11)).status).toBe(202);
});

test("an address's limits are in the database: a restart resets none of them", async () => {
  const { token } = await start();
  const anon = browser(t);
  for (let i = 0; i < 5; i++) {
    expect(
      (await sendCode(anon, token, { email: "ana@example.com" }, { "x-forwarded-for": `203.0.113.${i}` })).status,
    ).toBe(202);
    // As if a minute passed: the next code can go.
    await t.db.update(schema.organizationJoinCodes).set({ sentAt: new Date(Date.now() - 61_000) });
  }
  // A restart empties every count kept in memory.
  t.adapters.rateLimiter = createMemoryRateLimiter();
  const sixth = await sendCode(anon, token, { email: "ana@example.com" });
  expect(sixth.status).toBe(429);
  expect(await errorCode(sixth)).toBe("join.code_limit");
});

test("asks are limited per IP (10 an hour) and per link (20 an hour)", async () => {
  const { token } = await start();
  Object.assign(t.email, { delivers: false });
  const from = (ip: string, i: number) =>
    ask(browser(t), token, { name: `P ${ip} ${i}`, email: `p${i}-${ip}@example.com` }, { "x-forwarded-for": ip });
  for (let i = 0; i < 10; i++) expect((await from("203.0.113.1", i)).status).toBe(201);
  const limited = await from("203.0.113.1", 10);
  expect(limited.status).toBe(429);
  expect(await errorCode(limited)).toBe("join.rate_limited");
  for (let i = 0; i < 10; i++) expect((await from("203.0.113.2", i)).status).toBe(201);
  const busy = await from("203.0.113.3", 0);
  expect(busy.status).toBe(429);
  expect(await errorCode(busy)).toBe("join.link_busy");
});

test("asks without a right code don't use up a link's hour: a person with a verified code still gets in", async () => {
  const { owner, orgId, link, token } = await start();
  // 30 asks from 3 IP addresses, each within its own limit, half with no code and half with a wrong one.
  for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
    for (let i = 0; i < 10; i++) {
      const json = { name: "Eve", email: `eve${i}@example.com`, ...(i % 2 ? { code: "123456" } : {}) };
      const res = await ask(browser(t), token, json, { "x-forwarded-for": ip });
      expect(await errorCode(res)).toBe(i % 2 ? "join.code_wrong" : "join.code_needed");
    }
  }
  const ana = { name: "Ana", email: "ana@example.com" };
  expect((await provenAsk(token, ana)).status).toBe(201);
  expect(await requests(owner, orgId)).toEqual([expect.objectContaining({ email: ana.email, verified: true })]);

  // Only new requests count, 20 an hour. Ana's was the 1st and 18 more go: Ana asking again is free, Bo's is the
  // 20th (were either 15 refused asks above counted, it would be past 20) and Cy's waits. Cy's code still works once
  // the link's hour frees up (a fresh limiter stands in for that), within its 30 minutes.
  const hour = { limit: 20, windowMs: 3_600_000 };
  for (let i = 0; i < 18; i++) await t.adapters.rateLimiter.consume(`join-request:link:${link.id}`, hour);
  expect((await provenAsk(token, ana)).status).toBe(200);
  expect((await provenAsk(token, { name: "Bo", email: "bo@example.com" })).status).toBe(201);
  const cy = browser(t);
  const cyAsk = { name: "Cy", email: "cy@example.com", code: await codeFor(cy, token, "cy@example.com") };
  const waits = await ask(cy, token, cyAsk);
  expect(waits.status).toBe(429);
  expect(await errorCode(waits)).toBe("join.link_busy");
  t.adapters.rateLimiter = createMemoryRateLimiter();
  expect((await ask(cy, token, cyAsk)).status).toBe(201);
});

test("signed in: a confirmed address joins at approval; an unconfirmed one gets an invitation", async () => {
  const { owner, orgId, token } = await start({ ALLOW_SIGNUP: "true" });
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  await t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, "bia@example.com"));
  const preview = async (b: Browser) =>
    ((await (await b(`/api/app/invitations/${token}`)).json()) as { you?: Record<string, unknown> }).you;
  expect(await preview(bia)).toEqual({ member: false, email: "bia@example.com", request: null });

  expect((await ask(bia, token, { note: "From the design team" })).status).toBe(201);
  expect((await ask(bia, token, {})).status).toBe(200);
  expect(await preview(bia)).toMatchObject({ request: { status: "pending", reason: null } });
  const [request] = await requests(owner, orgId);
  expect(request).toMatchObject({ email: "bia@example.com", confirmed: true });

  const admin = await adminRole(owner, orgId);
  const res = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, {
    json: { roleIds: [admin] },
  });
  expect(await res.json()).toEqual({ outcome: "joined" });
  expect(await preview(bia)).toEqual({
    member: true,
    orgId,
    email: "bia@example.com",
    request: { status: "approved", reason: null },
  });
  const me = (await (await bia("/api/app/me")).json()) as {
    organizations: { id: string; role: string; permissions: string[] }[];
  };
  // With the roles picked: the Admin role, so everything but ownership.
  expect(me.organizations).toEqual([
    expect.objectContaining({
      id: orgId,
      role: "member",
      rank: 0,
      permissions: expect.arrayContaining(["administrator", "manage_members"]),
    }),
  ]);
  expect(me.organizations[0]?.permissions).not.toContain("manage_owners");
  expect((await ask(bia, token, {})).status).toBe(409);

  // Not confirmed: the account's own address proves itself with a code, which never confirms the account.
  const cris = browser(t);
  await signUp(cris, "cris@example.com");
  expect(await errorCode(await ask(cris, token, {}))).toBe("join.code_needed");
  const code = await codeFor(cris, token);
  expect(mailTo("cris@example.com").filter((m) => m.subject.startsWith(code))).toHaveLength(1);
  expect((await ask(cris, token, { code })).status).toBe(201);
  const [unconfirmed] = await requests(owner, orgId);
  expect(unconfirmed).toMatchObject({ email: "cris@example.com", verified: true, confirmed: false });
  const [account] = await t.db.select().from(schema.users).where(eq(schema.users.email, "cris@example.com"));
  expect(account?.emailVerified).toBe(false);
  const invited = await owner(`/api/app/organizations/${orgId}/join-requests/${unconfirmed?.id}/approve`, {
    json: {},
  });
  expect(await invited.json()).toMatchObject({ outcome: "invited" });
  // Confirmed accounts never need one.
  expect(await errorCode(await sendCode(bia, token))).toBe("join.verified");
});

test("members' open apps hear whoever joins, changes roles or leaves, to read the people again", async () => {
  const { owner, orgId, token } = await start({ ALLOW_SIGNUP: "true" });
  let heard = 0;
  t.adapters.pubsub.subscribe(orgTopic(orgId), (e) => {
    if ((e as { event?: { type?: string } }).event?.type === "org.members") heard++;
  });
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  await t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, "bia@example.com"));
  await ask(bia, token, {});
  const [request] = await requests(owner, orgId);
  await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, { json: {} });
  expect(heard).toBe(1);
  const cai = await joinByInvitation(t, owner, orgId, "cai@example.com");
  expect(heard).toBe(2);
  const { user } = (await (await cai("/api/app/me")).json()) as { user: { id: string } };
  const member = `/api/app/organizations/${orgId}/members/${user.id}`;
  const roles = { roleIds: [await adminRole(owner, orgId)] };
  expect((await owner(`${member}/roles`, { method: "PUT", json: roles })).status).toBe(200);
  expect(heard).toBe(3);
  expect((await owner(member, { method: "DELETE" })).status).toBe(204);
  expect(heard).toBe(4);
});

test("only admins see and answer requests; asks must come from our own pages", async () => {
  const { owner, orgId, link, token } = await start();
  await provenAsk(token, { name: "Ana", email: "ana@example.com" });
  const [request] = await requests(owner, orgId);
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const calls = (b: Browser) => [
    b(`/api/app/organizations/${orgId}/join-requests`),
    b(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, { json: {} }),
    b(`/api/app/organizations/${orgId}/join-requests/${request?.id}/deny`, { json: {} }),
    b(`/api/app/organizations/${orgId}/invite-links`),
    b(`/api/app/organizations/${orgId}/invite-links`, { json: {} }),
    b(`/api/app/organizations/${orgId}/invite-links/${link.id}`, { method: "DELETE" }),
  ];
  for (const res of await Promise.all(calls(member))) expect(res.status).toBe(403);
  for (const res of await Promise.all(calls(browser(t)))) expect(res.status).toBe(401);
  for (const path of ["requests", "code", "code/check"]) {
    const foreign = await browser(t)(`/api/app/invitations/${token}/${path}`, {
      json: { name: "Eve", email: "eve@example.com", code: "123456" },
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
  }

  // Denied with a reason: the person reads it in the email.
  const denied = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/deny`, {
    json: { reason: "We only take people from <the studio>" },
  });
  expect(denied.status).toBe(204);
  const again = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/deny`, { json: {} });
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("join.answered");
  await t.drain();
  const toAna = mailTo("ana@example.com").find((m) => m.subject === "Seu pedido para entrar não foi aprovado");
  expect(toAna?.html).toContain(
    'We only take people from <span style="display:inline-block">&lt;the studio&gt;”</span>',
  );
});

test("an account that never confirmed its address reads no one else's answer, nor asks without its mailbox", async () => {
  const { owner, orgId, token } = await start({ ALLOW_SIGNUP: "true" });
  await provenAsk(token, { name: "Otto", email: "otto@corp.com" });
  const [otto] = await requests(owner, orgId);
  const denied = await owner(`/api/app/organizations/${orgId}/join-requests/${otto?.id}/deny`, {
    json: { reason: "Not this team" },
  });
  expect(denied.status).toBe(204);
  const notOtto = browser(t);
  await signUp(notOtto, "otto@corp.com");
  const preview = (await (await notOtto(`/api/app/invitations/${token}`)).json()) as { you?: unknown };
  expect(preview.you).toEqual({ member: false, email: "otto@corp.com", request: null });
  // Asking needs the code from Otto's mailbox.
  expect(await errorCode(await ask(notOtto, token, {}))).toBe("join.code_needed");
  expect(await errorCode(await ask(notOtto, token, { code: "123456" }))).toBe("join.code_wrong");
  await t.drain();
  expect(await requests(owner, orgId)).toEqual([]);
});

test("joining by an email invitation closes the person's request and the admins' notice", async () => {
  const { owner, orgId, token } = await start();
  await provenAsk(token, { name: "Rui", email: "rui@example.com" });
  await t.drain();
  const inbox = async () =>
    ((await (await owner(`/api/app/organizations/${orgId}/notifications`)).json()) as { items: { kind: string }[] })
      .items;
  expect(await requests(owner, orgId)).toHaveLength(1);
  expect((await inbox()).map((n) => n.kind)).toEqual(["join_request"]);
  await joinByInvitation(t, owner, orgId, "rui@example.com");
  expect(await requests(owner, orgId)).toEqual([]);
  // The request's notice is gone; what's left is that Rui accepted the owner's invitation (ADR 0090).
  expect((await inbox()).map((n) => n.kind)).toEqual(["invitation_accepted"]);
});

test("a link turned off: its requests close quietly, its page says it no longer works", async () => {
  const { owner, orgId, link, token } = await start({ ALLOW_SIGNUP: "true" });
  await provenAsk(token, { name: "Ana", email: "ana@example.com" });
  await t.drain();
  t.email.sent.length = 0;
  expect((await owner(`/api/app/organizations/${orgId}/invite-links`)).status).toBe(200);
  expect((await owner(`/api/app/organizations/${orgId}/invite-links/${link.id}`, { method: "DELETE" })).status).toBe(
    204,
  );
  expect(await requests(owner, orgId)).toEqual([]);
  expect(await (await browser(t)(`/api/app/invitations/${token}`)).json()).toMatchObject({
    kind: "link",
    closed: true,
  });
  const refused = await ask(browser(t), token, { name: "Bia", email: "bia@example.com" });
  expect(refused.status).toBe(404);
  expect(await errorCode(refused)).toBe("join.link_closed");
  expect(await errorCode(await sendCode(browser(t), token, { email: "bia@example.com" }))).toBe("join.link_closed");
  expect((await browser(t)(`/api/app/invitations/${token}/request-new`, { json: {} })).status).toBe(404);
  await t.drain();
  expect(t.email.sent).toEqual([]);
  // A member opening it is told they're in; anyone else signed in hears only that it no longer works.
  expect(await (await owner(`/api/app/invitations/${token}`)).json()).toMatchObject({
    closed: true,
    you: { member: true, orgId },
  });
  const eve = browser(t);
  await signUp(eve, "eve@example.com");
  expect(await (await eve(`/api/app/invitations/${token}`)).json()).not.toHaveProperty("you");
  // A new link is made the next time one is asked for.
  const next = (await (await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} })).json()) as Link;
  expect(next.url).not.toBe(link.url);
});

test("request a new invitation: the inviter is emailed once; valid or unknown tokens are refused", async () => {
  const { owner, orgId } = await start();
  const { url } = (await (
    await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
  ).json()) as { url: string };
  const token = url.split("/invite/")[1] ?? "";
  const anon = browser(t);
  expect((await anon(`/api/app/invitations/${token}/request-new`, { json: {} })).status).toBe(409); // still valid
  expect((await anon("/api/app/invitations/nope/request-new", { json: {} })).status).toBe(404);

  await t.db.update(schema.organizationInvitations).set({ expiresAt: new Date(Date.now() - 1000) });
  await t.drain();
  t.email.sent.length = 0;
  expect((await anon(`/api/app/invitations/${token}/request-new`, { json: {} })).status).toBe(204);
  expect((await anon(`/api/app/invitations/${token}/request-new`, { json: {} })).status).toBe(204);
  await t.drain();
  expect(t.email.sent.map((m) => [m.to, m.subject])).toEqual([[["owner@example.com"], "Pediram um novo convite"]]);
  // The address as typed, with the hair spaces that keep mail clients from linking it.
  expect(t.email.sent[0]?.text).toContain("ana@\u200aexample.\u200acom abriu um convite vencido da Acme");
  expect(t.email.sent[0]?.text).toContain(`/org/${orgId}/settings/members`);
});

test("an ask with a password: approval makes the account, and the asking page signs in once (ADR 0090)", async () => {
  const { owner, orgId, token } = await start();
  const anon = browser(t);
  const code = await codeFor(anon, token, "rafa@example.com");
  const asked = await ask(anon, token, {
    name: "Rafa Costa",
    email: "rafa@example.com",
    code,
    password: "correct horse battery",
  });
  expect(asked.status).toBe(201);
  const { key } = (await asked.json()) as { key: string };
  expect(key).toMatch(/^[0-9a-f-]{36}\./);
  // No account until someone approves: a link never signs anyone up.
  expect(await t.db.select().from(schema.users).where(eq(schema.users.email, "rafa@example.com"))).toEqual([]);
  const claim = () => anon(`/api/app/invitations/${token}/requests/claim`, { json: { key } });
  expect(await (await claim()).json()).toEqual({ status: "pending" });

  const [request] = await requests(owner, orgId);
  const approved = await owner(`/api/app/organizations/${orgId}/join-requests/${request?.id}/approve`, { json: {} });
  expect(await approved.json()).toEqual({ outcome: "joined" });
  const claimed = (await (await claim()).json()) as { status: string; orgId: string; signIn: string };
  expect(claimed).toMatchObject({ status: "in", orgId });
  expect((await anon("/api/auth/sign-in/one-time-token", { json: { token: claimed.signIn } })).status).toBe(200);
  const me = (await (await anon("/api/app/me")).json()) as {
    user: { email: string; emailVerified: boolean };
    organizations: { id: string }[];
  };
  expect(me.user).toMatchObject({ email: "rafa@example.com", emailVerified: true });
  expect(me.organizations.map((o) => o.id)).toContain(orgId);
  // Spent: the key signs in once, and the page reads it closed from then on.
  expect(await (await claim()).json()).toEqual({ status: "closed" });
  // The password they chose is the account's.
  const later = browser(t);
  const signIn = await later("/api/auth/sign-in/email", {
    json: { email: "rafa@example.com", password: "correct horse battery" },
  });
  expect(signIn.status).toBe(200);
});

test("sign-up from the invitation's email: no 'confirm your email'; from a copied link or none, it goes (ADR 0090)", async () => {
  const { owner, orgId } = await start();
  const invite = async (email: string) => {
    const res = await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email } });
    return ((await res.json()) as { url: string }).url.split("/invite/")[1] ?? "";
  };
  const ana = await invite("ana@example.com");
  const dani = await invite("dani@example.com");
  await invite("bia@example.com");
  await invite("caio@example.com");
  await t.drain();
  // The email's link is the copied one plus the proof only the message carries.
  const emailed = mailTo("ana@example.com")[0]?.text.match(/\/invite\/([\w-]+)\?mail=([\w-]{43})/);
  expect(emailed?.[1]).toBe(ana);
  const mail = emailed?.[2] ?? "";
  t.email.sent.length = 0;
  // Each signs up in a browser of their own, signed in from then on.
  const people = new Map<string, Browser>();
  const signUpWith = (email: string, invitation?: { token: string; mail?: string }) => {
    const b = browser(t);
    people.set(email, b);
    return b("/api/auth/sign-up/email", {
      json: { email, password: "correct horse battery", name: email.split("@")[0] },
      headers: {
        ...(invitation ? { "x-invitation-token": invitation.token } : {}),
        ...(invitation?.mail ? { "x-invitation-mail": invitation.mail } : {}),
      },
    });
  };
  // From Ana's own email: accepting confirms her address, so no message asks her to.
  expect((await signUpWith("ana@example.com", { token: ana, mail })).status).toBe(200);
  // Dani's link as an admin copies it, another address's email, or nothing: the message goes as always.
  expect((await signUpWith("dani@example.com", { token: dani })).status).toBe(200);
  expect((await signUpWith("bia@example.com", { token: ana, mail })).status).toBe(200);
  expect((await signUpWith("caio@example.com")).status).toBe(200);
  await t.drain();
  const confirmations = t.email.sent.filter((m) => m.subject === "Confirme seu e-mail no agentes.chat");
  expect(confirmations.map((m) => m.to[0]).sort()).toEqual(["bia@example.com", "caio@example.com", "dani@example.com"]);

  // Accepting confirms only from the email: Dani, with the copied link, still has her own message to open.
  const verified = async (b: Browser) =>
    ((await (await b("/api/app/me")).json()) as { user: { emailVerified: boolean } }).user.emailVerified;
  const asAna = people.get("ana@example.com") ?? browser(t);
  expect((await asAna(`/api/app/invitations/${ana}/accept?mail=${mail}`, { json: {} })).status).toBe(200);
  expect(await verified(asAna)).toBe(true);
  const asDani = people.get("dani@example.com") ?? browser(t);
  expect((await asDani(`/api/app/invitations/${dani}/accept`, { json: {} })).status).toBe(200);
  expect(await verified(asDani)).toBe(false);
});

test("a batch of invitations takes `emails` or `invites`, never both nor neither", async () => {
  const { owner, orgId } = await start();
  const path = `/api/app/organizations/${orgId}/invitations/batch`;
  const batch = (json: Record<string, unknown>) => owner(path, { json });
  const both = await batch({ emails: ["a@example.com"], invites: [{ email: "b@example.com" }] });
  expect(both.status).toBe(400);
  expect(await errorCode(both)).toBe("invalid_request");
  expect((await batch({})).status).toBe(400);
  expect((await batch({ invites: [{ email: "b@example.com" }] })).status).toBe(200);
});

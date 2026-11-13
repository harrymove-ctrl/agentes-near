import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { passwordLinkByEmail } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** ADR 0158: a new-password link made by a workspace owner on a server that sends no email. */

let t: TestServer;
beforeEach(async () => {
  // Sign-up otherwise closes after the first account, and one test needs a second owner with a workspace of their own.
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  Object.assign(t.email, { delivers: false });
});
afterEach(async () => {
  await t.close();
});

const meOf = async (b: Browser) => (await (await b("/api/app/me")).json()) as { user: { id: string } };
const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";
const signIn = (email: string, password: string) =>
  browser(t)("/api/auth/sign-in/email", { json: { email, password } });

test("an owner makes a member's link: it resets the password once, the earlier link stops working, the log keeps it", async () => {
  const owner = browser(t);
  await signUp(owner, "ana@example.com");
  const { orgId } = await seedOrg(owner);
  const bruno = await joinByInvitation(t, owner, orgId, "bruno@example.com");
  const brunoId = (await meOf(bruno)).user.id;

  const first = await owner(`/api/app/organizations/${orgId}/members/${brunoId}/password-link`, { json: {} });
  expect(first.status).toBe(201);
  const earlier = (await first.json()) as { url: string; expiresAt: string };
  expect(earlier.url).toContain("/reset-password?token=");
  const second = (await (
    await owner(`/api/app/organizations/${orgId}/members/${brunoId}/password-link`, { json: {} })
  ).json()) as { url: string };

  const reset = (token: string) =>
    browser(t)("/api/auth/reset-password", { json: { token, newPassword: "a brand new password" } });
  expect((await reset(tokenOf(earlier.url))).status).toBe(400);
  expect((await reset(tokenOf(second.url))).status).toBe(200);
  expect((await reset(tokenOf(second.url))).status).toBe(400);
  expect((await signIn("bruno@example.com", "a brand new password")).status).toBe(200);

  const log = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "member.password_link"));
  expect(log).toHaveLength(2);
  expect(JSON.stringify(log)).not.toContain(tokenOf(second.url));
});

test("refused for a member, for oneself, for the server's owner, and where the server emails", async () => {
  const owner = browser(t);
  await signUp(owner, "ana@example.com");
  const ownerId = (await meOf(owner)).user.id;
  const { orgId } = await seedOrg(owner);
  const bruno = await joinByInvitation(t, owner, orgId, "bruno@example.com");
  const brunoId = (await meOf(bruno)).user.id;
  const link = (b: Browser, userId: string) =>
    b(`/api/app/organizations/${orgId}/members/${userId}/password-link`, { json: {} });

  expect((await link(bruno, ownerId)).status).toBe(403);
  expect((await link(owner, ownerId)).status).toBe(403);
  // Bruno made owner of this workspace still can't take over the server's owner.
  const promoted = await owner(`/api/app/organizations/${orgId}/members/${brunoId}`, {
    method: "PATCH",
    json: { role: "owner" },
  });
  expect(promoted.status).toBe(204);
  const refused = await link(bruno, ownerId);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "password_link.server_owner" } });

  Object.assign(t.email, { delivers: true });
  const emails = await link(owner, brunoId);
  expect(emails.status).toBe(409);
  expect(await emails.json()).toMatchObject({ error: { code: "password_link.email" } });
});

test("never for someone who also belongs to a workspace the owner doesn't own", async () => {
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const { orgId } = await seedOrg(ana);
  const caio = browser(t);
  await signUp(caio, "caio@example.com");
  const created = await caio("/api/app/organizations", { json: { name: "Norte", context: "Norte paints houses." } });
  const theirs = (await created.json()) as { organization: { id: string } };
  const bruno = await joinByInvitation(t, ana, orgId, "bruno@example.com");
  await joinByInvitation(t, caio, theirs.organization.id, "bruno@example.com", { as: bruno });
  const brunoId = (await meOf(bruno)).user.id;
  const refused = await ana(`/api/app/organizations/${orgId}/members/${brunoId}/password-link`, { json: {} });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "password_link.other_workspace" } });
});

test("the command line's link, by email", async () => {
  const owner = browser(t);
  await signUp(owner, "ana@example.com");
  const link = await passwordLinkByEmail(t.db, "https://agentes.example.com/", " Ana@Example.com ");
  expect(link?.url).toStartWith("https://agentes.example.com/reset-password?token=");
  const token = tokenOf(link?.url ?? "");
  expect(
    (await browser(t)("/api/auth/reset-password", { json: { token, newPassword: "a brand new password" } })).status,
  ).toBe(200);
  expect(await passwordLinkByEmail(t.db, "https://agentes.example.com", "nobody@example.com")).toBeNull();
});

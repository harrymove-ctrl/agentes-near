import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

const options = (b = browser(t), email: string) => b("/api/app/sign-in-options", { json: { email } });

test("an e-mail with a password account: sign in with the password", async () => {
  await signUp(browser(t), "owner@example.com");
  const res = await options(undefined, " Owner@Example.com ".trim());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ account: true, password: true, providers: [], canSignUp: false });
});

test("an account linked to Google only: no password, the provider", async () => {
  await signUp(browser(t), "owner@example.com");
  const [user] = await t.db.select({ id: schema.users.id }).from(schema.users);
  await t.db.delete(schema.accounts);
  await t.db.insert(schema.accounts).values({
    id: "acc-google",
    accountId: "g-1",
    providerId: "google",
    userId: user?.id ?? "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(await (await options(undefined, "owner@example.com")).json()).toEqual({
    account: true,
    password: false,
    providers: ["google"],
    canSignUp: false,
  });
});

test("a new e-mail: sign-up follows the policy (first account, closed, invited)", async () => {
  expect(await (await options(undefined, "first@example.com")).json()).toMatchObject({
    account: false,
    canSignUp: true,
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  expect(await (await options(undefined, "stranger@example.com")).json()).toMatchObject({
    account: false,
    canSignUp: false,
  });
  const { orgId } = await seedOrg(owner);
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } });
  expect(await (await options(undefined, "ana@example.com")).json()).toMatchObject({ account: false, canSignUp: true });
});

test("rate limited per address; another origin is refused", async () => {
  const b = browser(t);
  for (let i = 0; i < 30; i++) expect((await options(b, `p${i}@example.com`)).status).toBe(200);
  expect((await options(b, "one-more@example.com")).status).toBe(429);
  const res = await browser(t)("/api/app/sign-in-options", {
    json: { email: "a@example.com" },
    origin: "https://evil.example",
  });
  expect(res.status).toBe(403);
});

test("auth-config says whether 'forgot password' can send its e-mail", async () => {
  expect(await (await browser(t)("/api/app/auth-config")).json()).toHaveProperty("passwordReset");
});

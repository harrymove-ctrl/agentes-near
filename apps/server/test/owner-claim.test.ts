import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { schema } from "@agenteschat/db";
import { deleteAccount } from "@agenteschat/engine";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

/**
 * The installation's first account when the install left a secret for its owner (ADR 0060 §6): the
 * setup's owner link (a claim) or the desktop app's owner key. Every other way to the first account
 * waits until the owner exists.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const CLAIM = "claim-token-0123456789abcdefghijklmnopqrstu";
const KEY = "owner-key-0123456789abcdefghijklmnopqrstuvwx";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const PASSWORD = "correct horse battery";

const instance = async () => (await (await t.app.request("/api/instance")).json()) as Record<string, unknown>;
const authConfig = async () => (await (await t.app.request("/api/app/auth-config")).json()) as Record<string, unknown>;

/** What the desktop app sends, from no web view: no Origin, no cookie. */
const ownerKey = (body: Record<string, unknown>) =>
  t.app.request("/api/auth/owner-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A window trading a one-time sign-in for its own session. */
async function trade(token: string) {
  const window = browser(t);
  const res = await window("/api/auth/sign-in/one-time-token", { json: { token } });
  return { res, window };
}

describe("the owner link (OWNER_CLAIM_SHA256)", () => {
  test("the first account waits for it, by email and by any other sign-up", async () => {
    t = await createTestServer({ env: { OWNER_CLAIM_SHA256: sha256(CLAIM) } });
    expect(await instance()).toMatchObject({ ownerClaim: true, signup: "invite" });
    expect(await authConfig()).toMatchObject({ ownerClaim: true, firstRun: false, signupOpen: false });

    const res = await browser(t)("/api/auth/sign-up/email", {
      json: { name: "Ana", email: "ana@example.com", password: PASSWORD },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "OWNER_CLAIM_REQUIRED" });
    const options = await browser(t)("/api/app/sign-in-options", { json: { email: "ana@example.com" } });
    expect(await options.json()).toMatchObject({ account: false, canSignUp: false });
    // Social sign-ups create users through the same hook.
    const { internalAdapter } = await t.auth.$context;
    await expect(
      internalAdapter.createUser({ name: "Ana", email: "ana@example.com" }, { method: "email-password" }),
    ).rejects.toThrow(/waits for its owner/);
    expect(await t.db.select().from(schema.users)).toEqual([]);
  });

  test("it makes the owner once, with a password, and signs them in", async () => {
    t = await createTestServer({ env: { OWNER_CLAIM_SHA256: sha256(CLAIM) } });
    const owner = browser(t);
    expect(
      (
        await owner("/api/auth/owner-claim", {
          json: { token: "x".repeat(43), name: "Ana", email: "a@x.io", password: PASSWORD },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await owner("/api/auth/owner-claim", {
          json: { token: CLAIM, name: "Ana", email: "ana@example.com", password: "short" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await owner("/api/auth/owner-claim", { json: { token: CLAIM, name: "Ana", email: "ana@example.com" } })).status,
    ).toBe(400);

    const claimed = await owner("/api/auth/owner-claim", {
      json: { token: CLAIM, name: "Ana", email: "Ana@Example.com", password: PASSWORD },
    });
    expect(claimed.status).toBe(201);
    const me = (await (await owner("/api/app/me")).json()) as { user: { email: string; hasPassword: boolean } };
    expect(me.user).toMatchObject({ email: "ana@example.com", hasPassword: true });
    const org = await owner("/api/app/organizations", { json: { name: "Acme" } });
    expect(org.status).toBe(201);

    // Inert from here: the link again, and the ordinary rules for everyone else.
    const again = await browser(t)("/api/auth/owner-claim", {
      json: { token: CLAIM, name: "Bia", email: "bia@example.com", password: PASSWORD },
    });
    expect(again.status).toBe(409);
    expect(await instance()).toMatchObject({ ownerClaim: false });
    expect(
      (await browser(t)("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: PASSWORD } })).status,
    ).toBe(200);
    const second = await browser(t)("/api/auth/sign-up/email", {
      json: { name: "Bia", email: "bia@example.com", password: PASSWORD },
    });
    expect(second.status).toBe(403);
    expect(await t.db.select().from(schema.users)).toHaveLength(1);
  });

  test("without it nothing changes: the first account to sign up owns the installation", async () => {
    t = await createTestServer();
    expect(await instance()).toMatchObject({ ownerClaim: false, signup: "open" });
    expect(await authConfig()).toMatchObject({ ownerClaim: false, firstRun: true });
    expect(
      (
        await browser(t)("/api/auth/owner-claim", {
          json: { token: CLAIM, name: "A", email: "a@x.io", password: PASSWORD },
        })
      ).status,
    ).toBe(404);
    await signUp(browser(t), "ana@example.com");
  });
});

describe("the desktop app's owner key (OWNER_KEY_SHA256)", () => {
  test("makes the owner with no password, then a one-time sign-in for them on every call", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY) } });
    expect((await ownerKey({ key: "y".repeat(43), name: "Ana", email: "ana@example.com" })).status).toBe(401);
    expect((await ownerKey({ key: KEY })).status).toBe(400);
    const signup = await browser(t)("/api/auth/sign-up/email", {
      json: { name: "Eve", email: "eve@example.com", password: PASSWORD },
    });
    expect(signup.status).toBe(403);

    const first = await ownerKey({ key: KEY, name: "Ana", email: "ana@example.com" });
    expect(first.status).toBe(200);
    const { token, userId } = (await first.json()) as { token: string; expiresIn: number; userId: string };
    const { res, window } = await trade(token);
    expect(res.status).toBe(200);
    const me = (await (await window("/api/app/me")).json()) as {
      user: { id: string; email: string; hasPassword: boolean };
    };
    expect(me.user).toMatchObject({ email: "ana@example.com", hasPassword: false });
    // Who the owner is: the app compares it with who its window was signed in as.
    expect(userId).toBe(me.user.id);
    // Single use.
    expect((await trade(token)).res.status).toBe(401);

    // Later (a session that ended): the same owner, no name needed, any extra fields ignored.
    const later = await ownerKey({ key: KEY, name: "Someone", email: "someone@example.com" });
    const again = await trade(((await later.json()) as { token: string }).token);
    expect(again.res.status).toBe(200);
    expect(((await (await again.window("/api/app/me")).json()) as { user: { email: string } }).user.email).toBe(
      "ana@example.com",
    );
    expect(await t.db.select().from(schema.users)).toHaveLength(1);
  });

  test("the owner adds a password for other browsers, then a new one after Continue on this Mac (ADR 0158)", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY) } });
    const { token } = (await (await ownerKey({ key: KEY, name: "Ana", email: "ana@example.com" })).json()) as {
      token: string;
    };
    const { window } = await trade(token);
    expect(
      (await browser(t)("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: PASSWORD } })).status,
    ).toBe(401);
    expect((await window("/api/app/me/password", { json: { password: "short" } })).status).toBe(400);
    expect((await window("/api/app/me/password", { json: { password: PASSWORD } })).status).toBe(204);
    expect(
      (await browser(t)("/api/auth/sign-in/email", { json: { email: "ana@example.com", password: PASSWORD } })).status,
    ).toBe(200);
    // Forgot it: the app signs the owner in again with its key, and the fresh sign-in sets a new one.
    const again = (await (await ownerKey({ key: KEY })).json()) as { token: string };
    const { window: fresh } = await trade(again.token);
    expect((await fresh("/api/app/me/password", { json: { password: "another one entirely" } })).status).toBe(204);
    // Every other session ended with the old password: only the window that set it stays signed in.
    expect(await t.db.select().from(schema.sessions)).toHaveLength(1);
    const signIn = (password: string) =>
      browser(t)("/api/auth/sign-in/email", { json: { email: "ana@example.com", password } });
    expect((await signIn(PASSWORD)).status).toBe(401);
    expect((await signIn("another one entirely")).status).toBe(200);
  });

  test("the key follows the pinned owner, not whoever is oldest after a deletion", async () => {
    t = await createTestServer({ env: { OWNER_KEY_SHA256: sha256(KEY), ALLOW_SIGNUP: "true" } });
    expect((await ownerKey({ key: KEY, name: "Ana", email: "ana@example.com" })).status).toBe(200);
    const [ana] = await t.db.select().from(schema.users);
    if (!ana) throw new Error("no owner account");
    // A newer account, then the owner deletes hers (deleteAccount pins the owner first, so it stays Ana once gone).
    await signUp(browser(t), "bia@example.com");
    await deleteAccount(t.db, ana.id);
    // The owner key must never sign in as Bia, the now-oldest account.
    const later = await ownerKey({ key: KEY });
    const token = ((await later.json()) as { token?: string }).token;
    let email: string | null = null;
    if (token) {
      const { res, window } = await trade(token);
      if (res.status === 200) {
        const me = await window("/api/app/me");
        if (me.status === 200) email = ((await me.json()) as { user: { email: string } }).user.email;
      }
    }
    expect(email).not.toBe("bia@example.com");
  });
});

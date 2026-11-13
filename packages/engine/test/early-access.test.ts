import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFakeEmailSender } from "@agenteschat/adapters";
import { countQueries, type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  canCreateWorkspace,
  createInvitation,
  createOrganization,
  deleteAccount,
  EARLY_ACCESS_TOKEN,
  type EmailLocale,
  earlyAccessEmail,
  enqueueWaitlistContacts,
  hasWorkspaceAllowance,
  importWaitlist,
  inviteEarlyAccess,
  isSignupAllowed,
  listEarlyAccess,
  NotFoundError,
  needsWorkspaceAllowance,
  resendEarlyAccess,
  revokeEarlyAccess,
  type SignupPolicy,
  saveWaitlistContact,
  setSignupMode,
  sha256,
  signInOptions,
  signupAdmission,
  signupMode,
  useEarlyAccess,
  ValidationError,
  waitlistCounts,
  waitlistNext,
} from "../src";

const { earlyAccessInvitations: invitations, waitlistEntries, outbox } = schema;

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(() => close());

const CLOSED: SignupPolicy = { allowSignup: false, ownerByLink: false };
const CLOUD = { paidMachines: true, allowSignup: false };
const APP = "https://app.test";
const T0 = new Date("2026-11-02T12:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

let accounts = 0;
// A millisecond apart, in order: made back to back they could share `created_at`, and the installation's owner (the
// earliest) would then be picked by a random id.
async function account(email: string, locale?: "en" | "pt-BR") {
  const id = `user_${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = new Date(T0.getTime() - DAY + accounts++);
  await db.insert(schema.users).values({ id, name: email.split("@")[0] ?? "x", email, createdAt, locale });
  return id;
}

/** A member of `orgId` who got in through a workspace invitation, not early access. */
async function member(email: string, orgId: string, locale?: "en" | "pt-BR") {
  const id = await account(email, locale);
  await db.insert(schema.organizationMembers).values({ orgId, userId: id, role: "member" });
  return id;
}

/** The account's address confirmed, as its confirmation link does. */
async function confirm(userId: string) {
  await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, userId));
}

async function confirmed(userId: string) {
  const [user] = await db
    .select({ emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return user?.emailVerified;
}

async function invite(email: string, now = T0, options: { resend?: boolean; locale?: EmailLocale } = {}) {
  const [result] = await inviteEarlyAccess(
    db,
    { emails: [email], resend: options.resend ?? true, locale: options.locale, publicUrl: APP },
    now,
  );
  if (!result) throw new Error("no answer");
  return result;
}

type Sent = {
  key: string;
  to: string[];
  template: { kind: string; locale: string; url: string } & Record<string, unknown>;
};

/** The early-access emails queued, oldest first. */
async function sent() {
  const rows = await db.select({ payload: outbox.payload }).from(outbox).where(eq(outbox.kind, "email.send"));
  return rows.map((r) => r.payload as Sent).filter((p) => p.key.startsWith("early-access:"));
}

/** The token in the latest link sent to `email`. */
async function tokenOf(email: string) {
  const links = (await sent()).filter((s) => s.to[0] === email);
  const token = new URL(links.at(-1)?.template.url ?? "x:").searchParams.get("access");
  if (!token) throw new Error(`no link for ${email}`);
  return token;
}

async function row(email: string) {
  const [r] = await db.select().from(invitations).where(eq(invitations.email, email));
  if (!r) throw new Error(`no invitation for ${email}`);
  return r;
}

/** An account made with the address's link, as the sign-up hook does. */
async function signUpWithLink(email: string, now = T0) {
  const userId = await account(email);
  expect(await useEarlyAccess(db, { access: await tokenOf(email), email, userId }, now)).toBe(true);
  return userId;
}

describe("the sign-up mode", () => {
  test("no row reads as invite; it changes live, and changedAt moves only when the mode does", async () => {
    expect(await signupMode(db)).toEqual({ mode: "invite", changedAt: null });
    expect(await setSignupMode(db, "invite", at(1))).toEqual({ mode: "invite", changedAt: null });
    expect(await setSignupMode(db, "open", at(2))).toEqual({ mode: "open", changedAt: at(2) });
    expect(await setSignupMode(db, "open", at(3))).toEqual({ mode: "open", changedAt: at(2) });
    expect(await setSignupMode(db, "invite", at(4))).toEqual({ mode: "invite", changedAt: at(4) });
  });
});

describe("who may sign up", () => {
  test("in order: ALLOW_SIGNUP, the first account, the live mode, a workspace invitation", async () => {
    // No account yet: the first one, unless the owner's link or key makes it.
    expect(await signupAdmission(db, "ana@acme.com", CLOSED)).toBe("first");
    expect(await signupAdmission(db, "ana@acme.com", { allowSignup: false, ownerByLink: true })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", { allowSignup: true, ownerByLink: true })).toBeNull();
    const owner = await account("owner@acme.com");
    expect(await signupAdmission(db, "ana@acme.com", CLOSED)).toBeNull();
    // ALLOW_SIGNUP forces it open, whatever the mode.
    expect(await signupAdmission(db, "ana@acme.com", { allowSignup: true, ownerByLink: false })).toBe("open");
    expect(await signupAdmission(db, "ana@acme.com", { allowSignup: true, ownerByLink: true })).toBe("open");
    // The live mode lets anyone in, and back.
    await setSignupMode(db, "open");
    expect(await signupAdmission(db, "ana@acme.com", CLOSED)).toBe("open");
    expect(await isSignupAllowed(db, "ana@acme.com", CLOSED)).toBe(true);
    // Never on a server that is its agents' computer.
    expect(await signupAdmission(db, "ana@acme.com", { ...CLOSED, hostComputer: true })).toBeNull();
    await setSignupMode(db, "invite");
    expect(await isSignupAllowed(db, "ana@acme.com", CLOSED)).toBe(false);
    // A pending workspace invitation, as before.
    const { organization } = await createOrganization(db, owner, { name: "Acme" });
    await createInvitation(db, owner, organization.id, { email: "Ana@Acme.com", role: "member" });
    expect(await signupAdmission(db, " ANA@acme.com ", CLOSED)).toBe("invitation");
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { now: at(400 * DAY) })).toBeNull();
  });

  test("an early-access link opens sign-up for its own address, in any case or spacing, until it expires", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const access = await tokenOf("ana@acme.com");
    expect(access).toMatch(EARLY_ACCESS_TOKEN);
    expect(await signupAdmission(db, "  Ana@ACME.com ", CLOSED, { access, now: at(MIN) })).toBe("early_access");
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access, now: at(14 * DAY - 1) })).toBe("early_access");
    // Expired, another address, a wrong token, a malformed one, none.
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access, now: at(14 * DAY) })).toBeNull();
    expect(await signupAdmission(db, "bia@acme.com", CLOSED, { access, now: at(MIN) })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: "A".repeat(43) })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: `${access}A` })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", CLOSED)).toBeNull();
  });

  test("a revoked or used link opens nothing", async () => {
    await account("owner@acme.com");
    const { invitationId } = await invite("ana@acme.com");
    await invite("bia@acme.com");
    const ana = await tokenOf("ana@acme.com");
    await revokeEarlyAccess(db, invitationId ?? "", at(MIN));
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: ana, now: at(2 * MIN) })).toBeNull();
    const bia = await tokenOf("bia@acme.com");
    await signUpWithLink("bia@acme.com");
    expect(await signupAdmission(db, "bia@acme.com", CLOSED, { access: bia })).toBeNull();
  });

  test("without its token an invited address answers like any other, with the same queries", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const invited = await countQueries(() => signupAdmission(db, "ana@acme.com", CLOSED));
    const stranger = await countQueries(() => signupAdmission(db, "bia@acme.com", CLOSED));
    expect(invited).toEqual({ result: null, queries: stranger.queries });
    expect(await signInOptions(db, "ana@acme.com", CLOSED)).toEqual(await signInOptions(db, "bia@acme.com", CLOSED));
  });

  test("the sign-in screen: canSignUp with the link, and accessExpired only for the link's own address", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const access = await tokenOf("ana@acme.com");
    const none = { account: false, password: false, providers: [] };
    expect(await signInOptions(db, "Ana@acme.com", CLOSED, access, at(MIN))).toEqual({ ...none, canSignUp: true });
    const later = at(15 * DAY);
    expect(await signInOptions(db, "ana@acme.com", CLOSED, access, later)).toEqual({
      ...none,
      canSignUp: false,
      accessExpired: true,
    });
    expect(await signInOptions(db, "bia@acme.com", CLOSED, access, later)).toEqual({ ...none, canSignUp: false });
    expect(await signInOptions(db, "ana@acme.com", CLOSED, undefined, later)).toEqual({ ...none, canSignUp: false });
  });
});

describe("using an invitation", () => {
  test("once, by its own address, which it confirms: the token goes; deleting the account keeps the use", async () => {
    await account("owner@acme.com");
    const { invitationId } = await invite("ana@acme.com");
    const access = await tokenOf("ana@acme.com");
    const bia = await account("bia@acme.com");
    expect(await useEarlyAccess(db, { access, email: "bia@acme.com", userId: bia })).toBe(false);
    expect(await confirmed(bia)).toBe(false);
    const ana = await account("ana@acme.com");
    expect(await useEarlyAccess(db, { access, email: " Ana@Acme.com", userId: ana }, at(MIN))).toBe(true);
    expect(await useEarlyAccess(db, { access, email: "ana@acme.com", userId: ana }, at(2 * MIN))).toBe(false);
    expect(await row("ana@acme.com")).toMatchObject({ usedAt: at(MIN), userId: ana, tokenHash: null });
    // The token reached her mailbox, as a confirmation link would.
    expect(await confirmed(ana)).toBe(true);

    await deleteAccount(db, ana);
    expect(await row("ana@acme.com")).toMatchObject({ id: invitationId, usedAt: at(MIN), userId: null });
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access })).toBeNull();
    expect((await invite("ana@acme.com", at(DAY))).outcome).toBe("signed_up");
    const again = await account("ana@acme.com");
    expect(await hasWorkspaceAllowance(db, again)).toBe(false);
  });
});

describe("inviting", () => {
  test("one row with only the token's hash, and the email queued with the sign-up link", async () => {
    const [result] = await inviteEarlyAccess(
      db,
      { emails: ["  Ana@Acme.com "], resend: true, publicUrl: `${APP}/` },
      T0,
    );
    expect(result).toEqual({ email: "ana@acme.com", outcome: "invited", invitationId: expect.any(String) });
    const access = await tokenOf("ana@acme.com");
    const rows = await db.select().from(invitations);
    expect(rows).toEqual([
      {
        id: result?.invitationId ?? "",
        email: "ana@acme.com",
        locale: "en",
        tokenHash: sha256(access),
        createdAt: T0,
        sentAt: T0,
        sends: 1,
        expiresAt: at(14 * DAY),
        revokedAt: null,
        usedAt: null,
        userId: null,
        workspaceCreatedAt: null,
        workspaceId: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(access);
    expect(await sent()).toEqual([
      {
        key: `early-access:${result?.invitationId}:1`,
        to: ["ana@acme.com"],
        template: {
          kind: "early_access",
          locale: "en",
          email: "ana@acme.com",
          url: `${APP}/signup?email=ana%40acme.com&access=${access}`,
          days: 14,
        },
      },
    ]);
  });

  test("the email's language: the invitation's, else the waiting list's, else the request's, else English", async () => {
    await importWaitlist(db, [{ email: "listed@acme.com", locale: "en" }], at(-DAY));
    await invite("listed@acme.com", T0, { locale: "pt-BR" });
    await invite("asked@acme.com", T0, { locale: "en" });
    await invite("plain@acme.com", T0);
    await invite("plain@acme.com", at(3 * MIN), { locale: "ja" });
    expect((await sent()).map((s) => [s.to[0], s.template.locale])).toEqual([
      ["listed@acme.com", "en"],
      ["asked@acme.com", "en"],
      ["plain@acme.com", "en"],
      ["plain@acme.com", "en"],
    ]);
    expect((await row("listed@acme.com")).locale).toBe("en");
  });

  test("again: the same invitation with a new link (the old one stops), one more send, 14 days more, not revoked", async () => {
    await account("owner@acme.com");
    const first = await invite("ana@acme.com", T0);
    const old = await tokenOf("ana@acme.com");
    await revokeEarlyAccess(db, first.invitationId ?? "", at(MIN));
    expect(await invite("ana@acme.com", at(3 * MIN))).toEqual({
      email: "ana@acme.com",
      outcome: "resent",
      invitationId: first.invitationId,
    });
    const access = await tokenOf("ana@acme.com");
    expect(access).not.toBe(old);
    expect(await db.select().from(invitations)).toHaveLength(1);
    expect(await row("ana@acme.com")).toMatchObject({
      tokenHash: sha256(access),
      sends: 2,
      sentAt: at(3 * MIN),
      expiresAt: at(3 * MIN + 14 * DAY),
      revokedAt: null,
    });
    expect((await sent()).map((s) => s.key)).toEqual([
      `early-access:${first.invitationId}:1`,
      `early-access:${first.invitationId}:2`,
    ]);
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: old, now: at(4 * MIN) })).toBeNull();
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access, now: at(4 * MIN) })).toBe("early_access");
  });

  test("within 2 minutes of the last send nothing goes out (recent); after them it does", async () => {
    const first = await invite("ana@acme.com", T0);
    expect(await invite("ana@acme.com", at(2 * MIN - 1))).toEqual({ ...first, outcome: "recent" });
    const resent = await resendEarlyAccess(db, first.invitationId ?? "", APP, at(MIN));
    expect(resent).toMatchObject({ sent: false, invitation: { sends: 1, state: "sent" } });
    expect(await sent()).toHaveLength(1);
    expect((await invite("ana@acme.com", at(2 * MIN))).outcome).toBe("resent");
    const later = await resendEarlyAccess(db, first.invitationId ?? "", APP, at(5 * MIN));
    expect(later).toMatchObject({ sent: true, invitation: { sends: 3, sentAt: at(5 * MIN) } });
    expect(await sent()).toHaveLength(3);
  });

  test("outcomes in order, in the request's order, each address once", async () => {
    await account("owner@acme.com");
    const used = await invite("used@acme.com");
    await signUpWithLink("used@acme.com");
    const invited = await invite("sent@acme.com");
    await account("member@acme.com");
    const results = await inviteEarlyAccess(
      db,
      {
        emails: [
          "not an email",
          "used@acme.com",
          "member@acme.com",
          "SENT@acme.com",
          "new@acme.com",
          " New@Acme.com",
          `${"a".repeat(250)}@acme.com`,
        ],
        resend: false,
        publicUrl: APP,
      },
      at(10 * MIN),
    );
    expect(results).toEqual([
      { email: "not an email", outcome: "invalid_email" },
      { email: "used@acme.com", outcome: "signed_up", invitationId: used.invitationId },
      { email: "member@acme.com", outcome: "allowed", invitationId: expect.any(String) },
      { email: "sent@acme.com", outcome: "already_invited", invitationId: invited.invitationId },
      { email: "new@acme.com", outcome: "invited", invitationId: expect.any(String) },
      { email: `${"a".repeat(250)}@acme.com`, outcome: "invalid_email" },
    ]);
    expect((await sent()).map((s) => [s.to[0], s.template.kind])).toEqual([
      ["used@acme.com", "early_access"],
      ["sent@acme.com", "early_access"],
      ["member@acme.com", "early_access_allowed"],
      ["new@acme.com", "early_access"],
    ]);
    await expect(
      inviteEarlyAccess(db, { emails: Array(201).fill("x@acme.com"), resend: true, publicUrl: APP }),
    ).rejects.toThrow(ValidationError);
  });

  test("a used invitation is never sent again", async () => {
    await account("owner@acme.com");
    const used = await invite("used@acme.com");
    await signUpWithLink("used@acme.com");
    await expect(resendEarlyAccess(db, used.invitationId ?? "", APP, at(DAY))).rejects.toMatchObject({
      code: "early_access.used",
    });
    await expect(resendEarlyAccess(db, crypto.randomUUID(), APP)).rejects.toThrow(NotFoundError);
    expect(await sent()).toHaveLength(1);
  });

  test("two invitations of one address at once send one email", async () => {
    const answers = await Promise.all([invite("ana@acme.com"), invite("ana@acme.com")]);
    expect(answers.map((a) => a.outcome).sort()).toEqual(["invited", "recent"]);
    expect(await sent()).toHaveLength(1);
    expect(await db.select().from(invitations)).toHaveLength(1);
  });

  test("the waiting list notes the first invitation only", async () => {
    await importWaitlist(db, [{ email: "ana@acme.com" }], at(-DAY));
    await invite("ana@acme.com", T0);
    await invite("ana@acme.com", at(3 * MIN));
    const [entry] = await db.select().from(waitlistEntries);
    expect(entry?.invitedAt).toEqual(T0);
  });
});

describe("revoking and expiry", () => {
  test("revoke kills the link, can be repeated, and takes a signed-up account's allowance", async () => {
    await account("owner@acme.com");
    const ana = await invite("ana@acme.com");
    const revoked = await revokeEarlyAccess(db, ana.invitationId ?? "", at(MIN));
    expect(revoked).toMatchObject({ state: "revoked", revokedAt: at(MIN) });
    expect((await row("ana@acme.com")).tokenHash).toBeNull();
    expect(await revokeEarlyAccess(db, ana.invitationId ?? "", at(2 * MIN))).toEqual(revoked);

    const bia = await invite("bia@acme.com");
    const biaId = await signUpWithLink("bia@acme.com");
    expect(await canCreateWorkspace(db, biaId, CLOUD)).toBe(true);
    await revokeEarlyAccess(db, bia.invitationId ?? "", at(MIN));
    expect(await hasWorkspaceAllowance(db, biaId)).toBe(false);
    expect(await canCreateWorkspace(db, biaId, CLOUD)).toBe(false);
    await expect(revokeEarlyAccess(db, crypto.randomUUID())).rejects.toThrow(NotFoundError);
  });

  test("expiry: 14 days after the latest send, for sign-up only; an account made in time keeps its allowance", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com", T0);
    const list = async (now: Date) => (await listEarlyAccess(db, { limit: 10 }, now)).invitations[0]?.state;
    expect(await list(at(14 * DAY - 1))).toBe("sent");
    expect(await list(at(14 * DAY))).toBe("expired");
    const ana = await signUpWithLink("ana@acme.com", at(13 * DAY));
    expect(await list(at(30 * DAY))).toBe("signed_up");
    expect(await canCreateWorkspace(db, ana, CLOUD)).toBe(true);
    await createOrganization(db, ana, { name: "Ana" }, { needsAllowance: true });

    // An account let in another way (open mode, a workspace's invitation) with an expired link takes nothing from it.
    await invite("bia@acme.com", T0);
    const bia = await account("bia@acme.com");
    const late = { access: await tokenOf("bia@acme.com"), email: "bia@acme.com", userId: bia };
    expect(await useEarlyAccess(db, late, at(14 * DAY))).toBe(false);
    expect(await row("bia@acme.com")).toMatchObject({ usedAt: null, userId: null });
    expect(await canCreateWorkspace(db, bia, CLOUD)).toBe(false);
  });
});

describe("workspaces while sign-up is by invitation (every workspace with a paid computer)", () => {
  test("a member early access didn't allow is refused, leaving nothing, until its address is invited and confirmed", async () => {
    const owner = await account("owner@acme.com");
    const acme = await createOrganization(db, owner, { name: "Acme" });
    const bia = await member("bia@acme.com", acme.organization.id);
    expect(await needsWorkspaceAllowance(db, bia, CLOUD)).toBe(true);
    const refused = async () => {
      expect(await canCreateWorkspace(db, bia, CLOUD)).toBe(false);
      await expect(createOrganization(db, bia, { name: "Bia" }, { needsAllowance: true })).rejects.toMatchObject({
        code: "org.create_invite_only",
      });
      expect(await db.select().from(schema.organizations)).toHaveLength(1);
    };
    await refused();
    // Allowed, but anyone can sign up with an address that isn't theirs: it counts once the address is confirmed.
    expect((await invite("bia@acme.com")).outcome).toBe("allowed");
    expect(await hasWorkspaceAllowance(db, bia)).toBe(false);
    await refused();
    await confirm(bia);
    expect(await canCreateWorkspace(db, bia, CLOUD)).toBe(true);
    await createOrganization(db, bia, { name: "Bia" }, { needsAllowance: true });
  });

  test("an allowed account makes as many as it likes, and its first is recorded on its invitation", async () => {
    await account("owner@acme.com");
    const { invitationId } = await invite("ana@acme.com");
    const ana = await signUpWithLink("ana@acme.com");
    const made: string[] = [];
    for (const name of ["One", "Two", "Three"]) {
      made.push((await createOrganization(db, ana, { name }, { needsAllowance: true })).organization.id);
      expect(await canCreateWorkspace(db, ana, CLOUD)).toBe(true);
    }
    expect(await row("ana@acme.com")).toMatchObject({ id: invitationId, workspaceId: made[0] });
    expect((await listEarlyAccess(db, { limit: 10 })).invitations[0]?.state).toBe("workspace_created");
  });

  test("two at once both go ahead, and one of them is recorded, once", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const ana = await signUpWithLink("ana@acme.com");
    const made = await Promise.all([
      createOrganization(db, ana, { name: "One" }, { needsAllowance: true }),
      createOrganization(db, ana, { name: "Two" }, { needsAllowance: true }),
    ]);
    const recorded = await row("ana@acme.com");
    expect(made.map((m) => m.organization.id)).toContain(recorded.workspaceId ?? "");
    expect(recorded.workspaceCreatedAt).toBeInstanceOf(Date);
    await createOrganization(db, ana, { name: "Three" }, { needsAllowance: true });
    expect(await row("ana@acme.com")).toEqual(recorded);
    expect(await db.select().from(schema.organizations)).toHaveLength(3);
  });

  test("revoking stops further workspaces and keeps the ones made", async () => {
    await account("owner@acme.com");
    const { invitationId } = await invite("ana@acme.com");
    const ana = await signUpWithLink("ana@acme.com");
    const { organization } = await createOrganization(db, ana, { name: "Ana" }, { needsAllowance: true });
    expect(await revokeEarlyAccess(db, invitationId ?? "", at(MIN))).toMatchObject({
      state: "revoked",
      revokedAt: at(MIN),
      workspaceId: organization.id,
    });
    expect(await canCreateWorkspace(db, ana, CLOUD)).toBe(false);
    await expect(createOrganization(db, ana, { name: "More" }, { needsAllowance: true })).rejects.toMatchObject({
      code: "org.create_invite_only",
    });
    expect(await db.select({ id: schema.organizations.id }).from(schema.organizations)).toEqual([
      { id: organization.id },
    ]);
    const members = schema.organizationMembers;
    expect(
      await db
        .select({ userId: members.userId, role: members.role })
        .from(members)
        .where(eq(members.orgId, organization.id)),
    ).toEqual([{ userId: ana, role: "owner" }]);
  });

  test("off for the installation's owner, without paid computers, with ALLOW_SIGNUP and in open mode, revoked or not", async () => {
    const owner = await account("owner@acme.com");
    const acme = await createOrganization(db, owner, { name: "Acme" });
    const bia = await member("bia@acme.com", acme.organization.id);
    const { invitationId } = await invite("cleo@acme.com");
    const cleo = await signUpWithLink("cleo@acme.com");
    await createOrganization(db, cleo, { name: "Cleo" }, { needsAllowance: true });
    await revokeEarlyAccess(db, invitationId ?? "");
    expect(await needsWorkspaceAllowance(db, owner, CLOUD)).toBe(false);
    expect(await canCreateWorkspace(db, owner, CLOUD)).toBe(true);
    expect(await canCreateWorkspace(db, cleo, CLOUD)).toBe(false);
    for (const policy of [
      { paidMachines: false, allowSignup: false },
      { paidMachines: true, allowSignup: true },
    ]) {
      for (const who of [bia, cleo]) expect(await canCreateWorkspace(db, who, policy)).toBe(true);
    }
    await setSignupMode(db, "open");
    for (const who of [bia, cleo]) expect(await canCreateWorkspace(db, who, CLOUD)).toBe(true);
  });

  test("off, the first workspace is still recorded on the invitation", async () => {
    await account("owner@acme.com");
    await invite("ana@acme.com");
    const ana = await signUpWithLink("ana@acme.com");
    const first = await createOrganization(db, ana, { name: "One" });
    await createOrganization(db, ana, { name: "Two" });
    expect((await row("ana@acme.com")).workspaceId).toBe(first.organization.id);
  });
});

describe("allowing an account that exists", () => {
  test("inviting its address: no link, the invitation bound and used at once, one email in the account's language", async () => {
    const owner = await account("owner@acme.com");
    const acme = await createOrganization(db, owner, { name: "Acme" });
    const bia = await member("bia@acme.com", acme.organization.id, "en");
    await confirm(bia);
    const result = await invite(" Bia@Acme.com", T0, { locale: "pt-BR" });
    expect(result).toEqual({ email: "bia@acme.com", outcome: "allowed", invitationId: expect.any(String) });
    expect(await row("bia@acme.com")).toMatchObject({
      id: result.invitationId,
      locale: "en",
      tokenHash: null,
      sends: 1,
      usedAt: T0,
      userId: bia,
      revokedAt: null,
      workspaceCreatedAt: null,
    });
    expect(await sent()).toEqual([
      {
        key: `early-access:${result.invitationId}:1`,
        to: ["bia@acme.com"],
        template: { kind: "early_access_allowed", locale: "en", email: "bia@acme.com", url: `${APP}/onboarding` },
      },
    ]);
    expect((await listEarlyAccess(db, { limit: 10 })).invitations[0]?.state).toBe("signed_up");
    expect(await canCreateWorkspace(db, bia, CLOUD)).toBe(true);
    await createOrganization(db, bia, { name: "Bia" }, { needsAllowance: true });
  });

  test("the next N from the waiting list: an address with an account is among them, and inviting it allows it", async () => {
    const owner = await account("owner@acme.com");
    const acme = await createOrganization(db, owner, { name: "Acme" });
    await importWaitlist(db, [{ email: "ana@acme.com" }, { email: "bia@acme.com", locale: "en" }], at(-DAY));
    const bia = await member("bia@acme.com", acme.organization.id);
    await confirm(bia);
    expect((await waitlistCounts(db)).waiting).toBe(2);
    const next = await waitlistNext(db, 10);
    expect(next.map((e) => e.email)).toEqual(["ana@acme.com", "bia@acme.com"]);
    const emails = next.map((e) => e.email);
    const results = await inviteEarlyAccess(db, { emails, resend: false, publicUrl: APP }, T0);
    expect(results.map((r) => r.outcome)).toEqual(["invited", "allowed"]);
    // Bia's account has no language of its own: her waiting-list entry's.
    expect((await sent()).map((s) => [s.to[0], s.template.kind, s.template.locale])).toEqual([
      ["ana@acme.com", "early_access", "en"],
      ["bia@acme.com", "early_access_allowed", "en"],
    ]);
    expect(await canCreateWorkspace(db, bia, CLOUD)).toBe(true);
    expect(await waitlistCounts(db)).toMatchObject({ waiting: 0, invited: 2, signedUp: 1 });
    expect((await db.select().from(waitlistEntries)).map((e) => e.invitedAt)).toEqual([T0, T0]);
    expect(await waitlistNext(db, 10)).toEqual([]);
  });

  test("resending an invitation whose address has an account by now allows it, with sent false", async () => {
    await account("owner@acme.com");
    const { invitationId } = await invite("ana@acme.com", T0);
    const link = await tokenOf("ana@acme.com");
    // Ana got in another way (a workspace's invitation) without the link.
    const ana = await account("ana@acme.com", "en");
    expect(await resendEarlyAccess(db, invitationId ?? "", APP, at(MIN))).toMatchObject({
      sent: false,
      invitation: { id: invitationId, state: "signed_up", userId: ana, usedAt: at(MIN), sends: 2 },
    });
    expect((await sent()).map((s) => [s.template.kind, s.template.locale])).toEqual([
      ["early_access", "en"],
      ["early_access_allowed", "en"],
    ]);
    expect(await signupAdmission(db, "ana@acme.com", CLOSED, { access: link, now: at(2 * MIN) })).toBeNull();
    expect(await canCreateWorkspace(db, ana, CLOUD)).toBe(false);
    await confirm(ana);
    expect(await canCreateWorkspace(db, ana, CLOUD)).toBe(true);
  });

  test("a blocked account's address: left out of the next N, and allowed when named, with no email", async () => {
    const owner = await account("owner@acme.com");
    const acme = await createOrganization(db, owner, { name: "Acme" });
    await importWaitlist(db, [{ email: "bia@acme.com" }, { email: "ana@acme.com" }], at(-DAY));
    const bia = await member("bia@acme.com", acme.organization.id);
    await db
      .update(schema.users)
      .set({ blockedAt: at(-MIN) })
      .where(eq(schema.users.id, bia));
    expect((await waitlistNext(db, 10)).map((e) => e.email)).toEqual(["ana@acme.com"]);
    expect((await waitlistCounts(db)).waiting).toBe(2);
    // It can't sign in: nothing tells it to make a workspace.
    expect((await invite("bia@acme.com")).outcome).toBe("allowed");
    expect(await row("bia@acme.com")).toMatchObject({ userId: bia, usedAt: T0 });
    expect(await sent()).toEqual([]);
  });

  test("allowing twice sends nothing, and two at once mail once", async () => {
    const owner = await account("owner@acme.com");
    const acme = await createOrganization(db, owner, { name: "Acme" });
    await member("bia@acme.com", acme.organization.id);
    await member("cleo@acme.com", acme.organization.id);
    const first = await invite("bia@acme.com");
    expect(first.outcome).toBe("allowed");
    expect(await invite("bia@acme.com", at(DAY))).toEqual({ ...first, outcome: "signed_up" });
    await expect(resendEarlyAccess(db, first.invitationId ?? "", APP, at(DAY))).rejects.toMatchObject({
      code: "early_access.used",
    });
    const both = await Promise.all([invite("cleo@acme.com"), invite("cleo@acme.com")]);
    expect(both.map((a) => a.outcome).sort()).toEqual(["allowed", "signed_up"]);
    expect((await sent()).map((s) => s.to[0])).toEqual(["bia@acme.com", "cleo@acme.com"]);
  });
});

describe("the waiting list", () => {
  test("import: confirmed entries in the list's order, deduplicated, invalid ones by index; a repeat changes nothing", async () => {
    await db.insert(waitlistEntries).values([
      { email: "landing@acme.com", locale: "en", source: "landing", createdAt: at(-DAY) },
      { email: "done@acme.com", source: "landing", createdAt: at(-DAY), confirmedAt: at(-DAY) },
    ]);
    const input = [
      { email: "First@Acme.com" },
      { email: "nope" },
      { email: "second@acme.com", locale: "en" as const },
      { email: " first@acme.com " },
      { email: "landing@acme.com" },
      { email: "done@acme.com" },
      { email: "past@acme.com", joinedAt: new Date("2025-06-01T00:00:00.000Z") },
      { email: "future@acme.com", joinedAt: at(DAY) },
      { email: `${"a".repeat(250)}@acme.com` },
    ];
    expect(await importWaitlist(db, input, T0)).toEqual({ added: 4, confirmed: 1, unchanged: 2, invalid: [1, 8] });
    const rows = new Map((await db.select().from(waitlistEntries)).map((r) => [r.email, r]));
    expect(rows.get("first@acme.com")).toMatchObject({ source: "import", locale: "en", createdAt: T0 });
    expect(rows.get("second@acme.com")).toMatchObject({ source: "import", locale: "en", createdAt: at(2) });
    expect(rows.get("past@acme.com")?.createdAt).toEqual(new Date("2025-06-01T00:00:00.000Z"));
    expect(rows.get("future@acme.com")?.createdAt).toEqual(T0);
    for (const r of rows.values()) expect(r.confirmedAt).toBeInstanceOf(Date);
    expect(rows.get("landing@acme.com")).toMatchObject({
      source: "landing",
      locale: "en",
      createdAt: at(-DAY),
      confirmedAt: T0,
    });
    expect(await importWaitlist(db, input, at(MIN))).toEqual({ added: 0, confirmed: 0, unchanged: 7, invalid: [1, 8] });
    await expect(
      importWaitlist(
        db,
        Array.from({ length: 5001 }, (_, i) => ({ email: `p${i}@acme.com` })),
      ),
    ).rejects.toThrow(ValidationError);
  });

  test("imported entries never reach the email provider's contacts, at import or at boot", async () => {
    await db.insert(waitlistEntries).values({ email: "landing@acme.com", source: "landing", confirmedAt: T0 });
    await importWaitlist(db, [{ email: "imported@acme.com" }]);
    const contacts = () =>
      db.select({ payload: outbox.payload }).from(outbox).where(eq(outbox.kind, "waitlist.contact"));
    expect(await contacts()).toEqual([]);
    expect(await enqueueWaitlistContacts(db)).toBe(1);
    const [landing] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.email, "landing@acme.com"));
    expect(await contacts()).toEqual([{ payload: { entryId: landing?.id } }]);
    const [imported] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.email, "imported@acme.com"));
    const sender = createFakeEmailSender();
    await saveWaitlistContact(db, sender, imported?.id ?? "");
    expect(sender.contacts).toEqual([]);
  });

  test("next: confirmed entries still waiting (with an account too), oldest first, past invitations (revoked too) and refused addresses", async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    await db.insert(waitlistEntries).values([
      { email: "old@acme.com", locale: "en", createdAt: day(1), confirmedAt: day(1) },
      { email: "unconfirmed@acme.com", createdAt: day(2) },
      { email: "two..dots@acme.com", createdAt: day(3), confirmedAt: day(3) },
      { email: "invited@acme.com", createdAt: day(4), confirmedAt: day(4) },
      { email: "member@acme.com", createdAt: day(5), confirmedAt: day(5) },
      { email: "new@acme.com", createdAt: day(6), confirmedAt: day(6) },
      { email: "newer@acme.com", createdAt: day(7), confirmedAt: day(7) },
    ]);
    const { invitationId } = await invite("invited@acme.com");
    await revokeEarlyAccess(db, invitationId ?? "");
    await account("member@acme.com");
    expect(earlyAccessEmail("two..dots@acme.com")).toBeNull();
    expect(await waitlistNext(db, 10)).toEqual([
      { email: "old@acme.com", locale: "en", joinedAt: day(1) },
      { email: "member@acme.com", locale: "en", joinedAt: day(5) },
      { email: "new@acme.com", locale: "en", joinedAt: day(6) },
      { email: "newer@acme.com", locale: "en", joinedAt: day(7) },
    ]);
    // A page that ends with a refused address reads on to fill the limit.
    expect((await waitlistNext(db, 2)).map((e) => e.email)).toEqual(["old@acme.com", "member@acme.com"]);
    expect((await waitlistNext(db, 1)).map((e) => e.email)).toEqual(["old@acme.com"]);
    expect(await waitlistCounts(db)).toEqual({
      unconfirmed: 1,
      confirmed: 6,
      waiting: 5,
      invited: 1,
      signedUp: 0,
      workspaceCreated: 0,
    });
  });

  test("the counts follow each invitation to its account and workspace", async () => {
    await account("owner@acme.com");
    await importWaitlist(
      db,
      ["a", "b", "c", "d"].map((n) => ({ email: `${n}@acme.com` })),
    );
    await db.insert(waitlistEntries).values({ email: "e@acme.com" });
    await inviteEarlyAccess(db, { emails: ["a@acme.com", "b@acme.com", "c@acme.com"], resend: true, publicUrl: APP });
    await signUpWithLink("b@acme.com");
    const c = await signUpWithLink("c@acme.com");
    await createOrganization(db, c, { name: "C" }, { needsAllowance: true });
    expect(await waitlistCounts(db)).toEqual({
      unconfirmed: 1,
      confirmed: 4,
      waiting: 1,
      invited: 3,
      signedUp: 2,
      workspaceCreated: 1,
    });
  });
});

describe("the list", () => {
  test("states by precedence, newest first in stable pages, q and state filters, counts whatever the filters", async () => {
    await account("owner@acme.com");
    // Several at the same instant: paging must keep them all.
    for (const email of ["s1@acme.com", "s2@acme.com", "s3@acme.com"]) await invite(email, T0);
    await invite("old@acme.com", at(-20 * DAY));
    const used = await invite("used_one@acme.com", at(MIN));
    await signUpWithLink("used_one@acme.com", at(2 * MIN));
    await revokeEarlyAccess(db, used.invitationId ?? "", at(3 * MIN));
    await invite("made@acme.com", at(-30 * DAY));
    const made = await signUpWithLink("made@acme.com", at(-29 * DAY));
    await createOrganization(db, made, { name: "Made" }, { needsAllowance: true });
    await invite("signed@acme.com", at(2 * MIN));
    await signUpWithLink("signed@acme.com", at(3 * MIN));

    const now = at(4 * MIN);
    const all: { email: string; state: string; createdAt: Date; id: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await listEarlyAccess(db, { limit: 2, cursor }, now);
      all.push(...page.invitations);
      cursor = page.next ?? undefined;
    } while (cursor);
    expect(all.map((i) => i.email).slice(0, 2)).toEqual(["signed@acme.com", "used_one@acme.com"]);
    expect(
      all
        .map((i) => i.email)
        .slice(2, 5)
        .sort(),
    ).toEqual(["s1@acme.com", "s2@acme.com", "s3@acme.com"]);
    expect(all.map((i) => i.email).slice(5)).toEqual(["old@acme.com", "made@acme.com"]);
    expect(Object.fromEntries(all.map((i) => [i.email, i.state]))).toEqual({
      "signed@acme.com": "signed_up",
      "used_one@acme.com": "revoked",
      "s1@acme.com": "sent",
      "s2@acme.com": "sent",
      "s3@acme.com": "sent",
      "old@acme.com": "expired",
      "made@acme.com": "workspace_created",
    });
    const counts = { sent: 3, expired: 1, signedUp: 1, workspaceCreated: 1, revoked: 1 };
    const only = async (query: { state?: "sent" | "expired"; q?: string }) => {
      const page = await listEarlyAccess(db, { limit: 50, ...query }, now);
      expect(page.counts).toEqual(counts);
      return page.invitations.map((i) => i.email).sort();
    };
    expect(await only({ state: "expired" })).toEqual(["old@acme.com"]);
    expect(await only({ q: "S2@" })).toEqual(["s2@acme.com"]);
    // Literal: an underscore is no wildcard.
    expect(await only({ q: "_" })).toEqual(["used_one@acme.com"]);
    expect(await only({ q: "s", state: "sent" })).toEqual(["s1@acme.com", "s2@acme.com", "s3@acme.com"]);
    await expect(listEarlyAccess(db, { limit: 2, cursor: "nope" })).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});

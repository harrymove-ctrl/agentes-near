import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import {
  acceptInvitation,
  ConflictError,
  can,
  changeMemberRole,
  createInvitation,
  createOrganization,
  createRole,
  ForbiddenError,
  getMembership,
  isSignupAllowed,
  listMachineRequests,
  listMemberships,
  myAccount,
  type Permission,
  previewInvitation,
  removeMember,
  requestLocale,
  requirePermission,
  setBillingHold,
  setMemberRoles,
  setMyLocale,
  setOrgStanding,
  sha256,
  unfinishedWorkspaces,
  updateOrganization,
  updateOrgSettings,
} from "../src";
import { addMember, addUser, adminRoleId, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

describe("permissions", () => {
  test("what an owner, an admin (the Admin role) and a member may do", async () => {
    const all: Permission[] = [
      "read",
      "post",
      "create_channels",
      "configure",
      "manage_agents",
      "manage_credentials",
      // Using other people's plans (ADR 0059 §3): owners and admins, never "Todos".
      "use_others_plans",
      // Mentioning everyone (`@todos`): owners and admins, never "Todos".
      "mention_everyone",
      "view_usage",
      "manage_members",
      "manage_billing",
      "manage_owners",
    ];
    const admin = await addMember(f.db, f.org.id, "admin");
    const member = await addMember(f.db, f.org.id, "member");
    const allowed = async (userId: string) => {
      const membership = await getMembership(f.db, userId, f.org.id);
      return all.filter((p) => can(membership, p));
    };
    expect(await allowed(f.owner.id)).toEqual(all);
    expect(await allowed(admin.id)).toEqual(all.filter((p) => p !== "manage_owners"));
    expect(await allowed(member.id)).toEqual(["read", "post", "create_channels"]);
  });

  test("requirePermission rejects non-members and missing permissions", async () => {
    const stranger = await addUser(f.db, "eve");
    await expect(requirePermission(f.db, stranger.id, f.org.id, "read")).rejects.toThrow(/not a member/);
    const member = await addMember(f.db, f.org.id, "member");
    await expect(updateOrganization(f.db, member.id, f.org.id, { context: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await requirePermission(f.db, member.id, f.org.id, "post")).role).toBe("member");
  });

  test("the creator is owner and lands in #general", async () => {
    expect(await listMemberships(f.db, f.owner.id)).toEqual([
      {
        orgId: f.org.id,
        orgName: "Acme",
        role: "owner",
        permissions: expect.any(Set),
        rank: null,
        roleIds: [],
        orgLogo: null,
        standing: { state: "active", reason: null, notice: "shown", deletionDueAt: null },
        start: { page: "home", channelId: null },
        showActivity: false,
        agentStyle: null,
        chatPrefs: {},
        mode: "team",
        orgCreatedAt: expect.any(Date),
      },
    ]);
    const members = await f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, f.general.id));
    expect(members.map((m) => m.userId)).toContain(f.owner.id);
  });
});

describe("onboarding", () => {
  test("workspaces from before it was kept count as set up, as do ones made outside the app", async () => {
    // The table as it was before the migration, with a workspace in it.
    await f.db.execute(sql`alter table organizations drop column onboarding_step, drop column onboarded_at`);
    await f.db.execute(sql`insert into organizations (name) values ('Old')`);
    await runMigration(f.db, "onboarding");
    const [old] = await f.db.select().from(schema.organizations).where(eq(schema.organizations.name, "Old"));
    expect(old?.onboardingStep).toBe("done");
    expect(old?.onboardedAt).toBeInstanceOf(Date);
    expect(await unfinishedWorkspaces(f.db, f.owner.id)).toEqual([]);
  });
});

describe("ownership", () => {
  test("the last owner can't be demoted or leave", async () => {
    await expect(changeMemberRole(f.db, f.owner.id, f.org.id, f.owner.id, "member")).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(removeMember(f.db, f.owner.id, f.org.id, f.owner.id)).rejects.toBeInstanceOf(ConflictError);
  });

  test("admins can't grant ownership or remove owners; they give roles below their own", async () => {
    const admin = await addMember(f.db, f.org.id, "admin");
    const member = await addMember(f.db, f.org.id, "member");
    await expect(changeMemberRole(f.db, admin.id, f.org.id, member.id, "owner")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMember(f.db, admin.id, f.org.id, f.owner.id)).rejects.toBeInstanceOf(ForbiddenError);
    // Their own Admin role is not below them; a role under it is.
    const adminRole = await adminRoleId(f.db, f.org.id);
    await expect(setMemberRoles(f.db, admin.id, f.org.id, member.id, [adminRole])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    expect(await setMemberRoles(f.db, admin.id, f.org.id, member.id, [devs.id])).toEqual([devs.id]);
  });

  test("an owner makes an owner and takes it back", async () => {
    const member = await addMember(f.db, f.org.id, "member");
    await changeMemberRole(f.db, f.owner.id, f.org.id, member.id, "owner");
    expect(can(await getMembership(f.db, member.id, f.org.id), "manage_owners")).toBe(true);
    await changeMemberRole(f.db, f.owner.id, f.org.id, member.id, "member");
    expect(can(await getMembership(f.db, member.id, f.org.id), "manage_owners")).toBe(false);
  });
});

describe("invitations", () => {
  test("only the token hash is stored; accepting needs the invited email and joins #general", async () => {
    const { token, invitation } = await createInvitation(f.db, f.owner.id, f.org.id, {
      email: "Bia@Example.com",
      role: "member",
    });
    const [row] = await f.db
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.id, invitation.id));
    expect(row?.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const preview = await previewInvitation(f.db, token);
    expect(preview).toMatchObject({ orgName: "Acme", email: "bia@example.com", role: "member", kind: "email" });
    // Who invited and the org's first agents (name and look), for the phone's invitation screen.
    expect(typeof preview?.invitedBy).toBe("string");
    expect(preview?.agents.length).toBeLessThanOrEqual(4);
    for (const a of preview?.agents ?? []) expect(Object.keys(a).sort()).toEqual(["appearance", "id", "name"]);

    const wrong = await addUser(f.db, "carl");
    await expect(acceptInvitation(f.db, wrong, token)).rejects.toBeInstanceOf(ForbiddenError);
    const bia = { id: (await addUser(f.db, "bia")).id, email: "bia@example.com" };
    expect(await acceptInvitation(f.db, bia, token)).toMatchObject({ orgId: f.org.id });
    await expect(acceptInvitation(f.db, bia, token)).rejects.toBeInstanceOf(ConflictError);
    const general = await f.db.select().from(schema.channelMembers).where(eq(schema.channelMembers.userId, bia.id));
    expect(general.map((g) => g.channelId)).toEqual([f.general.id]);
  });

  test("an invitation says who the workspace is for, so a personal one's page never names it (ADR 0159)", async () => {
    const { token } = await createInvitation(f.db, f.owner.id, f.org.id, { email: "bia@example.com", role: "member" });
    expect(await previewInvitation(f.db, token)).toMatchObject({ orgName: "Acme", mode: "team" });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { mode: "personal" });
    expect(await previewInvitation(f.db, token)).toMatchObject({ orgName: "Acme", mode: "personal" });
  });

  test("an invitation names the first four agents, oldest first, and counts the others", async () => {
    const { token } = await createInvitation(f.db, f.owner.id, f.org.id, { email: "bia@example.com", role: "member" });
    const names = async () => {
      const preview = await previewInvitation(f.db, token);
      return [preview?.agents.map((a) => a.name), preview && "moreAgents" in preview ? preview.moreAgents : undefined];
    };
    const start = Date.now();
    const hire = (name: string, i: number) =>
      f.db.insert(schema.agents).values({
        orgId: f.org.id,
        name,
        handle: name.toLowerCase(),
        model: "claude-sonnet-5-5",
        createdAt: new Date(start + (i + 1) * 1000),
      });
    for (const [i, name] of ["Ada", "Lia", "Atlas"].entries()) await hire(name, i);
    // Four: every one by name, nothing more to count.
    expect(await names()).toEqual([["Dev", "Ada", "Lia", "Atlas"], undefined]);
    for (const [i, name] of ["Theo", "Bia"].entries()) await hire(name, i + 3);
    expect(await names()).toEqual([["Dev", "Ada", "Lia", "Atlas"], 2]);
  });

  test("expired invitations don't work", async () => {
    const past = new Date(Date.now() - 30 * 86_400_000);
    const { token } = await createInvitation(
      f.db,
      f.owner.id,
      f.org.id,
      { email: "old@example.com", role: "member" },
      past,
    );
    expect(await previewInvitation(f.db, token)).toBeNull();
  });

  test("members can't invite; admins can't invite owners", async () => {
    const member = await addMember(f.db, f.org.id, "member");
    await expect(
      createInvitation(f.db, member.id, f.org.id, { email: "x@example.com", role: "member" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await addMember(f.db, f.org.id, "admin");
    await expect(
      createInvitation(f.db, admin.id, f.org.id, { email: "x@example.com", role: "owner" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("self-host sign-up policy", () => {
  const closed = { allowSignup: false, ownerByLink: false };
  test("closed after the first account unless ALLOW_SIGNUP or a pending invitation", async () => {
    expect(await isSignupAllowed(f.db, "new@example.com", closed)).toBe(false);
    expect(await isSignupAllowed(f.db, "new@example.com", { ...closed, allowSignup: true })).toBe(true);
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "new@example.com", role: "member" });
    expect(await isSignupAllowed(f.db, "NEW@example.com", closed)).toBe(true);
    // An owner link only decides the first account.
    expect(await isSignupAllowed(f.db, "NEW@example.com", { ...closed, ownerByLink: true })).toBe(true);
  });

  test("the very first account may always sign up, unless it waits for its owner's link", async () => {
    await f.db.delete(schema.users);
    expect(await isSignupAllowed(f.db, "first@example.com", closed)).toBe(true);
    expect(await isSignupAllowed(f.db, "first@example.com", { ...closed, ownerByLink: true })).toBe(false);
    expect(await isSignupAllowed(f.db, "first@example.com", { allowSignup: true, ownerByLink: true })).toBe(false);
  });
});

describe("creating a workspace while one is held", () => {
  const refusal = (userId: string) =>
    createOrganization(f.db, userId, { name: "Next" }).then(
      () => null,
      (e: ForbiddenError) => ({ code: e.code, params: e.params }),
    );

  test("billing holds refuse nobody but the owner of a workspace waiting for its first plan; other holds still do", async () => {
    const admin = await addMember(f.db, f.org.id, "admin");
    const member = await addMember(f.db, f.org.id, "member");
    const { organization: second } = await createOrganization(f.db, f.owner.id, { name: "Second" });
    for (const hold of ["unpaid", "ended", "payment"] as const) {
      await setBillingHold({ db: f.db }, f.org.id, hold);
      expect(await refusal(admin.id)).toBeNull();
      expect(await refusal(member.id)).toBeNull();
    }
    // Their own: the oldest one waiting.
    await setBillingHold({ db: f.db }, second.id, "payment");
    expect(await refusal(f.owner.id)).toEqual({ code: "org.create_unpaid", params: { orgId: f.org.id } });

    // A hold set through the standing (shown or silent) or a suspension refuses everyone in it, as before.
    await setOrgStanding({ db: f.db }, f.org.id, { state: "hold", reason: "review", notice: "shown" });
    for (const who of [f.owner.id, admin.id, member.id])
      expect(await refusal(who)).toEqual({ code: "org.create_refused", params: undefined });
    await setOrgStanding({ db: f.db }, f.org.id, { state: "hold", reason: "payment", notice: "silent" });
    expect(await refusal(member.id)).toEqual({ code: "org.create_refused", params: undefined });
  });

  test("holdForPayment: the workspace starts on that hold, with no audit row, notification or computer request", async () => {
    const ana = await addUser(f.db, "ana");
    const { organization } = await createOrganization(f.db, ana.id, { name: "Ana's" }, { holdForPayment: true });
    expect(organization).toMatchObject({
      standing: "hold",
      standingReason: "payment",
      standingNotice: "shown",
      standingNote: null,
    });
    expect(organization.standingChangedAt).toBeInstanceOf(Date);
    expect(await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, organization.id))).toEqual([]);
    expect(
      await f.db.select().from(schema.notifications).where(eq(schema.notifications.orgId, organization.id)),
    ).toEqual([]);
    const requests = await listMachineRequests(f.db, "external", { limit: 50 });
    expect(requests.requests.map((r) => r.orgId)).toEqual([f.org.id]);

    expect(await refusal(ana.id)).toEqual({ code: "org.create_unpaid", params: { orgId: organization.id } });
    // Paid (the hold lifted), the next one may start.
    await setBillingHold({ db: f.db }, organization.id, null);
    expect((await createOrganization(f.db, ana.id, { name: "Ana 2" })).organization.standing).toBe("active");
  });

  test("two creates at once start one workspace waiting for its plan, and refuse the other", async () => {
    const ana = await addUser(f.db, "ana");
    const create = (name: string) =>
      createOrganization(f.db, ana.id, { name }, { holdForPayment: true }).then(
        ({ organization }) => organization.id,
        (e: ForbiddenError) => e.code,
      );
    const results = await Promise.all([create("One"), create("Two")]);
    expect(results.filter((r) => r === "org.create_unpaid")).toHaveLength(1);
    const owned = await f.db
      .select({ orgId: schema.organizationMembers.orgId })
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.userId, ana.id));
    expect(owned).toHaveLength(1);
  });
});

describe("the person's language (ADR 0122)", () => {
  test("any language of the app, picked or detected; anything else refused", async () => {
    expect(await myAccount(f.db, f.owner.id)).toMatchObject({ locale: "pt-BR", localeAuto: true });
    await setMyLocale(f.db, f.owner.id, "fr");
    expect(await myAccount(f.db, f.owner.id)).toMatchObject({ locale: "fr", localeAuto: false });
    await setMyLocale(f.db, f.owner.id, "ja", true);
    expect(await myAccount(f.db, f.owner.id)).toMatchObject({ locale: "ja", localeAuto: true });
    await expect(setMyLocale(f.db, f.owner.id, "xx" as "en")).rejects.toThrow();
  });

  test("Accept-Language: the most preferred language people can pick", () => {
    expect(requestLocale("pt-PT,en;q=0.5")).toBe("pt-BR");
    expect(requestLocale("en-GB,pt;q=0.9")).toBe("en");
    expect(requestLocale("xx,en;q=0.5")).toBe("en");
    expect(requestLocale("de;q=0,xx")).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  AREA_PERMISSIONS,
  acceptInvitation,
  can,
  createAgent,
  createInvitation,
  createRole,
  deleteRole,
  ForbiddenError,
  getMembership,
  listRoles,
  openDm,
  reorderRoles,
  requirePermission,
  setMemberRoles,
  updateRole,
} from "../src";
import { addMember, adminRoleId, type Fixture, makeAdmin, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const everyoneOf = async () => {
  const { roles } = await listRoles(f.db, f.owner.id, f.org.id);
  const base = roles.find((r) => r.kind === "everyone");
  if (!base) throw new Error("no base role");
  return base;
};

describe("resolving permissions", () => {
  test("a new workspace has its base role and an Admin; the owner may everything", async () => {
    const { roles } = await listRoles(f.db, f.owner.id, f.org.id);
    expect(roles.map((r) => [r.kind, r.name])).toEqual([
      ["custom", "Admin"],
      ["everyone", "everyone"],
    ]);
    // The Admin is listed apart in the members column; the base role never is.
    expect(roles.map((r) => r.hoist)).toEqual([true, false]);
    const owner = await getMembership(f.db, f.owner.id, f.org.id);
    for (const k of [...AREA_PERMISSIONS, "administrator", "manage_owners", "read"] as const)
      expect(can(owner, k)).toBe(true);
  });

  test("a member may what the base role gives, and an admin everything but ownership", async () => {
    const member = await getMembership(f.db, (await addMember(f.db, f.org.id, "member")).id, f.org.id);
    expect(can(member, "post")).toBe(true);
    expect(can(member, "talk_to_agents")).toBe(true);
    expect(can(member, "manage_agents")).toBe(false);
    expect(can(member, "manage_owners")).toBe(false);
    const admin = await getMembership(f.db, (await addMember(f.db, f.org.id, "admin")).id, f.org.id);
    expect(can(admin, "manage_roles")).toBe(true);
    expect(can(admin, "approve_actions")).toBe(true);
    expect(can(admin, "manage_owners")).toBe(false);
    expect(admin?.rank).toBe(0);
  });

  test("roles add up, and changing the base role changes every member", async () => {
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Finance", permissions: ["view_usage"] });
    const support = await createRole(f.db, f.owner.id, f.org.id, { name: "Support", permissions: ["manage_routines"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [finance.id, support.id]);
    const both = await getMembership(f.db, ana.id, f.org.id);
    expect(can(both, "view_usage") && can(both, "manage_routines")).toBe(true);
    expect(both?.rank).toBe(1);
    const base = await everyoneOf();
    await updateRole(f.db, f.owner.id, f.org.id, base.id, {
      permissions: base.permissions.filter((k) => k !== "talk_to_agents"),
    });
    expect(can(await getMembership(f.db, ana.id, f.org.id), "talk_to_agents")).toBe(false);
  });

  test("the base role never holds administrator", async () => {
    const base = await everyoneOf();
    await updateRole(f.db, f.owner.id, f.org.id, base.id, { permissions: [...base.permissions, "administrator"] });
    expect((await everyoneOf()).permissions).not.toContain("administrator");
  });
});

describe("hierarchy", () => {
  test("someone who manages roles only changes the ones below their own", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Leads",
      permissions: ["manage_roles", "manage_members", "view_usage"],
    });
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    // Their own role and Admin (above) are out of reach; Devs (below) isn't.
    await expect(updateRole(f.db, lead.id, f.org.id, leads.id, { name: "Bosses" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const admin = await adminRoleId(f.db, f.org.id);
    await expect(deleteRole(f.db, lead.id, f.org.id, admin)).rejects.toBeInstanceOf(ForbiddenError);
    await updateRole(f.db, lead.id, f.org.id, devs.id, { name: "Developers" });
    const { roles } = await listRoles(f.db, lead.id, f.org.id);
    expect(roles.find((r) => r.id === devs.id)).toMatchObject({ name: "Developers", editable: true });
    expect(roles.find((r) => r.id === leads.id)?.editable).toBe(false);
  });

  test("nobody gives what they can't do", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_roles"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await expect(
      createRole(f.db, lead.id, f.org.id, { name: "Spenders", permissions: ["view_usage"] }),
    ).rejects.toMatchObject({ code: "role.grant_forbidden" });
    // A key they hold themselves is fine.
    await createRole(f.db, lead.id, f.org.id, { name: "Helpers", permissions: ["post"] });
  });

  test("roles go only to people below, and only roles below one's own", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const boss = await addMember(f.db, f.org.id, "admin", "boss");
    const dev = await addMember(f.db, f.org.id, "member", "dev");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_members"] });
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await setMemberRoles(f.db, lead.id, f.org.id, dev.id, [devs.id]);
    await expect(setMemberRoles(f.db, lead.id, f.org.id, boss.id, [])).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await adminRoleId(f.db, f.org.id);
    await expect(setMemberRoles(f.db, lead.id, f.org.id, dev.id, [devs.id, admin])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("nobody hands themselves a role with keys they don't hold", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_members"] });
    const finance = await createRole(f.db, f.owner.id, f.org.id, { name: "Finance", permissions: ["view_usage"] });
    const helpers = await createRole(f.db, f.owner.id, f.org.id, { name: "Helpers", permissions: ["post"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await expect(setMemberRoles(f.db, lead.id, f.org.id, lead.id, [leads.id, finance.id])).rejects.toMatchObject({
      code: "role.grant_forbidden",
    });
    // A role whose keys they hold is fine, and it shows as one they may give.
    await setMemberRoles(f.db, lead.id, f.org.id, lead.id, [leads.id, helpers.id]);
    const { roles } = await listRoles(f.db, lead.id, f.org.id);
    expect(roles.find((r) => r.id === finance.id)?.givable).toBe(false);
    expect(roles.find((r) => r.id === helpers.id)?.givable).toBe(true);
  });

  test("an owner's roles only owners change", async () => {
    const boss = await addMember(f.db, f.org.id, "admin", "boss");
    await expect(setMemberRoles(f.db, boss.id, f.org.id, f.owner.id, [])).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the order moves only roles below the actor's own", async () => {
    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["manage_roles"] });
    const a = await createRole(f.db, f.owner.id, f.org.id, { name: "A" });
    const b = await createRole(f.db, f.owner.id, f.org.id, { name: "B" });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    const admin = await adminRoleId(f.db, f.org.id);
    await reorderRoles(f.db, lead.id, f.org.id, [admin, leads.id, b.id, a.id]);
    await expect(reorderRoles(f.db, lead.id, f.org.id, [leads.id, admin, a.id, b.id])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const { roles } = await listRoles(f.db, f.owner.id, f.org.id);
    expect(roles.filter((r) => r.kind === "custom").map((r) => r.name)).toEqual(["Admin", "Leads", "B", "A"]);
  });
});

describe("where the keys land", () => {
  test("talking to agents is a key: without it a person can't open a DM with an agent", async () => {
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const base = await everyoneOf();
    await updateRole(f.db, f.owner.id, f.org.id, base.id, {
      permissions: base.permissions.filter((k) => k !== "talk_to_agents"),
    });
    await expect(openDm(f.db, ana.id, f.org.id, { agentId: f.agent.id })).rejects.toBeInstanceOf(ForbiddenError);
    // The base role back on: they can.
    await updateRole(f.db, f.owner.id, f.org.id, base.id, { permissions: base.permissions });
    expect(await openDm(f.db, ana.id, f.org.id, { agentId: f.agent.id })).toBeTruthy();
  });

  test("invitations carry roles, and only roles below the sender", async () => {
    const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
    const { invitation, token } = await createInvitation(f.db, f.owner.id, f.org.id, {
      email: "new@example.com",
      roleIds: [devs.id],
    });
    expect(invitation.roleIds).toEqual([devs.id]);
    const [user] = await f.db
      .insert(schema.users)
      .values({ id: "user_new", name: "New", email: "new@example.com" })
      .returning();
    if (!user) throw new Error("no user");
    await acceptInvitation(f.db, { id: user.id, email: user.email }, token);
    const held = await f.db
      .select({ roleId: schema.organizationMemberRoles.roleId })
      .from(schema.organizationMemberRoles)
      .where(
        and(eq(schema.organizationMemberRoles.orgId, f.org.id), eq(schema.organizationMemberRoles.userId, user.id)),
      );
    expect(held.map((r) => r.roleId)).toEqual([devs.id]);

    const lead = await addMember(f.db, f.org.id, "member", "lead");
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Leads", permissions: ["invite_people"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [leads.id]);
    await makeAdmin(f.db, f.org.id, f.owner.id);
    const admin = await adminRoleId(f.db, f.org.id);
    await expect(
      createInvitation(f.db, lead.id, f.org.id, { email: "x@example.com", roleIds: [admin] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("creating agents makes your own: someone else, or nobody, as its owner takes editing any agent", async () => {
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const makers = await createRole(f.db, f.owner.id, f.org.id, { name: "Makers", permissions: ["create_agents"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [makers.id]);
    const make = (handle: string, owner?: { ownerUserId: string | null }) =>
      createAgent(f.db, ana.id, f.org.id, { name: handle, handle, ...owner }, { model: "claude-haiku-5-5" });
    for (const ownerUserId of [f.owner.id, null]) {
      await expect(make("iris", { ownerUserId })).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Refused before anything is made: the @ stays free.
    const iris = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.handle, "iris")));
    expect(iris).toEqual([]);
    expect((await make("iris", { ownerUserId: ana.id })).ownerUserId).toBe(ana.id);
    expect((await make("lia")).ownerUserId).toBe(ana.id);
    const leads = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Leads",
      permissions: ["create_agents", "manage_agents"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [leads.id]);
    expect((await make("otto", { ownerUserId: f.owner.id })).ownerUserId).toBe(f.owner.id);
    expect((await make("dora", { ownerUserId: null })).ownerUserId).toBeNull();
  });

  test("approving actions follows the key, not a role's name", async () => {
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    await expect(requirePermission(f.db, ana.id, f.org.id, "approve_actions")).rejects.toBeInstanceOf(ForbiddenError);
    const approvers = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Approvers",
      permissions: ["approve_actions"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, ana.id, [approvers.id]);
    await requirePermission(f.db, ana.id, f.org.id, "approve_actions");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createVaultItem, listUsableVault, listVault, type VaultAccess, vaultPersonOfRun } from "../src";
import { type AccessColumns, runAccess, viewerManages, viewerSees } from "../src/vault/access";
import { routineRun, runAskedBy, unattendedRun, type VaultFixture, vaultSetup } from "./vault-fixtures";

/**
 * Who sees, manages and uses a Vault item (ADR 0144): personal items are their owner's alone (admins included);
 * team items are seen by their audience and whoever manages credentials; agents use an item for the person behind
 * their run (who asked, else a routine's creator, else nobody) and only when it is shared with them.
 */

const columns = (over: Partial<AccessColumns> = {}): AccessColumns => ({
  audienceEveryone: false,
  audienceRoleIds: [],
  audienceUserIds: [],
  allAgents: false,
  agentIds: [],
  ...over,
});
const person = (personId: string | null, roleIds: string[] = [], manages = false) => ({ personId, roleIds, manages });

describe("the rules, as pure checks", () => {
  test("a personal item: only its owner sees and manages it, whatever they hold", () => {
    const c = columns({ allAgents: true });
    expect(viewerSees("ana", c, { userId: "ana", roleIds: [], manages: false })).toBe(true);
    expect(viewerSees("ana", c, { userId: "carla", roleIds: [], manages: true })).toBe(false);
    expect(viewerManages("ana", { userId: "carla", roleIds: [], manages: true })).toBe(false);
    expect(viewerManages("ana", { userId: "ana", roleIds: [], manages: false })).toBe(true);
  });

  test("a team item: its audience and who manages credentials see it, only the latter manage it", () => {
    const c = columns({ audienceRoleIds: ["support"], audienceUserIds: ["dora"] });
    expect(viewerSees(null, c, { userId: "bruno", roleIds: ["support"], manages: false })).toBe(true);
    expect(viewerSees(null, c, { userId: "dora", roleIds: [], manages: false })).toBe(true);
    expect(viewerSees(null, c, { userId: "eva", roleIds: [], manages: false })).toBe(false);
    expect(viewerSees(null, c, { userId: "carla", roleIds: [], manages: true })).toBe(true);
    expect(viewerSees(null, columns({ audienceEveryone: true }), { userId: "eva", roleIds: [], manages: false })).toBe(
      true,
    );
    expect(viewerManages(null, { userId: "bruno", roleIds: ["support"], manages: false })).toBe(false);
    expect(viewerManages(null, { userId: "carla", roleIds: [], manages: true })).toBe(true);
  });

  test("agents on a personal item: only for its owner, and only the agents it is shared with", () => {
    expect(runAccess("ana", columns({ allAgents: true }), person("ana"), "dev")).toBe("use");
    expect(runAccess("ana", columns({ agentIds: ["infra"] }), person("ana"), "dev")).toBe("not_shared");
    expect(runAccess("ana", columns({ agentIds: ["infra"] }), person("ana"), "infra")).toBe("use");
    expect(runAccess("ana", columns({ allAgents: true }), person("bruno", [], true), "dev")).toBe("hidden");
    expect(runAccess("ana", columns({ allAgents: true }), person(null), "dev")).toBe("hidden");
  });

  test("agents on a team item: the person must be in its audience, or nobody behind it and shared with everyone", () => {
    const everyone = columns({ audienceEveryone: true, agentIds: ["dev"] });
    expect(runAccess(null, everyone, person("dora"), "dev")).toBe("use");
    expect(runAccess(null, everyone, person(null), "dev")).toBe("use");
    expect(runAccess(null, everyone, person("dora"), "infra")).toBe("not_shared");

    const support = columns({ audienceRoleIds: ["support"], allAgents: true });
    expect(runAccess(null, support, person("bruno", ["support"]), "dev")).toBe("use");
    expect(runAccess(null, support, person("dora"), "dev")).toBe("hidden");
    // Who manages credentials sees it, but agents work for them only within its audience.
    expect(runAccess(null, support, person("carla", [], true), "dev")).toBe("not_shared");
    expect(runAccess(null, support, person(null), "dev")).toBe("hidden");

    const people = columns({ audienceUserIds: ["dora"], allAgents: true });
    expect(runAccess(null, people, person("dora"), "infra")).toBe("use");
    expect(runAccess(null, people, person("bruno", ["support"]), "infra")).toBe("hidden");
  });
});

let v: VaultFixture;
afterEach(async () => {
  const current = v;
  v = undefined as unknown as VaultFixture;
  await current?.f.close();
});

const team = (over: Partial<VaultAccess>): VaultAccess => ({
  everyone: false,
  roleIds: [],
  userIds: [],
  allAgents: false,
  agentIds: [],
  ...over,
});

/** A login saved by `userId` for `site`. */
const login = (userId: string, title: string, scope: "personal" | "team", access?: VaultAccess) =>
  createVaultItem(v.deps, userId, v.f.org.id, {
    kind: "login",
    scope,
    title,
    website: `https://${title}.example.com`,
    username: "acme-bot",
    secret: `pw-of-${title}-0000`,
    access,
  });

describe("who is behind a run", () => {
  test("the person who asked, a routine's creator, or nobody; only while they are a member", async () => {
    v = await vaultSetup();
    const asked = await runAskedBy(v, v.dev.id, v.bruno.id);
    expect(await vaultPersonOfRun(v.f.db, asked)).toMatchObject({
      personId: v.bruno.id,
      roleIds: [v.supportRoleId],
      manages: false,
      routineId: null,
    });
    const byAdmin = await runAskedBy(v, v.dev.id, v.carla.id);
    expect((await vaultPersonOfRun(v.f.db, byAdmin)).manages).toBe(true);

    const routine = await routineRun(v, v.dev.id, v.ana.id);
    const behindRoutine = await vaultPersonOfRun(v.f.db, routine);
    expect(behindRoutine.personId).toBe(v.ana.id);
    expect(behindRoutine.routineId).not.toBeNull();
    expect((await vaultPersonOfRun(v.f.db, await routineRun(v, v.dev.id, null))).personId).toBeNull();
    expect((await vaultPersonOfRun(v.f.db, await unattendedRun(v, v.dev.id))).personId).toBeNull();

    // Bruno leaves: his runs are nobody's.
    await v.f.db
      .delete(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, v.f.org.id), eq(schema.organizationMembers.userId, v.bruno.id)));
    expect(await vaultPersonOfRun(v.f.db, asked)).toMatchObject({ personId: null, roleIds: [], manages: false });
  });
});

describe("what each run may use", () => {
  test("personal, team by role, team for everyone: the matrix of people, routines and nobody", async () => {
    v = await vaultSetup();
    await login(v.ana.id, "ana-personal", "personal");
    await login(v.ana.id, "ana-infra-only", "personal", team({ allAgents: false, agentIds: [v.infra.id] }));
    await login(v.carla.id, "support-tools", "team", team({ roleIds: [v.supportRoleId], allAgents: true }));
    await login(v.carla.id, "status-page", "team", team({ everyone: true, agentIds: [v.dev.id] }));
    await login(v.carla.id, "dora-only", "team", team({ userIds: [v.dora.id], allAgents: true }));

    const titles = async (run: Parameters<typeof listUsableVault>[1]) =>
      (await listUsableVault(v.deps, run)).map((i) => i.title).sort();

    expect(await titles(await runAskedBy(v, v.dev.id, v.ana.id))).toEqual(["ana-personal", "status-page"]);
    expect(await titles(await runAskedBy(v, v.infra.id, v.ana.id))).toEqual(["ana-infra-only", "ana-personal"]);
    expect(await titles(await runAskedBy(v, v.dev.id, v.bruno.id))).toEqual(["status-page", "support-tools"]);
    expect(await titles(await runAskedBy(v, v.infra.id, v.bruno.id))).toEqual(["support-tools"]);
    expect(await titles(await runAskedBy(v, v.dev.id, v.dora.id))).toEqual(["dora-only", "status-page"]);
    // Carla manages credentials but is in no audience: agents use for her only what everyone may.
    expect(await titles(await runAskedBy(v, v.dev.id, v.carla.id))).toEqual(["status-page"]);
    // A routine Ana set up reaches what she would; one with no creator, only what everyone may.
    expect(await titles(await routineRun(v, v.dev.id, v.ana.id))).toEqual(["ana-personal", "status-page"]);
    expect(await titles(await routineRun(v, v.dev.id, null))).toEqual(["status-page"]);
    expect(await titles(await unattendedRun(v, v.dev.id))).toEqual(["status-page"]);
    expect(await titles(await unattendedRun(v, v.infra.id))).toEqual([]);
  });

  test("people see their own personal items and the team items of their audience; admins never see others' personal ones", async () => {
    v = await vaultSetup();
    await login(v.ana.id, "ana-personal", "personal");
    await login(v.bruno.id, "bruno-personal", "personal");
    await login(v.carla.id, "support-tools", "team", team({ roleIds: [v.supportRoleId] }));
    await login(v.carla.id, "status-page", "team", team({ everyone: true }));

    const seen = async (userId: string) =>
      (await listVault(v.deps, userId, v.f.org.id)).items.map((i) => i.title).sort();
    expect(await seen(v.ana.id)).toEqual(["ana-personal", "status-page", "support-tools"]);
    expect(await seen(v.bruno.id)).toEqual(["bruno-personal", "status-page", "support-tools"]);
    expect(await seen(v.carla.id)).toEqual(["status-page", "support-tools"]);
    expect(await seen(v.dora.id)).toEqual(["status-page"]);

    const bruno = await listVault(v.deps, v.bruno.id, v.f.org.id);
    expect(bruno.canManageTeam).toBe(false);
    expect(bruno.items.find((i) => i.title === "support-tools")?.can).toEqual({
      edit: false,
      delete: false,
    });
    expect(bruno.items.find((i) => i.title === "bruno-personal")?.can).toEqual({
      edit: true,
      delete: true,
    });
    expect((await listVault(v.deps, v.carla.id, v.f.org.id)).canManageTeam).toBe(true);
  });

  test("someone outside the workspace sees nothing", async () => {
    v = await vaultSetup();
    await v.f.db.insert(schema.users).values({ id: "user_outsider", name: "Eva", email: "eva@example.com" });
    await expect(listVault(v.deps, "user_outsider", v.f.org.id)).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});

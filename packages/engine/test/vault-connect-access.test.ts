import { expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  connectVaultSource,
  createAgent,
  listUnreachedConnections,
  listUsableVault,
  listVault,
  updateVaultConnection,
  type VaultAccess,
  type VaultScope,
} from "../src";
import { vaultListText } from "../src/vault/tools";
import { runAskedBy, SOURCE_PASSWORD, SOURCE_TOKEN, type VaultFixture, vaultSetup } from "./vault-fixtures";

/** ADR 0144 §10: what a connection starts with, and what an agent it isn't shared with is told. */

const TITLE = "Payroll-console-login";
const USERNAME = "finance-bot@acme.example";

async function world() {
  const v = await vaultSetup();
  v.source.items = [
    {
      ref: "item-1",
      kind: "login",
      title: TITLE,
      username: USERNAME,
      websites: [{ url: "https://payroll.acme.example", match: "exact" }],
    },
  ];
  v.source.values.set("item-1", SOURCE_PASSWORD);
  return v;
}

const connect = (v: VaultFixture, userId: string, scope: VaultScope, access?: VaultAccess) =>
  connectVaultSource(v.deps, userId, v.f.org.id, {
    kind: "fakepass",
    scope,
    input: { token: SOURCE_TOKEN },
    ...(access ? { access } : {}),
  });

const titles = async (v: VaultFixture, agentId: string, userId: string) =>
  (await listUsableVault(v.deps, await runAskedBy(v, agentId, userId))).map((i) => i.title);

const NO_AGENTS: VaultAccess = { everyone: true, roleIds: [], userIds: [], allAgents: false, agentIds: [] };

test("a team connection made now is open to every agent, one created later too", async () => {
  const v = await world();
  const connection = await connect(v, v.carla.id, "team");
  expect(connection.access).toEqual({ ...NO_AGENTS, allAgents: true });
  expect(await titles(v, v.dev.id, v.bruno.id)).toEqual([TITLE]);
  expect(await titles(v, v.infra.id, v.dora.id)).toEqual([TITLE]);

  const later = await createAgent(
    v.f.db,
    v.ana.id,
    v.f.org.id,
    { name: "Later", handle: "later", role: "Ops", instructions: "", credentialId: v.f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const run = await runAskedBy(v, later.id, v.bruno.id);
  expect((await listUsableVault(v.deps, run)).map((i) => i.title)).toEqual([TITLE]);
  expect(await listUnreachedConnections(v.deps, run)).toEqual([]);
});

test("a personal connection is for its owner's agents, and nobody else's run knows of it", async () => {
  const v = await world();
  const connection = await connect(v, v.bruno.id, "personal");
  expect(connection.access).toMatchObject({ everyone: false, allAgents: true, agentIds: [] });
  expect(await titles(v, v.dev.id, v.bruno.id)).toEqual([TITLE]);
  expect(await titles(v, v.infra.id, v.bruno.id)).toEqual([TITLE]);
  const carlas = await runAskedBy(v, v.dev.id, v.carla.id);
  expect(await listUsableVault(v.deps, carlas)).toEqual([]);
  expect(await listUnreachedConnections(v.deps, carlas)).toEqual([]);
});

test("a connection no agent uses stays as it is, and the agent says it is connected without access", async () => {
  const v = await world();
  const old = await connect(v, v.carla.id, "team", NO_AGENTS);
  // Another connection made now changes nothing on the one before it.
  const second = await connect(v, v.carla.id, "team");
  const seen = (await listVault(v.deps, v.carla.id, v.f.org.id)).connections.find((c) => c.id === old.id);
  expect(seen?.access).toEqual(NO_AGENTS);
  await v.f.db.delete(schema.vaultConnections).where(eq(schema.vaultConnections.id, second.id));

  const run = await runAskedBy(v, v.dev.id, v.bruno.id);
  expect(await listUsableVault(v.deps, run)).toEqual([]);
  const unreached = await listUnreachedConnections(v.deps, run);
  expect(unreached).toEqual([
    { place: expect.objectContaining({ name: "FakePass", connectionId: old.id }), scope: "team", hasItems: true },
  ]);
  const text = vaultListText([], { name: "Bruno", manages: false }, false, [], unreached);
  expect(text).toContain("Nothing in the Vault is shared with you for Bruno.");
  expect(text).toContain("Connected, but you have no access.");
  expect(text).toContain(
    `- FakePass · "Agents" (team, has items): whoever manages the workspace's credentials gives you access in Settings, Vault, Connections, "Default access" of that connection.`,
  );
  for (const secret of [TITLE, USERNAME, "payroll.acme.example", SOURCE_PASSWORD, SOURCE_TOKEN, "item-1"]) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/\b1 item\b/);
  // Asked by someone who manages credentials, the answer names them as who can give it.
  expect(vaultListText([], { name: "Carla", manages: true }, false, [], unreached)).toContain(
    "whoever manages the workspace's credentials (Carla does) gives you access",
  );

  // Given access, it is a place like any other and the line is gone.
  await updateVaultConnection(v.deps, v.carla.id, v.f.org.id, old.id, {
    access: { ...NO_AGENTS, agentIds: [v.dev.id] },
  });
  expect(await listUnreachedConnections(v.deps, run)).toEqual([]);
  expect((await listUsableVault(v.deps, run)).map((i) => i.title)).toEqual([TITLE]);
  // Still closed to the other agent.
  expect(await listUnreachedConnections(v.deps, await runAskedBy(v, v.infra.id, v.bruno.id))).toHaveLength(1);
});

test("a connection the person behind the run may not know of is never named", async () => {
  const v = await world();
  await connect(v, v.carla.id, "team", { ...NO_AGENTS, everyone: false, roleIds: [v.supportRoleId] });
  // Dora is in no role and manages nothing. Bruno is in Support.
  expect(await listUnreachedConnections(v.deps, await runAskedBy(v, v.dev.id, v.dora.id))).toEqual([]);
  expect(await listUnreachedConnections(v.deps, await runAskedBy(v, v.dev.id, v.bruno.id))).toHaveLength(1);
});

test("only who manages a connection changes its access", async () => {
  const v = await world();
  const team = await connect(v, v.carla.id, "team", NO_AGENTS);
  const mine = await connect(v, v.bruno.id, "personal");
  const open = { ...NO_AGENTS, allAgents: true };
  await expect(updateVaultConnection(v.deps, v.bruno.id, v.f.org.id, team.id, { access: open })).rejects.toMatchObject({
    name: "NotFoundError",
  });
  await expect(
    updateVaultConnection(v.deps, v.carla.id, v.f.org.id, mine.id, { access: NO_AGENTS }),
  ).rejects.toMatchObject({ name: "NotFoundError" });
  const rows = await v.f.db.select().from(schema.vaultConnections);
  expect(rows.find((r) => r.id === team.id)?.allAgents).toBe(false);
  expect(rows.find((r) => r.id === mine.id)?.allAgents).toBe(true);
});

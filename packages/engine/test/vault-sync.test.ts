import { afterEach, describe, expect, test } from "bun:test";
import { VaultSourceError } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  connectVaultSource,
  createJobHandlers,
  deleteVaultConnection,
  enqueueVaultSyncs,
  getVaultItem,
  listVault,
  runVaultSync,
  syncVaultConnection,
  updateVaultConnection,
  updateVaultItem,
  VAULT_MAX_ITEMS,
  VAULT_SYNC_JOB,
  type VaultAccess,
} from "../src";
import { sourceConnection, sourceOf } from "../src/vault/seal";
import {
  everythingStored,
  SOURCE_PASSWORD,
  SOURCE_TOKEN,
  storedValue,
  type VaultFixture,
  vaultSetup,
} from "./vault-fixtures";

/**
 * Password managers in the Vault (ADR 0144): connecting checks the credentials and reads the items before it answers;
 * the credentials are sealed and never come back; each sync adds, updates and marks missing what the source lists;
 * a refusal stays on the connection, in our words.
 */

let v: VaultFixture;
afterEach(async () => {
  const current = v;
  v = undefined as unknown as VaultFixture;
  await current?.f.close();
});

const github = {
  ref: "item-1",
  kind: "login" as const,
  title: "GitHub",
  username: "acme-bot",
  websites: [{ url: "https://github.com", match: "exact" as const }],
};
const deploy = {
  ref: "item-2",
  kind: "key" as const,
  title: "Deploy token",
  keyName: "DEPLOY_TOKEN",
  description: "CI deploys",
};
const cloud = {
  ref: "item-3",
  kind: "login" as const,
  title: "Cloud console",
  websites: [{ url: "https://console.cloud.example.com", match: "site" as const }],
};

const connectTeam = (access?: VaultAccess) =>
  connectVaultSource(v.deps, v.carla.id, v.f.org.id, {
    kind: "fakepass",
    scope: "team",
    input: { token: SOURCE_TOKEN },
    access,
  });

const items = async (connectionId: string) =>
  v.f.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.connectionId, connectionId));

describe("connecting", () => {
  test("checked, sealed, read before it answers; the credentials never come back", async () => {
    v = await vaultSetup();
    v.source.items = [github, deploy];
    const connection = await connectTeam();
    expect(connection).toMatchObject({
      kind: "fakepass",
      name: "FakePass",
      scope: "team",
      label: "Agents",
      config: { vaultId: "v1", vaultName: "Agents" },
      status: "ready",
      errorCode: null,
      itemCount: 2,
      // Connected without an access: every agent (ADR 0144 §10).
      access: { everyone: true, allAgents: true, agentIds: [] },
      can: { edit: true },
    });
    expect(connection.syncedAt).not.toBeNull();
    expect(v.source.seenTokens).toEqual([SOURCE_TOKEN]);
    // Each call into the source has a deadline (a signal that aborts), and connecting names the workspace.
    expect(v.source.calls.map((c) => [c.op, c.orgId])).toEqual([
      ["connect", v.f.org.id],
      ["list", v.f.org.id],
    ]);
    expect(v.source.calls.every((c) => c.signal instanceof AbortSignal && !c.signal.aborted)).toBe(true);
    const [row] = await v.f.db.select().from(schema.vaultConnections);
    expect(row?.secretCiphertext).not.toContain(SOURCE_TOKEN);
    if (!row) throw new Error("no row");
    expect((await sourceConnection(v.deps, row)).secret).toEqual({ token: SOURCE_TOKEN });
    // Its seal names its workspace and owner: moved, it doesn't open.
    await expect(sourceConnection(v.deps, { ...row, ownerUserId: v.carla.id })).rejects.toThrow();
    await expect(sourceConnection(v.deps, { ...row, orgId: crypto.randomUUID() })).rejects.toThrow();

    const overview = await listVault(v.deps, v.carla.id, v.f.org.id);
    expect(overview.sources.map((s) => s.name)).toEqual(["FakePass"]);
    expect(overview.items.map((i) => [i.title, i.sourceName, i.accessFromConnection, i.hasSecret]).sort()).toEqual([
      ["Deploy token", "FakePass", true, true],
      ["GitHub", "FakePass", true, true],
    ]);
    expect(JSON.stringify(overview)).not.toContain(SOURCE_TOKEN);
    expect(await everythingStored(v)).not.toContain(SOURCE_TOKEN);
    // A team connection is for who manages credentials; Dora sees its items (everyone), not it.
    const dora = await listVault(v.deps, v.dora.id, v.f.org.id);
    expect(dora.connections).toEqual([]);
    expect(dora.items).toHaveLength(2);
    const [audit] = await v.f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "vault.connection_added"));
    expect(audit?.details).toMatchObject({ kind: "fakepass", label: "Agents", scope: "team" });
  });

  test("refusals: a wrong token leaves nothing; an unknown source; a team one without the permission", async () => {
    v = await vaultSetup();
    await expect(
      connectVaultSource(v.deps, v.carla.id, v.f.org.id, {
        kind: "fakepass",
        scope: "team",
        input: { token: "wrong" },
      }),
    ).rejects.toMatchObject({ name: "VaultSourceError", code: "auth_failed" });
    v.source.listError = new VaultSourceError("locked", "The vault is locked.");
    await expect(connectTeam()).rejects.toMatchObject({ code: "locked" });
    expect(await v.f.db.select().from(schema.vaultConnections)).toEqual([]);
    // A kind is looked up among the sources' own names only: one on an object's prototype finds nothing.
    for (const kind of ["nope", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await expect(
        connectVaultSource(v.deps, v.carla.id, v.f.org.id, { kind, scope: "team", input: {} }),
      ).rejects.toMatchObject({ code: "vault.source_unknown" });
    }
    expect(sourceOf(v.deps.sources, "fakepass")).toBe(v.source);
    expect(sourceOf(v.deps.sources, "constructor")).toBeUndefined();
    expect(sourceOf(v.deps.sources, 42)).toBeUndefined();
    v.source.listError = null;
    await expect(
      connectVaultSource(v.deps, v.bruno.id, v.f.org.id, {
        kind: "fakepass",
        scope: "team",
        input: { token: SOURCE_TOKEN },
      }),
    ).rejects.toMatchObject({ code: "vault.team_needs_permission" });
    // A provider's own failure never comes out as its words.
    v.source.listError = new Error(`upstream said ${SOURCE_TOKEN} is bad`);
    const error = await connectTeam().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultSourceError);
    expect((error as VaultSourceError).code).toBe("unreachable");
    expect(String((error as Error).message)).not.toContain(SOURCE_TOKEN);
  });

  test("any other failure of the first read leaves nothing either, and is thrown as it was", async () => {
    v = await vaultSetup();
    v.source.items = [github, deploy];
    // The first read lists and keeps the items, then fails (the database's error, say) before it marks it ready.
    let clock = 0;
    const failing = {
      ...v.deps,
      now: () => {
        clock += 1;
        if (clock > 1) throw new Error("the database went away");
        return new Date();
      },
    };
    await expect(
      connectVaultSource(failing, v.carla.id, v.f.org.id, {
        kind: "fakepass",
        scope: "team",
        input: { token: SOURCE_TOKEN },
      }),
    ).rejects.toThrow("the database went away");
    // No connection left `syncing` with its sealed credentials, nor the items it read.
    expect(await v.f.db.select().from(schema.vaultConnections)).toEqual([]);
    expect(await v.f.db.select().from(schema.vaultItems)).toEqual([]);
    expect(
      await v.f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "vault.connection_added")),
    ).toEqual([]);
  });

  test("a personal connection is its owner's alone; its items are personal", async () => {
    v = await vaultSetup();
    v.source.items = [github];
    const connection = await connectVaultSource(v.deps, v.bruno.id, v.f.org.id, {
      kind: "fakepass",
      scope: "personal",
      input: { token: SOURCE_TOKEN },
    });
    expect(connection).toMatchObject({ scope: "personal", ownerUserId: v.bruno.id, access: { allAgents: true } });
    const [item] = await items(connection.id);
    expect(item?.ownerUserId).toBe(v.bruno.id);
    expect((await listVault(v.deps, v.carla.id, v.f.org.id)).connections).toEqual([]);
    expect((await listVault(v.deps, v.carla.id, v.f.org.id)).items).toEqual([]);
    await expect(syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id)).rejects.toMatchObject({
      name: "NotFoundError",
    });
  });
});

describe("syncing", () => {
  test("adds, updates, marks missing and brings back; a name and a description people set stay", async () => {
    v = await vaultSetup();
    v.source.items = [github, deploy];
    const connection = await connectTeam();
    const before = await items(connection.id);
    const key = before.find((i) => i.externalRef === "item-2");
    if (!key) throw new Error("no key");
    await updateVaultItem(v.deps, v.carla.id, v.f.org.id, key.id, { keyName: "CI_DEPLOY_TOKEN", description: "Ours" });

    v.source.items = [{ ...github, title: "GitHub (bot)" }, cloud, { ...deploy, title: "Deploy" }];
    const after = await syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id);
    expect(after.itemCount).toBe(3);
    const rows = await items(connection.id);
    expect(rows.map((r) => [r.externalRef, r.title, r.missing]).sort()).toEqual([
      ["item-1", "GitHub (bot)", false],
      ["item-2", "Deploy", false],
      ["item-3", "Cloud console", false],
    ]);
    expect(rows.find((r) => r.externalRef === "item-3")).toMatchObject({
      website: "https://console.cloud.example.com",
      match: "site",
      accessFromConnection: true,
      ownerUserId: null,
    });
    expect(rows.find((r) => r.externalRef === "item-2")).toMatchObject({
      keyName: "CI_DEPLOY_TOKEN",
      description: "Ours",
    });
    // Each row kept its id: uses and access set on it stay with it.
    expect(rows.find((r) => r.externalRef === "item-2")?.id).toBe(key.id);

    v.source.items = [cloud];
    await syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id);
    const missing = (await items(connection.id)).filter((r) => r.missing).map((r) => r.externalRef);
    expect(missing.sort()).toEqual(["item-1", "item-2"]);
    expect((await listVault(v.deps, v.carla.id, v.f.org.id)).connections[0]?.itemCount).toBe(1);

    v.source.items = [cloud, github];
    await syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id);
    const back = (await items(connection.id)).filter((r) => !r.missing).map((r) => r.externalRef);
    expect(back.sort()).toEqual(["item-1", "item-3"]);
  });

  test("at the workspace's cap: what is there stays and is updated, new items wait, missing only what the source dropped", async () => {
    v = await vaultSetup();
    v.source.items = [github, deploy];
    const connection = await connectTeam();
    // Built-in items fill the rest of the Vault.
    const filler = Array.from({ length: VAULT_MAX_ITEMS - 2 }, (_, i) => ({
      orgId: v.f.org.id,
      kind: "contact",
      title: `Contact ${i}`,
    }));
    for (let i = 0; i < filler.length; i += 500) {
      await v.f.db.insert(schema.vaultItems).values(filler.slice(i, i + 500));
    }

    v.source.items = [{ ...github, title: "GitHub (bot)" }, deploy, cloud];
    const full = await syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id);
    // Not a refusal of the source: the person sees why, and the next sync tries again by itself.
    expect(full).toMatchObject({ status: "error", errorCode: "too_many_items", itemCount: 2 });
    const rows = async () =>
      (await items(connection.id)).map((r) => [r.externalRef, r.title, r.missing]).sort() as unknown[];
    expect(await rows()).toEqual([
      ["item-1", "GitHub (bot)", false],
      ["item-2", "Deploy token", false],
    ]);

    // The source dropped one: only that one is missing; the new one still waits (a missing item keeps its place).
    v.source.items = [github, cloud];
    await syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id);
    expect(await rows()).toEqual([
      ["item-1", "GitHub", false],
      ["item-2", "Deploy token", true],
    ]);
    expect(await enqueueVaultSyncs(v.f.db, new Date(Date.now() + 11 * 60_000))).toBe(1);

    // Room again: the new item comes in and the connection is ready.
    await v.f.db.delete(schema.vaultItems).where(eq(schema.vaultItems.title, "Contact 0"));
    const ready = await syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id);
    expect(ready).toMatchObject({ status: "ready", errorCode: null });
    expect(await rows()).toEqual([
      ["item-1", "GitHub", false],
      ["item-2", "Deploy token", true],
      ["item-3", "Cloud console", false],
    ]);
  });

  test("a refusal: on the connection, items untouched, thrown to a person, quiet for the job", async () => {
    v = await vaultSetup();
    v.source.items = [github];
    const connection = await connectTeam();
    v.source.listError = new VaultSourceError("rate_limited", "Too many reads. Try later.", "2030-01-01T00:00:00Z");
    await expect(syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id)).rejects.toMatchObject({
      code: "rate_limited",
    });
    const [row] = await v.f.db.select().from(schema.vaultConnections);
    expect(row).toMatchObject({ status: "error", errorCode: "rate_limited" });
    expect((await items(connection.id)).map((r) => r.missing)).toEqual([false]);
    await runVaultSync(v.deps, v.f.org.id, connection.id);
    const job = createJobHandlers({ ...v.f.jobDeps, vault: v.deps })[VAULT_SYNC_JOB];
    expect(job).toBeDefined();

    v.source.listError = null;
    expect((await syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id)).status).toBe("ready");
  });

  test("external items: source fields read-only here, access and description editable, value read from the source", async () => {
    v = await vaultSetup();
    v.source.items = [github];
    v.source.values.set("item-1", SOURCE_PASSWORD);
    const connection = await connectTeam();
    const [row] = await items(connection.id);
    if (!row) throw new Error("no item");
    await expect(updateVaultItem(v.deps, v.carla.id, v.f.org.id, row.id, { title: "Mine" })).rejects.toMatchObject({
      code: "vault.external_read_only",
    });
    await expect(updateVaultItem(v.deps, v.carla.id, v.f.org.id, row.id, { secret: "x" })).rejects.toMatchObject({
      code: "vault.external_read_only",
    });
    const changed = await updateVaultItem(v.deps, v.carla.id, v.f.org.id, row.id, {
      description: "The bot's login",
      access: { everyone: false, roleIds: [v.supportRoleId], userIds: [], allAgents: true, agentIds: [] },
    });
    expect(changed).toMatchObject({ accessFromConnection: false, access: { roleIds: [v.supportRoleId] } });
    expect(await storedValue(v, row.id)).toBe(SOURCE_PASSWORD);
    // Back to the connection's access.
    const back = await updateVaultItem(v.deps, v.carla.id, v.f.org.id, row.id, { accessFromConnection: true });
    expect(back).toMatchObject({ accessFromConnection: true, access: { everyone: true } });
    // While it is in its source it can't be deleted here; once gone from it, it can.
    expect(back.can.delete).toBe(false);
    v.source.items = [];
    await syncVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id);
    expect((await getVaultItem(v.deps, v.carla.id, v.f.org.id, row.id)).can.delete).toBe(true);
    expect(await everythingStored(v)).not.toContain(SOURCE_PASSWORD);
  });

  test("reconnecting, changing the default access, disconnecting (its items go with it)", async () => {
    v = await vaultSetup();
    v.source.items = [github, deploy];
    const connection = await connectTeam();
    await expect(
      updateVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id, { input: { token: "wrong" } }),
    ).rejects.toMatchObject({ code: "auth_failed" });
    const changed = await updateVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id, {
      access: { everyone: false, roleIds: [], userIds: [v.dora.id], allAgents: false, agentIds: [v.dev.id] },
      input: { token: SOURCE_TOKEN },
    });
    expect(changed).toMatchObject({
      status: "ready",
      access: { everyone: false, userIds: [v.dora.id], agentIds: [v.dev.id] },
    });
    // Its items follow it: Bruno no longer sees them, Dora does.
    expect((await listVault(v.deps, v.bruno.id, v.f.org.id)).items).toEqual([]);
    expect((await listVault(v.deps, v.dora.id, v.f.org.id)).items).toHaveLength(2);

    await deleteVaultConnection(v.deps, v.carla.id, v.f.org.id, connection.id);
    expect(await v.f.db.select().from(schema.vaultConnections)).toEqual([]);
    expect(await v.f.db.select().from(schema.vaultItems)).toEqual([]);
    const actions = (
      await v.f.db
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.orgId, v.f.org.id), eq(schema.auditLog.targetType, "vault_connection")))
    ).map((a) => a.action);
    expect(actions.sort()).toEqual(["vault.connection_added", "vault.connection_changed", "vault.connection_removed"]);
  });
});

describe("the periodic sync", () => {
  test("queues each connection read over 10 minutes ago once per window, never a refused sign-in", async () => {
    v = await vaultSetup();
    v.source.items = [github];
    const fresh = await connectTeam();
    const now = new Date();
    expect(await enqueueVaultSyncs(v.f.db, now)).toBe(0);

    const later = new Date(now.getTime() + 11 * 60_000);
    expect(await enqueueVaultSyncs(v.f.db, later)).toBe(1);
    expect(await enqueueVaultSyncs(v.f.db, later)).toBe(1);
    const jobs = () => v.f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, VAULT_SYNC_JOB));
    expect(await jobs()).toHaveLength(1);
    expect((await jobs())[0]?.payload).toEqual({ connectionId: fresh.id });
    await enqueueVaultSyncs(v.f.db, new Date(later.getTime() + 10 * 60_000));
    expect(await jobs()).toHaveLength(2);

    await v.f.db
      .update(schema.vaultConnections)
      .set({ status: "error", errorCode: "auth_failed" })
      .where(eq(schema.vaultConnections.id, fresh.id));
    expect(await enqueueVaultSyncs(v.f.db, new Date(later.getTime() + 60 * 60_000))).toBe(0);
  });
});

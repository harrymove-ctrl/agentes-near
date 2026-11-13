import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createVaultItem, deleteVaultItem, getVaultItem, listVault, updateVaultItem, type VaultAccess } from "../src";
import { itemAad, openItemValue } from "../src/vault/seal";
import { everythingStored, storedValue, type VaultFixture, vaultSetup } from "./vault-fixtures";

/**
 * Vault items for people (ADR 0144): saved sealed and bound to their workspace, id, owner and version; never a value
 * in a list, a detail, the audit log, a use or an event; shown or copied only by who manages them, and recorded.
 */

let v: VaultFixture;
afterEach(async () => {
  const current = v;
  v = undefined as unknown as VaultFixture;
  await current?.f.close();
});

const PASSWORD = "hunter2-Correct-Horse-0001";
const KEY = "sk-live-ABCDEFGHIJKLMNOP-1234";

const access = (over: Partial<VaultAccess>): VaultAccess => ({
  everyone: false,
  roleIds: [],
  userIds: [],
  allAgents: false,
  agentIds: [],
  ...over,
});

const rowOf = async (id: string) => {
  const [row] = await v.f.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, id));
  if (!row) throw new Error("no row");
  return row;
};

describe("saving", () => {
  test("a personal login: sealed, its view without the password, the agents any when its owner asks", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.bruno.id, v.f.org.id, {
      kind: "login",
      scope: "personal",
      title: "",
      website: "github.com/login",
      username: "bruno-acme",
      secret: PASSWORD,
      access: access({ everyone: true, roleIds: [v.supportRoleId], allAgents: true }),
    });
    expect(item).toMatchObject({
      kind: "login",
      scope: "personal",
      ownerUserId: v.bruno.id,
      title: "github.com",
      website: "https://github.com",
      match: "exact",
      username: "bruno-acme",
      hasSecret: true,
      contact: null,
      connectionId: null,
      // A personal item has no audience, whatever was sent.
      access: { everyone: false, roleIds: [], userIds: [], allAgents: true, agentIds: [] },
      can: { edit: true, delete: true },
    });
    const row = await rowOf(item.id);
    expect(row.secretVersion).toBe(1);
    expect(row.secretCiphertext).not.toContain(PASSWORD);
    expect(await openItemValue(v.deps, row)).toBe(PASSWORD);
    expect(JSON.stringify(item)).not.toContain(PASSWORD);
    expect(v.events.some((e) => (e as { event?: { type?: string } }).event?.type === "vault.changed")).toBe(true);
  });

  test("a team item takes the permission to manage credentials, and starts shared with everyone and no agent", async () => {
    v = await vaultSetup();
    const input = {
      kind: "key" as const,
      scope: "team" as const,
      title: "Payments",
      keyName: "STRIPE_KEY",
      secret: KEY,
    };
    await expect(createVaultItem(v.deps, v.bruno.id, v.f.org.id, input)).rejects.toMatchObject({
      code: "vault.team_needs_permission",
    });
    const item = await createVaultItem(v.deps, v.carla.id, v.f.org.id, input);
    expect(item.access).toEqual({ everyone: true, roleIds: [], userIds: [], allAgents: false, agentIds: [] });
    expect(item.keyHint).toBe("1234");
    expect(item.keyName).toBe("STRIPE_KEY");
    // One key name per scope; a personal one of the same name is another scope.
    await expect(createVaultItem(v.deps, v.ana.id, v.f.org.id, input)).rejects.toMatchObject({
      code: "vault.key_name_taken",
    });
    await createVaultItem(v.deps, v.bruno.id, v.f.org.id, { ...input, scope: "personal" });
    // A short value keeps its last characters to itself.
    const short = await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      ...input,
      keyName: "SHORT_KEY",
      secret: "abc12345",
    });
    expect(short.keyHint).toBeNull();
  });

  test("what isn't saved: an address that isn't HTTPS, a reserved or invalid name, an empty contact, others' roles and agents", async () => {
    v = await vaultSetup();
    const save = (input: Parameters<typeof createVaultItem>[3], userId = v.carla.id) =>
      createVaultItem(v.deps, userId, v.f.org.id, input);
    await expect(
      save({ kind: "login", scope: "personal", title: "x", website: "http://acme.example.com", secret: "p" }),
    ).rejects.toMatchObject({ code: "vault.not_https" });
    await expect(
      save({ kind: "key", scope: "personal", title: "x", keyName: "ANTHROPIC_API_KEY" }),
    ).rejects.toMatchObject({ code: "vault.key_name_reserved" });
    await expect(save({ kind: "key", scope: "personal", title: "x", keyName: "lower_case" })).rejects.toMatchObject({
      code: "vault.key_name_invalid",
    });
    await expect(save({ kind: "contact", scope: "personal", title: "x", contact: {} })).rejects.toMatchObject({
      code: "vault.contact_empty",
    });
    await expect(
      save({
        kind: "contact",
        scope: "team",
        title: "Acme",
        contact: { company: "Acme" },
        access: access({ roleIds: [crypto.randomUUID()] }),
      }),
    ).rejects.toMatchObject({ code: "vault.audience_invalid" });
    await expect(
      save({
        kind: "contact",
        scope: "team",
        title: "Acme",
        contact: { company: "Acme" },
        access: access({ everyone: true, agentIds: [crypto.randomUUID()] }),
      }),
    ).rejects.toMatchObject({ code: "vault.agents_invalid" });
    await expect(
      save({ kind: "contact", scope: "personal", title: "x".repeat(121), contact: { company: "Acme" } }),
    ).rejects.toMatchObject({ code: "vault.too_long" });
  });

  test("a contact: its fields sealed at rest, shown to who sees it on its page, never in the list", async () => {
    v = await vaultSetup();
    const contact = await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      kind: "contact",
      scope: "team",
      title: "",
      contact: {
        fullName: "Acme Ltda",
        document: "12.345.678/0001-90",
        city: "Recife",
        email: " billing@acme.example ",
      },
    });
    expect(contact.title).toBe("Acme Ltda");
    expect(contact.hasSecret).toBe(false);
    expect(contact.contact).toEqual({
      fullName: "Acme Ltda",
      document: "12.345.678/0001-90",
      city: "Recife",
      email: "billing@acme.example",
    });
    const row = await rowOf(contact.id);
    expect(row.secretCiphertext).not.toContain("12.345.678");
    // The list opens no contact's seal: its row goes by its title and description (ADR 0144 §7).
    const listed = (await listVault(v.deps, v.dora.id, v.f.org.id)).items.find((i) => i.id === contact.id);
    expect(listed).toMatchObject({ title: "Acme Ltda", contact: null });
    const seenByDora = await getVaultItem(v.deps, v.dora.id, v.f.org.id, contact.id);
    expect(seenByDora).toMatchObject({ unreadable: false, contact: { document: "12.345.678/0001-90" } });
    expect(await everythingStored(v)).not.toContain("12.345.678");
  });
});

describe("sealing", () => {
  test("a value opens only for its own workspace, item, owner and version", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.bruno.id, v.f.org.id, {
      kind: "login",
      scope: "personal",
      title: "github",
      website: "https://github.com",
      secret: PASSWORD,
    });
    const row = await rowOf(item.id);
    expect(await openItemValue(v.deps, row)).toBe(PASSWORD);
    await expect(openItemValue(v.deps, { ...row, orgId: crypto.randomUUID() })).rejects.toThrow();
    await expect(openItemValue(v.deps, { ...row, ownerUserId: v.dora.id })).rejects.toThrow();
    await expect(openItemValue(v.deps, { ...row, ownerUserId: null })).rejects.toThrow();
    await expect(openItemValue(v.deps, { ...row, id: crypto.randomUUID() })).rejects.toThrow();
    await expect(openItemValue(v.deps, { ...row, secretVersion: 2 })).rejects.toThrow();
    expect(itemAad(row.orgId, row.id, null, 3)).toBe(`vault-item|${row.orgId}|${row.id}|team|3`);

    // The row handed to another person in the database: it no longer opens, even for them.
    await v.f.db.update(schema.vaultItems).set({ ownerUserId: v.dora.id }).where(eq(schema.vaultItems.id, item.id));
    await expect(storedValue(v, item.id)).rejects.toThrow();
  });

  test("a new value takes the next version, and the old ciphertext put back doesn't open", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.ana.id, v.f.org.id, {
      kind: "key",
      scope: "personal",
      title: "npm",
      keyName: "NPM_TOKEN",
      secret: "npm_token_value_number_one",
    });
    const before = await rowOf(item.id);
    await updateVaultItem(v.deps, v.ana.id, v.f.org.id, item.id, { secret: "npm_token_value_number_two" });
    const after = await rowOf(item.id);
    expect(after.secretVersion).toBe(2);
    expect(await openItemValue(v.deps, after)).toBe("npm_token_value_number_two");
    await v.f.db
      .update(schema.vaultItems)
      .set({
        secretCiphertext: before.secretCiphertext,
        wrappedDataKey: before.wrappedDataKey,
        kekId: before.kekId,
      })
      .where(eq(schema.vaultItems.id, item.id));
    await expect(openItemValue(v.deps, await rowOf(item.id))).rejects.toThrow();
  });
});

describe("changing, showing, deleting", () => {
  test("only who manages an item changes it; an item outside someone's view is not found", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      kind: "login",
      scope: "team",
      title: "Status page",
      website: "https://status.acme.example",
      secret: PASSWORD,
      access: access({ roleIds: [v.supportRoleId] }),
    });
    await expect(
      updateVaultItem(v.deps, v.bruno.id, v.f.org.id, item.id, { description: "Shared login" }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
    await expect(getVaultItem(v.deps, v.dora.id, v.f.org.id, item.id)).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await expect(getVaultItem(v.deps, v.dora.id, v.f.org.id, "not-an-id")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    const changed = await updateVaultItem(v.deps, v.carla.id, v.f.org.id, item.id, {
      description: "The status page's admin",
      match: "site",
      username: "ops",
      access: access({ everyone: true, agentIds: [v.dev.id] }),
    });
    expect(changed).toMatchObject({
      description: "The status page's admin",
      match: "site",
      username: "ops",
      access: { everyone: true, agentIds: [v.dev.id] },
    });
    expect((await getVaultItem(v.deps, v.dora.id, v.f.org.id, item.id)).id).toBe(item.id);
    await expect(
      updateVaultItem(v.deps, v.carla.id, v.f.org.id, item.id, { keyName: "NOT_A_LOGIN_FIELD" }),
    ).rejects.toMatchObject({ code: "vault.invalid" });
    const [audit] = await v.f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "vault.item_changed"), eq(schema.auditLog.targetId, item.id)));
    expect(audit?.details).toMatchObject({ kind: "login", title: "Status page", fields: expect.any(Array) });
  });

  test("a saved value never comes back to a person: their screens learn it is saved, agents' computers get it", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      kind: "login",
      scope: "team",
      title: "Bank",
      website: "https://bank.example.com",
      secret: PASSWORD,
    });
    const detail = await getVaultItem(v.deps, v.carla.id, v.f.org.id, item.id);
    expect(detail.hasSecret).toBe(true);
    expect(detail.can).toEqual({ edit: true, delete: true });
    expect(JSON.stringify(detail)).not.toContain(PASSWORD);
    // Nothing in the engine answers a person with a value (ADR 0144 §2).
    const engine = await import("../src");
    expect(Object.keys(engine).filter((name) => /vault/i.test(name) && /reveal|show|copy/i.test(name))).toEqual([]);
    // Someone who only sees it can't change it, and doesn't see who used it.
    const seen = await getVaultItem(v.deps, v.dora.id, v.f.org.id, item.id);
    expect(seen.can).toEqual({ edit: false, delete: false });
    expect(seen.uses).toEqual([]);
    // Agents still use it: the server opens it only to seal it for their computer.
    expect(await storedValue(v, item.id)).toBe(PASSWORD);
  });

  test("no value anywhere: lists, details, audit, uses, jobs, events", async () => {
    v = await vaultSetup();
    const login = await createVaultItem(v.deps, v.ana.id, v.f.org.id, {
      kind: "login",
      scope: "personal",
      title: "gh",
      website: "https://github.com",
      secret: PASSWORD,
    });
    const key = await createVaultItem(v.deps, v.ana.id, v.f.org.id, {
      kind: "key",
      scope: "team",
      title: "Stripe",
      keyName: "STRIPE_KEY",
      secret: KEY,
    });
    await updateVaultItem(v.deps, v.ana.id, v.f.org.id, key.id, { secret: `${KEY}-rotated` });
    const views = JSON.stringify([
      await listVault(v.deps, v.ana.id, v.f.org.id),
      await getVaultItem(v.deps, v.ana.id, v.f.org.id, login.id),
      await getVaultItem(v.deps, v.ana.id, v.f.org.id, key.id),
    ]);
    const stored = await everythingStored(v);
    for (const secret of [PASSWORD, KEY, "ABCDEFGHIJKLMNOP"]) {
      expect(views).not.toContain(secret);
      expect(stored).not.toContain(secret);
    }
  });

  test("deleting: who manages it; the row and its uses go, the audit line stays", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.bruno.id, v.f.org.id, {
      kind: "contact",
      scope: "personal",
      title: "Me",
      contact: { fullName: "Bruno" },
    });
    await expect(deleteVaultItem(v.deps, v.carla.id, v.f.org.id, item.id)).rejects.toMatchObject({
      name: "NotFoundError",
    });
    await deleteVaultItem(v.deps, v.bruno.id, v.f.org.id, item.id);
    expect(await v.f.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, item.id))).toEqual([]);
    expect(await v.f.db.select().from(schema.vaultUses).where(eq(schema.vaultUses.itemId, item.id))).toEqual([]);
    const audit = await v.f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "vault.item_deleted"), eq(schema.auditLog.targetId, item.id)));
    expect(audit).toHaveLength(1);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { getVaultItem, listUsableVault, releaseVaultKeys, releaseVaultLogin, saveSecretRequestToVault } from "../src";
import { openItemValue } from "../src/vault/seal";
import { everythingStored, runAskedBy, type VaultFixture, vaultSetup } from "./vault-fixtures";

/**
 * "Save to the Vault" on a secret request's card (ADR 0144): only the person it was asked of, once delivered; a
 * site's password becomes a login for that site, a variable a key with its name; a file or a code never; saving the
 * same login or key again replaces its value.
 */

let v: VaultFixture;
afterEach(async () => {
  const current = v;
  v = undefined as unknown as VaultFixture;
  await current?.f.close();
});

const PASSWORD = "site-Password-From-Card-77";

/** A request Dev made in a run Bruno asked for, as `request_secret` leaves it. */
async function request(
  over: Partial<typeof schema.secretRequests.$inferInsert> & { forUserId?: string } = {},
): Promise<string> {
  const run = await runAskedBy(v, v.dev.id, over.forUserId ?? v.bruno.id);
  const { forUserId, ...rest } = over;
  const [row] = await v.f.db
    .insert(schema.secretRequests)
    .values({
      orgId: v.f.org.id,
      runId: run.runId,
      agentId: v.dev.id,
      channelId: v.f.general.id,
      toolUseId: `tool-${crypto.randomUUID()}`,
      requestedForUserId: forUserId ?? v.bruno.id,
      name: "GITHUB_PASSWORD",
      purpose: "Sign in to open the pull request",
      targetKind: "site",
      site: "https://github.com",
      publicKey: "AAAA",
      status: "delivered",
      deliveredAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      ...rest,
    })
    .returning({ id: schema.secretRequests.id });
  if (!row) throw new Error("no request");
  return row.id;
}

const card = (over: Partial<Parameters<typeof saveSecretRequestToVault>[4]> = {}) => ({
  value: PASSWORD,
  scope: "personal" as const,
  allAgents: false,
  agentIds: [v.dev.id],
  ...over,
});

describe("saving what was sent", () => {
  test("a site's password: a login for that site, the asking agent may use it; saved again, its password replaced", async () => {
    v = await vaultSetup();
    const first = await request({ username: "bruno-acme" });
    const item = await saveSecretRequestToVault(v.deps, v.bruno.id, v.f.org.id, first, card());
    expect(item).toMatchObject({
      kind: "login",
      scope: "personal",
      ownerUserId: v.bruno.id,
      title: "github.com",
      website: "https://github.com",
      match: "exact",
      username: "bruno-acme",
      hasSecret: true,
      access: { allAgents: false, agentIds: [v.dev.id] },
    });
    expect(JSON.stringify(item)).not.toContain(PASSWORD);
    const run = await runAskedBy(v, v.dev.id, v.bruno.id);
    expect((await releaseVaultLogin(v.deps, run, item.id, "https://github.com")).password).toBe(PASSWORD);

    const second = await request({ username: "bruno-acme" });
    const again = await saveSecretRequestToVault(
      v.deps,
      v.bruno.id,
      v.f.org.id,
      second,
      card({ value: "a-new-password-88", agentIds: [v.infra.id] }),
    );
    expect(again.id).toBe(item.id);
    expect(again.access.agentIds.sort()).toEqual([v.dev.id, v.infra.id].sort());
    const [row] = await v.f.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, item.id));
    if (!row) throw new Error("no row");
    expect(row.secretVersion).toBe(2);
    expect(await openItemValue(v.deps, row)).toBe("a-new-password-88");
    expect(await v.f.db.select().from(schema.vaultItems)).toHaveLength(1);

    // Another username on the same site is another login.
    const third = await request({ username: null });
    const other = await saveSecretRequestToVault(
      v.deps,
      v.bruno.id,
      v.f.org.id,
      third,
      card({ username: "bruno-alt" }),
    );
    expect(other.id).not.toBe(item.id);
    expect(other.username).toBe("bruno-alt");

    // The card always sends the username it shows: cleared, the agent's suggestion isn't kept (ADR 0144 §6).
    const cleared = await saveSecretRequestToVault(
      v.deps,
      v.bruno.id,
      v.f.org.id,
      await request({ username: "dev-guessed-this" }),
      card({ value: "a-third-password-99", username: "" }),
    );
    expect(cleared.username).toBeNull();
    expect(cleared.id).not.toBe(item.id);
    // Absent: the request's own (an older app).
    const kept = await saveSecretRequestToVault(
      v.deps,
      v.bruno.id,
      v.f.org.id,
      await request({ username: "bruno-kept" }),
      card({ value: "a-fourth-password-11" }),
    );
    expect(kept.username).toBe("bruno-kept");

    const uses = (await getVaultItem(v.deps, v.bruno.id, v.f.org.id, item.id)).uses.map((u) => u.action);
    expect(uses).toEqual(["edit", "create"]);
    const stored = await everythingStored(v);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain("a-new-password-88");
  });

  test("a variable: a key with its name and the request's purpose; a site password sent as a variable to an older computer is still a login", async () => {
    v = await vaultSetup();
    const env = await request({ targetKind: "env", site: null, name: "NPM_TOKEN", purpose: "Publish the package" });
    const key = await saveSecretRequestToVault(
      v.deps,
      v.bruno.id,
      v.f.org.id,
      env,
      card({ value: "  npm_token_from_card_123456 \n" }),
    );
    expect(key).toMatchObject({
      kind: "key",
      keyName: "NPM_TOKEN",
      title: "Npm token",
      description: "Publish the package",
      keyHint: "3456",
    });
    const run = await runAskedBy(v, v.dev.id, v.bruno.id);
    expect(await releaseVaultKeys(v.deps, run, ["NPM_TOKEN"])).toEqual([
      { name: "NPM_TOKEN", value: "npm_token_from_card_123456", itemId: key.id },
    ]);
    const old = await request({ targetKind: "env", site: "https://registry.example.com", name: "REGISTRY_PASSWORD" });
    expect((await saveSecretRequestToVault(v.deps, v.bruno.id, v.f.org.id, old, card())).kind).toBe("login");
    expect((await listUsableVault(v.deps, run)).map((i) => i.kind).sort()).toEqual(["key", "login"]);
  });

  test("a team item from the card: who manages credentials only, shared with everyone and the agents picked", async () => {
    v = await vaultSetup();
    const forBruno = await request();
    await expect(
      saveSecretRequestToVault(v.deps, v.bruno.id, v.f.org.id, forBruno, card({ scope: "team" })),
    ).rejects.toMatchObject({ code: "vault.team_needs_permission" });
    const forCarla = await request({ forUserId: v.carla.id });
    const team = await saveSecretRequestToVault(v.deps, v.carla.id, v.f.org.id, forCarla, card({ scope: "team" }));
    expect(team).toMatchObject({ scope: "team", access: { everyone: true, agentIds: [v.dev.id] } });
    const [audit] = await v.f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, team.id));
    expect(audit).toMatchObject({ action: "vault.item_created", details: { kind: "login", requestId: forCarla } });
  });

  test("refused: someone else's request, not delivered yet, a file, a code", async () => {
    v = await vaultSetup();
    const save = (id: string, userId = v.bruno.id) => saveSecretRequestToVault(v.deps, userId, v.f.org.id, id, card());
    const bruno = await request();
    await expect(save(bruno, v.dora.id)).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(save(crypto.randomUUID())).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(save("nope")).rejects.toMatchObject({ name: "NotFoundError" });
    await expect(save(await request({ status: "pending", deliveredAt: null }))).rejects.toMatchObject({
      code: "vault.request_not_delivered",
    });
    await expect(
      save(await request({ targetKind: "file", site: null, targetPath: "~/.npmrc", name: "NPMRC" })),
    ).rejects.toMatchObject({ code: "vault.request_not_savable" });
    await expect(save(await request({ codeDigits: 6, name: "GITHUB_CODE" }))).rejects.toMatchObject({
      code: "vault.request_not_savable",
    });
    await expect(save(bruno, v.bruno.id).then(() => "saved")).resolves.toBe("saved");
    expect(await v.f.db.select().from(schema.vaultItems)).toHaveLength(1);
  });
});

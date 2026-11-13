/**
 * "Save to the Vault" on a secret request's card (ADR 0144): after the person sent an agent a site's password or a
 * variable (ADR 0027, end to end to the computer), their browser sends the same value here once more to keep it. The
 * delivered box never comes here: the server sees the value only on this call, and only to seal it.
 *
 * A site's password becomes a login for that site, a variable a key with its name. A file and a one-time code are
 * never kept. Saving the same login (same scope, website and username) or the same key name again replaces its value.
 */
import { and, eq, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { UUID } from "../authority";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { publishVaultChanged } from "../events";
import { secretLabelOf } from "../secrets";
import { cleanAccess } from "./access";
import {
  assertRoom,
  cleanScope,
  cleanSecret,
  cleanText,
  cleanWebsite,
  keyHintOf,
  keyWithName,
  sameLogin,
  teamNeedsPermission,
  vaultViewer,
} from "./items";
import { sealItemValue } from "./seal";
import { type SecretToVaultInput, VAULT_LIMITS, type VaultDeps, type VaultItem, vaultNow } from "./service";
import { recordPersonUse } from "./uses";
import { itemView } from "./views";

const { secretRequests, vaultItems } = schema;

const notSavable = (why: string) => new ValidationError(why, "vault.request_not_savable");

type SavedFields = Pick<typeof vaultItems.$inferInsert, "title" | "description" | "website" | "username" | "keyName">;

export async function saveSecretRequestToVault(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  requestId: string,
  input: SecretToVaultInput,
): Promise<VaultItem> {
  const { db } = deps;
  if (!UUID.test(requestId)) throw new NotFoundError("Not found", "vault.not_found");
  const viewer = await vaultViewer(db, userId, orgId);
  const [request] = await db
    .select()
    .from(secretRequests)
    .where(and(eq(secretRequests.orgId, orgId), eq(secretRequests.id, requestId)));
  if (!request) throw new NotFoundError("Not found", "vault.not_found");
  // Someone else's request reads as no request at all.
  if (request.requestedForUserId !== userId) throw new NotFoundError("Not found", "vault.not_found");
  if (request.status !== "delivered") throw new ConflictError("Send it first", "vault.request_not_delivered");
  if (request.codeDigits !== null) throw notSavable("A one-time code isn't kept");
  if (request.targetKind === "file") throw notSavable("A file isn't kept in the Vault");

  const scope = cleanScope(input.scope);
  if (scope === "team" && !viewer.manages) throw teamNeedsPermission();
  const ownerUserId = scope === "personal" ? userId : null;
  const access = await cleanAccess(db, orgId, scope, {
    everyone: scope === "team",
    roleIds: [],
    userIds: [],
    allAgents: input.allAgents === true,
    agentIds: input.agentIds ?? [],
  });

  // A site's password delivered as a variable to an older computer still names its site.
  const login = request.targetKind === "site" || request.site !== null;
  let fields: SavedFields;
  let value: string;
  let existing: typeof vaultItems.$inferSelect | undefined;
  if (login) {
    let website: string;
    try {
      website = cleanWebsite(request.site);
    } catch {
      throw notSavable("This request has no HTTPS site to keep it for");
    }
    // The person's choice when the card sent one ("" = no username, a suggestion they cleared), else the agent's.
    const chosen = input.username !== undefined ? input.username : request.username;
    const username = cleanText(chosen, VAULT_LIMITS.username, "username") || null;
    value = cleanSecret(input.value, "login");
    existing = await sameLogin(db, orgId, ownerUserId, website, username);
    fields = { title: new URL(website).host, description: "", website, username, keyName: null };
  } else {
    value = cleanSecret(input.value, "key");
    existing = await keyWithName(db, orgId, ownerUserId, request.name);
    fields = {
      title: secretLabelOf(request).slice(0, VAULT_LIMITS.title),
      description: request.purpose.trim().slice(0, VAULT_LIMITS.description),
      website: null,
      username: null,
      keyName: request.name,
    };
  }
  const kind = login ? "login" : "key";
  const keyHint = kind === "key" ? keyHintOf(value) : null;
  const now = vaultNow(deps);

  if (existing) {
    const item = existing;
    const sealed = await sealItemValue(deps, item, item.secretVersion + 1, value);
    // The agents picked on the card join the ones it already had: the agent that asked can use it now.
    const agentIds = [...new Set([...item.agentIds, ...access.agentIds])];
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(vaultItems)
        .set({
          ...sealed,
          previousSecrets: [],
          ...(kind === "key" ? { keyHint } : {}),
          allAgents: item.allAgents || access.allAgents,
          agentIds,
          updatedAt: now,
        })
        .where(and(eq(vaultItems.id, item.id), eq(vaultItems.secretVersion, item.secretVersion)))
        .returning();
      if (!updated) throw new ConflictError("It changed meanwhile. Try again.", "vault.changed_meanwhile");
      await recordPersonUse(tx, { orgId, itemId: item.id, userId, action: "edit" });
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: userId },
        action: "vault.item_changed",
        target: { type: "vault_item", id: item.id },
        details: { kind, title: updated.title, scope, fields: ["secret"], requestId },
      });
      return updated;
    });
    await publishVaultChanged(deps.pubsub, orgId);
    return itemView(deps, row, undefined, viewer);
  }

  await assertRoom(db, orgId);
  const id = Bun.randomUUIDv7();
  const sealed = await sealItemValue(deps, { orgId, id, ownerUserId }, 1, value);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(vaultItems)
      .values({
        id,
        orgId,
        kind,
        ownerUserId,
        ...fields,
        match: "exact",
        keyHint,
        ...sealed,
        ...access,
        createdByUserId: userId,
      })
      .returning();
    if (!created) throw new Error("vault item insert returned nothing");
    await recordPersonUse(tx, { orgId, itemId: id, userId, action: "create" });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "vault.item_created",
      target: { type: "vault_item", id },
      details: { kind, title: created.title, scope, requestId },
    });
    return created;
  });
  await publishVaultChanged(deps.pubsub, orgId);
  return itemView(deps, row, undefined, viewer);
}

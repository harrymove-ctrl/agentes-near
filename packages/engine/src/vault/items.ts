/**
 * The Vault for people (ADR 0144): what the app's Settings, Vault lists, saves, changes and deletes. Every
 * function checks the person itself (`access.ts`): an item they may not see is `NotFoundError`, the same as one that
 * doesn't exist, and what they see but don't manage is `ForbiddenError`. Values are sealed before any write
 * (`seal.ts`) and never come back to a person: no answer carries one, and changing one means typing a new one (§2).
 */
import { isReservedSecretName, MAX_SECRET_BYTES, SECRET_NAME, vaultOrigin } from "@agenteschat/adapters";
import { and, count, type Database, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { UUID } from "../authority";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { publishVaultChanged } from "../events";
import { can, requireActiveMembership } from "../organizations";
import {
  type AccessColumns,
  cleanAccess,
  effectiveColumns,
  type ItemRow,
  type VaultViewer,
  viewerManages,
  viewerSees,
} from "./access";
import { sealItemValue } from "./seal";
import {
  CONTACT_FIELDS,
  VAULT_ITEM_KINDS,
  VAULT_LIMITS,
  VAULT_MAX_ITEMS,
  type VaultContactFields,
  type VaultDeps,
  type VaultItem,
  type VaultItemDetail,
  type VaultItemInput,
  type VaultItemKind,
  type VaultItemPatch,
  type VaultMatch,
  type VaultOverview,
  type VaultScope,
  vaultNow,
} from "./service";
import { listUses, recordPersonUse } from "./uses";
import {
  connectionOf,
  connectionView,
  contactOf,
  hostOf,
  itemView,
  loadVault,
  readContact,
  sourceInfos,
  sourceNameOf,
} from "./views";

const { vaultConnections, vaultItems } = schema;

/** The person in the app, with what they hold. Refuses anyone who isn't an active member. */
export async function vaultViewer(db: Database, userId: string, orgId: string): Promise<VaultViewer> {
  const membership = await requireActiveMembership(db, userId, orgId);
  return { userId, roleIds: membership.roleIds, manages: can(membership, "manage_credentials") };
}

export const vaultNotFound = () => new NotFoundError("Not found", "vault.not_found");
export const teamNeedsPermission = () =>
  new ForbiddenError("Team items take the permission to manage credentials", "vault.team_needs_permission");

/** An item the person sees, with its connection. Anything else is not found. */
export async function visibleItem(db: Executor, orgId: string, itemId: string, viewer: VaultViewer) {
  if (!UUID.test(itemId)) throw vaultNotFound();
  const [item] = await db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.orgId, orgId), eq(vaultItems.id, itemId)));
  if (!item) throw vaultNotFound();
  const connection = await connectionRow(db, orgId, item.connectionId);
  if (!viewerSees(item.ownerUserId, effectiveColumns(item, connection), viewer)) throw vaultNotFound();
  return { item, connection };
}

/** An item the person manages (edits, deletes). Seen but not managed is forbidden. */
async function managedItem(db: Executor, orgId: string, itemId: string, viewer: VaultViewer) {
  const found = await visibleItem(db, orgId, itemId, viewer);
  if (!viewerManages(found.item.ownerUserId, viewer)) throw new ForbiddenError();
  return found;
}

export async function connectionRow(db: Executor, orgId: string, connectionId: string | null) {
  if (!connectionId) return undefined;
  const [row] = await db
    .select()
    .from(vaultConnections)
    .where(and(eq(vaultConnections.orgId, orgId), eq(vaultConnections.id, connectionId)));
  return row;
}

// Field checks, shared by the app, the request card, imports and agents.

export function cleanText(value: string | undefined | null, max: number, field: string): string {
  const text = (value ?? "").trim();
  if (text.length > max) {
    throw new ValidationError(`The ${field} is too long (max ${max})`, "vault.too_long", { field, max });
  }
  return text;
}

export function cleanScope(scope: unknown): VaultScope {
  if (scope !== "personal" && scope !== "team") throw new ValidationError("Unknown scope", "vault.invalid");
  return scope;
}

export function cleanKind(kind: unknown): VaultItemKind {
  if (!VAULT_ITEM_KINDS.includes(kind as VaultItemKind)) throw new ValidationError("Unknown kind", "vault.invalid");
  return kind as VaultItemKind;
}

export function cleanWebsite(raw: string | undefined | null): string {
  const max = VAULT_LIMITS.website;
  if ((raw ?? "").length > max) {
    throw new ValidationError("The website is too long", "vault.too_long", { field: "website", max });
  }
  const origin = vaultOrigin(raw ?? "");
  if (!origin) throw new ValidationError("The website must be an HTTPS address", "vault.not_https");
  return origin;
}

export function cleanMatch(match: unknown): VaultMatch {
  if (match === undefined || match === null || match === "exact") return "exact";
  if (match === "site") return "site";
  throw new ValidationError("Unknown match", "vault.invalid");
}

export function cleanKeyName(raw: string | undefined | null): string {
  const name = (raw ?? "").trim();
  if (!SECRET_NAME.test(name)) {
    const example = "Use capital letters, digits and _ in the name (like GITHUB_TOKEN)";
    throw new ValidationError(example, "vault.key_name_invalid");
  }
  if (isReservedSecretName(name))
    throw new ValidationError("This name is reserved for how agents think. Pick another.", "vault.key_name_reserved");
  return name;
}

/** A login's password as typed (spaces kept), or a key's value trimmed. Never empty, at most 16 KB. */
export function cleanSecret(raw: string | undefined | null, kind: VaultItemKind): string {
  const value = kind === "key" ? (raw ?? "").trim() : (raw ?? "");
  if (!value) throw new ValidationError("Nothing to save", "vault.no_value");
  const max = MAX_SECRET_BYTES;
  if (new TextEncoder().encode(value).byteLength > max) {
    throw new ValidationError("The value is too large (max 16 KB)", "vault.too_long", { field: "secret", max });
  }
  return value;
}

/** A contact's fields: the known ones, each at most 300 characters, at least one filled in. */
export function cleanContact(input: VaultContactFields | undefined | null): VaultContactFields {
  const out: VaultContactFields = {};
  for (const key of CONTACT_FIELDS) {
    const value = cleanText(input?.[key], VAULT_LIMITS.contactField, key);
    if (value) out[key] = value;
  }
  if (Object.keys(out).length === 0) throw new ValidationError("Fill in at least one field", "vault.contact_empty");
  return out;
}

/** A key's last 4 characters, only when that leaves most of it unknown. */
export const keyHintOf = (value: string) => (value.length >= 12 ? value.slice(-4) : null);

/** A title, or the item's own name when none was given (a login's host, a key's name, a contact's name). */
function titleFor(
  raw: string | undefined,
  fallback: { website?: string | null; keyName?: string | null; contact?: VaultContactFields | null },
) {
  const title =
    cleanText(raw, VAULT_LIMITS.title, "title") ||
    (fallback.website ? hostOf(fallback.website) : "") ||
    fallback.keyName ||
    fallback.contact?.fullName ||
    fallback.contact?.company ||
    fallback.contact?.email ||
    "";
  if (!title) throw new ValidationError("Give it a name", "vault.title_required");
  return title.slice(0, VAULT_LIMITS.title);
}

/** Room for one more item in the workspace (`VAULT_MAX_ITEMS`). */
export async function assertRoom(db: Executor, orgId: string, more = 1) {
  const [row] = await db.select({ n: count() }).from(vaultItems).where(eq(vaultItems.orgId, orgId));
  if ((row?.n ?? 0) + more > VAULT_MAX_ITEMS)
    throw new ConflictError(`The Vault holds at most ${VAULT_MAX_ITEMS} items`, "vault.too_many_items");
}

const ownerIs = (ownerUserId: string | null) =>
  ownerUserId ? eq(vaultItems.ownerUserId, ownerUserId) : isNull(vaultItems.ownerUserId);

/** A built-in key with this name in the same scope (one name per scope, so a command gets the one it asked for). */
export async function keyWithName(db: Executor, orgId: string, ownerUserId: string | null, keyName: string) {
  const [row] = await db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.orgId, orgId),
        eq(vaultItems.kind, "key"),
        isNull(vaultItems.connectionId),
        ownerIs(ownerUserId),
        eq(vaultItems.keyName, keyName),
      ),
    )
    .limit(1);
  return row;
}

async function assertKeyNameFree(
  db: Executor,
  orgId: string,
  ownerUserId: string | null,
  keyName: string,
  exceptId: string | null,
) {
  const found = await keyWithName(db, orgId, ownerUserId, keyName);
  if (found && found.id !== exceptId)
    throw new ConflictError("A key with this name is already saved here", "vault.key_name_taken");
}

/** A built-in login of the same scope for the same website and username: saving it again replaces its password. */
export async function sameLogin(
  db: Executor,
  orgId: string,
  ownerUserId: string | null,
  website: string,
  username: string | null,
) {
  const [row] = await db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.orgId, orgId),
        eq(vaultItems.kind, "login"),
        isNull(vaultItems.connectionId),
        ownerIs(ownerUserId),
        eq(vaultItems.website, website),
        username ? eq(vaultItems.username, username) : isNull(vaultItems.username),
      ),
    )
    .limit(1);
  return row;
}

const accessColumnsOf = (row: AccessColumns): AccessColumns => ({
  audienceEveryone: row.audienceEveryone,
  audienceRoleIds: row.audienceRoleIds,
  audienceUserIds: row.audienceUserIds,
  allAgents: row.allAgents,
  agentIds: row.agentIds,
});

/** The person's audit line for an item. Never a value: its kind, title and what changed. */
function auditItem(
  db: Executor,
  orgId: string,
  userId: string,
  action: string,
  item: Pick<ItemRow, "id" | "kind" | "title" | "ownerUserId">,
  extra: Record<string, unknown> = {},
) {
  return recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action,
    target: { type: "vault_item", id: item.id },
    details: { kind: item.kind, title: item.title, scope: item.ownerUserId ? "personal" : "team", ...extra },
  });
}

/**
 * Everything the person sees in the Vault: their items, the connections they manage, the sources to connect. No
 * contact's fields (`contact: null`): opening every contact's seal for a list is work no row shows (ADR 0144 §7); an
 * item's page has them (`getVaultItem`).
 */
export async function listVault(deps: VaultDeps, userId: string, orgId: string): Promise<VaultOverview> {
  const viewer = await vaultViewer(deps.db, userId, orgId);
  const state = await loadVault(deps.db, orgId);
  const visible = state.items.filter((item) =>
    viewerSees(item.ownerUserId, effectiveColumns(item, connectionOf(state, item)), viewer),
  );
  const items = await Promise.all(
    visible.map((item) => itemView(deps, item, connectionOf(state, item), viewer, { contact: false })),
  );
  const counts = new Map<string, number>();
  for (const item of state.items)
    if (item.connectionId && !item.missing) counts.set(item.connectionId, (counts.get(item.connectionId) ?? 0) + 1);
  const connections = [...state.connections.values()]
    .filter((row) => viewerManages(row.ownerUserId, viewer))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((row) => connectionView(deps.sources, row, viewer, counts.get(row.id) ?? 0));
  return { items, connections, sources: sourceInfos(deps.sources), canManageTeam: viewer.manages };
}

/**
 * One item with its newest uses (only who manages it sees who used it, and for whom) and, for a contact, its fields,
 * or `unreadable` when they don't open here.
 */
export async function getVaultItem(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  itemId: string,
): Promise<VaultItemDetail> {
  const viewer = await vaultViewer(deps.db, userId, orgId);
  const { item, connection } = await visibleItem(deps.db, orgId, itemId, viewer);
  const view = await itemView(deps, item, connection, viewer, { contact: false });
  const { contact, unreadable } = await readContact(deps, item);
  const uses = viewerManages(item.ownerUserId, viewer) ? await listUses(deps.db, orgId, item.id) : [];
  return { ...view, contact, uses, unreadable };
}

/** Saves a new built-in item: personal for anyone, team for who manages credentials. */
export async function createVaultItem(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  input: VaultItemInput,
): Promise<VaultItem> {
  const { db } = deps;
  const viewer = await vaultViewer(db, userId, orgId);
  const kind = cleanKind(input.kind);
  const scope = cleanScope(input.scope);
  if (scope === "team" && !viewer.manages) throw teamNeedsPermission();
  const ownerUserId = scope === "personal" ? userId : null;

  const description = cleanText(input.description, VAULT_LIMITS.description, "description");
  let website: string | null = null;
  let match: VaultMatch = "exact";
  let username: string | null = null;
  let keyName: string | null = null;
  let contact: VaultContactFields | null = null;
  let plaintext: string | null = null;
  if (kind === "login") {
    website = cleanWebsite(input.website);
    match = cleanMatch(input.match);
    username = cleanText(input.username, VAULT_LIMITS.username, "username") || null;
    plaintext = input.secret ? cleanSecret(input.secret, kind) : null;
  } else if (kind === "key") {
    keyName = cleanKeyName(input.keyName);
    plaintext = input.secret ? cleanSecret(input.secret, kind) : null;
  } else {
    contact = cleanContact(input.contact);
    plaintext = JSON.stringify(contact);
  }
  const title = titleFor(input.title, { website, keyName, contact });
  const access = await cleanAccess(db, orgId, scope, input.access);
  await assertRoom(db, orgId);
  if (keyName) await assertKeyNameFree(db, orgId, ownerUserId, keyName, null);

  const id = Bun.randomUUIDv7();
  const sealed = plaintext ? await sealItemValue(deps, { orgId, id, ownerUserId }, 1, plaintext) : null;
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(vaultItems)
      .values({
        id,
        orgId,
        kind,
        ownerUserId,
        title,
        description,
        website,
        match,
        username,
        keyName,
        keyHint: kind === "key" && plaintext ? keyHintOf(plaintext) : null,
        ...(sealed ?? {}),
        ...access,
        createdByUserId: userId,
      })
      .returning();
    if (!created) throw new Error("vault item insert returned nothing");
    await recordPersonUse(tx, { orgId, itemId: id, userId, action: "create" });
    await auditItem(tx, orgId, userId, "vault.item_created", created);
    return created;
  });
  await publishVaultChanged(deps.pubsub, orgId);
  return itemView(deps, row, undefined, viewer);
}

const SOURCE_FIELDS = ["title", "website", "match", "username", "secret", "contact"] as const;

/**
 * Changes an item. Its owner (personal) or who manages credentials (team). An external item's fields come from its
 * source and stay read-only: only its access, its variable name and its description change here.
 */
export async function updateVaultItem(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  itemId: string,
  patch: VaultItemPatch,
): Promise<VaultItem> {
  const { db } = deps;
  const viewer = await vaultViewer(db, userId, orgId);
  const { item, connection } = await managedItem(db, orgId, itemId, viewer);
  const kind = item.kind as VaultItemKind;
  const external = item.connectionId !== null;
  if (external) {
    for (const field of SOURCE_FIELDS)
      if (patch[field] !== undefined) {
        const source = connection ? sourceNameOf(deps.sources, connection.kind) : "its password manager";
        throw new ValidationError(`This item comes from ${source}. Change it there.`, "vault.external_read_only");
      }
  }
  const wrongField = (field: string) => new ValidationError(`A ${kind} has no ${field}`, "vault.invalid", { field });

  const set: Partial<typeof vaultItems.$inferInsert> = {};
  const changed: string[] = [];
  if (patch.description !== undefined) {
    set.description = cleanText(patch.description, VAULT_LIMITS.description, "description");
    changed.push("description");
  }
  if (patch.website !== undefined || patch.match !== undefined || patch.username !== undefined) {
    if (kind !== "login") throw wrongField(patch.username !== undefined ? "username" : "website");
    if (patch.website !== undefined) {
      set.website = cleanWebsite(patch.website);
      changed.push("website");
    }
    if (patch.match !== undefined) {
      set.match = cleanMatch(patch.match);
      changed.push("match");
    }
    if (patch.username !== undefined) {
      set.username = cleanText(patch.username, VAULT_LIMITS.username, "username") || null;
      changed.push("username");
    }
  }
  if (patch.keyName !== undefined) {
    if (kind !== "key") throw wrongField("keyName");
    const keyName = cleanKeyName(patch.keyName);
    if (!external) await assertKeyNameFree(db, orgId, item.ownerUserId, keyName, item.id);
    set.keyName = keyName;
    changed.push("keyName");
  }
  if (patch.title !== undefined) {
    // An emptied name falls back as on creation: a contact's goes by its (new or saved) fields (ADR 0144).
    const contact =
      kind !== "contact" || patch.title.trim()
        ? null
        : patch.contact !== undefined
          ? cleanContact(patch.contact)
          : await contactOf(deps, item);
    set.title = titleFor(patch.title, {
      website: set.website ?? item.website,
      keyName: set.keyName ?? item.keyName,
      contact,
    });
    changed.push("title");
  }
  let plaintext: string | null = null;
  if (patch.secret !== undefined) {
    if (kind === "contact") throw wrongField("secret");
    plaintext = cleanSecret(patch.secret, kind);
    if (kind === "key") set.keyHint = keyHintOf(plaintext);
    changed.push("secret");
  }
  if (patch.contact !== undefined) {
    if (kind !== "contact") throw wrongField("contact");
    plaintext = JSON.stringify(cleanContact(patch.contact));
    changed.push("contact");
  }
  if (patch.access !== undefined) {
    Object.assign(set, await cleanAccess(db, orgId, item.ownerUserId ? "personal" : "team", patch.access));
    if (external) set.accessFromConnection = false;
    changed.push("access");
  } else if (patch.accessFromConnection !== undefined && external) {
    set.accessFromConnection = patch.accessFromConnection;
    // Its own access starts as the connection's, never as an empty one nobody picked.
    if (!patch.accessFromConnection && item.accessFromConnection && connection)
      Object.assign(set, accessColumnsOf(connection));
    changed.push("access");
  }
  if (changed.length === 0) return itemView(deps, item, connection, viewer);

  const version = item.secretVersion + 1;
  if (plaintext !== null)
    Object.assign(set, await sealItemValue(deps, item, version, plaintext), { previousSecrets: [] });
  set.updatedAt = vaultNow(deps);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(vaultItems)
      .set(set)
      .where(
        and(
          eq(vaultItems.orgId, orgId),
          eq(vaultItems.id, item.id),
          // A new value is sealed for the next version: another save meanwhile would leave one that doesn't open.
          eq(vaultItems.secretVersion, item.secretVersion),
        ),
      )
      .returning();
    if (!updated) throw new ConflictError("It changed meanwhile. Open it again.", "vault.changed_meanwhile");
    await recordPersonUse(tx, { orgId, itemId: item.id, userId, action: "edit" });
    await auditItem(tx, orgId, userId, "vault.item_changed", updated, { fields: changed });
    return updated;
  });
  await publishVaultChanged(deps.pubsub, orgId);
  return itemView(deps, row, connection, viewer);
}

/** Deletes a built-in item, or an external one gone from its source (one still there comes back at the next sync). */
export async function deleteVaultItem(deps: VaultDeps, userId: string, orgId: string, itemId: string): Promise<void> {
  const { db } = deps;
  const viewer = await vaultViewer(db, userId, orgId);
  const { item, connection } = await managedItem(db, orgId, itemId, viewer);
  if (item.connectionId && !item.missing) {
    const source = connection ? sourceNameOf(deps.sources, connection.kind) : "its password manager";
    throw new ValidationError(
      `This item comes from ${source}. Remove it there, or disconnect ${source}.`,
      "vault.external_read_only",
    );
  }
  await db.transaction(async (tx) => {
    await tx.delete(vaultItems).where(and(eq(vaultItems.orgId, orgId), eq(vaultItems.id, item.id)));
    await auditItem(tx, orgId, userId, "vault.item_deleted", item);
  });
  await publishVaultChanged(deps.pubsub, orgId);
}

/**
 * Reading a connection's items into the Vault (ADR 0144): its source lists metadata (never a value), and each item
 * becomes a row keyed by (connection, the source's id). New ones follow the connection's access; ones the source no
 * longer lists are marked missing (nobody uses them until they come back). A refusal (`VaultSourceError`) leaves the
 * items as they were and goes on the connection (`status` `error`, `errorCode`), never the source's own words.
 *
 * The workspace's cap (`VAULT_MAX_ITEMS`) counts every item. At it, the items already here stay and are updated, and
 * only new ones wait: the connection says `too_many_items` (`status` `error`) until a later sync finds room. Whether
 * an item is missing is decided by the source's listing alone, never by the cap.
 *
 * Every connection is read again every 10 minutes (`enqueueVaultSyncs`, one job per connection and window), except
 * one whose sign-in was refused: trying again with the same credentials could lock its account, so it waits for a
 * person to reconnect it.
 */
import {
  isReservedSecretName,
  SECRET_NAME,
  VaultSourceError,
  type VaultSourceItem,
  vaultOrigin,
} from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, lt, not, or, schema, sql } from "@agenteschat/db";
import { UUID } from "../authority";
import { SealedValueError } from "../crypto";
import { publishVaultChanged } from "../events";
import { enqueue } from "../outbox";
import { closedOrg } from "../standing";
import type { ConnectionRow, ItemRow } from "./access";
import { sourceCall, sourceConnection, sourceOf } from "./seal";
import {
  VAULT_ITEM_KINDS,
  VAULT_LIMITS,
  VAULT_MAX_ITEMS,
  type VaultDeps,
  type VaultItemKind,
  vaultNow,
} from "./service";
import { hostOf } from "./views";

const { organizations, vaultConnections, vaultItems } = schema;

/** Outbox job: read one connection's items again (`{ connectionId }`). */
export const VAULT_SYNC_JOB = "vault.sync";
/** How often each connection is read again. */
export const VAULT_SYNC_EVERY_MS = 10 * 60_000;
/** Refusals that wait for a person to reconnect instead of being tried again. */
const WAITS_FOR_PERSON = ["auth_failed", "locked"];
/**
 * The connection's `errorCode` when the Vault was full: what it already had stays, new items wait for room. Not a
 * refusal of the source: the next sync tries again by itself (the apps say "Remove items before syncing more").
 */
export const VAULT_FULL = "too_many_items";

/** A row's columns from one listed item; null when it can't be kept (an unknown kind, no id). */
function rowOf(connection: ConnectionRow, item: VaultSourceItem) {
  const kind = item.kind as VaultItemKind;
  if (!VAULT_ITEM_KINDS.includes(kind) || !item.ref || item.ref.length > 512) return null;
  const site = (item.websites ?? [])
    .map((w) => ({ origin: vaultOrigin(w.url), match: w.match === "site" ? "site" : "exact" }))
    .find((w) => w.origin !== null);
  const keyName = kind === "key" && item.keyName?.trim() ? item.keyName.trim() : null;
  return {
    orgId: connection.orgId,
    kind,
    connectionId: connection.id,
    externalRef: item.ref,
    ownerUserId: connection.ownerUserId,
    title: (item.title ?? "").trim().slice(0, VAULT_LIMITS.title) || (site?.origin ? hostOf(site.origin) : "Untitled"),
    description: (item.description ?? "").trim().slice(0, VAULT_LIMITS.description),
    website: kind === "login" ? (site?.origin ?? null) : null,
    match: kind === "login" ? (site?.match ?? "exact") : "exact",
    username: kind === "login" ? (item.username ?? "").trim().slice(0, VAULT_LIMITS.username) || null : null,
    keyName: keyName && SECRET_NAME.test(keyName) && !isReservedSecretName(keyName) ? keyName : null,
    accessFromConnection: true,
    missing: false,
  };
}

/**
 * One item a source just answered a write with (a login it now keeps, or one it changed), indexed at once as the
 * next sync would: the same row by (connection, the source's id), following the connection's access. Null when the
 * item can't be kept (`rowOf`).
 */
export async function indexSourceItem(
  db: Executor,
  connection: ConnectionRow,
  item: VaultSourceItem,
  now: Date,
  createdByAgentId?: string,
): Promise<ItemRow | null> {
  const row = rowOf(connection, item);
  if (!row) return null;
  const [kept] = await db
    .insert(vaultItems)
    .values({ ...row, createdAt: now, updatedAt: now, ...(createdByAgentId ? { createdByAgentId } : {}) })
    .onConflictDoUpdate({
      target: [vaultItems.connectionId, vaultItems.externalRef],
      set: {
        title: row.title,
        website: row.website,
        match: row.match,
        username: row.username,
        missing: false,
        updatedAt: now,
      },
    })
    .returning();
  return kept ?? null;
}

/** Why a connection failed, as a code people can act on. A seal that no longer opens means: connect it again. */
const failureOf = (error: unknown) =>
  error instanceof VaultSourceError
    ? error
    : error instanceof SealedValueError
      ? new VaultSourceError("auth_failed", "Connect it again.")
      : new VaultSourceError("unreachable", "Couldn't reach the password manager.");

/**
 * Reads one connection now. Returns the row as it ends and, when the source refused, why (also on the row). Never
 * throws for a source's refusal. A full Vault isn't one: the row says `too_many_items` and `error` stays null.
 */
export async function syncConnectionRow(
  deps: Pick<VaultDeps, "db" | "keyWrappers" | "sources" | "pubsub" | "now">,
  connection: ConnectionRow,
): Promise<{ row: ConnectionRow; error: VaultSourceError | null }> {
  const { db } = deps;
  const where = and(eq(vaultConnections.orgId, connection.orgId), eq(vaultConnections.id, connection.id));
  const ended = async (set: Partial<typeof vaultConnections.$inferInsert>, error: VaultSourceError | null) => {
    const [row] = await db
      .update(vaultConnections)
      .set({ ...set, updatedAt: vaultNow(deps) })
      .where(where)
      .returning();
    await publishVaultChanged(deps.pubsub, connection.orgId);
    return { row: row ?? { ...connection, ...set }, error } as { row: ConnectionRow; error: VaultSourceError | null };
  };

  const source = sourceOf(deps.sources, connection.kind);
  if (!source) {
    const error = new VaultSourceError("unsupported", "This server can't read this password manager any more.");
    return ended({ status: "error", errorCode: error.code }, error);
  }
  await db.update(vaultConnections).set({ status: "syncing" }).where(where);
  let listed: VaultSourceItem[];
  try {
    const opened = await sourceConnection(deps, connection);
    listed = await sourceCall((signal) => source.list(opened, signal));
  } catch (error) {
    const failure = failureOf(error);
    return ended({ status: "error", errorCode: failure.code }, failure);
  }

  const now = vaultNow(deps);
  const byRef = new Map<string, NonNullable<ReturnType<typeof rowOf>>>();
  for (const item of listed) {
    const row = rowOf(connection, item);
    if (row && !byRef.has(row.externalRef)) byRef.set(row.externalRef, row);
  }
  const existing = await db
    .select({ id: vaultItems.id, externalRef: vaultItems.externalRef, missing: vaultItems.missing })
    .from(vaultItems)
    .where(and(eq(vaultItems.orgId, connection.orgId), eq(vaultItems.connectionId, connection.id)));
  const known = new Set(existing.map((r) => r.externalRef));
  // The workspace's cap counts every item (this connection's missing ones too): the ones already here stay, and new
  // ones fill only what is left.
  const [{ others } = { others: 0 }] = await db
    .select({ others: sql<number>`count(*)::int` })
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.orgId, connection.orgId),
        or(isNull(vaultItems.connectionId), sql`${vaultItems.connectionId} <> ${connection.id}`),
      ),
    );
  const all = [...byRef.values()];
  const fresh = all.filter((r) => !known.has(r.externalRef));
  const room = Math.max(0, VAULT_MAX_ITEMS - others - existing.length);
  const rows = [...all.filter((r) => known.has(r.externalRef)), ...fresh.slice(0, room)];
  const full = fresh.length > room;
  // Missing: what the source no longer lists, whatever the cap kept out.
  const gone = existing.filter((r) => !r.missing && !byRef.has(r.externalRef ?? "")).map((r) => r.id);

  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      await tx
        .insert(vaultItems)
        .values(rows.slice(i, i + 200).map((r) => ({ ...r, createdAt: now, updatedAt: now })))
        .onConflictDoUpdate({
          target: [vaultItems.connectionId, vaultItems.externalRef],
          set: {
            kind: sql`excluded.kind`,
            title: sql`excluded.title`,
            website: sql`excluded.website`,
            match: sql`excluded.match`,
            username: sql`excluded.username`,
            // A variable name a person set here stays; a description too (both are theirs to edit, ADR 0144).
            keyName: sql`coalesce(${vaultItems.keyName}, excluded.key_name)`,
            missing: false,
            updatedAt: now,
          },
          setWhere: sql`(${vaultItems.kind}, ${vaultItems.title}, ${vaultItems.website}, ${vaultItems.match},
            ${vaultItems.username}, ${vaultItems.missing}) is distinct from
            (excluded.kind, excluded.title, excluded.website, excluded.match, excluded.username, false)
            or (${vaultItems.keyName} is null and excluded.key_name is not null)`,
        });
    }
    for (let i = 0; i < gone.length; i += 1000) {
      await tx
        .update(vaultItems)
        .set({ missing: true, updatedAt: now })
        .where(and(eq(vaultItems.orgId, connection.orgId), inArray(vaultItems.id, gone.slice(i, i + 1000))));
    }
  });
  if (full) return ended({ status: "error", errorCode: VAULT_FULL, syncedAt: now }, null);
  return ended({ status: "ready", errorCode: null, syncedAt: now }, null);
}

/**
 * Queues a read of every connection last read more than 10 minutes ago, once per connection and 10-minute window
 * (the window in its dedupe key). Left out: closed workspaces, refused sign-ins waiting for a person, and personal
 * connections whose owner is no longer a member.
 */
export async function enqueueVaultSyncs(db: Database, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - VAULT_SYNC_EVERY_MS);
  const due = await db
    .select({ id: vaultConnections.id, orgId: vaultConnections.orgId })
    .from(vaultConnections)
    .innerJoin(organizations, eq(organizations.id, vaultConnections.orgId))
    .where(
      and(
        not(closedOrg),
        or(isNull(vaultConnections.syncedAt), lt(vaultConnections.syncedAt, before)),
        or(
          sql`${vaultConnections.status} <> 'error'`,
          isNull(vaultConnections.errorCode),
          not(inArray(vaultConnections.errorCode, WAITS_FOR_PERSON)),
        ),
        or(
          isNull(vaultConnections.ownerUserId),
          sql`exists (select 1 from organization_members m
            where m.org_id = ${vaultConnections.orgId} and m.user_id = ${vaultConnections.ownerUserId})`,
        ),
      ),
    );
  const window = Math.floor(now.getTime() / VAULT_SYNC_EVERY_MS);
  for (const connection of due) {
    await enqueue(db, {
      orgId: connection.orgId,
      kind: VAULT_SYNC_JOB,
      payload: { connectionId: connection.id },
      dedupeKey: `${VAULT_SYNC_JOB}:${connection.id}:${window}`,
      maxAttempts: 1,
    });
  }
  return due.length;
}

/** The job: reads one connection of the workspace again, if it is still there. A refusal stays on the connection. */
export async function runVaultSync(deps: VaultDeps, orgId: string, connectionId: string): Promise<void> {
  if (!UUID.test(connectionId)) return;
  const [row] = await deps.db
    .select()
    .from(vaultConnections)
    .where(and(eq(vaultConnections.orgId, orgId), eq(vaultConnections.id, connectionId)));
  if (!row) return;
  await syncConnectionRow(deps, row);
}

/**
 * Connecting a password manager to the Vault (ADR 0144). The source checks what the person typed and says what to
 * keep: settings safe to show (`config`) and credentials (`secret`), sealed here at once and never sent back. A
 * personal connection is its owner's alone; a team one is for who manages credentials. Its items follow its access
 * by default (`access_from_connection`). A source's refusal comes out as its `VaultSourceError`, for the route to say
 * in the person's language.
 */
import { VaultSourceError } from "@agenteschat/adapters";
import { and, count, type Executor, eq, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { UUID } from "../authority";
import { NotFoundError, ValidationError } from "../errors";
import { publishVaultChanged } from "../events";
import {
  type ConnectionRow,
  cleanAccess,
  DEFAULT_CONNECTION_ACCESS,
  scopeOf,
  type VaultViewer,
  viewerManages,
} from "./access";
import { cleanScope, teamNeedsPermission, vaultViewer } from "./items";
import { sealConnectionSecret, sourceCall, sourceOf } from "./seal";
import {
  VAULT_LIMITS,
  type VaultConnectInput,
  type VaultConnection,
  type VaultConnectionPatch,
  type VaultDeps,
  vaultNow,
} from "./service";
import { syncConnectionRow } from "./sync";
import { connectionView, sourceNameOf } from "./views";

const { vaultConnections, vaultItems } = schema;

const notFound = () => new NotFoundError("Not found", "vault.not_found");

/** A connection the person manages; any other (someone else's, or a team one without the permission) is not found. */
async function managedConnection(db: Executor, orgId: string, connectionId: string, viewer: VaultViewer | null) {
  if (!UUID.test(connectionId)) throw notFound();
  const [row] = await db
    .select()
    .from(vaultConnections)
    .where(and(eq(vaultConnections.orgId, orgId), eq(vaultConnections.id, connectionId)));
  if (!row || (viewer && !viewerManages(row.ownerUserId, viewer))) throw notFound();
  return row;
}

async function itemCount(db: Executor, row: ConnectionRow) {
  const [found] = await db
    .select({ n: count() })
    .from(vaultItems)
    .where(and(eq(vaultItems.orgId, row.orgId), eq(vaultItems.connectionId, row.id), eq(vaultItems.missing, false)));
  return found?.n ?? 0;
}

async function view(deps: VaultDeps, row: ConnectionRow, viewer: VaultViewer | null): Promise<VaultConnection> {
  return connectionView(deps.sources, row, viewer, await itemCount(deps.db, row));
}

/** What a source asks for, as strings only (what a form sends). */
function inputOf(raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) if (typeof value === "string") out[key] = value;
  return out;
}

/** What a source kept to show: strings only, nothing long. */
function configOf(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (typeof value === "string") out[key] = value.slice(0, 2048);
  return out;
}

function auditConnection(
  db: Executor,
  userId: string,
  action: string,
  row: ConnectionRow,
  extra: Record<string, unknown> = {},
) {
  return recordAudit(db, {
    orgId: row.orgId,
    actor: { type: "person", id: userId },
    action,
    target: { type: "vault_connection", id: row.id },
    details: { kind: row.kind, label: row.label, scope: scopeOf(row.ownerUserId), ...extra },
  });
}

/**
 * Connects a source: checked with the provider, its credentials sealed, then its items read before this returns. A
 * refusal at either step leaves nothing behind and throws the source's `VaultSourceError`; so does any other failure
 * of that first read (the database's, say), thrown as it was.
 */
export async function connectVaultSource(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  input: VaultConnectInput,
): Promise<VaultConnection> {
  const { db } = deps;
  const viewer = await vaultViewer(db, userId, orgId);
  const scope = cleanScope(input.scope);
  if (scope === "team" && !viewer.manages) throw teamNeedsPermission();
  const source = sourceOf(deps.sources, input.kind);
  if (!source) throw new ValidationError("This server can't connect that password manager", "vault.source_unknown");
  const access = await cleanAccess(db, orgId, scope, input.access ?? DEFAULT_CONNECTION_ACCESS[scope]);
  const result = await sourceCall((signal) => source.connect(inputOf(input.input), signal, { orgId }));

  const ownerUserId = scope === "personal" ? userId : null;
  const id = Bun.randomUUIDv7();
  const sealed = await sealConnectionSecret(deps, { orgId, id, ownerUserId }, result.secret);
  const label = (result.label ?? "").trim().slice(0, VAULT_LIMITS.title) || sourceNameOf(deps.sources, input.kind);
  const [inserted] = await db
    .insert(vaultConnections)
    .values({
      id,
      orgId,
      kind: input.kind,
      ownerUserId,
      label,
      config: configOf(result.config ?? {}),
      ...sealed,
      ...access,
      status: "syncing",
      createdByUserId: userId,
    })
    .returning();
  if (!inserted) throw new Error("vault connection insert returned nothing");
  let row: ConnectionRow;
  try {
    const synced = await syncConnectionRow(deps, inserted);
    if (synced.error) throw synced.error;
    row = synced.row;
  } catch (error) {
    // Nothing half made, whatever stopped the first read (a source's refusal, the database): no row left `syncing`
    // with sealed credentials, nor the items it read (they go with it). The person connects again.
    await db
      .delete(vaultConnections)
      .where(and(eq(vaultConnections.orgId, orgId), eq(vaultConnections.id, id)))
      .catch(() => undefined);
    await publishVaultChanged(deps.pubsub, orgId);
    throw error;
  }
  await auditConnection(db, userId, "vault.connection_added", row);
  return view(deps, row, viewer);
}

/**
 * Changes a connection's default access, or connects it again with new credentials (checked first; its items are
 * read again). A refusal of the new credentials changes nothing and throws the source's `VaultSourceError`.
 */
export async function updateVaultConnection(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  connectionId: string,
  patch: VaultConnectionPatch,
): Promise<VaultConnection> {
  const { db } = deps;
  const viewer = await vaultViewer(db, userId, orgId);
  const current = await managedConnection(db, orgId, connectionId, viewer);
  const set: Partial<typeof vaultConnections.$inferInsert> = {};
  const fields: string[] = [];
  if (patch.access !== undefined) {
    Object.assign(set, await cleanAccess(db, orgId, scopeOf(current.ownerUserId), patch.access));
    fields.push("access");
  }
  if (patch.input !== undefined) {
    const source = sourceOf(deps.sources, current.kind);
    if (!source) throw new VaultSourceError("unsupported", "This server can't read this password manager any more.");
    const result = await sourceCall((signal) => source.connect(inputOf(patch.input), signal, { orgId }));
    Object.assign(set, await sealConnectionSecret(deps, current, result.secret), {
      label: (result.label ?? "").trim().slice(0, VAULT_LIMITS.title) || current.label,
      config: configOf(result.config ?? {}),
      status: "ready",
      errorCode: null,
    });
    fields.push("credentials");
  }
  if (fields.length === 0) return view(deps, current, viewer);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(vaultConnections)
      .set({ ...set, updatedAt: vaultNow(deps) })
      .where(and(eq(vaultConnections.orgId, orgId), eq(vaultConnections.id, current.id)))
      .returning();
    if (!row) throw notFound();
    await auditConnection(tx, userId, "vault.connection_changed", row, { fields });
    return row;
  });
  await publishVaultChanged(deps.pubsub, orgId);
  if (patch.input === undefined) return view(deps, updated, viewer);
  const { row, error } = await syncConnectionRow(deps, updated);
  if (error) throw error;
  return view(deps, row, viewer);
}

/**
 * Reads a connection's items now: a person who manages it ("Sync now"), or the server (`userId` null). A refusal
 * stays on the connection and, for a person, comes out as the source's `VaultSourceError`.
 */
export async function syncVaultConnection(
  deps: VaultDeps,
  userId: string | null,
  orgId: string,
  connectionId: string,
): Promise<VaultConnection> {
  const viewer = userId ? await vaultViewer(deps.db, userId, orgId) : null;
  const current = await managedConnection(deps.db, orgId, connectionId, viewer);
  const { row, error } = await syncConnectionRow(deps, current);
  if (error && viewer) throw error;
  return view(deps, row, viewer);
}

/** Disconnects a source: its credentials and every item read from it go. */
export async function deleteVaultConnection(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  connectionId: string,
): Promise<void> {
  const { db } = deps;
  const viewer = await vaultViewer(db, userId, orgId);
  const current = await managedConnection(db, orgId, connectionId, viewer);
  await db.transaction(async (tx) => {
    // Its items cascade (`vault_items.connection_id`), with their uses.
    await tx
      .delete(vaultConnections)
      .where(and(eq(vaultConnections.orgId, orgId), eq(vaultConnections.id, current.id)));
    await auditConnection(tx, userId, "vault.connection_removed", current);
  });
  await publishVaultChanged(deps.pubsub, orgId);
}

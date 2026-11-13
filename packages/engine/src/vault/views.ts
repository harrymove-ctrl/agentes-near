/**
 * Vault rows as people and agents see them (ADR 0144). Never a value: a contact's fields are the only thing opened
 * here, since they are meant to be read (by the people who see the item and by the agents who may use it).
 */
import { VAULT_READ_ONLY_CONFIG, type VaultSources } from "@agenteschat/adapters";
import { asc, type Executor, eq, schema } from "@agenteschat/db";
import {
  accessView,
  type ConnectionRow,
  effectiveColumns,
  type ItemRow,
  scopeOf,
  type VaultViewer,
  viewerManages,
} from "./access";
import { openContact, sourceOf } from "./seal";
import {
  VAULT_MAX_ITEMS,
  type VaultConnection,
  type VaultConnectionStatus,
  type VaultContactFields,
  type VaultDeps,
  type VaultItem,
  type VaultItemForAgent,
  type VaultItemKind,
  type VaultMatch,
  type VaultPlace,
  type VaultSourceInfo,
} from "./service";

const { vaultConnections, vaultItems } = schema;

/** A workspace's items (at most `VAULT_MAX_ITEMS`) and its connections, by id. */
export interface VaultState {
  items: ItemRow[];
  connections: Map<string, ConnectionRow>;
}

export async function loadVault(db: Executor, orgId: string): Promise<VaultState> {
  const items = await db
    .select()
    .from(vaultItems)
    .where(eq(vaultItems.orgId, orgId))
    .orderBy(asc(vaultItems.kind), asc(vaultItems.title), asc(vaultItems.id))
    .limit(VAULT_MAX_ITEMS);
  const connections = await db.select().from(vaultConnections).where(eq(vaultConnections.orgId, orgId));
  return { items, connections: new Map(connections.map((c) => [c.id, c])) };
}

export const connectionOf = (state: VaultState, item: ItemRow) =>
  item.connectionId ? state.connections.get(item.connectionId) : undefined;

/** A saved origin's host (`https://github.com` → `github.com`); the text itself when it isn't an address. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** A login or a key has a value to use: a built-in one sealed here, an external one in its source. */
export const hasValue = (item: ItemRow) =>
  item.kind !== "contact" && (item.connectionId !== null || item.secretCiphertext !== null);

/** A source's brand name (`1Password`), or its kind when this server doesn't have it any more. */
export function sourceNameOf(sources: VaultSources, kind: string): string {
  try {
    return sourceOf(sources, kind)?.describe().name ?? kind;
  } catch {
    return kind;
  }
}

/** This workspace's own Vault as a place: it always takes a new item. */
export const THE_VAULT: VaultPlace = { name: "the Vault", connectionId: null, label: null, writes: "yes" };

/** A connection's credential was refused a write: it only reads until a person connects it again. */
export const connectionReadOnly = (connection: Pick<ConnectionRow, "config">) =>
  connection.config[VAULT_READ_ONLY_CONFIG] === "true";

/** Where a connection's items are kept (none: the Vault itself), and whether a new login can go there. */
export function placeOf(sources: VaultSources, connection: ConnectionRow | undefined): VaultPlace {
  if (!connection) return THE_VAULT;
  const writes = connectionReadOnly(connection)
    ? "read_only"
    : sourceOf(sources, connection.kind)?.createLogin
      ? "yes"
      : "no";
  return {
    name: sourceNameOf(sources, connection.kind),
    connectionId: connection.id,
    label: connection.label,
    writes,
  };
}

/** The sources a person can connect here, as the app draws their cards. */
export function sourceInfos(sources: VaultSources): VaultSourceInfo[] {
  const out: VaultSourceInfo[] = [];
  for (const source of Object.values(sources)) {
    try {
      const d = source.describe();
      out.push({
        kind: d.kind,
        name: d.name,
        kinds: [...d.kinds],
        steps: [...d.steps],
        fields: d.fields.map((f) => ({ ...f, ...(f.choices ? { choices: f.choices.map((c) => ({ ...c })) } : {}) })),
        ...(d.warning ? { warning: d.warning } : {}),
        ...(d.helpUrl ? { helpUrl: d.helpUrl } : {}),
      });
    } catch {
      // A module's source that can't describe itself isn't offered.
    }
  }
  return out;
}

/** A contact's fields, or null (not a contact, nothing saved, or a seal that doesn't open here). */
export async function contactOf(deps: Pick<VaultDeps, "keyWrappers">, item: ItemRow) {
  return (await readContact(deps, item)).contact;
}

/**
 * A contact's fields, and whether its saved fields can't be read here (ADR 0144): sealed with a key this server no
 * longer has, or a row moved onto another owner, or not JSON. Such a contact is never merged onto or shown as empty:
 * a person saves it again. Not a contact, or nothing saved: no fields, and nothing unreadable.
 */
export async function readContact(
  deps: Pick<VaultDeps, "keyWrappers">,
  item: ItemRow,
): Promise<{ contact: VaultContactFields | null; unreadable: boolean }> {
  if (item.kind !== "contact" || !item.secretCiphertext) return { contact: null, unreadable: false };
  try {
    const contact = await openContact(deps, item);
    return contact ? { contact, unreadable: false } : { contact: null, unreadable: true };
  } catch {
    return { contact: null, unreadable: true };
  }
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/**
 * An item for a person; `viewer` null: nobody's rights (a system call). `contact: false` leaves a contact's fields
 * out (`contact: null`) without opening its seal: the list of the whole Vault (ADR 0144 §7); an item's page has them.
 */
export async function itemView(
  deps: Pick<VaultDeps, "keyWrappers" | "sources">,
  item: ItemRow,
  connection: ConnectionRow | undefined,
  viewer: VaultViewer | null,
  options: { contact?: boolean } = {},
): Promise<VaultItem> {
  const manages = viewer !== null && viewerManages(item.ownerUserId, viewer);
  const value = hasValue(item);
  return {
    id: item.id,
    kind: item.kind as VaultItemKind,
    scope: scopeOf(item.ownerUserId),
    ownerUserId: item.ownerUserId,
    title: item.title,
    description: item.description,
    website: item.website,
    match: item.match as VaultMatch,
    username: item.username,
    keyName: item.keyName,
    keyHint: item.keyHint,
    hasSecret: value,
    contact: options.contact === false ? null : await contactOf(deps, item),
    connectionId: item.connectionId,
    sourceName: connection ? sourceNameOf(deps.sources, connection.kind) : null,
    accessFromConnection: item.accessFromConnection,
    access: accessView(effectiveColumns(item, connection), item.ownerUserId),
    missing: item.missing,
    createdByUserId: item.createdByUserId,
    createdByAgentId: item.createdByAgentId,
    lastUsedAt: iso(item.lastUsedAt),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    can: {
      edit: manages,
      // An external item comes back at the next sync: it goes from its source, or here once it is gone from it.
      delete: manages && (item.connectionId === null || item.missing),
    },
  };
}

/** An item for an agent: what it needs to pick and use it, never a value. */
export function agentView(
  item: ItemRow,
  contact: VaultContactFields | null,
  place: VaultPlace = THE_VAULT,
): VaultItemForAgent {
  return {
    id: item.id,
    kind: item.kind as VaultItemKind,
    scope: scopeOf(item.ownerUserId),
    title: item.title,
    description: item.description,
    website: item.website,
    match: item.match as VaultMatch,
    username: item.username,
    keyName: item.keyName,
    contact: item.kind === "contact" ? (contact ?? {}) : null,
    place,
    ...(item.previousSecrets.length > 0 ? { earlier: item.previousSecrets.length } : {}),
  };
}

/** A connection for a person: its settings safe to show, never its secret. */
export function connectionView(
  sources: VaultSources,
  row: ConnectionRow,
  viewer: VaultViewer | null,
  itemCount: number,
): VaultConnection {
  return {
    id: row.id,
    kind: row.kind,
    name: sourceNameOf(sources, row.kind),
    readOnly: connectionReadOnly(row),
    scope: scopeOf(row.ownerUserId),
    ownerUserId: row.ownerUserId,
    label: row.label,
    config: { ...row.config },
    access: accessView(row, row.ownerUserId),
    status: row.status as VaultConnectionStatus,
    errorCode: row.status === "error" ? row.errorCode : null,
    itemCount,
    syncedAt: iso(row.syncedAt),
    can: { edit: viewer !== null && viewerManages(row.ownerUserId, viewer) },
  };
}

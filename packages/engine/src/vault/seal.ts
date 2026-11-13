/**
 * Vault values at rest (ADR 0144): envelope encryption with the installation's key wrapper (ADR 0007), each value
 * bound to where it belongs. An item's seal names its workspace, its id, its owner (or the team) and its version, so
 * a row copied to another workspace or another owner, or an old ciphertext put back, doesn't open. A connection's
 * seal names its workspace, id and owner. Nothing here keeps a plaintext.
 */
import {
  type VaultConnection as SourceConnection,
  type VaultSecretField,
  type VaultSource,
  VaultSourceError,
  type VaultSources,
} from "@agenteschat/adapters";
import { openSecret, sealSecret } from "../crypto";
import type { ConnectionRow, ItemRow } from "./access";
import { CONTACT_FIELDS, type VaultContactFields, type VaultDeps } from "./service";

export const itemAad = (orgId: string, itemId: string, ownerUserId: string | null, version: number) =>
  `vault-item|${orgId}|${itemId}|${ownerUserId ?? "team"}|${version}`;

export const connectionAad = (orgId: string, connectionId: string, ownerUserId: string | null) =>
  `vault-connection|${orgId}|${connectionId}|${ownerUserId ?? "team"}`;

/** The columns of a sealed item value. */
export interface SealedItemColumns {
  secretCiphertext: string;
  wrappedDataKey: string;
  kekId: string;
  secretVersion: number;
}

/** Seals an item's value as `version` (a new value always takes the next one). */
export async function sealItemValue(
  deps: Pick<VaultDeps, "keyWrapper">,
  item: { orgId: string; id: string; ownerUserId: string | null },
  version: number,
  plaintext: string,
): Promise<SealedItemColumns> {
  const sealed = await sealSecret(deps.keyWrapper, plaintext, itemAad(item.orgId, item.id, item.ownerUserId, version));
  return {
    secretCiphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    kekId: sealed.kekId,
    secretVersion: version,
  };
}

/** A built-in item's value, or null when it has none. Throws when the seal doesn't match its row. */
export async function openItemValue(
  deps: Pick<VaultDeps, "keyWrappers">,
  item: Pick<
    ItemRow,
    "orgId" | "id" | "ownerUserId" | "secretVersion" | "secretCiphertext" | "wrappedDataKey" | "kekId"
  >,
): Promise<string | null> {
  if (!item.secretCiphertext || !item.wrappedDataKey || !item.kekId) return null;
  return openSecret(
    deps.keyWrappers,
    { ciphertext: item.secretCiphertext, wrappedDataKey: item.wrappedDataKey, kekId: item.kekId },
    itemAad(item.orgId, item.id, item.ownerUserId, item.secretVersion),
  );
}

/** A contact's fields, kept as they are: only the known ones, trimmed strings, empty ones left out. */
export function contactFieldsOf(value: unknown): VaultContactFields {
  const out: VaultContactFields = {};
  if (!value || typeof value !== "object") return out;
  for (const key of CONTACT_FIELDS) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string" && field.trim()) out[key] = field.trim();
  }
  return out;
}

/** A contact item's fields (sealed as JSON), or null when it has none. */
export async function openContact(
  deps: Pick<VaultDeps, "keyWrappers">,
  item: Parameters<typeof openItemValue>[1],
): Promise<VaultContactFields | null> {
  const json = await openItemValue(deps, item);
  if (json === null) return null;
  try {
    return contactFieldsOf(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Seals what a source returned to keep (its `secret`). */
export async function sealConnectionSecret(
  deps: Pick<VaultDeps, "keyWrapper">,
  connection: { orgId: string; id: string; ownerUserId: string | null },
  secret: Record<string, string>,
) {
  const sealed = await sealSecret(
    deps.keyWrapper,
    JSON.stringify(secret),
    connectionAad(connection.orgId, connection.id, connection.ownerUserId),
  );
  return { secretCiphertext: sealed.ciphertext, wrappedDataKey: sealed.wrappedDataKey, kekId: sealed.kekId };
}

/** A connection as its source reads it: its config and its secret, opened for this call only. */
export async function sourceConnection(
  deps: Pick<VaultDeps, "keyWrappers">,
  row: ConnectionRow,
): Promise<SourceConnection> {
  const json = await openSecret(
    deps.keyWrappers,
    { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    connectionAad(row.orgId, row.id, row.ownerUserId),
  );
  const parsed = JSON.parse(json) as unknown;
  const secret: Record<string, string> = {};
  if (parsed && typeof parsed === "object")
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") secret[key] = value;
  return { id: row.id, orgId: row.orgId, config: { ...row.config }, secret };
}

/**
 * The source of a kind, only when this server has one by that name: a kind comes from a request or a row, so a name
 * like `constructor` or `__proto__` must find nothing rather than something on the object's prototype (ADR 0144).
 */
export function sourceOf(sources: VaultSources, kind: unknown): VaultSource | undefined {
  return typeof kind === "string" && Object.hasOwn(sources, kind) ? sources[kind] : undefined;
}

/**
 * A login's password or a key's value, read now: a built-in item's opened, an external one's asked of its source.
 * Null when there is none. A source's failure throws its `VaultSourceError`; a source no longer installed throws one
 * too (`unsupported`).
 */
export async function readItemValue(
  deps: Pick<VaultDeps, "keyWrappers" | "sources">,
  item: ItemRow,
  connection: ConnectionRow | undefined,
): Promise<string | null> {
  if (!item.connectionId) return openItemValue(deps, item);
  const source = connection ? sourceOf(deps.sources, connection.kind) : undefined;
  if (!connection || !source || !item.externalRef)
    throw new VaultSourceError("unsupported", "This source isn't available on this server.");
  const field: VaultSecretField = item.kind === "key" ? "key" : "password";
  const ref = item.externalRef;
  // Credentials that no longer open here (another server key, a moved row): the person connects it again.
  const opened = await sourceConnection(deps, connection).catch(() => {
    throw new VaultSourceError("auth_failed", "Connect this password manager again.");
  });
  const value = await sourceCall((signal) => source.reveal(opened, ref, field, signal));
  return value === "" ? null : value;
}

/**
 * The longest one call into a source may take, all its requests and its key derivation included (ADR 0144): past
 * it the signal aborts, the source stops (or never starts) its work, and the call fails as `unreachable`.
 */
export const VAULT_SOURCE_DEADLINE_MS = 60_000;

/**
 * A call into a source, with a signal that aborts at the deadline: its own failures as they are (coded, in our
 * words), anything else as `unreachable` with its text dropped, since a provider's message may carry a token.
 */
export async function sourceCall<T>(
  work: (signal: AbortSignal) => Promise<T>,
  deadlineMs = VAULT_SOURCE_DEADLINE_MS,
): Promise<T> {
  const signal = AbortSignal.timeout(deadlineMs);
  try {
    return await work(signal);
  } catch (error) {
    if (error instanceof VaultSourceError) throw error;
    throw new VaultSourceError("unreachable", "Couldn't reach the password manager.");
  }
}

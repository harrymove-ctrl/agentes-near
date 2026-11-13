import type {
  VaultAccess,
  VaultContactFields,
  VaultItem,
  VaultItemKind,
  VaultMatch,
  VaultScope,
} from "@agenteschat/client";
import type { IconName } from "@agenteschat/ui";

/*
 * The Vault's words and rules as the web reads them (ADR 0144): what a row says, what a search finds, the access a new
 * item starts with, and the checks a form makes before the server makes them again.
 */

/** A key's variable name: the server's `SECRET_NAME` (UPPER_SNAKE, a letter first, 64 at most). */
export const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The contact fields, in the order a form shows them (two columns: name beside company, and so on). */
export const CONTACT_FIELDS = [
  "fullName",
  "company",
  "email",
  "phone",
  "document",
  "country",
  "address",
  "address2",
  "city",
  "region",
  "postalCode",
] as const satisfies readonly (keyof VaultContactFields)[];

export type ContactField = (typeof CONTACT_FIELDS)[number];

/** Limits the server checks too (spec of the API): the form stops there instead of failing on Save. */
export const LIMITS = { title: 120, description: 300, website: 2048, username: 200, contact: 300 } as const;

export const KIND_ICON: Record<VaultItemKind, IconName> = { login: "globe", key: "key", contact: "person" };

/** The access a new item starts with: a personal one for any agent its owner asks, a team one seen by everyone. */
export function defaultAccess(scope: VaultScope, agentIds: string[] = []): VaultAccess {
  return scope === "personal"
    ? { everyone: false, roleIds: [], userIds: [], allAgents: agentIds.length === 0, agentIds }
    : { everyone: true, roleIds: [], userIds: [], allAgents: false, agentIds };
}

/**
 * `https://host[:port]` for what a person types (`acme.example/login` reads as HTTPS), or null: only HTTPS ever fills,
 * as the server's `vaultOrigin` says.
 */
export function vaultOrigin(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > LIMITS.website) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** `https://www.acme.example` → `www.acme.example`; null for none. */
export function hostOf(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(website).host;
  } catch {
    return website;
  }
}

/** Folded for search: no accents, no case. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Whether an item has `query` in what a person would look it up by (never a value). A contact by its title and
 * description: the list carries no contact's fields (ADR 0144 §7).
 */
export function matchesQuery(item: VaultItem, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  return [item.title, item.description, hostOf(item.website), item.username, item.keyName, item.sourceName]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .some((v) => fold(v).includes(q));
}

/** Items in the order a list shows them: the most recently used first, then by name. */
export function sortItems(items: VaultItem[], locale: string): VaultItem[] {
  const used = (i: VaultItem) => i.lastUsedAt ?? "";
  return [...items].sort((a, b) => used(b).localeCompare(used(a)) || a.title.localeCompare(b.title, locale));
}

/** The largest CSV file an import takes (the server's 2 MB). */
export const CSV_MAX_BYTES = 2 * 1024 * 1024;

/** The match a login starts with: one address. */
export const DEFAULT_MATCH: VaultMatch = "exact";

/**
 * The Vault (ADR 0144): logins, keys and contacts a workspace keeps for its agents. This file holds what the rest of
 * the engine and the API see: the dependencies, the shapes people and agents get, and the inputs they send. The
 * shapes match `packages/client/src/vault/types.ts`, so a route hands them over as they are.
 *
 * A value (a password, a key) never appears in any of these shapes, nor in any answer to a person once it is saved
 * (§2): agents get one only through `releaseVaultLogin`/`releaseVaultKeys`, on their way into a box sealed for their
 * own computer.
 */
import type { KeyWrapper, PubSub, VaultMatch, VaultOriginRule, VaultSources } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";

export type { VaultMatch, VaultOriginRule } from "@agenteschat/adapters";

export interface VaultDeps {
  db: Database;
  /** Seals new values. */
  keyWrapper: KeyWrapper;
  /** Opens values sealed with any of these (the current one first, then older ones). */
  keyWrappers: KeyWrapper[];
  /** External sources by kind (adapters); the built-in source is this module. */
  sources: VaultSources;
  pubsub?: PubSub;
  now?: () => Date;
}

/** The run an agent uses the Vault in: who is behind it decides what it may use. */
export interface VaultRun {
  orgId: string;
  agentId: string;
  runId: string;
}

export type VaultItemKind = "login" | "key" | "contact";
export const VAULT_ITEM_KINDS: readonly VaultItemKind[] = ["login", "key", "contact"];
export type VaultScope = "personal" | "team";

/** Who has access to an item (or the default of a connection's items). */
export interface VaultAccess {
  /** Team items: everyone in the workspace. Always false for personal ones. */
  everyone: boolean;
  roleIds: string[];
  userIds: string[];
  /** Every agent may use it (a personal one: any agent, when its owner is the one asking). */
  allAgents: boolean;
  agentIds: string[];
}

/** A contact's fields. Not secret (agents read and type them), sealed at rest anyway: they are personal data. */
export interface VaultContactFields {
  fullName?: string;
  company?: string;
  /** A tax id of any country. */
  document?: string;
  email?: string;
  phone?: string;
  address?: string;
  address2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export const CONTACT_FIELDS = [
  "fullName",
  "company",
  "document",
  "email",
  "phone",
  "address",
  "address2",
  "city",
  "region",
  "postalCode",
  "country",
] as const satisfies readonly (keyof VaultContactFields)[];

/** An item as a person sees it. */
export interface VaultItem {
  id: string;
  kind: VaultItemKind;
  scope: VaultScope;
  ownerUserId: string | null;
  title: string;
  description: string;
  website: string | null;
  match: VaultMatch;
  username: string | null;
  keyName: string | null;
  keyHint: string | null;
  hasSecret: boolean;
  /** A contact's fields on its own page (`getVaultItem`); null in the list (`listVault`), and for logins and keys. */
  contact: VaultContactFields | null;
  connectionId: string | null;
  sourceName: string | null;
  accessFromConnection: boolean;
  /** The access that applies now (its connection's when `accessFromConnection`). */
  access: VaultAccess;
  missing: boolean;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  can: { edit: boolean; delete: boolean };
}

/** What a use records: an agent's fill, key or read, a person's or an agent's create or edit. */
export const VAULT_USE_ACTIONS = ["fill", "key", "read", "create", "edit"] as const;
export type VaultUseAction = (typeof VAULT_USE_ACTIONS)[number];

export interface VaultUse {
  id: string;
  action: VaultUseAction;
  agentId: string | null;
  userId: string | null;
  onBehalfOfUserId: string | null;
  routineName: string | null;
  origin: string | null;
  at: string;
}

export interface VaultItemDetail extends VaultItem {
  /** The newest 30. */
  uses: VaultUse[];
  /**
   * A contact whose saved fields can't be read here (sealed with a key this server no longer has, or a row moved):
   * `contact` is null and a person saves its fields again.
   */
  unreadable: boolean;
}

export type VaultConnectionStatus = "ready" | "error" | "syncing";

/** A connection as a person sees it: never its secret. */
export interface VaultConnection {
  id: string;
  kind: string;
  name: string;
  /** Its credential may only read: agents save nothing there until a person connects it again with one that writes. */
  readOnly: boolean;
  scope: VaultScope;
  ownerUserId: string | null;
  label: string;
  config: Record<string, string>;
  access: VaultAccess;
  status: VaultConnectionStatus;
  errorCode: string | null;
  itemCount: number;
  syncedAt: string | null;
  can: { edit: boolean };
}

export interface VaultConnectField {
  id: string;
  kind: "text" | "secret" | "url" | "email" | "choice";
  label: string;
  required: boolean;
  placeholder?: string;
  choices?: { value: string; label: string }[];
  initial?: string;
}

export interface VaultSourceInfo {
  kind: string;
  name: string;
  kinds: VaultItemKind[];
  steps: string[];
  fields: VaultConnectField[];
  warning?: string;
  helpUrl?: string;
}

export interface VaultOverview {
  items: VaultItem[];
  connections: VaultConnection[];
  sources: VaultSourceInfo[];
  /** The viewer may create team items and team connections (`manage_credentials`). */
  canManageTeam: boolean;
}

export interface VaultItemInput {
  kind: VaultItemKind;
  scope: VaultScope;
  title: string;
  description?: string;
  website?: string;
  match?: VaultMatch;
  username?: string;
  /** Login password or key value. */
  secret?: string;
  keyName?: string;
  contact?: VaultContactFields;
  access?: VaultAccess;
}

export interface VaultItemPatch {
  title?: string;
  description?: string;
  website?: string;
  match?: VaultMatch;
  username?: string;
  /** A new value; absent keeps the saved one. */
  secret?: string;
  keyName?: string;
  contact?: VaultContactFields;
  access?: VaultAccess;
  /** External items: back to the connection's access. */
  accessFromConnection?: boolean;
}

export type VaultImportSkip = "duplicate" | "not_https" | "no_password" | "invalid";
export type VaultCsvFormat = "chrome" | "1password" | "bitwarden" | "generic";

export interface VaultImportResult {
  added: number;
  updated: number;
  skipped: { reason: VaultImportSkip; count: number }[];
  format: VaultCsvFormat;
}

export interface VaultConnectInput {
  kind: string;
  scope: VaultScope;
  input: Record<string, string>;
  access?: VaultAccess;
}

export interface VaultConnectionPatch {
  access?: VaultAccess;
  /** New credentials (reconnect). */
  input?: Record<string, string>;
}

/** "Save to the Vault" on a secret request's card, sent after the box was delivered. */
export interface SecretToVaultInput {
  value: string;
  /**
   * Logins: the username the person kept on the card ("" = none, even when the agent suggested one). Absent: the
   * request's own.
   */
  username?: string;
  scope: VaultScope;
  allAgents: boolean;
  agentIds: string[];
}

/**
 * Where an item is kept, as an agent reads it: this workspace's own Vault, or a connected password manager by its
 * brand name and what the connection reads (a vault's or a folder's name).
 */
export interface VaultPlace {
  /** `the Vault`, or the password manager's brand name (`1Password`). */
  name: string;
  connectionId: string | null;
  label: string | null;
  /**
   * Whether an agent's new login can be kept there: `read_only` when the connection's credential may only read, `no`
   * when the source never takes one.
   */
  writes: "yes" | "read_only" | "no";
}

/** A connected password manager an agent is told of without using it: where it is, whose, and whether it holds items. */
export interface VaultUnreached {
  place: VaultPlace;
  scope: VaultScope;
  hasItems: boolean;
}

/** An item as an agent sees it: never a value. `contact` only for contacts (their fields are meant for agents). */
export interface VaultItemForAgent {
  id: string;
  kind: VaultItemKind;
  scope: VaultScope;
  title: string;
  description: string;
  website: string | null;
  match: VaultMatch;
  username: string | null;
  keyName: string | null;
  contact: VaultContactFields | null;
  place: VaultPlace;
  /** Values a made password replaced, kept for `undo`. */
  earlier?: number;
}

/**
 * What an agent may change (`vault_save`): without `itemId`, a new contact (personal to the person behind the run);
 * with one, an item it may use: a contact's title and fields, a login's username, any item's description (a team
 * item only when the person behind the run manages credentials). Built-in items only.
 */
export interface VaultAgentChange {
  itemId?: string;
  title?: string;
  description?: string;
  /** Logins only. */
  username?: string;
  /** Contacts only: the fields to set (an empty string clears one, an absent one stays). */
  contact?: VaultContactFields;
}

export interface VaultAgentResult {
  outcome: "created" | "updated" | "deleted";
  item: VaultItemForAgent;
  /** Why it is kept where it is (`item.place`), when a rule chose the place: an English clause for the agent. */
  why?: string;
}

/** What `releaseVaultLogin` gives the tool that seals it for the computer. */
export interface VaultReleasedLogin {
  item: VaultItemForAgent;
  password: string;
  rule: VaultOriginRule;
}

/** Most items one workspace keeps: what every check loads and filters in code. */
export const VAULT_MAX_ITEMS = 5000;
/** Field limits (the API checks the same). */
export const VAULT_LIMITS = {
  title: 120,
  description: 300,
  website: 2048,
  username: 200,
  contactField: 300,
  roles: 100,
  people: 500,
  agents: 200,
  csvBytes: 2 * 1024 * 1024,
  csvRows: 5000,
} as const;

export const vaultNow = (deps: Pick<VaultDeps, "now">) => deps.now?.() ?? new Date();

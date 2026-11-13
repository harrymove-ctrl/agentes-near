import { isIP } from "node:net";
import {
  type ComposioClient,
  type KeyWrapper,
  type MailAccountRef,
  type MailAdapters,
  MailError,
  type MailPreset,
  type MailProvider,
  type MailTestError,
} from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notInArray,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { countComposioConnection } from "../connector-usage";
import { composioToolkitUrl } from "../connectors/presets";
import { openSecret, sealSecret, sha256 } from "../crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { isBlockedAddress, type ResolveHost, resolveHostDns } from "../net-guard";
import { requirePermission } from "../organizations";
import { closedRefusal, orgStanding } from "../standing";
import { isEmailAddress, normalizeAddress } from "./text";
import { restartMailWatches } from "./watches";

const { mailAccounts, mailAgentPolicies, mailWatches, agentScopes, connectorConnections, users } = schema;

export type MailAccountRow = typeof mailAccounts.$inferSelect;

/** What the mail code needs (accounts, tools, inbound). */
export interface MailDeps {
  db: Database;
  /** Current wrapper first (seals), then legacy ones (open only). */
  keyWrappers: KeyWrapper[];
  /** Absent or null members = that path is off on this server. */
  mail?: MailAdapters | null;
  /** Public base URL, for Composio's callback. */
  publicUrl: string;
  /** DNS for the SSRF guard on custom IMAP/SMTP hosts (tests: fake). */
  resolveHost?: ResolveHost;
  now?: () => Date;
  /** Between the callback's reads of a sign-in that is still pending (default 1 s; tests: 0). */
  composioPollMs?: number;
}

export interface MailAccountView {
  id: string;
  provider: "gmail" | "outlook" | "imap";
  via: "composio" | "imap";
  address: string;
  label: string;
  status: "pending" | "active" | "needs_reconnect";
  lastError: string | null;
  preset: string | null;
  createdAt: string;
  /** Actions turned off for every agent (see `MAIL_ACTIONS`). */
  offActions: MailAction[];
  /** Actions that always ask a person in this mailbox (only `draft` and `organize` can; sends and deletes always do). */
  askActions: MailAction[];
  /** Other addresses of this mailbox (replies go out from the one a message arrived at). */
  aliases: string[];
  /** What new mail goes out from; null = `address`. */
  defaultFrom: string | null;
  /** Who connected it: the only person who gives agents access to it (ADR 0038). */
  ownerUserId: string | null;
  agents: { agentId: string; level: "read" | "read_write"; canDelete: boolean }[];
}

/** What people turn on or off for a mailbox ("O que faz"); each tool belongs to one. */
export const MAIL_ACTIONS = [
  "search",
  "read",
  "folders",
  "draft",
  "organize",
  "send",
  "reply",
  "forward",
  "delete",
] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];
/** The actions that can be made to ask (the rest read, or always ask). */
export const ASKABLE_MAIL_ACTIONS: readonly MailAction[] = ["draft", "organize"];

export const mailAccountAad = (orgId: string, id: string) => `mail-account|${orgId}|${id}`;
/** Our Composio user id for an organization. */
export const composioUserId = (orgId: string) => `org_${orgId}`;
const COMPOSIO_USER = /^org_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The organization of one of our Composio user ids (`composioUserId`), or null for anything else. */
export const orgOfComposioUser = (userId: string) => COMPOSIO_USER.exec(userId)?.[1] ?? null;
/** `from=desktop`: started in the desktop app's window, so the callback hands the return back to the app. */
export const composioCallbackUrl = (publicUrl: string, accountId: string, desktop = false) =>
  `${publicUrl.replace(/\/$/, "")}/api/app/mail/composio/callback?account=${encodeURIComponent(accountId)}${desktop ? "&from=desktop" : ""}`;

/** The mail scopes an agent can hold on one mailbox (`agent_scopes.connection_id` = the account). */
export const MAIL_SCOPES = {
  read: "mail:read",
  draft: "mail:draft",
  send: "mail:send",
  organize: "mail:organize",
  delete: "mail:delete",
} as const;
export const ALL_MAIL_SCOPES: string[] = Object.values(MAIL_SCOPES);

/** Level and delete flag from an agent's mail scopes on one mailbox. */
export function levelOf(scopes: Set<string>): { level: "none" | "read" | "read_write"; canDelete: boolean } {
  const write = [MAIL_SCOPES.draft, MAIL_SCOPES.send, MAIL_SCOPES.organize].some((s) => scopes.has(s));
  const level = write ? "read_write" : scopes.has(MAIL_SCOPES.read) ? "read" : "none";
  return { level, canDelete: level !== "none" && scopes.has(MAIL_SCOPES.delete) };
}

/** Agents' mail grants per account (account id → agent id → scopes). */
export async function mailGrants(db: Database, orgId: string, accountIds: string[]) {
  const out = new Map<string, Map<string, Set<string>>>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({ connectionId: agentScopes.connectionId, agentId: agentScopes.agentId, scope: agentScopes.scope })
    .from(agentScopes)
    .where(
      and(
        eq(agentScopes.orgId, orgId),
        inArray(agentScopes.connectionId, accountIds),
        like(agentScopes.scope, "mail:%"),
      ),
    );
  for (const r of rows) {
    if (!r.connectionId) continue;
    const byAgent = out.get(r.connectionId) ?? new Map<string, Set<string>>();
    const set = byAgent.get(r.agentId) ?? new Set<string>();
    set.add(r.scope);
    byAgent.set(r.agentId, set);
    out.set(r.connectionId, byAgent);
  }
  return out;
}

export function mailAccountView(row: MailAccountRow, grants?: Map<string, Set<string>>): MailAccountView {
  const agents: MailAccountView["agents"] = [];
  for (const [agentId, scopes] of grants ?? []) {
    const { level, canDelete } = levelOf(scopes);
    if (level !== "none") agents.push({ agentId, level, canDelete });
  }
  return {
    id: row.id,
    provider: row.provider as MailAccountView["provider"],
    via: row.via as MailAccountView["via"],
    address: row.address,
    label: row.label,
    status: row.status as MailAccountView["status"],
    lastError: row.lastError,
    preset: row.preset,
    createdAt: row.createdAt.toISOString(),
    offActions: row.offActions.filter((a): a is MailAction => (MAIL_ACTIONS as readonly string[]).includes(a)),
    askActions: row.askActions.filter((a): a is MailAction => (ASKABLE_MAIL_ACTIONS as readonly string[]).includes(a)),
    aliases: row.aliases,
    defaultFrom: row.defaultFrom,
    ownerUserId: row.createdByUserId,
    agents,
  };
}

/** Every address a mailbox sends as: its own first, then its aliases. */
export const mailboxAddresses = (row: Pick<MailAccountRow, "address" | "aliases">) => [
  ...new Set([row.address, ...row.aliases].filter(Boolean)),
];

/** At most this many aliases per mailbox. */
export const MAX_MAIL_ALIASES = 20;

/** Aliases as stored: lowercase, valid, without the mailbox's own address, no repeats; throws on an invalid one. */
export function normalizeAliases(address: string, input: string[]) {
  const out: string[] = [];
  for (const raw of input) {
    const a = normalizeAddress(raw);
    if (!a) continue;
    if (!isEmailAddress(a))
      throw new ValidationError(`"${raw}" is not an email address`, "mail.invalid_alias", { value: raw });
    if (a !== address && !out.includes(a)) out.push(a);
  }
  if (out.length > MAX_MAIL_ALIASES)
    throw new ValidationError(`At most ${MAX_MAIL_ALIASES} addresses`, "mail.too_many_aliases");
  return out;
}

/** The org's mailboxes (not disconnected), oldest first. */
export async function orgMailAccounts(db: Database, orgId: string) {
  return db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.orgId, orgId), isNull(mailAccounts.revokedAt)))
    .orderBy(asc(mailAccounts.createdAt), asc(mailAccounts.id));
}

export async function listMailAccounts(db: Database, actorId: string, orgId: string): Promise<MailAccountView[]> {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await orgMailAccounts(db, orgId);
  const grants = await mailGrants(
    db,
    orgId,
    rows.map((r) => r.id),
  );
  return rows.map((r) => mailAccountView(r, grants.get(r.id)));
}

/** The refusal when someone other than who connected a mailbox would widen what agents do with it (ADR 0038). */
export async function mailOwnerOnlyError(db: Database, account: { address: string; createdByUserId: string | null }) {
  const [owner] = account.createdByUserId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, account.createdByUserId))
    : [];
  return new ForbiddenError(
    `Only ${owner?.name ?? "the person who connected it"} can give an agent access to ${account.address}`,
    "mail.owner_only",
    { address: account.address, ownerUserId: account.createdByUserId ?? "", ownerName: owner?.name ?? "" },
  );
}

async function loadAccount(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, id), eq(mailAccounts.orgId, orgId), isNull(mailAccounts.revokedAt)));
  if (!row) throw new NotFoundError("Mailbox not found", "mail.account_not_found");
  return row;
}

export async function getMailAccountView(db: Database, orgId: string, id: string) {
  const row = await loadAccount(db, orgId, id);
  const grants = await mailGrants(db, orgId, [row.id]);
  return mailAccountView(row, grants.get(row.id));
}

async function assertAddressFree(db: Database, orgId: string, address: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.orgId, orgId),
        eq(mailAccounts.address, address),
        isNull(mailAccounts.revokedAt),
        exceptId ? ne(mailAccounts.id, exceptId) : undefined,
      ),
    );
  return !taken;
}

/**
 * Tool name slugs per account (`mail_<slug>_search`): the address's local
 * part as `[a-z0-9]`, at most 20 characters; when two mailboxes clash, the
 * later ones (by creation) get a short hash of their id instead of the tail.
 * Deterministic for the same set of accounts.
 */
export function mailSlugs(accounts: { id: string; address: string }[]) {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const a of accounts) {
    const local = a.address.split("@")[0] ?? "";
    const base =
      local
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 20) || "mailbox";
    let slug = base;
    if (used.has(slug)) slug = `${base.slice(0, 14)}${sha256(a.id).slice(0, 6)}`;
    for (let n = 2; used.has(slug); n++) slug = `${base.slice(0, 14)}${sha256(`${a.id}:${n}`).slice(0, 6)}`;
    used.add(slug);
    out.set(a.id, slug);
  }
  return out;
}

// ── IMAP accounts ───────────────────────────────────────────────────────────

export interface ImapAccountInput {
  preset: string;
  address: string;
  password: string;
  label?: string;
  username?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A custom host may not point inside our network (SSRF): private, loopback, metadata addresses. */
async function hostAllowed(host: string, resolve: ResolveHost): Promise<"ok" | "blocked" | "unreachable"> {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal"))
    return "blocked";
  if (isIP(h)) return isBlockedAddress(h) ? "blocked" : "ok";
  if (!HOST.test(h)) return "blocked";
  try {
    const addresses = await resolve(h);
    if (addresses.length === 0) return "unreachable";
    return addresses.some(isBlockedAddress) ? "blocked" : "ok";
  } catch {
    return "unreachable";
  }
}

const imapOf = (deps: MailDeps) => deps.mail?.imap ?? null;

/** The servers and login for an IMAP account (preset, or custom hosts checked against the SSRF guard). */
async function imapSettings(
  deps: MailDeps,
  input: ImapAccountInput,
): Promise<
  | {
      ok: true;
      preset: string;
      imapHost: string;
      imapPort: number;
      smtpHost: string;
      smtpPort: number;
      username: string;
    }
  | { ok: false; error: MailTestError }
> {
  const imap = imapOf(deps);
  if (!imap) throw new ConflictError("IMAP mailboxes are off on this server", "mail.imap_disabled");
  const address = normalizeAddress(input.address);
  const preset: MailPreset | undefined = imap.presets.find((p) => p.id === input.preset);
  if (!preset && input.preset !== "custom") throw new ValidationError(`Unknown preset ${input.preset}`, "mail.preset");
  const imapHost = (input.imapHost ?? preset?.imapHost ?? "").trim().toLowerCase();
  const smtpHost = (input.smtpHost ?? preset?.smtpHost ?? "").trim().toLowerCase();
  const imapPort = input.imapPort ?? preset?.imapPort ?? 993;
  const smtpPort = input.smtpPort ?? preset?.smtpPort ?? 587;
  if (!imapHost || !smtpHost) throw new ValidationError("Give the IMAP and SMTP servers", "mail.hosts_required");
  // Hosts not from a preset are typed by a person: never inside our network.
  const resolve = deps.resolveHost ?? resolveHostDns;
  if (imapHost !== preset?.imapHost) {
    const r = await hostAllowed(imapHost, resolve);
    if (r !== "ok") return { ok: false, error: r === "blocked" ? "blocked_host" : "imap_unreachable" };
  }
  if (smtpHost !== preset?.smtpHost) {
    const r = await hostAllowed(smtpHost, resolve);
    if (r !== "ok") return { ok: false, error: r === "blocked" ? "blocked_host" : "smtp_unreachable" };
  }
  const username =
    input.username?.trim() || (preset?.username === "local" ? (address.split("@")[0] ?? address) : address);
  return { ok: true, preset: preset?.id ?? "custom", imapHost, imapPort, smtpHost, smtpPort, username };
}

/**
 * Connects an IMAP/SMTP mailbox (admins): the login and both servers are
 * tested first; the app password is sealed bound to (org, account). Returns
 * the test's error instead of saving when it fails.
 */
export async function createImapAccount(
  deps: MailDeps,
  actorId: string,
  orgId: string,
  input: ImapAccountInput,
): Promise<{ ok: true; account: MailAccountView } | { ok: false; error: MailTestError }> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const address = normalizeAddress(input.address);
  if (!isEmailAddress(address)) throw new ValidationError("Invalid email address", "mail.invalid_address");
  const password = input.password.trim();
  if (!password) throw new ValidationError("Paste the app password", "mail.password_required");
  const settings = await imapSettings(deps, input);
  if (!settings.ok) return settings;
  if (!(await assertAddressFree(deps.db, orgId, address))) {
    throw new ConflictError("This mailbox is already connected", "mail.already_connected");
  }
  const imap = imapOf(deps);
  if (!imap) throw new ConflictError("IMAP mailboxes are off on this server", "mail.imap_disabled");
  const id = crypto.randomUUID();
  const ref: MailAccountRef = {
    id,
    orgId,
    provider: "imap",
    via: "imap",
    address,
    imap: {
      host: settings.imapHost,
      port: settings.imapPort,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      username: settings.username,
      password,
      sentFolder: null,
    },
  };
  const tested = await imap.tester.test(ref);
  if (!tested.ok) return tested;
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const sealed = await sealSecret(wrapper, password, mailAccountAad(orgId, id));
  const [row] = await deps.db
    .insert(mailAccounts)
    .values({
      id,
      orgId,
      provider: "imap",
      via: "imap",
      address,
      label: input.label?.trim().slice(0, 80) || address,
      status: "active",
      preset: settings.preset,
      imapHost: settings.imapHost,
      imapPort: settings.imapPort,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      username: settings.username,
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      sentFolder: tested.sentFolder,
      createdByUserId: actorId,
    })
    .returning();
  if (!row) throw new Error("mail account insert returned nothing");
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "mail_account.connected",
    target: { type: "mail_account", id },
    details: { via: "imap", preset: settings.preset, address },
  });
  return { ok: true, account: mailAccountView(row) };
}

// ── Composio accounts (Gmail, Outlook) ──────────────────────────────────────

const composioOf = (deps: MailDeps) => deps.mail?.composio ?? null;

/**
 * Starts connecting Gmail or Outlook through Composio (admins): a pending
 * row and Composio's link; the person signs in there and comes back to
 * `/api/app/mail/composio/callback?account=<id>`. `desktop`: started in the
 * desktop app's window, whose links open in the person's browser. With
 * `accountId`, a mailbox that needs reconnecting signs in again: the new
 * Composio account takes the refused one's place, and the mailbox keeps its
 * agents, rules and routines.
 */
export async function startComposioConnect(
  deps: MailDeps,
  actorId: string,
  orgId: string,
  input: { provider: "gmail" | "outlook"; label?: string; accountId?: string; desktop?: boolean },
): Promise<{ accountId: string; redirectUrl: string }> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const composio = composioOf(deps);
  if (!composio)
    throw new ConflictError("Gmail and Outlook are not configured on this server", "mail.composio_disabled");
  const again = input.accountId ? await loadAccount(deps.db, orgId, input.accountId) : null;
  if (again && (again.via !== "composio" || again.provider !== input.provider || again.status !== "needs_reconnect"))
    throw new ConflictError("This mailbox doesn't need reconnecting", "mail.not_reconnectable");
  const id = again?.id ?? crypto.randomUUID();
  if (!again) {
    await deps.db.insert(mailAccounts).values({
      id,
      orgId,
      provider: input.provider,
      via: "composio",
      label: input.label?.trim().slice(0, 80) ?? "",
      status: "pending",
      createdByUserId: actorId,
    });
  }
  try {
    const link = await composio.client.createConnectLink({
      toolkit: input.provider,
      userId: composioUserId(orgId),
      callbackUrl: composioCallbackUrl(deps.publicUrl, id, input.desktop === true),
    });
    await deps.db
      .update(mailAccounts)
      .set({ externalAccountId: link.connectedAccountId, updatedAt: new Date() })
      .where(eq(mailAccounts.id, id));
    // Not revoked at Google/Microsoft: the person is signing in to the same app again.
    if (again?.externalAccountId)
      await composio.client.deleteConnectedAccount(again.externalAccountId, { revoke: false }).catch(() => {});
    return { accountId: id, redirectUrl: link.redirectUrl };
  } catch (error) {
    if (!again) await deps.db.delete(mailAccounts).where(eq(mailAccounts.id, id));
    throw error;
  }
}

/**
 * Applies Composio's state of an account to our row: active (with its
 * address) or, for an account that never worked, disconnected. Returns
 * `active`, `pending` (Composio hasn't finished the sign-in, nothing
 * changed) or `off`.
 */
export async function applyComposioStateFor(
  deps: MailDeps,
  row: MailAccountRow,
  actorId: string | null = null,
): Promise<"active" | "pending" | "off"> {
  const composio = composioOf(deps);
  if (!composio || !row.externalAccountId) return "off";
  // An active mailbox has its address already: reading it again is a billed tool call on every
  // reconcile pass, so only its status is checked.
  const known = row.status === "active" && row.address !== "";
  const remote = await composio.client.getConnectedAccount(row.externalAccountId, composioUserId(row.orgId), {
    readAddress: !known,
  });
  if (known && remote.status === "active") return "active";
  const now = deps.now?.() ?? new Date();
  if (remote.status === "active" && remote.address) {
    // Composio made a connected account, which it bills once past the free ones: a reconnect's too, and one that
    // goes away below (ADR 0103).
    if (row.status !== "active") await countComposioConnection(deps.db, { orgId: row.orgId, toolkit: row.provider });
    const address = normalizeAddress(remote.address);
    if (row.status === "needs_reconnect" && row.address && address !== row.address) {
      // Signed in to another mailbox: it doesn't take this one's place (its agents and rules are for this
      // address). Not revoked: that mailbox may be connected here on its own.
      await composio.client.deleteConnectedAccount(row.externalAccountId, { revoke: false }).catch(() => {});
      await deps.db
        .update(mailAccounts)
        .set({ externalAccountId: null, lastError: "other_mailbox", updatedAt: now })
        .where(eq(mailAccounts.id, row.id));
      return "off";
    }
    if (!(await assertAddressFree(deps.db, row.orgId, address, row.id))) {
      // The same mailbox is connected already: this second connection goes away, and the grant they share stays
      // (Google revokes the app's whole grant, which would also end the connection that stays).
      await composio.client.deleteConnectedAccount(row.externalAccountId, { revoke: false }).catch(() => {});
      await deps.db
        .update(mailAccounts)
        .set({ status: "needs_reconnect", lastError: "already_connected", revokedAt: now, updatedAt: now })
        .where(eq(mailAccounts.id, row.id));
      return "off";
    }
    await deps.db
      .update(mailAccounts)
      .set({
        address,
        label: row.label || address,
        status: "active",
        lastError: null,
        updatedAt: now,
      })
      .where(eq(mailAccounts.id, row.id));
    if (row.status !== "active") {
      await recordAudit(deps.db, {
        orgId: row.orgId,
        actor: actorId ? { type: "person", id: actorId } : { type: "system", id: null },
        action: "mail_account.connected",
        target: { type: "mail_account", id: row.id },
        details: { via: "composio", provider: row.provider, address },
      });
    }
    if (row.status === "needs_reconnect") await restartMailWatches(deps, row.id);
    return "active";
  }
  if (remote.status === "pending") return "pending";
  if (row.status === "pending") {
    // It never worked: nothing to keep.
    await deps.db
      .update(mailAccounts)
      .set({ lastError: remote.status, revokedAt: now, updatedAt: now })
      .where(eq(mailAccounts.id, row.id));
  } else {
    await markNeedsReconnect(deps.db, row.id, `composio_${remote.status}`);
  }
  return "off";
}

/** Reads of the connected account before the callback leaves a sign-in that is still pending to the reconcile. */
const CALLBACK_READS = 10;

/**
 * Composio sent the person back (`GET /api/app/mail/composio/callback`):
 * reads the connected account. Needs no session: the browser Composio returns
 * to may not be signed in (the desktop app opens it in the person's browser),
 * the row's id is random, and only Composio's own state is copied onto the
 * row, as the reconcile does. Only a sign-in under way is read (a new
 * mailbox, still pending, or Reconectar on one that needs it): the id of a
 * mailbox already connected, which the org's members see, never makes it call
 * Composio. A pending account, or a read that failed for a moment, is read
 * again for a few seconds in case Composio is still finishing.
 */
export async function completeComposioConnect(
  deps: MailDeps,
  accountId: string,
): Promise<{ orgId: string; ok: boolean }> {
  const [row] = await deps.db.select().from(mailAccounts).where(eq(mailAccounts.id, accountId));
  if (row?.via !== "composio" || row.revokedAt) throw new NotFoundError("Mailbox not found");
  // No session to refuse it: a workspace closed to its people (suspended, or being deleted) takes no sign-in.
  const closed = closedRefusal(await orgStanding(deps.db, row.orgId));
  if (closed) throw closed;
  if (row.status !== "pending" && row.status !== "needs_reconnect") {
    return { orgId: row.orgId, ok: row.status === "active" };
  }
  for (let read = 1; ; read++) {
    const last = read === CALLBACK_READS;
    // Composio's errors come from the read, before anything is written: the same row is read again.
    const outcome = await applyComposioStateFor(deps, row, row.createdByUserId).catch((error: unknown) => {
      if (!last && error instanceof MailError && error.retryable) return "pending" as const;
      throw error;
    });
    if (outcome !== "pending" || last) return { orgId: row.orgId, ok: outcome === "active" };
    await Bun.sleep(deps.composioPollMs ?? 1000);
  }
}

// ── Changes ─────────────────────────────────────────────────────────────────

/**
 * Renames, turns actions on or off, sets the mailbox's other addresses and
 * the one new mail goes out from, or replaces the IMAP app password after
 * testing it. An agent pinned to an address the mailbox no longer has goes
 * back to the default.
 */
export async function updateMailAccount(
  deps: MailDeps,
  actorId: string,
  orgId: string,
  accountId: string,
  input: {
    label?: string;
    password?: string;
    offActions?: string[];
    askActions?: string[];
    aliases?: string[];
    defaultFrom?: string | null;
  },
): Promise<{ ok: true; account: MailAccountView } | { ok: false; error: MailTestError }> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await loadAccount(deps.db, orgId, accountId);
  const set: Partial<typeof mailAccounts.$inferInsert> = {};
  if (input.label !== undefined) set.label = input.label.trim().slice(0, 80) || row.address;
  const aliases = input.aliases !== undefined ? normalizeAliases(row.address, input.aliases) : row.aliases;
  const addresses = mailboxAddresses({ address: row.address, aliases });
  if (input.aliases !== undefined) set.aliases = aliases;
  if (input.defaultFrom !== undefined) {
    const from = input.defaultFrom ? normalizeAddress(input.defaultFrom) : null;
    if (from && !addresses.includes(from))
      throw new ValidationError("defaultFrom must be one of the mailbox's addresses", "mail.from_not_mailbox");
    set.defaultFrom = from === row.address ? null : from;
  } else if (row.defaultFrom && !addresses.includes(row.defaultFrom)) {
    set.defaultFrom = null;
  }
  if (input.offActions !== undefined) {
    const unknown = input.offActions.filter((a) => !(MAIL_ACTIONS as readonly string[]).includes(a));
    if (unknown.length > 0) throw new ValidationError(`Unknown mail actions: ${unknown.join(", ")}`, "mail.action");
    set.offActions = [...new Set(input.offActions)];
  }
  if (input.askActions !== undefined) {
    const wrong = input.askActions.filter((a) => !(ASKABLE_MAIL_ACTIONS as readonly string[]).includes(a));
    if (wrong.length > 0)
      throw new ValidationError(`These actions can't be made to ask: ${wrong.join(", ")}`, "mail.action");
    set.askActions = [...new Set(input.askActions)];
  }
  if (row.createdByUserId !== actorId) {
    // Narrowing (more off, more asking, fewer aliases) is anyone's; widening is giving access.
    const off = set.offActions ?? row.offActions;
    const ask = set.askActions ?? row.askActions;
    const widens =
      row.offActions.some((a) => !off.includes(a)) ||
      row.askActions.some((a) => !ask.includes(a) && !off.includes(a)) ||
      aliases.some((a) => !row.aliases.includes(a));
    if (widens) throw await mailOwnerOnlyError(deps.db, row);
  }
  if (input.password !== undefined) {
    if (row.via !== "imap") throw new ValidationError("Only IMAP mailboxes have a password", "mail.no_password");
    const imap = imapOf(deps);
    if (!imap) throw new ConflictError("IMAP mailboxes are off on this server", "mail.imap_disabled");
    const password = input.password.trim();
    if (!password) throw new ValidationError("Paste the app password", "mail.password_required");
    const ref = await accountRef(deps, row, password);
    const tested = await imap.tester.test(ref);
    if (!tested.ok) return tested;
    const wrapper = deps.keyWrappers[0];
    if (!wrapper) throw new Error("no key wrapper");
    const sealed = await sealSecret(wrapper, password, mailAccountAad(orgId, row.id));
    Object.assign(set, {
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      sentFolder: tested.sentFolder ?? row.sentFolder,
      status: "active",
      lastError: null,
    });
  }
  if (Object.keys(set).length > 0) {
    await deps.db
      .update(mailAccounts)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(mailAccounts.id, row.id));
    if (input.aliases !== undefined || input.defaultFrom !== undefined) {
      await deps.db
        .update(mailAgentPolicies)
        .set({ fromAddress: null, updatedAt: new Date() })
        .where(and(eq(mailAgentPolicies.accountId, row.id), notInArray(mailAgentPolicies.fromAddress, addresses)));
      await recordAudit(deps.db, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "mail_account.addresses_changed",
        target: { type: "mail_account", id: row.id },
        details: { aliases, defaultFrom: "defaultFrom" in set ? set.defaultFrom : row.defaultFrom },
      });
    }
    if (input.password !== undefined) {
      // Watches stopped by the old password start again.
      await deps.db
        .update(mailWatches)
        .set({ status: "active", lastError: null, updatedAt: new Date() })
        .where(and(eq(mailWatches.accountId, row.id), eq(mailWatches.status, "needs_reconnect")));
      await recordAudit(deps.db, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "mail_account.password_rotated",
        target: { type: "mail_account", id: row.id },
      });
    }
  }
  return { ok: true, account: await getMailAccountView(deps.db, orgId, row.id) };
}

/**
 * Composio forgets a mailbox: its triggers, then its connected account, which with `revoke` also revokes the grant at
 * Google or Microsoft. A 404 counts as done. Every call is tried, and the first failure is thrown after them.
 */
export async function forgetAtComposio(
  client: Pick<ComposioClient, "deleteTrigger" | "deleteConnectedAccount">,
  externalAccountId: string | null,
  triggerIds: string[],
  revoke = true,
) {
  const failures: unknown[] = [];
  for (const id of triggerIds) await client.deleteTrigger(id).catch((error: unknown) => failures.push(error));
  if (externalAccountId)
    await client.deleteConnectedAccount(externalAccountId, { revoke }).catch((error: unknown) => failures.push(error));
  if (failures.length > 0) throw failures[0];
}

/** The toolkits behind the same Google or Microsoft app as a mailbox's, which may share its grant. */
const SAME_APP_TOOLKITS: Record<string, string[]> = {
  gmail: ["googledrive", "googledocs", "googlesheets", "googlecalendar"],
  outlook: ["one_drive", "microsoft_teams"],
};

/**
 * Whether another connection still in use, in this workspace or another, reaches the same mailbox's grant through
 * Composio: another mailbox of the address, or a connector on the same provider's app (Drive, Calendar…) of that
 * account, or of an account it can't name. Forgetting this one must then leave that grant alone.
 */
export async function composioGrantShared(
  db: Pick<Database, "select">,
  box: { id: string; address: string; provider: string },
) {
  if (!box.address) return false;
  const [other] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.via, "composio"),
        eq(mailAccounts.address, box.address),
        isNull(mailAccounts.revokedAt),
        ne(mailAccounts.id, box.id),
      ),
    )
    .limit(1);
  if (other) return true;
  const toolkits = SAME_APP_TOOLKITS[box.provider];
  if (!toolkits) return false;
  const [connector] = await db
    .select({ id: connectorConnections.id })
    .from(connectorConnections)
    .where(
      and(
        inArray(connectorConnections.serverUrl, toolkits.map(composioToolkitUrl)),
        isNotNull(connectorConnections.composioAccountId),
        isNull(connectorConnections.revokedAt),
        or(isNull(connectorConnections.accountId), sql`lower(${connectorConnections.accountId}) = ${box.address}`),
      ),
    )
    .limit(1);
  return Boolean(connector);
}

/**
 * Disconnects a mailbox (admins): Composio forgets the account and its
 * triggers; agents lose their mail scopes on it; routines watching it stop.
 */
export async function revokeMailAccount(deps: MailDeps, actorId: string, orgId: string, accountId: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await loadAccount(deps.db, orgId, accountId);
  const watches = await deps.db.select().from(mailWatches).where(eq(mailWatches.accountId, row.id));
  const composio = composioOf(deps);
  if (row.via === "composio" && composio) {
    const triggers = watches.flatMap((w) => (w.externalTriggerId ? [w.externalTriggerId] : []));
    const revoke = !(await composioGrantShared(deps.db, row));
    await forgetAtComposio(composio.client, row.externalAccountId, triggers, revoke).catch(() => {});
  }
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    await tx.update(mailAccounts).set({ revokedAt: now, updatedAt: now }).where(eq(mailAccounts.id, row.id));
    await tx.delete(agentScopes).where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.connectionId, row.id)));
    await tx
      .update(mailWatches)
      .set({ status: "needs_reconnect", lastError: "account_removed", externalTriggerId: null, updatedAt: now })
      .where(eq(mailWatches.accountId, row.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "mail_account.disconnected",
      target: { type: "mail_account", id: row.id },
      details: { via: row.via, address: row.address },
    });
  });
  caches.scopes.deletePrefix(`${orgId}:`);
}

/**
 * The credentials were refused: a person must reconnect (routines watching it show "Reconnect"). A sign-in that
 * never finished stays pending: it has no address to reconnect, and the reconcile removes it.
 */
export async function markNeedsReconnect(db: Database, accountId: string, reason: string) {
  const now = new Date();
  await db
    .update(mailAccounts)
    .set({ status: "needs_reconnect", lastError: reason.slice(0, 300), updatedAt: now })
    .where(and(eq(mailAccounts.id, accountId), isNull(mailAccounts.revokedAt), ne(mailAccounts.status, "pending")));
  await db
    .update(mailWatches)
    .set({ status: "needs_reconnect", lastError: reason.slice(0, 300), updatedAt: now })
    .where(eq(mailWatches.accountId, accountId));
}

// ── Opening a mailbox ───────────────────────────────────────────────────────

/** What a connector needs for one account; the IMAP password opened in memory for this call only. */
export async function accountRef(deps: MailDeps, row: MailAccountRow, password?: string): Promise<MailAccountRef> {
  const base = {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider as MailAccountRef["provider"],
    via: row.via as MailAccountRef["via"],
    address: row.address,
  };
  if (row.via !== "imap") {
    return { ...base, externalAccountId: row.externalAccountId, externalUserId: composioUserId(row.orgId) };
  }
  let secret = password;
  if (secret === undefined) {
    if (!row.secretCiphertext || !row.wrappedDataKey || !row.kekId)
      throw new MailError("Mailbox has no password", false);
    secret = await openSecret(
      deps.keyWrappers,
      { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
      mailAccountAad(row.orgId, row.id),
    );
  }
  return {
    ...base,
    imap: {
      host: row.imapHost ?? "",
      port: row.imapPort ?? 993,
      smtpHost: row.smtpHost ?? "",
      smtpPort: row.smtpPort ?? 587,
      username: row.username ?? row.address,
      password: secret,
      sentFolder: row.sentFolder,
    },
  };
}

/** The connector for an account's path; null when that path is off on this server. */
export function connectorFor(deps: Pick<MailDeps, "mail">, via: string) {
  if (via === "composio") return deps.mail?.composio?.connector ?? null;
  if (via === "imap") return deps.mail?.imap?.connector ?? null;
  return null;
}

const PATH_NAMES: Record<string, string> = { composio: "Gmail/Outlook", imap: "IMAP" };

/** Opens one mailbox of the org (backend only; the caller closes it). */
export async function openMailProvider(deps: MailDeps, orgId: string, accountId: string): Promise<MailProvider> {
  const row = await loadAccount(deps.db, orgId, accountId);
  return openAccount(deps, row);
}

export async function openAccount(deps: MailDeps, row: MailAccountRow): Promise<MailProvider> {
  const connector = connectorFor(deps, row.via);
  if (!connector) throw new MailError(`${PATH_NAMES[row.via] ?? row.via} mailboxes are off`, false);
  return connector.open(await accountRef(deps, row));
}

/** Folders of a mailbox, for an agent's rules there (its owner, who sets them, and admins). */
export async function listMailFolders(deps: MailDeps, actorId: string, orgId: string, accountId: string) {
  await requirePermission(deps.db, actorId, orgId, "read");
  const row = await loadAccount(deps.db, orgId, accountId);
  if (row.createdByUserId !== actorId) await requirePermission(deps.db, actorId, orgId, "manage_agents");
  const provider = await openAccount(deps, row);
  try {
    return await provider.listFolders();
  } finally {
    await provider.close().catch(() => {});
  }
}

/**
 * Addresses this mailbox has sent from, newest first (the From of its sent
 * folder's recent mail): the aliases the connect flow offers. Best effort:
 * empty when the mailbox can't be read.
 */
export async function suggestMailAddresses(deps: MailDeps, actorId: string, orgId: string, accountId: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const row = await loadAccount(deps.db, orgId, accountId);
  let provider: MailProvider | null = null;
  try {
    provider = await openAccount(deps, row);
    const folders = await provider.listFolders();
    const sent = folders.find((f) => f.role === "sent")?.id ?? row.sentFolder;
    if (!sent) return [];
    const recent = await provider.search({ folder: sent, limit: 50 });
    const found = recent.map((m) => m.from?.address).filter((a): a is string => !!a && isEmailAddress(a));
    return [...new Set(found.map(normalizeAddress))].filter((a) => a !== row.address).slice(0, MAX_MAIL_ALIASES);
  } catch {
    return [];
  } finally {
    await provider?.close().catch(() => {});
  }
}

/** Which paths this server offers (`GET …/mail/providers`). */
export function mailProviders(mail: MailAdapters | null | undefined) {
  return {
    composio: !!mail?.composio,
    imap: !!mail?.imap,
    presets: mail?.imap?.presets ?? [],
  };
}

/** Active mailboxes for agents: not pending, not disconnected. */
export const usableAccount = (row: MailAccountRow) => row.status === "active" && !row.revokedAt;

/** Accounts with the given ids still connected (for grant validation). */
export async function activeMailAccountIds(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.orgId, orgId), inArray(mailAccounts.id, ids), isNull(mailAccounts.revokedAt)));
  return new Set(rows.map((r) => r.id));
}

/** Every mail account id of an org, connected or not (grants on them are managed only by the mail API). */
export const mailAccountIdsSql = (orgId: string) =>
  sql`(select ${mailAccounts.id} from ${mailAccounts} where ${mailAccounts.orgId} = ${orgId})`;

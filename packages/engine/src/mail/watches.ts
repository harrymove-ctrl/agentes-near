import type { MailAdapters } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { ValidationError } from "../errors";
import { hasScope } from "../tools/scopes";
import { composioUserId } from "./accounts";
import { normalizeAddressRule } from "./text";

const { mailWatches, mailAccounts, routines } = schema;

/** A routine's mail filter: from addresses or `@domains`, words in the subject, words anywhere. */
export interface MailFilter {
  from?: string[];
  subject?: string;
  text?: string;
}

export type MailWatchRow = typeof mailWatches.$inferSelect;

/** Normalised filter (lowercase rules, trimmed text); throws on an invalid sender rule. */
export function normalizeMailFilter(filter: MailFilter | undefined): MailFilter {
  const out: MailFilter = {};
  const from: string[] = [];
  for (const raw of filter?.from ?? []) {
    const rule = normalizeAddressRule(raw);
    if (!rule) throw new ValidationError(`"${raw}" is not an address or @domain`, "mail.invalid_rule", { value: raw });
    if (!from.includes(rule)) from.push(rule);
  }
  if (from.length > 50) throw new ValidationError("At most 50 senders", "mail.too_many_addresses");
  if (from.length > 0) out.from = from;
  const subject = filter?.subject?.trim().slice(0, 200);
  if (subject) out.subject = subject;
  const text = filter?.text?.trim().slice(0, 200);
  if (text) out.text = text;
  return out;
}

const quoted = (s: string) => `"${s.replace(/["\\]/g, " ").trim()}"`;

/**
 * The filter as a Gmail search, so unrelated mail never becomes a (billed)
 * Composio event: `from:(a@x.com OR @b.com) subject:"x" "words"`. Null = no filter.
 */
export function gmailQuery(filter: MailFilter): string | null {
  const parts: string[] = [];
  if (filter.from?.length) parts.push(`from:(${filter.from.join(" OR ")})`);
  if (filter.subject) parts.push(`subject:${quoted(filter.subject)}`);
  if (filter.text) parts.push(quoted(filter.text));
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The mailbox a routine may watch: connected in the org, and readable by the routine's agent. */
export async function checkWatchable(db: Database, orgId: string, agentId: string, accountId: string) {
  const [account] = await db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, accountId), eq(mailAccounts.orgId, orgId), isNull(mailAccounts.revokedAt)));
  if (!account || account.status === "pending") {
    throw new ValidationError("Pick a connected mailbox", "routine.mail_account_not_found");
  }
  if (!(await hasScope(db, orgId, agentId, accountId, "mail:read"))) {
    throw new ValidationError(
      "Let the agent read this mailbox before it can watch it",
      "routine.mail_agent_cannot_read",
    );
  }
  return account;
}

export async function watchesOf(db: Database, routineIds: string[]) {
  if (routineIds.length === 0) return new Map<string, MailWatchRow>();
  const rows = await db.select().from(mailWatches).where(inArray(mailWatches.routineId, routineIds));
  return new Map(rows.map((r) => [r.routineId, r]));
}

type SyncDeps = { db: Database; mail?: MailAdapters | null };

async function dropTrigger(deps: SyncDeps, watch: MailWatchRow) {
  if (watch.externalTriggerId) await deps.mail?.composio?.client.deleteTrigger(watch.externalTriggerId).catch(() => {});
}

/**
 * Keeps a routine's watch in step with the routine: one row per email
 * routine; for Composio mailboxes a trigger exists only while the routine is
 * active (paused routines cost nothing), recreated when the mailbox or the
 * filter changes. IMAP watches restart from "now" when the folder changes.
 * `watch` null = the routine no longer watches mail.
 */
export async function syncMailWatch(
  deps: SyncDeps,
  routine: { id: string; orgId: string; active: boolean; deletedAt?: Date | null },
  watch: { accountId: string; folder: string; filter: MailFilter } | null,
) {
  const [current] = await deps.db.select().from(mailWatches).where(eq(mailWatches.routineId, routine.id));
  if (!watch || routine.deletedAt) {
    if (current) {
      await dropTrigger(deps, current);
      await deps.db.delete(mailWatches).where(eq(mailWatches.id, current.id));
    }
    return null;
  }
  const filter = normalizeMailFilter(watch.filter);
  const folder = watch.folder.trim() || "INBOX";
  const same =
    current &&
    current.accountId === watch.accountId &&
    current.folder === folder &&
    JSON.stringify(current.filter) === JSON.stringify(filter);
  const now = new Date();
  let row: MailWatchRow | undefined = current;
  if (!current) {
    [row] = await deps.db
      .insert(mailWatches)
      .values({ orgId: routine.orgId, routineId: routine.id, accountId: watch.accountId, folder, filter })
      .returning();
  } else if (!same) {
    await dropTrigger(deps, current);
    [row] = await deps.db
      .update(mailWatches)
      .set({
        accountId: watch.accountId,
        folder,
        filter,
        externalTriggerId: null,
        lastUid: null,
        uidValidity: null,
        status: "active",
        lastError: null,
        updatedAt: now,
      })
      .where(eq(mailWatches.id, current.id))
      .returning();
  }
  if (!row) throw new Error("mail watch upsert returned nothing");
  const [account] = await deps.db.select().from(mailAccounts).where(eq(mailAccounts.id, row.accountId));
  if (account?.via !== "composio") return row;
  const client = deps.mail?.composio?.client;
  if (!routine.active) {
    if (row.externalTriggerId) {
      await dropTrigger(deps, row);
      [row] = await deps.db
        .update(mailWatches)
        .set({ externalTriggerId: null, updatedAt: now })
        .where(eq(mailWatches.id, row.id))
        .returning();
    }
    return row ?? null;
  }
  if (row.externalTriggerId) return row;
  if (!client || !account.externalAccountId || account.status !== "active") {
    [row] = await deps.db
      .update(mailWatches)
      .set({ status: "needs_reconnect", lastError: "account_unavailable", updatedAt: now })
      .where(eq(mailWatches.id, row.id))
      .returning();
    return row ?? null;
  }
  const watchId = row.id;
  try {
    const toolkit = account.provider === "outlook" ? "outlook" : "gmail";
    const { triggerId } = await client.createMailTrigger({
      toolkit,
      connectedAccountId: account.externalAccountId,
      userId: composioUserId(account.orgId),
      // Outlook has no search language here: its mail is filtered on our side.
      query: toolkit === "gmail" ? gmailQuery(filter) : null,
    });
    [row] = await deps.db
      .update(mailWatches)
      .set({ externalTriggerId: triggerId, status: "active", lastError: null, updatedAt: now })
      .where(eq(mailWatches.id, watchId))
      .returning();
  } catch (error) {
    [row] = await deps.db
      .update(mailWatches)
      .set({ status: "error", lastError: String(error).slice(0, 300), updatedAt: now })
      .where(eq(mailWatches.id, watchId))
      .returning();
  }
  return row ?? null;
}

/**
 * A Composio mailbox that works again (reconnected, or back at Composio):
 * the routines watching it stop asking for a reconnect, and the active ones
 * get a trigger again, on the account the mailbox has now.
 */
export async function restartMailWatches(deps: SyncDeps, accountId: string) {
  const rows = await deps.db
    .select({ watch: mailWatches, routine: routines })
    .from(mailWatches)
    .innerJoin(routines, eq(routines.id, mailWatches.routineId))
    .where(eq(mailWatches.accountId, accountId));
  for (const { watch, routine } of rows) {
    await dropTrigger(deps, watch);
    await deps.db
      .update(mailWatches)
      .set({ externalTriggerId: null, status: "active", lastError: null, updatedAt: new Date() })
      .where(eq(mailWatches.id, watch.id));
    await syncMailWatch(deps, routine, { accountId, folder: watch.folder, filter: watch.filter });
  }
}

/** IMAP: a resumed routine starts again from "now" (no burst of everything that arrived while paused). */
export async function resetMailWatchState(db: Database, routineId: string) {
  await db
    .update(mailWatches)
    .set({ lastUid: null, uidValidity: null, updatedAt: new Date() })
    .where(eq(mailWatches.routineId, routineId));
}

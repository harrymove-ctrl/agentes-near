import type { EmailSender } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, lt, ne, or, schema, sql } from "@agenteschat/db";
import { type AppLocale, appLocale, LOCALE_CODES } from "@agenteschat/i18n/locale";
import { randomToken, sha256 } from "./crypto";
import { emailLocale, queueEmail, rethrowEmailError } from "./email";
import { ValidationError } from "./errors";
import { enqueue } from "./outbox";

const { waitlistEntries } = schema;

export const WAITLIST_LOCALES = LOCALE_CODES;
export type WaitlistLocale = AppLocale;

/** A new confirmation email waits this long after the previous one. */
export const WAITLIST_RESEND_AFTER_MS = 2 * 60_000;
/** At most this many confirmation emails per address, ever. */
export const WAITLIST_MAX_SENDS = 5;
/** The confirmation link works for this long. */
export const WAITLIST_LINK_TTL_MS = 48 * 3600_000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** What `randomToken()` makes: base64url, 32 characters for 24 bytes. */
export const WAITLIST_TOKEN = /^[A-Za-z0-9_-]{32}$/;

/** Lowercase, trimmed; null when it doesn't look like an email. */
export function normalizeWaitlistEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/**
 * Puts someone on the waiting list and emails them a confirmation link
 * (double opt-in). Joining again resends the link, at most once every 2
 * minutes and 5 times per address; a confirmed address gets nothing. The
 * caller answers the same either way, so the list can't be probed.
 * Returns whether a confirmation email was queued.
 */
export async function joinWaitlist(
  db: Database,
  input: { email: string; locale?: string; source?: string; publicUrl: string },
  now = new Date(),
): Promise<{ sent: boolean }> {
  const email = normalizeWaitlistEmail(input.email);
  if (!email) throw new ValidationError("Use an email like name@company.com", "invalid_email");
  const locale: WaitlistLocale = appLocale([input.locale], true) ?? "en";
  await db.transaction(async (tx) => {
    const [added] = await tx
      .insert(waitlistEntries)
      .values({ email, locale, source: input.source ?? "landing" })
      .onConflictDoNothing()
      .returning({ id: waitlistEntries.id });
    // A new address is a contact right away, as pending until confirmed.
    if (added) await enqueueWaitlistContact(tx, added.id, "pending");
  });

  const token = randomToken();
  return db.transaction(async (tx) => {
    // One conditional update claims the send, so two requests at once can't both email.
    const [entry] = await tx
      .update(waitlistEntries)
      .set({
        confirmTokenHash: sha256(token),
        confirmSentAt: now,
        confirmSends: sql`${waitlistEntries.confirmSends} + 1`,
      })
      .where(
        and(
          eq(waitlistEntries.email, email),
          isNull(waitlistEntries.confirmedAt),
          lt(waitlistEntries.confirmSends, WAITLIST_MAX_SENDS),
          or(
            isNull(waitlistEntries.confirmSentAt),
            lt(waitlistEntries.confirmSentAt, new Date(now.getTime() - WAITLIST_RESEND_AFTER_MS)),
          ),
        ),
      )
      .returning({ id: waitlistEntries.id, locale: waitlistEntries.locale, sends: waitlistEntries.confirmSends });
    if (!entry) return { sent: false };
    await queueEmail(tx, {
      orgId: null,
      key: `waitlist-confirm:${entry.id}:${entry.sends}`,
      to: [email],
      template: {
        kind: "waitlist_confirm",
        locale: emailLocale(entry.locale),
        email,
        url: `${input.publicUrl.replace(/\/$/, "")}/?confirm=${token}`,
      },
    });
    return { sent: true };
  });
}

/**
 * Confirms the address behind a link from the confirmation email. Opening
 * the same link again still answers true; an unknown or expired one, false.
 */
export async function confirmWaitlist(db: Database, token: string, now = new Date()): Promise<boolean> {
  if (!WAITLIST_TOKEN.test(token)) return false;
  const [entry] = await db
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.confirmTokenHash, sha256(token)));
  if (!entry) return false;
  if (entry.confirmedAt) return true;
  if (!entry.confirmSentAt || now.getTime() - entry.confirmSentAt.getTime() > WAITLIST_LINK_TTL_MS) return false;
  await db.transaction(async (tx) => {
    const [confirmed] = await tx
      .update(waitlistEntries)
      .set({ confirmedAt: now })
      .where(and(eq(waitlistEntries.id, entry.id), isNull(waitlistEntries.confirmedAt)))
      .returning({ id: waitlistEntries.id });
    if (confirmed) await enqueueWaitlistContact(tx, confirmed.id, "confirmed");
  });
  return true;
}

/**
 * Job `waitlist.contact`: the address goes to the email provider's contacts,
 * once when it joins (pending) and once when it's confirmed.
 */
function enqueueWaitlistContact(db: Executor, entryId: string, status: "pending" | "confirmed") {
  return enqueue(db, {
    orgId: null,
    kind: "waitlist.contact",
    payload: { entryId },
    dedupeKey: status === "confirmed" ? `waitlist.contact:${entryId}` : `waitlist.contact:${entryId}:pending`,
  });
}

/** Where imported entries come from (`importWaitlist`): they are contacts there already, so they never sync. */
export const WAITLIST_IMPORT_SOURCE = "import";

/**
 * Queues `waitlist.contact` for every entry in its current status (run at
 * boot: catches up entries from before contacts were synced; the dedupe key
 * makes it a no-op for the rest). Returns how many entries were looked at.
 */
export async function enqueueWaitlistContacts(db: Database): Promise<number> {
  const rows = await db
    .select({ id: waitlistEntries.id, confirmedAt: waitlistEntries.confirmedAt })
    .from(waitlistEntries)
    .where(ne(waitlistEntries.source, WAITLIST_IMPORT_SOURCE));
  for (const row of rows) await enqueueWaitlistContact(db, row.id, row.confirmedAt ? "confirmed" : "pending");
  return rows.length;
}

/**
 * Saves an entry as a contact in the email provider (MillionSend), with
 * `waitlist` ("pending" or "confirmed"), `locale`, `source`,
 * `waitlist_joined_at` and, once confirmed, `waitlist_confirmed_at`, so the
 * list can be segmented there. The status is read now, not when the job was
 * queued, so a late pending job never undoes a confirmation. A provider
 * without contacts: nothing.
 */
export async function saveWaitlistContact(db: Database, email: EmailSender, entryId: string): Promise<void> {
  if (!email.saveContact) return;
  const [entry] = await db.select().from(waitlistEntries).where(eq(waitlistEntries.id, entryId));
  if (!entry || entry.source === WAITLIST_IMPORT_SOURCE) return;
  await email
    .saveContact({
      email: entry.email,
      properties: {
        waitlist: entry.confirmedAt ? "confirmed" : "pending",
        locale: entry.locale,
        source: entry.source,
        waitlist_joined_at: entry.createdAt.toISOString(),
        ...(entry.confirmedAt ? { waitlist_confirmed_at: entry.confirmedAt.toISOString() } : {}),
      },
    })
    .catch(rethrowEmailError);
}

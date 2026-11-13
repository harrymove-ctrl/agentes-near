import type { EmailSender } from "@agenteschat/adapters";
import { type Database, type Executor, eq, schema } from "@agenteschat/db";
import { rethrowEmailError } from "./email";
import { enqueue } from "./outbox";
import { isAgentesCloud } from "./telemetry";

const { users } = schema;

export const ACCOUNT_CONTACT_JOB = "account.contact";

let enabled = false;

/**
 * On only on agentes.chat Cloud with a provider that keeps contacts: a self-hosted server never sends anything about
 * its accounts, and queues no job.
 */
export function enableAccountContacts(publicUrl: string, email: Pick<EmailSender, "saveContact">) {
  enabled = isAgentesCloud(publicUrl) && Boolean(email.saveContact);
}

/**
 * Job `account.contact`: the account's address goes to the email provider's contacts as it is when the job runs.
 * Called where an account is created, changes language, is blocked or let back, is being deleted or restored, or
 * goes for good (before its row is deleted: the job keeps its address). No key: each change syncs once more.
 */
export async function enqueueAccountContact(db: Executor, userId: string) {
  if (!enabled) return;
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!row) return;
  await enqueue(db, { orgId: null, kind: ACCOUNT_CONTACT_JOB, payload: { userId, email: row.email } });
}

/**
 * Queues `account.contact` for every account (run at boot: catches up accounts from before contacts were synced).
 * The key is what the contact holds, so a restart with nothing changed is a no-op. Returns how many were queued.
 */
export async function enqueueAccountContacts(db: Database): Promise<number> {
  if (!enabled) return 0;
  const rows = await db.select().from(users);
  for (const row of rows) {
    const state = row.blockedAt || row.deletionDueAt ? "off" : `on:${row.locale ?? ""}`;
    await enqueue(db, {
      orgId: null,
      kind: ACCOUNT_CONTACT_JOB,
      payload: { userId: row.id, email: row.email },
      dedupeKey: `${ACCOUNT_CONTACT_JOB}:${row.id}:${state}`,
    });
  }
  return rows.length;
}

/**
 * Saves the account as a contact in the email provider (MillionSend) with `account_created_at` and, when set,
 * `locale` (left alone when null, so the waiting list's stays). A blocked account, one being deleted or one gone
 * loses `account_created_at`; the contact itself stays, keeping its unsubscribe state. A provider without contacts:
 * nothing.
 */
export async function saveAccountContact(
  db: Database,
  email: EmailSender,
  payload: { userId: string; email: string },
): Promise<void> {
  if (!email.saveContact) return;
  const [row] = await db.select().from(users).where(eq(users.id, payload.userId));
  const contact =
    !row || row.blockedAt || row.deletionDueAt
      ? { email: row?.email ?? payload.email, properties: { account_created_at: null } }
      : {
          email: row.email,
          properties: {
            account_created_at: row.createdAt.toISOString(),
            ...(row.locale ? { locale: row.locale } : {}),
          },
        };
  await email.saveContact(contact).catch(rethrowEmailError);
}

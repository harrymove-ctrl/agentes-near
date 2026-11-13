import type { KeyWrapper } from "@agenteschat/adapters";
import { and, type Database, eq, isNotNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { openSecret } from "../crypto";
import { mailAccountAad } from "./accounts";

const { mailAccounts, mailWatches, agentScopes } = schema;

/** Where MillionSend inboxes lived (the setting that could point elsewhere is gone with them). */
const MILLIONSEND_INBOXES_API = "https://api.millionsend.com";

/**
 * One-time cleanup at boot for MillionSend inboxes connected as mailboxes, a path withdrawn (ADR 0102): each one's
 * webhook is deleted at MillionSend with its own sealed key, and the mailbox is disconnected the way
 * `revokeMailAccount` does it. The sealed key is wiped once the webhook is gone; a delete that failed keeps it, so
 * the next boot (or that workspace's purge, which runs it for the workspace first) tries again. Remove once every
 * installation has booted a release with it and no workspace's purge still has such a key.
 */
export async function retireMillionSendMailboxes(deps: {
  db: Database;
  keyWrappers: KeyWrapper[];
  /** Only this workspace's mailboxes (its purge); all of them when absent (boot). */
  orgId?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): Promise<{ checked: number; webhooksLeft: string[] }> {
  const http = deps.fetch ?? fetch;
  const rows = await deps.db
    .select()
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.provider, "millionsend"),
        isNotNull(mailAccounts.secretCiphertext),
        deps.orgId ? eq(mailAccounts.orgId, deps.orgId) : undefined,
      ),
    );
  const webhooksLeft: string[] = [];
  for (const row of rows) {
    const gone = await deleteWebhook(http, deps.keyWrappers, row).catch(() => false);
    if (!gone) webhooksLeft.push(row.id);
    const now = deps.now?.() ?? new Date();
    await deps.db.transaction(async (tx) => {
      await tx
        .update(mailAccounts)
        .set({
          revokedAt: row.revokedAt ?? now,
          ...(gone ? { secretCiphertext: null, wrappedDataKey: null, kekId: null } : {}),
          updatedAt: now,
        })
        .where(eq(mailAccounts.id, row.id));
      if (row.revokedAt) return;
      await tx.delete(agentScopes).where(and(eq(agentScopes.orgId, row.orgId), eq(agentScopes.connectionId, row.id)));
      await tx
        .update(mailWatches)
        .set({ status: "needs_reconnect", lastError: "account_removed", externalTriggerId: null, updatedAt: now })
        .where(eq(mailWatches.accountId, row.id));
      await recordAudit(tx, {
        orgId: row.orgId,
        actor: { type: "system", id: null },
        action: "mail_account.disconnected",
        target: { type: "mail_account", id: row.id },
        details: { via: row.via, address: row.address, reason: "millionsend_mailboxes_withdrawn" },
      });
    });
  }
  if (rows.length > 0) caches.scopes.clear();
  return { checked: rows.length, webhooksLeft };
}

/** True when MillionSend no longer posts this mailbox's mail (deleted, already gone, or it never had a webhook). */
async function deleteWebhook(http: typeof fetch, keyWrappers: KeyWrapper[], row: typeof mailAccounts.$inferSelect) {
  if (!row.secretCiphertext || !row.wrappedDataKey || !row.kekId) return true;
  const json = await openSecret(
    keyWrappers,
    { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    mailAccountAad(row.orgId, row.id),
  );
  const secret = JSON.parse(json) as { apiKey?: string; webhook?: { id?: string } };
  const id = secret.webhook?.id;
  if (!id) return true;
  // An id that can't be MillionSend's names no webhook to delete, and without a key nothing can delete it.
  if (!secret.apiKey || !/^[0-9a-f-]{36}$/i.test(id)) return true;
  const res = await http(`${MILLIONSEND_INBOXES_API}/webhooks/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${secret.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  // A key MillionSend refuses (401) or no longer allows (403) can delete nothing anymore, and a 404 is already done.
  return res.ok || res.status === 404 || res.status === 401 || res.status === 403;
}

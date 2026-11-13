import {
  COMPOSIO_MAIL_TRIGGERS,
  type ComposioMailToolkit,
  MailAuthError,
  type MailPoller,
  type MailSummary,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, lt, or, schema, sql } from "@agenteschat/db";
import { countComposio } from "../connector-usage";
import { markComposioAccountBroken } from "../connectors/composio";
import { NotFoundError } from "../errors";
import { cutText } from "../format";
import { type EventMerge, holdForNextRun, queueEventRun, type RoutineEventPayload } from "../routine-events";
import { hasScope } from "../tools/scopes";
import { neutralizeUntrusted } from "../untrusted";
import {
  accountRef,
  applyComposioStateFor,
  type MailDeps,
  mailSlugs,
  markNeedsReconnect,
  orgMailAccounts,
} from "./accounts";
import { agentMailPolicy } from "./policies";
import { formatAddress, matchesAddressRules, oneLine } from "./text";
import type { MailFilter } from "./watches";

const { mailWatches, mailSeen, mailAccounts, routines, routineRuns } = schema;

/** At most this many messages go into one routine run; the rest are only counted. */
export const MAX_MESSAGES_PER_RUN = 20;
/** The event summary a run shows the agent is cut at 2000 characters: keep under it. */
const SUMMARY_BUDGET = 1900;

/** Whether a message passes a watch's filter (applied here too: Outlook can't filter at the source). */
export function matchesMailFilter(filter: MailFilter, m: MailSummary) {
  if (filter.from?.length && (!m.from || !matchesAddressRules(filter.from, m.from.address))) return false;
  const lower = (s: string) => s.toLowerCase();
  if (filter.subject && !lower(m.subject).includes(lower(filter.subject))) return false;
  if (filter.text && !`${lower(m.subject)} ${lower(m.snippet)}`.includes(lower(filter.text))) return false;
  return true;
}

interface QueuedMail {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

/** The event summary: who, what, when, a short snippet, per message; marker-free, one line each. */
function mailSummary(address: string, folder: string, readTool: string, messages: QueuedMail[], extra: number) {
  const head = `${messages.length + extra} new email${messages.length + extra === 1 ? "" : "s"} in ${address} (${folder}). Read one with ${readTool} and its id.`;
  const room = Math.max(0, Math.floor((SUMMARY_BUDGET - head.length) / Math.max(1, messages.length)));
  const lines = messages.map((m) => {
    const base = `- ${m.date} · ${m.from} · "${m.subject}" · id ${m.id}`;
    const snippetRoom = room - base.length - 3;
    // A list without text: no snippet, no dangling separator.
    const snippet = snippetRoom > 20 ? oneLine(m.snippet, snippetRoom) : "";
    return snippet ? `${base} · ${snippet}` : cutText(base, Math.max(40, room));
  });
  const more = extra > 0 ? [`(and ${extra} more not listed)`] : [];
  return neutralizeUntrusted([head, ...lines, ...more].join("\n"));
}

/**
 * New mail for a watch (a Composio webhook or an IMAP poll): filtered here
 * (the watch's filter and what the routine's agent may read), deduplicated
 * by message id (`mail_seen`), and merged into ONE routine run: a run still
 * queued for this routine takes the new messages instead of a second run.
 * The run's context carries the summary inside the outside-content envelope.
 */
export async function ingestMail(
  deps: { db: Database; now?: () => Date },
  watchId: string,
  messages: MailSummary[],
): Promise<{ added: number; fired: boolean }> {
  const { db } = deps;
  const [watch] = await db.select().from(mailWatches).where(eq(mailWatches.id, watchId));
  if (!watch) return { added: 0, fired: false };
  const [routine] = await db.select().from(routines).where(eq(routines.id, watch.routineId));
  if (!routine?.active || routine.deletedAt) return { added: 0, fired: false };
  const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, watch.accountId));
  if (!account || account.revokedAt) return { added: 0, fired: false };
  // The watch outlives the agent's access (taken by the mailbox's owner, or dropped as its audience widened).
  if (!(await hasScope(db, routine.orgId, routine.agentId, account.id, "mail:read"))) return { added: 0, fired: false };
  const policy = await agentMailPolicy(db, routine.orgId, routine.agentId, account.id);
  const now = deps.now?.() ?? new Date();
  const wanted = messages.filter(
    (m) =>
      matchesMailFilter(watch.filter, m) &&
      // Never hand the agent a message it couldn't read itself.
      (policy.senders.length === 0 || (m.from && matchesAddressRules(policy.senders, m.from.address))) &&
      (policy.windowDays === null || Date.parse(m.date) >= now.getTime() - policy.windowDays * 86_400_000),
  );
  if (wanted.length === 0) return { added: 0, fired: false };
  const fresh = await db
    .insert(mailSeen)
    .values(wanted.map((m) => ({ orgId: watch.orgId, watchId: watch.id, messageKey: m.id })))
    .onConflictDoNothing()
    .returning({ key: mailSeen.messageKey });
  const freshKeys = new Set(fresh.map((r) => r.key));
  const added = wanted
    .filter((m) => freshKeys.has(m.id))
    .map(
      (m): QueuedMail => ({
        id: oneLine(m.id, 200),
        from: oneLine(formatAddress(m.from), 120),
        subject: oneLine(m.subject, 150),
        date: m.date,
        snippet: oneLine(m.snippet, 200),
      }),
    );
  if (added.length === 0) return { added: 0, fired: false };
  const merge = await mailMerge(db, routine.orgId, account, watch.folder);
  // Bursts become one run (§6.3, §6.8): the new messages join the run still queued with its job alive,
  // or the run waiting to start (gathered while another works, or emails held from a run that didn't finish).
  const { outcome } = await queueEventRun({ db }, routine, {
    event: merge(
      { type: "email.received", accountId: account.id, watchId: watch.id, messages: [], extra: 0, summary: "" },
      { messages: added },
    ) as RoutineEventPayload,
    merge,
    at: now,
  });
  return { added: added.length, fired: outcome === "queued" };
}

/** How new messages join a mail run's event: one list (the first `MAX_MESSAGES_PER_RUN`, the rest counted). */
async function mailMerge(
  db: Database,
  orgId: string,
  account: { id: string; address: string },
  folder: string,
): Promise<EventMerge> {
  const slugs = mailSlugs((await orgMailAccounts(db, orgId)).filter((a) => a.address));
  const readTool = `mail_${slugs.get(account.id) ?? "mailbox"}_read`;
  return (current, incoming) => {
    const listed = (e: Record<string, unknown>) => (Array.isArray(e.messages) ? (e.messages as QueuedMail[]) : []);
    const counted = (e: Record<string, unknown>) => (typeof e.extra === "number" ? e.extra : 0);
    const all = [...listed(current), ...listed(incoming)];
    const kept = all.slice(0, MAX_MESSAGES_PER_RUN);
    const extra = counted(current) + counted(incoming) + all.length - kept.length;
    return {
      ...current,
      messages: kept,
      extra,
      summary: mailSummary(account.address, folder, readTool, kept, extra),
    };
  };
}

/**
 * An email run that failed, was stopped or never ran (§6.8): its messages are released to the next
 * run (they join the run waiting to start, or wait for the next email), so none is lost.
 */
export async function releaseRoutineEmails(deps: { db: Database }, routineRunId: string): Promise<boolean> {
  const { db } = deps;
  const [run] = await db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId));
  const event = (run?.event ?? null) as { type?: unknown; watchId?: unknown; messages?: unknown } | null;
  if (!run || event?.type !== "email.received" || !Array.isArray(event.messages) || event.messages.length === 0)
    return false;
  const [routine] = await db.select().from(routines).where(eq(routines.id, run.routineId));
  if (!routine || routine.deletedAt) return false;
  const [watch] = await db
    .select()
    .from(mailWatches)
    .where(eq(mailWatches.id, String(event.watchId ?? "")));
  if (!watch || watch.routineId !== routine.id) return false;
  const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, watch.accountId));
  if (!account || account.revokedAt) return false;
  const merge = await mailMerge(db, routine.orgId, account, watch.folder);
  const released = merge(
    { type: "email.received", accountId: account.id, watchId: watch.id, messages: [], extra: 0, summary: "" },
    run.event ?? {},
  ) as RoutineEventPayload;
  await holdForNextRun({ db }, routine, released, merge);
  return true;
}

// ── Composio webhooks ───────────────────────────────────────────────────────

/**
 * `POST /api/webhooks/composio`: the signature is checked by the client
 * (throws `ComposioSignatureError`); then new mail goes to its watch, and an
 * expired account (a mailbox's or a connector's, ADR 0107) or a disabled
 * trigger asks a person to reconnect.
 */
export async function handleComposioWebhook(
  deps: Pick<MailDeps, "db" | "mail" | "now">,
  headers: Headers,
  rawBody: string,
): Promise<{ type: string; fired: number }> {
  const client = deps.mail?.composio?.client;
  if (!client) throw new NotFoundError("Composio is not configured");
  const event = client.verifyWebhook(headers, rawBody);
  const { db } = deps;
  if (event.type === "mail.received") {
    const [watch] = await db.select().from(mailWatches).where(eq(mailWatches.externalTriggerId, event.triggerId));
    if (!watch) return { type: event.type, fired: 0 };
    const [account] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, watch.accountId));
    // The trigger belongs to the account it was created on; anything else is ignored.
    if (!account || account.externalAccountId !== event.connectedAccountId) return { type: event.type, fired: 0 };
    // Composio bills every delivery, a repeated one too (ADR 0103).
    const trigger = COMPOSIO_MAIL_TRIGGERS[account.provider as ComposioMailToolkit];
    if (trigger)
      await countComposio(db, { orgId: account.orgId, toolkit: account.provider, action: trigger, events: 1 });
    const r = await ingestMail(deps, watch.id, [event.message]);
    return { type: event.type, fired: r.fired ? 1 : 0 };
  }
  if (event.type === "account.expired") {
    const rows = await db
      .select({ id: mailAccounts.id })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.externalAccountId, event.connectedAccountId), isNull(mailAccounts.revokedAt)));
    for (const r of rows) await markNeedsReconnect(db, r.id, "composio_expired");
    await markComposioAccountBroken(db, event.connectedAccountId, "composio_expired");
    return { type: event.type, fired: 0 };
  }
  if (event.type === "trigger.disabled") {
    await db
      .update(mailWatches)
      .set({ status: "needs_reconnect", lastError: "trigger_disabled", updatedAt: new Date() })
      .where(eq(mailWatches.externalTriggerId, event.triggerId));
    return { type: event.type, fired: 0 };
  }
  return { type: event.type, fired: 0 };
}

// ── Polling (IMAP) ─────────────────────────────────────────────

/** A watch that failed (not the password) waits this many intervals before the next try. */
const ERROR_BACKOFF_INTERVALS = 5;

/**
 * Worker tick: checks the folders watched by active routines on IMAP mailboxes whose last
 * check is older than `intervalMs` (failed ones back off). Watches are claimed with `FOR UPDATE SKIP LOCKED` and stamped before the
 * network call, so replicas never poll the same folder twice. A first check starts from now; a changed IMAP
 * `UIDVALIDITY` starts over from now too (the poller says so).
 */
export async function pollMailWatches(
  deps: MailDeps,
  options: { intervalMs: number; concurrency?: number; limit?: number } = { intervalMs: 300_000 },
): Promise<{ checked: number; fired: number; failed: number }> {
  const pollers: Record<string, MailPoller | undefined> = {
    imap: deps.mail?.imap?.poller,
  };
  const vias = Object.keys(pollers).filter((via) => pollers[via]);
  if (vias.length === 0) return { checked: 0, fired: 0, failed: 0 };
  const now = deps.now?.() ?? new Date();
  const dueBefore = new Date(now.getTime() - options.intervalMs);
  const errorBefore = new Date(now.getTime() - options.intervalMs * ERROR_BACKOFF_INTERVALS);
  const claimed = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ watch: mailWatches })
      .from(mailWatches)
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailWatches.accountId))
      .innerJoin(routines, eq(routines.id, mailWatches.routineId))
      .where(
        and(
          inArray(mailAccounts.via, vias),
          eq(mailAccounts.status, "active"),
          isNull(mailAccounts.revokedAt),
          eq(routines.active, true),
          isNull(routines.deletedAt),
          or(
            and(
              eq(mailWatches.status, "active"),
              or(isNull(mailWatches.lastCheckedAt), lt(mailWatches.lastCheckedAt, dueBefore)),
            ),
            and(eq(mailWatches.status, "error"), lt(mailWatches.lastCheckedAt, errorBefore)),
          ),
        ),
      )
      .orderBy(sql`${mailWatches.lastCheckedAt} asc nulls first`)
      .limit(options.limit ?? 100)
      .for("update", { of: mailWatches, skipLocked: true });
    const ids = rows.map((r) => r.watch.id);
    if (ids.length > 0) {
      await tx.update(mailWatches).set({ lastCheckedAt: now }).where(inArray(mailWatches.id, ids));
    }
    return rows.map((r) => r.watch);
  });
  let fired = 0;
  let failed = 0;
  const queue = [...claimed];
  const worker = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      const [account] = await deps.db.select().from(mailAccounts).where(eq(mailAccounts.id, w.accountId));
      const poller = account ? pollers[account.via] : undefined;
      if (!account || !poller) continue;
      try {
        const ref = await accountRef(deps, account);
        const state =
          w.lastUid !== null && w.uidValidity !== null ? { lastUid: w.lastUid, uidValidity: w.uidValidity } : null;
        const r = await poller.newMessages(ref, w.folder, state, { limit: 50 });
        await deps.db
          .update(mailWatches)
          .set({
            lastUid: r.state.lastUid,
            uidValidity: r.state.uidValidity,
            status: "active",
            lastError: null,
            updatedAt: now,
          })
          .where(eq(mailWatches.id, w.id));
        if (r.messages.length > 0 && (await ingestMail(deps, w.id, r.messages)).fired) fired++;
      } catch (error) {
        failed++;
        if (error instanceof MailAuthError) {
          await markNeedsReconnect(deps.db, account.id, error.message);
        } else {
          await deps.db
            .update(mailWatches)
            .set({ status: "error", lastError: String(error).slice(0, 300), updatedAt: now })
            .where(eq(mailWatches.id, w.id));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 5) }, worker));
  return { checked: claimed.length, fired, failed };
}

// ── Composio reconcile ──────────────────────────────────────────────────────

/** Pending Composio rows older than this were abandoned (the person never finished): removed. */
const PENDING_TTL_MS = 24 * 3600_000;

/**
 * Worker tick (every 15 min): each Composio account's state from Composio.
 * Expired ones ask a person to reconnect; pending ones that finished become
 * active; pending ones abandoned for a day go away. `failed`: the accounts
 * whose check threw (the worker logs them).
 */
export async function reconcileComposioAccounts(deps: MailDeps) {
  const failed: { orgId: string; accountId: string; error: string }[] = [];
  if (!deps.mail?.composio) return { checked: 0, failed };
  const now = deps.now?.() ?? new Date();
  const rows = await deps.db
    .select()
    .from(mailAccounts)
    .where(and(eq(mailAccounts.via, "composio"), isNull(mailAccounts.revokedAt)))
    .limit(500);
  let checked = 0;
  for (const row of rows) {
    if (row.status === "pending" && now.getTime() - row.createdAt.getTime() > PENDING_TTL_MS) {
      await deps.db
        .update(mailAccounts)
        .set({ revokedAt: now, lastError: "abandoned", updatedAt: now })
        .where(eq(mailAccounts.id, row.id));
      continue;
    }
    if (!row.externalAccountId) continue;
    checked++;
    await applyComposioStateFor(deps, row).catch((error: unknown) => {
      failed.push({ orgId: row.orgId, accountId: row.id, error: String(error) });
    });
  }
  return { checked, failed };
}

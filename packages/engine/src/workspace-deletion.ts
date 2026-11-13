import { randomUUID } from "node:crypto";
import { ACCOUNTS_PROTOCOL, type MailAdapters, type PubSub, type RateLimiter } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  schema,
  sql,
} from "@agenteschat/db";
import { enqueueAccountContact } from "./account-contacts";
import { recordAudit } from "./audit";
import { orgMessageCount } from "./billing-link";
import { caches } from "./cache";
import { stopOrgWork } from "./cancel";
import { type ConnectorDeps, revokeAtProvider } from "./connectors/connections";
import { sha256 } from "./crypto";
import { emailLocale, modeStamp, queueEmail } from "./email";
import {
  CODE_LIMITS,
  CODE_RESEND_SECONDS,
  CODE_TRIES,
  CODE_TTL_MS,
  codeLimit,
  codeRefusal,
  codeVerdict,
  codeWait,
  codeWaitMs,
  newCode,
} from "./email-codes";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { type OrgDeletingEvent, publishOrgEvent } from "./events";
import { forgetInstallationTokens, uninstallInstallation } from "./git/github-app";
import type { GitHubAppAccess } from "./git/github-call";
import { announceReleasedAccounts, type ReleasedAccounts, releaseOrgAccounts } from "./machine-accounts";
import type { MachineHub } from "./machine-hub";
import { MACHINE_CONTROL_TOPIC, machineOnline, personalMachines } from "./machines";
import { composioGrantShared, forgetAtComposio } from "./mail/accounts";
import { retireMillionSendMailboxes } from "./mail/retire-millionsend";
import { recordOperatorEvent } from "./operator-events";
import {
  announceMembers,
  appleSignInTokens,
  can,
  deleteAccount,
  getMembership,
  getOrganization,
  lockOrgMembers,
  lockWorkspacesOf,
  type MemberRole,
  type Membership,
  queueOrgFilesPurge,
} from "./organizations";
import { enqueue } from "./outbox";
import { followOwner } from "./right-hand";
import {
  accountInUse,
  closedRefusal,
  heldOrg,
  OrgDeletingError,
  OrgPausedError,
  type OrgStanding,
  refusesNewWorkspace,
  STANDING_COLUMNS,
  waitsForPlan,
} from "./standing";

const {
  agents,
  organizations,
  organizationMembers,
  organizationSettings,
  users,
  sessions,
  pushDevices,
  machineProvisioning,
  machines,
  machineAccounts,
  messageReactions,
  routingDecisions,
  threadReflections,
  usageRecords,
  wikiLinks,
  contextUsage,
  feedbackFiles,
  mailAccounts,
  mailWatches,
  connectorConnections,
  oauthStates,
  githubAppInstallations,
  auditLog,
  providerCredentials,
  dbConnections,
  verifications,
} = schema;

/*
 * Deleting a workspace: an owner asks, with proof that it's them (a code emailed to them, `spendDeletionCode`), and
 * the workspace turns read-only for everyone at once: its people still read it, but every change and all its work are
 * refused (`closedRefusal`, `readRefusal`). Any owner may restore it until its
 * date. At the date the `org.delete` job deletes it for good: its computers' AI sign-ins first, then the grants it
 * holds at Composio and GitHub, then its rows in one transaction. The date is the point of no return, by the database's clock: restoring
 * works only before it and the purge only after it, each checked under the workspace's `org-members` lock once it has
 * it, so neither can undo the other.
 */

/** Days a deleted workspace stays read-only, and restorable by any owner, before it goes for good. */
export const WORKSPACE_DELETION_DAYS = 7;
/** The job that deletes a workspace at its date (`purgeWorkspace`). */
export const ORG_DELETE_JOB = "org.delete";
/**
 * Tables holding a workspace's rows that nothing cascades to from it (no foreign key to it, or only through a nullable
 * column): the purge deletes them itself.
 */
export const PURGED_BY_HAND = [
  "message_reactions",
  "routing_decisions",
  "thread_reflections",
  "usage_records",
  "wiki_links",
  "context_usage",
  "feedback_files",
] as const;
/** How long the purge waits for a workspace's online computers to sign its AI accounts out. */
const ACCOUNTS_WAIT_MS = 60_000;

/** Who asked: an owner, or the account of its only member, which went with it. */
export type DeletionVia = "owner" | "account";

/**
 * A deletion past its date still waits while the workspace is suspended, on a hold that isn't billing's, or under the
 * operator's deletion hold (a legal hold), so evidence outlives a deletion. It never refuses one: the workspace turns
 * read-only at once either way.
 */
export const keptFromDeletion = (
  org: Pick<OrgStanding, "state" | "reason" | "notice"> & { deletionHoldAt: Date | null },
) => refusesNewWorkspace(org) || org.deletionHoldAt !== null;
/** `keptFromDeletion` in SQL. */
const keptOrg = sql<boolean>`(${heldOrg} or ${organizations.deletionHoldAt} is not null)`;
/**
 * Its date passed, by the database's clock when the statement runs: after the lock it waited for, never when its
 * transaction began. Restoring reads the same clock the same way (`restorable`).
 */
const pastDue = sql<boolean>`${organizations.deletionDueAt} <= statement_timestamp()`;
/** `pastDue`'s other side: a restore is still in time. */
const restorable = sql<boolean>`${organizations.deletionDueAt} > statement_timestamp()`;

export interface DeletionDeps {
  db: Database;
  pubsub?: PubSub;
  /** Stops its agents' tasks and desktops on its computers (absent: the tasks are only marked canceled). */
  hub?: Pick<MachineHub, "call">;
  /**
   * This server sends email: the members are told, with links to this address, and a deleted account is told whom to
   * write to (`support`, `SUPPORT_EMAIL`). Absent: nobody is.
   */
  emails?: { publicUrl: string; support?: string | null } | null;
}

/** Days a deleted account waits, and can be restored by signing in, before it goes for good. */
export const ACCOUNT_DELETION_DAYS = WORKSPACE_DELETION_DAYS;
/** The job that deletes an account at its date (`purgeAccount`). */
export const ACCOUNT_DELETE_JOB = "account.delete";

/** A deletion written in a transaction, for what follows its commit (`afterClosing`). */
export interface Closed {
  orgId: string;
  dueAt: Date;
  by: { id: string; name: string };
}

const workspaceUrl = (publicUrl: string, orgId: string) => `${publicUrl.replace(/\/$/, "")}/org/${orgId}`;

/**
 * An owner's membership, before deleting or restoring the workspace: refused for anyone else and while it is suspended
 * (`org.suspended`, its owners can act on nothing then), and a 404 once it is gone. Being deleted is no refusal here.
 */
export async function requireOwnerToDelete(db: Database, userId: string, orgId: string): Promise<Membership> {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) {
    if (!(await getOrganization(db, orgId))) throw new NotFoundError("This workspace no longer exists");
    throw new ForbiddenError("You are not a member of this organization");
  }
  const refusal = closedRefusal(membership.standing);
  if (refusal instanceof OrgPausedError) throw refusal;
  if (!can(membership, "manage_owners")) throw new ForbiddenError("Only an owner can delete or restore the workspace");
  return membership;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** One per person and what it deletes, in Better Auth's `verifications`: a code proves only that deletion. */
const deletionCodeId = (userId: string, orgId: string | null) =>
  `deletion-code:${userId}:${orgId ? `workspace:${orgId}` : "account"}`;
const deletionCodeHash = (id: string, code: string) => sha256(`${id}:${code}`);
/** A person's codes are sent and checked one at a time, whatever they delete: their wrong tries are counted together. */
const lockDeletionCodes = (tx: Executor, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`deletion-code:${userId}`}))`);
/** The account's wrong tries in its day (`CODE_LIMITS.wrongDay`): one `verifications` row, the count till the day ends. */
const wrongTriesId = (userId: string) => `deletion-code:${userId}:wrong`;
async function wrongTries(tx: Executor, userId: string, now: Date) {
  const [row] = await tx
    .select()
    .from(verifications)
    .where(eq(verifications.identifier, wrongTriesId(userId)));
  return row && row.expiresAt > now
    ? { count: Number(row.value), until: row.expiresAt }
    : { count: 0, until: new Date(now.getTime() + DAY_MS) };
}
const triesSpent = async (tx: Executor, userId: string, now: Date) =>
  (await wrongTries(tx, userId, now)).count >= CODE_LIMITS.wrongDay;
async function countWrongTry(tx: Executor, userId: string, now: Date) {
  const id = wrongTriesId(userId);
  const { count, until } = await wrongTries(tx, userId, now);
  await tx.delete(verifications).where(eq(verifications.identifier, id));
  await tx.insert(verifications).values({
    id: randomUUID(),
    identifier: id,
    value: String(count + 1),
    expiresAt: until,
    createdAt: now,
    updatedAt: now,
  });
}
/** A code waiting, in its row's `value`: its hash and wrong tries, never the code. */
type WaitingCode = { hash: string; tries: number };
const waitingCode = (value: string): WaitingCode | null => {
  try {
    const v = JSON.parse(value) as Partial<WaitingCode>;
    return typeof v.hash === "string" && typeof v.tries === "number" ? { hash: v.hash, tries: v.tries } : null;
  } catch {
    return null;
  }
};

/**
 * Emails `userId` a code that proves it's them before deleting the workspace `orgId`, or their account when it is null
 * (ADR 0088 §2), with the rules of every emailed code (`email-codes.ts`): it works for 10 minutes, a new one replaces it
 * after 60 s at the soonest, and an account gets `CODE_LIMITS` an hour and a day, and none once its wrong tries for the
 * day are spent, since no code would be taken then. The email says what it deletes and whom to write to if it wasn't
 * them. Only where the server sends email: the routes check it.
 */
export async function sendDeletionCode(
  deps: { db: Database; rateLimiter: RateLimiter; emails: { publicUrl: string; support?: string | null } },
  userId: string,
  orgId: string | null,
  now = new Date(),
) {
  const { db } = deps;
  const [account] = await db
    .select({ email: users.email, locale: users.locale, blockedAt: users.blockedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!account || account.blockedAt) throw new ForbiddenError();
  const org = orgId ? await getOrganization(db, orgId) : null;
  if (orgId && !org) throw new NotFoundError("This workspace no longer exists");
  const id = deletionCodeId(userId, orgId);
  return db.transaction(async (tx) => {
    await lockDeletionCodes(tx, userId);
    if (await triesSpent(tx, userId, now)) throw codeLimit("reauth");
    const [row] = await tx
      .select({ sentAt: verifications.createdAt })
      .from(verifications)
      .where(eq(verifications.identifier, id));
    const wait = codeWaitMs(row?.sentAt, now);
    if (wait > 0) throw codeWait("reauth", wait);
    // ponytail: counted in the rate limiter (in memory on a self-hosted server), so a restart resets them; count them
    // in the database, as asking to join does, if that ever matters.
    const caps = [
      ["hour", CODE_LIMITS.hour, HOUR_MS],
      ["day", CODE_LIMITS.day, DAY_MS],
    ] as const;
    for (const [span, limit, windowMs] of caps) {
      const spent = await deps.rateLimiter.consume(`deletion-code:${span}:${userId}`, { limit, windowMs });
      if (!spent.allowed) throw codeLimit("reauth");
    }
    const code = newCode();
    await tx.delete(verifications).where(eq(verifications.identifier, id));
    await tx.insert(verifications).values({
      id: randomUUID(),
      identifier: id,
      value: JSON.stringify({ hash: deletionCodeHash(id, code), tries: 0 } satisfies WaitingCode),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      createdAt: now,
      updatedAt: now,
    });
    await queueEmail(tx, {
      orgId: null,
      key: `deletion-code:${sha256(id)}:${now.getTime()}`,
      to: [account.email],
      template: {
        kind: "deletion_code",
        locale: emailLocale(account.locale),
        code,
        email: account.email,
        ...(org ? { orgName: org.name, ...(await modeStamp(tx, org.id)) } : {}),
        support: deps.emails.support ?? null,
        url: deps.emails.publicUrl.replace(/\/$/, ""),
      },
      maxAttempts: 3,
      runAt: now,
    });
    return { email: account.email, resendIn: CODE_RESEND_SECONDS };
  });
}

/**
 * Spends the code that proves it's `userId` before deleting the workspace `orgId` (their account when null): right, it
 * is used up, so it proves one deletion. A wrong one counts against it (`CODE_TRIES`) and against the account's day
 * (`CODE_LIMITS.wrongDay`): once that is spent, every code is refused unread until the day ends, so a guess past it
 * learns nothing. A code sent for anything else, or to anyone else, is wrong here. Throws `reauth.code_wrong`,
 * `reauth.code_expired`, `reauth.code_tries` or, for the day's, `reauth.code_limit`.
 */
export async function spendDeletionCode(
  deps: { db: Database },
  userId: string,
  orgId: string | null,
  code: string,
  now = new Date(),
) {
  const id = deletionCodeId(userId, orgId);
  const refused = await deps.db.transaction(async (tx) => {
    await lockDeletionCodes(tx, userId);
    if (await triesSpent(tx, userId, now)) return "limit";
    const [row] = await tx.select().from(verifications).where(eq(verifications.identifier, id));
    const waiting = row ? waitingCode(row.value) : null;
    const verdict = codeVerdict(
      waiting && row ? { ...waiting, expiresAt: row.expiresAt } : null,
      deletionCodeHash(id, code),
      now,
    );
    if (verdict === "right") {
      await tx.delete(verifications).where(eq(verifications.identifier, id));
      return null;
    }
    if (verdict === "none" || !waiting) return "wrong";
    if (verdict !== "miss") return verdict;
    const tries = waiting.tries + 1;
    await tx
      .update(verifications)
      .set({ value: JSON.stringify({ ...waiting, tries } satisfies WaitingCode), updatedAt: now })
      .where(eq(verifications.identifier, id));
    await countWrongTry(tx, userId, now);
    return tries >= CODE_TRIES ? "tries" : "wrong";
  });
  if (refused === "limit") throw codeLimit("reauth");
  if (refused) throw codeRefusal("reauth", refused);
}

/** Deletion codes that ran out a day ago: their rows go (the hourly `deletions` tick). */
export async function pruneDeletionCodes(db: Database, now = new Date()) {
  await db
    .delete(verifications)
    .where(
      and(
        like(verifications.identifier, "deletion-code:%"),
        lte(verifications.expiresAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
}

/**
 * Deletes a workspace after `WORKSPACE_DELETION_DAYS` (`org.delete` then): it turns read-only for everyone now, and
 * its work stops. `owner`: an owner asked (read again under the lock), refused while it is suspended, and its members are
 * emailed. `account`: its only member deleted their account, whatever its standing. Already being deleted, it keeps
 * its date (`scheduled` false) and nobody is told again.
 */
export async function scheduleDeletion(deps: DeletionDeps, actorId: string, orgId: string, via: DeletionVia) {
  const { dueAt, closed } = await deps.db.transaction(async (tx) => {
    await lockOrgMembers(tx, orgId);
    if (via === "owner") {
      const [me] = await tx
        .select({ role: organizationMembers.role, standing: STANDING_COLUMNS })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, actorId)));
      if (me?.role !== "owner") throw new ForbiddenError("Only an owner can delete the workspace");
      const refusal = closedRefusal(me.standing);
      if (refusal instanceof OrgPausedError) throw refusal;
    }
    return closeForDeletion(tx, { actorId, orgId, via, emails: deps.emails });
  });
  if (closed) await afterClosing(deps, closed);
  return { dueAt, scheduled: closed !== null };
}

/**
 * Closes a workspace for deletion in the caller's transaction, which holds its `lockOrgMembers`: its date
 * `WORKSPACE_DELETION_DAYS` out, who asked, the audit row, the operator's event and `org.delete` at the date. A computer
 * it still waits for is awaited no more, as for a hold. With `emails` and an owner's deletion, every member is told in
 * their language and time zone. The jobs carry no org_id, so the workspace's cascade leaves them. `closed` is null when
 * it already was being deleted: it keeps its date.
 */
export async function closeForDeletion(
  tx: Executor,
  input: { actorId: string; orgId: string; via: DeletionVia; emails?: { publicUrl: string } | null },
): Promise<{ dueAt: Date; closed: Closed | null }> {
  const { actorId, orgId, via } = input;
  const [row] = await tx
    .update(organizations)
    .set({
      deletionDueAt: sql`now() + make_interval(days => ${WORKSPACE_DELETION_DAYS})`,
      deletionRequestedAt: sql`now()`,
      deletionRequestedBy: actorId,
    })
    .where(and(eq(organizations.id, orgId), isNull(organizations.deletionDueAt)))
    .returning({ dueAt: organizations.deletionDueAt, name: organizations.name });
  const dueAt = row?.dueAt;
  if (!row || !dueAt) {
    const [org] = await tx
      .select({ dueAt: organizations.deletionDueAt })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org?.dueAt) throw new NotFoundError("This workspace no longer exists");
    return { dueAt: org.dueAt, closed: null };
  }
  await tx
    .delete(machineProvisioning)
    .where(and(eq(machineProvisioning.orgId, orgId), ne(machineProvisioning.state, "ready")));
  const due = dueAt.toISOString();
  await recordAudit(tx, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "organization.deletion_scheduled",
    target: { type: "organization", id: orgId },
    details: { dueAt: due, via },
  });
  await recordOperatorEvent(tx, {
    type: "organization.deletion_requested",
    orgId,
    userId: actorId,
    data: { dueAt: due, via },
  });
  const by = { id: actorId, name: await nameOf(tx, actorId) };
  if (input.emails && via === "owner") {
    const url = workspaceUrl(input.emails.publicUrl, orgId);
    const mode = await modeStamp(tx, orgId);
    for (const member of await membersToTell(tx, orgId)) {
      await queueEmail(tx, {
        orgId: null,
        key: `workspace-deleting:${orgId}:${dueAt.getTime()}:${member.id}`,
        to: [member.email],
        template: {
          kind: "workspace_deleting",
          locale: emailLocale(member.locale),
          orgName: row.name,
          byName: by.name,
          dueAt: due,
          timeZone: member.timeZone,
          owner: member.role === "owner",
          url,
          ...mode,
        },
      });
    }
  }
  await enqueue(tx, {
    orgId: null,
    kind: ORG_DELETE_JOB,
    payload: { orgId },
    runAt: dueAt,
    dedupeKey: `${ORG_DELETE_JOB}:${orgId}:${dueAt.getTime()}`,
  });
  return { dueAt, closed: { orgId, dueAt, by } };
}

/**
 * What follows a deletion's commit: the cached standing goes, its people's apps hear it and turn read-only, and its
 * work stops.
 */
export async function afterClosing(deps: DeletionDeps, closed: Closed) {
  caches.standing.delete(`${closed.orgId}:`);
  const event: OrgDeletingEvent = {
    type: "org.deleting",
    orgId: closed.orgId,
    dueAt: closed.dueAt.toISOString(),
    by: closed.by,
  };
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId: closed.orgId, event });
  await stopOrgWork(deps, closed.orgId, new OrgDeletingError(null).message, "org_deleting");
}

/**
 * Restores a workspace being deleted: an owner, with no proof, since it destroys nothing. Only before its date
 * (`org.not_restorable` after), never while suspended. One waiting for its first plan comes back only while its owner
 * waits on no other (`org.create_unpaid`). The operator's deletion hold stays as it is. Its members are told. What
 * stopped while it was closed stays stopped, and its routines fire again at their next time. `account`: it closed with
 * its member's account and comes back with it, whatever their role, nobody else to tell, and its feed event says so:
 * a plan that stopped renewing stays that way until the person turns it on (a billing service reads `via`).
 */
export async function restoreWorkspace(
  deps: DeletionDeps,
  actorId: string,
  orgId: string,
  options: { account?: boolean } = {},
) {
  await deps.db.transaction(async (tx) => {
    // The plan rule below can't race a new workspace of theirs.
    await lockWorkspacesOf(tx, actorId);
    await lockOrgMembers(tx, orgId);
    const [org] = await tx
      .select({
        name: organizations.name,
        standing: STANDING_COLUMNS,
        restorable,
        role: organizationMembers.role,
      })
      .from(organizations)
      .leftJoin(
        organizationMembers,
        and(eq(organizationMembers.orgId, organizations.id), eq(organizationMembers.userId, actorId)),
      )
      .where(eq(organizations.id, orgId));
    if (!org) throw new NotFoundError("This workspace no longer exists");
    if (org.role !== "owner" && !(options.account && org.role))
      throw new ForbiddenError("Only an owner can restore the workspace");
    const refusal = closedRefusal(org.standing);
    if (refusal instanceof OrgPausedError) throw refusal;
    const dueAt = org.standing.deletionDueAt;
    if (!dueAt || !org.restorable) {
      throw new ConflictError("This workspace can't be restored anymore", "org.not_restorable");
    }
    if (waitsForPlan({ ...org.standing, deletionDueAt: null })) {
      const theirs = await tx
        .select({ id: organizations.id, standing: STANDING_COLUMNS })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
        .where(
          and(
            eq(organizationMembers.userId, actorId),
            eq(organizationMembers.role, "owner"),
            ne(organizations.id, orgId),
          ),
        );
      const other = theirs.find((o) => waitsForPlan(o.standing));
      if (other) {
        throw new ForbiddenError("You already have a workspace waiting for a plan", "org.create_unpaid", {
          orgId: other.id,
        });
      }
    }
    await tx
      .update(organizations)
      .set({ deletionDueAt: null, deletionRequestedAt: null, deletionRequestedBy: null })
      .where(eq(organizations.id, orgId));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "organization.deletion_canceled",
      target: { type: "organization", id: orgId },
      details: { dueAt: dueAt.toISOString() },
    });
    await recordOperatorEvent(tx, {
      type: "organization.deletion_canceled",
      orgId,
      userId: actorId,
      ...(options.account ? { data: { via: "account" } } : {}),
    });
    if (!deps.emails || options.account) return;
    const url = workspaceUrl(deps.emails.publicUrl, orgId);
    const byName = await nameOf(tx, actorId);
    const mode = await modeStamp(tx, orgId);
    for (const member of await membersToTell(tx, orgId)) {
      await queueEmail(tx, {
        orgId: null,
        key: `workspace-restored:${orgId}:${dueAt.getTime()}:${member.id}`,
        to: [member.email],
        template: {
          kind: "workspace_restored",
          locale: emailLocale(member.locale),
          orgName: org.name,
          byName,
          url,
          ...mode,
        },
      });
    }
  });
  caches.standing.delete(`${orgId}:`);
}

const nameOf = async (tx: Executor, userId: string) =>
  (await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)))[0]?.name ?? "";

/** Who is told about a workspace: its members, blocked accounts aside, with their language and time zone. */
function membersToTell(tx: Executor, orgId: string) {
  return tx
    .select({
      id: users.id,
      email: users.email,
      locale: users.locale,
      role: organizationMembers.role,
      timeZone: sql<string>`coalesce(${organizationMembers.timezone}, ${organizationSettings.timezone}, 'UTC')`,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(organizationSettings, eq(organizationSettings.orgId, organizationMembers.orgId))
    .where(and(eq(organizationMembers.orgId, orgId), accountInUse));
}

export interface PurgeDeps {
  db: Database;
  pubsub?: PubSub;
  /** Revokes its GitHub OAuth grants at GitHub (absent, or without the GitHub app: none can be). */
  connectors?: ConnectorDeps;
  /** Uninstalls the server's GitHub App from the workspace's GitHub accounts (absent, or no app: none can be). */
  githubApp?: GitHubAppAccess;
  /** Has Composio forget its mailboxes (absent, or without it: none can be). */
  mail?: MailAdapters | null;
  log?: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
}

/**
 * The `org.delete` job: deletes a workspace past its date that nothing keeps, else does nothing (restored, kept or
 * gone; the hourly `enqueueOverdueDeletions` comes back once a hold lifts). First its AI accounts leave its online
 * computers (an offline one keeps them, and its token dies with the workspace). Then its outside grants are revoked
 * while their sealed copies exist: a failure fails the job, which retries, and its final attempt goes on and logs the
 * ids it couldn't revoke. Then one transaction, which checks again under the row's lock (a hold that committed first
 * wins), deletes it with everything that cascades and what doesn't (`PURGED_BY_HAND`), and queues its files' purge.
 * Its computers are told they were removed. Returns whether it was deleted.
 */
export async function purgeWorkspace(deps: PurgeDeps, orgId: string, options: { finalAttempt?: boolean } = {}) {
  const { db } = deps;
  const dueColumns = { ...STANDING_COLUMNS, deletionHoldAt: organizations.deletionHoldAt };
  // Under the lock restoring takes: a restore under way commits first and is seen here, and a later one finds its date
  // passed, so nothing below is ever undone.
  const [org] = await db.transaction(async (tx) => {
    await lockOrgMembers(tx, orgId);
    return tx
      .select(dueColumns)
      .from(organizations)
      .where(and(eq(organizations.id, orgId), pastDue))
      .for("update");
  });
  if (!org || keptFromDeletion(org)) return false;

  const released = await db.transaction((tx) => releaseOrgAccounts(tx, orgId));
  await announceReleasedAccounts(deps.pubsub, released);
  await accountsSignedOut(db, orgId, released);

  const left = await revokeGrants(deps, orgId);
  if (left.length > 0) {
    if (!options.finalAttempt) throw new Error(`Grants not revoked yet: ${left.join(", ")}`);
    deps.log?.warn("workspace deletion went on with grants not revoked", { orgId, ids: left });
  }

  const gone = await db.transaction(async (tx) => {
    await lockOrgMembers(tx, orgId);
    const [row] = await tx
      .select({
        ...dueColumns,
        requestedAt: organizations.deletionRequestedAt,
        requestedBy: organizations.deletionRequestedBy,
      })
      .from(organizations)
      .where(and(eq(organizations.id, orgId), pastDue))
      .for("update");
    if (!row || keptFromDeletion(row)) return null;
    await tx.delete(messageReactions).where(eq(messageReactions.orgId, orgId));
    await tx.delete(routingDecisions).where(eq(routingDecisions.orgId, orgId));
    await tx.delete(threadReflections).where(eq(threadReflections.orgId, orgId));
    await tx.delete(usageRecords).where(eq(usageRecords.orgId, orgId));
    await tx.delete(wikiLinks).where(eq(wikiLinks.orgId, orgId));
    // By its org_id, not through the runs: a run deleted earlier (a restarted one) leaves its rows behind.
    // ponytail: no index on context_usage.org_id, one scan per purge; index it if purges get slow.
    await tx.delete(contextUsage).where(eq(contextUsage.orgId, orgId));
    // Its row only: the feedback sweep removes bytes with no row left (`sweepFeedbackFiles`).
    await tx.delete(feedbackFiles).where(eq(feedbackFiles.orgId, orgId));
    const via = await requestedVia(tx, orgId);
    await recordOperatorEvent(tx, {
      type: "organization.deleted",
      orgId,
      userId: row.requestedBy,
      data: { requestedAt: row.requestedAt?.toISOString() ?? null, via },
    });
    await queueOrgFilesPurge(tx, orgId);
    const computers = await tx
      .select({ id: machines.id })
      .from(machines)
      .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)));
    const installs = await tx
      .select({ id: githubAppInstallations.installationId })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.orgId, orgId));
    // ponytail: one cascading delete; batch it by table if a workspace's delete ever outlives the job's renewed lease.
    await tx.delete(organizations).where(eq(organizations.id, orgId));
    return { computers, installs, requestedBy: row.requestedBy, via };
  });
  if (!gone) return false;
  for (const computer of gone.computers) {
    await deps.pubsub
      ?.publish(MACHINE_CONTROL_TOPIC, { type: "machine.revoke", machineId: computer.id })
      .catch(() => undefined);
  }
  for (const install of gone.installs) forgetInstallationTokens(install.id);
  caches.standing.delete(`${orgId}:`);
  // On a server without the operator API, the only trace it leaves.
  deps.log?.info("workspace deleted", { orgId, requestedBy: gone.requestedBy, via: gone.via });
  return true;
}

/** How its deletion was asked for, as its own audit log recorded it. */
async function requestedVia(tx: Executor, orgId: string): Promise<DeletionVia> {
  const [scheduled] = await tx
    .select({ via: sql<string | null>`${auditLog.details}->>'via'` })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "organization.deletion_scheduled")))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return scheduled?.via === "account" ? "account" : "owner";
}

/** Waits, at most `ACCOUNTS_WAIT_MS`, until its online computers that remove accounts hold none of its tombstones. */
async function accountsSignedOut(db: Database, orgId: string, released: ReleasedAccounts) {
  const ids = released.machines.map((m) => m.machineId);
  if (ids.length === 0) return;
  const rows = await db
    .select({
      id: machines.id,
      online: machines.online,
      lastSeenAt: machines.lastSeenAt,
      deletedAt: machines.deletedAt,
      protocol: machines.protocol,
    })
    .from(machines)
    .where(inArray(machines.id, ids));
  const waiting = rows.filter((m) => machineOnline(m) && m.protocol >= ACCOUNTS_PROTOCOL).map((m) => m.id);
  const until = Date.now() + ACCOUNTS_WAIT_MS;
  while (waiting.length > 0 && Date.now() < until) {
    const [left] = await db
      .select({ id: machineAccounts.id })
      .from(machineAccounts)
      .where(
        and(
          eq(machineAccounts.orgId, orgId),
          eq(machineAccounts.status, "removing"),
          inArray(machineAccounts.machineId, waiting),
        ),
      )
      .limit(1);
    if (!left) return;
    await Bun.sleep(250);
  }
}

/**
 * Revokes the grants a workspace holds outside: Composio forgets the accounts of its connectors and of every Connect
 * Link it made for one (never revoked there: Composio's apps share one grant across toolkits and workspaces) and its
 * mailboxes (their triggers, and the accounts, which revokes them at Google or Microsoft unless another connection
 * still uses the same grant), MillionSend the webhooks of inboxes left from the withdrawn path whose boot cleanup
 * failed (their sealed keys go with the workspace), and GitHub its OAuth tokens and the app's installations. Each is
 * marked as it goes, so a retry skips it. Returns the ids of the mailboxes, connections, Composio accounts and
 * installations that failed; never a token.
 */
async function revokeGrants(deps: PurgeDeps, orgId: string): Promise<string[]> {
  const { db } = deps;
  const left: string[] = [];
  const composio = deps.mail?.composio;
  if (composio) {
    // Connectors first: once they are gone, they no longer keep this workspace's mailboxes' grants (below).
    const accounts = await db
      .select({ id: connectorConnections.id, accountId: connectorConnections.composioAccountId })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.orgId, orgId), isNotNull(connectorConnections.composioAccountId)));
    const forgotten = new Set<string>();
    for (const account of accounts) {
      try {
        await composio.client.deleteConnectedAccount(account.accountId ?? "", { revoke: false });
      } catch {
        left.push(account.id);
        continue;
      }
      forgotten.add(account.accountId ?? "");
      await db
        .update(connectorConnections)
        .set({ composioAccountId: null, revokedAt: sql`coalesce(${connectorConnections.revokedAt}, now())` })
        .where(eq(connectorConnections.id, account.id));
    }
    // A link's account that no connection holds: a sign-in that never finished, or one someone else finished on it.
    const links = await db
      .select({ accountId: oauthStates.composioAccountId })
      .from(oauthStates)
      .where(and(eq(oauthStates.orgId, orgId), isNotNull(oauthStates.composioAccountId)));
    for (const accountId of new Set(links.map((l) => l.accountId ?? ""))) {
      if (!forgotten.has(accountId)) {
        try {
          await composio.client.deleteConnectedAccount(accountId, { revoke: false });
        } catch {
          left.push(accountId);
          continue;
        }
      }
      await db
        .update(oauthStates)
        .set({ composioAccountId: null })
        .where(and(eq(oauthStates.orgId, orgId), eq(oauthStates.composioAccountId, accountId)));
    }
    const boxes = await db
      .select({
        id: mailAccounts.id,
        address: mailAccounts.address,
        provider: mailAccounts.provider,
        externalAccountId: mailAccounts.externalAccountId,
      })
      .from(mailAccounts)
      .where(and(eq(mailAccounts.orgId, orgId), eq(mailAccounts.via, "composio")));
    const watches = await db
      .select({ accountId: mailWatches.accountId, triggerId: mailWatches.externalTriggerId })
      .from(mailWatches)
      .where(and(eq(mailWatches.orgId, orgId), isNotNull(mailWatches.externalTriggerId)));
    for (const box of boxes) {
      const triggers = watches.flatMap((w) => (w.accountId === box.id && w.triggerId ? [w.triggerId] : []));
      if (!box.externalAccountId && triggers.length === 0) continue;
      try {
        await forgetAtComposio(composio.client, box.externalAccountId, triggers, !(await composioGrantShared(db, box)));
      } catch {
        left.push(box.id);
        continue;
      }
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx
          .update(mailAccounts)
          .set({ externalAccountId: null, revokedAt: sql`coalesce(${mailAccounts.revokedAt}, now())`, updatedAt: now })
          .where(eq(mailAccounts.id, box.id));
        await tx
          .update(mailWatches)
          .set({ externalTriggerId: null, updatedAt: now })
          .where(eq(mailWatches.accountId, box.id));
      });
    }
  }
  const keyWrappers = deps.connectors?.keyWrappers;
  if (keyWrappers) left.push(...(await retireMillionSendMailboxes({ db, keyWrappers, orgId })).webhooksLeft);
  const connectors = deps.connectors;
  if (connectors?.oauthApps?.github) {
    const grants = await db
      .select({ id: connectorConnections.id })
      .from(connectorConnections)
      .where(
        and(
          eq(connectorConnections.orgId, orgId),
          eq(connectorConnections.connector, "github"),
          eq(connectorConnections.authType, "oauth"),
          isNull(connectorConnections.revokedAt),
        ),
      );
    for (const grant of grants) {
      if (!(await revokeAtProvider(connectors, orgId, grant.id).catch(() => false))) {
        left.push(grant.id);
        continue;
      }
      await db.update(connectorConnections).set({ revokedAt: new Date() }).where(eq(connectorConnections.id, grant.id));
    }
  }
  // The app's installations reach the workspace's repositories with no one left to use them: uninstalled there, as
  // removing one does (ADR 0156); left installed, anyone who can see one could bind it to another workspace.
  const app = deps.githubApp?.app();
  if (app && deps.githubApp) {
    const installs = await db
      .select({ id: githubAppInstallations.id, installationId: githubAppInstallations.installationId })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.orgId, orgId));
    for (const i of installs) {
      if ((await uninstallInstallation(app, deps.githubApp.http, i.installationId)) === "refused") {
        left.push(i.id);
        continue;
      }
      await db.delete(githubAppInstallations).where(eq(githubAppInstallations.id, i.id));
      forgetInstallationTokens(i.installationId);
    }
  }
  return left;
}

/**
 * Queues `org.delete` for every workspace past its date that nothing keeps, at most once an hour each: for a hold that
 * lifted after the date, a job that failed for good, or one a deploy lost. Returns how many are due.
 */
export async function enqueueOverdueDeletions(db: Database, now = new Date()) {
  const due = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(lte(organizations.deletionDueAt, now), sql`not ${keptOrg}`));
  const hour = now.toISOString().slice(0, 13);
  for (const { id } of due) {
    await enqueue(db, {
      orgId: null,
      kind: ORG_DELETE_JOB,
      payload: { orgId: id },
      dedupeKey: `${ORG_DELETE_JOB}:${id}:${hour}`,
    });
  }
  return due.length;
}

/**
 * The operator's deletion hold (a legal hold), or letting it go: while held, a deletion past its date waits. It refuses
 * nothing and the workspace is told nothing, no audit row and no notice. Restoring never lifts it. Null when there is
 * no such workspace.
 */
export async function setDeletionHold(db: Database, orgId: string, change: { held: boolean; reason: string | null }) {
  const [row] = await db
    .update(organizations)
    .set(
      change.held
        ? { deletionHoldAt: sql`coalesce(${organizations.deletionHoldAt}, now())`, deletionHoldReason: change.reason }
        : { deletionHoldAt: null, deletionHoldReason: null },
    )
    .where(eq(organizations.id, orgId))
    .returning({ heldAt: organizations.deletionHoldAt, reason: organizations.deletionHoldReason });
  return row ?? null;
}

/**
 * The deletions of these workspaces, by id, for their people: when each goes for good, when it was asked, and by whom
 * (null once their account is gone). Only the ones being deleted.
 */
export async function workspaceDeletions(db: Executor, orgIds: string[]) {
  const rows =
    orgIds.length === 0
      ? []
      : await db
          .select({
            orgId: organizations.id,
            dueAt: organizations.deletionDueAt,
            requestedAt: organizations.deletionRequestedAt,
            byId: users.id,
            byName: users.name,
          })
          .from(organizations)
          .leftJoin(users, eq(users.id, organizations.deletionRequestedBy))
          .where(and(inArray(organizations.id, orgIds), isNotNull(organizations.deletionDueAt)));
  return new Map(
    rows.flatMap((r) =>
      r.dueAt
        ? [
            [
              r.orgId,
              {
                dueAt: r.dueAt,
                requestedAt: r.requestedAt,
                requestedBy: r.byId ? { id: r.byId, name: r.byName ?? "" } : null,
              },
            ] as const,
          ]
        : [],
    ),
  );
}

// ── Deleting an account ─────────────────────────────────────────────────────

/**
 * How many agents and messages each workspace holds, for the preflight to say what closes: agents as the workspace
 * counts them, without the right hand every workspace has. Kept out of `accountDeletionPlan`, which `deleteAccount`
 * runs under its locks.
 */
export async function workspaceContents(db: Executor, orgIds: string[]) {
  const counted = await Promise.all(
    orgIds.map(async (id) => {
      const [row] = await db
        .select({
          agents: sql<number>`(select count(*) from ${agents} where ${agents.orgId} = ${id}
            and ${agents.archivedAt} is null and ${agents.deletedAt} is null
            and ${agents.builtin} is null)`.mapWith(Number),
          messages: orgMessageCount(id),
        })
        .from(organizations)
        .where(eq(organizations.id, id));
      return [id, row ?? { agents: 0, messages: 0 }] as const;
    }),
  );
  return new Map(counted);
}

/** What deleting an account does, workspace by workspace (`accountDeletionPlan`). */
export interface AccountDeletionPlan {
  /**
   * Nobody else in use is in it: it closes with the account and goes on the account's date. One already being deleted
   * keeps its date (`dueAt`; null for the others).
   */
  closes: { id: string; name: string; dueAt: Date | null }[];
  /** Others are in it: they leave it. */
  leaves: { id: string; name: string; role: MemberRole }[];
  /** They are its only owner, others are in it, and it isn't being deleted: the account can't go yet. */
  soleOwner: { id: string; name: string }[];
  /** The computers they connected in the workspaces they leave (`personalMachines`): they go with the account. */
  computers: { orgId: string; id: string; name: string }[];
  /** Keys, connections and mailboxes they added to the workspaces they leave: those are the workspace's, and stay. */
  staysBehind: { orgId: string; kind: "key" | "connection" | "mailbox"; name: string }[];
}

/**
 * What deleting `userId`'s account does: its preflight shows it (`GET /account/deletion`), and `deleteAccount` acts on
 * it under its locks.
 */
export async function accountDeletionPlan(db: Executor, userId: string): Promise<AccountDeletionPlan> {
  const plan: AccountDeletionPlan = { closes: [], leaves: [], soleOwner: [], computers: [], staysBehind: [] };
  const mine = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      role: organizationMembers.role,
      dueAt: organizations.deletionDueAt,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.createdAt));
  if (mine.length === 0) return plan;
  const counts = await db
    .select({
      orgId: organizationMembers.orgId,
      others: sql<number>`count(*)::int`,
      owners: sql<number>`(count(*) filter (where ${organizationMembers.role} = 'owner'))::int`,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        inArray(
          organizationMembers.orgId,
          mine.map((o) => o.id),
        ),
        ne(organizationMembers.userId, userId),
        // An account waiting for its own date is leaving too: it keeps nothing open, and owns nothing for anyone.
        isNull(users.deletionDueAt),
      ),
    )
    .groupBy(organizationMembers.orgId);
  for (const org of mine) {
    const count = counts.find((c) => c.orgId === org.id);
    if (Number(count?.others ?? 0) === 0) {
      plan.closes.push({ id: org.id, name: org.name, dueAt: org.dueAt });
      continue;
    }
    plan.leaves.push({ id: org.id, name: org.name, role: org.role });
    if (org.role === "owner" && Number(count?.owners ?? 0) === 0 && org.dueAt === null) {
      plan.soleOwner.push({ id: org.id, name: org.name });
    }
  }
  const left = plan.leaves.map((o) => o.id);
  if (left.length === 0) return plan;
  plan.computers = (await personalMachines(db, userId, left)).map(({ orgId, id, name }) => ({ orgId, id, name }));
  const keys = await db
    .select({ orgId: providerCredentials.orgId, name: providerCredentials.label })
    .from(providerCredentials)
    .where(
      and(
        inArray(providerCredentials.orgId, left),
        eq(providerCredentials.createdByUserId, userId),
        isNull(providerCredentials.revokedAt),
      ),
    );
  const connectors = await db
    .select({ orgId: connectorConnections.orgId, name: connectorConnections.label })
    .from(connectorConnections)
    .where(
      and(
        inArray(connectorConnections.orgId, left),
        eq(connectorConnections.createdByUserId, userId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  const databases = await db
    .select({ orgId: dbConnections.orgId, name: dbConnections.label })
    .from(dbConnections)
    .where(
      and(
        inArray(dbConnections.orgId, left),
        eq(dbConnections.createdByUserId, userId),
        isNull(dbConnections.revokedAt),
      ),
    );
  const mailboxes = await db
    .select({
      orgId: mailAccounts.orgId,
      name: sql<string>`coalesce(nullif(${mailAccounts.address}, ''), ${mailAccounts.label})`,
    })
    .from(mailAccounts)
    .where(
      and(inArray(mailAccounts.orgId, left), eq(mailAccounts.createdByUserId, userId), isNull(mailAccounts.revokedAt)),
    );
  plan.staysBehind = [
    ...keys.map((k) => ({ ...k, kind: "key" as const })),
    ...[...connectors, ...databases].map((c) => ({ ...c, kind: "connection" as const })),
    ...mailboxes.map((m) => ({ ...m, kind: "mailbox" as const })),
  ];
  return plan;
}

/** `sole_owner`, with the names and ids of the workspaces that keep the account from going; null when none does. */
export function soleOwnerRefusal(plan: Pick<AccountDeletionPlan, "soleOwner">) {
  if (plan.soleOwner.length === 0) return null;
  return new ConflictError(
    "You are the only owner of a workspace that has other members. Make someone else an owner, or delete the workspace, first.",
    "sole_owner",
    { organizations: plan.soleOwner.map((o) => o.name), orgIds: plan.soleOwner.map((o) => o.id) },
  );
}

/**
 * Deletes an account in `ACCOUNT_DELETION_DAYS`, as a workspace's deletion does (ADR 0088 §10): the caller checked it's
 * them. Refused for a blocked account and with `sole_owner`, under the same locks as `deleteAccount`. Its sessions and
 * phones go now and every membership reads it as no member (`accountInUse`), but nothing else leaves: its memberships,
 * sign-in methods and computers wait for `account.delete` at the date, so restoring is whole. Workspaces only they are
 * in close now, on the same date (the transaction's clock), and one already being deleted keeps its own. Already
 * waiting, it keeps its date. The feed's `user.deletion_requested` stops the plans it pays for, which a restore leaves
 * off (`restoreAccount`). Their email says when it goes and how to come back.
 */
export async function scheduleAccountDeletion(deps: DeletionDeps, userId: string) {
  const { dueAt, closed, orgs } = await deps.db.transaction(async (tx) => {
    await lockWorkspacesOf(tx, userId);
    const mine = await tx
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizationMembers.orgId));
    // Every workspace row before the user row, as `deleteAccount` writes them.
    for (const m of mine) await lockOrgMembers(tx, m.orgId);
    const [account] = await tx
      .select({ dueAt: users.deletionDueAt, blockedAt: users.blockedAt, email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, userId));
    if (!account || account.blockedAt) throw new ForbiddenError();
    if (account.dueAt) return { dueAt: account.dueAt, closed: [], orgs: [] };
    const plan = await accountDeletionPlan(tx, userId);
    const refusal = soleOwnerRefusal(plan);
    if (refusal) throw refusal;
    const closed: Closed[] = [];
    for (const org of plan.closes) {
      const scheduled = await closeForDeletion(tx, { actorId: userId, orgId: org.id, via: "account" });
      if (scheduled.closed) closed.push(scheduled.closed);
    }
    const [row] = await tx
      .update(users)
      .set({
        deletionDueAt: sql`now() + make_interval(days => ${ACCOUNT_DELETION_DAYS})`,
        deletionRequestedAt: sql`now()`,
      })
      .where(eq(users.id, userId))
      .returning({ dueAt: users.deletionDueAt });
    const dueAt = row?.dueAt;
    if (!dueAt) throw new NotFoundError("This account no longer exists");
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(pushDevices).where(eq(pushDevices.userId, userId));
    for (const m of mine) await followOwner(tx, m.orgId);
    await recordOperatorEvent(tx, { type: "user.deletion_requested", userId, data: { dueAt: dueAt.toISOString() } });
    await enqueueAccountContact(tx, userId);
    if (deps.emails) {
      const names = closed.length
        ? await tx
            .select({ name: organizations.name })
            .from(organizations)
            .where(
              inArray(
                organizations.id,
                closed.map((c) => c.orgId),
              ),
            )
            .orderBy(asc(organizations.createdAt))
        : [];
      const [zone] = await tx
        .select({
          timeZone: sql<string>`coalesce(${organizationMembers.timezone}, ${organizationSettings.timezone}, 'UTC')`,
        })
        .from(organizationMembers)
        .leftJoin(organizationSettings, eq(organizationSettings.orgId, organizationMembers.orgId))
        .where(eq(organizationMembers.userId, userId))
        .orderBy(asc(organizationMembers.createdAt))
        .limit(1);
      await queueEmail(tx, {
        orgId: null,
        key: `account-deleting:${userId}:${dueAt.getTime()}`,
        to: [account.email],
        template: {
          kind: "account_deleting",
          locale: emailLocale(account.locale),
          email: account.email,
          orgNames: names.map((o) => o.name),
          dueAt: dueAt.toISOString(),
          timeZone: zone?.timeZone || "UTC",
          support: deps.emails.support ?? null,
          url: deps.emails.publicUrl.replace(/\/$/, ""),
        },
      });
    }
    await enqueue(tx, {
      orgId: null,
      kind: ACCOUNT_DELETE_JOB,
      payload: { userId },
      runAt: dueAt,
      dedupeKey: `${ACCOUNT_DELETE_JOB}:${userId}:${dueAt.getTime()}`,
    });
    return { dueAt, closed, orgs: mine };
  });
  // Their open sockets lose every subscription now.
  for (const m of orgs) {
    await publishOrgEvent(deps.pubsub, { type: "membership.revoked", orgId: m.orgId, userId, quiet: true });
    await announceMembers(deps.pubsub, m.orgId);
  }
  for (const one of closed) await afterClosing(deps, one);
  return { dueAt };
}

/**
 * Brings back an account waiting for its deletion: only before its date (`account.not_restorable` after), by the same
 * clock and under the same lock as `deleteAccount`, so neither can undo the other. No proof: it destroys nothing, and
 * only its own session gets here. Workspaces that closed with it (same date, asked by them) come back; one that can't
 * yet stays as it was: suspended, on its screen, or waiting for a plan another of theirs waits for, read-only under its
 * line, where its Restaurar says why. Plans that stopped renewing stay stopped: nothing charges until the person turns one on.
 */
export async function restoreAccount(deps: DeletionDeps, userId: string) {
  const { closed, mine } = await deps.db.transaction(async (tx) => {
    await lockWorkspacesOf(tx, userId);
    const [account] = await tx
      .select({ dueAt: users.deletionDueAt, inTime: sql<boolean>`${users.deletionDueAt} > statement_timestamp()` })
      .from(users)
      .where(eq(users.id, userId));
    if (!account?.dueAt || !account.inTime) {
      throw new ConflictError("This account can't be restored anymore", "account.not_restorable");
    }
    const closed = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.deletionRequestedBy, userId), eq(organizations.deletionDueAt, account.dueAt)));
    await tx.update(users).set({ deletionDueAt: null, deletionRequestedAt: null }).where(eq(users.id, userId));
    await recordOperatorEvent(tx, { type: "user.deletion_canceled", userId });
    await enqueueAccountContact(tx, userId);
    const mine = await tx
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    return { closed, mine };
  });
  for (const m of mine) await announceMembers(deps.pubsub, m.orgId);
  for (const org of closed) {
    await restoreWorkspace(deps, userId, org.id, { account: true }).catch((error) => {
      if (!(error instanceof ForbiddenError || error instanceof ConflictError || error instanceof OrgPausedError))
        throw error;
    });
  }
}

/**
 * The `account.delete` job: deletes an account past its date, exactly as `deleteAccount` does, its Apple sign-in revoked
 * after (`appleRevoke`, best effort: the account is gone). Does nothing when it was restored or is gone, and waits while
 * it is blocked, as a blocked account can't delete itself: the hourly `enqueueOverdueAccountDeletions` comes back.
 * Returns whether it was deleted.
 */
export async function purgeAccount(
  deps: DeletionDeps & {
    appleRevoke?: ((token: { value: string; hint: "refresh_token" | "access_token" }) => Promise<void>) | null;
  },
  userId: string,
) {
  const { appleRevoke, db, ...options } = deps;
  const [row] = await db
    .select({ blockedAt: users.blockedAt })
    .from(users)
    .where(and(eq(users.id, userId), sql`${users.deletionDueAt} <= statement_timestamp()`));
  if (!row || row.blockedAt) return false;
  // Read before the account goes: its sign-in rows go with it.
  const tokens = appleRevoke ? await appleSignInTokens(db, userId) : [];
  if (!(await deleteAccount(db, userId, { ...options, whenDue: true }))) return false;
  if (appleRevoke) await Promise.all(tokens.map((token) => appleRevoke(token).catch(() => undefined)));
  return true;
}

/** Queues `account.delete` for every account past its date, at most once an hour each, as for workspaces. */
export async function enqueueOverdueAccountDeletions(db: Database, now = new Date()) {
  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(lte(users.deletionDueAt, now), isNull(users.blockedAt)));
  const hour = now.toISOString().slice(0, 13);
  for (const { id } of due) {
    await enqueue(db, {
      orgId: null,
      kind: ACCOUNT_DELETE_JOB,
      payload: { userId: id },
      dedupeKey: `${ACCOUNT_DELETE_JOB}:${id}:${hour}`,
    });
  }
  return due.length;
}

/**
 * The `account_deleted` email, in the transaction that deletes the account and before its row goes: the workspaces
 * that closed with it (`closed`, all with the transaction's date), the date in their time zone there, and whom to write
 * to if it wasn't them.
 */
export async function queueAccountDeletedEmail(
  tx: Executor,
  userId: string,
  closed: Closed[],
  emails: NonNullable<DeletionDeps["emails"]>,
) {
  const [person] = await tx
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.id, userId));
  if (!person) return;
  const first = closed[0];
  const named = first
    ? await tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(
          inArray(
            organizations.id,
            closed.map((c) => c.orgId),
          ),
        )
        .orderBy(asc(organizations.createdAt))
    : [];
  const timeZone = first && (await membersToTell(tx, first.orgId)).find((m) => m.id === userId)?.timeZone;
  await queueEmail(tx, {
    orgId: null,
    key: `account-deleted:${userId}`,
    to: [person.email],
    template: {
      kind: "account_deleted",
      locale: emailLocale(person.locale),
      email: person.email,
      orgNames: named.map((o) => o.name),
      dueAt: first?.dueAt.toISOString() ?? null,
      timeZone: timeZone || "UTC",
      support: emails.support ?? null,
      url: emails.publicUrl,
    },
  });
}

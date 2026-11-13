import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNotNull, ne, schema, sql } from "@agenteschat/db";
import { en } from "@agenteschat/i18n/en";
import { enqueueAccountContact } from "./account-contacts";
import { recordAudit } from "./audit";
import { profileIdOfKey } from "./browser/profiles";
import { caches } from "./cache";
import { ForbiddenError } from "./errors";
import { publishOrgEvent } from "./events";
import type { Judge } from "./judge";
import type { MachineHub } from "./machine-hub";
import { notifyAgentHold, notifyOrgStanding, resolveAgentHold } from "./notification-producers";
import { enqueue } from "./outbox";
import { isAgentesCloud } from "./telemetry";

const { organizations, agents, users, sessions, pushDevices, organizationMembers, machineProvisioning } = schema;

let cloudNotices = false;

/**
 * From the server's own address at boot: on agentes.chat Cloud a restriction says `cloud: true` beside its code, with
 * a held agent's or a blocked account's kind, and an agent hold tells its people, so the apps add the Terms section
 * and how to contest it (ADR 0056 §9). Elsewhere its people read what they always read.
 */
export function setRestrictionNotices(publicUrl: string) {
  cloudNotices = isAgentesCloud(publicUrl);
}

/** `{ cloud: true }` on agentes.chat Cloud, nothing elsewhere: spread beside a restriction the apps put in words. */
export const cloudNotice = () => (cloudNotices ? { cloud: true as const } : undefined);

/**
 * What the people a restriction meets read of its stored reason, on agentes.chat Cloud only: an agent hold is
 * `network` (a network rule's, `network.…`) or `operator`, an account block `abuse` (a sign-up linked to an account
 * closed for abuse), `legal` (a legal hold) or `other`. Never the reason itself.
 */
export const agentHoldKind = (reason: string | null) => (reason?.startsWith("network.") ? "network" : "operator");
export const accountBlockKind = (reason: string | null) =>
  reason === "abuse.resignup" ? "abuse" : reason === "legal_hold" ? "legal" : "other";

/**
 * A workspace's standing (ADR 0056 §8), set by the people who run this server through the operator API and
 * enforced where work starts:
 *
 * - `hold`: its agents stop. No model call (Model Gateway), no new computer work and no bridge call (machine
 *   hub), no judge or router call (they bill the server, not the workspace), no routine, no invitation; a run
 *   that starts fails at once and says why. People still read and write.
 * - `suspended`: the same, every permission check refuses (`org.suspended`), and what its agents still have
 *   going stops at once (`stopOrgWork`).
 * - notice `shown`: the workspace is told the reason, the change goes into its audit log and a new state
 *   notifies its owners and admins. `silent`: it is told only that it is paused, never why or by whom, and
 *   nothing is written where it can read it.
 *
 * Also one agent held (the same refusals, for that agent only) and one account blocked (no sign-in, no
 * membership anywhere): ADR 0056 §9.
 */
export const STANDING_STATES = ["active", "hold", "suspended"] as const;
export type StandingState = (typeof STANDING_STATES)[number];
export const STANDING_NOTICES = ["shown", "silent"] as const;
export type StandingNotice = (typeof STANDING_NOTICES)[number];

export interface OrgStanding {
  state: StandingState;
  reason: string | null;
  /** The operator's own note: never shown to the workspace. */
  note: string | null;
  notice: StandingNotice;
  changedAt: Date | null;
}

/** What a refusal needs, for selects that already read the organization row. */
export const STANDING_COLUMNS = {
  state: organizations.standing,
  reason: organizations.standingReason,
  notice: organizations.standingNotice,
  deletionDueAt: organizations.deletionDueAt,
};

/** All of it, the operator's note included: for the operator API only. A deletion is never part of a standing. */
export const OPERATOR_STANDING_COLUMNS = {
  state: organizations.standing,
  reason: organizations.standingReason,
  notice: organizations.standingNotice,
  note: organizations.standingNote,
  changedAt: organizations.standingChangedAt,
};

/** What the workspace may know of its standing (never the operator's note), and when it goes while being deleted. */
export type WorkspaceStanding = Pick<OrgStanding, "state" | "reason" | "notice"> & { deletionDueAt: Date | null };

/**
 * Holds a billing service sets (ADR 0079): a shown hold whose reason is one of these codes, which the apps say in
 * the person's words. `payment`: no plan yet; `unpaid`: its payment failed; `ended`: its plan ended.
 */
export const BILLING_HOLDS = ["payment", "unpaid", "ended"] as const;
export type BillingHold = (typeof BILLING_HOLDS)[number];

/** A hold the billing service set: never one an operator or trust set (those win, and block creating workspaces). */
export const isBillingHold = (s: Pick<OrgStanding, "state" | "reason" | "notice">) =>
  s.state === "hold" && s.notice === "shown" && (BILLING_HOLDS as readonly string[]).includes(s.reason ?? "");

const ACTIVE: WorkspaceStanding = { state: "active", reason: null, notice: "shown", deletionDueAt: null };

/** The reason the workspace is told: only with the notice `shown`. */
export const toldReason = (s: Pick<OrgStanding, "reason" | "notice">) => (s.notice === "shown" ? s.reason : null);

const PAUSED = "Agents in this workspace are paused for now.";
const UNAVAILABLE = "This workspace is unavailable for now.";
const ON_HOLD = "This workspace is on hold: ";
const SUSPENDED = "This workspace is suspended: ";
const DELETING = "This workspace is being deleted.";
const AGENT_PAUSED = "This agent is paused for now.";
/** On agentes.chat Cloud, followed by the hold's kind: a run keeps it in its error, so its line names the kind. */
const AGENT_HELD = "This agent is paused: ";

const FLAGGED = "automated checks flagged activity that seems to involve ";
/**
 * On agentes.chat Cloud, what its automatic hold flagged (`review.<category>`) in the apps' English words
 * (`standing.cloud.reviewWhat`), in the standing's text, which people read in an error's message and in a computer's
 * refused call. A run keeps the words in its error, and `standingErrorDetail` reads the reason back from them.
 */
const REVIEW_FLAGGED = new Map<string, string>(
  Object.entries(en.standing.cloud.reviewWhat).map(([category, what]) => [`review.${category}`, `${FLAGGED}${what}`]),
);

/** The told reason in a standing's text: back from the words of `REVIEW_FLAGGED`, else as it was written. */
const reasonIn = (said: string) => [...REVIEW_FLAGGED].find(([, words]) => words === said)?.[0] ?? said;

/** What the workspace reads when work is refused; silent, only that it is paused. */
export function standingText(s: Pick<OrgStanding, "state" | "reason" | "notice">): string {
  const reason = toldReason(s);
  const said = reason && ((cloudNotices && REVIEW_FLAGGED.get(reason)) || reason);
  if (s.state === "suspended") return said ? `${SUSPENDED}${said}` : UNAVAILABLE;
  return said ? `${ON_HOLD}${said}` : PAUSED;
}

/**
 * The app's code of a run refused by its standing, with the reason told or the hold's kind, and on agentes.chat Cloud
 * `cloud` ("true": a run's values are text); null for any other error.
 */
export function standingErrorDetail(error: string): { errorCode: string; errorParams?: Record<string, string> } | null {
  const told = (errorCode: string, values: Record<string, string> = {}) => {
    const errorParams = cloudNotices ? { ...values, cloud: "true" } : values;
    return Object.keys(errorParams).length > 0 ? { errorCode, errorParams } : { errorCode };
  };
  if (error === AGENT_PAUSED) return told("run.agent_paused");
  if (error.startsWith(AGENT_HELD)) return told("run.agent_paused", { kind: error.slice(AGENT_HELD.length) });
  // Nothing to contest: an owner deleted it.
  if (error === DELETING) return { errorCode: "run.org_deleting" };
  if (error === PAUSED) return told("run.org_paused");
  if (error === UNAVAILABLE) return told("run.org_suspended");
  if (error.startsWith(ON_HOLD)) return told("run.org_paused", { reason: reasonIn(error.slice(ON_HOLD.length)) });
  if (error.startsWith(SUSPENDED))
    return told("run.org_suspended", { reason: reasonIn(error.slice(SUSPENDED.length)) });
  return null;
}

/** Work refused because the workspace isn't active: `org.paused` on hold, else `org.suspended` (403). */
export class OrgPausedError extends ForbiddenError {
  /** A job that hits it fails at once: retrying within minutes won't lift a hold (the outbox reads this flag). */
  readonly retryable = false;

  constructor(readonly standing: WorkspaceStanding) {
    const reason = toldReason(standing);
    const params = { ...(reason ? { reason } : {}), ...cloudNotice() };
    super(
      standingText(standing),
      standing.state === "suspended" ? "org.suspended" : "org.paused",
      Object.keys(params).length > 0 ? params : undefined,
    );
    this.name = "OrgPausedError";
  }
}

/**
 * Work refused because this agent is held (`agent.paused`, 403). The workspace never reads why: on agentes.chat Cloud
 * only the hold's kind (`agentHoldKind`).
 */
export class AgentHeldError extends ForbiddenError {
  /** Like `OrgPausedError`: a job that hits it fails at once. */
  readonly retryable = false;

  constructor(kind?: string) {
    super(kind ? `${AGENT_HELD}${kind}` : AGENT_PAUSED, "agent.paused", kind ? { kind, cloud: true } : undefined);
    this.name = "AgentHeldError";
  }
}

/** Work refused because an owner is deleting the workspace (`org.deleting`, 403), with `dueAt` while it's ahead. */
export class OrgDeletingError extends ForbiddenError {
  /** Like `OrgPausedError`: a job that hits it fails at once. */
  readonly retryable = false;

  constructor(dueAt: Date | null, now = new Date()) {
    super(DELETING, "org.deleting", dueAt && dueAt > now ? { dueAt: dueAt.toISOString() } : undefined);
    this.name = "OrgDeletingError";
  }
}

/**
 * Why the workspace is closed to every change and to all work, or null while it is open: suspended (the operator's,
 * which comes first), else being deleted. Restoring it and leaving it stay open, and its people still read one being
 * deleted (`readRefusal`). `closedOrg` says the same in SQL.
 */
export function closedRefusal(standing: WorkspaceStanding | undefined): OrgPausedError | OrgDeletingError | null {
  if (standing?.state === "suspended") return new OrgPausedError(standing);
  if (standing?.deletionDueAt) return new OrgDeletingError(standing.deletionDueAt);
  return null;
}

/**
 * Why its people can't even read the workspace, or null: only a suspension. One being deleted stays readable to its
 * members until it goes (ADR 0088 §7); the API refuses its changes (`readOnlyWhileDeleting`) and `workRefusal` its work.
 */
export function readRefusal(standing: WorkspaceStanding | undefined): OrgPausedError | null {
  return standing?.state === "suspended" ? new OrgPausedError(standing) : null;
}

/** Why work in the workspace is refused now: `closedRefusal`, else a hold. Null while active. `openOrg` in SQL. */
export function workRefusal(standing: WorkspaceStanding | undefined): OrgPausedError | OrgDeletingError | null {
  const closed = closedRefusal(standing);
  if (closed || !standing || standing.state === "active") return closed;
  return new OrgPausedError(standing);
}

/** `closedRefusal` in SQL, for queries over `organizations`: suspended, or being deleted. */
export const closedOrg = sql<boolean>`(${organizations.standing} = 'suspended'
  or ${organizations.deletionDueAt} is not null)`;
/** `workRefusal` in SQL, for queries over `organizations`: active, and not being deleted. */
export const openOrg = sql<boolean>`(${organizations.standing} = 'active' and ${organizations.deletionDueAt} is null)`;

/** An org broadcast that closes the workspace to its people (a suspension): their sockets close. */
export const closesWorkspace = (event: { type: string; state?: unknown }) =>
  event.type === "org.standing" && event.state === "suspended";

/**
 * A suspension, or a hold that isn't billing's: its people don't carry on in a new workspace, and its deletion waits
 * past its date until it lifts.
 */
export const refusesNewWorkspace = (s: Pick<OrgStanding, "state" | "reason" | "notice">) =>
  s.state !== "active" && !isBillingHold(s);
/** `refusesNewWorkspace` in SQL, for queries over `organizations`. */
export const heldOrg = sql<boolean>`(${organizations.standing} = 'suspended' or (${organizations.standing} = 'hold'
  and not coalesce(${organizations.standingNotice} = 'shown' and ${organizations.standingReason} in (${sql.join(
    BILLING_HOLDS.map((hold) => sql`${hold}`),
    sql`, `,
  )}), false)))`;

/** A workspace that waits for its first plan: a person owns one at a time (ADR 0079 §2). */
export const waitsForPlan = (s: WorkspaceStanding) => isBillingHold(s) && s.reason === "payment" && !s.deletionDueAt;

/** A workspace's standing, cached 5 s per process. An unknown id reads as active: what needs the row fails on its own. */
export async function orgStanding(db: Executor, orgId: string): Promise<WorkspaceStanding> {
  return (await caches.standing.getOrLoad(`${orgId}:`, async () => {
    const [row] = await db.select(STANDING_COLUMNS).from(organizations).where(eq(organizations.id, orgId));
    return row ?? ACTIVE;
  })) as WorkspaceStanding;
}

/** The billing hold work is refused for here, or null: a workspace being deleted is closed for that, not for its plan. */
export async function billingHold(db: Executor, orgId: string): Promise<BillingHold | null> {
  const standing = await orgStanding(db, orgId);
  return !standing.deletionDueAt && isBillingHold(standing) ? (standing.reason as BillingHold) : null;
}

/** This agent's hold (its stored reason), or null while it isn't held: cached 5 s per process like the standing. */
async function agentHold(db: Executor, orgId: string, agentId: string): Promise<{ reason: string | null } | null> {
  // A shared browser profile's stream goes by "profile:<id>": no agent, so no hold of its own (and no row to ask for).
  if (profileIdOfKey(agentId)) return null;
  return (await caches.standing.getOrLoad(`${orgId}:${agentId}`, async () => {
    const [row] = await db
      .select({ heldAt: agents.operatorHoldAt, reason: agents.operatorHoldReason })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    return row?.heldAt ? { reason: row.reason } : null;
  })) as { reason: string | null } | null;
}

/** Why work in this workspace (by this agent, when given) is refused now, or null while it may go on. */
export async function standingRefusal(
  db: Executor,
  orgId: string,
  agentId?: string | null,
): Promise<OrgPausedError | OrgDeletingError | AgentHeldError | null> {
  const refusal = workRefusal(await orgStanding(db, orgId));
  if (refusal) return refusal;
  const hold = agentId ? await agentHold(db, orgId, agentId) : null;
  if (!hold) return null;
  return new AgentHeldError(cloudNotices ? agentHoldKind(hold.reason) : undefined);
}

/** Throws `standingRefusal`'s refusal: the workspace isn't active or is being deleted, or the agent given is held. */
export async function assertCanWork(db: Executor, orgId: string, agentId?: string | null) {
  const refusal = await standingRefusal(db, orgId, agentId);
  if (refusal) throw refusal;
}

/**
 * The judge, asking nothing for a workspace that isn't active: Jev bills the server, not the workspace,
 * and callers already carry on without an answer.
 */
export function standingJudge(db: Database, judge: Judge): Judge {
  return {
    // Read live: the name follows whether Jev has a key now.
    get name() {
      return judge.name;
    },
    async ask(request) {
      await assertCanWork(db, request.orgId);
      return judge.ask(request);
    },
  };
}

export interface StandingChange {
  state: StandingState;
  reason: string | null;
  note?: string | null;
  notice: StandingNotice;
}

export interface StandingDeps {
  db: Database;
  pubsub?: PubSub;
  /** Stops the tasks of a suspended workspace on its computers (absent: they are only marked canceled). */
  hub?: Pick<MachineHub, "call">;
}

/**
 * Sets a workspace's standing (the operator API): at once in this process, within 5 s in the others. When
 * what the workspace sees changes (the state, or the reason it is told), its members hear `org.standing`;
 * with the notice `shown` the change goes into its audit log, and a new state notifies its owners and
 * admins. Suspending it also stops its runs and tasks now. A workspace held or suspended waits for no computer:
 * what its provisioner last said goes, and the apps ask again on `org.standing`. Null when there is no such workspace.
 */
export async function setOrgStanding(
  deps: StandingDeps,
  orgId: string,
  change: StandingChange,
): Promise<OrgStanding | null> {
  const done = await deps.db.transaction(async (tx) => {
    const [before] = await lockStanding(tx, orgId);
    return before ? writeStanding(tx, orgId, before, change) : null;
  });
  if (!done) return null;
  await standingWritten(deps, orgId, done);
  return done.after;
}

/** The team's hello in #general once it can work (`sayTeamHello` in team-templates, ADR 0162). */
export const TEAM_HELLO_JOB = "team.hello";

/**
 * Puts the billing service's hold on a workspace, moves it to another code, or lifts it (`null`), through the same
 * write as `setOrgStanding`. Lifting the first plan's hold queues the team's hello. A suspension or any other hold is never replaced nor lifted from here: `applied` false,
 * as when it is already so. Null when there is no such workspace.
 */
export async function setBillingHold(
  deps: StandingDeps,
  orgId: string,
  hold: BillingHold | null,
): Promise<{ applied: boolean; standing: OrgStanding } | null> {
  const done = await deps.db.transaction(async (tx) => {
    const [before] = await lockStanding(tx, orgId);
    if (!before) return null;
    const change = billingChange(before, hold);
    const written = change ? await writeStanding(tx, orgId, before, change) : null;
    if (written && hold === null && before.reason === "payment")
      await enqueue(tx, {
        orgId,
        kind: TEAM_HELLO_JOB,
        payload: { how: "paid" },
        dedupeKey: `${TEAM_HELLO_JOB}:${orgId}`,
      });
    return { before, written };
  });
  if (!done) return null;
  if (!done.written) return { applied: false, standing: done.before };
  // A first plan is a start, not a return: the person paying just saw it, and nobody else is in yet to tell.
  const firstPlan = hold === null && done.before.reason === "payment";
  await standingWritten(deps, orgId, done.written, { notify: !firstPlan });
  return { applied: true, standing: done.written.after };
}

/** What a billing hold changes on the standing now; null when nothing (already so, or not the billing service's). */
function billingChange(before: OrgStanding, hold: BillingHold | null): StandingChange | null {
  const billing = isBillingHold(before);
  if (before.state === "suspended" || (before.state === "hold" && !billing)) return null;
  if (hold === null) return billing ? { state: "active", reason: null, note: null, notice: "shown" } : null;
  return billing && before.reason === hold ? null : { state: "hold", reason: hold, note: null, notice: "shown" };
}

const lockStanding = (tx: Executor, orgId: string) =>
  tx.select(OPERATOR_STANDING_COLUMNS).from(organizations).where(eq(organizations.id, orgId)).for("update");

/** Writes a standing on the workspace's row, locked by `lockStanding` in the same transaction. */
async function writeStanding(tx: Executor, orgId: string, before: OrgStanding, change: StandingChange) {
  const moved = before.state !== change.state;
  const [after] = await tx
    .update(organizations)
    .set({
      standing: change.state,
      standingReason: change.reason,
      standingNote: change.note ?? null,
      standingNotice: change.notice,
      ...(moved ? { standingChangedAt: new Date() } : {}),
    })
    .where(eq(organizations.id, orgId))
    .returning(OPERATOR_STANDING_COLUMNS);
  if (!after) return null;
  // Held or suspended, it waits for no computer: what its provisioner last said goes (a ready computer stays), each
  // time it is set. Under this row's lock, which a report and a removal share, so neither brings the wait back.
  if (after.state !== "active") {
    await tx
      .delete(machineProvisioning)
      .where(and(eq(machineProvisioning.orgId, orgId), ne(machineProvisioning.state, "ready")));
  }
  const seen = moved || (after.state !== "active" && toldReason(before) !== toldReason(after));
  if (seen && after.notice === "shown") {
    await recordAudit(tx, {
      orgId,
      actor: { type: "system", id: null },
      action: "organization.standing_changed",
      target: { type: "organization", id: orgId },
      details: { from: before.state, to: after.state, reason: after.reason },
    });
  }
  return { after, moved, seen };
}

/** What follows a standing written, once its transaction committed: caches, the members, owners and admins, work. */
async function standingWritten(
  deps: StandingDeps,
  orgId: string,
  { after, moved, seen }: { after: OrgStanding; moved: boolean; seen: boolean },
  { notify = true }: { notify?: boolean } = {},
) {
  caches.standing.delete(`${orgId}:`);
  if (seen) {
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "org.standing", orgId, state: after.state, reason: toldReason(after), ...cloudNotice() },
    });
  }
  if (notify && moved && after.notice === "shown") {
    await notifyOrgStanding(deps, orgId, { ...after, billing: isBillingHold(after), cloud: cloudNotices }).catch(
      () => {},
    );
  }
  // Every time, not only on the move: setting it again (a retry after a failure) finishes the job.
  if (after.state === "suspended") {
    // Loaded here: the run engine builds on this module.
    const { stopOrgWork } = await import("./cancel");
    await stopOrgWork(deps, orgId, standingText(after));
  }
}

/**
 * Holds an agent, or lets it go (the operator API): held, it starts nothing (no run, model call, computer
 * work, routine slot or bridge call) and the router never picks it, while the rest of the workspace works.
 * What it is doing now stops at its next model, computer or bridge call. At once in this process, within
 * 5 s in the others. On agentes.chat Cloud its responsible person and the workspace's admins are told, with the
 * hold's kind, and told again when it is held again for another kind. Letting it go closes that notice. Null when the
 * workspace has no such agent.
 */
export async function setAgentHold(
  db: Database,
  orgId: string,
  agentId: string,
  change: { held: boolean; reason: string | null },
  pubsub?: PubSub,
) {
  const theAgent = and(eq(agents.id, agentId), eq(agents.orgId, orgId));
  const [before] = await db
    .select({ heldAt: agents.operatorHoldAt, reason: agents.operatorHoldReason })
    .from(agents)
    .where(theAgent);
  const [row] = await db
    .update(agents)
    .set(
      change.held
        ? { operatorHoldAt: sql`coalesce(${agents.operatorHoldAt}, now())`, operatorHoldReason: change.reason }
        : { operatorHoldAt: null, operatorHoldReason: null },
    )
    .where(theAgent)
    .returning({ heldAt: agents.operatorHoldAt, reason: agents.operatorHoldReason, name: agents.name });
  if (!row) return null;
  caches.standing.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:${agentId}`);
  const { heldAt, reason, name } = row;
  const deps = { db, pubsub };
  const kind = agentHoldKind(reason);
  // The notice says the kind its refusals and runs say: another kind while held replaces it, the same one keeps it.
  const was = before?.heldAt ? agentHoldKind(before.reason) : null;
  if (!heldAt || (was && was !== kind)) await resolveAgentHold(deps, orgId, agentId).catch(() => {});
  if (heldAt && cloudNotices && was !== kind)
    await notifyAgentHold(deps, { orgId, agentId, name, kind, at: new Date() }).catch(() => {});
  return { heldAt, reason };
}

/**
 * Whether this account is blocked (null: it isn't), and what its sign-in may say of why: on agentes.chat Cloud the
 * block's kind (`accountBlockKind`) with `cloud: true`, never the reason.
 */
export async function accountBlock(db: Executor, userId: string) {
  const [row] = await db
    .select({ blockedAt: users.blockedAt, reason: users.blockedReason })
    .from(users)
    .where(eq(users.id, userId));
  if (!row?.blockedAt) return null;
  return cloudNotices ? { kind: accountBlockKind(row.reason), cloud: true as const } : {};
}

/** Whether this account is blocked (`setUserBlocked`). */
export async function isUserBlocked(db: Executor, userId: string) {
  return (await accountBlock(db, userId)) !== null;
}

/**
 * An account in use: not blocked, and not waiting for its deletion (ADR 0088 §10). Anything else counts as nobody:
 * no membership, no mention, no DM, no email or push.
 */
export const accountInUse = sql<boolean>`(${users.blockedAt} is null and ${users.deletionDueAt} is null)`;

/** Whether this account can't join or make anything: blocked, or waiting for its deletion. */
export async function accountClosed(db: Executor, userId: string) {
  const [row] = await db.select({ open: accountInUse }).from(users).where(eq(users.id, userId));
  return row?.open !== true;
}

/** Whether this account waits for its deletion (ADR 0088 §10). */
export async function deletionPending(db: Executor, userId: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNotNull(users.deletionDueAt)));
  return !!row;
}

/**
 * Blocks an account, or lets it back (the operator API). Blocked, it can't sign in (`auth.ts`), its sessions
 * and phones are gone, and every membership check reads it as no member (`getMembership`): that bites on
 * its next request, even while a browser's cookie cache still holds the session for minutes. Its open
 * sockets in every workspace close (`membership.revoked`). Null when there is no such account.
 */
export async function setUserBlocked(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  change: { blocked: boolean; reason: string | null },
) {
  const done = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set(
        change.blocked
          ? { blockedAt: sql`coalesce(${users.blockedAt}, now())`, blockedReason: change.reason }
          : { blockedAt: null, blockedReason: null },
      )
      .where(eq(users.id, userId))
      .returning({ blockedAt: users.blockedAt, reason: users.blockedReason });
    if (!row) return null;
    await enqueueAccountContact(tx, userId);
    if (!change.blocked) return { ...row, sessionsRevoked: 0, orgIds: [] };
    const revoked = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    await tx.delete(pushDevices).where(eq(pushDevices.userId, userId));
    const orgs = await tx
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    return { ...row, sessionsRevoked: revoked.length, orgIds: orgs.map((o) => o.orgId) };
  });
  if (!done) return null;
  const { orgIds, ...state } = done;
  for (const orgId of orgIds)
    await publishOrgEvent(deps.pubsub, { type: "membership.revoked", orgId, userId, quiet: true });
  return state;
}

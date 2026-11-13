import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  arrayContains,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  not,
  or,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { type AppLocale, appLocale, isAppLocale, LOCALE_CODES } from "@agenteschat/i18n/locale";
import { enqueueAccountContact } from "./account-contacts";
import { type AgentStyle, isAgentStyle, saveAgentStyle } from "./agent-style";
import { dropAgentRules } from "./approval-rules";
import { revokeMemberApps } from "./apps/revoke";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { memberCardVia } from "./card-via";
import { type ChatPrefs, chatPrefsOf, saveChatPrefs } from "./chat-prefs";
import { invitationMailProof, invitationToken, inviteLinkToken, randomToken, safeEqual, sha256 } from "./crypto";
import { restoreDms } from "./dms";
import { earlyAccessLink, hasWorkspaceAllowance, recordFirstWorkspace, signupMode } from "./early-access";
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { deleteGifKey } from "./gif-key";
import { deleteGitHubAppSettings } from "./git/github-app-settings";
import { deleteJevKey } from "./jev-key";
import { assertMemberRoom } from "./limits";
import { followWorkspaceName } from "./machine-provisioning";
import { addressDomain } from "./mail/text";
import { recordOperatorEvent } from "./operator-events";
import { enqueue } from "./outbox";
import { memberKeysSql, memberRankSql, type Permission, resolvePermissions } from "./permissions";
import { ensureRightHand, followOwner } from "./right-hand";
import { addMemberRolesInTx, createDefaultRoles, givableRoleIds, rolesStillThere, stillGivableRoleIds } from "./roles";
import {
  accountClosed,
  accountInUse,
  assertCanWork,
  type BillingHold,
  closedOrg,
  closedRefusal,
  cloudNotice,
  isUserBlocked,
  openOrg,
  readRefusal,
  refusesNewWorkspace,
  STANDING_COLUMNS,
  type WorkspaceStanding,
  waitsForPlan,
  workRefusal,
} from "./standing";
import type { Closed, DeletionDeps } from "./workspace-deletion";
import { isWorkspaceMode, WORKSPACE_MODES, type WorkspaceMode, workspaceMode } from "./workspace-mode";

const {
  organizations,
  organizationMembers,
  organizationInvitations,
  organizationInviteLinks,
  organizationJoinRequests,
  channels,
  channelMembers,
  users,
  accounts,
  agents,
  instanceTelemetry,
} = schema;

/** Whether a person owns the workspace (ADR 0085); what a member may do comes from their roles (`roles.ts`). */
export type MemberRole = "owner" | "member";

/** The billing hold of a workspace with no plan yet: the one a new workspace may start on. */
const PAYMENT: BillingHold = "payment";

export interface Membership {
  orgId: string;
  orgName: string;
  role: MemberRole;
  /**
   * Everything this person may do here (ADR 0085): the keys of their roles and of `everyone`, every one of them
   * with `administrator`, all of it for an owner. Checked by the backend on every request; the apps only hide.
   */
  permissions: ReadonlySet<Permission>;
  /** Their highest role's position (0 the top); null when they hold none but `everyone`. An owner is above all. */
  rank: number | null;
  /** The roles they hold (`org_roles` ids), not `everyone`. */
  roleIds: string[];
  /** The workspace logo URL, when one was uploaded (listMemberships). */
  orgLogo?: string | null;
  /** When the workspace was made (listMemberships): tells apart two with the same name. */
  orgCreatedAt?: Date;
  /** The workspace's standing (`standing.ts`). */
  standing?: WorkspaceStanding;
  /** What opens when the app starts here (listMemberships). */
  start?: StartChoice;
  /** Whether the person sees what agents did under each reply (listMemberships, `setShowActivity`). */
  showActivity?: boolean;
  /** How agents talk to the person here (listMemberships, `setAgentStyle`); null until they pick (ADR 0147). */
  agentStyle?: AgentStyle | null;
  /** How conversations look to the person here (listMemberships, `setChatPrefs`); only what they chose. */
  chatPrefs?: ChatPrefs;
  /** Who the workspace is for (listMemberships, ADR 0159): `team` or `personal`. */
  mode?: WorkspaceMode;
}

/** What opens when the app starts in a workspace (ADR 0108), the person's own. */
export const START_PAGES = schema.START_PAGES;
export type StartPage = schema.StartPage;
export interface StartChoice {
  page: StartPage;
  /** With `channel`; the apps open the home when the person is no longer in it. */
  channelId: string | null;
}

/** Whether a membership (or none) may `permission`. */
export const can = (membership: Pick<Membership, "permissions"> | null | undefined, permission: Permission) =>
  membership?.permissions.has(permission) === true;

/**
 * Whether `actor` stands above a role at `position` or a person whose highest role is `rank` (ADR 0085): an owner
 * above everything, anyone else only strictly above (lower position). `everyone` (`Infinity`) is below everybody.
 */
export function outranks(actor: Pick<Membership, "role" | "rank">, rank: number | null) {
  if (actor.role === "owner") return true;
  return (actor.rank ?? Number.POSITIVE_INFINITY) < (rank ?? Number.POSITIVE_INFINITY);
}

type MembershipRow = Omit<Membership, "permissions"> & { keys: string[] };
const withPermissions = ({ keys, ...row }: MembershipRow): Membership => ({
  ...row,
  permissions: resolvePermissions(row.role === "owner", keys),
});

/** A member's roles (`org_roles` ids), not `everyone`. */
export const MEMBER_ROLE_IDS = sql<
  string[]
>`coalesce((select array_agg(mr.role_id::text) from organization_member_roles mr
    where mr.org_id = ${organizationMembers.orgId} and mr.user_id = ${organizationMembers.userId}), '{}'::text[])`;

const ROLE_COLUMNS = {
  keys: memberKeysSql({ orgId: organizationMembers.orgId, userId: organizationMembers.userId }),
  rank: memberRankSql({ orgId: organizationMembers.orgId, userId: organizationMembers.userId }),
  roleIds: MEMBER_ROLE_IDS,
};

export async function listMemberships(db: Database, userId: string): Promise<Membership[]> {
  const rows = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      role: organizationMembers.role,
      orgLogo: organizations.logo,
      orgCreatedAt: organizations.createdAt,
      standing: STANDING_COLUMNS,
      startPage: organizationMembers.startPage,
      startChannelId: organizationMembers.startChannelId,
      showActivity: organizationMembers.showActivity,
      agentStyle: organizationMembers.agentStyle,
      chatPrefs: organizationMembers.chatPrefs,
      mode: schema.organizationSettings.mode,
      ...ROLE_COLUMNS,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(schema.organizationSettings, eq(schema.organizationSettings.orgId, organizations.id))
    .where(and(eq(organizationMembers.userId, userId), accountInUse))
    .orderBy(asc(organizations.createdAt));
  return rows.map(({ startPage, startChannelId, chatPrefs, mode, ...row }) => ({
    ...withPermissions(row),
    chatPrefs: chatPrefsOf(chatPrefs),
    mode: isWorkspaceMode(mode) ? mode : "team",
    start: { page: startPage, channelId: startPage === "channel" ? startChannelId : null },
  }));
}

/**
 * A person's membership, or null. A blocked account (`standing.ts`) has none, so every permission check
 * refuses it at once; `includeBlocked` is for acting on them (removing them, changing their role).
 */
export async function getMembership(
  db: Executor,
  userId: string,
  orgId: string,
  options: { includeBlocked?: boolean } = {},
): Promise<Membership | null> {
  const [row] = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      role: organizationMembers.role,
      standing: STANDING_COLUMNS,
      ...ROLE_COLUMNS,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
        options.includeBlocked ? undefined : accountInUse,
      ),
    );
  return row ? withPermissions(row) : null;
}

/**
 * Refuses a workspace its people can't read (suspended: `readRefusal`) without changing membership lookups. One being
 * deleted still reads: the API refuses its changes, and `workRefusal` its work.
 */
export function assertActiveMembership(membership: Membership): void {
  const closed = readRefusal(membership.standing);
  if (closed) throw closed;
}

/** Requires an active organization member before acting on its resources. */
export async function requireActiveMembership(db: Database, userId: string, orgId: string): Promise<Membership> {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  assertActiveMembership(membership);
  return membership;
}

/**
 * Throws ForbiddenError unless the user is a member with `permission`, and `org.suspended` for anyone in a suspended
 * workspace. Returns the membership.
 */
export async function requirePermission(db: Database, userId: string, orgId: string, permission: Permission) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!can(membership, permission)) throw new ForbiddenError();
  return membership;
}

/**
 * `requirePermission` for a change that never passes `readOnlyWhileDeleting` (an OAuth return, a socket's input): a
 * workspace being deleted refuses it too (`closedRefusal`).
 */
export async function requireChangePermission(db: Database, userId: string, orgId: string, permission: Permission) {
  const membership = await requirePermission(db, userId, orgId, permission);
  const closed = closedRefusal(membership.standing);
  if (closed) throw closed;
  return membership;
}

/** Invitations go out only from an active workspace that isn't being deleted (`standing.ts`). */
export function assertInviting(membership: Membership) {
  const refusal = workRefusal(membership.standing);
  if (refusal) throw refusal;
}

/**
 * Creates an organization owned by `userId`, with a `general` channel. Refused while their account is
 * blocked or they are in a workspace suspended or on any hold but a billing one: they don't carry on in a new
 * one (`org.create_refused`, the same words whatever the cause, and how to contest it on agentes.chat Cloud).
 * Billing holds refuse nobody, but one person
 * owns at most one workspace waiting for its first plan (`org.create_unpaid`, with that workspace's id); one being
 * deleted waits for none, so restoring it is what checks that.
 * With `needsAllowance` (`needsWorkspaceAllowance`) early access must have allowed the account, else
 * `org.create_invite_only` and nothing is made. An allowed account's first workspace is recorded on its invitation.
 * `holdForPayment`: the workspace starts on the `payment` hold (ADR 0079), with no audit row or notification.
 * With `onboarding` (the app's), its owner sets it up in the onboarding, already past its first step; while they
 * have one they haven't finished, that one comes back (`existing`) instead of a new one, even one waiting for its
 * first plan. `UnauthorizedError` once their account is gone.
 */
export async function createOrganization(
  db: Database,
  userId: string,
  input: { name: string; context?: string; mode?: WorkspaceMode },
  options: { holdForPayment?: boolean; needsAllowance?: boolean; onboarding?: boolean } = {},
) {
  if (input.mode !== undefined && !isWorkspaceMode(input.mode))
    throw new ValidationError(`mode must be one of ${WORKSPACE_MODES.join(", ")}`);
  return db.transaction(async (tx) => {
    // One create at a time per person, checked after the lock: two at once would both start waiting for a plan. A
    // deletion of the account waits for this workspace, or this finds the account gone (a cached session cookie
    // outlives it).
    await lockWorkspacesOf(tx, userId);
    const [me] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    if (!me) throw new UnauthorizedError();
    const theirs = await tx
      .select({ id: organizations.id, role: organizationMembers.role, standing: STANDING_COLUMNS })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizations.createdAt));
    if (theirs.some((o) => refusesNewWorkspace(o.standing)) || (await accountClosed(tx, userId)))
      throw new ForbiddenError("You can't create a workspace right now", "org.create_refused", cloudNotice());
    if (options.needsAllowance && !(await hasWorkspaceAllowance(tx, userId)))
      throw new ForbiddenError("New workspaces need an invitation for now", "org.create_invite_only");
    if (options.onboarding) {
      // A second create at the same time (a double submit, another tab) waited on the lock and finds this one.
      const [open] = await unfinishedWorkspaces(tx, userId);
      if (open) return { ...open, existing: true };
    }
    const unpaid = theirs.find((o) => o.role === "owner" && waitsForPlan(o.standing));
    if (unpaid)
      throw new ForbiddenError("You already have a workspace waiting for a plan", "org.create_unpaid", {
        orgId: unpaid.id,
      });
    const [organization] = await tx
      .insert(organizations)
      .values({
        name: input.name,
        context: input.context ?? "",
        ...(options.onboarding ? { onboardingStep: "context" as const, onboardedAt: null } : {}),
        ...(options.holdForPayment
          ? ({
              standing: "hold",
              standingReason: PAYMENT,
              standingNotice: "shown",
              standingChangedAt: new Date(),
            } as const)
          : {}),
      })
      .returning();
    if (!organization) throw new Error("organization insert returned nothing");
    await recordFirstWorkspace(tx, userId, organization.id);
    await tx.insert(organizationMembers).values({ orgId: organization.id, userId, role: "owner" });
    // A personal workspace (ADR 0159) is one from the start: its first screens are already shaped for one person.
    if (input.mode === "personal")
      await tx.insert(schema.organizationSettings).values({ orgId: organization.id, mode: "personal" });
    await createDefaultRoles(tx, organization.id);
    await assignHandle(tx, organization.id, userId);
    // The team's right hand comes with the workspace (ADR 0137), after the owner's handle so `@lodi` stays theirs if
    // it is their own.
    await ensureRightHand(tx, organization.id);
    const [general] = await tx
      .insert(channels)
      .values({ orgId: organization.id, name: "general", createdByUserId: userId })
      .returning();
    if (!general) throw new Error("channel insert returned nothing");
    await tx.insert(channelMembers).values({ orgId: organization.id, channelId: general.id, userId });
    await recordOperatorEvent(tx, {
      type: "organization.created",
      orgId: organization.id,
      userId,
      data: { name: organization.name, mode: input.mode ?? "team" },
    });
    return { organization, general, existing: false };
  });
}

/** The onboarding's steps, in order: a workspace's only moves forward through them. */
export const ONBOARDING_STEPS = schema.ONBOARDING_STEPS;

/**
 * The workspaces `userId` owns whose onboarding isn't finished, oldest first, each with its #general (where the
 * onboarding puts the agents and posts the first message). A closed one isn't among them: it shows as suspended or
 * being deleted, and the onboarding starts a new one.
 */
export async function unfinishedWorkspaces(db: Executor, userId: string) {
  return db
    .select({ organization: organizations, general: channels })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(channels, and(eq(channels.orgId, organizations.id), eq(channels.name, "general")))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.role, "owner"),
        isNull(organizations.onboardedAt),
        not(closedOrg),
      ),
    )
    .orderBy(asc(organizations.createdAt));
}

/**
 * Saves how far a workspace's owner got in its onboarding: `step`, the furthest one reached, only moves forward;
 * `finished` ends it, for good. Anyone else is refused. Returns where it stands.
 */
export async function saveOnboarding(
  db: Database,
  userId: string,
  orgId: string,
  input: { step?: schema.OnboardingStep; finished?: boolean },
) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (membership.role !== "owner") throw new ForbiddenError("Only the workspace's owner sets it up");
  const open = and(eq(organizations.id, orgId), isNull(organizations.onboardedAt));
  if (input.finished) {
    await db.update(organizations).set({ onboardingStep: "done", onboardedAt: new Date() }).where(open);
  } else if (input.step) {
    // The steps before it, in the statement itself: two tabs saving at once never take it back.
    const before = ONBOARDING_STEPS.slice(0, ONBOARDING_STEPS.indexOf(input.step));
    if (before.length > 0)
      await db
        .update(organizations)
        .set({ onboardingStep: input.step })
        .where(and(open, inArray(organizations.onboardingStep, before)));
  }
  const [row] = await db
    .select({ step: organizations.onboardingStep, onboardedAt: organizations.onboardedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return { step: row?.step ?? "done", finished: Boolean(row?.onboardedAt) };
}

export async function updateOrganization(
  db: Database,
  actorId: string,
  orgId: string,
  input: { name?: string; context?: string },
) {
  const before = await requirePermission(db, actorId, orgId, "configure");
  const [row] = await db.update(organizations).set(input).where(eq(organizations.id, orgId)).returning();
  if (row && row.name !== before.orgName) await followWorkspaceName(db, orgId, before.orgName, row.name);
  if (row) {
    // The context goes into every agent's prompt: the audit says it changed, not what it says.
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "organization.updated",
      target: { type: "organization", id: orgId },
      details: {
        name: row.name,
        ...(row.name !== before.orgName ? { from: before.orgName } : {}),
        ...(input.context !== undefined ? { contextChanged: true } : {}),
      },
    });
  }
  caches.orgs.delete(`${orgId}:`);
  return row;
}

export async function getOrganization(db: Database, orgId: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return row ?? null;
}

// ── Sign-up policy (ADR 0006) ────────────────────────────────────────────────

export async function countUsers(db: Database): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
}

/** The installation's first account: the person who set it up. */
export async function installOwner(db: Database): Promise<string | null> {
  const [first] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
  return first?.id ?? null;
}

/**
 * Who has the installation's own settings, the usage report's switch, the Jev key (ADR 0073) and the GIPHY key
 * (ADR 0091): its first account, pinned the first time anyone asks. Unlike `installOwner`, it never passes to the
 * next oldest account, who may be any member of any workspace: once the owner deletes their account, nobody has
 * these settings here (the server's environment still does), until no account is left and the next first account
 * is pinned.
 */
export async function pinnedOwner(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ owner: instanceTelemetry.ownerUserId })
    .from(instanceTelemetry)
    .where(eq(instanceTelemetry.id, 1));
  if (row?.owner) return row.owner;
  const first = await installOwner(db);
  if (!first) return null;
  const [pinned] = await db
    .insert(instanceTelemetry)
    .values({ ownerUserId: first })
    .onConflictDoUpdate({
      target: instanceTelemetry.id,
      set: { ownerUserId: sql`coalesce(${instanceTelemetry.ownerUserId}, excluded.owner_user_id)` },
    })
    .returning({ owner: instanceTelemetry.ownerUserId });
  return pinned?.owner ?? first;
}

/** Who may create an account (ADR 0006): see `isSignupAllowed`. */
export interface SignupPolicy {
  /** `ALLOW_SIGNUP`: anyone. */
  allowSignup: boolean;
  /** An owner link (`OWNER_CLAIM_SHA256`) or the desktop app's owner key (`OWNER_KEY_SHA256`) makes the first account (ADR 0060 §6). */
  ownerByLink: boolean;
  /** `HOST_COMPUTER_TOKEN`: agents run on this server's own machine, so the live mode never opens sign-up. */
  hostComputer?: boolean;
}

/** Anyone may sign up once the first account exists: `ALLOW_SIGNUP`, or the live mode `open` (ADR 0078). */
export async function signupOpenToAll(db: Database, policy: SignupPolicy) {
  return policy.allowSignup || (!policy.hostComputer && (await signupMode(db)).mode === "open");
}

/** Why a sign-up may go ahead (`signupAdmission`). */
export type SignupAdmission = "open" | "first" | "invitation" | "early_access";

/**
 * Who may create an account (ADR 0006, ADR 0078): the first account may always register (there is no other way
 * in), unless the installation waits for its owner's link or key, which make it on their own path. After that,
 * anyone with `ALLOW_SIGNUP` or while the sign-up mode is `open` (`signupOpenToAll`); else only a pending workspace
 * invitation for that email (not into a workspace being deleted), or an early-access link (`access`) sent to it.
 * An invitation link never opens it (ADR 0068): whoever holds one asks to join without an account. Open sign-up
 * on a reachable server would let anyone create organizations (and spend model credits) on it. Null: refused.
 */
export async function signupAdmission(
  db: Database,
  email: string,
  policy: SignupPolicy,
  options: { access?: string | null; now?: Date } = {},
): Promise<SignupAdmission | null> {
  const now = options.now ?? new Date();
  const stored = email.trim().toLowerCase();
  if (policy.allowSignup && !policy.ownerByLink) return "open";
  if ((await countUsers(db)) === 0) return policy.ownerByLink ? null : "first";
  if (await signupOpenToAll(db, policy)) return "open";
  const [invite] = await db
    .select({ id: organizationInvitations.id })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.orgId))
    .where(
      and(
        eq(organizationInvitations.email, stored),
        isNull(organizationInvitations.acceptedAt),
        gt(organizationInvitations.expiresAt, now),
        isNull(organizations.deletionDueAt),
      ),
    )
    .limit(1);
  if (invite) return "invitation";
  const link = await earlyAccessLink(db, options.access);
  return link && link.expiresAt > now && link.email === stored ? "early_access" : null;
}

export async function isSignupAllowed(db: Database, email: string, policy: SignupPolicy, now = new Date()) {
  return (await signupAdmission(db, email, policy, { now })) !== null;
}

/** What decides whether making a workspace needs early access (`needsWorkspaceAllowance`). */
export interface WorkspacePolicy {
  /** agentes.chat Cloud, whose provisioner gives every workspace a computer that costs money (ADR 0056 §10). */
  paidMachines: boolean;
  /** `ALLOW_SIGNUP`. */
  allowSignup: boolean;
}

/**
 * Whether making a workspace needs the account allowed by early access (ADR 0078 §4): on agentes.chat Cloud, where
 * every workspace gets a paid computer, while sign-up is by invitation only, for everyone but the installation's owner.
 */
export async function needsWorkspaceAllowance(db: Database, userId: string, policy: WorkspacePolicy) {
  if (!policy.paidMachines || policy.allowSignup) return false;
  if ((await signupMode(db)).mode === "open") return false;
  return userId !== (await pinnedOwner(db));
}

export async function canCreateWorkspace(db: Database, userId: string, policy: WorkspacePolicy) {
  return !(await needsWorkspaceAllowance(db, userId, policy)) || (await hasWorkspaceAllowance(db, userId));
}

export type SignInProvider = "google" | "github" | "apple";
const SIGN_IN_PROVIDERS = new Set<string>(["google", "github", "apple"]);

/**
 * The sign-in screen asks for the e-mail first, then shows the one next step:
 * the password, the provider the account signs in with, or the sign-up (when
 * allowed for that e-mail, with the early-access link's `access` when the page
 * has one). This tells whether the e-mail has an account, so the route that
 * serves it is rate limited. `accessExpired` speaks only of a link sent to this
 * same address.
 */
export async function signInOptions(
  db: Database,
  email: string,
  policy: SignupPolicy,
  access?: string | null,
  now = new Date(),
) {
  const stored = email.trim().toLowerCase();
  const rows = await db
    .select({ providerId: accounts.providerId })
    .from(users)
    .leftJoin(accounts, eq(accounts.userId, users.id))
    .where(eq(users.email, stored));
  if (rows.length === 0) {
    const canSignUp = (await signupAdmission(db, email, policy, { access, now })) !== null;
    const link = canSignUp ? null : await earlyAccessLink(db, access);
    return {
      account: false,
      password: false,
      providers: [] as SignInProvider[],
      canSignUp,
      ...(link && link.email === stored && link.expiresAt <= now ? { accessExpired: true as const } : {}),
    };
  }
  const ids = rows.map((r) => r.providerId).filter((id): id is string => id !== null);
  return {
    account: true,
    password: ids.includes("credential"),
    providers: [...new Set(ids.filter((id) => SIGN_IN_PROVIDERS.has(id)))] as SignInProvider[],
    canSignUp: false,
  };
}

/** Whether the account signs in with a password (its credential row has one). */
export async function hasPassword(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.providerId, "credential"), sql`${accounts.password} is not null`),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Runs after a user is created. The very first account of an installation
 * becomes owner of every organization that already exists, so a self-hoster
 * who seeded data first lands in it. Not of one being deleted, which isn't theirs to restore.
 */
export async function onUserCreated(db: Database, userId: string) {
  if ((await countUsers(db)) !== 1) return;
  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(isNull(organizations.deletionDueAt));
  if (existing.length === 0) return;
  await db
    .insert(organizationMembers)
    .values(existing.map((o) => ({ orgId: o.id, userId, role: "owner" as const })))
    .onConflictDoNothing();
  for (const o of existing) await followOwner(db, o.id);
}

// ── Members ──────────────────────────────────────────────────────────────────

/** Members with their handle and time zone (the org's when they didn't pick one). */
export async function listMembers(db: Database, orgId: string) {
  const query = () =>
    db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        role: organizationMembers.role,
        /** Their roles (`org_roles`), not `everyone`; ordered by the apps. */
        roleIds: MEMBER_ROLE_IDS,
        joinedAt: organizationMembers.createdAt,
        lastSeenAt: organizationMembers.lastSeenAt,
        handle: organizationMembers.handle,
        availability: organizationMembers.availability,
        statusText: organizationMembers.statusText,
        statusEmoji: organizationMembers.statusEmoji,
        statusUntil: organizationMembers.statusUntil,
        ownTimezone: organizationMembers.timezone,
        orgTimezone: schema.organizationSettings.timezone,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(schema.organizationSettings, eq(schema.organizationSettings.orgId, organizationMembers.orgId))
      .where(and(eq(organizationMembers.orgId, orgId), isNull(users.deletionDueAt)))
      .orderBy(asc(organizationMembers.createdAt));
  let rows = await query();
  if (rows.some((r) => !r.handle)) {
    for (const r of rows) if (!r.handle) await assignHandle(db, orgId, r.userId);
    rows = await query();
  }
  return rows.map(({ ownTimezone, orgTimezone, handle, ...r }) => ({
    ...r,
    /** The photo uploaded here (`PUT …/me/avatar`); `image` may also be a sign-in provider's. */
    avatarUrl: r.image?.startsWith("/api/app/avatars/") ? r.image : null,
    handle: handle ?? "",
    timezone: ownTimezone ?? orgTimezone ?? "UTC",
  }));
}

export const PERSON_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** "Ana Souza" → "ana"; "João" → "joao"; falls back to the email's local part. */
export function handleBase(name: string, email: string) {
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  const first = slug(name.trim().split(/\s+/)[0] ?? "");
  const local = slug(email.split("@")[0] ?? "");
  const base = (first.length >= 2 ? first : local.length >= 2 ? local : "person").slice(0, 24);
  return base;
}

/** Gives a member a handle unique in the org (`ana`, `ana-2`…), unless they have one. */
export async function assignHandle(db: Executor, orgId: string, userId: string) {
  const [row] = await db
    .select({ handle: organizationMembers.handle, name: users.name, email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  if (!row || row.handle) return row?.handle ?? null;
  const base = handleBase(row.name, row.email);
  const like = `${base}%`;
  // Agents' handles too, the ones they had before a rename included: those still reach the agent.
  const taken = new Set(
    rowsOf<{ handle: string }>(
      await db.execute(sql`select handle from ${organizationMembers}
          where org_id = ${orgId}::uuid and handle like ${like}
        union select handle from ${agents} where org_id = ${orgId}::uuid and handle like ${like}
        union select h from ${agents} cross join unnest(previous_handles) as u(h)
          where org_id = ${orgId}::uuid and h like ${like}`),
    ).map((r) => r.handle),
  );
  let handle = base;
  for (let n = 2; taken.has(handle); n++) handle = `${base}-${n}`;
  await db
    .update(organizationMembers)
    .set({ handle })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return handle;
}

/** A person changes their own handle (unique in the org, not an agent's) or time zone (null = the org's). */
export async function updateMyProfile(
  db: Database,
  userId: string,
  orgId: string,
  input: { handle?: string; timezone?: string | null },
) {
  await requirePermission(db, userId, orgId, "read");
  const set: { handle?: string; timezone?: string | null } = {};
  if (input.handle !== undefined) {
    const handle = input.handle.trim().replace(/^@/, "").toLowerCase();
    if (!PERSON_HANDLE_PATTERN.test(handle)) {
      throw new ValidationError("handle: 2 to 32 lowercase letters, numbers, - or _", "handle.invalid", {
        min: 2,
        max: 32,
      });
    }
    // An agent's handle, or one it had before a rename: that one still names it.
    const [agent] = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, orgId),
          or(eq(schema.agents.handle, handle), arrayContains(schema.agents.previousHandles, [handle])),
          isNull(schema.agents.archivedAt),
        ),
      );
    if (agent) throw new ConflictError(`@${handle} belongs to an agent`, "handle.taken_by_agent", { handle });
    const [other] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.handle, handle)));
    if (other && other.userId !== userId) throw new ConflictError(`@${handle} is taken`, "handle.taken", { handle });
    set.handle = handle;
  }
  if (input.timezone !== undefined) {
    if (input.timezone !== null) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
      } catch {
        throw new ValidationError("timezone must be an IANA time zone");
      }
    }
    set.timezone = input.timezone;
  }
  if (Object.keys(set).length > 0) {
    await db
      .update(organizationMembers)
      .set(set)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
    caches.zones.delete(`${orgId}:${userId}`);
  }
  const me = (await listMembers(db, orgId)).find((m) => m.userId === userId);
  if (!me) throw new ForbiddenError("You are not a member of this organization");
  return me;
}

/**
 * What opens when the app starts in this workspace, for this person (ADR 0108). A channel is one of the workspace's
 * (not a DM), not archived, with the person in it (`start.channel_unknown`).
 */
export async function setStartPage(
  db: Database,
  userId: string,
  orgId: string,
  input: { page: StartPage; channelId?: string | null },
): Promise<StartChoice> {
  await requirePermission(db, userId, orgId, "read");
  if (!START_PAGES.includes(input.page)) throw new ValidationError("page must be home, last or channel");
  const channelId = input.page === "channel" ? (input.channelId ?? null) : null;
  if (input.page === "channel") {
    const [inIt] = channelId
      ? await db
          .select({ id: channels.id })
          .from(channels)
          .innerJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)))
          .where(
            and(
              eq(channels.orgId, orgId),
              eq(channels.id, channelId),
              eq(channels.kind, "channel"),
              isNull(channels.archivedAt),
            ),
          )
      : [];
    if (!inIt) throw new ValidationError("Not a channel you are in", "start.channel_unknown");
  }
  await db
    .update(organizationMembers)
    .set({ startPage: input.page, startChannelId: channelId })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return { page: input.page, channelId };
}

/** Shows or hides, for the person in this workspace, what agents did under each reply. */
export async function setShowActivity(db: Database, userId: string, orgId: string, show: boolean): Promise<boolean> {
  await requirePermission(db, userId, orgId, "read");
  await db
    .update(organizationMembers)
    .set({ showActivity: show })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return show;
}

/** How agents talk to the person in this workspace (ADR 0147). */
export async function setAgentStyle(db: Database, userId: string, orgId: string, style: AgentStyle) {
  await requirePermission(db, userId, orgId, "read");
  if (!isAgentStyle(style)) throw new ValidationError("style must be simple or technical");
  await saveAgentStyle(db, orgId, userId, style);
  return style;
}

/** How conversations look to the person in this workspace, on every device. Only the keys in `patch` change. */
export async function setChatPrefs(db: Database, userId: string, orgId: string, patch: ChatPrefs) {
  await requirePermission(db, userId, orgId, "read");
  return (await saveChatPrefs(db, orgId, userId, chatPrefsOf(patch))) ?? {};
}

/** The languages of the app (`users.locale`): emails and pushes are written in it. */
export const USER_LOCALES = LOCALE_CODES;
export type UserLocale = AppLocale;

/**
 * Saves the person's app language (ADR 0122): `auto` when a device detected it ("Automático"), false when they
 * picked it, so every device shows that one.
 */
export async function setMyLocale(db: Database, userId: string, locale: UserLocale, auto = false, pubsub?: PubSub) {
  if (!isAppLocale(locale)) throw new ValidationError(`locale must be one of ${LOCALE_CODES.join(", ")}`);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ locale, localeAuto: auto }).where(eq(users.id, userId));
    await enqueueAccountContact(tx, userId);
  });
  // Runners render each agent's browser start page in its responsible person's language.
  if (pubsub) {
    const orgs = await db.selectDistinct({ id: agents.orgId }).from(agents).where(eq(agents.ownerUserId, userId));
    const { publishMachineAgentsChanged } = await import("./machines");
    await Promise.all(orgs.map((org) => publishMachineAgentsChanged(pubsub, org.id)));
  }
}

/**
 * Saves the person's own area, asked once during the onboarding (an id the route checked against `WORK_AREAS`, or
 * `skipped`). About the person, not a workspace.
 */
export async function setMyWorkArea(db: Database, userId: string, area: string) {
  await db.update(users).set({ workArea: area }).where(eq(users.id, userId));
}

/**
 * The person's name and photo as saved (a session's cached cookie keeps the old ones for minutes after a change
 * elsewhere), their language and whether it follows each device's, and their area.
 */
export async function myAccount(db: Database, userId: string) {
  const [row] = await db
    .select({
      name: users.name,
      image: users.image,
      locale: users.locale,
      localeAuto: users.localeAuto,
      workArea: users.workArea,
      deletionDueAt: users.deletionDueAt,
      deletionRequestedAt: users.deletionRequestedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  return {
    deletionDueAt: row?.deletionDueAt ?? null,
    deletionRequestedAt: row?.deletionRequestedAt ?? null,
    name: row?.name ?? null,
    image: row?.image ?? null,
    locale: row?.locale ?? null,
    localeAuto: row?.localeAuto ?? true,
    workArea: row?.workArea ?? null,
  };
}

/**
 * The app language a request's `Accept-Language` asks for: its most preferred tag of a language people can pick
 * ("en-GB,en;q=0.9" → en, "pt-PT" → pt-BR), else null. The web app sends its own language in it.
 */
export function requestLocale(acceptLanguage: string | null | undefined): UserLocale | null {
  const tags = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.split(";").map((s) => s.trim().toLowerCase());
      const q = params.find((p) => p.startsWith("q="));
      return { tag, q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((l) => l.q > 0)
    .sort((a, b) => b.q - a.q);
  return appLocale(tags.map((l) => l.tag));
}

/**
 * Whether the person opened the link that confirms their email, read here: a session's cached copy can lag. Null when
 * the account is gone, which a cached session cookie outlives for minutes.
 */
export async function isEmailVerified(db: Database, userId: string): Promise<boolean | null> {
  const [row] = await db.select({ verified: users.emailVerified }).from(users).where(eq(users.id, userId));
  return row ? row.verified === true : null;
}

async function ownerCount(db: Pick<Database, "select">, orgId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner"), isNull(users.deletionDueAt)),
    );
  return row?.n ?? 0;
}

/**
 * The lock on who is in a workspace: role changes, joins, removals, account deletions, and a workspace's deletion,
 * restore and purge take it, so each sees the others' commits.
 */
export const lockOrgMembers = (tx: Executor, orgId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-members:${orgId}`}))`);

/**
 * The lock on what workspaces a person has: creating one, restoring one and deleting their account take it first, so
 * each sees the others' commits (a workspace made in another tab closes with the account, or finds it gone).
 */
export const lockWorkspacesOf = (tx: Executor, userId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-create:${userId}`}))`);

/**
 * Someone joined or left, a role changed, or a person's name, handle or photo: the members' open apps read the people
 * and the counts again.
 */
/** `agents`: the ones whose owner or brain changed with it, which open apps read again. */
export const announceMembers = (pubsub: PubSub | undefined, orgId: string, agents: string[] = []) =>
  publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "org.members", ...(agents.length ? { agents } : {}) },
  });

/** A person's name or photo changed (theirs in every workspace): each of their workspaces reads its people again. */
export async function announceProfile(db: Database, pubsub: PubSub | undefined, userId: string) {
  if (!pubsub) return;
  const rows = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));
  await Promise.all(rows.map((r) => announceMembers(pubsub, r.orgId)));
}

/**
 * A change to who is in the workspace, in the audit log: the person's name and address as they were then
 * (the row outlives the account).
 */
async function auditMember(
  tx: Executor,
  orgId: string,
  actorId: string,
  action: string,
  userId: string,
  details: Record<string, unknown>,
) {
  const [person] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  await recordAudit(tx, {
    orgId,
    actor: { type: "person", id: actorId },
    action,
    target: { type: "person", id: userId },
    details: { ...(person ? { name: person.name, email: person.email } : {}), ...details },
  });
}

/**
 * Makes a member an owner or takes it back (ADR 0085): only an owner does it, and nobody can demote the last
 * owner. What anyone else may do is their roles (`setMemberRoles`).
 */
export async function changeMemberRole(
  db: Database,
  actorId: string,
  orgId: string,
  targetUserId: string,
  role: MemberRole,
  /** `via`: the people card it was applied from (the audit's "via", `memberCardVia`). */
  options: { pubsub?: PubSub; via?: string } = {},
) {
  await requirePermission(db, actorId, orgId, "manage_owners");
  const target = await getMembership(db, targetUserId, orgId, { includeBlocked: true });
  const via = await memberCardVia(db, orgId, options.via, targetUserId);
  if (!target) throw new ConflictError("That user is not a member");
  await db.transaction(async (tx) => {
    await lockOrgMembers(tx, orgId);
    if (target.role === "owner" && role !== "owner" && (await ownerCount(tx, orgId)) <= 1) {
      throw new ConflictError("An organization needs at least one owner");
    }
    await tx
      .update(organizationMembers)
      .set({ role })
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)));
    if (target.role !== role) {
      await auditMember(tx, orgId, actorId, "member.role_changed", targetUserId, {
        from: target.role,
        to: role,
        ...(via ? { via } : {}),
      });
      await followOwner(tx, orgId);
    }
  });
  await announceMembers(options.pubsub, orgId);
}

/**
 * The member someone may remove, or themselves leaving: refused unless the actor may (`manage_members`, owners only by
 * `manage_owners`, and only someone above them, ADR 0085). Null when they aren't a member.
 */
async function removableMember(db: Database, actorId: string, orgId: string, targetUserId: string) {
  // Admins can remove a blocked member; a blocked person can't act, not even to leave.
  const target = await getMembership(db, targetUserId, orgId, { includeBlocked: actorId !== targetUserId });
  if (!target) return null;
  if (actorId !== targetUserId) {
    const actor = await requirePermission(db, actorId, orgId, "manage_members");
    if (target.role === "owner" && !can(actor, "manage_owners"))
      throw new ForbiddenError("Only owners can remove owners");
    // Only someone above them (ADR 0085): their highest role below the actor's.
    if (!outranks(actor, target.rank)) throw new ForbiddenError("Only someone above them can remove them");
  }
  return target;
}

/**
 * Who answers for the agents of someone leaving: whoever removes them when they may manage agents, else (or when they
 * leave themselves) the workspace's longest-standing other owner, one who can still sign in first (the last owner
 * can't leave, so one is there). Removing someone never hands their agents to a remover who couldn't take them.
 */
async function heirOf(db: Executor, actorId: string, orgId: string, targetUserId: string) {
  if (actorId !== targetUserId && can(await getMembership(db, actorId, orgId), "manage_agents")) return actorId;
  const [owner] = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.role, "owner"),
        ne(organizationMembers.userId, targetUserId),
      ),
    )
    .orderBy(sql`not ${accountInUse}`, asc(organizationMembers.createdAt))
    .limit(1);
  return owner?.userId ?? null;
}

/** What goes with a person leaving the workspace, for the confirmation of `removeMember`. */
export interface RemovalPreview {
  /** Who answers for their agents from then on. */
  heir: { userId: string; name: string } | null;
  /** The agents they answer for. */
  agents: { id: string; name: string }[];
  /** Their agents (or others) that think with a plan they signed in, or on their computer: back to the API. */
  losePlan: { id: string; name: string }[];
  /** The computers they connected here: removed. */
  computers: { id: string; name: string }[];
  /** Their routines still on: paused. */
  routines: number;
}

/** What `removeMember` would do, refused exactly as it would be (`removableMember`). */
export async function removalPreview(
  db: Database,
  actorId: string,
  orgId: string,
  targetUserId: string,
): Promise<RemovalPreview | null> {
  const target = await removableMember(db, actorId, orgId, targetUserId);
  if (!target) return null;
  const { personalMachines } = await import("./machines");
  const computers = (await personalMachines(db, targetUserId, [orgId])).map(({ id, name }) => ({ id, name }));
  const heirId = await heirOf(db, actorId, orgId, targetUserId);
  const [heir] = heirId
    ? await db.select({ userId: users.id, name: users.name }).from(users).where(eq(users.id, heirId))
    : [];
  const live = and(eq(agents.orgId, orgId), isNull(agents.deletedAt), isNull(agents.archivedAt));
  const owned = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(live, eq(agents.ownerUserId, targetUserId)))
    .orderBy(asc(agents.name));
  const theirAccounts = db
    .select({ id: schema.machineAccounts.id })
    .from(schema.machineAccounts)
    .where(
      and(
        eq(schema.machineAccounts.orgId, orgId),
        eq(schema.machineAccounts.createdBy, targetUserId),
        ne(schema.machineAccounts.status, "removing"),
      ),
    );
  const onTheirs = computers.length
    ? inArray(
        agents.machineId,
        computers.map((c) => c.id),
      )
    : undefined;
  const losePlan = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(live, ne(agents.brain, "model"), or(inArray(agents.brainAccountId, theirAccounts), onTheirs)))
    .orderBy(asc(agents.name));
  const [routines] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.routines)
    .where(
      and(
        eq(schema.routines.orgId, orgId),
        eq(schema.routines.createdByUserId, targetUserId),
        eq(schema.routines.active, true),
        isNull(schema.routines.deletedAt),
      ),
    );
  return { heir: heir ?? null, agents: owned, losePlan, computers, routines: routines?.n ?? 0 };
}

/**
 * A plan thinks only for its owner's agents (ADR 0059 §3, `updateAgent`): of these agents, each one on a computer
 * brain (any of them: Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity) whose plan (an account, or the computer's own sign-in)
 * isn't its owner's, or that has no computer left, goes back to the API.
 */
async function offPlansNotOwners(tx: Executor, orgId: string, ids: string[]) {
  if (ids.length === 0) return;
  await tx
    .update(agents)
    .set({ brain: "model", brainAccountId: null, updatedAt: new Date() })
    .where(
      and(
        eq(agents.orgId, orgId),
        inArray(agents.id, ids),
        ne(agents.brain, "model"),
        sql`not exists (select 1 from ${schema.machines} m where m.id = ${agents.machineId} and m.deleted_at is null
            and ${agents.ownerUserId} = case when ${agents.brainAccountId} is null then m.paired_by_user_id
              else (select a.created_by from ${schema.machineAccounts} a where a.id = ${agents.brainAccountId}) end)`,
      ),
    );
}

/**
 * Removes a member (or lets a member leave). The last owner can't leave. Their agents pass on (`heirOf`); the plans they signed in leave the agents, which go back to the API, and the computers they connected
 * here go with them (`personalMachines`) unless marked the workspace's (`releaseLeaverDevices`). Every agent loses their mailboxes (`dropMailOfOwner`). Their messages stay.
 */
export async function removeMember(
  db: Database,
  actorId: string,
  orgId: string,
  targetUserId: string,
  /** `via`: the people card it was applied from (the audit's "via", `memberCardVia`). */
  options: { pubsub?: PubSub; via?: string } = {},
) {
  const target = await removableMember(db, actorId, orgId, targetUserId);
  if (!target) return;
  const via = await memberCardVia(db, orgId, options.via, targetUserId);
  // Loaded here: these modules build on this one.
  const { announceReleasedAccounts, forgetAgents, releaseMemberAccounts } = await import("./machine-accounts");
  const { announceRemovedMachine, detachMachine, personalMachines } = await import("./machines");
  const { releaseLeaverDevices } = await import("./devices");
  const { cancelSecretRequestsFor, publishSecret } = await import("./secrets");
  const { cancelMailboxApprovals, publishApproval } = await import("./approvals");
  const { dropMailOfOwner } = await import("./tools/scopes");
  const { dropMemberDashboards } = await import("./dashboards/service");
  const { released, removed, handed, changed, heir, secrets, mailActions } = await db.transaction(async (tx) => {
    await lockOrgMembers(tx, orgId);
    if (target.role === "owner" && (await ownerCount(tx, orgId)) <= 1) {
      throw new ConflictError("An organization needs at least one owner. Transfer ownership first.");
    }
    await tx
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)));
    // Leaving the organization also leaves its channels.
    await tx
      .delete(channelMembers)
      .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, targetUserId)));
    // And their inbox here, snippets included: invited back later, nothing from before returns.
    await tx
      .delete(schema.notifications)
      .where(and(eq(schema.notifications.orgId, orgId), eq(schema.notifications.userId, targetUserId)));
    // And the wiki pages and folders they were named on: rejoining later doesn't give a restricted page back.
    await tx
      .update(schema.wikiPages)
      .set({
        audienceUserIds: sql`array_remove(${schema.wikiPages.audienceUserIds}, ${targetUserId})`,
        editorUserIds: sql`array_remove(${schema.wikiPages.editorUserIds}, ${targetUserId})`,
      })
      .where(
        and(
          eq(schema.wikiPages.orgId, orgId),
          sql`${targetUserId} = any(${schema.wikiPages.audienceUserIds} || ${schema.wikiPages.editorUserIds})`,
        ),
      );
    await tx
      .update(schema.wikiFolderAudiences)
      .set({
        audienceUserIds: sql`array_remove(${schema.wikiFolderAudiences.audienceUserIds}, ${targetUserId})`,
        editorUserIds: sql`array_remove(${schema.wikiFolderAudiences.editorUserIds}, ${targetUserId})`,
      })
      .where(
        and(
          eq(schema.wikiFolderAudiences.orgId, orgId),
          sql`${targetUserId} = any(${schema.wikiFolderAudiences.audienceUserIds} || ${schema.wikiFolderAudiences.editorUserIds})`,
        ),
      );
    // And the agents' "only some people" lists, for the same reason.
    const unlisted = await tx
      .update(schema.agents)
      .set({ audienceUserIds: sql`array_remove(${schema.agents.audienceUserIds}, ${targetUserId})` })
      .where(and(eq(schema.agents.orgId, orgId), sql`${targetUserId} = any(${schema.agents.audienceUserIds})`))
      .returning({ id: schema.agents.id });
    for (const a of unlisted) caches.agents.delete(`${orgId}:${a.id}`);
    if (unlisted.length > 0) caches.agents.delete(`${orgId}:team`);
    // Their AI apps and personal tokens here stop now (ADR 0119).
    await revokeMemberApps(tx, orgId, targetUserId);
    // Their personal Vault goes with them, and they leave the team items' audiences (ADR 0144 §2). A personal
    // connection's items cascade with it.
    await tx
      .delete(schema.vaultConnections)
      .where(and(eq(schema.vaultConnections.orgId, orgId), eq(schema.vaultConnections.ownerUserId, targetUserId)));
    await tx
      .delete(schema.vaultItems)
      .where(and(eq(schema.vaultItems.orgId, orgId), eq(schema.vaultItems.ownerUserId, targetUserId)));
    await tx
      .update(schema.vaultItems)
      .set({ audienceUserIds: sql`array_remove(${schema.vaultItems.audienceUserIds}, ${targetUserId})` })
      .where(and(eq(schema.vaultItems.orgId, orgId), sql`${targetUserId} = any(${schema.vaultItems.audienceUserIds})`));
    await tx
      .update(schema.vaultConnections)
      .set({ audienceUserIds: sql`array_remove(${schema.vaultConnections.audienceUserIds}, ${targetUserId})` })
      .where(
        and(
          eq(schema.vaultConnections.orgId, orgId),
          sql`${targetUserId} = any(${schema.vaultConnections.audienceUserIds})`,
        ),
      );
    // Their home and private dashboards go, with their widgets' routines (ADR 0135).
    await dropMemberDashboards(tx, orgId, targetUserId);
    // The secrets agents are waiting on from them won't come.
    const secrets = await cancelSecretRequestsFor(tx, orgId, targetUserId);
    // Their agents keep someone answering for them (approvals, budget alerts), before their plans are released: an
    // agent on a computer of theirs then goes back to the API too (`releaseAgents`).
    const heir = await heirOf(tx, actorId, orgId, targetUserId);
    const handed = heir
      ? await tx
          .update(agents)
          .set({ ownerUserId: heir, updatedAt: new Date() })
          .where(and(eq(agents.orgId, orgId), eq(agents.ownerUserId, targetUserId)))
          .returning()
      : [];
    await dropAgentRules(
      tx,
      orgId,
      handed.map((a) => a.id),
      { type: "person", id: actorId },
    );
    const action = actorId === targetUserId ? "member.left" : "member.removed";
    await auditMember(tx, orgId, actorId, action, targetUserId, {
      role: target.role,
      ...(handed.length ? { agentsTo: heir, agents: handed.map((a) => a.id) } : {}),
      ...(via ? { via } : {}),
    });
    // No agent goes on reading or sending in their name: their mailboxes leave every agent, and what waits to run there doesn't.
    await dropMailOfOwner(tx, orgId, targetUserId, actorId);
    const mailActions = await cancelMailboxApprovals(tx, orgId, targetUserId, actorId);
    // Their AI accounts on the organization's computers are signed out and removed (ADR 0059 §1).
    const released = await releaseMemberAccounts(tx, targetUserId, orgId);
    const removed = [];
    for (const computer of await personalMachines(tx, targetUserId, [orgId])) {
      removed.push({ computer, freed: await detachMachine(tx, computer) });
    }
    await releaseLeaverDevices(tx, orgId, targetUserId);
    const touched = [...new Set([...handed.map((a) => a.id), ...removed.flatMap((r) => r.freed)])];
    await offPlansNotOwners(tx, orgId, touched);
    const changed = [...new Set([...touched, ...released.agents.flatMap((a) => a.agentIds)])];
    await followOwner(tx, orgId);
    return { released, removed, handed, changed, heir, secrets, mailActions };
  });
  for (const row of secrets) await publishSecret({ db, pubsub: options.pubsub }, row, "secret.updated");
  for (const row of mailActions) await publishApproval({ db, pubsub: options.pubsub }, row, "approval.decided");
  forgetAgents(
    orgId,
    handed.map((a) => a.id),
  );
  if (handed.length) caches.agents.delete(`${orgId}:team`);
  if (heir && handed.length) {
    const { handOver } = await import("./agents");
    for (const agent of handed) {
      await handOver({ db, pubsub: options.pubsub }, actorId, { ...agent, ownerUserId: targetUserId }, heir);
    }
  }
  await announceReleasedAccounts(options.pubsub, released);
  for (const { computer, freed } of removed) {
    await announceRemovedMachine({ db, pubsub: options.pubsub }, computer, { type: "person", id: actorId }, freed);
  }
  // Runs waiting on a device that left with them stop waiting and say so (bring your own devices).
  if (removed.length > 0) {
    const { endWaitsOnLeftDevice } = await import("./device-waits");
    for (const { computer } of removed) {
      await endWaitsOnLeftDevice({ db, pubsub: options.pubsub }, orgId, computer.id, targetUserId).catch(() => 0);
    }
  }
  // Their open WebSocket connections lose every subscription now, not on reconnect.
  const quiet = actorId === targetUserId ? { quiet: true as const } : {};
  await publishOrgEvent(options.pubsub, { type: "membership.revoked", orgId, userId: targetUserId, ...quiet });
  await announceMembers(options.pubsub, orgId, changed);
  const { releaseQuestionsOf } = await import("./questions");
  await releaseQuestionsOf({ db, pubsub: options.pubsub }, orgId, targetUserId);
  // Their routines pause at once and their work stops; the agents' owners hear it (ADR 0053 §6.2).
  // Loaded here: the routine engine builds on this module.
  const { pauseRoutinesOfCreator } = await import("./routine-firing");
  await pauseRoutinesOfCreator({ db, pubsub: options.pubsub }, orgId, targetUserId).catch(() => 0);
}

/** A deleted workspace's files leave platform storage (`purgeOrgFiles`). */
export const ORG_FILES_PURGE_JOB = "org.files.purge";
/** The backoff tops out at 3 h: a purge keeps trying through a storage outage for about 30 days. */
export const ORG_FILES_PURGE_ATTEMPTS = 240;
/** A deleted account's photos leave platform storage (`purgeUserFiles`). */
export const USER_FILES_PURGE_JOB = "user.files.purge";

/**
 * Queues the purge of a workspace's files, in the transaction that deletes it. No org_id on the job: the outbox row
 * would be deleted with the workspace (cascade). A second pass a day later takes files that work under way stored after
 * the first (an agent's upload stores its file, then its row is refused).
 */
export async function queueOrgFilesPurge(tx: Executor, orgId: string) {
  const purge = { orgId: null, kind: ORG_FILES_PURGE_JOB, payload: { orgId }, maxAttempts: ORG_FILES_PURGE_ATTEMPTS };
  await enqueue(tx, purge);
  const late = { runAt: new Date(Date.now() + 86_400_000), dedupeKey: `${ORG_FILES_PURGE_JOB}:${orgId}:late` };
  await enqueue(tx, { ...purge, ...late });
}

/**
 * Deletes a person's account for good, as `accountDeletionPlan` reads it under the `org-members` locks: the account
 * deletion job does this at its date (`purgeAccount`, with `whenDue`, which then does nothing unless the date passed,
 * by the clock restoring reads, and returns false). Refused for a blocked account (it can't act) and with `sole_owner` (`soleOwnerRefusal`).
 * Workspaces only they are in close and go later, as any deletion, whatever their standing (`closeForDeletion`,
 * `via: "account"`): a hold makes their purge wait, never the account. They leave the others, and the computers they
 * connected there go (`personalMachines`); what they added there stays. Their AI accounts on computers are signed out
 * and removed, never inherited (ADR 0059 §1). The rest follows the foreign keys: sessions, sign-in methods,
 * memberships, channel memberships, notifications and phones are deleted; messages and records they authored stay
 * without an author. With `emails` they are told (`account_deleted`). Their photos leave platform storage
 * (`user.files.purge`). The caller checks that it's them.
 */
export async function deleteAccount(
  db: Database,
  userId: string,
  options: Omit<DeletionDeps, "db"> & { whenDue?: boolean } = {},
) {
  if (await isUserBlocked(db, userId)) throw new ForbiddenError();
  // Before any account goes: the first one stays the owner even once it is gone.
  const owner = await pinnedOwner(db);
  // Loaded here: these modules build on this one.
  const { announceReleasedAccounts, releaseMemberAccounts } = await import("./machine-accounts");
  const { announceRemovedMachine, detachMachine } = await import("./machines");
  const { accountDeletionPlan, afterClosing, closeForDeletion, queueAccountDeletedEmail, soleOwnerRefusal } =
    await import("./workspace-deletion");
  const { cancelMailboxApprovals, publishApproval } = await import("./approvals");
  const { dropMailOfOwner } = await import("./tools/scopes");
  const done = await db.transaction(async (tx) => {
    // First, as creating a workspace does: one made in another tab meanwhile is in the plan below and closes with them.
    await lockWorkspacesOf(tx, userId);
    if (options.whenDue) {
      const [due] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), sql`${users.deletionDueAt} <= statement_timestamp()`));
      if (!due) return null;
    }
    const mine = await tx
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizationMembers.orgId));
    // The lock of role changes, removals and a workspace's deletion, in a fixed order. Every workspace row is written
    // before the user row, as the purge writes them.
    for (const m of mine) await lockOrgMembers(tx, m.orgId);
    const plan = await accountDeletionPlan(tx, userId);
    const refusal = soleOwnerRefusal(plan);
    if (refusal) throw refusal;
    const closed: Closed[] = [];
    for (const org of plan.closes) {
      // One already being deleted keeps its date, and is no news.
      const scheduled = await closeForDeletion(tx, { actorId: userId, orgId: org.id, via: "account" });
      if (scheduled.closed) closed.push(scheduled.closed);
    }
    // Before the user row: `created_by` would turn null, and a null owner is nobody's.
    const released = await releaseMemberAccounts(tx, userId, null);
    // Their mailboxes leave every agent there too (`removeMember`); a mailbox without an owner would be anyone's.
    const mailActions = [];
    for (const m of mine) {
      await dropMailOfOwner(tx, m.orgId, userId, userId);
      mailActions.push(...(await cancelMailboxApprovals(tx, m.orgId, userId, userId)));
    }
    for (const org of plan.leaves) {
      await auditMember(tx, org.id, userId, "member.left", userId, { role: org.role, accountDeleted: true });
    }
    const removed = [];
    for (const computer of plan.computers) {
      const freed = await detachMachine(tx, { ...computer, kind: "connected" });
      // Their computer's own sign-in thought for these agents, whatever the brain: back to the API (`removeMember`).
      await offPlansNotOwners(tx, computer.orgId, freed);
      removed.push({ computer, freed });
    }
    // Their agents are left with no owner, and a plan thinks only for its owner's (`planIsOwners`): whatever computer
    // brain they had, they go back to the API.
    const ownerless = plan.leaves.length
      ? await tx
          .update(agents)
          .set({ brain: "model", brainAccountId: null, updatedAt: new Date() })
          .where(
            and(
              inArray(
                agents.orgId,
                plan.leaves.map((o) => o.id),
              ),
              eq(agents.ownerUserId, userId),
              ne(agents.brain, "model"),
            ),
          )
          .returning({ id: agents.id, orgId: agents.orgId })
      : [];
    if (options.emails) await queueAccountDeletedEmail(tx, userId, closed, options.emails);
    await enqueueAccountContact(tx, userId);
    await tx.delete(users).where(eq(users.id, userId));
    for (const org of plan.leaves) await followOwner(tx, org.id);
    // The owner's own TypeSafe account would go on getting, and paying for, every workspace's Jev calls; and their
    // GIPHY key would go on serving every workspace's GIFs, with nobody left who could remove it (ADR 0091); so would
    // the speech provider's key (ADR 0100) and the GitHub App they made, whose GitHub account holds it (ADR 0156).
    if (userId === owner) {
      await deleteJevKey(tx, { type: "system", id: null });
      await deleteGifKey(tx, { type: "system", id: null });
      await tx.delete(schema.instanceSecrets).where(eq(schema.instanceSecrets.name, "speech"));
      await deleteGitHubAppSettings(tx, { type: "system", id: null });
    }
    // With nobody left, the next first account owns the server again.
    await tx.update(instanceTelemetry).set({ ownerUserId: null }).where(sql`not exists (select 1 from ${users})`);
    await recordOperatorEvent(tx, { type: "user.deleted", userId });
    // No org_id: the job outlives every workspace.
    await enqueue(tx, {
      orgId: null,
      kind: USER_FILES_PURGE_JOB,
      payload: { userId },
      maxAttempts: ORG_FILES_PURGE_ATTEMPTS,
    });
    return { plan, closed, released, removed, mailActions, ownerless };
  });
  if (!done) return false;
  const { plan, closed, released, removed, mailActions, ownerless } = done;
  for (const row of mailActions) await publishApproval({ db, pubsub: options.pubsub }, row, "approval.decided");
  await announceReleasedAccounts(options.pubsub, released);
  for (const { computer, freed } of removed) {
    await announceRemovedMachine({ db, pubsub: options.pubsub }, computer, { type: "person", id: userId }, freed);
  }
  // Their open WebSocket connections lose every subscription now.
  for (const org of [...plan.closes, ...plan.leaves]) {
    await publishOrgEvent(options.pubsub, { type: "membership.revoked", orgId: org.id, userId, quiet: true });
  }
  const { releaseQuestionsOf } = await import("./questions");
  for (const org of plan.leaves) {
    await releaseQuestionsOf({ db, pubsub: options.pubsub }, org.id, userId);
    const changed = [
      ...released.agents.filter((a) => a.orgId === org.id).flatMap((a) => a.agentIds),
      ...removed.filter((r) => r.computer.orgId === org.id).flatMap((r) => r.freed),
      ...ownerless.filter((a) => a.orgId === org.id).map((a) => a.id),
    ];
    for (const id of changed) caches.agents.delete(`${org.id}:${id}`);
    await announceMembers(options.pubsub, org.id, [...new Set(changed)]);
  }
  for (const one of closed) await afterClosing({ ...options, db }, one);
  return true;
}

/**
 * The Apple tokens of a person's "Sign in with Apple" accounts, to revoke
 * when the account is deleted (read before `deleteAccount`, which deletes
 * them). The refresh token when Better Auth kept one, else the access token.
 */
export async function appleSignInTokens(
  db: Database,
  userId: string,
): Promise<{ value: string; hint: "refresh_token" | "access_token" }[]> {
  const rows = await db
    .select({ refreshToken: schema.accounts.refreshToken, accessToken: schema.accounts.accessToken })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, "apple")));
  return rows.flatMap((r): { value: string; hint: "refresh_token" | "access_token" }[] =>
    r.refreshToken
      ? [{ value: r.refreshToken, hint: "refresh_token" as const }]
      : r.accessToken
        ? [{ value: r.accessToken, hint: "access_token" as const }]
        : [],
  );
}

// ── Invitations ──────────────────────────────────────────────────────────────

export const INVITATION_TTL_DAYS = 7;
/** How long an invitation link works (ADR 0068): nobody gets in through it without an admin's approval. */
export const INVITE_LINK_TTL_DAYS = 30;

const ROLE_RANK: Record<MemberRole, number> = { member: 0, owner: 1 };

/**
 * Sends an invitation to an address with a role and the roles (`org_roles`) the person gets: the one named
 * (`invitationId`), else the newest one for that address not accepted yet, gets 7 more days; with none, a new one
 * is made. With `secret` its token is derived from its id (`invitationToken`, ADR 0090): the link can be copied
 * again and sending it again keeps it. Without one (or for an invitation made before), a new random token replaces
 * the old one, whose link stops working. One still working keeps the higher of its role and this one and adds these
 * roles and channels to its own, so sending it again never demotes whoever it was meant for, and an owner's
 * invitation goes out again only from an owner (`ownersOk`). Records `invitation.created`. The caller checks who
 * may invite, which roles they may give (`givableRoleIds`) and which channels (`invitableChannelIds`).
 */
export async function sendInvitation(
  db: Executor,
  input: {
    orgId: string;
    email: string;
    role: MemberRole;
    /** Roles the person gets on accepting (checked by the caller). */
    roleIds?: string[];
    /** Channels the person joins on accepting, besides `general` (checked by the caller). */
    channelIds?: string[];
    /** The inviter's words for the email; absent keeps the invitation's own. */
    note?: string | null;
    invitedBy: string;
    /** The sender may invite owners (`manage_owners`). */
    ownersOk: boolean;
    /** `AGENTES_SECRET`: the token is derived from the invitation's id (ADR 0090). */
    secret?: string;
    now?: Date;
    invitationId?: string;
    /** Resent from the pending list. */
    resent?: boolean;
    /** An admin approved a request to join (`invite-requests.ts`). */
    fromRequest?: boolean;
  },
) {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const [existing] = await db
    .select({
      id: organizationInvitations.id,
      role: organizationInvitations.role,
      roleIds: organizationInvitations.roleIds,
      channelIds: organizationInvitations.channelIds,
      expiresAt: organizationInvitations.expiresAt,
    })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.orgId, input.orgId),
        input.invitationId
          ? eq(organizationInvitations.id, input.invitationId)
          : eq(organizationInvitations.email, email),
        isNull(organizationInvitations.acceptedAt),
      ),
    )
    .orderBy(desc(organizationInvitations.createdAt))
    .limit(1);
  const role =
    existing && existing.expiresAt > now && ROLE_RANK[existing.role] > ROLE_RANK[input.role]
      ? existing.role
      : input.role;
  if (role === "owner" && !input.ownersOk) throw new ForbiddenError("Only owners can invite owners");
  const working = existing && existing.expiresAt > now;
  const keep = working ? existing.roleIds : [];
  const keepChannels = working ? existing.channelIds : [];
  const id = existing?.id ?? crypto.randomUUID();
  const token = input.secret ? invitationToken(input.secret, id) : randomToken(32);
  const fresh = {
    role,
    roleIds: [...new Set([...keep, ...(input.roleIds ?? [])])],
    channelIds: [...new Set([...keepChannels, ...(input.channelIds ?? [])])],
    ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
    tokenHash: sha256(token),
    invitedByUserId: input.invitedBy,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
  };
  const [invitation] = existing
    ? await db.update(organizationInvitations).set(fresh).where(eq(organizationInvitations.id, existing.id)).returning()
    : await db
        .insert(organizationInvitations)
        .values({ id, orgId: input.orgId, email, ...fresh })
        .returning();
  if (!invitation) throw new ConflictError("This invitation can't be sent");
  await recordAudit(db, {
    orgId: input.orgId,
    actor: { type: "person", id: input.invitedBy },
    action: input.resent ? "invitation.resent" : "invitation.sent",
    target: { type: "invitation", id: invitation.id },
    details: {
      email: invitation.email,
      role: invitation.role,
      roleIds: invitation.roleIds,
      ...(input.fromRequest ? { fromRequest: true } : {}),
    },
  });
  await recordOperatorEvent(db, {
    type: "invitation.created",
    orgId: input.orgId,
    userId: input.invitedBy,
    data: {
      emailDomain: addressDomain(invitation.email),
      role: invitation.role,
      ...(input.resent ? { resent: true } : {}),
      ...(input.fromRequest ? { fromRequest: true } : {}),
    },
  });
  /** `token` goes in the link and is never stored. */
  return { invitation, token };
}

/** The longest note an inviter writes for the invitation email (ADR 0090). */
export const INVITE_NOTE_MAX = 300;

/**
 * The channels an invitation adds someone to, besides `general` (ADR 0090): the workspace's own, not archived and
 * not a conversation, public or one the sender is in. Any other id refuses the invitation (`invitation.channel`).
 */
export async function invitableChannelIds(db: Executor, actorId: string, orgId: string, ids: readonly string[]) {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  // The sender's own row in each channel, joined: a subquery in a single-table select names its columns bare, so
  // `channels.id` in it would read the inner table's id.
  const rows = await db
    .select({ id: channels.id, visibility: channels.visibility, member: channelMembers.userId })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, actorId)))
    .where(
      and(
        eq(channels.orgId, orgId),
        inArray(channels.id, wanted),
        isNull(channels.archivedAt),
        ne(channels.kind, "dm"),
      ),
    );
  const ok = rows.filter((r) => r.visibility === "public" || r.member !== null).map((r) => r.id);
  if (ok.length !== wanted.length) {
    throw new ValidationError("One of these channels can't go with an invitation", "invitation.channel");
  }
  return ok;
}

export async function createInvitation(
  db: Database,
  actorId: string,
  orgId: string,
  input: {
    email: string;
    role?: MemberRole;
    roleIds?: string[];
    channelIds?: string[];
    note?: string | null;
    /** `AGENTES_SECRET`: a link that can be copied again and stays the same when sent again (ADR 0090). */
    secret?: string;
  },
  now = new Date(),
) {
  const actor = await requirePermission(db, actorId, orgId, "invite_people");
  assertInviting(actor);
  const roleIds = await givableRoleIds(db, actor, orgId, input.roleIds ?? []);
  const channelIds = await invitableChannelIds(db, actorId, orgId, input.channelIds ?? []);
  return inviteChecked(db, actor, actorId, orgId, { ...input, roleIds, channelIds }, now);
}

/**
 * One invitation from a sender whose standing, roles and channels the caller checked (`createInvitation`, and
 * `inviteMany` once for its whole batch): refused for an address already in (`conflict`) and while the workspace is
 * full (`org.members_full`).
 */
async function inviteChecked(
  db: Database,
  actor: Membership,
  actorId: string,
  orgId: string,
  input: {
    email: string;
    role?: MemberRole;
    roleIds: string[];
    channelIds: string[];
    note?: string | null;
    secret?: string;
  },
  now: Date,
) {
  const email = input.email.trim().toLowerCase();
  const [alreadyMember] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(and(eq(users.email, email), eq(organizationMembers.orgId, orgId)));
  if (alreadyMember) throw new ConflictError(`${email} is already a member`);
  await assertMemberRoom(db, orgId);
  return sendInvitation(db, {
    orgId,
    email,
    role: input.role ?? "member",
    roleIds: input.roleIds,
    channelIds: input.channelIds,
    ...(input.note !== undefined ? { note: input.note?.slice(0, INVITE_NOTE_MAX) ?? null } : {}),
    invitedBy: actorId,
    ownersOk: can(actor, "manage_owners"),
    secret: input.secret,
    now,
  });
}

/**
 * Changes the roles a pending invitation gives (ADR 0090): its link stays the same and nothing is sent. Only while it
 * still works (sending it again is what brings back one that ran out), and from a workspace that may invite.
 */
export async function setInvitationRoles(
  db: Database,
  actorId: string,
  orgId: string,
  invitationId: string,
  roleIdsIn: string[],
  now = new Date(),
) {
  const actor = await requirePermission(db, actorId, orgId, "invite_people");
  assertInviting(actor);
  const roleIds = await givableRoleIds(db, actor, orgId, roleIdsIn);
  const [row] = await db
    .update(organizationInvitations)
    .set({ roleIds })
    .where(
      and(
        eq(organizationInvitations.id, invitationId),
        eq(organizationInvitations.orgId, orgId),
        isNull(organizationInvitations.acceptedAt),
        gt(organizationInvitations.expiresAt, now),
      ),
    )
    .returning({ email: organizationInvitations.email });
  if (!row) throw new ConflictError("This invitation can't be changed");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "invitation.roles_changed",
    target: { type: "invitation", id: invitationId },
    details: { email: row.email, roleIds },
  });
  return { roleIds };
}

export async function listInvitations(db: Database, orgId: string, now = new Date()) {
  return db
    .select({
      id: organizationInvitations.id,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      roleIds: organizationInvitations.roleIds,
      expiresAt: organizationInvitations.expiresAt,
      createdAt: organizationInvitations.createdAt,
    })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.orgId, orgId),
        isNull(organizationInvitations.acceptedAt),
        gt(organizationInvitations.expiresAt, now),
      ),
    )
    .orderBy(asc(organizationInvitations.createdAt));
}

export async function revokeInvitation(db: Database, actorId: string, orgId: string, invitationId: string) {
  await requirePermission(db, actorId, orgId, "invite_people");
  const [gone] = await db
    .delete(organizationInvitations)
    .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.orgId, orgId)))
    .returning({ email: organizationInvitations.email, role: organizationInvitations.role });
  if (gone) {
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "invitation.revoked",
      target: { type: "invitation", id: invitationId },
      details: { email: gone.email, role: gone.role },
    });
  }
}

/**
 * The workspace's invitation link (admins, ADR 0068): whoever opens it can only ask to join. One link per
 * workspace, shown again whenever needed: the newest active link whose token is still derived from
 * `secret` (`inviteLinkToken`), else a new one for 30 days (`made`). Uses the same `/invite/{token}` page as
 * email invitations.
 */
export async function inviteLink(db: Database, secret: string, actorId: string, orgId: string, now = new Date()) {
  assertInviting(await requirePermission(db, actorId, orgId, "invite_people"));
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invite-links:${orgId}`}))`);
    const active = await tx
      .select()
      .from(organizationInviteLinks)
      .where(
        and(
          eq(organizationInviteLinks.orgId, orgId),
          isNull(organizationInviteLinks.revokedAt),
          gt(organizationInviteLinks.expiresAt, now),
        ),
      )
      .orderBy(desc(organizationInviteLinks.createdAt));
    for (const link of active) {
      const token = inviteLinkToken(secret, link.id);
      if (link.tokenHash === sha256(token)) return { link, token, made: false };
    }
    const id = crypto.randomUUID();
    const token = inviteLinkToken(secret, id);
    const [link] = await tx
      .insert(organizationInviteLinks)
      .values({
        id,
        orgId,
        role: "member",
        tokenHash: sha256(token),
        createdByUserId: actorId,
        expiresAt: new Date(now.getTime() + INVITE_LINK_TTL_DAYS * 86_400_000),
      })
      .returning();
    if (!link) throw new Error("invite link insert returned nothing");
    await recordOperatorEvent(tx, { type: "invitation.created", orgId, userId: actorId, data: { link: true } });
    return { link, token, made: true };
  });
}

/** An invitation link by its token (or its id), with its workspace's name, logo and whether it is open; null when none. */
export async function findInviteLink(db: Executor, by: string | { id: string }) {
  const [row] = await db
    .select({
      link: organizationInviteLinks,
      orgName: organizations.name,
      orgLogo: organizations.logo,
      open: openOrg,
    })
    .from(organizationInviteLinks)
    .innerJoin(organizations, eq(organizations.id, organizationInviteLinks.orgId))
    .where(
      typeof by === "string"
        ? eq(organizationInviteLinks.tokenHash, sha256(by))
        : eq(organizationInviteLinks.id, by.id),
    );
  return row ?? null;
}

/** A link people can still ask with: not turned off, not expired, and its workspace active and not being deleted. */
export const inviteLinkOpen = (
  found: { link: { revokedAt: Date | null; expiresAt: Date }; open: boolean },
  now = new Date(),
) => !found.link.revokedAt && found.link.expiresAt > now && found.open;

/** How many of the organization's agents an invitation names ("Theo, Ada, Lia e Atlas já trabalham lá"). */
const INVITE_AGENTS = 4;

/**
 * The organization's first agents (not archived), for an invitation page: name and look only, and how many more
 * work there (`moreAgents`, when some do), so the page never reads as if those were all of them.
 */
async function inviteAgents(db: Database, orgId: string) {
  const rows = await db
    .select({ id: agents.id, name: agents.name, appearance: agents.appearance, total: sql<number>`count(*) over ()` })
    .from(agents)
    // Every workspace has its right hand (ADR 0137): the page names the team's own agents.
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNull(agents.builtin)))
    .orderBy(asc(agents.createdAt))
    .limit(INVITE_AGENTS);
  const more = Number(rows[0]?.total ?? 0) - rows.length;
  return { agents: rows.map(({ total: _, ...agent }) => agent), ...(more > 0 ? { moreAgents: more } : {}) };
}

/**
 * The workspace's logo on an invitation's page (`logo`, when it has one): its current file at an address of that
 * token's own (`invitationLogoFile`), since the members' address serves members only.
 */
const inviteLogo = (token: string, logo: string | null) => {
  const file = logo?.split("/").pop();
  return file ? { logo: `/api/app/invitations/${encodeURIComponent(token)}/logo/${file}` } : {};
};

/**
 * How the invited address signs in (ADR 0090), for the invite page to ask only what is missing: whether it has an
 * account, a password, and which social sign-ins. Only for the holder of an invitation to that address.
 */
async function invitedAccount(db: Database, email: string) {
  const rows = await db
    .select({ providerId: accounts.providerId })
    .from(users)
    .leftJoin(accounts, eq(accounts.userId, users.id))
    .where(eq(users.email, email));
  const ids = rows.map((r) => r.providerId).filter((id): id is string => id !== null);
  return {
    exists: rows.length > 0,
    password: ids.includes("credential"),
    providers: [...new Set(ids.filter((id) => SIGN_IN_PROVIDERS.has(id)))] as SignInProvider[],
  };
}

/** Whether the workspace has no seat left (`assertMemberRoom`), said on the invite page before any account is made. */
async function seatsFull(db: Executor, orgId: string) {
  try {
    await assertMemberRoom(db, orgId);
    return false;
  } catch (error) {
    if (error instanceof ConflictError && error.code === "org.members_full") return true;
    throw error;
  }
}

/**
 * What the invite page shows before signing in (`email` is empty for an org link): the organization and its logo,
 * who invited (their name), the role and its first agents. Only for a valid token, which reached the person.
 * A link that was turned off, expired, or whose workspace is paused or being deleted, and an email invitation to a
 * workspace paused or being deleted, say only that (`closed`), never why. An email invitation also says how its
 * address signs in (`account`) and whether the workspace is full (`full`), before anyone makes an account
 * (ADR 0090). One that works also says who the workspace is for (`mode`): a personal one's page speaks of the
 * person who invited, not of a team or of its name ("Personal"), ADR 0159.
 */
/**
 * The role an invitation gives now: owner only while whoever sent it can still make owners, so removing or demoting
 * them takes back what they handed out.
 */
async function invitedAs(
  db: Executor,
  invitation: { orgId: string; invitedByUserId: string | null; role: MemberRole },
) {
  const inviter = invitation.invitedByUserId
    ? await getMembership(db, invitation.invitedByUserId, invitation.orgId)
    : null;
  const role: MemberRole = invitation.role === "owner" && can(inviter, "manage_owners") ? "owner" : "member";
  return { inviter, role };
}

export async function previewInvitation(db: Database, token: string, now = new Date()) {
  const [row] = await db
    .select({
      orgId: organizationInvitations.orgId,
      orgName: organizations.name,
      orgLogo: organizations.logo,
      open: openOrg,
      deleting: sql<boolean>`${organizations.deletionDueAt} is not null`,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      expiresAt: organizationInvitations.expiresAt,
      acceptedAt: organizationInvitations.acceptedAt,
      invitedBy: users.name,
      invitedByUserId: organizationInvitations.invitedByUserId,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.orgId))
    .leftJoin(users, eq(users.id, organizationInvitations.invitedByUserId))
    .where(eq(organizationInvitations.tokenHash, sha256(token)));
  if (!row) {
    const link = await findInviteLink(db, token);
    if (!link) return null;
    if (!inviteLinkOpen(link, now)) {
      return {
        orgName: link.orgName,
        email: "",
        role: "member" as const,
        kind: "link" as const,
        invitedBy: null,
        agents: [],
        closed: true as const,
      };
    }
    const [creator] = link.link.createdByUserId
      ? await db.select({ name: users.name }).from(users).where(eq(users.id, link.link.createdByUserId))
      : [];
    return {
      orgName: link.orgName,
      email: "",
      role: link.link.role,
      kind: "link" as const,
      invitedBy: creator?.name ?? null,
      mode: await workspaceMode(db, link.link.orgId),
      ...inviteLogo(token, link.orgLogo),
      ...(await inviteAgents(db, link.link.orgId)),
    };
  }
  if (row.acceptedAt || row.expiresAt <= now) return null;
  // Nobody joins a workspace paused or being deleted: its name only, and that it's closed, as for a link.
  if (row.deleting || !row.open) {
    return {
      orgName: row.orgName,
      email: "",
      role: "member" as const,
      kind: "email" as const,
      invitedBy: null,
      agents: [],
      closed: true as const,
    };
  }
  // What accepting would give now, and who sent it only while they're still here.
  const { inviter, role } = await invitedAs(db, row);
  return {
    orgName: row.orgName,
    email: row.email,
    role,
    kind: "email" as const,
    invitedBy: inviter ? (row.invitedBy ?? null) : null,
    mode: await workspaceMode(db, row.orgId),
    expiresAt: row.expiresAt.toISOString(),
    account: await invitedAccount(db, row.email),
    ...((await seatsFull(db, row.orgId)) ? { full: true as const } : {}),
    // Only while it can be accepted, as `invitedOrgId` serves it.
    ...inviteLogo(token, row.orgLogo),
    ...(await inviteAgents(db, row.orgId)),
  };
}

/**
 * What the page of an email invitation that no longer opens says (ADR 0090): accepted (with the workspace's id,
 * to open it for a member) or expired (when, and who invited, to ask again). Null for a token that matches none,
 * a cancelled invitation's included (its row is gone), and for one that still works (`previewInvitation`).
 */
export async function invitationState(db: Database, token: string, now = new Date()) {
  const [row] = await db
    .select({
      orgId: organizationInvitations.orgId,
      orgName: organizations.name,
      acceptedAt: organizationInvitations.acceptedAt,
      expiresAt: organizationInvitations.expiresAt,
      invitedBy: users.name,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.orgId))
    .leftJoin(users, eq(users.id, organizationInvitations.invitedByUserId))
    .where(eq(organizationInvitations.tokenHash, sha256(token)));
  if (!row) return null;
  if (row.acceptedAt) {
    return { state: "accepted" as const, orgId: row.orgId, orgName: row.orgName, at: row.acceptedAt.toISOString() };
  }
  if (row.expiresAt <= now) {
    return {
      state: "expired" as const,
      orgName: row.orgName,
      invitedBy: row.invitedBy ?? null,
      at: row.expiresAt.toISOString(),
    };
  }
  return null;
}

/**
 * The workspace a token opens while it works, else null: an invitation neither accepted nor expired into an active
 * workspace that isn't being deleted (`acceptInvitation` refuses any other), or an open link.
 */
export async function invitedOrgId(db: Executor, token: string, now = new Date()): Promise<string | null> {
  const [invitation] = await db
    .select({
      orgId: organizationInvitations.orgId,
      acceptedAt: organizationInvitations.acceptedAt,
      expiresAt: organizationInvitations.expiresAt,
      open: openOrg,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.orgId))
    .where(eq(organizationInvitations.tokenHash, sha256(token)));
  if (invitation) {
    const works = !invitation.acceptedAt && invitation.expiresAt > now && invitation.open;
    return works ? invitation.orgId : null;
  }
  const link = await findInviteLink(db, token);
  return link && inviteLinkOpen(link, now) ? link.link.orgId : null;
}

/** The proof an emailed invitation link carries (`invitationMailLink`), with the secret to check it (ADR 0090). */
export interface InvitationMail {
  secret: string;
  proof?: string | null;
}

/**
 * Whether `mail` holds the proof only this invitation's own email carries (ADR 0090). The link itself doesn't show
 * it: an admin can copy that one and hand it to anyone.
 */
function cameByEmail(invitationId: string, mail: InvitationMail | undefined): boolean {
  const proof = mail?.proof;
  if (!mail || !proof || proof.length > 100) return false;
  return safeEqual(invitationMailProof(mail.secret, invitationId), proof);
}

/**
 * Accepts an invitation. The signed-in user's email must match the invited one. Joins `general`. Not for
 * a blocked account, nor into a workspace on hold, suspended or being deleted. An invitation link only lets people
 * ask (`invitation.ask_to_join`, ADR 0068). Accepted from its own email (`mail`), it confirms the address.
 */
export async function acceptInvitation(
  db: Database,
  user: { id: string; email: string },
  token: string,
  now = new Date(),
  mail?: InvitationMail,
) {
  if (await accountClosed(db, user.id)) throw new ForbiddenError();
  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.tokenHash, sha256(token)))
      .for("update");
    if (!invitation) {
      if (await findInviteLink(tx, token))
        throw new ConflictError("This link asks an admin first", "invitation.ask_to_join");
      throw new ConflictError("This invitation is invalid or has expired");
    }
    if (invitation.acceptedAt || invitation.expiresAt <= now) {
      throw new ConflictError("This invitation is invalid or has expired");
    }
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenError(
        `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
      );
    }
    await assertCanWork(tx, invitation.orgId);
    // What it gives is what whoever sent it could still give now: removing or demoting them takes back the roles they
    // handed out, as with private channels below. Someone already in gets no roles from an old invitation.
    const { inviter, role } = await invitedAs(tx, invitation);
    const already = await getMembership(tx, user.id, invitation.orgId, { includeBlocked: true });
    const roleIds = already ? [] : await stillGivableRoleIds(tx, inviter, invitation.orgId, invitation.roleIds);
    await joinOrganization(tx, invitation.orgId, user.id, role, roleIds);
    // The channels it named, besides `general` (ADR 0090): those still there. A private one only while whoever sent
    // the invitation is still in it, as when it was sent (`invitableChannelIds`): leaving it, or the workspace, takes
    // back what they could give.
    if (invitation.channelIds.length > 0) {
      const inviter = invitation.invitedByUserId;
      const inviterIn = inviter
        ? sql`exists (select 1 from ${channelMembers}
            where ${channelMembers.channelId} = ${channels.id} and ${channelMembers.userId} = ${inviter})`
        : undefined;
      const still = await tx
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.orgId, invitation.orgId),
            inArray(channels.id, invitation.channelIds),
            isNull(channels.archivedAt),
            ne(channels.kind, "dm"),
            or(eq(channels.visibility, "public"), inviterIn),
          ),
        );
      for (const channel of still) {
        await tx
          .insert(channelMembers)
          .values({ orgId: invitation.orgId, channelId: channel.id, userId: user.id })
          .onConflictDoNothing();
      }
    }
    // From its own email, the message reached that mailbox: the address is confirmed, and no "confirm your email"
    // follows (ADR 0090). From a copied link nothing shows that, so confirming goes as for any sign-up.
    if (cameByEmail(invitation.id, mail)) {
      await tx
        .update(users)
        .set({ emailVerified: true })
        .where(and(eq(users.id, user.id), eq(users.emailVerified, false)));
    }
    await auditMember(tx, invitation.orgId, user.id, "member.joined", user.id, {
      role,
      roleIds,
      invitedBy: invitation.invitedByUserId,
    });
    await tx
      .update(organizationInvitations)
      .set({ acceptedAt: now })
      .where(eq(organizationInvitations.id, invitation.id));
    return { orgId: invitation.orgId, invitedBy: invitation.invitedByUserId };
  });
}

/** Headers a sign-up from an email invitation's page carries its token and proof in (ADR 0090, `holdsInvitation`). */
export const INVITATION_TOKEN_HEADER = "x-invitation-token";
export const INVITATION_MAIL_HEADER = "x-invitation-mail";

/**
 * Whether a sign-up holds an email invitation to its own address, from that invitation's email (ADR 0090): `token` is
 * the link of one to `email` that can still be accepted, and `mail` the proof only its message carries. Such a sign-up
 * skips the "confirm your email" message, since accepting from the email confirms the address. With a copied link, or
 * none, the message goes as always.
 */
export async function holdsInvitation(
  db: Database,
  email: string,
  token: string,
  mail: InvitationMail,
  now = new Date(),
) {
  if (!token || token.length > 200) return false;
  const [row] = await db
    .select({ id: organizationInvitations.id })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.orgId))
    .where(
      and(
        eq(organizationInvitations.tokenHash, sha256(token)),
        eq(organizationInvitations.email, email.trim().toLowerCase()),
        isNull(organizationInvitations.acceptedAt),
        gt(organizationInvitations.expiresAt, now),
        openOrg,
      ),
    );
  return row !== undefined && cameByEmail(row.id, mail);
}

/**
 * A request's page key once it signs in no one (ADR 0090): kept so the page that holds the key still finds its request
 * and reads `closed`. Marked, not only hashed again: no key's hash can equal it, so even someone who saw the live hash
 * can't hand it in as a key.
 */
export const spentClaimHash = (claimHash: string) => `spent:${sha256(claimHash)}`;

/**
 * Adds a person to an organization (keeping an existing role), with `roleIds` (those still there), and to
 * `general`, in the caller's transaction. A request to join that they or their address had waiting closes: whoever
 * answers it next finds it answered. A full workspace refuses a new member (`org.members_full`), and a closed one
 * (`closedRefusal`) anyone, under the lock role changes, removals and a deletion take, so two people taking the last
 * seat at once can't both get in, and nobody gets in once a deletion committed.
 */
export async function joinOrganization(
  tx: Executor,
  orgId: string,
  userId: string,
  role: MemberRole,
  roleIds: readonly string[] = [],
) {
  await lockOrgMembers(tx, orgId);
  // The row as it is now: a check before the lock may have read a cached standing.
  const [org] = await tx.select(STANDING_COLUMNS).from(organizations).where(eq(organizations.id, orgId));
  const closed = closedRefusal(org);
  if (closed) throw closed;
  const [member] = await tx
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  if (!member) await assertMemberRoom(tx, orgId);
  await tx.insert(organizationMembers).values({ orgId, userId, role }).onConflictDoNothing();
  await addMemberRolesInTx(tx, orgId, userId, roleIds);
  // Nothing a closed request kept stays (ADR 0090): the password it chose goes, and the page's key is spent, so that
  // page reads it closed and signs in no one.
  const closing = await tx
    .select({ id: organizationJoinRequests.id, claimHash: organizationJoinRequests.claimHash })
    .from(organizationJoinRequests)
    .where(
      and(
        eq(organizationJoinRequests.orgId, orgId),
        eq(organizationJoinRequests.status, "pending"),
        or(
          eq(organizationJoinRequests.userId, userId),
          eq(organizationJoinRequests.email, sql`(select ${users.email} from ${users} where ${users.id} = ${userId})`),
        ),
      ),
    );
  for (const request of closing) {
    await tx
      .update(organizationJoinRequests)
      .set({
        status: "closed",
        decidedAt: new Date(),
        passwordHash: null,
        claimHash: request.claimHash === null ? null : spentClaimHash(request.claimHash),
      })
      .where(eq(organizationJoinRequests.id, request.id));
  }
  await assignHandle(tx, orgId, userId);
  const [general] = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.name, "general")));
  if (general) {
    await tx.insert(channelMembers).values({ orgId, channelId: general.id, userId }).onConflictDoNothing();
  }
  await restoreDms(tx, orgId, userId);
}

/** Marks a person as seen now in an organization (WebSocket connect/disconnect). */
/** Not while the person is hidden: a "last seen" that keeps moving would give them away. */
export async function touchLastSeen(db: Database, orgId: string, userId: string, at = new Date()) {
  await db
    .update(organizationMembers)
    .set({ lastSeenAt: at })
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
        ne(organizationMembers.availability, "hidden"),
      ),
    );
}

export type InviteOutcome =
  | { email: string; status: "invited"; invitationId: string; token: string }
  | { email: string; status: "already_member" | "invalid_email" | "already_invited"; invitationId?: string };

/**
 * An address as it can be invited: nothing mail apps wrap one in (`Ana <ana@x.com>`, quotes, `mailto:`), since
 * accepting compares the signed-in address exactly and such an invitation could never be accepted.
 */
const EMAIL = /^[^\s@,;:<>()[\]"]+@[^\s@,;:<>()[\]"]+\.[^\s@,;:<>()[\]"]+$/;

/**
 * Invites several people at once: `invites`, each address with its own roles (the invite dialog, ADR 0090), or
 * `emails` all with `roleIds`, never both. `channelIds` and `note` go with every one. Each address gets its own
 * outcome; pending invitations are not duplicated (resend them instead).
 */
export async function inviteMany(
  db: Database,
  actorId: string,
  orgId: string,
  input: {
    emails?: string[];
    invites?: { email: string; roleIds?: string[] }[];
    roleIds?: string[];
    channelIds?: string[];
    note?: string | null;
    /** `AGENTES_SECRET`: links that can be copied again (ADR 0090). */
    secret?: string;
  },
  now = new Date(),
): Promise<InviteOutcome[]> {
  const actor = await requirePermission(db, actorId, orgId, "invite_people");
  assertInviting(actor);
  if (input.emails && input.invites) throw new ValidationError("Send `emails` or `invites`, not both");
  const asked = input.invites ?? (input.emails ?? []).map((email) => ({ email, roleIds: input.roleIds }));
  // Checked once for the batch: a role or a channel the sender may not give refuses it all.
  await givableRoleIds(db, actor, orgId, [...new Set(asked.flatMap((i) => i.roleIds ?? []))]);
  const channelIds = await invitableChannelIds(db, actorId, orgId, input.channelIds ?? []);
  const rolesOf = new Map<string, string[]>();
  for (const i of asked) {
    const email = i.email.trim().toLowerCase();
    if (email && !rolesOf.has(email)) rolesOf.set(email, i.roleIds ?? []);
  }
  const emails = [...rolesOf.keys()].slice(0, 100);
  const out: InviteOutcome[] = [];
  for (const email of emails) {
    if (!EMAIL.test(email)) {
      out.push({ email, status: "invalid_email" });
      continue;
    }
    const [pending] = await db
      .select({ id: organizationInvitations.id })
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.orgId, orgId),
          eq(organizationInvitations.email, email),
          isNull(organizationInvitations.acceptedAt),
          gt(organizationInvitations.expiresAt, now),
        ),
      );
    if (pending) {
      out.push({ email, status: "already_invited", invitationId: pending.id });
      continue;
    }
    try {
      const roleIds = [...new Set(rolesOf.get(email) ?? [])];
      const { invitation, token } = await inviteChecked(
        db,
        actor,
        actorId,
        orgId,
        {
          email,
          roleIds,
          channelIds,
          ...(input.note !== undefined ? { note: input.note } : {}),
          secret: input.secret,
        },
        now,
      );
      out.push({ email, status: "invited", invitationId: invitation.id, token });
    } catch (error) {
      // A full workspace (`org.members_full`) refuses the batch, not one address.
      if (error instanceof ConflictError && error.code === "conflict") out.push({ email, status: "already_member" });
      else throw error;
    }
  }
  return out;
}

/**
 * Sends an invitation again with a fresh 7-day expiry. With `secret` its link stays the same (ADR 0090); without,
 * a new token replaces it and the old link stops working.
 */
export async function resendInvitation(
  db: Database,
  actorId: string,
  orgId: string,
  invitationId: string,
  now = new Date(),
  secret?: string,
) {
  const actor = await requirePermission(db, actorId, orgId, "invite_people");
  assertInviting(actor);
  const [existing] = await db
    .select()
    .from(organizationInvitations)
    .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.orgId, orgId)));
  if (!existing || existing.acceptedAt) throw new ConflictError("This invitation can't be resent");
  await assertMemberRoom(db, orgId);
  // Its roles go again, expired or not: the ones still there, when the sender may give them (ADR 0085).
  const roleIds = await givableRoleIds(db, actor, orgId, await rolesStillThere(db, orgId, existing.roleIds));
  return sendInvitation(db, {
    orgId,
    email: existing.email,
    role: existing.role,
    roleIds,
    invitedBy: actorId,
    ownersOk: can(actor, "manage_owners"),
    secret,
    now,
    invitationId,
    resent: true,
  });
}

/**
 * Invitations not yet accepted, expired ones included, with their status, oldest first. With `secret`, `token`
 * when the link can be copied again (derived from the invitation's id, ADR 0090), null for one made before.
 */
export async function listInvitationsWithStatus(
  db: Database,
  actorId: string,
  orgId: string,
  now = new Date(),
  secret?: string,
) {
  await requirePermission(db, actorId, orgId, "invite_people");
  const rows = await db
    .select({ invitation: organizationInvitations, invitedBy: users.name })
    .from(organizationInvitations)
    .leftJoin(users, eq(users.id, organizationInvitations.invitedByUserId))
    .where(and(eq(organizationInvitations.orgId, orgId), isNull(organizationInvitations.acceptedAt)))
    .orderBy(asc(organizationInvitations.createdAt));
  return rows.map(({ invitation: i, invitedBy }) => {
    const derived = secret ? invitationToken(secret, i.id) : null;
    return {
      id: i.id,
      email: i.email,
      role: i.role,
      roleIds: i.roleIds,
      channelIds: i.channelIds,
      status: i.expiresAt > now ? ("pending" as const) : ("expired" as const),
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      invitedByUserId: i.invitedByUserId,
      invitedBy: invitedBy ?? null,
      token: derived && sha256(derived) === i.tokenHash ? derived : null,
    };
  });
}

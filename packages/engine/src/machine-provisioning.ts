import { randomBytes } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { type AiStatusDeps, orgHasAi } from "./ai-status";
import { caches } from "./cache";
import { decodeCursor, encodeCursor } from "./cursor";
import { type EmailLocale, emailCrew, emailLocale, emailsByLocale, modeStamp, queueEmail } from "./email";
import { ConflictError } from "./errors";
import { publishOrgEvent } from "./events";
import { DEVICE_CODE_TTL_MS, generateUserCode } from "./machine-device";
import { machineActivity } from "./machine-wake";
import { cleanMachineName, inStandby, type MachineRow, machineOnline, removeMachine, sha256Hex } from "./machines";
import { notifyComputerReady } from "./notification-producers";
import { OrgCursor, orgCreatedAtMs } from "./operator";
import { requirePermission, USER_LOCALES } from "./organizations";
import { openOrg, orgStanding, STANDING_COLUMNS, workRefusal } from "./standing";
import { isPersonalWorkspace } from "./workspace-mode";

const {
  organizations,
  organizationMembers,
  users,
  machines,
  machineProvisioning,
  machineDeviceCodes,
  agents,
  messages,
  channels,
} = schema;

/**
 * The workspace's own computer, from a provisioner the operator runs (ADR 0056 §10), with
 * `MACHINE_PROVISIONING=external`. Pulled, never pushed: every active workspace without a ready computer is
 * a request the provisioner lists; it says how far it is (`setProvisioning`) and asks for a single-use code
 * (`issueManagedMachine`) that the computer redeems through the device-code flow (`pollDeviceToken`), so the
 * computer's own token never passes through the provisioner. That computer's first hello makes it ready
 * and gives it the workspace's agents that have no computer.
 */

export const PROVISIONING_STATES = ["preparing", "waiting", "problem", "ready"] as const;
export type ProvisioningState = (typeof PROVISIONING_STATES)[number];
export const PROVISIONING_STEPS = ["reserving", "starting", "installing", "connecting"] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];
export const PROVISIONING_REASONS = ["capacity"] as const;
export type ProvisioningReason = (typeof PROVISIONING_REASONS)[number];
export type MachineSpecs = { cpus: number; memoryGb: number; diskGb: number };
export type ProvisioningMode = "off" | "external";

/** A wait longer than this gets the ready email: a spare claimed in seconds doesn't. */
export const READY_EMAIL_AFTER_MS = 60_000;

type ProvisioningRow = typeof machineProvisioning.$inferSelect;

export interface ProvisioningDeps {
  db: Database;
  pubsub?: PubSub;
  /** The server sends email (`EmailSender.delivers`): the apps tell the owners the ready email will come. */
  emails?: boolean;
}

/** Only the computer's first hello says `ready`, and only removing that computer undoes it. */
const notReady = sql`${machineProvisioning.state} <> 'ready'`;

/** There is no approval step: an older provisioner's `approval` (and a row it wrote) reads as `capacity`. */
const currentReason = (reason: string | null | undefined): ProvisioningReason | null =>
  reason == null ? null : reason === "approval" ? "capacity" : (reason as ProvisioningReason);

/** How far a workspace's computer is; nothing reported yet reads as `preparing`. */
export function provisioningStatus(row: ProvisioningRow | null, orgCreatedAt: Date) {
  return {
    state: (row?.state ?? "preparing") as ProvisioningState,
    step: (row?.step ?? null) as ProvisioningStep | null,
    /** With `preparing`: what the computer is doing within its step, as the provisioner said it. */
    stage: row?.stage ?? null,
    reason: currentReason(row?.reason),
    /** When this state (and step or reason) began; null before anything was reported. */
    since: row?.since.toISOString() ?? null,
    /** When people started waiting: the computer's last removal, else the workspace's creation. */
    requestedAt: (row?.requestedAt ?? orgCreatedAt).toISOString(),
    /** With `preparing`: the earliest ready time this wait was told; a time already past means it runs over. */
    expectedReadyAt: row?.expectedReadyAt?.toISOString() ?? null,
    specs: row?.specs ?? null,
  };
}

/** No computer on its way to tell of: where people connect their own (`pair`), or a workspace that isn't open. */
const NO_WAIT = {
  state: null,
  step: null,
  stage: null,
  reason: null,
  since: null,
  requestedAt: null,
  expectedReadyAt: null,
  specs: null,
  secondsLeft: null,
  secondsWaited: null,
} as const;

/** What `setupStatus` reads of the workspace, and the size its managed computer's runner reported. */
type SetupOrg = { createdAt: Date; open: boolean; size?: schema.MachineSizeRecord | null };

/** The workspace's managed computer, still in it. */
const managedComputer = and(
  eq(machines.orgId, organizations.id),
  eq(machines.kind, "managed"),
  isNull(machines.deletedAt),
);

/**
 * A ready computer's size as its runner reports it (protocol 22), within a container's limit, else what the
 * provisioner said: once ready the provisioner can't report a resize (`setProvisioning` is refused). Memory is a
 * whole number, as the provisioner gives it, because the apps print the number as it comes.
 */
function setupSpecs(row: ProvisioningRow | null, size: schema.MachineSizeRecord | null | undefined) {
  if (row?.state !== "ready" || !size) return row?.specs ?? null;
  const usable = size.limit ?? size;
  return { cpus: usable.cpus, memoryGb: Math.round(usable.memoryGb), diskGb: size.diskGb };
}

/**
 * What the apps show (`GET …/computer-setup`, `machine.provisioning`): the status, the seconds left and the
 * seconds since `requestedAt`, both counted here (a wrong clock on someone's device doesn't matter), and
 * whether the owners get the ready email. A workspace on hold, suspended or being deleted waits for no computer
 * (`setOrgStanding`): no state at all, unless its computer is ready.
 */
function setupStatus(row: ProvisioningRow | null, org: SetupOrg, emails: boolean, now = Date.now()) {
  if (!org.open && row?.state !== "ready") return { ...NO_WAIT, notifyByEmail: emails };
  const readyAt = row?.expectedReadyAt ?? null;
  return {
    ...provisioningStatus(row, org.createdAt),
    specs: setupSpecs(row, org.size),
    secondsLeft: readyAt ? Math.round((readyAt.getTime() - now) / 1000) : null,
    secondsWaited: Math.round((now - (row?.requestedAt ?? org.createdAt).getTime()) / 1000),
    notifyByEmail: emails,
  };
}

/** `machine.provisioning` to the workspace's members: what `GET …/computer-setup` would say now. */
async function publishProvisioning(
  deps: ProvisioningDeps,
  orgId: string,
  row: ProvisioningRow | null,
  machineId: string | null,
) {
  const [org] = await deps.db
    .select({ createdAt: organizations.createdAt, open: openOrg, size: machines.size })
    .from(organizations)
    .leftJoin(machines, managedComputer)
    .where(eq(organizations.id, orgId));
  if (!org) return;
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.provisioning", ...setupStatus(row, org, deps.emails === true), machineId },
  });
}

/**
 * Workspaces waiting for their computer, oldest first, in keyset pages: active ones (one on hold, suspended or
 * being deleted is never listed) whose computer isn't ready. Empty unless provisioning is external.
 */
export async function listMachineRequests(
  db: Database,
  mode: ProvisioningMode,
  query: { limit: number; cursor?: string },
) {
  if (mode !== "external") return { requests: [], next: null };
  const after = query.cursor ? decodeCursor(query.cursor, OrgCursor) : null;
  const rows = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      createdAt: orgCreatedAtMs,
      provisioning: machineProvisioning,
    })
    .from(organizations)
    .leftJoin(machineProvisioning, eq(machineProvisioning.orgId, organizations.id))
    .where(
      and(
        openOrg,
        sql`${machineProvisioning.state} is distinct from 'ready'`,
        after
          ? sql`(${orgCreatedAtMs}, ${organizations.id}) > (${after[0]}::timestamptz, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(orgCreatedAtMs), asc(organizations.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const owners = page.length
    ? await db
        .select({ orgId: organizationMembers.orgId, userId: users.id, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            inArray(
              organizationMembers.orgId,
              page.map((r) => r.orgId),
            ),
            eq(organizationMembers.role, "owner"),
          ),
        )
        .orderBy(asc(organizationMembers.createdAt))
    : [];
  const last = page.at(-1);
  return {
    requests: page.map((r) => {
      const owner = owners.find((o) => o.orgId === r.orgId);
      return {
        orgId: r.orgId,
        orgName: r.orgName,
        createdAt: r.createdAt,
        /** Its first owner. */
        owner: owner ? { userId: owner.userId, email: owner.email } : null,
        /** What the provisioner last said; null before anything. */
        provisioning: r.provisioning ? provisioningStatus(r.provisioning, r.createdAt) : null,
      };
    }),
    next: rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.orgId]) : null,
  };
}

export interface ProvisioningInput {
  state: Exclude<ProvisioningState, "ready">;
  /** Kept with `preparing` only. */
  step?: ProvisioningStep | null;
  /**
   * Kept with `preparing` only: what the computer is doing within its step (`updating`, `apps`…). Any word is kept:
   * the apps read one they don't know as its step.
   */
  stage?: string | null;
  /** Kept with `waiting` only; `approval` reads as `capacity`. */
  reason?: ProvisioningReason | "approval" | null;
  /** Kept with `preparing` only: when it should be ready, unless the wait was told an earlier time; none keeps it. */
  expectedReadyAt?: Date | null;
  /** An older provisioner's countdown, read as that many seconds from now. */
  etaSeconds?: number | null;
  /** Kept from before when not given. */
  specs?: MachineSpecs | null;
}

/**
 * The provisioner says how far the workspace's computer is; its members see it live (`machine.provisioning`)
 * when something they see changed. `ready` is not the provisioner's to say: it comes with the computer's
 * first hello, and stays until that computer is removed (`ConflictError` meanwhile). One wait (`preparing` until
 * ready or another state) counts down to the earliest ready time it was told: a part running long moves the
 * provisioner's time later with the clock, so a later time is kept out and people see the wait run over, never a
 * countdown that goes back up. A wait said to take over a minute (a ready time that far ahead, `waiting` or
 * `problem`) promises the owners the ready email, until it is ready. Only an active workspace that isn't being
 * deleted waits for one (`workRefusal` otherwise): a report sent as it was held would say again that a computer is
 * on its way. False: no such workspace.
 */
export async function setProvisioning(
  deps: ProvisioningDeps,
  orgId: string,
  input: ProvisioningInput,
): Promise<boolean> {
  const { db } = deps;
  const now = new Date();
  const step = input.state === "preparing" ? (input.step ?? null) : null;
  const stage = input.state === "preparing" ? (input.stage ?? null) : null;
  const reason = input.state === "waiting" ? currentReason(input.reason) : null;
  const done = await db.transaction(async (tx) => {
    // The standing as it is now, not the 5 s cache, under a lock its change waits for (`setOrgStanding` drops the
    // wait in the same transaction): a hold set first refuses this report, one set meanwhile drops it.
    const [org] = await tx.select(STANDING_COLUMNS).from(organizations).where(eq(organizations.id, orgId)).for("share");
    if (!org) return null;
    const refusal = workRefusal(org);
    if (refusal) throw refusal;
    const [before] = await tx.select().from(machineProvisioning).where(eq(machineProvisioning.orgId, orgId));
    const same = before?.state === input.state && before.step === step && currentReason(before.reason) === reason;
    const reported =
      input.state !== "preparing"
        ? null
        : (input.expectedReadyAt ??
          (input.etaSeconds == null ? null : new Date(now.getTime() + input.etaSeconds * 1000)));
    // A report without a time is still the same wait: it keeps the earliest time the wait was told.
    const kept = input.state === "preparing" && before?.state === "preparing" ? before.expectedReadyAt : null;
    const expectedReadyAt = !reported || (kept && kept.getTime() < reported.getTime()) ? kept : reported;
    const long =
      input.state !== "preparing" ||
      (expectedReadyAt !== null && expectedReadyAt.getTime() - now.getTime() > READY_EMAIL_AFTER_MS);
    const next = {
      state: input.state,
      step,
      stage,
      reason,
      expectedReadyAt,
      emailWhenReady: long || before?.emailWhenReady === true,
      specs: input.specs ?? before?.specs ?? null,
      since: same && before ? before.since : now,
      updatedAt: now,
    };
    const [row] = await tx
      .insert(machineProvisioning)
      .values({ orgId, ...next })
      .onConflictDoUpdate({ target: machineProvisioning.orgId, set: next, setWhere: notReady })
      .returning();
    return { before, row, same };
  });
  if (!done) return false;
  const { before, row, same } = done;
  if (!row) {
    throw new ConflictError(
      "This workspace's computer is ready: remove it first (DELETE …/machines/{machineId}) to prepare another one",
      "provisioning.ready",
    );
  }
  const moved = before?.expectedReadyAt?.getTime() !== row.expectedReadyAt?.getTime();
  // A new stage is told without restarting `since`: the step is still the same one.
  if (!same || before?.stage !== row.stage || moved || !Bun.deepEquals(before?.specs ?? null, row.specs)) {
    const [managed] = await db
      .select({ id: machines.id })
      .from(machines)
      .where(and(eq(machines.orgId, orgId), eq(machines.kind, "managed"), isNull(machines.deletedAt)));
    await publishProvisioning(deps, orgId, row, managed?.id ?? null);
  }
  return true;
}

/**
 * The workspace's computer's name until someone renames it, in its first owner's language: what the apps call
 * it (mirrors `computerSetup.title` in packages/i18n). A name like any computer's, so every message that names
 * it says a computer, never the bare workspace. A personal workspace's (ADR 0159) is its person's agents' computer
 * (`computerSetup.titlePersonal`), which names no workspace, so a rename never touches it.
 */
export const managedMachineName = (orgName: string, locale: EmailLocale, personal = false) =>
  cleanMachineName(
    personal
      ? serverText(locale, "computerSetup.titlePersonal")
      : serverText(locale, "computerSetup.title", { org: orgName }),
  );

/** The workspace was renamed: its computer, still under the name it got for the old one, takes the new one. */
export async function followWorkspaceName(db: Executor, orgId: string, from: string, to: string) {
  for (const locale of USER_LOCALES) {
    const [old, next] = [managedMachineName(from, locale), managedMachineName(to, locale)];
    if (old === next) continue;
    await db
      .update(machines)
      .set({ name: next, updatedAt: new Date() })
      .where(
        and(
          eq(machines.orgId, orgId),
          eq(machines.kind, "managed"),
          eq(machines.name, old),
          isNull(machines.deletedAt),
        ),
      );
  }
}

/** Codes issued for this computer and not redeemed yet stop working (a poll with one gets `access_denied`). */
async function supersedeCodes(tx: Executor, machineId: string, now: Date) {
  await tx
    .update(machineDeviceCodes)
    .set({ status: "denied", decidedAt: now })
    .where(and(eq(machineDeviceCodes.machineId, machineId), eq(machineDeviceCodes.status, "confirmed")));
}

/**
 * The workspace's computer and a code for it to connect with: the managed machine row (one per workspace,
 * made the first time, the same row every time after, brought back when it was removed) and a confirmed
 * device code for it, single use, `DEVICE_CODE_TTL_MS`. The computer redeems it like any other
 * (`POST /api/machines/device/token`); an earlier code still unused stops working. Only for an active
 * workspace that isn't being deleted (`workRefusal` otherwise). Null: no such workspace.
 */
export async function issueManagedMachine(
  deps: { db: Database; now?: () => Date },
  orgId: string,
  input: { name?: string | null } = {},
) {
  const { db } = deps;
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, standing: STANDING_COLUMNS })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) return null;
  const refusal = workRefusal(org.standing);
  if (refusal) throw refusal;
  const [owner] = await db
    .select({ locale: users.locale })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")))
    .orderBy(asc(organizationMembers.createdAt))
    .limit(1);
  const personal = await isPersonalWorkspace(db, orgId);
  const now = deps.now?.() ?? new Date();
  const enrollCode = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
  const name = cleanMachineName(input.name);
  const machineId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(machines)
      .values({
        orgId,
        kind: "managed",
        name: name || managedMachineName(org.name, emailLocale(owner?.locale), personal),
        audienceMode: "everyone",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: machines.orgId,
        targetWhere: sql`${machines.kind} = 'managed'`,
        set: { deletedAt: null, previousAgentIds: [], ...(name ? { name } : {}), updatedAt: now },
      })
      .returning({ id: machines.id, name: machines.name });
    if (!row) throw new Error("managed machine upsert returned nothing");
    await supersedeCodes(tx, row.id, now);
    await tx.insert(machineDeviceCodes).values({
      orgId,
      deviceCodeHash: sha256Hex(enrollCode),
      userCode: generateUserCode(),
      status: "confirmed",
      name: row.name,
      machineId: row.id,
      // An expired code never takes the row with it (`pollDeviceToken` keeps a machine coming back as itself).
      previousMachineId: row.id,
      decidedAt: now,
      expiresAt,
      createdAt: now,
    });
    return row.id;
  });
  return { machineId, enrollCode, expiresAt };
}

/**
 * The workspace's computers as the provisioner sees them: every machine still in it, with no secret and
 * nothing of what is on them; its own one with whether it sleeps, is in use and when it last was (ADR 0161).
 * Null: no such workspace.
 */
export async function operatorMachines(db: Database, orgId: string) {
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId));
  if (!org) return null;
  const rows = await db
    .select()
    .from(machines)
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
    .orderBy(asc(machines.createdAt));
  const managed = rows.find((m) => m.kind === "managed");
  const activity = managed ? await machineActivity(db, managed) : null;
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    managed: m.kind === "managed",
    name: m.name,
    online: machineOnline(m),
    lastSeenAt: m.lastSeenAt,
    runnerVersion: m.runnerVersion,
    protocol: m.protocol,
    standby: inStandby(m),
    ...(m === managed && activity ? activity : { busy: false, lastUsedAt: null }),
  }));
}

/**
 * Takes the workspace's computer away (the provisioner wipes or retires it): its token and unused codes stop
 * working, its socket closes, its agents are left with no computer, and an active workspace is back to waiting
 * for one from now (a request again); one held, suspended or being deleted waits for none until it is open again.
 * False: the workspace has no such managed computer.
 */
export async function revokeManagedMachine(deps: ProvisioningDeps, orgId: string, machineId: string) {
  const [machine] = await deps.db
    .select()
    .from(machines)
    .where(
      and(
        eq(machines.orgId, orgId),
        eq(machines.id, machineId),
        eq(machines.kind, "managed"),
        isNull(machines.deletedAt),
      ),
    );
  if (!machine) return false;
  const now = new Date();
  const waiting = {
    state: "preparing",
    step: null,
    stage: null,
    reason: null,
    expectedReadyAt: null,
    requestedAt: now,
    emailWhenReady: false,
    specs: null,
    since: now,
    updatedAt: now,
  };
  await removeMachine(deps, machine, { type: "system", id: null }, async (tx) => {
    await supersedeCodes(tx, machine.id, now);
    // Locked as a report locks it (`setProvisioning`): a hold set meanwhile drops the wait this starts.
    const [org] = await tx
      .select({ open: openOrg })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("share");
    if (!org?.open) {
      await tx.delete(machineProvisioning).where(eq(machineProvisioning.orgId, orgId));
      return;
    }
    await tx
      .insert(machineProvisioning)
      .values({ orgId, ...waiting })
      .onConflictDoUpdate({ target: machineProvisioning.orgId, set: waiting });
  });
  const [row] = await deps.db.select().from(machineProvisioning).where(eq(machineProvisioning.orgId, orgId));
  await publishProvisioning(deps, orgId, row ?? null, null);
  return true;
}

/** What the ready email needs besides the database (the server sends email). */
export interface ReadyEmailDeps {
  publicUrl: string;
  /** What `orgHasAi` reads: the email's first step is connecting an AI while no agent has one. */
  gateway: AiStatusDeps["gateway"];
  machines: AiStatusDeps["machines"];
}

/**
 * What the ready email says, read before the transaction that queues it (`orgHasAi` asks the computers).
 * Null: nothing to send now, because the computer is ready already (a reconnect), the workspace isn't active or is
 * being deleted (its agents can't take a first task), or it has no owner.
 */
async function readyEmailDraft(db: Database, email: ReadyEmailDeps, orgId: string) {
  const [org] = await db
    .select({
      name: organizations.name,
      createdAt: organizations.createdAt,
      open: openOrg,
      state: machineProvisioning.state,
    })
    .from(organizations)
    .leftJoin(machineProvisioning, eq(machineProvisioning.orgId, organizations.id))
    .where(eq(organizations.id, orgId));
  if (!org || org.state === "ready" || !org.open) return null;
  const owners = await db
    .select({ email: users.email, locale: users.locale })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")));
  if (owners.length === 0) return null;
  const crew = await emailCrew(db, orgId);
  // Not known now: the step that connects an AI stays in, rather than the computer's ready going unsaid.
  const hasAi = await orgHasAi({ db, gateway: email.gateway, machines: email.machines }, orgId).catch(() => false);
  const kept = await keptConversation(db, orgId);
  return { org, owners, crew, needsAi: !hasAi, kept, publicUrl: email.publicUrl };
}

/** The app path of the newest message kept on a billing hold: signing in there, it is answered right there. */
async function keptConversation(db: Database, orgId: string) {
  const [card] = await db
    .select({ channelId: messages.channelId, agentId: messages.authorAgentId, kind: channels.kind })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(
      and(
        eq(messages.orgId, orgId),
        isNull(messages.deletedAt),
        sql`${messages.meta}->'noAi'->>'reason' = 'plan_hold'`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!card) return null;
  return card.kind === "dm" ? `/org/${orgId}/dm/agent/${card.agentId}` : `/org/${orgId}/c/${card.channelId}`;
}

/**
 * The ready email to the workspace's owners, each group in its language, once per ready (the notification's
 * group key), in the transaction that makes the computer ready: when they were told to expect it, or the
 * wait from `requested_at` (else the workspace's creation) took over a minute.
 */
async function queueReadyEmail(
  tx: Executor,
  draft: NonNullable<Awaited<ReturnType<typeof readyEmailDraft>>>,
  row: ProvisioningRow,
  machineId: string,
  readyAt: Date,
) {
  const waited = readyAt.getTime() - (row.requestedAt ?? draft.org.createdAt).getTime();
  if (!row.emailWhenReady && waited <= READY_EMAIL_AFTER_MS) return;
  const groups = emailsByLocale(
    draft.owners.map((o) => ({ email: o.email, locale: emailLocale(o.locale) })),
    `computer_ready:${machineId}:${readyAt.getTime()}`,
  );
  const mode = await modeStamp(tx, row.orgId);
  for (const group of groups) {
    await queueEmail(tx, {
      orgId: row.orgId,
      key: group.key,
      to: group.to,
      template: {
        kind: "computer_ready",
        locale: group.locale,
        orgName: draft.org.name,
        specs: row.specs ?? null,
        needsAi: draft.needsAi,
        hasAgents: draft.crew.length > 0,
        crew: draft.crew,
        url: `${draft.publicUrl.replace(/\/$/, "")}/org/${row.orgId}`,
        ...(draft.kept ? { keptUrl: `${draft.publicUrl.replace(/\/$/, "")}${draft.kept}` } : {}),
        ...mode,
      },
    });
  }
}

/**
 * A managed computer said hello (the hub calls this for every machine). The first time since it was issued
 * it becomes the workspace's ready computer: the agents with no computer get it (later reconnects leave
 * whatever people chose since), its members hear it, and its owners are told (and emailed after a long
 * wait, when the server sends email: `readyEmail`). Not while the workspace is being deleted, which asks for no
 * computer: one restored gets its computer back, which says hello again.
 */
export async function onManagedMachineHello(
  deps: { db: Database; pubsub?: PubSub; readyEmail?: ReadyEmailDeps | null },
  machine: Pick<MachineRow, "id" | "orgId" | "name" | "kind">,
) {
  if (machine.kind !== "managed") return;
  const { orgId } = machine;
  if ((await orgStanding(deps.db, orgId)).deletionDueAt) return;
  const draft = deps.readyEmail ? await readyEmailDraft(deps.db, deps.readyEmail, orgId) : null;
  const now = new Date();
  const ready = {
    state: "ready",
    step: null,
    stage: null,
    reason: null,
    expectedReadyAt: null,
    since: now,
    updatedAt: now,
  };
  const done = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(machineProvisioning)
      .values({ orgId, ...ready })
      .onConflictDoUpdate({ target: machineProvisioning.orgId, set: ready, setWhere: notReady })
      .returning();
    if (!row) return null;
    const given = await tx
      .update(agents)
      .set({ machineId: machine.id, updatedAt: now })
      .where(and(eq(agents.orgId, orgId), isNull(agents.machineId), isNull(agents.archivedAt), isNull(agents.builtin)))
      .returning({ id: agents.id });
    // The owners were told it would come: it goes out with the ready, or neither happens and the next hello
    // tries both again.
    if (draft) await queueReadyEmail(tx, draft, row, machine.id, now);
    return { row, agentIds: given.map((a) => a.id) };
  });
  if (!done) return;
  for (const agentId of done.agentIds) {
    caches.agents.delete(`${orgId}:${agentId}`);
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: {
        type: "agent.computer",
        agentId,
        target: { kind: "machine", machineId: machine.id, name: machine.name, online: true },
      },
    });
  }
  const { readyEmail, ...rest } = deps;
  await publishProvisioning({ ...rest, emails: Boolean(readyEmail) }, orgId, done.row, machine.id);
  await notifyComputerReady(deps, machine, now).catch(() => {});
}

/** Whether the workspace's computer is on its way (reported, not ready): agents say so instead of "no computer". */
export async function computerPreparing(
  { db, workspaceComputer }: { db: Database; workspaceComputer?: unknown },
  orgId: string,
) {
  // Nobody can connect one on such a server, and a paid workspace has no row until the provisioner's first report.
  if (workspaceComputer) return true;
  const [row] = await db
    .select({ state: machineProvisioning.state })
    .from(machineProvisioning)
    .where(eq(machineProvisioning.orgId, orgId));
  return Boolean(row && row.state !== "ready");
}

/**
 * `GET …/computer-setup` (every member): `pair` when people connect their own computers; `external`, how
 * far the workspace's computer is and, once issued, its machine id. `emails`: the server sends email.
 */
export async function computerSetup(
  db: Database,
  mode: ProvisioningMode,
  actorId: string,
  orgId: string,
  emails = false,
) {
  await requirePermission(db, actorId, orgId, "read");
  if (mode !== "external") return { mode: "pair" as const, ...NO_WAIT, notifyByEmail: false, machineId: null };
  const [row] = await db
    .select({
      provisioning: machineProvisioning,
      machineId: machines.id,
      size: machines.size,
      createdAt: organizations.createdAt,
      open: openOrg,
    })
    .from(organizations)
    .leftJoin(machineProvisioning, eq(machineProvisioning.orgId, organizations.id))
    .leftJoin(machines, managedComputer)
    .where(eq(organizations.id, orgId));
  return {
    mode: "external" as const,
    ...setupStatus(row?.provisioning ?? null, row ?? { createdAt: new Date(), open: true }, emails),
    machineId: row?.machineId ?? null,
  };
}

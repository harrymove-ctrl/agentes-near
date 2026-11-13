import { createHash, randomBytes } from "node:crypto";
import {
  BROWSER_PROFILE_PROTOCOL,
  DESKTOP_PROTOCOL,
  HEARTBEAT_MS,
  MACHINE_TOKEN_PREFIX,
  type MachineAgent,
  MIN_RUNNER_PROTOCOL,
  type PubSub,
  REMOTE_PAUSE_PROTOCOL,
} from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgent } from "./agents";
import { type AuditEntry, recordAudit } from "./audit";
import { isSandboxedBrain } from "./brains/types";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { can, requireActiveMembership, requirePermission } from "./organizations";
import { maySql } from "./permissions";
import { isRightHand, RIGHT_HAND, rightHandPermanent } from "./right-hand";

const { machines, agents, users, organizationMembers } = schema;

/**
 * Connected computers (ADR 0025): the machine token, the list, pause and
 * access as the runner reports them (ADR 0036), and which computer each
 * agent uses. Connecting one is `machine-device.ts`; the live socket is the
 * hub's (`machine-hub.ts`); this file only reads and writes rows.
 */
export type MachineRow = typeof machines.$inferSelect;

/** A machine whose last sign of life is older than this is offline, whatever its row says (a replica may have died). */
export const MACHINE_STALE_MS = 3 * HEARTBEAT_MS;

export const MACHINE_LIMITS = { nameChars: 80 };

/**
 * Server-side signals (never forwarded to clients), for whichever replica
 * holds the machine's socket: `machine.revoke` closes it; `machine.agents`
 * sends the org's machines their `agents` frame again.
 */
export const MACHINE_CONTROL_TOPIC = "machines:control";

export interface MachineDeps {
  db: Database;
  pubsub?: PubSub;
  /** Our public base URL (the verification link). */
  publicUrl: string;
  now?: () => Date;
}

export const REMOVED_COMPUTER_MESSAGE =
  "Your connected computer was removed. Ask an admin or your owner to choose another one.";

/**
 * The machine can't be reached now (runner not connected): nothing was sent. The workspace's own computer
 * (`managed`) has no runner for anyone to start: it comes back by itself. `kind` has no default, so no
 * caller tells a workspace to start a runner it doesn't have.
 */
export class MachineOfflineError extends Error {
  constructor(
    readonly machineName: string,
    kind: string | null | undefined,
  ) {
    super(
      kind === "managed"
        ? `The computer ${machineName} isn't answering right now. It usually comes back within minutes.`
        : `The computer ${machineName} is offline. Ask its owner to start the runner.`,
    );
    this.name = "MachineOfflineError";
  }
}

/**
 * The request was sent and the link to the machine (or the agent's process there) went away before its
 * answer: it may have stopped partway or finished, with effects. `serverStop`: our own server stopped (a
 * restart), not the computer or its network.
 */
export class MachineDroppedError extends MachineOfflineError {
  readonly serverStop: boolean;
  constructor(machineName: string, options: { serverStop?: boolean; message?: string } = {}) {
    super(machineName, null);
    this.name = "MachineDroppedError";
    this.serverStop = options.serverStop === true;
    this.message =
      options.message ??
      `The connection to the computer ${machineName} dropped while this ran: it may have stopped partway or finished, and may have had effects. Check before running it again.`;
  }
}

/**
 * The owner paused the machine (ADR 0036 §6): no new work starts there until
 * they resume (or `until` passes). The message is for the agent to relay.
 */
export class MachinePausedError extends Error {
  readonly code = "machine_paused";
  constructor(
    readonly machineName: string,
    /** ISO time, or null: until the owner resumes. */
    readonly until: string | null,
    timezone?: string | null,
  ) {
    super(pausedMessage(machineName, until, timezone));
    this.name = "MachinePausedError";
  }
}

/** "The owner paused the computer X until 16:24 (UTC)." in the owner's time zone when known. */
export function pausedMessage(name: string, until: string | null, timezone?: string | null, now = new Date()) {
  if (!until) return `The owner paused the computer ${name} until they resume it. Nothing new can start there now.`;
  const at = new Date(until);
  const zone = timezone || "UTC";
  let when: string;
  try {
    const sameDay = at.getTime() - now.getTime() < 20 * 3600_000;
    when = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(sameDay ? {} : { day: "numeric", month: "short" }),
    }).format(at);
  } catch {
    when = until.slice(11, 16);
  }
  return `The owner paused the computer ${name} until ${when}${zone === "UTC" ? " UTC" : ""}. Nothing new can start there before that.`;
}

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** `agm_` + 32 random bytes, base64url. */
export const generateMachineToken = () => `${MACHINE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/** Online and seen recently: a row left `online` by a replica that died goes stale. */
export function machineOnline(row: Pick<MachineRow, "online" | "lastSeenAt" | "deletedAt">, now = new Date()) {
  if (!row.online || row.deletedAt || !row.lastSeenAt) return false;
  return now.getTime() - row.lastSeenAt.getTime() <= MACHINE_STALE_MS;
}

/** The operator put the workspace's own computer in standby (ADR 0161): offline by design until something wants it. */
export const inStandby = (row: Pick<MachineRow, "kind" | "standbyAt">) =>
  row.kind === "managed" && row.standbyAt !== null;

/** The pause in force now (a past `until` is over); null when not paused. */
export function machinePause(
  row: Pick<MachineRow, "paused" | "pausedUntil">,
  now = new Date(),
): { until: string | null } | null {
  if (!row.paused) return null;
  if (row.pausedUntil && row.pausedUntil.getTime() <= now.getTime()) return null;
  return { until: row.pausedUntil?.toISOString() ?? null };
}

/** Who paused a computer from the apps, by id, among the org's members (a runner's word alone names no outsider). */
export async function pauserNames(db: Database, orgId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, wanted)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** A pause as the apps read it: until when, and who paused it from the apps (null: on the computer itself). */
export async function pauseForApps(
  db: Database,
  orgId: string,
  pause: { until: string | null; by?: string | null } | null,
): Promise<{ until: string | null; by: { id: string; name: string } | null } | null> {
  if (!pause) return null;
  const name = pause.by ? (await pauserNames(db, orgId, [pause.by])).get(pause.by) : undefined;
  return { until: pause.until, by: pause.by && name !== undefined ? { id: pause.by, name } : null };
}

/**
 * A runner's reported pause with `by` kept only for a member of the org: the runner's config can outlive the person
 * (`machines.paused_by_user_id` references `users`), and its word alone names no outsider.
 */
export async function memberPause<P extends { until: string | null; by?: string | null }>(
  db: Database,
  orgId: string,
  pause: P | null,
): Promise<P | null> {
  if (!pause?.by) return pause;
  return (await pauserNames(db, orgId, [pause.by])).has(pause.by) ? pause : { ...pause, by: null };
}

/** The time zone the machine's owner reads times in (their own, else UTC). */
export async function machineOwnerTimezone(db: Database, row: Pick<MachineRow, "orgId" | "pairedByUserId">) {
  if (!row.pairedByUserId) return null;
  const [m] = await db
    .select({ timezone: organizationMembers.timezone })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, row.orgId), eq(organizationMembers.userId, row.pairedByUserId)));
  return m?.timezone ?? null;
}

/** Throws `MachinePausedError` when the owner paused this machine. */
export async function assertNotPaused(db: Database, row: MachineRow, now = new Date()) {
  const pause = machinePause(row, now);
  if (!pause) return;
  throw new MachinePausedError(row.name, pause.until, await machineOwnerTimezone(db, row).catch(() => null));
}

export const cleanMachineName = (name: string | undefined | null) =>
  (name ?? "")
    .replace(/[\p{Cc}]/gu, " ")
    .trim()
    .slice(0, MACHINE_LIMITS.nameChars);

/** `machine.status { machineId, online }` to every member of the org. */
export async function publishMachineStatus(
  pubsub: PubSub | undefined,
  orgId: string,
  machineId: string,
  online: boolean,
) {
  await publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "machine.status", machineId, online } });
}

/** The machine a token belongs to; null for unknown, revoked (deleted) or outdated runners. */
export async function authenticateMachine(db: Database, token: string): Promise<MachineRow | null> {
  if (!token.startsWith(MACHINE_TOKEN_PREFIX) || token.length > 200) return null;
  const [row] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.tokenHash, sha256Hex(token)), isNull(machines.deletedAt)));
  if (!row || row.protocol < MIN_RUNNER_PROTOCOL) return null;
  return row;
}

export async function getMachine(db: Database, orgId: string, machineId: string): Promise<MachineRow | null> {
  const [row] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.id, machineId), isNull(machines.deletedAt)));
  return row ?? null;
}

/** By id only (the hub and the provider: the id comes from our own rows). */
export async function getMachineById(db: Database, machineId: string): Promise<MachineRow | null> {
  const [row] = await db.select().from(machines).where(eq(machines.id, machineId));
  return row ?? null;
}

/** Whether a computer serves the agents' desktops (ADR 0058 §9): protocol 18, its switch on, and able to. */
export const servesDesktops = (m: {
  protocol: number;
  access?: { tools: { desktop?: boolean } } | null;
  executors?: MachineRow["executors"] | null;
}) => m.protocol >= DESKTOP_PROTOCOL && m.access?.tools.desktop === true && m.executors?.desktop?.available === true;

/** The account whose folder system mode lends to the agent's OS user (ADR 0059 §8): the one it thinks with. */
const lentAccount = (a: { brain: string; account: string | null }) => (a.brain !== "model" ? a.account : null);

/**
 * Whether a person may run commands as the OS user an agent's desktop and terminal run as (ADR 0058 §4): what
 * controlling the desktop or opening the terminal gives. In system mode each agent is its own user: the org's
 * admins (`control_computers`) and the agent's owner (with `own_computers`); while that user holds the owner's
 * sign-in (`signIn`, ADR 0059 §8), only those admins who also manage agents (`manages`), who could read that sign-in
 * there. Otherwise every agent is the runner's own user, which holds every agent's folder, the computer's sign-ins
 * and its token: only the person who paired the computer (with `own_computers`), and nobody on one nobody paired.
 */
export function drivesComputer(
  machine: Pick<MachineRow, "pairedByUserId" | "executors">,
  person: DrivingPerson,
  signIn = false,
) {
  return driveRefusal(machine, person, signIn) === null;
}

/**
 * Why a person may not drive the computer (`drivesComputer`), null when they may: `pairer` (not the person who
 * paired a computer outside system mode), `owner_plan` (an admin who doesn't manage agents while the agent's user
 * holds its owner's sign-in), `role` (their roles give them the agents' browsers but not the whole computer here),
 * `not_allowed` (neither an admin nor the agent's owner).
 */
export type DriveRefusal = "pairer" | "owner_plan" | "role" | "not_allowed";
export interface DrivingPerson {
  userId: string;
  /** `control_computers`. */
  admin: boolean;
  /** `own_computers`: the whole computer of an agent they own, or of one they paired. */
  own: boolean;
  owner: boolean;
  /** `manage_agents`: drives it on its owner's plan too. */
  manages?: boolean;
  /** `control_browsers`: told `role` rather than `not_allowed`. */
  browsers?: boolean;
}
export function driveRefusal(
  machine: Pick<MachineRow, "pairedByUserId" | "executors">,
  person: DrivingPerson,
  signIn = false,
): DriveRefusal | null {
  if (machine.executors?.mode !== "system") {
    if (machine.pairedByUserId !== person.userId) return "pairer";
    return person.own ? null : "role";
  }
  if (person.owner && person.own) return null;
  if (!person.admin) return person.owner || person.browsers ? "role" : "not_allowed";
  return signIn && !person.manages ? "owner_plan" : null;
}

/**
 * The computers a person connected in these workspaces that leave with them: every one, a system-mode server too (it
 * runs on hardware they control), unless an admin marked it the workspace's (`belongs_to_workspace`).
 */
export async function personalMachines(db: Executor, userId: string, orgIds: string[]) {
  if (orgIds.length === 0) return [];
  return db
    .select({ id: machines.id, orgId: machines.orgId, name: machines.name, kind: machines.kind })
    .from(machines)
    .where(
      and(
        inArray(machines.orgId, orgIds),
        eq(machines.pairedByUserId, userId),
        eq(machines.kind, "connected"),
        eq(machines.belongsToWorkspace, false),
        isNull(machines.deletedAt),
      ),
    )
    .orderBy(machines.createdAt);
}

/** The computer of an agent that the person may drive (`drivesComputer`); refused otherwise. */
export async function requireComputerDriver(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<MachineRow> {
  const { machine, refusal } = await computerDriving(db, userId, orgId, agentId);
  if (refusal) {
    throw new ForbiddenError(
      refusal === "pairer"
        ? "Only the person who connected this computer can use it as the agent"
        : refusal === "owner_plan"
          ? "Only the agent's owner and admins who manage agents can use its computer as the agent while it thinks with the owner's plan"
          : refusal === "role"
            ? "Your roles give you the agents' browsers, not their whole computer"
            : "Only admins and the agent's owner can use its computer as the agent",
    );
  }
  return machine;
}

/** The agent's computer and why this person may not drive it (`driveRefusal`), null when they may. */
export async function computerDriving(db: Database, userId: string, orgId: string, agentId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  const [agent] = await db
    .select({
      machineId: agents.machineId,
      owner: agents.ownerUserId,
      brain: agents.brain,
      account: agents.brainAccountId,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  const machine = agent.machineId ? await getMachine(db, orgId, agent.machineId) : null;
  if (!machine) throw new NotFoundError("This agent has no computer");
  const person = {
    userId,
    admin: can(membership, "control_computers"),
    own: can(membership, "own_computers"),
    owner: agent.owner === userId,
    manages: can(membership, "manage_agents"),
    browsers: can(membership, "control_browsers"),
  };
  return { machine, refusal: driveRefusal(machine, person, lentAccount(agent) !== null) };
}

/** Whether this person may drive the agent's computer now (`computerDriving`); false where it has none. */
export const mayDriveComputer = (db: Database, userId: string, orgId: string, agentId: string) =>
  computerDriving(db, userId, orgId, agentId).then(
    (d) => d.refusal === null,
    () => false,
  );

/**
 * Who an agent asks for help on its desktop: only people who may drive its computer. Its owner when they may,
 * else everyone who may (the person who paired it; the admins in system mode). Empty: nobody here may.
 */
export async function computerDrivers(db: Database, orgId: string, agentId: string): Promise<string[]> {
  const [agent] = await db
    .select({
      machineId: agents.machineId,
      owner: agents.ownerUserId,
      brain: agents.brain,
      account: agents.brainAccountId,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  const machine = agent?.machineId ? await getMachine(db, orgId, agent.machineId) : null;
  if (!agent || !machine) return [];
  const signIn = lentAccount(agent) !== null;
  const named = [agent.owner, machine.pairedByUserId].filter((id): id is string => !!id);
  // Who may drive it (`control_computers`, `own_computers`, ADR 0085), read once per member, and the people named above.
  const everyone = await db
    .select({
      userId: organizationMembers.userId,
      admin: maySql(orgId, organizationMembers.userId, "control_computers"),
      own: maySql(orgId, organizationMembers.userId, "own_computers"),
      manages: maySql(orgId, organizationMembers.userId, "manage_agents"),
    })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(organizationMembers.createdAt);
  const members = everyone.filter((m) => m.admin || named.includes(m.userId));
  const drivers = members
    .filter((m) => drivesComputer(machine, { ...m, owner: m.userId === agent.owner }, signIn))
    .map((m) => m.userId);
  return agent.owner && drivers.includes(agent.owner) ? [agent.owner] : drivers;
}

/**
 * The machines of an org as one person sees them: every member sees them;
 * the workspace path and the access report only admins and the pairer.
 */
async function machineViews(db: Database, actorId: string, orgId: string, only?: string, now = new Date()) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const admin = can(membership, "configure");
  const rows = await db
    .select({ machine: machines, pairedByName: users.name })
    .from(machines)
    .leftJoin(users, eq(users.id, machines.pairedByUserId))
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt), ...(only ? [eq(machines.id, only)] : [])))
    .orderBy(machines.createdAt);
  const ids = rows.map((r) => r.machine.id);
  const pausers = await pauserNames(
    db,
    orgId,
    rows.flatMap((r) => (r.machine.pausedByUserId ? [r.machine.pausedByUserId] : [])),
  );
  const using = ids.length
    ? await db
        .select({ id: agents.id, name: agents.name, handle: agents.handle, machineId: agents.machineId })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), inArray(agents.machineId, ids), isNull(agents.archivedAt)))
        // The agents' order everywhere else (the sidebar, the team): who came first.
        .orderBy(agents.createdAt)
    : [];
  return rows.map(({ machine: m, pairedByName }) => {
    const mine = m.pairedByUserId === actorId;
    const pause = machinePause(m, now);
    // The workspace's own computer (ADR 0056 §10) is a service people use, not a box they look into.
    const managed = m.kind === "managed";
    return {
      id: m.id,
      name: m.name,
      /** `connected` (a person paired it), `host` (the server's own) or `managed` (the workspace's, never removed here). */
      kind: m.kind,
      online: machineOnline(m, now),
      /** The workspace's own computer is asleep in standby (ADR 0161): it wakes when wanted, nothing is wrong. */
      standby: inStandby(m),
      networkTransition: managed ? m.networkTransition : null,
      /** The workspace's own computer's agents wait for their way out, as the operator says: a line, never an error. */
      egressWaiting: managed && machineOnline(m, now) && m.egressWaitingAt !== null,
      egress: managed && machineOnline(m, now) && m.egress?.ip ? { ...m.egress, ip: m.egress.ip } : null,
      lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
      hostname: managed ? "" : m.hostname,
      os: managed ? "other" : m.os,
      arch: managed ? "" : m.arch,
      /** `system`: each agent works as its own OS user (ADR 0057); `single`: all as the runner's user. */
      mode: m.executors?.mode === "system" ? ("system" as const) : ("single" as const),
      runnerVersion: m.runnerVersion,
      /** The runner's machine protocol (9+: pause; 10+: access on the machine). */
      protocol: m.protocol,
      /** Its runner can hold browser profiles (ADR 0110); a system-mode computer has none at all (`mode`). */
      browserProfiles: m.protocol >= BROWSER_PROFILE_PROTOCOL,
      execAllowed: m.execAllowed,
      /** The owner paused it (ADR 0036 §6); `until` null: until they resume; `by`: who did it from the apps. */
      paused: pause
        ? {
            until: pause.until,
            by:
              m.pausedByUserId && pausers.has(m.pausedByUserId)
                ? { id: m.pausedByUserId, name: pausers.get(m.pausedByUserId) ?? "" }
                : null,
          }
        : null,
      /** Its app can be paused from here (`REMOTE_PAUSE_PROTOCOL`); the workspace's own computer never is. */
      remotePause: !managed && m.protocol >= REMOTE_PAUSE_PROTOCOL,
      pairedBy: m.pairedByUserId ? { id: m.pairedByUserId, name: pairedByName ?? "" } : null,
      agents: using.filter((a) => a.machineId === m.id).map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
      /** Shown to admins and the person who paired it only. */
      workspace: (admin || mine) && !managed ? m.workspace : null,
      /** Folders and tools allowed on the machine (protocol 10); admins and the pairer only, null otherwise or unknown. */
      access: admin || mine ? (m.access ?? null) : null,
      /**
       * Its workspace disk and shared folder (ADR 0115) as its runner last measured them; admins and the pairer
       * only, null otherwise or from a runner that doesn't say.
       */
      disk:
        (admin || mine) && m.load?.diskFreeGb !== undefined
          ? {
              freeGb: m.load.diskFreeGb,
              use: m.load.diskUse ?? null,
              sharedGb: m.load.sharedGb ?? null,
            }
          : null,
      /** Whether the agent browser can run there (protocol 12, ADR 0040); null when its runner doesn't say. */
      browser: m.executors?.browser
        ? {
            available: m.executors.browser.available,
            version: m.executors.browser.version ?? null,
            chrome: m.executors.browser.chrome ?? null,
            reason: m.executors.browser.reason ?? null,
            code: m.executors.browser.code ?? null,
          }
        : null,
      /** Whether agents can use their desktops there (protocol 21, ADR 0062); null when its runner doesn't say. */
      desktopUse: m.executors?.desktopUse
        ? {
            available: m.executors.desktopUse.available,
            reason: m.executors.desktopUse.reason ?? null,
            code: m.executors.desktopUse.code ?? null,
          }
        : null,
      /** This person may rename, delete or reduce its access. */
      canManage: admin || mine,
      createdAt: m.createdAt.toISOString(),
    };
  });
}

/** `GET …/machines`. */
export function listMachines(db: Database, actorId: string, orgId: string, now = new Date()) {
  return machineViews(db, actorId, orgId, undefined, now);
}

export type MachineView = Awaited<ReturnType<typeof listMachines>>[number];

/** One machine as `actorId` sees it. */
export async function machineView(db: Database, actorId: string, orgId: string, machineId: string) {
  const [view] = await machineViews(db, actorId, orgId, machineId);
  if (!view) throw new NotFoundError("Computer not found", "machine.not_found");
  return view;
}

/** `machine.updated` to every member: what changed (no access details: those are for admins and the pairer). */
export async function publishMachineUpdated(
  pubsub: PubSub | undefined,
  orgId: string,
  machineId: string,
  change: Record<string, unknown>,
) {
  await publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.updated", machineId, ...change },
  });
}

/**
 * `PUT …/machines/{machineId}/egress-waiting`: the operator says the workspace's own computer's agents wait for their
 * way out (`egress_waiting_at` keeps the first time), or no longer; its people's apps read it again. Null: the
 * workspace has no such managed computer.
 */
export async function setMachineEgressWaiting(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  machineId: string,
  waiting: boolean,
) {
  const [row] = await deps.db
    .update(machines)
    .set({ egressWaitingAt: waiting ? sql`coalesce(${machines.egressWaitingAt}, now())` : null })
    .where(
      and(
        eq(machines.orgId, orgId),
        eq(machines.id, machineId),
        eq(machines.kind, "managed"),
        isNull(machines.deletedAt),
      ),
    )
    .returning({ id: machines.id });
  if (!row) return null;
  await publishMachineUpdated(deps.pubsub, orgId, machineId, { egressWaiting: waiting });
  return { waiting };
}

/** How many `deletedAgentIds` lists: a computer that misses one only keeps that agent's transcripts. */
const DELETED_AGENTS_LISTED = 500;

/** The org's agents gone for good, the latest first. A computer clears what it holds for those it knew. */
export async function deletedAgentIds(db: Database, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNotNull(agents.deletedAt)))
    .orderBy(desc(agents.deletedAt))
    .limit(DELETED_AGENTS_LISTED);
  return rows.map((a) => a.id);
}

/** The agents of the org pointed at this machine, as its `agents` frame lists them (protocol 9). */
export async function machineAgents(db: Database, orgId: string, machineId: string): Promise<MachineAgent[]> {
  const rows = await db
    .select({
      id: agents.id,
      handle: agents.handle,
      name: agents.name,
      appearance: agents.appearance,
      brain: agents.brain,
      account: agents.brainAccountId,
      builtin: agents.builtin,
      locale: users.locale,
    })
    .from(agents)
    .leftJoin(users, eq(users.id, agents.ownerUserId))
    .where(
      and(
        eq(agents.orgId, orgId),
        isNull(agents.archivedAt),
        // The team's right hand on a plan signed in here (ADR 0137 §1, §11: the workspace's or a person's own): its
        // user holds those sign-ins while it thinks.
        or(
          eq(agents.machineId, machineId),
          and(
            eq(agents.builtin, RIGHT_HAND),
            or(
              sql`exists (select 1 from ${schema.machineAccounts} ma
                where ma.id = ${agents.brainAccountId} and ma.org_id = ${agents.orgId} and ma.machine_id = ${machineId}::uuid)`,
              sql`exists (select 1 from ${schema.rightHandBrains} rb join ${schema.machineAccounts} ma
                on ma.org_id = rb.org_id and ma.id = rb.brain_account_id
                where rb.org_id = ${agents.orgId} and ma.machine_id = ${machineId}::uuid)`,
            ),
          ),
        ),
      ),
    )
    .orderBy(agents.createdAt);
  const personal = rows.some((a) => a.builtin === RIGHT_HAND)
    ? await db
        .select({ id: schema.rightHandBrains.brainAccountId })
        .from(schema.rightHandBrains)
        .innerJoin(
          schema.machineAccounts,
          and(
            eq(schema.machineAccounts.orgId, schema.rightHandBrains.orgId),
            eq(schema.machineAccounts.id, schema.rightHandBrains.brainAccountId),
          ),
        )
        .where(and(eq(schema.rightHandBrains.orgId, orgId), eq(schema.machineAccounts.machineId, machineId)))
    : [];
  return rows.map((a) => {
    const own = a.builtin === RIGHT_HAND ? lentAccount(a) : null;
    const extra = a.builtin === RIGHT_HAND ? [...new Set(personal.map((p) => p.id))].filter((id) => id !== own) : [];
    // The right hand off any workspace plan here thinks only with people's own: the first is its frame's account.
    const account = a.builtin === RIGHT_HAND ? (own ?? extra.shift() ?? null) : lentAccount(a);
    return {
      id: a.id,
      handle: a.handle,
      name: a.name,
      locale: /^pt(?:-|$)/i.test(a.locale ?? "") ? "pt-BR" : "en",
      ...(a.appearance
        ? { look: { color: a.appearance.color, eyes: a.appearance.eyes, accessory: a.appearance.accessory } }
        : {}),
      // System mode keeps an account's folder with this agent's user only while it thinks with it.
      ...(account ? { account } : {}),
      ...(extra.length > 0 ? { accounts: extra } : {}),
      // Where a sandbox of its CLI's own is what holds its turns, a containers service outside it would be a way out.
      ...(a.builtin !== RIGHT_HAND && !isSandboxedBrain(a.brain) ? { containers: true } : {}),
    };
  });
}

/**
 * The agents on the org's machines changed (pointed at or away, renamed, a
 * new look, archived): the replica holding each machine's socket sends its
 * `agents` frame again.
 */
export async function publishMachineAgentsChanged(pubsub: PubSub | undefined, orgId: string) {
  await pubsub?.publish(MACHINE_CONTROL_TOPIC, { type: "machine.agents", orgId }).catch(() => undefined);
}

/** The person who paired it, or an admin (`configure`). */
export async function requireMachineManager(db: Database, actorId: string, orgId: string, machineId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (!can(membership, "configure") && machine.pairedByUserId !== actorId) {
    throw new ForbiddenError(
      "Only an admin or the person who connected this computer can change it",
      "machine.forbidden",
    );
  }
  return machine;
}

export async function renameMachine(
  deps: Pick<MachineDeps, "db" | "pubsub">,
  actorId: string,
  orgId: string,
  machineId: string,
  input: { name: string },
) {
  const machine = await requireMachineManager(deps.db, actorId, orgId, machineId);
  const name = cleanMachineName(input.name);
  if (!name) throw new ValidationError("Give the computer a name", "machine.name_required");
  await deps.db.update(machines).set({ name, updatedAt: new Date() }).where(eq(machines.id, machine.id));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.renamed",
    target: { type: "machine", id: machine.id },
    details: { from: machine.name, to: name },
  });
  await publishMachineUpdated(deps.pubsub, orgId, machine.id, { name });
  return { id: machine.id, name };
}

/** A person removes a computer (the person who paired it or an admin); the workspace's own computer only goes with its provisioner. */
export async function deleteMachine(
  deps: Pick<MachineDeps, "db" | "pubsub">,
  actorId: string,
  orgId: string,
  machineId: string,
) {
  const machine = await requireMachineManager(deps.db, actorId, orgId, machineId);
  if (machine.kind === "managed") {
    throw new ForbiddenError("This is the workspace's own computer: it can't be removed here", "machine.managed");
  }
  await removeMachine(deps, machine, { type: "person", id: actorId });
}

/**
 * Removes a machine: its token stops working, its socket is closed
 * (`refused: revoked`, on whichever replica holds it), and agents that used
 * it are left with no computer (remembered in `previous_agent_ids`, so
 * reconnecting the same computer gives them back). Soft delete, audited.
 * `also` runs in the same transaction.
 */
export async function removeMachine(
  deps: Pick<MachineDeps, "db" | "pubsub">,
  machine: MachineRow,
  actor: AuditEntry["actor"],
  also?: (tx: Executor) => Promise<unknown>,
) {
  const freed = await deps.db.transaction(async (tx) => {
    const ids = await detachMachine(tx, machine);
    await also?.(tx);
    return ids;
  });
  await announceRemovedMachine(deps, machine, actor, freed);
}

/** `removeMachine`'s writes, in the caller's transaction: the agents it leaves with no computer. */
export async function detachMachine(tx: Executor, machine: Pick<MachineRow, "id" | "orgId" | "kind">) {
  const now = new Date();
  const rows = await tx
    .update(agents)
    // Its accounts (ADR 0041) stay with it: the agents leave them.
    .set({ machineId: null, brainAccountId: null, updatedAt: now })
    .where(and(eq(agents.orgId, machine.orgId), eq(agents.machineId, machine.id)))
    .returning({ id: agents.id });
  const ids = rows.map((r) => r.id);
  // Remembered so reconnecting this computer gives them back (`confirmDeviceCode`). A connected
  // computer's token hash stays too: a removed row never authenticates (`authenticateMachine`), and
  // the token is how that computer proves it is this machine when it asks to come back
  // (`startDeviceCode`, ADR 0036 §5). The workspace's own computers lose it.
  await tx
    .update(machines)
    .set({
      deletedAt: now,
      ...(machine.kind === "connected" ? {} : { tokenHash: null }),
      online: false,
      connectedReplica: null,
      // A managed computer issued again comes back on this row, not asleep (ADR 0161), its agents waiting for nothing.
      standbyAt: null,
      egressWaitingAt: null,
      previousAgentIds: ids,
      updatedAt: now,
    })
    .where(eq(machines.id, machine.id));
  // Its phones keep their rows (names, rules) for a host that reports them again.
  await tx
    .update(schema.machinePhones)
    .set({ machineId: null, holder: null, updatedAt: now })
    .where(and(eq(schema.machinePhones.orgId, machine.orgId), eq(schema.machinePhones.machineId, machine.id)));
  return ids;
}

/** After `detachMachine` commits: the audit row, its socket closed wherever it is, and the apps told. */
export async function announceRemovedMachine(
  deps: Pick<MachineDeps, "db" | "pubsub">,
  machine: Pick<MachineRow, "id" | "orgId" | "name">,
  actor: AuditEntry["actor"],
  freed: string[],
) {
  const orgId = machine.orgId;
  for (const agentId of freed) caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(deps.db, {
    orgId,
    actor,
    action: "machine.deleted",
    target: { type: "machine", id: machine.id },
    details: { name: machine.name, agents: freed },
  });
  await deps.pubsub
    ?.publish(MACHINE_CONTROL_TOPIC, { type: "machine.revoke", machineId: machine.id })
    .catch(() => undefined);
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.deleted", machineId: machine.id },
  });
  for (const agentId of freed) {
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "agent.computer", agentId, target: { kind: "none" } },
    });
  }
}

/** Which computer an agent uses (`GET …/computer` `target`). */
export type ComputerTarget = { kind: "none" } | { kind: "machine"; machineId: string; name: string; online: boolean };

export async function computerTarget(db: Database, orgId: string, agentId: string): Promise<ComputerTarget> {
  const agent = await getAgent(db, orgId, agentId);
  if (!agent?.machineId) return { kind: "none" };
  const machine = await getMachine(db, orgId, agent.machineId);
  if (!machine) return { kind: "none" };
  return { kind: "machine", machineId: machine.id, name: machine.name, online: machineOnline(machine) };
}

let workspaceComputers = false;

/**
 * With external provisioning (agentes.chat Cloud) the workspace's computer is every agent's home: a computer someone
 * brought is a target an agent names for a call or a task, never where it lives.
 */
export function setWorkspaceComputers(on: boolean) {
  workspaceComputers = on;
}

/** Whether a computer may be an agent's home (`setWorkspaceComputers`). */
export const mayBeHome = (m: Pick<MachineRow, "kind">) => !workspaceComputers || m.kind !== "connected";

/**
 * Points an agent at a connected machine, or at none with null. An admin (`manage_agents`) may; so may the
 * agent's owner when they paired that machine or it is the workspace's own (leaving it with none only needs
 * the owner). Never at a brought computer where workspaces have their own (`mayBeHome`).
 */
export async function setAgentComputerTarget(
  deps: Pick<MachineDeps, "db" | "pubsub">,
  actorId: string,
  orgId: string,
  agentId: string,
  machineId: string | null,
): Promise<ComputerTarget> {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const agent = await getAgent(deps.db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (machineId && isRightHand(agent)) throw rightHandPermanent("given a computer");
  const admin = can(membership, "manage_agents");
  const machine = machineId ? await getMachine(deps.db, orgId, machineId) : null;
  if (machineId && !machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (machine && !mayBeHome(machine)) {
    throw new ForbiddenError(
      `${machine.name} can't be an agent's computer here: agents live on the workspace computer and use ${machine.name} when they name it.`,
      "device.not_home",
    );
  }
  if (!admin) {
    if (agent.ownerUserId !== actorId) {
      throw new ForbiddenError("Only an admin or the agent's owner can choose its computer", "machine.forbidden");
    }
    // The workspace's own computers (managed, host) are nobody's: any agent of the workspace may use them.
    if (machine && machine.kind === "connected" && machine.pairedByUserId !== actorId) {
      throw new ForbiddenError(
        "You can only give your agent a computer you connected yourself. Ask an admin for this one.",
        "machine.forbidden",
      );
    }
  }
  const moved = (machine?.id ?? null) !== agent.machineId;
  await deps.db
    .update(agents)
    .set({
      machineId: machine?.id ?? null,
      // An account is a folder on one computer (ADR 0041): another computer starts on its own sign-in.
      ...(moved ? { brainAccountId: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.computer_target",
    target: { type: "agent", id: agentId },
    details: { from: agent.machineId, to: machine?.id ?? null, name: machine?.name ?? null },
  });
  const target: ComputerTarget = machine
    ? { kind: "machine", machineId: machine.id, name: machine.name, online: machineOnline(machine) }
    : { kind: "none" };
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "agent.computer", agentId, target },
  });
  // The machine it left and the one it joined list their agents again (protocol 9).
  await publishMachineAgentsChanged(deps.pubsub, orgId);
  return target;
}

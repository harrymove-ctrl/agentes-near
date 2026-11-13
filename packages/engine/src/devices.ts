import {
  IPHONE_WIFI_PROTOCOL,
  PHONE_SCREEN_PROTOCOL,
  type PhoneHolder,
  type PhonePlatform,
  type PhoneReason,
  type PhoneTarget,
  type PubSub,
  type RateLimiter,
  type RunnerPhone,
  STREAM_CLOSE,
  STREAM_LIMITS,
} from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gt, inArray, isNull, schema, sql } from "@agenteschat/db";
import { AUDIENCE_MODES, type AudienceMode } from "./audience";
import { recordAudit } from "./audit";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import type { MachineCaller, MachineHub } from "./machine-hub";
import {
  cleanMachineName,
  getMachine,
  MachineOfflineError,
  type MachineRow,
  machineOnline,
  machinePause,
  publishMachineUpdated,
} from "./machines";
import { can, getMembership, type Membership, requirePermission } from "./organizations";
import { closedRefusal, OrgDeletingError, orgStanding } from "./standing";
import type { Stream, StreamInput, StreamTarget } from "./streams";

const { agents, deviceAccessRequests, machineConnectLinks, machineDeviceCodes, machinePhones, machines, users } =
  schema;
const { organizationMembers, orgRoles } = schema;

/**
 * Bring your own devices: computers people connect (`machines`) and the phones those reach (`machine_phones`), as
 * targets any allowed person's agents can name for one call or task. The workspace computer stays the agents' home.
 */

export type MachinePhoneRow = typeof schema.machinePhones.$inferSelect;

/** Who may point their agents at a device: the same shape and words as an agent's audience. */
export interface DeviceAudience {
  mode: AudienceMode;
  userIds: string[];
  roleIds: string[];
}

/** What the apps show for a device, worded by them from these codes. */
export type DeviceStatus =
  | { kind: "ready" }
  /** A phone held by an agent (`holder`), or a computer busy with one agent's task while it allows one at a time. */
  | {
      kind: "in_use";
      agentId: string | null;
      agentName: string | null;
      userId: string | null;
      userName: string | null;
      label?: string;
      since: string;
    }
  /** A computer running background tasks: `running` of `max`. */
  | { kind: "busy"; running: number; max: number }
  | { kind: "needs_you"; reason: PhoneReason | string }
  | { kind: "preparing"; reason: PhoneReason | string }
  | { kind: "paused"; until: string | null }
  /** `withHost`: a phone whose host is offline. */
  | { kind: "offline"; lastSeenAt: string | null; withHost?: boolean }
  | { kind: "unsupported"; reason: PhoneReason | string };

export interface PhoneDevice {
  id: string;
  platform: PhonePlatform;
  phoneKind: "device" | "emulator" | "simulator";
  name: string;
  model: string;
  osVersion: string;
  hostMachineId: string | null;
  ownerUserId: string | null;
  /** null: it follows its host's rule (an iPhone). */
  audience: DeviceAudience | null;
  status: DeviceStatus;
  transport: "usb" | "wifi" | "local" | null;
  lastSeenAt: string | null;
  /** The viewer's agents may use it; and may change it (its owner, or an admin narrowing). */
  mayUse: boolean;
  mayManage: boolean;
}

export interface ComputerDevice {
  id: string;
  machineKind: "connected" | "host" | "managed";
  name: string;
  os: string;
  arch: string;
  hostname: string;
  cpus: number | null;
  memoryGb: number | null;
  ownerUserId: string | null;
  belongsToWorkspace: boolean;
  /** Each agent works as its own OS user there (a server install). */
  systemMode: boolean;
  audience: DeviceAudience;
  status: DeviceStatus;
  /** Background tasks it runs at once. */
  maxTasks: number | null;
  toolchains: Record<string, string>;
  lastSeenAt: string | null;
  mayUse: boolean;
  mayManage: boolean;
  phones: PhoneDevice[];
}

/** A computer that ran a connect link and waits for the link's maker (`machine_device_codes` with `link_id`). */
export interface JoinRequest {
  id: string;
  linkId: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  ip: string;
  location: string | null;
  createdAt: string;
  expiresAt: string;
}

/** The rule a device's fields spell, an `everyone`/`owner` one without lists. */
export const deviceAudienceOf = (d: {
  audienceMode: AudienceMode;
  audienceUserIds: string[];
  audienceRoleIds: string[];
}): DeviceAudience => ({
  mode: d.audienceMode,
  userIds: d.audienceMode === "people" ? d.audienceUserIds : [],
  roleIds: d.audienceMode === "people" ? d.audienceRoleIds : [],
});

/**
 * Whether a person's agents may target a device under its rule: its owner always; under `owner` a device that
 * belongs to the workspace reads as everyone once nobody owns it. Admins get no way around a personal device's rule.
 */
export function audienceAllows(
  audience: DeviceAudience,
  ownerUserId: string | null,
  person: { userId: string; roleIds: readonly string[] },
  belongsToWorkspace = false,
): boolean {
  if (ownerUserId !== null && ownerUserId === person.userId) return true;
  if (audience.mode === "everyone") return true;
  if (audience.mode === "owner") return ownerUserId === null && belongsToWorkspace;
  return audience.userIds.includes(person.userId) || audience.roleIds.some((id) => person.roleIds.includes(id));
}

/** A rule only narrows from `from` to `to` (admins may narrow someone's personal device, never widen it). */
export function narrowsAudience(from: DeviceAudience, to: DeviceAudience): boolean {
  if (to.mode === "owner" || from.mode === "everyone") return true;
  if (to.mode === "everyone") return false;
  if (from.mode === "owner") return false;
  return to.userIds.every((id) => from.userIds.includes(id)) && to.roleIds.every((id) => from.roleIds.includes(id));
}

/** The device rows `mayUseDevice` reads. */
export interface DeviceRule {
  machineId: string;
  phoneId?: string | null;
  ownerUserId: string | null;
  audience: DeviceAudience;
  belongsToWorkspace: boolean;
}

/** A device's rule, from its machine row or (an Android phone) its own. An iPhone's is its host's. */
export function machineRule(m: {
  id: string;
  pairedByUserId: string | null;
  audienceMode: AudienceMode;
  audienceUserIds: string[];
  audienceRoleIds: string[];
  belongsToWorkspace: boolean;
}): DeviceRule {
  return {
    machineId: m.id,
    ownerUserId: m.pairedByUserId,
    audience: deviceAudienceOf(m),
    belongsToWorkspace: m.belongsToWorkspace,
  };
}

export function phoneRule(
  phone: Pick<
    MachinePhoneRow,
    "id" | "machineId" | "ownerUserId" | "followsHost" | "audienceMode" | "audienceUserIds" | "audienceRoleIds"
  >,
  host: DeviceRule | null,
): DeviceRule {
  if (phone.followsHost && host) return { ...host, phoneId: phone.id };
  return {
    machineId: phone.machineId ?? host?.machineId ?? "",
    phoneId: phone.id,
    ownerUserId: phone.ownerUserId,
    audience: deviceAudienceOf(phone),
    belongsToWorkspace: host?.belongsToWorkspace ?? false,
  };
}

/**
 * Whether `userId`'s agents may use the device now: its rule, or an `Allow once` / `Always` answer to an access
 * request still in force (`device_access_requests`). `membership` saves a lookup when the caller has it.
 */
export async function mayUseDevice(
  db: Executor,
  orgId: string,
  userId: string,
  rule: DeviceRule,
  options: { membership?: Membership | null; runId?: string | null; now?: Date } = {},
): Promise<boolean> {
  const membership = options.membership ?? (await getMembership(db, userId, orgId));
  if (!membership) return false;
  if (audienceAllows(rule.audience, rule.ownerUserId, { userId, roleIds: membership.roleIds }, rule.belongsToWorkspace))
    return true;
  const now = options.now ?? new Date();
  const [granted] = await db
    .select({ id: deviceAccessRequests.id, runId: deviceAccessRequests.runId })
    .from(deviceAccessRequests)
    .where(
      and(
        eq(deviceAccessRequests.orgId, orgId),
        eq(deviceAccessRequests.requesterUserId, userId),
        eq(deviceAccessRequests.status, "once"),
        rule.phoneId
          ? eq(deviceAccessRequests.phoneId, rule.phoneId)
          : eq(deviceAccessRequests.machineId, rule.machineId),
        gt(deviceAccessRequests.expiresAt, now),
      ),
    )
    .limit(1);
  return granted !== undefined;
}

/** Who may change a device: its owner, or an admin (`configure`), who may only narrow a personal device's rule. */
export const mayManageDevice = (
  membership: Pick<Membership, "permissions"> | null,
  userId: string,
  ownerUserId: string | null,
) => ownerUserId === userId || can(membership, "configure");

/** The holder a phone op runs for. */
export const phoneHolder = (h: Omit<PhoneHolder, "since"> & { since?: string }): PhoneHolder => ({
  ...h,
  since: h.since ?? new Date().toISOString(),
});

export interface DevicesList {
  devices: ComputerDevice[];
  requests: JoinRequest[];
}

/** Background tasks a computer runs at once; its runner doesn't report its own limit, so the runner's default. */
export const DEFAULT_MAX_TASKS = 3;

/** `devices.changed` to every member: a phone, a holder or a join request changed; the apps read `GET …/devices` again. */
export const publishDevicesChanged = (pubsub: PubSub | undefined, orgId: string) =>
  publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "devices.changed", orgId } });

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/**
 * An emulator's serial (`emulator-5554`) names it only on its own host, so its row is keyed with the host's id too;
 * a real phone's serial (or an iPhone's or a simulator's UDID) is its own wherever it is plugged in.
 */
const phoneKey = (machineId: string, p: Pick<RunnerPhone, "kind" | "serial">) =>
  p.kind === "emulator" ? `${p.serial}@${machineId}` : p.serial;

/** The serial the phone's host knows it by (`phoneKey` undone). */
export const runnerSerial = (row: Pick<MachinePhoneRow, "kind" | "serial">) =>
  row.kind === "emulator" && row.serial.includes("@") ? row.serial.slice(0, row.serial.lastIndexOf("@")) : row.serial;

/** What a `phone.*` op names: this phone, run for `holder`. */
export const phoneTargetOf = (
  row: Pick<MachinePhoneRow, "platform" | "kind" | "serial">,
  holder: PhoneHolder,
): PhoneTarget => ({ platform: row.platform, serial: runnerSerial(row), holder });

/** A device only its owner may widen (admins only narrow it): one person's computer, not the workspace's. */
const personalComputer = (m: Pick<MachineRow, "kind" | "pairedByUserId" | "executors" | "belongsToWorkspace">) =>
  m.kind === "connected" && m.pairedByUserId !== null && m.executors?.mode !== "system" && !m.belongsToWorkspace;

function computerStatus(m: MachineRow, running: number, now: Date): DeviceStatus {
  if (!machineOnline(m, now)) return { kind: "offline", lastSeenAt: iso(m.lastSeenAt) };
  const pause = machinePause(m, now);
  if (pause) return { kind: "paused", until: pause.until };
  if (running > 0) return { kind: "busy", running, max: DEFAULT_MAX_TASKS };
  return { kind: "ready" };
}

/**
 * A phone its host stops reporting keeps its row and host with `state` `offline`, its `last_seen_at` the last report
 * that listed it. While its host is offline it reads offline with it (`withHost`), last seen when the host was.
 */
function phoneStatus(
  p: MachinePhoneRow,
  host: MachineRow,
  hostOnline: boolean,
  names: { agents: Map<string, string>; users: Map<string, string> },
): DeviceStatus {
  if (!hostOnline) {
    const lastSeenAt = p.state === "offline" ? p.lastSeenAt : host.lastSeenAt;
    return { kind: "offline", lastSeenAt: iso(lastSeenAt), withHost: true };
  }
  if (p.state === "offline") return { kind: "offline", lastSeenAt: iso(p.lastSeenAt) };
  if (p.holder) {
    const { agentId, userId, label, since } = p.holder;
    return {
      kind: "in_use",
      agentId,
      agentName: agentId ? (names.agents.get(agentId) ?? null) : null,
      userId,
      userName: userId ? (names.users.get(userId) ?? null) : null,
      ...(label ? { label } : {}),
      since,
    };
  }
  if (p.state === "needs_you" || p.state === "preparing" || p.state === "unsupported") {
    return { kind: p.state, reason: p.reason ?? "" };
  }
  return { kind: "ready" };
}

/**
 * `GET …/devices`: the workspace's computers (the workspace's own first) with the phones they reach, as `viewerUserId`
 * sees them. Every member sees every device, its owner and status; join requests only their link's maker and admins.
 */
export async function listDevices(
  db: Database,
  orgId: string,
  viewerUserId: string,
  now = new Date(),
): Promise<DevicesList> {
  const membership = await requirePermission(db, viewerUserId, orgId, "read");
  const admin = can(membership, "configure");
  const person = { userId: viewerUserId, roleIds: membership.roleIds };
  const rows = await db
    .select()
    .from(machines)
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
    .orderBy(sql`${machines.kind} = 'managed' desc`, machines.createdAt);
  const ids = rows.map((m) => m.id);
  const phones = ids.length
    ? await db
        .select()
        .from(machinePhones)
        .where(
          and(eq(machinePhones.orgId, orgId), inArray(machinePhones.machineId, ids), isNull(machinePhones.deletedAt)),
        )
        .orderBy(machinePhones.createdAt)
    : [];
  const running = ids.length
    ? await db
        .select({ machineId: schema.machineTasks.machineId, n: sql<number>`count(*)::int` })
        .from(schema.machineTasks)
        .where(
          and(
            eq(schema.machineTasks.orgId, orgId),
            inArray(schema.machineTasks.machineId, ids),
            eq(schema.machineTasks.status, "running"),
          ),
        )
        .groupBy(schema.machineTasks.machineId)
    : [];
  const grants = await db
    .select({ machineId: deviceAccessRequests.machineId, phoneId: deviceAccessRequests.phoneId })
    .from(deviceAccessRequests)
    .where(
      and(
        eq(deviceAccessRequests.orgId, orgId),
        eq(deviceAccessRequests.requesterUserId, viewerUserId),
        eq(deviceAccessRequests.status, "once"),
        gt(deviceAccessRequests.expiresAt, now),
      ),
    );
  const agentIds = [...new Set(phones.map((p) => p.holder?.agentId).filter((id): id is string => !!id))];
  const userIds = [...new Set(phones.map((p) => p.holder?.userId).filter((id): id is string => !!id))];
  const names = {
    agents: new Map(
      agentIds.length
        ? (
            await db
              .select({ id: agents.id, name: agents.name })
              .from(agents)
              .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))
          ).map((a) => [a.id, a.name])
        : [],
    ),
    users: new Map(
      userIds.length
        ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds))).map(
            (u) => [u.id, u.name],
          )
        : [],
    ),
  };
  const busy = new Map(running.map((r) => [r.machineId, Number(r.n)]));
  const grantedMachines = new Set(grants.filter((g) => !g.phoneId).map((g) => g.machineId));
  const grantedPhones = new Set(grants.map((g) => g.phoneId).filter(Boolean));

  const devices = rows.map((m): ComputerDevice => {
    const managed = m.kind === "managed";
    const online = machineOnline(m, now);
    const rule = machineRule(m);
    const mayUse =
      audienceAllows(rule.audience, rule.ownerUserId, person, rule.belongsToWorkspace) || grantedMachines.has(m.id);
    return {
      id: m.id,
      machineKind: m.kind,
      name: m.name,
      // The workspace's own computer is a service people use, not a box they look into (as `listMachines`).
      os: managed ? "other" : m.os,
      arch: managed ? "" : m.arch,
      hostname: managed ? "" : m.hostname,
      cpus: m.size?.cpus ?? null,
      memoryGb: m.size?.memoryGb ?? null,
      ownerUserId: m.pairedByUserId,
      belongsToWorkspace: m.belongsToWorkspace,
      systemMode: m.executors?.mode === "system",
      audience: rule.audience,
      status: computerStatus(m, busy.get(m.id) ?? 0, now),
      maxTasks: null,
      toolchains: m.executors?.toolchains ?? {},
      lastSeenAt: iso(m.lastSeenAt),
      mayUse,
      mayManage: !managed && mayManageDevice(membership, viewerUserId, m.pairedByUserId),
      phones: phones
        .filter((p) => p.machineId === m.id)
        .map((p): PhoneDevice => {
          const own = phoneRule(p, rule);
          return {
            id: p.id,
            platform: p.platform,
            phoneKind: p.kind,
            name: p.name,
            model: p.model,
            osVersion: p.osVersion,
            hostMachineId: p.machineId,
            ownerUserId: p.ownerUserId,
            audience: p.followsHost ? null : deviceAudienceOf(p),
            status: phoneStatus(p, m, online, names),
            transport: p.facts.transport ?? null,
            lastSeenAt: iso(p.lastSeenAt),
            mayUse:
              audienceAllows(own.audience, own.ownerUserId, person, own.belongsToWorkspace) ||
              grantedPhones.has(p.id) ||
              (p.followsHost && grantedMachines.has(m.id)),
            mayManage: mayManageDevice(membership, viewerUserId, p.ownerUserId),
          };
        }),
    };
  });

  const asking = await db
    .select({ code: machineDeviceCodes, makerId: machineConnectLinks.createdByUserId })
    .from(machineDeviceCodes)
    .innerJoin(machineConnectLinks, eq(machineConnectLinks.id, machineDeviceCodes.linkId))
    .where(
      and(
        eq(machineDeviceCodes.orgId, orgId),
        eq(machineDeviceCodes.status, "pending"),
        gt(machineDeviceCodes.expiresAt, now),
      ),
    )
    .orderBy(machineDeviceCodes.createdAt);
  const requests = asking.filter((r) => admin || r.makerId === viewerUserId).map((r) => joinRequestOf(r.code));
  return { devices, requests };
}

/** A device code that came with a connect link, as the apps show it. */
export const joinRequestOf = (c: typeof machineDeviceCodes.$inferSelect): JoinRequest => ({
  id: c.id,
  linkId: c.linkId ?? "",
  name: c.name || c.hostname,
  hostname: c.hostname,
  os: c.os,
  arch: c.arch,
  ip: c.requesterIp,
  location: c.approxLocation,
  createdAt: c.createdAt.toISOString(),
  expiresAt: c.expiresAt.toISOString(),
});

/**
 * A rule as people may send it, checked against the workspace: people still in it, its own roles (an unknown role
 * is refused). `people` with nobody left is the owner alone.
 */
export async function cleanDeviceAudience(db: Executor, orgId: string, a: DeviceAudience): Promise<DeviceAudience> {
  if (!AUDIENCE_MODES.includes(a.mode)) throw new ValidationError("Unknown audience mode");
  if (a.mode !== "people") return { mode: a.mode, userIds: [], roleIds: [] };
  const requested = [...new Set(a.userIds)];
  const requestedRoles = [...new Set(a.roleIds)];
  if (requested.length > 500) throw new ValidationError("At most 500 people");
  if (requestedRoles.length > 100) throw new ValidationError("At most 100 roles");
  const userIds = requested.length
    ? (
        await db
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, requested)))
      ).map((m) => m.userId)
    : [];
  const roleIds = requestedRoles.length
    ? (
        await db
          .select({ id: orgRoles.id })
          .from(orgRoles)
          .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, requestedRoles)))
      ).map((r) => r.id)
    : [];
  if (roleIds.length !== requestedRoles.length) throw new ValidationError("Every role must be one of the workspace's");
  if (userIds.length === 0 && roleIds.length === 0) return { mode: "owner", userIds: [], roleIds: [] };
  return { mode: "people", userIds, roleIds };
}

const deviceNotFound = () => new NotFoundError("Device not found", "device.not_found");
const widenRefused = () =>
  new ForbiddenError("Admins can only narrow who can use someone's own device", "device.widen_forbidden");

async function deviceOf(db: Database, viewerUserId: string, orgId: string, machineId: string) {
  const device = (await listDevices(db, orgId, viewerUserId)).devices.find((d) => d.id === machineId);
  if (!device) throw deviceNotFound();
  return device;
}

export interface ComputerDeviceInput {
  name?: string;
  audience?: DeviceAudience;
  belongsToWorkspace?: boolean;
}

/**
 * `PATCH …/devices/computers/{machineId}`: its owner changes anything; an admin renames it, marks it the workspace's,
 * and narrows its rule (widens it only on the workspace's own devices). Never the workspace's computer.
 */
export async function updateComputerDevice(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  machineId: string,
  input: ComputerDeviceInput,
): Promise<ComputerDevice> {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine) throw deviceNotFound();
  if (machine.kind === "managed") {
    throw new ForbiddenError("This is the workspace's own computer: it can't be changed here", "machine.managed");
  }
  const owner = machine.pairedByUserId === actorId;
  if (!owner && !can(membership, "configure")) {
    throw new ForbiddenError("Only the device's owner or an admin can change it", "device.forbidden");
  }
  const set: Partial<MachineRow> = {};
  if (input.name !== undefined) {
    const name = cleanMachineName(input.name);
    if (!name) throw new ValidationError("Give the device a name", "device.name_required");
    set.name = name;
  }
  if (input.audience) {
    const next = await cleanDeviceAudience(deps.db, orgId, input.audience);
    if (!owner && personalComputer(machine) && !narrowsAudience(deviceAudienceOf(machine), next)) throw widenRefused();
    Object.assign(set, { audienceMode: next.mode, audienceUserIds: next.userIds, audienceRoleIds: next.roleIds });
  }
  if (input.belongsToWorkspace !== undefined) set.belongsToWorkspace = input.belongsToWorkspace;
  if (Object.keys(set).length > 0) {
    await deps.db
      .update(machines)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(machines.id, machine.id));
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "device.updated",
      target: { type: "machine", id: machine.id },
      details: { ...set },
    });
    if (set.name) await publishMachineUpdated(deps.pubsub, orgId, machine.id, { name: set.name });
    await publishDevicesChanged(deps.pubsub, orgId);
  }
  return deviceOf(deps.db, actorId, orgId, machine.id);
}

/** A phone still known, with its host (a phone no host has now isn't listed, so it can't be changed either). */
async function phoneWithHost(db: Database, orgId: string, phoneId: string) {
  const [phone] = await db
    .select()
    .from(machinePhones)
    .where(and(eq(machinePhones.orgId, orgId), eq(machinePhones.id, phoneId), isNull(machinePhones.deletedAt)));
  const host = phone?.machineId ? await getMachine(db, orgId, phone.machineId) : null;
  if (!phone || !host) throw deviceNotFound();
  return { phone, host };
}

export interface PhoneDeviceInput {
  name?: string;
  audience?: DeviceAudience;
}

/**
 * `PATCH …/devices/phones/{phoneId}`: its owner renames it or changes its rule; an admin renames it and narrows the
 * rule of someone's phone. An iPhone has no rule of its own (`device.follows_host`).
 */
export async function updatePhoneDevice(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  phoneId: string,
  input: PhoneDeviceInput,
): Promise<PhoneDevice> {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const { phone, host } = await phoneWithHost(deps.db, orgId, phoneId);
  const owner = phone.ownerUserId === actorId;
  if (!owner && !can(membership, "configure")) {
    throw new ForbiddenError("Only the phone's owner or an admin can change it", "device.forbidden");
  }
  const set: Partial<MachinePhoneRow> = {};
  if (input.name !== undefined) {
    const name = cleanMachineName(input.name);
    if (!name) throw new ValidationError("Give the phone a name", "device.name_required");
    set.name = name;
  }
  if (input.audience) {
    if (phone.followsHost) {
      throw new ValidationError(
        `An iPhone follows the rule of the computer it's plugged into. Change who can use ${host.name} instead.`,
        "device.follows_host",
      );
    }
    const next = await cleanDeviceAudience(deps.db, orgId, input.audience);
    const personal = phone.ownerUserId !== null && !host.belongsToWorkspace;
    if (!owner && personal && !narrowsAudience(deviceAudienceOf(phone), next)) throw widenRefused();
    Object.assign(set, { audienceMode: next.mode, audienceUserIds: next.userIds, audienceRoleIds: next.roleIds });
  }
  if (Object.keys(set).length > 0) {
    await deps.db
      .update(machinePhones)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(machinePhones.id, phone.id));
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "device.phone_updated",
      target: { type: "phone", id: phone.id },
      details: { ...set },
    });
    await publishDevicesChanged(deps.pubsub, orgId);
  }
  const device = (await deviceOf(deps.db, actorId, orgId, host.id)).phones.find((p) => p.id === phone.id);
  if (!device) throw deviceNotFound();
  return device;
}

/**
 * `DELETE …/devices/phones/{phoneId}` (its owner or an admin): gone from the list until its host reports it again. An
 * iPhone's Mac drops its pick to use it over Wi-Fi too (`phone.wifi` `forget`), so it comes back only if picked again
 * or plugged in. One over Wi-Fi now is forgotten only once its Mac confirms: an offline Mac would go on using it.
 */
export async function forgetPhone(
  deps: { db: Database; pubsub?: PubSub; hub?: Pick<MachineCaller, "call"> },
  actorId: string,
  orgId: string,
  phoneId: string,
) {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const { phone, host } = await phoneWithHost(deps.db, orgId, phoneId);
  if (phone.ownerUserId !== actorId && !can(membership, "configure")) {
    throw new ForbiddenError("Only the phone's owner or an admin can forget it", "device.forbidden");
  }
  if (phone.platform === "ios" && deps.hub && host.protocol >= IPHONE_WIFI_PROTOCOL) {
    const told = deps.hub.call(host.id, { op: "phone.wifi", action: "forget", serial: phone.serial });
    if (phone.facts?.transport === "wifi") await told;
    else await told.catch(() => undefined);
  }
  await deps.db
    .update(machinePhones)
    .set({ deletedAt: new Date(), holder: null, updatedAt: new Date() })
    .where(eq(machinePhones.id, phone.id));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "device.phone_forgotten",
    target: { type: "phone", id: phone.id },
    details: { name: phone.name },
  });
  await publishDevicesChanged(deps.pubsub, orgId);
}

/** The reason a Stop is kept under (`device_access_requests`, `denied` for that run and phone). */
const STOPPED = "stopped";

/**
 * `POST …/devices/phones/{phoneId}/stop`: takes the phone back from the agent holding it (its host releases the lock
 * for anyone). Its owner, an admin, or the person the agent works for. The run that held it is told on its next call
 * (`phoneStoppedBy`).
 */
export async function stopPhone(
  deps: { db: Database; pubsub?: PubSub; hub: Pick<MachineCaller, "call"> },
  actorId: string,
  orgId: string,
  phoneId: string,
) {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const { phone, host } = await phoneWithHost(deps.db, orgId, phoneId);
  const holder = phone.holder;
  if (phone.ownerUserId !== actorId && holder?.userId !== actorId && !can(membership, "configure")) {
    throw new ForbiddenError(
      "Only the phone's owner, an admin or the person the agent works for can stop it",
      "device.forbidden",
    );
  }
  const now = new Date();
  const as = holder ?? phoneHolder({ runId: null, agentId: null, userId: actorId });
  try {
    await deps.hub.call(host.id, { op: "phone.release", ...phoneTargetOf(phone, as), force: true });
  } catch (error) {
    // No lock left to release: the host is away (its lock goes with it) or no longer sees the phone.
    const code = (error as { code?: unknown }).code;
    if (!(error instanceof MachineOfflineError) && code !== "phone_missing") throw error;
  }
  await deps.db.update(machinePhones).set({ holder: null, updatedAt: now }).where(eq(machinePhones.id, phone.id));
  const [requester] =
    holder?.runId && holder.userId
      ? await deps.db.select({ id: users.id }).from(users).where(eq(users.id, holder.userId))
      : [];
  if (holder?.runId && requester) {
    await deps.db.insert(deviceAccessRequests).values({
      orgId,
      machineId: host.id,
      phoneId: phone.id,
      requesterUserId: requester.id,
      agentId: holder.agentId,
      runId: holder.runId,
      reason: STOPPED,
      status: "denied",
      decidedByUserId: actorId,
      decidedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 3600_000),
    });
  }
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "device.phone_stopped",
    target: { type: "phone", id: phone.id },
    details: { name: phone.name, ...(holder ? { holder } : {}) },
  });
  await publishDevicesChanged(deps.pubsub, orgId);
}

/** Who pressed Stop on this phone while `runId` held it, if anyone: that run's next call says "<name> stopped this". */
export async function phoneStoppedBy(
  db: Executor,
  orgId: string,
  phoneId: string,
  runId: string,
): Promise<{ userId: string; name: string } | null> {
  const [row] = await db
    .select({ userId: users.id, name: users.name })
    .from(deviceAccessRequests)
    .innerJoin(users, eq(users.id, deviceAccessRequests.decidedByUserId))
    .where(
      and(
        eq(deviceAccessRequests.orgId, orgId),
        eq(deviceAccessRequests.phoneId, phoneId),
        eq(deviceAccessRequests.runId, runId),
        eq(deviceAccessRequests.reason, STOPPED),
      ),
    )
    .limit(1);
  return row ?? null;
}

type PhoneStreamInput = Pick<StreamInput, "userId" | "orgId" | "request">;

/**
 * Whether a person may see a phone's screen live, or control it (`kind: "phone"` streams): seeing it is using it (its
 * rule, as for its screenshots); control also needs it free, already theirs, or held by an agent they may stop (its
 * owner, an admin, or whom the agent works for), which then waits until they give it back. Another person in
 * control keeps it. A refusal of control only (`controlEnded`) lets the viewer open again as a watcher.
 */
async function phoneStreamAccess(
  db: Database,
  input: PhoneStreamInput,
): Promise<{ refused: number; reason: string } | { phone: MachinePhoneRow; host: MachineRow }> {
  const { userId, orgId, request } = input;
  if (request.kind !== "phone") return { refused: STREAM_CLOSE.badRequest, reason: "bad_request" };
  const closed = closedRefusal(await orgStanding(db, orgId));
  if (closed) {
    return { refused: STREAM_CLOSE.forbidden, reason: closed instanceof OrgDeletingError ? "deleting" : "suspended" };
  }
  const membership = await getMembership(db, userId, orgId);
  if (!membership) return { refused: STREAM_CLOSE.forbidden, reason: "forbidden" };
  const found = await phoneWithHost(db, orgId, request.phoneId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  });
  if (!found) return { refused: STREAM_CLOSE.notFound, reason: "no_phone" };
  const { phone, host } = found;
  const rule = phoneRule(phone, machineRule(host));
  if (!(await mayUseDevice(db, orgId, userId, rule, { membership }))) {
    return { refused: STREAM_CLOSE.forbidden, reason: "forbidden" };
  }
  const h = phone.holder;
  if (request.mode === "control" && h && !(h.runId === null && h.agentId === null && h.userId === userId)) {
    if (h.runId === null && h.agentId === null)
      return { refused: STREAM_CLOSE.controlEnded, reason: "someone_in_control" };
    const mayStop = phone.ownerUserId === userId || h.userId === userId || can(membership, "configure");
    if (!mayStop) return { refused: STREAM_CLOSE.controlEnded, reason: "in_use" };
  }
  return { phone, host };
}

/**
 * The broker's `authorize` for a phone's screen: at most `opensPerMinute` opens a minute per person (shared with
 * desktops and terminals), `phoneStreamAccess`, then its host: online on this server (streams don't cross servers)
 * and new enough. Control goes to the host as the person's own hold of the phone.
 */
export async function authorizePhoneStream(
  deps: { db: Database; hub: Pick<MachineHub, "isLocal">; rateLimiter?: RateLimiter },
  input: StreamInput,
): Promise<StreamTarget> {
  const rate = await deps.rateLimiter?.consume(`stream-open:${input.userId}`, {
    limit: STREAM_LIMITS.opensPerMinute,
    windowMs: 60_000,
  });
  if (rate && !rate.allowed) return { refused: STREAM_CLOSE.tooMany, reason: "rate_limited" };
  const access = await phoneStreamAccess(deps.db, input);
  if ("refused" in access) return access;
  const { phone, host } = access;
  if (!deps.hub.isLocal(host.id)) {
    return { refused: STREAM_CLOSE.unreachable, reason: machineOnline(host) ? "other_server" : "offline" };
  }
  if (host.protocol < PHONE_SCREEN_PROTOCOL) return { refused: STREAM_CLOSE.refused, reason: "runner_outdated" };
  const holder = phoneHolder({ runId: null, agentId: null, userId: input.userId });
  return { machineId: host.id, phone: phoneTargetOf(phone, holder) };
}

/** The broker's `recheck` of a phone's screen: whether its person may still have it (`phoneStreamAccess`). */
export async function recheckPhoneStream(db: Database, stream: Stream) {
  const access = await phoneStreamAccess(db, stream);
  return "refused" in access ? { refused: access.refused, reason: access.reason } : null;
}

/** A phone's screen that ran, in the org's audit log: who, which phone and computer, how long, how many bytes. */
export async function auditPhoneStream(db: Executor, s: Stream) {
  if (s.request.kind !== "phone") return;
  await recordAudit(db, {
    orgId: s.orgId,
    actor: { type: "person", id: s.userId },
    action: s.request.mode === "control" ? "device.phone_controlled" : "device.phone_watched",
    target: { type: "phone", id: s.request.phoneId },
    details: {
      machineId: s.machineId,
      seconds: Math.round((Date.now() - (s.readyAt ?? s.openedAt)) / 1000),
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
    },
  });
}

/**
 * The phones a host reports (`hello.phones`, `phones.changed`, whole), stored by (org, platform, serial): a phone
 * moves to the host that reports it, keeping its name and rule. One first seen, forgotten, or reported by a computer
 * of someone else is a new phone: that computer's owner owns it, Only them, named after the phone. Phones of this
 * host it no longer reports turn `offline` (`phoneStatus`). Returns this host's phones as stored now.
 */
export async function syncMachinePhones(
  db: Executor,
  machine: Pick<MachineRow, "id" | "orgId" | "pairedByUserId">,
  phones: RunnerPhone[],
  now = new Date(),
): Promise<MachinePhoneRow[]> {
  const seen = new Map<string, typeof machinePhones.$inferInsert>();
  for (const p of phones) {
    const serial = phoneKey(machine.id, p);
    seen.set(`${p.platform}:${serial}`, {
      orgId: machine.orgId,
      machineId: machine.id,
      platform: p.platform,
      serial,
      kind: p.kind,
      name: cleanMachineName(p.name || p.model) || p.serial.slice(0, 80),
      model: p.model,
      osVersion: p.osVersion,
      state: p.state,
      reason: p.reason ?? null,
      // Absent facts leave no key (jsonb is written as JSON).
      facts: { transport: p.transport, screen: p.screen, abi: p.abi, power: p.power, battery: p.battery },
      holder: p.holder ?? null,
      ownerUserId: machine.pairedByUserId,
      followsHost: p.platform === "ios",
      lastSeenAt: now,
      updatedAt: now,
    });
  }
  if (seen.size > 0) {
    const fresh = sql`(${machinePhones.deletedAt} is not null or ${machinePhones.ownerUserId} is distinct from excluded.owner_user_id)`;
    // ponytail: two people's computers both reporting one phone (a cable on one, adb over Wi-Fi on the other) pass it
    // back and forth, each time as a new phone; a phone that is two places at once would need a host per phone.
    await db
      .insert(machinePhones)
      .values([...seen.values()])
      .onConflictDoUpdate({
        target: [machinePhones.orgId, machinePhones.platform, machinePhones.serial],
        set: {
          machineId: sql`excluded.machine_id`,
          kind: sql`excluded.kind`,
          model: sql`excluded.model`,
          osVersion: sql`excluded.os_version`,
          state: sql`excluded.state`,
          reason: sql`excluded.reason`,
          facts: sql`excluded.facts`,
          holder: sql`excluded.holder`,
          followsHost: sql`excluded.follows_host`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
          name: sql`case when ${fresh} then excluded.name else ${machinePhones.name} end`,
          audienceMode: sql`case when ${fresh} then 'owner' else ${machinePhones.audienceMode} end`,
          audienceUserIds: sql`case when ${fresh} then '{}'::text[] else ${machinePhones.audienceUserIds} end`,
          audienceRoleIds: sql`case when ${fresh} then '{}'::uuid[] else ${machinePhones.audienceRoleIds} end`,
          ownerUserId: sql`excluded.owner_user_id`,
          deletedAt: sql`null`,
        },
      });
  }
  const current = await db
    .select()
    .from(machinePhones)
    .where(
      and(
        eq(machinePhones.orgId, machine.orgId),
        eq(machinePhones.machineId, machine.id),
        isNull(machinePhones.deletedAt),
      ),
    )
    .orderBy(machinePhones.createdAt);
  const gone = current.filter((p) => !seen.has(`${p.platform}:${p.serial}`) && (p.state !== "offline" || p.holder));
  if (gone.length === 0) return current;
  await db
    .update(machinePhones)
    .set({ state: "offline", reason: null, holder: null, updatedAt: now })
    .where(
      inArray(
        machinePhones.id,
        gone.map((p) => p.id),
      ),
    );
  const off = new Set(gone.map((p) => p.id));
  return current.map((p) =>
    off.has(p.id) ? { ...p, state: "offline", reason: null, holder: null, updatedAt: now } : p,
  );
}

/**
 * A member leaves (`removeMember`): the computers they connected that an admin marked the workspace's stay, now
 * nobody's (an Only-them rule then reads as everyone), and so do their phones on those; their other phones are
 * forgotten. Their other computers go with them (`personalMachines`).
 */
export async function releaseLeaverDevices(tx: Executor, orgId: string, userId: string) {
  const now = new Date();
  const kept = await tx
    .update(machines)
    .set({ pairedByUserId: null, updatedAt: now })
    .where(
      and(
        eq(machines.orgId, orgId),
        eq(machines.pairedByUserId, userId),
        eq(machines.belongsToWorkspace, true),
        isNull(machines.deletedAt),
      ),
    )
    .returning({ id: machines.id });
  const theirs = and(
    eq(machinePhones.orgId, orgId),
    eq(machinePhones.ownerUserId, userId),
    isNull(machinePhones.deletedAt),
  );
  if (kept.length > 0) {
    await tx
      .update(machinePhones)
      .set({ ownerUserId: null, updatedAt: now })
      .where(
        and(
          theirs,
          inArray(
            machinePhones.machineId,
            kept.map((m) => m.id),
          ),
        ),
      );
  }
  await tx.update(machinePhones).set({ deletedAt: now, holder: null, updatedAt: now }).where(theirs);
}

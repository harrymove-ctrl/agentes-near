import { randomInt } from "node:crypto";
import { and, type Database, eq, gt, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import {
  cleanDeviceAudience,
  type DeviceAudience,
  type JoinRequest,
  joinRequestOf,
  publishDevicesChanged,
} from "./devices";
import { ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import {
  confirmPendingCode,
  type DeviceDeps,
  type DeviceRequester,
  type DeviceStartInput,
  normalizeUserCode,
  startDeviceCode,
  USER_CODE_ALPHABET,
} from "./machine-device";
import { sha256Hex } from "./machines";
import { notifyDeviceJoinRequest, resolveDeviceJoinRequest } from "./notification-producers";
import { can, requireActiveMembership } from "./organizations";

const { machineConnectLinks, machineDeviceCodes, organizations, users } = schema;

/**
 * One-line installs (bring your own devices): `curl -fsSL <server>/i/<code> | sh`. A link is made by a member for
 * their workspace, works once and for `CONNECT_LINK_TTL_MS`, and grants nothing by itself: the computer that runs it
 * asks to join (a device code bound to the link), and only the link's maker lets it in (`approveDeviceJoin`), with
 * its name and who can use it. The code is stored as SHA-256 only.
 */
export type ConnectLinkKind = "server" | "computer";
export type ConnectLinkRow = typeof machineConnectLinks.$inferSelect;

export const CONNECT_LINK_TTL_MS = 10 * 60_000;
export const CONNECT_CODE_LENGTH = 8;

export const LINK_INVALID = "This link expired or was already used. Make a new one under Settings › Devices.";

export interface ConnectLink {
  id: string;
  /** `ABCD-EFGH`. */
  code: string;
  expiresAt: string;
  commands: { unix: string; windows: string };
}

export interface ConnectLinkState {
  status: "waiting" | "asking" | "joined" | "denied" | "expired";
  request?: JoinRequest;
  machineId?: string;
}

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

/** Uniform over the unambiguous alphabet, shown as `ABCD-EFGH`. */
function generateConnectCode() {
  let code = "";
  for (let i = 0; i < CONNECT_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The install lines for a code. */
export function connectCommands(publicUrl: string, code: string) {
  const base = publicUrl.replace(/\/+$/, "");
  return { unix: `curl -fsSL ${base}/i/${code} | sh`, windows: `irm ${base}/i/${code}/ps | iex` };
}

/** `POST …/devices/connect-links`: a member who may connect computers makes one (the route limits how often). */
export async function createConnectLink(
  deps: { db: Database; now?: () => Date },
  publicUrl: string,
  actorId: string,
  orgId: string,
  kind: ConnectLinkKind,
): Promise<ConnectLink> {
  const membership = await requireActiveMembership(deps.db, actorId, orgId);
  if (!can(membership, "pair_computers")) {
    throw new ForbiddenError("Only members who can post in the workspace can connect a device", "machine.forbidden");
  }
  const now = nowOf(deps);
  const expiresAt = new Date(now.getTime() + CONNECT_LINK_TTL_MS);
  for (let attempt = 0; ; attempt++) {
    const code = generateConnectCode();
    try {
      const [row] = await deps.db
        .insert(machineConnectLinks)
        .values({
          orgId,
          createdByUserId: actorId,
          codeHash: sha256Hex(normalizeUserCode(code)),
          kind,
          expiresAt,
          createdAt: now,
        })
        .returning({ id: machineConnectLinks.id });
      if (!row) throw new Error("connect link insert returned nothing");
      return { id: row.id, code, expiresAt: expiresAt.toISOString(), commands: connectCommands(publicUrl, code) };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= 4) throw error;
    }
  }
}

/** A link still waiting for its computer (unused, unexpired), by the code in the install line; null otherwise. */
export async function openConnectLink(db: Database, code: string, now = new Date()): Promise<ConnectLinkRow | null> {
  const normalized = normalizeUserCode(code);
  if (normalized.length !== CONNECT_CODE_LENGTH) return null;
  const [row] = await db
    .select()
    .from(machineConnectLinks)
    .where(
      and(
        eq(machineConnectLinks.codeHash, sha256Hex(normalized)),
        isNull(machineConnectLinks.usedAt),
        gt(machineConnectLinks.expiresAt, now),
      ),
    );
  return row ?? null;
}

export interface ConnectLinkInfo {
  org: { name: string };
  by: { name: string };
  kind: ConnectLinkKind;
  expiresAt: string;
}

/**
 * `GET /api/machines/connect-links/{code}` (no session): what the desktop app shows before it asks to join with a
 * link, the workspace and who made it. Null for a code that is unknown, used or expired alike, so a guess learns
 * nothing about which.
 */
export async function connectLinkInfo(db: Database, code: string, now = new Date()): Promise<ConnectLinkInfo | null> {
  const link = await openConnectLink(db, code, now);
  if (!link) return null;
  const [who] = await db
    .select({ by: users.name, org: organizations.name })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, link.orgId))
    .where(eq(users.id, link.createdByUserId));
  if (!who) return null;
  return { org: { name: who.org }, by: { name: who.by }, kind: link.kind, expiresAt: link.expiresAt.toISOString() };
}

const OS_WORDS: Record<string, string> = { darwin: "macOS", windows: "Windows", linux: "Linux" };

/**
 * `POST /api/machines/device` with `link`: the computer that ran the install line asks to join. The link is used up
 * (a second computer with the same line is refused), its maker hears it, and the computer polls for its token as
 * with any code. `maker` and `org` in the answer name who it waits for, and where.
 */
export async function startLinkedDeviceCode(
  deps: DeviceDeps & { publicUrl: string },
  code: string,
  input: DeviceStartInput,
  requester: DeviceRequester,
) {
  const now = nowOf(deps);
  const link = await openConnectLink(deps.db, code, now);
  if (!link) throw new ValidationError(LINK_INVALID, "machine.link_invalid");
  const started = await startDeviceCode(deps, input, requester, { id: link.id, orgId: link.orgId });
  const [request] = await deps.db
    .select()
    .from(machineDeviceCodes)
    .where(eq(machineDeviceCodes.deviceCodeHash, sha256Hex(started.deviceCode)));
  if (!request) throw new Error("device code insert not found");
  const [claimed] = await deps.db
    .update(machineConnectLinks)
    .set({ usedAt: now, deviceCodeId: request.id })
    .where(
      and(
        eq(machineConnectLinks.id, link.id),
        isNull(machineConnectLinks.usedAt),
        gt(machineConnectLinks.expiresAt, now),
      ),
    )
    .returning({ id: machineConnectLinks.id });
  if (!claimed) {
    // Another computer used the same line a moment before.
    await deps.db.delete(machineDeviceCodes).where(eq(machineDeviceCodes.id, request.id));
    throw new ValidationError(LINK_INVALID, "machine.link_invalid");
  }
  const [who] = await deps.db
    .select({ maker: users.name, org: organizations.name })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, link.orgId))
    .where(eq(users.id, link.createdByUserId));
  await notifyDeviceJoinRequest(deps, joinRequestOf(request), {
    orgId: link.orgId,
    orgName: who?.org ?? "",
    makerId: link.createdByUserId,
    facts: [OS_WORDS[request.os], request.requesterIp, request.approxLocation].filter(Boolean).join(" · "),
    os: request.os,
    ip: request.requesterIp,
    location: request.approxLocation,
  }).catch(() => undefined);
  await publishDevicesChanged(deps.pubsub, link.orgId);
  return { ...started, maker: { name: who?.maker ?? "" }, org: { name: who?.org ?? "" } };
}

/** A link of this workspace that `actorId` made (an admin sees any); unknown otherwise, never someone else's. */
async function linkOf(db: Database, actorId: string, orgId: string, linkId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [link] = await db
    .select()
    .from(machineConnectLinks)
    .where(and(eq(machineConnectLinks.orgId, orgId), eq(machineConnectLinks.id, linkId)));
  if (!link || (link.createdByUserId !== actorId && !can(membership, "configure"))) {
    throw new NotFoundError("This link is unknown", "device.link_not_found");
  }
  return link;
}

/** `GET …/devices/connect-links/{id}`: where the computer that ran it is (the dialog asks every 2 s). */
export async function connectLinkState(
  deps: { db: Database; now?: () => Date },
  actorId: string,
  orgId: string,
  linkId: string,
): Promise<ConnectLinkState> {
  const now = nowOf(deps);
  const link = await linkOf(deps.db, actorId, orgId, linkId);
  const [request] = link.deviceCodeId
    ? await deps.db.select().from(machineDeviceCodes).where(eq(machineDeviceCodes.id, link.deviceCodeId))
    : [];
  if (!request) return { status: link.expiresAt <= now ? "expired" : "waiting" };
  if (request.status === "denied") return { status: "denied" };
  if (request.status !== "pending")
    return request.machineId ? { status: "joined", machineId: request.machineId } : { status: "expired" };
  if (request.expiresAt <= now) return { status: "expired" };
  return { status: "asking", request: joinRequestOf(request) };
}

/** A computer asking to join through a link of this workspace, still pending. */
async function pendingRequest(db: Database, orgId: string, requestId: string, now: Date) {
  const [row] = await db
    .select({ request: machineDeviceCodes, link: machineConnectLinks })
    .from(machineDeviceCodes)
    .innerJoin(machineConnectLinks, eq(machineConnectLinks.id, machineDeviceCodes.linkId))
    .where(
      and(
        eq(machineDeviceCodes.id, requestId),
        eq(machineDeviceCodes.orgId, orgId),
        eq(machineDeviceCodes.status, "pending"),
        gt(machineDeviceCodes.expiresAt, now),
      ),
    );
  if (!row) {
    throw new NotFoundError(
      "This computer's request is gone or expired. Make a new link under Settings › Devices.",
      "device.request_not_found",
    );
  }
  return row;
}

/**
 * `POST …/devices/requests/{id}/approve` ("Let it join"): only the link's maker. The computer joins with its name and
 * rule (default: everyone for a server, Only the maker for one person's computer) and gets its token on its next poll.
 */
export async function approveDeviceJoin(
  deps: DeviceDeps,
  actorId: string,
  orgId: string,
  requestId: string,
  input: { name?: string; audience?: DeviceAudience } = {},
): Promise<{ machineId: string }> {
  const { request, link } = await pendingRequest(deps.db, orgId, requestId, nowOf(deps));
  if (link.createdByUserId !== actorId) {
    throw new ForbiddenError("Only the person who made this link can let the computer join", "device.not_link_maker");
  }
  const audience = input.audience
    ? await cleanDeviceAudience(deps.db, orgId, input.audience)
    : { mode: link.kind === "server" ? ("everyone" as const) : ("owner" as const), userIds: [], roleIds: [] };
  const machine = await confirmPendingCode(deps, actorId, orgId, request, { name: input.name, audience });
  await resolveDeviceJoinRequest(deps, orgId, request.id).catch(() => undefined);
  await publishDevicesChanged(deps.pubsub, orgId);
  return { machineId: machine.id };
}

/** `POST …/devices/requests/{id}/deny`: the link's maker, or an admin; the computer's next poll is refused. */
export async function denyDeviceJoin(deps: DeviceDeps, actorId: string, orgId: string, requestId: string) {
  const membership = await requireActiveMembership(deps.db, actorId, orgId);
  const now = nowOf(deps);
  const { request, link } = await pendingRequest(deps.db, orgId, requestId, now);
  if (link.createdByUserId !== actorId && !can(membership, "configure")) {
    throw new ForbiddenError("Only the person who made this link or an admin can deny it", "device.not_link_maker");
  }
  await deps.db
    .update(machineDeviceCodes)
    .set({ status: "denied", confirmedByUserId: actorId, decidedAt: now })
    .where(and(eq(machineDeviceCodes.id, request.id), eq(machineDeviceCodes.status, "pending")));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "device.join_denied",
    target: { type: "device_code", id: request.id },
    details: { name: request.name, hostname: request.hostname, ip: request.requesterIp },
  });
  await resolveDeviceJoinRequest(deps, orgId, request.id).catch(() => undefined);
  await publishDevicesChanged(deps.pubsub, orgId);
}

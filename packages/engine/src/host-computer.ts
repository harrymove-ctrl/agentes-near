import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  schema,
} from "@agenteschat/db";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError } from "./errors";
import { publishOrgEvent } from "./events";
import {
  cleanMachineName,
  generateMachineToken,
  MACHINE_CONTROL_TOPIC,
  type MachineRow,
  publishMachineAgentsChanged,
  sha256Hex,
} from "./machines";
import { can, pinnedOwner, requirePermission } from "./organizations";
import { maySql } from "./permissions";

const { agents, channels, machines, organizationMembers, organizations } = schema;

/**
 * The server's own computer (`HOST_COMPUTER_TOKEN`, and `agentes-runner host`
 * on the machine the server runs on): one `host` machine row per organization
 * it serves, each with an ordinary machine token, so the runner keeps one
 * child runner per organization and the hub, outages, accounts and brains
 * work as for any computer.
 *
 * It serves only the organizations the installation's first account (the
 * person who set it up) made and is still an owner or an admin of, and that
 * account is the rows' pairer, so it adds the computer's AI sign-ins (ADR
 * 0041). Someone who joins by invitation and makes an organization of their
 * own doesn't get agents on the operator's machine, not even by inviting that
 * account and making it an admin there. A removed row is that organization's
 * opt-out; turning it back on brings the same row back.
 */

export interface HostSyncInput {
  name?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  runnerVersion?: string;
  /** Organizations the runner holds a token for. */
  have?: string[];
  /** Organizations whose token the server refused: they get new ones. */
  rotate?: string[];
}

export interface HostSyncOrg {
  orgId: string;
  orgName: string;
  machineId: string;
  /** Only when one was issued now; the server keeps its hash only. */
  token?: string;
}

export interface HostDeps {
  db: Database;
  pubsub?: PubSub;
  /** `hostKey` of `HOST_COMPUTER_TOKEN`: the tokens issued now are under it. */
  hostKey: string;
  now?: () => Date;
}

/** What a host row keeps of the `HOST_COMPUTER_TOKEN` its token was issued under. */
export const hostKey = (hostToken: string) => sha256Hex(hostToken);

const OSES = new Set(["linux", "darwin", "windows"]);

/**
 * The organizations served (or just `orgId`, when it is one): made by the first account and still run by it.
 * Who made an organization is recorded only on its #general (`createOrganization`), which can't be renamed
 * or archived. A role alone isn't enough: an organization's owner can make anyone an admin.
 */
async function servedOrgs(db: Database, ownerId: string, orgId?: string) {
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      may: maySql(organizationMembers.orgId, ownerId, "configure"),
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(
      channels,
      and(eq(channels.orgId, organizations.id), eq(channels.name, "general"), eq(channels.createdByUserId, ownerId)),
    )
    .where(and(eq(organizationMembers.userId, ownerId), ...(orgId ? [eq(organizationMembers.orgId, orgId)] : [])))
    .orderBy(asc(organizations.createdAt));
  return rows.filter((o) => o.may);
}

const revoke = (pubsub: PubSub | undefined, machineId: string) =>
  pubsub?.publish(MACHINE_CONTROL_TOPIC, { type: "machine.revoke", machineId }).catch(() => undefined);

/**
 * `POST /api/machines/host/sync`: the organizations the server's computer
 * serves, each with a token when it has none yet (a new row, or one turned
 * back on), when the runner holds none (`have`) or when the server refused
 * the one it holds (`rotate`). A removed row is left out. An organization no
 * longer served loses its token.
 */
export async function syncHostComputer(deps: HostDeps, input: HostSyncInput): Promise<{ orgs: HostSyncOrg[] }> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const ownerId = await pinnedOwner(db);
  const served = ownerId ? await servedOrgs(db, ownerId) : [];
  const ids = served.map((o) => o.id);
  const dropped = await db
    .update(machines)
    .set({ tokenHash: null, online: false, connectedReplica: null, updatedAt: now })
    .where(
      and(
        eq(machines.kind, "host"),
        isNotNull(machines.tokenHash),
        ...(ids.length > 0 ? [notInArray(machines.orgId, ids)] : []),
      ),
    )
    .returning({ id: machines.id });
  for (const m of dropped) await revoke(deps.pubsub, m.id);
  if (!ownerId || served.length === 0) return { orgs: [] };

  const name = cleanMachineName(input.name) || cleanMachineName(input.hostname);
  await db
    .insert(machines)
    .values(
      served.map((o) => ({
        orgId: o.id,
        kind: "host" as const,
        name,
        audienceMode: "everyone" as const,
        pairedByUserId: ownerId,
        hostname: (input.hostname ?? "").slice(0, 200),
        os: OSES.has(input.os ?? "") ? (input.os as string) : "other",
        arch: (input.arch ?? "").slice(0, 40),
        runnerVersion: (input.runnerVersion ?? "").slice(0, 40),
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
  const rows = await db
    .select()
    .from(machines)
    .where(and(eq(machines.kind, "host"), inArray(machines.orgId, ids)));
  const have = new Set(input.have ?? []);
  const rotate = new Set(input.rotate ?? []);
  const orgs: HostSyncOrg[] = [];
  for (const org of served) {
    const row = rows.find((r) => r.orgId === org.id);
    if (!row || row.deletedAt) continue;
    const view = { orgId: org.id, orgName: org.name, machineId: row.id };
    const fresh = row.tokenHash === null;
    if (!fresh && have.has(org.id) && !rotate.has(org.id)) {
      orgs.push(view);
      continue;
    }
    const token = generateMachineToken();
    // Only over what was read: a sync running alongside that already changed it wins.
    const [issued] = await db
      .update(machines)
      .set({
        tokenHash: sha256Hex(token),
        hostKey: deps.hostKey,
        pairedByUserId: ownerId,
        ...(row.name ? {} : { name }),
        updatedAt: now,
      })
      .where(
        and(
          eq(machines.id, row.id),
          isNull(machines.deletedAt),
          row.tokenHash === null ? isNull(machines.tokenHash) : eq(machines.tokenHash, row.tokenHash),
        ),
      )
      .returning();
    if (!issued) {
      orgs.push(view);
      continue;
    }
    if (fresh) await joined(deps, issued, now);
    else await revoke(deps.pubsub, row.id);
    orgs.push({ ...view, token });
  }
  return { orgs };
}

/**
 * At boot: host rows whose token was issued under another
 * `HOST_COMPUTER_TOKEN` (or any, when it is unset now) lose it, so changing
 * that token retires every organization's token too; the runner holding the
 * new one gets new ones at its next sync. Returns how many.
 */
export async function retireHostTokens(db: Database, hostToken: string | undefined): Promise<number> {
  const key = hostToken ? hostKey(hostToken) : null;
  const retired = await db
    .update(machines)
    .set({ tokenHash: null, online: false, connectedReplica: null, updatedAt: new Date() })
    .where(
      and(
        eq(machines.kind, "host"),
        isNotNull(machines.tokenHash),
        ...(key ? [or(isNull(machines.hostKey), ne(machines.hostKey, key))] : []),
      ),
    )
    .returning({ id: machines.id });
  return retired.length;
}

/** A row's first token (new, or turned back on): the organization's agents with no computer start using it. */
async function joined(deps: HostDeps, row: MachineRow, now: Date) {
  const { db, pubsub } = deps;
  const moved = await db
    .update(agents)
    .set({ machineId: row.id, brainAccountId: null, updatedAt: now })
    .where(
      and(eq(agents.orgId, row.orgId), isNull(agents.machineId), isNull(agents.archivedAt), isNull(agents.builtin)),
    )
    .returning({ id: agents.id });
  for (const a of moved) caches.agents.delete(`${row.orgId}:${a.id}`);
  await recordAudit(db, {
    orgId: row.orgId,
    actor: { type: "system", id: null },
    action: "machine.host_joined",
    target: { type: "machine", id: row.id },
    details: { name: row.name, agents: moved.map((a) => a.id) },
  });
  await publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId: row.orgId,
    event: { type: "machine.paired", machineId: row.id, name: row.name },
  });
  for (const a of moved) {
    await publishOrgEvent(pubsub, {
      type: "org.broadcast",
      orgId: row.orgId,
      event: {
        type: "agent.computer",
        agentId: a.id,
        target: { kind: "machine", machineId: row.id, name: row.name, online: false },
      },
    });
  }
  if (moved.length > 0) await publishMachineAgentsChanged(pubsub, row.orgId);
}

/**
 * A new organization the server's computer serves gets its row at once, with
 * the computer's details from the organizations it already serves, so
 * onboarding can offer it; its token comes with the runner's next sync.
 */
export async function addHostComputer(db: Database, orgId: string) {
  const ownerId = await pinnedOwner(db);
  if (!ownerId || (await servedOrgs(db, ownerId, orgId)).length === 0) return;
  const [same] = await db
    .select({
      name: machines.name,
      hostname: machines.hostname,
      os: machines.os,
      arch: machines.arch,
      runnerVersion: machines.runnerVersion,
    })
    .from(machines)
    .where(and(eq(machines.kind, "host"), isNotNull(machines.tokenHash)))
    .orderBy(desc(machines.updatedAt))
    .limit(1);
  await db
    .insert(machines)
    .values({ orgId, kind: "host", name: "", ...same, pairedByUserId: ownerId, audienceMode: "everyone" })
    .onConflictDoNothing();
}

/** The organization's row of the server's computer, removed or not; null when the server doesn't serve it. */
async function servedRow(db: Database, orgId: string): Promise<MachineRow | null> {
  const ownerId = await pinnedOwner(db);
  if (!ownerId || (await servedOrgs(db, ownerId, orgId)).length === 0) return null;
  const [row] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.kind, "host")));
  return row ?? null;
}

/** `GET …/machines/host`: whether this organization uses the server's computer; null when it isn't served. */
export async function hostComputerState(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const row = await servedRow(db, orgId);
  return row ? { machineId: row.id, on: row.deletedAt === null } : null;
}

/**
 * `POST …/machines/host` ("Usar o computador deste servidor"): the removed row
 * comes back (admins, or its pairer) and gets its token at the runner's next
 * sync, when the agents with no computer start using it. Turning it off is
 * removing the row (`deleteMachine`).
 */
export async function restoreHostComputer(deps: Pick<HostDeps, "db" | "pubsub">, actorId: string, orgId: string) {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const row = await servedRow(deps.db, orgId);
  if (!row) throw new NotFoundError("This server's computer doesn't work for this organization", "machine.host_none");
  if (!can(membership, "configure") && row.pairedByUserId !== actorId) {
    throw new ForbiddenError("Only an admin can turn this server's computer back on", "machine.forbidden");
  }
  if (row.deletedAt) {
    const now = new Date();
    await deps.db
      .update(machines)
      .set({
        deletedAt: null,
        tokenHash: null,
        online: false,
        connectedReplica: null,
        previousAgentIds: [],
        updatedAt: now,
      })
      .where(eq(machines.id, row.id));
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "machine.host_restored",
      target: { type: "machine", id: row.id },
      details: { name: row.name },
    });
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "machine.paired", machineId: row.id, name: row.name },
    });
  }
  return { machineId: row.id, on: true };
}

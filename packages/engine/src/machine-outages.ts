import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { brainOf, brainOptions } from "./brain-settings";
import type { ComputerBrainKind } from "./brains/types";
import { isComputerBrain } from "./brains/types";
import { publishQueueChanged } from "./computer-queue";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { TASK_OFFLINE_GRACE_MS } from "./machine-tasks";
import {
  getMachine,
  inStandby,
  type MachineRow,
  machineOnline,
  machinePause,
  mayBeHome,
  setAgentComputerTarget,
} from "./machines";
import { missionTurnFor } from "./missions-engine";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { missStaleRoutineRun } from "./routine-firing";

const { machines, agents, agentRuns, routineRuns } = schema;

/*
 * "Computador desconectado": the
 * computers that run some agents' brain (Claude Code, Codex) and are offline,
 * who is waiting for them, where those agents could go instead, and the move
 * itself ("Trocar computador"): the agents point at another computer and the
 * runs that waited for the old one go on there, except a turn that already
 * ran tools on the old computer (only it may finish that turn).
 */

export interface OutageAgent {
  agentId: string;
  name: string;
  brain: ComputerBrainKind;
  waiting: { routines: number; conversations: number };
}

export interface MachineOutage {
  machineId: string;
  name: string;
  platform: string;
  /** The workspace's own computer (ADR 0056 §10): its platform reads `other`, like its OS everywhere people look. */
  managed: boolean;
  /** ISO: the last sign of life. */
  offlineSince: string;
  agents: OutageAgent[];
  /** Runs of these agents waiting for this computer. */
  waitingRuns: number;
}

export type OutageTarget = {
  kind: "machine";
  machineId: string;
  name: string;
  platform: string;
  managed: boolean;
  online: boolean;
  brains: ComputerBrainKind[];
  /** Why it can't take agents now: `offline`, `paused`; null when it can. */
  reasonOff: string | null;
};

export interface OutageDeps {
  db: Database;
  pubsub?: PubSub;
  now?: () => Date;
}

/** `mac`, `windows`, `linux` from the runner's `os`; anything else as reported; `other` for a managed computer. */
export function machinePlatform(os: string, kind?: MachineRow["kind"]): string {
  if (kind === "managed") return "other";
  if (os === "darwin" || os === "mac" || os === "macos") return "mac";
  if (os === "windows" || os === "win32") return "windows";
  return os;
}

const computerBrains = (row: MachineRow): ComputerBrainKind[] =>
  brainOptions(row)
    .filter((o) => o.available && isComputerBrain(o.kind))
    .map((o) => o.kind as ComputerBrainKind);

/** A run waiting for one of `machineIds`, with whether a routine started it and its cut-off turn's tools. */
async function waitingRunsFor(db: Database, orgId: string, machineIds: string[], agentIds?: string[]) {
  if (machineIds.length === 0) return [];
  return db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      agentId: agentRuns.agentId,
      channelId: agentRuns.channelId,
      threadRootId: agentRuns.threadRootId,
      triggerMessageId: agentRuns.triggerMessageId,
      machineId: agentRuns.waitingMachineId,
      kind: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'kind'`,
      /** `machine_dropped`: its turn was cut and it waits quietly for a short while. */
      code: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'code'`,
      /** Its computer just went (within the grace): it waits without a word. */
      quiet: sql<boolean>`coalesce((${agentRuns.transcript}->'waitingForBrain'->>'quiet')::boolean, false)`,
      executed: sql<number>`coalesce(jsonb_array_length(${agentRuns.transcript}->'interruptedTurn'->'executed'), 0)`,
      routineRunId: routineRuns.id,
    })
    .from(agentRuns)
    .leftJoin(routineRuns, eq(routineRuns.agentRunId, agentRuns.id))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "waiting_input"),
        inArray(agentRuns.waitingMachineId, machineIds),
        ...(agentIds ? [inArray(agentRuns.agentId, agentIds)] : []),
      ),
    );
}

/**
 * `GET …/machines/outages`: each offline computer that some agents think on
 * (computer brain pointed at it) or that runs wait for, with only the agents
 * this person may move (admins with `manage_agents`: all; others: their own
 * agents); and every other computer as a place to move them.
 */
export async function listMachineOutages(
  deps: OutageDeps,
  actorId: string,
  orgId: string,
): Promise<{ outages: MachineOutage[]; targets: OutageTarget[] }> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const membership = await requirePermission(db, actorId, orgId, "read");
  const admin = can(membership, "manage_agents");
  const rows = await db
    .select()
    .from(machines)
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
    .orderBy(machines.createdAt);
  // One in standby is asleep by design, never an outage (ADR 0161).
  const offline = rows.filter((m) => !machineOnline(m, now) && !inStandby(m));
  const offlineIds = offline.map((m) => m.id);

  const [onMachines, waiting] = offlineIds.length
    ? await Promise.all([
        db
          .select({
            id: agents.id,
            name: agents.name,
            brain: agents.brain,
            machineId: agents.machineId,
            ownerUserId: agents.ownerUserId,
            createdAt: agents.createdAt,
          })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.machineId, offlineIds), isNull(agents.archivedAt))),
        waitingRunsFor(db, orgId, offlineIds),
      ])
    : [[], []];
  // Agents that wait but no longer point at that computer (moved, or a mission's): looked up too.
  const known = new Set(onMachines.map((a) => a.id));
  const extraIds = [...new Set(waiting.map((r) => r.agentId).filter((id) => !known.has(id)))];
  const extra = extraIds.length
    ? await db
        .select({
          id: agents.id,
          name: agents.name,
          brain: agents.brain,
          machineId: agents.machineId,
          ownerUserId: agents.ownerUserId,
          createdAt: agents.createdAt,
        })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), inArray(agents.id, extraIds), isNull(agents.archivedAt)))
    : [];
  const byId = new Map([...onMachines, ...extra].map((a) => [a.id, a]));
  const mayMove = (a: { ownerUserId: string | null }) => admin || a.ownerUserId === actorId;

  const outages: MachineOutage[] = [];
  for (const m of offline) {
    const list = new Map<string, OutageAgent>();
    const add = (agentId: string, fallbackKind: string | null) => {
      const a = byId.get(agentId);
      if (!a || !mayMove(a)) return null;
      let entry = list.get(agentId);
      if (!entry) {
        const own = brainOf(a.brain);
        const brain: ComputerBrainKind = isComputerBrain(own)
          ? own
          : isComputerBrain(fallbackKind)
            ? fallbackKind
            : "claude_code";
        entry = { agentId, name: a.name, brain, waiting: { routines: 0, conversations: 0 } };
        list.set(agentId, entry);
      }
      return entry;
    };
    for (const a of onMachines) if (a.machineId === m.id && isComputerBrain(brainOf(a.brain))) add(a.id, null);
    let waitingRuns = 0;
    for (const r of waiting) {
      if (r.machineId !== m.id) continue;
      const entry = add(r.agentId, r.kind);
      if (!entry) continue;
      waitingRuns++;
      if (r.routineRunId) entry.waiting.routines++;
      else entry.waiting.conversations++;
    }
    if (list.size === 0) continue;
    // Just gone (our own restart, a blip, its runner dialing again): not an outage yet, unless a run already
    // said it waits for it. The grace's end tells open apps to look again (`interruptOfflineMachineTasks`).
    const fresh = now.getTime() - (m.lastSeenAt ?? m.updatedAt).getTime() < TASK_OFFLINE_GRACE_MS;
    if (fresh && !waiting.some((r) => r.machineId === m.id && r.code !== "machine_dropped" && !r.quiet)) continue;
    const order = (id: string) => byId.get(id)?.createdAt.getTime() ?? 0;
    outages.push({
      machineId: m.id,
      name: m.name,
      platform: machinePlatform(m.os, m.kind),
      managed: m.kind === "managed",
      offlineSince: (m.lastSeenAt ?? m.updatedAt).toISOString(),
      agents: [...list.values()].sort((a, b) => order(a.agentId) - order(b.agentId)),
      waitingRuns,
    });
  }

  const out = new Set(outages.map((o) => o.machineId));
  const targets: OutageTarget[] = rows
    .filter((m) => !out.has(m.id) && mayBeHome(m))
    .map((m) => {
      const online = machineOnline(m, now);
      return {
        kind: "machine" as const,
        machineId: m.id,
        name: m.name,
        platform: machinePlatform(m.os, m.kind),
        managed: m.kind === "managed",
        online,
        brains: computerBrains(m),
        reasonOff: !online ? "offline" : machinePause(m, now) ? "paused" : null,
      };
    });
  return { outages, targets };
}

export type MoveTarget = { kind: "machine"; machineId: string };

export interface MoveAgentsResult {
  moved: string[];
  skipped: { agentId: string; reason: "brain_unavailable" | "forbidden" | "not_found" }[];
  /** Waiting runs queued again on the new computer. */
  resumed: number;
  /** Waiting runs that stay with the old computer (a cut-off turn that already ran tools there, or a mission's). */
  stillWaiting: number;
}

/**
 * `POST …/machines/{machineId}/move-agents` ("Trocar computador"): points the
 * agents at another computer (`setAgentComputerTarget`: same permissions,
 * audited per agent) when it can run their brain, then queues their runs
 * that waited for the old computer again there. A run whose cut-off turn
 * already ran tools on the old computer keeps waiting for it. Audited.
 */
export async function moveAgentsFromMachine(
  deps: OutageDeps,
  actorId: string,
  orgId: string,
  machineId: string,
  input: { agentIds: string[]; target: MoveTarget },
): Promise<MoveAgentsResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const membership = await requirePermission(db, actorId, orgId, "read");
  const admin = can(membership, "manage_agents");
  const from = await getMachine(db, orgId, machineId);
  if (!from) throw new NotFoundError("Computer not found", "machine.not_found");
  const agentIds = [...new Set(input.agentIds)];
  if (agentIds.length === 0) throw new ValidationError("Choose at least one agent", "machine.move_no_agents");

  const target = input.target;
  if (target.machineId === from.id) {
    throw new ConflictError("Choose another computer", "machine.target_same");
  }
  const to = await getMachine(db, orgId, target.machineId);
  if (!to) throw new ConflictError("That computer isn't in this organization", "machine.target_not_found");
  if (!machineOnline(to, now)) {
    throw new ConflictError(`${to.name} is offline`, "machine.target_offline", { name: to.name });
  }
  if (machinePause(to, now)) {
    throw new ConflictError(`${to.name} is paused by its owner`, "machine.target_paused", { name: to.name });
  }
  const brains = computerBrains(to);

  const waiting = await waitingRunsFor(db, orgId, [from.id], agentIds);
  const moved: string[] = [];
  const skipped: MoveAgentsResult["skipped"] = [];
  for (const agentId of agentIds) {
    const agent = await getAgent(db, orgId, agentId);
    const related = agent?.machineId === from.id || waiting.some((r) => r.agentId === agentId);
    if (!agent || agent.archivedAt || !related) {
      skipped.push({ agentId, reason: "not_found" });
      continue;
    }
    if (!admin && agent.ownerUserId !== actorId) {
      skipped.push({ agentId, reason: "forbidden" });
      continue;
    }
    const brain = brainOf(agent.brain);
    if (isComputerBrain(brain) && !brains.includes(brain)) {
      skipped.push({ agentId, reason: "brain_unavailable" });
      continue;
    }
    try {
      await setAgentComputerTarget(deps, actorId, orgId, agentId, to.id);
      moved.push(agentId);
    } catch (error) {
      if (error instanceof ForbiddenError) skipped.push({ agentId, reason: "forbidden" });
      else if (error instanceof NotFoundError) skipped.push({ agentId, reason: "not_found" });
      else throw error;
    }
  }

  let resumed = 0;
  let stillWaiting = 0;
  const movedSet = new Set(moved);
  for (const r of waiting) {
    if (!movedSet.has(r.agentId)) continue;
    // A routine's run whose slot is more than 12 hours old doesn't run late on the new computer: it is missed.
    if (r.routineRunId && (await missStaleRoutineRun(deps, r.id, now))) continue;
    // Tools already ran in the cut-off turn: only the old computer may finish it.
    if (r.executed > 0) {
      stillWaiting++;
      continue;
    }
    // A mission's main session lives on the mission's own computer: it waits for that one.
    const mission = await missionTurnFor(db, r).catch(() => null);
    if (mission?.session?.machineId && mission.session.machineId !== to.id) {
      stillWaiting++;
      continue;
    }
    if (await repointWaitingRun(db, r.id, from.id, to.id)) resumed++;
  }

  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.agents_moved",
    target: { type: "machine", id: from.id },
    details: {
      to: { kind: "machine", machineId: to.id, name: to.name },
      moved,
      skipped,
      resumed,
      stillWaiting,
    },
  });
  if (resumed > 0) await publishQueueChanged(deps.pubsub, orgId, from.id);
  if (moved.length > 0) {
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: {
        type: "machine.agents_moved",
        machineId: from.id,
        agentIds: moved,
        target: { kind: "machine", machineId: to.id },
      },
    });
  }
  return { moved, skipped, resumed, stillWaiting };
}

/**
 * A run that waited for `fromId` now waits for `toId` and is queued again,
 * under a new wait id: one job for this move (a later move or the old
 * computer's "back" job finds the wait changed and does nothing). False: it no
 * longer waits for that computer.
 */
async function repointWaitingRun(db: Database, runId: string, fromId: string, toId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        orgId: agentRuns.orgId,
        status: agentRuns.status,
        machineId: agentRuns.waitingMachineId,
        transcript: agentRuns.transcript,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    if (row?.status !== "waiting_input" || row.machineId !== fromId) return false;
    const t = (row.transcript ?? {}) as { waitingForBrain?: Record<string, unknown> } & Record<string, unknown>;
    const waitId = Bun.randomUUIDv7();
    t.waitingForBrain = {
      ...(t.waitingForBrain ?? { kind: "claude_code", code: "machine_offline" }),
      machineId: toId,
      waitId,
      movedFrom: fromId,
    };
    await tx
      .update(agentRuns)
      .set({ transcript: t, waitingMachineId: toId, updatedAt: new Date() })
      .where(eq(agentRuns.id, runId));
    await enqueue(tx, {
      orgId: row.orgId,
      kind: "agent_run.execute",
      payload: { runId, wait: waitId },
      dedupeKey: `agent_run.execute:${runId}:moved:${waitId}`,
      maxAttempts: 4,
    });
    return true;
  });
}

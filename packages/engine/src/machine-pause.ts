import { type PubSub, REMOTE_PAUSE_PROTOCOL } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ForbiddenError, ValidationError } from "./errors";
import type { MachineCaller } from "./machine-hub";
import {
  MachineOfflineError,
  memberPause,
  pauseForApps,
  publishMachineUpdated,
  requireMachineManager,
} from "./machines";

const { machines } = schema;

/** `until` null: until resumed. */
export type MachinePauseInput = { paused: true; until: string | null } | { paused: false };

/**
 * `POST …/machines/{machineId}/pause` and `…/resume` (an admin or the person who connected it): the computer applies
 * it as its own pause (`pause.set`, `REMOTE_PAUSE_PROTOCOL`), through whichever replica holds its socket. Returns the
 * pause as the apps read it.
 */
export async function setMachinePause(
  deps: { db: Database; pubsub?: PubSub; hub: Pick<MachineCaller, "call" | "status"> },
  actorId: string,
  orgId: string,
  machineId: string,
  input: MachinePauseInput,
  now = new Date(),
) {
  const machine = await requireMachineManager(deps.db, actorId, orgId, machineId);
  if (machine.kind === "managed") {
    throw new ForbiddenError("The workspace's own computer can't be paused", "machine.managed");
  }
  if (machine.protocol < REMOTE_PAUSE_PROTOCOL) {
    throw new ValidationError("This computer's app is too old to pause from here. Update it.", "machine.outdated");
  }
  let until: string | null = null;
  if (input.paused && input.until !== null) {
    const at = Date.parse(input.until);
    if (Number.isNaN(at) || at <= now.getTime()) {
      throw new ValidationError("Choose a time in the future", "machine.pause_past");
    }
    until = new Date(at).toISOString();
  }
  const status = await deps.hub.status(machine.id);
  if (!status?.online) throw new MachineOfflineError(machine.name, machine.kind);
  const reply = await deps.hub.call(machine.id, {
    op: "pause.set",
    paused: input.paused,
    ...(input.paused ? { until } : {}),
    by: actorId,
  });
  const said = reply?.paused?.paused ? { until: reply.paused.until ?? null, by: reply.paused.by ?? null } : null;
  const pause = await memberPause(deps.db, orgId, said);
  // The runner's `runner.state` says the same soon after; the row is right for this answer already.
  await deps.db
    .update(machines)
    .set({
      paused: pause !== null,
      pausedUntil: pause?.until ? new Date(pause.until) : null,
      pausedByUserId: pause?.by ?? null,
      updatedAt: new Date(),
    })
    .where(eq(machines.id, machine.id));
  const view = await pauseForApps(deps.db, orgId, pause);
  await publishMachineUpdated(deps.pubsub, orgId, machine.id, { paused: view });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: input.paused ? "machine.paused" : "machine.resumed",
    target: { type: "machine", id: machine.id },
    details: input.paused ? { until } : {},
  });
  return { paused: view };
}

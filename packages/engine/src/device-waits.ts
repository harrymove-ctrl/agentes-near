import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { type DeviceTarget, firstNames, targetMachineId, targetName, targetRule } from "./device-resolve";
import type { MachinePhoneRow } from "./devices";
import { ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { insertMessage, messageView } from "./messages";
import { notify, resolveNotifications } from "./notifications";
import { can, getMembership } from "./organizations";
import { enqueue } from "./outbox";
import { resumeRunWithResult, type StoredTranscript } from "./run-resume";
import { replyThreadOf } from "./runs";
import type { ToolContext, ToolOutput } from "./tools/types";

const { agentRuns, machines, messages } = schema;

/**
 * "I'll start when it's back" (bring your own devices): `wait_for_device` parks the run on a pending call whose wait
 * id names the device (`device:<host>:<phone or ->:<uuid>`), so the usual pause, resume and steering apply: a person's
 * message moves it on (`holdsMessages`, `onMessageWhileWaiting`), the host coming online or its phones report wakes it
 * (`deviceWaitHooks`), and a job gives up after `DEVICE_WAIT_MS`. A card in the thread (`meta.deviceWait`) says why,
 * with Try now, Use another device and Stop waiting; `device_wait.updated` tells the apps when it ends.
 */

/** How long a run waits for a device before it gives up and says so. */
export const DEVICE_WAIT_MS = 24 * 3600_000;

/** The job that ends a wait still open at its `until`. */
export const DEVICE_WAIT_EXPIRED_JOB = "device.wait_expired";

const PREFIX = "device:";

export const isDeviceWaitId = (id: string | null | undefined) => typeof id === "string" && id.startsWith(PREFIX);

export const newDeviceWaitId = (machineId: string, phoneId: string | null) =>
  `${PREFIX}${machineId}:${phoneId ?? "-"}:${Bun.randomUUIDv7()}`;

export function parseDeviceWaitId(id: string): { machineId: string; phoneId: string | null } | null {
  if (!isDeviceWaitId(id)) return null;
  const [machineId, phone] = id.slice(PREFIX.length).split(":");
  if (!machineId || !phone) return null;
  return { machineId, phoneId: phone === "-" ? null : phone };
}

/**
 * Why a run waits: its computer or the phone's host is `offline`; the phone isn't seen (`missing`), is held by another
 * agent (`busy`), needs its person (`needs_you`, `detail` the phone's reason code) or is getting ready (`preparing`);
 * or its owner was asked to let the requester use it (`asked`).
 */
export type DeviceWaitReason = "offline" | "missing" | "busy" | "needs_you" | "preparing" | "asked";

/**
 * How a wait ended: the device is `back`, a person pressed Try now (`retried`) or Stop waiting (`stopped`), wrote in
 * the thread (`moved_on`), its owner answered (`allowed`, `denied`), or a day went by (`gave_up`).
 */
export type DeviceWaitState =
  | "waiting"
  | "back"
  | "retried"
  | "stopped"
  | "moved_on"
  | "allowed"
  | "denied"
  | "gave_up"
  /** The device left with its owner (they left the workspace). */
  | "left";

/** `meta.deviceWait` on the card message: what the web and phone apps render. */
export interface DeviceWaitCard {
  runId: string;
  waitId: string;
  agentId: string;
  /** Whom the agent works for (they, the agent's owner and admins may press its buttons). */
  requesterUserId: string | null;
  device: {
    kind: "computer" | "phone";
    id: string;
    name: string;
    platform: "android" | "ios" | null;
    /** The computer it waits for, or the phone's host. */
    hostId: string | null;
    hostName: string | null;
    ownerUserId: string | null;
  };
  /** `device.name` and `device.hostName` again, flat, as the phone app reads them. */
  deviceName: string;
  hostName: string | null;
  reason: DeviceWaitReason;
  /** With `needs_you` or `preparing`: the phone's reason code (`PhoneReason`: `locked`, `unauthorized`…). */
  detail: string | null;
  lastSeenAt: string | null;
  /** With `busy`: who holds the phone. */
  holder: { agentId: string | null; userId: string | null; label: string | null; since: string } | null;
  /** The agent's own words, if it gave any. */
  note: string | null;
  since: string;
  until: string;
  state: DeviceWaitState;
  endedAt?: string;
}

export interface DeviceWaitDeps {
  db: Database;
  pubsub?: PubSub;
  now?: () => Date;
}

/**
 * Parks the run on a device: its card in the thread, the owner told when someone else's agent waits on their device,
 * the give-up job queued. The tool answers with `data.pause` (the executor holds the call) and the card.
 */
export async function startDeviceWait(
  deps: DeviceWaitDeps,
  ctx: ToolContext,
  input: {
    target: DeviceTarget;
    reason: DeviceWaitReason;
    detail?: string | null;
    holder?: DeviceWaitCard["holder"];
    requester: string | null;
    note?: string;
    /** What the tool answers the model now. */
    content: string;
    /** The card's words in the language of whom the agent works for (the apps say them again from the fields). */
    body: string;
  },
): Promise<ToolOutput> {
  const now = deps.now?.() ?? new Date();
  const { target } = input;
  const machineId = targetMachineId(target) ?? "";
  const phoneId = target.kind === "phone" ? target.phone.id : null;
  const host = target.kind === "computer" ? target.computer : target.host;
  const owner = targetRule(target).ownerUserId;
  const waitId = newDeviceWaitId(machineId, phoneId);
  const card: DeviceWaitCard = {
    runId: ctx.runId,
    waitId,
    agentId: ctx.agentId,
    requesterUserId: input.requester,
    device: {
      kind: target.kind,
      id: target.kind === "computer" ? target.computer.id : target.phone.id,
      name: targetName(target),
      platform: target.kind === "phone" ? target.phone.platform : null,
      hostId: host?.id ?? null,
      hostName: host?.name ?? null,
      ownerUserId: owner,
    },
    deviceName: targetName(target),
    hostName: host?.name ?? null,
    reason: input.reason,
    detail: input.detail ?? null,
    lastSeenAt:
      (target.kind === "phone" ? (target.phone.lastSeenAt ?? host?.lastSeenAt) : host?.lastSeenAt)?.toISOString() ??
      null,
    holder: input.holder ?? null,
    note: input.note?.trim() || null,
    since: now.toISOString(),
    until: new Date(now.getTime() + DEVICE_WAIT_MS).toISOString(),
    state: "waiting",
  };
  const threadId = replyThreadOf(ctx);
  const message = await insertMessage(ctx.db, {
    orgId: ctx.orgId,
    channelId: ctx.channelId,
    threadId,
    author: { type: "agent", agentId: ctx.agentId, runId: null, hop: 0, stretchId: null },
    body: input.body,
    meta: { deviceWait: card },
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message)).catch(() => undefined);
  // Asked for it already: the access request is what the owner reads.
  if (owner && owner !== input.requester && input.reason !== "asked") {
    const names = input.requester ? await firstNames(ctx.db, [input.requester]) : new Map<string, string>();
    await notify(deps, {
      orgId: ctx.orgId,
      userIds: [owner],
      kind: "device.waiting",
      groupKey: `device-waiting:${waitId}`,
      actor: { type: "agent", id: ctx.agentId },
      source: {
        channelId: ctx.channelId,
        ...(threadId ? { threadId } : {}),
        messageId: message.id,
        machineId,
        ...(phoneId ? { phoneId } : {}),
        ...(input.requester ? { userId: input.requester } : {}),
        runId: ctx.runId,
        label: card.device.name,
      },
      latest: { ...(input.requester ? { title: names.get(input.requester) } : {}) },
    }).catch(() => undefined);
  }
  await enqueue(ctx.db, {
    orgId: ctx.orgId,
    kind: DEVICE_WAIT_EXPIRED_JOB,
    payload: { runId: ctx.runId, waitId },
    dedupeKey: `${DEVICE_WAIT_EXPIRED_JOB}:${waitId}`,
    runAt: new Date(card.until),
  });
  return {
    content: input.content,
    data: { pause: { kind: "device", id: waitId }, deviceWait: card },
  };
}

/** A waiting run's open device waits, with the device each names. */
interface OpenWait {
  run: { id: string; orgId: string; channelId: string; agentId: string };
  waitId: string;
  machineId: string;
  phoneId: string | null;
}

/** Runs waiting on a device of this host (or on this run), from their pending calls. */
export async function openDeviceWaits(
  db: Executor,
  orgId: string,
  filter: { machineId?: string; runId?: string },
): Promise<OpenWait[]> {
  const like = `${PREFIX}${filter.machineId ?? ""}%`;
  const rows = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      channelId: agentRuns.channelId,
      agentId: agentRuns.agentId,
      transcript: agentRuns.transcript,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "waiting_input"),
        filter.runId ? eq(agentRuns.id, filter.runId) : undefined,
        sql`exists (select 1 from jsonb_array_elements(coalesce(${agentRuns.transcript}->'pending'->'calls', '[]'::jsonb)) c
          where c->>'waitId' like ${like} and c->'result' is null)`,
      ),
    )
    .limit(200);
  const out: OpenWait[] = [];
  for (const r of rows) {
    const calls = (r.transcript as StoredTranscript | null)?.pending?.calls ?? [];
    for (const c of calls) {
      const named = c.waitId && !c.result ? parseDeviceWaitId(c.waitId) : null;
      if (!named || (filter.machineId && named.machineId !== filter.machineId)) continue;
      out.push({ run: r, waitId: c.waitId as string, ...named });
    }
  }
  return out;
}

/** The card message of a wait. */
async function cardOf(db: Executor, run: OpenWait["run"], waitId: string) {
  const [m] = await db
    .select({ id: messages.id, threadId: messages.threadId, meta: messages.meta })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        eq(messages.authorAgentId, run.agentId),
        sql`${messages.meta}->'deviceWait'->>'waitId' = ${waitId}`,
      ),
    )
    .limit(1);
  const card = m?.meta?.deviceWait as DeviceWaitCard | undefined;
  return m && card ? { id: m.id, threadId: m.threadId, card } : null;
}

/** The card stops looking live: its state, the apps told, the owner's notification done. */
async function endCard(deps: DeviceWaitDeps, run: OpenWait["run"], waitId: string, state: DeviceWaitState) {
  const found = await cardOf(deps.db, run, waitId);
  if (found?.card.state !== "waiting") return found?.card ?? null;
  const card: DeviceWaitCard = { ...found.card, state, endedAt: (deps.now?.() ?? new Date()).toISOString() };
  await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{deviceWait}', ${JSON.stringify(card)}::jsonb)` })
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, found.id)));
  await publishChannelEvent(deps.pubsub, {
    type: "device_wait.updated",
    channelId: run.channelId,
    threadId: found.threadId,
    messageId: found.id,
    deviceWait: card as unknown as Record<string, unknown>,
  });
  await resolveNotifications(deps, run.orgId, { groupKey: `device-waiting:${waitId}` }).catch(() => 0);
  return card;
}

/** Ends cards of waits the run no longer waits on (a person's message moved it on). */
export async function endDeviceWaitCards(
  deps: DeviceWaitDeps,
  run: OpenWait["run"],
  waitIds: string[],
  state: DeviceWaitState,
) {
  for (const waitId of waitIds.filter(isDeviceWaitId)) await endCard(deps, run, waitId, state).catch(() => null);
}

/**
 * Ends one wait: the run reads `text` as the tool's result and goes on; its card says `state`. `back`: the device
 * itself is back, which ends no wait for its owner's answer (that one goes on when they answer).
 */
async function endWait(
  deps: DeviceWaitDeps,
  wait: OpenWait,
  state: DeviceWaitState,
  text: (card: DeviceWaitCard | null) => string,
) {
  const found = await cardOf(deps.db, wait.run, wait.waitId);
  if (state === "back" && found?.card.reason === "asked") return false;
  const resumed = await resumeRunWithResult(deps.db, {
    runId: wait.run.id,
    waitId: wait.waitId,
    result: { content: text(found?.card ?? null) },
    waitingOnly: true,
  });
  await endCard(deps, wait.run, wait.waitId, state);
  return resumed !== null;
}

const nameOf = (card: DeviceWaitCard | null) => card?.device.name ?? "The device";

/** The host is online: runs waiting for that computer itself go on. */
export async function resumeComputerWaits(deps: DeviceWaitDeps, machineId: string): Promise<string[]> {
  const [m] = await deps.db.select({ orgId: machines.orgId }).from(machines).where(eq(machines.id, machineId));
  if (!m) return [];
  const resumed: string[] = [];
  for (const w of await openDeviceWaits(deps.db, m.orgId, { machineId })) {
    if (w.phoneId) continue;
    const ok = await endWait(
      deps,
      w,
      "back",
      (card) => `${nameOf(card)} is back online. Check it again and carry on with the work.`,
    );
    if (ok) resumed.push(w.run.id);
  }
  return resumed;
}

/**
 * A host's phones changed: runs waiting on a phone now ready and free go on, and so does a run a person gave its phone
 * back to (it holds it again).
 */
export async function resumePhoneWaits(
  deps: DeviceWaitDeps,
  machine: { id: string; orgId: string },
  phones: Pick<MachinePhoneRow, "id" | "state" | "holder" | "machineId">[],
): Promise<string[]> {
  const ready = phones.filter((p) => p.state === "ready");
  if (ready.length === 0) return [];
  const resumed: string[] = [];
  for (const w of await openDeviceWaits(deps.db, machine.orgId, { machineId: machine.id })) {
    const p = ready.find((x) => x.id === w.phoneId);
    if (!p || (p.holder && p.holder.runId !== w.run.id)) continue;
    const ok = await endWait(
      deps,
      w,
      "back",
      (card) => `${nameOf(card)} is back and free. Check it again and carry on with the work (start the flow over).`,
    );
    if (ok) resumed.push(w.run.id);
  }
  return resumed;
}

/** What the machine hub calls for device waits: the host online, its phones changed. */
export function deviceWaitHooks(deps: DeviceWaitDeps) {
  return {
    online: (machineId: string) => resumeComputerWaits(deps, machineId).then(() => undefined),
    phonesChanged: (machine: { id: string; orgId: string }, phones: MachinePhoneRow[]) =>
      resumePhoneWaits(deps, machine, phones).then(() => undefined),
  };
}

/** The owner answered an access request: the run that waited on it goes on, told the answer. */
export async function afterDeviceAccessDecided(
  deps: DeviceWaitDeps,
  orgId: string,
  decided: {
    status: "once" | "always" | "denied";
    runId: string | null;
    machineId: string | null;
    phoneId: string | null;
  },
  ownerName: string,
) {
  if (!decided.runId) return false;
  let any = false;
  for (const w of await openDeviceWaits(deps.db, orgId, { runId: decided.runId })) {
    if (w.machineId !== decided.machineId || w.phoneId !== decided.phoneId) continue;
    any =
      (await endWait(deps, w, decided.status === "denied" ? "denied" : "allowed", (card) =>
        decided.status === "denied"
          ? `${ownerName} said no to ${nameOf(card)}. Tell the person and use another device.`
          : `${ownerName} allowed you to use ${nameOf(card)}${decided.status === "once" ? " for this work" : ""}. Carry on with the work there.`,
      )) || any;
  }
  return any;
}

/** A computer left the workspace with its owner: runs waiting on it, or on a phone it reaches, stop waiting. */
export async function endWaitsOnLeftDevice(
  deps: DeviceWaitDeps,
  orgId: string,
  machineId: string,
  ownerUserId: string,
) {
  const owner = (await firstNames(deps.db, [ownerUserId])).get(ownerUserId) ?? "its owner";
  let ended = 0;
  for (const w of await openDeviceWaits(deps.db, orgId, { machineId })) {
    const ok = await endWait(
      deps,
      w,
      "left",
      (card) =>
        `${nameOf(card)} left the workspace with ${owner}, so you stopped waiting for it. Tell the person in one line and use another device if there is one.`,
    );
    if (ok) ended++;
  }
  return ended;
}

/** A day went by: a wait still open ends, and the agent says it stopped waiting. */
export async function expireDeviceWait(deps: DeviceWaitDeps, runId: string, waitId: string) {
  const [run] = await deps.db.select({ orgId: agentRuns.orgId }).from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return false;
  const [w] = (await openDeviceWaits(deps.db, run.orgId, { runId })).filter((x) => x.waitId === waitId);
  if (!w) return false;
  return endWait(
    deps,
    w,
    "gave_up",
    (card) =>
      `${nameOf(card)} hasn't been back for a day, so you stopped waiting. Tell the person in one line (they can ask you to try again when it's back).`,
  );
}

/**
 * Try now or Stop waiting on a run's device card: whom the agent works for, the agent's owner, or whoever manages
 * agents. Null: the run waits on no device.
 */
export async function deviceWaitAction(
  deps: DeviceWaitDeps,
  actorId: string,
  orgId: string,
  runId: string,
  action: "retry" | "stop",
): Promise<{ resumed: boolean }> {
  const membership = await getMembership(deps.db, actorId, orgId);
  if (!membership) throw new NotFoundError("Run not found");
  const [w] = await openDeviceWaits(deps.db, orgId, { runId });
  if (!w) throw new NotFoundError("This run isn't waiting for a device");
  const found = await cardOf(deps.db, w.run, w.waitId);
  const agent = await getAgentCached(deps.db, orgId, w.run.agentId);
  const mayAct =
    found?.card.requesterUserId === actorId || agent?.ownerUserId === actorId || can(membership, "manage_agents");
  if (!mayAct) throw new ForbiddenError("Only the person it works for, the agent's owner or an admin can do this");
  const who = (await firstNames(deps.db, [actorId])).get(actorId) ?? "A person";
  const resumed =
    action === "retry"
      ? await endWait(
          deps,
          w,
          "retried",
          (card) =>
            `${who} pressed Try now: check ${nameOf(card)} again and carry on. If it still isn't ready, say so and wait again.`,
        )
      : await endWait(
          deps,
          w,
          "stopped",
          (card) =>
            `${who} stopped the wait for ${nameOf(card)}. Don't wait for it: tell them in one line what you'll do instead, or stop here.`,
        );
  return { resumed };
}

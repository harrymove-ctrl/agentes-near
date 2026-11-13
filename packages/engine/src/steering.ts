import type { PubSub } from "@agenteschat/adapters";
import { type Database, inArray, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { runBrainOf } from "./brains/select";
import { cancelRun, interruptRun } from "./cancel";
import { frontOfLine } from "./computer-queue";
import { publishChannelEvent } from "./events";
import { isStopRequest, type Judge } from "./judge";
import { deliverLive } from "./live-steer";
import type { Message } from "./messages";
import { enqueue } from "./outbox";
import { holdsMessages } from "./run-hold";
import { handOnMessages } from "./run-inbox";
import { type AgentRun, computerWaitOf, replyThreadOf } from "./runs";
import type { Talker } from "./talker";
import { onMessageWhileWaiting, type WaitMessageOutcome } from "./waits";

const { agentRuns } = schema;

/**
 * What happens to a person's message that went into an agent's task in
 * progress (one active run per agent and conversation). The message is
 * already queued on the run (`pending_message_ids`); this decides how soon and
 * how it is read, in order:
 *
 * 1. "Parar e mandar" (`now`): the model call stops and the loop reads it.
 * 2. Live delivery (`live-steer.ts`): a computer brain mid-turn gets it at its
 *    next tool boundary instead of at the end of the turn.
 * 3. A run waiting (`waits.ts`): browser help, another agent's answer. The
 *    message may end the wait ("pronto, loguei") or wake the run (the wait
 *    stays open; its result comes later as a notice). Parked waiting for its
 *    computer: look again now. Waiting on something the message can't move
 *    (a secret, a mission's decision, a question for someone else;
 *    `holdsMessages`): the message leaves it for a run of its own; an approval
 *    never takes it at all.
 * 4. The fast reply (`talker.ts`): when the run can't answer soon (waiting, or
 *    deep in a long turn), the agent's conversation layer may answer in a
 *    second or two, or pass.
 * 5. A plain "stop" (the judge): the task is canceled.
 *
 * Nothing here ever grants anything.
 */
export interface SteeringDeps {
  db: Database;
  pubsub: PubSub;
  /** Tells a plain "stop" from a correction (none = never a stop). */
  judge?: Judge;
  /** The conversation layer (none = no fast replies). */
  talker?: Talker;
}

export interface SteeredInput {
  orgId: string;
  userId: string;
  channelId: string;
  message: Message;
  /** The runs it was queued on. */
  runIds: string[];
  /** "Parar e mandar". */
  now: boolean;
}

export async function afterSteered(deps: SteeringDeps, input: SteeredInput) {
  const { orgId, userId, channelId, message, now } = input;
  const runs = await deps.db.select().from(agentRuns).where(inArray(agentRuns.id, input.runIds));
  for (const runId of input.runIds) {
    const active = runs.find((r) => r.id === runId);
    if (!active) continue;
    const threadId = replyThreadOf(active);
    /** Parked waiting for its computer brain, its plan or its budget (`waitingForBrain`). */
    const parked =
      active.status === "waiting_input"
        ? ((active.transcript as { waitingForBrain?: { waitId?: string; code?: string; source?: string } } | null)
            ?.waitingForBrain ?? null)
        : null;
    // Long work paused near a limit is no wait a message moves (`holdsMessages`): it isn't woken for it.
    const brainWait = parked?.code === "usage_pause" ? null : parked;
    // A conversation's catch-up on its plan or budget takes the message and stays in its place in line: a look now
    // would only ask the plan again, early and out of order.
    const usageWait = brainWait?.code === "plan_limit" || brainWait?.code === "budget";
    const computerWait = computerWaitOf(active);
    // Gone from its inbox already, the app heard where it went (`agent.run.read`, `agent.run.redispatched`):
    // a late "steered" would move the receipt back onto this run.
    if (active.pendingMessageIds.includes(message.id)) {
      await publishChannelEvent(deps.pubsub, {
        type: "agent.run.steered",
        channelId,
        threadId,
        runId,
        agentId: active.agentId,
        messageId: message.id,
        ...(now ? { now: true as const } : {}),
        // Into a run waiting for its computer: the message shows that wait, as a reload would.
        ...(computerWait
          ? { computer: computerWait }
          : active.status === "waiting_input" && brainWait?.code === "work_queue"
            ? { computer: "line" as const }
            : {}),
        // On its plan or budget (long work paused near one too, by its `source`), as a reload says (`usageWaitSql`).
        ...(parked?.code === "plan_limit" || parked?.code === "budget" || parked?.code === "usage_pause"
          ? { usage: parked.code === "budget" || parked.source === "budget" ? ("budget" as const) : ("plan" as const) }
          : {}),
      });
    }
    let live = false;
    // Its model call stops and the loop reads the message at once (a running tool finishes first).
    // A computer brain (Claude Code, Codex) can't drop its turn halfway: one whose turn takes messages
    // gets it live and urgent (Claude Code reads it now or at its next tool boundary; Codex's app-server
    // stops the turn and starts the next one with it: `live-steer.ts`); else
    // the task stops for real, and stopping it starts it again from this message
    // (`restartAfterStopAndSend`). Who may not stop it just leaves the message for its next step.
    // The brain this run thinks with (a conversation run may have fallen back to the model brain). A model-brain run
    // reads its inbox at every step: asking it live would only hold the send while its executor is still starting.
    const computer =
      active.status === "running" &&
      (await getAgentCached(deps.db, orgId, active.agentId).then((a) => !!a && runBrainOf(active, a) !== "model"));
    if (now && active.status === "running") {
      if (computer) {
        live = await deliverLive(deps, active, { messageId: message.id, urgent: true }).catch(() => false);
        if (!live) await cancelRun(deps, userId, orgId, runId, { tell: false }).catch(() => undefined);
      } else await interruptRun(deps.pubsub, runId, message.id);
    } else if (computer) {
      live = await deliverLive(deps, active, { messageId: message.id, urgent: false }).catch(() => false);
    }
    // Parked waiting for its computer: look again now. Back (or never really away): the run resumes and reads this
    // message with the rest; still away: it parks again quietly (one answer later).
    else if (active.status === "waiting_input" && (active.waitingMachineId || brainWait) && !usageWait) {
      const wait = brainWait?.waitId;
      if (brainWait?.code === "busy") await frontOfLine(deps.db, active, message.id).catch(() => undefined);
      else
        await enqueue(deps.db, {
          orgId,
          kind: "agent_run.execute",
          payload: { runId, ...(wait ? { wait } : {}) },
          dedupeKey: `agent_run.execute:${runId}:steer:${message.id}`,
          maxAttempts: 4,
        }).catch(() => undefined);
    }
    // What it does to a wait, then the fast reply: after the response (the judge may take a moment), in order.
    const waiting =
      !active.waitingMachineId &&
      !brainWait &&
      (active.status === "waiting_input" || active.status === "waiting_approval");
    // Waiting on something the message can't move (a secret, a mission's decision, a question for someone else; an
    // approval never takes it): the agent doesn't keep it waiting behind that, it answers in a run of its own. Gone from the
    // inbox already (the run handed it on as it paused, or read it first): the run that has it answers, so
    // nothing here speaks for this one either.
    const holds = waiting && (await holdsMessages(deps.db, active, userId));
    if (holds) await handOnMessages(deps.db, deps.pubsub, active, [message.id]).catch(() => null);
    else if (waiting || (deps.talker && !now)) {
      const followUp = async () => {
        let waited: WaitMessageOutcome | null = null;
        if (waiting) {
          waited = await onMessageWhileWaiting(deps, active, message).catch(() => null);
          if (waited) {
            await publishChannelEvent(deps.pubsub, {
              type: "agent.run.wait_message",
              channelId,
              threadId,
              runId,
              agentId: active.agentId,
              messageId: message.id,
              waitKind: waited.waitKind,
              outcome: waited.outcome,
            });
          }
        }
        if (deps.talker && !now) await deps.talker.consider({ run: active, message, live, waited });
      };
      trackStopCheck(followUp());
    }
    // A plain "stop", in any language, cancels the task instead (the judge decides; short messages
    // only). Never in the way of the send: judged after the response, the app hears `stop` then.
    if (deps.judge) trackStopCheck(judgeStop(deps, deps.judge, input, active, threadId));
  }
}

async function judgeStop(
  deps: SteeringDeps,
  judge: Judge,
  input: SteeredInput,
  run: AgentRun,
  threadId: string | null,
) {
  const agentName = (await getAgentCached(deps.db, input.orgId, run.agentId))?.name ?? "the agent";
  const stop = await isStopRequest(judge, {
    orgId: input.orgId,
    text: input.message.body,
    agentName,
    agentId: run.agentId,
    runId: run.id,
  }).catch(() => false);
  if (!stop) return;
  await publishChannelEvent(deps.pubsub, {
    type: "agent.run.steered",
    channelId: input.channelId,
    threadId,
    runId: run.id,
    agentId: run.agentId,
    messageId: input.message.id,
    stop: true,
  });
  // The "stop" itself is not handed on to a new run when the task's unread messages are.
  await cancelRun(deps, input.userId, input.orgId, run.id, { stopMessageId: input.message.id });
}

/** Checks still running after the post returned (stop judge, fast replies). */
const pendingChecks = new Set<Promise<unknown>>();

function trackStopCheck(check: Promise<unknown>) {
  const tracked = check.catch(() => undefined).finally(() => pendingChecks.delete(tracked));
  pendingChecks.add(tracked);
}

/** Resolves once every check started so far is done (and its cancel or reply): for tests and shutdown. */
export async function stopChecksSettled() {
  while (pendingChecks.size > 0) await Promise.all([...pendingChecks]);
}

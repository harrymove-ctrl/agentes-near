import type { PubSub } from "@agenteschat/adapters";
import type { Executor } from "@agenteschat/db";
import { createAgentRuns, type RunTrigger } from "./dispatch";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { insertMessage, type Message, messageView } from "./messages";
import { type Notice, SELF_REPORT_NOTICES } from "./notices";
import { type AgentRun, replyThreadOf } from "./runs";

export interface DeliverNoticeInput {
  orgId: string;
  agentId: string;
  channelId: string;
  /** The thread it belongs to (null for a flat DM or the channel's timeline). */
  threadId: string | null;
  /** Hop of the notice (the run it wakes answers at hop + 1). */
  hop: number;
  /** The stretch it belongs to (ADR 0089): the run's it is for, or null for a root (a routine's report). */
  stretchId: string | null;
  notice: Notice;
  /** Shown to people (a compact card); the agent reads `notice.text`. Defaults to the text. */
  body?: string;
  /** `false`: write the notice only (the run that waits on it reads it some other way). */
  wake?: boolean;
  trigger?: RunTrigger;
  /** It relays what a run read outside (`meta.readOutside`, ADR 0117). */
  readOutside?: boolean;
}

/**
 * The one way an event reaches an agent's conversation: a notice message
 * (agent-authored, `meta.notice`) plus a run, in the caller's transaction.
 * Like a person's message, it joins the agent's active run in that
 * conversation (read at its next step) or starts one; nothing is ever
 * delivered to a run that already ended. A self-report (`SELF_REPORT_NOTICES`)
 * never starts one. Publish with `publishDelivery`
 * after the commit.
 */
export async function deliverNotice(
  tx: Executor,
  input: DeliverNoticeInput,
): Promise<{ message: Message; runs: AgentRun[] }> {
  const message = await insertMessage(tx, {
    orgId: input.orgId,
    channelId: input.channelId,
    threadId: input.threadId ?? undefined,
    author: { type: "agent", agentId: input.agentId, runId: null, hop: input.hop, stretchId: input.stretchId },
    body: input.body ?? input.notice.text,
    meta: { notice: input.notice, ...(input.readOutside ? { readOutside: true } : {}) },
  });
  const wake = input.wake !== false && !SELF_REPORT_NOTICES.includes(input.notice.kind);
  const runs = wake ? await createAgentRuns(tx, message, [input.agentId], input.trigger ?? "mention") : [];
  return { message, runs };
}

/** After the commit: the notice shows up and the agent's working indicator starts. */
export async function publishDelivery(pubsub: PubSub | undefined, delivered: { message: Message; runs: AgentRun[] }) {
  if (!pubsub) return;
  await publishMessageCreated(pubsub, messageView(delivered.message));
  for (const run of delivered.runs) {
    await publishChannelEvent(pubsub, {
      type: "agent.thinking",
      channelId: run.channelId,
      threadId: replyThreadOf(run),
      agentId: run.agentId,
      runId: run.id,
    });
  }
}

export { type Notice, type NoticeKind, noticeText } from "./notices";

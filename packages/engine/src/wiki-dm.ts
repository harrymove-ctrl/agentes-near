import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { deliverNotice, publishDelivery } from "./delivery";
import { openPersonAgentDm } from "./dms";

const { channels, messages } = schema;

/** What the channel's run is told in place of the page: never its title or text. */
export const RESTRICTED_HERE =
  "Part of what was asked is restricted: not everyone in this conversation may see it, so its text isn't available to you here. You are answering the person who asked in your DM with them, right away. Say here, in one short line, that it's restricted and that you're answering by DM, and answer here only what you can without it. Don't guess what it says.";

export interface HeldRun {
  orgId: string;
  agentId: string;
  channelId: string;
  runId: string;
  triggerMessageId: string;
}

/**
 * The person who asked may see what their conversation may not (ADR 0023 addendum): their question goes to the agent's
 * DM with them, where only the two read, and the run it wakes answers there. The server decides this, not the agent:
 * the channel's run never holds the text. Only for a person's own message, so a chain of agents or a routine doesn't
 * open a DM nobody asked for, and once per run. Reports whether the person will get a DM.
 */
export async function sendHeldToDm(deps: { db: Database; pubsub?: PubSub }, run: HeldRun): Promise<boolean> {
  const { db } = deps;
  const [asked] = await db
    .select({
      authorType: messages.authorType,
      authorUserId: messages.authorUserId,
      body: messages.body,
      hop: messages.hop,
      stretchId: messages.stretchId,
      where: channels.name,
      kind: channels.kind,
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
  if (asked?.authorType !== "person" || !asked.authorUserId || asked.kind === "dm") return false;
  const userId = asked.authorUserId;
  const delivered = await db.transaction(async (tx) => {
    const dm = await openPersonAgentDm(tx, run.orgId, userId, run.agentId);
    const [sent] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, run.orgId),
          eq(messages.channelId, dm.id),
          sql`${messages.meta}->'notice'->'refs'->>'heldFrom' = ${run.runId}`,
        ),
      )
      .limit(1);
    if (sent) return null;
    return deliverNotice(tx, {
      orgId: run.orgId,
      agentId: run.agentId,
      channelId: dm.id,
      threadId: null,
      hop: asked.hop,
      stretchId: asked.stretchId,
      // A kind the apps already keep out of the conversation: people see the answer, not this.
      notice: {
        kind: "agent_note",
        from: "the person in this DM",
        text: `They asked this in ${asked.where ? `#${asked.where}` : "a conversation"}: "${asked.body}"\nThe answer uses restricted wiki content that not everyone there may see, so it comes here, where only you two read. Answer them in full.`,
        refs: { runId: run.runId, heldFrom: run.runId },
      },
    });
  });
  if (delivered) await publishDelivery(deps.pubsub, delivered);
  return true;
}

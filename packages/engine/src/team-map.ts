import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { proposeSettings, type SettingsProposalCard } from "./context/proposals";
import { openPersonAgentDm } from "./dms";
import { NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import { insertMessage, messageView } from "./messages";
import { requirePermission } from "./organizations";
import { ensureRightHand, RIGHT_HAND } from "./right-hand";
import { bodyCode } from "./run-tools";
import type { WantedLine } from "./settings-proposals";
import { SETTINGS_PROPOSAL_CARD } from "./setup-tools";

const { channelMembers, channels } = schema;

/**
 * The team map's drag (ADR 0148): an agent dropped on another channel becomes the right hand's settings card in the
 * person's DM with it, a join row and, when it came from a channel, a leave row, decided like any other card (ADR
 * 0137 §4). It joins answering as it did where it was. Nothing changes until someone who may applies it.
 */
export async function proposeChannelMove(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  input: { agentId: string; fromChannelId: string | null; toChannelId: string; reason: string },
): Promise<{ channelId: string; messageId: string; rightHandId: string }> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "read");
  if (input.fromChannelId === input.toChannelId) throw new ValidationError("It is already there");
  const [rightHand] = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, RIGHT_HAND)));
  const rightHandId = rightHand?.id ?? (await ensureRightHand(db, orgId));
  if (!rightHandId) throw new NotFoundError("The team's right hand isn't here");
  const ids = [input.toChannelId, ...(input.fromChannelId ? [input.fromChannelId] : [])];
  const named = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), inArray(channels.id, ids), isNull(channels.deletedAt)));
  const nameOf = (id: string) => named.find((c) => c.id === id)?.name;
  const toName = nameOf(input.toChannelId);
  if (!toName || (input.fromChannelId && !nameOf(input.fromChannelId))) throw new NotFoundError("Channel not found");
  const [seat] = input.fromChannelId
    ? await db
        .select({ autoReply: channelMembers.autoReply })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, input.fromChannelId), eq(channelMembers.agentId, input.agentId)))
    : [];
  const lines: WantedLine[] = [
    { field: "channel_add", channelId: input.toChannelId, to: seat?.autoReply ?? true, label: { to: `#${toName}` } },
  ];
  if (input.fromChannelId)
    lines.push({
      field: "channel_remove",
      channelId: input.fromChannelId,
      to: null,
      label: { to: `#${nameOf(input.fromChannelId)}` },
    });
  const { proposals, skipped } = await proposeSettings(
    { db },
    {
      orgId,
      agentId: rightHandId,
      targets: [{ agentId: input.agentId, lines }],
      rationale: input.reason.trim(),
      requesterId: userId,
    },
  );
  // A move whose join row was refused (a channel the person can't see, say) would be a bare leave: refuse it whole.
  const joins = proposals.some((p) => p.settings?.some((l) => l.field === "channel_add"));
  if (!joins) {
    if (proposals.length > 0)
      await db.delete(schema.contextProposals).where(
        inArray(
          schema.contextProposals.id,
          proposals.map((p) => p.id),
        ),
      );
    throw new ValidationError(skipped.join(" ") || "Nothing to change");
  }
  const dm = await openPersonAgentDm(db, orgId, userId, rightHandId);
  const card: SettingsProposalCard = {
    kind: "settings_proposal",
    forUserId: userId,
    proposalIds: proposals.map((p) => p.id),
  };
  const [agent] = await db
    .select({ name: schema.agents.name })
    .from(schema.agents)
    .where(eq(schema.agents.id, input.agentId));
  const who = agent?.name ?? "";
  const message = await insertMessage(db, {
    orgId,
    channelId: dm.id,
    author: { type: "agent", agentId: rightHandId, runId: null, hop: 0, stretchId: null },
    body: `Proposed a change to ${who}: ${input.reason.trim()}`,
    meta: { ...bodyCode(SETTINGS_PROPOSAL_CARD, { names: who }), actionCard: card },
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return { channelId: dm.id, messageId: message.id, rightHandId };
}

import type { PubSub } from "@agenteschat/adapters";
import { and, arrayOverlaps, type Database, eq, inArray, isNotNull, isNull, ne, schema } from "@agenteschat/db";
import { publishChannelEvent } from "./events";

const { contextItems, messages } = schema;

/**
 * "O agente estudando": what an agent saved to its memory from a person's
 * message (the item lists the message in `source_ids`). Shown as a mark in
 * that message's reaction row. Only items whose channels are all the
 * message's own channel: whoever reads the message may read the item
 * (an item that also draws on other channels stays out).
 */
export interface MessageMemory {
  id: string;
  agentId: string;
  kind: "fact" | "preference" | "decision" | "note" | "lesson";
  text: string;
  createdAt: string;
}

const SHOWN = ["fact", "preference", "decision", "note", "lesson"] as const;

type Source = { id: string; channelId: string; authorType: string };

/** Memories sourced from these messages (people's only), by message id; one batch query. */
export async function memoriesFor(
  db: Database,
  orgId: string,
  list: readonly Source[],
): Promise<Map<string, MessageMemory[]>> {
  const out = new Map<string, MessageMemory[]>();
  const people = list.filter((m) => m.authorType === "person");
  if (people.length === 0) return out;
  const byId = new Map(people.map((m) => [m.id, m]));
  const rows = await db
    .select({
      id: contextItems.id,
      agentId: contextItems.agentId,
      kind: contextItems.kind,
      content: contextItems.content,
      sourceIds: contextItems.sourceIds,
      channelIds: contextItems.channelIds,
      createdAt: contextItems.createdAt,
    })
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.status, "active"),
        isNotNull(contextItems.agentId),
        isNull(contextItems.supersededBy),
        // What the agent learned on its own stays quiet: a receipt with Undo, no mark (ADR 0120).
        ne(contextItems.createdByKind, "agent"),
        inArray(contextItems.kind, [...SHOWN]),
        arrayOverlaps(contextItems.sourceIds, [...byId.keys()]),
      ),
    );
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const row of rows) {
    for (const sourceId of row.sourceIds) {
      const m = byId.get(sourceId);
      if (!m || !row.agentId || !row.channelIds.every((c) => c === m.channelId)) continue;
      const view: MessageMemory = {
        id: row.id,
        agentId: row.agentId,
        kind: row.kind as MessageMemory["kind"],
        text: row.content,
        createdAt: row.createdAt.toISOString(),
      };
      out.set(m.id, [...(out.get(m.id) ?? []), view]);
    }
  }
  return out;
}

/**
 * An agent memory was saved (or changed) from people's messages: everyone in
 * the channel hears `message.memories` with that message's current marks.
 */
export async function announceMessageMemories(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  item: { agentId: string | null; sourceIds: string[] },
) {
  if (!deps.pubsub || !item.agentId || item.sourceIds.length === 0) return;
  const sources = await deps.db
    .select({ id: messages.id, channelId: messages.channelId, authorType: messages.authorType })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), inArray(messages.id, item.sourceIds), eq(messages.authorType, "person")));
  if (sources.length === 0) return;
  const marks = await memoriesFor(deps.db, orgId, sources);
  for (const m of sources) {
    await publishChannelEvent(deps.pubsub, {
      type: "message.memories",
      channelId: m.channelId,
      messageId: m.id,
      memories: marks.get(m.id) ?? [],
    });
  }
}

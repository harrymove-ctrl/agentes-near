import { and, type Executor, eq, schema } from "@agenteschat/db";

const { messages } = schema;

/**
 * The agent whose card a person acted from (the audit's `via`, ADR 0137 §4): the author of `messageId` when its
 * `meta.actionCard` is of `kind` and names what was done (`names`). Null otherwise, so a made-up id adds nothing.
 */
export async function cardVia(
  db: Executor,
  orgId: string,
  messageId: string | null | undefined,
  kind: string,
  names: (params: Record<string, unknown>) => boolean,
): Promise<string | null> {
  if (!messageId || !/^[0-9a-f-]{36}$/i.test(messageId)) return null;
  const [row] = await db
    .select({ agentId: messages.authorAgentId, meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  const card = row?.meta.actionCard as { kind?: unknown; params?: unknown } | undefined;
  if (!row?.agentId || card?.kind !== kind || !card.params || typeof card.params !== "object") return null;
  return names(card.params as Record<string, unknown>) ? row.agentId : null;
}

/** An approvals card (`offer_approvals`) that lists `approvalId`. */
export const approvalCardVia = (
  db: Executor,
  orgId: string,
  messageId: string | null | undefined,
  approvalId: string,
) =>
  cardVia(db, orgId, messageId, "approvals", (p) => Array.isArray(p.approvalIds) && p.approvalIds.includes(approvalId));

/** A people card (`propose_member_changes`) with a row for `userId`. */
export const memberCardVia = (db: Executor, orgId: string, messageId: string | null | undefined, userId: string) =>
  cardVia(
    db,
    orgId,
    messageId,
    "member_changes",
    (p) => Array.isArray(p.rows) && p.rows.some((r) => (r as { userId?: unknown }).userId === userId),
  );

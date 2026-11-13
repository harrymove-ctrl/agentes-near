import { and, type Database, type Executor, eq, inArray, isNull, schema } from "@agenteschat/db";
import { type MessagePlace, messagePath, parseMessageLink } from "@agenteschat/tokens/message-links";
import { UUID } from "./authority";
import { channelCard } from "./channels";
import { NotFoundError } from "./errors";
import { requirePermission } from "./organizations";

const { messages, channels, channelMembers, users, agents } = schema;

/** This server's address (`PUBLIC_URL`), set at boot with the other process-wide switches (`applyBootSwitches`). */
let base = "http://localhost:3000";

export function setMessageLinkBase(publicUrl: string) {
  base = publicUrl.replace(/\/+$/, "");
}

/** A page of this workspace in the web app (`/team`, `/settings/members`), as an agent links a person to it. */
export const appPageLink = (orgId: string, path: string) => `${base}/org/${orgId}${path}`;

/** The Cloud's domain: an address under it is our own app wherever this server runs. */
const PRODUCT_HOST = "agentes.chat";

/** A loopback `PUBLIC_URL` (a self-host's default): there, on the agent's computer, it is some other app. */
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/;

/**
 * Whether an address or a sentence names our own app: this server's address (`PUBLIC_URL`, unless loopback), or
 * agentes.chat and its subdomains. An email address on those domains (an agent's own mailbox) doesn't count; a URL's
 * `user@` does not hide its host, nor do width forms or an ideographic full stop (browsers read them as dots).
 */
export function namesOwnApp(text: string): boolean {
  const own = new URL(base).hostname;
  const loopback = LOOPBACK.test(own);
  if (!loopback && text.includes(base)) return true;
  const hosts = !loopback && own.includes(".") ? [PRODUCT_HOST, own] : [PRODUCT_HOST];
  return text
    .normalize("NFKC")
    .replace(/[\u3002\uff61]/g, ".")
    .toLowerCase()
    .replace(/:\/\/[^\s/?#@]*@/g, "://")
    .split(/[^\w.@-]+/)
    .filter((word) => !word.includes("@"))
    .map((word) => word.replace(/\.+$/, ""))
    .some((word) => hosts.some((h) => word === h || word.endsWith(`.${h}`)));
}

/** A message's permalink on this server, as agents write it and the apps show it as a pill. */
export const messageLink = (orgId: string, m: MessagePlace) => `${base}${messagePath(orgId, m)}`;

/** The message a tool's input names: its id, or its permalink on this server (of this workspace). */
export function messageIdOf(input: string, orgId: string): string | null {
  const text = input.trim();
  if (UUID.test(text)) return text;
  const link = parseMessageLink(text, [base]);
  return link && link.orgId === orgId ? link.messageId : null;
}

export interface DescribedMessage {
  id: string;
  channelId: string;
  threadId: string | null;
  createdAt: Date;
  body: string;
  meta: Record<string, unknown> | null;
  channelKind: string;
  channelName: string;
  visibility: string;
  /** "Ana" for a person, "Theo (@theo)" for an agent. */
  who: string;
  /** "#general", or "a DM". */
  where: string;
  link: string;
}

/** Messages by id (deleted ones left out) with who wrote them, where, and their links: one query. */
export async function describeMessages(db: Executor, orgId: string, ids: string[]): Promise<DescribedMessage[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      threadId: messages.threadId,
      createdAt: messages.createdAt,
      body: messages.body,
      meta: messages.meta,
      channelKind: channels.kind,
      channelName: channels.name,
      visibility: channels.visibility,
      userName: users.name,
      agentName: agents.name,
      agentHandle: agents.handle,
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(eq(messages.orgId, orgId), inArray(messages.id, [...new Set(ids)]), isNull(messages.deletedAt)));
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    threadId: r.threadId,
    createdAt: r.createdAt,
    body: r.body,
    meta: r.meta ?? null,
    channelKind: r.channelKind,
    channelName: r.channelName,
    visibility: r.visibility,
    who: r.userName ?? (r.agentName ? `${r.agentName} (@${r.agentHandle})` : "unknown"),
    where: r.channelKind === "dm" ? "a DM" : `#${r.channelName}`,
    link: messageLink(orgId, r),
  }));
}

/** A pasted message link's pill (`messageCard`): where the message is and who wrote it, never what it says. */
export interface MessageCard {
  id: string;
  channelId: string;
  /** The thread a reply is in; null for any other message. */
  threadId: string | null;
  kind: "channel" | "dm";
  /** The channel's name, or who else is in the DM (people and agents, without the viewer). */
  name: string;
  author: string;
}

/**
 * A message link's pill for `userId`: a channel's message when they can see that channel (its `#channel` card's rule),
 * a DM's only when they are in it. Anything else is not found, so the pill names nothing of a place they can't see.
 */
export async function messageCard(
  db: Database,
  userId: string,
  orgId: string,
  messageId: string,
): Promise<MessageCard> {
  await requirePermission(db, userId, orgId, "read");
  const [m] = await describeMessages(db, orgId, [messageId]);
  if (!m || (m.channelKind !== "channel" && m.channelKind !== "dm")) throw new NotFoundError("Message not found");
  const card = (name: string): MessageCard => ({
    id: m.id,
    channelId: m.channelId,
    threadId: m.threadId && m.threadId !== m.id ? m.threadId : null,
    kind: m.channelKind as "channel" | "dm",
    name,
    author: m.who.replace(/ \(@[^)]*\)$/, ""),
  });
  if (m.channelKind === "channel") {
    const channel = await channelCard(db, userId, orgId, m.channelId).catch(() => null);
    if (!channel || channel.archived) throw new NotFoundError("Message not found");
    return card(channel.name);
  }
  const members = await db
    .select({ userId: channelMembers.userId, userName: users.name, agentName: agents.name })
    .from(channelMembers)
    .leftJoin(users, eq(users.id, channelMembers.userId))
    .leftJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, m.channelId)));
  if (!members.some((r) => r.userId === userId)) throw new NotFoundError("Message not found");
  const others = members.filter((r) => r.userId !== userId).flatMap((r) => r.userName ?? r.agentName ?? []);
  return card(others.join(", "));
}

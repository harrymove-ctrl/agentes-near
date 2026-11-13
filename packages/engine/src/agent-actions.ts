import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNull, schema } from "@agenteschat/db";
import { publishChannelEvent } from "./events";
import { personBehindCall } from "./requester";
import type { ToolContext } from "./tools/types";

const { agentActions, messages } = schema;

/**
 * Act with undo (ADR 0037 round 2). Internal, reversible changes an agent
 * makes with its tools are done without asking; the run's reply carries a
 * receipt per change with "Desfazer" for this long. Every undo or redo
 * opens the window again from that moment.
 */
export const UNDO_WINDOW_MS = 5 * 60_000;

/**
 * What an agent did. Covered: issues (created, fields changed, assigned),
 * memory (saved, changed, forgotten), routines (created, changed, deleted), an agent
 * added to a channel, a channel created, wiki pages (created, edited), threads
 * (renamed, closed). Merge, deploy, rollback, anything that leaves the organization
 * and deletes that can't be restored keep asking (approvals). A merge in a repository the agent merges in without
 * asking only has its receipt (`final`: nothing undoes it). The API's enum is this list. The apps keep their own
 * copy (`@agenteschat/client`'s `AGENT_ACTION_KINDS`), and a test keeps the two the same.
 */
export const AGENT_ACTION_KINDS = [
  "issue.created",
  "issue.updated",
  "issue.assigned",
  "memory.saved",
  "memory.updated",
  "memory.forgotten",
  "routine.created",
  "routine.updated",
  "routine.deleted",
  "channel.agent_added",
  "channel.created",
  "wiki.page_created",
  "wiki.page_edited",
  "thread.renamed",
  "thread.closed",
  "skill.created",
  "skill.updated",
  /** A teammate's settings changed from the right hand's card (ADR 0137): by the person who clicked, not by an agent. */
  "agent.settings_changed",
  "pr.merged",
  /** A change from the right hand's catalog (`workspace-actions.ts`, `params.action` says which), at once or from its card. */
  "workspace.changed",
] as const;
export type AgentActionKind = (typeof AGENT_ACTION_KINDS)[number];

/** Built-in tools whose changes are receipts with Undo (no approval; "What you can do" lists them). */
export const UNDOABLE_TOOLS = new Set([
  "create_issue",
  "update_issue",
  "remember",
  "update_memory",
  "forget",
  "create_routine",
  "update_routine",
  "delete_routine",
  "add_agent_to_channel",
  "create_channel",
  "create_wiki_page",
  "update_wiki_page",
  "link_to_wiki",
  "update_thread",
  "save_how_to",
  "update_skill",
]);

export type AgentActionTargetType =
  | "issue"
  | "memory"
  | "routine"
  | "channel"
  | "wiki_page"
  | "thread"
  | "skill"
  | "agent"
  | "repository"
  | "role"
  | "person"
  | "workspace";

/** What the change was made to, with enough to label it ("#23 · Prompt…"). */
export interface AgentActionTarget {
  type: AgentActionTargetType;
  id: string;
  /** Issues. */
  number?: number;
  /** Issue, routine, wiki page or thread title; channel name (without `#`); skill name. */
  title?: string;
  /** Wiki pages. */
  slug?: string;
}

/** A value of a receipt's sentence: plain values, or a small object the app renders (a schedule's rule). */
export type AgentActionParam = string | number | boolean | null | string[] | { [key: string]: unknown };

/** Values for the receipt's sentence (`agentActions.{kind}` in the app's i18n). */
export type AgentActionParams = Record<string, AgentActionParam>;

/** One receipt, as the app shows it under the agent's message. */
export interface AgentActionView {
  id: string;
  kind: AgentActionKind;
  agentId: string;
  /** The message that carries it (null until the reply is posted). */
  messageId: string | null;
  /** The person the agent worked for: they, admins and the agent's owner may undo. */
  requestedByUserId: string | null;
  target: AgentActionTarget;
  params: AgentActionParams;
  createdAt: string;
  /** Desfazer (or Refazer, once undone) works until then. */
  undoableUntil: string;
  /** Set while undone (Refazer clears it). */
  undoneAt: string | null;
  undoneByUserId: string | null;
  redoneAt: string | null;
}

/** What a tool records: the kind, its target, the receipt's params and what inverting needs. */
export interface ActionRecord {
  kind: AgentActionKind;
  target: AgentActionTarget;
  params?: AgentActionParams;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Nothing undoes it: its receipt is plain history from the start. */
  final?: boolean;
}

type Row = typeof agentActions.$inferSelect;

export const actionView = (r: Row): AgentActionView => {
  const { type, id, ...label } = r.target as Record<string, unknown>;
  return {
    id: r.id,
    kind: r.kind as AgentActionKind,
    agentId: r.agentId,
    messageId: r.messageId,
    requestedByUserId: r.requestedByUserId,
    target: { type: r.targetType as AgentActionTargetType, id: r.targetId, ...(label as object) },
    params: r.params as AgentActionParams,
    createdAt: r.createdAt.toISOString(),
    undoableUntil: r.undoableUntil.toISOString(),
    undoneAt: r.undoneAt?.toISOString() ?? null,
    undoneByUserId: r.undoneByUserId,
    redoneAt: r.redoneAt?.toISOString() ?? null,
  };
};

/** Writes receipts for a run's change (call it in the change's transaction). Returns their ids. */
export async function recordAgentActions(
  db: Executor,
  ctx: Pick<ToolContext, "orgId" | "agentId" | "runId" | "channelId" | "triggerMessageId">,
  records: ActionRecord[],
  now = new Date(),
): Promise<string[]> {
  if (records.length === 0 || !ctx.runId) return [];
  // Who asked for the change (`authority.ts`); nobody for a routine's or an unattended run.
  const requestedByUserId = await personBehindCall({ ...ctx, db });
  const rows = await db
    .insert(agentActions)
    .values(
      records.map((r, i) => {
        const { type, id, ...label } = r.target;
        return {
          orgId: ctx.orgId,
          runId: ctx.runId,
          agentId: ctx.agentId,
          channelId: ctx.channelId,
          requestedByUserId,
          kind: r.kind,
          targetType: type,
          targetId: id,
          target: label,
          params: r.params ?? {},
          before: r.before ?? null,
          after: r.after ?? null,
          // Several in one call keep their order.
          createdAt: new Date(now.getTime() + i),
          undoableUntil: new Date(now.getTime() + i + (r.final ? 0 : UNDO_WINDOW_MS)),
        };
      }),
    )
    .returning({ id: agentActions.id });
  return rows.map((r) => r.id);
}

/**
 * Runs a tool's change and records what it did in the same transaction: a
 * change without its receipt (or the reverse) never commits. Outside a run
 * (a mission task's bridge call) nothing is recorded.
 */
export async function actWithUndo<T>(
  ctx: ToolContext,
  change: (db: Database) => Promise<T>,
  /** Reads with `db` (the transaction): another handle would wait on it. */
  describe: (
    result: T,
    db: Database,
  ) => ActionRecord | ActionRecord[] | null | Promise<ActionRecord | ActionRecord[] | null>,
): Promise<T> {
  if (!ctx.runId) return change(ctx.db);
  return ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const result = await change(db);
    const described = await describe(result, db);
    const records = described === null ? [] : Array.isArray(described) ? described : [described];
    await recordAgentActions(db, ctx, records);
    return result;
  });
}

/** The run's receipts not yet on a message go on this one (its reply). Returns how many. */
export async function linkRunActions(db: Executor, orgId: string, runId: string, messageId: string) {
  const rows = await db
    .update(agentActions)
    .set({ messageId })
    .where(and(eq(agentActions.orgId, orgId), eq(agentActions.runId, runId), isNull(agentActions.messageId)))
    .returning({ id: agentActions.id });
  return rows.length;
}

/** Receipts of these messages, oldest first, by message id (one query). */
export async function actionsFor(
  db: Executor,
  orgId: string,
  messageIds: string[],
): Promise<Map<string, AgentActionView[]>> {
  const out = new Map<string, AgentActionView[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.orgId, orgId), inArray(agentActions.messageId, messageIds)))
    .orderBy(asc(agentActions.createdAt), asc(agentActions.id));
  for (const r of rows) {
    if (!r.messageId) continue;
    out.set(r.messageId, [...(out.get(r.messageId) ?? []), actionView(r)]);
  }
  return out;
}

/** Everyone in the channel hears `message.actions` with the message's receipts now. */
export async function publishMessageActions(deps: { db: Database; pubsub?: PubSub }, orgId: string, messageId: string) {
  if (!deps.pubsub) return;
  const [m] = await deps.db
    .select({ channelId: messages.channelId, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  if (!m) return;
  const actions = (await actionsFor(deps.db, orgId, [messageId])).get(messageId) ?? [];
  await publishChannelEvent(deps.pubsub, {
    type: "message.actions",
    channelId: m.channelId,
    threadId: m.threadId,
    messageId,
    actions,
  });
}

/** The receipt in English, for the agent's own history ("created issue #23 "Title""). */
export function describeAction(a: Pick<AgentActionView, "kind" | "target" | "params">): string {
  const t = a.target;
  const title = t.title ? ` "${t.title}"` : "";
  const issue = `issue #${t.number ?? "?"}${title}`;
  const p = a.params;
  switch (a.kind) {
    case "issue.created":
      return `created ${issue}`;
    case "issue.updated":
      return `changed ${Array.isArray(p.fields) ? p.fields.join(", ") : "fields"} of ${issue}`;
    case "issue.assigned":
      return `assigned ${issue}${typeof p.assigneeName === "string" ? ` to ${p.assigneeName}` : ""}`;
    case "memory.saved":
      return `saved to ${p.rule === true ? "my rules" : "memory"}: "${String(p.text ?? "").slice(0, 120)}"`;
    case "memory.updated":
      return `changed a memory to "${String(p.text ?? "").slice(0, 120)}"`;
    case "memory.forgotten":
      return `forgot a memory: "${String(p.text ?? "").slice(0, 120)}"`;
    case "routine.created":
      return `created the routine${title}`;
    case "routine.updated":
      return `changed the routine${title}`;
    case "routine.deleted":
      return `deleted the routine${title}`;
    case "channel.agent_added":
      return `added ${typeof p.agentName === "string" ? p.agentName : "an agent"} to #${t.title ?? "?"}`;
    case "channel.created":
      return `created the channel #${t.title ?? "?"}`;
    case "wiki.page_created":
      return `created the wiki page${title}`;
    case "wiki.page_edited":
      return `edited the wiki page${title}`;
    case "thread.renamed":
      return `renamed the thread to "${String(p.to ?? "")}"`;
    case "thread.closed":
      return `closed the thread${title}`;
    case "skill.created":
      return `made the skill${title} from its how-tos`;
    case "skill.updated":
      return `changed the skill${title}`;
    case "agent.settings_changed":
      return `changed ${Array.isArray(p.fields) ? p.fields.join(", ") : "settings"} of ${t.title ?? "an agent"} from your card`;
    case "pr.merged":
      return `merged ${p.number ? `PR #${p.number}` : `${String(p.ref ?? "a branch")}`} in ${String(p.repo ?? t.title ?? "a repository")}`;
    case "workspace.changed":
      return `did ${String(p.action ?? "a change")}${t.title ? ` on ${t.title}` : ""}`;
  }
}

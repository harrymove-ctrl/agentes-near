import { GIF_ID_PATTERN, type GifProvider, type PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { mentionsEveryone } from "@agenteschat/i18n/everyone";
import { CHANNEL_REF } from "@agenteschat/ui/channel-refs";
import { plainLine } from "@agenteschat/ui/markdown";
import { type AgentActionView, actionsFor } from "./agent-actions";
import { currentHandles } from "./agents";
import { withDeletedArtifacts } from "./artifacts";
import { audienceSql, notifyBlocked } from "./audience";
import { postRefusal, requireChannelAccess } from "./channels";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import {
  type DecidedBy,
  decidedByOf,
  MENTION_NEEDED,
  publishChannelEvent,
  publishMessageCreated,
  publishUserEvent,
} from "./events";
import { cutText } from "./format";
import { type Judge, personMentionAddressees } from "./judge";
import { PLATFORM_CAP } from "./limits";
import { isMediaAfterReply, isStickerMood, type MessageMedia, mediaOf, mediaSettings, type StickerMood } from "./media";
import { type MessageMemory, memoriesFor } from "./message-memories";
import { readableBody, voiceOf } from "./message-preview";
import { quietNoticeSql } from "./notices";
import { can } from "./organizations";
import { maySql } from "./permissions";
import { afterReplyAnswered } from "./questions";
import { rightHandReaches } from "./right-hand";
import { inChannelRun, waitsOnUsage, workKeepsThread, workTakesPersonMessage } from "./run-scope";
import { computerWaitSql, KEPT_ON_HOLD, NO_AI, outageParkedSql, passedSql, runErrorDetail, usageWaitSql } from "./runs";
import { accountInUse, closedRefusal } from "./standing";
import { afterSteered } from "./steering";
import type { Talker } from "./talker";
import { admitTaskAgents, taskReaderSql } from "./task-access";
import { WEB_USAGE_PROVIDER } from "./web-tools";
import { syncWikiLinks, withWikiLinks } from "./wiki-links";
import { type WorkView, workViews } from "./works";

export { stopChecksSettled } from "./steering";

const { messages, agents, channelMembers, channels, agentRuns, outbox, agentQuestions, threads } = schema;

export type Message = typeof messages.$inferSelect;

export const MAX_MESSAGE_LENGTH = 40_000;

export interface MessageView {
  id: string;
  channelId: string;
  threadId: string | null;
  author: { type: "person" | "agent"; id: string | null };
  body: string;
  mentionedAgentIds: string[];
  /** People mentioned by handle (`@ana`) who are in the channel. */
  mentionedUserIds: string[];
  agentRunId: string | null;
  /** Structured attachments: `{ approvalId }`, `{ memoryUpdates }`, `{ clientId }`. */
  meta: Record<string, unknown>;
  /** The sender's own id for the optimistic copy (echoed back). */
  clientId: string | null;
  /** Which agents saw it and which answered (in message lists; no router scores). */
  receipts?: Receipts;
  /** Agent messages in lists: model, tokens and cost of the run that wrote it. */
  usage?: MessageUsage;
  /** Only in the sender's own POST response: agents that won't answer them, and why (never stored). */
  notices?: { agentId: string; text: string; code?: string; params?: Record<string, unknown> }[];
  /** Top-level messages with `include=replies`: thread summary and the latest replies. */
  replies?: { count: number; lastAt: string | null; latest: MessageView[] };
  /** In message lists: reactions (`+1`/`-1` or an emoji) and who reacted. */
  reactions?: ReactionCount[];
  /** People's messages: what agents saved to memory from them (the memory mark). */
  memories?: MessageMemory[];
  /** In message lists: `true` when pinned in its channel (absent: not pinned); live via `message.pinned`/`message.unpinned`. */
  pinned?: boolean;
  /**
   * Agents' messages in lists: the changes the agent made with it, as
   * receipts with Undo (ADR 0037 round 2); live via `message.actions`.
   */
  actions?: AgentActionView[];
  /** On a long work's anchor (`meta.longWork`, ADR 0121): its line, live via `agent.work`. */
  longWork?: WorkView;
  createdAt: string;
}

export interface ReactionCount {
  reaction: string;
  /** People and agents together. */
  count: number;
  /** People who reacted. */
  userIds: string[];
  /** Agents who reacted (the `react` tool). */
  agentIds: string[];
}

/** Rows (oldest first) → one entry per reaction, in the order each was first given. */
export function groupReactions(rows: { reaction: string; userId: string | null; agentId: string | null }[]) {
  const out: ReactionCount[] = [];
  for (const row of rows) {
    let found = out.find((x) => x.reaction === row.reaction);
    if (!found) {
      found = { reaction: row.reaction, count: 0, userIds: [], agentIds: [] };
      out.push(found);
    }
    found.count += 1;
    if (row.userId) found.userIds.push(row.userId);
    else if (row.agentId) found.agentIds.push(row.agentId);
  }
  return out;
}

/** `meta.replyTo` of a quote reply: the message it answers, as it was when quoted. */
export interface ReplyRef {
  messageId: string;
  /** The quoted message's thread (null = main timeline). */
  threadId: string | null;
  author: { type: "person" | "agent"; id: string | null };
  authorName: string;
  excerpt: string;
  /** The quoted message's GIF, sticker (ADR 0091) or voice (ADR 0100): a quote of one with no text still says what it was. */
  mediaKind?: MessageMedia["kind"] | "voice";
  /** The original is gone (`withGoneQuotes`, when listed): its words and author go with it. */
  deleted?: true;
}

export const REPLY_EXCERPT_LENGTH = 200;

/** One line of a message for a quote: its plain words, ~200 chars. */
export function replyExcerpt(body: string, max = REPLY_EXCERPT_LENGTH): string {
  const line = plainLine(body, max);
  return line.length > max ? `${cutText(line, max - 1).trimEnd()}…` : line;
}

/** Files a person may attach to one message. */
export const MAX_MESSAGE_ATTACHMENTS = 10;

/** What the app sends for a GIF or a sticker (ADR 0091): only what picks it; the rest is looked up. */
export type MessageMediaInput = { kind: "gif"; id: string } | { kind: "sticker"; agentId: string; mood: StickerMood };

/**
 * Why a GIF or sticker can't be sent: `message.media_off` (GIFs or stickers off here, or no GIF provider now) and
 * `message.media_not_found` (no such GIF at the workspace's rating, or no such agent here). The route answers 422.
 */
export const MEDIA_REFUSALS: readonly string[] = ["message.media_off", "message.media_not_found"];

/** Model and tokens of the run that wrote an agent message (no money: everyone in the channel sees it). */
export interface MessageUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export const messageView = (m: Message): MessageView => ({
  id: m.id,
  channelId: m.channelId,
  threadId: m.threadId,
  author: { type: m.authorType, id: m.authorType === "person" ? m.authorUserId : m.authorAgentId },
  body: m.body,
  mentionedAgentIds: m.mentionedAgentIds,
  mentionedUserIds: m.mentionedUserIds,
  agentRunId: m.agentRunId,
  meta: m.meta,
  clientId: typeof m.meta.clientId === "string" ? m.meta.clientId : null,
  createdAt: m.createdAt.toISOString(),
});

export interface Receipts {
  seenBy: string[];
  pickedBy: string[];
  handled: {
    agentId: string;
    /** The run answering it: its own, the task it was steered into, or the run its answer resumed. */
    runId: string;
    status: "queued" | "running" | "waiting_approval" | "waiting_input" | "done" | "failed" | "canceled";
    /** `no_ai`: it failed for want of an AI to think with. */
    reason?: typeof NO_AI;
    /** `failed` for another reason: why, for the app to word (`runErrorDetail`). */
    errorCode?: string;
    errorParams?: Record<string, string>;
    /** `waiting_input` parked on a provider outage: it retries by itself. */
    outage?: true;
    /** `waiting_input` for its computer: in line for room (`queued`) or for it to come back (`away`). */
    computer?: "queued" | "away" | "line";
    /** `waiting_input` on its plan's limit or its budget: it answers when that renews. */
    usage?: "plan" | "budget";
    /** It ended without answering: passed and posted nothing, or canceled before it started. */
    passed?: true;
  }[];
  /** Agents it mentions that won't answer (they don't reply to this person, or a mission's agent). */
  blocked: string[];
  /** Agents it only mentions as part of the request to another agent: no run, by design (not blocked). */
  referenced?: string[];
  /** Routed to nobody: the organization had no AI connected. */
  noAi?: true;
  /** Routed to nobody: the workspace used up its platform AI for the month, so only @mentions start agents. */
  platformCap?: true;
  /** The router's step that picked (ADR 0074); absent for a decision made before the chain. */
  decidedBy?: DecidedBy;
  /** No step could read it and no rule fit: only a mention reaches an agent. */
  reason?: typeof MENTION_NEEDED;
}

/** `meta.referencedAgentIds`: agents a person's message only references (no run; see `classifyAddressees`). */
export const referencedOf = (meta: Record<string, unknown>) =>
  Array.isArray(meta.referencedAgentIds)
    ? meta.referencedAgentIds.filter((v): v is string => typeof v === "string")
    : [];

/**
 * Receipts for messages, from what is already stored: the routing decision
 * (candidates = seen), mentions, the runs each message triggered, the task in
 * progress it was steered into (`meta.steeredRunIds`) and the run its answer
 * resumed (`meta.answersQuestionId`). Router off or no candidates → empty receipts.
 */
export async function receiptsFor(db: Database, orgId: string, list: Message[]): Promise<Map<string, Receipts>> {
  const out = new Map<string, Receipts>();
  const ids = list.map((m) => m.id);
  if (ids.length === 0) return out;
  const steeredOf = (m: Message) =>
    Array.isArray(m.meta.steeredRunIds) ? m.meta.steeredRunIds.filter((v): v is string => typeof v === "string") : [];
  const questionOf = (m: Message) => (typeof m.meta.answersQuestionId === "string" ? m.meta.answersQuestionId : null);
  const steeredIds = [...new Set(list.flatMap(steeredOf))];
  const questionIds = [...new Set(list.map(questionOf).filter((v): v is string => v !== null))];
  const runFields = {
    id: schema.agentRuns.id,
    triggerMessageId: schema.agentRuns.triggerMessageId,
    agentId: schema.agentRuns.agentId,
    status: schema.agentRuns.status,
    error: schema.agentRuns.error,
    outage: outageParkedSql,
    computer: computerWaitSql,
    usage: usageWaitSql,
    passed: passedSql,
  };
  const [decisions, runs, steeredRuns, answeredRuns] = await Promise.all([
    db
      .select({
        messageId: schema.routingDecisions.messageId,
        candidates: schema.routingDecisions.candidates,
        error: schema.routingDecisions.error,
        strategy: schema.routingDecisions.strategy,
        selected: schema.routingDecisions.selectedAgentIds,
      })
      .from(schema.routingDecisions)
      .where(and(eq(schema.routingDecisions.orgId, orgId), inArray(schema.routingDecisions.messageId, ids))),
    db
      .select(runFields)
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, orgId), inArray(schema.agentRuns.triggerMessageId, ids))),
    steeredIds.length
      ? db
          .select(runFields)
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.orgId, orgId), inArray(schema.agentRuns.id, steeredIds)))
      : Promise.resolve([]),
    questionIds.length
      ? db
          .select({ questionId: agentQuestions.id, ...runFields })
          .from(agentQuestions)
          .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, agentQuestions.runId))
          .where(and(eq(agentQuestions.orgId, orgId), inArray(agentQuestions.id, questionIds)))
      : Promise.resolve([]),
  ]);
  const seen = new Map(decisions.map((d) => [d.messageId, d.candidates.map((c) => c.agentId)]));
  const noAi = new Set(decisions.filter((d) => d.error === NO_AI).map((d) => d.messageId));
  const capped = new Set(decisions.filter((d) => d.error === PLATFORM_CAP).map((d) => d.messageId));
  const strategyOf = new Map(decisions.map((d) => [d.messageId, d.strategy]));
  // An agent's mentions the judge was sure need nothing (`delegatedAgents`); the ones it woke that a stretch's limit
  // held are its pause card's to explain.
  const handedOff = new Map(
    decisions.filter((d) => d.strategy.startsWith("mention-")).map((d) => [d.messageId, d.selected]),
  );
  const steeredById = new Map(steeredRuns.map((r) => [r.id, r]));
  const answeredByQuestion = new Map(answeredRuns.map((r) => [r.questionId, r]));
  for (const m of list) {
    const answered = answeredByQuestion.get(questionOf(m) ?? "");
    const all = [
      ...runs.filter((r) => r.triggerMessageId === m.id),
      ...steeredOf(m).flatMap((id) => steeredById.get(id) ?? []),
      ...(answered ? [answered] : []),
    ];
    // One entry per agent (its own run first).
    const mine = all.filter((r, i) => all.findIndex((o) => o.agentId === r.agentId) === i);
    const picked = new Set(mine.map((r) => r.agentId));
    const seenBy = [...new Set([...(seen.get(m.id) ?? []), ...m.mentionedAgentIds, ...picked])];
    const selected = m.authorType === "agent" ? handedOff.get(m.id) : undefined;
    const referenced = (
      selected ? m.mentionedAgentIds.filter((id) => !selected.includes(id)) : referencedOf(m.meta)
    ).filter((id) => !picked.has(id));
    out.set(m.id, {
      seenBy,
      pickedBy: [...picked],
      handled: mine.map((r) => ({
        agentId: r.agentId,
        runId: r.id,
        // Asking its computer from the line it still waits, as `computer` says.
        status: r.computer === "queued" ? ("waiting_input" as const) : r.status,
        ...(r.error === NO_AI ? { reason: NO_AI } : {}),
        ...(r.status === "failed" && r.error !== NO_AI ? runErrorDetail(r.error) : {}),
        ...(r.outage ? { outage: true as const } : {}),
        ...(r.computer ? { computer: r.computer } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
        ...(r.passed ? { passed: true as const } : {}),
      })),
      // A person's mention always starts, steers or resumes a run, unless that agent can't answer them
      // or the message only references it.
      blocked:
        m.authorType === "person"
          ? m.mentionedAgentIds.filter((id) => !picked.has(id) && !referenced.includes(id))
          : [],
      ...(referenced.length > 0 ? { referenced } : {}),
      ...(noAi.has(m.id) ? { noAi: true as const } : {}),
      ...(strategyOf.get(m.id) === KEPT_ON_HOLD ? { kept: true as const } : {}),
      ...(capped.has(m.id) ? { platformCap: true as const } : {}),
      ...decisionOf(strategyOf.get(m.id), m.authorUserId),
    });
  }
  return out;
}

/** What a routing decision's `strategy` tells a receipt: who picked, or that nobody could. */
function decisionOf(strategy: string | undefined, authorUserId: string | null): Pick<Receipts, "decidedBy" | "reason"> {
  if (strategy === undefined) return {};
  if (strategy === "none") return { reason: MENTION_NEEDED };
  const decidedBy = decidedByOf(strategy, authorUserId);
  return decidedBy ? { decidedBy } : {};
}

/** `@handle` tokens in a message, lower-cased and de-duplicated. Emails (`a@b.c`) are not mentions. */
export function parseMentionHandles(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/g)) {
    if (match[2]) found.add(match[2].toLowerCase());
  }
  return [...found];
}

/** Code and links, as the apps show them (a fence nobody closed runs to the end): what stands there stays as written. */
const CODE_OR_LINK = /```[\s\S]*?(?:```|$)|`[^`\n]+`|\[[^\]]*\]\([^)\s]*\)|https?:\/\/\S+/;

/**
 * An agent's text with each `@Full Name` of a person among `members` as their `@handle`, its real mention: agents write
 * the names they read, and a mention is one word. Only the whole name, the longest one first, ignoring case. A name two
 * members share, or the full name of someone outside the conversation (`outsiders`), mentions nobody: it loses its @, or
 * `@Ana` of `@Ana Souza` would reach whoever holds that handle. A name that is also a member's handle already mentions
 * them, and code, links and package scopes (`@ana/kit`) stay as written.
 */
export function mentionsByName(
  body: string,
  members: { name: string | null; handle: string | null; person: boolean }[],
  outsiders: (string | null)[] = [],
): string {
  const key = (name: string) => name.trim().normalize("NFC").toLowerCase();
  const named = new Map<string, typeof members>();
  for (const m of members) {
    const name = key(m.name ?? "");
    if (name) named.set(name, [...(named.get(name) ?? []), m]);
  }
  // One word is a handle's business, whoever holds it.
  const elsewhere = outsiders.map((n) => key(n ?? "")).filter((n) => n.includes(" "));
  if (named.size === 0 && elsewhere.length === 0) return body;
  const handles = new Set(members.map((m) => m.handle));
  const names = [...new Set([...named.keys(), ...elsewhere].flatMap((n) => [n, n.normalize("NFD")]))]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const mention = new RegExp(
    `${CODE_OR_LINK.source}|(^|[^\\p{L}\\p{N}_@./])@(${names})(?![\\p{L}\\p{N}_@/-]|\\.[\\p{L}\\p{N}])`,
    "giu",
  );
  return body.replace(mention, (whole, before: string | undefined, written: string | undefined) => {
    if (written === undefined) return whole;
    const name = key(written);
    if (handles.has(name)) return whole;
    const [one, other] = named.get(name) ?? [];
    if (!one || other) return `${before}${written}`;
    return one.person && one.handle ? `${before}@${one.handle}` : whole;
  });
}

/** `mentionsByName` for a message going to `channelId`: its people and agents, an agent's message only. */
async function withNamedMentions(tx: Executor, input: NewMessage, body: string) {
  if (input.author.type !== "agent" || !/@\p{L}/u.test(body)) return body;
  const { organizationMembers, users } = schema;
  // ponytail: reads every member's name for such a message; filter by the text in SQL if a workspace's size calls for it.
  const people = await tx
    .select({ name: users.name, handle: organizationMembers.handle, here: channelMembers.userId })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(
      channelMembers,
      and(eq(channelMembers.channelId, input.channelId), eq(channelMembers.userId, organizationMembers.userId)),
    )
    .where(eq(organizationMembers.orgId, input.orgId));
  const teammates = await tx
    .select({ name: agents.name, handle: agents.handle })
    .from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(and(eq(channelMembers.channelId, input.channelId), isNull(agents.archivedAt)));
  return mentionsByName(
    body,
    [
      ...people.filter((p) => p.here).map((p) => ({ ...p, person: true })),
      ...teammates.map((a) => ({ ...a, person: false })),
    ],
    people.filter((p) => !p.here).map((p) => p.name),
  );
}

/**
 * `#name` channel references in a message, lower-cased and de-duplicated, outside code and links (they stay as
 * typed), by the rule the apps share (`CHANNEL_REF`).
 */
export function parseChannelNames(body: string): string[] {
  const prose = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/\[[^\]]*\]\([^)\s]*\)|https?:\/\/\S+/g, " ");
  const found = new Set<string>();
  for (const match of prose.matchAll(CHANNEL_REF)) {
    if (match[2]) found.add(match[2].toLowerCase());
  }
  return [...found];
}

/**
 * `{ channelRefs }` for a new message's meta: each `#name` it writes → the channel's id (`{}` when none), so the link
 * survives a rename. Archived channels count (they show as archived). A private channel only when the message is
 * posted in it: `meta` reaches every reader, and only then are they all its members. Elsewhere its members' apps
 * match the channel by its current name.
 */
function channelRefsSql(orgId: string, channelId: string, names: string[]) {
  // Names match [a-z0-9_-]: safe as an array literal.
  return sql`coalesce((select jsonb_build_object('channelRefs', jsonb_object_agg(c.name, c.id)) from ${channels} c
      where c.org_id = ${orgId}::uuid and c.kind = 'channel' and c.name = any(${`{${names.join(",")}}`}::text[])
        and (c.visibility = 'public' or c.id = ${channelId}::uuid)
      having count(*) > 0), '{}'::jsonb)`;
}

/**
 * The org's agents an agent's text @mentions that aren't members of `channelId`: a mention reaches only members
 * (`insertMessageWithRuns`), so for them it is plain text that wakes nobody. Handles, lower case; never the author,
 * an archived agent or a handle a person holds (the @ is theirs). In a task's conversation (ADR 0145) the ones that see
 * the task join it first, as `insertMessageWithRuns` does, so they are reached.
 */
export async function unreachedAgents(
  db: Executor,
  input: { orgId: string; channelId: string; authorAgentId: string; body: string; handedTo?: string },
): Promise<string[]> {
  const handles = parseMentionHandles(input.body);
  if (handles.length === 0) return [];
  await admitTaskAgents(db, input.orgId, input.channelId, {
    handles: await currentHandles(db, input.orgId, handles),
  });
  const rows = await db
    .select({ handle: agents.handle })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, input.orgId),
        isNull(agents.archivedAt),
        inArray(agents.handle, handles),
        ne(agents.id, input.authorAgentId),
        sql`not exists (select 1 from ${channelMembers} cm
          where cm.channel_id = ${input.channelId}::uuid and cm.agent_id = ${agents.id})`,
        sql`not exists (select 1 from ${schema.organizationMembers} om
          where om.org_id = ${input.orgId}::uuid and om.handle = ${agents.handle})`,
        input.handedTo
          ? sql`not exists (select 1 from ${schema.agentConsultations} c
              where c.asker_run_id = ${input.handedTo}::uuid and c.target_agent_id = ${agents.id})`
          : undefined,
      ),
    );
  return rows.map((r) => r.handle).sort();
}

/**
 * The people an agent's text @mentions who hear nothing of it: members it names by handle, or by a full name
 * (`withNamedMentions` drops that @ of someone outside), who don't read `channelId` (a mention notifies only them,
 * `insertMessageWithRuns`: its members, an administrator in a channel, a task's reader in its conversation). Their
 * handles, lower case; never a blocked account or one waiting for its deletion.
 */
export async function unreachedPeople(
  db: Executor,
  input: { orgId: string; channelId: string; body: string },
): Promise<string[]> {
  if (!input.body.includes("@")) return [];
  const handles = parseMentionHandles(input.body);
  const rows = rowsOf<{ handle: string }>(
    await db.execute(sql`select om.handle from ${schema.organizationMembers} om
      join ${schema.users} on ${schema.users.id} = om.user_id
      join ${channels} c on c.id = ${input.channelId}::uuid
      where om.org_id = ${input.orgId}::uuid and om.handle is not null and ${accountInUse}
        and (om.handle = any(${`{${handles.join(",")}}`}::text[])
          or (strpos(${schema.users.name}, ' ') > 0 and strpos(lower(${input.body}::text), lower('@' || ${schema.users.name})) > 0))
        and not exists (select 1 from ${channelMembers} cm where cm.channel_id = c.id and cm.user_id = om.user_id)
        and not (c.kind = 'channel' and ${maySql(sql`om.org_id`, sql`om.user_id`, "administrator")})
        and not (c.kind = 'task' and ${taskReaderSql(sql`c.id`, sql`om.user_id`)})`),
  );
  return rows.map((r) => r.handle).sort();
}

/**
 * What the agent reads about its mentions that reached nobody (`unreachedAgents`, `unreachedPeople`): who, and how to
 * reach them if it meant to. `canAdd`: a channel, where `add_agent_to_channel` brings an agent in with the rights of
 * the person behind the run; a DM keeps its participants. `routine`: a routine's run, whose DMs go to its creator only.
 * In the past tense: the line stays under the message, also after they join.
 */
export function unreachedNote(
  handles: string[],
  where: string,
  canAdd: boolean,
  people: string[] = [],
  routine = false,
): string {
  const named = (list: string[]) => list.map((h) => `@${h}`).join(", ");
  const one = handles.length === 1;
  const it = one ? "it" : "them";
  const agents = handles.length
    ? `${named(handles)} ${one ? "wasn't" : "weren't"} in ${where}, so your mention didn't reach ${it}. If you meant ${it} to act or answer, use tell_agent or ask_agent${canAdd ? `, or add ${it} to ${where} with add_agent_to_channel (it works with the rights of the person you work for)` : ""}.`
    : "";
  const persons = people.length
    ? `${named(people)} ${people.length === 1 ? "wasn't" : "weren't"} in ${where}, so your mention didn't notify them. If they should see it, ${routine ? "post it where they read with post_message" : "tell them with send_dm"}.`
    : "";
  return [agents, persons].filter(Boolean).join(" ");
}

/** An agent's message may bring in one more agent only up to this hop (ADR 0034); `router.ts` enforces it too. */
export const AGENT_CHIME_IN_MAX_HOP = 2;
/** A reply waits this long before its thread is assessed (`threads.assess`); a newer reply's job takes over. */
export const THREAD_ASSESS_DELAY_MS = 2 * 60_000;
/**
 * The floor: a person's follow-up without @ in a channel's main timeline goes to the agent's run
 * still answering that person there, when it was asked within this window (else the router decides).
 */
export const FLOOR_WINDOW_MS = 30 * 60_000;

/**
 * An agent's message written by a run takes that run's hop and stretch (ADR 0089) from its row in its own insert
 * (`hop` only when the row is gone): a person may have rerooted the run since its caller read it. One no run wrote
 * (a notice, a task's end, a follow-up line) says its stretch: the run's it belongs to, or null for a root (a
 * routine's report, a line that wakes nobody).
 */
export type MessageAuthor =
  | { type: "person"; userId: string }
  | { type: "agent"; agentId: string; runId: string; hop: number }
  | { type: "agent"; agentId: string; runId: null; hop: number; stretchId: string | null };

export interface NewMessage {
  orgId: string;
  channelId: string;
  threadId?: string | null;
  author: MessageAuthor;
  body: string;
  meta?: Record<string, unknown>;
  /** Placed at this time instead of now (an agent's text that came before a card already posted). */
  createdAt?: Date;
  /**
   * A person's app id for this send (trimmed, at most 64 chars): a resend with the same one by the same
   * person returns the message already written (`duplicate`), with nothing else written. Ignored for agents.
   */
  clientId?: string | null;
}

/** A `clientId` as it is stored and claimed: trimmed, at most 64 chars; empty is none. */
const normalizeClientId = (id: string | null | undefined) => id?.trim().slice(0, 64) || null;

/** How long a person's `clientId` keeps a resend from writing the message again. */
export const MESSAGE_CLIENT_ID_TTL_MS = 7 * 24 * 3600_000;

/** Forgets `clientId`s older than the TTL (a resend that late writes a new message). Returns rows deleted. */
export async function pruneMessageClientIds(db: Executor, olderThanMs = MESSAGE_CLIENT_ID_TTL_MS): Promise<number> {
  const deleted = await db
    .delete(schema.messageClientIds)
    .where(lt(schema.messageClientIds.createdAt, new Date(Date.now() - olderThanMs)))
    .returning({ id: schema.messageClientIds.messageId });
  return deleted.length;
}

/**
 * Writes a message and its `message.posted` outbox event (mentions or router)
 * in the caller's transaction. Mentions resolve to active agents that are members of the
 * channel; an agent never mentions itself. No permission checks: callers
 * (`postPersonMessage`, the run executor) do them.
 */
export async function insertMessage(tx: Executor, input: NewMessage): Promise<Message> {
  return (await insertMessageWithRuns(tx, input, { startRuns: false })).message;
}

interface RawMessage {
  id: string;
  created_at: Date | string;
  org_id: string;
  channel_id: string;
  thread_id: string | null;
  author_type: Message["authorType"];
  author_user_id: string | null;
  author_agent_id: string | null;
  body: string;
  mentioned_agent_ids: string[] | string | null;
  mentioned_user_ids: string[] | string | null;
  hop: number;
  stretch_id: string | null;
  agent_run_id: string | null;
  meta: Record<string, unknown> | string | null;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  runs: { id: string; agentId: string }[] | string | null;
  /** Agents the sender addressed but can't talk to. */
  blocked?: string[] | string | null;
  /** Active runs this message was delivered to (no new run). */
  steered?: { id: string; agentId: string }[] | string | null;
  /** The open question this reply answered: the run it resumes and its agent. */
  answered?: { id: string | null; agentId: string } | string | null;
  /** The reply reopened a closed thread. */
  reopened?: boolean | null;
}

async function isThreadArchived(db: Executor, orgId: string, rootId: string) {
  const [row] = await db
    .select({ state: threads.state })
    .from(threads)
    .where(and(eq(threads.orgId, orgId), eq(threads.rootMessageId, rootId)));
  return row?.state === "archived";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asDate = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v : new Date(v));
const parseUuidArray = (v: string[] | string | null) =>
  Array.isArray(v) ? v : v ? v.replace(/^{|}$/g, "").split(",").filter(Boolean) : [];
const parseJson = <T>(v: T | string | null, fallback: T): T =>
  typeof v === "string" ? (JSON.parse(v) as T) : (v ?? fallback);

/**
 * Writes a message in ONE statement (the database may be far away): thread
 * check, mention resolution (active agents that are members of the
 * channel; an agent never mentions itself), the message, its outbox rows
 * (`search.index`, `message.posted`), and, with `startRuns` for a person's
 * message, the runs of the agents that will surely answer (mentioned ones,
 * or the agent of a DM) with their `agent_run.execute` jobs. Atomic like a
 * transaction. No permission checks: callers do them.
 */
export async function insertMessageWithRuns(
  tx: Executor,
  input: NewMessage,
  /**
   * `deliver: false`: a person's message written on their behalf (a routine's trigger) answers no open
   * question and joins no run in progress; only the runs its caller starts read it.
   */
  options: { startRuns: boolean; deliver?: boolean },
): Promise<{
  message: Message;
  runs: { id: string; agentId: string }[];
  blocked: string[];
  /** Runs already active in this conversation that will read the message at their next step. */
  steered: { id: string; agentId: string }[];
  /** The open question a person's reply answered: the run it resumes (null if gone) and its agent. */
  answered: { id: string | null; agentId: string } | null;
  /** A person's reply reopened a closed thread. */
  reopened: boolean;
  /** A resend (same person and `clientId`): `message` is the one already written; nothing was written now. */
  duplicate: boolean;
}> {
  const body = await withNamedMentions(tx, input, input.body.trim());
  // Files alone are a message (`meta.artifacts`), and so is a GIF or a sticker (`meta.media`, ADR 0091): the
  // text may be empty then.
  const attached = input.meta?.artifacts;
  const files = Array.isArray(attached) && attached.length > 0;
  const media = mediaOf(input.meta);
  if (body === "" && !files && !media) throw new ValidationError("Message is empty");
  // A GIF or a sticker alone is like a reaction (ADR 0091 §1): it routes to nobody, starts no run, reaches no run in
  // progress (nor answers its question), suggests nothing in a mission and reopens no thread. Agents read it in the
  // conversation later. Nothing to search in it either.
  const mediaOnly = body === "" && !files && media !== null;
  // The sticker or GIF an agent adds after its own reply is silent (ADR 0091 §4): it notifies nobody, and a thread
  // waits for the reply's own assessment.
  const silent = isMediaAfterReply(input.meta);
  if (body.length > MAX_MESSAGE_LENGTH)
    throw new ValidationError(`Message is longer than ${MAX_MESSAGE_LENGTH} characters`);
  const mentions = await currentHandles(tx, input.orgId, parseMentionHandles(body));
  const person = input.author.type === "person";
  // A task's conversation (ADR 0145): an agent another agent mentions there joins it when it sees the task, as with a
  // person's mention (`postPersonMessage`), so the mention wakes it (hop limits as anywhere). Elsewhere it adds no one.
  if (!person && mentions.length > 0) await admitTaskAgents(tx, input.orgId, input.channelId, { handles: mentions });
  // Handles match [a-z0-9_-]: safe as an array literal.
  const handles = `{${mentions.join(",")}}`;
  const id = Bun.randomUUIDv7();
  const userId = input.author.type === "person" ? input.author.userId : null;
  const agentId = input.author.type === "agent" ? input.author.agentId : null;
  const runId = input.author.type === "agent" ? input.author.runId : null;
  const hop = input.author.type === "agent" ? input.author.hop : 0;
  const stretchId =
    (input.author.type === "agent" && input.author.runId === null ? input.author.stretchId : null) ?? null;
  const threadId = input.threadId ?? null;
  const channelNames = parseChannelNames(body);
  // `@todos` (any language's word, `mentionsEveryone`) from a person who may `mention_everyone`: every member of the
  // conversation is mentioned, but in a DM (plain text there). Never an agent's: one mentioning everyone would wake
  // every agent here, and they would answer each other.
  const everyone = person && mentionsEveryone(body);
  const startRuns = options.startRuns && person && !mediaOnly;
  const deliver = person && options.deliver !== false && !mediaOnly;
  // Agents the person only referenced (`classifyAddressees`): mentioned, but no run and no steering.
  const referenced = `{${(person ? referencedOf(input.meta ?? {}) : []).filter((v) => UUID.test(v)).join(",")}}`;
  // A quote reply to an agent's message is for that agent (`replyRefFor` wrote it, never the client).
  const quoted = person ? (input.meta?.replyTo as ReplyRef | undefined)?.author : undefined;
  const quotedAgentId = quoted?.type === "agent" && quoted.id && UUID.test(quoted.id) ? quoted.id : null;
  /**
   * SQL: the message is for another agent than `agent`: it doesn't mention it, and mentions others or quotes another
   * agent's message (a mention wins: "@dev see what Theo said" quoting Theo is for Dev). Then no task in progress of
   * `agent`, question of its, background work or held run takes it: it is routed.
   */
  const forAnother = (agent: SQL) => sql`(${agent} not in (select id from mentioned)
    and (exists (select 1 from mentioned)
      or (${quotedAgentId}::uuid is not null and ${agent} <> ${quotedAgentId}::uuid)))`;
  /**
   * SQL: a reply in a thread joins run `r` only when the person talks to its agent there: not for another agent, and
   * it quotes that agent, the run answers this person, or that agent spoke last in the thread. A run another agent
   * started by naming it is not who the person talks to while the agent that named it spoke last.
   */
  const talkingTo = (r: SQL) => sql`(not ${forAnother(sql`${r}.agent_id`)} and (
    ${r}.agent_id = ${quotedAgentId}::uuid
    or exists (select 1 from ${messages} tm where tm.org_id = ${input.orgId}::uuid and tm.id = ${r}.trigger_message_id
      and tm.author_user_id = ${userId})
    or ${r}.agent_id = coalesce(
      (select lm.author_agent_id from ${messages} lm where lm.org_id = ${input.orgId}::uuid
        and lm.channel_id = ${input.channelId}::uuid and lm.thread_id = ${threadId}::uuid and lm.author_type = 'agent'
        order by lm.created_at desc limit 1),
      (select rm.author_agent_id from ${messages} rm where rm.org_id = ${input.orgId}::uuid
        and rm.id = ${threadId}::uuid))))`;
  // Idempotent send: a person's `clientId` is claimed with the message; a resend finds it taken.
  const clientId = person ? normalizeClientId(input.clientId) : null;
  // Where the message may go: no thread, or a top-level message of this channel (`m` checks it too).
  // Who may wake agents here: the person's `talk_to_agents` in this channel (ADR 0134).
  const inChannel = { channelId: sql`${input.channelId}::uuid` };
  const threadOk = sql`(${threadId}::uuid is null or exists (
          select 1 from ${messages} r where r.id = ${threadId}::uuid and r.org_id = ${input.orgId}::uuid
            and r.channel_id = ${input.channelId}::uuid and r.thread_id is null))`;
  const rows = rowsOf<RawMessage>(
    await tx.execute(sql`with archived as (
        -- An archived thread is read only for people (ADR 0029); an agent's run already going still lands.
        select 1 from ${threads} th
        where ${person}::boolean and ${threadId}::uuid is not null and th.org_id = ${input.orgId}::uuid
          and th.root_message_id = ${threadId}::uuid and th.state = 'archived'
      ), claimed as (
        -- Only when the message will be written (same checks as m): a refused send claims nothing.
        -- Taken already (a resend, or the same send racing): no row, so nothing below writes anything.
        insert into ${schema.messageClientIds} (org_id, user_id, client_id, message_id)
        select ${input.orgId}::uuid, ${userId}::text, ${clientId}::text, ${id}::uuid
        where ${clientId}::text is not null and ${threadOk} and not exists (select 1 from archived)
        on conflict do nothing
        returning message_id
      ), fresh as (
        -- The write goes ahead: no client id, or this send claimed it.
        select 1 where ${clientId}::text is null or exists (select 1 from claimed)
      ), task_readers_named as (
        -- A task's conversation (ADR 0145) has no people in it: who is named there and sees the task is mentioned.
        select om.user_id from ${schema.organizationMembers} om
        where om.org_id = ${input.orgId}::uuid and om.user_id is distinct from ${userId}
          and om.handle = any(${handles}::text[])
          and exists (select 1 from ${channels} tc where tc.id = ${input.channelId}::uuid and tc.kind = 'task')
          and ${taskReaderSql(sql`${input.channelId}::uuid`, sql`om.user_id`)}
      ), muted as (
        -- A mission's thread (ADR 0029): only its owner and those who can decide make its agent act.
        -- Anyone else addressing it starts nothing: the message becomes a suggestion.
        select mi.id as mission_id, mi.agent_id,
          not exists (select 1 from ${schema.missionParticipants} mo
            where mo.mission_id = mi.id and mo.user_id = ${userId}) as outsider
        from ${schema.missions} mi
        where ${person}::boolean and not ${mediaOnly}::boolean and ${threadId}::uuid is not null
          and mi.org_id = ${input.orgId}::uuid
          and mi.thread_root_id = ${threadId}::uuid and mi.status in ('proposed', 'active', 'paused', 'awaiting_close')
          and mi.owner_id is distinct from ${userId}
          and not exists (select 1 from ${schema.missionParticipants} mp
            where mp.mission_id = mi.id and mp.user_id = ${userId} and mp.role = 'decide')
      ), everyone as (
        select 1 where ${everyone}::boolean
          and ${maySql(sql`${input.orgId}::uuid`, sql`${userId}::text`, "mention_everyone")}
          and exists (select 1 from ${channels} ec where ec.id = ${input.channelId}::uuid and ec.kind <> 'dm')
      ), named as (
        select a.id from ${agents} a
        where a.org_id = ${input.orgId}::uuid and a.archived_at is null
          and a.handle = any(${handles}::text[])
          and a.id is distinct from ${agentId}::uuid
          and (exists (select 1 from ${channelMembers} cm where cm.agent_id = a.id
              and cm.channel_id = ${input.channelId}::uuid)
            or ${rightHandReaches(sql`a`, sql`${input.channelId}::uuid`)})
      ), everyone_agents as (
        -- The agents that answer this person here (the others aren't "blocked": nobody named them), never Lodi, nor
        -- one held (standing.ts: its run would only fail, as the router leaves it out).
        select a.id from ${agents} a
        join ${channelMembers} cm on cm.agent_id = a.id and cm.channel_id = ${input.channelId}::uuid
        where exists (select 1 from everyone) and a.org_id = ${input.orgId}::uuid and a.archived_at is null
          and a.operator_hold_at is null and a.builtin is null and a.id not in (select id from named)
          and ${audienceSql("a", sql`${userId}::text`, inChannel)}
      ), mentioned as (
        select id from named union all select id from everyone_agents
      ), mentioned_people as (
        select om.user_id from ${schema.organizationMembers} om
        left join ${channelMembers} pcm on pcm.user_id = om.user_id and pcm.channel_id = ${input.channelId}::uuid
        where om.org_id = ${input.orgId}::uuid and om.user_id is distinct from ${userId}
          and ((pcm.id is not null and (om.handle = any(${handles}::text[]) or exists (select 1 from everyone)))
            -- Named, an administrator hears it from a channel they read without being in it (ADR 0151).
            or (om.handle = any(${handles}::text[])
              and exists (select 1 from ${channels} mc where mc.id = ${input.channelId}::uuid and mc.kind = 'channel')
              and ${maySql(sql`om.org_id`, sql`om.user_id`, "administrator")}))
      ), answered as (
        -- A person's reply where an agent asked something (same channel and thread) answers it, unless it is for
        -- someone else.
        update ${agentQuestions} q set status = 'answered', answer = ${body}, answered_by_user_id = ${userId},
          answered_at = now()
        where ${deliver}::boolean and q.status = 'open' and not exists (select 1 from archived)
          and exists (select 1 from fresh) and q.id = (
            select oq.id from ${agentQuestions} oq
            where oq.org_id = ${input.orgId}::uuid and oq.channel_id = ${input.channelId}::uuid
              and oq.status = 'open' and oq.expires_at > now()
              and oq.thread_id is not distinct from ${threadId}::uuid
              and (oq.requested_for_user_id is null or oq.requested_for_user_id = ${userId})
              -- In a channel's main timeline many talk at once: who it is for or who asked the agent answers it,
              -- or whoever addresses it.
              and (${threadId}::uuid is not null or oq.requested_for_user_id = ${userId}
                or not exists (select 1 from ${channels} c where c.id = ${input.channelId}::uuid and c.kind = 'channel')
                -- Named: a mention of everyone is no answer to whatever each agent asked.
                or oq.agent_id in (select id from named)
                or exists (select 1 from ${agentRuns} ar join ${messages} tm on tm.id = ar.trigger_message_id
                  where ar.id = oq.run_id and tm.author_user_id = ${userId}))
            order by oq.created_at desc limit 1)
          and not ${forAnother(sql`q.agent_id`)}
          and q.agent_id not in (select agent_id from muted)
          and exists (select 1 from ${agents} qa where qa.id = q.agent_id and ${audienceSql("qa", sql`${userId}::text`, inChannel)})
          and (${threadId}::uuid is null or exists (
            select 1 from ${messages} r where r.id = ${threadId}::uuid and r.org_id = ${input.orgId}::uuid
              and r.channel_id = ${input.channelId}::uuid and r.thread_id is null))
        returning q.id, q.run_id, q.agent_id
      ), work_thread as (
        -- A person's reply in the thread where an agent's background work posts (its anchor's, or the thread it was
        -- asked in) is for that agent, as a reply in a thread an agent works in always was: a reply turn of its own
        -- answers it now (ADR 0121 addendum 2026-11-06). In a DM the agent is addressed anyway. Naming a person there
        -- talks to them: the router decides.
        select distinct w.agent_id from ${schema.agentWorks} w
        join ${agents} wa on wa.id = w.agent_id and wa.archived_at is null
        where ${startRuns}::boolean and ${threadId}::uuid is not null and not exists (select 1 from mentioned)
          and not exists (select 1 from mentioned_people)
          and w.org_id = ${input.orgId}::uuid and w.channel_id = ${input.channelId}::uuid
          and w.status in ('live', 'queued')
          and ((w.own_thread and w.anchor_message_id = ${threadId}::uuid)
            or (not w.own_thread and w.home_thread_id = ${threadId}::uuid))
          and not ${forAnother(sql`w.agent_id`)}
          and exists (select 1 from ${channels} wc where wc.id = ${input.channelId}::uuid and wc.kind = 'channel')
          and ${audienceSql("wa", sql`${userId}::text`, inChannel)}
      ), addressed as (
        select a.id as agent_id,
          case when exists (select 1 from mentioned) or a.id in (select agent_id from work_thread) then 'mention'
            else 'dm' end as trig,
          ${audienceSql("a", sql`${userId}::text`, inChannel)} as allowed
        from ${agents} a
        where ${startRuns}::boolean and a.org_id = ${input.orgId}::uuid and a.archived_at is null
          and (exists (select 1 from ${channelMembers} cm where cm.agent_id = a.id
              and cm.channel_id = ${input.channelId}::uuid)
            or ${rightHandReaches(sql`a`, sql`${input.channelId}::uuid`)})
          and a.id not in (select agent_id from answered)
          and a.id <> all(${referenced}::uuid[])
          and (a.id in (select id from mentioned) or a.id in (select agent_id from work_thread)
            or (not exists (select 1 from mentioned) and not exists (select 1 from answered) and exists (
              select 1 from ${channels} c where c.id = ${input.channelId}::uuid and c.kind = 'dm')))
      ), answering as (
        -- Who can talk to the agent: the others get no run, only a notice for the sender.
        select agent_id, trig from addressed where allowed and agent_id not in (select agent_id from muted)
      ), floor_runs as (
        -- The floor (a follow-up without @ in a channel's main timeline): it goes to the agent still
        -- answering this same person there, asked within the last minutes. Deterministic, no router. Only
        -- while one agent is at it: with two answering them (a question to each), the next message may be
        -- for one of them or both, so the router decides.
        select r.id, r.agent_id from ${agentRuns} r
        join ${agents} ra on ra.id = r.agent_id
        where ${startRuns && !threadId}::boolean and ${deliver}::boolean and not exists (select 1 from mentioned)
          and r.org_id = ${input.orgId}::uuid and r.channel_id = ${input.channelId}::uuid
          and r.status in ('queued', 'running') and not r.background and ${inChannelRun(sql`r`)}
          and ${workKeepsThread(sql`r`)}
          and r.agent_id not in (select agent_id from answered)
          and r.agent_id not in (select agent_id from muted)
          and r.agent_id <> all(${referenced}::uuid[])
          and not ${forAnother(sql`r.agent_id`)}
          and r.created_at > now() - ${FLOOR_WINDOW_MS / 1000}::int * interval '1 second'
          and ra.archived_at is null
          and exists (select 1 from ${channels} c where c.id = ${input.channelId}::uuid and c.kind = 'channel')
          and exists (select 1 from ${messages} tm where tm.org_id = ${input.orgId}::uuid
            and tm.id = r.trigger_message_id and tm.author_user_id = ${userId})
          and ${audienceSql("ra", sql`${userId}::text`, inChannel)}
      ), active as (
        -- One active run per agent and conversation: a new message goes to it instead of a second run.
        -- Addressed agents (mention, DM) with a run in this conversation, and, for a reply in a
        -- thread, an agent working in that thread the person talks to (talkingTo: no mention needed). A new
        -- message in the channel joins the agent's run that answers in the channel itself (not one in
        -- a thread's panel, a range thread or a mission), while it is queued or working (one waiting for
        -- an approval or an answer would hold the new request), or while it waits for its computer, its plan or its
        -- budget (one catch-up per conversation): two people calling Ada get one Ada.
        -- Background runs (a routine's) hold no conversation: a person's message never goes to one.
        -- Nor does a run waiting on an approval: the agent answers in a run of its own meanwhile
        -- (one waiting on a secret or a mission's decision hands it on after the insert: steering.ts).
        select distinct on (r.agent_id) r.id, r.agent_id from ${agentRuns} r
        join ${agents} ra on ra.id = r.agent_id
        where ${deliver}::boolean and r.org_id = ${input.orgId}::uuid and r.channel_id = ${input.channelId}::uuid
          and r.status in ('queued', 'running', 'waiting_input')
          and not r.background
          -- Background work (ADR 0121) never holds a person's message while it works: a reply turn answers it.
          and ${workTakesPersonMessage(sql`r`, userId)}
          and r.agent_id not in (select agent_id from answered)
          and r.agent_id not in (select agent_id from muted)
          and r.agent_id <> all(${referenced}::uuid[])
          and (
            (r.agent_id in (select agent_id from answering)
              and (r.thread_root_id = coalesce(${threadId}::uuid, ${id}::uuid)
                -- In a DM the main timeline is one conversation; each thread (a mission's) is its own, so the
                -- agent works in both at once instead of one taking the other's messages.
                or ${
                  threadId
                    ? sql`false`
                    : sql`(${inChannelRun(sql`r`)} and exists (
                select 1 from ${channels} c where c.id = ${input.channelId}::uuid and c.kind = 'dm'))
                or (r.status in ('queued', 'running') and ${inChannelRun(sql`r`)})
                or (r.status = 'waiting_input' and (r.waiting_machine_id is not null or ${waitsOnUsage(sql`r`)})
                  and ${inChannelRun(sql`r`)})`
                }))
            or (${threadId}::uuid is not null and r.thread_root_id = ${threadId}::uuid
              and ${talkingTo(sql`r`)}
              and ${audienceSql("ra", sql`${userId}::text`, inChannel)})
            or (r.id in (select id from floor_runs) and (select count(distinct agent_id) from floor_runs) = 1)
          )
        order by r.agent_id, r.created_at desc
      ), held as (
        -- A reply in a thread where the agent's run waits on an approval (it takes nothing new):
        -- the agent answers it in a run of its own, as that run would have read it.
        select distinct r.agent_id from ${agentRuns} r
        join ${agents} ra on ra.id = r.agent_id
        where ${startRuns}::boolean and ${deliver}::boolean and ${threadId}::uuid is not null
          and r.org_id = ${input.orgId}::uuid and r.channel_id = ${input.channelId}::uuid
          and r.thread_root_id = ${threadId}::uuid and r.status = 'waiting_approval' and not r.background
          and ra.archived_at is null
          and r.agent_id not in (select agent_id from answered)
          and r.agent_id not in (select agent_id from muted)
          and r.agent_id <> all(${referenced}::uuid[])
          and ${talkingTo(sql`r`)}
          and ${audienceSql("ra", sql`${userId}::text`, inChannel)}
      ), steered as (
        -- Queued on the run only while it is still active: one that ended since (its unread messages
        -- already handed on) is never appended to; the message starts a run of its own below instead.
        -- Same conditions as m (the message is written).
        update ${agentRuns} r set pending_message_ids = array_append(r.pending_message_ids, ${id}::uuid),
          updated_at = now()
        from active a where r.id = a.id
          and r.status in ('queued', 'running', 'waiting_input')
          and ${threadOk} and not exists (select 1 from archived) and exists (select 1 from fresh)
        returning r.id, r.agent_id
      ), m as (
        insert into ${messages} (id, created_at, org_id, channel_id, thread_id, author_type, author_user_id,
          author_agent_id, agent_run_id, hop, stretch_id, body, mentioned_agent_ids, mentioned_user_ids, meta)
        select ${id}::uuid, coalesce(${input.createdAt?.toISOString() ?? null}::timestamptz, now()), ${input.orgId}::uuid, ${input.channelId}::uuid, ${threadId}::uuid,
          ${input.author.type}::author_type, ${userId}, ${agentId}::uuid, ${runId}::uuid,
          coalesce((select sr.hop from ${agentRuns} sr where sr.id = ${runId}::uuid), ${hop}),
          coalesce(${stretchId}::uuid, (select coalesce(sr.stretch_id, sr.trigger_message_id) from ${agentRuns} sr
            where sr.id = ${runId}::uuid)),
          ${body},
          coalesce((select array_agg(id) from mentioned), '{}'::uuid[]),
          coalesce((select array_agg(user_id) from (select user_id from mentioned_people
            union select user_id from task_readers_named) mp), '{}'::text[]),
          -- Only this statement says a message mentions everyone.
          (${JSON.stringify(input.meta ?? {})}::jsonb - 'mentionsEveryone' - 'everyoneAgentIds')
            || coalesce((select jsonb_build_object('mentionsEveryone', true) from everyone), '{}'::jsonb)
            -- The agents only the mention of everyone woke: they may stay quiet (reply-policy.ts).
            || coalesce((select jsonb_build_object('everyoneAgentIds', jsonb_agg(id)) from everyone_agents
                having count(*) > 0), '{}'::jsonb)
            || ${channelNames.length > 0 ? channelRefsSql(input.orgId, input.channelId, channelNames) : sql`'{}'::jsonb`}
            || coalesce((select jsonb_build_object('answersQuestionId', id) from answered), '{}'::jsonb)
            -- For an agent's background work, answered by its own reply turn: nobody routes it again.
            || coalesce((select jsonb_build_object('forWork', true) from work_thread limit 1), '{}'::jsonb)
            -- Delivered to a task in progress: nobody routes it again (no second run).
            || coalesce((select jsonb_build_object('steeredRunIds', jsonb_agg(st.id)) from steered st
                having count(*) > 0), '{}'::jsonb)
            -- Addressed the mission's agent without the right to: a suggestion the owner decides.
            || coalesce((select jsonb_build_object('missionSuggestion',
                  jsonb_build_object('status', 'pending', 'missionId', mu.mission_id))
                from muted mu where mu.agent_id in (select agent_id from addressed)
                  -- A plain reply there by someone who takes no part: a suggestion too, so the owner sees it.
                  or (mu.outsider and not exists (select 1 from mentioned)) limit 1), '{}'::jsonb)
        where ${threadOk}
          -- An archived thread is read only for people (ADR 0029); an agent's run already going still lands.
          and not exists (select 1 from archived)
          -- A resend (its client id already claimed) writes nothing.
          and exists (select 1 from fresh)
        returning *
      ), reopened as (
        -- A person replying in a closed thread reopens it (one indexed update; no row = nothing to do). A GIF or a
        -- sticker alone doesn't, like a reaction.
        update ${threads} t set state = 'open', closed_by = null, closed_at = null, updated_at = now()
        where ${person}::boolean and not ${mediaOnly}::boolean and ${threadId}::uuid is not null
          and t.org_id = ${input.orgId}::uuid
          and t.root_message_id = ${threadId}::uuid and t.state = 'closed' and exists (select 1 from m)
        returning t.id
      ), runs as (
        insert into ${agentRuns} (id, org_id, agent_id, channel_id, thread_root_id, trigger_message_id, trigger, hop,
          stretch_id)
        select gen_random_uuid(), ${input.orgId}::uuid, an.agent_id, ${input.channelId}::uuid,
          coalesce(${threadId}::uuid, ${id}::uuid), ${id}::uuid, an.trig::agent_run_trigger, ${hop} + 1, ${id}::uuid
        from (select agent_id, trig from answering
          union select agent_id, 'mention' from held where agent_id not in (select agent_id from answering)) an
        where exists (select 1 from m)
          and an.agent_id not in (select agent_id from steered)
        on conflict do nothing
        returning id, agent_id
      ), jobs as (
        insert into ${outbox} (id, org_id, kind, payload, dedupe_key, max_attempts)
        select gen_random_uuid(), ${input.orgId}::uuid, 'agent_run.execute', jsonb_build_object('runId', r.id),
          'agent_run.execute:' || r.id, 4 from runs r
        union all
        select gen_random_uuid(), ${input.orgId}::uuid, 'agent_run.execute', jsonb_build_object('runId', a.run_id),
          'agent_run.execute:' || a.run_id || ':question:' || a.id, 4 from answered a
        union all
        select gen_random_uuid(), ${input.orgId}::uuid, 'search.index',
          jsonb_build_object('kind', 'message', 'sourceId', m.id), 'search.index:message:' || m.id, 8 from m
          where not ${mediaOnly}::boolean
        union all
        select gen_random_uuid(), ${input.orgId}::uuid, 'message.posted', jsonb_build_object('messageId', m.id),
          'message.posted:' || m.id, 8 from m
          -- An agent's message without a mention goes to the router too: another agent may chime in (ADR 0034).
          -- A GIF or a sticker alone goes to nobody, an agent's silent one after its reply included (ADR 0091).
          where not ${mediaOnly}::boolean and (m.author_type = 'person' or cardinality(m.mentioned_agent_ids) > 0
            or m.hop < ${AGENT_CHIME_IN_MAX_HOP})
        union all
        -- In-app notifications: people mentioned, a reply in a thread, a person's DM, an agent's answer to whoever
        -- is behind its run (ADR 0071), a routine's report (it may have no mention and no run).
        select gen_random_uuid(), ${input.orgId}::uuid, 'notifications.message', jsonb_build_object('messageId', m.id),
          'notifications.message:' || m.id, 4 from m
          where not ${silent}::boolean and (cardinality(m.mentioned_user_ids) > 0 or m.thread_id is not null
            or m.agent_run_id is not null or m.meta -> 'routine' is not null
            or (m.author_type = 'person' and exists (
              select 1 from ${channels} dc where dc.id = ${input.channelId}::uuid and dc.kind = 'dm')))
        on conflict do nothing
        returning id
      ), assess as (
        -- A reply: the thread's title and "resolved?" are assessed a while later (threads.assess);
        -- a newer reply's job takes over. An agent's silent sticker or GIF
        -- after its reply leaves it to the reply's own job (the assessment doesn't count it as newer).
        insert into ${outbox} (id, org_id, kind, payload, dedupe_key, max_attempts, next_attempt_at)
        select gen_random_uuid(), ${input.orgId}::uuid, 'threads.assess',
          jsonb_build_object('threadRootId', m.thread_id, 'messageId', m.id), 'threads.assess:' || m.id, 2,
          now() + ${THREAD_ASSESS_DELAY_MS / 1000}::int * interval '1 second'
        from m where m.thread_id is not null and not ${silent}::boolean
        on conflict do nothing
        returning id
      )
      select m.*,
        coalesce((select json_agg(json_build_object('id', r.id, 'agentId', r.agent_id)) from runs r), '[]'::json) as runs,
        coalesce((select json_agg(ad.agent_id) from addressed ad where not ad.allowed), '[]'::json) as blocked,
        coalesce((select json_agg(json_build_object('id', s.id, 'agentId', s.agent_id)) from steered s), '[]'::json)
          as steered,
        (select json_build_object('id', an.run_id, 'agentId', an.agent_id) from answered an limit 1) as answered,
        (select count(*) from jobs)::int as jobs,
        exists (select 1 from reopened) as reopened
      from m`),
  );
  const row = rows[0];
  if (!row) {
    // A resend (the response to the first send was lost): the message already written, nothing new.
    if (clientId && userId) {
      const sent = await sentWithClientId(tx, input.orgId, userId, clientId);
      if (sent) {
        const none = { runs: [], blocked: [], steered: [], answered: null, reopened: false };
        return { message: sent, ...none, duplicate: true };
      }
    }
    // Only on the failure path: tell an archived thread from a wrong thread id.
    if (threadId && person && (await isThreadArchived(tx, input.orgId, threadId))) {
      throw new ConflictError("This thread is archived: unarchive it to reply", "thread.archived");
    }
    throw new ValidationError("threadId must be a top-level message of this channel");
  }
  const message: Message = {
    id: row.id,
    createdAt: asDate(row.created_at) as Date,
    orgId: row.org_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    authorType: row.author_type,
    authorUserId: row.author_user_id,
    authorAgentId: row.author_agent_id,
    body: row.body,
    mentionedAgentIds: parseUuidArray(row.mentioned_agent_ids),
    mentionedUserIds: parseUuidArray(row.mentioned_user_ids),
    hop: row.hop,
    stretchId: row.stretch_id,
    agentRunId: row.agent_run_id,
    meta: parseJson(row.meta, {}),
    editedAt: asDate(row.edited_at),
    deletedAt: asDate(row.deleted_at),
  };
  // `[[…]]` links become backlinks of the pages they name (ADR 0023).
  if (body.includes("[[")) {
    await syncWikiLinks(tx, input.orgId, { type: "message", id: message.id, channelId: input.channelId }, body);
  }
  return {
    message,
    runs: parseJson(row.runs, []),
    blocked: parseJson(row.blocked ?? null, [] as string[]),
    steered: parseJson(row.steered ?? null, [] as { id: string; agentId: string }[]),
    answered: parseJson<{ id: string | null; agentId: string } | null>(row.answered ?? null, null),
    reopened: row.reopened === true || (row.reopened as unknown) === "t",
    duplicate: false,
  };
}

/** The message this person already sent with this `clientId` (a resend's lookup). */
async function sentWithClientId(db: Executor, orgId: string, userId: string, clientId: string) {
  const { messageClientIds } = schema;
  const [claim] = await db
    .select({ messageId: messageClientIds.messageId })
    .from(messageClientIds)
    .where(
      and(
        eq(messageClientIds.orgId, orgId),
        eq(messageClientIds.userId, userId),
        eq(messageClientIds.clientId, clientId),
      ),
    );
  if (!claim) return null;
  const message = await getMessage(db, orgId, claim.messageId);
  // Claimed, but the message is gone: it was sent; never write it twice.
  if (!message) throw new ConflictError("This message was already sent", "message.already_sent");
  return message;
}

/**
 * "Responder" opened this thread at this reply: its row says when (made here when the thread had
 * none); replies from then on leave the channel's timeline. True when it wasn't marked before, so
 * the channel hears about it once.
 */
async function markOpenedByReply(db: Database, reply: Message, userId: string): Promise<boolean> {
  if (!reply.threadId) return false;
  const marked = await db
    .insert(threads)
    .values({
      orgId: reply.orgId,
      channelId: reply.channelId,
      rootMessageId: reply.threadId,
      openedByReplyAt: reply.createdAt,
      createdBy: userId,
    })
    .onConflictDoUpdate({
      target: [threads.orgId, threads.rootMessageId],
      set: { openedByReplyAt: reply.createdAt, updatedAt: new Date() },
      setWhere: isNull(threads.openedByReplyAt),
    })
    .returning({ id: threads.id });
  return marked.length > 0;
}

/**
 * A person posts in a channel: org membership, channel membership and the
 * `post` permission are checked, then message + outbox event commit together,
 * then the message is published to real-time subscribers.
 */
/**
 * A resend's answer: the message already written. Its runs, receipts and jobs went out with the first send;
 * only `message.created` goes again (idempotent), in case the first send died before publishing it.
 */
async function resendView(deps: { db: Database; pubsub: PubSub }, orgId: string, message: Message) {
  const [view] = (await withWikiLinks(deps.db, orgId, [messageView(message)])) as [MessageView];
  await publishMessageCreated(deps.pubsub, view);
  return view;
}

export async function postPersonMessage(
  /**
   * `judge`: tells a plain "stop" from a correction while an agent works (none = never a stop).
   * `talker`: the agents' conversation layer, for fast replies while they work (none = no fast replies).
   * `gifs`: the server's GIF provider (ADR 0091; none = no GIFs).
   */
  deps: { db: Database; pubsub: PubSub; judge?: Judge; talker?: Talker; gifs?: GifProvider | null },
  userId: string,
  orgId: string,
  channelId: string,
  input: {
    body: string;
    threadId?: string | null;
    clientId?: string | null;
    /** Server-side attachments (e.g. `{ issueId }` when asking an agent to implement an issue). */
    meta?: Record<string, unknown>;
    /** Quote reply: the message this one answers (same channel; in a thread, that thread). Stored as `meta.replyTo`. */
    replyTo?: string | null;
    /** Files (artifact ids) uploaded for this message, or files of this channel. Stored as `meta.artifacts`. */
    attachments?: string[];
    /**
     * Sent from the thread panel ("Responder"): from this reply on, the thread's replies live in the
     * panel and the channel shows one line (`threads.opened_by_reply_at`). Needs `threadId`.
     */
    openThread?: boolean;
    /**
     * "Parar e mandar": when the message goes into an agent's task in progress, its current model
     * call stops and it reads the message now (instead of at its next step).
     */
    steer?: "now";
    /** A GIF or an agent's sticker (ADR 0091), looked up here and stored as `meta.media`; `body` may be empty. */
    media?: MessageMediaInput;
  },
): Promise<MessageView> {
  // One access check (membership + channel) instead of two round trips. It reads a workspace being deleted; posting
  // there is refused here too, for what posts without the API (a voice note's job).
  const { channel, membership, workspace } = await requireChannelAccess(deps.db, userId, orgId, channelId);
  const closed = closedRefusal(membership.standing);
  if (closed) throw closed;
  if (!can(membership, "post")) throw postRefusal(workspace);
  // A task's conversation (ADR 0145): an agent mentioned there that sees the task joins it, so the mention wakes it.
  if (channel.kind === "task") {
    await admitTaskAgents(deps.db, orgId, channelId, {
      handles: await currentHandles(deps.db, orgId, parseMentionHandles(input.body)),
    });
  }
  const clientId = normalizeClientId(input.clientId);
  // A resend found before the judge call (no cost again); a resend racing the first send is caught by the insert.
  const resent = clientId ? await sentWithClientId(deps.db, orgId, userId, clientId) : null;
  if (resent) return resendView(deps, orgId, resent);
  // Quote, files and media: checked and resolved here, so the run's context reads them from the meta (no query there).
  const [replyTo, files, media] = await Promise.all([
    input.replyTo ? replyRefFor(deps.db, orgId, channelId, input.replyTo, input.threadId) : null,
    input.attachments?.length ? attachmentRefsFor(deps.db, userId, orgId, channelId, input.attachments) : null,
    input.media ? resolveMedia(deps, orgId, input.media) : null,
  ]);
  // Several agents mentioned: who is asked to act now, who is only referenced (no run for those).
  const addressees = deps.judge
    ? await classifyAddressees(deps.db, deps.judge, { orgId, channelId, userId, body: input.body })
    : null;
  const referencedIds = addressees?.referenced ?? [];
  const meta =
    replyTo || files || media || referencedIds.length > 0
      ? {
          ...(input.meta ?? {}),
          ...(replyTo ? { replyTo } : {}),
          ...(files ? { artifacts: files } : {}),
          ...(media ? { media } : {}),
          ...(referencedIds.length > 0 ? { referencedAgentIds: referencedIds } : {}),
        }
      : input.meta;
  // One statement: the message, its jobs, and the runs of agents that will surely answer.
  // A resend with the same `clientId` (the first response was lost) gets the message already written.
  const { message, runs, blocked, steered, answered, reopened, duplicate } = await insertMessageWithRuns(
    deps.db,
    {
      orgId,
      channelId,
      threadId: input.threadId,
      author: { type: "person", userId },
      body: input.body,
      clientId,
      meta:
        clientId || meta || input.steer === "now"
          ? {
              ...(meta ?? {}),
              ...(clientId ? { clientId } : {}),
              // A computer brain can't drop a turn halfway: its task stops and starts again from this message.
              ...(input.steer === "now" ? { steerNow: true } : {}),
            }
          : undefined,
    },
    { startRuns: true },
  );
  if (duplicate) return resendView(deps, orgId, message);
  const [view] = (await withWikiLinks(deps.db, orgId, [messageView(message)])) as [MessageView];
  // Right after the commit, before any routing: the sender's optimistic copy reconciles by `clientId`.
  await publishMessageCreated(deps.pubsub, view);
  if (addressees) await recordAddressees(deps.db, message, addressees);
  // People mentioned by handle hear about it on their own topic (notifications).
  for (const mentioned of message.mentionedUserIds) {
    await publishUserEvent(deps.pubsub, orgId, mentioned, {
      type: "mention",
      channelId,
      messageId: message.id,
      threadId: message.threadId,
      byUserId: userId,
    });
  }
  if (input.openThread && message.threadId && (await markOpenedByReply(deps.db, message, userId))) {
    await publishChannelEvent(deps.pubsub, {
      type: "thread.updated",
      channelId,
      threadId: message.threadId,
      change: "created",
    });
  }
  if (reopened && message.threadId) {
    await publishChannelEvent(deps.pubsub, {
      type: "thread.updated",
      channelId,
      threadId: message.threadId,
      change: "reopened",
      state: "open",
    });
  }
  const answers = message.meta.answersQuestionId;
  if (typeof answers === "string") await afterReplyAnswered(deps, orgId, answers);
  // Agents this person can't talk to: no run; only they hear why ("Theo only replies to …").
  if (blocked.length > 0) {
    view.notices = await notifyBlocked(deps, orgId, userId, {
      agentIds: blocked,
      channelId,
      threadId: message.threadId,
      messageId: message.id,
      deniedHere: can(workspace, "talk_to_agents") && !can(membership, "talk_to_agents"),
    });
  }
  // Delivered to the agent's task in progress: it reads it at its next step, now, or wakes from a wait.
  if (steered.length > 0) {
    await afterSteered(deps, {
      orgId,
      userId,
      channelId,
      message,
      runIds: steered.map((s) => s.id),
      now: input.steer === "now",
    });
  }
  // Receipts: who answers it — new runs, the task in progress it was steered into, the run its
  // answer resumes — and the mentioned agents that won't. Nothing else routes this message.
  const answering = [
    ...runs.map((r) => ({ agentId: r.agentId, runId: r.id })),
    ...steered.map((s) => ({ agentId: s.agentId, runId: s.id })),
    ...(answered ? [{ agentId: answered.agentId, runId: answered.id }] : []),
  ].filter((r, i, all) => all.findIndex((o) => o.agentId === r.agentId) === i);
  const picked = new Set(answering.map((r) => r.agentId));
  const referenced = referencedOf(message.meta).filter((id) => !picked.has(id));
  const wontAnswer =
    message.mentionedAgentIds.length > 0
      ? message.mentionedAgentIds.filter((id) => !picked.has(id) && !referenced.includes(id))
      : [];
  if (answering.length > 0 || wontAnswer.length > 0 || referenced.length > 0) {
    await publishChannelEvent(deps.pubsub, {
      type: "message.routed",
      channelId,
      messageId: message.id,
      seenBy: [...new Set([...message.mentionedAgentIds, ...picked])],
      pickedBy: [...picked],
      runs: answering.flatMap((r) => (r.runId ? [{ agentId: r.agentId, runId: r.runId }] : [])),
      ...(wontAnswer.length > 0 ? { blocked: wontAnswer } : {}),
      ...(referenced.length > 0 ? { referenced } : {}),
      strategy: channel.kind === "dm" && message.mentionedAgentIds.length === 0 ? "dm" : "mention",
    });
  }
  if (runs.length > 0) {
    // The runs answer where the message is.
    const threadId = message.threadId;
    for (const run of runs) {
      await publishChannelEvent(deps.pubsub, {
        type: "agent.thinking",
        channelId,
        threadId,
        agentId: run.agentId,
        runId: run.id,
      });
    }
  }
  return view;
}

/** Above this "the person asks this agent to act now" probability, a mentioned agent gets a run. */
export const ADDRESSEE_THRESHOLD = 0.5;
/** Below the threshold, the top score must reach this to count as a lead (Jev's yes is often 0.2–0.4). */
export const ADDRESSEE_LEAD_MIN = 0.15;

/**
 * Who acts, from each mentioned agent's score. Above the threshold: those. Otherwise a
 * calibrated judge (Jev) still separates them: the leader acts with whoever scores at least
 * half of it ("@atlas, ask @ada to…" scores 0.3 vs 0.06: only Atlas). No lead (all near zero,
 * or close to each other below the lead minimum): everyone mentioned acts, as before.
 */
export function pickAddressees(scores: { agentId: string; score: number }[]) {
  const above = scores.filter((s) => s.score >= ADDRESSEE_THRESHOLD).map((s) => s.agentId);
  if (above.length) return above;
  const top = Math.max(0, ...scores.map((s) => s.score));
  if (top < ADDRESSEE_LEAD_MIN) return scores.map((s) => s.agentId);
  return scores.filter((s) => s.score >= top / 2).map((s) => s.agentId);
}

/** The classification waits at most this long before the post goes on as before (everyone mentioned acts). */
export const ADDRESSEE_TIMEOUT_MS = 2500;

export interface AddresseeDecision {
  strategy: string;
  scores: { agentId: string; score: number }[];
  /** Mentioned agents that get a run. */
  addressees: string[];
  /** Mentioned agents that are only referenced: no run. */
  referenced: string[];
  error?: string;
}

/**
 * A person's message that mentions two or more agents of the channel: which
 * of them is the person asking to act now, and which are only part of the
 * request ("@atlas, when an error comes in ask @ada to analyze it": Atlas
 * acts; Ada is referenced and keeps the message as context only). The judge
 * scores each mentioned agent; code applies the threshold. Fail-open: one
 * mention, no judge, an error, a timeout, or nobody above the threshold
 * keeps today's behaviour (every mentioned agent acts). Null when there was
 * nothing to classify.
 */
export async function classifyAddressees(
  db: Executor,
  judge: Judge,
  input: { orgId: string; channelId: string; userId: string; body: string },
  options: { timeoutMs?: number } = {},
): Promise<AddresseeDecision | null> {
  const handles = await currentHandles(db, input.orgId, parseMentionHandles(input.body));
  if (handles.length < 2) return null;
  const targets = await db
    .select({ id: agents.id, handle: agents.handle, name: agents.name, role: agents.role })
    .from(agents)
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.agentId, agents.id), eq(channelMembers.channelId, input.channelId)),
    )
    .where(and(eq(agents.orgId, input.orgId), inArray(agents.handle, handles), isNull(agents.archivedAt)));
  if (targets.length < 2) return null;
  const everyone = targets.map((t) => t.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [author] = await db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId));
    const judged = await Promise.race([
      personMentionAddressees(judge, {
        orgId: input.orgId,
        body: input.body,
        author: author?.name ?? "a person",
        targets: targets.map((t) => ({ agentId: t.id, handle: t.handle, name: t.name, role: t.role || null })),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("addressees: timed out")), options.timeoutMs ?? ADDRESSEE_TIMEOUT_MS);
      }),
    ]);
    const scores = targets.map((t) => ({ agentId: t.id, score: judged.get(t.id) ?? 0 }));
    const addressees = pickAddressees(scores);
    return {
      strategy: `addressees-${judge.name}`,
      scores,
      addressees,
      referenced: everyone.filter((id) => !addressees.includes(id)),
    };
  } catch (error) {
    return {
      strategy: `addressees-${judge.name}`,
      scores: everyone.map((agentId) => ({ agentId, score: 0 })),
      addressees: everyone,
      referenced: [],
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The addressee decision, for audit (`routing_decisions`; never fails the post). */
async function recordAddressees(db: Database, message: Message, d: AddresseeDecision) {
  await db
    .insert(schema.routingDecisions)
    .values({
      orgId: message.orgId,
      channelId: message.channelId,
      messageId: message.id,
      strategy: d.strategy,
      candidates: d.scores,
      selectedAgentIds: d.addressees,
      reason: d.referenced.length > 0 ? `referenced only: ${d.referenced.length}` : "every mentioned agent acts",
      error: d.error ?? null,
    })
    .onConflictDoNothing()
    .catch(() => undefined);
}

/**
 * A person's GIF or sticker (ADR 0091), looked up here: a GIF at the workspace's rating with the provider's own
 * title and size, a sticker of an agent of this workspace. What the app sent is never stored as it came.
 */
async function resolveMedia(
  deps: { db: Database; gifs?: GifProvider | null },
  orgId: string,
  input: MessageMediaInput,
): Promise<MessageMedia> {
  const settings = await mediaSettings(deps.db, orgId);
  const notFound = () => new ValidationError("That GIF or sticker isn't available", "message.media_not_found");
  if (input.kind === "gif") {
    // A provider without a key now (`available()`) is none: GIFs come back once the server's owner adds one.
    const gifs = deps.gifs?.available() ? deps.gifs : null;
    if (!gifs || !settings.gifs) throw new ValidationError("GIFs are off in this workspace", "message.media_off");
    if (!GIF_ID_PATTERN.test(input.id)) throw notFound();
    const gif = await gifs.get(input.id, settings.gifRating).catch((): never => {
      // The provider didn't answer: no GIFs for now, the same as without one.
      throw new ValidationError("GIFs aren't available right now", "message.media_off");
    });
    if (!gif) throw notFound();
    return { kind: "gif", provider: "giphy", id: gif.id, title: gif.title, width: gif.width, height: gif.height };
  }
  if (!settings.agentStickers) throw new ValidationError("Stickers are off in this workspace", "message.media_off");
  if (!UUID.test(input.agentId) || !isStickerMood(input.mood)) throw notFound();
  const [agent] = await deps.db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.id, input.agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt), isNull(agents.deletedAt)),
    );
  if (!agent) throw notFound();
  return { kind: "sticker", agentId: agent.id, mood: input.mood };
}

/**
 * The quoted message (one statement, with its author's name): a live message of this channel and, from a thread, of
 * that thread. The main timeline stays open to the channel: it shows the agents' replies, which live in their threads.
 */
async function replyRefFor(
  db: Database,
  orgId: string,
  channelId: string,
  messageId: string,
  threadId?: string | null,
): Promise<ReplyRef> {
  const [row] = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      threadId: messages.threadId,
      authorType: messages.authorType,
      authorUserId: messages.authorUserId,
      authorAgentId: messages.authorAgentId,
      body: messages.body,
      meta: messages.meta,
      deletedAt: messages.deletedAt,
      userName: schema.users.name,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(schema.users, eq(schema.users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)));
  const elsewhere = threadId && row?.id !== threadId && row?.threadId !== threadId;
  if (!row || row.deletedAt || row.channelId !== channelId || elsewhere) {
    throw new ValidationError("replyTo must be a message of this conversation", "message.reply_not_found");
  }
  const person = row.authorType === "person";
  const media = mediaOf(row.meta);
  return {
    messageId: row.id,
    threadId: row.threadId,
    author: { type: row.authorType, id: person ? row.authorUserId : row.authorAgentId },
    authorName: (person ? row.userName : row.agentName) ?? "",
    // A file with no words is quoted by its name, so people and agents still see what is answered.
    excerpt: replyExcerpt(readableBody(row.body, row.meta) || fileNameOf(row.meta)),
    ...(voiceOf(row.meta) ? { mediaKind: "voice" as const } : media ? { mediaKind: media.kind } : {}),
  };
}

const fileNameOf = (meta: Record<string, unknown>) => {
  const title = (meta.artifacts as { title?: unknown }[] | undefined)?.[0]?.title;
  return typeof title === "string" ? title : "";
};

/** The ids of the files on a message (`meta.artifacts`), in order. */
export const fileIdsOf = (meta: Record<string, unknown> | undefined): string[] =>
  (Array.isArray(meta?.artifacts) ? (meta.artifacts as { id?: unknown }[]) : []).flatMap((f) =>
    typeof f?.id === "string" ? [f.id] : [],
  );

/** Files for a message: the person's own uploads or files of this channel, not deleted. */
async function attachmentRefsFor(db: Database, userId: string, orgId: string, channelId: string, ids: string[]) {
  const wanted = [...new Set(ids)];
  if (wanted.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new ValidationError(`At most ${MAX_MESSAGE_ATTACHMENTS} files per message`, "message.too_many_attachments", {
      max: MAX_MESSAGE_ATTACHMENTS,
    });
  }
  const a = schema.artifacts;
  const rows = await db
    .select({ id: a.id, title: a.title, version: a.currentVersion })
    .from(a)
    .where(
      and(
        eq(a.orgId, orgId),
        inArray(a.id, wanted),
        isNull(a.deletedAt),
        or(eq(a.channelId, channelId), and(eq(a.createdByType, "person"), eq(a.createdById, userId))),
      ),
    );
  if (rows.length !== wanted.length) {
    throw new ValidationError("Attach files you uploaded or files of this channel", "message.attachment_not_found");
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wanted.map((id) => {
    const r = byId.get(id) as (typeof rows)[number];
    return { id: r.id, version: r.version, title: r.title };
  });
}

/** Reactions on these messages, grouped like `listReactions`. */
async function reactionsFor(db: Database, orgId: string, ids: string[]): Promise<Map<string, ReactionCount[]>> {
  const out = new Map<string, ReactionCount[]>();
  if (ids.length === 0) return out;
  const r = schema.messageReactions;
  const rows = await db
    .select({ messageId: r.messageId, reaction: r.reaction, userId: r.userId, agentId: r.agentId })
    .from(r)
    .where(and(eq(r.orgId, orgId), inArray(r.messageId, ids)))
    .orderBy(asc(r.createdAt));
  const byMessage = new Map<string, typeof rows>();
  for (const row of rows) byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row]);
  for (const [id, list] of byMessage) out.set(id, groupReactions(list));
  return out;
}

export async function getMessage(db: Executor, orgId: string, messageId: string): Promise<Message | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)));
  return row ?? null;
}

/**
 * Lists messages the user may read. Without `threadId`: top-level channel
 * messages, newest page first (returned oldest → newest). With `threadId`:
 * the thread root and its replies.
 */
export async function listMessages(
  db: Database,
  userId: string,
  orgId: string,
  channelId: string,
  options: { threadId?: string; before?: Date; limit?: number; includeReplies?: boolean } = {},
): Promise<MessageView[]> {
  await requireChannelAccess(db, userId, orgId, channelId);
  const limit = Math.min(options.limit ?? 50, 200);
  const scope = and(eq(messages.orgId, orgId), eq(messages.channelId, channelId), isNull(messages.deletedAt));
  if (options.threadId) {
    const root = await getMessage(db, orgId, options.threadId);
    if (!root || root.channelId !== channelId) throw new NotFoundError("Thread not found");
    // The latest ones, as the channel's list: past the limit, a reply just said must not be the one left out.
    const replies = await db
      .select()
      .from(messages)
      .where(
        and(
          scope,
          eq(messages.threadId, options.threadId),
          options.before ? lt(messages.createdAt, options.before) : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit);
    return withReceipts(db, orgId, [root, ...replies.reverse()]);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(scope, isNull(messages.threadId), options.before ? lt(messages.createdAt, options.before) : undefined))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  const views = await withReceipts(db, orgId, rows.reverse());
  return options.includeReplies ? withReplies(db, orgId, views) : views;
}

/** How many replies each thread has, when the last came, and the last three (with usage). */
async function withReplies(db: Database, orgId: string, roots: MessageView[]): Promise<MessageView[]> {
  const ids = roots.map((r) => r.id);
  if (ids.length === 0) return roots;
  const counts = await db
    .select({
      threadId: messages.threadId,
      n: sql<number>`count(*)::int`,
      last: sql<string>`max(${messages.createdAt})`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        inArray(messages.threadId, ids),
        isNull(messages.deletedAt),
        // An agent's sticker or GIF after its own reply (ADR 0091) is part of that reply: not one more.
        sql`${messages.meta}->>'mediaAfter' is null`,
        sql`not ${quietNoticeSql(sql`${messages.meta}`)}`,
      ),
    )
    .groupBy(messages.threadId);
  const recent = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        inArray(messages.threadId, ids),
        isNull(messages.deletedAt),
        sql`not ${quietNoticeSql(sql`${messages.meta}`)}`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(Math.min(600, ids.length * 20));
  const latestByThread = new Map<string, Message[]>();
  for (const m of recent) {
    const list = latestByThread.get(m.threadId ?? "") ?? [];
    if (list.length < 3) list.push(m);
    latestByThread.set(m.threadId ?? "", list);
  }
  const latestViews = await withReceipts(db, orgId, [...latestByThread.values()].flat());
  const viewById = new Map(latestViews.map((v) => [v.id, v]));
  const countBy = new Map(counts.map((c) => [c.threadId ?? "", c]));
  return roots.map((r) => {
    const c = countBy.get(r.id);
    const latest = (latestByThread.get(r.id) ?? [])
      .reverse()
      .flatMap((m) => (viewById.has(m.id) ? [viewById.get(m.id) as MessageView] : []));
    return {
      ...r,
      replies: { count: c?.n ?? 0, lastAt: c?.last ? new Date(c.last).toISOString() : null, latest },
    };
  });
}

/** Tokens of the runs that wrote these agent messages. */
async function usageFor(db: Database, orgId: string, list: Message[]) {
  const runIds = [...new Set(list.flatMap((m) => (m.authorType === "agent" && m.agentRunId ? [m.agentRunId] : [])))];
  const out = new Map<string, MessageUsage>();
  if (runIds.length === 0) return out;
  const u = schema.usageRecords;
  const rows = await db
    .select({
      runId: u.runId,
      model: sql<string>`max(${u.model})`,
      input: sql<number>`coalesce(sum(${u.inputTokens} + ${u.cacheReadTokens} + ${u.cacheWriteTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${u.outputTokens}), 0)::int`,
    })
    .from(u)
    .where(
      and(
        eq(u.orgId, orgId),
        inArray(u.runId, runIds),
        eq(u.kind, "agent"),
        sql`${u.provider} <> ${WEB_USAGE_PROVIDER}`,
      ),
    )
    .groupBy(u.runId);
  for (const r of rows) {
    if (!r.runId) continue;
    out.set(r.runId, {
      model: r.model,
      inputTokens: Number(r.input),
      outputTokens: Number(r.output),
    });
  }
  return out;
}

/** Which of these messages are pinned (one indexed read per channel of the list). */
async function pinnedOf(db: Database, orgId: string, list: Message[]): Promise<Set<string>> {
  if (list.length === 0) return new Set();
  const p = schema.messagePins;
  const rows = await db
    .select({ messageId: p.messageId })
    .from(p)
    .where(
      and(
        eq(p.orgId, orgId),
        inArray(p.channelId, [...new Set(list.map((m) => m.channelId))]),
        inArray(
          p.messageId,
          list.map((m) => m.id),
        ),
      ),
    );
  return new Set(rows.map((r) => r.messageId));
}

const longWorkOf = (m: Message, works: Map<string, WorkView>) => {
  const id = (m.meta.longWork as { id?: unknown } | undefined)?.id;
  const view = typeof id === "string" ? works.get(id) : undefined;
  return view ? { longWork: view } : {};
};

/** Message views with what lists carry: receipts, usage, reactions, memory marks, pins, wiki links. */
export const withMessageDetails = (db: Database, orgId: string, list: Message[]) => withReceipts(db, orgId, list);

async function withReceipts(db: Database, orgId: string, list: Message[]): Promise<MessageView[]> {
  const agentMessageIds = list.flatMap((m) => (m.authorType === "agent" ? [m.id] : []));
  const workIds = list.flatMap((m) => {
    const id = (m.meta.longWork as { id?: unknown } | undefined)?.id;
    return typeof id === "string" ? [id] : [];
  });
  const [receipts, usage, reactions, memories, pinned, actions, works] = await Promise.all([
    // A person's message, and an agent's that mentions agents (whom it handed work to, ADR 0089).
    receiptsFor(
      db,
      orgId,
      list.filter((m) => m.authorType === "person" || m.mentionedAgentIds.length > 0),
    ),
    usageFor(db, orgId, list),
    reactionsFor(
      db,
      orgId,
      list.map((m) => m.id),
    ),
    memoriesFor(db, orgId, list),
    pinnedOf(db, orgId, list),
    actionsFor(db, orgId, agentMessageIds),
    workIds.length ? workViews(db, orgId, workIds) : Promise.resolve(new Map<string, WorkView>()),
  ]);
  const views = list.map((m) => {
    const runUsage = m.agentRunId ? usage.get(m.agentRunId) : undefined;
    const reacted = reactions.get(m.id);
    return {
      ...messageView(m),
      ...(receipts.has(m.id) ? { receipts: receipts.get(m.id) } : {}),
      ...(runUsage ? { usage: runUsage } : {}),
      ...(reacted ? { reactions: reacted } : {}),
      ...(memories.has(m.id) ? { memories: memories.get(m.id) } : {}),
      ...(pinned.has(m.id) ? { pinned: true } : {}),
      ...(actions.has(m.id) ? { actions: actions.get(m.id) } : {}),
      ...longWorkOf(m, works),
    };
  });
  return withGoneQuotes(db, orgId, await withDeletedArtifacts(db, orgId, await withWikiLinks(db, orgId, views)));
}

/** A quote of a message deleted since keeps only that: the words saved with it go when the original does. */
async function withGoneQuotes(db: Database, orgId: string, views: MessageView[]): Promise<MessageView[]> {
  const quoteOf = (v: MessageView) => v.meta.replyTo as ReplyRef | undefined;
  const ids = [...new Set(views.flatMap((v) => quoteOf(v)?.messageId ?? []))];
  if (ids.length === 0) return views;
  const live = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), inArray(messages.id, ids), isNull(messages.deletedAt)));
  const alive = new Set(live.map((m) => m.id));
  return views.map((v) => {
    const quote = quoteOf(v);
    if (!quote || alive.has(quote.messageId)) return v;
    const { mediaKind: _gone, ...kept } = quote;
    return { ...v, meta: { ...v.meta, replyTo: { ...kept, authorName: "", excerpt: "", deleted: true } } };
  });
}

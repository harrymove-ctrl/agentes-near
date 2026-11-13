import type { PubSub } from "@agenteschat/adapters";
import { and, count, type Database, eq, inArray, isNotNull, isNull, lt, schema } from "@agenteschat/db";
import type { BlockSpec } from "@agenteschat/ui/blocks/spec";
import {
  ARTIFACT_LIMITS,
  type ArtifactContent,
  type ArtifactDeps,
  type ChoiceQuestion,
  createConversationArtifact,
  getArtifact,
  updateArtifact,
} from "./artifacts";
import { runAuthorityById } from "./authority";
import { requireChannelAccess } from "./channels";
import { publishDelivery } from "./delivery";
import { isAgentOnlyDm } from "./dms";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { type MessageView, postPersonMessage } from "./messages";
import type { Notice } from "./notices";
import { can } from "./organizations";
import { enqueue } from "./outbox";
import { deliverNoticeToRun } from "./run-resume";
import { replyThreadOf } from "./runs";
import type { Talker } from "./talker";
import { listsEveryTool } from "./tools/directory";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const { agentRuns, agents, artifacts, channelMembers, channels, choiceAnswers, messages, pollVotes, polls, users } =
  schema;

/**
 * What lives in a conversation and not in the Drive (ADR 0113). A file is for keeping; a block is for using now: a
 * small interactive thing in the agent's reply, and what the person picks comes back to the agent. A poll is the
 * same for several people, drawn by the apps themselves: a vote is an act of the person's, so no page may cast one.
 */

export const SHOW_BLOCK_TOOL = "show_block";
export const START_POLL_TOOL = "start_poll";
export const ASK_CHOICES_TOOL = "ask_choices";
export const POLL_CLOSE_JOB = "poll.close";

const DEFAULT_POLL_HOURS = 24;
const MAX_POLL_HOURS = 7 * 24;
/** What a block can send back: the person reads it before it goes. */
export const BLOCK_REPLY_CHARS = 2000;

/**
 * The manual an agent writes blocks from: the parts and the formula language of `@agenteschat/ui/blocks/spec` and
 * `expr`, which the apps draw with their own components. The agent's own page (`html`, over the kit in
 * `packages/client/src/lib/block-kit.ts`) is the way out for what no part shows, and runs only when a person asks.
 */
export const BLOCK_MANUAL = `A live block is a small interactive thing inside your reply: something the person uses now (a simulator, a filterable view, options to see side by side, a short form). Reports and documents are files, not blocks; a question with plain choices is ask_choices.

Describe it in spec, as JSON. The app draws it with its own parts, in its look and in both themes: you write no HTML, CSS or colors. There is no network: put the data in the block. Everyone in the conversation sees what is typed in a block, so never ask for passwords, keys or card numbers in one: use request_secret. Every word on it is in the person's language.

spec: {data, state, compute, parts, send}, all but parts optional.
- data: fixed values the formulas read (prices, lists of records).
- state: starting values that no input holds (a step, a pick).
- compute: name: formula, in order; each reads the values above it. What the block shows follows from these.
- parts: what it shows, top to bottom. Any part takes "when": a formula, to show it only then.

Inputs (each has a name; its value is the same for everyone, and you read it):
- {"type":"slider","name","label","min","max","step","value","format","unit"}
- {"type":"choice","name","label","options":["A","B"],"value"} buttons, one pick; "value":null starts with none, as a quiz needs
- {"type":"field","name","label","input":"text|number|date|textarea","placeholder"}
- {"type":"switch","name","label","value":false}
Showing:
- {"type":"heading|text|note","text"} and {"type":"list","items":[...]}; {name} or {name:format} in the text fills in a value
- {"type":"stat","label","value","format","unit","sub","tone"} a big number; {"type":"stats","items":[stats]} a row of them; tone is a formula giving "up" or "down"
- {"type":"result","label","value","format","unit"} the answer the block gives, large and centered
- {"type":"progress","label","value","max","format"}
- {"type":"chart","chart":"bar|line|pie","label","items":[{"label","value"}],"unit"}, or "data": a formula giving [{label, value}]
- {"type":"table","columns":[{"label","key","format"}],"rows"}: the records, or a formula giving them
Layout: {"type":"row","parts"} side by side; {"type":"card","label","sub","parts"}, and with "name" and "value" a card is a choice (a click sets name to value); {"type":"more","label","parts"} details that open; {"type":"actions","buttons":[{"label","set":{"name":"formula"}} or {"label","draw":{"name","options":[...]}}]}.
format: brl (1200 is R$ 1.200), mil (12 is R$ 12 mil: the value is in thousands), pct, int. A chart takes unit ("R$", "%", "h").

A value, a "set" and a "when" are formulas, written as text: + - * / % ^, == != < > <= >=, && || !, a ? b : c, 'text', [lists], {label: 'A', value: x}, row.field, list[0]. Functions: min max abs round(x, digits) floor ceil sqrt clamp(x, lo, hi) sum avg count len map filter find sort reverse slice first last range join includes lower upper text number fmt(x, 'brl') if. List functions take a step: sum(items, x => x.price * x.qty), map(range(12), m => {label: 'M' + (m + 1), value: saldo * (1 + taxa / 100) ^ m}), filter(lojas, l => cidade == 'Todas' || l.cidade == cidade).

A random pick (a draw, a wheel, dice, a shuffle) is a button with draw: the server picks once among the options, the same for everyone, and a result showing that name rolls into it. Never make anything random yourself.

To get an answer, add send: {"label":"Usar este preço","text":"Usar {preco:brl}.","needs":["a"],"hint":"Why it waits"}. The app shows the text and the button outside the block and the person decides; it reaches you as their message. needs lists values that must be filled or true. Add it only when your next step depends on the answer: you read what people set even without it.

When a number comes from your own formula, show how in a "more" part and call it an estimate. If the block is refused, the error says where (parts[2].value: ...): fix that and call again.

Example:
{"data":{"custo":40},"compute":{"margem":"(preco - custo) / preco * 100"},"parts":[{"type":"slider","name":"preco","label":"Preço","min":50,"max":200,"step":10,"value":100,"format":"brl"},{"type":"stat","label":"Margem","value":"margem","format":"pct"}],"send":{"label":"Usar este preço","text":"Usar {preco:brl}."}}

A draw:
{"parts":[{"type":"result","label":"Sorteado","value":"nome"},{"type":"actions","align":"center","buttons":[{"label":"Sortear","draw":{"name":"nome","options":["Ana","Bia"]}}]}]}

Only when no part can show it (a game, a free drawing, an animation), send html instead of spec: short HTML with an inline script and canvas, no <html> or <body>, no network, colors only from the CSS variables --ink, --muted, --raised, --line and --s1 to --s6. agentes.set(name, value), agentes.on(s => ...) and agentes.draw(name, options) share its state like the parts do. It shows as a card that runs only when a person presses it, so a spec is always better when the parts reach.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
const actorOf = (ctx: ToolContext) => ({
  type: "agent" as const,
  agentId: ctx.agentId,
  channelId: ctx.channelId,
  threadId: replyThreadOf(ctx),
  runId: ctx.runId,
});

export interface PollVote {
  userId: string;
  option: number;
}

/** A poll as the apps draw it; its question and options are the artifact's content (`poll.updated`). */
export interface PollView {
  id: string;
  closesAt: string;
  closedAt: string | null;
  /** How many people can answer: the conversation's members, or more when others voted. */
  people: number;
  votes: PollVote[];
}

async function memberCount(db: Database, channelId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), isNotNull(channelMembers.userId)));
  return row?.n ?? 0;
}

async function loadPollView(db: Database, orgId: string, artifactId: string, channelId: string): Promise<PollView> {
  const [poll] = await db
    .select()
    .from(polls)
    .where(and(eq(polls.artifactId, artifactId), eq(polls.orgId, orgId)));
  if (!poll) throw new NotFoundError("Poll not found");
  const votes = await db
    .select({ userId: pollVotes.userId, option: pollVotes.option })
    .from(pollVotes)
    .where(eq(pollVotes.artifactId, artifactId));
  const voters = new Set(votes.map((v) => v.userId)).size;
  return {
    id: artifactId,
    closesAt: poll.closesAt.toISOString(),
    closedAt: poll.closedAt?.toISOString() ?? null,
    people: Math.max(voters, await memberCount(db, channelId)),
    votes,
  };
}

/** A poll, for someone who can see its conversation. */
export async function getPoll(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string) {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId);
  if (a.kind !== "poll" || !a.channelId) throw new NotFoundError("Poll not found");
  return loadPollView(deps.db, orgId, artifactId, a.channelId);
}

/** A person's choices, replacing their last ones. Empty takes their vote back. The last one in closes the poll. */
export async function votePoll(
  deps: ArtifactDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  options: number[],
): Promise<PollView> {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId);
  if (a.kind !== "poll" || a.content.kind !== "poll" || !a.channelId) throw new NotFoundError("Poll not found");
  const { membership } = await requireChannelAccess(deps.db, userId, orgId, a.channelId);
  if (!can(membership, "post")) throw new ForbiddenError();
  const { options: labels, multiple } = a.content;
  const chosen = [...new Set(options)];
  if (chosen.some((o) => !Number.isInteger(o) || o < 0 || o >= labels.length)) {
    throw new ValidationError("no such option");
  }
  if (!multiple && chosen.length > 1) throw new ValidationError("this poll takes one option");
  await deps.db.transaction(async (tx) => {
    const [poll] = await tx
      .select()
      .from(polls)
      .where(and(eq(polls.artifactId, artifactId), eq(polls.orgId, orgId), isNull(polls.closedAt)))
      .for("update");
    if (!poll || poll.closesAt.getTime() <= Date.now()) {
      throw new ValidationError("This poll has closed", "poll.closed");
    }
    await tx.delete(pollVotes).where(and(eq(pollVotes.artifactId, artifactId), eq(pollVotes.userId, userId)));
    if (chosen.length > 0) {
      await tx.insert(pollVotes).values(chosen.map((option) => ({ orgId, artifactId, userId, option })));
    }
  });
  const poll = await loadPollView(deps.db, orgId, artifactId, a.channelId);
  await publishChannelEvent(deps.pubsub, { type: "poll.updated", channelId: a.channelId, poll });
  if (new Set(poll.votes.map((v) => v.userId)).size >= poll.people) {
    return (await closePoll(deps, orgId, artifactId)) ?? poll;
  }
  return poll;
}

/** How a closed poll came out, as the agent reads it. */
async function resultText(
  db: Database,
  content: { question: string; options: string[] },
  poll: PollView,
): Promise<string> {
  const ids = [...new Set(poll.votes.map((v) => v.userId))];
  const people = ids.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
    : [];
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "someone";
  const lines = content.options.map((label, i) => {
    const who = poll.votes.filter((v) => v.option === i).map((v) => nameOf(v.userId));
    return `- ${label}: ${who.length}${who.length ? ` (${who.join(", ")})` : ""}`;
  });
  return `"${content.question}"\n${lines.join("\n")}\n${ids.length} of ${poll.people} people answered.`;
}

/**
 * Closes a poll once: its time came (`POLL_CLOSE_JOB`) or the last person voted. The agent that started it hears the
 * result. Returns null when it had already closed or is gone.
 */
export async function closePoll(deps: ArtifactDeps, orgId: string, artifactId: string): Promise<PollView | null> {
  const [closed] = await deps.db
    .update(polls)
    .set({ closedAt: new Date() })
    .where(and(eq(polls.artifactId, artifactId), eq(polls.orgId, orgId), isNull(polls.closedAt)))
    .returning();
  if (!closed) return null;
  const [row] = await deps.db
    .select({ agentId: artifacts.createdById, channelId: artifacts.channelId })
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.orgId, orgId), isNull(artifacts.deletedAt)));
  if (!row?.channelId) return null;
  const actor = { type: "agent" as const, agentId: row.agentId, channelId: row.channelId };
  const a = await getArtifact(deps, actor, orgId, artifactId);
  if (a.content.kind !== "poll" || !a.channelId) return null;
  const poll = await loadPollView(deps.db, orgId, artifactId, a.channelId);
  await publishChannelEvent(deps.pubsub, { type: "poll.updated", channelId: a.channelId, poll });
  const [run] = await deps.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, closed.runId)));
  if (!run) return poll;
  const notice: Notice = {
    kind: "poll_result",
    from: "Your poll",
    text: await resultText(deps.db, a.content, poll),
    refs: { artifactId, runId: run.id },
  };
  const delivered = await deps.db.transaction((tx) => deliverNoticeToRun(tx, run, notice));
  await publishDelivery(deps.pubsub, delivered).catch(() => {});
  return poll;
}

type ReplyDeps = ArtifactDeps & { pubsub: PubSub; judge?: Judge; talker?: Talker };

/**
 * What a person sent back from a block: their own message to the agent that made it, in the block's place. The apps
 * show this exact text beside the button, outside the block: the block proposes, the person sends.
 */
export async function replyToBlock(
  deps: ReplyDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  input: { text: string; clientId?: string | null },
): Promise<MessageView> {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId);
  if (a.kind !== "block" || !a.channelId) throw new NotFoundError("Block not found");
  const text = input.text.trim();
  if (!text) throw new ValidationError("Nothing to send");
  if (text.length > BLOCK_REPLY_CHARS) throw new ValidationError("That is too long to send");
  return replyAsPerson(deps, userId, orgId, a, text, { blockReply: { id: a.id, title: a.title } }, input.clientId);
}

/** The person's own message to the agent that made `a`, where `a` is: in a channel it names the agent. */
async function replyAsPerson(
  deps: ReplyDeps,
  userId: string,
  orgId: string,
  a: { channelId: string | null; threadId: string | null; createdBy: { id: string } },
  text: string,
  meta: Record<string, unknown>,
  clientId?: string | null,
): Promise<MessageView> {
  if (!a.channelId) throw new NotFoundError("Not in a conversation");
  const [where] = await deps.db
    .select({ kind: channels.kind, handle: agents.handle })
    .from(channels)
    .leftJoin(agents, and(eq(agents.orgId, orgId), eq(agents.id, a.createdBy.id)))
    .where(and(eq(channels.id, a.channelId), eq(channels.orgId, orgId)));
  // Other agents may be in the channel: the answer goes to the one that asked.
  const body = where?.handle && where.kind !== "dm" ? `@${where.handle} ${text}` : text;
  return postPersonMessage(deps, userId, orgId, a.channelId, { body, threadId: a.threadId, clientId, meta });
}

/**
 * A choice card's answer as the apps draw it (`choices.updated`); its questions are the artifact's content. A pick past
 * a question's last option is "Outra resposta": what was written is in `others`, at that question's place.
 */
export interface ChoicesView {
  id: string;
  answer: {
    userId: string;
    picks: number[];
    messageId: string | null;
    at: string;
    others?: (string | null)[];
  } | null;
}

/**
 * A claim whose message was never posted (the process died between the two steps) stops holding the card after this:
 * the card opens again. Posting can wait on the judge, so it is far longer than a post takes.
 */
const UNPOSTED_CLAIM_MS = 5 * 60_000;
const unposted = (artifactId: string) =>
  and(
    eq(choiceAnswers.artifactId, artifactId),
    isNull(choiceAnswers.messageId),
    lt(choiceAnswers.createdAt, new Date(Date.now() - UNPOSTED_CLAIM_MS)),
  );

/** The written answers a reply carries (`meta.choiceReply.others`), the person's message being where they live. */
async function writtenAnswers(db: Database, orgId: string, messageId: string) {
  const [row] = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
    .limit(1);
  const others = (row?.meta.choiceReply as { others?: unknown } | undefined)?.others;
  return Array.isArray(others) && others.every((o) => o === null || typeof o === "string")
    ? (others as (string | null)[])
    : undefined;
}

async function loadChoicesView(db: Database, orgId: string, artifactId: string): Promise<ChoicesView> {
  const [row] = await db
    .select()
    .from(choiceAnswers)
    .where(and(eq(choiceAnswers.artifactId, artifactId), eq(choiceAnswers.orgId, orgId)));
  const lost = row && !row.messageId && row.createdAt.getTime() < Date.now() - UNPOSTED_CLAIM_MS;
  if (!row || lost) return { id: artifactId, answer: null };
  const others = row.messageId ? await writtenAnswers(db, orgId, row.messageId) : undefined;
  return {
    id: artifactId,
    answer: {
      userId: row.userId,
      picks: row.picks,
      messageId: row.messageId,
      at: row.createdAt.toISOString(),
      ...(others ? { others } : {}),
    },
  };
}

/** A choice card and its answer, for someone who can see its conversation. */
export async function getChoices(deps: ArtifactDeps, userId: string, orgId: string, artifactId: string) {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId);
  if (a.kind !== "choices") throw new NotFoundError("Choice card not found");
  return loadChoicesView(deps.db, orgId, artifactId);
}

/**
 * What the agent reads as the person's reply: each question with its pick, or what they wrote instead, one per line.
 * The question is always there: the agent's own history shows its reply text, not the card it sent.
 */
export function choiceReplyText(
  questions: ChoiceQuestion[],
  picks: number[],
  others: readonly (string | null | undefined)[] = [],
): string {
  return questions.map((q, i) => `${q.question} ${others[i] ?? q.options[picks[i] as number]?.label ?? ""}`).join("\n");
}

/**
 * A person picks on a choice card (ADR 0124): one option per question, or a written answer ("Outra resposta": the
 * pick past its last option, the text in `others` at its place), once, the first answer in. It goes to the agent as
 * that person's own message (`meta.choiceReply`, which keeps what was written), and the card shows the answer to
 * everyone.
 */
export async function answerChoices(
  deps: ReplyDeps,
  userId: string,
  orgId: string,
  artifactId: string,
  input: { picks: number[]; others?: (string | null)[] | null; clientId?: string | null },
): Promise<{ choices: ChoicesView; message: MessageView }> {
  const a = await getArtifact(deps, { type: "person", userId }, orgId, artifactId);
  if (a.kind !== "choices" || a.content.kind !== "choices" || !a.channelId)
    throw new NotFoundError("Choice card not found");
  const { questions } = a.content;
  const picks = input.picks;
  const others = questions.map((q, i) => (picks[i] === q.options.length ? (input.others?.[i]?.trim() ?? "") : null));
  const fits = (p: number, i: number) => {
    const q = questions[i];
    if (!q || !Number.isInteger(p)) return false;
    const written = others[i];
    if (written === null || written === undefined) return Boolean(q.options[p]);
    return written.length > 0 && written.length <= ARTIFACT_LIMITS.choiceOtherChars;
  };
  if (picks.length !== questions.length || !picks.every(fits))
    throw new ValidationError("Pick an option or write an answer for each question");
  const wrote = others.some((o) => o !== null);
  await deps.db.delete(choiceAnswers).where(unposted(artifactId));
  const [claimed] = await deps.db
    .insert(choiceAnswers)
    .values({ artifactId, orgId, userId, picks })
    .onConflictDoNothing()
    .returning({ artifactId: choiceAnswers.artifactId });
  if (!claimed) throw new ConflictError("This card was already answered", "choices.answered");
  const message = await replyAsPerson(
    deps,
    userId,
    orgId,
    a,
    choiceReplyText(questions, picks, others),
    { choiceReply: { id: a.id, title: a.title, ...(wrote ? { others } : {}) } },
    input.clientId,
  ).catch(async (error: unknown) => {
    // Not sent: the card stays open for another try.
    await deps.db.delete(choiceAnswers).where(eq(choiceAnswers.artifactId, artifactId));
    throw error;
  });
  await deps.db.update(choiceAnswers).set({ messageId: message.id }).where(eq(choiceAnswers.artifactId, artifactId));
  const choices = await loadChoicesView(deps.db, orgId, artifactId);
  await publishChannelEvent(deps.pubsub, { type: "choices.updated", channelId: a.channelId, choices });
  return { choices, message };
}

/** Choices need someone to pick: a run a person is behind, where people read (ADR 0124). */
export async function someoneAnswers(ctx: ToolContext) {
  if (ctx.background || !ctx.runId) return false;
  const [channel] = await ctx.db
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.id, ctx.channelId), eq(channels.orgId, ctx.orgId)));
  if (!channel || isAgentOnlyDm(channel)) return false;
  return (await runAuthorityById(ctx.db, ctx.orgId, ctx.runId)).kind === "person";
}

/**
 * `show_block` and `start_poll`: no scope, like `react` and `ask_user`, because they only speak in the agent's own
 * conversation and touch nothing outside it (ADR 0109). `tools/run-policy.ts` lists them as `HERE`.
 */
export function createBlockToolSource(deps: ArtifactDeps): ToolSource {
  const showBlock: ToolDefinition = {
    name: SHOW_BLOCK_TOOL,
    // The manual comes on first use (a call without html), not in every request (token-trim B2).
    description:
      "Show a live block in your reply: a small interactive thing the person uses now (a what-if simulator, options to see side by side, a filterable view, a short form); what they pick comes back to you. Use it on your own whenever using something beats reading about it; nobody needs to ask for one, and it needs no approval: the app draws it from your description and it can't reach anything. Reports and documents are files; a question with plain choices is ask_choices. Call it first with only `title` to get the manual (the parts and formulas a block is described with), then with `spec`. To change a block you showed, send its block_id.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200, description: "What it is, in the person's language" },
        subtitle: { type: "string", maxLength: 120, description: "A short line: where the data comes from and when" },
        spec: { type: "object", description: "The block: data, state, compute, parts and send (see the manual)" },
        html: {
          type: "string",
          description: "Only when no part can show it: your own page, which runs only when a person presses it",
        },
        block_id: { type: "string", minLength: 36, maxLength: 36, description: "A block of yours to replace" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Show ${str(input.title)}` }),
    async execute(input, ctx) {
      const spec = input.spec;
      const html = str(input.html);
      const hasSpec = spec !== undefined && spec !== null;
      if (!hasSpec && !html.trim()) return { content: BLOCK_MANUAL };
      try {
        const actor = actorOf(ctx);
        const title = str(input.title);
        const subtitle = str(input.subtitle).trim() || undefined;
        const blockId = str(input.block_id);
        // A spec when there is one: a page runs only on a click, so the parts win when the agent sent both.
        const content: Extract<ArtifactContent, { kind: "block" }> = hasSpec
          ? { kind: "block", spec: spec as BlockSpec, subtitle }
          : { kind: "block", html, subtitle };
        const a = blockId
          ? await updateArtifact(deps, actor, ctx.orgId, blockId, { content, note: "updated", title })
          : await createConversationArtifact(deps, actor, ctx.orgId, { title, content });
        return {
          content: `Showing "${a.title}" in your reply as block ${a.id}. Write a line or two around it, and don't repeat what it shows.`,
          data: { artifact: { id: a.id, version: a.version, title: a.title } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };

  const startPoll: ToolDefinition = {
    name: START_POLL_TOOL,
    description:
      "Start a vote among the people in this conversation: they mark options, everyone sees the votes come in, and the result reaches you when it closes (at closes_in_hours, or as soon as everyone has voted). Use it when a group has to decide; for one person's choice use ask_user or a block.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 200 },
        options: { type: "array", items: { type: "string", minLength: 1, maxLength: 120 }, minItems: 2, maxItems: 8 },
        multiple: { type: "boolean", description: "Each person may mark more than one" },
        closes_in_hours: {
          type: "number",
          minimum: 1,
          maximum: MAX_POLL_HOURS,
          description: `Default ${DEFAULT_POLL_HOURS}`,
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Start a vote: ${cutText(str(input.question), 60)}` }),
    async execute(input, ctx) {
      try {
        const hours = typeof input.closes_in_hours === "number" ? input.closes_in_hours : DEFAULT_POLL_HOURS;
        const closesAt = new Date(Date.now() + Math.min(MAX_POLL_HOURS, Math.max(1, hours)) * 3600_000);
        const question = str(input.question);
        const a = await createConversationArtifact(deps, actorOf(ctx), ctx.orgId, {
          title: question,
          content: {
            kind: "poll",
            question,
            options: (input.options as string[]) ?? [],
            multiple: input.multiple === true,
          },
        });
        await deps.db.transaction(async (tx) => {
          await tx.insert(polls).values({ artifactId: a.id, orgId: ctx.orgId, runId: ctx.runId, closesAt });
          await enqueue(tx, {
            orgId: ctx.orgId,
            kind: POLL_CLOSE_JOB,
            payload: { artifactId: a.id },
            dedupeKey: `${POLL_CLOSE_JOB}:${a.id}`,
            runAt: closesAt,
          });
        });
        return {
          content: `The vote is in your reply. It closes on ${closesAt.toISOString()} or when everyone has voted, and you'll hear the result then. Say in a line what you're asking and end your turn.`,
          data: { artifact: { id: a.id, version: a.version, title: a.title } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };

  const askChoices: ToolDefinition = {
    name: ASK_CHOICES_TOOL,
    description:
      'Ask the person to pick between a few clear options, as a one-click card (options lettered A, B, C…), instead of writing "you have two options: 1… 2…" in your reply. Use it for a short decision between options you can name: which way to go, which fix, now or later. Several related decisions can go in one card (questions, up to 5), each taking a written answer too: never add an "Other" option. Never for an open question, a secret (request_secret) or an approval of a sensitive action (that action asks by itself). Their pick or written answer reaches you as their next message. To stop mid-work for an answer, use ask_user instead. After calling, write at most one short line around it and end your turn: don\'t repeat the options in your text.',
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "A few words: what is being decided" },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              question: { type: "string", minLength: 1, maxLength: 300 },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 6,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", minLength: 1, maxLength: 120 },
                    description: { type: "string", maxLength: 200, description: "One short line, when it helps" },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "questions"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: `Ask: ${cutText(str(input.title), 60)}` }),
    async execute(input, ctx) {
      try {
        const a = await createConversationArtifact(deps, actorOf(ctx), ctx.orgId, {
          title: str(input.title).trim(),
          content: { kind: "choices", questions: (input.questions as ChoiceQuestion[]) ?? [] },
        });
        return {
          content: "The card is in your reply. Their pick reaches you as their next message: end your turn now.",
          data: { artifact: { id: a.id, version: a.version, title: a.title } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };

  // A run that lists every tool has it whoever is behind the run, and is told why it can't use it when nobody can pick.
  const choices: ToolDefinition = {
    ...askChoices,
    async execute(input, ctx) {
      if (!(await someoneAnswers(ctx))) {
        return {
          content:
            "Nobody can pick on a card in this run (a routine's work, or a conversation between agents): decide within your permissions and say what you chose, or write the options in your answer.",
          isError: true,
        };
      }
      return askChoices.execute(input, ctx);
    },
  };

  return {
    name: "blocks",
    tools: async (ctx) =>
      listsEveryTool(ctx)
        ? [showBlock, startPoll, choices]
        : [showBlock, startPoll, ...((await someoneAnswers(ctx)) ? [askChoices] : [])],
  };
}

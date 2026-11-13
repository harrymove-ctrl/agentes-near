import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, gte, isNull, schema, sql } from "@agenteschat/db";
import { getAgent } from "../agents";
import { audienceError, canTalkTo, speakerOf } from "../audience";
import { UUID } from "../authority";
import { routineBriefOfRun } from "../background";
import { requireChannelAccess } from "../channels";
import { deliverNotice, publishDelivery } from "../delivery";
import { eligibleChannelAgents } from "../dispatch";
import { isAgentOnlyDm, openPersonAgentDm } from "../dms";
import { ConflictError, NotFoundError } from "../errors";
import { cutText } from "../format";
import { getMessage } from "../messages";
import type { Notice } from "../notices";
import { getMembership } from "../organizations";
import { enqueue } from "../outbox";
import { RIGHT_HAND } from "../right-hand";
import { forPeople } from "../run-resume";
import { replyThreadOf } from "../runs";
import { closedRefusal, orgStanding } from "../standing";
import type { ToolContext } from "../tools/types";
import { UNTRUSTED_MAX_CHARS } from "../untrusted";
import { parseRepo } from "./repos";
import { signedByAgent } from "./signature";

const {
  accounts,
  agentRuns,
  agents,
  channels,
  githubAppInstallations,
  githubItems,
  issues,
  messages,
  organizationMembers,
  users,
} = schema;

/**
 * What happens on GitHub wakes the agent it concerns (ADR 0156): the app's webhook queues each event GitHub sends once
 * (`queueGitHubAppEvent`, deduped by its delivery id), and its job (`handleGitHubAppEvent`) brings it to the agent that
 * opened or wrote on the item, in the conversation that work came from (`github_items`), or a mention of the app on an
 * item no agent worked on to the workspace's right hand, to hand on. A member whose GitHub account is linked to their
 * sign-in wakes the agent with them behind the run; anyone else only leaves the notice, which a member may ask the
 * agent to answer (`answerGitHubNotice`). Bots, the app's own included, and what our agents wrote are never news.
 */

export const GITHUB_EVENT_JOB = "github_app.event";

/** A GitHub item an agent wrote on: its repository (`owner/name`) and number, and whether the agent opened it. */
export interface GitHubItemRef {
  repo: string;
  number: number;
  authored: boolean;
}

const GITHUB_ITEM_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues|discussions)\/(\d+)/;
const NUMBER_INPUTS = ["pullNumber", "issue_number", "discussionNumber"] as const;

/**
 * The item a GitHub tool's call wrote on: the call's repository and number, or for one it opened (and one named only by
 * a comment's id) the link in GitHub's answer. Null when neither says.
 */
export function githubItemOfCall(tool: string, input: Record<string, unknown>, answer: string): GitHubItemRef | null {
  const authored = tool === "create_pull_request" || (tool === "issue_write" && input.method === "create");
  const named = parseRepo(`${String(input.owner ?? "")}/${String(input.repo ?? "")}`);
  const number = NUMBER_INPUTS.map((k) => input[k]).find((n): n is number => Number.isInteger(n) && Number(n) > 0);
  if (!authored && named && number) return { repo: `${named.owner}/${named.repo}`, number, authored };
  const link = GITHUB_ITEM_URL.exec(answer);
  return link?.[1] && parseRepo(link[1]) ? { repo: link[1], number: Number(link[2]), authored } : null;
}

/**
 * Keeps where the agent wrote on a GitHub item from: the run's conversation (a routine's run: where the routine
 * reports). The agent that opened it keeps it; one only written on goes to the agent that wrote last. The run kept is
 * the last one on a task: one GitHub woke to answer there has none, and a merge must still name the task.
 */
export async function recordGitHubItem(ctx: ToolContext, item: GitHubItemRef) {
  const to = ctx.background ? (await routineBriefOfRun(ctx.db, ctx))?.deliverTo : undefined;
  const values = {
    orgId: ctx.orgId,
    repo: item.repo.toLowerCase(),
    number: item.number,
    agentId: ctx.agentId,
    authored: item.authored,
    channelId: to?.channelId ?? ctx.channelId,
    threadId: to ? to.threadId : replyThreadOf(ctx),
    runId: UUID.test(ctx.runId) ? ctx.runId : null,
  };
  await ctx.db
    .insert(githubItems)
    .values(values)
    .onConflictDoUpdate({
      target: [githubItems.orgId, githubItems.repo, githubItems.number],
      set: {
        agentId: values.agentId,
        channelId: values.channelId,
        threadId: values.threadId,
        runId: sql`coalesce((select r.id from ${agentRuns} r where r.org_id = excluded.org_id and r.id = excluded.run_id
          and r.issue_id is not null), ${githubItems.runId}, excluded.run_id)`,
        authored: sql`${githubItems.authored} or excluded.authored`,
        updatedAt: new Date(),
      },
      setWhere: sql`not ${githubItems.authored} or ${githubItems.agentId} = excluded.agent_id`,
    });
}

/** What happened: a comment, a review, the app's review asked, an item opened naming the app, merged or closed. */
export type GitHubEventAction = "comment" | "review" | "review_requested" | "opened" | "merged" | "closed";

/** One GitHub event as its job reads it: the item, who did it, and their text (cut). */
export interface GitHubAppEvent {
  installationId: number;
  action: GitHubEventAction;
  item: "pull_request" | "issue" | "discussion";
  repo: string;
  number: number;
  url: string;
  sender: { id: number; login: string };
  body: string;
  /** A review's verdict: `approved`, `changes_requested` or `commented`. */
  state: string | null;
  /** It names the app's bot (`@slug`), or asks for its review. */
  mentioned: boolean;
  /** GitHub's `X-GitHub-Delivery`, set when queued: a job run twice brings it once. */
  delivery?: string;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** `@slug` (or `@slug[bot]`) in the text, as GitHub writes a mention. */
const namesApp = (text: string, slug: string) =>
  [...text.matchAll(/(?:^|[^\w/@.-])@([A-Za-z0-9-]+)/g)].some((m) => m[1]?.toLowerCase() === slug.toLowerCase());

/** Which kind of item a GitHub event is about: a comment on an issue's number may be a pull request's. */
function itemKind(event: string, issue: Record<string, unknown>): GitHubAppEvent["item"] {
  if (event.startsWith("discussion")) return "discussion";
  if (event.startsWith("pull_request")) return "pull_request";
  return issue.pull_request ? "pull_request" : "issue";
}

/**
 * The event agents hear in what GitHub sent (`X-GitHub-Event` and its payload), null for any other: a comment, a
 * submitted review with something to read, the app's bot asked to review, a pull request, issue or discussion opened
 * naming the app, a pull request merged or closed, an issue closed. Bots' text and what our agents signed are left
 * out, and so is an item the app itself closed (an agent did it).
 */
export function githubAppEventOf(
  event: string | null,
  payload: Record<string, unknown>,
  slug?: string,
): GitHubAppEvent | null {
  const installationId = obj(payload.installation).id;
  const sender = obj(payload.sender);
  const repo = str(obj(payload.repository).full_name);
  if (!event || typeof installationId !== "number" || typeof sender.id !== "number" || !parseRepo(repo)) return null;
  const bot = slug ? `${slug}[bot]`.toLowerCase() : null;
  const action = payload.action;
  const pr = obj(payload.pull_request);
  const target = event.startsWith("discussion")
    ? obj(payload.discussion)
    : event.startsWith("pull_request")
      ? pr
      : obj(payload.issue);
  let what: { action: GitHubEventAction; body: string; url: string; state?: string } | null = null;
  if (
    action === "created" &&
    (event === "issue_comment" || event === "pull_request_review_comment" || event === "discussion_comment")
  ) {
    const comment = obj(payload.comment);
    what = { action: "comment", body: str(comment.body), url: str(comment.html_url) };
  } else if (event === "pull_request_review" && action === "submitted") {
    const review = obj(payload.review);
    const state = str(review.state).toLowerCase();
    // Inline comments only: each comes as its own `pull_request_review_comment`.
    if (state === "commented" && !str(review.body).trim()) return null;
    what = { action: "review", body: str(review.body), url: str(review.html_url), state };
  } else if ((event === "pull_request" || event === "issues") && action === "closed") {
    what = { action: pr.merged === true ? "merged" : "closed", body: "", url: str(target.html_url) };
  } else if (event === "pull_request" && action === "review_requested") {
    if (!bot || str(obj(payload.requested_reviewer).login).toLowerCase() !== bot) return null;
    what = { action: "review_requested", body: "", url: str(pr.html_url) };
  } else if (
    ((event === "issues" || event === "pull_request") && action === "opened") ||
    (event === "discussion" && action === "created")
  ) {
    what = { action: "opened", body: str(target.body), url: str(target.html_url) };
  }
  if (!what) return null;
  const closing = what.action === "merged" || what.action === "closed";
  // A merge queue or other automation still closes an agent's item for real; only the app's own close is an agent's.
  if (closing ? str(sender.login).toLowerCase() === bot : sender.type === "Bot" || signedByAgent(what.body))
    return null;
  const mentioned = what.action === "review_requested" || (slug ? namesApp(what.body, slug) : false);
  if (what.action === "opened" && !mentioned) return null;
  const number = Number(target.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    installationId,
    action: what.action,
    item: itemKind(event, target),
    repo,
    number,
    url: what.url || str(target.html_url),
    sender: { id: sender.id, login: cutText(str(sender.login), 100) },
    body: cutText(what.body, UNTRUSTED_MAX_CHARS),
    state: what.state ?? null,
    mentioned,
  };
}

/**
 * Queues what GitHub sent for an installation bound here (true), once per delivery (`X-GitHub-Delivery`: GitHub's
 * Redeliver sends the same id): the webhook answers at once and the job does the rest. False when it isn't an event
 * agents hear, or no workspace installed the app there.
 */
export async function queueGitHubAppEvent(
  db: Database,
  input: { event: string | null; delivery: string | null; payload: Record<string, unknown>; slug?: string },
): Promise<boolean> {
  const event = githubAppEventOf(input.event, input.payload, input.slug);
  if (!event) return false;
  const [bound] = await db
    .select({ orgId: githubAppInstallations.orgId })
    .from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, event.installationId));
  if (!bound) return false;
  const delivery = input.delivery?.trim().slice(0, 100);
  await enqueue(db, {
    orgId: bound.orgId,
    kind: GITHUB_EVENT_JOB,
    payload: { event: { ...event, ...(delivery ? { delivery } : {}) } },
    ...(delivery ? { dedupeKey: `${GITHUB_EVENT_JOB}:${delivery}` } : {}),
    maxAttempts: 4,
  });
  return true;
}

const ITEM_WORDS = { pull_request: "PR", issue: "issue", discussion: "discussion" } as const;

/** The event in the server's words, for the agent and as the notice's plain text ("Ana commented on PR #12 …"). */
function eventLine(e: GitHubAppEvent, who: string) {
  const item = `${ITEM_WORDS[e.item]} #${e.number} (${e.repo})`;
  switch (e.action) {
    case "comment":
      return `${who} commented on ${item} on GitHub`;
    case "review":
      return e.state === "approved"
        ? `${who} approved ${item} on GitHub`
        : e.state === "changes_requested"
          ? `${who} asked for changes on ${item} on GitHub`
          : `${who} reviewed ${item} on GitHub`;
    case "review_requested":
      return `${who} asked the agentes.chat app to review ${item} on GitHub`;
    case "opened":
      return `${who} opened ${item} on GitHub, naming the agentes.chat app`;
    case "merged":
      return `${who} merged ${item} on GitHub`;
    case "closed":
      return `${who} closed ${item} on GitHub`;
  }
}

/** The member whose GitHub sign-in is this GitHub account, while they belong to the workspace. */
async function linkedMember(db: Database, orgId: string, githubId: number) {
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, accounts.userId), eq(organizationMembers.orgId, orgId)),
    )
    .where(and(eq(accounts.providerId, "github"), eq(accounts.accountId, String(githubId))))
    .limit(1);
  return row ?? null;
}

/** Who connected that GitHub account to the workspace, while they belong to it. */
async function installerOf(db: Database, orgId: string, installationId: number) {
  const [row] = await db
    .select({ id: organizationMembers.userId })
    .from(githubAppInstallations)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, githubAppInstallations.createdByUserId), eq(organizationMembers.orgId, orgId)),
    )
    .where(and(eq(githubAppInstallations.orgId, orgId), eq(githubAppInstallations.installationId, installationId)));
  return row?.id ?? null;
}

/** The workspace's right hand, in the person's DM with it. */
async function rightHandConversation(db: Database, orgId: string, userId: string) {
  const [hand] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.orgId, orgId), eq(agents.builtin, RIGHT_HAND), isNull(agents.archivedAt), isNull(agents.deletedAt)),
    );
  if (!hand) return null;
  const dm = await openPersonAgentDm(db, orgId, userId, hand.id);
  return { agentId: hand.id, channelId: dm.id, threadId: null };
}

/**
 * Brings one GitHub event to its agent (job `github_app.event`): the item's agent in the conversation it came from
 * (a merge or a close only of an item the agent opened), else a mention of the app to the right hand, to hand on: in
 * the DM of the member who wrote it, or of whoever connected that GitHub account here for anyone else. A member who
 * may read that conversation and talk to the agent wakes it, behind the run; anyone else leaves a notice only
 * (`refs.outside`). A merge or a close wakes the agent whoever did it. A workspace closed to changes (suspended, or
 * being deleted) takes none.
 */
export async function handleGitHubAppEvent(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  e: GitHubAppEvent,
): Promise<"delivered" | "ignored"> {
  const { db } = deps;
  if (closedRefusal(await orgStanding(db, orgId))) return "ignored";
  const [item] = await db
    .select()
    .from(githubItems)
    .where(
      and(eq(githubItems.orgId, orgId), eq(githubItems.repo, e.repo.toLowerCase()), eq(githubItems.number, e.number)),
    );
  const closing = e.action === "merged" || e.action === "closed";
  if (closing ? !item?.authored : !item && !e.mentioned) return "ignored";
  const member = await linkedMember(db, orgId, e.sender.id);
  const dmWith = item ? null : (member?.id ?? (await installerOf(db, orgId, e.installationId)));
  const target = item
    ? { agentId: item.agentId, channelId: item.channelId, threadId: item.threadId }
    : dmWith
      ? await rightHandConversation(db, orgId, dmWith)
      : null;
  if (!target) return "ignored";
  const agent = await getAgent(db, orgId, target.agentId);
  const [channel] = await db
    .select({ kind: channels.kind, dmKey: channels.dmKey, archivedAt: channels.archivedAt })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, target.channelId)));
  if (!agent || agent.archivedAt || !channel || channel.archivedAt) return "ignored";
  // Taken out of that conversation since: never brought back there, as a mention isn't (`dispatchMentions`).
  if ((await eligibleChannelAgents(db, orgId, target.channelId, [agent.id])).length === 0) return "ignored";
  // The job ran before (a worker lost it after writing): its notice is there already. Its retries come within minutes,
  // so a day back is plenty and keeps the read to the newest partitions.
  if (e.delivery) {
    const [seen] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.channelId, target.channelId),
          gte(messages.createdAt, new Date(Date.now() - 86_400_000)),
          eq(messages.authorAgentId, agent.id),
          sql`${messages.meta}->'notice'->'refs'->>'delivery' = ${e.delivery}`,
        ),
      )
      .limit(1);
    if (seen) return "ignored";
  }
  // Work an agent was handed (the agents' DM) is read by no person: being in the workspace is what counts there.
  const membership = !member
    ? null
    : isAgentOnlyDm(channel)
      ? await getMembership(db, member.id, orgId)
      : ((await requireChannelAccess(db, member.id, orgId, target.channelId).catch(() => null))?.membership ?? null);
  const behind = member && membership && canTalkTo(agent, member.id, speakerOf(membership)) ? member : null;
  // The task the agent worked on when it wrote there: what a merge or a close changes.
  const [task] =
    closing && item?.runId
      ? await db
          .select({ number: issues.number, title: issues.title })
          .from(agentRuns)
          .innerJoin(issues, and(eq(issues.id, agentRuns.issueId), eq(issues.orgId, agentRuns.orgId)))
          .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, item.runId)))
      : [];
  const who = member?.name || e.sender.login;
  const notice: Notice = {
    kind: "github_event",
    text: e.body,
    from: eventLine(e, who),
    refs: {
      event: e.action,
      item: e.item,
      repo: e.repo,
      number: String(e.number),
      url: e.url,
      login: e.sender.login,
      who,
      // For what lists it with no directory at hand (previews, notifications): the chat names the agent as it is now.
      agent: agent.name,
      ...(e.delivery ? { delivery: e.delivery } : {}),
      ...(e.state ? { state: e.state } : {}),
      ...(task ? { task: `#${task.number} «${cutText(task.title, 200)}»` } : {}),
      ...(behind ? { personId: behind.id } : closing ? {} : { outside: "1" }),
      ...(item ? {} : { unowned: "1" }),
    },
  };
  const delivered = await db.transaction((tx) =>
    deliverNotice(tx, {
      orgId,
      agentId: agent.id,
      channelId: target.channelId,
      threadId: target.threadId,
      hop: 0,
      stretchId: null,
      notice,
      body: forPeople(notice),
      wake: Boolean(behind) || closing,
      trigger: channel.kind === "dm" ? "dm" : "mention",
      // GitHub text is outside content, a member's too (ADR 0117): the runs that read it post and learn as such.
      readOutside: Boolean(e.body.trim()),
    }),
  );
  await publishDelivery(deps.pubsub, delivered);
  return "delivered";
}

/**
 * "Pedir resposta" on a GitHub notice that woke nobody (`refs.outside`): a person who reads that conversation and may
 * talk to the agent asks it to answer, once. The notice changes in place (`refs.answeredBy`), and a new one with that
 * person behind it (`refs.answerFor`, `refs.personId`) wakes the agent. 409 `github_event.answered` when someone
 * already asked, `github_event.agent_not_here` when the agent was taken out of that conversation since.
 */
export async function answerGitHubNotice(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  messageId: string,
): Promise<void> {
  const { db } = deps;
  const original = await getMessage(db, orgId, messageId);
  const notice = original?.meta.notice as Notice | undefined;
  if (
    !original?.authorAgentId ||
    original.deletedAt ||
    original.authorType !== "agent" ||
    notice?.kind !== "github_event" ||
    notice.refs?.outside !== "1"
  )
    throw new NotFoundError("GitHub notice not found", "github_event.not_found");
  const { channel, membership } = await requireChannelAccess(db, userId, orgId, original.channelId);
  const agent = await getAgent(db, orgId, original.authorAgentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if ((await eligibleChannelAgents(db, orgId, original.channelId, [agent.id])).length === 0)
    throw new ConflictError("The agent isn't in this conversation anymore", "github_event.agent_not_here");
  if (!canTalkTo(agent, userId, speakerOf(membership))) throw await audienceError(db, agent);
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const answered = JSON.stringify({ answeredBy: userId });
  const done = await db.transaction(async (tx) => {
    const [marked] = await tx
      .update(messages)
      .set({
        meta: sql`jsonb_set(${messages.meta}, '{notice,refs}', coalesce(${messages.meta}->'notice'->'refs', '{}'::jsonb) || ${answered}::jsonb)`,
      })
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.id, original.id),
          eq(messages.createdAt, original.createdAt),
          sql`${messages.meta}->'notice'->'refs'->>'answeredBy' is null`,
        ),
      )
      .returning();
    if (!marked) return null;
    const { outside: _, ...refs } = notice.refs ?? {};
    const ask: Notice = {
      ...notice,
      refs: { ...refs, answerFor: original.id, personId: userId, asker: person?.name ?? "" },
    };
    const sent = await deliverNotice(tx, {
      orgId,
      agentId: agent.id,
      channelId: original.channelId,
      threadId: original.threadId,
      hop: 0,
      stretchId: null,
      notice: ask,
      body: forPeople(ask),
      trigger: channel.kind === "dm" ? "dm" : "mention",
      readOutside: Boolean(ask.text.trim()),
    });
    return { marked, sent };
  });
  if (!done) throw new ConflictError("Someone already asked for this answer", "github_event.answered");
  await publishDelivery(deps.pubsub, { message: done.marked, runs: [] });
  await publishDelivery(deps.pubsub, done.sent);
}

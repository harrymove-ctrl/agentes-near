import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  commentIssue,
  createAgent,
  createChannel,
  createIssue,
  drainOutbox,
  ForbiddenError,
  getIssue,
  issueFromMessage,
  listApprovals,
  listIssueActivity,
  listIssues,
  listMembers,
  markThreadRead,
  moveIssueComments,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openTaskConversation,
  postPersonMessage,
  requireChannelAccess,
  unreadTaskConversations,
  updateIssue,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const repliesIn = async (channelId: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId)))
    .filter((m) => m.threadId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

describe("a task's conversation (ADR 0145)", () => {
  test("made once on first use; a mention there wakes the agent, which answers in the same thread", async () => {
    f = await setup({ reply: () => ({ chunks: ["Olhei: 18 das 31 usam WhatsApp."] }) });
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Confirmação por WhatsApp" });
    expect(issue.conversation).toBeNull();
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);
    expect(await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id)).toEqual(at);
    const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, at.channelId));
    expect(channel).toMatchObject({ kind: "task", visibility: "private" });

    // The chat's own send, in the thread: the mention admits the agent (it sees the task) and starts its run.
    const asked = await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
      body: "@dev quantas clínicas já usam WhatsApp?",
      threadId: at.rootId,
    });
    expect(asked.mentionedAgentIds).toEqual([f.agent.id]);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ agentId: f.agent.id, channelId: at.channelId, threadRootId: at.rootId });
    await drainOutbox(f.db, f.handlers);
    const replies = await repliesIn(at.channelId);
    expect(replies.map((m) => [m.authorType, m.body])).toEqual([
      ["person", "@dev quantas clínicas já usam WhatsApp?"],
      ["agent", "Olhei: 18 das 31 usam WhatsApp."],
    ]);
    // The run knew it was in the task's conversation.
    expect(JSON.stringify(f.provider.calls.at(-1)?.request.system)).toContain("This conversation: task #1");

    // The card reads it in the board's one query: count, who, nobody at work now.
    const [card] = await listIssues(f.db, person(f.owner.id), f.org.id);
    expect(card?.conversation).toMatchObject({ channelId: at.channelId, rootId: at.rootId, count: 2, working: false });
    expect(card?.conversation?.participants).toEqual([
      { type: "person", id: f.owner.id },
      { type: "agent", id: f.agent.id },
    ]);
  });

  test("an agent's mention there brings in the agent it names, as a person's does, at the next hop", async () => {
    f = await setup({
      // The judge reads the handover as one that needs QA.
      judge: (kind) => (kind === "mention_needs_nothing" ? 0 : undefined),
      reply: (_request, call) => ({ chunks: [call === 1 ? "@qa pode revisar o texto?" : "Revisei: tudo certo."] }),
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Texto do convite" });
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);
    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "@dev escreve", threadId: at.rootId });
    await drainOutbox(f.db, f.handlers);

    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => [r.agentId, r.channelId, r.hop]).sort()).toEqual(
      [
        [f.agent.id, at.channelId, 1],
        [qa.id, at.channelId, 2],
      ].sort(),
    );
    expect((await repliesIn(at.channelId)).map((m) => [m.authorType, m.body])).toEqual([
      ["person", "@dev escreve"],
      ["agent", "@qa pode revisar o texto?"],
      ["agent", "Revisei: tudo certo."],
    ]);
    const members = await f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, at.channelId));
    expect(members.map((m) => m.agentId)).toContain(qa.id);
  });

  test("a comment (the old box, the agent's tool) is a reply in it; never an activity row", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Frete lento" });
    await commentIssue(deps, person(f.owner.id), f.org.id, issue.id, "Começo amanhã.");
    const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    await commentIssue(deps, agent, f.org.id, issue.id, "Reproduzi.");
    const at = (await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).conversation;
    if (!at) throw new Error("no conversation");
    expect((await repliesIn(at.channelId)).map((m) => [m.authorType, m.body])).toEqual([
      ["person", "Começo amanhã."],
      ["agent", "Reproduzi."],
    ]);
    expect(at.count).toBe(2);
    const activity = await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id);
    expect(activity.map((a) => a.kind)).toEqual(["event"]);
  });

  test("read by whoever sees the task: a private channel's task stays its members'; agents join only seeing it", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: "Checkout quebra" });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, said.id);
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);

    // An approval card the agent asked for there (a merge): read like the conversation.
    await f.db.insert(schema.approvals).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: at.channelId,
      threadRootId: at.rootId,
      toolUseId: "toolu_1",
      tool: "github.merge_pull_request",
      scope: "github:merge",
      params: { pr: 42 },
      actionHash: "hash",
      title: "Merge PR #42",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    // Bia isn't in #secreto: no task, no conversation, by any way in.
    expect(await listApprovals(f.db, bia.id, f.org.id)).toEqual([]);
    await expect(openTaskConversation(f.db, person(bia.id), f.org.id, issue.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      postPersonMessage(deps, bia.id, f.org.id, at.channelId, { body: "oi", threadId: at.rootId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // In #secreto now: she reads it, without being a member of the conversation itself.
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id });
    expect((await requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).channel.id).toBe(at.channelId);
    expect((await listApprovals(f.db, bia.id, f.org.id)).map((a) => a.title)).toEqual(["Merge PR #42"]);
    const members = await f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, at.channelId));
    expect(members.filter((m) => m.userId)).toEqual([]);

    // An agent outside #secreto mentioned there doesn't join (and starts nothing); one inside does.
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "@qa olha", threadId: at.rootId });
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: qa.id });
    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "@qa e agora?", threadId: at.rootId });
    expect((await f.db.select().from(schema.agentRuns)).map((r) => [r.agentId, r.channelId])).toEqual([
      [qa.id, at.channelId],
    ]);
  });

  test("old comments move in once: their ids, times, authors and files; the events stay as the history", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Exportar CSV" });
    const [file] = await f.db
      .insert(schema.artifacts)
      .values({
        orgId: f.org.id,
        kind: "file",
        title: "print.png",
        createdByType: "person",
        createdById: f.owner.id,
        updatedByType: "person",
        updatedById: f.owner.id,
      })
      .returning();
    const old = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const comments = [
      { authorType: "person", authorId: f.owner.id, text: "Vejam o print", at: old(30), files: [file?.id ?? ""] },
      { authorType: "agent", authorId: f.agent.id, text: "Vou olhar.", at: old(20), files: [] },
      // Someone who left: the text and the time stay, with no author.
      { authorType: "person", authorId: "gone-user", text: "Urgente", at: old(10), files: [] },
    ];
    const rows = await f.db
      .insert(schema.issueActivity)
      .values(
        comments.map((c) => ({
          orgId: f.org.id,
          issueId: issue.id,
          kind: "comment",
          authorType: c.authorType,
          authorId: c.authorId,
          text: c.text,
          createdAt: c.at,
          data: c.files.length ? { attachments: c.files.map((id) => ({ id, title: "print.png" })) } : {},
        })),
      )
      .returning();

    expect(await moveIssueComments(f.db)).toBe(1);
    expect(await moveIssueComments(f.db)).toBe(0);
    const at = (await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).conversation;
    if (!at) throw new Error("no conversation");
    const moved = await repliesIn(at.channelId);
    const same = (i: number) => [rows[i]?.id ?? "", comments[i]?.at.getTime() ?? 0];
    expect(moved.map((m) => [m.id, m.createdAt.getTime(), m.authorUserId, m.authorAgentId, m.body])).toEqual([
      [...same(0), f.owner.id, null, "Vejam o print"],
      [...same(1), null, f.agent.id, "Vou olhar."],
      [...same(2), null, null, "Urgente"],
    ]);
    expect(moved[0]?.meta).toMatchObject({ movedFromIssue: true, artifacts: [{ id: file?.id, title: "print.png" }] });
    expect(moved.every((m) => m.threadId === at.rootId)).toBe(true);
    expect(at.count).toBe(3);
    // The old comments left the activity; "created" is still there.
    expect((await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id)).map((a) => a.event)).toEqual([
      "created",
    ]);
    // Moved quietly: nobody hears about old comments again.
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.notifications)).toEqual([]);
  });

  test("a reply there reaches the task's followers like a comment did, opening the task at that message", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const issue = await createIssue(deps, person(bia.id), f.org.id, { title: "Exportar CSV" });
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);
    const reply = await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
      body: "Feito o rascunho",
      threadId: at.rootId,
    });
    await drainOutbox(f.db, f.handlers);
    const [n] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, bia.id));
    expect(n).toMatchObject({ kind: "issue_comment" });
    expect(n?.source).toMatchObject({ issueId: issue.id, issueNumber: issue.number, messageId: reply.id });

    // Who wrote there follows the task, as a commenter did: Bia hears its status change.
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    await postPersonMessage(deps, caio.id, f.org.id, at.channelId, { body: "Testei aqui", threadId: at.rootId });
    await drainOutbox(f.db, f.handlers);
    await updateIssue(deps, person(bia.id), f.org.id, issue.id, { status: "done" });
    const told = await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "issue_status"));
    expect(told.map((x) => x.userId).sort()).toEqual([caio.id, f.owner.id].sort());
  });

  test("a mention there is unread for whoever sees the task until they read it; one who can't see it gets none", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await listMembers(f.db, f.org.id); // assigns their handles
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id });
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: "Checkout quebra" });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, said.id);
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);

    // Nobody in a task's channel is a member: who sees the task and is named is mentioned all the same.
    const asked = await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
      body: "@bia e @caio, conferem?",
      threadId: at.rootId,
    });
    expect(asked.mentionedUserIds).toEqual([bia.id]); // caio isn't in #secreto
    expect(await unreadTaskConversations(f.db, bia.id, f.org.id)).toEqual([
      { issueId: issue.id, unread: 1, mentions: 1 },
    ]);
    expect(await unreadTaskConversations(f.db, caio.id, f.org.id)).toEqual([]);
    // My own message is never unread for me; the task's creator follows its conversation (its root is theirs).
    expect(await unreadTaskConversations(f.db, f.owner.id, f.org.id)).toEqual([]);

    // A plain reply after: Bia doesn't follow the conversation, so only the mention counts; the creator sees it.
    await postPersonMessage(deps, bia.id, f.org.id, at.channelId, { body: "Confiro hoje", threadId: at.rootId });
    expect(await unreadTaskConversations(f.db, f.owner.id, f.org.id)).toEqual([
      { issueId: issue.id, unread: 1, mentions: 0 },
    ]);

    // Read there, it's gone.
    await markThreadRead(deps, bia.id, f.org.id, at.rootId);
    expect(await unreadTaskConversations(f.db, bia.id, f.org.id)).toEqual([]);

    // Mentioned again, then out of #secreto: the task is out of her sight, so is the mention.
    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "@bia mais uma", threadId: at.rootId });
    expect((await unreadTaskConversations(f.db, bia.id, f.org.id)).map((u) => u.mentions)).toEqual([1]);
    await f.db.delete(schema.channelMembers).where(eq(schema.channelMembers.userId, bia.id));
    expect(await unreadTaskConversations(f.db, bia.id, f.org.id)).toEqual([]);
  });

  test("an agent's mention of a person there counts like a person's", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await listMembers(f.db, f.org.id); // assigns their handles
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Texto da confirmação" });
    const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    await commentIssue(deps, agent, f.org.id, issue.id, "@bia pode revisar o texto?");
    expect(await unreadTaskConversations(f.db, bia.id, f.org.id)).toEqual([
      { issueId: issue.id, unread: 1, mentions: 1 },
    ]);
    // The task's creator follows its conversation: the agent's reply is unread for them, with no mention.
    expect(await unreadTaskConversations(f.db, f.owner.id, f.org.id)).toEqual([
      { issueId: issue.id, unread: 1, mentions: 0 },
    ]);
  });

  test("a task whose creator's account is gone still gets its conversation", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Sem dono" });
    await f.db.update(schema.issues).set({ createdById: "gone-account" }).where(eq(schema.issues.id, issue.id));
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);
    const [root] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, at.rootId));
    expect(root).toMatchObject({ authorType: "person", authorUserId: null });
    // The root routes to nobody and is never indexed.
    expect(
      (await f.db.select().from(schema.outbox)).filter((o) => JSON.stringify(o.payload).includes(at.rootId)),
    ).toEqual([]);
  });
});

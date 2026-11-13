import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  archiveThread,
  buildRunContext,
  cleanAssessedTitle,
  closeThread,
  createChannel,
  createThreadFromRange,
  deleteThread,
  drainOutbox,
  getThread,
  insertMessage,
  listMessages,
  listThreads,
  moveContextIntoThread,
  openDm,
  postPersonMessage,
  reopenThread,
  returnContextToChannel,
  THREAD_ASSESS_DELAY_MS,
  unarchiveThread,
  updateThread,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
/** What the fake cheap model answers to `threads.assess` (other calls get "ok"). */
let assessed: { title: string; resolved: boolean } = { title: "", resolved: false };
const isAssess = (system: Parameters<typeof systemText>[0]) =>
  systemText(system).startsWith("You read a conversation thread");
beforeEach(async () => {
  assessed = { title: "", resolved: false };
  f = await setup({
    reply: (request) => ({ chunks: [isAssess(request.system) ? JSON.stringify(assessed) : "ok"] }),
  });
});
afterEach(() => f.close());

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const post = (userId: string, channelId: string, body: string, threadId?: string) =>
  postPersonMessage(deps(), userId, f.org.id, channelId, { body, threadId });
const ids = (list: { id: string }[]) => list.map((m) => m.id);
const topLevel = async (channelId = f.general.id) => ids(await listMessages(f.db, f.owner.id, f.org.id, channelId));
const inThread = async (rootId: string) =>
  ids(await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: rootId }));
const listed = async (userId: string, input: Omit<Parameters<typeof listThreads>[2], "orgId"> = {}) =>
  ids((await listThreads(f.db, userId, { orgId: f.org.id, ...input })).threads);

test("a thread past its limit reads its latest replies: the one just said is never left out", async () => {
  const root = await post(f.owner.id, f.general.id, "raiz");
  await post(f.owner.id, f.general.id, "primeira", root.id);
  const second = await post(f.owner.id, f.general.id, "segunda", root.id);
  const third = await post(f.owner.id, f.general.id, "terceira", root.id);
  const read = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: root.id, limit: 2 });
  expect(ids(read)).toEqual([root.id, second.id, third.id]);
});

test("a thread pages back from a time: its root, then the replies before it", async () => {
  const root = await post(f.owner.id, f.general.id, "raiz");
  const first = await post(f.owner.id, f.general.id, "primeira", root.id);
  const second = await post(f.owner.id, f.general.id, "segunda", root.id);
  const read = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, {
    threadId: root.id,
    before: new Date(second.createdAt),
  });
  expect(ids(read)).toEqual([root.id, first.id]);
});

test("a thread from a range: auto title, a root in the channel, exclusions; nothing moves, nobody runs", async () => {
  const a = await post(f.owner.id, f.general.id, "Onboarding is too long for new teams");
  const b = await post(f.owner.id, f.general.id, "Agree, step 3 is confusing");
  const off = await post(f.owner.id, f.general.id, "lunch?");
  const c = await post(f.owner.id, f.general.id, "Let's cut it to 2 steps");
  const events = f.listen(f.general.id);
  // The ends may come in either order.
  const thread = await createThreadFromRange(deps(), f.owner.id, {
    orgId: f.org.id,
    channelId: f.general.id,
    firstMessageId: c.id,
    lastMessageId: a.id,
    excludedMessageIds: [off.id],
  });
  expect(thread).toMatchObject({
    title: "Onboarding is too long for new teams",
    state: "open",
    replyCount: 0,
    canManage: true,
    createdBy: f.owner.id,
    context: {
      channelId: f.general.id,
      firstMessageId: a.id,
      lastMessageId: c.id,
      excludedMessageIds: [off.id],
      moved: false,
      count: 3,
    },
  });
  expect(await topLevel()).toEqual([a.id, b.id, off.id, c.id, thread.id]);
  const [root] = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { threadId: thread.id });
  expect(root?.meta.threadStart).toMatchObject({ count: 3, moved: false, firstMessageId: a.id });
  expect(events.some((e) => e.type === "thread.updated" && e.change === "created")).toBe(true);
  expect(events.some((e) => e.type === "message.created" && e.messageId === thread.id)).toBe(true);
  // The root routes to nobody.
  const outbox = await f.db.select().from(schema.outbox);
  expect(outbox.some((o) => JSON.stringify(o.payload).includes(thread.id))).toBe(false);
  expect(await listed(f.owner.id)).toEqual([thread.id]);
  // Undo (the toast's "Desfazer"): gone, the channel as before.
  await deleteThread(deps(), f.owner.id, f.org.id, thread.id);
  expect(await topLevel()).toEqual([a.id, b.id, off.id, c.id]);
  expect(await listed(f.owner.id)).toEqual([]);
});

test("a range is top-level messages of one channel; from another channel, everyone here must see it", async () => {
  const root = await post(f.owner.id, f.general.id, "root");
  const reply = await post(f.owner.id, f.general.id, "reply", root.id);
  const create = (input: { channelId: string; contextChannelId?: string; first: string; last: string }) =>
    createThreadFromRange(deps(), f.owner.id, {
      orgId: f.org.id,
      channelId: input.channelId,
      contextChannelId: input.contextChannelId,
      firstMessageId: input.first,
      lastMessageId: input.last,
    });
  await expect(create({ channelId: f.general.id, first: root.id, last: reply.id })).rejects.toMatchObject({
    code: "thread.range_invalid",
  });
  await expect(
    createThreadFromRange(deps(), f.owner.id, {
      orgId: f.org.id,
      channelId: f.general.id,
      firstMessageId: root.id,
      lastMessageId: root.id,
      excludedMessageIds: [root.id],
    }),
  ).rejects.toMatchObject({ code: "thread.range_empty" });

  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const board = await createChannel(f.db, f.owner.id, f.org.id, { name: "board", visibility: "private" });
  const secret = await post(f.owner.id, board.id, "Trial of 14 days");
  // #general has Bia and @dev, who are not in #board.
  await expect(
    create({ channelId: f.general.id, contextChannelId: board.id, first: secret.id, last: secret.id }),
  ).rejects.toMatchObject({
    code: "thread.context_not_visible",
    params: { userIds: [bia.id], agentIds: [f.agent.id] },
  });
  // Bia can't even read #board.
  await expect(
    createThreadFromRange(deps(), bia.id, {
      orgId: f.org.id,
      channelId: f.general.id,
      contextChannelId: board.id,
      firstMessageId: secret.id,
      lastMessageId: secret.id,
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  // In #board itself it's fine.
  const here = await create({ channelId: board.id, first: secret.id, last: secret.id });
  expect(here.context).toMatchObject({ channelId: board.id, count: 1 });

  await addChannelMember(f.db, f.owner.id, f.org.id, board.id, { userId: bia.id });
  await addChannelMember(f.db, f.owner.id, f.org.id, board.id, { agentId: f.agent.id });
  const cross = await create({
    channelId: f.general.id,
    contextChannelId: board.id,
    first: secret.id,
    last: secret.id,
  });
  expect(cross).toMatchObject({ channelId: f.general.id, title: "Trial of 14 days", context: { channelId: board.id } });
  await expect(moveContextIntoThread(deps(), f.owner.id, f.org.id, cross.id)).rejects.toMatchObject({
    code: "thread.move_other_channel",
  });
  // A plain thread has no owner: its creator, the root's author or an admin manage it.
  await expect(closeThread(deps(), bia.id, f.org.id, cross.id)).rejects.toMatchObject({ code: "thread.not_allowed" });
  expect((await getThread(f.db, bia.id, f.org.id, cross.id)).canManage).toBe(false);
});

test("moving takes the range out of the channel (the root is the stub); returning puts those back", async () => {
  const a = await post(f.owner.id, f.general.id, "first point");
  const x = await post(f.owner.id, f.general.id, "off topic");
  const b = await post(f.owner.id, f.general.id, "second point");
  const thread = await createThreadFromRange(deps(), f.owner.id, {
    orgId: f.org.id,
    channelId: f.general.id,
    firstMessageId: a.id,
    lastMessageId: b.id,
    excludedMessageIds: [x.id],
  });
  const reply = await post(f.owner.id, f.general.id, "a real reply", thread.id);
  const events = f.listen(f.general.id);
  const moved = await moveContextIntoThread(deps(), f.owner.id, f.org.id, thread.id);
  expect(moved.context).toMatchObject({ moved: true, count: 2 });
  expect(await topLevel()).toEqual([x.id, thread.id]);
  expect(await inThread(thread.id)).toEqual([thread.id, a.id, b.id, reply.id]);
  const stub = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === thread.id);
  expect(stub?.meta.threadStart).toMatchObject({ moved: true, movedCount: 2 });
  const movedEvent = events.find((e) => e.type === "thread.updated" && e.change === "moved");
  expect(((movedEvent?.messageIds as string[]) ?? []).sort()).toEqual([a.id, b.id].sort());

  // Adjusting a moved range moves the new range.
  const c = await post(f.owner.id, f.general.id, "third point");
  const adjusted = await updateThread(deps(), f.owner.id, f.org.id, thread.id, {
    lastMessageId: c.id,
    title: "Three points",
  });
  expect(adjusted).toMatchObject({ title: "Three points", context: { lastMessageId: c.id, moved: true, count: 3 } });
  expect(await topLevel()).toEqual([x.id, thread.id]);

  const back = await returnContextToChannel(deps(), f.owner.id, f.org.id, thread.id);
  expect(back.context?.moved).toBe(false);
  expect(await topLevel()).toEqual([a.id, x.id, b.id, thread.id, c.id]);
  expect(await inThread(thread.id)).toEqual([thread.id, reply.id]);
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, thread.id));
  expect(audit.map((r) => r.action)).toEqual(
    expect.arrayContaining(["thread.created", "thread.context_moved", "thread.context_returned"]),
  );
  // Undo is only for a thread nobody replied to.
  await expect(deleteThread(deps(), f.owner.id, f.org.id, thread.id)).rejects.toMatchObject({
    code: "thread.has_replies",
  });

  // A message of the range with its own replies can't move.
  const nested = await post(f.owner.id, f.general.id, "has a thread of its own");
  await post(f.owner.id, f.general.id, "inner reply", nested.id);
  const other = await createThreadFromRange(deps(), f.owner.id, {
    orgId: f.org.id,
    channelId: f.general.id,
    firstMessageId: nested.id,
    lastMessageId: nested.id,
  });
  await expect(moveContextIntoThread(deps(), f.owner.id, f.org.id, other.id)).rejects.toMatchObject({
    code: "thread.range_has_replies",
  });
});

test("closing; a person's reply reopens it; an archived thread is read only; unarchiving goes back", async () => {
  const root = await post(f.owner.id, f.general.id, "deploy broke");
  await post(f.owner.id, f.general.id, "fixed", root.id);
  const closed = await closeThread(deps(), f.owner.id, f.org.id, root.id);
  expect(closed).toMatchObject({ state: "closed", closedBy: f.owner.id });
  expect(await listed(f.owner.id, { tab: "closed" })).toEqual([root.id]);
  expect(await listed(f.owner.id)).toEqual([root.id]);

  const events = f.listen(f.general.id);
  await post(f.owner.id, f.general.id, "it broke again", root.id);
  expect((await getThread(f.db, f.owner.id, f.org.id, root.id)).state).toBe("open");
  expect(events.some((e) => e.type === "thread.updated" && e.change === "reopened" && e.state === "open")).toBe(true);
  expect(await listed(f.owner.id, { tab: "closed" })).toEqual([]);

  await closeThread(deps(), f.owner.id, f.org.id, root.id);
  const archived = await archiveThread(deps(), f.owner.id, f.org.id, root.id);
  expect(archived).toMatchObject({ state: "archived", archivedBy: f.owner.id });
  await expect(post(f.owner.id, f.general.id, "late", root.id)).rejects.toMatchObject({ code: "thread.archived" });
  await expect(reopenThread(deps(), f.owner.id, f.org.id, root.id)).rejects.toMatchObject({
    code: "thread.archived",
  });
  expect(await listed(f.owner.id)).toEqual([]);
  expect(await listed(f.owner.id, { tab: "archived" })).toEqual([root.id]);
  // A top-level message in the channel is not affected.
  await post(f.owner.id, f.general.id, "new subject");

  expect((await unarchiveThread(deps(), f.owner.id, f.org.id, root.id)).state).toBe("closed");
  expect((await reopenThread(deps(), f.owner.id, f.org.id, root.id)).state).toBe("open");
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, root.id));
  expect(audit.map((r) => r.action)).toEqual(
    expect.arrayContaining(["thread.closed", "thread.archived", "thread.unarchived", "thread.reopened"]),
  );
});

test("the list shows threads of the channels you read: private channel members and DM participants", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  for (const u of [bia, caio]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  const core = await createChannel(f.db, f.owner.id, f.org.id, { name: "core", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, core.id, { userId: bia.id });
  const priv = await post(f.owner.id, core.id, "private plan");
  await post(bia.id, core.id, "ok", priv.id);
  const pub = await post(f.owner.id, f.general.id, "public question");
  await post(caio.id, f.general.id, "an answer", pub.id);
  const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
  const direct = await post(f.owner.id, dm.id, "just us");
  await post(bia.id, dm.id, "sure", direct.id);

  const all = [priv.id, pub.id, direct.id].sort();
  expect((await listed(f.owner.id)).sort()).toEqual(all);
  expect((await listed(bia.id)).sort()).toEqual(all);
  expect(await listed(caio.id)).toEqual([pub.id]);
  await expect(listThreads(f.db, caio.id, { orgId: f.org.id, channelId: core.id })).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(getThread(f.db, caio.id, f.org.id, priv.id)).rejects.toMatchObject({ code: "forbidden" });
  await expect(closeThread(deps(), caio.id, f.org.id, direct.id)).rejects.toMatchObject({ code: "forbidden" });
  expect(await listed(bia.id, { channelId: core.id })).toEqual([priv.id]);

  const [view] = (await listThreads(f.db, caio.id, { orgId: f.org.id })).threads;
  expect(view).toMatchObject({
    channelId: f.general.id,
    channelName: "general",
    title: null,
    rootText: "public question",
    replyCount: 1,
    lastMessage: { author: { type: "person", id: caio.id }, excerpt: "an answer" },
    working: false,
    canManage: false,
  });
  expect(view?.participants).toEqual([
    { type: "person", id: f.owner.id },
    { type: "person", id: caio.id },
  ]);
});

test("filters: working, agent, mine, words, needs you; pages by cursor", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const alpha = await post(f.owner.id, f.general.id, "alpha plan");
  const ask = await post(f.owner.id, f.general.id, "@dev check alpha", alpha.id);
  const beta = await post(bia.id, f.general.id, "beta release");
  await post(bia.id, f.general.id, "more on beta", beta.id);

  expect(await listed(f.owner.id, { tab: "working" })).toEqual([alpha.id]);
  expect(await listed(f.owner.id, { agentId: f.agent.id })).toEqual([alpha.id]);
  expect(await listed(f.owner.id, { mine: true })).toEqual([alpha.id]);
  expect(await listed(bia.id, { mine: true })).toEqual([beta.id]);
  expect(await listed(f.owner.id, { q: "BETA" })).toEqual([beta.id]);

  const first = await listThreads(f.db, f.owner.id, { orgId: f.org.id, limit: 1 });
  expect(ids(first.threads)).toEqual([beta.id]);
  const second = await listThreads(f.db, f.owner.id, { orgId: f.org.id, limit: 1, cursor: first.nextCursor });
  expect(ids(second.threads)).toEqual([alpha.id]);
  expect(second.nextCursor).toBeNull();

  // The agent asks something in alpha: it needs the people who took part there.
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, ask.id));
  if (!run) throw new Error("no run");
  await f.db.insert(schema.agentQuestions).values({
    orgId: f.org.id,
    runId: run.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadId: alpha.id,
    toolUseId: "toolu_1",
    text: "Which environment?",
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  expect(await listed(f.owner.id, { needsYou: true })).toEqual([alpha.id]);
  expect(await listed(bia.id, { needsYou: true })).toEqual([]);

  await drainOutbox(f.db, f.handlers);
  const done = await getThread(f.db, f.owner.id, f.org.id, alpha.id);
  expect(done.working).toBe(false);
  expect(done.participants).toContainEqual({ type: "agent", id: f.agent.id });
});

test("the run's context reads the thread's range (minus exclusions), not the channel before the root", async () => {
  await post(f.owner.id, f.general.id, "unrelated old talk");
  const a = await post(f.owner.id, f.general.id, "Onboarding: step 3 confuses people");
  const x = await post(f.owner.id, f.general.id, "anyone for lunch?");
  const b = await post(f.owner.id, f.general.id, "Let's merge steps 2 and 3");
  await post(f.owner.id, f.general.id, "something later in the channel");
  const thread = await createThreadFromRange(deps(), f.owner.id, {
    orgId: f.org.id,
    channelId: f.general.id,
    firstMessageId: a.id,
    lastMessageId: b.id,
    excludedMessageIds: [x.id],
    title: "Lighter onboarding",
  });
  const contextFor = async (body: string) => {
    const ask = await post(f.owner.id, f.general.id, body, thread.id);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, ask.id));
    if (!run) throw new Error("no run");
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
    const ctx = await buildRunContext(f.db, run, f.agent, { maxMessages: 30 });
    return { text: JSON.stringify(ctx.messages), system: systemText(ctx.system) };
  };
  const check = ({ text, system }: { text: string; system: string }) => {
    expect(text.split("step 3 confuses people").length).toBe(2);
    expect(text.split("merge steps 2 and 3").length).toBe(2);
    expect(text).toContain('started the thread \\"Lighter onboarding\\"');
    expect(text).not.toContain("lunch");
    expect(text).not.toContain("unrelated old talk");
    expect(text).not.toContain("something later");
    expect(system).toContain("# Where this thread comes from");
    expect(system).toContain("#general");
  };
  const referenced = await contextFor("@dev summarize the plan");
  check(referenced);
  expect(referenced.text.indexOf("step 3 confuses")).toBeLessThan(referenced.text.indexOf("started the thread"));
  // Moved into the thread: the same messages, read once (as replies now).
  await moveContextIntoThread(deps(), f.owner.id, f.org.id, thread.id);
  check(await contextFor("@dev and now?"));
});

// ── Assessment (threads.assess): title and "resolved?" ─────────────────────────

/** Runs the jobs due once the assessment delay has passed. */
const drainLater = () => drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + THREAD_ASSESS_DELAY_MS + 60_000) });
const assessCalls = () => f.provider.calls.filter((c) => isAssess(c.request.system));
const viewOf = (rootId: string) => getThread(f.db, f.owner.id, f.org.id, rootId);

test("a reply gets the thread a model-written title a while later; only the latest reply's job asks", async () => {
  const root = await post(f.owner.id, f.general.id, "**App Hang** no iOS de novo");
  await post(f.owner.id, f.general.id, "acontece ao abrir a câmera", root.id);
  const last = await post(f.owner.id, f.general.id, "pode olhar?", root.id);
  // Not yet: due minutes later.
  await drainOutbox(f.db, f.handlers);
  expect(assessCalls()).toHaveLength(0);
  expect((await viewOf(root.id)).title).toBeNull();

  assessed = { title: "**App travando** ao abrir a câmera no iOS @dev.", resolved: false };
  const events = f.listen(f.general.id);
  await drainLater();
  // The first reply's job saw a newer reply and left it to that one.
  expect(assessCalls()).toHaveLength(1);
  const prompt = JSON.stringify(assessCalls()[0]?.request.messages);
  expect(prompt).toContain("pode olhar?");
  const view = await viewOf(root.id);
  expect(view).toMatchObject({ title: "App travando ao abrir a câmera no iOS", suggestedResolved: false });
  expect(events.some((e) => e.type === "thread.updated" && e.threadId === root.id)).toBe(true);
  // Billed to the org (no agent budget), kind `summary`.
  const usage = await f.db.select().from(schema.usageRecords);
  expect(usage.some((u) => u.kind === "summary" && u.orgId === f.org.id && u.agentId === null)).toBe(true);
  expect(last.threadId).toBe(root.id);

  // The model may rewrite its own title later.
  assessed = { title: "Travamento da câmera no iOS", resolved: false };
  await post(f.owner.id, f.general.id, "mais detalhes", root.id);
  await drainLater();
  expect((await viewOf(root.id)).title).toBe("Travamento da câmera no iOS");
});

test("a person's title is never overwritten by the model", async () => {
  const root = await post(f.owner.id, f.general.id, "@theo");
  await updateThread(deps(), f.owner.id, f.org.id, root.id, { title: "Rotina de relatórios" });
  assessed = { title: "Pedido ao Theo", resolved: true };
  await post(f.owner.id, f.general.id, "pode fazer sim", root.id);
  await drainLater();
  expect(assessCalls()).toHaveLength(1);
  expect(await viewOf(root.id)).toMatchObject({ title: "Rotina de relatórios", suggestedResolved: true });
});

test("'resolved?' holds until a new message; closing or reopening clears it; it never closes", async () => {
  const root = await post(f.owner.id, f.general.id, "a rotina pode rodar a cada 30 min?");
  await post(f.owner.id, f.general.id, "Feito, a rotina agora roda a cada 30 min", root.id);
  assessed = { title: "Rotina a cada 30 minutos", resolved: true };
  await drainLater();
  let view = await viewOf(root.id);
  expect(view).toMatchObject({ suggestedResolved: true, state: "open" });
  expect((await listThreads(f.db, f.owner.id, { orgId: f.org.id })).threads[0]?.suggestedResolved).toBe(true);

  // A new message: the suggestion no longer holds (before any new assessment).
  await post(f.owner.id, f.general.id, "na verdade, a cada 15", root.id);
  expect((await viewOf(root.id)).suggestedResolved).toBe(false);

  assessed = { title: "Rotina a cada 15 minutos", resolved: true };
  await drainLater();
  view = await viewOf(root.id);
  expect(view).toMatchObject({ suggestedResolved: true, title: "Rotina a cada 15 minutos" });

  // Closing answers it; reopening doesn't bring it back.
  expect((await closeThread(deps(), f.owner.id, f.org.id, root.id)).suggestedResolved).toBe(false);
  expect((await reopenThread(deps(), f.owner.id, f.org.id, root.id)).suggestedResolved).toBe(false);
  // A closed thread isn't assessed (an agent's late reply doesn't reopen it).
  await closeThread(deps(), f.owner.id, f.org.id, root.id);
  const calls = assessCalls().length;
  await f.db.transaction((tx) =>
    insertMessage(tx, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: root.id,
      author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 1 },
      body: "Anotado",
    }),
  );
  await drainLater();
  expect(assessCalls()).toHaveLength(calls);
  expect((await viewOf(root.id)).suggestedResolved).toBe(false);
});

test("a model's title is plain text on one line", () => {
  expect(cleanAssessedTitle("**App Hang** no @theo.")).toBe("App Hang no");
  expect(cleanAssessedTitle('"Deploy  de\nsexta"')).toBe("Deploy de sexta");
  expect(cleanAssessedTitle("x".repeat(80))?.length).toBe(60);
  expect(cleanAssessedTitle("  ")).toBeNull();
  expect(cleanAssessedTitle(3)).toBeNull();
});

test("'Responder' marks when the thread was opened by reply, once; a plain reply doesn't", async () => {
  const root = await post(f.owner.id, f.general.id, "Who owns the onboarding copy?");
  await post(f.owner.id, f.general.id, "a reply that isn't from the panel", root.id);
  expect((await getThread(f.db, f.owner.id, f.org.id, root.id)).openedByReplyAt).toBeNull();

  const events = f.listen(f.general.id);
  const first = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, {
    body: "I do",
    threadId: root.id,
    openThread: true,
  });
  await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, {
    body: "and the screenshots",
    threadId: root.id,
    openThread: true,
  });
  const view = await getThread(f.db, f.owner.id, f.org.id, root.id);
  // From the first panel reply on (the one before it stays in the channel's timeline).
  expect(view).toMatchObject({ openedByReplyAt: first.createdAt, state: "open", replyCount: 3 });
  const listedView = (await listThreads(f.db, f.owner.id, { orgId: f.org.id, channelId: f.general.id })).threads;
  expect(listedView.find((x) => x.id === root.id)?.openedByReplyAt).toBe(first.createdAt);
  // The channel hears it once (the second reply finds it marked).
  const created = events.filter((e) => e.type === "thread.updated" && e.change === "created" && e.threadId === root.id);
  expect(created).toHaveLength(1);
});

test("openThread without a threadId is a plain top-level message", async () => {
  const m = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "hi", openThread: true });
  expect(m.threadId).toBeNull();
  const rows = await f.db.select().from(schema.threads).where(eq(schema.threads.rootMessageId, m.id));
  expect(rows).toHaveLength(0);
});

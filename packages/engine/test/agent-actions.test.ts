import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  actionsFor,
  commentIssue,
  createChannel,
  createContextToolSource,
  createIssue,
  createIssueToolSource,
  createScheduleToolSource,
  createWikiToolSource,
  createWorkspaceToolSource,
  drainOutbox,
  ForbiddenError,
  getIssue,
  getThread,
  getWikiPage,
  grantScopes,
  insertMessage,
  linkRunActions,
  listMessages,
  postPersonMessage,
  redoAgentAction,
  replyThreadOf,
  type ToolContext,
  type ToolDefinition,
  toTurns,
  UNDO_WINDOW_MS,
  undoAgentAction,
  undoMessageActions,
  updateIssue,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });

/**
 * A run's tool context whose trigger is a real message by the owner (tools act for them): in the
 * channel (the run answers there), or `inThread` (a reply under another message).
 */
async function runContext(fx: Fixture, body = "please organize this", inThread = false): Promise<ToolContext> {
  const root = inThread
    ? await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: fx.general.id,
        author: { type: "person", userId: fx.owner.id },
        body: "deploy notes",
      })
    : null;
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    threadId: root?.id ?? null,
    author: { type: "person", userId: fx.owner.id },
    body,
  });
  // A real run on the person's message: who asked is read from it (ADR 0053's authority gate).
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: root?.id ?? trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: root?.id ?? trigger.id,
    triggerMessageId: trigger.id,
  };
}

/** The run's reply: links the receipts to it, as the executor does when it posts (where the run answers). */
async function reply(fx: Fixture, ctx: ToolContext) {
  const m = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    threadId: replyThreadOf(ctx),
    author: { type: "agent", agentId: fx.agent.id, runId: ctx.runId, hop: 0 },
    body: "Done.",
  });
  await linkRunActions(fx.db, fx.org.id, ctx.runId, m.id);
  return m;
}

async function toolsOf(sources: { tools(ctx: ToolContext): Promise<ToolDefinition[]> }[], ctx: ToolContext) {
  const all = (await Promise.all(sources.map((s) => s.tools(ctx)))).flat();
  return async (name: string, input: Record<string, unknown>) => {
    const tool = all.find((t) => t.name === name);
    if (!tool) throw new Error(`no ${name}`);
    const out = await tool.execute(input, ctx);
    if (out.isError) throw new Error(out.content);
    return out;
  };
}

const deps = (fx: Fixture) => ({ db: fx.db, pubsub: fx.pubsub });
const rows = (fx: Fixture) => fx.db.select().from(schema.agentActions);

describe("act with undo: issues", () => {
  test("create_issue leaves a receipt on the reply; undo cancels it, redo brings it back; notes reach the agent", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await toolsOf([createIssueToolSource(f.artifactDeps)], ctx);
    const created = await call("create_issue", {
      title: "Prompt de avaliação após a assinatura",
      assignee: "me",
      due_date: "2026-10-23",
    });
    expect(created.content).toContain("Created #1");
    expect((await call("list_issues", { issue: "#1" })).content).toContain("due 2026-10-23");
    const [recorded] = await rows(f);
    expect(recorded).toMatchObject({ kind: "issue.created", messageId: null, requestedByUserId: f.owner.id });

    const events = f.listen(f.general.id);
    const m = await reply(f, ctx);
    const [view] = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).filter((x) => x.id === m.id);
    expect(view?.actions?.map((a) => [a.kind, a.target.number, a.params.title])).toEqual([
      ["issue.created", 1, "Prompt de avaliação após a assinatura"],
    ]);
    const action = view?.actions?.[0];
    if (!action) throw new Error("no action");
    expect(Date.parse(action.undoableUntil) - Date.parse(action.createdAt)).toBe(UNDO_WINDOW_MS);

    const undone = await undoAgentAction(deps(f), f.owner.id, f.org.id, action.id);
    expect(undone.undoneAt).not.toBeNull();
    expect(undone.undoneByUserId).toBe(f.owner.id);
    const issue = await getIssue(f.db, person(f.owner.id), f.org.id, { id: action.target.id });
    expect(issue.status).toBe("canceled");
    const live = events.find((e) => e.type === "message.actions");
    expect(live).toMatchObject({ messageId: m.id, threadId: null });
    expect((live as unknown as { actions: { undoneAt: string | null }[] }).actions[0]?.undoneAt).not.toBeNull();

    // The agent reads it next time, on the people's side of its history.
    const [stored] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, m.id));
    const notes = stored?.meta.actionNotes as string[];
    expect(notes[0]).toContain("undid: created issue #1");
    const turns = toTurns(stored ? [stored] : [], f.agent.id, new Map(), undefined);
    expect(JSON.stringify(turns)).toContain("[Undo]: ana undid: created issue #1");

    const redone = await redoAgentAction(deps(f), f.owner.id, f.org.id, action.id);
    expect(redone.undoneAt).toBeNull();
    expect(redone.redoneAt).not.toBeNull();
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: action.target.id })).status).toBe("todo");
    // And undo again (the redo's own change is not "someone else's").
    await undoAgentAction(deps(f), f.owner.id, f.org.id, action.id);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: action.target.id })).status).toBe("canceled");
  });

  test("update_issue: priority, labels, due date and assignee are receipts; a person's edit since blocks undo", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await toolsOf([createIssueToolSource(f.artifactDeps)], ctx);
    const issue = await createIssue(deps(f), person(f.owner.id), f.org.id, { title: "Login quebra" });
    await call("update_issue", { issue: "#1", priority: "high", labels: ["bug"], due_date: "2026-11-01" });
    await call("update_issue", { issue: "#1", assignee: "me" });
    const m = await reply(f, ctx);
    const actions = (await actionsFor(f.db, f.org.id, [m.id])).get(m.id) ?? [];
    expect(actions.map((a) => a.kind)).toEqual(["issue.updated", "issue.assigned"]);
    expect(actions[0]?.params).toMatchObject({ fields: ["priority", "labels", "dueDate"], priority: "high" });
    expect(actions[1]?.params).toMatchObject({ assigneeType: "agent", assigneeIsSelf: true, assigneeName: "@dev" });

    // Someone changed the priority after the agent: refused, nothing changes, the receipt stays undoable.
    await updateIssue(deps(f), person(f.owner.id), f.org.id, issue.id, { priority: "low" });
    const first = actions[0];
    if (!first) throw new Error("no action");
    await expect(undoAgentAction(deps(f), f.owner.id, f.org.id, first.id)).rejects.toMatchObject({
      code: "action.changed_since",
    });
    const [still] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.id, first.id));
    expect(still?.undoneAt).toBeNull();

    // Put it back as the agent left it: undo restores the values before the agent.
    await updateIssue(deps(f), person(f.owner.id), f.org.id, issue.id, { priority: "high" });
    await undoAgentAction(deps(f), f.owner.id, f.org.id, first.id);
    const back = await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id });
    expect(back).toMatchObject({ priority: "normal", labels: [], dueDate: null });
    expect(back.assignee).toEqual({ type: "agent", id: f.agent.id });
  });

  test("update_issue: an agent's GitHub link is a receipt, and undo takes it off", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await toolsOf([createIssueToolSource(f.artifactDeps)], ctx);
    const issue = await createIssue(deps(f), person(f.owner.id), f.org.id, { title: "Login quebra" });
    await call("update_issue", { issue: "#1", github_url: "https://github.com/acme/app/pull/9" });
    const m = await reply(f, ctx);
    const [action] = (await actionsFor(f.db, f.org.id, [m.id])).get(m.id) ?? [];
    if (!action) throw new Error("no action");
    expect(action.params).toMatchObject({ fields: ["githubUrl"] });
    await undoAgentAction(deps(f), f.owner.id, f.org.id, action.id);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).githubUrl).toBeNull();
  });

  test("create_issue: a person's reply in the task's conversation since blocks undo", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await toolsOf([createIssueToolSource(f.artifactDeps)], ctx);
    await call("create_issue", { title: "Uma" });
    const m = await reply(f, ctx);
    const [created] = (await actionsFor(f.db, f.org.id, [m.id])).get(m.id) ?? [];
    if (!created) throw new Error("no action");
    await commentIssue(deps(f), person(f.owner.id), f.org.id, created.target.id, "vou olhar isso amanhã");
    await expect(undoAgentAction(deps(f), f.owner.id, f.org.id, created.id)).rejects.toMatchObject({
      code: "action.changed_since",
    });
  });

  test("who may undo; the window expires; Desfazer tudo goes newest first", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await toolsOf([createIssueToolSource(f.artifactDeps)], ctx);
    await call("create_issue", { title: "Uma" });
    await call("update_issue", { issue: "#1", priority: "high" });
    const m = await reply(f, ctx);
    const [created] = (await actionsFor(f.db, f.org.id, [m.id])).get(m.id) ?? [];
    if (!created) throw new Error("no action");

    const stranger = await addMember(f.db, f.org.id, "member", "bia");
    await expect(undoAgentAction(deps(f), stranger.id, f.org.id, created.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(undoMessageActions(deps(f), stranger.id, f.org.id, m.id)).rejects.toBeInstanceOf(ForbiddenError);

    const later = () => new Date(Date.now() + UNDO_WINDOW_MS + 1000);
    await expect(undoAgentAction({ ...deps(f), now: later }, f.owner.id, f.org.id, created.id)).rejects.toMatchObject({
      code: "action.expired",
    });

    // An admin may undo for the requester: both changes, the priority first.
    const admin = await addMember(f.db, f.org.id, "admin", "caio");
    const all = await undoMessageActions(deps(f), admin.id, f.org.id, m.id);
    expect(all.failed).toEqual([]);
    expect(all.actions.every((a) => a.undoneByUserId === admin.id)).toBe(true);
    const issue = await getIssue(f.db, person(f.owner.id), f.org.id, { id: created.target.id });
    expect(issue).toMatchObject({ status: "canceled", priority: "normal" });
    await expect(undoAgentAction(deps(f), f.owner.id, f.org.id, created.id)).rejects.toMatchObject({
      code: "action.already_undone",
    });
  });

  test("end to end: the run's reply carries the receipt and the channel hears message.actions", async () => {
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) =>
        JSON.stringify(req.messages.at(-1)?.content).includes("tool_result")
          ? { chunks: ["Abri a #1 e deixei comigo."] }
          : {
              chunks: [],
              toolUses: [{ name: "create_issue", input: { title: "Organizar o trabalho", assignee: "me" } }],
            },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, [
      { connectionId: null, scope: "issues:read" },
      { connectionId: null, scope: "issues:write" },
    ]);
    const events = f.listen(f.general.id);
    await postPersonMessage(deps(f), f.owner.id, f.org.id, f.general.id, { body: "@dev organiza isso numa issue" });
    await drainOutbox(f.db, f.handlers);
    const [action] = await rows(f);
    expect(action?.messageId).not.toBeNull();
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const agentReply = timeline.find((x) => x.author.type === "agent");
    expect(agentReply?.body).toBe("Abri a #1 e deixei comigo.");
    expect(agentReply?.actions?.map((a) => a.kind)).toEqual(["issue.created"]);
    expect(events.some((e) => e.type === "message.actions" && e.messageId === agentReply?.id)).toBe(true);
  });
});

describe("act with undo: memory, routines, channels, wiki, threads", () => {
  test("memory: saved, changed and forgotten undo and redo", async () => {
    f = await setup();
    const ctx = await runContext(f, "lembra que o deploy é às sextas");
    const call = await toolsOf([createContextToolSource(f.context)], ctx);
    await call("remember", { content: "O deploy é às sextas" });
    const items = () => f.db.select().from(schema.contextItems);
    const [saved] = await items();
    if (!saved) throw new Error("not saved");
    await call("update_memory", { item_id: saved.id, content: "O deploy é às quintas" });
    const next = (await items()).find((i) => i.status === "active");
    if (!next) throw new Error("no current");
    await call("forget", { item_id: next.id });
    const m = await reply(f, ctx);
    const actions = (await actionsFor(f.db, f.org.id, [m.id])).get(m.id) ?? [];
    expect(actions.map((a) => a.kind)).toEqual(["memory.saved", "memory.updated", "memory.forgotten"]);
    expect(actions[1]?.params).toMatchObject({ text: "O deploy é às quintas", previousText: "O deploy é às sextas" });

    // Desfazer tudo: forgotten comes back, then the change goes back to the first version, then that is archived.
    const all = await undoMessageActions(deps(f), f.owner.id, f.org.id, m.id);
    expect(all.failed).toEqual([]);
    expect((await items()).filter((i) => i.status === "active")).toEqual([]);
    const forgotten = actions[2];
    const updated = actions[1];
    if (!forgotten || !updated) throw new Error("missing");
    // Redo the change: the new version is current again, the first archived behind it.
    await redoAgentAction(deps(f), f.owner.id, f.org.id, actions[0]?.id ?? "");
    await redoAgentAction(deps(f), f.owner.id, f.org.id, updated.id);
    const current = (await items()).filter((i) => i.status === "active");
    expect(current.map((i) => i.content)).toEqual(["O deploy é às quintas"]);
    expect((await items()).find((i) => i.id === saved.id)?.supersededBy).toBe(next.id);
  });

  test("routines: created and changed undo and redo", async () => {
    f = await setup();
    const ctx = await runContext(f, "toda segunda me manda o resumo");
    const call = await toolsOf([createScheduleToolSource({ pubsub: f.pubsub, context: f.context })], ctx);
    const out = await call("create_routine", { schedule: "toda segunda às 9h", prompt: "Resumo da semana" });
    const routineId = (out.data?.routine as { id: string } | undefined)?.id ?? "";
    await call("update_routine", { id: routineId, schedule: "toda sexta às 17h", title: "Resumo" });
    const m = await reply(f, ctx);
    const [created, updated] = (await actionsFor(f.db, f.org.id, [m.id])).get(m.id) ?? [];
    expect(created?.kind).toBe("routine.created");
    expect(updated?.params).toMatchObject({ fields: ["name", "schedule"], name: "Resumo" });
    const routine = async () =>
      (await f.db.select().from(schema.routines)).find(
        (r) => r.id === routineId,
      ) as typeof schema.routines.$inferSelect;

    // Undo the creation alone: the later change is the agent's own on the same routine, so it is refused.
    await expect(undoAgentAction(deps(f), f.owner.id, f.org.id, created?.id ?? "")).rejects.toMatchObject({
      code: "action.changed_since",
    });
    await undoAgentAction(deps(f), f.owner.id, f.org.id, updated?.id ?? "");
    expect((await routine()).phrase).toBe("toda segunda às 9h");
    await undoAgentAction(deps(f), f.owner.id, f.org.id, created?.id ?? "");
    expect((await routine()).deletedAt).not.toBeNull();
    await redoAgentAction(deps(f), f.owner.id, f.org.id, created?.id ?? "");
    const back = await routine();
    expect(back.deletedAt).toBeNull();
    expect(back.active).toBe(true);
    expect(back.nextRunAt).not.toBeNull();
  });

  test("an agent added to a channel; wiki pages created and edited; a thread renamed and closed", async () => {
    f = await setup();
    // Asked in a thread: it is the thread the agent renames and closes.
    const ctx = await runContext(f, "organiza: chama a lia no #produto, salva na wiki e fecha a thread", true);
    const [lia] = await f.db
      .insert(schema.agents)
      .values({
        orgId: f.org.id,
        name: "Lia",
        handle: "lia",
        role: "Research",
        instructions: "",
        model: "claude-sonnet-5-5",
        ownerUserId: f.owner.id,
      })
      .returning();
    const produto = await createChannel(f.db, f.owner.id, f.org.id, { name: "produto" });
    const call = await toolsOf(
      [createWorkspaceToolSource({ pubsub: f.pubsub }), createWikiToolSource({ pubsub: f.pubsub, search: f.context })],
      ctx,
    );
    await call("add_agent_to_channel", { agent: "@lia", channel: "#produto" });
    await call("create_wiki_page", { title: "Deploy", body: "Às sextas." });
    await call("update_wiki_page", { page: "Deploy", mode: "append", content: "Com aprovação." });
    await call("update_thread", { title: "Organização", close: true });
    const m = await reply(f, ctx);
    const actions = (await actionsFor(f.db, f.org.id, [m.id])).get(m.id) ?? [];
    expect(actions.map((a) => a.kind)).toEqual([
      "channel.agent_added",
      "wiki.page_created",
      "wiki.page_edited",
      "thread.renamed",
      "thread.closed",
    ]);
    expect(actions[0]?.params).toMatchObject({ agentName: "Lia", channel: "produto" });

    const members = async () =>
      (await f.db.select().from(schema.channelMembers)).filter(
        (r) => r.channelId === produto.id && r.agentId === lia?.id,
      );
    const page = () => getWikiPage(f.db, person(f.owner.id), f.org.id, "Deploy");
    const thread = () => getThread(f.db, f.owner.id, f.org.id, ctx.threadRootId);
    const [added, pageCreated, pageEdited, renamed, closed] = actions;

    await undoAgentAction(deps(f), f.owner.id, f.org.id, added?.id ?? "");
    expect(await members()).toEqual([]);
    await redoAgentAction(deps(f), f.owner.id, f.org.id, added?.id ?? "");
    expect((await members()).length).toBe(1);

    await undoAgentAction(deps(f), f.owner.id, f.org.id, pageEdited?.id ?? "");
    expect((await page()).body).toBe("Às sextas.");
    await redoAgentAction(deps(f), f.owner.id, f.org.id, pageEdited?.id ?? "");
    expect((await page()).body).toContain("Com aprovação.");
    await undoAgentAction(deps(f), f.owner.id, f.org.id, pageEdited?.id ?? "");
    await undoAgentAction(deps(f), f.owner.id, f.org.id, pageCreated?.id ?? "");
    await expect(page()).rejects.toMatchObject({ code: "wiki.page_not_found" });
    await redoAgentAction(deps(f), f.owner.id, f.org.id, pageCreated?.id ?? "");
    expect((await page()).title).toBe("Deploy");

    expect((await thread()).state).toBe("closed");
    await undoAgentAction(deps(f), f.owner.id, f.org.id, closed?.id ?? "");
    await undoAgentAction(deps(f), f.owner.id, f.org.id, renamed?.id ?? "");
    expect(await thread()).toMatchObject({ state: "open", title: null });
    await redoAgentAction(deps(f), f.owner.id, f.org.id, renamed?.id ?? "");
    expect((await thread()).title).toBe("Organização");
  });
});

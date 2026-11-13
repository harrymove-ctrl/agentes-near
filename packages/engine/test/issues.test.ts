import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  addRunStep,
  askAgentToImplement,
  buildRunContext,
  commentIssue,
  createAgent,
  createAgentRuns,
  createChannel,
  createIssue,
  createIssueToolSource,
  drainOutbox,
  executeRun,
  ForbiddenError,
  getIssue,
  grantScopes,
  insertMessage,
  issueFromMessage,
  issueWorkBrief,
  listIssueActivity,
  listIssues,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  postPersonMessage,
  searchVisible,
  setCriterion,
  updateIssue,
  ValidationError,
  type WorkActor,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const ISSUES = ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope }));

describe("issues", () => {
  test("numbers per org, criteria, activity for every change, comments, search", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const first = await createIssue(deps, ana, f.org.id, {
      title: "Login quebra no Safari",
      description: "Ao clicar em entrar, nada acontece.",
      criteria: ["Funciona no Safari 17", "Teste automatizado"],
      priority: "high",
      dueDate: "2026-10-20",
      labels: ["Bug", "bug", " web "],
    });
    const second = await createIssue(deps, ana, f.org.id, { title: "Outra" });
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(first).toMatchObject({ status: "todo", priority: "high", labels: ["bug", "web"], dueDate: "2026-10-20" });
    expect(first.criteria.map((c) => [c.text, c.done])).toEqual([
      ["Funciona no Safari 17", false],
      ["Teste automatizado", false],
    ]);
    await expect(createIssue(deps, ana, f.org.id, { title: "x", dueDate: "20/10/2026" })).rejects.toBeInstanceOf(
      ValidationError,
    );

    await updateIssue(deps, ana, f.org.id, first.id, {
      status: "in_review",
      assignee: { type: "agent", id: f.agent.id },
    });
    const checked = await setCriterion(deps, ana, f.org.id, first.id, first.criteria[0]?.id ?? "", true);
    expect(checked.criteria[0]?.done).toBe(true);
    await commentIssue(deps, ana, f.org.id, first.id, "Reproduzi no iPhone também.");
    const activity = await listIssueActivity(f.db, ana, f.org.id, first.id);
    expect(activity.map((a) => a.event ?? a.kind)).toEqual([
      "created",
      "status_changed",
      "assigned",
      "criterion_checked",
    ]);
    // The comment is a reply in the task's conversation (ADR 0145), not an activity row.
    expect((await getIssue(f.db, ana, f.org.id, { id: first.id })).conversation?.count).toBe(1);
    expect(activity[1]?.text).toBe("changed the status to In review");
    expect(activity[1]).toMatchObject({ textCode: "status_changed", textParams: { status: "in_review" } });

    expect((await listIssues(f.db, ana, f.org.id, { q: "safari" })).map((i) => i.number)).toEqual([1]);
    expect((await listIssues(f.db, ana, f.org.id, { q: "#2" })).map((i) => i.number)).toEqual([2]);
    expect((await getIssue(f.db, ana, f.org.id, { number: 1 })).assignee).toEqual({ type: "agent", id: f.agent.id });

    await drainOutbox(f.db, f.handlers);
    const hits = await searchVisible(f.context, {
      orgId: f.org.id,
      text: "Safari",
      visibleChannelIds: [f.general.id],
      kinds: ["issue"],
    });
    expect(hits.map((h) => h.sourceId)).toContain(first.id);
  });

  test("title, description and criteria edited in place: a kept criterion keeps its check", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const issue = await createIssue(deps, ana, f.org.id, {
      title: "Botão some no iPhone",
      criteria: ["Aparece com o teclado", "Funciona no SE", "Nada muda no Android"],
    });
    const [keep, drop, rename] = issue.criteria;
    await setCriterion(deps, ana, f.org.id, issue.id, keep?.id ?? "", true);
    const edited = await updateIssue(deps, ana, f.org.id, issue.id, {
      title: "Botão Pagar some no iPhone SE",
      description: "O teclado cobre o botão.",
      criteria: [
        { id: keep?.id, text: "Aparece com o teclado" },
        { id: rename?.id, text: "Nada muda no Android nem na web" },
        { text: "  Testado no iPhone 15  " },
        { text: "   " },
      ],
    });
    expect(edited.title).toBe("Botão Pagar some no iPhone SE");
    expect(edited.description).toBe("O teclado cobre o botão.");
    expect(edited.criteria.map((c) => [c.text, c.done])).toEqual([
      ["Aparece com o teclado", true],
      ["Nada muda no Android nem na web", false],
      ["Testado no iPhone 15", false],
    ]);
    expect(edited.criteria[0]?.id).toBe(keep?.id ?? "");
    expect(edited.criteria[1]?.id).toBe(rename?.id ?? "");
    expect(edited.criteria.some((c) => c.id === drop?.id)).toBe(false);
    // The same list again changes nothing and logs nothing.
    await updateIssue(deps, ana, f.org.id, issue.id, {
      criteria: edited.criteria.map((c) => ({ id: c.id, text: c.text })),
    });
    const activity = await listIssueActivity(f.db, ana, f.org.id, issue.id);
    expect(activity.map((a) => a.event)).toEqual([
      "created",
      "criterion_checked",
      "renamed",
      "description_changed",
      "criteria_changed",
    ]);
    expect(activity.at(-1)).toMatchObject({ text: "edited the acceptance criteria", textCode: "criteria_changed" });
  });

  test('"Transformar em issue" keeps the visibility of a private channel', async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const message = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, {
      body: "Bug no pagamento\nDetalhes",
    });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, message.id);
    expect(issue).toMatchObject({ title: "Bug no pagamento", channelId: secret.id });
    expect(issue.source).toEqual({ type: "message", channelId: secret.id, messageId: message.id });
    await expect(getIssue(f.db, person(bia.id), f.org.id, { id: issue.id })).rejects.toBeInstanceOf(NotFoundError);
    expect(await listIssues(f.db, person(bia.id), f.org.id)).toEqual([]);

    const open = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "Melhorar o onboarding" });
    const fromGeneral = await issueFromMessage(deps, f.owner.id, f.org.id, open.id, { title: "Onboarding" });
    expect(fromGeneral.channelId).toBeNull(); // public origin: the whole org sees it
    expect((await listIssues(f.db, person(bia.id), f.org.id)).map((i) => i.id)).toEqual([fromGeneral.id]);
  });

  test("asking an agent to implement: work in the task's conversation, instructions only in the run's context", async () => {
    let step = 0;
    let system = "";
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) => {
        step++;
        system = JSON.stringify(req.system);
        if (step === 1 && system.includes("# Your task: issue #1")) {
          return {
            chunks: [],
            toolUses: [{ name: "comment_issue", input: { issue: "#1", text: "Comecei: reproduzi o bug." } }],
          };
        }
        return { chunks: ["Corrigido no PR #7."] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Login quebra",
      description: "Safari não entra.",
      criteria: ["Funciona no Safari"],
    });
    const asked = await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    expect(asked.assignee).toEqual({ type: "agent", id: f.agent.id });

    // The task's conversation: its root and the start inside its thread; nothing in #general or a DM.
    const at = asked.conversation;
    if (!at) throw new Error("no conversation");
    const all = await f.db.select().from(schema.messages);
    expect(all.every((m) => m.channelId === at.channelId)).toBe(true);
    const root = all.find((m) => m.id === at.rootId);
    expect(root?.meta).toMatchObject({ taskConversation: { issueId: issue.id, number: 1, title: "Login quebra" } });
    const start = all.find((m) => m.threadId === root?.id && m.authorType === "person");
    expect(start?.meta).toMatchObject({ issueId: issue.id, bodyCode: "issue_work_start" });
    for (const m of [root, start]) {
      expect(m?.body).not.toContain(issue.id);
      expect(m?.body).not.toContain("comment_issue");
      expect(m?.body).not.toContain("Safari não entra");
    }
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ channelId: at.channelId, threadRootId: root?.id, triggerMessageId: start?.id });

    await drainOutbox(f.db, f.handlers);
    // The run read its task from the issue (description, criteria, where it works).
    expect(system).toContain("Safari não entra.");
    expect(system).toContain("1. [ ] Funciona no Safari");
    expect(system).toContain("the task's own conversation");
    // Progress (`comment_issue`) and the reply are both replies in the conversation, once each.
    const replies = (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
    expect(replies.map((m) => [m.channelId, m.threadId, m.body])).toEqual([
      [at.channelId, root?.id ?? "", "Comecei: reproduzi o bug."],
      [at.channelId, root?.id ?? "", "Corrigido no PR #7."],
    ]);
    const activity = await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id);
    expect(activity.filter((a) => a.kind === "comment")).toEqual([]);
    const askedEvent = activity.find((a) => a.event === "agent_asked");
    expect(askedEvent?.textParams).toMatchObject({ threadId: root?.id });
  });

  test("asking to implement an issue from a channel message: one line there, a private issue still works", async () => {
    let system = "";
    let step = 0;
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) => {
        step++;
        system = JSON.stringify(req.system);
        if (step === 1)
          return { chunks: [], toolUses: [{ name: "comment_issue", input: { issue: "#1", text: "Vou olhar." } }] };
        return { chunks: ["Feito."] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const deps = { db: f.db, pubsub: f.pubsub };
    // A private channel the agent is not in: the issue keeps its visibility.
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: "Checkout quebra" });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, said.id);
    expect(issue.channelId).toBe(secret.id);
    await drainOutbox(f.db, f.handlers);
    const before = (await f.db.select().from(schema.messages)).length;
    await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    const added = (await f.db.select().from(schema.messages)).slice(before);
    const line = added.filter((m) => m.channelId === secret.id);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ authorType: "agent", authorAgentId: f.agent.id, threadId: null });
    expect(line[0]?.meta).toMatchObject({ issueTaken: { issueId: issue.id, number: 1 }, bodyCode: "issue_taken" });
    expect(added.filter((m) => m.channelId === f.general.id)).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    // Nobody answered the line; the agent (not in #secreto) still read and commented the issue in its conversation.
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(1);
    expect(system).toContain("# Your task: issue #1");
    // From the task's conversation the agent sees the private issue, so it's among its open tasks there.
    expect(system).toContain("- #1 Checkout quebra (in_progress)");
    const at = (await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).conversation;
    const replies = (await f.db.select().from(schema.messages))
      .filter((m) => m.authorType === "agent" && m.channelId === at?.channelId)
      .map((m) => m.body);
    expect(replies).toEqual(["Vou olhar.", "Feito."]);
  });

  test("asking to implement a manual issue posts nothing in channels; an agent the person can't talk to refuses", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Sem origem" });
    const asked = await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    const channelsWithMessages = new Set((await f.db.select().from(schema.messages)).map((m) => m.channelId));
    expect([...channelsWithMessages]).toEqual([asked.conversation?.channelId ?? ""]);
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "owner", ownerUserId: f.owner.id })
      .where(eq(schema.agents.id, f.agent.id));
    await expect(askAgentToImplement(deps, bia.id, f.org.id, issue.id, f.agent.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("the issue follows the agent's work: in progress when it starts, working while the run lives, stalled after, review with a PR", async () => {
    let step = 0;
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) => {
        step++;
        if (step === 1 && JSON.stringify(req.system).includes("# Your task: issue #1"))
          return { chunks: [], toolUses: [{ name: "update_issue", input: { issue: "#1", done_criteria: [1] } }] };
        return { chunks: ["Plano escrito; falta o teste."] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Frete lento",
      criteria: ["Responde em 2 s", "Tem teste"],
    });
    expect(issue.work).toBeNull();

    // Asked: the run is queued, so the agent is working and the status moved by itself.
    const asked = await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    expect(asked.status).toBe("in_progress");
    expect(asked.work).toMatchObject({ agentId: f.agent.id, state: "running" });
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => r.issueId)).toEqual([issue.id]);

    // The run ends without a PR: still in progress with the agent, nothing alive → stalled.
    await drainOutbox(f.db, f.handlers);
    const after = await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id });
    expect(after.status).toBe("in_progress");
    expect(after.work?.state).toBe("stalled");
    expect(after.work?.steps.map((s) => s.tool)).toEqual(["update_issue"]);
    // The agent checked the first criterion; it remembers who.
    expect(after.criteria.map((c) => [c.done, c.doneBy?.type ?? null])).toEqual([
      [true, "agent"],
      [false, null],
    ]);
    const moved = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id)).filter(
      (a) => a.event === "status_changed",
    );
    expect(moved.map((a) => [a.textParams?.status, a.auto ?? false])).toEqual([["in_progress", true]]);

    // A linked PR moves it to review on its own; in review, an ended run is not "stalled".
    const reviewed = await updateIssue(deps, person(f.owner.id), f.org.id, issue.id, {
      addPullRequest: { number: 7, url: "https://github.com/acme/app/pull/7" },
    });
    expect(reviewed.status).toBe("in_review");
    expect(reviewed.work).toBeNull();
    const last = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id)).at(-1);
    expect(last).toMatchObject({ event: "status_changed", auto: true, textParams: { status: "in_review" } });
  });

  test("the agent's steps: a permission check says its command and whether it was refused or waits", async () => {
    f = await setup({ issueTools: true });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Testes lentos" });
    await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    const [run] = await f.db.select().from(schema.agentRuns);
    if (!run) throw new Error("no run");
    const check = async (input: Record<string, unknown>, answer?: Record<string, unknown>) => {
      const toolUseId = crypto.randomUUID();
      await addRunStep(f.db, run, "tool_call", { toolUseId, name: "permission_prompt", input });
      if (answer)
        await addRunStep(f.db, run, "tool_result", {
          toolUseId,
          name: "permission_prompt",
          isError: false,
          content: JSON.stringify(answer),
        });
    };
    const pending = (id: string) => ({ status: "pending", request_id: id });
    await check(
      { tool_name: "Bash", input: { command: "npm test", description: "Run the unit tests" } },
      {
        behavior: "allow",
      },
    );
    await check(
      { tool_name: "Bash", input: { command: "rm -rf /etc/agentes" } },
      { behavior: "deny", code: "outside" },
    );
    // Waited on a person who said no (asked twice while the card was open): the runner asking again brings the
    // answer, and adds no step.
    await check({ tool_name: "Bash", input: { command: "npm publish" } }, pending("req-1"));
    await check({ tool_name: "Bash", input: { command: "npm publish" } }, pending("req-1"));
    await check({ request_id: "req-1" }, pending("req-1"));
    await check({ request_id: "req-1" }, { behavior: "deny", code: "person" });
    // Waited on a person who said yes.
    await check({ tool_name: "Bash", input: { command: "npm version patch" } }, pending("req-2"));
    await check({ request_id: "req-2" }, { behavior: "allow" });
    // Still waiting.
    await check({ tool_name: "Bash", input: { command: "git -C /w push origin fix" } }, pending("req-3"));
    await check({ request_id: "req-3" }, pending("req-3"));
    const read = await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id });
    expect(read.work?.steps.map((s) => [s.detail, s.outcome ?? null])).toEqual([
      ["Run the unit tests", null],
      ["rm /etc/agentes", "refused"],
      ["npm publish", "refused"],
      ["npm publish", "refused"],
      ["npm version patch", null],
      ["git push origin", "waiting"],
    ]);
  });

  test("every run of the assignee in the task's conversation works on it: a reply there, a computer task's end; a run elsewhere doesn't", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Frete lento" });
    const at = (await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id)).conversation;
    await drainOutbox(f.db, f.handlers);
    if (!at) throw new Error("no conversation");
    const dm = { id: at.channelId };
    const root = { id: at.rootId };
    const runOf = async (messageId: string) =>
      (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId)))[0];
    // Moved back to "to do": the next run in its thread starts the work again.
    await updateIssue(deps, person(f.owner.id), f.org.id, issue.id, { status: "todo" });

    const reply = await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, {
      body: "@dev e aí?",
      threadId: root.id,
    });
    await drainOutbox(f.db, f.handlers);
    expect((await runOf(reply.id))?.issueId).toBe(issue.id);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).status).toBe("in_progress");

    // A task on its computer ended: the notice lands in that thread and wakes the agent there.
    const notice = await f.db.transaction(async (tx) => {
      const message = await insertMessage(tx, {
        orgId: f.org.id,
        channelId: dm.id,
        threadId: root.id,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
        body: 'Task "Rodar os testes" finished on mac after 2 min.',
        meta: { machineTask: { id: crypto.randomUUID(), title: "Rodar os testes", status: "done" } },
      });
      await createAgentRuns(tx, message, [f.agent.id], "mention");
      return message;
    });
    await drainOutbox(f.db, f.handlers);
    expect((await runOf(notice.id))?.issueId).toBe(issue.id);

    const elsewhere = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    expect(await runOf(elsewhere.id)).toMatchObject({ status: "done", issueId: null });
  });

  test("an issue handed to another agent: a run of the first one in its conversation doesn't hide the new one's work", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Frete lento" });
    const at = (await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id)).conversation;
    await drainOutbox(f.db, f.handlers);
    if (!at) throw new Error("no conversation");
    const dm = { id: at.channelId };
    const root = { id: at.rootId };
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    // QA's run stays queued, so it is live: only the reply below runs.
    const handed = await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, qa.id);
    expect(handed.work).toMatchObject({ agentId: qa.id, state: "running" });

    const reply = await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "@dev e aí?", threadId: root.id });
    const runOf = async () =>
      (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, reply.id)))[0];
    await executeRun(f.jobDeps, (await runOf())?.id ?? "", { finalAttempt: true });
    expect(await runOf()).toMatchObject({ agentId: f.agent.id, status: "done", issueId: null });
    const work = (await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).work;
    expect(work).toMatchObject({ agentId: qa.id, state: "running", runId: handed.work?.runId });
  });

  test("a run's context lists the agent's open tasks, latest activity first; not closed, others' or hidden ones; none for a routine", async () => {
    f = await setup({ issueTools: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    let asked = "";
    const ask = async (body: string) => {
      asked = (await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body })).id;
      await drainOutbox(f.db, f.handlers);
      return systemText(f.provider.calls.at(-1)?.request.system ?? "");
    };
    expect(await ask("@dev bom dia")).not.toContain("# Your open tasks");

    const mine: WorkActor = { type: "agent", id: f.agent.id };
    const make = (title: string, assignee: WorkActor, criteria: string[] = []) =>
      createIssue(deps, person(f.owner.id), f.org.id, { title, assignee, criteria });
    const older = await make("Frete lento", mine, ["Responde em 2 s", "Tem teste"]);
    const newer = await make("Login quebra", mine);
    for (const [title, status] of [
      ["Já feito", "done"],
      ["Desistimos", "canceled"],
    ] as const) {
      await updateIssue(deps, person(f.owner.id), f.org.id, (await make(title, mine)).id, { status });
    }
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    await make("Do QA", { type: "agent", id: qa.id });
    // From a private channel the agent isn't in: it keeps that channel's visibility.
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: "Cofre aberto" });
    const hidden = await issueFromMessage(deps, f.owner.id, f.org.id, said.id);
    await updateIssue(deps, person(f.owner.id), f.org.id, hidden.id, { assignee: mine });
    await updateIssue(deps, person(f.owner.id), f.org.id, older.id, { status: "in_progress" });
    await setCriterion(deps, person(f.owner.id), f.org.id, older.id, older.criteria[0]?.id ?? "", true);
    const at = (id: string, minutesAgo: number) =>
      f.db
        .update(schema.issues)
        .set({ updatedAt: new Date(Date.now() - minutesAgo * 60_000) })
        .where(eq(schema.issues.id, id));
    await at(older.id, 5);
    await at(newer.id, 1);

    const listed =
      "# Your open tasks\nIssues assigned to you, latest activity first:\n- #2 Login quebra (todo)\n- #1 Frete lento (in_progress, criteria 1/2)";
    // Reading issues only, like every new agent: the list, and nothing about tools it doesn't have.
    const reading = await ask("@dev e agora?");
    expect(reading).toContain(listed);
    expect(reading).not.toContain("keep that task updated");
    for (const title of ["Já feito", "Desistimos", "Do QA", "Cofre aberto"]) expect(reading).not.toContain(title);
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    expect(await ask("@dev e agora?")).toContain(
      `${listed}\nWhen what you're doing belongs to one of them, keep that task updated as you go: a short progress comment (\`comment_issue\`) and each criterion as you meet it (\`update_issue\`); its status moves on its own.`,
    );
    // A routine's run keeps to its own task.
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked));
    if (!run) throw new Error("no run");
    const routine = await buildRunContext(f.db, run, f.agent, { maxMessages: 30, routine: true });
    expect(systemText(routine.system)).not.toContain("# Your open tasks");
  });

  test("a comment can carry the author's Drive files; they link to the issue; someone else's can't be attached", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Tela quebra no Safari" });
    const file = async (by: string, title: string) => {
      const [row] = await f.db
        .insert(schema.artifacts)
        .values({
          orgId: f.org.id,
          kind: "file",
          title,
          createdByType: "person",
          createdById: by,
          updatedByType: "person",
          updatedById: by,
        })
        .returning();
      return row?.id ?? "";
    };
    const mine = await file(f.owner.id, "print.png");
    const comment = await commentIssue(deps, person(f.owner.id), f.org.id, issue.id, "", { attachmentIds: [mine] });
    expect(comment.attachments).toEqual([{ id: mine, title: "print.png" }]);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).artifacts.map((a) => a.id)).toEqual([
      mine,
    ]);
    const other = await addMember(f.db, f.org.id, "member", "Ana");
    const theirs = await file(other.id, "deles.pdf");
    await expect(
      commentIssue(deps, person(f.owner.id), f.org.id, issue.id, "olha", { attachmentIds: [theirs] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("a new issue can carry the author's Drive files: linked, on the created event and in the agent's brief", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const file = async (by: string, title: string) => {
      const [row] = await f.db
        .insert(schema.artifacts)
        .values({
          orgId: f.org.id,
          kind: "file",
          title,
          createdByType: "person",
          createdById: by,
          updatedByType: "person",
          updatedById: by,
        })
        .returning();
      return row?.id ?? "";
    };
    const shot = await file(f.owner.id, "print-checkout.png");
    const log = await file(f.owner.id, "log-pagamento.txt");
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Botão de pagar some no celular",
      attachmentIds: [shot, log],
    });
    expect(issue.artifacts.map((a) => a.id)).toEqual([shot, log]);
    const created = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id)).find(
      (a) => a.event === "created",
    );
    expect(created?.attachments).toEqual([
      { id: shot, title: "print-checkout.png" },
      { id: log, title: "log-pagamento.txt" },
    ]);
    const brief = await issueWorkBrief(f.db, f.org.id, issue.id);
    expect(brief).toContain("## Files attached to the issue");
    expect(brief).toContain(`- print-checkout.png (artifact ${shot})`);
    // Someone else's file can't ride along on a new issue either.
    const other = await addMember(f.db, f.org.id, "member", "Ana");
    const theirs = await file(other.id, "deles.pdf");
    await expect(
      createIssue(deps, person(f.owner.id), f.org.id, { title: "Outra", attachmentIds: [theirs] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("update_issue and create_issue set the assignee: me, a handle, none; an unknown name fails", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
    const run = (name: string, input: Record<string, unknown>) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no ${name}`);
      return tool.execute(input, ctx);
    };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "N+1 no offline-map",
      assignee: { type: "person", id: f.owner.id },
    });
    const mine = await run("update_issue", { issue: `#${issue.number}`, assignee: "me" });
    expect(mine.isError).toBeUndefined();
    // The agent reads who it is, not an id.
    expect(mine.content).toContain("(assignee: @dev (you))");
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).assignee).toEqual({
      type: "agent",
      id: f.agent.id,
    });
    await run("update_issue", { issue: issue.id, assignee: "none" });
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).assignee).toBeNull();
    const failed = await run("update_issue", { issue: issue.id, assignee: "@nobody" });
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("Nobody called");

    const created = await run("create_issue", { title: "Contar o rate limit uma vez", assignee: "@dev" });
    const [row] = (await listIssues(f.db, person(f.owner.id), f.org.id, { q: "rate limit" })).filter(
      (i) => i.title === "Contar o rate limit uma vez",
    );
    expect(created.isError).toBeUndefined();
    expect(row?.assignee).toEqual({ type: "agent", id: f.agent.id });
  });

  test("assigning a task to another agent says it doesn't start it, and how to hand it the job", async () => {
    f = await setup();
    await createAgent(f.db, f.owner.id, f.org.id, { name: "Bia", handle: "bia" }, { model: "claude-sonnet-5-5" });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
    const run = async (name: string, input: Record<string, unknown>) =>
      (await tools.find((t) => t.name === name)?.execute(input, ctx))?.content ?? "";
    const created = await run("create_issue", { title: "Revisar o contrato", assignee: "@bia" });
    expect(created).toContain("Assigning doesn't tell @bia or start its work");
    expect(created).toContain("tell_agent");
    const [issue] = await listIssues(f.db, person(f.owner.id), f.org.id, { q: "contrato" });
    const ref = `#${issue?.number}`;
    // The same assignee kept, a change of its own, or the agent itself: nothing to hand over.
    expect(await run("update_issue", { issue: ref, priority: "high" })).not.toContain("tell_agent");
    expect(await run("update_issue", { issue: ref, assignee: "me" })).not.toContain("tell_agent");
    expect(await run("update_issue", { issue: ref, assignee: "@bia" })).toContain(
      "Assigning doesn't tell @bia or start its work",
    );
    expect(await run("update_issue", { issue: ref, assignee: "@bia", status: "in_progress" })).not.toContain(
      "tell_agent",
    );
  });

  test("list_issues shows each due date, so a late-tasks routine reads them from the list", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    await createIssue(deps, person(f.owner.id), f.org.id, { title: "Com prazo", dueDate: "2026-10-20" });
    await createIssue(deps, person(f.owner.id), f.org.id, { title: "Sem prazo" });
    const list = (await createIssueToolSource(f.artifactDeps).tools(ctx)).find((t) => t.name === "list_issues");
    const { content } = (await list?.execute({}, ctx)) ?? { content: "" };
    expect(content).toContain("Com prazo due 2026-10-20 id=");
    expect(content).toMatch(/Sem prazo id=/);
  });

  test("update_issue links only an https pull request; any other address is refused", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
    const update = tools.find((t) => t.name === "update_issue");
    if (!update) throw new Error("no update_issue");
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Corrigir o login" });
    for (const url of ["javascript:alert(1)//pull/3", "data:text/html,x/pull/3", "http://example.com/pull/3"]) {
      const refused = await update.execute({ issue: issue.id, pull_request_url: url, pull_request_number: 3 }, ctx);
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("https://");
    }
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).pullRequests).toEqual([]);
    const pr = "https://github.com/acme/app/pull/3";
    const linked = await update.execute({ issue: issue.id, pull_request_url: pr }, ctx);
    expect(linked.isError).toBeUndefined();
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).pullRequests).toMatchObject([
      { number: 3, url: pr },
    ]);
    await expect(
      updateIssue(deps, person(f.owner.id), f.org.id, issue.id, {
        addPullRequest: { number: 4, url: "javascript:alert(1)" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("a GitHub link: an agent sets and removes it, and only a GitHub issue or PR address goes in", async () => {
    f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
    const tool = (name: string) => {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error(name);
      return found;
    };
    const url = "https://github.com/acme/app/issues/12";
    const made = await tool("create_issue").execute({ title: "Sync", github_url: url }, ctx);
    expect(made.isError).toBeUndefined();
    const read = async () => getIssue(f.db, person(f.owner.id), f.org.id, { number: 1 });
    expect((await read()).githubUrl).toBe(url);

    const refused = await tool("update_issue").execute({ issue: "#1", github_url: "javascript:alert(1)" }, ctx);
    expect(refused.isError).toBe(true);
    for (const bad of [
      "https://evil.example/acme/app/issues/1",
      "https://github.com/acme/app",
      "http://github.com/a/b/pull/1",
    ]) {
      await expect(
        updateIssue(deps, person(f.owner.id), f.org.id, (await read()).id, { githubUrl: bad }),
      ).rejects.toBeInstanceOf(ValidationError);
    }

    const pr = "https://github.com/acme/app/pull/40/files";
    await tool("update_issue").execute({ issue: "#1", github_url: pr }, ctx);
    expect((await read()).githubUrl).toBe(pr);
    await tool("update_issue").execute({ issue: "#1", github_url: "" }, ctx);
    expect((await read()).githubUrl).toBeNull();
    // Setting what is already there says nothing in the activity.
    const issue = await read();
    await updateIssue(deps, person(f.owner.id), f.org.id, issue.id, { githubUrl: null });
    const said = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id)).filter(
      (a) => a.event === "github_link",
    );
    expect(said.map((a) => a.textCode).sort()).toEqual(["github_linked", "github_unlinked"]);
  });

  test("a new agent creates tasks with no card, updates what it can see of others' and never what it can't", async () => {
    f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
    const { id: agentId } = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Lia", handle: "lia" },
      NEW_AGENT_DEFAULTS,
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId });
    const deps = { db: f.db, pubsub: f.pubsub };
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const hidden = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Segredo", channelId: secret.id });
    const theirs = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Da Ana",
      assignee: { type: "person", id: f.owner.id },
    });
    const ctx = { ...(await runContext(f)), agentId };
    await f.db.update(schema.agentRuns).set({ agentId }).where(eq(schema.agentRuns.id, ctx.runId));
    // Someone who is no administrator asked: an administrator's run reaches what they reach.
    const plain = await addMember(f.db, f.org.id, "member", "plain");
    await f.db
      .update(schema.messages)
      .set({ authorUserId: plain.id })
      .where(eq(schema.messages.id, ctx.triggerMessageId ?? ""));
    const call = (name: string, input: Record<string, unknown>) =>
      f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });

    expect(await call("create_issue", { title: "Revisar o onboarding" })).toMatchObject({
      type: "result",
      output: { content: expect.stringContaining("Created #") },
    });
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await call("update_issue", { issue: theirs.id, status: "in_progress" })).toMatchObject({
      type: "result",
      output: { content: expect.stringContaining("Updated #") },
    });
    expect(await call("comment_issue", { issue: theirs.id, text: "Comecei." })).toMatchObject({
      output: { content: `Commented on #${theirs.number}.` },
    });
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: theirs.id })).assignee).toMatchObject({
      id: f.owner.id,
    });
    expect(await call("update_issue", { issue: hidden.id, status: "done" })).toMatchObject({
      output: { isError: true },
    });
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: hidden.id })).status).toBe("todo");
  });

  test("closing someone's task while unassigning it reads as a change on the receipt, never as an assignment", async () => {
    f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const theirs = await createIssue({ db: f.db, pubsub: f.pubsub }, person(f.owner.id), f.org.id, {
      title: "Da Ana",
      assignee: { type: "person", id: f.owner.id },
    });
    await f.tools?.invoke(await runContext(f), {
      toolUseId: crypto.randomUUID(),
      name: "update_issue",
      input: { issue: theirs.id, status: "canceled", assignee: "none" },
    });
    expect(await f.db.select().from(schema.agentActions)).toMatchObject([
      { kind: "issue.updated", after: { status: "canceled", assignee: null } },
    ]);
  });

  test("an agent without issues:write can't create issues; one in another channel can't see private ones", async () => {
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) =>
        JSON.stringify(req.messages.at(-1)?.content).includes("tool_result")
          ? { chunks: ["ok"] }
          : { chunks: [], toolUses: [{ name: "create_issue", input: { title: "Nova" } }] },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev abre" });
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.issues)).toEqual([]);

    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const deps = { db: f.db, pubsub: f.pubsub };
    const hidden = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Segredo", channelId: secret.id });
    const inGeneral = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    const inSecret = { type: "agent" as const, agentId: f.agent.id, channelId: secret.id };
    await expect(getIssue(f.db, inGeneral, f.org.id, { id: hidden.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getIssue(f.db, inSecret, f.org.id, { id: hidden.id })).title).toBe("Segredo");
    const githubUrl = "https://github.com/acme/app/issues/1";
    await expect(updateIssue(deps, inGeneral, f.org.id, hidden.id, { githubUrl })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await getIssue(f.db, inSecret, f.org.id, { id: hidden.id })).githubUrl).toBeNull();
  });
});

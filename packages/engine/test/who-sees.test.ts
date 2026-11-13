import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  archiveChannel,
  askAgentToImplement,
  buildTeamWeek,
  calendarRange,
  channelCard,
  commentIssue,
  createArtifact,
  createCalendarEvent,
  createChannel,
  createIssue,
  createRole,
  createWikiPage,
  drainOutbox,
  ForbiddenError,
  getArtifact,
  getIssue,
  getWikiPage,
  grantScopes,
  issueFromMessage,
  joinChannel,
  listArtifacts,
  listAudit,
  listChannels,
  listIssues,
  listMessages,
  listMissions,
  listNotifications,
  listThreads,
  listWikiPages,
  NotFoundError,
  openDm,
  openPersonAgentDm,
  openTaskConversation,
  postPersonMessage,
  readableChannelIds,
  removeMember,
  requireChannelAccess,
  searchForUser,
  setIssueAudience,
  setMemberRoles,
  setWikiPageAudience,
  updateIssue,
  userVisibleChannels,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const everyone = { mode: "everyone" } as const;
const only = (...userIds: string[]) => ({ mode: "people" as const, userIds });
const seen = async (userId: string) => (await listIssues(f.db, person(userId), f.org.id)).map((i) => i.title);

describe("what changing who sees a task reaches", () => {
  const steps = async (who: string) => {
    const parent = await createIssue(deps(), person(who), f.org.id, { title: "Pai" });
    const step = await createIssue(deps(), person(who), f.org.id, { title: "Passo", parentIssueId: parent.id });
    const deep = await createIssue(deps(), person(who), f.org.id, { title: "Fundo", parentIssueId: step.id });
    return { parent, step, deep };
  };
  const audienceOf = async (id: string) => (await getIssue(f.db, person(f.owner.id), f.org.id, { id })).audience;

  test("limiting a task limits its steps at every depth", async () => {
    const { ana, bia } = await team();
    const { parent, deep } = await steps(ana.id);
    await setIssueAudience(deps(), person(ana.id), f.org.id, parent.id, only(ana.id));
    expect(await seen(bia.id)).toEqual([]);
    expect((await audienceOf(deep.id)).userIds).toEqual([ana.id]);
  });

  test("a step kept to someone isn't opened to the people of its task; one that followed the task goes on following", async () => {
    const { ana, bia } = await team();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const { parent, step, deep } = await steps(ana.id);
    await setIssueAudience(deps(), person(ana.id), f.org.id, step.id, only(ana.id));
    await setIssueAudience(deps(), person(ana.id), f.org.id, deep.id, only(caio.id));
    await setIssueAudience(deps(), person(ana.id), f.org.id, parent.id, only(ana.id, bia.id));
    expect((await audienceOf(step.id)).userIds).toEqual([ana.id]);
    const follower = await createIssue(deps(), person(ana.id), f.org.id, { title: "B", parentIssueId: parent.id });
    await setIssueAudience(deps(), person(ana.id), f.org.id, parent.id, only(ana.id));
    expect((await audienceOf(follower.id)).userIds).toEqual([ana.id]);
    await setIssueAudience(deps(), person(ana.id), f.org.id, parent.id, only(ana.id, bia.id));
    expect((await audienceOf(follower.id)).userIds.sort()).toEqual([ana.id, bia.id].sort());
  });

  test("someone assigned to a step keeps it; someone who lost a step loses its notifications", async () => {
    const { ana, bia } = await team();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const parent = await createIssue(deps(), person(ana.id), f.org.id, { title: "Pai" });
    const kept = await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Dele",
      parentIssueId: parent.id,
      assignee: { type: "person", id: bia.id },
    });
    const gone = await createIssue(deps(), person(caio.id), f.org.id, { title: "Do Caio", parentIssueId: parent.id });
    await updateIssue(deps(), person(ana.id), f.org.id, gone.id, { status: "in_progress" });
    await drainOutbox(f.db, f.handlers);
    expect((await listNotifications({ db: f.db }, caio.id, f.org.id)).items.length).toBeGreaterThan(0);
    await setIssueAudience(deps(), person(ana.id), f.org.id, parent.id, only(ana.id));
    expect(await seen(bia.id)).toEqual(["Dele"]);
    expect((await audienceOf(kept.id)).userIds.sort()).toEqual([ana.id, bia.id].sort());
    expect((await listNotifications({ db: f.db }, caio.id, f.org.id)).items).toEqual([]);
  });

  test("who stops seeing it loses its open conversation at once; who still sees it doesn't", async () => {
    const { ana, bia, adm } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Plano",
      audience: only(ana.id, bia.id),
    });
    const { channelId } = await openTaskConversation(f.db, person(ana.id), f.org.id, task.id);
    const heard: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => heard.push(e));
    await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, only(ana.id));
    const revoked = heard.filter((e) => e.type === "membership.revoked");
    expect(revoked).toMatchObject([{ userId: bia.id, channelId }]);
    expect(JSON.stringify(revoked)).not.toContain(adm.id);
  });

  test("search keeps a task out as soon as it's limited, before its document catches up", async () => {
    const { ana, bia } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Reajuste geral" });
    await drainOutbox(f.db, f.handlers);
    const hits = async (userId: string) =>
      (await searchForUser(f.context, userId, f.org.id, { text: "Reajuste" })).map((h) => h.sourceId);
    expect(await hits(bia.id)).toEqual([task.id]);
    await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, only(ana.id));
    expect(await hits(bia.id)).toEqual([]);
    expect(await hits(ana.id)).toEqual([task.id]);
  });

  test("a file brought to a limited task stays with who sees it, not in the workspace's Drive", async () => {
    const { ana, bia, adm } = await team();
    const upload = (title: string) =>
      createArtifact(f.artifactDeps, person(ana.id), f.org.id, { title, content: { kind: "document", markdown: "x" } });
    const atCreation = await upload("Na criação");
    const inComment = await upload("Num comentário");
    const task = await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Plano",
      audience: only(ana.id),
      attachmentIds: [atCreation.id],
    });
    await commentIssue(deps(), person(ana.id), f.org.id, task.id, "", { attachmentIds: [inComment.id] });
    for (const file of [atCreation, inComment]) {
      await expect(getArtifact(f.artifactDeps, person(bia.id), f.org.id, file.id)).rejects.toThrow();
      expect((await getArtifact(f.artifactDeps, person(ana.id), f.org.id, file.id)).id).toBe(file.id);
      expect((await getArtifact(f.artifactDeps, person(adm.id), f.org.id, file.id)).id).toBe(file.id);
    }
    expect((await listArtifacts(f.db, person(bia.id), f.org.id)).map((a) => a.id)).toEqual([]);
  });

  test("a file brought to an open task stays the workspace's, and someone else's file isn't taken from it", async () => {
    const { ana, bia } = await team();
    const mine = await createArtifact(f.artifactDeps, person(ana.id), f.org.id, {
      title: "Aberto",
      content: { kind: "document", markdown: "x" },
    });
    const theirs = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, {
      title: "Da Bia",
      content: { kind: "document", markdown: "x" },
    });
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Plano", attachmentIds: [mine.id] });
    expect((await getArtifact(f.artifactDeps, person(bia.id), f.org.id, mine.id)).id).toBe(mine.id);
    await updateIssue(deps(), person(ana.id), f.org.id, task.id, { addFiles: [theirs.id] });
    await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, only(ana.id));
    expect((await getArtifact(f.artifactDeps, person(bia.id), f.org.id, theirs.id)).id).toBe(theirs.id);
    await expect(getArtifact(f.artifactDeps, person(bia.id), f.org.id, mine.id)).rejects.toThrow();
  });

  test("who chooses stays in the list even at its limit", async () => {
    const { ana } = await team();
    const crowd = Array.from({ length: 200 }, (_, i) => `someone-${i}`);
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Cheia", audience: only(...crowd) });
    expect(task.audience.userIds).toEqual([ana.id]);
  });
});

describe("what an administrator reaches, and what stays closed", () => {
  async function privateRoom() {
    const people = await team();
    const secret = await createChannel(f.db, people.ana.id, f.org.id, { name: "secret", visibility: "private" });
    return { ...people, secret };
  }

  test("a task's conversation is never joined, not even by an administrator", async () => {
    const { ana, adm } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Plano", audience: only(ana.id) });
    const { channelId } = await openTaskConversation(f.db, person(ana.id), f.org.id, task.id);
    await expect(joinChannel(f.db, adm.id, f.org.id, channelId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a channel's threads open for them; the Threads page stays their own, and a DM's are closed", async () => {
    const { ana, bia, adm, secret } = await privateRoom();
    const root = await postPersonMessage(deps(), ana.id, f.org.id, secret.id, { body: "Pergunta" });
    await postPersonMessage(deps(), ana.id, f.org.id, secret.id, { body: "Resposta", threadId: root.id });
    const inRoom = (userId: string) => listThreads(f.db, userId, { orgId: f.org.id, channelId: secret.id });
    expect((await inRoom(adm.id)).threads.map((t) => t.id)).toEqual([root.id]);
    await expect(inRoom(bia.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listThreads(f.db, adm.id, { orgId: f.org.id })).threads).toEqual([]);
    const dm = await openDm(f.db, ana.id, f.org.id, { userId: bia.id });
    await expect(listThreads(f.db, adm.id, { orgId: f.org.id, channelId: dm.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("a private channel's missions are listed for them, a DM's aren't, and a demoted one loses them", async () => {
    const { ana, bia, adm, secret } = await privateRoom();
    const mission = async (channelId: string, title: string) => {
      const root = await postPersonMessage(deps(), ana.id, f.org.id, channelId, { body: title });
      await f.db.insert(schema.missions).values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId,
        threadRootId: root.id,
        ownerId: ana.id,
        title,
        goal: "x",
        status: "active",
        brain: "model",
        mainSessionId: crypto.randomUUID(),
      });
    };
    await mission(secret.id, "Na sala");
    await mission((await openDm(f.db, ana.id, f.org.id, { userId: bia.id })).id, "Na DM");
    const titles = async (userId: string) =>
      (await listMissions({ db: f.db } as never, userId, f.org.id)).missions.map((m) => m.title);
    expect(await titles(adm.id)).toEqual(["Na sala"]);
    expect(await titles(bia.id)).toEqual(["Na DM"]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, adm.id, []);
    expect(await titles(adm.id)).toEqual([]);
  });

  test("the task of a DM shows to them; what its work asks in the DM doesn't", async () => {
    const { ana, adm } = await team();
    const dm = await openDm(f.db, ana.id, f.org.id, { agentId: f.agent.id });
    const root = await postPersonMessage(deps(), ana.id, f.org.id, dm.id, { body: "monta o relatório" });
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Relatório", channelId: dm.id });
    const [run] = await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_input" })
      .where(eq(schema.agentRuns.triggerMessageId, root.id))
      .returning();
    const [work] = await f.db
      .insert(schema.agentWorks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: dm.id,
        title: "Relatório",
        issueId: task.id,
        anchorMessageId: root.id,
        homeThreadId: root.id,
        ownThread: false,
        status: "live",
        how: "agent",
        lastUpdateAt: new Date(),
        requestedByUserId: ana.id,
      })
      .returning();
    await f.db
      .update(schema.agentRuns)
      .set({ workId: work?.id })
      .where(eq(schema.agentRuns.id, run?.id ?? ""));
    await f.db.insert(schema.agentQuestions).values({
      orgId: f.org.id,
      runId: run?.id ?? "",
      agentId: f.agent.id,
      channelId: dm.id,
      toolUseId: "tu-1",
      text: "Mando o salário de quem?",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const card = async (userId: string) =>
      (await getIssue(f.db, person(userId), f.org.id, { id: task.id })).backgroundWork;
    expect((await card(ana.id))?.question?.text).toContain("salário");
    const theirs = await card(adm.id);
    expect(theirs).not.toBeNull();
    expect(theirs?.question).toBeNull();
    const listed = (await listIssues(f.db, person(adm.id), f.org.id)).find((i) => i.id === task.id);
    expect(JSON.stringify(listed)).not.toContain("salário");
  });

  test("an event of an archived channel stays on the calendar of who's in it", async () => {
    const { ana, bia, secret } = await privateRoom();
    await addChannelMember(f.db, ana.id, f.org.id, secret.id, { userId: bia.id });
    await createCalendarEvent({ db: f.db }, ana.id, f.org.id, {
      title: "Reunião",
      start: "2026-11-20T12:00:00Z",
      end: "2026-11-20T13:00:00Z",
      recurrence: "none",
      participants: [],
      channelId: secret.id,
    });
    await archiveChannel(f.db, ana.id, f.org.id, secret.id);
    const range = await calendarRange({ db: f.db }, bia.id, f.org.id, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect(range.events.map((e) => e.title)).toEqual(["Reunião"]);
  });
});

describe("what a conversation hears of a limited task", () => {
  const receiptsOf = async () =>
    (await f.db.select().from(schema.agentActions)).map((a) => ({ target: a.target, params: a.params }));

  test("a receipt in a public channel keeps its title, where only some see the task", async () => {
    const { ana } = await team();
    const call = await toolsIn(f.general.id);
    const made = await call("create_issue", { title: "Demissão da Bia", visible_to: "requester" });
    expect(JSON.stringify(await receiptsOf())).not.toContain("Demissão da Bia");
    expect(JSON.stringify(made)).toContain("don't repeat");
    await call("update_issue", { issue: "#1", priority: "high" });
    expect(JSON.stringify(await receiptsOf())).not.toContain("Demissão da Bia");
    expect(await seen(f.owner.id)).toEqual(["Demissão da Bia"]);
    expect(await seen(ana.id)).toEqual([]);
    await call("create_issue", { title: "Onboarding" });
    expect(JSON.stringify(await receiptsOf())).toContain("Onboarding");
  });

  test("the line that an agent took a task stays out of the channel once it's limited", async () => {
    const { ana } = await team();
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: ana.id });
    const message = await postPersonMessage(deps(), ana.id, f.org.id, f.general.id, { body: "Demissão da Bia" });
    const task = await issueFromMessage(deps(), ana.id, f.org.id, message.id);
    await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, only(ana.id));
    await askAgentToImplement(deps(), ana.id, f.org.id, task.id, f.agent.id);
    const lines = await listMessages(f.db, ana.id, f.org.id, f.general.id);
    expect(lines.filter((m) => m.meta.issueTaken)).toEqual([]);
  });
});

describe("the audit log, for calls that wrote on what the reader doesn't see", () => {
  test("a comment and a link made from a public channel keep their text from view_audit alone", async () => {
    const { ana } = await team();
    const role = await createRole(f.db, f.owner.id, f.org.id, { name: "Auditoria", permissions: ["view_audit"] });
    const auditor = await addMember(f.db, f.org.id, "member", "auditor");
    await setMemberRoles(f.db, f.owner.id, f.org.id, auditor.id, [role.id]);
    const task = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Sigilo", audience: only(ana.id) });
    const page = await createWikiPage(deps(), person(f.owner.id), f.org.id, {
      title: "Página fechada depois",
      body: "x",
    });
    const call = await toolsIn(f.general.id);
    await call("comment_issue", { issue: `#${task.number}`, text: "Demissão confirmada" });
    await call("link_to_wiki", { page: page.slug, to: ["Outra página"] });
    await setWikiPageAudience(deps(), f.owner.id, f.org.id, page.slug, { roleIds: [], userIds: [f.owner.id] });
    const rows = (userId: string) => listAudit(f.db, userId, f.org.id, { kind: "tool" });
    const asOwner = JSON.stringify((await rows(f.owner.id)).rows);
    expect(asOwner).toContain("Demissão confirmada");
    expect(asOwner).toContain("Outra página");
    const asAuditor = JSON.stringify((await rows(auditor.id)).rows);
    expect(asAuditor).not.toContain("Demissão confirmada");
    expect(asAuditor).not.toContain("Outra página");
  });
});

/** A workspace with a plain member (`ana`), another (`bia`) and an administrator who is in nothing (`adm`). */
async function team() {
  f = await setup({ issueTools: true, wikiTools: true, reply: () => ({ chunks: ["ok"] }) });
  await grantScopes(
    f.db,
    f.org.id,
    f.agent.id,
    ["issues:read", "issues:write", "wiki:read", "wiki:write"].map((scope) => ({ connectionId: null, scope })),
  );
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const adm = await addMember(f.db, f.org.id, "admin", "adm");
  return { ana, bia, adm };
}

async function toolsIn(channelId: string) {
  const ctx = { ...(await runContext(f)), channelId };
  await f.db.update(schema.agentRuns).set({ channelId }).where(eq(schema.agentRuns.id, ctx.runId));
  return (name: string, input: Record<string, unknown>) =>
    f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
}

describe("a task's audience", () => {
  test("only me, specific people, everyone: every read path, and administrators always", async () => {
    const { ana, bia, adm } = await team();
    const mine = await createIssue(deps(), person(ana.id), f.org.id, { title: "Só minha", audience: only(ana.id) });
    const ours = await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Nossa",
      audience: only(ana.id, bia.id),
    });
    await createIssue(deps(), person(ana.id), f.org.id, { title: "Aberta", audience: everyone });

    expect(mine.audience).toEqual({ mode: "people", userIds: [ana.id], channelId: null });
    expect((await seen(ana.id)).sort()).toEqual(["Aberta", "Nossa", "Só minha"]);
    expect((await seen(bia.id)).sort()).toEqual(["Aberta", "Nossa"]);
    expect((await seen(adm.id)).sort()).toEqual(["Aberta", "Nossa", "Só minha"]);
    expect(await seen(f.owner.id)).toHaveLength(3);

    const outsider = await addMember(f.db, f.org.id, "member", "caio");
    expect(await seen(outsider.id)).toEqual(["Aberta"]);
    await expect(getIssue(f.db, person(outsider.id), f.org.id, { id: ours.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getIssue(f.db, person(bia.id), f.org.id, { number: mine.number })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(updateIssue(deps(), person(bia.id), f.org.id, mine.id, { status: "done" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(commentIssue(deps(), person(bia.id), f.org.id, mine.id, "oi")).rejects.toBeInstanceOf(NotFoundError);
    await expect(openTaskConversation(f.db, person(bia.id), f.org.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("its conversation is read by who sees it, an administrator too, and nobody else", async () => {
    const { ana, bia, adm } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Só minha", audience: only(ana.id) });
    const at = await openTaskConversation(f.db, person(ana.id), f.org.id, task.id);
    await requireChannelAccess(f.db, ana.id, f.org.id, at.channelId);
    await requireChannelAccess(f.db, adm.id, f.org.id, at.channelId);
    await expect(requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).rejects.toThrow();
    expect(await readableChannelIds(f.db, f.org.id, bia.id, [at.channelId])).toEqual(new Set());
  });

  test("anyone who can edit it changes it; they stay in, and so does who it's assigned to", async () => {
    const { ana, bia, adm } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Plano",
      assignee: { type: "person", id: bia.id },
    });
    const limited = await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, only());
    expect(limited.audience.userIds.sort()).toEqual([ana.id, bia.id].sort());
    expect(await seen(bia.id)).toEqual(["Plano"]);
    await expect(
      setIssueAudience(
        deps(),
        person(adm.id),
        f.org.id,
        (await createIssue(deps(), person(adm.id), f.org.id, { title: "x" })).id,
        only(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    const byAdmin = await setIssueAudience(deps(), person(adm.id), f.org.id, task.id, only(ana.id));
    expect(byAdmin.audience.userIds.sort()).toEqual([ana.id, bia.id].sort());
    const open = await setIssueAudience(deps(), person(bia.id), f.org.id, task.id, everyone);
    expect(open.audience).toEqual({ mode: "everyone", userIds: [], channelId: null });
    const activity = await f.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.issueId, task.id));
    expect(activity.filter((a) => a.event === "audience_changed")).toHaveLength(2);
  });

  test("someone outside it can't be assigned until they're in it", async () => {
    const { ana, bia } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Só minha", audience: only(ana.id) });
    await expect(
      updateIssue(deps(), person(ana.id), f.org.id, task.id, { assignee: { type: "person", id: bia.id } }),
    ).rejects.toMatchObject({ code: "issue.assignee_outside" });
    await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, only(ana.id, bia.id));
    await updateIssue(deps(), person(ana.id), f.org.id, task.id, { assignee: { type: "person", id: bia.id } });
  });

  test("a step follows its task when it's limited; to everyone, a step kept back stays back", async () => {
    const { ana, bia } = await team();
    const parent = await createIssue(deps(), person(ana.id), f.org.id, { title: "Pai" });
    const step = await createIssue(deps(), person(ana.id), f.org.id, { title: "Passo", parentIssueId: parent.id });
    await setIssueAudience(deps(), person(ana.id), f.org.id, parent.id, only(ana.id));
    expect(await seen(bia.id)).toEqual([]);
    expect((await getIssue(f.db, person(ana.id), f.org.id, { id: step.id })).audience.mode).toBe("people");
    const later = await createIssue(deps(), person(ana.id), f.org.id, { title: "Depois", parentIssueId: parent.id });
    expect(later.audience.userIds).toEqual([ana.id]);
    await setIssueAudience(deps(), person(ana.id), f.org.id, parent.id, everyone);
    expect(await seen(bia.id)).toEqual(["Pai"]);
  });

  test("realtime: a limited task goes to its people and administrators, never to the workspace; a change says no more than its id", async () => {
    const { ana, bia, adm } = await team();
    const toOrg: RealtimeEvent[] = [];
    const heard = (userId: string) => {
      const out: RealtimeEvent[] = [];
      f.pubsub.subscribe(userTopic(f.org.id, userId), (e) => out.push(e));
      return out;
    };
    const [toAna, toBia, toAdm] = [heard(ana.id), heard(bia.id), heard(adm.id)];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => toOrg.push(e));
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Só minha", audience: only(ana.id) });
    await updateIssue(deps(), person(ana.id), f.org.id, task.id, { status: "in_progress" });
    expect(toOrg).toEqual([]);
    expect(toAna.map((e) => e.type)).toEqual(["issue.created", "issue.updated"]);
    expect(toAdm.map((e) => e.type)).toEqual(["issue.created", "issue.updated"]);
    expect(toBia).toEqual([]);

    await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, only(ana.id, bia.id));
    expect(JSON.stringify(toOrg)).not.toContain("Só minha");
    expect(toOrg).toMatchObject([{ type: "org.broadcast", event: { type: "issue.audience", issueId: task.id } }]);
  });

  test("search finds it for who sees it, an administrator included, and a DM's task without its messages", async () => {
    const { ana, bia, adm } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Reajuste", audience: only(ana.id) });
    const dm = await openDm(f.db, ana.id, f.org.id, { userId: bia.id });
    await postPersonMessage(deps(), ana.id, f.org.id, dm.id, { body: "Reajuste combinado" });
    const tied = await createIssue(deps(), person(ana.id), f.org.id, { title: "Reajuste da DM", channelId: dm.id });
    await drainOutbox(f.db, f.handlers);
    const hits = async (userId: string) =>
      (await searchForUser(f.context, userId, f.org.id, { text: "Reajuste" })).map((h) => h.sourceId);
    expect((await hits(adm.id)).sort()).toEqual([task.id, tied.id].sort());
    expect(await hits(bia.id)).not.toContain(task.id);
    expect(await hits(ana.id)).toContain(task.id);
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    expect(await hits(caio.id)).toEqual([]);
  });

  test("notifications reach who sees it, and go when someone stops seeing it", async () => {
    const { ana, bia } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Plano",
      audience: only(ana.id, bia.id),
      assignee: { type: "person", id: bia.id },
    });
    await drainOutbox(f.db, f.handlers);
    expect((await listNotifications({ db: f.db }, bia.id, f.org.id)).items).toHaveLength(1);
    await updateIssue(deps(), person(ana.id), f.org.id, task.id, { assignee: null });
    await setIssueAudience(deps(), person(ana.id), f.org.id, task.id, only(ana.id));
    expect((await listNotifications({ db: f.db }, bia.id, f.org.id)).items).toEqual([]);
  });

  test("counts: the calendar and the weekly card leave out what the person doesn't see", async () => {
    const { ana, bia, adm } = await team();
    await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Prazo",
      audience: only(ana.id),
      dueDate: "2026-11-20",
    });
    const range = (userId: string) =>
      calendarRange({ db: f.db }, userId, f.org.id, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect((await range(ana.id)).deadlines).toHaveLength(1);
    expect((await range(adm.id)).deadlines).toHaveLength(1);
    expect((await range(bia.id)).deadlines).toEqual([]);

    const closed = async (title: string) => {
      const t = await createIssue(deps(), person(ana.id), f.org.id, { title, audience: only(ana.id) });
      await f.db
        .update(schema.issues)
        .set({ status: "done", assigneeType: "agent", assigneeId: f.agent.id })
        .where(eq(schema.issues.id, t.id));
    };
    await closed("Um");
    await closed("Dois");
    const { runId } = await runContext(f);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, runId));
    const end = new Date(Date.now() + 60_000);
    const week = (userId: string) =>
      buildTeamWeek(f.db, {
        orgId: f.org.id,
        userId,
        rightHandId: f.agent.id,
        start: new Date(end.getTime() - 7 * 86_400_000),
        end,
        timezone: "UTC",
      });
    expect((await week(ana.id))?.worked.filter((h) => h.kind === "tasks")).toHaveLength(1);
    expect((await week(bia.id))?.worked.filter((h) => h.kind === "tasks") ?? []).toEqual([]);
  });

  test("a person removed from the workspace and an administrator demoted lose it at once", async () => {
    const { ana, bia, adm } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, {
      title: "Plano",
      audience: only(ana.id, bia.id),
    });
    const at = await openTaskConversation(f.db, person(ana.id), f.org.id, task.id);
    expect(await seen(adm.id)).toEqual(["Plano"]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, adm.id, []);
    expect(await seen(adm.id)).toEqual([]);
    await expect(requireChannelAccess(f.db, adm.id, f.org.id, at.channelId)).rejects.toThrow();
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    await expect(listIssues(f.db, person(bia.id), f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("what an agent picks and reaches", () => {
  test("it picks from where it's made and says so; the person may ask for another", async () => {
    const { ana } = await team();
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
    const made = async (channelId: string, more: Record<string, unknown> = {}) => {
      const answer = await (await toolsIn(channelId))("create_issue", { title: "Tarefa", ...more });
      if (answer?.type !== "result") throw new Error("no result");
      const id = (answer.output.data as { issue: { id: string } }).issue.id;
      return { said: answer.output.content, task: await getIssue(f.db, person(f.owner.id), f.org.id, { id }) };
    };
    const open = await made(f.general.id);
    expect(open.task.audience.mode).toBe("everyone");
    expect(open.said).toContain("everyone in the workspace");
    const here = await made(dm.id);
    expect(here.task.audience).toEqual({ mode: "people", userIds: [f.owner.id], channelId: dm.id });
    expect(here.said).toContain("the people in this conversation");
    const wide = await made(dm.id, { visible_to: "everyone" });
    expect(wide.task.audience.mode).toBe("everyone");
    const mine = await made(f.general.id, { visible_to: "requester" });
    expect(mine.task.audience).toEqual({ mode: "people", userIds: [f.owner.id], channelId: null });
    expect(await seen(ana.id)).toHaveLength(2);
  });

  test("working for a person it reaches their task by id; it lists it only where everyone there sees it", async () => {
    const { ana, bia } = await team();
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
    const task = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "Só do dono",
      audience: only(f.owner.id),
    });
    const inDm = await toolsIn(dm.id);
    expect(await inDm("list_issues", {})).toMatchObject({ output: { content: expect.stringContaining("Só do dono") } });
    const inGeneral = await toolsIn(f.general.id);
    expect(await inGeneral("list_issues", {})).toMatchObject({ output: { content: "No issues." } });
    expect(await inGeneral("list_issues", { issue: task.id })).toMatchObject({
      output: { content: expect.stringContaining("Só do dono") },
    });
    // The owner is an administrator, so the run reaches it; someone else's run doesn't.
    const anas = await createIssue(deps(), person(ana.id), f.org.id, { title: "Da Ana", audience: only(ana.id) });
    expect(await inDm("list_issues", { issue: anas.id })).toMatchObject({
      output: { content: expect.stringContaining("Da Ana") },
    });
    const bias = await runContext(f);
    await f.db
      .update(schema.messages)
      .set({ authorUserId: bia.id })
      .where(eq(schema.messages.id, bias.triggerMessageId ?? ""));
    const reach = { toolUseId: crypto.randomUUID(), name: "list_issues", input: { issue: anas.id } };
    expect(await f.tools?.invoke(bias, reach)).toMatchObject({ output: { isError: true } });
  });

  test("with nobody behind it, a limited task is out of reach", async () => {
    const { ana } = await team();
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Só minha", audience: only(ana.id) });
    await expect(
      getIssue(f.db, { type: "agent", agentId: f.agent.id, channelId: f.general.id }, f.org.id, { id: task.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("administrators and channels", () => {
  async function privateRoom() {
    const people = await team();
    const secret = await createChannel(f.db, people.ana.id, f.org.id, { name: "secret", visibility: "private" });
    await postPersonMessage(deps(), people.ana.id, f.org.id, secret.id, { body: "Fusão com a ACME" });
    return { ...people, secret };
  }

  test("they read a private channel with no need to join; it's listed, not joined; someone else's isn't", async () => {
    const { bia, adm, secret } = await privateRoom();
    const listed = (await listChannels(f.db, adm.id, f.org.id)).find((c) => c.id === secret.id);
    expect(listed).toMatchObject({ isMember: false, unreadCount: 0, lastMessage: null });
    expect((await listChannels(f.db, bia.id, f.org.id)).some((c) => c.id === secret.id)).toBe(false);
    expect((await channelCard(f.db, adm.id, f.org.id, secret.id)).isMember).toBe(false);
    await expect(channelCard(f.db, bia.id, f.org.id, secret.id)).rejects.toBeInstanceOf(NotFoundError);
    await requireChannelAccess(f.db, adm.id, f.org.id, secret.id);
    await expect(requireChannelAccess(f.db, bia.id, f.org.id, secret.id)).rejects.toBeInstanceOf(ForbiddenError);
    const read = await listMessages(f.db, adm.id, f.org.id, secret.id, {});
    expect(read.map((m) => m.body)).toEqual(["Fusão com a ACME"]);
    await joinChannel(f.db, adm.id, f.org.id, secret.id);
    expect((await listChannels(f.db, adm.id, f.org.id)).find((c) => c.id === secret.id)?.isMember).toBe(true);
  });

  test("a DM between other people stays theirs: no access, no search, no join, not in any list", async () => {
    const { ana, bia, adm } = await privateRoom();
    const dm = await openDm(f.db, ana.id, f.org.id, { userId: bia.id });
    await postPersonMessage(deps(), ana.id, f.org.id, dm.id, { body: "Conversa reservada" });
    await drainOutbox(f.db, f.handlers);
    await expect(requireChannelAccess(f.db, adm.id, f.org.id, dm.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(joinChannel(f.db, adm.id, f.org.id, dm.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await userVisibleChannels(f.db, f.org.id, adm.id)).not.toContain(dm.id);
    expect(await readableChannelIds(f.db, f.org.id, adm.id, [dm.id])).toEqual(new Set());
    expect((await listChannels(f.db, adm.id, f.org.id)).some((c) => c.id === dm.id)).toBe(false);
    expect(await searchForUser(f.context, adm.id, f.org.id, { text: "reservada" })).toEqual([]);
    expect(await searchForUser(f.context, ana.id, f.org.id, { text: "reservada" })).toHaveLength(1);
  });

  test("a task tied to a DM shows to an administrator; the DM doesn't, not even through that task", async () => {
    const { ana, bia, adm } = await privateRoom();
    const dm = await openDm(f.db, ana.id, f.org.id, { userId: bia.id });
    const said = await postPersonMessage(deps(), ana.id, f.org.id, dm.id, { body: "Bug na DM" });
    const task = await createIssue(deps(), person(ana.id), f.org.id, { title: "Da DM", channelId: dm.id });
    expect(await seen(adm.id)).toEqual(["Da DM"]);
    const { issueFromMessage } = await import("../src");
    await expect(issueFromMessage(deps(), adm.id, f.org.id, said.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getIssue(f.db, person(adm.id), f.org.id, { id: task.id })).audience.userIds.sort()).toEqual(
      [ana.id, bia.id].sort(),
    );
  });

  test("search and Drive files of a private channel reach them; an administrator demoted loses them", async () => {
    const { adm, ana, bia, secret } = await privateRoom();
    await drainOutbox(f.db, f.handlers);
    const file = await createArtifact(f.artifactDeps, person(ana.id), f.org.id, {
      title: "Contrato",
      content: { kind: "document", markdown: "x" },
      channelId: secret.id,
    });
    const hits = async (userId: string) => searchForUser(f.context, userId, f.org.id, { text: "ACME" });
    expect(await hits(adm.id)).toHaveLength(1);
    expect(await hits(bia.id)).toEqual([]);
    expect((await getArtifact(f.artifactDeps, person(adm.id), f.org.id, file.id)).id).toBe(file.id);
    expect((await listArtifacts(f.db, person(adm.id), f.org.id)).some((a) => a.id === file.id)).toBe(true);
    await expect(getArtifact(f.artifactDeps, person(bia.id), f.org.id, file.id)).rejects.toThrow();

    await setMemberRoles(f.db, f.owner.id, f.org.id, adm.id, []);
    expect(await hits(adm.id)).toEqual([]);
    await expect(requireChannelAccess(f.db, adm.id, f.org.id, secret.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getArtifact(f.artifactDeps, person(adm.id), f.org.id, file.id)).rejects.toThrow();
    expect((await listChannels(f.db, adm.id, f.org.id)).some((c) => c.id === secret.id)).toBe(false);
  });

  test("a mention reaches an administrator outside the channel, and nobody else outside it", async () => {
    const { ana, bia, adm, secret } = await privateRoom();
    await f.db
      .update(schema.organizationMembers)
      .set({ handle: "adm" })
      .where(eq(schema.organizationMembers.userId, adm.id));
    await f.db
      .update(schema.organizationMembers)
      .set({ handle: "bia" })
      .where(eq(schema.organizationMembers.userId, bia.id));
    await postPersonMessage(deps(), ana.id, f.org.id, secret.id, { body: "@adm e @bia olhem isso" });
    await drainOutbox(f.db, f.handlers);
    expect((await listNotifications({ db: f.db }, adm.id, f.org.id)).items.length).toBeGreaterThan(0);
    expect((await listNotifications({ db: f.db }, bia.id, f.org.id)).items).toEqual([]);
  });
});

describe("a wiki page's audience", () => {
  test("anyone who edits it chooses, the same three options; administrators always see", async () => {
    const { ana, bia, adm } = await team();
    const open = await createWikiPage(deps(), person(ana.id), f.org.id, { title: "Guia", body: "Oi" });
    expect(open.audience).toBeNull();
    const limited = await setWikiPageAudience(deps(), ana.id, f.org.id, open.slug, { roleIds: [], userIds: [ana.id] });
    expect(limited.audience).toEqual({ roleIds: [], userIds: [ana.id] });
    await expect(getWikiPage(f.db, person(bia.id), f.org.id, open.slug)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getWikiPage(f.db, person(adm.id), f.org.id, open.slug)).id).toBe(open.id);
    expect((await listWikiPages(f.db, person(adm.id), f.org.id, {})).map((p) => p.id)).toContain(open.id);

    const mine = await createWikiPage(deps(), person(ana.id), f.org.id, {
      title: "Rascunho",
      body: "Oi",
      audience: only(bia.id),
    });
    expect(mine.audience?.userIds.sort()).toEqual([ana.id, bia.id].sort());
    await setWikiPageAudience(deps(), bia.id, f.org.id, mine.slug, null);
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, mine.slug)).audience).toBeNull();
  });

  test("choosing agents or editors still takes managing roles", async () => {
    const { ana } = await team();
    const page = await createWikiPage(deps(), person(ana.id), f.org.id, { title: "Guia", body: "Oi" });
    await expect(setWikiPageAudience(deps(), ana.id, f.org.id, page.slug, null, [])).rejects.toMatchObject({
      code: "wiki.audience_forbidden",
    });
  });

  test("an agent's page takes the conversation's people, and says so", async () => {
    await team();
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
    const answer = await (await toolsIn(dm.id))("create_wiki_page", { title: "Da DM", body: "Texto" });
    expect(answer).toMatchObject({ output: { content: expect.stringContaining("only the people chosen") } });
    const page = await getWikiPage(f.db, person(f.owner.id), f.org.id, "da-dm");
    expect(page.audience?.userIds).toEqual([f.owner.id]);
  });
});

describe("the audit log", () => {
  test("a title shows to who sees it: administrators always; view_audit alone shows the row without it", async () => {
    const { ana, adm } = await team();
    const role = await createRole(f.db, f.owner.id, f.org.id, { name: "Auditoria", permissions: ["view_audit"] });
    const auditor = await addMember(f.db, f.org.id, "member", "auditor");
    await setMemberRoles(f.db, f.owner.id, f.org.id, auditor.id, [role.id]);
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    await (await toolsIn(secret.id))("create_issue", { title: "Demissão da Bia" });
    await (await toolsIn(f.general.id))("create_issue", { title: "Onboarding" });
    const page = await createWikiPage(deps(), person(ana.id), f.org.id, {
      title: "Plano secreto",
      body: "x",
      audience: only(ana.id),
    });
    await createWikiPage(deps(), person(ana.id), f.org.id, { title: "Guia aberto", body: "x" });

    const text = async (userId: string) => JSON.stringify((await listAudit(f.db, userId, f.org.id)).rows);
    for (const id of [adm.id, f.owner.id]) {
      expect(await text(id)).toContain("Demissão da Bia");
      expect(await text(id)).toContain("Plano secreto");
    }
    const seenByAuditor = await listAudit(f.db, auditor.id, f.org.id);
    const asText = JSON.stringify(seenByAuditor.rows);
    expect(asText).not.toContain("Demissão da Bia");
    expect(asText).not.toContain("Plano secreto");
    expect(asText).not.toContain(page.slug);
    expect(asText).toContain("Onboarding");
    expect(asText).toContain("Guia aberto");
    expect(seenByAuditor.rows.some((r) => r.action === "wiki.page_created" && r.target.id === page.id)).toBe(true);
    await expect(listAudit(f.db, ana.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

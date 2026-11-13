import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

test("issues API: create, by number, patch, criteria, comments, activity, ask agent, from a message", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/issues", { json: { title: "Login quebra", criteria: ["Funciona no Safari"] } });
  expect(created.status).toBe(201);
  const issue = (await created.json()) as { id: string; number: number; criteria: { id: string }[] };
  expect(issue.number).toBe(1);
  expect(await (await api("/issues/by-number/1")).json()).toMatchObject({ id: issue.id, title: "Login quebra" });
  expect(
    await (await api(`/issues/${issue.id}`, { method: "PATCH", json: { status: "in_progress" } })).json(),
  ).toMatchObject({
    status: "in_progress",
  });
  const githubUrl = "https://github.com/acme/app/issues/12";
  const linked = await api(`/issues/${issue.id}`, { method: "PATCH", json: { githubUrl } });
  expect(await linked.json()).toMatchObject({ githubUrl });
  const notGithub = { githubUrl: "https://example.org/a/b/issues/1" };
  expect((await api(`/issues/${issue.id}`, { method: "PATCH", json: notGithub })).status).toBe(400);
  const unlinked = await api(`/issues/${issue.id}`, { method: "PATCH", json: { githubUrl: null } });
  expect(await unlinked.json()).toMatchObject({ githubUrl: null });
  const criterion = await api(`/issues/${issue.id}/criteria/${issue.criteria[0]?.id}`, {
    method: "PUT",
    json: { done: true },
  });
  expect(((await criterion.json()) as { criteria: { done: boolean }[] }).criteria[0]?.done).toBe(true);
  expect((await api(`/issues/${issue.id}/comments`, { json: { text: "Olhando" } })).status).toBe(201);

  const asked = await api(`/issues/${issue.id}/ask-agent`, { json: { agentId } });
  expect(await asked.json()).toMatchObject({ assignee: { type: "agent", id: agentId } });
  await t.drain();
  const activity = (await (await api(`/issues/${issue.id}/activity`)).json()) as {
    activity: { kind: string; event?: string; author: { type: string }; text: string }[];
  };
  // Comments are the task's conversation now (ADR 0145): the activity keeps its events.
  expect(activity.activity.map((a) => a.event ?? a.kind)).toEqual([
    "created",
    "status_changed",
    "github_link",
    "github_link",
    "criterion_checked",
    "assigned",
    "agent_asked",
  ]);

  // The conversation: opened once (the same thread again), read and written through the chat's own routes.
  const at = (await (await api(`/issues/${issue.id}/conversation`, { json: {} })).json()) as {
    channelId: string;
    rootId: string;
  };
  expect(await (await api(`/issues/${issue.id}/conversation`, { json: {} })).json()).toEqual(at);
  const read = await api(`/channels/${at.channelId}/messages?threadId=${at.rootId}`);
  const thread = (await read.json()) as {
    messages: { author: { type: string }; body: string; meta: Record<string, unknown> }[];
  };
  // The root stands for the task (never drawn); the replies are the conversation.
  expect(thread.messages.filter((m) => !m.meta.taskConversation).map((m) => [m.author.type, m.body])).toEqual([
    ["person", "Olhando"],
    ["person", "Please implement issue #1."],
    ["agent", "Feito."],
  ]);
  const posted = await api(`/channels/${at.channelId}/messages`, { json: { body: "Valeu", threadId: at.rootId } });
  expect(posted.status).toBe(201);
  const card = (await (await api(`/issues/${issue.id}`)).json()) as {
    conversation: { channelId: string; count: number; participants: { type: string }[]; working: boolean };
  };
  expect(card.conversation).toMatchObject({ channelId: at.channelId, count: 4, working: false });
  expect(card.conversation.participants.map((p) => p.type)).toEqual(["person", "agent"]);
  // The agent's reply is unread for the task's creator, who follows its conversation, until they read the thread.
  expect(await (await api("/unread-tasks")).json()).toEqual({ tasks: [{ issueId: issue.id, unread: 1, mentions: 0 }] });
  expect((await api(`/threads/${at.rootId}/read`, { json: {} })).status).toBe(204);
  expect(await (await api("/unread-tasks")).json()).toEqual({ tasks: [] });

  const message = (await (
    await api(`/channels/${channelId}/messages`, { json: { body: "Bug no checkout" } })
  ).json()) as {
    id: string;
  };
  const fromMessage = await api(`/messages/${message.id}/issue`, { json: {} });
  expect(await fromMessage.json()).toMatchObject({ number: 2, title: "Bug no checkout", source: { type: "message" } });
  const list = (await (await api("/issues")).json()) as { issues: { number: number }[] };
  expect(list.issues.map((i) => i.number).sort()).toEqual([1, 2]);
});

test("board columns API: list, add, rename, move a task, delete with a destination", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  type Columns = { columns: { id: string; stage: string; name: string | null }[] };

  const start = (await (await api("/issue-columns")).json()) as Columns;
  expect(start.columns.map((c) => c.stage)).toEqual(["todo", "in_progress", "in_review", "done", "canceled"]);
  const added = await api("/issue-columns", { json: { name: "QA", stage: "in_review" } });
  expect(added.status).toBe(201);
  const qa = ((await added.json()) as Columns).columns.find((c) => c.name === "QA");
  if (!qa) throw new Error("QA column missing");
  const renamed = (await (
    await api(`/issue-columns/${qa.id}`, { method: "PATCH", json: { name: "Conferir" } })
  ).json()) as Columns;
  expect(renamed.columns.find((c) => c.id === qa.id)?.name).toBe("Conferir");

  const issue = (await (await api("/issues", { json: { title: "Relatório" } })).json()) as { id: string };
  const moved = await api(`/issues/${issue.id}`, { method: "PATCH", json: { columnId: qa.id } });
  expect(await moved.json()).toMatchObject({ status: "in_review", columnId: qa.id });

  const done = start.columns.find((c) => c.stage === "done");
  const deleted = await api(`/issue-columns/${qa.id}?moveTo=${done?.id}`, { method: "DELETE" });
  expect(deleted.status).toBe(200);
  expect(await (await api(`/issues/${issue.id}`)).json()).toMatchObject({ status: "done", columnId: done?.id });
});

test("deleting a task: 204, gone from the list and its address; a member who didn't create it is refused", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = (await (await api("/issues", { json: { title: "Sobrou" } })).json()) as { id: string };
  const deleted = await api(`/issues/${created.id}`, { method: "DELETE" });
  expect(deleted.status).toBe(204);
  expect((await api("/issues/by-number/1")).status).toBe(404);
  expect(await (await api("/issues")).json()).toMatchObject({ issues: [] });
  expect((await api(`/issues/${created.id}`, { method: "DELETE" })).status).toBe(404);
});

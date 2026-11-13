import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { OVER_BUDGET_REASON, proposeChange, proposeSettings, WAITING_GROUP } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("knowledge API: search, context items (add, pin, edit), reactions, correction → lesson, proposals", async () => {
  t = await createTestServer({ embeddings: true, reply: () => ({ chunks: ["Builds run on Jenkins."] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  await api(`/channels/${channelId}/messages`, { json: { body: "@dev where do builds run?" } });
  await t.drain();
  const search = (await (await api("/search?q=builds%20run")).json()) as {
    hits: { kind: string; snippet: string; messageId: string | null; threadId: string | null; author: unknown }[];
  };
  expect(search.hits.map((h) => h.snippet)).toContain("Builds run on Jenkins.");
  // Message hits say where they are and who wrote them.
  const replyHit = search.hits.find((h) => h.snippet === "Builds run on Jenkins.");
  expect(replyHit).toMatchObject({ kind: "message", author: { type: "agent", id: agentId, name: "Dev" } });
  expect(replyHit?.messageId).toBeTruthy();
  // Asked in the channel: the reply is in the main timeline.
  expect(replyHit?.threadId).toBeNull();
  // Filters (ADR 0123): no words needed; a channel the person can't read finds nothing; bad ids are refused.
  const filtered = (await (await api(`/search?fromAgents=${agentId}&author=agent&sort=newest`)).json()) as {
    hits: { snippet: string }[];
  };
  expect(filtered.hits.map((h) => h.snippet)).toEqual(["Builds run on Jenkins."]);
  const linked = (await (await api(`/search?q=builds&in=${channelId}&has=link,nonsense`)).json()) as {
    hits: unknown[];
  };
  expect(linked.hits).toEqual([]);
  const elsewhere = (await (await api(`/search?q=builds&in=${crypto.randomUUID()}`)).json()) as { hits: unknown[] };
  expect(elsewhere.hits).toEqual([]);
  expect((await api("/search?fromAgents=not-an-id")).status).toBe(400);

  const created = await api("/context-items", { json: { kind: "fact", content: "Our CI is Buildkite", pinned: true } });
  expect(created.status).toBe(201);
  const item = (await created.json()) as { id: string; verified: boolean; evidence: { type: string }[] };
  expect(item.evidence.map((e) => e.type)).toEqual(["human"]);
  expect(
    (await api("/context-items", { json: { kind: "fact", content: "token: ghp_abcdefghijklmnopqrstuvwxyz12" } }))
      .status,
  ).toBe(400);
  const edited = (await (
    await api(`/context-items/${item.id}`, { method: "PATCH", json: { content: "Our CI is Buildkite (since May)" } })
  ).json()) as { version: number; id: string };
  expect(edited.version).toBe(2);
  const list = (await (await api("/context-items?kinds=fact")).json()) as { items: { content: string }[] };
  expect(list.items.map((i) => i.content)).toEqual(["Our CI is Buildkite (since May)"]);

  const [reply] = (await t.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
  const reacted = (await (await api(`/messages/${reply?.id}/reactions`, { json: { reaction: "-1" } })).json()) as {
    reactions: { reaction: string; count: number }[];
  };
  expect(reacted.reactions).toEqual([expect.objectContaining({ reaction: "-1", count: 1 })]);
  const lesson = await api(`/messages/${reply?.id}/correction`, { json: { body: "We use Buildkite, not Jenkins." } });
  expect(lesson.status).toBe(201);
  const memory = (await (await api(`/context-items?agentId=${agentId}`)).json()) as {
    items: { kind: string; verified: boolean }[];
  };
  expect(memory.items).toEqual([expect.objectContaining({ kind: "lesson", verified: true })]);

  const memories = (await (await api(`/agents/${agentId}/memories`)).json()) as {
    memories: { id: string; kind: string; text: string; source: string; lowTrust: boolean; archived: boolean }[];
  };
  expect(memories.memories).toEqual([
    expect.objectContaining({
      kind: "lesson",
      text: expect.stringContaining("We use Buildkite"),
      lowTrust: false,
      archived: false,
    }),
  ]);
  expect(memories.memories[0]?.source).toContain("Written by owner in #general");
  const pinned = (await (
    await api(`/memories/${memories.memories[0]?.id}`, {
      method: "PATCH",
      json: { pinned: true, text: "Builds: Buildkite." },
    })
  ).json()) as { pinned: boolean; text: string; supersedes: string | null };
  expect(pinned).toMatchObject({ pinned: true, text: "Builds: Buildkite." });
  expect(pinned.supersedes).toContain("We use Buildkite");

  // A recurring verified lesson → proposal (the web app's shape) → accept with adjusted text.
  await t.db
    .update(schema.contextItems)
    .set({ recurrence: 2, proposedAt: null })
    .where(eq(schema.contextItems.kind, "lesson"));
  await t.engine.handlers["context.consolidate"]?.({ orgId } as never, { finalAttempt: false });
  const proposals = (await (await api("/proposals?status=pending")).json()) as {
    proposals: {
      id: string;
      title: string;
      before: string;
      after: string;
      decider: { type: string };
      canDecide: boolean;
    }[];
  };
  expect(proposals.proposals).toHaveLength(1);
  expect(proposals.proposals[0]).toMatchObject({
    title: "Update Dev's instructions",
    proposedByAgentId: agentId,
    access: null,
    before: "",
    decider: { type: "user" },
    canDecide: true,
  });
  expect(proposals.proposals[0]?.after).toContain("Builds: Buildkite.");
  const accepted = (await (
    await api(`/proposals/${proposals.proposals[0]?.id}/accept`, { json: { text: "Our CI is Buildkite." } })
  ).json()) as { status: string; after: string };
  expect(accepted).toMatchObject({ status: "accepted", after: "Our CI is Buildkite." });
  const agent = (await (await api(`/agents/${agentId}`)).json()) as { instructions: string };
  expect(agent.instructions).toBe("Our CI is Buildkite.");
  expect((await api("/search/reindex", { json: {} })).status).toBe(202);
});

test("proposals an agent made for a teammate name it and say what they change: instructions, role, apps", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const ada = (await (
    await api("/agents", {
      json: { name: "Ada", handle: "ada", role: "Dev", instructions: "Seja breve.", model: "claude-sonnet-5-5" },
    })
  ).json()) as { id: string };
  const [me] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
  await proposeChange(
    { db: t.db },
    {
      orgId,
      agentId,
      target: "agent_instructions",
      agentIds: [ada.id],
      change: "Responder em português.",
      roles: [{ agentId: ada.id, role: "Revisora" }],
      access: [{ agentId: ada.id, lines: [{ id: "calendar:write", label: "Propose events", on: true }] }],
      rationale: "",
      requesterId: me?.id ?? "",
    },
  );
  type View = { id: string; target: { type: string }; [key: string]: unknown };
  const { proposals } = (await (await api("/proposals?status=pending")).json()) as { proposals: View[] };
  const of = (type: string) => proposals.find((p) => p.target.type === type) as View;
  expect(of("agent_instructions")).toMatchObject({
    agentId: ada.id,
    proposedByAgentId: agentId,
    target: { agentId: ada.id },
    access: null,
    decider: { type: "user" },
  });
  expect(of("agent_role")).toMatchObject({
    title: "Change Ada's role",
    proposedByAgentId: agentId,
    before: "Dev",
    after: "Revisora",
    decider: { type: "admins" },
    canDecide: true,
  });
  expect(of("agent_access")).toMatchObject({
    title: "Change Ada's access",
    access: [{ id: "calendar:write", label: "Propose events", on: true }],
    before: "",
    decider: { type: "admins" },
  });
  // A role is taken as proposed or refused: only instructions and the org context are edited first.
  expect((await api(`/proposals/${of("agent_role").id}/accept`, { json: { text: "Outra" } })).status).toBe(400);
  const role = await api(`/proposals/${of("agent_role").id}/accept`, { json: {} });
  expect(await role.json()).toMatchObject({ status: "accepted", after: "Revisora" });
  expect(((await (await api(`/agents/${ada.id}`)).json()) as { role: string }).role).toBe("Revisora");
});

test("a card's rows are read by id, and deciding one answers with it however many came after", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const [me] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
  const {
    proposals: [mine],
  } = await proposeChange(
    { db: t.db },
    {
      orgId,
      agentId,
      target: "agent_instructions",
      change: "Responder em português.",
      rationale: "",
      requesterId: me?.id ?? "",
    },
  );
  const id = mine?.id ?? "";
  // 200 newer ones, still waiting: the whole of the list.
  await t.db.insert(schema.contextProposals).values(
    Array.from({ length: 200 }, (_, i) => ({
      orgId,
      target: "org_context" as const,
      baseHash: "x",
      proposedText: `v${i}`,
      diff: "",
      rationale: "",
      createdAt: new Date(Date.now() + 1000 + i),
    })),
  );
  const card = (await (await api(`/proposals?ids=${id},not-an-id`)).json()) as { proposals: { id: string }[] };
  expect(card.proposals.map((p) => p.id)).toEqual([id]);
  const accepted = await api(`/proposals/${id}/accept`, { json: {} });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ id, status: "accepted" });
});

test("a settings row a member can't decide: only they send it, once, and not once decided (ADR 0137)", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const [bia] = await t.db.select().from(schema.users).where(eq(schema.users.email, "bia@example.com"));
  const {
    proposals: [row],
  } = await proposeSettings(
    { db: t.db },
    {
      orgId,
      agentId,
      targets: [{ agentId, lines: [{ field: "budget", to: 20_000_000_000 }] }],
      rationale: "mais folga",
      requesterId: bia?.id ?? "",
    },
  );
  const id = row?.id ?? "";
  const as = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const seen = (await (await as(member)(`/proposals?ids=${id}`)).json()) as { proposals: Record<string, unknown>[] };
  expect(seen.proposals[0]).toMatchObject({
    target: { type: "agent_settings", agentId },
    settings: [{ field: "budget", from: 50_000_000_000, to: 20_000_000_000 }],
    requestedBy: { userId: bia?.id },
    askedAt: null,
    canDecide: false,
    decider: { type: "admins" },
    undoActionId: null,
  });
  expect((await as(owner)(`/proposals/${id}/ask`, { json: {} })).status).toBe(403);
  const asked = await as(member)(`/proposals/${id}/ask`, { json: {} });
  expect(asked.status).toBe(200);
  expect(((await asked.json()) as { askedAt: string | null }).askedAt).toBeString();
  expect((await as(member)(`/proposals/${id}/ask`, { json: {} })).status).toBe(409);
  expect((await as(owner)(`/proposals/${id}/accept`, { json: {} })).status).toBe(200);
  expect((await as(member)(`/proposals/${id}/ask`, { json: {} })).status).toBe(409);
});

test("the server's own lessons reach people without their template, a proposal's reason included", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string) => owner(`/api/app/organizations/${orgId}${path}`);
  const [item] = await t.db
    .insert(schema.contextItems)
    .values({
      orgId,
      kind: "lesson",
      scopeType: "agent",
      scopeId: agentId,
      agentId,
      subjectKey: "refused",
      title: "",
      content: "A person refused this change; don't propose it again: ## Learned - Remover o sistema antigo.",
      evidence: [{ type: "human", ref: "x", at: new Date().toISOString() }],
    })
    .returning();
  const [row] = await t.db
    .insert(schema.contextProposals)
    .values({
      orgId,
      target: "agent_instructions",
      agentId,
      baseHash: "x",
      proposedText: "",
      diff: "",
      rationale: "Seen 2× (confidence 0.90, evidence: human).",
      itemIds: [item?.id ?? ""],
    })
    .returning();
  const reasons = async () =>
    (
      (await (await api("/proposals")).json()) as {
        proposals: { why: string; whyCode: string | null; evidence: { what: string }[] }[];
      }
    ).proposals;
  expect(await reasons()).toMatchObject([
    { why: "Remover o sistema antigo.", whyCode: "refused", evidence: [{ what: "Remover o sistema antigo." }] },
  ]);
  const memories = (await (await api(`/agents/${agentId}/memories`)).json()) as {
    memories: { text: string; how: string | null }[];
  };
  expect(memories.memories).toMatchObject([{ text: "Remover o sistema antigo.", how: "refused" }]);

  // Its memory gone: the code, never the line written for the logs.
  await t.db
    .update(schema.contextProposals)
    .set({ itemIds: [crypto.randomUUID()] })
    .where(eq(schema.contextProposals.id, row?.id ?? ""));
  expect(await reasons()).toMatchObject([{ why: "", whyCode: "seen", evidence: [] }]);
});

test("the team week's reasons reach people as codes, and the list ends an inbox row with nothing left to decide", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string) => owner(`/api/app/organizations/${orgId}${path}`);
  const [me] = await t.db.select().from(schema.organizationMembers).where(eq(schema.organizationMembers.orgId, orgId));
  const [row] = await t.db
    .insert(schema.contextProposals)
    .values({
      orgId,
      target: "agent_settings",
      agentId,
      baseHash: "x",
      proposedText: "",
      diff: "",
      settings: [],
      requestedByUserId: me?.userId ?? "",
      rationale: OVER_BUDGET_REASON,
    })
    .returning();
  const list = async () =>
    ((await (await api("/proposals")).json()) as { proposals: { why: string; whyCode: string | null }[] }).proposals;
  expect(await list()).toMatchObject([{ why: "", whyCode: "budget" }]);

  await t.db.insert(schema.notifications).values({
    orgId,
    userId: me?.userId ?? "",
    kind: "proposal_waiting",
    waiting: true,
    groupKey: WAITING_GROUP,
  });
  const open = async () =>
    (await t.db.select().from(schema.notifications).where(eq(schema.notifications.groupKey, WAITING_GROUP))).filter(
      (n) => n.doneAt === null,
    );
  await list();
  expect(await open()).toHaveLength(1);
  await t.db
    .update(schema.contextProposals)
    .set({ status: "stale" })
    .where(eq(schema.contextProposals.id, row?.id ?? ""));
  await list();
  expect(await open()).toEqual([]);
});

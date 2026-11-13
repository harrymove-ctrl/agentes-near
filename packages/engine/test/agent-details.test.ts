import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  consolidateItem,
  createRole,
  decideProposal,
  drainOutbox,
  listContextItems,
  listOrgMemoryRows,
  listProposals,
  searchForUser,
  setMemberRoles,
  sha256,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const answers = (f: Fixture, mode: "owner" | "everyone") =>
  f.db.update(schema.agents).set({ audienceMode: mode }).where(eq(schema.agents.id, f.agent.id));

test("an agent's memory and proposed instructions only for who sees how it works; the workspace's context only for admins", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await answers(f, "owner");
  const lesson = await consolidateItem(f.db, {
    orgId: f.org.id,
    kind: "lesson",
    scopeType: "agent",
    agentId: f.agent.id,
    channelIds: [],
    content: "Ping QA before merging.",
    evidence: [{ type: "human", ref: "x", at: "" }],
    confidence: 0.9,
  });
  const proposal = (base: { target: "agent_instructions" | "org_context"; agentId: string | null }) => ({
    ...base,
    orgId: f.org.id,
    baseHash: "x",
    proposedText: "Answer briefly.",
    diff: "+ Answer briefly.",
    rationale: "Seen 2×.",
    itemIds: [],
  });
  const [forAgent] = await f.db
    .insert(schema.contextProposals)
    .values(proposal({ target: "agent_instructions", agentId: f.agent.id }))
    .returning();
  const [forOrg] = await f.db
    .insert(schema.contextProposals)
    .values(proposal({ target: "org_context", agentId: null }))
    .returning();

  expect((await listOrgMemoryRows(f.db, bia.id, f.org.id)).items).toEqual([]);
  expect(await listProposals(f.db, bia.id, f.org.id)).toEqual([]);
  // Admins see all of it.
  expect((await listOrgMemoryRows(f.db, f.owner.id, f.org.id)).items.map((i) => i.id)).toEqual([lesson.item.id]);
  expect((await listProposals(f.db, f.owner.id, f.org.id)).map((p) => p.id).sort()).toEqual(
    [forAgent?.id ?? "", forOrg?.id ?? ""].sort(),
  );

  // Once it answers her: its memory and proposals, never the workspace's context.
  await answers(f, "everyone");
  expect((await listOrgMemoryRows(f.db, bia.id, f.org.id)).items.map((i) => i.id)).toEqual([lesson.item.id]);
  expect((await listProposals(f.db, bia.id, f.org.id)).map((p) => p.id)).toEqual([forAgent?.id ?? ""]);
});

test("an agent's memory stays hidden from its list and from search; a person's preferences stay theirs", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await answers(f, "owner");
  const item = (content: string, scope: { scopeType: "agent" | "person"; agentId: string | null; scopeId?: string }) =>
    consolidateItem(f.db, {
      orgId: f.org.id,
      kind: "lesson",
      ...scope,
      channelIds: [],
      content,
      evidence: [{ type: "human", ref: "x", at: "" }],
      confidence: 0.9,
    });
  const lesson = await item("Customer Acme pays late.", { scopeType: "agent", agentId: f.agent.id });
  await item("Owner wants a summary when invoices are late.", {
    scopeType: "person",
    agentId: null,
    scopeId: f.owner.id,
  });
  await drainOutbox(f.db, f.handlers);
  const deps = { db: f.db, search: f.search, gateway: f.gateway };
  const found = async (userId: string) =>
    (await searchForUser(deps, userId, f.org.id, { text: "late" })).filter((h) => h.kind === "context_item").length;

  expect(await listContextItems(f.db, bia.id, f.org.id, { agentId: f.agent.id })).toEqual([]);
  expect(await listContextItems(f.db, bia.id, f.org.id)).toEqual([]);
  expect(await found(bia.id)).toBe(0);
  expect((await listContextItems(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).map((i) => i.id)).toEqual([
    lesson.item.id,
  ]);
  expect(await found(f.owner.id)).toBe(2);

  await answers(f, "everyone");
  expect((await listContextItems(f.db, bia.id, f.org.id)).map((i) => i.id)).toEqual([lesson.item.id]);
  expect(await found(bia.id)).toBe(1);
});

test("reviewing memory without configuring the workspace neither lists nor decides its context's proposals", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const reviewers = await createRole(f.db, f.owner.id, f.org.id, { name: "Revisores", permissions: ["review_memory"] });
  await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [reviewers.id]);
  const [forOrg] = await f.db
    .insert(schema.contextProposals)
    .values({
      orgId: f.org.id,
      target: "org_context",
      agentId: null,
      baseHash: sha256(f.org.context),
      proposedText: "Answer briefly.",
      diff: "+ Answer briefly.",
      rationale: "Seen 2×.",
      itemIds: [],
    })
    .returning();
  if (!forOrg) throw new Error("expected a proposal");
  expect(await listProposals(f.db, bia.id, f.org.id)).toEqual([]);
  await expect(decideProposal(f.db, bia.id, f.org.id, forOrg.id, "reject")).rejects.toThrow();
  expect((await listProposals(f.db, f.owner.id, f.org.id)).map((p) => p.canDecide)).toEqual([true]);
});

test("an agent's playbook stays out of a plain member's list and search, even one it answers", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await answers(f, "everyone");
  const lesson = await consolidateItem(f.db, {
    orgId: f.org.id,
    kind: "lesson",
    scopeType: "agent",
    agentId: f.agent.id,
    channelIds: [],
    content: "Run the database push before the deploy.",
    evidence: [{ type: "self", ref: "x", agentId: f.agent.id, at: "" }],
    confidence: 0.8,
    createdByKind: "agent",
    createdById: f.agent.id,
  });
  await drainOutbox(f.db, f.handlers);
  const deps = { db: f.db, search: f.search, gateway: f.gateway };
  const found = async (userId: string) =>
    (await searchForUser(deps, userId, f.org.id, { text: "deploy" })).filter((h) => h.kind === "context_item").length;

  expect(await listContextItems(f.db, bia.id, f.org.id, { agentId: f.agent.id })).toEqual([]);
  expect(await found(bia.id)).toBe(0);
  expect((await listContextItems(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).map((i) => i.id)).toEqual([
    lesson.item.id,
  ]);
  expect(await found(f.owner.id)).toBe(1);
});

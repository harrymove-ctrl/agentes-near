import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, ne, schema } from "@agenteschat/db";
import {
  decideProposal,
  getAgentBrain,
  insertMessage,
  listMachineAccounts,
  MACHINE_CONTROL_TOPIC,
  type MachineStatus,
  machineAgents,
  makeDefaultCredential,
  openPersonAgentDm,
  PLAN_LENT_JOB,
  postPersonMessage,
  queuePlanLent,
  RIGHT_HAND,
  releaseMemberAccounts,
  resolveBrain,
  runAuthority,
  setAgentBrain,
  sha256,
  takeBackPlan,
} from "../src";
import { agentAiState, orgAiStatus, orgHasAi } from "../src/ai-status";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/*
 * ADR 0137 §11: each person's DM with the team's right hand thinks with that person's own AI (their plan, or one given
 * to them with `use_others_plans`), else with the workspace's; nobody's plan serves someone else unless they allow it.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ANAS = "0193eeee-0000-4000-8000-0000000000a1";
const BIAS = "0193eeee-0000-4000-8000-0000000000b1";
const CAIOS = "0193eeee-0000-4000-8000-0000000000c1";

const statusOf = (id: string): MachineStatus => ({
  id,
  orgId: "org",
  name: "Mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
});
const machines = { status: async (id: string) => statusOf(id) };

async function world() {
  const fx = await setup({ rightHand: true });
  f = fx;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  await fx.db
    .update(schema.machines)
    .set({
      pairedByUserId: null,
      executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
    })
    .where(eq(schema.machines.id, machineId));
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  const account = (id: string, createdBy: string) =>
    fx.db.insert(schema.machineAccounts).values({
      id,
      orgId: fx.org.id,
      machineId,
      kind: "claude_code",
      label: id,
      status: "active",
      createdBy,
      shared: true,
    });
  await account(ANAS, fx.owner.id);
  await account(BIAS, bia.id);
  await account(CAIOS, caio.id);
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  // One run per person: a second message in a DM with a run open joins it.
  const opened = new Map<string, { run: typeof schema.agentRuns.$inferSelect; dm: { id: string } }>();
  const runIn = async (userId: string) => {
    let open = opened.get(userId);
    if (!open) {
      const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
      const m = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body: "oi" });
      const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, m.id));
      if (!run) throw new Error("no run");
      open = { run, dm };
      opened.set(userId, open);
    }
    const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
    if (!agent) throw new Error("no right hand");
    return resolveBrain({ db: fx.db, machines }, agent, open.run, open.dm.id);
  };
  return { fx, deps: { db: fx.db }, machineId, bia, caio, lodi, runIn };
}

const codeOf = (p: Promise<unknown>) => p.then(() => null).catch((e: { code?: string }) => e.code);

test("a member gives their own DM with Lodi their plan; everyone else keeps the workspace's", async () => {
  const { fx, deps, machineId, bia, caio, lodi, runIn } = await world();
  const before = await getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "mine");
  expect(before).toMatchObject({
    scope: "mine",
    brain: "model",
    canUsePlans: true,
    workspaceAi: { brain: "model", ownerId: null, servesYou: true },
  });
  // Her own plans only: Ana's and Caio's aren't hers to give.
  expect(before.accounts.map((a) => a.id)).toEqual([BIAS]);
  const view = await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, {
    scope: "mine",
    brain: "claude_code",
    account: BIAS,
  });
  expect(view).toMatchObject({ scope: "mine", brain: "claude_code", account: BIAS, computer: { machineId } });
  // The workspace's AI didn't move, and members still can't see it.
  const [row] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
  expect(row).toMatchObject({ brain: "model", brainAccountId: null });
  expect(await codeOf(getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "workspace"))).toBe("agent.not_owner");
  expect(await runIn(bia.id)).toMatchObject({ kind: "claude_code", account: { id: BIAS }, session: { machineId } });
  expect((await runIn(fx.owner.id)).kind).toBe("model");
  // Her computer's frame lends Lodi's user her sign-in.
  const frame = (await machineAgents(fx.db, fx.org.id, machineId)).find((a) => a.id === lodi.id);
  expect(frame?.account).toBe(BIAS);
  // Two people's plans on one computer: its user keeps both.
  await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: CAIOS });
  const both = (await machineAgents(fx.db, fx.org.id, machineId)).find((a) => a.id === lodi.id);
  expect([both?.account, ...(both?.accounts ?? [])].sort()).toEqual([BIAS, CAIOS].sort());
  // Back to the workspace's.
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "model" });
  expect((await runIn(bia.id)).kind).toBe("model");
  expect((await fx.db.select().from(schema.rightHandBrains)).map((r) => r.userId)).toEqual([caio.id]);
});

test("someone else's plan: only with use_others_plans, its owner hears it and takes it back", async () => {
  const { fx, deps, bia, caio, lodi, runIn } = await world();
  expect(
    await codeOf(
      setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: ANAS }),
    ),
  ).toBe("account.not_owner");
  // Caio, an admin, may: Ana's plan serves him though she never opened it to others.
  await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: ANAS });
  const plan = await runIn(caio.id);
  expect(plan).toMatchObject({ kind: "claude_code", account: { id: ANAS } });
  expect(plan.unavailable).toBeUndefined();
  const jobs = await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, PLAN_LENT_JOB));
  expect(jobs.map((j) => j.payload)).toContainEqual({ agentId: lodi.id, accountId: ANAS, actorId: caio.id });
  // She hears it though the agent's own row never had her plan.
  await queuePlanLent({ db: fx.db, pubsub: fx.pubsub }, null, fx.org.id, "job-1", {
    agentId: lodi.id,
    accountId: ANAS,
    actorId: caio.id,
  });
  const notes = await fx.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "plan_lent"));
  expect(notes.map((n) => n.userId)).toEqual([fx.owner.id]);
  await takeBackPlan(deps, fx.owner.id, fx.org.id, ANAS);
  expect((await runIn(caio.id)).kind).toBe("model");
});

test("the workspace's plan serves only its owner until they open it; the AI status says so per person", async () => {
  const { fx, deps, bia, lodi, runIn } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { brain: "claude_code", account: ANAS });
  expect(await getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "mine")).toMatchObject({
    workspaceAi: { brain: "claude_code", ownerId: fx.owner.id, servesYou: false },
  });
  expect((await runIn(bia.id)).unavailable).toMatchObject({ code: "plan_not_shared" });
  const status = { db: fx.db, gateway: fx.gateway, machines };
  const of = async (viewer: string) =>
    (await orgAiStatus(status, fx.org.id, viewer)).agents.find((a) => a.agentId === lodi.id);
  expect(await of(bia.id)).toMatchObject({ state: "no_ai", reason: "plan_not_shared" });
  expect(await of(fx.owner.id)).toMatchObject({ state: "ready" });
  // Her own plan answers her whatever the workspace's does.
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  expect(await of(bia.id)).toMatchObject({ state: "ready" });
  expect((await runIn(bia.id)).unavailable).toBeUndefined();
  // Opened to everyone, the workspace's serves whoever has none.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { onlyOwner: false });
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, lodi.id));
  if (!agent) throw new Error("no right hand");
  const caio = await addMember(fx.db, fx.org.id, "member", "dani");
  expect(await agentAiState(status, agent, undefined, caio.id)).toMatchObject({ state: "ready" });
});

test("a decision on its card wakes it for the person behind the card's run, on that person's own plan", async () => {
  const { fx, deps, bia, lodi: helper } = await world();
  // The workspace's AI is the owner's plan, for the owner alone; the member has a plan of her own.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, helper.id, { brain: "claude_code", account: ANAS });
  await setAgentBrain(deps, bia.id, fx.org.id, helper.id, { scope: "mine", brain: "claude_code", account: BIAS });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, bia.id, helper.id);
  const asked = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, bia.id, fx.org.id, dm.id, {
    body: "anota no contexto que respondemos em inglês",
  });
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
  if (!run) throw new Error("no run");
  // Its run proposed a change to the workspace's context there, showed the card and ended.
  const [org] = await fx.db.select().from(schema.organizations).where(eq(schema.organizations.id, fx.org.id));
  const context = org?.context ?? "";
  const [proposal] = await fx.db
    .insert(schema.contextProposals)
    .values({
      orgId: fx.org.id,
      target: "org_context",
      proposedByAgentId: helper.id,
      requestedByUserId: bia.id,
      baseHash: sha256(context),
      proposedText: `${context}\n- Respondemos em inglês.`,
      diff: "+- Respondemos em inglês.",
      rationale: "Pedido no DM.",
    })
    .returning();
  if (!proposal) throw new Error("no proposal");
  await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: dm.id,
    author: { type: "agent", agentId: helper.id, runId: run.id, hop: run.hop },
    body: "Propus.",
    meta: { memoryUpdates: [{ action: "proposed", proposalId: proposal.id, proposalIds: [proposal.id], text: "x" }] },
  });
  await fx.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  await decideProposal(fx.db, fx.owner.id, fx.org.id, proposal.id, "accept", { pubsub: fx.pubsub });
  const [next] = await fx.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.agentId, helper.id), ne(schema.agentRuns.id, run.id)));
  if (!next) throw new Error("it wasn't told");
  expect(await runAuthority(fx.db, next)).toEqual({ kind: "person", personId: bia.id });
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, helper.id));
  if (!agent) throw new Error("no right hand");
  const plan = await resolveBrain({ db: fx.db, machines }, agent, next, dm.id);
  expect(plan).toMatchObject({ kind: "claude_code", account: { id: BIAS } });
  expect(plan.unavailable).toBeUndefined();
});

test("a person's plan on Lodi is an AI of the workspace, though Lodi's own row has none", async () => {
  const { fx, deps, bia, lodi } = await world();
  const status = { db: fx.db, gateway: { hasModelCredential: async () => false }, machines };
  expect(await orgHasAi(status, fx.org.id)).toBe(false);
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  expect(await orgHasAi(status, fx.org.id)).toBe(true);
});

test("a plan taken back from a person's Lodi tells the computers, so its user lets the sign-in go", async () => {
  const { fx, deps, caio, lodi } = await world();
  await setAgentBrain(deps, caio.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: ANAS });
  const heard: unknown[] = [];
  fx.pubsub.subscribe(MACHINE_CONTROL_TOPIC, (e) => heard.push(e));
  await takeBackPlan({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, ANAS);
  expect(heard).toContainEqual({ type: "machine.agents", orgId: fx.org.id });
});

test("the plans page names Lodi, and a plan that goes takes people's Lodi back to the workspace's at once", async () => {
  const { fx, deps, machineId, bia, lodi, runIn } = await world();
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { scope: "mine", brain: "claude_code", account: BIAS });
  const views = await listMachineAccounts(deps, fx.org.id, machineId, bia.id);
  expect(views.find((a) => a.id === BIAS)?.usedBy).toEqual([lodi.name]);
  // Its row stays until the computer's runner has removed the sign-in, which may be away.
  await releaseMemberAccounts(fx.db, bia.id, fx.org.id);
  expect((await runIn(bia.id)).kind).toBe("model");
});

test("a login made for one agent moves to a person's Lodi only when they say so, and to one agent only", async () => {
  const { fx, deps, machineId, bia, lodi } = await world();
  await fx.db.update(schema.machineAccounts).set({ shared: false }).where(eq(schema.machineAccounts.id, BIAS));
  await fx.db
    .update(schema.agents)
    .set({ brain: "claude_code", brainAccountId: BIAS, machineId, ownerUserId: bia.id })
    .where(eq(schema.agents.id, fx.agent.id));
  const input = { scope: "mine", brain: "claude_code", account: BIAS };
  expect(await codeOf(setAgentBrain(deps, bia.id, fx.org.id, lodi.id, input))).toBe("account.in_use");
  await setAgentBrain(deps, bia.id, fx.org.id, lodi.id, { ...input, moveAccount: true });
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, fx.agent.id));
  expect(agent?.brainAccountId).toBeNull();
  // Back to an agent: it leaves her Lodi, which goes back to the workspace's.
  await setAgentBrain(deps, bia.id, fx.org.id, fx.agent.id, { brain: "claude_code", account: BIAS });
  expect((await getAgentBrain(deps, bia.id, fx.org.id, lodi.id, "mine")).account).toBeNull();
});

test("chosen, reloaded, read: a workspace key shows as the workspace's AI, and each person's own stays theirs", async () => {
  const { fx, deps, lodi } = await world();
  // What the dialogs do for a key (`rightHandOnKey`): no own plan, the workspace on its model, the key pinned.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { brain: "model", scope: "mine" });
  await setAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, { brain: "model", scope: "workspace" });
  await fx.db.update(schema.agents).set({ credentialId: fx.credential.id }).where(eq(schema.agents.id, lodi.id));
  const mine = await getAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, "mine");
  const workspace = await getAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, "workspace");
  const key = { provider: "anthropic", label: fx.credential.label };
  expect(mine).toMatchObject({ brain: "model", scope: "mine", workspaceAi: { brain: "model", key } });
  expect(workspace).toMatchObject({ brain: "model", scope: "workspace", workspaceAi: { brain: "model", key } });
});

test("with no key pinned, the page names the key its calls take: the default, not the newest", async () => {
  const { fx, deps, lodi } = await world();
  await fx.db.update(schema.agents).set({ credentialId: null }).where(eq(schema.agents.id, lodi.id));
  await fx.db.insert(schema.providerCredentials).values({
    ...(await keyRow(fx)),
    label: "Newer",
    createdAt: new Date(Date.now() + 60_000),
  });
  await makeDefaultCredential(fx.db, fx.owner.id, fx.org.id, fx.credential.id);
  const mine = await getAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, "mine");
  expect(mine.workspaceAi?.key?.label).toBe(fx.credential.label);
});

test("with no key anywhere, the workspace's AI says so instead of naming one", async () => {
  const { fx, deps, lodi } = await world();
  await fx.db.delete(schema.providerCredentials).where(eq(schema.providerCredentials.orgId, fx.org.id));
  const mine = await getAgentBrain(deps, fx.owner.id, fx.org.id, lodi.id, "mine");
  expect(mine.workspaceAi?.key).toBeNull();
});

/** Another key of the same provider, copied from the fixture's. */
async function keyRow(fx: Awaited<ReturnType<typeof world>>["fx"]) {
  const [row] = await fx.db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.id, fx.credential.id));
  if (!row) throw new Error("fixture key");
  return { ...row, id: crypto.randomUUID() };
}

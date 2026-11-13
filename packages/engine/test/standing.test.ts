import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, MACHINE_PROTOCOL_VERSION, orgTopic, type ServerFrame } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  AgentHeldError,
  acceptInvitation,
  accountBlock,
  accountBlockKind,
  addChannelMember,
  agentHoldKind,
  assertCanWork,
  type BillingHold,
  cloudNotice,
  createAgent,
  createFakeJudge,
  createInvitation,
  createOrganization,
  deleteAccount,
  drainOutbox,
  ForbiddenError,
  getMembership,
  inviteLink,
  isUserBlocked,
  listMemberships,
  type MachineHub,
  OrgPausedError,
  postPersonMessage,
  type RouterStrategy,
  removeMember,
  requireBrowserAccess,
  requireChannelAccess,
  requirePermission,
  resendInvitation,
  routeMessage,
  runErrorDetail,
  setAgentHold,
  setBillingHold,
  setMemberRoles,
  setOrgStanding,
  setRestrictionNotices,
  setUserBlocked,
  standingJudge,
} from "../src";
import { addMember, addUser, adminRoleId, type Fixture, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { channelRoutine, fire, routineRow } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const REASON = "Unpaid invoice";
const standing = (state: "active" | "hold" | "suspended", notice: "shown" | "silent" = "shown") =>
  setOrgStanding({ db: f.db, pubsub: f.pubsub, hub: f.machineHub ?? undefined }, f.org.id, {
    state,
    reason: REASON,
    note: "card declined",
    notice,
  });
const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const runs = () => f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
const audits = () =>
  f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "organization.standing_changed"));
const standingNotices = () =>
  f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "org_standing"));

describe("hold", () => {
  test("a run fails before the model is called and says why; back to active the agent answers", async () => {
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    const events = f.listen(f.general.id);
    await standing("hold");

    await post("@dev can you check the build?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
    const [failed] = await runs();
    expect(failed).toMatchObject({ status: "failed", error: `This workspace is on hold: ${REASON}` });
    expect(runErrorDetail(failed?.error)).toEqual({ errorCode: "run.org_paused", errorParams: { reason: REASON } });
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({
      status: "failed",
      errorCode: "run.org_paused",
    });

    // Any other way to the model is refused too.
    const call = { orgId: f.org.id, system: "x", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50 };
    await expect(f.gateway.stream({ ...call, agentId: f.agent.id, onDelta: () => {} })).rejects.toBeInstanceOf(
      OrgPausedError,
    );
    await expect(f.gateway.complete({ ...call, kind: "summary", model: "claude-haiku-5-5" })).rejects.toMatchObject({
      code: "org.paused",
      params: { reason: REASON },
    });
    expect(f.provider.calls).toHaveLength(0);
    // People still work there.
    expect(await requirePermission(f.db, f.owner.id, f.org.id, "manage_agents")).toMatchObject({ role: "owner" });

    await standing("active");
    await post("@dev and now?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
    expect((await runs()).map((r) => r.status)).toEqual(["failed", "done"]);
  });

  test("a routine's slot is skipped, the routine stays on its schedule", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    await standing("hold", "silent");
    expect(await fire(f, routine.id, new Date())).toMatchObject({
      status: "skipped",
      code: "org_paused",
      agentRunId: null,
    });
    expect(await routineRow(f, routine.id)).toMatchObject({ active: true, pausedReason: null });
    expect(await runs()).toHaveLength(0);

    await standing("active");
    expect((await fire(f, routine.id, new Date())).agentRunId).not.toBeNull();
  });

  test("the router and the judge ask nothing (they bill the server)", async () => {
    f = await setup();
    const message = await post("anyone around?");
    const decided: string[] = [];
    const strategy: RouterStrategy = {
      name: "spy",
      decide: async (input) => {
        decided.push(input.message.body);
        return { agents: [] };
      },
    };
    const judge = createFakeJudge(() => 1);
    const guarded = standingJudge(f.db, judge);
    const ask = () =>
      guarded.ask({
        orgId: f.org.id,
        kind: "stop_request",
        state: { message: "para" },
        questions: { stop: { type: "noul", instructions: "Stop?", criteria: { true: "yes", false: "no" } } },
      });
    await standing("hold");

    const routed = await routeMessage(
      { db: f.db, strategy, policy: { minScore: 0.5, maxAgents: 2, maxHops: 3 } },
      { orgId: f.org.id, messageId: message.id },
    );
    expect(routed).toEqual({ runs: [], skipped: "org_paused" });
    expect(decided).toEqual([]);
    await expect(ask()).rejects.toBeInstanceOf(OrgPausedError);
    expect(judge.calls).toHaveLength(0);

    await standing("active");
    expect((await ask()).stop?.noul).toBe(1);
  });

  test("computers: new work and bridge calls are refused, following running work goes on", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      ...RUNNER,
    });
    const runner = fakeRunner(hub);
    await runner.hello(paired.token);
    const ls = () => hub.call(paired.machineId, { op: "exec", command: "ls", timeoutSeconds: 5, stream: false });
    await standing("hold", "silent");

    await expect(ls()).rejects.toMatchObject({
      code: "org.paused",
      message: "Agents in this workspace are paused for now.",
    });
    expect(runner.requests().some((r) => r.op === "exec")).toBe(false);
    expect(await hub.call(paired.machineId, { op: "task.output", taskId: crypto.randomUUID(), tail: 10 })).toEqual({
      lines: [],
      truncated: false,
    });
    await runner.send({ type: "mcp.call", callId: "call-1", taskId: "task-1", tool: "post_message", args: {} });
    const answer = await runner.answer("call-1");
    expect(answer).toMatchObject({ type: "mcp.result", ok: false, error: { code: "org.paused" } });

    await standing("active");
    expect(await ls()).toMatchObject({ exitCode: 0 });
  });
});

describe("suspended", () => {
  test("browser and desktop access stop on suspension, while hold remains readable", async () => {
    f = await setup();
    const access = (screen: "browser" | "desktop") =>
      requireBrowserAccess(f.db, f.owner.id, f.org.id, f.agent.id, undefined, screen);

    await access("browser");
    await standing("hold");
    await access("browser");
    await access("desktop");

    await standing("suspended");
    for (const screen of ["browser", "desktop"] as const) {
      await expect(access(screen)).rejects.toMatchObject({ code: "org.suspended", params: { reason: REASON } });
    }

    await standing("suspended", "silent");
    await expect(access("browser")).rejects.toMatchObject({
      code: "org.suspended",
      message: "This workspace is unavailable for now.",
      params: undefined,
    });

    await standing("active");
    await access("browser");
  }, 75_000);

  test("every permission check refuses with org.suspended; back to active it works", async () => {
    f = await setup();
    await standing("suspended");
    const refused = requirePermission(f.db, f.owner.id, f.org.id, "read");
    await expect(refused).rejects.toBeInstanceOf(OrgPausedError);
    await expect(refused).rejects.toMatchObject({ code: "org.suspended", params: { reason: REASON } });
    await expect(post("hello?")).rejects.toMatchObject({ code: "org.suspended" });
    await expect(assertCanWork(f.db, f.org.id)).rejects.toMatchObject({ code: "org.suspended" });

    await standing("suspended", "silent");
    await expect(requirePermission(f.db, f.owner.id, f.org.id, "read")).rejects.toMatchObject({
      code: "org.suspended",
      message: "This workspace is unavailable for now.",
      params: undefined,
    });

    await standing("active");
    expect(await requirePermission(f.db, f.owner.id, f.org.id, "read")).toMatchObject({ role: "owner" });
    expect(await post("hello again")).toMatchObject({ body: "hello again" });
  });

  test("invitations: none go out, are resent or accepted; its people start no other workspace", async () => {
    f = await setup();
    const bia = await addUser(f.db, "bia");
    const sent = await createInvitation(f.db, f.owner.id, f.org.id, { email: bia.email, role: "member" });
    await standing("hold");

    for (const refused of [
      () => createInvitation(f.db, f.owner.id, f.org.id, { email: "carl@example.com", role: "member" }),
      () => inviteLink(f.db, SECRET, f.owner.id, f.org.id),
      () => resendInvitation(f.db, f.owner.id, f.org.id, sent.invitation.id),
      () => acceptInvitation(f.db, bia, sent.token),
    ]) {
      await expect(refused()).rejects.toMatchObject({ code: "org.paused" });
    }
    await expect(createOrganization(f.db, f.owner.id, { name: "Acme 2" })).rejects.toMatchObject({
      code: "org.create_refused",
    });
    // Someone who isn't in it still can.
    expect((await createOrganization(f.db, bia.id, { name: "Bia's" })).organization.name).toBe("Bia's");

    await standing("active");
    expect(await acceptInvitation(f.db, bia, sent.token)).toMatchObject({ orgId: f.org.id });
    expect((await createOrganization(f.db, f.owner.id, { name: "Acme 2" })).organization.name).toBe("Acme 2");
  });

  test("a run mid-reply stops at once: what it wrote is posted, it says why and hands nothing on", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f = await setup({
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Looking at the logs. ", "Never sent."], hold: held } : { chunks: ["no"] },
    });
    let suspending: Promise<unknown> | null = null;
    f.pubsub.subscribe(channelTopic(f.general.id), (event) => {
      if (event.type === "agent.typing" && !suspending) suspending = standing("suspended").finally(release);
    });
    await post("@dev check the logs");
    await drainOutbox(f.db, f.handlers);
    await suspending;

    const [run] = await runs();
    expect(run).toMatchObject({ status: "canceled", error: `This workspace is suspended: ${REASON}` });
    expect(runErrorDetail(run?.error)).toEqual({ errorCode: "run.org_suspended", errorParams: { reason: REASON } });
    expect(await runs()).toHaveLength(1);
    expect(f.provider.calls).toHaveLength(1);
    const posted = await f.db.select().from(schema.messages).where(eq(schema.messages.authorType, "agent"));
    expect(posted.map((m) => m.body)).toEqual(["Looking at the logs.\n\n_Stopped._"]);
    const [audit] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "run.canceled"));
    expect(audit).toMatchObject({ actorType: "system", actorId: null, details: { from: "running" } });
  });

  test("its computers stop its tasks and its agents' desktops, and a queued run never starts", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      ...RUNNER,
    });
    const runner = fakeRunner(hub);
    await runner.hello(paired.token);
    const task = async (status: "queued" | "running", extra: Partial<typeof schema.machineTasks.$inferInsert> = {}) => {
      const [row] = await f.db
        .insert(schema.machineTasks)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          machineId: paired.machineId,
          channelId: f.general.id,
          title: "Build",
          executor: "shell",
          command: "make",
          status,
          ...extra,
        })
        .returning();
      if (!row) throw new Error("no task");
      return row;
    };
    const running = await task("running", { startedAt: new Date() });
    const waiting = await task("queued", { startRequest: { title: "Build" } });
    await post("@dev deploy it");
    await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
    await standing("suspended", "silent");
    // A desktop stays on otherwise: it ends here, and what runs on it with it.
    expect(runner.requests().filter((r) => r.op === "desktop.session.stop")).toMatchObject([
      { agent: { id: f.agent.id, handle: "dev" } },
    ]);

    expect((await runs()).map((r) => [r.status, r.error])).toEqual([
      ["canceled", "This workspace is unavailable for now."],
    ]);
    // The computer stops the one it runs (its `task.done` ends the row); the one in our queue ends here.
    expect(runner.requests().filter((r) => r.op === "task.cancel")).toMatchObject([{ taskId: running.id }]);
    const tasks = Object.fromEntries((await f.db.select().from(schema.machineTasks)).map((t) => [t.id, t]));
    expect(tasks[running.id]).toMatchObject({ status: "running", canceledBy: "system" });
    expect(tasks[waiting.id]).toMatchObject({ status: "canceled", canceledBy: "system" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
  });
});

describe("agent hold", () => {
  test("only that agent stops: runs, routines, computer work and model calls; let go, it answers", async () => {
    f = await setup({ reply: () => ({ chunks: ["On it."] }), machines: true });
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    expect(await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: "Spam" })).toEqual({
      heldAt: expect.any(Date),
      reason: "Spam",
    });

    await post("@dev check the build");
    await post("@ops check the build");
    await drainOutbox(f.db, f.handlers);
    const of = async (agentId: string) => (await runs()).filter((r) => r.agentId === agentId);
    const [refused] = await of(f.agent.id);
    expect(refused).toMatchObject({ status: "failed", error: "This agent is paused for now." });
    expect(runErrorDetail(refused?.error)).toEqual({ errorCode: "run.agent_paused" });
    expect((await of(ops.id)).map((r) => r.status)).toEqual(["done"]);
    expect(f.provider.calls).toHaveLength(1);
    // The operator's reason never reaches the workspace.
    expect(JSON.stringify(await runs())).not.toContain("Spam");

    const routine = await channelRoutine(f);
    expect(await fire(f, routine.id, new Date())).toMatchObject({
      status: "skipped",
      code: "agent_paused",
      agentRunId: null,
    });
    expect(await routineRow(f, routine.id)).toMatchObject({ active: true, pausedReason: null });

    const call = { orgId: f.org.id, system: "x", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50 };
    await expect(f.gateway.stream({ ...call, agentId: f.agent.id, onDelta: () => {} })).rejects.toBeInstanceOf(
      AgentHeldError,
    );

    const hub = f.machineHub as MachineHub;
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      ...RUNNER,
    });
    const runner = fakeRunner(hub);
    await runner.hello(paired.token);
    const ls = (agent: { id: string; handle: string }) =>
      hub.call(paired.machineId, { op: "exec", command: "ls", timeoutSeconds: 5, stream: false, agent });
    await expect(ls({ id: f.agent.id, handle: "dev" })).rejects.toMatchObject({
      code: "agent.paused",
      message: "This agent is paused for now.",
    });
    expect(await ls({ id: ops.id, handle: "ops" })).toMatchObject({ exitCode: 0 });

    expect(await setAgentHold(f.db, f.org.id, f.agent.id, { held: false, reason: null })).toEqual({
      heldAt: null,
      reason: null,
    });
    await post("@dev and now?");
    await drainOutbox(f.db, f.handlers);
    expect((await of(f.agent.id)).map((r) => r.status)).toEqual(["failed", "done"]);
    expect(await ls({ id: f.agent.id, handle: "dev" })).toMatchObject({ exitCode: 0 });
    expect(await setAgentHold(f.db, crypto.randomUUID(), f.agent.id, { held: true, reason: null })).toBeNull();
  });

  test("a shared browser profile's key is no agent: only the workspace's standing is asked", async () => {
    f = await setup();
    const key = "profile:6f1c2a34-5b6d-4e7f-8a90-b1c2d3e4f5a6";
    await assertCanWork(f.db, f.org.id, key);
    await standing("suspended");
    await expect(assertCanWork(f.db, f.org.id, key)).rejects.toMatchObject({ code: "org.suspended" });
  });

  test("the router never picks a held agent: the others answer", async () => {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: null });
    const seen: string[][] = [];
    const strategy: RouterStrategy = {
      name: "spy",
      decide: async (input) => {
        seen.push(input.candidates.map((c) => c.handle));
        return { agents: [] };
      },
    };
    const message = await post("anyone around?");
    await routeMessage(
      { db: f.db, strategy, policy: { minScore: 0.5, maxAgents: 2, maxHops: 3 } },
      { orgId: f.org.id, messageId: message.id },
    );
    expect(seen).toEqual([["ops"]]);
  });
});

describe("user block", () => {
  test("no membership anywhere at once, sessions and phones gone, sockets told; let back in", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const day = 86_400_000;
    await f.db
      .insert(schema.sessions)
      .values(
        [1, 2].map((i) => ({ id: `s-${i}`, token: `t-${i}`, userId: bia.id, expiresAt: new Date(Date.now() + day) })),
      );
    await f.db
      .insert(schema.pushDevices)
      .values({ userId: bia.id, token: "ExponentPushToken[bia]", platform: "ios", locale: "en" });
    const link = await inviteLink(f.db, SECRET, f.owner.id, f.org.id);
    const events: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));

    expect(await setUserBlocked({ db: f.db, pubsub: f.pubsub }, bia.id, { blocked: true, reason: "Phishing" })).toEqual(
      {
        blockedAt: expect.any(Date),
        reason: "Phishing",
        sessionsRevoked: 2,
      },
    );
    expect(await isUserBlocked(f.db, bia.id)).toBe(true);
    expect(await f.db.select().from(schema.sessions).where(eq(schema.sessions.userId, bia.id))).toEqual([]);
    expect(await f.db.select().from(schema.pushDevices)).toEqual([]);
    expect(events).toEqual([{ type: "membership.revoked", orgId: f.org.id, userId: bia.id, quiet: true }]);

    expect(await getMembership(f.db, bia.id, f.org.id)).toBeNull();
    expect(await listMemberships(f.db, bia.id)).toEqual([]);
    await expect(requirePermission(f.db, bia.id, f.org.id, "read")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireChannelAccess(f.db, bia.id, f.org.id, f.general.id)).rejects.toMatchObject({
      message: "You are not a member of this organization",
    });
    await expect(createOrganization(f.db, bia.id, { name: "Bia's" })).rejects.toMatchObject({
      code: "org.create_refused",
    });
    await expect(acceptInvitation(f.db, bia, link.token)).rejects.toMatchObject({ code: "forbidden" });
    // Nor erase their workspaces with their account.
    await expect(deleteAccount(f.db, bia.id)).rejects.toBeInstanceOf(ForbiddenError);
    // The workspace still manages them; they can't act, not even to leave.
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [await adminRoleId(f.db, f.org.id)]);
    await removeMember(f.db, bia.id, f.org.id, bia.id);
    expect(await getMembership(f.db, bia.id, f.org.id, { includeBlocked: true })).toMatchObject({ rank: 0 });

    expect(await setUserBlocked({ db: f.db }, bia.id, { blocked: false, reason: null })).toEqual({
      blockedAt: null,
      reason: null,
      sessionsRevoked: 0,
    });
    expect(await requirePermission(f.db, bia.id, f.org.id, "manage_members")).toMatchObject({
      role: "member",
      rank: 0,
    });
    expect((await createOrganization(f.db, bia.id, { name: "Bia's" })).organization.name).toBe("Bia's");

    await setUserBlocked({ db: f.db }, bia.id, { blocked: true, reason: null });
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    expect(await getMembership(f.db, bia.id, f.org.id, { includeBlocked: true })).toBeNull();
    expect(await setUserBlocked({ db: f.db }, "nobody", { blocked: true, reason: null })).toBeNull();
  });
});

describe("notice", () => {
  test("shown: audit row (actor system), notification to owners and admins, members hear the reason", async () => {
    f = await setup();
    const events: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
    const set = await standing("hold");
    expect(set).toMatchObject({ state: "hold", reason: REASON, note: "card declined", notice: "shown" });
    expect(set?.changedAt).toBeInstanceOf(Date);

    expect(await audits()).toMatchObject([
      {
        actorType: "system",
        actorId: null,
        targetId: f.org.id,
        details: { from: "active", to: "hold", reason: REASON },
      },
    ]);
    expect(await standingNotices()).toMatchObject([{ userId: f.owner.id, latest: { statusTo: "hold", text: REASON } }]);
    expect(events).toEqual([
      {
        type: "org.broadcast",
        orgId: f.org.id,
        event: { type: "org.standing", orgId: f.org.id, state: "hold", reason: REASON },
      },
    ]);

    // The same again tells nobody anything new.
    await standing("hold");
    expect(await audits()).toHaveLength(1);
    expect(await standingNotices()).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("silent: generic text, no audit row, no notification, no reason, not the note", async () => {
    f = await setup();
    const events: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
    await standing("hold", "silent");

    const error = await assertCanWork(f.db, f.org.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgPausedError);
    expect(error).toMatchObject({ code: "org.paused", message: "Agents in this workspace are paused for now." });
    expect((error as OrgPausedError).params).toBeUndefined();
    expect(runErrorDetail((error as OrgPausedError).message)).toEqual({ errorCode: "run.org_paused" });
    expect(await audits()).toHaveLength(0);
    expect(await standingNotices()).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain(REASON);
    expect(JSON.stringify(events)).not.toContain("card declined");
    expect(events).toEqual([
      {
        type: "org.broadcast",
        orgId: f.org.id,
        event: { type: "org.standing", orgId: f.org.id, state: "hold", reason: null },
      },
    ]);

    expect(
      await setOrgStanding({ db: f.db }, crypto.randomUUID(), { state: "hold", reason: REASON, notice: "silent" }),
    ).toBeNull();
  });
});

describe("billing hold", () => {
  const billing = (hold: BillingHold | null) => setBillingHold({ db: f.db, pubsub: f.pubsub }, f.org.id, hold);

  test("set, moved to another code and lifted through the standing's own write: told, audited, notified on a move", async () => {
    f = await setup();
    const events: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
    // Held, it waits for no computer (the same write as any hold).
    await f.db.insert(schema.machineProvisioning).values({ orgId: f.org.id, state: "preparing" });

    const set = await billing("payment");
    expect(set).toMatchObject({
      applied: true,
      standing: { state: "hold", reason: "payment", note: null, notice: "shown" },
    });
    expect(set?.standing.changedAt).toBeInstanceOf(Date);
    expect(await f.db.select().from(schema.machineProvisioning)).toEqual([]);
    await expect(assertCanWork(f.db, f.org.id)).rejects.toMatchObject({
      code: "org.paused",
      params: { reason: "payment" },
    });
    // Its owners and admins hear the code, never as text to print.
    const [notice] = await standingNotices();
    expect(notice?.latest).toEqual({ statusTo: "hold", billingHold: "payment" });

    expect(await billing("payment")).toMatchObject({ applied: false, standing: { state: "hold", reason: "payment" } });
    expect(await billing("unpaid")).toMatchObject({ applied: true, standing: { state: "hold", reason: "unpaid" } });
    // Another code is a new reason told, not a move: audited and heard live, with no second notification.
    expect(await standingNotices()).toHaveLength(1);

    expect(await billing(null)).toMatchObject({ applied: true, standing: { state: "active", reason: null } });
    expect(await billing(null)).toMatchObject({ applied: false, standing: { state: "active" } });
    await assertCanWork(f.db, f.org.id);

    expect((await audits()).map((a) => a.details)).toEqual([
      { from: "active", to: "hold", reason: "payment" },
      { from: "hold", to: "hold", reason: "unpaid" },
      { from: "hold", to: "active", reason: null },
    ]);
    expect((await standingNotices()).map((n) => n.latest)).toEqual([
      { statusTo: "hold", billingHold: "payment" },
      { statusTo: "active" },
    ]);
    expect(events.map((e) => (e as { event: { reason: string | null } }).event.reason)).toEqual([
      "payment",
      "unpaid",
      null,
    ]);
  });

  test("the first plan lifting the payment hold starts the workspace with no 'working again' notice", async () => {
    f = await setup();
    await billing("payment");
    expect(await billing(null)).toMatchObject({ applied: true, standing: { state: "active" } });
    expect((await standingNotices()).map((n) => n.latest)).toEqual([{ statusTo: "hold", billingHold: "payment" }]);
    // A plan that ended or failed and came back is a return: told.
    await billing("ended");
    await billing(null);
    expect((await standingNotices()).map((n) => n.latest)).toMatchObject([
      { statusTo: "hold" },
      { statusTo: "hold" },
      { statusTo: "active" },
    ]);
  });

  test("never replaces nor lifts a hold set through the standing, shown or silent, or a suspension", async () => {
    f = await setup();
    await standing("hold");
    expect(await billing("unpaid")).toMatchObject({ applied: false, standing: { state: "hold", reason: REASON } });
    expect(await billing(null)).toMatchObject({ applied: false, standing: { state: "hold", reason: REASON } });

    // A silent hold with a billing code for its reason is the operator's too.
    await setOrgStanding({ db: f.db }, f.org.id, { state: "hold", reason: "payment", notice: "silent" });
    expect(await billing(null)).toMatchObject({ applied: false, standing: { notice: "silent" } });

    await standing("suspended");
    expect(await billing("ended")).toMatchObject({ applied: false, standing: { state: "suspended" } });

    await standing("active");
    expect(await billing("ended")).toMatchObject({ applied: true, standing: { state: "hold", reason: "ended" } });
    // The operator's hold replaces a billing one, as before.
    expect(await standing("hold")).toMatchObject({ state: "hold", reason: REASON });
    expect(await setBillingHold({ db: f.db }, crypto.randomUUID(), "payment")).toBeNull();
  });
});

describe("on agentes.chat Cloud: a restriction's kind and how to contest it, never its reason", () => {
  afterEach(() => setRestrictionNotices("http://localhost:3000"));

  test("the kinds come from the stored reasons", () => {
    expect(["network.smtp", "network.scan", "operator", "Spam", null].map((r) => agentHoldKind(r))).toEqual([
      "network",
      "network",
      "operator",
      "operator",
      "operator",
    ]);
    expect(["abuse.resignup", "legal_hold", "Phishing", null].map((r) => accountBlockKind(r))).toEqual([
      "abuse",
      "legal",
      "other",
      "other",
    ]);
  });

  test("only on an agentes.chat address", () => {
    for (const url of ["https://agentes.chat", "https://app.agentes.chat"]) {
      setRestrictionNotices(url);
      expect(cloudNotice()).toEqual({ cloud: true });
    }
    for (const url of ["https://chat.acme.com", "https://agentes.chat.example.com", "http://localhost:3000"]) {
      setRestrictionNotices(url);
      expect(cloudNotice()).toBeUndefined();
    }
  });

  test("a held agent: its refusal and its runs say the kind, its people hear it, letting it go closes that", async () => {
    setRestrictionNotices("https://agentes.chat");
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const cid = await addMember(f.db, f.org.id, "member", "cid");
    await addMember(f.db, f.org.id, "member", "dan");
    // Cid answers for the agent.
    await f.db.update(schema.agents).set({ ownerUserId: cid.id }).where(eq(schema.agents.id, f.agent.id));
    const hold = (held: boolean, reason: string | null = null) =>
      setAgentHold(f.db, f.org.id, f.agent.id, { held, reason }, f.pubsub);

    expect(await hold(true, "network.smtp")).toEqual({ heldAt: expect.any(Date), reason: "network.smtp" });
    await expect(assertCanWork(f.db, f.org.id, f.agent.id)).rejects.toMatchObject({
      code: "agent.paused",
      message: "This agent is paused: network",
      params: { kind: "network", cloud: true },
    });
    await post("@dev check the build");
    await drainOutbox(f.db, f.handlers);
    const [refused] = await runs();
    expect(refused).toMatchObject({ status: "failed", error: "This agent is paused: network" });
    expect(runErrorDetail(refused?.error)).toEqual({
      errorCode: "run.agent_paused",
      errorParams: { kind: "network", cloud: "true" },
    });

    const told = await standingNotices();
    expect(told.map((n) => n.userId).sort()).toEqual([f.owner.id, bia.id, cid.id].sort());
    for (const n of told)
      expect(n).toMatchObject({
        source: { agentId: f.agent.id, label: "Dev" },
        latest: { statusTo: "agent_hold", holdKind: "network" },
        doneAt: null,
      });
    // Held again meanwhile for the same kind: nobody is told twice.
    await hold(true, "network.scan");
    expect(await standingNotices()).toHaveLength(3);
    // For another kind, and back: the open notice says what its refusals say.
    const open = async () => (await standingNotices()).filter((n) => n.doneAt === null);
    const each = (holdKind: string) => [1, 2, 3].map(() => ({ latest: { statusTo: "agent_hold", holdKind } }));
    await hold(true, "operator");
    await expect(assertCanWork(f.db, f.org.id, f.agent.id)).rejects.toMatchObject({ params: { kind: "operator" } });
    expect(await open()).toMatchObject(each("operator"));
    await hold(true, "network.smtp");
    expect(await open()).toMatchObject(each("network"));
    expect(await standingNotices()).toHaveLength(9);
    // The reasons never reach the workspace.
    expect(JSON.stringify([await runs(), await standingNotices()])).not.toContain("smtp");

    await hold(false);
    expect(await open()).toEqual([]);
    await Bun.sleep(5);
    await hold(true, "operator");
    expect(await open()).toMatchObject(each("operator"));
  });

  test("a blocked account's kind, a refused workspace, the workspace's standing and its runs say cloud", async () => {
    setRestrictionNotices("https://agentes.chat");
    f = await setup();
    const bia = await addUser(f.db, "bia");
    for (const [reason, kind] of [
      ["abuse.resignup", "abuse"],
      ["legal_hold", "legal"],
      ["Phishing", "other"],
    ] as const) {
      await setUserBlocked({ db: f.db }, bia.id, { blocked: true, reason });
      expect(await accountBlock(f.db, bia.id)).toEqual({ kind, cloud: true });
    }
    await expect(createOrganization(f.db, bia.id, { name: "Bia's" })).rejects.toMatchObject({
      code: "org.create_refused",
      params: { cloud: true },
    });
    await setUserBlocked({ db: f.db }, bia.id, { blocked: false, reason: null });
    expect(await accountBlock(f.db, bia.id)).toBeNull();

    const events: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
    const set = (notice: "shown" | "silent") =>
      setOrgStanding({ db: f.db, pubsub: f.pubsub }, f.org.id, { state: "hold", reason: "review", notice });
    await set("shown");
    await expect(assertCanWork(f.db, f.org.id)).rejects.toMatchObject({
      code: "org.paused",
      params: { reason: "review", cloud: true },
    });
    // Its owners' notice reads as the hold does.
    expect((await standingNotices()).map((n) => n.latest)).toEqual([{ statusTo: "hold", text: "review", cloud: true }]);
    expect(events).toEqual([
      {
        type: "org.broadcast",
        orgId: f.org.id,
        event: { type: "org.standing", orgId: f.org.id, state: "hold", reason: "review", cloud: true },
      },
    ]);
    expect(runErrorDetail("This workspace is on hold: review")).toEqual({
      errorCode: "run.org_paused",
      errorParams: { reason: "review", cloud: "true" },
    });
    // Silent: only that it is paused.
    await set("silent");
    const silent = await assertCanWork(f.db, f.org.id).catch((e: unknown) => e);
    expect((silent as OrgPausedError).params).toEqual({ cloud: true });
  });

  test("the automatic hold's category: its text says it in words, the apps get the code", async () => {
    setRestrictionNotices("https://agentes.chat");
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    const flagged = "automated checks flagged activity that seems to involve";
    const reason = "review.phishing_impersonation";
    await setOrgStanding({ db: f.db, pubsub: f.pubsub }, f.org.id, { state: "hold", reason, notice: "shown" });
    await expect(assertCanWork(f.db, f.org.id)).rejects.toMatchObject({
      message: `This workspace is on hold: ${flagged} phishing or impersonating a brand`,
      params: { reason, cloud: true },
    });
    expect((await standingNotices()).map((n) => n.latest)).toEqual([{ statusTo: "hold", text: reason, cloud: true }]);
    // A run keeps the words, and its values give the code back.
    await post("@dev check the build");
    await drainOutbox(f.db, f.handlers);
    const [refused] = await runs();
    expect(refused?.error).toBe(`This workspace is on hold: ${flagged} phishing or impersonating a brand`);
    expect(runErrorDetail(refused?.error)).toEqual({
      errorCode: "run.org_paused",
      errorParams: { reason, cloud: "true" },
    });
    const suspended = new OrgPausedError({
      state: "suspended",
      reason: "review.account_takeover",
      notice: "shown",
      deletionDueAt: null,
    });
    expect(suspended.message).toBe(`This workspace is suspended: ${flagged} getting into other people's accounts`);
    expect(runErrorDetail(suspended.message)?.errorParams).toEqual({
      reason: "review.account_takeover",
      cloud: "true",
    });
    // A category this server doesn't know is told as it came.
    const unknown = new OrgPausedError({ state: "hold", reason: "review.spam", notice: "shown", deletionDueAt: null });
    expect(unknown.message).toBe("This workspace is on hold: review.spam");
    expect(runErrorDetail(unknown.message)?.errorParams).toEqual({ reason: "review.spam", cloud: "true" });
  });

  test("a self-hosted server: no kind, no cloud, and nobody told of an agent hold", async () => {
    setRestrictionNotices("https://chat.acme.com");
    f = await setup();
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: "network.smtp" }, f.pubsub);
    await expect(assertCanWork(f.db, f.org.id, f.agent.id)).rejects.toMatchObject({
      message: "This agent is paused for now.",
      params: undefined,
    });
    expect(await standingNotices()).toHaveLength(0);
    const bia = await addUser(f.db, "bia");
    await setUserBlocked({ db: f.db }, bia.id, { blocked: true, reason: "abuse.resignup" });
    expect(await accountBlock(f.db, bia.id)).toEqual({});
    await expect(createOrganization(f.db, bia.id, { name: "Bia's" })).rejects.toMatchObject({
      code: "org.create_refused",
      params: undefined,
    });
    expect(runErrorDetail("This workspace is on hold: review")).toEqual({
      errorCode: "run.org_paused",
      errorParams: { reason: "review" },
    });
    // `review.<category>` is the Cloud's alone: here it reads as it was set.
    expect(
      new OrgPausedError({ state: "hold", reason: "review.fraud", notice: "shown", deletionDueAt: null }).message,
    ).toBe("This workspace is on hold: review.fraud");
    await setOrgStanding({ db: f.db }, f.org.id, { state: "hold", reason: "review", notice: "shown" });
    expect((await standingNotices()).map((n) => n.latest)).toEqual([{ statusTo: "hold", text: "review" }]);
  });
});

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.9.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/ana/agentes",
  exec: true,
};

type Request = Extract<ServerFrame, { type: "request" }>;

/** A runner over an in-memory socket that answers every request with a harmless success. */
function fakeRunner(hub: MachineHub) {
  const sent: ServerFrame[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const data = (req: Request) =>
    req.op === "exec"
      ? { exitCode: 0, stdout: "ok", stderr: "", timedOut: false }
      : req.op === "task.output"
        ? { lines: [], truncated: false }
        : req.op === "task.cancel"
          ? { canceled: true }
          : {};
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type === "request")
        setTimeout(() => void reply({ type: "result", id: frame.id, ok: true, data: data(frame) }), 1);
    },
    close() {
      void hub.close(conn);
    },
  });
  return {
    requests: () => sent.filter((s): s is Request => s.type === "request"),
    send: (frame: Record<string, unknown>) => reply(frame),
    hello: (token: string) => reply({ type: "hello", token, ...RUNNER }),
    /** The server's answer to a bridge call, once it is sent. */
    async answer(callId: string) {
      for (let i = 0; i < 100; i++) {
        const found = sent.find((s) => "callId" in s && s.callId === callId);
        if (found) return found;
        await Bun.sleep(5);
      }
      return null;
    },
  };
}

import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AHEAD_GRACE_MS,
  AHEAD_REFUSED,
  acceptCustomSuggestion,
  addChannelMember,
  COMPOSIO_EXECUTOR,
  type CustomDeps,
  cancelAheadApproval,
  cancelReminder,
  connectCustomServer,
  createChannel,
  createConnectorToolSource,
  createRole,
  createScheduleToolSource,
  createToolGateway,
  decideApproval,
  decideApprovals,
  executeRoutineRun,
  expireApprovals,
  type InvokeResult,
  insertMessage,
  invokeWithChip,
  listRoutines,
  type McpConnect,
  mcpSessionOver,
  NotFoundError,
  type RoutineBrief,
  RUN_APPROVED_ACTION,
  runRoutineNow,
  runWhere,
  setMemberRoles,
  type ToolContext,
  updateRoutine,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const EXEC = `composio_${COMPOSIO_EXECUTOR}`;
const WORKBENCH = "COMPOSIO_REMOTE_WORKBENCH";
const WHY = "The launch post goes out with the announcement: the person asked for it at that time.";

/** A Composio-shaped server in process: its executor and its code workbench, each call kept. */
function composioMcp() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const build = () => {
    const server = new McpServer({ name: "composio", version: "1" });
    server.registerTool(
      COMPOSIO_EXECUTOR,
      {
        description: "Executes up to 50 tools in parallel.",
        inputSchema: {
          tools: z.array(z.object({ tool_slug: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })),
          thought: z.string().optional(),
          sync_response_to_workbench: z.boolean(),
        },
        annotations: { destructiveHint: true },
      },
      async (args) => {
        calls.push({ tool: COMPOSIO_EXECUTOR, args });
        return text(`ran ${args.tools.map((t) => t.tool_slug).join(", ")}`);
      },
    );
    server.registerTool(
      WORKBENCH,
      { description: "Runs Python in a sandbox", inputSchema: { code_to_execute: z.string() } },
      async (args) => {
        calls.push({ tool: WORKBENCH, args });
        return text("done");
      },
    );
    return server;
  };
  const connect: McpConnect = async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await build().connect(server);
    return mcpSessionOver(client);
  };
  return { connect, calls };
}

/** Composio connected by address (its suggestions accepted), with the schedule tools beside it. */
async function world(fx: Fixture) {
  const mcp = composioMcp();
  const deps: CustomDeps = {
    db: fx.db,
    keyWrappers: [fx.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect: mcp.connect,
  };
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
    serverUrl: "https://backend.composio.dev/v3/mcp/composio",
    apiKey: "ck_fake_key_for_tests",
    label: "Composio",
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, started.server.id);
  const sources = [
    createConnectorToolSource(deps),
    createScheduleToolSource({ pubsub: fx.pubsub, context: fx.context }),
  ];
  /** The gateway as the server runs it; `at`: its clock (a run that comes late). */
  const gatewayAt = (at?: Date) => createToolGateway({ sources, ...(at ? { now: () => at } : {}) });
  return { mcp, gateway: gatewayAt(), gatewayAt };
}

/** A run a person asked for in #general (or `channelId`). */
async function personRun(fx: Fixture, channelId = fx.general.id): Promise<ToolContext> {
  const msg = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId,
    author: { type: "person", userId: fx.owner.id },
    body: "@dev posta isso amanhã às 10h",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
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
    channelId,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

/** The routine's background run for its slot at `dueAt` (its brief as the server writes it when it fires). */
async function routineRun(fx: Fixture, routineId: string, dueAt: Date): Promise<ToolContext> {
  const brief: RoutineBrief = {
    routineId,
    routineRunId: crypto.randomUUID(),
    name: "Post de lançamento",
    creatorUserId: fx.owner.id,
    deliverTo: { channelId: fx.general.id, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: dueAt.toISOString(),
  };
  const msg = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId: fx.owner.id },
    body: "Post de lançamento",
    meta: { routineBrief: brief, background: true },
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      background: true,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
    background: true,
  };
}

/** The executor's call publishing a post on a social network. */
const post = (text: string) => ({
  tools: [
    {
      tool_slug: "LINKEDIN_PUBLISH_POST",
      arguments: { author: "urn:li:organization:42", commentary: text, visibility: "PUBLIC" },
    },
  ],
  sync_response_to_workbench: false,
});

let seq = 0;
const invoke = (gateway: ReturnType<typeof createToolGateway>, ctx: ToolContext, name: string, input: object) =>
  gateway.invoke(ctx, { toolUseId: `call-${++seq}`, name, input: input as Record<string, unknown> });

function asked(result: InvokeResult) {
  if (result.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(result)}`);
  return result.approval;
}
function answered(result: InvokeResult) {
  if (result.type !== "result") throw new Error(`expected a result, got ${JSON.stringify(result)}`);
  return result.output;
}

const inTwoHours = () => new Date(Date.now() + 2 * 3600_000).toISOString();
const decide = (approvalId: string, decision: "approve" | "refuse", reason?: string) =>
  decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approvalId, { decision, reason });
const approvalRow = async (id: string) =>
  (await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, id)))[0];
const routineRow = async (id: string) =>
  (await f.db.select().from(schema.routines).where(eq(schema.routines.id, id)))[0];

/** One of the agent's recurring routines that may act, reporting in #general, its next run in two hours. */
async function recurring(fx: Fixture) {
  const [row] = await fx.db
    .insert(schema.routines)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      name: "Resumo da semana",
      prompt: "Posta o resumo da semana no LinkedIn.",
      target: { type: "channel", channelId: fx.general.id },
      triggerType: "schedule",
      access: "act",
      nextRunAt: new Date(Date.now() + 2 * 3600_000),
      createdByUserId: fx.owner.id,
    })
    .returning();
  if (!row?.nextRunAt) throw new Error("no routine");
  return { routineId: row.id, runAt: row.nextRunAt };
}

/** A person asks, the agent prepares the post for later: the approval it waits on, for the one-off it made. */
async function prepared(gateway: ReturnType<typeof createToolGateway>, text = "Lançamos hoje!") {
  const ctx = await personRun(f);
  const approval = asked(
    await invoke(gateway, ctx, "schedule_action", {
      tool: EXEC,
      arguments: post(text),
      when: inTwoHours(),
      title: "Post de lançamento no LinkedIn",
      why: WHY,
    }),
  );
  if (!approval.runAt || !approval.routineId) throw new Error("not prepared ahead");
  return { ctx, approval, runAt: approval.runAt, routineId: approval.routineId };
}

describe("an action approved ahead", () => {
  test("is asked when it is prepared, and its run at its time does it without asking", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { ctx, approval, runAt, routineId } = await prepared(gateway);
    // The card: the exact call, its reason, when it runs; decided by its time at the latest. Nothing went out.
    expect(approval).toMatchObject({ status: "pending", tool: EXEC, params: post("Lançamos hoje!"), why: WHY });
    expect(approval.expiresAt.getTime()).toBeLessThanOrEqual(runAt.getTime());
    expect(await routineRow(routineId)).toMatchObject({
      triggerType: "once",
      active: true,
      access: "act",
      nextRunAt: runAt,
      name: "Post de lançamento no LinkedIn",
    });
    expect(mcp.calls).toEqual([]);

    // Whoever approved it may still withdraw it before its time.
    expect(await decide(approval.id, "approve")).toMatchObject({ status: "approved", canCancel: true });
    // The run that asked hears it is set for later; approving ran nothing.
    const note = await gateway.executeApproved(ctx, (await approvalRow(approval.id)) ?? approval);
    expect(note.isError).toBeFalsy();
    expect(note.content).toContain("Approved ahead");
    expect(mcp.calls).toEqual([]);
    // Its routine's page lists it, with a way to cancel it.
    const [listed] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(listed?.ahead).toEqual([
      expect.objectContaining({ id: approval.id, status: "approved", runAt: runAt.toISOString(), canCancel: true }),
    ]);

    // At its time: the routine's run does it by its id, without a new card.
    const run = await routineRun(f, routineId, runAt);
    const out = answered(await invoke(gateway, run, RUN_APPROVED_ACTION, { id: approval.id }));
    expect(out.isError).toBeFalsy();
    expect(mcp.calls).toEqual([{ tool: COMPOSIO_EXECUTOR, args: post("Lançamos hoje!") }]);
    const ran = await approvalRow(approval.id);
    expect(ran?.executedAt).not.toBeNull();
    expect(ran?.result).toMatchObject({ isError: false });
    expect(await f.db.select().from(schema.approvals)).toHaveLength(1);

    // At most once: the same call again asks a person.
    asked(await invoke(gateway, run, EXEC, { ...post("Lançamos hoje!"), why: WHY }));
    expect(mcp.calls).toHaveLength(1);
  });

  test("when its run does it, its cards hear it ran", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const { approval, runAt, routineId } = await prepared(gateway);
    await decide(approval.id, "approve");
    const heard: unknown[] = [];
    f.pubsub.subscribe(channelTopic(approval.channelId), (e) => heard.push(e));
    const ctx = await routineRun(f, routineId, runAt);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, ctx.runId));
    if (!run) throw new Error("no run");
    await invokeWithChip(
      { deps: { db: f.db, pubsub: f.pubsub }, tools: gateway, ctx, where: runWhere(run), turnTools: null },
      { id: "call-at-its-time", name: RUN_APPROVED_ACTION, input: { id: approval.id } },
    );
    expect(heard).toContainEqual(
      expect.objectContaining({
        type: "approval.decided",
        approval: expect.objectContaining({ id: approval.id, status: "approved", executedAt: expect.any(String) }),
      }),
    );
  });

  test("a changed post asks again: at its time, or prepared again with replaces", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { approval, runAt, routineId } = await prepared(gateway);
    await decide(approval.id, "approve");
    const run = await routineRun(f, routineId, runAt);
    // Other text at its time: a new card, nothing goes out.
    const changed = asked(await invoke(gateway, run, EXEC, { ...post("Lançamos ontem!"), why: WHY }));
    expect(changed).toMatchObject({ status: "pending", runAt: null });
    expect(mcp.calls).toEqual([]);

    // Prepared again with new text: the earlier approval is withdrawn, the new one asks, for the same run.
    const again = asked(
      await invoke(gateway, await personRun(f), "schedule_action", {
        tool: EXEC,
        arguments: post("Lançamos hoje, às 10h!"),
        replaces: approval.id,
        title: "Post de lançamento no LinkedIn",
        why: WHY,
      }),
    );
    expect(again).toMatchObject({ status: "pending", routineId, runAt });
    expect((await approvalRow(approval.id))?.status).toBe("canceled");
    expect((await routineRow(routineId))?.active).toBe(true);
    // The earlier one now asks too: nothing runs on an approval that was withdrawn.
    asked(await invoke(gateway, run, RUN_APPROVED_ACTION, { id: approval.id }));
    expect(mcp.calls).toEqual([]);
    await decide(again.id, "approve");
    answered(await invoke(gateway, run, RUN_APPROVED_ACTION, { id: again.id }));
    expect(mcp.calls).toEqual([{ tool: COMPOSIO_EXECUTOR, args: post("Lançamos hoje, às 10h!") }]);
  });

  test("an expired one asks: a run past its time and grace, or a request nobody decided", async () => {
    f = await setup();
    const { mcp, gateway, gatewayAt } = await world(f);
    const late = await prepared(gateway);
    await decide(late.approval.id, "approve");
    const after = new Date(late.runAt.getTime() + AHEAD_GRACE_MS + 60_000);
    const run = await routineRun(f, late.routineId, late.runAt);
    const again = asked(await invoke(gatewayAt(after), run, RUN_APPROVED_ACTION, { id: late.approval.id }));
    expect(again).toMatchObject({ status: "pending", params: post("Lançamos hoje!"), why: WHY, runAt: null });
    expect(mcp.calls).toEqual([]);
    // The worker ends it too: past its grace an approval ahead covers nothing.
    await expireApprovals({ db: f.db, pubsub: f.pubsub }, after);
    expect((await approvalRow(late.approval.id))?.status).toBe("expired");

    // Never decided: it expires by its time, and its run then asks.
    const undecided = await prepared(gateway, "Outro post");
    await expireApprovals({ db: f.db, pubsub: f.pubsub }, new Date(undecided.approval.expiresAt.getTime() + 1000));
    expect((await approvalRow(undecided.approval.id))?.status).toBe("expired");
    const its = await routineRun(f, undecided.routineId, undecided.runAt);
    asked(await invoke(gateway, its, RUN_APPROVED_ACTION, { id: undecided.approval.id }));
    expect(mcp.calls).toEqual([]);
  });

  test("a denied one never runs: its one-off stops, and its run is refused without a new card", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { approval, runAt, routineId } = await prepared(gateway);
    await decide(approval.id, "refuse", "Ainda não, o lançamento mudou de data.");
    expect(await routineRow(routineId)).toMatchObject({ active: false, nextRunAt: null });
    const run = await routineRun(f, routineId, runAt);
    for (const call of [
      { name: RUN_APPROVED_ACTION, input: { id: approval.id } },
      { name: EXEC, input: { ...post("Lançamos hoje!"), why: WHY } },
    ]) {
      const out = answered(await invoke(gateway, run, call.name, call.input));
      expect(out).toMatchObject({ isError: true, content: AHEAD_REFUSED });
    }
    expect(mcp.calls).toEqual([]);
    expect(await f.db.select().from(schema.approvals)).toHaveLength(1);
  });

  test("denied together on one card, each one-off stops", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const first = await prepared(gateway);
    const second = await prepared(gateway, "Segunda chamada do lançamento");
    await decideApprovals({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      ids: [first.approval.id, second.approval.id],
      decision: "refuse",
    });
    for (const { routineId } of [first, second]) {
      expect(await routineRow(routineId)).toMatchObject({ active: false, nextRunAt: null });
    }
  });

  test("for a recurring routine's next run, the latest decision on the same post wins", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { routineId, runAt } = await recurring(f);
    const prepare = async () =>
      asked(
        await invoke(gateway, await personRun(f), "schedule_action", {
          tool: EXEC,
          arguments: post("Resumo da semana"),
          routine: routineId,
          title: "Resumo no LinkedIn",
          why: WHY,
        }),
      );
    const run = await routineRun(f, routineId, runAt);
    // Refused, then prepared again and approved: it goes out.
    const refused = await prepare();
    expect(refused).toMatchObject({ routineId, runAt });
    await decide(refused.id, "refuse", "Ainda não.");
    expect((await routineRow(routineId))?.active).toBe(true);
    const approved = await prepare();
    await decide(approved.id, "approve");
    expect(answered(await invoke(gateway, run, RUN_APPROVED_ACTION, { id: approved.id })).isError).toBeFalsy();
    expect(mcp.calls).toEqual([{ tool: COMPOSIO_EXECUTOR, args: post("Resumo da semana") }]);

    // Both asked, one approved and then the other refused: refused, whichever was asked last.
    const earlier = await prepare();
    const later = await prepare();
    await decide(later.id, "approve");
    await decide(earlier.id, "refuse");
    const out = answered(await invoke(gateway, run, RUN_APPROVED_ACTION, { id: later.id }));
    expect(out).toMatchObject({ isError: true, content: AHEAD_REFUSED });
    expect(mcp.calls).toHaveLength(1);
  });

  test("never-for-good actions and tools that run anything can't be approved ahead", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const ctx = await personRun(f);
    const slug = (tool_slug: string) => ({
      tools: [{ tool_slug, arguments: { owner: "acme", repo: "app", pull_number: 42 } }],
      sync_response_to_workbench: false,
    });
    for (const [tool, args] of [
      [EXEC, slug("GITHUB_MERGE_A_PULL_REQUEST")],
      [EXEC, slug("GITHUB_CREATE_A_DEPLOYMENT")],
      [EXEC, slug("GITHUB_CREATE_A_WORKFLOW_DISPATCH_EVENT")],
      [`composio_${WORKBENCH}`, { code_to_execute: "post_everywhere()" }],
    ] as const) {
      const out = answered(
        await invoke(gateway, ctx, "schedule_action", {
          tool,
          arguments: args,
          when: inTwoHours(),
          title: "Depois",
          why: WHY,
        }),
      );
      expect(out.isError).toBe(true);
      expect(out.content).toMatch(/can't be approved ahead|Only a connected app's own action/);
    }
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await f.db.select().from(schema.routines)).toEqual([]);
    expect(mcp.calls).toEqual([]);
  });

  test("its one-off ended before its time withdraws it: canceled as a reminder, paused, or run now", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const deps = { db: f.db, pubsub: f.pubsub };
    const approvedAhead = async (text: string) => {
      const p = await prepared(gateway, text);
      await decide(p.approval.id, "approve");
      return p;
    };
    // The person cancels it as a reminder (the agent's cancel_reminder, the app's reminders).
    const reminder = await approvedAhead("Lançamos hoje!");
    await cancelReminder(deps, f.owner.id, f.org.id, reminder.routineId);
    // Paused: a one-off resumed has no next run, so it would never fire.
    const paused = await approvedAhead("Outro post");
    await updateRoutine(deps, f.owner.id, f.org.id, paused.routineId, { active: false });
    // Run now, before its time: the one-off is done and its time never comes.
    const now = await approvedAhead("Mais um post");
    await runRoutineNow(deps, f.owner.id, f.org.id, now.routineId);
    const [manual] = await f.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, now.routineId));
    if (!manual) throw new Error("no manual run");
    await executeRoutineRun(deps, manual.id);
    expect(await routineRow(now.routineId)).toMatchObject({ active: false, nextRunAt: null });

    for (const p of [reminder, paused, now]) {
      expect(await approvalRow(p.approval.id)).toMatchObject({ status: "canceled", executedAt: null });
    }
    expect((await listRoutines(f.db, f.owner.id, f.org.id)).flatMap((r) => r.ahead)).toEqual([]);
    expect(mcp.calls).toEqual([]);
  });

  test("its routine's page lists it only to who sees its request, and only they cancel it", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const { routineId } = await recurring(f);
    // Asked in a private channel while the routine reports in #general: the request lives where it was asked.
    const board = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, board.id, { agentId: f.agent.id });
    const approval = asked(
      await invoke(gateway, await personRun(f, board.id), "schedule_action", {
        tool: EXEC,
        arguments: post("Resultado do trimestre"),
        routine: routineId,
        title: "Resultado no LinkedIn",
        why: WHY,
      }),
    );
    expect(approval.channelId).toBe(board.id);
    // Someone who manages routines reads this one, but not that conversation.
    const cora = await addMember(f.db, f.org.id, "member", "cora");
    const role = await createRole(f.db, f.owner.id, f.org.id, { name: "Rotinas", permissions: ["manage_routines"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, cora.id, [role.id]);
    const seen = async (userId: string) => (await listRoutines(f.db, userId, f.org.id)).find((r) => r.id === routineId);
    expect((await seen(f.owner.id))?.ahead.map((a) => a.id)).toEqual([approval.id]);
    expect(await seen(cora.id)).toMatchObject({ canSeeDetails: true, canManage: true, ahead: [] });
    await expect(
      cancelAheadApproval({ db: f.db, pubsub: f.pubsub }, cora.id, f.org.id, approval.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await approvalRow(approval.id))?.status).toBe("pending");
  });

  test("canceled on its routine's page before its time: it never runs and its one-off stops", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { approval, runAt, routineId } = await prepared(gateway);
    await decide(approval.id, "approve");
    const view = await cancelAheadApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval.id);
    expect(view).toMatchObject({ status: "canceled", canCancel: false });
    expect(await routineRow(routineId)).toMatchObject({ active: false });
    const [listed] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(listed?.ahead).toEqual([]);
    const run = await routineRun(f, routineId, runAt);
    asked(await invoke(gateway, run, RUN_APPROVED_ACTION, { id: approval.id }));
    expect(mcp.calls).toEqual([]);
  });
});

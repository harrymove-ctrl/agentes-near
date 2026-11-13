import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acceptCustomSuggestion,
  addChannelMember,
  approvalView,
  COMPOSIO_EXECUTOR,
  type CustomDeps,
  connectCustomServer,
  createConnectorToolSource,
  createRole,
  createRoutine,
  createScheduleToolSource,
  createToolGateway,
  decideApproval,
  deleteRoutine,
  type InvokeResult,
  insertMessage,
  type McpConnect,
  mcpSessionOver,
  type RoutineBrief,
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
const WHY = "The weekly summary goes to the team channel every Monday, as the person asked for.";

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
  const gateway = createToolGateway({
    sources: [createConnectorToolSource(deps), createScheduleToolSource({ pubsub: fx.pubsub, context: fx.context })],
  });
  return { mcp, gateway };
}

/** A run `userId` asked for in #general. */
async function personRun(fx: Fixture, userId = fx.owner.id): Promise<ToolContext> {
  const msg = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId },
    body: "@dev toda segunda às 9h manda o resumo da semana no Slack e por email",
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
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

/** The routine's scheduled background run, its brief as the server writes it when it fires. */
async function routineRun(fx: Fixture, routineId: string, creatorUserId = fx.owner.id): Promise<ToolContext> {
  const brief: RoutineBrief = {
    routineId,
    routineRunId: crypto.randomUUID(),
    name: "Resumo da semana",
    creatorUserId,
    deliverTo: { channelId: fx.general.id, threadId: null },
    access: "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
  };
  const msg = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId: creatorUserId },
    body: "Resumo da semana",
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

const exec = (...slugs: string[]) => ({
  tools: slugs.map((tool_slug) => ({ tool_slug, arguments: { channel: "#time", text: "Resumo" } })),
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
const routineRow = async (id: string) =>
  (await f.db.select().from(schema.routines).where(eq(schema.routines.id, id)))[0];

/** The person asks the agent for the routine in the chat, with the actions its job needs. */
async function created(
  gateway: ReturnType<typeof createToolGateway>,
  ownActions: string[],
  prompt = "Manda o resumo da semana no Slack (#time) e por email para a diretoria.",
) {
  const ctx = await personRun(f);
  const out = answered(
    await invoke(gateway, ctx, "create_routine", {
      prompt,
      schedule: "toda segunda às 9h",
      own_actions: ownActions,
    }),
  );
  const id = (out.data?.routine as { id: string } | undefined)?.id;
  if (out.isError || !id) throw new Error(`not created: ${out.content}`);
  return { ctx, out, id };
}

describe("a routine's own job (routines.own_actions)", () => {
  test("a scheduled routine posts to Slack and sends the email it was set up for, without a card", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { ctx, out, id } = await created(gateway, ["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"]);
    // At creation the person hears what it will do on its own, and the receipt carries it.
    expect(out.content).toContain("On its own, without asking, every run may: SLACK_SEND_MESSAGE, GMAIL_SEND_EMAIL");
    expect((await routineRow(id))?.ownActions).toEqual(["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"]);
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId));
    expect(receipt?.params).toMatchObject({ ownActions: ["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"] });

    const run = await routineRun(f, id);
    expect(answered(await invoke(gateway, run, EXEC, exec("SLACK_SEND_MESSAGE"))).isError).toBeFalsy();
    expect(answered(await invoke(gateway, run, EXEC, { ...exec("GMAIL_SEND_EMAIL"), why: WHY })).isError).toBeFalsy();
    expect(
      answered(await invoke(gateway, run, EXEC, exec("SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"))).isError,
    ).toBeFalsy();
    expect(mcp.calls.map((c) => c.args)).toEqual([
      exec("SLACK_SEND_MESSAGE"),
      exec("GMAIL_SEND_EMAIL"),
      exec("SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"),
    ]);
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
  });

  test("an action outside its job still asks, alone or beside one of its own", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { id } = await created(gateway, ["SLACK_SEND_MESSAGE"]);
    const run = await routineRun(f, id);
    asked(await invoke(gateway, run, EXEC, { ...exec("SLACK_DELETE_MESSAGE"), why: WHY }));
    asked(await invoke(gateway, run, EXEC, { ...exec("SLACK_SEND_MESSAGE", "GITHUB_CREATE_AN_ISSUE"), why: WHY }));
    // A tool that runs whatever its input says never counts, even listed.
    await updateRoutine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id, {
      ownActions: ["SLACK_SEND_MESSAGE", WORKBENCH],
    });
    asked(await invoke(gateway, run, `composio_${WORKBENCH}`, { code_to_execute: "print(1)", why: WHY }));
    expect(mcp.calls).toEqual([]);
  });

  test("a deploy always asks: it can't be listed, and a run that tries it gets a card", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const refused = answered(
      await invoke(gateway, await personRun(f), "create_routine", {
        prompt: "Faz o deploy toda segunda.",
        schedule: "toda segunda às 9h",
        own_actions: ["VERCEL_CREATE_NEW_DEPLOYMENT"],
      }),
    );
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("always asks a person");
    expect(await f.db.select().from(schema.routines)).toEqual([]);

    const { id } = await created(gateway, ["SLACK_SEND_MESSAGE"]);
    // Even stored by hand, a deploy or a merge asks at the time.
    await f.db
      .update(schema.routines)
      .set({ ownActions: ["SLACK_SEND_MESSAGE", "VERCEL_CREATE_NEW_DEPLOYMENT", "GITHUB_MERGE_A_PULL_REQUEST"] })
      .where(eq(schema.routines.id, id));
    const run = await routineRun(f, id);
    asked(await invoke(gateway, run, EXEC, { ...exec("VERCEL_CREATE_NEW_DEPLOYMENT"), why: WHY }));
    asked(await invoke(gateway, run, EXEC, { ...exec("GITHUB_MERGE_A_PULL_REQUEST"), why: WHY }));
    expect(mcp.calls).toEqual([]);
  });

  test("only someone who decides the agent's approvals sets them, and losing that right makes the run ask", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    // Cora manages routines but doesn't approve the agent's actions.
    const cora = await addMember(f.db, f.org.id, "member", "cora");
    const role = await createRole(f.db, f.owner.id, f.org.id, { name: "Rotinas", permissions: ["manage_routines"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, cora.id, [role.id]);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: cora.id });
    const input = {
      agentId: f.agent.id,
      prompt: "Manda o resumo no Slack.",
      target: { type: "channel" as const, channelId: f.general.id },
      trigger: { type: "schedule" as const, phrase: "toda segunda às 9h" },
    };
    const deps = { db: f.db, pubsub: f.pubsub, context: f.context };
    await expect(
      createRoutine(deps, cora.id, f.org.id, { ...input, ownActions: ["SLACK_SEND_MESSAGE"] }),
    ).rejects.toMatchObject({ code: "routine.actions_need_approver" });
    const routine = await createRoutine(deps, cora.id, f.org.id, input);
    expect(routine.ownActions).toEqual([]);

    // Stored for her anyway, it doesn't count: she couldn't approve it herself.
    await f.db
      .update(schema.routines)
      .set({ ownActions: ["SLACK_SEND_MESSAGE"] })
      .where(eq(schema.routines.id, routine.id));
    asked(
      await invoke(gateway, await routineRun(f, routine.id, cora.id), EXEC, {
        ...exec("SLACK_SEND_MESSAGE"),
        why: WHY,
      }),
    );
    expect(mcp.calls).toEqual([]);

    // Taking actions away only makes it ask more: she may, and so may an editor who isn't its creator.
    const shrunk = await updateRoutine(deps, cora.id, f.org.id, routine.id, { ownActions: [] });
    expect(shrunk.ownActions).toEqual([]);
    const own = await createRoutine(deps, f.owner.id, f.org.id, { ...input, ownActions: ["SLACK_SEND_MESSAGE"] });
    await expect(
      updateRoutine(deps, cora.id, f.org.id, own.id, { ownActions: ["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"] }),
    ).rejects.toMatchObject({ code: "routine.act_take_over" });
    expect((await updateRoutine(deps, cora.id, f.org.id, own.id, { ownActions: [] })).ownActions).toEqual([]);
  });

  test("a routine with no own actions asks for every write, as before", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { out, id } = await created(gateway, []);
    expect(out.content).toContain("Every action in a connected app asks a person first.");
    asked(await invoke(gateway, await routineRun(f, id), EXEC, { ...exec("SLACK_SEND_MESSAGE"), why: WHY }));
    expect(mcp.calls).toEqual([]);
  });
});

describe('"Sempre nesta rotina": a routine\'s card keeps its kind for that routine', () => {
  const decide = (id: string, userId = f.owner.id) =>
    decideApproval({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, id, { decision: "approve", always: true });

  test("offered on its card; approved, this routine's next runs do it without asking, and no other run does", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const { id } = await created(gateway, ["SLACK_SEND_MESSAGE"]);
    const other = await created(gateway, [], "Manda os números do mês por email.");
    const card = asked(await invoke(gateway, await routineRun(f, id), EXEC, { ...exec("GMAIL_SEND_EMAIL"), why: WHY }));
    expect(card.approveAlways).toEqual({ tool: EXEC, actions: ["GMAIL_SEND_EMAIL"], routineId: id });
    expect(approvalView(card, true).approveAlways).toEqual({
      tool: EXEC,
      actions: ["GMAIL_SEND_EMAIL"],
      routineId: id,
    });

    await decide(card.id);
    expect((await routineRow(id))?.ownActions).toEqual(["SLACK_SEND_MESSAGE", "GMAIL_SEND_EMAIL"]);
    // No rule of the agent: "Aprovado sempre" stays as it was.
    expect(await f.db.select().from(schema.approvalRules)).toEqual([]);
    const audit = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "routine.own_actions_added"));
    expect(audit.map((a) => [a.targetId, a.actorId])).toEqual([[id, f.owner.id]]);

    expect(
      answered(await invoke(gateway, await routineRun(f, id), EXEC, exec("GMAIL_SEND_EMAIL"))).isError,
    ).toBeFalsy();
    expect(mcp.calls.map((c) => c.args)).toEqual([exec("GMAIL_SEND_EMAIL")]);
    // Another routine of the agent still asks.
    asked(await invoke(gateway, await routineRun(f, other.id), EXEC, { ...exec("GMAIL_SEND_EMAIL"), why: WHY }));
    // Undone in the routine's settings: it asks at once.
    await updateRoutine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id, {
      ownActions: ["SLACK_SEND_MESSAGE"],
    });
    asked(await invoke(gateway, await routineRun(f, id), EXEC, { ...exec("GMAIL_SEND_EMAIL"), why: WHY }));
  });

  test.each([
    ["a merge", "GITHUB_MERGE_A_PULL_REQUEST"],
    ["a deploy", "VERCEL_CREATE_NEW_DEPLOYMENT"],
    ["a deletion", "SLACK_DELETE_MESSAGE"],
    ["a removal", "NOTION_REMOVE_PAGE"],
    ["a payment", "STRIPE_CREATE_PAYMENT_INTENT"],
    ["a refund", "STRIPE_CREATE_REFUND"],
  ])("never covers %s: the card still asks, without the button", async (_kind, slug) => {
    f = await setup();
    const { gateway } = await world(f);
    const { id } = await created(gateway, []);
    const card = asked(await invoke(gateway, await routineRun(f, id), EXEC, { ...exec(slug), why: WHY }));
    expect(card.approveAlways).toBeNull();
  });

  test("beside an action it never covers, the whole call goes without the button", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const { id } = await created(gateway, []);
    const input = { ...exec("SLACK_SEND_MESSAGE", "SLACK_DELETE_MESSAGE"), why: WHY };
    expect(asked(await invoke(gateway, await routineRun(f, id), EXEC, input)).approveAlways).toBeNull();
  });

  test.each(["GMAIL_MOVE_TO_TRASH", "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST", "GOOGLEDOMAINS_RENEW_DOMAIN"])(
    "not for %s: lost data, money or a pull request's approval",
    async (action) => {
      f = await setup();
      const { gateway } = await world(f);
      const { id } = await created(gateway, []);
      const input = { ...exec(action), why: WHY };
      expect(asked(await invoke(gateway, await routineRun(f, id), EXEC, input)).approveAlways).toBeNull();
    },
  );

  test("not when the routine's creator no longer decides the agent's approvals: own actions would still ask", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const cora = await addMember(f.db, f.org.id, "member", "cora");
    const { id } = await created(gateway, []);
    await f.db.update(schema.routines).set({ createdByUserId: cora.id }).where(eq(schema.routines.id, id));
    const card = asked(
      await invoke(gateway, await routineRun(f, id), EXEC, { ...exec("SLACK_SEND_MESSAGE"), why: WHY }),
    );
    expect(card.approveAlways).toBeNull();
  });

  test("not on a routine that has no room left", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const { id } = await created(
      gateway,
      Array.from({ length: 20 }, (_, i) => `SLACK_ACTION_${i}`),
    );
    const card = asked(
      await invoke(gateway, await routineRun(f, id), EXEC, { ...exec("SLACK_SEND_MESSAGE"), why: WHY }),
    );
    expect(card.approveAlways).toBeNull();
  });

  test("a routine deleted while it waited: the decision fails and nothing is approved", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const { id } = await created(gateway, []);
    const card = asked(
      await invoke(gateway, await routineRun(f, id), EXEC, { ...exec("SLACK_SEND_MESSAGE"), why: WHY }),
    );
    await deleteRoutine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    await expect(decide(card.id)).rejects.toMatchObject({ code: "approval.always_unavailable" });
    const [row] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.id, card.id));
    expect(row?.status).toBe("pending");
  });

  test("someone covering for its owner can't use it: approving for good is never in someone else's name", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const { id } = await created(gateway, []);
    const card = asked(
      await invoke(gateway, await routineRun(f, id), EXEC, { ...exec("SLACK_SEND_MESSAGE"), why: WHY }),
    );
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await expect(decide(card.id, bob.id)).rejects.toThrow();
    expect((await routineRow(id))?.ownActions).toEqual([]);
  });
});

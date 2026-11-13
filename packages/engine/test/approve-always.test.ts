import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acceptCustomSuggestion,
  actionLevel,
  COMMAND_RULE_TOOL,
  COMPOSIO_EXECUTOR,
  ConflictError,
  type CustomDeps,
  composioActions,
  connectCustomServer,
  connectorGrantValidator,
  createAgent,
  createConnectorToolSource,
  createToolGateway,
  decideApproval,
  deleteAgent,
  ForbiddenError,
  grantScopes,
  type InvokeResult,
  insertMessage,
  listApprovalRules,
  type McpConnect,
  mcpSessionOver,
  type RoutineBrief,
  removeApprovalRule,
  revokeConnection,
  saveCustomTools,
  setAgentAccess,
  setAgentScopes,
  sqlArgOf,
  type ToolContext,
  type ToolSource,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("what an action named by its slug does", () => {
  test("reads only when the verb after the app reads and nothing else acts; sensitive on any sensitive word; else a write", () => {
    const cases: [string, ReturnType<typeof actionLevel>][] = [
      ["GITHUB_LIST_PULL_REQUESTS", "read"],
      ["GITHUB_GET_A_PULL_REQUEST", "read"],
      ["GITHUB_SEARCH_REPOSITORIES", "read"],
      ["GITHUB_LIST_DEPLOYMENTS", "read"],
      // "open" is a verb of its own: it may open something, so it isn't taken as a read.
      ["GITHUB_LIST_OPEN_ISSUES", "write"],
      ["GITHUB_CREATE_AN_ISSUE_COMMENT", "write"],
      ["GITHUB_CREATE_A_DEPLOYMENT", "write"],
      ["SLACK_CHANNELS", "write"],
      ["LINEAR_GET_PROMOTE_STATUS", "write"],
      // A read verb elsewhere in the slug, or a query that may change (GraphQL mutations, SQL), is no read.
      ["SHOPIFY_GRAPH_QL_QUERY", "write"],
      ["GOOGLEBIGQUERY_QUERY", "write"],
      ["GOOGLESHEETS_FIND_REPLACE", "write"],
      ["CLOUDFLARE_REPLACE_LIST_ITEMS", "write"],
      ["GITHUB_REREQUEST_A_CHECK_SUITE", "write"],
      ["GITHUB_MARK_NOTIFICATIONS_AS_READ", "write"],
      ["X_LIST_AND_DELETE_Y", "sensitive"],
      ["GITHUB_MERGE_A_PULL_REQUEST", "sensitive"],
      ["GMAIL_SEND_EMAIL", "sensitive"],
      ["GOOGLEDRIVE_SHARE_FILE", "sensitive"],
      // Sends, deletes and payments in other forms and words.
      ["SLACK_DELETES_A_MESSAGE_FROM_A_CHAT", "sensitive"],
      ["SLACK_CHAT_POST_MESSAGE", "sensitive"],
      ["SLACK_SCHEDULE_MESSAGE", "sensitive"],
      ["GMAIL_REPLY_TO_THREAD", "sensitive"],
      ["GMAIL_FORWARD_MESSAGE", "sensitive"],
      ["GOOGLEDRIVE_EMPTY_TRASH", "sensitive"],
      ["SLACK_INVITE_USER_TO_WORKSPACE", "sensitive"],
      ["VERCEL_BUY_DOMAINS", "sensitive"],
      ["VERCEL_RENEW_DOMAIN", "sensitive"],
      ["SHOPIFY_CREATE_ONE_TIME_APPLICATION_CHARGE", "sensitive"],
    ];
    expect(cases.map(([slug]) => [slug, actionLevel(slug)])).toEqual(cases);
  });
});

describe("the actions one call of Composio's executor runs", () => {
  const item = (tool_slug: string, args: unknown = { owner: "acme" }) => ({ tool_slug, arguments: args });
  test("only the documented shape: its slugs, each once; anything else says nothing (null)", () => {
    const cases: [Record<string, unknown>, string[] | null][] = [
      [
        { tools: [item("GITHUB_LIST_PULL_REQUESTS")], sync_response_to_workbench: false },
        ["GITHUB_LIST_PULL_REQUESTS"],
      ],
      [
        {
          tools: [
            item("GITHUB_LIST_PULL_REQUESTS"),
            { tool_slug: "GITHUB_GET_A_PULL_REQUEST" },
            item("GITHUB_LIST_PULL_REQUESTS"),
          ],
          thought: "Reading the open pull requests",
          sync_response_to_workbench: false,
          current_step: "FETCHING_PRS",
          current_step_metric: "1/2 repos",
          session_id: "s-1",
        },
        ["GITHUB_LIST_PULL_REQUESTS", "GITHUB_GET_A_PULL_REQUEST"],
      ],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS")], sync_response_to_workbench: false, why: "x" }, null],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS")], sync_response_to_workbench: "no" }, null],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS")], thought: 3 }, null],
      [{ tools: [], sync_response_to_workbench: false }, null],
      [{ tools: Array.from({ length: 51 }, () => item("GITHUB_LIST_PULL_REQUESTS")) }, null],
      [{ tools: item("GITHUB_LIST_PULL_REQUESTS") }, null],
      [{ sync_response_to_workbench: false }, null],
      [{ tools: [{ ...item("GITHUB_LIST_PULL_REQUESTS"), retries: 2 }] }, null],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS", ["acme"])] }, null],
      [{ tools: [item("github_list_pull_requests")] }, null],
      [{ tools: [item("LIST")] }, null],
      [{ tools: [item(`GITHUB_${"X".repeat(130)}`)] }, null],
      [{ tools: [item("COMPOSIO_REMOTE_WORKBENCH")] }, null],
      [{ tools: [item("GITHUB_LIST_PULL_REQUESTS"), "GITHUB_GET_A_PULL_REQUEST"] }, null],
    ];
    expect(cases.map(([input]) => composioActions(input))).toEqual(cases.map(([, out]) => out));
  });
});

// ── Through the Tool Gateway, with an in-process server shaped like Composio's ──────────────────────────

const WORKBENCH = "COMPOSIO_REMOTE_WORKBENCH";
const PROXY = "COMPOSIO_PROXY_EXECUTE";
const EXEC = `composio_${COMPOSIO_EXECUTOR}`;
const WHY = "The reporter is waiting on this issue: a short note tells them the team is on it.";

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
          current_step: z.string().optional(),
          current_step_metric: z.string().optional(),
          session_id: z.string().optional(),
        },
        annotations: { destructiveHint: true },
      },
      async (args) => {
        calls.push({ tool: COMPOSIO_EXECUTOR, args });
        return text(`ran ${args.tools.map((t) => t.tool_slug).join(", ")}`);
      },
    );
    // No annotation: it asks because we name it, not because the server says so.
    server.registerTool(
      WORKBENCH,
      { description: "Runs Python in a sandbox", inputSchema: { code_to_execute: z.string() } },
      async (args) => {
        calls.push({ tool: WORKBENCH, args });
        return text("done");
      },
    );
    server.registerTool(
      PROXY,
      {
        description: "Sends a raw HTTP request to a connected app's own API",
        inputSchema: { toolkit_slug: z.string(), endpoint: z.string(), method: z.string() },
        annotations: { openWorldHint: true },
      },
      async (args) => {
        calls.push({ tool: PROXY, args });
        return text("204");
      },
    );
    server.registerTool(
      "close_ticket",
      { description: "Close a ticket", inputSchema: { id: z.number() } },
      async (args) => {
        calls.push({ tool: "close_ticket", args });
        return text(`closed #${args.id}`);
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

/** A Composio server connected by address and its suggestions accepted: every agent's, whole (`connector:*`). */
async function composio(fx: Fixture, mcp: ReturnType<typeof composioMcp>, label = "Composio") {
  const deps: CustomDeps = {
    db: fx.db,
    keyWrappers: [fx.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect: mcp.connect,
  };
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
    serverUrl: `https://backend.composio.dev/v3/mcp/${label.toLowerCase().replace(/\W+/g, "-")}`,
    apiKey: "ck_fake_key_for_tests",
    label,
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, started.server.id);
  return { deps, serverId: started.server.id };
}

/** A server connected by address, like Higgsfield's: one tool that makes images, and others that must always ask. */
function imageMcp() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const build = () => {
    const server = new McpServer({ name: "images", version: "1" });
    const add = (name: string, description: string, inputSchema: Record<string, z.ZodType>) =>
      server.registerTool(name, { description, inputSchema }, async (args) => {
        calls.push({ tool: name, args });
        return { content: [{ type: "text" as const, text: "ok" }] };
      });
    add("generate_image", "Makes an image from a prompt, spending credits", { prompt: z.string() });
    add("deploy_site", "Publishes the site", { site: z.string() });
    add("run_script", "Runs a script", { code: z.string() });
    add("delete_image", "Deletes an image", { id: z.string() });
    return server;
  };
  const connect: McpConnect = async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await build().connect(server);
    return mcpSessionOver(client);
  };
  return { connect, calls };
}

/** Any server connected by address with its suggestions accepted (each undecided tool asks first). */
async function connectServer(fx: Fixture, mcp: { connect: McpConnect }, label: string, serverUrl: string) {
  const deps: CustomDeps = {
    db: fx.db,
    keyWrappers: [fx.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect: mcp.connect,
  };
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
    serverUrl,
    apiKey: "fake_key_for_tests",
    label,
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, started.server.id);
  return { deps, serverId: started.server.id };
}

async function world(fx: Fixture) {
  const mcp = composioMcp();
  const server = await composio(fx, mcp);
  const gateway = createToolGateway({ sources: [createConnectorToolSource(server.deps)] });
  return { mcp, gateway, ...server };
}

/** A run of `agentId` a person asked for (or a routine's, with its brief), to call tools in. */
async function runOf(fx: Fixture, agentId = fx.agent.id, routine?: RoutineBrief): Promise<ToolContext> {
  const msg = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "person", userId: fx.owner.id },
    body: "@dev olha os PRs da acme/app",
    meta: routine ? { routineBrief: routine, background: true } : {},
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      background: Boolean(routine),
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

const exec = (...slugs: string[]) => ({
  tools: slugs.map((tool_slug, i) => ({ tool_slug, arguments: { owner: "acme", repo: "app", issue_number: 40 + i } })),
  sync_response_to_workbench: false,
});

let seq = 0;
const invoke = (gateway: ReturnType<typeof createToolGateway>, ctx: ToolContext, name: string, input: object) =>
  gateway.invoke(ctx, { toolUseId: `call-${++seq}`, name, input: input as Record<string, unknown> });

function asked(result: InvokeResult) {
  if (result.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(result)}`);
  return result.approval;
}

const toolCalls = async (fx: Fixture) =>
  (
    await fx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "tool.call"))
      .orderBy(schema.auditLog.createdAt, schema.auditLog.id)
  ).map((r) => ({
    outcome: r.outcome,
    kind: r.details.kind,
    approvalRules: r.details.approvalRules,
  }));
const rules = (fx: Fixture) => fx.db.select().from(schema.approvalRules);
const decide = (fx: Fixture, actorId: string, approvalId: string, input: Parameters<typeof decideApproval>[4]) =>
  decideApproval({ db: fx.db, pubsub: fx.pubsub }, actorId, fx.org.id, approvalId, input);

describe("reads through Composio's executor", () => {
  test("all reads run as the server's reads: no approval and no why needed, audited as reads", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    const ctx = await runOf(f);
    const read = await invoke(gateway, ctx, EXEC, {
      ...exec("GITHUB_LIST_PULL_REQUESTS", "GITHUB_GET_A_PULL_REQUEST"),
      why: WHY,
    });
    expect(read.type).toBe("result");
    // The `why` is ours: the server never sees it.
    expect(mcp.calls).toEqual([
      { tool: COMPOSIO_EXECUTOR, args: exec("GITHUB_LIST_PULL_REQUESTS", "GITHUB_GET_A_PULL_REQUEST") },
    ]);
    expect((await invoke(gateway, ctx, EXEC, exec("GITHUB_SEARCH_REPOSITORIES"))).type).toBe("result");
    expect(mcp.calls).toHaveLength(2);
    expect(await f.db.select().from(schema.approvals)).toEqual([]);
    expect(await toolCalls(f)).toEqual([
      { outcome: "done", kind: "read", approvalRules: undefined },
      { outcome: "done", kind: "read", approvalRules: undefined },
    ]);
  });

  test("an agent that may only write to the server, a write, a merge or an unknown shape asks as before", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const ctx = await runOf(f);
    const write = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    expect(write.title).toBe("Composio: GITHUB_CREATE_AN_ISSUE_COMMENT");
    expect(write.approveAlways).toEqual({ tool: COMPOSIO_EXECUTOR, actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"] });
    // A read next to a write is not a read.
    const mixed = asked(
      await invoke(gateway, ctx, EXEC, {
        ...exec("GITHUB_LIST_PULL_REQUESTS", "GITHUB_CREATE_AN_ISSUE_COMMENT"),
        why: WHY,
      }),
    );
    expect(mixed.approveAlways?.actions).toEqual(["GITHUB_LIST_PULL_REQUESTS", "GITHUB_CREATE_AN_ISSUE_COMMENT"]);
    // Not a shape we know: nothing is guessed, and nothing can be approved for good.
    for (const input of [
      { tools: [{ tool_slug: "github_list_pull_requests", arguments: {} }], sync_response_to_workbench: false },
      exec("GITHUB_LIST_PULL_REQUESTS", WORKBENCH),
    ]) {
      expect(asked(await invoke(gateway, ctx, EXEC, { ...input, why: WHY })).approveAlways).toBeNull();
    }
    // Write alone on the server: its reads aren't the agent's.
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ connectionId: serverId, scope: `custom:${serverId}:write` }],
      connectorGrantValidator,
    );
    asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_LIST_PULL_REQUESTS"), why: WHY }));
    expect(mcp.calls).toEqual([]);
  });

  test("a routine's reads run; its writes always ask and are never approved for good", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const brief: RoutineBrief = {
      routineId: crypto.randomUUID(),
      routineRunId: crypto.randomUUID(),
      name: "Revisar PRs",
      creatorUserId: f.owner.id,
      deliverTo: { channelId: f.general.id, threadId: null },
      access: "act",
      report: "when_new",
      trigger: "schedule",
      dueAt: new Date().toISOString(),
    };
    const ctx = await runOf(f, f.agent.id, brief);
    expect((await invoke(gateway, ctx, EXEC, exec("GITHUB_LIST_PULL_REQUESTS"))).type).toBe("result");
    await f.db.insert(schema.approvalRules).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      connectionId: serverId,
      tool: COMPOSIO_EXECUTOR,
      action: "GITHUB_CREATE_AN_ISSUE_COMMENT",
    });
    const write = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    expect(write.approveAlways).toBeNull();
    expect(mcp.calls.map((c) => c.tool)).toEqual([COMPOSIO_EXECUTOR]);
  });
});

describe("Aprovar sempre", () => {
  test("asks once, then not for the same kind with any values; asks for another action, tool, agent or server", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await grantScopes(f.db, f.org.id, other.id, [{ connectionId: serverId, scope: "connector:*" }]);
    const ctx = await runOf(f);
    const first = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    const view = await decide(f, f.owner.id, first.id, { decision: "approve", always: true });
    expect(view).toMatchObject({ status: "approved" });
    expect((await rules(f)).map((r) => [r.agentId, r.connectionId, r.tool, r.action, r.createdByUserId])).toEqual([
      [f.agent.id, serverId, COMPOSIO_EXECUTOR, "GITHUB_CREATE_AN_ISSUE_COMMENT", f.owner.id],
    ]);
    const [approved] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.approved"));
    expect(approved?.details.always).toEqual({
      connectionId: serverId,
      tool: COMPOSIO_EXECUTOR,
      actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"],
    });

    // The same kind, other values, no why: it runs, and the audit says which rule let it.
    const again = await invoke(gateway, ctx, EXEC, {
      tools: [{ tool_slug: "GITHUB_CREATE_AN_ISSUE_COMMENT", arguments: { issue_number: 7, body: "Outro texto" } }],
      sync_response_to_workbench: false,
    });
    expect(again.type).toBe("result");
    expect(mcp.calls.at(-1)?.args.tools).toEqual([
      { tool_slug: "GITHUB_CREATE_AN_ISSUE_COMMENT", arguments: { issue_number: 7, body: "Outro texto" } },
    ]);
    const [rule] = await rules(f);
    expect((await toolCalls(f)).at(-1)).toEqual({ outcome: "done", kind: "external", approvalRules: [rule?.id] });
    expect(await f.db.select().from(schema.approvals)).toHaveLength(1);

    // Another action, or one more beside it, asks.
    asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE"), why: WHY }));
    asked(
      await invoke(gateway, ctx, EXEC, {
        ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT", "GITHUB_ADD_LABELS_TO_AN_ISSUE"),
        why: WHY,
      }),
    );
    // Another tool of the same server asks.
    asked(await invoke(gateway, ctx, "composio_close_ticket", { id: 1, why: WHY }));
    // Another agent asks.
    asked(
      await invoke(gateway, await runOf(f, other.id), EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }),
    );
    // Another Composio account asks.
    await composio(f, mcp, "Composio Two");
    asked(
      await invoke(gateway, ctx, `composio_two_${COMPOSIO_EXECUTOR}`, {
        ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"),
        why: WHY,
      }),
    );
    expect(mcp.calls).toHaveLength(1);
  });

  test("merge, deploy, workflows, sends, GraphQL and SQL are never offered nor honoured, even with a rule in the table", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const ctx = await runOf(f);
    for (const slug of [
      "GITHUB_MERGE_A_PULL_REQUEST",
      "GITHUB_CREATE_A_DEPLOYMENT",
      "GITHUB_CREATE_A_WORKFLOW_DISPATCH_EVENT",
      "VERCEL_PROMOTE_A_DEPLOYMENT",
      "GMAIL_SEND_EMAIL",
      "SLACK_CHAT_POST_MESSAGE",
      // Under other names: a dispatch starts workflows, a reference moves a branch, a release or an alias deploys.
      "GITHUB_CREATE_A_REPOSITORY_DISPATCH_EVENT",
      "GITHUB_UPDATE_A_REFERENCE",
      "GITHUB_CREATE_A_RELEASE",
      "VERCEL_ASSIGN_ALIAS",
      "VERCEL_START_ROLLING_RELEASE",
      "RAILWAY_COMMIT_ENVIRONMENT_CHANGES",
      "SUPABASE_RESTORE_PITR_BACKUP",
      // What their arguments say: a GraphQL mutation can merge, SQL can drop a table, a command can do anything.
      "GITHUB_RUN_GRAPH_QL_QUERY",
      "SUPABASE_BETA_RUN_SQL_QUERY",
      "CLOUDFLARE_EXECUTE_D1_QUERY",
      "VERCEL_EXECUTE_SANDBOX_COMMAND",
    ]) {
      await f.db.insert(schema.approvalRules).values({
        orgId: f.org.id,
        agentId: f.agent.id,
        connectionId: serverId,
        tool: COMPOSIO_EXECUTOR,
        action: slug,
      });
      const ask = asked(await invoke(gateway, ctx, EXEC, { ...exec(slug), why: WHY }));
      expect({ slug, offered: ask.approveAlways }).toEqual({ slug, offered: null });
      await expect(decide(f, f.owner.id, ask.id, { decision: "approve", always: true })).rejects.toMatchObject({
        code: "approval.always_unavailable",
      });
    }
    expect(mcp.calls).toEqual([]);
    // A pull request, its labels or a commit's comment still may be.
    for (const slug of [
      "GITHUB_CREATE_A_PULL_REQUEST",
      "GITHUB_ADD_LABELS_TO_AN_ISSUE",
      "GITHUB_CREATE_A_COMMIT_COMMENT",
    ]) {
      const ask = asked(await invoke(gateway, ctx, EXEC, { ...exec(slug), why: WHY }));
      expect(ask.approveAlways).toEqual({ tool: COMPOSIO_EXECUTOR, actions: [slug] });
    }
  });

  test("the workbench and the proxy always ask, even set to write, and are never offered", async () => {
    f = await setup();
    const { mcp, gateway, deps, serverId } = await world(f);
    await saveCustomTools(deps, f.owner.id, f.org.id, serverId, {
      label: "Composio",
      tools: [
        { name: WORKBENCH, access: "write", label: "Workbench" },
        { name: PROXY, access: "write", label: "Proxy" },
      ],
    });
    const ctx = await runOf(f);
    const calls: [string, Record<string, unknown>][] = [
      [WORKBENCH, { code_to_execute: "print(1)" }],
      [PROXY, { toolkit_slug: "github", endpoint: "/repos/acme/app/pulls/12/merge", method: "PUT" }],
    ];
    for (const [tool, input] of calls) {
      const ask = asked(await invoke(gateway, ctx, `composio_${tool}`, { ...input, why: WHY }));
      expect({ tool, offered: ask.approveAlways }).toEqual({ tool, offered: null });
    }
    expect(mcp.calls).toEqual([]);
  });

  test("a plain tool of the server is one action: approved for good, that agent runs it with any values", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const ctx = await runOf(f);
    const ask = asked(await invoke(gateway, ctx, "composio_close_ticket", { id: 1, why: WHY }));
    expect(ask.approveAlways).toEqual({ tool: "close_ticket", actions: [] });
    await decide(f, f.owner.id, ask.id, { decision: "approve", always: true });
    expect((await rules(f)).map((r) => [r.agentId, r.tool, r.action])).toEqual([[f.agent.id, "close_ticket", ""]]);
    expect((await invoke(gateway, ctx, "composio_close_ticket", { id: 2, why: WHY })).type).toBe("result");
    // The first runs when the run resumes; the second ran at once, without asking.
    expect(mcp.calls.map((c) => c.args)).toEqual([{ id: 2 }]);
    // Another agent of the workspace still asks.
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await grantScopes(f.db, f.org.id, other.id, [{ connectionId: serverId, scope: "connector:*" }]);
    asked(await invoke(gateway, await runOf(f, other.id), "composio_close_ticket", { id: 3, why: WHY }));
  });

  test("a custom server's tool asking because of its level is offered: deploys, deletes and code runners never", async () => {
    f = await setup();
    const mcp = imageMcp();
    const server = await connectServer(f, mcp, "Higgsfield", "https://mcp.higgsfield.example/mcp");
    const gateway = createToolGateway({ sources: [createConnectorToolSource(server.deps)] });
    const ctx = await runOf(f);
    const ask = asked(await invoke(gateway, ctx, "higgsfield_generate_image", { prompt: "capa", why: WHY }));
    expect(ask.approveAlways).toEqual({ tool: "generate_image", actions: [] });
    await decide(f, f.owner.id, ask.id, { decision: "approve", always: true });
    expect((await invoke(gateway, ctx, "higgsfield_generate_image", { prompt: "outra", why: WHY })).type).toBe(
      "result",
    );
    for (const [tool, input] of [
      ["deploy_site", { site: "loja" }],
      ["run_script", { code: "rm -rf /" }],
      ["delete_image", { id: "img-1" }],
    ] as const) {
      const other = asked(await invoke(gateway, ctx, `higgsfield_${tool}`, { ...input, why: WHY }));
      expect({ tool, offered: other.approveAlways }).toEqual({ tool, offered: null });
    }
    expect(mcp.calls.map((c) => c.tool)).toEqual(["generate_image"]);
  });

  test("a rule is kept by the server's own tool name: it outlives a renamed connection", async () => {
    f = await setup();
    const { mcp, gateway, deps, serverId } = await world(f);
    const ctx = await runOf(f);
    const ask = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    await decide(f, f.owner.id, ask.id, { decision: "approve", always: true });
    await saveCustomTools(deps, f.owner.id, f.org.id, serverId, { label: "Cmposio", tools: [] });
    // Renaming never renames tools (ADR 0099): the same name runs, and the rule still covers it.
    expect((await invoke(gateway, ctx, EXEC, exec("GITHUB_CREATE_AN_ISSUE_COMMENT"))).type).toBe("result");
    expect(mcp.calls.map((c) => c.tool)).toEqual([COMPOSIO_EXECUTOR]);
    expect(await listApprovalRules(f.db, f.owner.id, f.org.id, f.agent.id)).toMatchObject([
      { connectionId: serverId, server: "Cmposio", tool: COMPOSIO_EXECUTOR, action: "GITHUB_CREATE_AN_ISSUE_COMMENT" },
    ]);
  });

  test("a run nobody is behind asks as a person's run would, and a rule approved for good covers it too", async () => {
    f = await setup();
    const { mcp, gateway } = await world(f);
    // An agent's own line woke it: nobody is behind the run, and it works as the agent itself.
    const line = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Lembrete: responder no #40",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: line.id,
        triggerMessageId: line.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id ?? "",
      channelId: f.general.id,
      threadRootId: line.id,
      triggerMessageId: line.id,
    };
    const first = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    expect(first.origin).toEqual({ kind: "unattended" });
    expect(first.approveAlways).not.toBeNull();
    await decide(f, f.owner.id, first.id, { decision: "approve", always: true });
    // The same kind again runs at once (the approved call itself runs when its run resumes).
    expect((await invoke(gateway, ctx, EXEC, exec("GITHUB_CREATE_AN_ISSUE_COMMENT"))).type).toBe("result");
    expect(mcp.calls.map((c) => c.tool)).toEqual([COMPOSIO_EXECUTOR]);
  });

  test("only who decides the agent's approvals approves for good, and only where it's offered", async () => {
    f = await setup();
    const { gateway } = await world(f);
    const member = await addMember(f.db, f.org.id, "member", "bia");
    const ctx = await runOf(f);
    const ask = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    await expect(decide(f, member.id, ask.id, { decision: "approve", always: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(decide(f, f.owner.id, ask.id, { decision: "refuse", always: true })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await rules(f)).toEqual([]);
    // The agent's owner decides it even when they aren't an admin.
    await f.db.update(schema.agents).set({ ownerUserId: member.id }).where(eq(schema.agents.id, f.agent.id));
    const theirs = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
    await decide(f, member.id, theirs.id, { decision: "approve", always: true });
    expect((await rules(f)).map((r) => r.createdByUserId)).toEqual([member.id]);
  });

  test("removed, it asks again at once; without the scope it does nothing; it goes with the server or the agent", async () => {
    f = await setup();
    const { mcp, gateway, serverId } = await world(f);
    const ctx = await runOf(f);
    const always = async () => {
      const ask = asked(await invoke(gateway, ctx, EXEC, { ...exec("GITHUB_CREATE_AN_ISSUE_COMMENT"), why: WHY }));
      await decide(f, f.owner.id, ask.id, { decision: "approve", always: true });
    };
    await always();
    const [rule] = await listApprovalRules(f.db, f.owner.id, f.org.id, f.agent.id);
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await expect(removeApprovalRule(f.db, member.id, f.org.id, f.agent.id, rule?.id ?? "")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await removeApprovalRule(f.db, f.owner.id, f.org.id, f.agent.id, rule?.id ?? "");
    const removed = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.approval_rule_removed"), eq(schema.auditLog.targetId, f.agent.id)));
    expect(removed.map((r) => r.details)).toEqual([
      { connectionId: serverId, tool: COMPOSIO_EXECUTOR, action: "GITHUB_CREATE_AN_ISSUE_COMMENT" },
    ]);
    await always();

    // Without access to the server, a rule gives nothing: the call is refused before any rule is read.
    const none = { all: false, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, none);
    const refused = await invoke(gateway, ctx, EXEC, exec("GITHUB_CREATE_AN_ISSUE_COMMENT"));
    expect(refused).toMatchObject({ type: "result", output: { isError: true } });
    expect(mcp.calls).toEqual([]);
    expect(await rules(f)).toHaveLength(1);

    // Deleting the agent takes its rules; disconnecting the server takes every agent's.
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db
      .insert(schema.approvalRules)
      .values({ orgId: f.org.id, agentId: other.id, connectionId: serverId, tool: "close_ticket", action: "" });
    await deleteAgent({ db: f.db, pubsub: f.pubsub, hub: f.machineHub }, f.owner.id, f.org.id, other.id);
    expect((await rules(f)).map((r) => r.agentId)).toEqual([f.agent.id]);
    await revokeConnection(f.db, f.owner.id, f.org.id, serverId);
    expect(await rules(f)).toEqual([]);
  });
});

// ── "Aprovar sempre leituras": a server's tool that runs SQL (shaped like Supabase's execute_sql) ──────────────

function sqlMcp() {
  const calls: Record<string, unknown>[] = [];
  const connect: McpConnect = async () => {
    const server = new McpServer({ name: "db", version: "1" });
    server.registerTool(
      "execute_sql",
      { description: "Runs SQL on a Postgres project", inputSchema: { project_id: z.string(), query: z.string() } },
      async (args) => {
        calls.push(args);
        return { content: [{ type: "text" as const, text: "[]" }] };
      },
    );
    const [client, transport] = InMemoryTransport.createLinkedPair();
    await server.connect(transport);
    return mcpSessionOver(client);
  };
  return { connect, calls };
}

async function sqlWorld(fx: Fixture) {
  const mcp = sqlMcp();
  const deps: CustomDeps = {
    db: fx.db,
    keyWrappers: [fx.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect: mcp.connect,
  };
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
    serverUrl: "https://db.example.com/mcp",
    apiKey: "fake-key-for-tests",
    label: "Banco",
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, started.server.id);
  const gateway = createToolGateway({ sources: [createConnectorToolSource(deps)] });
  return { mcp, gateway, serverId: started.server.id, name: "banco_execute_sql" };
}

const READ = "select status, count(*) from orders group by 1";
const sql = (query: string, project_id = "proj-a") => ({ project_id, query, why: WHY });

describe("Aprovar sempre leituras", () => {
  test("offered only on Postgres: a known preset's tool, or a custom one that says Postgres and no other engine", () => {
    const tool = (name: string, description: string, ...args: string[]) => ({
      name,
      description,
      inputSchema: { properties: Object.fromEntries(args.map((a) => [a, { type: "string" }])) },
    });
    const cases: [string, ReturnType<typeof tool>, string | null, string | null][] = [
      ["supabase", tool("execute_sql", "Runs SQL", "project_id", "query"), "supabase", "query"],
      ["supabase-readonly", tool("execute_sql", "Runs SQL", "project_id", "query"), "supabase-readonly", "query"],
      ["neon", tool("run_sql", "Runs SQL", "projectId", "sql"), "neon", "sql"],
      ["preset, other tool", tool("list_tables", "Lists tables", "query"), "supabase", null],
      ["preset not Postgres", tool("run_sql", "Runs SQL", "sql"), "github", null],
      ["custom Postgres", tool("query", "Run a read-only query on PostgreSQL", "sql"), null, "sql"],
      ["custom, no engine named", tool("run_sql", "Runs SQL", "sql"), null, null],
      ["custom MySQL", tool("mysql_query", "Runs SQL on MySQL", "sql"), null, null],
      ["custom MySQL by name only", tool("mysql_query", "Runs SQL", "sql"), null, null],
      ["custom, Postgres and MySQL", tool("run_sql", "Postgres or MySQL", "sql"), null, null],
      ["custom GraphQL", tool("graphql_query", "Postgres GraphQL", "query"), null, null],
    ];
    expect(cases.map(([what, t, preset]) => [what, sqlArgOf(t, preset)])).toEqual(
      cases.map(([what, , , arg]) => [what, arg]),
    );
  });

  test("offered only on SQL proven read-only; it then runs that project's reads and still asks for anything else", async () => {
    f = await setup();
    const { mcp, gateway, serverId, name } = await sqlWorld(f);
    const ctx = await runOf(f);
    const write = asked(await invoke(gateway, ctx, name, sql("delete from orders")));
    expect(write.approveAlways).toBeNull();
    const read = asked(await invoke(gateway, ctx, name, sql(READ)));
    expect(read.approveAlways).toEqual({ tool: "execute_sql", actions: ["sql-read:project_id=proj-a"] });
    await decide(f, f.owner.id, read.id, { decision: "approve", always: true });
    expect((await rules(f)).map((r) => [r.connectionId, r.tool, r.action, r.createdByUserId])).toEqual([
      [serverId, "execute_sql", "sql-read:project_id=proj-a", f.owner.id],
    ]);

    // Another read of that project, without a why: it runs, and its line says who approved reads for good.
    const ran = await invoke(gateway, ctx, name, { project_id: "proj-a", query: "select count(*) from customers" });
    expect(ran.type === "result" && ran.autoApproved).toEqual({ by: f.owner.name, reads: true });
    expect(mcp.calls).toEqual([{ project_id: "proj-a", query: "select count(*) from customers" }]);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, ctx.runId));
    const result = steps.filter((s) => s.kind === "tool_result").at(-1);
    expect(result?.data.autoApproved).toEqual({ by: f.owner.name, reads: true });

    // A write, a read with a side effect, or another project: it asks.
    for (const input of [
      sql("with d as (delete from orders returning id) select count(*) from d"),
      sql("select nextval('orders_id_seq')"),
      sql("select 1; update orders set status = 'x'"),
      sql(READ, "proj-b"),
    ]) {
      expect((await invoke(gateway, ctx, name, input)).type).toBe("approval");
    }
    expect(mcp.calls).toHaveLength(1);
  });

  test("only who decides makes or removes it; a new owner is asked again", async () => {
    f = await setup();
    const { gateway, name } = await sqlWorld(f);
    const member = await addMember(f.db, f.org.id, "member", "bia");
    const ctx = await runOf(f);
    const ask = asked(await invoke(gateway, ctx, name, sql(READ)));
    await expect(decide(f, member.id, ask.id, { decision: "approve", always: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await decide(f, f.owner.id, ask.id, { decision: "approve", always: true });
    const [rule] = await listApprovalRules(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(rule?.action).toBe("sql-read:project_id=proj-a");
    await expect(removeApprovalRule(f.db, member.id, f.org.id, f.agent.id, rule?.id ?? "")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // Handing the agent to someone else drops what the old owner approved for good, and says so in the audit.
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: member.id });
    expect(await rules(f)).toEqual([]);
    const removed = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.approval_rule_removed"));
    expect(removed.map((r) => r.details.reason)).toEqual(["owner_changed"]);
    expect((await invoke(gateway, ctx, name, sql(READ))).type).toBe("approval");
  });
  test("after the agent changed hands its old owner no longer decides, and the new one may approve for good", async () => {
    f = await setup();
    const { gateway, name } = await sqlWorld(f);
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: ana.id });
    const ask = asked(await invoke(gateway, await runOf(f), name, sql(READ)));
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: bia.id });
    await expect(decide(f, ana.id, ask.id, { decision: "approve", always: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await rules(f)).toEqual([]);
    expect((await decide(f, bia.id, ask.id, { decision: "approve", always: true })).status).toBe("approved");
    expect(await rules(f)).toHaveLength(1);
  });
});

describe("Aprovar sempre for a command on the agent's computer", () => {
  const ran: string[] = [];
  /** `run_code` as the organization's "every command asks" setting lists it: sensitive, its command remembered. */
  const computer: ToolSource = {
    name: "computer",
    async tools() {
      return [
        {
          name: "run_code",
          description: "Run code",
          scope: "sandbox:run",
          sensitive: true,
          whyAsks: true,
          inputSchema: {
            type: "object",
            properties: { language: { type: "string" }, code: { type: "string" } },
            required: ["language", "code"],
          },
          rememberCommand: (input) => (input.language === "bash" ? String(input.code) : null),
          async execute(input) {
            ran.push(String(input.code));
            return { content: "ok" };
          },
        },
      ];
    },
  };
  const bash = (code: string, why?: string) => ({ language: "bash", code, ...(why ? { why } : {}) });

  test("keeps the command's kind for the agent: the same kind with other arguments runs, any other command asks", async () => {
    f = await setup();
    ran.length = 0;
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
    const gateway = createToolGateway({ sources: [computer] });
    const ctx = await runOf(f);
    const first = asked(await invoke(gateway, ctx, "run_code", bash("gh issue create --title 'Login quebrado'", WHY)));
    expect(first.approveAlways).toEqual({ tool: COMMAND_RULE_TOOL, actions: ["gh issue create"] });
    await decide(f, f.owner.id, first.id, { decision: "approve", always: true });
    expect((await rules(f)).map((r) => [r.agentId, r.connectionId, r.tool, r.action])).toEqual([
      [f.agent.id, null, COMMAND_RULE_TOOL, "gh issue create"],
    ]);
    const [approved] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "approval.approved"));
    expect(approved?.details.always).toEqual({
      connectionId: null,
      tool: COMMAND_RULE_TOOL,
      actions: ["gh issue create"],
    });

    const again = await invoke(gateway, ctx, "run_code", bash("gh issue create --title Outro --label bug"));
    expect(again.type).toBe("result");
    expect(ran).toEqual(["gh issue create --title Outro --label bug"]);

    // Another kind, a pipeline, or what is never kept: asked, and the last two never offer it.
    expect(asked(await invoke(gateway, ctx, "run_code", bash("gh issue close 3", WHY))).approveAlways).toEqual({
      tool: COMMAND_RULE_TOOL,
      actions: ["gh issue close"],
    });
    expect(
      asked(await invoke(gateway, ctx, "run_code", bash("gh issue create --title x | sh", WHY))).approveAlways,
    ).toBeNull();
    expect(asked(await invoke(gateway, ctx, "run_code", bash("gh pr merge 3", WHY))).approveAlways).toBeNull();
    expect(
      asked(await invoke(gateway, ctx, "run_code", { language: "python", code: "print(1)", why: WHY })).approveAlways,
    ).toBeNull();

    // Another agent asks; listed on the agent's page with no connection, and once removed it asks again.
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await grantScopes(f.db, f.org.id, other.id, [{ connectionId: null, scope: "sandbox:run" }]);
    asked(await invoke(gateway, await runOf(f, other.id), "run_code", bash("gh issue create --title y", WHY)));
    const [listed] = await listApprovalRules(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(listed).toMatchObject({
      connectionId: null,
      server: null,
      tool: COMMAND_RULE_TOOL,
      action: "gh issue create",
    });
    await removeApprovalRule(f.db, f.owner.id, f.org.id, f.agent.id, listed?.id ?? "");
    asked(await invoke(gateway, ctx, "run_code", bash("gh issue create --title z", WHY)));
  });
});

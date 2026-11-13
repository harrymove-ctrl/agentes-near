import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acceptCustomSuggestion,
  type CustomDeps,
  classifyByRules,
  connectCustomServer,
  connectorGrantValidator,
  createConnectorToolSource,
  createFakeJudge,
  createToolGateway,
  describeToolName,
  type Judge,
  type McpConnect,
  mcpSessionOver,
  postPersonMessage,
  refreshCustomServer,
  saveCustomTools,
  setAgentScopes,
  sharedPrefix,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

const WHY = "The person asked for this and the checks passed: this action finishes what was requested.";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("classification by the rules", () => {
  test("annotations first: readOnlyHint → read, destructiveHint → approval (sensitive)", () => {
    expect(classifyByRules({ name: "delete_preview", readOnlyHint: true })).toEqual({
      level: "read",
      source: "annotation",
      reason: "read_only_hint",
      sensitive: false,
    });
    expect(classifyByRules({ name: "status_update", destructiveHint: true })).toEqual({
      level: "approval",
      source: "annotation",
      reason: "destructive_hint",
      sensitive: true,
    });
    // A preset's read-only tools.
    expect(classifyByRules({ name: "execute_sql" }, ["execute_sql"])?.level).toBe("read");
  });

  test("then the verb, first or last in the name; sensitive verbs ask and can't be freed", () => {
    const level = (name: string) => {
      const c = classifyByRules({ name });
      return c ? `${c.level}${c.sensitive ? "!" : ""}` : null;
    };
    expect(
      ["list_tickets", "ad_get", "campaignBudget_get", "search-docs", "audience_size_estimate"].map(level),
    ).toEqual(["read", "read", "read", "read", "read"]);
    expect(
      ["create_ticket", "adgroup_budget_update", "catalog_product_set", "video_upload", "ad_copy"].map(level),
    ).toEqual(["write", "write", "write", "write", "write"]);
    expect(
      [
        "delete_customer",
        "bc_member_remove",
        "send_email",
        "invoice_pay",
        "identity_video_publish",
        "balance_transfer",
        "refund_payment",
        "spark_auth_unbind",
        "audience_share",
        "merge_pull_request",
        "github_delete_repo",
      ].map(level),
    ).toEqual(Array(11).fill("approval!"));
    // A noun that looks like a verb doesn't fool it: the verb is at the end.
    expect(level("balance_transfer_get")).toBe("read");
    // The name doesn't say: ambiguous (the judge suggests).
    expect(
      ["pixel_track", "report_task_run", "close_ticket", "execute_sql", "catalog_feed_refresh"].map(level),
    ).toEqual([null, null, null, null, null]);
  });

  test("readable parts and subjects from the name (shared prefixes dropped)", () => {
    expect(describeToolName("adgroup_budget_get")).toEqual({
      verb: "get",
      words: ["adgroup", "budget"],
      subject: "adgroup",
    });
    expect(describeToolName("get_campaign_budget")).toEqual({
      verb: "get",
      words: ["campaign", "budget"],
      subject: "campaign",
    });
    expect(describeToolName("close_ticket").subject).toBe("ticket");
    expect(describeToolName("list_tickets").subject).toBe("ticket");
    expect(describeToolName("categories").subject).toBe("category");
    expect(describeToolName("ping")).toEqual({ verb: null, words: ["ping"], subject: "ping" });
    expect(sharedPrefix(["github_create_issue", "github_list_repos"])).toBe("github");
    expect(sharedPrefix(["list_issues", "list_repos"])).toBeNull();
    expect(describeToolName("github_create_issue", "github")).toEqual({
      verb: "create",
      words: ["issue"],
      subject: "issue",
    });
  });
});

/** An ads server: read, write and sensitive verbs, two annotations and two names the verb can't decide. */
function adsMcp() {
  const state = { calls: [] as string[], extra: false };
  const tool = (server: McpServer, name: string, annotations: Record<string, boolean> = {}) =>
    server.registerTool(
      name,
      { description: `${name} (as the server describes it)`, inputSchema: { id: z.number().optional() }, annotations },
      async () => {
        state.calls.push(name);
        return { content: [{ type: "text", text: `${name} done` }] };
      },
    );
  const connect: McpConnect = async () => {
    const server = new McpServer({ name: "ads", version: "1" });
    tool(server, "campaign_list");
    tool(server, "campaign_budget_update");
    tool(server, "campaign_delete");
    tool(server, "report_export", { readOnlyHint: true });
    tool(server, "campaign_status_toggle", { destructiveHint: true });
    tool(server, "pixel_track");
    tool(server, "report_task_run");
    if (state.extra) tool(server, "catalog_feed_refresh");
    const [client, end] = InMemoryTransport.createLinkedPair();
    await server.connect(end);
    return mcpSessionOver(client);
  };
  return { connect, state };
}

const depsOf = (fx: Fixture, extra: Partial<CustomDeps> = {}): CustomDeps => ({
  db: fx.db,
  keyWrappers: [fx.keyWrapper],
  publicUrl: "https://chat.example.com",
  resolveHost: async () => ["93.184.216.34"],
  ...extra,
});

/** The judge's suggestion for each tool, by the tool's id in the batch. */
function adsJudge() {
  const answers: Record<string, [string, string]> = {
    pixel_track: ["write", "changes_undoable"],
    report_task_run: ["read", "reads_only"],
    catalog_feed_refresh: ["write", "replaces_data"],
  };
  return createFakeJudge((kind, id, state) => {
    if (kind !== "connector_tool_level") return undefined;
    const i = Number(id.split("_").at(-1));
    const tools = state.tools as { id: string; name: string }[];
    const pair = answers[tools[i]?.name ?? ""];
    if (!pair) return undefined;
    return id.startsWith("level_") ? pair[0] : pair[1];
  });
}

async function connectAds(fx: Fixture, deps: CustomDeps) {
  const started = await connectCustomServer(deps, fx.owner.id, fx.org.id, {
    serverUrl: "https://ads.example.com/mcp",
    apiKey: "ads_secret_12345",
    label: "Ads",
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  return started.server;
}

async function runContext(fx: Fixture) {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "x",
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
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}

describe("listing a connection's tools", () => {
  test("each tool comes classified; the ambiguous ones by the judge, in one batch, kept for the next listing", async () => {
    f = await setup();
    const mcp = adsMcp();
    const judge = adsJudge();
    const deps = depsOf(f, { connect: mcp.connect, judge });
    const server = await connectAds(f, deps);
    const by = new Map(server.tools.map((t) => [t.name, t]));
    const row = (name: string) => {
      const t = by.get(name);
      return [t?.level, t?.suggestionSource, t?.suggestionReason, t?.sensitive, t?.pending];
    };
    expect(row("campaign_list")).toEqual(["read", "verb", "verb_read", false, false]);
    expect(row("campaign_budget_update")).toEqual(["write", "verb", "verb_write", false, false]);
    expect(row("campaign_delete")).toEqual(["approval", "verb", "verb_sensitive", true, false]);
    expect(row("report_export")).toEqual(["read", "annotation", "read_only_hint", false, false]);
    expect(row("campaign_status_toggle")).toEqual(["approval", "annotation", "destructive_hint", true, false]);
    expect(row("pixel_track")).toEqual(["write", "judge", "changes_undoable", false, true]);
    expect(row("report_task_run")).toEqual(["read", "judge", "reads_only", false, true]);
    // Subjects and readable parts come from the name; nothing is decided yet.
    expect(by.get("campaign_budget_update")).toMatchObject({
      subject: "campaign",
      nameParts: { verb: "update", words: ["campaign", "budget"] },
      access: null,
      off: false,
    });
    // One request for both ambiguous tools; only their names and descriptions go in.
    expect(judge.calls.filter((c) => c.kind === "connector_tool_level")).toHaveLength(1);
    expect(((judge.calls[0]?.state.tools ?? []) as { name: string }[]).map((t) => t.name).sort()).toEqual([
      "pixel_track",
      "report_task_run",
    ]);

    // Listing again asks only about the new ambiguous tool (answers are kept per tool name).
    mcp.state.extra = true;
    const again = await refreshCustomServer(deps, f.owner.id, f.org.id, server.id);
    expect(judge.calls).toHaveLength(2);
    expect(((judge.calls[1]?.state.tools ?? []) as { name: string }[]).map((t) => t.name)).toEqual([
      "catalog_feed_refresh",
    ]);
    expect(again.tools.find((t) => t.name === "catalog_feed_refresh")).toMatchObject({
      level: "write",
      suggestionReason: "replaces_data",
      pending: true,
    });
    expect(again.tools.find((t) => t.name === "pixel_track")?.suggestionReason).toBe("changes_undoable");
  });

  test("the judge fails (or there is none): approval, 'couldn't tell', still waiting; asked again next time", async () => {
    f = await setup();
    const mcp = adsMcp();
    let fail = true;
    const working = adsJudge();
    const judge: Judge = {
      name: "flaky",
      async ask(request) {
        if (fail) throw new Error("judge down");
        return working.ask(request);
      },
    };
    const deps = depsOf(f, { connect: mcp.connect, judge });
    const server = await connectAds(f, deps);
    expect(server.tools.find((t) => t.name === "pixel_track")).toMatchObject({
      level: "approval",
      suggestionSource: "judge_failed",
      suggestionReason: "unknown",
      pending: true,
      sensitive: false,
    });
    fail = false;
    const again = await refreshCustomServer(deps, f.owner.id, f.org.id, server.id);
    expect(again.tools.find((t) => t.name === "pixel_track")).toMatchObject({
      level: "write",
      suggestionSource: "judge",
      pending: true,
    });

    // No judge at all: the same safe suggestion.
    const none = await connectCustomServer(depsOf(f, { connect: mcp.connect }), f.owner.id, f.org.id, {
      serverUrl: "https://ads2.example.com/mcp",
      apiKey: "ads_secret_12345",
    });
    if (none.status !== "connected") throw new Error("expected connected");
    expect(none.server.tools.find((t) => t.name === "report_task_run")).toMatchObject({
      level: "approval",
      suggestionReason: "unknown",
    });
  });
});

describe("the person's choices", () => {
  test("saved per tool: off is hidden, approval asks, change runs and is audited; confirming ends 'pending'", async () => {
    f = await setup();
    const fx = f;
    const mcp = adsMcp();
    const deps = depsOf(fx, { connect: mcp.connect, judge: adsJudge() });
    const server = await connectAds(fx, deps);

    // A sensitive tool may only ask or be off.
    await expect(
      saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
        label: "Ads",
        tools: [{ name: "campaign_delete", access: "read", label: "x" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
        label: "Ads",
        tools: [{ name: "campaign_status_toggle", access: "write", label: "x" }],
      }),
    ).rejects.toThrow("can only ask for approval or be off");

    const decisions: Record<string, "read" | "write" | "approval" | "off"> = {
      campaign_list: "read",
      campaign_budget_update: "write",
      campaign_delete: "approval",
      report_export: "off",
      campaign_status_toggle: "off",
      pixel_track: "approval", // decided by the person
      report_task_run: "read", // the suggestion applies, but it still waits for a decision
    };
    const saved = await saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
      label: "Ads",
      tools: Object.entries(decisions).map(([name, access]) => ({
        name,
        access,
        label: name,
        confirmed: name !== "report_task_run",
      })),
    });
    const pending = saved.tools.filter((t) => t.pending).map((t) => t.name);
    expect(pending).toEqual(["report_task_run"]);
    expect(saved.tools.find((t) => t.name === "report_export")).toMatchObject({ off: true, level: "off" });

    const source = createConnectorToolSource(deps);
    const gateway = createToolGateway({ sources: [source] });
    const ctx = await runContext(fx);
    await setAgentScopes(
      fx.db,
      fx.owner.id,
      fx.org.id,
      fx.agent.id,
      [
        { connectionId: server.id, scope: `custom:${server.id}:read` },
        { connectionId: server.id, scope: `custom:${server.id}:write` },
      ],
      connectorGrantValidator,
    );
    const offered = (await gateway.list(ctx)).map((t) => t.name).sort();
    // Off tools are never offered.
    expect(offered).toEqual([
      "ads_campaign_budget_update",
      "ads_campaign_delete",
      "ads_campaign_list",
      "ads_pixel_track",
      "ads_report_task_run",
    ]);
    const call = (name: string, id: string, why?: string) =>
      gateway.invoke(ctx, { toolUseId: id, name, input: why ? { id: 1, why } : { id: 1 } });
    expect((await call("ads_campaign_list", "t1")).type).toBe("result");
    expect((await call("ads_campaign_budget_update", "t2")).type).toBe("result");
    const ask = await call("ads_campaign_delete", "t3", WHY);
    expect(ask.type).toBe("approval");
    expect((await call("ads_pixel_track", "t4", WHY)).type).toBe("approval");
    expect(mcp.state.calls).toEqual(["campaign_list", "campaign_budget_update"]);
    const audit = await fx.db.select().from(schema.auditLog);
    const changed = audit.filter((a) => a.action === "connector.tool_changed");
    expect(changed.map((a) => [a.actorType, a.actorId, (a.details as { tool: string }).tool])).toEqual([
      ["agent", fx.agent.id, "campaign_budget_update"],
    ]);

    // Accepting the suggestions keeps decisions and doesn't confirm what still waits.
    const accepted = await acceptCustomSuggestion(deps, fx.owner.id, fx.org.id, server.id);
    expect(accepted.server.tools.find((t) => t.name === "report_export")?.access).toBe("off");
    expect(accepted.server.tools.filter((t) => t.pending).map((t) => t.name)).toEqual(["report_task_run"]);
  });

  test("a stored free decision on a sensitive tool still asks for approval", async () => {
    f = await setup();
    const fx = f;
    const mcp = adsMcp();
    const deps = depsOf(fx, { connect: mcp.connect });
    const server = await connectAds(fx, deps);
    await saveCustomTools(deps, fx.owner.id, fx.org.id, server.id, {
      label: "Ads",
      tools: [{ name: "campaign_delete", access: "approval", label: "Apagar campanha" }],
    });
    // Written around the API (old data): the gateway still gates it.
    await fx.db.update(schema.customTools).set({ access: "write" });
    const source = createConnectorToolSource(deps);
    const tools = await source.tools(await runContext(fx));
    expect(tools.find((t) => t.name === "ads_campaign_delete")?.sensitive).toBe(true);
    // Listing again turns it back to approval.
    const again = await refreshCustomServer(deps, fx.owner.id, fx.org.id, server.id);
    expect(again.tools.find((t) => t.name === "campaign_delete")?.access).toBe("approval");
  });
});

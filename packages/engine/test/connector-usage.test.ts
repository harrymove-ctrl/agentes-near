import { afterEach, describe, expect, test } from "bun:test";
import { gt, schema, sql } from "@agenteschat/db";
import {
  analyticsRange,
  composioUsageHook,
  connectorKeyOf,
  connectorLabelOf,
  countComposio,
  countComposioConnection,
  countToolCall,
  createToolGateway,
  decideApproval,
  grantScopes,
  mailboxConnector,
  OPERATOR_EVENTS_KEEP_DAYS,
  operatorAnalytics,
  operatorConnectorAnalytics,
  orgOfComposioUser,
  postPersonMessage,
  type ToolContext,
  type ToolDefinition,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // The tests without a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const { connectorUsageDays, composioUsageDays } = schema;

async function runIn(fx: Fixture): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "olha os chamados",
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

/** Each kind of tool as its source marks it (the sources' own tests check they do). */
const KINDS = {
  catalog_list_issues: {
    key: connectorKeyOf({ connector: "github", serverUrl: "https://api.githubcopilot.com/mcp/" }),
    via: "mcp",
    tool: "list_issues",
  },
  git_clone: { key: "github", via: "native", tool: "git_clone" },
  preset_list: {
    key: connectorKeyOf({ connector: "custom:c1", serverUrl: "https://mcp.linear.app/mcp" }),
    via: "mcp",
    tool: "list_issues",
  },
  // Its owner named the tool (n8n names it after a node, Make after a scenario).
  custom_list: {
    key: connectorKeyOf({ connector: "custom:c2", serverUrl: "https://Tickets.Example.com/mcp/v1/acme?token=s3cr3t" }),
    via: "mcp",
    tool: "Send_invoice_to_Acme_Ltda",
  },
  mail_team_search: { ...mailboxConnector({ provider: "gmail", via: "composio", preset: null }), tool: "search" },
  mail_support_read: { ...mailboxConnector({ provider: "imap", via: "imap", preset: "icloud" }), tool: "read" },
  pg_prod_query: { key: "postgres", via: "native", tool: "query" },
} satisfies Record<string, NonNullable<ToolDefinition["connector"]>>;

function gateway() {
  const obj = { type: "object", properties: { q: { type: "string" } }, additionalProperties: true };
  const tool = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
    name,
    description: name,
    scope: "context:read",
    inputSchema: obj,
    async execute() {
      return { content: `${name} ok` };
    },
    ...extra,
  });
  const tools = [
    ...Object.entries(KINDS).map(([name, connector]) => tool(name, { connector })),
    tool("search_context"),
    tool("tickets_broken", {
      connector: KINDS.custom_list,
      async execute() {
        return { content: "the server said no", isError: true };
      },
    }),
    tool("tickets_down", {
      connector: KINDS.custom_list,
      async execute() {
        throw new Error("unreachable");
      },
    }),
    tool("tickets_close", {
      connector: { ...KINDS.custom_list, tool: "close_ticket" },
      scope: "issues:write",
      sensitive: true,
    }),
    tool("tickets_delete", { connector: { ...KINDS.custom_list, tool: "delete_ticket" }, scope: "drive:delete" }),
  ];
  return createToolGateway({ sources: [{ name: "fake", tools: async () => tools }] });
}

const usageRows = (fx: Fixture) =>
  fx.db
    .select()
    .from(connectorUsageDays)
    .orderBy(connectorUsageDays.connector, connectorUsageDays.via, connectorUsageDays.tool);

describe("counting", () => {
  test("each kind of tool under its key and way, by its vendor's tool name; built-in and refused calls never", async () => {
    f = await setup();
    await grantScopes(f.db, f.org.id, f.agent.id, [
      { connectionId: null, scope: "context:read" },
      { connectionId: null, scope: "issues:write" },
    ]);
    const tools = gateway();
    const ctx = await runIn(f);
    const call = (name: string, input: Record<string, unknown> = { q: "o cliente pediu reembolso" }) =>
      tools.invoke(ctx, { toolUseId: `tu_${name}_${Math.random()}`, name, input });
    for (const name of Object.keys(KINDS)) expect((await call(name)).type).toBe("result");
    await call("search_context");
    await call("tickets_delete"); // no drive:delete: refused
    await call("tickets_broken");
    await call("tickets_down");

    const rows = await usageRows(f);
    expect(rows.map((r) => [r.connector, r.via, r.tool, r.calls, r.errors])).toEqual([
      ["github", "mcp", "list_issues", 1, 0],
      ["github", "native", "git_clone", 1, 0],
      ["gmail", "composio", "search", 1, 0],
      ["icloud", "native", "read", 1, 0],
      ["linear", "mcp", "list_issues", 1, 0],
      ["postgres", "native", "query", 1, 0],
      // The error result and the throw: a call and an error each. A custom server's own tool names never.
      ["tickets.example.com", "mcp", "other", 3, 2],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ orgId: f.org.id, agentId: f.agent.id, approvalsAsked: 0, approvalsGiven: 0 });
      expect(r.day).toBe(new Date().toISOString().slice(0, 10));
    }
    expect(JSON.stringify(rows)).not.toContain("s3cr3t");
    expect(JSON.stringify(rows)).not.toContain("reembolso");
    expect(JSON.stringify(rows)).not.toContain("Acme");
  });

  test("an approval asked counts once; approved, it ran once: one given and one call", async () => {
    f = await setup();
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:write" }]);
    const tools = gateway();
    const ctx = await runIn(f);
    const ask = () =>
      tools.invoke(ctx, {
        toolUseId: "tu_close",
        name: "tickets_close",
        input: { q: "#1", why: "The customer confirmed the fix and asked to close the ticket." },
      });
    const asked = await ask();
    if (asked.type !== "approval") throw new Error("expected an approval");
    // The same call again (a retried job) finds the request already there.
    expect(await ask()).toMatchObject({ type: "approval", approval: { id: asked.approval.id } });
    const counts = async () =>
      (await usageRows(f)).map((r) => [r.tool, r.calls, r.errors, r.approvalsAsked, r.approvalsGiven]);
    expect(await counts()).toEqual([["other", 0, 0, 1, 0]]);

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, asked.approval.id, {
      decision: "approve",
    });
    const [approved] = await f.db.select().from(schema.approvals);
    if (!approved) throw new Error("no approval");
    expect((await tools.executeApproved(ctx, approved)).content).toContain("tickets_close ok");
    expect(await counts()).toEqual([["other", 1, 0, 1, 1]]);
    await tools.executeApproved(ctx, approved);
    const [again] = await f.db.select().from(schema.approvals);
    if (again) await tools.executeApproved(ctx, again);
    expect(await counts()).toEqual([["other", 1, 0, 1, 1]]);
  });

  test("one row per UTC day; a count that fails never changes the call's result", async () => {
    f = await setup();
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "context:read" }]);
    const tools = gateway();
    const ctx = await runIn(f);
    const call = () => tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name: "pg_prod_query", input: {} });
    await call();
    await call();
    expect((await usageRows(f)).map((r) => r.calls)).toEqual([2]);
    await f.db.update(connectorUsageDays).set({ day: sql`${connectorUsageDays.day} - 1` });
    await call();
    expect((await usageRows(f)).map((r) => r.calls).sort()).toEqual([1, 2]);

    const before = await call();
    await f.db.execute(sql`drop table connector_usage_days`);
    expect(await call()).toEqual(before);
  });

  test("Composio: executions and events add up per toolkit and action, aliases to our keys; its user ids", async () => {
    f = await setup();
    const at = { orgId: f.org.id };
    // The client's hook: an execution each, a failure too, only for one of our user ids.
    const executed = composioUsageHook(f.db);
    const run = { toolkit: "gmail", slug: "GMAIL_FETCH_EMAILS" };
    await executed({ ...run, userId: `org_${f.org.id}`, ok: true });
    await executed({ ...run, userId: `org_${f.org.id}`, ok: false });
    await executed({ ...run, userId: `user_${f.org.id}`, ok: true });
    await executed({ ...run, userId: `org_${crypto.randomUUID()}`, ok: true });
    await countComposio(f.db, { ...at, toolkit: "gmail", action: "GMAIL_NEW_GMAIL_MESSAGE", events: 1 });
    await countComposio(f.db, { ...at, toolkit: "GOOGLEDRIVE", action: "GOOGLEDRIVE_FIND_FILE", executions: 1 });
    await countComposio(f.db, { ...at, toolkit: "gmail", action: "=HYPERLINK(evil)", executions: 1 });
    const rows = await f.db
      .select()
      .from(composioUsageDays)
      .orderBy(composioUsageDays.toolkit, composioUsageDays.action);
    expect(rows.map((r) => [r.toolkit, r.action, r.executions, r.failures, r.events])).toEqual([
      ["drive", "GOOGLEDRIVE_FIND_FILE", 1, 0, 0],
      ["gmail", "GMAIL_FETCH_EMAILS", 2, 1, 0],
      ["gmail", "GMAIL_NEW_GMAIL_MESSAGE", 0, 0, 1],
      ["gmail", "other", 1, 0, 0],
    ]);

    expect(orgOfComposioUser(`org_${f.org.id}`)).toBe(f.org.id);
    for (const other of [
      "",
      f.org.id,
      `org_${f.org.id}x`,
      `user_${f.org.id}`,
      "org_123",
      "org_0193ABCD-0000-7000-8000-000000000000",
    ])
      expect(orgOfComposioUser(other)).toBeNull();
  });
});

describe("keys and labels", () => {
  test("hostnames only, never a path; ids and hostnames never meet; anything odd is `custom` or `other`", () => {
    const custom = (serverUrl: string) => connectorKeyOf({ connector: "custom:x", serverUrl });
    expect(custom("https://mcp.supabase.com/mcp?read_only=true&features=database,docs,debugging")).toBe(
      "supabase-readonly",
    );
    // Another URL on a preset's host is still that service.
    expect(custom("https://mcp.supabase.com/mcp?read_only=true")).toBe("supabase");
    expect(custom("https://mcp.supabase.com/mcp?project_ref=abcdef")).toBe("supabase");
    expect(custom("https://mcp.vercel.com/acme-team")).toBe("vercel");
    expect(custom("https://mcp.notion.com/mcp")).toBe("notion");
    expect(custom("https://MCP.Acme.io:8443/v1/secret?key=1")).toBe("mcp.acme.io");
    expect(custom("https://localhost/mcp")).toBe("custom");
    expect(custom("https://[::1]/mcp")).toBe("custom");
    expect(custom(`https://${"a".repeat(98)}.io/mcp`)).toBe("custom");
    expect(custom("not a url")).toBe("custom");
    expect(connectorKeyOf({ connector: "sentry", serverUrl: "https://mcp.sentry.dev/mcp" })).toBe("sentry");
    expect(connectorKeyOf({ provider: "outlook", via: "composio", preset: null })).toBe("outlook");
    expect(connectorKeyOf({ provider: "imap", via: "imap", preset: "custom" })).toBe("imap");
    expect(connectorKeyOf({ provider: "imap", via: "imap", preset: null })).toBe("imap");
    expect(connectorKeyOf({ toolkit: "metaads" })).toBe("meta-ads");
    expect(connectorKeyOf({ toolkit: "Vercel" })).toBe("vercel");
    expect(connectorKeyOf({ toolkit: "two words" })).toBe("other");

    expect(
      ["github", "drive", "linear", "meta-ads", "gmail", "postgres", "icloud", "imap", "twitter"].map(connectorLabelOf),
    ).toEqual([
      "GitHub",
      "Google Drive",
      "Linear",
      "Meta Ads",
      "Gmail",
      "Postgres",
      "iCloud",
      "Other (IMAP/SMTP)",
      "X",
    ]);
    expect(connectorLabelOf("mcp.acme.io")).toBe("mcp.acme.io");
    expect(connectorLabelOf("constructor")).toBe("constructor");
  });

  test("dates: real UTC days in order, at most 400 of them", () => {
    expect(analyticsRange("2026-10-01", "2026-10-31")).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(analyticsRange("2025-10-03", "2026-11-06").to).toBe("2026-11-06");
    for (const [from, to] of [
      ["2026-10-31", "2026-10-01"],
      ["2025-10-02", "2026-11-06"],
      ["2026-02-30", "2026-03-01"],
      ["2026-10-1", "2026-10-31"],
      ["0000-01-01", "0000-01-02"],
      ["", "2026-10-31"],
    ] as const) {
      expect(() => analyticsRange(from, to)).toThrow(ValidationError);
    }
  });
});

describe("the operator's reads", () => {
  const range = () => {
    const today = new Date().toISOString().slice(0, 10);
    return { from: today, to: today, today };
  };

  async function world() {
    f = await setup();
    const [other] = await f.db.insert(schema.organizations).values({ name: "Beta" }).returning();
    const [idle] = await f.db.insert(schema.organizations).values({ name: "Gama" }).returning();
    if (!other || !idle) throw new Error("no org");
    const [a1, a2, a3] = [f.agent.id, crypto.randomUUID(), crypto.randomUUID()];
    const github = { key: "github", via: "mcp" as const, tool: "list_issues" };
    const tickets = { key: "tickets.example.com", via: "mcp" as const, tool: "Send_invoice_to_Acme_Ltda" };
    const gmail = { key: "gmail", via: "composio" as const, tool: "search" };
    await countToolCall(f.db, { orgId: f.org.id, agentId: a1, connector: github, calls: 1 });
    await countToolCall(f.db, { orgId: f.org.id, agentId: a1, connector: github, calls: 1, errors: 1 });
    await countToolCall(f.db, { orgId: f.org.id, agentId: a2, connector: github, calls: 1 });
    await countToolCall(f.db, { orgId: other.id, agentId: a3, connector: github, calls: 1 });
    // Only asked for an approval: not using it yet.
    await countToolCall(f.db, { orgId: idle.id, agentId: a3, connector: github, approvalsAsked: 1 });
    await countToolCall(f.db, {
      orgId: f.org.id,
      agentId: a1,
      connector: { ...github, via: "native", tool: "git_clone" },
      calls: 1,
    });
    await countToolCall(f.db, { orgId: other.id, agentId: a3, connector: tickets, calls: 4 });
    await countToolCall(f.db, { orgId: f.org.id, agentId: a1, connector: gmail, calls: 2 });
    await countComposio(f.db, {
      orgId: f.org.id,
      toolkit: "gmail",
      action: "GMAIL_FETCH_EMAILS",
      executions: 3,
      failures: 1,
    });
    await countComposio(f.db, { orgId: other.id, toolkit: "gmail", action: "GMAIL_NEW_GMAIL_MESSAGE", events: 2 });
    // A day of the month before: never this month's.
    const monthBefore = sql`(date_trunc('month', now() at time zone 'utc') - interval '1 day')::date`;
    await f.db.insert(composioUsageDays).values({
      day: monthBefore,
      toolkit: "gmail",
      orgId: f.org.id,
      action: "GMAIL_FETCH_EMAILS",
      executions: 100,
    });
    // Connected accounts: one the month before, one today.
    await countComposioConnection(f.db, { orgId: other.id, toolkit: "gmail" });
    await f.db.update(composioUsageDays).set({ day: monthBefore }).where(gt(composioUsageDays.connections, 0));
    await countComposioConnection(f.db, { orgId: f.org.id, toolkit: "gmail" });

    // Accounts: the catalog's GitHub, a preset, two custom servers on one host, mailboxes, a database, an installation.
    const connection = (orgId: string, connector: string, serverUrl: string, label = "Conexão") => ({
      orgId,
      connector,
      toolPrefix: connector.replace(":", "_"),
      label,
      serverUrl,
      authType: "none",
    });
    await f.db
      .insert(schema.connectorConnections)
      .values([
        connection(f.org.id, "github", "https://api.githubcopilot.com/mcp/"),
        connection(f.org.id, "custom:1", "https://mcp.linear.app/mcp"),
        connection(f.org.id, "custom:2", "https://tickets.example.com/mcp/acme-secret-path", "Chamados da Acme Ltda"),
        connection(other.id, "custom:3", "https://tickets.example.com/other?api_key=k_live_123"),
        { ...connection(other.id, "custom:4", "https://tickets.example.com/gone"), revokedAt: new Date() },
      ]);
    const mailbox = (orgId: string, provider: string, via: string, extra = {}) => ({
      orgId,
      provider,
      via,
      address: `${provider}${Math.random()}@cliente-secreto.com.br`,
      status: "active",
      ...extra,
    });
    await f.db
      .insert(schema.mailAccounts)
      .values([
        mailbox(f.org.id, "gmail", "composio"),
        mailbox(other.id, "gmail", "composio", { createdAt: new Date(Date.now() - 40 * 86_400_000) }),
        mailbox(other.id, "gmail", "composio", { status: "pending" }),
        mailbox(f.org.id, "imap", "imap", { preset: "icloud" }),
      ]);
    await f.db.insert(schema.githubAppInstallations).values({
      orgId: f.org.id,
      installationId: 42,
      accountLogin: "acme",
      accountType: "Organization",
    });
    await f.db.insert(schema.dbConnections).values({
      orgId: other.id,
      label: "Produção da Beta",
      host: "db.beta.example.com",
      database: "app",
      username: "reader",
      secretCiphertext: "x",
      wrappedDataKey: "x",
      kekId: "x",
    });

    // The product's days, from the events feed.
    const event = (type: string, orgId: string | null, createdAt = new Date()) => ({ type, orgId, createdAt });
    await f.db
      .insert(schema.operatorEvents)
      .values([
        event("run.finished", f.org.id),
        event("run.finished", f.org.id),
        event("task.finished", other.id),
        event("organization.created", other.id),
        event("user.signed_up", null),
        event("session.created", null),
        event("run.finished", idle.id, new Date(Date.now() - 400 * 86_400_000)),
      ]);
    return { other, idle, a1, a2, a3 };
  }

  test("the overview: totals, days, connectors with accounts keyed like their tools, Composio and its month, the product", async () => {
    await world();
    const r = range();
    const a = await operatorAnalytics(f.db, r);
    expect(a.since).toBe(
      new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0)).toISOString().slice(0, 10),
    );
    expect(a.totals).toEqual({ calls: 11, errors: 1, approvalsAsked: 1, approvalsGiven: 0, workspaces: 2, agents: 3 });
    expect(a.days).toEqual([
      { day: r.today, via: "composio", calls: 2, errors: 0, approvalsAsked: 0, approvalsGiven: 0, workspaces: 1 },
      { day: r.today, via: "mcp", calls: 8, errors: 1, approvalsAsked: 1, approvalsGiven: 0, workspaces: 2 },
      { day: r.today, via: "native", calls: 1, errors: 0, approvalsAsked: 0, approvalsGiven: 0, workspaces: 1 },
    ]);
    const zero = { approvalsAsked: 0, approvalsGiven: 0, executions: 0, executionFailures: 0, events: 0, errors: 0 };
    // Most calls first; at the same calls, more accounts.
    expect(a.connectors).toEqual([
      {
        ...zero,
        connector: "tickets.example.com",
        label: "tickets.example.com",
        via: "mcp",
        calls: 4,
        workspaces: 1,
        agents: 1,
        accounts: 2,
        accountsAdded: 2,
      },
      {
        ...zero,
        connector: "github",
        label: "GitHub",
        via: "mcp",
        calls: 4,
        errors: 1,
        approvalsAsked: 1,
        workspaces: 2,
        agents: 3,
        accounts: 1,
        accountsAdded: 1,
      },
      {
        ...zero,
        connector: "gmail",
        label: "Gmail",
        via: "composio",
        calls: 2,
        // The one that called, and the one Composio billed for its trigger events alone.
        workspaces: 2,
        agents: 1,
        accounts: 2,
        accountsAdded: 1,
        executions: 3,
        executionFailures: 1,
        events: 2,
      },
      {
        ...zero,
        connector: "github",
        label: "GitHub",
        via: "native",
        calls: 1,
        workspaces: 1,
        agents: 1,
        accounts: 1,
        accountsAdded: 1,
      },
      {
        ...zero,
        connector: "icloud",
        label: "iCloud",
        via: "native",
        calls: 0,
        workspaces: 0,
        agents: 0,
        accounts: 1,
        accountsAdded: 1,
      },
      {
        ...zero,
        connector: "linear",
        label: "Linear",
        via: "mcp",
        calls: 0,
        workspaces: 0,
        agents: 0,
        accounts: 1,
        accountsAdded: 1,
      },
      {
        ...zero,
        connector: "postgres",
        label: "Postgres",
        via: "native",
        calls: 0,
        workspaces: 0,
        agents: 0,
        accounts: 1,
        accountsAdded: 1,
      },
    ]);
    expect(a.connectorsMore).toBe(false);
    expect(a.composio.days).toEqual([{ day: r.today, executions: 3, failures: 1, events: 2 }]);
    expect(a.composio.month).toEqual({
      month: r.today.slice(0, 7),
      executions: 3,
      failures: 1,
      events: 2,
      // Not the one made the month before.
      connections: 1,
    });
    expect(a.product).toEqual({
      days: [{ day: r.today, runs: 2, tasks: 1, activeWorkspaces: 2, newWorkspaces: 1, signUps: 1 }],
      activeWorkspaces: 2,
      keptDays: OPERATOR_EVENTS_KEEP_DAYS,
    });
  });

  test("one connector: per day and way, tool, action and workspace, with its accounts; unknown keys are empty", async () => {
    const w = await world();
    const r = range();
    const gh = await operatorConnectorAnalytics(f.db, "github", r);
    expect(gh).toMatchObject({ connector: "github", label: "GitHub", from: r.from, to: r.to, orgsMore: false });
    expect(gh.days).toEqual([
      { day: r.today, via: "mcp", calls: 4, errors: 1, approvals: 1, executions: 0, events: 0 },
      { day: r.today, via: "native", calls: 1, errors: 0, approvals: 0, executions: 0, events: 0 },
    ]);
    expect(gh.tools).toEqual([
      { via: "mcp", tool: "list_issues", calls: 4, errors: 1, approvals: 1, workspaces: 2 },
      { via: "native", tool: "git_clone", calls: 1, errors: 0, approvals: 0, workspaces: 1 },
    ]);
    expect(gh.actions).toEqual([]);
    const org = { executions: 0, events: 0, errors: 0, approvals: 0 };
    expect(gh.orgs).toEqual([
      { ...org, orgId: f.org.id, via: "mcp", calls: 3, errors: 1, agents: 2, accounts: 1, lastDay: r.today },
      // The installation is the native way's account.
      { ...org, orgId: f.org.id, via: "native", calls: 1, agents: 1, accounts: 1, lastDay: r.today },
      { ...org, orgId: w.other.id, via: "mcp", calls: 1, agents: 1, accounts: 0, lastDay: r.today },
      { ...org, orgId: w.idle.id, via: "mcp", calls: 0, approvals: 1, agents: 0, accounts: 0, lastDay: r.today },
    ]);

    const gmail = await operatorConnectorAnalytics(f.db, "gmail", r);
    expect(gmail.days).toEqual([
      { day: r.today, via: "composio", calls: 2, errors: 0, approvals: 0, executions: 3, events: 2 },
    ]);
    expect(gmail.actions).toEqual([
      { action: "GMAIL_FETCH_EMAILS", executions: 3, failures: 1, events: 0, workspaces: 1 },
      { action: "GMAIL_NEW_GMAIL_MESSAGE", executions: 0, failures: 0, events: 2, workspaces: 1 },
    ]);
    expect(gmail.orgs.map((o) => [o.orgId, o.calls, o.executions, o.events, o.accounts])).toEqual([
      [f.org.id, 2, 3, 0, 1],
      [w.other.id, 0, 0, 2, 1],
    ]);

    const tickets = await operatorConnectorAnalytics(f.db, "tickets.example.com", r);
    expect(tickets.tools).toEqual([{ via: "mcp", tool: "other", calls: 4, errors: 0, approvals: 0, workspaces: 1 }]);
    expect(tickets.orgs.map((o) => [o.orgId, o.calls, o.accounts])).toEqual([
      [w.other.id, 4, 1],
      [f.org.id, 0, 1],
    ]);

    expect(await operatorConnectorAnalytics(f.db, "nothing-here", r)).toEqual({
      connector: "nothing-here",
      label: "nothing-here",
      from: r.from,
      to: r.to,
      days: [],
      tools: [],
      actions: [],
      orgs: [],
      orgsMore: false,
    });
    await expect(operatorConnectorAnalytics(f.db, "Not A Key", r)).rejects.toThrow(ValidationError);

    // Only counts, keys and ids leave: no label, path, address, input or name.
    const text = JSON.stringify([await operatorAnalytics(f.db, r), gh, gmail, tickets]);
    for (const secret of [
      "Conexão",
      "Acme Ltda",
      "Acme_Ltda",
      "acme-secret-path",
      "k_live_123",
      "cliente-secreto",
      "Beta",
      "Gama",
      "db.beta",
    ])
      expect(text).not.toContain(secret);
  });

  test("at most 500 connectors and 500 workspaces, then `more`", async () => {
    f = await setup();
    const orgs = await f.db
      .insert(schema.organizations)
      .values(Array.from({ length: 500 }, (_, i) => ({ name: `Org ${i}` })))
      .returning({ id: schema.organizations.id });
    const day = sql`(now() at time zone 'utc')::date`;
    const row = (orgId: string, connector: string) => ({
      day,
      connector,
      via: "mcp" as const,
      orgId,
      agentId: f.agent.id,
      tool: "t",
      calls: 1,
    });
    await f.db
      .insert(connectorUsageDays)
      .values([
        ...[f.org, ...orgs].map((o, i) => row(o.id, `k${i}`)),
        ...[f.org, ...orgs].map((o) => row(o.id, "github")),
      ]);
    const r = range();
    const a = await operatorAnalytics(f.db, r);
    expect([a.connectors.length, a.connectorsMore, a.connectors[0]?.connector]).toEqual([500, true, "github"]);
    const gh = await operatorConnectorAnalytics(f.db, "github", r);
    expect([gh.orgs.length, gh.orgsMore]).toEqual([500, true]);
  });
});

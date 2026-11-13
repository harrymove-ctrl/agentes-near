import { afterEach, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  chooseToolGroups,
  createFakeJudge,
  createToolGateway,
  describeCapabilities,
  drainOutbox,
  grantScopes,
  type Judge,
  postPersonMessage,
  presentTools,
  type ToolContext,
  type ToolDefinition,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const tool = (name: string, scope: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: `${name.replace(/_/g, " ")}.`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  scope,
  execute: async () => ({ content: `${name} ok` }),
  ...extra,
});

const SENTRY = "1f0e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const tools = (): ToolDefinition[] => [
  tool("ask_user", ""),
  tool("remember", "memory:write"),
  tool("search_context", "context:read"),
  tool("read_wiki_page", "wiki:read"),
  tool("create_wiki_page", "wiki:write"),
  tool("create_issue", "issues:write"),
  tool("list_issues", "issues:read"),
  tool("browser_read", "browser:use"),
  tool("sentry_search_issues", "sentry:read", { connectionId: SENTRY, connectorLabel: "Sentry" }),
];

test("tools on demand: core and loaded groups as they are, the rest behind find_tools / use_tool", () => {
  expect(presentTools(tools()).map((t) => t.name)).toHaveLength(9);
  const shown = presentTools(tools(), undefined, ["issues"]);
  expect(shown.map((t) => t.name)).toEqual([
    "ask_user",
    "remember",
    "search_context",
    "read_wiki_page",
    "create_issue",
    "list_issues",
    "find_tools",
    "use_tool",
  ]);
  const find = shown.find((t) => t.name === "find_tools");
  expect(find?.description).toContain("Organization wiki (writing) (1), Browser (1), Sentry (1)");
  // Everything loaded: no directory.
  expect(
    presentTools(tools(), undefined, ["issues", "wiki", "browser", "sentry"]).some((t) => t.name === "find_tools"),
  ).toBe(false);
});

test("find_tools ranks the loaded tools too: those that match best come first, to call directly, then the rest", async () => {
  const find = presentTools(tools(), undefined, ["issues"]).find((t) => t.name === "find_tools");
  const text = (await find?.execute({ query: "list issues" }, {} as ToolContext))?.content ?? "";
  expect(text).toStartWith(
    'Already in your tool list for "list issues": call them directly (if your list doesn\'t show them yet, use_tool runs them too).\n- list_issues: list issues.\n- create_issue: create issue.',
  );
  expect(text).toContain('\n\nother tools for "list issues" (call one with use_tool):\n- sentry_search_issues');
});

test("find_tools never puts a loaded tool that matches less before a better match: it keeps its rank", async () => {
  const find = presentTools(tools(), undefined, ["issues"]).find((t) => t.name === "find_tools");
  const text = (await find?.execute({ query: "create a wiki page" }, {} as ToolContext))?.content ?? "";
  expect(text).toStartWith(
    'other tools for "create a wiki page" (call one with use_tool):\n- create_wiki_page: create',
  );
  expect(text).toContain(
    "\n- read_wiki_page (already in your tool list: call it directly): read wiki page.\n- create_issue (already in your tool list: call it directly): create issue.",
  );
});

test("the prompt names the loaded tools only by name and the on-demand groups in one line", () => {
  const text = describeCapabilities(presentTools(tools(), undefined, []));
  expect(text).toContain("- On demand: Organization wiki (writing) (1), Issues (2), Browser (1), Sentry (1).");
  expect(text).toContain("Find the one you need with `find_tools` and run it with `use_tool`");
  expect(text).not.toContain("`create_issue`");
  expect(text).not.toContain("`find_tools` (");
  // The browser's guidance is there: the run can reach it on demand.
  expect(text).toContain("Your browser (`browser_*`)");
});

test("the prompt tells the agent to guide a person to connect an app it lacks, never to say it doesn't exist", () => {
  expect(describeCapabilities(presentTools(tools(), undefined, []))).toContain(
    "Search before saying you can't do something. For an app you have no tools for (Google Drive, Gmail…), `find_tools` also says how to get it: guide the person to connect it instead of saying it doesn't exist; when none can be connected and it has a web version, use that in your browser.",
  );
});

async function ctxOf(fx: Fixture, loadedGroups: string[]): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "hi",
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
    loadedGroups,
  };
}

test("find_tools finds a tool not loaded; use_tool and its real name run it, as itself", async () => {
  f = await setup();
  const ran: string[] = [];
  const gateway = createToolGateway({
    sources: [
      {
        name: "fake",
        tools: async () =>
          tools().map((t) => ({
            ...t,
            execute: async () => {
              ran.push(t.name);
              return { content: `${t.name} ok` };
            },
          })),
      },
    ],
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [
    { connectionId: null, scope: "issues:read" },
    { connectionId: null, scope: "issues:write" },
  ]);
  const ctx = await ctxOf(f, []);
  expect((await gateway.list(ctx)).map((t) => t.name)).toContain("find_tools");
  const call = (name: string, input: Record<string, unknown>) =>
    gateway.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });

  const found = await call("find_tools", { query: "create an issue" });
  const text = found.type === "result" ? found.output.content : "";
  expect(text).toContain("- create_issue");
  expect(text).toContain("call one with use_tool");
  expect(await call("use_tool", { tool: "create_issue", arguments: {} })).toMatchObject({
    output: { content: "create_issue ok" },
  });
  // A tool on demand called by its own name still runs (the gateway knows every granted tool).
  expect(await call("list_issues", {})).toMatchObject({ output: { content: "list_issues ok" } });
  expect(await call("use_tool", { tool: "nope", arguments: {} })).toMatchObject({
    output: { isError: true, content: expect.stringContaining('No other tool named "nope"') },
  });
  expect(ran).toEqual(["create_issue", "list_issues"]);
  const steps = await f.db.select().from(schema.agentRunSteps).orderBy(asc(schema.agentRunSteps.seq));
  expect(steps.filter((s) => s.kind === "tool_call").map((s) => s.data.name)).toEqual([
    "find_tools",
    "create_issue",
    "list_issues",
    "use_tool",
  ]);
});

test("chooseToolGroups: one calibrated question per group, the threshold, and the core tools when the judge fails", async () => {
  const judge = createFakeJudge((kind, _id, _state, q) =>
    kind === "tool_groups" && JSON.stringify(q.instructions).includes("Sentry") ? 0.8 : 0.1,
  );
  const input = {
    orgId: "o",
    agent: { name: "Ada", role: "Dev", instructions: "" },
    message: "olha os erros do sentry",
    recent: [],
    tools: tools(),
  };
  const chosen = await chooseToolGroups(judge, input);
  expect(chosen).toMatchObject({ groups: ["sentry"], source: "judge" });
  expect(Object.keys(chosen.scores).sort()).toEqual(["browser", "issues", "sentry", "wiki"]);
  expect(judge.calls[0]).toMatchObject({ kind: "tool_groups", calibrated: true });

  const slow: Judge = { name: "slow", ask: () => new Promise(() => {}) };
  expect(await chooseToolGroups(slow, { ...input, timeoutMs: 5 })).toEqual({
    groups: [],
    scores: {},
    source: "timeout",
    kept: [],
  });
  // In a thread the list only grows: the previous run's groups stay without asking, even when the judge fails.
  expect(await chooseToolGroups(slow, { ...input, keep: ["browser", "gone"], timeoutMs: 5 })).toMatchObject({
    groups: ["browser"],
    kept: ["browser"],
  });
  const kept = await chooseToolGroups(judge, { ...input, keep: ["browser"] });
  expect(kept.groups).toEqual(["browser", "sentry"]);
  expect(Object.keys(kept.scores)).not.toContain("browser");
  const broken: Judge = {
    name: "broken",
    ask: async () => {
      throw new Error("down");
    },
  };
  expect(await chooseToolGroups(broken, input)).toEqual({ groups: [], scores: {}, source: "error", kept: [] });
});

test("a run lists what the judge expects it to need, keeps it for the whole run, and reaches the rest on demand", async () => {
  let step = 0;
  f = await setup({
    toolsOnDemand: true,
    issueTools: true,
    contextTools: true,
    reply: () => {
      step++;
      if (step === 1)
        return { chunks: [], toolUses: [{ name: "use_tool", input: { tool: "list_issues", arguments: {} } }] };
      return { chunks: ["Nenhuma issue aberta."] };
    },
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev quais issues estão abertas?",
  });
  await drainOutbox(f.db, f.handlers);

  const [first, second] = f.provider.calls.map((c) => c.request);
  const names = (first?.tools ?? []).map((t) => t.name);
  expect(names).toContain("search_context");
  expect(names).toContain("find_tools");
  expect(names).not.toContain("list_issues");
  expect(systemText(first?.system ?? "")).toContain("- On demand: Issues");
  // The same list on every turn of the run (the prompt cache stays valid).
  expect((second?.tools ?? []).map((t) => t.name)).toEqual(names);
  expect(JSON.stringify(second?.messages.at(-1)?.content)).not.toContain("Unknown tool");

  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  expect((run?.transcript as { toolGroups?: string[] } | null)?.toolGroups).toEqual([]);
  const [context] = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.kind, "context"));
  expect(context?.data.toolGroups).toMatchObject({ groups: [], source: "judge", scores: { issues: 0 } });

  // Used by the previous run here: the next run lists it as it is, without asking.
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev e as fechadas?",
  });
  await drainOutbox(f.db, f.handlers);
  const next = (f.provider.calls.at(-1)?.request.tools ?? []).map((t) => t.name);
  expect(next).toContain("list_issues");
  const contexts = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.kind, "context"))
    .orderBy(asc(schema.agentRunSteps.createdAt));
  // The last run's opening context (a later `context` step records how its turn ended, ADR 0097).
  expect(contexts.filter((c) => c.data.toolGroups).at(-1)?.data.toolGroups).toMatchObject({
    groups: ["issues"],
    kept: ["issues"],
  });

  // That run used no issue tool: the one after it goes without them (a greeting doesn't carry what was used before).
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev valeu" });
  await drainOutbox(f.db, f.handlers);
  expect((f.provider.calls.at(-1)?.request.tools ?? []).map((t) => t.name)).not.toContain("list_issues");
});

test("a reply counts its tools without the lookups: lookups alone leave no tools under it", async () => {
  let step = 0;
  f = await setup({
    toolsOnDemand: true,
    issueTools: true,
    contextTools: true,
    reply: () => {
      step++;
      // The first run looks a tool up, misnames one, then lists the issues; the second only looks.
      if (step === 1 || step === 4)
        return { chunks: [], toolUses: [{ name: "find_tools", input: { query: "issues" } }] };
      if (step === 2) return { chunks: [], toolUses: [{ name: "use_tool", input: { tool: "nope", arguments: {} } }] };
      if (step === 3)
        return { chunks: [], toolUses: [{ name: "use_tool", input: { tool: "list_issues", arguments: {} } }] };
      return { chunks: ["Nenhuma issue aberta."] };
    },
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  for (const body of ["@dev quais issues estão abertas?", "@dev e agora?"]) {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
    await drainOutbox(f.db, f.handlers);
  }
  const replies = (await f.db.select().from(schema.messages))
    .filter((m) => m.authorType === "agent")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const work = replies.map((m) => (m.meta as { work?: { steps: number; calls: { name: string; n?: number }[] } }).work);
  expect(work.map((w) => w?.steps)).toEqual([1, 0]);
  expect(work[0]?.calls).toEqual([{ name: "list_issues", n: 1 }]);
  expect(work[1]?.calls).toEqual([]);
});

test("a group the judge expects goes in as it is, with no directory when nothing is left", async () => {
  f = await setup({
    toolsOnDemand: true,
    issueTools: true,
    contextTools: true,
    // Every group it could load (Issues, and the rarely used memory tools, token-trim B3).
    judge: (kind) => (kind === "tool_groups" ? 0.9 : 0),
    reply: () => ({ chunks: ["ok"] }),
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev quais issues estão abertas?",
  });
  await drainOutbox(f.db, f.handlers);
  const names = (f.provider.calls[0]?.request.tools ?? []).map((t) => t.name);
  expect(names).toContain("list_issues");
  expect(names).toContain("propose_instruction_change");
  expect(names).not.toContain("find_tools");
});

test("a run whose judge lists the browser starts the agent's browser while it thinks; any other run, never", async () => {
  const warmed: unknown[] = [];
  let browser = true;
  f = await setup({
    toolsOnDemand: true,
    issueTools: true,
    toolSources: [{ name: "browser", tools: async () => [tool("browser_read", "browser:use")] }],
    judge: (kind, _id, _state, q) =>
      kind === "tool_groups" && JSON.stringify(q.instructions).includes("Browser:") && browser ? 0.9 : 0,
    reply: () => ({ chunks: ["ok"] }),
    warmBrowser: (at) => warmed.push(at),
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [
    { connectionId: null, scope: "issues:read" },
    { connectionId: null, scope: "browser:use" },
  ]);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev abre o site da loja",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  expect(warmed).toEqual([{ orgId: f.org.id, agentId: f.agent.id, threadRootId: run?.threadRootId }]);

  browser = false;
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev quais issues estão abertas?",
  });
  await drainOutbox(f.db, f.handlers);
  expect(f.provider.calls).toHaveLength(2);
  expect(warmed).toHaveLength(1);
});

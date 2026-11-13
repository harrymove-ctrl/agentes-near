import { afterEach, expect, test } from "bun:test";
import { asc, schema } from "@agenteschat/db";
import {
  compactSchema,
  createToolGateway,
  DIRECTORY_MAX_TOOLS,
  describeCapabilities,
  EVERY_TOOL,
  grantScopes,
  postPersonMessage,
  presentTools,
  rankTools,
  type ToolContext,
  type ToolDefinition,
} from "../src";
import { type Fixture, setup } from "./fixtures";

const WHY = "The person asked for this and the checks passed: this action finishes what was requested.";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const TIKTOK = "0b5c7f3e-1d2a-4c8b-9e6f-2a7d4c1b9e00";
const SMALL = "6d1e2f3a-4b5c-4d7e-8f90-a1b2c3d4e5f6";

/** Names like the real TikTok Ads connector's (382 tools; here 96, 48 of them for reading). */
const AREAS = [
  "ad",
  "adgroup",
  "campaign",
  "catalog",
  "creative",
  "report",
  "pixel",
  "audience",
  "bc",
  "comment",
  "identity",
  "video",
];
const READ = ["get", "list", "info", "stats"];
const VERBS = [...READ, "create", "update", "status_update", "delete"];

function tiktokTools(executed: string[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const area of AREAS) {
    for (const verb of VERBS) {
      const name = `tiktok_${area}_${verb}`;
      out.push({
        name,
        description: `[TikTok] ${area} ${verb.replace("_", " ")}: ${verb === "create" ? "Creates" : "Works with"} ${area}s in an advertiser account.`,
        inputSchema: {
          type: "object",
          properties: {
            advertiser_id: { type: "string", description: "The advertiser account" },
            ...(verb === "create" ? { name: { type: "string", description: `The new ${area}'s name` } } : {}),
          },
          required: verb === "create" ? ["advertiser_id", "name"] : ["advertiser_id"],
        },
        scope: READ.includes(verb) ? "tiktok:read" : "tiktok:write",
        connectionId: TIKTOK,
        connectorLabel: "TikTok",
        sensitive: !READ.includes(verb),
        execute: async (input) => {
          executed.push(name);
          return { content: `${name} ok: ${JSON.stringify(input)}` };
        },
      });
    }
  }
  return out;
}

const smallTools = (): ToolDefinition[] =>
  ["list_events", "get_visitor"].map((n) => ({
    name: `himetrica_${n}`,
    description: `[Himetrica] ${n}`,
    inputSchema: { type: "object", properties: {} },
    scope: "himetrica:read",
    connectionId: SMALL,
    connectorLabel: "Himetrica",
    execute: async () => ({ content: `${n} ok` }),
  }));

const builtIn: ToolDefinition = {
  name: "list_issues",
  description: "List issues.",
  inputSchema: { type: "object", properties: {} },
  scope: "",
  execute: async () => ({ content: "no issues" }),
};

async function ctxOf(fx: Fixture): Promise<ToolContext> {
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
  };
}

test("presentTools: a big connector becomes find_tools + use_tool; built-ins and small connectors stay as they are", () => {
  const big = tiktokTools([]);
  expect(big.length).toBeGreaterThan(DIRECTORY_MAX_TOOLS);
  const shown = presentTools([builtIn, ...smallTools(), ...big]);
  expect(shown.map((t) => t.name)).toEqual([
    "list_issues",
    "himetrica_list_events",
    "himetrica_get_visitor",
    "tiktok_find_tools",
    "tiktok_use_tool",
  ]);
  expect(shown.find((t) => t.name === "tiktok_find_tools")?.description).toContain("96 in all");
  // At the limit, a connector is still listed whole.
  expect(presentTools(big.slice(0, DIRECTORY_MAX_TOOLS))).toHaveLength(DIRECTORY_MAX_TOOLS);
});

test("rankTools finds the tool for what the agent needs, by name first", () => {
  const tools = tiktokTools([]);
  expect(rankTools(tools, "tiktok", "create an ad")[0]?.name).toBe("tiktok_ad_create");
  expect(rankTools(tools, "tiktok", "campaign reports")[0]?.name).toMatch(/^tiktok_(campaign|report)_/);
  expect(rankTools(tools, "tiktok", "pausar")).toEqual([]);
});

test("through the directory the real tool runs with its own scope, schema, steps and approval", async () => {
  f = await setup();
  const executed: string[] = [];
  const tools = createToolGateway({
    sources: [{ name: "fake", tools: async () => [builtIn, ...tiktokTools(executed)] }],
  });
  const ctx = await ctxOf(f);
  // Only reading is granted.
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: TIKTOK, scope: "tiktok:read" }]);
  const call = (name: string, input: Record<string, unknown>) =>
    tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });

  // The search only knows the tools the agent holds.
  const found = await call("tiktok_find_tools", { query: "campaign" });
  expect(found).toMatchObject({ type: "result" });
  const text = found.type === "result" ? found.output.content : "";
  expect(text).toContain("tiktok_campaign_get");
  expect(text).not.toContain("tiktok_campaign_create");

  expect(await call("tiktok_use_tool", { tool: "campaign_get", arguments: { advertiser_id: "a1" } })).toMatchObject({
    type: "result",
    output: { content: 'tiktok_campaign_get ok: {"advertiser_id":"a1"}' },
  });
  // A tool it doesn't hold is refused as its direct call is: it exists, its access doesn't cover it.
  expect(await call("tiktok_use_tool", { tool: "tiktok_campaign_create", arguments: {} })).toMatchObject({
    output: {
      isError: true,
      content: expect.stringContaining(
        "Not allowed: tiktok_campaign_create exists, but this agent's access to TikTok doesn't cover it (it needs the scope tiktok:write). Only an admin can change that",
      ),
    },
  });
  // Bad input shows the schema the model never saw.
  expect(await call("tiktok_use_tool", { tool: "tiktok_ad_get", arguments: {} })).toMatchObject({
    output: { isError: true, content: expect.stringContaining("Input schema of tiktok_ad_get") },
  });

  // Writing is granted: a sensitive tool through the directory asks for approval as itself.
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: TIKTOK, scope: "tiktok:write" }]);
  const asked = await call("tiktok_use_tool", {
    tool: "tiktok_ad_create",
    arguments: { advertiser_id: "a1", name: "Black Friday", why: WHY },
  });
  expect(asked).toMatchObject({ type: "approval", approval: { tool: "tiktok_ad_create", connectionId: TIKTOK } });
  expect(executed).toEqual(["tiktok_campaign_get"]);

  // The run's steps name the real tools, never `use_tool`.
  const steps = await f.db.select().from(schema.agentRunSteps).orderBy(asc(schema.agentRunSteps.seq));
  const called = steps.filter((s) => s.kind === "tool_call").map((s) => s.data.name);
  expect(called).toEqual([
    "tiktok_find_tools",
    "tiktok_campaign_get",
    "tiktok_campaign_create",
    "tiktok_ad_get",
    "tiktok_ad_create",
  ]);
});

test("the prompt names a big connector in one line, with how to find its tools and how many ask approval", () => {
  const text = describeCapabilities(presentTools([builtIn, ...smallTools(), ...tiktokTools([])]));
  expect(text).toContain(
    "- TikTok (96 tools): find the one you need with `tiktok_find_tools`, then run it with `tiktok_use_tool`.",
  );
  expect(text).toContain("- Himetrica: `himetrica_get_visitor`, `himetrica_list_events`");
  expect(text).toContain("48 TikTok tools (its search marks them)");
  expect(text).not.toContain("tiktok_ad_create");
  expect(text.length).toBeLessThan(2_000);
});

// ── A custom connector named after its label (the Vega CRM case) ──────────────

const VEGA = "6b3c1f0e-2a4d-4e8f-9b7a-1c2d3e4f5a6b";
const VEGA_READ = ["listar", "buscar", "obter", "contar", "exportar", "consultar"];
const VEGA_WRITE = ["criar", "atualizar"];
const VEGA_OF = ["atendimentos", "tickets", "departamentos", "contatos", "usuarios", "etiquetas", "mensagens"];

/** As a custom server's tools come: `vega_crm_` (its label) before each name; 56, 42 of them reads: a directory. */
function vegaTools(executed: string[]): ToolDefinition[] {
  return [...VEGA_READ, ...VEGA_WRITE].flatMap((verb) =>
    VEGA_OF.map((what): ToolDefinition => {
      const name = `vega_crm_${verb}_${what}`;
      const read = VEGA_READ.includes(verb);
      return {
        name,
        description: `[Vega CRM] ${verb} ${what}: ${read ? "Reads" : "Changes"} ${what} in the CRM.`,
        inputSchema: { type: "object", properties: { filtro: { type: "string" } } },
        scope: `custom:${VEGA}:${read ? "read" : "write"}`,
        connectionId: VEGA,
        connectorLabel: "Vega CRM",
        execute: async () => {
          executed.push(name);
          return { content: `${name} ok` };
        },
      };
    }),
  );
}

async function vegaGateway(executed: string[]) {
  f = await setup();
  const tools = createToolGateway({
    sources: [{ name: "fake", tools: async () => [builtIn, ...vegaTools(executed)] }],
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: VEGA, scope: `custom:${VEGA}:read` }]);
  const ctx = await ctxOf(f);
  const call = async (name: string, input: Record<string, unknown>, at = ctx) => {
    const r = await tools.invoke(at, { toolUseId: `tu_${Math.random()}`, name, input });
    return r.type === "result" ? r.output : { content: r.type, isError: false };
  };
  return { tools, ctx, call };
}

/** A built-in tool with a required field, for what a search shows of it. */
const noteTool = (name: string, more: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: "Writes a zebra note.",
  inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
  scope: "",
  execute: async () => ({ content: "noted" }),
  ...more,
});

const INPUT_LINE = /\n {2}input: /g;

test("with every tool listed, find_tools shows the input of its best 3 matches, `why` included; other runs have the schema already", async () => {
  f = await setup();
  const tools = createToolGateway({
    sources: [
      {
        name: "fake",
        tools: async () => [
          noteTool("note_a", { sensitive: true }),
          ...["note_b", "note_c", "note_d", "note_e"].map((n) => noteTool(n)),
        ],
      },
    ],
  });
  const ctx = await ctxOf(f);
  const find = async (loadedGroups: string[]) => {
    const r = await tools.invoke(
      { ...ctx, loadedGroups },
      { toolUseId: `tu_${Math.random()}`, name: "find_tools", input: { query: "zebra why" } },
    );
    return r.type === "result" ? r.output.content : "";
  };
  const every = await find([EVERY_TOOL]);
  expect(every).toStartWith('Already in your tool list for "zebra why"');
  expect(every.match(INPUT_LINE)).toHaveLength(3);
  expect(every).toContain('- note_a: Writes a zebra note.\n  input: {"required":["body","why"],');
  const input = '\n  input: {"required":["body"],"type":"object","properties":{"body":{"type":"string"}}}';
  expect(every).toContain(`- note_c: Writes a zebra note.${input}`);
  expect(every).toEndWith("- note_e: Writes a zebra note.");
  expect(await find([])).not.toContain("input:");
});

test("with every tool listed, a listed tool under a better match shows its input too", async () => {
  f = await setup();
  const big = tiktokTools([]).map((t, i) =>
    i === 0 ? { ...t, description: `${t.description} zebra zebra zebra` } : t,
  );
  const tools = createToolGateway({
    sources: [{ name: "fake", tools: async () => [noteTool("note_a"), ...big] }],
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: TIKTOK, scope: "tiktok:read" }]);
  const r = await tools.invoke(
    { ...(await ctxOf(f)), loadedGroups: [EVERY_TOOL] },
    { toolUseId: "tu_1", name: "find_tools", input: { query: "zebra" } },
  );
  const text = r.type === "result" ? r.output.content : "";
  expect(text).toContain("- tiktok_ad_get: ");
  expect(text).toContain(
    '- note_a (already in your tool list: call it directly): Writes a zebra note.\n  input: {"required":["body"]',
  );
});

test("a schema over the cut keeps what is required", () => {
  const properties = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`field_${i}`, { type: "string", description: "A long enough field." }]),
  );
  const text = compactSchema({ type: "object", properties, required: ["inbox_id"], additionalProperties: false });
  expect(text).toStartWith('{"required":["inbox_id"],"type":"object"');
  expect(text).toEndWith("…");
  expect(text.length).toBeLessThanOrEqual(1_501);
  expect(compactSchema({ type: "object", properties: {} })).toBe('{"type":"object","properties":{}}');
});

test("a big connector's directory takes the prefix its tools have; the names it had before still run", async () => {
  const shown = presentTools(vegaTools([]));
  expect(shown.map((t) => t.name)).toEqual(["vega_crm_find_tools", "vega_crm_use_tool"]);
  // Its areas are its tools' own words, not the label's second one.
  expect(shown[0]?.description).toContain("56 in all, about: atualizar, buscar, consultar, contar");

  const executed: string[] = [];
  const { call } = await vegaGateway(executed);
  // The names of before (the first word of the tools' names) for an agent in the middle of a conversation.
  expect((await call("vega_find_tools", { query: "listar departamentos" })).content).toContain(
    "- vega_crm_listar_departamentos:",
  );
  expect(await call("vega_use_tool", { tool: "crm_listar_departamentos", arguments: {} })).toMatchObject({
    content: "vega_crm_listar_departamentos ok",
  });
  // A harness's own name for a tool is that tool's, called directly or named to a use_tool.
  expect(await call("mcp__agentes__vega_crm_find_tools", { query: "obter tickets" })).toMatchObject({
    content: expect.stringContaining("- vega_crm_obter_tickets:"),
  });
  expect(
    await call("vega_crm_use_tool", { tool: "mcp__agentes__vega_crm_obter_tickets", arguments: {} }),
  ).toMatchObject({ content: "vega_crm_obter_tickets ok" });
  // A use_tool named to another runs what that one names.
  expect(
    await call("vega_use_tool", { tool: "vega_crm_use_tool", arguments: { tool: "obter_contatos", arguments: {} } }),
  ).toMatchObject({ content: "vega_crm_obter_contatos ok" });
  expect(executed).toEqual(["vega_crm_listar_departamentos", "vega_crm_obter_tickets", "vega_crm_obter_contatos"]);
  // No tools on demand here, so no use_tool of its own: the closest name is the connector's.
  expect(await call("use_tool", { tool: "vega_crm_obter_tickets", arguments: {} })).toEqual({
    content: "Unknown tool use_tool. The exact name is vega_crm_use_tool.",
    isError: true,
  });
});

test("a name one word away gets the exact one, and what runs it", async () => {
  const { call } = await vegaGateway([]);
  expect(await call("vega_listar_departamentos", {})).toEqual({
    content:
      "Unknown tool vega_listar_departamentos. The exact name is vega_crm_listar_departamentos (run it with vega_crm_use_tool).",
    isError: true,
  });
  expect(await call("vega_crm_use_tool", { tool: "vega_listar_departamentos", arguments: {} })).toEqual({
    content:
      'No Vega CRM tool named "vega_listar_departamentos". The exact name is vega_crm_listar_departamentos (run it with vega_crm_use_tool).',
    isError: true,
  });
  // Nothing close: where to look.
  expect(await call("vega_crm_use_tool", { tool: "pausar", arguments: {} })).toEqual({
    content: 'No Vega CRM tool named "pausar". Find the exact name with vega_crm_find_tools.',
    isError: true,
  });
  expect(await call("rm_rf", {})).toEqual({ content: "Unknown tool rm_rf", isError: true });
});

test("a write tool with read access is refused plainly: it exists, who can change the access", async () => {
  const executed: string[] = [];
  const { call, ctx } = await vegaGateway(executed);
  const refusal =
    "Not allowed: vega_crm_criar_tickets exists, but this agent's access to Vega CRM doesn't cover it (it needs write access). Only an admin can change that, on the agent's page in Tools and access (in Portuguese, Ferramentas e acesso): say so (the person asking may be that admin), never that the tool doesn't exist";
  // By its name, through the connector's directory and through the one of tools on demand: the same answer, and the
  // word the apps say under the call's line.
  const refused = { content: refusal, isError: true, data: { refusal: "noAccess" } };
  expect(await call("vega_crm_criar_tickets", {})).toEqual(refused);
  expect(await call("vega_crm_use_tool", { tool: "criar_tickets", arguments: {} })).toEqual(refused);
  const onDemand = { ...ctx, loadedGroups: [] };
  expect(await call("use_tool", { tool: "vega_crm_criar_tickets", arguments: {} }, onDemand)).toEqual(refused);
  // The search names it too, as beyond its access (never as missing).
  const found = (await call("find_tools", { query: "criar tickets" }, onDemand)).content;
  expect(found).toContain(
    "Beyond your access to their connector; only an admin can change it, on your page in Tools and access (in Portuguese, Ferramentas e acesso):\n- vega_crm_criar_tickets: [Vega CRM] criar tickets: Changes tickets in the CRM.",
  );
  expect(executed).toEqual([]);
});

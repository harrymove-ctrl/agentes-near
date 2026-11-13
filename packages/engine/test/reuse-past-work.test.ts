import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  buildRunContext,
  createChannel,
  drainOutbox,
  insertMessage,
  postPersonMessage,
  retrieveForRun,
  type ToolContext,
  type ToolSource,
} from "../src";
import { setup as baseSetup, type Fixture } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const MODELS_URL = "https://api.northwind.example/v1/models";

/** A stand-in for the agent's computer: a request to an address, which works only at the right one. */
const fetchSource: ToolSource = {
  name: "fetch",
  tools: async () => [
    {
      name: "fetch_url",
      description: "Fetch an address with a secret from your computer.",
      scope: "context:read",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, secret: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
      execute: async (input) =>
        input.url === MODELS_URL ? { content: '["ts-small","ts-large"]' } : { content: "404 Not Found", isError: true },
    },
  ],
};

const isReflect = (system: string) => system.includes("shared memory");

describe("agents reuse past work", () => {
  test("a figured-out task is saved as a how-to; a second similar request finds it, the earlier steps and the held secret's name", async () => {
    let step = 0;
    const secondSystems: string[] = [];
    f = await baseSetup({
      contextTools: true,
      toolSources: [fetchSource],
      reply: (req) => {
        const system = systemText(req.system);
        if (isReflect(system)) return { chunks: [JSON.stringify({ summary: "", items: [], entities: [] })] };
        const all = JSON.stringify(req.messages);
        if (all.includes("list the Northwind models again")) {
          secondSystems.push(system);
          return all.includes("your earlier step")
            ? { chunks: ["ts-small, ts-large"] }
            : { chunks: [], toolUses: [{ name: "search_context", input: { query: "northwind models" } }] };
        }
        step++;
        const calls: Record<number, { name: string; input: Record<string, unknown> }> = {
          1: { name: "fetch_url", input: { url: "https://northwind.example/api/models", secret: "NORTHWIND_API_KEY" } },
          2: { name: "fetch_url", input: { url: MODELS_URL, secret: "NORTHWIND_API_KEY" } },
          3: {
            name: "save_how_to",
            input: {
              title: "List the Northwind models",
              key: "northwind api list models",
              how: `GET ${MODELS_URL} with the NORTHWIND_API_KEY secret as a bearer token; script scripts/northwind-models.sh`,
            },
          },
        };
        const call = calls[step];
        return call ? { chunks: [], toolUses: [call] } : { chunks: ["ts-small, ts-large"] };
      },
    });
    const post = (body: string, channelId = f.general.id) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body });

    await post("@dev pull the models from the Northwind API");
    await drainOutbox(f.db, f.handlers);
    const results = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { name: string; isError: boolean });
    expect(results.map((r) => [r.name, r.isError])).toEqual([
      ["fetch_url", true],
      ["fetch_url", false],
      ["save_how_to", false],
    ]);
    const [howTo, ...others] = await f.db
      .select()
      .from(schema.contextItems)
      .where(eq(schema.contextItems.agentId, f.agent.id));
    expect(others).toEqual([]);
    expect([howTo?.kind, howTo?.scopeType, howTo?.channelIds, howTo?.createdByKind, howTo?.title]).toEqual([
      "note",
      "agent",
      [f.general.id],
      "agent",
      "List the Northwind models",
    ]);

    // The person gave the key through request_secret in that run; a removed one and another agent's don't count.
    const [run] = await f.db.select().from(schema.agentRuns);
    if (!run) throw new Error("no run");
    const secret = (name: string, extra: Partial<typeof schema.secretRequests.$inferInsert> = {}) => ({
      orgId: f.org.id,
      runId: run.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      toolUseId: `tu_${name}`,
      requestedForUserId: f.owner.id,
      name,
      purpose: "Northwind API",
      targetKind: "env" as const,
      publicKey: "fake-public-key",
      expiresAt: new Date(Date.now() + 60_000),
      status: "delivered" as const,
      deliveredAt: new Date(),
      ...extra,
    });
    await f.db
      .insert(schema.secretRequests)
      .values([
        secret("NORTHWIND_API_KEY"),
        secret("OLD_TOKEN", { removedAt: new Date() }),
        secret("NPM_TOKEN", { targetKind: "file", targetPath: ".npmrc" }),
      ]);

    // Elsewhere, later: another channel the agent is in.
    const ops = await createChannel(f.db, f.owner.id, f.org.id, { name: "ops", visibility: "public" });
    await addChannelMember(f.db, f.owner.id, f.org.id, ops.id, { agentId: f.agent.id });
    await post("@dev list the Northwind models again", ops.id);
    await drainOutbox(f.db, f.handlers);

    const first = secondSystems[0] ?? "";
    // Its memory carries the how-to; its computer's secrets are named, never their values.
    expect(first).toContain(`List the Northwind models: GET ${MODELS_URL}`);
    expect(first).toContain("# Secrets on your computer");
    expect(first).toContain("- NORTHWIND_API_KEY: an environment variable in your commands");
    expect(first).toContain("- NPM_TOKEN: the file .npmrc");
    expect(first).not.toContain("OLD_TOKEN");
    // The prompt says to look for past work first and to save what took figuring out.
    expect(first).toContain("Before a task, look for how it was done before");
    expect(first).toContain("save how you did it with `save_how_to`");

    // search_context finds the earlier calls themselves (in #general, searched from #ops), with how each ended.
    const search = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result" && (s.data as { name: string }).name === "search_context")
      .map((s) => (s.data as { content: string }).content);
    expect(search).toHaveLength(1);
    const lines = (search[0] ?? "").split("\n").filter((l) => l.startsWith("[your earlier step]"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`fetch_url {"url":"${MODELS_URL}"`);
    expect(lines[0]).toEndWith("(ok)");
    expect(lines[1]).toEndWith("(error)");

    // One shared word is not a match: a search about something else carries no earlier steps.
    const invoke = toolCaller(f, ops.id, (await post("something unrelated", ops.id)).id);
    const searchFor = async (query: string) =>
      (await invoke("search_context", { query })).split("\n").filter((l) => l.startsWith("[your earlier step]"));
    expect(await searchFor("the northwind invoices from last week")).toEqual([]);
    expect(await searchFor("the models from northwind")).toHaveLength(2);

    // In a mission's thread its tools act on the mission's computer (ADR 0029), not the one holding the key.
    const root = await post("mission root");
    await f.db.insert(schema.threads).values({ orgId: f.org.id, channelId: f.general.id, rootMessageId: root.id });
    await f.db.insert(schema.missions).values({
      orgId: f.org.id,
      threadRootId: root.id,
      channelId: f.general.id,
      agentId: f.agent.id,
      title: "Mobile app",
      goal: "Ship it",
      mainSessionId: "session-1",
    });
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    if (!agent) throw new Error("no agent");
    const inMission = await buildRunContext(f.db, { ...run, threadRootId: root.id }, agent, { maxMessages: 10 });
    expect(inMission.system.map((b) => b.text).join("\n")).not.toContain("# Secrets on your computer");
  });

  test("a how-to: untrusted when no person is behind the run, kept to a private channel, and out of the prompt unless the request matches it", async () => {
    f = await baseSetup({ contextTools: true, reply: () => ({ chunks: ["ok"] }) });
    const saveHowTo = async (channelId: string, background: boolean, title: string) => {
      const msg = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId,
        author: { type: "person", userId: f.owner.id },
        body: "@dev do it",
      });
      const invoke = toolCaller(f, channelId, msg.id, background);
      return invoke("save_how_to", {
        title,
        key: title,
        how: `GET https://api.northwind.example/${title} with NORTHWIND_API_KEY`,
      });
    };
    const itemNamed = async (title: string) =>
      (await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.title, title)))[0];

    // A routine's run (or a webhook's) read it somewhere: kept, but labeled as data.
    await saveHowTo(f.general.id, true, "export the invoices");
    expect((await itemNamed("export the invoices"))?.trust).toBe("low");
    await saveHowTo(f.general.id, false, "list the warehouses");
    expect((await itemNamed("list the warehouses"))?.trust).toBe("high");

    const finance = await createChannel(f.db, f.owner.id, f.org.id, { name: "finance", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, finance.id, { agentId: f.agent.id });
    await saveHowTo(finance.id, false, "pull the payroll totals");
    expect((await itemNamed("pull the payroll totals"))?.channelIds).toEqual([finance.id]);

    const memory = (text: string) =>
      retrieveForRun(f.context, { orgId: f.org.id, agentId: f.agent.id, channelId: f.general.id, text });
    // Private stays private, even when the request matches it.
    expect((await memory("pull the payroll totals")).text).not.toContain("payroll");
    // A how-to reaches the prompt when the request is about it, not in every run.
    expect((await memory("list the warehouses please")).text).toContain("list the warehouses");
    expect((await memory("good morning")).text).not.toContain("warehouses");
  });
});

/** Calls the agent's tools as a run in `channelId` triggered by `triggerMessageId` would (a routine's when `background`). */
function toolCaller(fx: typeof f, channelId: string, triggerMessageId: string, background = false) {
  let run: Promise<string> | null = null;
  const runId = () =>
    (run ??= fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId,
        threadRootId: triggerMessageId,
        triggerMessageId,
        trigger: "mention",
        hop: 1,
        background,
      })
      .returning()
      .then(([r]) => r?.id ?? ""));
  return async (name: string, input: Record<string, unknown>) => {
    const ctx: ToolContext = {
      db: fx.db,
      orgId: fx.org.id,
      agentId: fx.agent.id,
      runId: await runId(),
      channelId,
      threadRootId: triggerMessageId,
      triggerMessageId,
    };
    const tools = fx.tools;
    if (!tools) throw new Error("no tools");
    const r = await tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
    if (r.type !== "result") throw new Error(`expected a result, got ${r.type}`);
    return r.output.content;
  };
}

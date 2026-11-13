import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acceptCustomSuggestion,
  applyToolPins,
  type CustomDeps,
  connectCustomServer,
  createConnectorToolSource,
  type Judge,
  listNotifications,
  type McpConnect,
  mcpSessionOver,
  notify,
  saveCustomTools,
  toolFingerprint,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

// ADR 0117 (addendum): a tool its server changed applies itself, with its level worked out again and an audit entry.

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const V1 = "Search the knowledge base for articles";
const V2 = "Search the knowledge base, newest first.";

/** A server whose tools the test changes between listings: `workspace_notes` has no verb, so only its hint says it reads. */
function notesMcp() {
  const state = { description: V1, withLimit: false, notes: "Shows the workspace's notes", notesReadOnly: true };
  const build = () => {
    const server = new McpServer({ name: "notes", version: "1" });
    server.registerTool(
      "search_articles",
      {
        description: state.description,
        inputSchema: state.withLimit ? { q: z.string(), limit: z.number().optional() } : { q: z.string() },
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text" as const, text: "no articles" }] }),
    );
    server.registerTool(
      "workspace_notes",
      { description: state.notes, inputSchema: {}, annotations: { readOnlyHint: state.notesReadOnly } },
      async () => ({ content: [{ type: "text" as const, text: "no notes" }] }),
    );
    return server;
  };
  const connect: McpConnect = async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await build().connect(server);
    return mcpSessionOver(client);
  };
  return { connect, state };
}

/** Says every tool it is asked about changes data. */
const judge: Judge = {
  name: "fake",
  ask: async ({ questions }) =>
    Object.fromEntries(
      Object.keys(questions).map((k) => [k, { choice: k.startsWith("level_") ? "write" : "changes_undoable" }]),
    ),
};

async function connected() {
  f = await setup();
  const mcp = notesMcp();
  const deps: CustomDeps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect: mcp.connect,
    judge,
  };
  const started = await connectCustomServer(deps, f.owner.id, f.org.id, {
    serverUrl: "https://notes.example.com/mcp",
    apiKey: "fake-api-key-for-tests",
    label: "Notes",
  });
  if (started.status !== "connected") throw new Error(started.status);
  const id = started.server.id;
  await acceptCustomSuggestion(deps, f.owner.id, f.org.id, id);
  const ctx = await runContext(f);
  // A new source each time: its 60 s listing cache would hide the server's change.
  const seen = async (name = "search_articles") => {
    const tools = await createConnectorToolSource(deps).tools(ctx);
    const tool = tools.find((t) => t.name.endsWith(name));
    if (!tool) throw new Error("no tool");
    return tool;
  };
  const pin = async (name = "search_articles") => {
    const [row] = await f.db
      .select()
      .from(schema.connectorToolPins)
      .where(and(eq(schema.connectorToolPins.connectionId, id), eq(schema.connectorToolPins.toolName, name)));
    if (!row) throw new Error("no pin");
    return row;
  };
  const audits = () =>
    f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "connector.tool_definitions_changed"));
  return { mcp, deps, id, seen, pin, audits };
}

test("a changed description reaches agents at once: no notice, nothing waiting, one audit entry", async () => {
  const w = await connected();
  expect((await w.seen()).description).toContain(V1);
  w.mcp.state.description = V2;
  // Listed twice: the new text both times, recorded once.
  expect((await w.seen()).description).toContain(V2);
  expect((await w.seen()).description).toContain(V2);
  expect(await f.db.select().from(schema.notifications)).toEqual([]);
  expect(await w.pin()).toMatchObject({
    description: V2,
    fingerprint: toolFingerprint({ description: V2, inputSchema: (await w.pin()).inputSchema }),
    pendingFingerprint: null,
  });
  const audits = await w.audits();
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ orgId: f.org.id, actorType: "system", targetId: w.id });
  expect(audits[0]?.details).toMatchObject({
    connection: "Notes",
    tools: [{ tool: "search_articles", descriptionBefore: V1, descriptionAfter: V2, inputChanged: false }],
  });
});

test("an input-only change applies too, and the tool is callable with the new input", async () => {
  const w = await connected();
  expect(Object.keys((await w.seen()).inputSchema.properties as object)).toEqual(["q"]);
  w.mcp.state.withLimit = true;
  const tool = await w.seen();
  expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["q", "limit"]);
  expect((await w.audits())[0]?.details).toMatchObject({ tools: [{ tool: "search_articles", inputChanged: true }] });
  expect((await tool.execute({ q: "x", limit: 1 }, await runContext(f))).content).toContain("no articles");
});

test("a version left waiting for a review is applied by the next listing", async () => {
  const w = await connected();
  const waiting = { pendingFingerprint: "v2", pendingDescription: V2, pendingSchema: {}, changedAt: new Date() };
  await f.db.update(schema.connectorToolPins).set(waiting).where(eq(schema.connectorToolPins.connectionId, w.id));
  w.mcp.state.description = V2;
  expect((await w.seen()).description).toContain(V2);
  expect(await w.pin()).toMatchObject({ description: V2, pendingFingerprint: null, pendingDescription: null });
  // A tool whose server went back to the pinned version has nothing left waiting either.
  expect(await w.pin("workspace_notes")).toMatchObject({ pendingFingerprint: null, changedAt: null });
  expect(await w.audits()).toHaveLength(1);
});

test("a read that became a write is treated as a write from the same listing on", async () => {
  const w = await connected();
  expect((await w.seen("workspace_notes")).scope).toBe(`custom:${w.id}:read`);
  w.mcp.state.notes = "Shows the workspace's notes and rewrites the ones you pass";
  w.mcp.state.notesReadOnly = false;
  const tool = await w.seen("workspace_notes");
  expect(tool.description).toContain("rewrites");
  expect(tool.scope).toBe(`custom:${w.id}:write`);
});

test("a level a person set by hand stays theirs when the tool changes", async () => {
  const w = await connected();
  await saveCustomTools(w.deps, f.owner.id, f.org.id, w.id, {
    label: "Notes",
    tools: [{ name: "workspace_notes", access: "read", label: "Notes" }],
  });
  w.mcp.state.notes = "Shows the workspace's notes and rewrites the ones you pass";
  w.mcp.state.notesReadOnly = false;
  const tool = await w.seen("workspace_notes");
  expect(tool.description).toContain("rewrites");
  expect(tool.scope).toBe(`custom:${w.id}:read`);
});

test("a changed tool whose level can't be worked out again keeps its pinned version", async () => {
  const w = await connected();
  const listed = [{ name: "search_articles", description: V2, inputSchema: (await w.pin()).inputSchema }];
  const connection = { id: w.id, orgId: f.org.id, label: "Notes" };
  const failing = { db: f.db, reclassify: () => Promise.reject(new Error("unreachable")) };
  expect((await applyToolPins(failing, connection, listed, () => true))[0]?.description).toBe(V1);
  expect((await w.pin()).description).toBe(V1);
  expect((await applyToolPins({ db: f.db }, connection, listed, () => true))[0]?.description).toBe(V2);
  expect((await w.pin()).description).toBe(V2);
});

test("a notice from when changes waited for a review is never listed or counted", async () => {
  const w = await connected();
  await notify(
    { db: f.db },
    {
      orgId: f.org.id,
      userIds: [f.owner.id],
      kind: "connector_tool_changed",
      groupKey: `connector_tool_changed:${w.id}:v2`,
      waiting: true,
      source: { label: "Notes" },
      latest: { title: "search_articles" },
    },
  );
  expect(await f.db.select().from(schema.notifications)).toHaveLength(1);
  const inbox = await listNotifications({ db: f.db }, f.owner.id, f.org.id);
  expect([inbox.items, inbox.counts.waiting, inbox.counts.unread]).toEqual([[], 0, 0]);
});

import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  createDesktopToolSource,
  DESKTOP_SCOPE,
  drainOutbox,
  grantScopes,
  type MachineCaller,
  postPersonMessage,
  SANDBOX_SCOPE,
} from "../src";
import {
  absorbBrowserCall,
  absorbToolData,
  type BrowserTrailStep,
  mergeToolEffects,
  type ToolSideEffects,
} from "../src/run-tools";
import { fakeHub } from "./desktop-fixtures";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("what the agent did on its desktop, for the card after the run", () => {
  const at = new Date("2026-10-24T12:00:00.000Z");

  test("single desktop calls join the desktop's trail, a plan only by its steps; the browser keeps its own", () => {
    const t: ToolSideEffects = {};
    absorbBrowserCall(t, { name: "desktop_read", input: { find: "the error" } }, false, at);
    absorbBrowserCall(t, { name: "mcp__agentes__desktop_screenshot", input: {} }, true, at);
    absorbBrowserCall(t, { name: "desktop_do", input: { steps: [] } }, false, at);
    absorbBrowserCall(t, { name: "browser_read", input: {} }, false, at);
    expect(t.desktop).toEqual([
      { tool: "desktop_read", at: at.toISOString() },
      { tool: "desktop_screenshot", at: at.toISOString(), failed: true },
    ]);
    expect(t.browser).toEqual([{ tool: "browser_read", at: at.toISOString() }]);

    // A plan's steps, from its result: only the desktop's own tools.
    absorbToolData(t, {
      desktopTrail: [
        { tool: "desktop_open", detail: "Files" },
        { tool: "browser_click" },
        { tool: "desktop_press", failed: true },
        { detail: "no tool" },
      ],
    });
    expect(t.desktop?.slice(2).map(({ at: _, ...s }) => s)).toEqual([
      { tool: "desktop_open", detail: "Files" },
      { tool: "desktop_press", failed: true },
    ]);
    expect(t.browser).toHaveLength(1);

    // A computer brain's calls, kept by the bridge, join the loop's.
    mergeToolEffects(t, { desktop: [{ tool: "desktop_read", at: at.toISOString() }] });
    expect(t.desktop?.map((s) => s.tool)).toEqual([
      "desktop_read",
      "desktop_screenshot",
      "desktop_open",
      "desktop_press",
      "desktop_read",
    ]);
  });
});

test("a run's reply carries its desktop steps (meta.desktop), and what it opened is in the audit log", async () => {
  const holder: { hub?: MachineCaller } = {};
  const source = createDesktopToolSource({
    machines: {
      hub: {
        status: (id) => (holder.hub as MachineCaller).status(id),
        call: (id, request, o) => (holder.hub as MachineCaller).call(id, request, o),
      },
    },
  });
  // The model plans on the desktop, reads it, then answers.
  const results = (req: ModelRequest) => (JSON.stringify(req.messages).match(/tool_result/g) ?? []).length;
  f = await setup({
    toolSources: [source],
    reply: (req) =>
      results(req) === 0
        ? {
            chunks: [],
            toolUses: [
              {
                name: "desktop_do",
                input: {
                  steps: [
                    { do: "open", app: "Files" },
                    { do: "double_click", target: "Documents" },
                    { do: "open", path: "reports/q3.ods" },
                    { do: "hover", target: "Documents" },
                    { do: "press", key: "ctrl+s" },
                  ],
                },
              },
            ],
          }
        : results(req) === 1
          ? { chunks: [], toolUses: [{ name: "desktop_read", input: {} }] }
          : { chunks: ["Pronto: abri o relatório."] },
  });
  const fx = f;
  const paired = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, { name: "Box" });
  await fx.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, fx.agent.id));
  holder.hub = fakeHub({ machineId: paired.machineId, orgId: fx.org.id }).hub;
  await grantScopes(fx.db, fx.org.id, fx.agent.id, [
    { connectionId: null, scope: DESKTOP_SCOPE },
    { connectionId: null, scope: SANDBOX_SCOPE },
  ]);

  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "@dev abre o relatório do trimestre",
  });
  await drainOutbox(fx.db, fx.handlers);

  const replies = await fx.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.orgId, fx.org.id), eq(schema.messages.authorType, "agent")));
  expect(replies.map((m) => m.body)).toEqual(["Pronto: abri o relatório."]);
  const meta = replies[0]?.meta as { desktop?: { steps: BrowserTrailStep[] }; browser?: unknown };
  expect(meta.browser).toBeUndefined();
  // Each step as the tool it stands for, a hover told as a click, the app in the agent's words, never what it read.
  expect(meta.desktop?.steps.map(({ at: _, ...s }) => s)).toEqual([
    { tool: "desktop_open", detail: "Files" },
    { tool: "desktop_double_click" },
    { tool: "desktop_open_file" },
    { tool: "desktop_click" },
    { tool: "desktop_press" },
    { tool: "desktop_read" },
  ]);
  expect(meta.desktop?.steps.every((s) => !Number.isNaN(Date.parse(s.at)))).toBe(true);

  const audit = await fx.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, fx.org.id), eq(schema.auditLog.actorId, fx.agent.id)));
  expect(
    audit
      .filter((a) => a.action.startsWith("desktop."))
      .map((a) => ({ action: a.action, target: a.targetId, details: a.details }))
      .sort((a, b) => a.action.localeCompare(b.action)),
  ).toEqual([
    {
      action: "desktop.app_opened",
      target: paired.machineId,
      details: { app: "thunar.desktop", runId: expect.any(String) },
    },
    {
      action: "desktop.file_opened",
      target: paired.machineId,
      details: { path: "reports/q3.ods", runId: expect.any(String) },
    },
  ]);
});

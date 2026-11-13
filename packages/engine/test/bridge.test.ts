import { afterEach, describe, expect, test } from "bun:test";
import { MCP_TOOLS_MAX, MISSION_MCP_TOOLS, type ServerFrame } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  createMission,
  createMissionRunToolSource,
  grantScopes,
  issueRunToolToken,
  type MachineHub,
  postPersonMessage,
  revokeRunToolTokens,
  startSessionTask,
  type ToolDefinition,
  type ToolSource,
  verifyRunToolToken,
} from "../src";
import { answerSteering, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { missionRunner, pairedMachine, RUNNER, type TaskStartRequest } from "./mission-helpers";
import { fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

type McpTools = Extract<ServerFrame, { type: "mcp.tools" }>;
type McpResult = Extract<ServerFrame, { type: "mcp.result" }>;

/** A tool whose schema uses `$ref` and a top-level `oneOf` (as some MCP servers send). */
const refSource: ToolSource = {
  name: "ref-tools",
  tools: async () => [
    {
      name: "lookup",
      description: "Look something up",
      scope: "github:pr.read",
      inputSchema: {
        $defs: { id: { type: "string", minLength: 1 } },
        oneOf: [
          { type: "object", properties: { id: { $ref: "#/$defs/id" } }, required: ["id"] },
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        ],
      },
      execute: async () => ({ content: "found" }),
    },
  ],
};

/** A fake runner that can send bridge frames and wait for the answer. */
function bridgeRunner(hub: MachineHub) {
  const runner = missionRunner(hub);
  let n = 0;
  const wait = async <T extends ServerFrame>(pick: (s: ServerFrame) => s is T): Promise<T> => {
    for (let i = 0; i < 400; i++) {
      const found = runner.sent.find(pick);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("no answer from the server");
  };
  return {
    ...runner,
    async list(token: string, taskId = "run"): Promise<McpTools> {
      const callId = `list-${++n}`;
      await runner.frame({ type: "mcp.list", callId, taskId, token });
      return wait((s): s is McpTools => s.type === "mcp.tools" && s.callId === callId);
    },
    async call(token: string, tool: string, args: Record<string, unknown>, taskId = "run"): Promise<McpResult> {
      const callId = `call-${++n}`;
      await runner.frame({ type: "mcp.call", callId, taskId, tool, args, token });
      return wait((s): s is McpResult => s.type === "mcp.result" && s.callId === callId);
    },
  };
}

const names = (r: McpTools) => (r.ok ? r.tools.map((t) => t.name).sort() : []);

async function runningRun(threadRootId?: string) {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "hi",
    ...(threadRootId ? { threadId: threadRootId } : {}),
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: threadRootId ?? msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("no run");
  // A later runningRun's "hi", the same person writing again, may go into this run.
  answerSteering(f, run);
  return run;
}

async function otherMachine() {
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  return pairMachine(deps, f.owner.id, f.org.id, { name: "Other", ...RUNNER, exec: true });
}

describe("runner MCP bridge (ADR 0032)", () => {
  async function connected() {
    const gh = fakeGithub();
    f = await setup({ machines: true, toolSources: [gh.source, refSource], reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    await grantScopes(f.db, f.org.id, f.agent.id, [
      { connectionId: null, scope: "github:pr.read" },
      { connectionId: null, scope: "github:pr.merge" },
    ]);
    const runner = bridgeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    return { gh, paired, runner };
  }

  test("tools/list returns the run's tools with the agent's scopes, schemas the CLIs accept", async () => {
    const { paired, runner } = await connected();
    const run = await runningRun();
    const token = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: paired.machineId,
      runId: run.id,
    });
    const listed = await runner.list(token);
    expect(listed.ok).toBe(true);
    // github:pr.write isn't granted: github_close_pr isn't listed.
    expect(names(listed)).toContain("github_get_pr");
    expect(names(listed)).toContain("github_merge_pr");
    expect(names(listed)).not.toContain("github_close_pr");
    // No mission here: no mission tools, and never Claude Code's prompt tool.
    expect(names(listed)).not.toContain("update_plan");
    expect(names(listed)).not.toContain("permission_prompt");
    const lookup = listed.ok ? listed.tools.find((t) => t.name === "lookup") : undefined;
    expect(JSON.stringify(lookup?.inputSchema)).not.toContain("$ref");
    expect(lookup?.inputSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string", minLength: 1 }, name: { type: "string" } },
    });
    expect(lookup?.inputSchema.oneOf).toBeUndefined();
  });

  test("a call goes through the gateway: steps recorded; a gated call posts the card and pauses the run", async () => {
    const { gh, paired, runner } = await connected();
    const run = await runningRun();
    const token = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: paired.machineId,
      runId: run.id,
    });
    const read = await runner.call(token, "github_get_pr", { repo: "a/b", pr: 3 });
    expect(read).toMatchObject({ ok: true, text: "github_get_pr ok: a/b#3" });
    expect(gh.executed).toEqual([{ tool: "github_get_pr", input: { repo: "a/b", pr: 3 } }]);
    const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
    expect(steps.map((s) => s.kind)).toEqual(["tool_call", "tool_result"]);

    // Bad input and tools the agent lacks: refused by the gateway, with codes.
    expect(await runner.call(token, "github_get_pr", { repo: "a/b" })).toMatchObject({
      ok: false,
      error: { code: "tool.invalid_input" },
    });
    expect(await runner.call(token, "github_close_pr", { repo: "a/b", pr: 3 })).toMatchObject({
      ok: false,
      error: { code: "tool.not_allowed" },
    });

    const merge = await runner.call(token, "github_merge_pr", {
      repo: "a/b",
      pr: 3,
      why: "The checks passed and the change was reviewed: this action finishes what was asked.",
    });
    expect(merge.ok && merge.text).toContain("Waiting for a person to approve");
    expect(gh.executed).toHaveLength(1);
    const [approval] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.id));
    expect(approval).toMatchObject({ tool: "github_merge_pr", status: "pending" });
    expect(approval?.messageId).not.toBeNull();
    const card = (await f.db.select().from(schema.messages)).find((m) => m.meta.approvalId === approval?.id);
    expect(card?.authorAgentId).toBe(f.agent.id);
    const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(after?.status).toBe("waiting_approval");
    // While it waits, the brain gets no more tools.
    expect(await runner.call(token, "github_get_pr", { repo: "a/b", pr: 4 })).toMatchObject({
      ok: false,
      error: { code: "bridge.run_waiting" },
    });
  });

  test("a token from another machine, of an ended run, revoked or unknown is refused", async () => {
    const { paired, runner } = await connected();
    const run = await runningRun();
    const token = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: paired.machineId,
      runId: run.id,
    });
    const other = await otherMachine();
    const intruder = bridgeRunner(f.machineHub as MachineHub);
    await intruder.hello(other.token);
    expect(await intruder.call(token, "github_get_pr", { repo: "a/b", pr: 3 })).toMatchObject({
      ok: false,
      error: { code: "bridge.wrong_machine" },
    });
    expect(await intruder.list(token)).toMatchObject({ ok: false, error: { code: "bridge.wrong_machine" } });
    expect(await runner.call(`agr_${"x".repeat(43)}`, "github_get_pr", { repo: "a/b", pr: 3 })).toMatchObject({
      ok: false,
      error: { code: "bridge.invalid_token" },
    });

    // Another run's token never acts for this one; an ended run's token is dead.
    const second = await runningRun();
    const secondToken = await issueRunToolToken(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      machineId: paired.machineId,
      runId: second.id,
    });
    expect((await verifyRunToolToken(f.db, paired.machineId, secondToken)).ok && true).toBe(true);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, second.id));
    expect(await runner.call(secondToken, "github_get_pr", { repo: "a/b", pr: 3 })).toMatchObject({
      ok: false,
      error: { code: "bridge.run_ended" },
    });
    const check = await verifyRunToolToken(f.db, paired.machineId, token);
    expect(check).toMatchObject({ ok: true, identity: { runId: run.id, machineId: paired.machineId } });

    await revokeRunToolTokens(f.db, { runId: run.id });
    expect(await runner.list(token)).toMatchObject({ ok: false, error: { code: "bridge.invalid_token" } });
  });
});

describe("mission tools through the bridge", () => {
  async function proposed() {
    f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    const runner = bridgeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const view = await createMission(f.missionDeps, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Build our mobile app",
      title: "Mobile app",
      repoDir: "app",
    });
    // An item session of the mission (the main session is the agent's run in the thread).
    const [mission] = await f.db.select().from(schema.missions);
    if (!mission) throw new Error("no mission");
    await startSessionTask(f.missionDeps, mission, {
      title: "Explore",
      prompt: "Map the repo",
      sessionId: crypto.randomUUID(),
      cwd: mission.repoDir,
      resume: false,
    });
    const plan = runner.started[0] as TaskStartRequest;
    return { view, runner, plan, paired };
  }

  test("a computer-brain run gets the mission tools only in its mission's thread", async () => {
    const { view, runner, paired } = await proposed();
    const inThread = await runningRun(view.threadId as string);
    const elsewhere = await runningRun();
    const tokenOf = (runId: string) =>
      issueRunToolToken(f.db, { orgId: f.org.id, agentId: f.agent.id, machineId: paired.machineId, runId });
    const there = names(await runner.list(await tokenOf(inThread.id)));
    expect(there).toEqual(expect.arrayContaining(["update_plan", "report", "ask_decision", "request_review"]));
    expect(there).not.toContain("send_to_mission");
    expect(there).not.toContain("permission_prompt");
    const outside = names(await runner.list(await tokenOf(elsewhere.id)));
    expect(outside).not.toContain("update_plan");
    expect(outside).not.toContain("report");
  });

  test("a connector with hundreds of tools never pushes the mission tools out of the list (it stands as its directory)", async () => {
    const connectionId = crypto.randomUUID();
    const many: ToolSource = {
      name: "big-connector",
      tools: async () =>
        Array.from({ length: MCP_TOOLS_MAX + 50 }, (_, i) => ({
          name: `ads_tool_${i}`,
          description: "An ads tool",
          scope: "ads:read",
          connectionId,
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({ content: "ok" }),
        })),
    };
    f = await setup({ machines: true, missionTools: true, toolSources: [many], reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    const runner = bridgeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId, scope: "connector:*" }]);
    const view = await createMission(f.missionDeps, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Write three TikTok tips",
      title: "Tips",
      repoDir: "tips",
    });
    const run = await runningRun(view.threadId as string);
    const listed = await runner.list(
      await issueRunToolToken(f.db, {
        orgId: f.org.id,
        agentId: f.agent.id,
        machineId: paired.machineId,
        runId: run.id,
      }),
    );
    // A big connector stands as its directory (ADR 0043), so the list stays under the cap; the mission tools are there.
    expect(listed.ok && listed.tools.length).toBeLessThanOrEqual(MCP_TOOLS_MAX);
    expect(names(listed)).toEqual(
      expect.arrayContaining(["update_plan", "report", "complete_mission", "ads_find_tools", "ads_use_tool"]),
    );
    expect(names(listed).some((n) => n.startsWith("ads_tool_"))).toBe(false);
  });

  test("a computer-brain run's machine mission tools (start_task, upload_artifact, get_context) only in its mission's thread", async () => {
    const { view, paired } = await proposed();
    const run = await runningRun(view.threadId as string);
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: view.threadId as string,
      triggerMessageId: run.triggerMessageId,
      bridge: { machineId: paired.machineId },
    };
    const { db: _db, ...deps } = f.missionDeps;
    const source = createMissionRunToolSource(deps);
    const npm = { tool_name: "Bash", input: { command: "npm install" } };
    const there = await source.tools(ctx);
    expect(there.map((t) => t.name).sort()).toEqual([
      "get_context",
      "permission_prompt",
      "start_task",
      "upload_artifact",
    ]);
    // The mission's command flow (a proposed mission only reads).
    const prompt = there.find((t) => t.name === "permission_prompt");
    expect((await prompt?.execute(npm, ctx))?.content).toContain("plan isn't approved");
    // Elsewhere the run is an ordinary run: code's own rules decide (`runPermissionPrompt`).
    const other = await runningRun();
    const elsewhere = {
      ...ctx,
      runId: other.id,
      threadRootId: other.threadRootId,
      triggerMessageId: other.triggerMessageId,
    };
    const outside = await source.tools(elsewhere);
    expect(outside.map((t) => t.name)).toEqual(["permission_prompt"]);
    expect((await outside[0]?.execute(npm, elsewhere))?.content).not.toContain("plan isn't approved");
  });

  test("a mission task's token: its own tools (permission_prompt included), bound to that task and machine", async () => {
    const { runner, plan, paired } = await proposed();
    const token = plan.mission?.mcpToken as string;
    expect(token).toMatch(/^agr_/);
    const listed = await runner.list(token, plan.taskId);
    // The mission's tools but approvals (those are the main session's).
    expect(names(listed)).toEqual(
      MISSION_MCP_TOOLS.map((t) => t.name)
        .filter((n) => n !== "request_approval")
        .sort(),
    );

    const reported = await runner.call(token, "report", { summary: "Mapped the repo" }, plan.taskId);
    expect(reported).toMatchObject({ ok: true });
    expect(reported.ok && reported.text).toContain("Reported");
    // Same refusal codes as before the bridge.
    expect(await runner.call(token, "report", { nope: 1 }, plan.taskId)).toMatchObject({
      ok: false,
      error: { code: "mission.invalid_input" },
    });
    // A task's executor never gets the agent's other tools.
    expect(await runner.call(token, "propose_mission", { title: "x", goal: "y" }, plan.taskId)).toMatchObject({
      ok: false,
      error: { code: "mission.unknown_tool" },
    });
    // The legacy path (an older runner: no token) still works.
    expect(await runner.mcp(plan.taskId, "report", { summary: "Still here" })).toMatchObject({ ok: true });

    const other = await otherMachine();
    const intruder = bridgeRunner(f.machineHub as MachineHub);
    await intruder.hello(other.token);
    expect(await intruder.call(token, "report", { summary: "hi" }, plan.taskId)).toMatchObject({
      ok: false,
      error: { code: "bridge.wrong_machine" },
    });

    await runner.done(plan.taskId);
    for (let i = 0; i < 100; i++) {
      const [task] = await f.db
        .select()
        .from(schema.machineTasks)
        .where(and(eq(schema.machineTasks.id, plan.taskId), eq(schema.machineTasks.machineId, paired.machineId)));
      if (task?.endedAt) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await runner.call(token, "report", { summary: "late" }, plan.taskId)).toMatchObject({
      ok: false,
      error: { code: "mission.task_ended" },
    });
  });
});

describe("a kept-alive computer brain after a grant (the Vega CRM case)", () => {
  const VEGA = "6b3c1f0e-2a4d-4e8f-9b7a-1c2d3e4f5a6b";
  const PORTAL = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

  /** A custom server of 56 tools named after its label (42 reads: a directory once granted), and a small one. */
  function connectors(executed: string[]): ToolSource {
    const tool = (connectionId: string, label: string, name: string, scope: string): ToolDefinition => ({
      name,
      description: `[${label}] ${name.replace(/_/g, " ")}`,
      inputSchema: { type: "object", properties: {} },
      scope,
      connectionId,
      connectorLabel: label,
      execute: async () => {
        executed.push(name);
        return { content: `${name} ok` };
      },
    });
    const verbs = ["listar", "buscar", "obter", "contar", "exportar", "consultar", "criar", "atualizar"];
    const things = ["atendimentos", "tickets", "departamentos", "contatos", "usuarios", "etiquetas", "mensagens"];
    const vega = verbs.flatMap((verb, i) =>
      things.map((what) =>
        tool(VEGA, "Vega CRM", `vega_crm_${verb}_${what}`, `custom:${VEGA}:${i < 6 ? "read" : "write"}`),
      ),
    );
    const portal = ["listar_colaboradores", "buscar_ferias"].map((n) =>
      tool(PORTAL, "Portal do Colaborador", `portal_do_colaborador_${n}`, `custom:${PORTAL}:read`),
    );
    return { name: "connectors", tools: async () => [...vega, ...portal] };
  }

  test("the run after a grant reaches its tools from the list the process started with: find_tools, use_tool, the tool runs", async () => {
    const executed: string[] = [];
    f = await setup({ machines: true, toolSources: [connectors(executed)], reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    const runner = bridgeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: PORTAL, scope: `custom:${PORTAL}:read` }]);
    const tokenOf = (runId: string) =>
      issueRunToolToken(f.db, { orgId: f.org.id, agentId: f.agent.id, machineId: paired.machineId, runId });
    // The tool groups the judge loaded for the run (ADR 0043), as the executor keeps them.
    const loads = (runId: string, toolGroups: string[]) =>
      f.db.update(schema.agentRuns).set({ transcript: { toolGroups } }).where(eq(schema.agentRuns.id, runId));

    // Before the grant: the Claude Code process lists its tools when it starts, and keeps that list.
    const first = await runningRun();
    await loads(first.id, []);
    const token1 = await tokenOf(first.id);
    const harness = names(await runner.list(token1));
    expect(harness).toEqual(expect.arrayContaining(["find_tools", "use_tool"]));
    expect(harness.some((n) => n.startsWith("vega"))).toBe(false);
    const looked = await runner.call(token1, "find_tools", { query: "Vega CRM listar atendimentos chat" });
    expect(looked.ok && looked.text).toContain("portal_do_colaborador_listar_colaboradores");
    expect(looked.ok && looked.text).not.toContain("vega");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, first.id));

    // Read access given; the next run loads the connector, which stands as its directory.
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: VEGA, scope: `custom:${VEGA}:read` }]);
    const second = await runningRun(first.threadRootId);
    await loads(second.id, [`custom:${VEGA}`]);
    const token2 = await tokenOf(second.id);
    expect(names(await runner.list(token2))).toEqual(
      expect.arrayContaining(["vega_crm_find_tools", "vega_crm_use_tool"]),
    );
    // The same process still has `harness`: its search says the directory is listed, and how to run it if not.
    const found = await runner.call(token2, "find_tools", { query: "Vega CRM" });
    expect(found.ok && found.text).toStartWith(
      `Already in your tool list for "Vega CRM": call them directly (if your list doesn't show them yet, use_tool runs them too).`,
    );
    expect(found.ok && found.text).toContain("- vega_crm_find_tools:");
    // The call that failed then, as it was made: the directory's search through use_tool, by the name it had.
    const search = await runner.call(token2, "use_tool", {
      tool: "vega_find_tools",
      arguments: { limit: 10, query: "buscar atendimentos chat e listar tickets e departamentos" },
    });
    expect(search.ok && search.text).toContain("- vega_crm_listar_departamentos:");
    expect(
      await runner.call(token2, "use_tool", { tool: "vega_crm_listar_departamentos", arguments: {} }),
    ).toMatchObject({ ok: true, text: "vega_crm_listar_departamentos ok" });
    expect(executed).toEqual(["vega_crm_listar_departamentos"]);
  });
});

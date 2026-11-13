import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  createJobHandlers,
  decideApproval,
  drainOutbox,
  executeToolForRun,
  grantScopes,
  listApprovals,
  listMessages,
  postPersonMessage,
  type ToolSource,
  toolsForRun,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

/**
 * ADR 0032 block 1: the engine is brain-agnostic. A scripted brain (not the
 * model brain, no Model Gateway) drives a whole run: deltas, tool calls
 * through the Tool Gateway, approvals, usage and failures.
 */

let f: Fixture;
afterEach(() => f?.close());

/** A brain that replays a script per turn and keeps what each turn received. */
function scriptedBrain(script: (n: number, turn: BrainTurn) => BrainEvent[]) {
  const seen: { messages: BrainTurn["messages"]; tools: string[]; system: string; trigger: string }[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      const n = seen.length;
      seen.push({
        messages: turn.messages,
        tools: turn.tools.map((t) => t.name),
        system: turn.system,
        trigger: turn.trigger,
      });
      for (const event of script(n, turn)) yield event;
    },
  };
  return { brain, seen };
}

/** A tool every agent may call (no scope), counting its calls. */
function envTool() {
  const calls: unknown[] = [];
  const source: ToolSource = {
    name: "env",
    tools: async () => [
      {
        name: "check_env",
        description: "Check the environment",
        scope: "",
        inputSchema: { type: "object", properties: { what: { type: "string" } }, additionalProperties: false },
        async execute(input) {
          calls.push(input);
          return { content: "go: not found" };
        },
      },
    ],
  };
  return { source, calls };
}

const handlersWith = (fx: Fixture, brain: Brain) =>
  createJobHandlers({ ...fx.jobDeps, brains: { model: () => brain } });

const post = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

const stepsOf = async (fx: Fixture, runId: string) =>
  (await fx.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, runId))).sort(
    (a, b) => a.seq - b.seq,
  );

test("a fake brain's text deltas become the agent's message, posted whole; usage lands on the model_call step", async () => {
  f = await setup();
  const { brain, seen } = scriptedBrain(() => [
    { type: "text_delta", text: "Olá, " },
    { type: "text_delta", text: "tudo certo." },
    { type: "usage", input: 120, output: 8, source: "plan", model: "opus" },
    { type: "done", text: "Olá, tudo certo." },
  ]);
  const events = f.listen(f.general.id);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlersWith(f, brain));

  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.map((m) => m.body)).toEqual(["@dev oi", "Olá, tudo certo."]);
  // It writes: the apps say so, its words wait for the message.
  expect(events.filter((e) => e.type === "agent.typing")).toHaveLength(1);
  expect(JSON.stringify(events.filter((e) => e.type !== "message.created"))).not.toContain("tudo certo");
  expect(events.at(-1)).toMatchObject({ type: "message.handled", status: "done" });

  // The brain got the engine-built context (system with the org context, the trigger).
  expect(seen[0]?.system).toContain("Acme builds rockets.");
  expect(seen[0]?.trigger).toBe("@dev oi");
  expect(seen[0]?.messages.at(-1)?.role).toBe("user");

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const call = (await stepsOf(f, run?.id ?? "")).find((s) => s.kind === "model_call");
  expect(call?.data).toMatchObject({ model: "opus", stopReason: "end_turn", inputTokens: 120, outputTokens: 8 });
  // No Model Gateway call for the run: nothing billed to the API.
  expect(
    await f.db
      .select()
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.runId, run?.id ?? "")),
  ).toEqual([]);
});

test("a computer brain's text before its own tool call is only its step line; the text that ends the turn is the message", async () => {
  f = await setup();
  const { brain } = scriptedBrain(() => [
    { type: "text_delta", text: "I need the inbox id first." },
    { type: "tool_call", id: "t1", name: "Bash", input: { command: "ls" }, executed: { content: "ok" } },
    { type: "text_delta", text: "Caixa " },
    { type: "text_delta", text: "conferida." },
    { type: "done", text: "Caixa conferida." },
  ]);
  const events = f.listen(f.general.id);
  await post(f, "@dev confere a caixa");
  await drainOutbox(f.db, handlersWith(f, brain));

  // Its first sentence is the call's step line (`said`, ADR 0121), and nowhere else.
  const said = events.flatMap((e) => ("said" in e && e.said ? [e.said] : []));
  expect(said).toEqual(["I need the inbox id first"]);
  expect(JSON.stringify(events, (k, v) => (k === "said" ? undefined : v))).not.toContain("inbox id");
  expect(JSON.stringify(events.filter((e) => e.type !== "message.created"))).not.toContain("conferida");
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.map((m) => m.body)).toEqual(["@dev confere a caixa", "Caixa conferida."]);
});

test("a tool_call runs through the Tool Gateway and its result is fed back on the next turn", async () => {
  const env = envTool();
  f = await setup({ toolSources: [env.source] });
  const { brain, seen } = scriptedBrain((n) =>
    n === 0
      ? [
          { type: "text_delta", text: "Vou verificar." },
          { type: "tool_call", id: "call-1", name: "check_env", input: { what: "go" } },
          { type: "done", text: "Vou verificar." },
        ]
      : [{ type: "done", text: "Go não está instalado." }],
  );
  await post(f, "@dev tem Go aí?");
  await drainOutbox(f.db, handlersWith(f, brain));

  expect(env.calls).toEqual([{ what: "go" }]);
  expect(seen.length).toBe(2);
  expect(seen[0]?.tools).toContain("check_env");
  expect(seen[1]?.messages.at(-1)).toEqual({ role: "user", content: "[tool result: go: not found]" });
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.map((m) => m.body)).toEqual(["@dev tem Go aí?", "Go não está instalado."]);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(run?.turns).toBe(2);
  const kinds = (await stepsOf(f, run?.id ?? "")).map((s) => s.kind);
  expect(kinds).toContain("tool_call");
  expect(kinds).toContain("tool_result");
  // The transcript keeps the same shape as a model run (tool_use, then tool_result).
  const transcript = run?.transcript as { messages: { role: string; content: unknown }[] };
  expect(JSON.stringify(transcript.messages)).toContain('"type":"tool_use"');
  expect(JSON.stringify(transcript.messages)).toContain('"type":"tool_result"');

  // The bridge seam (block 2) sees the same tools and runs them the same way.
  const id = { orgId: f.org.id, agentId: f.agent.id, runId: run?.id ?? "", machineId: "m-1" };
  expect((await toolsForRun(f.jobDeps, id)).map((t) => t.name)).toEqual(["check_env"]);
  expect(await executeToolForRun(f.jobDeps, id, { id: "call-2", name: "check_env", input: {} })).toEqual({
    content: "go: not found",
    isError: false,
  });
  expect(env.calls.length).toBe(2);
});

test("a gated tool call from a fake brain pauses the run; approving resumes it on the same brain", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const { brain, seen } = scriptedBrain((n) =>
    n === 0
      ? [
          {
            type: "tool_call",
            id: "call-1",
            name: "github_merge_pr",
            input: {
              repo: "acme/app",
              pr: 42,
              why: "The checks passed and the change was reviewed: this action finishes what was asked.",
            },
          },
          { type: "done", text: "" },
        ]
      : [{ type: "done", text: "Merged." }],
  );
  const handlers = handlersWith(f, brain);
  await post(f, "@dev merge PR 42");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_approval");
  expect(gh.executed).toEqual([]);
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(approval?.title).toBe("Merge PR #42 in acme/app");

  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(gh.executed).toEqual([{ tool: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }]);
  expect(seen[1]?.messages.at(-1)?.content).toContain("github_merge_pr ok: acme/app#42");

  // The bridge seam (block 2, the same path as the runner bridge): a gated call for a run that already
  // ended is refused without posting a card (nothing would ever resume it), and never runs.
  const id = { orgId: f.org.id, agentId: f.agent.id, runId: run?.id ?? "", machineId: "m-1" };
  const gated = await executeToolForRun(f.jobDeps, id, {
    id: "call-x",
    name: "github_merge_pr",
    input: {
      repo: "acme/app",
      pr: 7,
      why: "The checks passed and the change was reviewed: this action finishes what was asked.",
    },
  });
  expect(gated.isError).toBe(true);
  expect(gated.pause).toBeUndefined();
  expect(gh.executed.length).toBe(1);
  const [late] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.toolUseId, "call-x"));
  expect(late?.status).toBe("canceled");
  const cards = (await f.db.select().from(schema.messages)).filter((m) => m.meta.approvalId === late?.id);
  expect(cards).toEqual([]);
});

test("a brain's error event fails the run with its code", async () => {
  f = await setup();
  const { brain } = scriptedBrain(() => [
    { type: "text_delta", text: "Pensando" },
    { type: "error", code: "executor_offline", message: "The computer is offline" },
  ]);
  const events = f.listen(f.general.id);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlersWith(f, brain));

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("failed");
  expect(run?.error).toBe("executor_offline");
  expect(events.at(-1)).toMatchObject({ type: "message.handled", status: "failed" });
});

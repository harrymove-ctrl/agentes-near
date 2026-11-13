import { MACHINE_PROTOCOL_VERSION, type RealtimeEvent } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, ProviderError } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  type BrainEvent,
  type BrainFactory,
  type BrainKind,
  type BrainTurn,
  createJobHandlers,
  createPassToolSource,
  decideApproval,
  drainOutbox,
  grantScopes,
  HAND_OFF_TOOL,
  invokeToolForRun,
  type MachineStatus,
  postPersonMessage,
  type RoutineInput,
  runRoutineNow,
  type ToolContext,
  type ToolResult,
  type ToolSource,
  verifyRunToolToken,
} from "../../src";
import { type Fixture, setup } from "../fixtures";
import { pairMachine } from "../machine-fixtures";
import { channelRoutine, routineDeps } from "../routine-fixtures";

/**
 * The conformance harness (ADR 0053 §12): one scenario, written once as data, played by every brain
 * through the real executor (`createJobHandlers` + `drainOutbox`). The model brain is the fake
 * provider answering each model call with the script's next step; Claude Code and Codex are scripted
 * brains at the engine boundary that reach our tools the way the runner bridge does (the turn's run
 * tool token, `verifyRunToolToken`, `invokeToolForRun`) and yield what ran, text and done/error.
 */

export const BRAINS: readonly BrainKind[] = ["model", "claude_code", "codex"];

// ── Scripts ──────────────────────────────────────────────────────────────────

/** One tool call a brain makes. */
export interface ScriptCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * One step of a run, the same on every brain: the model brain answers one model call with it; a
 * computer brain runs its calls through the bridge inside one turn and goes on to the next step,
 * until a call pauses the run, a step ends the turn or the final step (no calls) answers.
 */
export interface ScriptStep {
  /** With no calls: the final answer ("" = nothing to say). */
  text?: string;
  calls?: ScriptCall[];
  /** The brain fails here: the model brain's provider refuses for good, a computer brain's CLI exits. */
  crash?: string;
  /** Computer brains end their turn after this step (the engine reads what came in meanwhile). */
  turnEnds?: boolean;
}

/**
 * A run's script. `background`: the routine's own run (it is offered `hand_off`), told apart from the
 * conversation run its report wakes.
 */
export interface ScriptRun {
  background?: boolean;
  steps: ScriptStep[];
}

export interface Scenario {
  name: string;
  /** Brains it truly can't apply to, with why. */
  skip?: Partial<Record<BrainKind, string>>;
  runs: ScriptRun[];
  /** The agent's computer is away from the start (computer brains). */
  offline?: boolean;
  /** Runs inside the `look` tool, while the run works (a person stops it, writes into it…). */
  onLook?: (h: Harness, ctx: ToolContext) => Promise<void>;
  /** Starts the work and drives it to its end (approvals, answers) through the real executor. */
  start(h: Harness): Promise<void>;
  /** Asserts the end state only: messages and where, runs, approvals, steps, ledger, notifications. */
  end(h: Harness): Promise<void>;
}

/** The script's run for a turn: the routine's own when the brain is offered `hand_off`. */
export function pickRun(runs: readonly ScriptRun[], background: boolean): number {
  return Math.max(
    0,
    runs.findIndex((r) => Boolean(r.background) === background),
  );
}

/** A call's id, the same on every brain: which run, step and call of the script (unique per run). */
const callId = (run: number, step: number, call: number) => `cf_${run}_${step}_${call}`;
const CALL_ID = /^cf_(\d+)_(\d+)_\d+$/;

/** The model brain's next step: one past the last step whose calls are already in the transcript. */
function nextModelStep(request: ModelRequest, run: number): number {
  let next = 0;
  for (const m of request.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const block of m.content) {
      const id = block.type === "tool_use" ? CALL_ID.exec(block.id) : null;
      if (id && Number(id[1]) === run) next = Math.max(next, Number(id[2]) + 1);
    }
  }
  return next;
}

/** The fake provider scripted per call: each model call gets its run's next step. */
export function modelReply(runs: readonly ScriptRun[]) {
  return (request: ModelRequest): FakeReply | Error => {
    const run = pickRun(
      runs,
      (request.tools ?? []).some((t) => t.name === HAND_OFF_TOOL),
    );
    const steps = runs[run]?.steps ?? [];
    const at = Math.max(0, Math.min(nextModelStep(request, run), steps.length - 1));
    const step: ScriptStep = steps[at] ?? {};
    if (step.crash) return new ProviderError(step.crash, false, 400);
    const calls = step.calls ?? [];
    return {
      chunks: step.text ? [step.text] : [],
      ...(calls.length > 0
        ? { toolUses: calls.map((c, i) => ({ id: callId(run, at, i), name: c.name, input: c.input })) }
        : {}),
    };
  };
}

/** Plan usage, as a computer brain reports it at the end of a turn. */
const PLAN_USAGE: BrainEvent = { type: "usage", input: 120, output: 30, source: "plan" };

/**
 * A computer brain (Claude Code or Codex) at the engine boundary: it plays its run's script, calling
 * our tools as the runner bridge does with the turn's real token, and yields what ran (`executed`),
 * its text, usage and done; a stop aborts the turn as the real brains do (`canceled`).
 */
function computerBrain(h: Harness, kind: BrainKind, runs: readonly ScriptRun[]): BrainFactory {
  return (_agent, _run, bridge) => ({
    kind,
    async *run(turn, io) {
      h.turns++;
      let cursor = h.cursors.get(turn.runId);
      if (!cursor) {
        cursor = {
          run: pickRun(
            runs,
            turn.tools.some((t) => t.name === HAND_OFF_TOOL),
          ),
          at: 0,
        };
        h.cursors.set(turn.runId, cursor);
      }
      const steps = runs[cursor.run]?.steps ?? [];
      for (;;) {
        const at = Math.max(0, Math.min(cursor.at, steps.length - 1));
        const step: ScriptStep = steps[at] ?? {};
        cursor.at = at + 1;
        if (step.crash) {
          yield { type: "error", code: "executor_crashed", message: step.crash };
          return;
        }
        if (step.text) yield { type: "text_delta", text: step.text };
        const calls = step.calls ?? [];
        if (calls.length === 0) {
          yield PLAN_USAGE;
          yield { type: "done", text: step.text ?? "" };
          return;
        }
        let paused = false;
        for (const [i, call] of calls.entries()) {
          const id = callId(cursor.run, at, i);
          const executed = await bridgeCall(h, bridge.mcpToken(), turn, { id, ...call });
          yield { type: "tool_call", id, name: call.name, input: call.input, executed };
          if (io.signal.aborted) {
            yield { type: "error", code: "canceled", message: "The turn was canceled." };
            return;
          }
          if (executed.pause) paused = true;
        }
        // Paused (the run waits for a person), told to end here, or out of script: the turn ends.
        if (paused || step.turnEnds || at >= steps.length - 1) {
          yield PLAN_USAGE;
          yield { type: "done", text: "" };
          return;
        }
      }
    },
  });
}

/** One call through the runner bridge: the turn's token checked like the socket does, then the shared path. */
async function bridgeCall(
  h: Harness,
  token: string,
  turn: BrainTurn,
  call: { id: string; name: string; input: Record<string, unknown> },
): Promise<ToolResult> {
  const who = await verifyRunToolToken(h.f.db, turn.session?.machineId ?? "", token);
  if (!who.ok) return { content: who.error.message, isError: true };
  const out = await invokeToolForRun({ db: h.f.db, pubsub: h.f.pubsub, tools: h.f.tools ?? null }, who.identity, call);
  return out.result;
}

// ── Tools every scenario can use ─────────────────────────────────────────────

/** A connected app's connection (no row needed: scopes and approvals only carry its id). */
export const CRM_CONNECTION = "0193c0de-0000-7000-8000-00000000c0de";

/** How many times each tool really ran. */
export interface ToolCounts {
  look: number;
  deploy: number;
  file: number;
  crm: number;
}

/**
 * A read (`look`), a sensitive action (`deploy_app`), an internal change people can undo
 * (`file_issue`) and a connected app's write (`crm_update_contact`).
 */
function conformanceTools(harness: () => Harness | undefined): ToolSource {
  const count = (key: keyof ToolCounts) => {
    const h = harness();
    if (h) h.counts[key]++;
  };
  return {
    name: "conformance",
    tools: async () => [
      {
        name: "look",
        description: "Look at the open pull requests and the checkout errors",
        scope: "context:read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, ctx) => {
          count("look");
          const h = harness();
          if (h?.scenario.onLook) await h.scenario.onLook(h, ctx);
          return { content: "3 PRs open; 12 new checkout errors since 9:00" };
        },
      },
      {
        name: "deploy_app",
        description: "Deploy the app",
        scope: "",
        sensitive: true,
        inputSchema: {
          type: "object",
          properties: { env: { type: "string" } },
          required: ["env"],
          additionalProperties: false,
        },
        describe: () => ({ title: "Deploy to production" }),
        execute: async () => {
          count("deploy");
          return { content: "Deployed 2.15 to production." };
        },
      },
      {
        name: "file_issue",
        description: "File an issue",
        scope: "issues:write",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
        execute: async () => {
          count("file");
          return { content: "Issue #7 created." };
        },
      },
      {
        name: "crm_update_contact",
        description: "Update a contact in the CRM",
        scope: "crm:contact.write",
        connectionId: CRM_CONNECTION,
        connectorLabel: "CRM",
        inputSchema: {
          type: "object",
          properties: { contact: { type: "string" }, status: { type: "string" } },
          required: ["contact", "status"],
          additionalProperties: false,
        },
        describe: (input) => ({ title: `Mark ${String(input.contact)} as ${String(input.status)}` }),
        execute: async () => {
          count("crm");
          return { content: "Contact updated." };
        },
      },
    ],
  };
}

// ── The harness ──────────────────────────────────────────────────────────────

export interface Harness {
  kind: BrainKind;
  scenario: Scenario;
  f: Fixture;
  /** The agent's computer (computer brains). */
  machineId: string | null;
  /** Whether that computer answers. */
  online: boolean;
  /** Computer turns started, and where each run is in its script. */
  turns: number;
  cursors: Map<string, { run: number; at: number }>;
  counts: ToolCounts;
  /** What a scenario keeps between its start, its hook and its checks. */
  vars: Record<string, string>;
  /** Everything published in #general. */
  events: RealtimeEvent[];
  handlers: ReturnType<typeof createJobHandlers>;
  /** Runs every job that is due, until none is left. */
  drain(): Promise<void>;
}

/** A computer as the hub reports it: online (or not), with both coding CLIs, signed in. */
const statusOf = (id: string, orgId: string, online: boolean): MachineStatus => ({
  id,
  orgId,
  name: "MacBook",
  online,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: {
    claude: { version: "2.1.300", loggedIn: true },
    codex: { version: "0.163.0" },
    detectedAt: new Date().toISOString(),
  },
});

/** A fresh workspace (owner `ana`, `#general`, agent `@dev`) whose agent thinks with `kind`. */
export async function createHarness(kind: BrainKind, scenario: Scenario): Promise<Harness> {
  let current: Harness | undefined;
  const f = await setup({
    reply: modelReply(scenario.runs),
    toolSources: [conformanceTools(() => current), createPassToolSource()],
    askUser: true,
    react: true,
    handOff: true,
    chatTools: true,
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [
    { connectionId: null, scope: "context:read" },
    { connectionId: null, scope: "issues:write" },
    { connectionId: CRM_CONNECTION, scope: "crm:contact.write" },
  ]);
  let machineId: string | null = null;
  if (kind !== "model") {
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      hostname: "mac",
      os: "darwin",
      arch: "arm64",
      version: "0.9.0",
      protocol: MACHINE_PROTOCOL_VERSION,
      workspace: "/Users/ana/agentes",
      exec: true,
    });
    machineId = paired.machineId;
    await f.db.update(schema.agents).set({ machineId, brain: kind }).where(eq(schema.agents.id, f.agent.id));
  }
  const h: Harness = {
    kind,
    scenario,
    f,
    machineId,
    online: !scenario.offline,
    turns: 0,
    cursors: new Map(),
    counts: { look: 0, deploy: 0, file: 0, crm: 0 },
    vars: {},
    events: f.listen(f.general.id),
    handlers: f.handlers,
    drain: async () => {
      await drainOutbox(f.db, h.handlers);
    },
  };
  if (kind !== "model") {
    const brains: Partial<Record<BrainKind, BrainFactory>> = {};
    brains[kind] = computerBrain(h, kind, scenario.runs);
    h.handlers = createJobHandlers({
      ...f.jobDeps,
      brains,
      machines: { status: async (id) => statusOf(id, f.org.id, h.online) },
    });
  }
  current = h;
  return h;
}

// ── Helpers for scenarios ────────────────────────────────────────────────────

/** A person (`ana`) writes in #general. */
export const say = (h: Harness, body: string, threadId?: string) =>
  postPersonMessage({ db: h.f.db, pubsub: h.f.pubsub }, h.f.owner.id, h.f.org.id, h.f.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });

/** A routine of `@dev` that reports to #general (access `read` unless given), run now by its creator. */
export async function runRoutine(h: Harness, input: Partial<RoutineInput> = {}) {
  const routine = await channelRoutine(h.f, {
    name: "Erros do checkout",
    prompt: "Confira os erros novos do checkout e os PRs abertos.",
    ...input,
  });
  h.vars.routineId = routine.id;
  await runRoutineNow(routineDeps(h.f), h.f.owner.id, h.f.org.id, routine.id);
  await h.drain();
  return routine;
}

/** The person approves every pending approval. */
export async function approveAll(h: Harness) {
  const pending = await h.f.db.select().from(schema.approvals).where(eq(schema.approvals.status, "pending"));
  for (const approval of pending) {
    await decideApproval({ db: h.f.db, pubsub: h.f.pubsub }, h.f.owner.id, h.f.org.id, approval.id, {
      decision: "approve",
    });
  }
}

/** Every agent run, oldest first. */
export const agentRuns = (h: Harness) =>
  h.f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt, schema.agentRuns.id);

/** What agents posted (notices left out), oldest first; in one conversation when given. */
export async function agentPosts(h: Harness, channelId?: string) {
  return (await h.f.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorType === "agent" && !m.meta.notice && (!channelId || m.channelId === channelId),
  );
}

/** A run's steps of a kind, in order (their data). */
export async function stepsOf(h: Harness, runId: string, kind: string) {
  const steps = await h.f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, runId))
    .orderBy(schema.agentRunSteps.seq);
  return steps.filter((s) => s.kind === kind).map((s) => s.data);
}

/** The routine's only routine run. */
export async function routineRunOf(h: Harness) {
  const rows = await h.f.db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.routineId, h.vars.routineId ?? ""));
  if (rows.length !== 1) throw new Error(`expected one routine run, found ${rows.length}`);
  return rows[0] as (typeof rows)[number];
}

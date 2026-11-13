/**
 * Probe: what a real `codex app-server` says to the runner's Codex brain
 * (`apps/server/runner/brain-codex-app.ts`), without an OpenAI sign-in.
 *
 *   bun apps/server/scripts/probe-codex-app-server.ts [path/to/codex]
 *
 * It starts `codex app-server` (stdio JSON-RPC, one JSON object per line, no
 * `jsonrpc` field) in an empty `CODEX_HOME` (so nothing of the machine's own
 * sign-in or config is used) with the same `-c` overrides the brain passes,
 * then: `initialize` + `initialized`, `account/read`, `thread/start`,
 * `turn/steer` with no turn running, `thread/resume` of an unknown thread,
 * `turn/start` (its model request can't succeed without a sign-in), a
 * `turn/steer` into it, one with the wrong turn id, `turn/interrupt`, and
 * prints every reply and notification. `PROBE_WAIT_MS` (default 15 s): how
 * long the turn runs before the interrupt.
 *
 * What it showed with codex-cli 0.163.0 (2026-10-23, no sign-in, no network
 * to OpenAI):
 * - `initialize` answers `{ userAgent, codexHome, platformFamily, platformOs }`
 *   (`optOutNotificationMethods` accepted); requests before it are refused
 *   (-32600 "Not initialized").
 * - `account/read`: `{ account: null, requiresOpenaiAuth: true }`.
 * - `thread/start` works signed out: `{ thread: { id, … }, model, cwd,
 *   approvalPolicy: "never", sandbox: { type: "workspaceWrite", writableRoots,
 *   networkAccess: true, … } }` plus `thread/started`: the `-c` overrides
 *   (network, writable roots, our MCP server, which then reports
 *   `mcpServer/startupStatus/updated`) apply.
 * - `turn/steer` with no turn: -32600 "no active turn to steer"; with another
 *   turn's id: -32600 "expected active turn id `X` but found `Y`" (the brain
 *   maps both to `no_turn`).
 * - `thread/resume` of an unknown id: -32600 "no rollout found for thread id …".
 * - `turn/start` answers `{ turn: { id, status: "inProgress" } }` at once,
 *   then `turn/started` and the prompt as a `userMessage` item whose
 *   `clientId` is our `clientUserMessageId`.
 * - `turn/steer` into it answers `{ turnId }`, and the steered input comes as
 *   its own `userMessage` item (`item/started` + `item/completed`) with our
 *   `clientUserMessageId` as `clientId`: the read confirmation.
 * - Signed out, the model request fails: `error` notifications with
 *   `willRetry: true` ("Reconnecting... n/5"), a `warning`, more retries.
 * - `turn/interrupt` answers `{}`, then `turn/completed` with
 *   `status: "interrupted"`.
 *
 * Re-run it after a Codex update; the brain's shapes come from
 * `codex app-server generate-ts` of the version named in brain-codex-app.ts.
 */
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const bin = process.argv[2] ?? "codex";
const home = mkdtempSync(path.join(os.tmpdir(), "codex-probe-home-"));
const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-probe-cwd-"));

const child = spawn(
  bin,
  [
    "app-server",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    `sandbox_workspace_write.writable_roots=${JSON.stringify([os.tmpdir()])}`,
    "-c",
    'mcp_servers.agenteschat_agentes.command="true"',
    "-c",
    'mcp_servers.agenteschat_agentes.default_tools_approval_mode="approve"',
  ],
  { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
);
child.stderr.on("data", (c: Buffer) => process.stderr.write(`[stderr] ${c.toString("utf8")}`));

let next = 1;
const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
(createInterface({ input: child.stdout }) as unknown as EventEmitter).on("line", (line: string) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(`[non-json] ${line}`);
    return;
  }
  if (typeof msg.id === "number" && !("method" in msg)) {
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
    return;
  }
  console.log(`<- ${"id" in msg ? "server request" : "notification"} ${line.slice(0, 600)}`);
});

const request = (method: string, params: unknown, timeoutMs = 15_000) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const id = next++;
    const timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
const show = (label: string, msg: unknown) => console.log(`== ${label}: ${JSON.stringify(msg).slice(0, 1500)}`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  show("before initialize (thread/start)", await request("thread/start", {}));
  show(
    "initialize",
    await request("initialize", {
      clientInfo: { name: "agentes_runner_probe", title: null, version: "0.0.0" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        // The same opt-outs as the brain (noise it never reads).
        optOutNotificationMethods: ["item/commandExecution/outputDelta", "item/reasoning/textDelta"],
      },
    }),
  );
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  show("account/read", await request("account/read", {}));
  const started = await request("thread/start", {
    cwd,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    developerInstructions: "You are a probe.",
    config: { model_reasoning_effort: "low" },
    ephemeral: true,
  });
  show("thread/start", started);
  show("thread/start sandbox", (started.result as { sandbox?: unknown } | undefined)?.sandbox);
  const threadId = ((started.result as { thread?: { id?: string } } | undefined)?.thread?.id ?? "") as string;
  show(
    "turn/steer (no turn)",
    await request("turn/steer", {
      threadId,
      expectedTurnId: "00000000-0000-0000-0000-000000000000",
      clientUserMessageId: "probe-steer",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    }),
  );
  show(
    "thread/resume (unknown id)",
    await request("thread/resume", { threadId: "01a166e3-0000-7000-8000-000000000000", cwd, excludeTurns: true }),
  );
  const turn = await request("turn/start", {
    threadId,
    clientUserMessageId: "probe-start",
    input: [{ type: "text", text: "Say hi.", text_elements: [] }],
  });
  show("turn/start", turn);
  const turnId = (turn.result as { turn?: { id?: string } } | undefined)?.turn?.id;
  if (turnId) {
    show(
      "turn/steer (turn just started)",
      await request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        clientUserMessageId: "probe-steer-2",
        input: [{ type: "text", text: "Also say bye.", text_elements: [] }],
      }),
    );
  }
  if (turnId) {
    show(
      "turn/steer (wrong expectedTurnId)",
      await request("turn/steer", {
        threadId,
        expectedTurnId: "00000000-0000-0000-0000-000000000000",
        input: [{ type: "text", text: "x", text_elements: [] }],
      }),
    );
  }
  await wait(Number(process.env.PROBE_WAIT_MS ?? 15_000));
  if (turnId) show("turn/interrupt", await request("turn/interrupt", { threadId, turnId }, 5000));
  await wait(1000);
} finally {
  child.kill("SIGTERM");
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import { grantScopes, insertMessageWithRuns, type MachineHub, setAgentComputerTarget } from "../src";
import type { Fixture } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/** Helpers for mission tests: a fake runner on the hub, and a paired computer for the fixture's agent. */
export const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.7.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};
export const SANDBOX = [{ connectionId: null, scope: "sandbox:run" }];

type Request = Extract<ServerFrame, { type: "request" }>;
export type TaskStartRequest = Extract<Request, { op: "task.start" }>;
export type McpResult = Extract<ServerFrame, { type: "mcp.result" }>;

/** A runner over an in-memory socket: tasks, files in memory (`read`/`write`), and MCP calls. */
export function missionRunner(hub: MachineHub, hello: Record<string, unknown> = {}) {
  const sent: ServerFrame[] = [];
  const started: TaskStartRequest[] = [];
  const files = new Map<string, string>();
  const canceled: string[] = [];
  /** What `task.output` answers, per task. */
  const outputs = new Map<string, string[]>();
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type !== "request") return;
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "task.start") {
          started.push(frame);
          return ok({
            taskId: frame.taskId,
            pid: 100 + started.length,
            startedAt: new Date().toISOString(),
            cwd: frame.branch ? `.worktrees/${frame.taskId}` : (frame.cwd ?? ""),
            ...(frame.branch ? { branch: frame.branch } : {}),
            command: "claude -p --output-format stream-json",
          });
        }
        if (frame.op === "task.cancel") {
          canceled.push(frame.taskId);
          return ok({ canceled: true });
        }
        if (frame.op === "task.output") {
          const lines = outputs.get(frame.taskId) ?? [];
          return ok({ lines: lines.slice(-frame.tail), truncated: lines.length > frame.tail });
        }
        if (frame.op === "read") {
          const text = files.get(frame.path);
          return ok(
            text === undefined
              ? { base64: null, size: 0 }
              : { base64: Buffer.from(text).toString("base64"), size: text.length },
          );
        }
        if (frame.op === "write") {
          files.set(frame.path, Buffer.from(frame.base64, "base64").toString("utf8"));
          return ok({ size: frame.base64.length });
        }
        return ok({});
      }, 1);
    },
    close() {
      void hub.close(conn);
    },
  };
  const conn = hub.open(socket);
  let calls = 0;
  return {
    sent,
    started,
    files,
    canceled,
    outputs,
    close: () => hub.close(conn),
    frame: (frame: Record<string, unknown>) => reply(frame),
    hello: (token: string) =>
      hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true, ...hello })),
    /** The executor of `taskId` calls one of our MCP tools; resolves with the server's answer. */
    async mcp(taskId: string, tool: string, args: Record<string, unknown>): Promise<McpResult> {
      const callId = `call-${++calls}`;
      await reply({ type: "mcp.call", callId, taskId, tool, args });
      for (let i = 0; i < 400; i++) {
        const found = sent.find((s): s is McpResult => s.type === "mcp.result" && s.callId === callId);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`no mcp.result for ${tool}`);
    },
    done: (taskId: string, extra: Record<string, unknown> = {}) =>
      reply({ type: "task.done", taskId, exitCode: 0, seconds: 60, ...extra }),
  };
}

export async function pairedMachine(f: Fixture) {
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, f.owner.id, f.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
  await setAgentComputerTarget(deps, f.owner.id, f.org.id, f.agent.id, paired.machineId);
  return paired;
}

/** The owner writes in the mission's thread: what a main-session run that works for them starts on. */
export async function ownerWrites(f: Fixture, mission: { channelId: string; threadRootId: string }) {
  const { message } = await insertMessageWithRuns(
    f.db,
    {
      orgId: f.org.id,
      channelId: mission.channelId,
      threadId: mission.threadRootId,
      author: { type: "person", userId: f.owner.id },
      body: "Pode seguir.",
    },
    { startRuns: false, deliver: false },
  );
  return message.id;
}

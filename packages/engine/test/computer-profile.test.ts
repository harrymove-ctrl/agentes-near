import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createAgentRuns, insertMessage, runAuthority, runPermissionPrompt } from "../src";
import { type BrainTurnRequest, CodexBrain, type ComputerBrainLink } from "../src/brains/codex";
import type { BrainEvent, BrainTurn } from "../src/brains/types";
import { type Fixture, setup } from "./fixtures";

/**
 * ADR 0053 §3 and 0109: every run but a mission's before Start works (`work`), whoever woke it; a mission's
 * plan turn keeps its profile on Codex, which never runs on a runner too old to keep it.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const message = (author: "person" | "agent", body: string, meta: Record<string, unknown> = {}) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author:
      author === "person"
        ? { type: "person", userId: f.owner.id }
        : { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body,
    meta,
  });
const runFor = async (messageId: string, options: { background?: boolean } = {}) => {
  const [m] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, messageId));
  if (!m) throw new Error("no message");
  const [run] = await f.db.transaction((tx) =>
    createAgentRuns(tx, m as never, [f.agent.id], "mention", options.background ? { background: true } : {}),
  );
  if (!run) throw new Error("no run");
  return run;
};
describe("who is behind the run", () => {
  test("a person who writes into a run a routine's report woke is behind it from then on", async () => {
    f = await setup();
    const report = await message("agent", "Erro novo no checkout", {
      notice: { kind: "routine_handoff", text: "Erro novo no checkout", from: "Routine «Sentry»", refs: {} },
    });
    const woken = await runFor(report.id);
    expect((await runAuthority(f.db, woken)).kind).toBe("unattended");
    expect(await runAuthority(f.db, { ...woken, transcript: { steeredBy: f.owner.id } })).toMatchObject({
      kind: "person",
    });
  });
});

// ── Codex: the profile goes with the turn, never to a runner that can't keep it ──

function turn(): BrainTurn {
  return {
    runId: "0193aaaa-0000-7000-8000-000000000001",
    orgId: "org",
    agentId: "agent",
    channelId: "channel",
    threadRootId: null,
    system: "You are Dev.",
    messages: [{ role: "user", content: "check the inbox" }],
    tools: [],
    trigger: "check the inbox",
    session: { id: "0193aaaa-0000-7000-8000-00000000c0de", resume: false, machineId: "m1", cwd: "" },
  };
}

function link(protocol: number): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return { online: true, execAllowed: true, protocol, executors: { codex: { version: "codex-cli 0.163.0" } } };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      onEvent({ type: "done", text: "ok" });
    },
  };
}

const io = () => ({
  signal: new AbortController().signal,
  executeTool: async () => {
    throw new Error("computer brains don't execute tools in the engine");
  },
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("the server's rules for a run's prompts (Claude Code and Codex alike)", () => {
  const scope = { cwd: "/w/dev/repos/acme/app", folders: ["/w/dev/repos/acme/app", "/w/dev"], home: "/Users/w" };
  const ask = (tool_name: string, input: Record<string, unknown>) =>
    JSON.parse(runPermissionPrompt({ tool_name, input, scope }, { canRun: true })) as {
      behavior: string;
      message?: string;
    };
  test("secrets, inline code and writes outside its folders are refused; its own work is allowed", () => {
    expect(ask("Read", { file_path: "/Users/w/.ssh/id_ed25519" })).toMatchObject({ behavior: "deny" });
    expect(ask("Bash", { command: "cat ~/.aws/credentials" })).toMatchObject({ behavior: "deny" });
    const inline = ask("Bash", { command: "python3 -c 'import os'" });
    expect(inline.behavior).toBe("deny");
    expect(inline.message).toContain("runs code given inline");
    expect(ask("Write", { file_path: "/etc/hosts" }).behavior).toBe("deny");
    expect(ask("Bash", { command: "gh -R acme/app pr merge 3" }).behavior).toBe("deny");
    expect(ask("Bash", { command: "npm install" }).behavior).toBe("allow");
    expect(ask("Write", { file_path: "/w/dev/repos/acme/app/src/a.ts" }).behavior).toBe("allow");
  });

  test("the runner's home, wherever the runner says it is, holds secrets (its AI accounts)", () => {
    const session = "accounts/codex/0193dddd-0000-4000-8000-000000000002/sessions/x.jsonl";
    const elsewhere = { ...scope, runnerHome: "/srv/agentes-runner" };
    const prompt = (s: Record<string, unknown>, file = `/srv/agentes-runner/${session}`) =>
      JSON.parse(runPermissionPrompt({ tool_name: "Read", input: { file_path: file }, scope: s }, { canRun: true }))
        .behavior;
    expect(prompt(elsewhere)).toBe("deny");
    expect(prompt({ ...elsewhere, runnerHome: "relative/home" })).not.toBe("deny");
    // System mode's home is one whatever the runner says: on the server's own computer it holds every
    // organization's token.
    expect(prompt({ ...elsewhere, runnerHome: "relative/home" }, `/var/lib/agentes-runner/${session}`)).toBe("deny");
  });
});

describe("Codex turns carry their profile", () => {
  test("a background plan turn: read-only profile and no process kept", async () => {
    const l = link(16);
    const brain = new CodexBrain({
      link: l,
      mcp: async () => ({ token: "t" }),
      permissions: async () => ({ mode: "plan", branchPrefix: "agentes/dev/" }),
      keepAlive: false,
    });
    expect(await collect(brain.run(turn(), io()))).toMatchObject([{ type: "done", text: "ok" }]);
    expect(l.sent[0]).toMatchObject({ permissions: { mode: "plan" }, keepAlive: false });
  });

  test("a runner older than the profiles fails the turn (runner_outdated) instead of running with more power", async () => {
    const l = link(15);
    const brain = new CodexBrain({
      link: l,
      mcp: async () => ({ token: "t" }),
      permissions: async () => ({ mode: "work", branchPrefix: "agentes/dev/" }),
    });
    expect(await collect(brain.run(turn(), io()))).toMatchObject([
      { type: "error", code: "runner_outdated", retryable: true },
    ]);
    expect(l.sent).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, BRAIN_PROTOCOL } from "@agenteschat/adapters";
import { accountUnavailable, claudeCodeAvailability } from "../src/brains/claude-code";
import type { MachineStatus } from "../src/machine-hub";
import { RunnerOutdatedError } from "../src/machine-tasks";

const status = (over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: "m1",
  orgId: "org",
  name: "Workspace",
  online: true,
  execAllowed: true,
  os: "linux",
  protocol: BRAIN_PROTOCOL - 1,
  executors: {},
  ...over,
});
const ACCOUNT = { id: "acc", label: "Claude", status: "active" as const };

const said = (event: unknown) => (event as { message?: string } | null)?.message ?? "";

describe("a computer too old for something says how it gets its update", () => {
  test("the workspace's own computer updates by itself: never the command its runner refuses", () => {
    const managed = status({ kind: "managed" });
    for (const line of [
      said(claudeCodeAvailability(managed)),
      said(accountUnavailable({ ...managed, protocol: ACCOUNTS_PROTOCOL - 1 }, ACCOUNT, "claude_code")),
      new RunnerOutdatedError("Workspace", false, managed).message,
      new RunnerOutdatedError("Workspace", true, managed).message,
    ]) {
      expect(line).toContain("It updates by itself, so try again later.");
      expect(line).not.toContain("agentes-runner update");
    }
  });

  test("a computer set up for all its agents, or this server's own, updates with the install command as root", () => {
    for (const s of [status({ executors: { mode: "system" } }), status({ kind: "host" })]) {
      const line = said(claudeCodeAvailability(s));
      expect(line).toContain("running the install command again, as root");
      expect(line).not.toContain("agentes-runner update");
    }
  });

  test("a connected computer: its owner runs the update command", () => {
    expect(said(claudeCodeAvailability(status({ kind: "connected" })))).toContain(
      "Its owner updates the agentes app there, or runs `agentes-runner update`.",
    );
    expect(new RunnerOutdatedError("MacBook", false, null).message).toContain("`agentes-runner update`");
  });
});

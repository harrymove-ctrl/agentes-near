import { afterEach, expect, test } from "bun:test";
import {
  ASK_AFTER_TASK,
  ASK_IN_CHAT,
  approvalMessage,
  DELETE_BRANCHES_POINTER,
} from "@agenteschat/adapters/command-policy";
import {
  allowedBy,
  PERMISSION_PROMPT_TOOL,
  PERMISSION_TIMEOUT_MESSAGE,
  parseRunnerFrame,
  ruleMatches,
  rulesFor,
} from "@agenteschat/adapters/machine-protocol";
import {
  claudeMcpConfig,
  claudePermissionSettings,
  DENY_RULES,
  handleMcpMessage,
  type IpcReply,
  mcpContextFromEnv,
  mcpProfileFromEnv,
  mcpScopeFromEnv,
  missionExecutorArgs,
  permissionPrompt,
} from "../../runner/mcp";
import { claudeDenials, parseOutputLine } from "../../runner/tasks";
import { gitRepo, hasGit, removeDirs } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const TASK = "0193aaaa-0000-7000-8000-000000000001";
const bash = (command: string) => ({ tool_name: "Bash", input: { command } });

/** A fake server: answers each `permission_prompt` call with the next reply. */
function server(replies: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  const call = async (_tool: string, args: Record<string, unknown>): Promise<IpcReply> => {
    calls.push(args);
    const next = replies.shift();
    return next instanceof Error ? { ok: false, error: next.message } : { ok: true, text: JSON.stringify(next) };
  };
  return { calls, call };
}

const instant = { sleep: async () => {}, pollMs: 1 };

test("rules: deny matches any part of a command, allow needs every part; Aprovar sempre keeps the first word or two", () => {
  expect(ruleMatches("Bash(git merge *)", "Bash", { command: "git status && git merge main" })).toBe(true);
  expect(DENY_RULES.some((r) => ruleMatches(r, "Bash", { command: "git -C /w merge feature" }))).toBe(true);
  // Pushes aren't on the deny list: the computer reads where each one goes (`commandApproval`).
  expect(DENY_RULES.some((r) => ruleMatches(r, "Bash", { command: "git push origin main" }))).toBe(false);
  expect(allowedBy(["Bash(swift *)"], "Bash", { command: "swift build" })).toBe(true);
  expect(allowedBy(["Bash(swift *)"], "Bash", { command: "swift build && rm -rf out" })).toBe(false);
  expect(allowedBy(["Bash(ls *)"], "Bash", { command: "ls" })).toBe(true);
  expect(allowedBy(["WebFetch(domain:example.com)"], "WebFetch", { url: "https://example.com/a" })).toBe(true);
  expect(rulesFor("Bash", { command: "swift build -c release" })).toEqual(["Bash(swift build *)"]);
  expect(rulesFor("Bash", { command: "sips -Z 800 a.png | head -3" })).toEqual(["Bash(sips *)", "Bash(head *)"]);
  expect(rulesFor("Bash", { command: "git init" })).toEqual(["Bash(git init *)"]);
  expect(rulesFor("WebFetch", { url: "https://docs.example.com/x" })).toEqual(["WebFetch(domain:docs.example.com)"]);
});

test("the prompt tool: a deny-list command is refused at once with its kind, never asked", async () => {
  const s = server([]);
  const out = await permissionPrompt(bash("gh pr merge 914"), s.call, instant);
  expect(out).toEqual({ behavior: "deny", message: approvalMessage("This is a merge", ASK_IN_CHAT) });
  // A push with nowhere to read the repository from (no scope) waits for a person too.
  expect((await permissionPrompt(bash("git push origin main"), s.call, instant)).behavior).toBe("deny");
  expect(s.calls).toHaveLength(0);
});

test("deploys, cluster changes and package publishes are on the deny list (any part, bare or with arguments)", async () => {
  const denied = (command: string) => DENY_RULES.some((r) => ruleMatches(r, "Bash", { command }));
  for (const command of [
    "kubectl rollout restart deploy/web",
    "kubectl delete pod web-1",
    "kubectl apply -f k8s/",
    "helm install web ./chart",
    "helm upgrade web ./chart",
    "helm uninstall web",
    "terraform apply -auto-approve",
    "terraform destroy",
    "railway up",
    "railway up --detach",
    "railway deploy",
    "fly deploy",
    "flyctl deploy --remote-only",
    "npm publish",
    "npm publish --access public",
    "pnpm publish",
    "yarn publish",
    "yarn npm publish",
    "bun publish",
    "cargo publish",
    "gem push x-1.0.gem",
    "twine upload dist/*",
    "docker push ghcr.io/acme/web:1",
    "gh release create v1.0.0",
    "npm test && npm publish",
    "helm rollback web 3",
    "vercel rollback",
  ]) {
    expect(denied(command)).toBe(true);
  }
  for (const command of [
    "kubectl get pods",
    "helm list",
    "terraform plan",
    "npm test",
    "docker build .",
    "gh pr create",
  ]) {
    expect(denied(command)).toBe(false);
  }
  // Never promptable: refused at once, nothing reaches the server.
  for (const command of ["npm publish", "helm upgrade web ./chart", "docker push x"]) {
    const s = server([]);
    expect(await permissionPrompt(bash(command), s.call, instant)).toMatchObject({ behavior: "deny" });
    expect(s.calls).toHaveLength(0);
  }
});

test("the prompt tool: plain reads are allowed at once (no card, nothing posted); the rest carry the scope", async () => {
  const scope = { cwd: "/w/ada/m1", folders: ["/w/ada/m1"], home: "/Users/w" };
  for (const command of [
    "ls /System/Library/Fonts /Library/Fonts",
    "curl -sI https://commons.wikimedia.org/w/api.php",
    "git -C /w/app log -3",
  ]) {
    const s = server([]);
    expect(await permissionPrompt(bash(command), s.call, { ...instant, scope })).toEqual({
      behavior: "allow",
      updatedInput: { command },
    });
    expect(s.calls).toHaveLength(0);
  }
  // The deny list still comes first.
  const denied = server([]);
  expect((await permissionPrompt(bash("npm publish"), denied.call, { ...instant, scope })).behavior).toBe("deny");
  expect(denied.calls).toHaveLength(0);
  // Not a plain read: the server decides, told where the task runs.
  for (const command of ["curl -d a=1 https://example.com", "ls | xargs rm"]) {
    const s = server([{ behavior: "allow" }]);
    await permissionPrompt(bash(command), s.call, { ...instant, scope });
    expect(s.calls[0]).toMatchObject({ tool_name: "Bash", input: { command }, scope });
  }
  // A secret is refused on the computer itself (ADR 0053 §3): the server is never asked.
  const secret = server([{ behavior: "allow" }]);
  expect((await permissionPrompt(bash("cat ~/.ssh/id_rsa"), secret.call, { ...instant, scope })).behavior).toBe("deny");
  expect(secret.calls).toHaveLength(0);
  // Without a scope (an older MCP config) nothing is allowed locally.
  const old = server([{ behavior: "allow" }]);
  await permissionPrompt(bash("ls /System"), old.call, instant);
  expect(old.calls).toHaveLength(1);
  expect(
    mcpScopeFromEnv({
      AGENTES_MCP_CWD: "/w/ada/m1/work/x",
      AGENTES_MCP_FOLDERS: "/w/ada/m1/work/x:/w/ada/m1",
      HOME: "/Users/w",
    }),
  ).toEqual({
    cwd: "/w/ada/m1/work/x",
    folders: ["/w/ada/m1/work/x", "/w/ada/m1"],
    home: "/Users/w",
  });
  expect(mcpScopeFromEnv({ AGENTES_MCP_CWD: "relative" })).toBeUndefined();
  // The runner's own home, wherever it is (system mode), is read by nothing either: its accounts are there.
  const system = mcpScopeFromEnv({ AGENTES_MCP_CWD: "/w/ada", AGENTES_RUNNER_HOME: "/var/lib/agentes-runner" });
  expect(system?.runnerHome).toBe("/var/lib/agentes-runner");
  const account = "/var/lib/agentes-runner/accounts/claude_code/0193dddd-0000-4000-8000-000000000001";
  const local = server([{ behavior: "allow" }]);
  for (const command of [`cat ${account}/.credentials.json`, "ls /var/lib/agentes-runner"]) {
    expect((await permissionPrompt(bash(command), local.call, { ...instant, scope: system })).behavior).toBe("deny");
  }
  expect(local.calls).toHaveLength(0);
  const settings = claudePermissionSettings("work", [], undefined, {
    promptReads: true,
    runnerHome: "/var/lib/agentes-runner",
  }).permissions;
  expect(settings.deny).toContain("Read(//var/lib/agentes-runner/**)");
  expect(settings.deny).toContain("Bash(*/var/lib/agentes-runner/*)");
  expect(
    claudeMcpConfig({ command: ["node", "r.mjs"], taskId: "t1", socketPath: "/s", token: "t", runnerHome: "/srv/r" })
      .mcpServers.agentes.env,
  ).toMatchObject({ AGENTES_RUNNER_HOME: "/srv/r" });
});

test("the prompt tool: pending, then allowed (the input comes back as is)", async () => {
  const s = server([
    { status: "pending", request_id: "r1" },
    { status: "pending", request_id: "r1" },
    { behavior: "allow" },
  ]);
  const out = await permissionPrompt(bash("swift build"), s.call, instant);
  expect(out).toEqual({ behavior: "allow", updatedInput: { command: "swift build" } });
  expect(s.calls[0]).toMatchObject({ tool_name: "Bash", input: { command: "swift build" } });
  expect(s.calls.slice(1)).toEqual([{ request_id: "r1" }, { request_id: "r1" }]);
});

test("the prompt tool: a person says no; nobody answers in time; the server is unreachable", async () => {
  const no = server([
    { status: "pending", request_id: "r1" },
    { behavior: "deny", message: "A person said no." },
  ]);
  expect(await permissionPrompt(bash("brew install x"), no.call, instant)).toEqual({
    behavior: "deny",
    message: "A person said no.",
  });
  let now = 0;
  const slow = server(Array.from({ length: 50 }, () => ({ status: "pending", request_id: "r2" })));
  const timedOut = await permissionPrompt(bash("brew install y"), slow.call, {
    waitMs: 10_000,
    pollMs: 4000,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  expect(timedOut).toEqual({ behavior: "deny", message: PERMISSION_TIMEOUT_MESSAGE });
  expect(slow.calls.length).toBe(4);
  const down = server([new Error("The computer is not connected")]);
  expect((await permissionPrompt(bash("brew install z"), down.call, instant)).behavior).toBe("deny");
});

test("the prompt tool: the runner restarting or reconnecting is waited out, not a silent deny", async () => {
  const replies: IpcReply[] = [
    { ok: false, error: "The runner closed the connection.", transient: true },
    { ok: false, error: "The computer is not connected to agentes.chat right now", transient: true },
    { ok: true, text: JSON.stringify({ status: "pending", request_id: "r9" }) },
    { ok: false, error: "The runner closed the connection.", transient: true },
    { ok: true, text: JSON.stringify({ behavior: "allow" }) },
  ];
  const calls: Record<string, unknown>[] = [];
  const call = async (_tool: string, args: Record<string, unknown>) => {
    calls.push(args);
    return replies.shift() as IpcReply;
  };
  expect(await permissionPrompt(bash("swift build"), call, instant)).toEqual({
    behavior: "allow",
    updatedInput: { command: "swift build" },
  });
  // The first question went again after the link came back; then the poll by its request id.
  expect(calls.filter((c) => c.tool_name === "Bash")).toHaveLength(3);
  expect(calls.filter((c) => c.request_id === "r9")).toHaveLength(2);
});

test("over MCP: permission_prompt always answers JSON text Claude Code understands", async () => {
  const s = server([{ behavior: "allow" }]);
  const res = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "permission_prompt", arguments: bash("swift build") },
    },
    s.call,
  )) as { result: { content: { text: string }[]; isError?: boolean } };
  expect(res.result.isError).toBeUndefined();
  expect(JSON.parse(res.result.content[0]?.text ?? "")).toEqual({
    behavior: "allow",
    updatedInput: { command: "swift build" },
  });
});

test("work turns: the prompt tool flag and the mission's allowed commands in the settings (deny list kept)", () => {
  const args = missionExecutorArgs(
    "claude",
    { configFile: "/m.json", command: ["node"], taskId: TASK, socketPath: "/s", rules: "", promptTool: true },
    "linux",
  );
  expect(args.join(" ")).toContain(`--permission-prompt-tool ${PERMISSION_PROMPT_TOOL}`);
  const plain = missionExecutorArgs(
    "claude",
    { configFile: "/m.json", command: ["node"], taskId: TASK, socketPath: "/s", rules: "" },
    "linux",
  );
  expect(plain.join(" ")).not.toContain("--permission-prompt-tool");
  const work = claudePermissionSettings("work", ["Bash(swift *)", "Bash", "Bash(a) && rm"]).permissions;
  expect(work.allow).toContain("Bash(swift *)");
  expect(work.allow).not.toContain("Bash");
  expect(work.deny).toContain("Bash(git merge *)");
  const plan = claudePermissionSettings("plan", ["Bash(swift *)"]).permissions;
  expect(plan.allow).not.toContain("Bash(swift *)");
});

test.skipIf(!hasGit)(
  "ADR 0053 §3: a push is read with git on the computer: the default branch or a force push is refused there with why, its own branches go through, the rest goes to the server",
  async () => {
    const { work } = gitRepo(dirs);
    const scope = { cwd: work, folders: [work] };
    const turn = { ...instant, scope, branches: ["agentes/dev/"] };
    const held = server([]);
    expect(await permissionPrompt(bash("git push origin develop"), held.call, turn)).toEqual({
      behavior: "deny",
      message: approvalMessage(
        "This push goes to the default branch develop",
        ASK_IN_CHAT,
        "Or push to a branch of your own (agentes/dev/…) and open a pull request.",
      ),
    });
    expect((await permissionPrompt(bash("git push --force origin cursor/pap-582-fix"), held.call, turn)).behavior).toBe(
      "deny",
    );
    expect(held.calls).toHaveLength(0);
    // Its own branches need nobody; a pull request's branch is ordinary work the server allows like any command.
    const own = server([]);
    expect(await permissionPrompt(bash("git push -u origin agentes/dev/fix"), own.call, turn)).toEqual({
      behavior: "allow",
      updatedInput: { command: "git push -u origin agentes/dev/fix" },
    });
    expect(own.calls).toHaveLength(0);
    const pr = server([{ behavior: "allow" }]);
    expect((await permissionPrompt(bash("git push origin HEAD"), pr.call, turn)).behavior).toBe("allow");
    expect(pr.calls).toHaveLength(1);
    // Inside a background task outside a mission nobody answers but this computer: an ordinary push goes
    // through, a held one says to stop and report.
    const alone = { ...turn, task: true, local: true };
    const local = server([]);
    expect((await permissionPrompt(bash("git push origin HEAD"), local.call, alone)).behavior).toBe("allow");
    expect(await permissionPrompt(bash("git push origin develop"), local.call, alone)).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining(ASK_AFTER_TASK),
    });
    expect(local.calls).toHaveLength(0);
    // What the MCP process reads from its env.
    expect(
      mcpContextFromEnv({ AGENTES_MCP_BRANCHES: "agentes/dev/,agentes/0193aaaa/", AGENTES_MCP_TASK: "local" }),
    ).toEqual({ branches: ["agentes/dev/", "agentes/0193aaaa/"], task: true, local: true });
    expect(mcpContextFromEnv({ AGENTES_MCP_TASK: "mission", AGENTES_MCP_BRANCHES: "bad branch" })).toEqual({
      task: true,
    });
    expect(mcpContextFromEnv({})).toEqual({});
  },
);

test.skipIf(!hasGit)(
  "through our git proxy: a delete or the default branch is refused here pointing to the server's way; a plain push to someone else's branch goes up to it",
  async () => {
    const { work, git } = gitRepo(dirs);
    git(
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://agentes.test/api/git/0190a7b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b/0190a7b2-3c4d-7e5f-8a9b-0c1d2e3f4a5c/acme/app.git",
    );
    // A mission's task: anything not decided here would go to the mission's command card.
    const mission = { ...instant, scope: { cwd: work, folders: [work] }, branches: ["agentes/dev/"], task: true };
    const s = server([]);
    expect(await permissionPrompt(bash("git push origin --delete cursor/pap-582-fix"), s.call, mission)).toEqual({
      behavior: "deny",
      message: `This deletes the remote branch cursor/pap-582-fix: ${DELETE_BRANCHES_POINTER}`,
    });
    expect(await permissionPrompt(bash("git push origin develop"), s.call, mission)).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("our git proxy never lets it through"),
    });
    expect(await permissionPrompt(bash("git push origin cursor/pap-582-fix"), s.call, mission)).toEqual({
      behavior: "allow",
      updatedInput: { command: "git push origin cursor/pap-582-fix" },
    });
    expect(s.calls).toHaveLength(0);
    // With anything else in the command, the push is no longer alone: the server decides, as before.
    const more = server([{ behavior: "allow" }]);
    await permissionPrompt(bash("npm test && git push origin cursor/pap-582-fix"), more.call, mission);
    expect(more.calls).toHaveLength(1);
  },
  30_000,
);

test("refused commands: Claude Code's permission_denials and Codex's declined commands; task.done carries them", () => {
  expect(
    claudeDenials([
      { tool_name: "Bash", tool_use_id: "t", tool_input: { command: "git init /w" } },
      { tool_name: "mcp__agentes__report", tool_input: {} },
      { tool_name: "WebFetch", tool_input: { url: "https://x.dev" } },
    ]),
  ).toEqual([
    { tool: "Bash", command: "git init /w" },
    { tool: "WebFetch", command: "WebFetch https://x.dev" },
  ]);
  const result = parseOutputLine(
    JSON.stringify({
      type: "result",
      result: "Blocked",
      session_id: "s",
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "ls ~/.claude/skills" } }],
    }),
    "claude",
    "/w",
  );
  expect(result.denials).toEqual([{ tool: "Bash", command: "ls ~/.claude/skills" }]);
  const codex = parseOutputLine(
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "bash -lc 'swift build'", status: "declined" },
    }),
    "codex",
    "/w",
  );
  expect(codex.denials).toEqual([{ tool: "Bash", command: "swift build" }]);
  const frame = parseRunnerFrame(
    JSON.stringify({
      type: "task.done",
      taskId: TASK,
      exitCode: 0,
      seconds: 3,
      denials: [{ tool: "Bash", command: "swift build" }, { tool: "Bash", command: "swift build" }, { nope: 1 }],
    }),
  );
  expect(frame).toMatchObject({ type: "task.done", denials: [{ tool: "Bash", command: "swift build" }] });
});

test("ADR 0053 §3: a plan turn's prompts are answered on the computer (reads only), never asked of the server", async () => {
  const scope = { cwd: "/w/dev/app", folders: ["/w/dev/app", "/w/dev"], home: "/Users/w" };
  const plan = { ...instant, scope, profile: "plan" as const };
  for (const command of ["ls -la", "git log -3", "cat README.md"]) {
    const s = server([]);
    expect(await permissionPrompt(bash(command), s.call, plan)).toEqual({
      behavior: "allow",
      updatedInput: { command },
    });
    expect(s.calls).toHaveLength(0);
  }
  for (const call of [
    bash("npm install"),
    bash("curl -sI https://example.com"),
    bash("git fetch"),
    { tool_name: "Edit", input: { file_path: "/w/dev/app/a.ts" } },
    { tool_name: "WebFetch", input: { url: "https://example.com" } },
  ]) {
    const s = server([{ behavior: "allow" }]);
    expect(await permissionPrompt(call, s.call, plan)).toMatchObject({ behavior: "deny" });
    expect(s.calls).toHaveLength(0);
  }
  // The profile reaches our MCP process through its env.
  expect(mcpProfileFromEnv({ AGENTES_MCP_PROFILE: "plan" })).toBe("plan");
  expect(mcpProfileFromEnv({})).toBe("work");
});

test("every profile: secrets and normalized deny-list commands are refused at once; inline code goes to the server", async () => {
  const scope = { cwd: "/w/dev/app", folders: ["/w/dev/app", "/w/dev"], home: "/Users/w" };
  for (const call of [
    bash("cat ~/.ssh/id_rsa"),
    { tool_name: "Read", input: { file_path: "/Users/w/.aws/credentials" } },
    { tool_name: "Grep", input: { pattern: "KEY", glob: "**/.env" } },
    bash("gh -R acme/web pr merge 1"),
    bash("git -c x=y push origin refs/heads/main"),
    bash("gh auth token"),
  ]) {
    const s = server([{ behavior: "allow" }]);
    expect(await permissionPrompt(call, s.call, { ...instant, scope })).toMatchObject({ behavior: "deny" });
    expect(s.calls).toHaveLength(0);
  }
  // Never allowed by the computer itself: the server's rules (or a person) decide.
  const s = server([{ behavior: "deny", message: "This command was refused because it runs code given inline." }]);
  expect(await permissionPrompt(bash("node -e 'process.exit(0)'"), s.call, { ...instant, scope })).toMatchObject({
    behavior: "deny",
  });
  expect(s.calls).toHaveLength(1);
});

test("the agent's browser profile (its logins) is refused at once from its own folder; its mission's files are read", async () => {
  const scope = { cwd: "/w/dev", folders: ["/w/dev"], home: "/Users/w" };
  for (const call of [
    bash("cat .agentes/browser/Default/Cookies"),
    bash("sqlite3 /w/dev/.agentes/browser/Default/Cookies 'select * from cookies'"),
    bash("cp -r .agentes/browser /tmp/b"),
    { tool_name: "Read", input: { file_path: "/w/dev/.agentes/browser/Default/Login Data" } },
    { tool_name: "Grep", input: { pattern: "sid", path: ".agentes/browser" } },
  ]) {
    const s = server([{ behavior: "allow" }]);
    expect(await permissionPrompt(call, s.call, { ...instant, scope })).toMatchObject({ behavior: "deny" });
    expect(s.calls).toHaveLength(0);
  }
  const notes = server([]);
  expect(await permissionPrompt(bash("cat .agentes/notes.md"), notes.call, { ...instant, scope })).toEqual({
    behavior: "allow",
    updatedInput: { command: "cat .agentes/notes.md" },
  });
  // Claude Code's own rules refuse it too, also where a mission's settings allow `cat`.
  const deny = claudePermissionSettings("work", ["Bash(cat *)"], undefined, { promptReads: true }).permissions.deny;
  expect(deny.some((r) => ruleMatches(r, "Bash", { command: "cat .agentes/browser/Default/Cookies" }))).toBe(true);
  expect(deny.some((r) => ruleMatches(r, "Bash", { command: "cat .agentes/notes.md" }))).toBe(false);
});

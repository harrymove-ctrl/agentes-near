import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type BrainRouteRequest,
  MACHINE_OPS,
  MACHINE_PROTOCOL_VERSION,
  ROUTE_PROTOCOL,
} from "@agenteschat/adapters/machine-protocol";
import { BrainManager } from "../../runner/brain";
import {
  CODEX_ROUTE_OFF,
  claudeRouteAnswer,
  claudeRouteArgs,
  codexRouteArgs,
  newestLuna,
  routeWithPlan,
} from "../../runner/brain-route";
import { handleRequest, NEW_WORK_OPS, OP_ROUTES } from "../../runner/handlers";
import { errorCode, removeDirs, tempDir, withContainersClient } from "./helpers";

const dirs: string[] = [];
const managers: BrainManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const ACCOUNT = "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const FAKE_CLAUDE = path.join(import.meta.dir, "fake-claude.mjs");
const FAKE_CODEX = path.join(import.meta.dir, "fake-codex.mjs");
const schema = {
  type: "object",
  properties: {
    needs_agent: { type: "number" },
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: { handle: { type: "string", enum: ["dev", "ops"] }, score: { type: "number" } },
      },
    },
    reason: { type: "string" },
  },
};
const request = (over: Partial<BrainRouteRequest> = {}): BrainRouteRequest => ({
  kind: "claude_code",
  account: ACCOUNT,
  system: "You route messages in a team chat.",
  prompt: "Channel #general.\n\n<message>\n[Ana]: alguém viu o deploy?\n</message>",
  schema,
  ...over,
});

/** An account folder, temporary folders for routes, and the fakes' logs. */
function folders() {
  const home = tempDir("route-account-");
  const tmp = tempDir("route-tmp-");
  dirs.push(home, tmp);
  const claudeLog = path.join(tmp, "..", `claude-${path.basename(tmp)}.log`);
  const codexLog = path.join(tmp, "..", `codex-${path.basename(tmp)}.log`);
  dirs.push(claudeLog, codexLog);
  process.env.FAKE_CLAUDE_LOG = claudeLog;
  process.env.FAKE_CODEX_LOG = codexLog;
  const lines = (file: string) =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  const deps = {
    accounts: { accountDir: () => home },
    claudeCommand: [process.execPath, FAKE_CLAUDE],
    codexCommand: [process.execPath, FAKE_CODEX],
    tmpDir: tmp,
  };
  return { home, tmp, deps, claude: () => lines(claudeLog), codex: () => lines(codexLog) };
}

test("protocol 24: brain.route is known, new work, and runs as the agent's own user", () => {
  expect(ROUTE_PROTOCOL).toBe(24);
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(ROUTE_PROTOCOL);
  expect(MACHINE_OPS).toContain("brain.route");
  expect(NEW_WORK_OPS.has("brain.route")).toBe(true);
  expect(OP_ROUTES["brain.route"]).toBe("agent");
});

test("every CLI tool off, nothing of the folder or its owner loaded, no session kept", () => {
  expect(claudeRouteArgs({ systemFile: "/tmp/r/system.txt", schema: { type: "object" } })).toEqual([
    "-p",
    "--safe-mode",
    "--model",
    "haiku",
    "--effort",
    "low",
    "--tools",
    "",
    "--no-session-persistence",
    "--system-prompt-file",
    "/tmp/r/system.txt",
    "--json-schema",
    '{"type":"object"}',
    "--output-format",
    "json",
  ]);
  const codex = codexRouteArgs({
    model: "gpt-5.6-luna",
    schemaFile: "/tmp/r/schema.json",
    lastFile: "/tmp/r/last.txt",
  });
  expect(codex.slice(0, 11)).toEqual([
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-m",
    "gpt-5.6-luna",
    "-c",
    'model_reasoning_effort="low"',
  ]);
  for (const feature of ["shell_tool", "plugins", "apps", "multi_agent", "browser_use", "computer_use"]) {
    expect(CODEX_ROUTE_OFF).toContain(feature as (typeof CODEX_ROUTE_OFF)[number]);
    expect(codex.join(" ")).toContain(`--disable ${feature}`);
  }
  expect(codex.slice(-5)).toEqual(["--output-schema", "/tmp/r/schema.json", "-o", "/tmp/r/last.txt", "-"]);
  // Codex's smallest model on a ChatGPT sign-in: the newest Luna it lists.
  expect(newestLuna({ models: [{ slug: "gpt-5.6-luna" }, { slug: "gpt-5.10-luna" }, { slug: "gpt-6-sol" }] })).toBe(
    "gpt-5.10-luna",
  );
  expect(newestLuna({ models: [{ slug: "gpt-5.4-mini" }] })).toBeNull();
  expect(newestLuna("nonsense")).toBeNull();
  // A refusal in text isn't an answer.
  expect(claudeRouteAnswer('{"type":"result","is_error":false,"result":"Sorry."}')).toBeNull();
});

test.skipIf(!posix)(
  "Claude Code answers in the account's folder, on Claude's own endpoint, from a temporary folder removed after",
  async () => {
    const { home, tmp, deps, claude } = folders();
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-stray-key";
    try {
      const reply = await routeWithPlan(request(), deps);
      expect(reply).toEqual({
        json: { needs_agent: 0.9, scores: [{ handle: "dev", score: 0.9 }], reason: "a fake route" },
        model: "claude-haiku-5-5",
        usage: { input: 2599, output: 750, cacheRead: 2597, cacheWrite: 0 },
        durationMs: 3847,
      });
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
    const [start, route] = claude();
    expect(start?.configDir).toBe(home);
    // No stray key signs it in, and requests go only to Claude's endpoint.
    expect(start?.apiKey).toBeNull();
    expect(start?.baseUrl).toBe("https://api.anthropic.com");
    expect(String(start?.cwd).startsWith(path.join(tmp, "agentes-route-"))).toBe(true);
    expect(start?.args).toContain("--safe-mode");
    expect(route).toMatchObject({ system: "You route messages in a team chat.", prompt: request().prompt });
    expect(readdirSync(tmp)).toEqual([]);
  },
);

test.skipIf(!posix)(
  "an account root keeps: the route thinks in the agent's own folder for it, with root's token; never with its key",
  async () => {
    const { tmp, deps, claude } = folders();
    const own = tempDir("route-own-");
    dirs.push(own);
    const TOKEN = "sk-ant-oat01-fake-token-for-tests-only";
    const accounts = { accountDir: () => tmp, agentHome: () => own };
    const reply = await routeWithPlan(request(), { ...deps, accounts, grant: { kind: "token", token: TOKEN } });
    expect(reply).toMatchObject({ model: "claude-haiku-5-5" });
    const [start] = claude();
    expect(start?.configDir).toBe(own);
    expect(start?.oauthToken).toBe(TOKEN);
    expect([start?.oauthFd, start?.oauthEnv]).toEqual(["3", null]);
    expect(start?.baseUrl).toBe("https://api.anthropic.com");
    const key = { kind: "key" as const, provider: "zai" as const, key: "zai-key-1234567890abcdef" };
    expect(await errorCode(() => routeWithPlan(request(), { ...deps, accounts, grant: key }))).toBe("not_allowed");
    expect(await errorCode(() => routeWithPlan(request(), { ...deps, accounts, grant: { kind: "none" } }))).toBe(
      "not_found",
    );
  },
);

test.skipIf(!posix)("Codex answers with the newest Luna its sign-in lists, the system prompt leading", async () => {
  const { home, deps, codex } = folders();
  const reply = await withContainersClient(() => routeWithPlan(request({ kind: "codex", account: ACCOUNT }), deps));
  expect(reply).toEqual({
    json: { needs_agent: 0.9, scores: [{ handle: "dev", score: 0.9 }], reason: "a fake route" },
    model: "gpt-5.10-luna",
    usage: { input: 18003, output: 100, cacheRead: 17000, cacheWrite: 0 },
    durationMs: expect.any(Number),
  });
  const [models, exec, route] = codex();
  expect(models?.args).toEqual(["debug", "models"]);
  expect(exec?.codexHome).toBe(home);
  // Codex's sandbox holds it, so the agent's containers service isn't named to it (ADR 0169).
  expect(exec?.containers).toEqual([]);
  expect((exec?.args as string[] | undefined)?.slice(0, 9)).toEqual(
    codexRouteArgs({ model: "gpt-5.10-luna", schemaFile: "", lastFile: "" }).slice(0, 9),
  );
  expect(String(route?.prompt).startsWith("You route messages in a team chat.\n\n")).toBe(true);
  // The model lookup is kept: a second route starts Codex once.
  await routeWithPlan(request({ kind: "codex", account: ACCOUNT }), deps);
  expect(codex().filter((l) => (l.args as string[] | undefined)?.[0] === "debug")).toHaveLength(1);
});

test("a sign-in made with a key, an account not on this computer, a malformed request: refused", async () => {
  const { home, deps } = folders();
  writeFileSync(path.join(home, "provider.json"), JSON.stringify({ provider: "zai", key: "zai-key-1234567890abcdef" }));
  expect(await errorCode(() => routeWithPlan(request(), deps))).toBe("not_allowed");
  if (!posix) return;
  expect(await errorCode(() => routeWithPlan(request(), { ...deps, accounts: { accountDir: () => null } }))).toBe(
    "not_found",
  );
  expect(await errorCode(() => routeWithPlan(request({ prompt: "  " }), deps))).toBe("bad_request");
  expect(await errorCode(() => routeWithPlan(request({ account: "../etc" }), deps))).toBe("bad_request");
});

test.skipIf(!posix)("busy while that sign-in has a process open or another route; free again after", async () => {
  const { deps, claude } = folders();
  let open = true;
  const brains = { holds: (account: string | null) => open && account === ACCOUNT };
  expect(await routeWithPlan(request(), { ...deps, brains })).toEqual({ busy: true });
  // The computer's own sign-in is another one.
  expect(await routeWithPlan(request({ account: undefined }), { ...deps, brains })).not.toHaveProperty("busy");
  open = false;
  const slow = routeWithPlan(request({ prompt: "SLOW_ROUTE" }), { ...deps, brains, timeoutMs: 400 });
  // One route per sign-in at a time.
  expect(await routeWithPlan(request(), { ...deps, brains })).toEqual({ busy: true });
  expect(await errorCode(() => slow)).toBe("internal");
  expect(await routeWithPlan(request(), { ...deps, brains })).not.toHaveProperty("busy");
  expect(claude().filter((l) => l.route)).toHaveLength(3);
  // A background task runs Claude Code on the computer's own sign-in: busy there, not in an account.
  const tasks = { runningTasks: () => [{ executor: "claude" }] };
  expect(await routeWithPlan(request({ account: undefined }), { ...deps, tasks })).toEqual({ busy: true });
  expect(await routeWithPlan(request(), { ...deps, tasks })).not.toHaveProperty("busy");
  // One on the account (protocol 31): busy in that account, not on the computer's own sign-in.
  const onAccount = { runningTasks: () => [{ executor: "claude", account: ACCOUNT }] };
  expect(await routeWithPlan(request(), { ...deps, tasks: onAccount })).toEqual({ busy: true });
  expect(await routeWithPlan(request({ account: undefined }), { ...deps, tasks: onAccount })).not.toHaveProperty(
    "busy",
  );
});

test.skipIf(!posix)("killed past its time, with what it started; an answer that isn't JSON fails", async () => {
  const { deps } = folders();
  const started = Date.now();
  const error = await routeWithPlan(request({ prompt: "SLOW_ROUTE" }), { ...deps, timeoutMs: 300 }).catch(
    (e: unknown) => e,
  );
  expect(String((error as Error).message)).toMatch(/^Claude Code didn't answer in \d+ s$/);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await errorCode(() => routeWithPlan(request({ prompt: "BAD_ROUTE" }), deps))).toBe("internal");
});

const AGENT = "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const SESSION = "0193aaaa-0000-7000-8000-000000000001";

/** Dev's brain processes, thinking with the account in `home`, and one turn of his there. */
function devBrains(home: string) {
  const root = tempDir("route-brains-");
  dirs.push(root);
  const m = new BrainManager({
    root,
    claudeCommand: [process.execPath, FAKE_CLAUDE],
    accounts: { accountDir: () => home },
    mcp: { socketPath: path.join(root, "mcp.sock"), command: ["node", "runner.mjs"] },
    deltaMs: 5,
  });
  managers.push(m);
  const turn = () =>
    m.turn(
      {
        runId: "0193bbbb-0000-7000-8000-000000000001",
        kind: "claude_code",
        session: { id: SESSION, resume: false },
        cwd: "",
        system: "You are dev.",
        prompt: "hello",
        mcp: { token: `agr_${"t".repeat(24)}1` },
        account: ACCOUNT,
      },
      { agent: { id: AGENT, handle: "dev" }, folder: root, emit: () => {} },
    );
  return { m, turn };
}

test.skipIf(!posix)(
  "the agent's processes: a sign-in is held during a turn and while its process is kept",
  async () => {
    const { home } = folders();
    const { m, turn } = devBrains(home);
    expect(m.holds(ACCOUNT)).toBe(false);
    const final = await turn();
    expect(final.type).toBe("done");
    // Kept for the next turn (10 minutes by default): busy for routes.
    expect(m.holds(ACCOUNT)).toBe(true);
    expect(m.holds(null)).toBe(false);
    m.close();
    expect(m.holds(ACCOUNT)).toBe(false);
  },
);

test.skipIf(!posix)(
  "a turn starting on that sign-in mid-route stops the route, and starts after it ended",
  async () => {
    const { home, deps, claude } = folders();
    const { m, turn } = devBrains(home);
    const route = routeWithPlan(request({ prompt: "SLOW_ROUTE" }), { ...deps, brains: m });
    const ended = route.then(
      () => Date.now(),
      () => Date.now(),
    );
    for (let i = 0; i < 250 && !claude().some((l) => l.route); i++) await Bun.sleep(20);
    expect((await turn()).type).toBe("done");
    expect(await route.catch((e: unknown) => String(e))).toBe("RunnerError: Claude Code didn't answer: canceled");
    expect(m.process(AGENT, SESSION)?.startedAt).toBeGreaterThanOrEqual(await ended);
  },
);

test("the handler: the machine's Claude Code switch decides, and a route needs its agent", async () => {
  const ws = tempDir("route-ws-");
  dirs.push(ws);
  const scope = { signal: new AbortController().signal, output: () => {} };
  const req = {
    op: "brain.route" as const,
    ...request(),
    agent: { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" },
  };
  const off = {
    workspaceReal: ws,
    exec: true,
    token: "t",
    access: () => ({
      folders: [],
      tools: { claude: false, codex: true, commands: true, browser: false, desktop: false, terminal: false },
    }),
  };
  expect(await errorCode(() => handleRequest(off, req, scope))).toBe("not_allowed");
  const on = { workspaceReal: ws, exec: true, token: "t" };
  expect(await errorCode(() => handleRequest(on, { ...req, agent: undefined }, scope))).toBe("bad_request");
});

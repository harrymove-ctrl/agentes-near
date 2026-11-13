import { afterEach, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineRequest, RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import {
  AccessRequests,
  addFolder,
  allowedFor,
  checkFolder,
  reduceAccess,
  refusedFolder,
  removeFolder,
  resolveAgentHandle,
  setFolderAgents,
  setTool,
  widens,
} from "../../runner/access";
import { type HandlerContext, handleRequest, type RequestScope } from "../../runner/handlers";
import { resolveInRoots } from "../../runner/paths";
import type { TaskManager } from "../../runner/tasks";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev", name: "Dev" };
const OTHER = { id: "0193bbbb-bbbb-7ccc-8ddd-eeeeffff0000", handle: "ops", name: "Ops" };
const scope = (): RequestScope => ({ signal: new AbortController().signal, output: () => {} });

function setup(tools: Partial<RunnerAccess["tools"]> = {}) {
  const ws = tempDir("ws-");
  const granted = tempDir("grant-");
  const outside = tempDir("out-");
  dirs.push(ws, granted, outside);
  writeFileSync(path.join(granted, "report.md"), "granted");
  writeFileSync(path.join(outside, "secret.txt"), "nope");
  let access: RunnerAccess = {
    folders: [{ path: granted, agents: [AGENT.id] }],
    tools: { claude: false, codex: false, commands: true, ...tools },
  };
  let paused = false;
  const ctx: HandlerContext = {
    workspaceReal: ws,
    exec: true,
    token: "agm_x",
    access: () => access,
    paused: () => paused,
  };
  return {
    ws,
    granted,
    outside,
    ctx,
    setAccess: (a: RunnerAccess) => {
      access = a;
    },
    pause: (p: boolean) => {
      paused = p;
    },
  };
}

const read = (p: string, agent = AGENT): MachineRequest => ({ op: "read", path: p, maxBytes: 1000, agent });

test("access: relative paths stay in the agent's folder; absolute ones only inside its allowed folders", async () => {
  const { ctx, granted, outside } = setup();
  const write = {
    op: "write" as const,
    path: "notes.txt",
    base64: Buffer.from("mine").toString("base64"),
    agent: AGENT,
  };
  expect(await handleRequest(ctx, write, scope())).toEqual({ size: 4 });
  expect(await handleRequest(ctx, read("notes.txt"), scope())).toMatchObject({ size: 4 });

  // Inside the allowed folder: read, write, list (entries come back absolute).
  const r = (await handleRequest(ctx, read(path.join(granted, "report.md")), scope())) as { base64: string };
  expect(Buffer.from(r.base64, "base64").toString()).toBe("granted");
  await handleRequest(
    ctx,
    {
      op: "write",
      path: path.join(granted, "new", "out.txt"),
      base64: Buffer.from("x").toString("base64"),
      agent: AGENT,
    },
    scope(),
  );
  const listed = (await handleRequest(ctx, { op: "list", path: granted, depth: 2, agent: AGENT }, scope())) as {
    entries: { path: string }[];
  };
  expect(listed.entries.map((e) => e.path)).toContain(path.join(granted, "new", "out.txt").split(path.sep).join("/"));

  // Outside every allowed folder, '..' out of one, or another agent's grant: not allowed.
  expect(await errorCode(() => handleRequest(ctx, read(path.join(outside, "secret.txt")), scope()))).toBe(
    "not_allowed",
  );
  expect(
    await errorCode(() => handleRequest(ctx, read(`${granted}/../${path.basename(outside)}/secret.txt`), scope())),
  ).toBe("not_allowed");
  expect(await errorCode(() => handleRequest(ctx, read(path.join(granted, "report.md"), OTHER), scope()))).toBe(
    "not_allowed",
  );
  // Relative paths still can't leave the agent's folder.
  expect(await errorCode(() => handleRequest(ctx, read("../x"), scope()))).toBe("outside_workspace");
});

test.skipIf(!posix)("access: a symlink inside an allowed folder that points outside is refused", async () => {
  const { ctx, granted, outside } = setup();
  symlinkSync(outside, path.join(granted, "escape"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(granted, "file-link"));
  expect(await errorCode(() => handleRequest(ctx, read(path.join(granted, "escape", "secret.txt")), scope()))).toBe(
    "not_allowed",
  );
  expect(await errorCode(() => handleRequest(ctx, read(path.join(granted, "file-link")), scope()))).toBe("not_allowed");
  const planted = {
    op: "write" as const,
    path: path.join(granted, "escape", "planted.txt"),
    base64: Buffer.from("x").toString("base64"),
    agent: AGENT,
  };
  expect(await errorCode(() => handleRequest(ctx, planted, scope()))).toBe("not_allowed");
  // Listing the allowed folder skips the link that leaves it.
  const listed = (await handleRequest(ctx, { op: "list", path: granted, depth: 1, agent: AGENT }, scope())) as {
    entries: { path: string }[];
  };
  expect(listed.entries.some((e) => e.path.endsWith("/escape"))).toBe(false);
  expect(await errorCode(() => resolveInRoots([granted], path.join(granted, "escape")))).toBe("not_allowed");
});

test("tools: commands off refuses exec and shell tasks; Claude Code and Codex need their own switch", async () => {
  const { ctx, setAccess } = setup({ commands: false });
  const tasks = { start: async () => ({ taskId: "t" }) } as unknown as TaskManager;
  const withTasks = { ...ctx, tasks };
  expect(
    await errorCode(() =>
      handleRequest(ctx, { op: "exec", command: "echo hi", timeoutSeconds: 10, stream: false, agent: AGENT }, scope()),
    ),
  ).toBe("exec_disabled");
  const task = (executor: "shell" | "claude" | "codex"): MachineRequest => ({
    op: "task.start",
    taskId: "0193aaaa-0000-7000-8000-000000000001",
    executor,
    command: "echo hi",
    prompt: "do it",
    agent: AGENT,
  });
  expect(await errorCode(() => handleRequest(withTasks, task("shell"), scope()))).toBe("exec_disabled");
  expect(await errorCode(() => handleRequest(withTasks, task("claude"), scope()))).toBe("not_allowed");
  expect(await errorCode(() => handleRequest(withTasks, task("codex"), scope()))).toBe("not_allowed");
  const brain: MachineRequest = {
    op: "brain.turn",
    runId: "run-00000001",
    kind: "claude_code",
    session: { id: "0193aaaa-0000-7000-8000-000000000001", resume: false },
    system: "",
    prompt: "hi",
    agent: AGENT,
  } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, brain, scope()))).toBe("not_allowed");

  setAccess({ folders: [], tools: { claude: true, codex: false, commands: false } });
  expect(await errorCode(() => handleRequest(withTasks, task("claude"), scope()))).toBe("ok");
  expect(await errorCode(() => handleRequest(withTasks, task("codex"), scope()))).toBe("not_allowed");
});

test("paused: new work is refused with `paused`; status and output still answer", async () => {
  const { ctx, pause } = setup();
  pause(true);
  const tasks = { status: () => ({ tasks: [] }) } as unknown as TaskManager;
  for (const req of [
    read("notes.txt"),
    { op: "list", path: "", depth: 1, agent: AGENT },
    { op: "exec", command: "echo hi", timeoutSeconds: 10, stream: false, agent: AGENT },
    { op: "write", path: "a.txt", base64: "", agent: AGENT },
  ] as MachineRequest[]) {
    expect(await errorCode(() => handleRequest(ctx, req, scope()))).toBe("paused");
  }
  expect(await handleRequest({ ...ctx, tasks }, { op: "task.status", agent: AGENT }, scope())).toEqual({ tasks: [] });
  pause(false);
  expect(await errorCode(() => handleRequest(ctx, { op: "list", path: "", depth: 1, agent: AGENT }, scope()))).toBe(
    "ok",
  );
});

test("system folders, the home itself and the runner's own folder can't be allowed", () => {
  const home = os.homedir();
  expect(refusedFolder("/", "/", { home })).toMatch(/system folder/);
  expect(refusedFolder(home, home, { home })).toMatch(/home folder/);
  expect(refusedFolder("/etc/ssh", "/etc/ssh", { home })).toMatch(/system folder/);
  expect(refusedFolder("/System/Library", "/System/Library", { home })).toMatch(/system folder/);
  expect(refusedFolder("/usr/local/lib", "/usr/local/lib", { home })).toMatch(/system folder/);
  // A symlink can't smuggle one in: the real path is checked too.
  expect(refusedFolder("/Users/me/link", "/etc", { home })).toMatch(/system folder/);
  expect(refusedFolder("/srv/r/home", "/srv/r/home", { home, runnerHome: "/srv/r/home" })).toMatch(/key/);
  expect(refusedFolder("/srv/r", "/srv/r", { home, runnerHome: "/srv/r/home" })).toMatch(/key/);
  expect(refusedFolder("/data", "/data", { home, workspace: "/data/agentes" })).toMatch(/every agent/);
  expect(refusedFolder(path.join(home, "Projects"), path.join(home, "Projects"), { home })).toBeNull();

  const ok = tempDir("proj-");
  dirs.push(ok);
  expect(checkFolder(ok)).toBe(ok);
  expect(() => checkFolder(path.join(ok, "missing"))).toThrow(/doesn't exist/);
  writeFileSync(path.join(ok, "file.txt"), "");
  expect(() => checkFolder(path.join(ok, "file.txt"))).toThrow(/not a folder/);
  if (posix) {
    try {
      checkFolder("/");
      throw new Error("allowed /");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("invalid_path");
    }
  }
});

test("access transforms: add merges, remove for one agent or all, set agents, tools", () => {
  const empty: RunnerAccess = { folders: [], tools: { claude: true, codex: true, commands: false } };
  let a = addFolder(empty, "/data/p", ["a1"]);
  a = addFolder(a, "/data/p", ["a2", "a1"]);
  expect(a.folders).toEqual([{ path: "/data/p", agents: ["a1", "a2"] }]);
  expect(allowedFor(a, "a1", "/data/p/src/x.ts")).toBe(true);
  expect(allowedFor(a, "a3", "/data/p/src/x.ts")).toBe(false);
  expect(allowedFor(a, "a1", "/data/px")).toBe(false);
  a = removeFolder(a, "/data/p", "a1");
  expect(a.folders).toEqual([{ path: "/data/p", agents: ["a2"] }]);
  a = setFolderAgents(a, "/data/p", ["a3"]);
  expect(a.folders[0]?.agents).toEqual(["a3"]);
  expect(setTool(a, "commands", true).tools.commands).toBe(true);
  expect(removeFolder(a, "/data/p").folders).toEqual([]);
  expect(empty.folders).toEqual([]); // never mutated
  expect(resolveAgentHandle([{ id: "a1", handle: "dev", name: "Dev" }], "@Dev")?.id).toBe("a1");
});

test("access.reduce from the site never widens", () => {
  const before: RunnerAccess = {
    folders: [
      { path: "/data/p", agents: ["a1", "a2"] },
      { path: "/data/q", agents: ["a1"] },
    ],
    tools: { claude: true, codex: false, commands: true },
  };
  const cases = [
    { removeFolder: { path: "/data/p", agentId: "a1" } },
    { removeFolder: { path: "/data/q" } },
    { removeFolder: { path: "/elsewhere" } },
    { disableTool: "commands" },
    // Attempts to widen are ignored.
    { disableTool: "codex" },
    { disableTool: "everything" },
    { removeFolder: { path: "/data/new", agentId: "a9" }, addFolder: { path: "/data/new" } },
    { enableTool: "codex", folders: [{ path: "/", agents: ["a1"] }] },
  ];
  for (const req of cases) {
    const after = reduceAccess(before, req as Parameters<typeof reduceAccess>[1]);
    expect(widens(after, before)).toBe(false);
  }
  expect(reduceAccess(before, { removeFolder: { path: "/data/p", agentId: "a1" } }).folders[0]).toEqual({
    path: "/data/p",
    agents: ["a2"],
  });
  expect(reduceAccess(before, { disableTool: "commands" }).tools).toEqual({
    claude: true,
    codex: false,
    commands: false,
  });
});

test("pending requests: kept 24 h, expired ones come out with their decision", () => {
  const home = tempDir("home-");
  dirs.push(home);
  let now = Date.parse("2026-10-17T10:00:00Z");
  const store = new AccessRequests(home, () => now);
  const r = store.add({
    requestId: "req-00000001",
    agent: { id: "a1", name: "Dev", handle: "dev" },
    path: "/data/p",
    reason: "tests",
  });
  expect(r.expiresAt).toBe("2026-10-18T10:00:00.000Z");
  // The same id again keeps the first.
  store.add({ requestId: "req-00000001", agent: { id: "a1", name: "Dev", handle: "dev" }, path: "/other", reason: "" });
  expect(new AccessRequests(home, () => now).list()).toHaveLength(1);
  now += 25 * 3600_000;
  expect(store.expire().map((x) => x.requestId)).toEqual(["req-00000001"]);
  expect(store.list()).toEqual([]);
  expect(store.undelivered()).toEqual([{ requestId: "req-00000001", decision: "expired" }]);
  store.delivered(["req-00000001"]);
  expect(store.undelivered()).toEqual([]);
});

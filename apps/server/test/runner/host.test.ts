import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readStoredConfig } from "../../runner/config";
import { TOKEN_REFUSED_EXIT } from "../../runner/connection";
import { defaultHostState, HostComputer, type HostOptions } from "../../runner/host";
import { installSystemService, launchdPlist, systemdSystemUnit } from "../../runner/service";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const hosts: HostComputer[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  removeDirs(dirs);
});

const A = "0192a6b0-0000-7000-8000-00000000000a";
const B = "0192a6b0-0000-7000-8000-00000000000b";
const MA = "0192a6b0-0000-7000-8000-0000000000aa";
const MB = "0192a6b0-0000-7000-8000-0000000000bb";

interface Sent {
  url: string;
  auth: string;
  body: { name: string; have: string[]; rotate: string[] };
}

/** The server's side: answers set by the test, requests kept. */
function fakeServer() {
  const sent: Sent[] = [];
  let answer: () => Response = () => Response.json({ orgs: [] });
  const fetch: HostOptions["fetch"] = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ url, auth: headers.authorization ?? "", body: JSON.parse(String(init.body)) });
    return answer();
  };
  return {
    sent,
    fetch,
    answer: (orgs: Record<string, unknown>[] | number) => {
      answer = () => (typeof orgs === "number" ? new Response(null, { status: orgs }) : Response.json({ orgs }));
    },
  };
}

interface FakeChild {
  home: string;
  label: string;
  signals: string[];
  exit(code: number | null): void;
}

/** Children that run until the test (or a kill) ends them. */
function fakeChildren() {
  const started: FakeChild[] = [];
  const start: HostOptions["start"] = (home, label) => {
    let resolve: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((r) => {
      resolve = r;
    });
    const child: FakeChild = { home, label, signals: [], exit: (code) => resolve(code) };
    started.push(child);
    return {
      exited,
      kill: (signal = "SIGTERM") => {
        child.signals.push(signal);
        resolve(null);
      },
    };
  };
  return { started, start };
}

function makeHost(over: Partial<HostOptions> = {}) {
  const state = tempDir("host-");
  dirs.push(state);
  const server = fakeServer();
  const children = fakeChildren();
  const lines: string[] = [];
  const host = new HostComputer({
    server: "http://127.0.0.1:3000",
    token: () => "host-token",
    state,
    name: "Servidor",
    system: false,
    exec: true,
    log: (line) => lines.push(line),
    start: children.start,
    fetch: server.fetch,
    workspaceBase: path.join(state, "work"),
    ...over,
  });
  hosts.push(host);
  return { host, state, server, children, lines, home: (orgId: string) => path.join(state, "orgs", orgId) };
}

const org = (orgId: string, machineId: string, token?: string, orgName = orgId === A ? "Acme" : "Beta") => ({
  orgId,
  orgName,
  machineId,
  ...(token ? { token } : {}),
});

test("a home per organization (mode 600, kept by the host) and a runner in each; `have` says which it holds", async () => {
  const { host, server, children, home, state } = makeHost();
  server.answer([org(A, MA, "agm_a"), org(B, MB, "agm_b")]);
  await host.sync();
  expect(server.sent[0]).toMatchObject({
    url: "http://127.0.0.1:3000/api/machines/host/sync",
    auth: "Bearer host-token",
    body: { name: "Servidor", have: [], rotate: [] },
  });
  const file = path.join(home(A), "config.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(home(A)).mode & 0o777).toBe(0o700);
  expect(readStoredConfig(home(A))).toEqual({
    server: "http://127.0.0.1:3000",
    machineId: MA,
    name: "Servidor",
    token: "agm_a",
    workspace: path.join(state, "work", "acme"),
    exec: true,
    orgId: A,
    orgName: "Acme",
    managedBy: "host",
    access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true, desktop: true } },
  });
  expect(existsSync(path.join(state, "work", "acme"))).toBe(true);
  expect(readStoredConfig(home(B))?.workspace).toBe(path.join(state, "work", "beta"));
  expect(children.started.map((c) => [c.home, c.label])).toEqual([
    [home(A), "Acme"],
    [home(B), "Beta"],
  ]);

  // Next round: no tokens (it holds them), nothing new runs, and the files stay as they were.
  server.answer([org(A, MA), org(B, MB)]);
  const before = readFileSync(file, "utf8");
  await host.sync();
  expect(server.sent[1]?.body.have.sort()).toEqual([A, B].sort());
  expect(children.started).toHaveLength(2);
  expect(readFileSync(file, "utf8")).toBe(before);

  // A home that lost its config isn't held: the server is asked for its token again.
  rmSync(file);
  await host.sync();
  expect(server.sent[2]?.body.have).toEqual([B]);
});

test("an organization no longer served stops its runner; a runner that stops starts again", async () => {
  const { host, server, children, home } = makeHost();
  server.answer([org(A, MA, "agm_a"), org(B, MB, "agm_b")]);
  await host.sync();
  const [a, b] = children.started;
  server.answer([org(A, MA)]);
  await host.sync();
  expect(b?.signals).toEqual(["SIGTERM"]);
  expect(a?.signals).toEqual([]);

  a?.exit(1);
  await waitFor(() => children.started.length === 3, 3000);
  expect(children.started[2]?.home).toBe(home(A));
});

test("a refused token: the next sync comes at once, asks for a new one, and the runner starts with it", async () => {
  const { host, server, children, home } = makeHost({ intervalMs: 60_000 });
  server.answer([org(A, MA, "agm_old")]);
  void host.run();
  await waitFor(() => children.started.length === 1);
  server.answer([org(A, MA, "agm_new")]);
  children.started[0]?.exit(TOKEN_REFUSED_EXIT);
  await waitFor(() => server.sent.length === 2);
  expect(server.sent[1]?.body).toMatchObject({ have: [A], rotate: [A] });
  await waitFor(() => readStoredConfig(home(A))?.token === "agm_new");
  await waitFor(() => children.started.length === 2, 3000);
});

test("turned off (404) or refused (401): nothing runs; back on when the server says yes", async () => {
  const { host, server, children, lines } = makeHost();
  server.answer([org(A, MA, "agm_a")]);
  await host.sync();
  server.answer(401);
  await host.sync();
  expect(children.started[0]?.signals).toEqual(["SIGTERM"]);
  expect(lines.some((l) => l.includes("refused this computer's token"))).toBe(true);
  server.answer(404);
  await host.sync();
  expect(children.started).toHaveLength(1);
  expect(lines.some((l) => l.includes("turned off"))).toBe(true);

  // The server unreachable: whatever runs keeps running.
  server.answer([org(A, MA)]);
  await host.sync();
  expect(children.started).toHaveLength(2);
  server.answer(502);
  await host.sync();
  expect(children.started[1]?.signals).toEqual([]);

  // No token at all: idle too.
  const off = makeHost({ token: () => null });
  await off.host.sync();
  expect(off.server.sent).toEqual([]);
  expect(off.children.started).toEqual([]);
});

test("--no-exec turns commands off in new homes; Claude Code, Codex, the browser and screens stay on, on a Mac and on Linux", async () => {
  for (const system of [false, true]) {
    const { host, server, home } = makeHost({ exec: false, system });
    server.answer([org(A, MA, "agm_a")]);
    await host.sync();
    expect(readStoredConfig(home(A))).toMatchObject({
      exec: false,
      access: { folders: [], tools: { claude: true, codex: true, commands: false, browser: true, desktop: true } },
    });
  }
});

test("its homes on a Mac go apart from the agentes app's, which starts every home in <home>/orgs", () => {
  expect(defaultHostState("darwin", "/Users/ana/.agentes-runner")).toBe("/Users/ana/.agentes-runner/host");
  expect(defaultHostState("linux", "/var/lib/agentes-runner")).toBe("/var/lib/agentes-runner");
});

test("system mode: each organization its own block of agent uids, root's folder as workspace, one list of uids", async () => {
  const { host, server, home } = makeHost({ system: true, uidRange: [20000, 20299] });
  server.answer([org(A, MA, "agm_a"), org(B, MB, "agm_b")]);
  await host.sync();
  expect(readStoredConfig(home(A))).toMatchObject({
    mode: "system",
    agentUidRange: [20000, 20099],
    workspace: path.join(home(A), "work"),
    access: { tools: { commands: true, browser: true } },
  });
  expect(readStoredConfig(home(B))).toMatchObject({ mode: "system", agentUidRange: [20100, 20199] });
  // A block, once given, stays with its organization.
  server.answer([org(B, MB)]);
  await host.sync();
  expect(readStoredConfig(home(B))?.agentUidRange).toEqual([20100, 20199]);

  writeFileSync(path.join(home(A), "agents.json"), JSON.stringify([{ id: "x", user: "ag-aaaaaaaa", uid: 20000 }]));
  writeFileSync(path.join(home(B), "agents.json"), JSON.stringify([{ id: "y", user: "ag-bbbbbbbb", uid: 20100 }]));
  expect(host.agentUids().sort()).toEqual([20000, 20100]);
});

test("an answer that names something other than ids makes no folder", async () => {
  const { host, server, state, children } = makeHost();
  mkdirSync(path.join(state, "orgs"), { recursive: true });
  server.answer([{ orgId: "../../escape", orgName: "x", machineId: MA, token: "agm_x" }]);
  await host.sync();
  expect(existsSync(path.join(state, "..", "escape"))).toBe(false);
  expect(children.started).toEqual([]);
});

test("its service: the root unit runs `host` (the token from a file), starts with no pairing, and leaves the home alone", () => {
  const state = tempDir("host-svc-");
  dirs.push(state);
  const launch = {
    runtime: "/opt/agentes-runner/bin/bun",
    script: "/opt/agentes-runner/agentes-runner.mjs",
    home: state,
  };
  const args = ["host", "--server", "http://127.0.0.1:3000", "--token-file", `${state}/host-token`, "--state", state];
  expect(systemdSystemUnit(launch, args)).toContain(
    `ExecStart="/opt/agentes-runner/bin/bun" "/opt/agentes-runner/agentes-runner.mjs" host --server http://127.0.0.1:3000 --token-file ${state}/host-token --state ${state}\n`,
  );
  expect(launchdPlist(launch, args)).toContain("<string>host</string>\n    <string>--server</string>");
  const calls: string[] = [];
  const unitPath = path.join(state, "etc/systemd/system/agentes-runner.service");
  const code = installSystemService({
    print: () => {},
    run: (file, a) => {
      calls.push(`${file} ${a.join(" ")}`);
      return { code: 0, output: "" };
    },
    launch,
    args,
    uid: 0,
    platform: "linux",
    unitPath,
    booted: true,
  });
  expect(code).toBe(0);
  expect(readFileSync(unitPath, "utf8")).toContain(" host --server ");
  expect(calls).toEqual([
    "systemctl daemon-reload",
    "systemctl enable agentes-runner",
    "systemctl restart agentes-runner",
  ]);
  expect(readStoredConfig(state)).toBeNull();
});

test("once: the homes written, every tool off, nothing started; what is new and what is gone", async () => {
  // Commands on, as `host` has them without --no-exec: once's homes still get no tool at all.
  const { host, server, children, home } = makeHost({ exec: true, rotate: [B] });
  server.answer([org(A, MA, "agm_a"), org(B, MB, "agm_b")]);
  expect(await host.once()).toEqual({
    status: "on",
    homes: [
      { orgId: A, orgName: "Acme", machineId: MA, home: home(A), new: true },
      { orgId: B, orgName: "Beta", machineId: MB, home: home(B), new: true },
    ],
    gone: [],
  });
  expect(server.sent[0]?.body.rotate).toEqual([B]);
  expect(children.started).toEqual([]);
  const stored = readStoredConfig(home(A));
  expect(stored).toMatchObject({ managedBy: "host", exec: false, access: { folders: [] } });
  // Nothing else on: a browser that's off has no key.
  expect(stored?.access?.tools).toEqual({ claude: false, codex: false, commands: false });

  // The next round: nothing new, and an organization it no longer serves is named, its home left alone.
  server.answer([org(A, MA)]);
  const next = await host.once();
  expect(next).toMatchObject({ status: "on", homes: [{ orgId: A, new: false }], gone: [B] });
  expect(existsSync(home(B))).toBe(true);
  expect(children.started).toEqual([]);
});

test("once: the server at another port is the same server, its homes not new and its tools kept", async () => {
  const { host, server, state, home } = makeHost();
  server.answer([org(A, MA, "agm_a")]);
  await host.once();
  const opened = { ...readStoredConfig(home(A)), access: { folders: [], tools: { claude: true, commands: true } } };
  writeFileSync(path.join(home(A), "config.json"), JSON.stringify(opened));

  const moved = makeHost({ server: "http://127.0.0.1:4311", state, fetch: server.fetch }).host;
  expect(await moved.once()).toMatchObject({ status: "on", homes: [{ orgId: A, new: false }], gone: [] });
  expect(readStoredConfig(home(A))).toMatchObject({
    server: "http://127.0.0.1:4311",
    access: { tools: { claude: true, commands: true } },
  });
});

test("once: says why it wrote nothing", async () => {
  const { host, server } = makeHost({ exec: false });
  server.answer(404);
  expect(await host.once()).toEqual({ status: "off", homes: [], gone: [] });
  server.answer(401);
  expect(await host.once()).toEqual({ status: "refused", homes: [], gone: [] });
  server.answer(502);
  expect(await host.once()).toEqual({ status: "unreachable", homes: [], gone: [] });
  expect((await makeHost({ token: () => null }).host.once()).status).toBe("no_token");
});

test("host --once from the command line: one JSON line, as this computer's user, in the home's orgs on a Mac too", async () => {
  const state = tempDir("host-once-");
  dirs.push(state);
  writeFileSync(path.join(state, "token"), "host-token\n", { mode: 0o600 });
  const seen: unknown[] = [];
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      seen.push(await req.json());
      return Response.json({ orgs: [org(A, MA, "agm_a")] });
    },
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "../../runner/main.ts"),
        "host",
        "--once",
        "--server",
        `http://127.0.0.1:${fake.port}`,
        "--token-file",
        path.join(state, "token"),
        "--name",
        "Ana's Mac",
        "--rotate",
        A,
      ],
      // HOME too: the organization's workspace goes in ~/agentes.
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTES_RUNNER_HOME: state, HOME: state } },
    );
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toHaveLength(1);
    // Without --state, where the agentes app keeps the homes it starts (not `host`'s own folder on a Mac).
    expect(JSON.parse(out)).toMatchObject({
      status: "on",
      homes: [{ orgId: A, new: true, home: path.join(state, "orgs", A) }],
      gone: [],
    });
    expect(seen[0]).toMatchObject({ name: "Ana's Mac", rotate: [A] });
    // Single-user, on Linux too: no system mode, no uid block.
    const stored = readStoredConfig(path.join(state, "orgs", A));
    expect(stored?.mode).toBeUndefined();
    expect(stored?.agentUidRange).toBeUndefined();
  } finally {
    await fake.stop(true);
  }
});

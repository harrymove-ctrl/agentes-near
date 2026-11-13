import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactCommon } from "@agenteschat/adapters/redact";
import { setTool } from "../../runner/access";
import { ActivityLog } from "../../runner/activity";
import {
  accessToStore,
  configPath,
  effectiveAccess,
  normalizeStored,
  parseService,
  pauseOf,
  readConfig,
  readStoredConfig,
  watchConfig,
  writeConfig,
} from "../../runner/config";
import { RotatingFile, rotatedName, tailLines } from "../../runner/logfile";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";

function home() {
  const h = tempDir("home-");
  dirs.push(h);
  return h;
}

const base = {
  server: "https://agentes.test",
  machineId: "m1",
  name: "box",
  token: "agm_secret_token_1234",
  workspace: "/tmp/ws",
  exec: true,
};

test("config: new fields are read and checked; a home without a token isn't paired", () => {
  const h = home();
  expect(readConfig(h)).toBeNull();
  writeConfig(
    {
      ...base,
      managedBy: "desktop",
      paused: { until: "2030-01-01T10:00:00Z" },
      access: {
        folders: [{ path: "/data/x", agents: ["a1"] }],
        tools: { claude: true, codex: false, commands: false },
      },
      orgId: "o1",
      orgName: "Acme",
    },
    h,
  );
  if (posix) expect(statSync(configPath(h)).mode & 0o777).toBe(0o600);
  const c = readConfig(h);
  expect(c).toMatchObject({
    managedBy: "desktop",
    orgId: "o1",
    orgName: "Acme",
    paused: { until: "2030-01-01T10:00:00.000Z" },
  });
  // With `access`, commands come from it, whatever `exec` says.
  expect(c?.exec).toBe(false);
  expect(effectiveAccess(c).tools).toEqual({
    claude: true,
    codex: false,
    cursor: false,
    opencode: false,
    grok: false,
    antigravity: false,
    commands: false,
  });

  // Unpaired from the app: settings stay, the token is gone.
  writeConfig({ managedBy: "desktop", workspace: "/tmp/ws" }, h);
  expect(readConfig(h)).toBeNull();
  expect(readStoredConfig(h)).toEqual({ managedBy: "desktop", workspace: "/tmp/ws" });

  // A token without the rest is broken, not "unpaired".
  writeFileSync(configPath(h), JSON.stringify({ token: "agm_x" }));
  expect(() => readConfig(h)).toThrow(/incomplete/);
});

test("a home paired before protocol 10 keeps its behaviour: every tool follows exec", () => {
  expect(effectiveAccess({ ...base, exec: true })).toEqual({
    folders: [],
    tools: { claude: true, codex: true, cursor: true, opencode: true, grok: true, antigravity: true, commands: true },
  });
  expect(effectiveAccess({ ...base, exec: false }).tools).toEqual({
    claude: false,
    codex: false,
    cursor: false,
    opencode: false,
    grok: false,
    antigravity: false,
    commands: false,
  });
  expect(effectiveAccess(null).tools.commands).toBe(false);
});

test("access stored before Cursor's switch: Cursor follows Codex's, and once stored it is its own", () => {
  const access = (tools: Record<string, boolean>) => ({ ...base, access: { folders: [], tools } }) as never;
  expect(effectiveAccess(access({ claude: true, codex: true, commands: false })).tools.cursor).toBe(true);
  expect(effectiveAccess(access({ claude: true, codex: false, commands: true })).tools.cursor).toBe(false);
  expect(effectiveAccess(access({ claude: true, codex: true, cursor: false, commands: true })).tools.cursor).toBe(
    false,
  );
  // Grok's switch (protocol 43) the same way.
  expect(effectiveAccess(access({ claude: true, codex: true, cursor: true, commands: true })).tools.grok).toBe(true);
  expect(effectiveAccess(access({ claude: true, codex: true, grok: false, commands: true })).tools.grok).toBe(false);
  // The Antigravity CLI's (protocol 44) too.
  expect(effectiveAccess(access({ claude: true, codex: true, commands: true })).tools.antigravity).toBe(true);
  expect(
    effectiveAccess(access({ claude: true, codex: true, antigravity: false, commands: true })).tools.antigravity,
  ).toBe(false);
});

test("a write from an app without Cursor's switch keeps Cursor following Codex's", () => {
  const stored = { ...base, access: { folders: [], tools: { claude: true, codex: true, commands: true } } } as never;
  const offCodex = setTool(effectiveAccess(stored), "codex", false);
  const written = { ...base, access: accessToStore(stored, offCodex) } as never;
  expect(effectiveAccess(written).tools.cursor).toBe(false);
  // Turning Cursor itself off stores its own switch.
  const offCursor = accessToStore(stored, setTool(effectiveAccess(stored), "cursor", false));
  expect(offCursor.tools.cursor).toBe(false);
  // Once stored, it no longer follows.
  const own = {
    ...base,
    access: { folders: [], tools: { claude: true, codex: true, cursor: true, commands: true } },
  } as never;
  expect(accessToStore(own, setTool(effectiveAccess(own), "codex", false)).tools.cursor).toBe(true);
});

test("services: what of the computer agents may reach, one TCP or UDP port each, kept as written once", () => {
  expect(["tcp/11434", " UDP/8125 ", "tcp/0", "tcp/65536", "sctp/5", "11434", "tcp/11434/x"].map(parseService)).toEqual(
    ["tcp/11434", "udp/8125", null, null, null, null, null],
  );
  expect(normalizeStored({ services: ["tcp/11434", "TCP/11434", "udp/8125", 5, "nope"] }).services).toEqual([
    "tcp/11434",
    "udp/8125",
  ]);
  expect(normalizeStored({ services: [] })).toEqual({});
  expect(normalizeStored({ services: "tcp/11434" })).toEqual({});
});

test("pause: until null holds until resumed; an until in the past counts as resumed", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  expect(pauseOf(null, now)).toEqual({ paused: false });
  expect(pauseOf({ paused: { until: null } }, now)).toEqual({ paused: true, until: null });
  expect(pauseOf({ paused: { until: "2026-10-17T13:00:00.000Z" } }, now)).toEqual({
    paused: true,
    until: "2026-10-17T13:00:00.000Z",
  });
  expect(pauseOf({ paused: { until: "2026-10-17T11:00:00.000Z" } }, now)).toEqual({ paused: false });
});

test("the config is watched: a terminal command or an editor changes it, the runner sees it", async () => {
  const h = home();
  writeConfig(base, h);
  const seen: (string | null)[] = [];
  stops.push(watchConfig(h, (text) => seen.push(text), { debounceMs: 20, pollMs: 50 }));
  await new Promise((r) => setTimeout(r, 30));
  writeConfig({ ...base, name: "renamed" }, h);
  await waitFor(() => seen.some((t) => t?.includes('"renamed"')), 3000);
  // An atomic rewrite with another inode is seen too (editors and `writeConfig` both replace the file).
  writeFileSync(`${configPath(h)}.x`, JSON.stringify({ ...base, name: "third" }));
  renameSync(`${configPath(h)}.x`, configPath(h));
  await waitFor(() => seen.some((t) => t?.includes('"third"')), 3000);
});

test("rotating files: 5 MB by default, three files at most, newest first", () => {
  const h = home();
  const file = path.join(h, "logs", "runner.log");
  expect(rotatedName(file, 2)).toBe(path.join(h, "logs", "runner.2.log"));
  const f = new RotatingFile(file, 100, 3);
  for (let i = 0; i < 20; i++) f.append(`line ${String(i).padStart(2, "0")} ${"x".repeat(30)}\n`);
  expect(readdirSync(path.join(h, "logs")).sort()).toEqual(["runner.1.log", "runner.2.log", "runner.log"]);
  expect(f.files()).toEqual([file, rotatedName(file, 1), rotatedName(file, 2)]);
  expect(tailLines(file, 1)[0]).toStartWith("line 19");
});

test("credentials are masked in free text", () => {
  const text = redactCommon(
    "token agm_abcdefgh123456 Authorization: Bearer abc.def.ghi123 key sk-ant-api03-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz0123 password=hunter2",
  );
  expect(text).not.toContain("agm_abcdefgh123456");
  expect(text).not.toContain("abc.def.ghi123");
  expect(text).not.toContain("sk-ant-api03-abcdefghijklmnop");
  expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  expect(text).not.toContain("hunter2");
  // GitHub's stateless App token (`ghs_<app id>_<JWT>`): all of it, dots and dashes included.
  const app = `ghs_123_eyJhbGciOiJSUzI1NiJ9.${"e".repeat(40)}.${"s-ig_".repeat(8)}`;
  expect(redactCommon(`fetch with ${app} failed`)).toBe("fetch with gh_*** failed");
});

test("activity log: newest first, pages with before, filters by agent, rotates, masks secrets", () => {
  const h = home();
  const log = new ActivityLog(h, { maxBytes: 2000, keep: 3 });
  const t0 = Date.parse("2026-10-17T10:00:00Z");
  for (let i = 0; i < 60; i++) {
    log.append(
      {
        at: new Date(t0 + i * 1000).toISOString(),
        agent: { id: i % 2 ? "a1" : "a2", name: i % 2 ? "Dev" : "Ops" },
        kind: "command",
        summary: `run ${i}`,
        command: `deploy --key=SECRETVALUE-${i}`,
        result: "ok",
      },
      (s) => s.replaceAll("SECRETVALUE", "***"),
    );
  }
  const files = readdirSync(h).filter((f) => f.startsWith("activity"));
  expect(files.length).toBeLessThanOrEqual(3);
  expect(existsSync(path.join(h, "activity.1.jsonl"))).toBe(true);

  const first = log.page({ limit: 5 });
  expect(first.entries.map((e) => e.summary)).toEqual(["run 59", "run 58", "run 57", "run 56", "run 55"]);
  expect(first.more).toBe(true);
  expect(first.entries[0]?.command).toBe("deploy --key=***-59");

  const next = log.page({ limit: 3, before: first.entries[4]?.at });
  expect(next.entries.map((e) => e.summary)).toEqual(["run 54", "run 53", "run 52"]);

  const dev = log.page({ limit: 200, agentId: "a1" });
  expect(dev.entries.every((e) => e.agent?.id === "a1")).toBe(true);
  expect(dev.more).toBe(false);
  // Limits: default 50, at most 200.
  expect(log.page({ limit: 10_000 }).entries.length).toBeLessThanOrEqual(200);
});

test("a configured network helper is preserved or refused, never silently disabled", () => {
  expect(normalizeStored({ ...base, networkLauncher: "/opt/network/launcher" }).networkLauncher).toBe(
    "/opt/network/launcher",
  );
  for (const networkLauncher of ["relative", "", "/opt/a\0b", false, 123])
    expect(() => normalizeStored({ ...base, networkLauncher })).toThrow("networkLauncher");
  expect(normalizeStored(base).networkLauncher).toBeUndefined();
});

test("networkMark is absent by default and rejects malformed or reserved packet bits", () => {
  expect(normalizeStored({}).networkMark).toBeUndefined();
  expect(normalizeStored({ networkMark: 0x08000000 }).networkMark).toBe(0x08000000);
  expect(normalizeStored({ networkMark: 0x80000000 }).networkMark).toBe(0x80000000);
  for (const mark of [0, -1, 1.5, "134217728", 0x100000000, 3, 0x01000000, 0x40000000]) {
    expect(() => normalizeStored({ networkMark: mark })).toThrow("networkMark");
  }
});

test("only an explicit bounded root policy enables forced network draining", () => {
  expect(normalizeStored({ networkDrainSeconds: 60 }).networkDrainSeconds).toBe(60);
  for (const value of [undefined, 0, 29, 3601, 1.5, "60"])
    expect(normalizeStored({ networkDrainSeconds: value }).networkDrainSeconds).toBeUndefined();
});

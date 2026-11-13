import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTerm } from "@agenteschat/setup/src/term";
import { connections, cpuName, type DoctorPhone, type DoctorSources, runDoctor } from "../../runner/doctor";
import { acquireLock } from "../../runner/lock";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const PIXEL: DoctorPhone = {
  platform: "android",
  serial: "38021FDH2000AB",
  kind: "device",
  model: "Pixel 8",
  osVersion: "16",
  transport: "usb",
  state: "ready",
};
const IPHONE: DoctorPhone = {
  platform: "ios",
  serial: "00008110-000A1B2C3D4E5F60",
  kind: "device",
  model: "iPhone 16",
  name: "Sam's iPhone 16",
  osVersion: "27.1",
  transport: "usb",
  state: "needs_you",
  reason: "developer_mode_off",
};

/** Sam's MacBook Pro as the doctor sees it; `phones` answers each look in turn (the last one again after that). */
function mac(over: Partial<DoctorSources> = {}, phones: DoctorPhone[][] = [[PIXEL, IPHONE]]): DoctorSources {
  let look = 0;
  return {
    platform: "darwin",
    system: "macOS 26.1 · Apple M3 Pro · 12 CPU · 36 GB",
    user: "sam",
    connections: () => [
      {
        home: "/Users/sam/.agentes-runner",
        name: "Sam's MacBook Pro",
        server: "https://app.example.com",
        org: "Acme",
        running: true,
        system: false,
        commands: true,
      },
    ],
    apps: async () => ({
      claude: { version: "2.1.4 (Claude Code)", loggedIn: true },
      codex: { version: "codex-cli 0.46.0" },
    }),
    toolchains: async () => ({ xcode: "27.0", java: "21.0.5", adb: "36.0.2", git: "2.47.1" }),
    phones: async () => phones[Math.min(look++, phones.length - 1)] ?? [],
    ...over,
  };
}

/** The doctor's lines as a log gets them (no terminal: marks, no frame, no color). */
async function doctor(sources: DoctorSources, opts: { wait?: boolean; json?: boolean } = {}) {
  let text = "";
  const term = createTerm({ env: {}, platform: "darwin", out: { isTTY: false, write: (s: string) => (text += s) } });
  let json = "";
  const code = await runDoctor({
    term,
    sources,
    wait: opts.wait ?? false,
    json: opts.json ?? false,
    write: (s) => (json += s),
    pollMs: 1,
  });
  return { code, text, json };
}

test("doctor: this Mac, its apps, toolchains and phones, the fix for what needs the person, exit 1", async () => {
  const r = await doctor(mac({}, [[{ ...PIXEL, inUseSince: new Date().toISOString() }, IPHONE]]));
  expect(r.code).toBe(1);
  const lines = r.text.trimEnd().split("\n");
  expect(lines[0]).toBe("agentes.chat check this Mac");
  expect(r.text).toContain(
    "◇  Sam's MacBook Pro, connected to Acme\n   macOS 26.1 · Apple M3 Pro · 12 CPU · 36 GB\n   https://app.example.com · commands run as sam\n",
  );
  expect(r.text).toContain("◇  Claude Code 2.1.4, signed in\n◇  Codex 0.46.0\n");
  expect(r.text).toContain("◇  Xcode 27.0\n◇  JDK 21.0.5\n◇  adb 36.0.2\n");
  expect(r.text).toContain("○  Not found: Android SDK, Maestro, scrcpy, Node\n");
  expect(r.text).toMatch(/◇ {2}Pixel 8: in use since \d\d:\d\d\n {3}Android 16 · USB\n/);
  // The same words the phone ops answer an agent with.
  expect(r.text).toContain(
    "■  Sam's iPhone 16 isn't ready\n   Turn on Developer Mode: Settings › Privacy & Security › Developer Mode, then restart the iPhone.\n",
  );
  expect(lines.at(-1)).toBe("1 thing needs you");
});

test("doctor --wait: says what it waits for, shows the fix landing, and ends by itself", async () => {
  const fixed = { ...IPHONE, state: "ready" as const, reason: undefined };
  const r = await doctor(
    mac({}, [
      [PIXEL, IPHONE],
      [PIXEL, IPHONE],
      [PIXEL, fixed],
    ]),
    { wait: true },
  );
  expect(r.code).toBe(0);
  expect(r.text).toContain(
    "◒  Waiting for Developer Mode on Sam's iPhone 16\n◇  Sam's iPhone 16: ready\n   iOS 27.1 · USB\n",
  );
  expect(r.text.trimEnd().split("\n").at(-1)).toBe("Every check passed");
});

test("doctor --wait: a phone that needs something else next is shown again; waiting can't connect a computer", async () => {
  const untrusted = { ...IPHONE, reason: "untrusted" as const };
  const ready = { ...IPHONE, state: "ready" as const, reason: undefined };
  const r = await doctor(mac({}, [[untrusted], [IPHONE], [ready]]), { wait: true });
  expect(r.code).toBe(0);
  expect(r.text).toContain(
    "◒  Waiting for Trust on Sam's iPhone 16\n■  Sam's iPhone 16 isn't ready\n   Turn on Developer Mode",
  );

  // Not connected: the fix, and no wait (nothing on this computer would change it).
  const alone = await doctor(mac({ connections: () => [] }, [[]]), { wait: true });
  expect(alone.code).toBe(1);
  expect(alone.text).toContain(
    "■  This Mac isn't connected to a workspace\n   Connect it in agentes.chat, under Settings › Devices.\n   macOS 26.1",
  );
  expect(alone.text).toContain("○  No phones attached\n");
  expect(alone.text).not.toContain("Waiting");
});

test("doctor: a connection that isn't running says how to start it; Linux shows no Xcode; --json for programs", async () => {
  const stopped = mac({
    platform: "linux",
    system: "Ubuntu 24.04 · AMD Ryzen 9 7950X · 32 CPU · 64 GB",
    connections: () => [
      {
        home: "/var/lib/agentes-runner",
        name: "build-box",
        server: "https://app.example.com",
        org: "Acme",
        running: false,
        system: true,
        commands: true,
      },
    ],
    apps: async () => ({}),
    toolchains: async () => ({ git: "2.43.0" }),
  });
  const r = await doctor(stopped);
  expect(r.code).toBe(1);
  expect(r.text).toStartWith("agentes.chat check this computer\n");
  expect(r.text).toContain(
    "■  build-box is connected to Acme but isn't running\n   Run it in the background:\n     agentes-runner service install\n",
  );
  expect(r.text).toContain("https://app.example.com · each agent works here as a user of its own");
  expect(r.text).toContain(
    "○  No agent apps here (Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity CLI (Gemini))\n",
  );
  expect(r.text).toContain("○  Not found: JDK, Android SDK, adb, Maestro, scrcpy, Node\n");

  const j = await doctor(mac(), { json: true });
  expect(j.code).toBe(1);
  expect(j.text).toBe("");
  const parsed = JSON.parse(j.json) as { ok: boolean; needsYou: number; checks: { key: string; status: string }[] };
  expect(parsed).toMatchObject({ ok: false, needsYou: 1 });
  expect(parsed.checks.find((c) => c.status === "needs")?.key).toBe(`phone:ios:${IPHONE.serial}`);
});

test("connections: this home and the agentes app's, running while their runner holds the lock", () => {
  const home = tempDir("doctor-");
  dirs.push(home);
  const config = (dir: string, extra: Record<string, unknown>) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        server: "https://app.example.com",
        machineId: "m-1",
        token: "agm_fake",
        workspace: "/w",
        exec: true,
        ...extra,
      }),
    );
  };
  config(home, { name: "build-box", orgName: "Acme" });
  config(path.join(home, "orgs", "o-2"), { name: "Sam's MacBook Pro", orgName: "Globex", managedBy: "desktop" });
  // Not connected (no token): left out.
  mkdirSync(path.join(home, "orgs", "o-3"), { recursive: true });
  writeFileSync(path.join(home, "orgs", "o-3", "config.json"), "{}");
  const lock = acquireLock(home, "start");
  if (!lock.ok) throw new Error("no lock");
  expect(connections(home)?.map((c) => [c.name, c.org, c.running, c.managedBy ?? null, c.commands])).toEqual([
    ["build-box", "Acme", true, null, true],
    ["Sam's MacBook Pro", "Globex", false, "desktop", true],
  ]);
  lock.release();
  expect(connections(path.join(home, "none"))).toEqual([]);
  // System mode's home is root's alone: to anyone else it is unreadable, not unconnected.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(home, 0o000);
    try {
      expect(connections(home)).toBeNull();
    } finally {
      chmodSync(home, 0o700);
    }
  }
});

test("doctor: a home only root reads says so; a phone too old for the tools needs nothing of the person", async () => {
  const old: DoctorPhone = { ...PIXEL, state: "unsupported", reason: "os_too_old" };
  const r = await doctor(mac({ connections: () => null }, [[old]]), { wait: true });
  expect(r.code).toBe(1);
  expect(r.text).toContain(
    "■  Only root can see this Mac's connection\n   Run it as root:\n     sudo agentes-runner doctor\n",
  );
  expect(r.text).toContain("○  Pixel 8 can't be used. Its Android version is too old for these tools.\n");
  expect(r.text).not.toContain("Waiting");
  expect(r.text.trimEnd().split("\n").at(-1)).toBe("1 thing needs you");
});

test("cpu names without the marketing marks", () => {
  expect(cpuName("AMD Ryzen 9 7950X 16-Core Processor")).toBe("AMD Ryzen 9 7950X");
  expect(cpuName("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz")).toBe("Intel Xeon E5-2680 v4");
  expect(cpuName("Apple M3 Pro")).toBe("Apple M3 Pro");
});

test("agentes-runner doctor --json on a computer never connected: exit 1, and the connection is what needs the person", () => {
  const home = tempDir("doctor-cli-");
  dirs.push(home);
  const run = Bun.spawnSync(
    [process.execPath, path.join(import.meta.dir, "../../runner/main.ts"), "doctor", "--json", "--home", home],
    { env: { HOME: home, PATH: "/usr/bin:/bin" } },
  );
  expect(run.exitCode).toBe(1);
  const out = JSON.parse(run.stdout.toString()) as { ok: boolean; checks: { key: string; status: string }[] };
  expect(out.ok).toBe(false);
  expect(out.checks[0]).toMatchObject({ key: "computer", status: "needs" });
}, 60_000);

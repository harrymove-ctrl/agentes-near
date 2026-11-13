import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { HELPER_ENV, type HelperReply, type HelperSnapshot, helperCommand } from "../../runner/desktop-helper";
import { removeDirs, tempDir } from "./helpers";

const SOURCE = path.join(import.meta.dir, "..", "..", "runner", "desktop-helper.py");
const FIXTURES = path.join(import.meta.dir, "fixtures", "desktop");
/** The CI runners have Python; a developer's machine may not. */
const python = Bun.which("python3") ?? (process.env.CI ? "python3" : null);

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

test("the helper runs from its source in one argument, isolated, with a UTF-8 locale", () => {
  const [command, isolated, flag, source = "", ...rest] = helperCommand();
  expect([command, isolated, flag, rest]).toEqual(["python3", "-I", "-c", []]);
  expect(source).toBe(readFileSync(SOURCE, "utf8"));
  // Linux takes at most 128 KiB in one argument, and decodes it with whatever locale the computer has.
  expect(Buffer.byteLength(source)).toBeLessThan(128 * 1024);
  expect(/^[\t\n\x20-\x7e]*$/.test(source)).toBe(true);
  expect(helperCommand("/usr/bin/python3")[0]).toBe("/usr/bin/python3");
  expect(HELPER_ENV.LC_ALL).toBe("C.UTF-8");
});

test.skipIf(!python)("the helper's pure parts pass their Python tests", () => {
  const run = Bun.spawnSync([python ?? "", "-I", path.join(import.meta.dir, "test_desktop_helper.py")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`${run.stdout}\n${run.stderr}`);
  expect(run.stderr.toString()).toMatch(/\nOK\n/);
});

test.skipIf(!python)("with no desktop, the helper still answers each line, and writes nothing else", async () => {
  const home = tempDir("desktop-helper-");
  dirs.push(home);
  const proc = Bun.spawn(helperCommand(python ?? ""), {
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", ...HELPER_ENV },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = [
    { id: 1, op: "hello" },
    "not json",
    { id: 2, op: "snapshot", scope: "front" },
    { id: 3, op: "input", steps: [{ type: "senha: Olá7Q" }] },
    { id: 4, op: "shutdown" },
  ];
  proc.stdin.write(lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
  proc.stdin.write("\n");
  await proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(err).toBe("");
  const replies = out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as HelperReply);
  expect(replies).toHaveLength(5);
  expect(replies[0]).toMatchObject({ id: 1, ok: true, data: { screen: null, a11y: false, damage: false } });
  expect(replies[1]).toMatchObject({ id: null, ok: false, code: "bad_request" });
  expect(replies[2]).toMatchObject({ id: 2, ok: false, code: "unavailable" });
  expect(replies[3]).toMatchObject({ id: 3, ok: false, code: "unavailable" });
  expect(replies[4]).toMatchObject({ id: 4, ok: false, code: "bad_request" });
  // The text it was sent to type is never repeated back, nor anywhere else.
  expect(out).not.toContain("Olá7Q");
});

test("the snapshots recorded on a real desktop have the shape of the types", () => {
  const names = readdirSync(FIXTURES);
  expect(names.sort()).toEqual([
    "chromium-skipped.json",
    "dialog.json",
    "dock.json",
    "gtk4.json",
    "menu.json",
    "qt.json",
    "terminal.json",
    "thunar.json",
  ]);
  const isBox = (b: unknown) => Array.isArray(b) && b.length === 4 && b.every(Number.isInteger);
  for (const name of names) {
    const snap = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as HelperSnapshot;
    // The desktops' size, or the 1280×800 the first snapshots were recorded at.
    expect([
      [1280, 800],
      [1280, 900],
    ]).toContainEqual(snap.screen);
    expect(snap.windows.filter((w) => w.active)).toHaveLength(1);
    for (const w of snap.windows) {
      expect([typeof w.xid, typeof w.title, isBox(w.box), w.class.length, Array.isArray(w.types)]).toEqual([
        "number",
        "string",
        true,
        2,
        true,
      ]);
    }
    for (const app of snap.apps) {
      for (const n of app.nodes ?? []) {
        expect([typeof n.path, typeof n.role, typeof n.name, n.states.length]).toEqual([
          "string",
          "string",
          "string",
          2,
        ]);
        if (n.box) expect(isBox(n.box)).toBe(true);
        if (n.role === "password text") expect(n.text).toBeUndefined();
      }
    }
  }
  const terminal = JSON.parse(readFileSync(path.join(FIXTURES, "terminal.json"), "utf8")) as HelperSnapshot;
  const text = terminal.apps.flatMap((a) => a.nodes ?? []).find((n) => n.role === "terminal")?.text;
  expect(text).toContain('- button "Pay now" [ref=e9]');
});

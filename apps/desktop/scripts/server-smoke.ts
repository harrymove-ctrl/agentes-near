/**
 * Runs the server here the way the desktop app does (`src-tauri/src/local_server.rs`), before the build ships:
 * the runner binary acting as Bun (`BUN_BE_BUN=1`) on the bundled `server/native.js`, with only the variables
 * the app passes, in a new data folder. It must answer `/api/health` as its own `server.json` names it, then
 * stop by itself, with exit 0, once its stdin closes (`--until-stdin-ends`, how the app stops it on Windows).
 *
 *   bun apps/desktop/scripts/server-smoke.ts <runner binary> <native folder>
 *
 * Run by the Desktop workflow on Windows and Linux.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [runner, native] = process.argv.slice(2);
if (!runner || !native) {
  console.error("usage: bun apps/desktop/scripts/server-smoke.ts <runner binary> <native folder>");
  process.exit(2);
}

/** The variables `Launch::command` keeps (the Unix ones and `WINDOWS_ENV`). */
const KEPT = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "TEMP",
  "TMP",
];
const env: Record<string, string> = { BUN_BE_BUN: "1" };
for (const key of KEPT) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}

const ANSWER_MS = 180_000;
const STOP_MS = 40_000;
const data = mkdtempSync(join(tmpdir(), "agentes-smoke-"));
const server = Bun.spawn([runner, join(native, "server", "native.js"), "--until-stdin-ends", "--data", data], {
  env,
  stdin: "pipe",
  stdout: "inherit",
  stderr: "inherit",
});

const fail = (message: string): never => {
  console.error(`server smoke: ${message}`);
  const log = join(data, "logs", "server.log");
  if (existsSync(log)) console.error(readFileSync(log, "utf8").split("\n").slice(-40).join("\n"));
  server.kill();
  process.exit(1);
};

const started = Date.now();
let url: string | null = null;
while (!url) {
  if (server.exitCode !== null) fail(`it stopped before it answered (exit ${server.exitCode})`);
  if (Date.now() - started > ANSWER_MS) fail("it didn't answer within 3 minutes");
  try {
    const ready = JSON.parse(readFileSync(join(data, "server.json"), "utf8")) as { pid?: number; url?: string };
    if (ready.pid === server.pid && ready.url && (await fetch(`${ready.url}/api/health`)).ok) url = ready.url;
  } catch {
    // not written yet, or not listening yet
  }
  if (!url) await Bun.sleep(500);
}
console.log(`server smoke: answered at ${url} in ${Math.round((Date.now() - started) / 1000)} s`);

server.stdin.end();
const code = await Promise.race([server.exited, Bun.sleep(STOP_MS).then(() => null)]);
if (code === null) fail(`it didn't stop within ${STOP_MS / 1000} s of its stdin closing`);
if (code !== 0) fail(`it stopped with exit ${code}`);
if (existsSync(join(data, "server.json"))) fail("it left server.json behind");
console.log("server smoke: stopped when its stdin closed");
rmSync(data, { recursive: true, force: true });

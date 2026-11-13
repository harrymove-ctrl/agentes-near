/**
 * `agentes-server`: agentes.chat with nothing else to install (native mode, ADR 0060 §2). One program
 * whose database is built in (PGlite: `DATABASE_URL=pglite:///<folder>`), keeping everything in one
 * folder, `--data` (`~/.agentes` by default):
 *
 *   .env             the settings, mode 600; variables already in the environment win over it
 *   db/              the database
 *   files/           uploaded files (FILES_DIR)
 *   logs/server.log  the log, 5 MB × 3
 *   server.lock      the pid of the one process using the folder
 *   server.json      written once it listens, removed when it stops
 *   backups/         what an upgrade's restore moved aside
 *   db.lock          the database's own lock, held by the process that has it open
 *
 * It listens on 127.0.0.1 only and answers only its own addresses (`ownHostsOnly`).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { format, parseArgs } from "node:util";
import { loadConfig } from "@agenteschat/config";
import {
  createDatabase,
  DatabaseInUseError,
  dumpPglite,
  folderLockFile,
  folderVersion,
  isEmptyFolder,
  openPglite,
  PG_MAJOR,
  PGLITE_VERSION,
  PgMajorMismatchError,
  pgliteUrl,
  restorePglite,
} from "@agenteschat/db";
import { passwordLinkByEmail } from "@agenteschat/engine";
import { INSTALL_DOCS_URL } from "@agenteschat/i18n/help";
import { envEntries, upsertEnv } from "@agenteschat/setup/src/lib";
import { expandHome } from "../runner/config";
import { acquireLock, type LockResult } from "../runner/lock";
import { RotatingFile } from "../runner/logfile";
import {
  removeUserService,
  type ServiceDefinition,
  startLaunchAgent,
  startUserUnit,
  systemdUnitText,
  systemdUserAvailable,
  userServiceStatus,
} from "../runner/service";
import { createLogger } from "./logger";
import { prepareDatabase, startServer } from "./start";
import { printTelemetry } from "./telemetry";
import { version } from "./version";

export const EXIT = { ok: 0, error: 1, locked: 3, upgrade: 4, port: 5 } as const;
/** The ports a new folder may take, first free one first; not 3000, which the Docker install and dev tools use. */
export const NATIVE_PORTS = { first: 4310, last: 4329 } as const;
const LOCK_FILE = "server.lock";

/**
 * The installed package around this file: `<package>/server/lib/native.js` once bundled, next to
 * `<package>/web` and `<package>/bin/agentes-server` (`scripts/native-package.ts`).
 */
const PACKAGE = resolve(import.meta.dir, "..", "..");

const USAGE = `agentes-server ${version}: agentes.chat on this computer, with its database built in.

Usage:
  agentes-server [--data <folder>] [--until-stdin-ends]
      Runs agentes.chat until it's stopped (Ctrl-C, or the end of stdin with --until-stdin-ends).
      The folder (default ~/.agentes) keeps everything. A new one gets its settings, in .env, the
      first time.
  agentes-server migrate [--data <folder>]
      Updates the database to this version, then exits.
  agentes-server db dump [--data <folder>] [--out <file>]
      The whole database as SQL (to the screen without --out). psql restores it into the
      Postgres of the Docker install.
  agentes-server db restore [--data <folder>] --in <file>
      Puts a dump into a folder with no database yet, or with one this version can't open (an
      upgrade: that one moves to backups/).
  agentes-server db check [--data <folder>]
      Opens the database and prints what wrote it.
  agentes-server telemetry [--data <folder>]
      Prints the next anonymous usage report, exactly, and sends nothing. TELEMETRY=off in the
      folder's .env turns the report off.
  agentes-server password-link <email> [--data <folder>]
      Prints a link that sets a new password for that account, once, within an hour, for
      whoever forgot theirs on a server that sends no email. Stop the server first.
  agentes-server version
  agentes-server service install|uninstall|status [--data <folder>]
      Starts it with this computer: at login on macOS, and from boot on Linux.

Exit codes: 0 stopped, 1 an error, 3 another agentes-server uses the folder, 4 the database needs
an upgrade (db dump with the previous version, then db restore with this one), 5 the port is taken.`;

/** What a data folder holds. */
export function nativeFiles(dir: string) {
  return {
    env: join(dir, ".env"),
    db: join(dir, "db"),
    files: join(dir, "files"),
    log: join(dir, "logs", "server.log"),
    ready: join(dir, "server.json"),
    backups: join(dir, "backups"),
  };
}

/** Where a restore builds the new database, and where it waits once complete, before taking `db`'s place. */
const restoreFolders = (db: string) => ({ building: `${db}.new`, complete: `${db}.restored` });

const ENV_HEADER = `# agentes.chat on this computer, with its database built in (agentes-server). The guide:
# ${INSTALL_DOCS_URL}. AGENTES_SECRET encrypts the keys stored in the database: it
# travels with the folder in a backup, and changing it makes them unreadable.
`;

/** Whether something already answers on 127.0.0.1:<port>. */
async function portTaken(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function firstFreePort(): Promise<number> {
  for (let port = NATIVE_PORTS.first; port <= NATIVE_PORTS.last; port++) if (!(await portTaken(port))) return port;
  return NATIVE_PORTS.first;
}

/**
 * The settings of the folder: its `.env` (made the first time, with a new secret and a free port),
 * under whatever the environment already sets, then what native mode is: the database and the files
 * in the folder, and only this computer's loopback.
 */
async function nativeEnv(dir: string, env: NodeJS.ProcessEnv = process.env) {
  const files = nativeFiles(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(files.env)) {
    const entries = {
      AGENTES_SECRET: randomBytes(48).toString("base64"),
      PORT: env.PORT ?? String(await firstFreePort()),
    };
    writeFileSync(files.env, upsertEnv(ENV_HEADER, entries), { mode: 0o600, flag: "wx" });
  }
  for (const [key, value] of envEntries(readFileSync(files.env, "utf8"))) env[key] ??= value;
  env.PORT ??= String(NATIVE_PORTS.first);
  env.PUBLIC_URL ??= `http://127.0.0.1:${env.PORT}`;
  env.INSTALL_MODE ??= "native";
  env.WEB_DIR ??= join(PACKAGE, "web");
  env.DATABASE_URL = pgliteUrl(files.db);
  env.FILES_DIR = files.files;
  env.HOST = "127.0.0.1";
  env.NODE_ENV = "production";
  return { port: Number(env.PORT), publicUrl: env.PUBLIC_URL };
}

/** Everything the console prints also goes to `logs/server.log`. */
function teeLogs(file: string) {
  const log = new RotatingFile(file);
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    const print = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      print(...args);
      try {
        log.append(`${format(...args)}\n`);
      } catch {
        // a full disk never stops the server
      }
    };
  }
}

function writeAtomic(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

const fail = (code: number, message: string) => {
  console.error(message);
  return code;
};

/**
 * One process per folder; released when this one exits. Then the folder as the last command left it: a
 * restore stopped between moving the old database aside and putting the new one in its place is finished.
 */
function lockFolder(dir: string): LockResult {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(dir, "server", { file: LOCK_FILE });
  if (!lock.ok) return lock;
  process.once("exit", lock.release);
  const { db } = nativeFiles(dir);
  const { complete } = restoreFolders(db);
  if (!existsSync(db) && existsSync(complete)) renameSync(complete, db);
  return lock;
}

const lockedMessage = (dir: string, pid: number) =>
  `Another agentes-server is using ${dir} (pid ${pid}). Stop it first, or use another folder (--data).`;

/**
 * `--until-stdin-ends` (the desktop app on Windows, which has no SIGTERM): the end of stdin stops the server the
 * way SIGTERM does. The app closes it to stop the server, and it closes by itself when the app ends any other
 * way, so the server never outlives it. An end before the server is up stops it once it is.
 */
function stopWhenStdinEnds(): { up: () => void } {
  let ended = false;
  let up = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (up) process.emit("SIGTERM");
  };
  process.stdin.on("end", end).on("close", end).on("error", end);
  process.stdin.resume();
  return {
    up: () => {
      up = true;
      if (ended) process.emit("SIGTERM");
    },
  };
}

/** `agentes-server [--data <dir>]`: runs until SIGTERM or SIGINT (`startServer` drains and exits). */
async function run(dir: string, untilStdinEnds = false): Promise<number> {
  const stdin = untilStdinEnds ? stopWhenStdinEnds() : null;
  const files = nativeFiles(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // From the start: a service's own output may go nowhere (launchd), and this says why it stopped.
  teeLogs(files.log);
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  const { port, publicUrl } = await nativeEnv(dir);
  if (Number.isInteger(port) && (await portTaken(port))) {
    return fail(EXIT.port, `Port ${port} is taken on this computer. Set another PORT in ${files.env}.`);
  }
  try {
    await startServer({ edition: "selfhost", ownHostsOnly: true });
  } catch (error) {
    if (error instanceof PgMajorMismatchError) return fail(EXIT.upgrade, error.message);
    if (error instanceof DatabaseInUseError) return fail(EXIT.locked, error.message);
    if ((error as { code?: string }).code === "EADDRINUSE") return fail(EXIT.port, `Port ${port} is taken.`);
    return fail(EXIT.error, `agentes.chat didn't start: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.once("exit", () => rmSync(files.ready, { force: true }));
  writeAtomic(
    files.ready,
    `${JSON.stringify({
      pid: process.pid,
      version,
      url: `http://127.0.0.1:${port}`,
      publicUrl,
      startedAt: new Date().toISOString(),
      pglite: PGLITE_VERSION,
      pgMajor: PG_MAJOR,
    })}\n`,
  );
  stdin?.up();
  // Until a signal: startServer stops the server and exits.
  return new Promise<number>(() => {});
}

async function migrate(dir: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  await nativeEnv(dir);
  const database = createDatabase({ url: process.env.DATABASE_URL ?? "", poolMax: 1 });
  try {
    await prepareDatabase(database, createLogger("warn"));
  } finally {
    await database.close();
  }
  return EXIT.ok;
}

async function dump(dir: string, out: string | undefined): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  const { db } = nativeFiles(dir);
  if (isEmptyFolder(db)) return fail(EXIT.error, `There is no database in ${dir} yet.`);
  const text = await dumpPglite(db);
  if (out) writeFileSync(resolve(out), text, { mode: 0o600 });
  else await Bun.write(Bun.stdout, text);
  return EXIT.ok;
}

/**
 * Into a folder with no database yet; or, when its database is another Postgres major's (an upgrade),
 * in its place, the old one moved to `backups/`. A database this version can open is never written over.
 * The new database is built aside and takes `db`'s place only once complete, so a restore that fails or
 * stops halfway leaves the folder as it was.
 */
async function restore(dir: string, input: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  const files = nativeFiles(dir);
  if (folderVersion(files.db)?.pgMajor === PG_MAJOR) {
    return fail(EXIT.error, `${files.db} already holds a database. Restore into a new folder (--data) instead.`);
  }
  const text = readFileSync(resolve(input), "utf8");
  const { building, complete } = restoreFolders(files.db);
  // What a restore that stopped halfway left: its own copies only.
  for (const leftover of [building, complete]) rmSync(leftover, { recursive: true, force: true });
  try {
    await restorePglite(building, text);
    renameSync(building, complete);
  } finally {
    rmSync(building, { recursive: true, force: true });
    rmSync(folderLockFile(building), { force: true });
  }
  if (!isEmptyFolder(files.db)) {
    mkdirSync(files.backups, { recursive: true, mode: 0o700 });
    const old = folderVersion(files.db);
    const aside = join(
      files.backups,
      `db-${old ? `pg${old.pgMajor}` : "unknown"}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    renameSync(files.db, aside);
    console.error(`Restored. The previous database is in ${aside}.`);
  }
  rmSync(files.db, { recursive: true, force: true });
  renameSync(complete, files.db);
  return EXIT.ok;
}

async function check(dir: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  const { db } = nativeFiles(dir);
  const found = folderVersion(db);
  if (isEmptyFolder(db) || !found) {
    console.log(JSON.stringify({ ok: false, error: `There is no database in ${dir} yet.` }));
    return EXIT.error;
  }
  if (found.pgMajor !== PG_MAJOR) {
    console.log(JSON.stringify({ ok: false, pgMajor: found.pgMajor, pglite: found.pglite }));
    return EXIT.upgrade;
  }
  const { pg, ready } = openPglite(db);
  try {
    await ready;
    await pg.query("select 1");
  } finally {
    await pg.close();
  }
  console.log(JSON.stringify({ ok: true, pgMajor: PG_MAJOR, pglite: PGLITE_VERSION }));
  return EXIT.ok;
}

/** `agentes-server telemetry`: the next usage report on stdout, as `main.ts telemetry` prints it; sends nothing. */
async function telemetry(dir: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  if (!folderVersion(nativeFiles(dir).db)) return fail(EXIT.error, `There is no database in ${dir} yet.`);
  await nativeEnv(dir);
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
  try {
    await printTelemetry(database.db, config);
  } finally {
    await database.close();
  }
  // Once stdout has drained: a piped report arrives whole.
  await new Promise((done) => process.stdout.write("", done));
  return EXIT.ok;
}

/**
 * `agentes-server password-link <email>` (ADR 0158): a new-password link for that account, printed. With the server
 * stopped: its database is the folder's, and only one process opens it.
 */
async function passwordLink(dir: string, email: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  if (!folderVersion(nativeFiles(dir).db)) return fail(EXIT.error, `There is no database in ${dir} yet.`);
  await nativeEnv(dir);
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
  try {
    const link = await passwordLinkByEmail(database.db, config.PUBLIC_URL, email);
    if (!link) return fail(EXIT.error, `No account here uses ${email}.`);
    console.log(link.url);
    console.error(`Works once, until ${link.expiresAt.toLocaleString()}.`);
  } finally {
    await database.close();
  }
  await new Promise((done) => process.stdout.write("", done));
  return EXIT.ok;
}

/** The server as a background service of the person's own account (never root). */
export function serviceDefinition(dir: string, manager: "systemd" | "launchd"): ServiceDefinition {
  return {
    unit: "agentes-server",
    label: "chat.agentes.server",
    description: "agentes.chat",
    program: [join(PACKAGE, "bin", "agentes-server")],
    args: ["--data", dir],
    env: [[SERVICE_ENV, manager]],
    // Stopped on purpose, or a database that needs its upgrade: starting again can't help. A folder or a
    // port in use can free up, so those start again.
    finalExits: [EXIT.ok, ...FINAL_EXITS],
  };
}

/** Exit codes after which a service isn't started again. */
const FINAL_EXITS: number[] = [EXIT.upgrade];
/** Set in the service's environment: which system starts it. */
const SERVICE_ENV = "AGENTES_SERVER_SERVICE";

/** launchd starts a service again after any exit but 0, so under it a final exit is 0 (its message is in the log). */
const serviceExit = (code: number) =>
  process.env[SERVICE_ENV] === "launchd" && FINAL_EXITS.includes(code) ? EXIT.ok : code;

function service(action: string | undefined, dir: string): number {
  const d = serviceDefinition(dir, process.platform === "darwin" ? "launchd" : "systemd");
  const print = (line: string) => console.log(line);
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return fail(EXIT.error, "agentes-server runs as a service on macOS and Linux.");
  }
  if (action === "status") {
    print(userServiceStatus(d) ?? "Not installed.");
    return EXIT.ok;
  }
  if (action === "uninstall") {
    print(`Removed ${removeUserService(d)}.`);
    return EXIT.ok;
  }
  if (action !== "install") return fail(EXIT.error, USAGE);
  const [launcher = ""] = d.program;
  if (!existsSync(launcher)) return fail(EXIT.error, `Install agentes.chat first: ${launcher} isn't there.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    if (!startLaunchAgent(d, { print })) return EXIT.error;
    print(`agentes.chat starts at login now. Its log: ${nativeFiles(dir).log}`);
    return EXIT.ok;
  }
  if (!systemdUserAvailable()) {
    return fail(EXIT.error, `systemd's user manager isn't running here. Start it yourself: ${launcher} --data ${dir}`);
  }
  if (!startUserUnit(d.unit, systemdUnitText(d, "default.target"), { print })) return EXIT.error;
  // Without it, systemd stops the person's services when they log out, and starts them only at their login.
  const user = os.userInfo().username;
  const linger = Bun.spawnSync(["loginctl", "enable-linger", user], { stdout: "ignore", stderr: "ignore" });
  print(`agentes.chat starts with this computer now. Its log: ${nativeFiles(dir).log}`);
  if (linger.exitCode !== 0) print(`To keep it running after you log out, run as root: loginctl enable-linger ${user}`);
  return EXIT.ok;
}

/** What the launcher and the desktop app run (`server/native.js`): the command's exit code. */
export async function main(argv: string[]): Promise<number> {
  return serviceExit(await runCommand(argv));
}

async function runCommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    return fail(EXIT.error, `${(error as Error).message}\n\n${USAGE}`);
  }
  const { command, values } = parsed;
  const dir = expandHome(values.data ?? "~/.agentes");
  try {
    switch (command.join(" ")) {
      case "":
        return await run(dir, values["until-stdin-ends"] === true);
      case "migrate":
        return await migrate(dir);
      case "db dump":
        return await dump(dir, values.out);
      case "db restore":
        return values.in ? await restore(dir, values.in) : fail(EXIT.error, "db restore needs --in <file>.");
      case "db check":
        return await check(dir);
      case "telemetry":
        return await telemetry(dir);
      case "version":
        console.log(JSON.stringify({ version, pgMajor: PG_MAJOR, pglite: PGLITE_VERSION }));
        return EXIT.ok;
      case "help":
        console.log(USAGE);
        return EXIT.ok;
      default:
        if (command[0] === "service" && command.length <= 2) return service(command[1], dir);
        if (command[0] === "password-link" && command.length === 2) return await passwordLink(dir, command[1] ?? "");
        return fail(EXIT.error, USAGE);
    }
  } catch (error) {
    if (error instanceof PgMajorMismatchError) return fail(EXIT.upgrade, error.message);
    if (error instanceof DatabaseInUseError) return fail(EXIT.locked, error.message);
    return fail(EXIT.error, error instanceof Error ? error.message : String(error));
  }
}

function parseCommand(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      out: { type: "string" },
      in: { type: "string" },
      help: { type: "boolean", short: "h" },
      "until-stdin-ends": { type: "boolean" },
    },
  });
  return { command: values.help ? ["help"] : positionals, values };
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { FOLDER_FILE, PG_MAJOR, PGLITE_VERSION } from "@agenteschat/db";
import { launchdPlistText, systemdUnitText } from "../runner/service";
import { serviceDefinition } from "../src/native";

/**
 * `agentes-server` as people run it: a real process on a folder of its own, its database built in.
 * Each start migrates the folder on PGlite, so the steps share one folder and run in order.
 */

const NATIVE = join(import.meta.dir, "../src/native.ts");
let root = "";
let data = "";
let port = 0;
let url = "";
beforeAll(() => {
  root = mkdtempSync(join(os.tmpdir(), "agentes-native-"));
  data = join(root, "data");
  port = freePort();
  url = `http://127.0.0.1:${port}`;
});
const children: Bun.Subprocess[] = [];
afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(children.map((child) => child.exited));
  rmSync(root, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const found = probe.port ?? 0;
  void probe.stop(true);
  return found;
}

function start(dir = data, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, NATIVE, "--data", dir], {
    env: { ...process.env, PORT: String(port), WEB_DIR: join(root, "no-web"), ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  children.push(child);
  return { child, stderr: () => new Response(child.stderr).text() };
}

async function healthy(base = url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(`${base}/api/health`).catch(() => null);
    if (res?.ok) return (await res.json()) as { status: string; database: string };
    await Bun.sleep(250);
  }
  throw new Error("the server didn't answer /api/health");
}

async function stop(child: ReturnType<typeof start>["child"]) {
  child.kill("SIGTERM");
  return child.exited;
}

/** The status and `Location` of a GET with this Host, over a plain socket (fetch sets its own Host). */
async function getWithHost(host: string, path = "/api/health", accept = "*/*") {
  let text = "";
  const done = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        text += Buffer.from(chunk).toString();
        if (text.includes("\r\n\r\n")) done.resolve();
      },
      close: () => done.resolve(),
    },
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: ${accept}\r\nConnection: close\r\n\r\n`);
  await done.promise;
  socket.end();
  return { status: Number(text.split(" ")[1]), location: /^location: (.*)$/im.exec(text)?.[1]?.trim() ?? null };
}

/** `agentes-server <args> --data <dir>` to its end. */
async function command(args: string[], dir = data, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, NATIVE, ...args, "--data", dir], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

let cookie = "";
const call = async (path: string, init: { json?: unknown } = {}) => {
  const headers = new Headers({ origin: url });
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${url}${path}`, {
    method: init.json === undefined ? "GET" : "POST",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (set.length > 0) cookie = set.join("; ");
  return res;
};

test("a new folder: it starts, migrates and answers only on its own loopback address", async () => {
  const server = start();
  const health = await healthy();
  expect(health).toMatchObject({ status: "ok", database: "ok" });
  // The folder it made: private, its settings generated once, and what wrote the database.
  expect(statSync(data).mode & 0o777).toBe(0o700);
  expect(statSync(join(data, ".env")).mode & 0o777).toBe(0o600);
  const env = readFileSync(join(data, ".env"), "utf8");
  expect(env).toMatch(/^AGENTES_SECRET=\S{40,}$/m);
  expect(env).toContain(`PORT=${port}`);
  expect(JSON.parse(readFileSync(join(data, "db", FOLDER_FILE), "utf8"))).toEqual({
    pglite: PGLITE_VERSION,
    pgMajor: PG_MAJOR,
  });
  expect(JSON.parse(readFileSync(join(data, "server.json"), "utf8"))).toMatchObject({
    pid: server.child.pid,
    url,
    publicUrl: url,
    pglite: PGLITE_VERSION,
    pgMajor: PG_MAJOR,
  });
  expect(readFileSync(join(data, "logs", "server.log"), "utf8")).toContain('"msg":"listening"');

  expect((await getWithHost(`127.0.0.1:${port}`)).status).toBe(200);
  expect((await getWithHost(`localhost:${port}`)).status).toBe(200);
  // A page opened at its other name goes to PUBLIC_URL, the one origin sign-in and saving accept.
  expect(await getWithHost(`localhost:${port}`, "/owner?from=typed", "text/html,*/*")).toEqual({
    status: 302,
    location: `${url}/owner?from=typed`,
  });
  expect((await getWithHost(`127.0.0.1:${port}`, "/owner", "text/html,*/*")).location).toBeNull();
  // A web page whose own name points at 127.0.0.1 (DNS rebinding) gets nothing.
  expect((await getWithHost(`attacker.example:${port}`)).status).toBe(421);
  expect((await getWithHost(`attacker.example:${port}`, "/", "text/html")).status).toBe(421);
  // Only loopback listens: this computer's other addresses refuse the connection.
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal);
  if (lan) expect(await fetch(`http://${lan.address}:${port}/api/health`).catch(() => null)).toBeNull();

  // The first account owns the installation; its workspace is in the folder's database.
  const signUp = await call("/api/auth/sign-up/email", {
    json: { name: "Ana", email: "ana@example.com", password: "correct horse battery" },
  });
  expect(signUp.status).toBe(200);
  const org = await call("/api/app/organizations", { json: { name: "Acme" } });
  expect(org.status).toBe(201);

  // One server per folder: a second one says who holds it and exits 3.
  const second = start();
  expect(await second.child.exited).toBe(3);
  expect(await second.stderr()).toContain(`pid ${server.child.pid}`);

  expect(await stop(server.child)).toBe(0);
  expect(existsSync(join(data, "server.json"))).toBe(false);
  expect(existsSync(join(data, "server.lock"))).toBe(false);
}, 120_000);

test("the data survives a restart, and a lock whose process is gone is taken over", async () => {
  // A crash leaves its lock behind: the pid of a process that has exited.
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  writeFileSync(join(data, "server.lock"), JSON.stringify({ pid: gone.pid, mode: "server", startedAt: "" }));
  expect(JSON.parse((await command(["db", "check"])).out)).toMatchObject({ ok: true });
  // A power cut leaves one whose pid another process has after the restart (here, the system's first).
  writeFileSync(
    join(data, "server.lock"),
    JSON.stringify({ pid: 1, mode: "server", startedAt: "2026-10-20T08:00:00.000Z", boot: "an-earlier-boot" }),
  );
  const server = start();
  await healthy();
  const me = await call("/api/app/me");
  expect(me.status).toBe(200);
  const body = (await me.json()) as { user: { email: string }; organizations: { name: string }[] };
  expect(body.user.email).toBe("ana@example.com");
  expect(body.organizations.map((o) => o.name)).toEqual(["Acme"]);
  expect(await stop(server.child)).toBe(0);
}, 120_000);

test("a taken port exits 5, and a database of another Postgres major exits 4", async () => {
  const other = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("not agentes.chat") });
  try {
    const taken = start();
    expect(await taken.child.exited).toBe(5);
    expect(await taken.stderr()).toContain(`Port ${port} is taken`);
  } finally {
    await other.stop(true);
  }
  const old = join(root, "old");
  mkdirSync(join(old, "db"), { recursive: true });
  writeFileSync(join(old, "db", FOLDER_FILE), JSON.stringify({ pglite: "0.3.0", pgMajor: PG_MAJOR - 1 }));
  const upgrade = start(old);
  expect(await upgrade.child.exited).toBe(4);
  expect(await upgrade.stderr()).toContain(`Postgres ${PG_MAJOR - 1}`);
  // As a launchd agent, which starts it again after anything but 0: 0, its reason in the log.
  const asAgent = start(old, { AGENTES_SERVER_SERVICE: "launchd" });
  expect(await asAgent.child.exited).toBe(0);
  expect(readFileSync(join(old, "logs", "server.log"), "utf8")).toContain(`Postgres ${PG_MAJOR - 1}`);
}, 60_000);

test("db check, dump, and an upgrade's restore, which keeps the previous database aside", async () => {
  const run = (...args: string[]) => command(args);
  expect(JSON.parse((await run("db", "check")).out)).toEqual({ ok: true, pgMajor: PG_MAJOR, pglite: PGLITE_VERSION });
  const dumpFile = join(root, "dump.sql");
  expect((await run("db", "dump", "--out", dumpFile)).code).toBe(0);
  expect(readFileSync(dumpFile, "utf8")).toContain("ana@example.com");
  // This version can open it: a restore never writes over it.
  expect((await run("db", "restore", "--in", dumpFile)).code).toBe(1);

  // The folder as an older version left it (its Postgres major stubbed): it needs the upgrade.
  writeFileSync(join(data, "db", FOLDER_FILE), JSON.stringify({ pglite: "0.3.0", pgMajor: PG_MAJOR - 1 }));
  expect((await run("db", "check")).code).toBe(4);
  expect((await run("db", "restore", "--in", dumpFile)).code).toBe(0);
  expect((await run("db", "check")).code).toBe(0);
  expect(readdirSync(join(data, "backups")).filter((name) => name.startsWith(`db-pg${PG_MAJOR - 1}-`))).toHaveLength(1);
  expect(readdirSync(data).filter((name) => name.startsWith("db."))).toEqual(["db.lock"]);
  // Stopped between moving the old database aside and putting the new one in its place: the next command
  // finishes it.
  renameSync(join(data, "db"), join(data, "db.restored"));
  expect((await run("db", "check")).code).toBe(0);
  expect(existsSync(join(data, "db.restored"))).toBe(false);

  const server = start();
  await healthy();
  const me = (await (await call("/api/app/me")).json()) as { organizations: { name: string }[] };
  expect(me.organizations.map((o) => o.name)).toEqual(["Acme"]);
  expect(await stop(server.child)).toBe(0);
}, 120_000);

test("a restore that fails leaves no database behind", async () => {
  const fresh = join(root, "fresh");
  const bad = join(root, "bad.sql");
  writeFileSync(bad, "create table t (id int);\nthis is not sql;\n");
  expect((await command(["db", "restore", "--in", bad], fresh)).code).toBe(1);
  expect(readdirSync(fresh).filter((name) => name.startsWith("db"))).toEqual([]);
  expect((await command(["db", "check"], fresh)).code).toBe(1);
}, 60_000);

test("telemetry prints the next usage report, sends nothing, and waits while the server runs", async () => {
  const report = await command(["telemetry"]);
  expect(report.code).toBe(0);
  expect(JSON.parse(report.out)).toMatchObject({
    report: 1,
    edition: "selfhost",
    install: "native",
    people: { total: 1 },
  });
  expect(report.err).toContain("TELEMETRY=off");
  const off = await command(["telemetry"], data, { TELEMETRY: "off" });
  expect(off.err).toContain("Off (TELEMETRY=off)");
  const server = start();
  await healthy();
  expect((await command(["telemetry"])).code).toBe(3);
  expect(await stop(server.child)).toBe(0);
}, 120_000);

test("as a service it isn't started again after an exit that retrying can't fix", () => {
  // systemd skips the codes; launchd starts again after anything but 0, so the server exits 0 under it.
  expect(systemdUnitText(serviceDefinition("/home/ana/.agentes", "systemd"), "default.target")).toContain(
    "RestartPreventExitStatus=0 4",
  );
  expect(launchdPlistText(serviceDefinition("/Users/ana/.agentes", "launchd"))).toContain(
    "<key>AGENTES_SERVER_SERVICE</key>\n    <string>launchd</string>",
  );
});

test("version names what it runs", async () => {
  const child = Bun.spawn([process.execPath, NATIVE, "version"], { stdout: "pipe" });
  const out = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(out).toMatchObject({ pgMajor: PG_MAJOR, pglite: PGLITE_VERSION });
});

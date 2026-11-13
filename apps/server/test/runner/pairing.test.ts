import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserNeeded } from "@agenteschat/adapters/machine-protocol";
import { findChrome } from "../../runner/browser";
import {
  type DeviceCode,
  devicePair,
  type FetchFn,
  formatUserCode,
  LINK_INVALID,
  orgSlug,
  PairingError,
  pollDeviceToken,
  redeemIssuedCode,
  requestDeviceCode,
  takeEnrollCode,
  uniqueWorkspace,
  whoCanUse,
} from "../../runner/pairing";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const SERVER = "https://agentes.test";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake server: `/device` hands out a code, `/device/token` answers from a script. */
function fakeServer(answers: Response[]) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/api/machines/device")) {
      return json(200, {
        deviceCode: "dc_secret",
        userCode: "K7Q4ZP",
        verificationUrl: `${SERVER}/conectar?code=K7Q4ZP`,
        expiresIn: 600,
        interval: 3,
      });
    }
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next;
  };
  return { fetch, calls };
}

const GRANT = { token: "agm_new", machineId: "m1", name: "Notebook", org: { id: "o1", name: "Acme" } };

test("device flow: pending, slow_down (+5 s), then the token", async () => {
  const server = fakeServer([
    json(400, { error: "authorization_pending" }),
    json(400, { error: "slow_down" }),
    json(400, { error: "authorization_pending" }),
    json(200, GRANT),
  ]);
  const sleeps: number[] = [];
  const codes: DeviceCode[] = [];
  const grant = await devicePair(
    SERVER,
    { name: "Notebook", os: "darwin", arch: "arm64", hostname: "nb", version: "0.9.0" },
    (c) => codes.push(c),
    { fetch: server.fetch, sleep: async (ms) => void sleeps.push(ms) },
  );
  expect(grant).toEqual(GRANT);
  expect(codes[0]).toMatchObject({ userCode: "K7Q4ZP", verificationUrl: `${SERVER}/conectar?code=K7Q4ZP` });
  expect(sleeps).toEqual([3000, 3000, 8000, 8000]);
  expect(server.calls[0]).toEqual({
    url: `${SERVER}/api/machines/device`,
    body: { name: "Notebook", os: "darwin", arch: "arm64", hostname: "nb", version: "0.9.0" },
  });
  expect(server.calls.slice(1).every((c) => (c.body as { deviceCode: string }).deviceCode === "dc_secret")).toBe(true);
});

test("device flow: expired and denied stop with their own code; a network blip is retried", async () => {
  const code: DeviceCode = { deviceCode: "dc", userCode: "ABC234", verificationUrl: "x", expiresIn: 600, interval: 1 };
  const sleep = async () => {};
  const expired = fakeServer([json(400, { error: "expired_token" })]);
  await expect(pollDeviceToken(SERVER, code, { fetch: expired.fetch, sleep })).rejects.toMatchObject({
    code: "expired",
  });

  const denied = fakeServer([json(400, { error: "authorization_pending" }), json(400, { error: "access_denied" })]);
  await expect(pollDeviceToken(SERVER, code, { fetch: denied.fetch, sleep })).rejects.toMatchObject({ code: "denied" });

  // The server's other error shape (`{ error: { code } }`) is understood too.
  const nested = fakeServer([json(400, { error: { code: "expired_token", message: "gone" } })]);
  await expect(pollDeviceToken(SERVER, code, { fetch: nested.fetch, sleep })).rejects.toMatchObject({
    code: "expired",
  });

  let n = 0;
  const flaky: FetchFn = async () => {
    n++;
    if (n === 1) throw new Error("ECONNRESET");
    if (n === 2) return json(503, {});
    return json(200, GRANT);
  };
  expect(await pollDeviceToken(SERVER, code, { fetch: flaky, sleep })).toEqual(GRANT);

  // The code's time runs out while the person hasn't confirmed: expired.
  let clock = 0;
  const pending: FetchFn = async () => json(400, { error: "authorization_pending" });
  await expect(
    pollDeviceToken(
      SERVER,
      { ...code, expiresIn: 5 },
      {
        fetch: pending,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    ),
  ).rejects.toMatchObject({ code: "expired" });
});

test("a canceled pairing stops at once", async () => {
  const ac = new AbortController();
  const code: DeviceCode = { deviceCode: "dc", userCode: "ABC234", verificationUrl: "x", expiresIn: 600, interval: 3 };
  const p = pollDeviceToken(SERVER, code, {
    fetch: async () => json(400, { error: "authorization_pending" }),
    signal: ac.signal,
  });
  ac.abort();
  await expect(p).rejects.toMatchObject({ code: "canceled" });
});

/** What `POST /orgs/{orgId}/machines` of the operator API hands a provisioner: 32 random bytes, base64url. */
const ISSUED = "q3v9mT0aLp8sR2wK5yN7bC1dF4gH6jZ0eU_i-oPqRsA";

test("an issued code: the token on the first poll, with nothing to show and nobody to confirm", async () => {
  const server = fakeServer([json(200, GRANT)]);
  const sleeps: number[] = [];
  const grant = await redeemIssuedCode(SERVER, ISSUED, {
    fetch: server.fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  expect(grant).toEqual(GRANT);
  expect(server.calls).toEqual([{ url: `${SERVER}/api/machines/device/token`, body: { deviceCode: ISSUED } }]);
  expect(sleeps).toEqual([2000]);
});

test("an issued code that expired, was used or was withdrawn says so, never quoting the code", async () => {
  const sleep = async () => {};
  const cases = [
    { answer: { error: "expired_token" }, code: "expired", says: "expired or was already used" },
    { answer: { error: "access_denied" }, code: "denied", says: "was withdrawn" },
  ];
  for (const c of cases) {
    const err = await redeemIssuedCode(SERVER, ISSUED, { fetch: fakeServer([json(400, c.answer)]).fetch, sleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PairingError);
    expect(err).toMatchObject({ code: c.code });
    expect((err as Error).message).toContain(c.says);
    expect((err as Error).message).not.toContain(ISSUED);
  }
});

test("the enrollment file is removed once read, also when it holds no code", () => {
  const dir = tempDir("enroll-");
  dirs.push(dir);
  const file = path.join(dir, "enroll-code");
  writeFileSync(file, `${ISSUED}\n`, { mode: 0o600 });
  expect(takeEnrollCode(file)).toBe(ISSUED);
  expect(existsSync(file)).toBe(false);

  // Another file's contents never go out as a code, nor into the message.
  writeFileSync(file, '{ "token": "agm_0123456789abcdef0123" }\n');
  expect(() => takeEnrollCode(file)).toThrow(`${file} doesn't hold an enrollment code`);
  expect(existsSync(file)).toBe(false);
  expect(() => takeEnrollCode(file)).toThrow("Couldn't read the enrollment file");
});

const RUNNER = path.join(import.meta.dir, "../../runner/main.ts");

/** `agentes-runner pair --enroll-file` as a provisioner runs it, against a server that answers `answer`. */
async function enroll(answer: () => Response) {
  const dir = tempDir("enroll-");
  dirs.push(dir);
  const file = path.join(dir, "enroll-code");
  writeFileSync(file, ISSUED, { mode: 0o600 });
  const seen: { path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      seen.push({ path: new URL(req.url).pathname, body: await req.json() });
      return answer();
    },
  });
  try {
    const home = path.join(dir, "home");
    const args = ["pair", "--server", server.url.origin, "--enroll-file", file, "--home", home];
    const proc = Bun.spawn([process.execPath, RUNNER, ...args, "--dir", path.join(dir, "work")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { file, seen, exit, stdout, stderr, output: stdout + stderr, config: path.join(home, "config.json") };
  } finally {
    server.stop(true);
  }
}

test("pair --enroll-file connects: the token in the config, the code nowhere", async () => {
  const r = await enroll(() => json(200, GRANT));
  expect(r.exit).toBe(0);
  expect(r.seen).toEqual([{ path: "/api/machines/device/token", body: { deviceCode: ISSUED } }]);
  expect(existsSync(r.file)).toBe(false);
  const text = readFileSync(r.config, "utf8");
  expect(JSON.parse(text)).toMatchObject({ token: GRANT.token, machineId: "m1", name: "Notebook", orgId: "o1" });
  expect(text).not.toContain(ISSUED);
  expect(r.output).toContain('Connected to Acme as "Notebook"');
  expect(r.output).not.toContain(ISSUED);
}, 20_000);

test("pair --enroll-file with an expired code: a clear error, the file gone, nothing written", async () => {
  const r = await enroll(() => json(400, { error: "expired_token" }));
  expect(r.exit).toBe(1);
  expect(r.output).toContain("The enrollment code expired or was already used");
  expect(r.output).not.toContain(ISSUED);
  expect(existsSync(r.file)).toBe(false);
  expect(existsSync(r.config)).toBe(false);
}, 20_000);

test("pair --enroll-file refused: why is the last line of stderr, where a provisioner reads it", async () => {
  const r = await enroll(() => json(400, { error: "access_denied" }));
  expect(r.exit).toBe(1);
  const last = r.stderr.trimEnd().split("\n").pop() ?? "";
  expect(last).toStartWith("■  The enrollment code was withdrawn");
  expect(r.stdout).toBe("agentes.chat connect this computer\n◒  Connecting with the code issued for this computer\n");
}, 20_000);

test("pair --link: who may use the computer, its page, and the warning when other people's agents share this user", async () => {
  const dir = tempDir("pair-link-");
  dirs.push(dir);
  const url = "https://app.example.com/org/o1/settings/devices/m1";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname.endsWith("/device")
        ? json(200, {
            deviceCode: "dc",
            userCode: "K7Q4ZP",
            verificationUrl: "https://x.test/c",
            expiresIn: 600,
            interval: 1,
            maker: { name: "Sam Rivera" },
            org: { name: "Acme" },
          })
        : json(200, { ...GRANT, name: "Windows build PC", audience: "everyone", owner: "Sam Rivera", url }),
  });
  try {
    const args = ["pair", "--server", server.url.origin, "--link", "R4TW-8HNC", "--home", path.join(dir, "home")];
    const proc = Bun.spawn([process.execPath, RUNNER, ...args, "--dir", path.join(dir, "work")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exit).toBe(0);
    const user = os.userInfo().username;
    expect(out).toContain("◒  Waiting for Sam Rivera to let this computer join Acme…\n");
    expect(out).toContain(
      `●  Everyone in the workspace can use Windows build PC. Change it on its page:\n     ${url}\n▲  Other people's agents will run as ${user} and can read ${user}'s files.\n`,
    );
  } finally {
    server.stop(true);
  }
}, 20_000);

test("the code is shown as K7Q·4ZP; workspaces are named after the organization", () => {
  expect(formatUserCode("K7Q4ZP")).toBe("K7Q·4ZP");
  expect(formatUserCode("k7q-4zp")).toBe("K7Q·4ZP");
  expect(orgSlug("Ação & Cia.")).toBe("acao-cia");
  expect(orgSlug("!!!")).toBe("org");

  const base = tempDir("agentes-");
  dirs.push(base);
  expect(uniqueWorkspace(base, "Acme")).toBe(path.join(base, "acme"));
  mkdirSync(path.join(base, "acme"));
  // An empty folder of that name is fine; one with something in it is taken.
  expect(uniqueWorkspace(base, "Acme")).toBe(path.join(base, "acme"));
  writeFileSync(path.join(base, "acme", "notes.txt"), "mine");
  expect(uniqueWorkspace(base, "Acme")).toBe(path.join(base, "acme-2"));
});

test("Ctrl-C while it waits for the confirmation: Canceled, and 130 for the installer that started it", async () => {
  const dir = tempDir("pair-");
  dirs.push(dir);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname.endsWith("/device")
        ? json(200, {
            deviceCode: "dc",
            userCode: "K7Q4ZP",
            verificationUrl: "https://x.test/c",
            expiresIn: 600,
            interval: 1,
          })
        : json(400, { error: "authorization_pending" }),
  });
  try {
    const proc = Bun.spawn(
      [process.execPath, RUNNER, "pair", "--server", server.url.origin, "--home", path.join(dir, "home")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes("Waiting for the confirmation")) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
    }
    expect(output).toContain(
      "●  To connect this computer, open this link and confirm the code K7Q·4ZP:\n     https://x.test/c\n",
    );
    proc.kill("SIGINT");
    for (let next = await reader.read(); !next.done; next = await reader.read()) output += decoder.decode(next.value);
    expect(await proc.exited).toBe(130);
    expect(output).toContain("◒  Waiting for the confirmation\n■  Canceled\n");
  } finally {
    server.stop(true);
  }
}, 20_000);

test("status, never connected: each state with its mark, and where the config lives", () => {
  const home = tempDir("status-");
  dirs.push(home);
  const run = Bun.spawnSync([process.execPath, RUNNER, "status", "--home", home], {
    env: { ...process.env, HOME: home },
  });
  const out = run.stdout.toString();
  expect(run.exitCode).toBe(0);
  expect(out).toStartWith("agentes.chat agentes-runner ");
  expect(out).toContain("\n■  Not connected.\n▲  Running: no\n▲  Service: not installed\n");
  expect(out).toContain(`\n   Config: ${path.join(home, "config.json")}\n`);
  expect(out).not.toContain("\x1b");
});

test("service install's refusals keep their words as ■: a frame of its own by hand, none inside the installer's", () => {
  const home = tempDir("service-");
  dirs.push(home);
  const install = (env: Record<string, string> = {}) =>
    Bun.spawnSync([process.execPath, RUNNER, "service", "install", "--host", "--home", home], {
      env: { ...process.env, HOME: home, ...env },
    });
  const usage =
    "Usage: agentes-runner service install --host --server <url> --token-file <path> [--state <dir>] [--no-exec] [--no-start]";
  const byHand = install();
  expect(byHand.exitCode).toBe(1);
  // Without a terminal nothing follows the failure: it's the line a log ends on.
  expect(byHand.stdout.toString()).toBe(`agentes.chat service install\n■  ${usage}\n`);
  const framed = install({ AGENTES_FRAME: "1" });
  expect(framed.exitCode).toBe(1);
  expect(framed.stdout.toString()).toBe(`■  ${usage}\n`);
});

test("desktop-check without an agent says how to run it in its frame", () => {
  const home = tempDir("check-");
  dirs.push(home);
  const run = Bun.spawnSync([process.execPath, RUNNER, "desktop-check", "--home", home], {
    env: { ...process.env, HOME: home },
  });
  expect(run.exitCode).toBe(1);
  expect(run.stdout.toString()).toBe("agentes.chat desktop-check\n");
  expect(run.stderr.toString()).toBe("■  Usage: agentes-runner desktop-check --agent <handle>\n");
});

test("update: the new runner is a step done, and a service that won't start is the failure", async () => {
  const dir = tempDir("update-");
  dirs.push(dir);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("#!/usr/bin/env node\n// agentes-runner, a newer one\n"),
  });
  try {
    const home = path.join(dir, "home");
    mkdirSync(home);
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ server: server.url.origin, machineId: "m1", token: "agm_x", workspace: dir, name: "Notebook" }),
    );
    // Its service is installed, and the service manager fails to load it again.
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "systemctl"),
      '#!/bin/sh\ncase "$*" in *show-environment*) exit 0 ;; *is-active*) echo active ;; *) echo "Failed to connect to bus" >&2; exit 1 ;; esac\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(bin, "launchctl"), '#!/bin/sh\necho "Load failed: 5: Input/output error" >&2\nexit 5\n', {
      mode: 0o755,
    });
    const unit =
      process.platform === "darwin"
        ? path.join(dir, "Library/LaunchAgents/chat.agentes.runner.plist")
        : path.join(dir, ".config/systemd/user/agentes-runner.service");
    mkdirSync(path.dirname(unit), { recursive: true });
    writeFileSync(unit, "");
    // The runner as a script of its own, the file update replaces.
    const script = path.join(dir, "agentes-runner.mjs");
    writeFileSync(script, `import ${JSON.stringify(RUNNER)};\n`);
    const proc = Bun.spawn([process.execPath, script, "update", "--home", home], {
      env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exit).toBe(1);
    expect(readFileSync(script, "utf8")).toContain("a newer one");
    const lines = stdout.trimEnd().split("\n");
    expect(lines.slice(0, 2)).toEqual(["agentes.chat update", `◇  Updated ${script}.`]);
    expect(lines[2]).toMatch(/^■ {2}(systemctl --user daemon-reload failed|launchctl couldn't load)/);
    // The new runner drives the computer's own Google Chrome (Chromium on Linux on ARM): one without it is told
    // where to get it.
    if (findChrome(dir)) expect(stdout).not.toContain(browserNeeded());
    else expect(`${stdout}${await new Response(proc.stderr).text()}`).toContain(browserNeeded());
  } finally {
    server.stop(true);
  }
}, 30_000);

test("a connect link: sent with the device, its maker and workspace read back; a used or expired one in words", async () => {
  const calls: unknown[] = [];
  const answer =
    (res: Response): FetchFn =>
    async (_url, init) => {
      calls.push(JSON.parse(String(init.body)));
      return res;
    };
  const code = await requestDeviceCode(
    SERVER,
    { os: "linux", arch: "x64", hostname: "build-box", version: "1", link: "7KQ2-M9XD" },
    {
      fetch: answer(
        json(200, {
          deviceCode: "dc_secret",
          userCode: "K7Q4ZP",
          verificationUrl: `${SERVER}/conectar?code=K7Q4ZP`,
          expiresIn: 600,
          interval: 3,
          maker: { name: "Sam Rivera" },
          org: { id: "o1", name: "Acme" },
        }),
      ),
    },
  );
  expect(calls[0]).toMatchObject({ hostname: "build-box", link: "7KQ2-M9XD" });
  expect(code).toMatchObject({ maker: "Sam Rivera", orgName: "Acme", deviceCode: "dc_secret" });

  const refused = await requestDeviceCode(
    SERVER,
    { os: "linux", arch: "x64", hostname: "build-box", version: "1", link: "OLD1-CODE" },
    { fetch: answer(json(400, { error: { code: "machine.link_invalid", message: "This link was used already." } })) },
  ).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(PairingError);
  expect(refused).toMatchObject({ code: "link_invalid", message: "This link was used already." });
  const bare = await requestDeviceCode(
    SERVER,
    { os: "linux", arch: "x64", hostname: "build-box", version: "1", link: "OLD1-CODE" },
    { fetch: answer(json(400, { error: "machine.link_invalid" })) },
  ).catch((e: unknown) => e);
  expect(bare).toMatchObject({ code: "link_invalid", message: LINK_INVALID });
});

test("the grant says who may use the computer and where to change it; the connection says it in a sentence", async () => {
  const url = `${SERVER}/org/o1/settings/devices/m1`;
  const answer = { ...GRANT, audience: "everyone", owner: "Sam Rivera", url };
  const code: DeviceCode = { deviceCode: "dc", userCode: "K7Q4ZP", verificationUrl: "", expiresIn: 600, interval: 1 };
  const sleep = async () => {};
  const grant = await pollDeviceToken(SERVER, code, { fetch: async () => json(200, answer), sleep });
  expect(grant).toEqual({ ...GRANT, audience: "everyone", owner: "Sam Rivera", url });
  expect(whoCanUse(grant, "build-box")).toBe("Everyone in the workspace can use build-box.");
  expect(whoCanUse({ ...grant, audience: "owner" }, "Notebook")).toBe("Only Sam Rivera can use Notebook.");
  expect(whoCanUse({ ...grant, audience: "people" }, "Notebook")).toBe(
    "Only the people and roles chosen can use Notebook.",
  );
  // An older server says none of it; anything odd is left out.
  const odd = { ...GRANT, audience: "anyone", owner: 7, url: "javascript:alert(1)" };
  const older = await pollDeviceToken(SERVER, code, { fetch: async () => json(200, odd), sleep });
  expect(older).toEqual(GRANT);
  expect(whoCanUse(older, "Notebook")).toBeNull();
});

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { type SecretTarget, sealSecret, secretAad } from "@agenteschat/adapters/secret-box";
import { readZip } from "@agenteschat/engine";
import { describeRequest, handleRequest, type RequestScope } from "../../runner/handlers";
import { handleSecret } from "../../runner/secrets";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const scope = (): RequestScope => ({ signal: new AbortController().signal, output: () => {} });
const dev = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
const ops = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };
const ORG = "org-1";
const VALUE = "ghp_s3cretValue1234567890";

function setup() {
  const ws = tempDir();
  const home = tempDir("runner-home-");
  dirs.push(ws, home);
  const ctx = { workspaceReal: ws, exec: true, token: "agm_x", secretsDir: path.join(home, "secrets") };
  const call = (req: MachineRequest) => handleRequest(ctx, req, scope());
  let deliveryNumber = 0;
  /** keypair on the machine → sealed like the browser does → deliver. */
  const give = async (agent: typeof dev, requestId: string, name: string, target: SecretTarget, value = VALUE) => {
    const { publicKey } = (await call({ agent, op: "secret", action: "keypair", requestId })) as { publicKey: string };
    const aad = secretAad({ requestId, orgId: ORG, name, target });
    const box = await sealSecret(publicKey, value, aad);
    const order = `${new Date(++deliveryNumber).toISOString()}|${requestId}`;
    return {
      aad,
      box,
      order,
      deliver: () => call({ agent, op: "secret", action: "deliver", requestId, name, target, aad, box }),
      activate: () => call({ agent, op: "secret", action: "activate", requestId, order }),
      commit: async () => {
        await call({ agent, op: "secret", action: "deliver", requestId, name, target, aad, box });
        await call({ agent, op: "secret", action: "activate", requestId, order });
      },
    };
  };
  return { ws, home, ctx, call, give };
}

const exec = (command: string) => ({ op: "exec" as const, command, timeoutSeconds: 10, stream: false });

test("an env secret reaches the agent's commands, never their output; other agents don't get it", async () => {
  const { call, give, home } = setup();
  const sent = await give(dev, "req-0001-aaaa", "AGENTES_DEMO_TOKEN", { kind: "env" });
  expect(await sent.deliver()).toEqual({ size: VALUE.length });
  expect(existsSync(path.join(home, "secrets", "01a142cb", "store.json"))).toBe(false);
  const stagedBox = readFileSync(path.join(home, "secrets", "01a142cb", "staged", "req-0001-aaaa"), "utf8");
  expect(stagedBox).not.toContain(VALUE);
  const staged = (await call({ agent: dev, ...exec('echo "[$AGENTES_DEMO_TOKEN]"') })) as { stdout: string };
  expect(staged.stdout.trim()).toBe("[]");
  expect(await sent.activate()).toEqual({ size: VALUE.length });

  const used = (await call({
    agent: dev,
    ...exec(`test "$AGENTES_DEMO_TOKEN" = "${VALUE}" && echo matches`),
  })) as {
    stdout: string;
  };
  expect(used.stdout.trim()).toBe("matches");
  const printed = (await call({
    agent: dev,
    ...exec('echo "token=$AGENTES_DEMO_TOKEN"; echo "$AGENTES_DEMO_TOKEN" >&2'),
  })) as {
    stdout: string;
    stderr: string;
  };
  expect(printed.stdout.trim()).toBe("token=[secret:AGENTES_DEMO_TOKEN]");
  expect(printed.stderr.trim()).toBe("[secret:AGENTES_DEMO_TOKEN]");

  const other = (await call({ agent: ops, ...exec('echo "[$AGENTES_DEMO_TOKEN]"') })) as { stdout: string };
  expect(other.stdout.trim()).toBe("[]");

  // Stored outside the workspace, private to the user; the key is gone once used.
  const store = path.join(home, "secrets", "01a142cb", "store.json");
  expect(statSync(store).mode & 0o777).toBe(0o600);
  expect(statSync(path.dirname(store)).mode & 0o777).toBe(0o700);
  expect(existsSync(path.join(home, "secrets", "01a142cb", "keys", "req-0001-aaaa"))).toBe(false);
  expect(await errorCode(() => sent.deliver())).toBe("not_found");
});

test("a file a command wrote the value into is read back redacted; other files come back as they are", async () => {
  const { call, give } = setup();
  await (await give(dev, "req-0002-dump", "AGENTES_DEMO_TOKEN", { kind: "env" })).commit();
  await call({
    agent: dev,
    ...exec('printf "token=%s\\n" "$AGENTES_DEMO_TOKEN" > dump.txt; printf "plain" > plain.txt'),
  });
  const read = async (p: string) => {
    const out = (await call({ agent: dev, op: "read", path: p, maxBytes: 1024 })) as { base64: string; size: number };
    return Buffer.from(out.base64, "base64").toString("utf8");
  };
  expect(await read("dump.txt")).toBe("token=[secret:AGENTES_DEMO_TOKEN]\n");
  expect(await read("plain.txt")).toBe("plain");
});

test("a file secret is written 600 in the agent's folder and can't be read or uploaded from there", async () => {
  const { ws, call, give } = setup();
  const sent = await give(
    dev,
    "req-0002-bbbb",
    "NPM_TOKEN",
    { kind: "file", path: ".npmrc" },
    "//registry/:_authToken=abc12345",
  );
  await sent.commit();
  const file = path.join(ws, "dev-01a142cb", ".npmrc");
  expect(readFileSync(file, "utf8")).toBe("//registry/:_authToken=abc12345");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await errorCode(() => call({ agent: dev, op: "read", path: ".npmrc", maxBytes: 1000 }))).toBe("bad_request");
  expect(
    await errorCode(() =>
      call({ agent: dev, op: "push", path: ".npmrc", url: "https://x/u", uploadId: "u1", maxBytes: 1000 }),
    ),
  ).toBe("bad_request");
  const cat = (await call({ agent: dev, ...exec("cat .npmrc") })) as { stdout: string };
  expect(cat.stdout).toBe("[secret:NPM_TOKEN]");

  // Removed: the file goes too.
  await call({ agent: dev, op: "secret", action: "remove", name: "NPM_TOKEN" });
  expect(existsSync(file)).toBe(false);
});

test("the agent browser's profile (its logins) never leaves through the file tools; the rest of its folder does", async () => {
  const { ws, ctx } = setup();
  const uploads: Uint8Array[] = [];
  const call = (req: MachineRequest) =>
    handleRequest(
      {
        ...ctx,
        fetch: async (_url, init) => {
          uploads.push(init.body as Uint8Array);
          return new Response(null, { status: 204 });
        },
      },
      req,
      scope(),
    );
  const folder = path.join(ws, "dev-01a142cb");
  mkdirSync(path.join(folder, ".agentes", "browser", "Default"), { recursive: true });
  writeFileSync(path.join(folder, ".agentes", "browser", "Default", "Cookies"), "sid=a-working-login");
  writeFileSync(path.join(folder, ".agentes", "notes.md"), "next: auth");
  symlinkSync(path.join(folder, ".agentes", "browser"), path.join(folder, "profile-link"));
  const read = (p: string) => call({ agent: dev, op: "read", path: p, maxBytes: 1000 });
  const push = (p: string) =>
    call({ agent: dev, op: "push", path: p, url: "https://x/u", uploadId: "u1", maxBytes: 1e6 });
  for (const p of [
    ".agentes/browser/Default/Cookies",
    "./.agentes/browser/Default/Cookies",
    ".agentes/browser",
    "profile-link/Default/Cookies",
  ]) {
    expect([p, await errorCode(() => read(p))]).toEqual([p, "bad_request"]);
    expect([p, await errorCode(() => push(p))]).toEqual([p, "bad_request"]);
  }
  expect(uploads).toHaveLength(0);
  // A folder that holds it goes as a zip without it.
  for (const p of [".agentes", "."]) {
    await push(p);
    const names = readZip(uploads.at(-1) as Uint8Array, { maxFiles: 100, maxBytes: 1e6 }).map((e) => e.path);
    expect([p, names.some((n) => n.endsWith(".agentes/notes.md"))]).toEqual([p, true]);
    expect([p, names.filter((n) => n.includes("browser"))]).toEqual([p, []]);
  }
  expect(await read(".agentes/notes.md")).toMatchObject({ base64: Buffer.from("next: auth").toString("base64") });
});

test("replacing a file secret removes its old path before it becomes untracked", async () => {
  const { ws, call, give } = setup();
  const first = await give(dev, "req-0020-aaaa", "NPM_TOKEN", { kind: "file", path: ".npmrc" }, "old-secret-value");
  await first.commit();
  const oldFile = path.join(ws, "dev-01a142cb", ".npmrc");
  expect(existsSync(oldFile)).toBe(true);

  const second = await give(
    dev,
    "req-0021-bbbb",
    "NPM_TOKEN",
    { kind: "file", path: "config/token" },
    "new-secret-value",
  );
  await second.commit();
  const newFile = path.join(ws, "dev-01a142cb", "config/token");
  const staleRead = (await call({ agent: dev, op: "read", path: ".npmrc", maxBytes: 1000 })) as {
    base64: string | null;
  };
  expect(staleRead.base64 === null).toBe(true);
  expect(existsSync(oldFile)).toBe(false);
  expect(readFileSync(newFile, "utf8")).toBe("new-secret-value");
  expect(await errorCode(() => call({ agent: dev, op: "read", path: "config/token", maxBytes: 1000 }))).toBe(
    "bad_request",
  );

  await call({ agent: dev, op: "secret", action: "remove", name: "NPM_TOKEN" });
  expect(existsSync(newFile)).toBe(false);
});

test("moving a file secret to the environment removes its old plaintext file", async () => {
  const { ws, call, give } = setup();
  await (
    await give(dev, "req-0022-cccc", "API_KEY", { kind: "file", path: "private/key" }, "old-secret-value")
  ).commit();
  const oldFile = path.join(ws, "dev-01a142cb", "private/key");
  expect(existsSync(oldFile)).toBe(true);

  await (await give(dev, "req-0023-dddd", "API_KEY", { kind: "env" }, "new-secret-value")).commit();
  expect(existsSync(oldFile)).toBe(false);
  await call({ agent: dev, op: "secret", action: "remove", name: "API_KEY" });
});

test("a box for another request, secret or target doesn't open; nothing is stored", async () => {
  const { call, give, home } = setup();
  const sent = await give(dev, "req-0003-cccc", "API_KEY", { kind: "env" });
  const base = { agent: dev, op: "secret" as const, action: "deliver" as const, requestId: "req-0003-cccc" };
  // The server says another name than the box was sealed for.
  expect(
    await errorCode(() => call({ ...base, name: "OTHER", target: { kind: "env" }, aad: sent.aad, box: sent.box })),
  ).toBe("bad_request");
  // Same request, but the AAD was changed on the way: the cipher refuses it.
  const forged = sent.aad.replace(ORG, "org-2");
  expect(
    await errorCode(() => call({ ...base, name: "API_KEY", target: { kind: "env" }, aad: forged, box: sent.box })),
  ).toBe("bad_request");
  expect(existsSync(path.join(home, "secrets", "01a142cb", "store.json"))).toBe(false);
  // Discarded: the key is gone, the box can't be used any more.
  await call({ agent: dev, op: "secret", action: "discard", requestId: "req-0003-cccc" });
  expect(await errorCode(() => sent.deliver())).toBe("not_found");
});

test("discarding a staged file secret leaves no plaintext file or live store", async () => {
  const { ws, home, call, give } = setup();
  const sent = await give(dev, "req-0024-eeee", "NPM_TOKEN", { kind: "file", path: ".npmrc" });
  await sent.deliver();
  const file = path.join(ws, "dev-01a142cb", ".npmrc");
  expect(existsSync(file)).toBe(false);
  expect(existsSync(path.join(home, "secrets", "01a142cb", "store.json"))).toBe(false);
  await call({ agent: dev, op: "secret", action: "discard", requestId: "req-0024-eeee" });
  expect(await errorCode(() => sent.activate())).toBe("not_found");
  expect(existsSync(file)).toBe(false);
});

test("retrying an identical stage reply is idempotent", async () => {
  const { give } = setup();
  const sent = await give(dev, "req-0025-ffff", "NPM_TOKEN", { kind: "env" });
  expect(await sent.deliver()).toEqual({ size: VALUE.length });
  expect(await sent.deliver()).toEqual({ size: VALUE.length });
  expect(await sent.activate()).toEqual({ size: VALUE.length });
  expect(await sent.activate()).toEqual({ size: VALUE.length });
});

test("a removed newer secret keeps an older delayed activation superseded", async () => {
  const { home, call, give } = setup();
  const older = await give(dev, "req-0026-aaaa", "NPM_TOKEN", { kind: "env" }, "old-value");
  await older.deliver();
  const newer = await give(dev, "req-0027-bbbb", "NPM_TOKEN", { kind: "env" }, "new-value");
  await newer.commit();
  await call({ agent: dev, op: "secret", action: "remove", name: "NPM_TOKEN", requestIds: ["req-0027-bbbb"] });
  expect(await older.activate()).toEqual({ superseded: true });
  expect(existsSync(path.join(home, "secrets", "01a142cb", "staged", "req-0026-aaaa"))).toBe(false);
  expect(existsSync(path.join(home, "secrets", "01a142cb", "keys", "req-0026-aaaa"))).toBe(false);
  expect(await older.activate()).toEqual({ superseded: true });
  const env = (await call({ agent: dev, ...exec('echo "[$NPM_TOKEN]"') })) as { stdout: string };
  expect(env.stdout.trim()).toBe("[]");
});

test("a delayed broker install cannot restore a secret after its request was removed", async () => {
  const { ws, home, call, give } = setup();
  const requestId = "req-0041-aaaa";
  const name = "API_KEY";
  const sent = await give(dev, requestId, name, { kind: "env" }, "removed-value");
  await sent.commit();
  await call({ agent: dev, op: "secret", action: "remove", name, throughOrder: sent.order });
  const result = await handleSecret(path.join(home, "secrets"), dev, ws, {
    action: "install",
    requestId,
    name,
    target: { kind: "env" },
    value: "removed-value",
    order: sent.order,
  });
  expect(result).toEqual({ superseded: true });
  expect(((await call({ agent: dev, ...exec('echo "[$API_KEY]"') })) as { stdout: string }).stdout.trim()).toBe("[]");
});

test("removal of an old request leaves a newer value in place", async () => {
  const { call, give } = setup();
  const older = await give(dev, "req-0028-aaaa", "NPM_TOKEN", { kind: "env" }, "old-value");
  await older.commit();
  const newer = await give(dev, "req-0029-bbbb", "NPM_TOKEN", { kind: "env" }, "new-value");
  await newer.commit();
  await call({
    agent: dev,
    op: "secret",
    action: "remove",
    name: "NPM_TOKEN",
    requestIds: ["req-0028-aaaa"],
    throughOrder: older.order,
  });
  const env = (await call({ agent: dev, ...exec('echo "$NPM_TOKEN"') })) as { stdout: string };
  expect(env.stdout.trim()).toBe("[secret:NPM_TOKEN]");
  expect(await newer.activate()).toEqual({ size: "new-value".length });
});

test("removing a newer delivery clears retained older file guards through its generation", async () => {
  const { ws, home, call, give } = setup();
  const older = await give(dev, "req-0030-aaaa", "NPM_TOKEN", { kind: "file", path: ".npmrc" }, "old-value");
  await older.commit();
  const storePath = path.join(home, "secrets", "01a142cb", "store.json");
  const oldEntry = (JSON.parse(readFileSync(storePath, "utf8")) as { secrets: unknown[] }).secrets[0];
  const newer = await give(dev, "req-0031-bbbb", "NPM_TOKEN", { kind: "env" }, "new-value");
  await newer.commit();
  const current = JSON.parse(readFileSync(storePath, "utf8")) as { secrets: unknown[] };
  writeFileSync(storePath, JSON.stringify({ secrets: [oldEntry, ...current.secrets] }));
  const oldPath = path.join(ws, "dev-01a142cb", ".npmrc");
  writeFileSync(oldPath, "old-value");
  await call({
    agent: dev,
    op: "secret",
    action: "remove",
    name: "NPM_TOKEN",
    requestIds: ["req-0031-bbbb"],
    throughOrder: newer.order,
  });
  const store = JSON.parse(readFileSync(storePath, "utf8")) as { secrets: unknown[] };
  expect(store.secrets).toEqual([]);
  expect(existsSync(oldPath)).toBe(false);
});

test("names that steer an AI CLI's sign-in or requests are never kept nor put in the env", async () => {
  const { call, give } = setup();
  const names = ["ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "NODE_OPTIONS", "OPENCODE_API_KEY"];
  for (const [i, name] of names.entries()) {
    const sent = await give(dev, `req-001${i}-rrrr`, name, { kind: "env" });
    expect(await errorCode(() => sent.deliver())).toBe("bad_request");
  }
  const ok = await give(dev, "req-0019-rrrr", "GITHUB_TOKEN", { kind: "env" });
  expect(await ok.deliver()).toEqual({ size: VALUE.length });
  await ok.activate();
  const env = (await call({ agent: dev, ...exec('test -n "$GITHUB_TOKEN" && echo "[$HTTPS_PROXY]"') })) as {
    stdout: string;
  };
  expect(env.stdout.trim()).toBe("[]");
});

test("the log line names the action, never the value", () => {
  const line = describeRequest({
    agent: dev,
    op: "secret",
    action: "deliver",
    requestId: "req-0004-dddd",
    name: "AGENTES_DEMO_TOKEN",
    target: { kind: "env" },
    aad: "x",
    box: { v: 1, epk: "e", iv: "i", ct: "c" },
  });
  expect(line).toBe("[dev] secret deliver AGENTES_DEMO_TOKEN");
});

test("live output never shows a value split between two chunks", async () => {
  const { ctx, give } = setup();
  await (await give(dev, "req-0005-eeee", "AGENTES_DEMO_TOKEN", { kind: "env" })).commit();
  const live: string[] = [];
  const half = VALUE.length / 2;
  const reply = (await handleRequest(
    ctx,
    {
      agent: dev,
      op: "exec",
      command: `printf 'a=${VALUE.slice(0, half)}'; sleep 0.6; printf '${VALUE.slice(half)}\\n'`,
      timeoutSeconds: 10,
      stream: true,
    },
    { signal: new AbortController().signal, output: (_s, chunk) => live.push(chunk) },
  )) as { stdout: string };
  expect(live.length).toBeGreaterThan(0);
  expect(live.join("")).toBe("a=[secret:AGENTES_DEMO_TOKEN]\n");
  expect(live.join("")).not.toContain(VALUE.slice(0, half));
  expect(reply.stdout).toBe("a=[secret:AGENTES_DEMO_TOKEN]\n");
});

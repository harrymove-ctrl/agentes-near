import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineRequest, RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import { sealSecret, secretAad } from "@agenteschat/adapters/secret-box";
import { readZip } from "@agenteschat/engine";
import { RunnerError } from "../../runner/errors";
import { type HandlerContext, handleRequest, OP_ROUTES, type RequestScope } from "../../runner/handlers";
import { agentFolderName, resolveForAgent } from "../../runner/paths";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev", name: "Dev" };
const scope = (): RequestScope => ({ signal: new AbortController().signal, output: () => {} });

/** A worker on a computer where agents have users: the workspace it was given is the agent's home. */
function worker(tools: Partial<RunnerAccess["tools"]> = {}, folders: RunnerAccess["folders"] = []) {
  const home = tempDir("home-");
  const secrets = tempDir("secrets-");
  dirs.push(home, secrets);
  const folder = path.join(home, agentFolderName(AGENT).name);
  mkdirSync(path.join(folder, "clips"), { recursive: true });
  writeFileSync(path.join(folder, "clips", "take.mp4"), "video");
  writeFileSync(path.join(folder, ".hidden-note"), "mine");
  const access: RunnerAccess = { folders, tools: { claude: false, codex: false, commands: true, ...tools } };
  const ctx: HandlerContext = {
    workspaceReal: home,
    ownHome: home,
    exec: true,
    token: "agm_x",
    access: () => access,
    secretsDir: path.join(secrets, "secrets"),
  };
  const uploads: { name: string; body: Uint8Array }[] = [];
  ctx.fetch = async (_url, init) => {
    uploads.push({
      name: decodeURIComponent(new Headers(init.headers as Record<string, string>).get("x-agentes-file-name") ?? ""),
      body: init.body as unknown as Uint8Array,
    });
    return new Response("{}", { status: 200 });
  };
  return { home, folder, ctx, uploads };
}

const read = (p: string): MachineRequest => ({ op: "read", path: p, maxBytes: 1000, agent: AGENT });
const list = (p: string, depth = 3): MachineRequest => ({ op: "list", path: p, depth, agent: AGENT });
const push = (p: string): MachineRequest => ({
  op: "push",
  path: p,
  url: "https://x/u",
  uploadId: "u1",
  maxBytes: 1_000_000,
  agent: AGENT,
});
const write = (p: string): MachineRequest => ({
  op: "write",
  path: p,
  base64: Buffer.from("new").toString("base64"),
  agent: AGENT,
});

const text = (out: unknown) => Buffer.from((out as { base64: string }).base64, "base64").toString();
const entries = (out: unknown) => (out as { entries: { path: string }[] }).entries.map((e) => e.path);
const refusal = async (ctx: HandlerContext, req: MachineRequest) => {
  try {
    await handleRequest(ctx, req, scope());
  } catch (err) {
    if (err instanceof RunnerError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected a refusal");
};

test("a path written in full inside the agent's folder works like the relative one, for every file op", async () => {
  const { folder, ctx, uploads } = worker();
  const full = path.join(folder, "clips", "take.mp4");
  expect(await handleRequest(ctx, read(full), scope())).toEqual(
    await handleRequest(ctx, read("clips/take.mp4"), scope()),
  );
  expect(await handleRequest(ctx, list(folder), scope())).toEqual(await handleRequest(ctx, list(""), scope()));
  expect(await handleRequest(ctx, write(path.join(folder, "out", "a.txt")), scope())).toEqual({ size: 3 });
  expect(text(await handleRequest(ctx, read("out/a.txt"), scope()))).toBe("new");
  await handleRequest(ctx, push(full), scope());
  expect(uploads[0]?.name).toBe("take.mp4");
  expect(await errorCode(() => handleRequest(ctx, write(folder), scope()))).toBe("bad_request");
});

test("however it is spelled: dots, a trailing slash, ~, and a link on the way there", async () => {
  const { home, folder, ctx } = worker();
  const name = path.basename(folder);
  const link = path.join(tempDir("via-"), "home");
  dirs.push(path.dirname(link));
  symlinkSync(home, link);
  for (const spelled of [
    `${folder}/./clips/take.mp4`,
    `${folder}/clips/../clips/take.mp4`,
    `~/${name}/clips/take.mp4`,
    path.join(link, name, "clips", "take.mp4"),
    `  ${folder}/clips/take.mp4 `,
  ]) {
    expect(text(await handleRequest(ctx, read(spelled), scope()))).toBe("video");
  }
  expect(entries(await handleRequest(ctx, list(`${folder}/clips/`), scope()))).toEqual(["clips/take.mp4"]);
});

test("a path that isn't where it was written, but is in the folder: said in one line, and never used instead", async () => {
  const { home, folder, ctx, uploads } = worker();
  const dropped = path.join(home, "clips", "take.mp4");
  const said = `${dropped} doesn't exist. Your folder has clips/take.mp4: use that path.`;
  expect(await refusal(ctx, read(dropped))).toEqual({ code: "not_found", message: said });
  expect(await refusal(ctx, list(dropped))).toEqual({ code: "not_found", message: said });
  expect(await refusal(ctx, push(dropped))).toEqual({ code: "not_found", message: said });
  expect(uploads).toEqual([]);
  // Nothing of the kind for what isn't there either.
  const nowhere = path.join(home, "clips", "other.mp4");
  expect(await handleRequest(ctx, read(nowhere), scope())).toEqual({ base64: null, size: 0 });
  expect(await handleRequest(ctx, read(path.join(folder, "nope.txt")), scope())).toEqual({ base64: null, size: 0 });
  // Refused, it says so too: where commands are off, and for a path from the root.
  const off = worker({ commands: false });
  const refused = await refusal(off.ctx, read(path.join(off.home, "clips", "take.mp4")));
  expect(refused.message).toContain("Your folder has clips/take.mp4: use that path.");
  const root = await refusal(ctx, read("/clips/take.mp4"));
  expect(root.message).toContain("Your folder has clips/take.mp4: use that path.");
});

test("the agent's home reads, lists and goes to the Drive with no grant; what is hidden there stays closed", async () => {
  const { home, folder, ctx, uploads } = worker();
  writeFileSync(path.join(home, "notes.txt"), "from home");
  mkdirSync(path.join(home, "Downloads"));
  writeFileSync(path.join(home, "Downloads", "a.pdf"), "pdf");
  mkdirSync(path.join(home, "Downloads", ".cache"));
  writeFileSync(path.join(home, "Downloads", ".cache", "b"), "b");
  mkdirSync(path.join(home, ".ssh"));
  writeFileSync(path.join(home, ".ssh", "id_rsa"), "KEY");
  writeFileSync(path.join(home, ".bash_history"), "history");
  mkdirSync(path.join(home, "proj"));
  writeFileSync(path.join(home, "proj", ".env"), "TOKEN");
  symlinkSync(path.join(home, ".ssh", "id_rsa"), path.join(home, "key-link"));
  symlinkSync(path.join(home, ".ssh"), path.join(home, "ssh-link"));
  symlinkSync(path.join(home, ".ssh", "id_rsa"), path.join(folder, "key-link"));
  symlinkSync(path.join(home, "notes.txt"), path.join(home, ".alias"));

  expect(text(await handleRequest(ctx, read(path.join(home, "notes.txt")), scope()))).toBe("from home");
  const listed = entries(await handleRequest(ctx, list(home), scope()));
  expect(listed).toContain(`${home}/notes.txt`);
  expect(listed).toContain(`${home}/Downloads/a.pdf`);
  expect(listed.filter((p) => /\/\.|key-link|ssh-link/.test(p.slice(home.length)))).toEqual([]);

  await handleRequest(ctx, push(path.join(home, "Downloads")), scope());
  await handleRequest(ctx, push(home), scope());
  const [downloads, zipped] = uploads.map((u) =>
    readZip(u.body, { maxFiles: 100, maxBytes: 1e6 }).map((e) => e.path),
  ) as [string[], string[]];
  expect(downloads.filter((p) => !p.endsWith("/"))).toEqual(["Downloads/a.pdf"]);
  expect(zipped.some((p) => p.endsWith("notes.txt"))).toBe(true);
  expect(zipped.some((p) => p.split("/").some((part) => part.startsWith(".")))).toBe(false);

  for (const closed of [
    ".ssh",
    ".ssh/id_rsa",
    ".ssh/none",
    ".bash_history",
    "proj/.env",
    "Downloads/.cache/b",
    "key-link",
    "ssh-link/id_rsa",
    ".alias",
    `${path.basename(folder)}/key-link`,
  ]) {
    for (const req of [read(path.join(home, closed)), list(path.join(home, closed)), push(path.join(home, closed))]) {
      const out = await refusal(ctx, req);
      expect(out.code).toBe("outside_workspace");
      expect(out.message).not.toContain("request_folder_access");
    }
  }
  expect(uploads).toHaveLength(2);
});

test("in the home, a key or sign-in by its name stays closed too, as Claude Code's own reads", async () => {
  const { home, ctx, uploads } = worker();
  mkdirSync(path.join(home, "proj"));
  writeFileSync(path.join(home, "proj", "ok.txt"), "ok");
  const closed = ["id_ed25519", "credentials.json", "deploy.key", "proj/server.pem", "proj/mcp-token"];
  for (const name of closed) writeFileSync(path.join(home, name), "KEY");
  for (const name of closed) {
    for (const req of [read(path.join(home, name)), push(path.join(home, name))]) {
      expect((await refusal(ctx, req)).code).toBe("outside_workspace");
    }
  }
  const listed = entries(await handleRequest(ctx, list(home), scope()));
  expect(listed.filter((p) => closed.some((name) => p.endsWith(name)))).toEqual([]);
  await handleRequest(ctx, push(path.join(home, "proj")), scope());
  const zipped = readZip(uploads[0]?.body as Uint8Array, { maxFiles: 100, maxBytes: 1e6 }).map((e) => e.path);
  expect(zipped.filter((p) => !p.endsWith("/"))).toEqual(["proj/ok.txt"]);
});

test("hidden files of the agent's own folder stay its own, written in full or not", async () => {
  const { folder, ctx } = worker();
  expect(text(await handleRequest(ctx, read(path.join(folder, ".hidden-note")), scope()))).toBe("mine");
});

test.skipIf(!posix)("a link out of the home or the folder is refused, and sends nobody to ask for it", async () => {
  const { home, folder, ctx } = worker();
  const outside = tempDir("out-");
  dirs.push(outside);
  writeFileSync(path.join(outside, "shadow"), "root:x");
  symlinkSync(path.join(outside, "shadow"), path.join(home, "out"));
  symlinkSync(path.join(outside, "shadow"), path.join(folder, "out"));
  symlinkSync(path.join(outside, "gone"), path.join(home, "dangling"));
  for (const link of [path.join(home, "out"), path.join(folder, "out"), path.join(home, "dangling")]) {
    const out = await refusal(ctx, read(link));
    expect(out.code).toBe("outside_workspace");
    expect(out.message).toContain("is a link that leaves your");
    expect(out.message).not.toContain("request_folder_access");
  }
});

test("writes go to the folder only: the home stays read-only for the file tools", async () => {
  const { home, ctx } = worker();
  const out = await refusal(ctx, write(path.join(home, "planted.txt")));
  expect(out).toEqual({
    code: "outside_workspace",
    message: `${path.join(home, "planted.txt")} isn't in your folder, the only place this works here: use a path relative to it.`,
  });
  expect(existsSync(path.join(home, "planted.txt"))).toBe(false);
});

test("commands off: the home gives nothing it didn't give before", async () => {
  const { home, ctx, uploads } = worker({ commands: false });
  writeFileSync(path.join(home, "notes.txt"), "from home");
  for (const req of [read(path.join(home, "notes.txt")), list(home), push(path.join(home, "notes.txt"))]) {
    const out = await refusal(ctx, req);
    expect(out.code).toBe("outside_workspace");
    expect(out.message).not.toContain("request_folder_access");
  }
  expect(uploads).toEqual([]);
});

test("a runner with no agents' users has no home to read", async () => {
  const { home, ctx } = worker();
  writeFileSync(path.join(home, "notes.txt"), "person's");
  const single = { ...ctx, ownHome: undefined };
  const out = await refusal(single, read(path.join(home, "notes.txt")));
  expect(out.code).toBe("not_allowed");
  expect(out.message).toContain("request_folder_access");
});

test("elsewhere on the computer stays as it was: refused, allowed folders first", async () => {
  const granted = tempDir("grant-");
  dirs.push(granted);
  writeFileSync(path.join(granted, "report.md"), "granted");
  const { home, ctx } = worker({}, [{ path: granted, agents: [AGENT.id] }]);
  symlinkSync(granted, path.join(home, "shared"));
  expect(text(await handleRequest(ctx, read(path.join(home, "shared", "report.md")), scope()))).toBe("granted");
  expect(await errorCode(() => handleRequest(ctx, read("/etc/hosts"), scope()))).toBe("not_allowed");
});

test.skipIf(!posix || process.getuid?.() === 0)("another agent's home is refused like anywhere else", async () => {
  const other = tempDir("other-home-");
  dirs.push(other);
  writeFileSync(path.join(other, "theirs.txt"), "theirs");
  chmodSync(other, 0o000);
  try {
    const { ctx } = worker();
    const out = await refusal(ctx, read(path.join(other, "theirs.txt")));
    expect(out.code).toBe("not_allowed");
  } finally {
    chmodSync(other, 0o700);
  }
});

test("a secret's file and the browser's profile stay closed written in full", async () => {
  const { folder, ctx } = worker();
  const requestId = "req-0002-bbbb";
  const target = { kind: "file" as const, path: ".npmrc" };
  const name = "NPM_TOKEN";
  const call = (req: MachineRequest) => handleRequest(ctx, req, scope());
  const { publicKey } = (await call({ agent: AGENT, op: "secret", action: "keypair", requestId })) as {
    publicKey: string;
  };
  const aad = secretAad({ requestId, orgId: "org-1", name, target });
  const box = await sealSecret(publicKey, "token-value", aad);
  await call({ agent: AGENT, op: "secret", action: "deliver", requestId, name, target, aad, box });
  await call({
    agent: AGENT,
    op: "secret",
    action: "activate",
    requestId,
    order: `${new Date(1).toISOString()}|${requestId}`,
  });
  for (const held of [path.join(folder, ".npmrc"), folder, path.dirname(folder)]) {
    expect(await errorCode(() => call(push(held)))).toBe("bad_request");
  }
  expect(await errorCode(() => call(read(path.join(folder, ".npmrc"))))).toBe("bad_request");
  mkdirSync(path.join(folder, ".agentes", "browser"), { recursive: true });
  writeFileSync(path.join(folder, ".agentes", "browser", "Cookies"), "cookies");
  expect(await errorCode(() => call(read(path.join(folder, ".agentes", "browser", "Cookies"))))).toBe("bad_request");
});

test("a turn with no grants, as a locked-down one, gets none of this", async () => {
  const { home, folder } = worker();
  const own = { path: home, reads: true };
  for (const p of [path.join(folder, "clips"), path.join(home, "Downloads")]) {
    expect(await errorCode(() => resolveForAgent(folder, undefined, p, own))).toBe("outside_workspace");
  }
});

test("reading and sending run as the agent's own user, never as root", () => {
  expect([OP_ROUTES.read, OP_ROUTES.list, OP_ROUTES.push, OP_ROUTES.write]).toEqual([
    "agent",
    "agent",
    "agent",
    "agent",
  ]);
});

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import type { FetchLike } from "../../runner/push";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const scope = (signal = new AbortController().signal): RequestScope => ({ signal, output: () => {} });
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const bytes = Buffer.from("o conteúdo inteiro do arquivo");
const URL_OF_PULL = "https://agentes.test/api/machines/pulls/p1";
const pull = (over: Record<string, unknown> = {}) =>
  ({
    op: "pull",
    path: "in/base.zip",
    url: URL_OF_PULL,
    pullId: "11111111-1111-4111-8111-111111111111",
    size: bytes.length,
    sha256: sha(bytes),
    ...over,
  }) as MachineRequest;

function workspace(fetch: FetchLike, server?: string) {
  const ws = tempDir();
  dirs.push(ws);
  return { ws, ctx: { workspaceReal: ws, exec: false, token: "agm_x", fetch, ...(server ? { server } : {}) } };
}

const serves =
  (body: ConstructorParameters<typeof Response>[0] = bytes, status = 200): FetchLike =>
  async () =>
    new Response(body, { status });

/** A body that gives its first bytes and then dies, as a cut connection does. */
const cutOff = (): FetchLike => async () =>
  new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(bytes.subarray(0, 4));
        controller.error(new Error("socket closed"));
      },
    }),
  );

const message = async (fn: () => Promise<unknown>) =>
  fn().then(
    () => "",
    (e: Error) => e.message,
  );

test("the file lands whole at its path, fetched with the machine token from the server it is paired with", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const { ws, ctx } = workspace(async (url, init) => {
    calls.push({ url, init });
    return new Response(bytes);
  }, "http://127.0.0.1:3000");
  expect(await handleRequest(ctx, pull(), scope())).toEqual({ size: bytes.length, sha256: sha(bytes) });
  expect(readFileSync(path.join(ws, "in/base.zip")).equals(bytes)).toBe(true);
  expect(readdirSync(path.join(ws, "in"))).toEqual(["base.zip"]);
  expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:3000/api/machines/pulls/p1"]);
  expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer agm_x" });
});

test("a body that comes in pieces lands in order, on the machine's own disk pace", async () => {
  const pieces = [bytes.subarray(0, 3), bytes.subarray(3, 9), bytes.subarray(9)];
  const { ws, ctx } = workspace(
    async () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            const next = pieces.shift();
            if (next) controller.enqueue(next);
            else controller.close();
          },
        }),
      ),
  );
  await handleRequest(ctx, pull(), scope());
  expect(readFileSync(path.join(ws, "in/base.zip")).equals(bytes)).toBe(true);
});

test("without a hash (a skill's file) the size alone is checked", async () => {
  const { ws, ctx } = workspace(serves());
  await handleRequest(ctx, pull({ sha256: undefined }), scope());
  expect(readFileSync(path.join(ws, "in/base.zip")).equals(bytes)).toBe(true);
});

test("whatever goes wrong, the old file stays as it was and no half file is left", async () => {
  const cases: [string, FetchLike, Record<string, unknown>, string][] = [
    ["cut", cutOff(), {}, "the copy stopped before the end."],
    ["short", serves(bytes.subarray(0, 4)), {}, "it arrived damaged"],
    ["long", serves(Buffer.concat([bytes, bytes])), {}, "it arrived damaged"],
    ["hash", serves(), { sha256: sha("something else") }, "it arrived damaged"],
    [
      "refused",
      serves('{"error":{"message":"This file isn\'t waiting for this computer"}}', 404),
      {},
      "This file isn't waiting for this computer",
    ],
  ];
  for (const [, fetch, over, said] of cases) {
    const { ws, ctx } = workspace(fetch);
    mkdirSync(path.join(ws, "in"));
    writeFileSync(path.join(ws, "in/base.zip"), "antes");
    expect(await errorCode(() => handleRequest(ctx, pull(over), scope()))).toBe("pull_failed");
    expect(await message(() => handleRequest(ctx, pull({ ...over, pullId: "again" }), scope()))).toContain(said);
    expect(readFileSync(path.join(ws, "in/base.zip"), "utf8")).toBe("antes");
    expect(readdirSync(path.join(ws, "in"))).toEqual(["base.zip"]);
  }
});

test("what the agent reads of a failed pull never names the server's address", async () => {
  const host = "server.internal.example";
  const cases: FetchLike[] = [
    () => Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`)),
    serves(`<html>502 from ${host} (10.0.0.7)</html>`, 502),
  ];
  for (const fetch of cases) {
    const { ctx } = workspace(fetch);
    const said = await message(() => handleRequest(ctx, pull(), scope()));
    expect(said).not.toContain(host);
    expect(said).not.toContain("10.0.0.7");
  }
});

test("a full disk says so, whether it fills before the first byte or during the copy", async () => {
  const fullDisk = Object.assign(new Error("no space left"), { code: "ENOSPC" });
  const { ws, ctx } = workspace(async () => {
    throw fullDisk;
  });
  expect(await message(() => handleRequest(ctx, pull(), scope()))).toContain("the computer's disk is full");
  expect(readdirSync(path.join(ws, "in"))).toEqual([]);
});

test("canceled: stops at once and leaves nothing", async () => {
  const stop = new AbortController();
  const { ws, ctx } = workspace(async (_url, init) => {
    stop.abort();
    init.signal?.throwIfAborted();
    return new Response(bytes);
  });
  expect(await message(() => handleRequest(ctx, pull(), scope(stop.signal)))).toBe("Canceled");
  expect(readdirSync(path.join(ws, "in"))).toEqual([]);
});

test("over an existing file it keeps that file's permissions; through a link, the link's own target", async () => {
  const { ws, ctx } = workspace(serves());
  mkdirSync(path.join(ws, "in"));
  writeFileSync(path.join(ws, "in/base.zip"), "antes");
  chmodSync(path.join(ws, "in/base.zip"), 0o640);
  await handleRequest(ctx, pull(), scope());
  expect(statSync(path.join(ws, "in/base.zip")).mode & 0o777).toBe(0o640);
  symlinkSync("base.zip", path.join(ws, "in/link.zip"));
  await handleRequest(ctx, pull({ path: "in/link.zip" }), scope());
  expect(readdirSync(path.join(ws, "in")).sort()).toEqual(["base.zip", "link.zip"]);
});

test("the same path rules as write: nothing lands outside the workspace, in .git or over a folder", async () => {
  const outside = tempDir();
  dirs.push(outside);
  const { ws, ctx } = workspace(serves());
  symlinkSync(outside, path.join(ws, "link"));
  symlinkSync(path.join(outside, "missing.txt"), path.join(ws, "dangling"));
  mkdirSync(path.join(ws, "repo/.git"), { recursive: true });
  mkdirSync(path.join(ws, "folder"));
  const refused = (p: string) => errorCode(() => handleRequest(ctx, pull({ path: p }), scope()));
  expect(await refused("link/planted.txt")).toBe("outside_workspace");
  expect(await refused("dangling")).toBe("outside_workspace");
  expect(await refused("../up.txt")).toBe("outside_workspace");
  expect(await refused("/etc/passwd")).toBe("outside_workspace");
  expect(await refused("repo/.git/config")).toBe("bad_request");
  expect(await refused("")).toBe("bad_request");
  expect(await refused("folder")).toBe("bad_request");
  expect(readdirSync(outside)).toEqual([]);
  expect(existsSync(path.join(ws, "repo/.git/config"))).toBe(false);
});

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readZip } from "@agenteschat/engine";
import { contentTypeFor, type FetchLike, pushPath } from "../../runner/push";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

interface Captured {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function capture(response: () => Response = () => new Response(null, { status: 204 })) {
  const calls: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body as Uint8Array,
    });
    return response();
  };
  return { calls, fetch };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

test("push a file: PUT with the machine token, name, sha256 and type", async () => {
  const ws = tempDir();
  dirs.push(ws);
  mkdirSync(path.join(ws, "docs"));
  const content = Buffer.from("%PDF-1.4 fake");
  writeFileSync(path.join(ws, "docs", "relatório final.pdf"), content);
  const { calls, fetch } = capture();
  const receipt = await pushPath({
    workspaceReal: ws,
    token: "agm_secret",
    path: "/workspace/docs/relatório final.pdf",
    url: "https://agentes.test/api/machines/uploads/u1",
    uploadId: "u1",
    maxBytes: 1000,
    fetch,
  });
  expect(receipt).toEqual({
    name: "relatório final.pdf",
    size: content.byteLength,
    sha256: sha(content),
    contentType: "application/pdf",
  });
  expect(calls.length).toBe(1);
  const call = calls[0] as Captured;
  expect(call.url).toBe("https://agentes.test/api/machines/uploads/u1");
  expect(call.method).toBe("PUT");
  expect(call.headers).toEqual({
    authorization: "Bearer agm_secret",
    "content-type": "application/pdf",
    "x-agentes-file-name": encodeURIComponent("relatório final.pdf"),
    "x-agentes-sha256": sha(content),
    "x-agentes-upload-id": "u1",
  });
  expect(Buffer.from(call.body).equals(content)).toBe(true);
});

test("push a folder: zipped as <folder>.zip, symlinks left out", async () => {
  const ws = tempDir();
  const outside = tempDir("runner-outside-");
  dirs.push(ws, outside);
  mkdirSync(path.join(ws, "site", "assets"), { recursive: true });
  writeFileSync(path.join(ws, "site", "index.html"), "<h1>hi</h1>");
  writeFileSync(path.join(ws, "site", "assets", "app.js"), "console.log(1)");
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "site", "secret.txt"));
  const { calls, fetch } = capture();
  const receipt = await pushPath({
    workspaceReal: ws,
    token: "agm_secret",
    path: "site",
    url: "https://agentes.test/api/machines/uploads/u2",
    uploadId: "u2",
    maxBytes: 1_000_000,
    fetch,
  });
  const call = calls[0] as Captured;
  expect(receipt.name).toBe("site.zip");
  expect(receipt.contentType).toBe("application/zip");
  expect(receipt.sha256).toBe(sha(call.body));
  expect(receipt.size).toBe(call.body.byteLength);
  expect(call.headers["x-agentes-file-name"]).toBe("site.zip");
  const entries = readZip(call.body, { maxFiles: 10, maxBytes: 1_000_000 });
  expect(entries.map((e) => e.path).sort()).toEqual(["site/assets/app.js", "site/index.html"]);
});

test("push: limits, missing files, escapes and server errors", async () => {
  const ws = tempDir();
  const outside = tempDir("runner-outside-");
  dirs.push(ws, outside);
  writeFileSync(path.join(ws, "big.bin"), Buffer.alloc(100, 1));
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  symlinkSync(outside, path.join(ws, "out"));
  const base = { workspaceReal: ws, token: "agm_x", url: "https://agentes.test/u", uploadId: "u3", maxBytes: 50 };

  const ok = capture();
  expect(await errorCode(() => pushPath({ ...base, path: "big.bin", fetch: ok.fetch }))).toBe("too_large");
  expect(await errorCode(() => pushPath({ ...base, path: "nope.txt", fetch: ok.fetch }))).toBe("not_found");
  expect(await errorCode(() => pushPath({ ...base, path: "out/secret.txt", fetch: ok.fetch }))).toBe(
    "outside_workspace",
  );
  expect(await errorCode(() => pushPath({ ...base, path: "../x", fetch: ok.fetch }))).toBe("outside_workspace");
  expect(ok.calls.length).toBe(0);

  const expired = capture(
    () =>
      new Response(JSON.stringify({ error: { code: "upload.expired", message: "The upload expired" } }), {
        status: 410,
        headers: { "content-type": "application/json" },
      }),
  );
  let message = "";
  try {
    await pushPath({ ...base, maxBytes: 1000, path: "big.bin", fetch: expired.fetch });
  } catch (err) {
    message = `${(err as { code: string }).code}: ${(err as Error).message}`;
  }
  expect(message).toBe("upload_failed: The upload expired");
});

test("a failed upload never tells the agent the host or a proxy's page", async () => {
  const ws = tempDir();
  dirs.push(ws);
  writeFileSync(path.join(ws, "a.txt"), "hi");
  const opts = {
    url: "https://up.example/x",
    token: "t",
    uploadId: "u",
    maxBytes: 1000,
    path: "a.txt",
    workspaceReal: ws,
  };
  const said = (fetch: FetchLike) =>
    pushPath({ ...opts, fetch }).then(
      () => "",
      (err: Error) => err.message,
    );
  const noHost = await said(async () => {
    throw new Error("getaddrinfo ENOTFOUND internal.host.example");
  });
  expect(noHost).toBe("The upload stopped. Try again.");
  const page = await said(async () => new Response("<html>internal.host.example</html>", { status: 502 }));
  expect(page).toBe("The server refused it (502). Try again.");
});

test("push goes to the paired server, at the path the server gave (its public address may not be reachable here)", async () => {
  const ws = tempDir();
  dirs.push(ws);
  writeFileSync(path.join(ws, "a.txt"), "a");
  const { calls, fetch } = capture();
  await pushPath({
    workspaceReal: ws,
    token: "agm_x",
    server: "http://agentes:3000",
    path: "a.txt",
    url: "https://box.tailnet.ts.net/api/machines/uploads/u4?v=1",
    uploadId: "u4",
    maxBytes: 100,
    fetch,
  });
  expect(calls.map((c) => c.url)).toEqual(["http://agentes:3000/api/machines/uploads/u4?v=1"]);
  const refused = await errorCode(() =>
    pushPath({
      workspaceReal: ws,
      token: "agm_x",
      server: "http://agentes:3000",
      path: "a.txt",
      url: "file:///etc/passwd",
      uploadId: "u5",
      maxBytes: 100,
      fetch,
    }),
  );
  expect(refused).toBe("bad_request");
  expect(calls).toHaveLength(1);
});

test("content types by extension", () => {
  expect(contentTypeFor("a.ZIP")).toBe("application/zip");
  expect(contentTypeFor("photo.jpeg")).toBe("image/jpeg");
  expect(contentTypeFor("Makefile")).toBe("application/octet-stream");
  expect(contentTypeFor("data.parquet")).toBe("application/octet-stream");
});

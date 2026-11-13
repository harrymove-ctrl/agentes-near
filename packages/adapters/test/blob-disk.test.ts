import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiskBlobStore } from "../src";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentes-blobs-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const bytes = (s: string) => new TextEncoder().encode(s);

test("files live at their key with their content type; listed by prefix; deleted", async () => {
  const store = createDiskBlobStore(dir);
  await store.put("orgs/o1/artifacts/a1/v1", bytes("%PDF"), { contentType: "application/pdf" });
  await store.put("orgs/o1/artifacts/a1/v2", bytes("v2"), { contentType: "text/plain" });
  await store.put("avatars/u1/abc.png", bytes("png"), { contentType: "image/png" });

  expect(await store.get("orgs/o1/artifacts/a1/v1")).toEqual({ body: bytes("%PDF"), contentType: "application/pdf" });
  // A plain file on disk, as uploaded (backups, inspection), readable by the server's user alone.
  expect(await readFile(join(dir, "orgs/o1/artifacts/a1/v1"), "utf8")).toBe("%PDF");
  const mode = async (path: string) => (await stat(join(dir, path))).mode & 0o777;
  expect(await mode("orgs")).toBe(0o700);
  expect(await mode("orgs/o1/artifacts/a1")).toBe(0o700);
  expect(await mode("orgs/o1/artifacts/a1/v1")).toBe(0o600);
  expect(await mode("orgs/o1/artifacts/a1/v1.type")).toBe(0o600);
  expect(await store.get("orgs/o1/artifacts/a1/v9")).toBeNull();
  expect(await store.signedUrl("avatars/u1/abc.png", { expiresInSeconds: 60 })).toBeNull();

  expect(await store.list("orgs/o1/")).toEqual(["orgs/o1/artifacts/a1/v1", "orgs/o1/artifacts/a1/v2"]);
  expect(await store.list("orgs/o1/artifacts/a1/v1")).toEqual(["orgs/o1/artifacts/a1/v1"]);
  expect(await store.list("orgs/o1/", 1)).toEqual(["orgs/o1/artifacts/a1/v1"]);
  expect(await store.list("orgs/nobody/")).toEqual([]);

  await store.delete("orgs/o1/artifacts/a1/v1");
  await store.delete("orgs/o1/artifacts/a1/v1");
  expect(await store.get("orgs/o1/artifacts/a1/v1")).toBeNull();
  expect(await store.list("")).toEqual(["avatars/u1/abc.png", "orgs/o1/artifacts/a1/v2"]);
});

test("a folder goes whole, folders inside it too, and only when the prefix names it as written", async () => {
  const store = createDiskBlobStore(dir);
  await store.put("orgs/o1/skills/s1/v1/clientes/acme/notes.md", bytes("x"), { contentType: "text/markdown" });
  await store.put("orgs/o2/artifacts/a1/v1", bytes("y"), { contentType: "text/plain" });
  // Each would reach past one folder (or name none).
  for (const prefix of ["orgs//", "orgs/o2/../", "orgs/o1", "", "../"]) {
    await expect(store.deletePrefix?.(prefix)).rejects.toThrow();
  }
  await store.deletePrefix?.("orgs/o1/");
  await store.deletePrefix?.("orgs/o1/");
  expect(await readdir(join(dir, "orgs"))).toEqual(["o2"]);
});

test("a key never reaches outside the folder", async () => {
  const store = createDiskBlobStore(join(dir, "files"));
  for (const key of ["../outside", "orgs/o1/../../../outside", "/etc/passwd", ""]) {
    await expect(store.put(key, bytes("x"), { contentType: "text/plain" })).rejects.toThrow();
    await expect(store.get(key)).rejects.toThrow();
    await expect(store.delete(key)).rejects.toThrow();
  }
  expect(await readdir(dir)).toEqual([]);
});

test("streamed: the file as it is read; nothing for a missing key", async () => {
  const store = createDiskBlobStore(dir);
  await store.put("orgs/o1/big", bytes("all of it"), { contentType: "application/zip" });
  expect(await new Response(await store.stream?.("orgs/o1/big")).text()).toBe("all of it");
  expect(await store.stream?.("orgs/o1/gone")).toBeNull();
  expect(store.stream?.("../outside")).rejects.toThrow("outside the files folder");
});

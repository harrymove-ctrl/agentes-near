import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readZip } from "@agenteschat/engine";
import { crc32, dosDateTime, ZipWriter, zipFolder } from "../../runner/zip";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const text = (s: string) => new TextEncoder().encode(s);

test("crc32 matches the known vectors", () => {
  expect(crc32(new Uint8Array(0))).toBe(0);
  expect(crc32(text("123456789"))).toBe(0xcbf43926);
  expect(crc32(text("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  expect(crc32(text("a"))).toBe(0xe8b7be43);
  // Running checksum: the same as all at once.
  expect(crc32(text("6789"), crc32(text("12345")))).toBe(0xcbf43926);
});

test("DOS timestamps", () => {
  const { time, date } = dosDateTime(new Date(2026, 9, 15, 13, 45, 31));
  expect(date).toBe(((2026 - 1980) << 9) | (10 << 5) | 15);
  expect(time).toBe((13 << 11) | (45 << 5) | 15);
  expect(dosDateTime(new Date(1970, 0, 1))).toEqual({ time: 0, date: (1 << 5) | 1 });
});

test("the zip writer round-trips through the engine's reader (deflated, stored, UTF-8 names, folders)", () => {
  const repeated = text("hello world\n".repeat(500));
  const random = new Uint8Array(randomBytes(2000));
  const zip = new ZipWriter();
  zip.addDirectory("dir");
  zip.addFile("dir/repeated.txt", repeated);
  zip.addFile("random.bin", random);
  zip.addFile("ünïcödé/çà.txt", text("acentos"));
  zip.addFile("empty.txt", new Uint8Array(0));
  const bytes = zip.finish();
  // Deflate made the repeated text much smaller.
  expect(bytes.byteLength).toBeLessThan(repeated.byteLength);

  const entries = readZip(bytes, { maxFiles: 10, maxBytes: 1_000_000 });
  const byPath = new Map(entries.map((e) => [e.path, e.data]));
  expect([...byPath.keys()].sort()).toEqual(["dir/repeated.txt", "empty.txt", "random.bin", "ünïcödé/çà.txt"]);
  expect(Buffer.from(byPath.get("dir/repeated.txt") as Uint8Array).equals(Buffer.from(repeated))).toBe(true);
  expect(Buffer.from(byPath.get("random.bin") as Uint8Array).equals(Buffer.from(random))).toBe(true);
  expect(new TextDecoder().decode(byPath.get("ünïcödé/çà.txt"))).toBe("acentos");
  expect(byPath.get("empty.txt")?.byteLength).toBe(0);

  // The folder entry is in the central directory with a trailing slash.
  expect(Buffer.from(bytes).includes(Buffer.from("dir/"))).toBe(true);
});

test("zipFolder: prefix, nested folders, symlinks skipped, limit enforced", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const out = path.join(ws, "out");
  mkdirSync(path.join(out, "nested", "deeper"), { recursive: true });
  mkdirSync(path.join(out, "empty"));
  writeFileSync(path.join(out, "a.txt"), "A".repeat(1000));
  writeFileSync(path.join(out, "nested", "deeper", "b.txt"), "b");
  symlinkSync(path.join(out, "a.txt"), path.join(out, "link.txt"));

  const bytes = await zipFolder(out, { prefix: "out", maxBytes: 1_000_000, workspaceReal: ws });
  const entries = readZip(bytes, { maxFiles: 10, maxBytes: 1_000_000 });
  expect(entries.map((e) => e.path).sort()).toEqual(["out/a.txt", "out/nested/deeper/b.txt"]);
  expect(Buffer.from(bytes).includes(Buffer.from("out/empty/"))).toBe(true);
  expect(Buffer.from(bytes).includes(Buffer.from("link.txt"))).toBe(false);

  expect(await errorCode(() => zipFolder(out, { prefix: "out", maxBytes: 100 }))).toBe("too_large");
});

test("the writer refuses to pass its byte limit", async () => {
  const zip = new ZipWriter(200);
  expect(await errorCode(() => zip.addFile("big.bin", new Uint8Array(randomBytes(500))))).toBe("too_large");
});

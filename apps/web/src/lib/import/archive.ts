import {
  ARCHIVE_PATH,
  IMPORT_MAX_BYTES,
  ImportError,
  type ImportFile,
  isSecretPath,
  normalizePath,
  TEXT_PATH,
} from "@agenteschat/client/lib/import/shared";
import { readZip, ZipError } from "@agenteschat/client/lib/zip";

/**
 * The async step before `parseImport`: picked or dropped files (a folder keeps
 * its relative paths), or one archive (.zip, .tar.gz, .tgz, .tar) unpacked in
 * the browser. Only text files the formats use are read; a credential store,
 * a binary or a file over 4 MB comes back with empty text, so it can be
 * listed without being read. Other small text files (a script, a config) come
 * back with a `peek`, only to look for keys in them before they go to the
 * Drive. Every file keeps its size and a way to read its
 * bytes later, when it goes to the Drive; system files (`.DS_Store`,
 * `__MACOSX`, `Thumbs.db`, `.git`) are dropped and only their paths come
 * back, as `junk`.
 */

export const ARCHIVE_LIMITS = {
  /** The archive file. */
  bytes: 512 * 1024 * 1024,
  entries: 50_000,
  /** What it may unpack to, and how much larger than itself past `ratioFrom` bytes. */
  unpacked: 2 * 1024 * 1024 * 1024,
  ratio: 200,
  ratioFrom: 64 * 1024 * 1024,
  /** Text read in all: what one import may send (IMPORT_LIMITS.bodyBytes in packages/engine/src/imports.ts). */
  text: 32 * 1024 * 1024,
  /** Files no format reads, looked at for keys: each, and in all. */
  peekFile: 1024 * 1024,
  peek: 32 * 1024 * 1024,
};

/** System files, and what tools make and fetch again (dependencies, caches, builds): never an agent's own. */
const JUNK =
  /(^|\/)(__MACOSX\/|\.DS_Store$|\._[^/]*$|Thumbs\.db$|desktop\.ini$|\.git\/|node_modules\/|__pycache__\/|\.?venv\/|site-packages\/|\.cache\/|\.next\/|\.tox\/)/;
/** Folders a format itself has at its root: an archive with only one of them is not wrapped in a folder. */
const LAYOUT = new Set(["agents", "skills", "memory", "memories", "cron", "tasks", "projects", "teams", "profiles"]);

export type PickedFile = File | { path: string; file: Blob };

/** What a reader found: the files, and the paths of the system files it dropped. */
interface Read {
  files: ImportFile[];
  junk: string[];
}

export async function readImportFiles(
  picked: readonly PickedFile[],
): Promise<{ files: ImportFile[]; root: string | null; junk: string[] }> {
  const items = picked.map((p) =>
    "file" in p
      ? { path: normalizePath(p.path), blob: p.file }
      : { path: normalizePath(p.webkitRelativePath || p.name), blob: p },
  );
  const [only] = items;
  if (items.length === 1 && only && ARCHIVE_PATH.test(only.path)) return readArchive(only.blob, only.path);
  const { wants, peeks } = budget();
  const read: Read = { files: [], junk: [] };
  for (const { path, blob } of items) {
    if (JUNK.test(path)) read.junk.push(path);
    else if (wants(path, blob.size)) {
      read.files.push({ name: path, text: await blob.text(), size: blob.size, read: async () => blob });
    } else {
      const peek = peeks(path, blob.size) ? peekOf(new Uint8Array(await blob.arrayBuffer())) : "";
      read.files.push({ name: path, text: "", size: blob.size, read: async () => blob, ...(peek ? { peek } : {}) });
    }
  }
  // A dropped folder: every path starts with its name.
  return unwrap(read, true);
}

async function readArchive(blob: Blob, path: string) {
  if (blob.size > ARCHIVE_LIMITS.bytes) throw new ImportError("tooLarge");
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const zip = head[0] === 0x50 && head[1] === 0x4b;
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  if (/\.zip$/i.test(path) ? !zip : /\.(tar\.gz|tgz)$/i.test(path) && !gzip) throw new ImportError("corrupt");
  return unwrap(zip ? await fromZip(blob) : await fromTar(blob, gzip), false);
}

/**
 * Which files to read: text a format uses, under the per-file and total caps; and which of the others to peek at
 * for keys, small ones. Never a credential store.
 */
function budget() {
  let total = 0;
  let peeked = 0;
  return {
    wants: (path: string, size: number) => {
      if (
        isSecretPath(path) ||
        !TEXT_PATH.test(path) ||
        size > IMPORT_MAX_BYTES ||
        total + size > ARCHIVE_LIMITS.text
      ) {
        return false;
      }
      total += size;
      return true;
    },
    peeks: (path: string, size: number) => {
      if (isSecretPath(path) || size > ARCHIVE_LIMITS.peekFile || peeked + size > ARCHIVE_LIMITS.peek) return false;
      peeked += size;
      return true;
    },
  };
}

const strict = new TextDecoder("utf-8", { fatal: true });
/** A peek's text: "" for a binary. */
function peekOf(data: Uint8Array) {
  try {
    return strict.decode(data);
  } catch {
    return "";
  }
}

function safePath(raw: string): string {
  const path = raw.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) {
    throw new ImportError("unsafe");
  }
  return normalizePath(path);
}

/** Paths relative to the single folder everything is in (its name is `root`); macOS's copies of it too. */
function unwrap({ files, junk }: Read, folder: boolean) {
  const tops = new Set(files.map((f) => (f.name.includes("/") ? f.name.split("/")[0] : "")));
  const [top] = tops;
  const system = junk.map((p) => p.replace(/^__MACOSX\//, ""));
  if (tops.size !== 1 || !top || (!folder && LAYOUT.has(top))) return { files, root: null, junk: system };
  const inside = (p: string) => (p.startsWith(`${top}/`) ? p.slice(top.length + 1) : p);
  return {
    files: files.map((f) => ({ ...f, name: inside(f.name) })),
    root: top,
    junk: system.map(inside),
  };
}

const decoder = new TextDecoder();

async function fromZip(blob: Blob): Promise<Read> {
  const entries = await readZip(blob).catch(() => {
    throw new ImportError("corrupt");
  });
  const declared = entries.reduce((sum, e) => sum + e.size, 0);
  if (
    entries.length > ARCHIVE_LIMITS.entries ||
    declared > ARCHIVE_LIMITS.unpacked ||
    (declared > ARCHIVE_LIMITS.ratioFrom && declared > blob.size * ARCHIVE_LIMITS.ratio)
  ) {
    throw new ImportError("tooLarge");
  }
  const { wants, peeks } = budget();
  const out: Read = { files: [], junk: [] };
  for (const entry of entries) {
    const path = safePath(entry.name);
    if (JUNK.test(path)) {
      out.junk.push(path);
      continue;
    }
    // An entry larger than its declared size is a zip bomb or a broken archive: the reader stops there.
    const bytes = () =>
      entry.read().catch((error: unknown) => {
        throw error instanceof ZipError && error.code === "too_large" ? new ImportError("tooLarge") : error;
      });
    // An encrypted entry, or one packed in a way the reader doesn't know, is listed without being read.
    const readable = () =>
      bytes().catch((error: unknown) => {
        if (error instanceof ImportError) throw error;
        if (error instanceof ZipError && (error.code === "encrypted" || error.code === "method")) return null;
        throw new ImportError("corrupt");
      });
    const file = { name: path, size: entry.size, read: async () => new Blob([(await bytes()).slice()]) };
    if (wants(path, entry.size)) {
      const data = await readable();
      out.files.push({ ...file, text: data ? decoder.decode(data) : "" });
    } else {
      const data = peeks(path, entry.size) ? await readable() : null;
      const peek = data ? peekOf(data) : "";
      out.files.push({ ...file, text: "", ...(peek ? { peek } : {}) });
    }
  }
  return out;
}

/** The bytes of a stream, taken or skipped in order, without keeping what is skipped. */
class Bytes {
  private queue: Uint8Array[] = [];
  private queued = 0;
  private total = 0;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly packed: number,
  ) {}

  /** How many bytes were taken or skipped so far: where the next one sits in the (unpacked) stream. */
  get position() {
    return this.total - this.queued;
  }

  private async pull(): Promise<boolean> {
    const { done, value } = await this.reader.read();
    if (done || !value) return false;
    this.total += value.length;
    if (
      this.total > ARCHIVE_LIMITS.unpacked ||
      (this.total > ARCHIVE_LIMITS.ratioFrom && this.total > this.packed * ARCHIVE_LIMITS.ratio)
    ) {
      throw new ImportError("tooLarge");
    }
    this.queue.push(value);
    this.queued += value.length;
    return true;
  }

  /** The next `n` bytes, or null when the stream ends first. */
  async take(n: number): Promise<Uint8Array | null> {
    while (this.queued < n) if (!(await this.pull())) return null;
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const chunk = this.queue[0] as Uint8Array;
      const part = chunk.subarray(0, n - at);
      out.set(part, at);
      at += part.length;
      if (part.length === chunk.length) this.queue.shift();
      else this.queue[0] = chunk.subarray(part.length);
    }
    this.queued -= n;
    return out;
  }

  async skip(n: number) {
    for (let left = n; left > 0; ) {
      if (this.queued === 0 && !(await this.pull())) throw new ImportError("corrupt");
      const chunk = this.queue[0] as Uint8Array;
      const part = Math.min(left, chunk.length);
      if (part === chunk.length) this.queue.shift();
      else this.queue[0] = chunk.subarray(part);
      this.queued -= part;
      left -= part;
    }
  }

  cancel() {
    this.reader.cancel().catch(() => {});
  }
}

const field = (block: Uint8Array, at: number, length: number) =>
  decoder.decode(block.subarray(at, at + length)).replace(/\0[\s\S]*$/, "");

/** A numeric header field: octal text, or base-256 when its first byte has the high bit. */
function numeric(block: Uint8Array, at: number, length: number): number {
  if (((block[at] ?? 0) & 0x80) !== 0) {
    let n = 0;
    for (let i = at + 1; i < at + length; i++) n = n * 256 + (block[i] ?? 0);
    return n;
  }
  const text = field(block, at, length).trim();
  const n = text ? Number.parseInt(text, 8) : 0;
  if (Number.isNaN(n)) throw new ImportError("corrupt");
  return n;
}

/**
 * A ustar archive (GNU long names and pax paths too), streamed: only the text files read are kept. A file's bytes
 * are read later as a slice of the archive, unpacked again the first time a file of a .tar.gz is asked for, up to
 * where the last file ends.
 */
async function fromTar(blob: Blob, gzip: boolean): Promise<Read> {
  const unpack = () => blob.stream().pipeThrough(new DecompressionStream("gzip"));
  const stream = gzip ? unpack() : blob.stream();
  const bytes = new Bytes(stream.getReader(), blob.size);
  let unpacked: Promise<Blob> | undefined;
  // Where the last file kept ends: unpacking again stops there.
  let end = 0;
  const tar = () => {
    if (!gzip) return Promise.resolve(blob);
    unpacked ??= head(unpack(), end);
    return unpacked;
  };
  const { wants, peeks } = budget();
  const out: Read = { files: [], junk: [] };
  let longName = "";
  try {
    for (let count = 0; ; count++) {
      const header = await bytes.take(512);
      if (!header && count === 0) throw new ImportError("corrupt");
      if (!header || header.every((b) => b === 0)) break;
      if (count >= ARCHIVE_LIMITS.entries) throw new ImportError("tooLarge");
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (header[i] as number);
      if (sum !== numeric(header, 148, 8)) throw new ImportError("corrupt");
      const size = numeric(header, 124, 12);
      const padded = Math.ceil(size / 512) * 512;
      const type = String.fromCharCode(header[156] as number);
      if (type === "L" || type === "x") {
        // The next entry's name: a GNU long name, or a pax header's `path` record.
        if (size > 1024 * 1024) throw new ImportError("corrupt");
        const data = decoder.decode((await bytes.take(padded))?.subarray(0, size));
        longName = type === "L" ? data.replace(/\0[\s\S]*$/, "") : (/(?:^|\n)\d+ path=([^\n]*)/.exec(data)?.[1] ?? "");
        continue;
      }
      const prefix = field(header, 257, 6).startsWith("ustar") ? field(header, 345, 155) : "";
      const name = longName || (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
      longName = "";
      const path = safePath(name);
      const regular = type === "0" || type === "\0" || type === "7";
      const at = bytes.position;
      const file = { name: path, size, read: async () => (await tar()).slice(at, at + size) };
      if (regular) end = Math.max(end, at + size);
      if (regular && JUNK.test(path)) out.junk.push(path);
      const own = regular && !JUNK.test(path) && !path.endsWith("/");
      if (own && wants(path, size)) {
        const data = await bytes.take(padded);
        if (!data) throw new ImportError("corrupt");
        out.files.push({ ...file, text: decoder.decode(data.subarray(0, size)) });
        continue;
      }
      if (own && peeks(path, size)) {
        const data = await bytes.take(padded);
        if (!data) throw new ImportError("corrupt");
        const peek = peekOf(data.subarray(0, size));
        out.files.push({ ...file, text: "", ...(peek ? { peek } : {}) });
        continue;
      }
      await bytes.skip(padded);
      // A link is listed, never followed (nor copied); directories and devices are not files.
      if ((regular || type === "1" || type === "2") && !JUNK.test(path) && !path.endsWith("/")) {
        out.files.push(regular ? { ...file, text: "" } : { name: path, text: "" });
      }
    }
  } catch (error) {
    throw error instanceof ImportError ? error : new ImportError("corrupt");
  } finally {
    bytes.cancel();
  }
  return out;
}

/** The first `max` bytes of a stream, then it stops. */
async function head(stream: ReadableStream<Uint8Array>, max: number): Promise<Blob> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
  }
  await reader.cancel();
  return new Blob(parts as BlobPart[]).slice(0, max);
}

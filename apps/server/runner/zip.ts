import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { inBrowserProfile } from "@agenteschat/adapters/command-policy";
import { RunnerError } from "./errors";
import { isInside } from "./paths";

/** Classic zip limits (we don't write zip64). */
export const ZIP_MAX_ENTRIES = 65_535;
export const ZIP_MAX_BYTES = 0xffff_ffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE, as zip uses it). Pass the previous value to continue a running checksum. */
export function crc32(data: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

/** MS-DOS date and time (local time, 2-second steps, from 1980). */
export function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const y = Math.min(year, 2107) - 1980;
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: (y << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface CentralEntry {
  name: Uint8Array;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  isDir: boolean;
}

const tooLarge = (message: string) => new RunnerError("too_large", message);

/**
 * A minimal in-memory zip writer: local headers, central directory and end
 * record; deflate per entry (stored when deflate doesn't shrink it); UTF-8
 * names (flag bit 11). Throws `too_large` as soon as the archive would pass
 * `maxBytes` or the classic zip limits.
 */
export class ZipWriter {
  private readonly chunks: Uint8Array[] = [];
  private readonly central: CentralEntry[] = [];
  private offset = 0;
  private readonly encoder = new TextEncoder();

  constructor(private readonly maxBytes: number = ZIP_MAX_BYTES) {}

  get size() {
    return this.offset;
  }

  get entries() {
    return this.central.length;
  }

  addDirectory(name: string, mtime = new Date()) {
    const clean = name.endsWith("/") ? name : `${name}/`;
    this.add(clean, new Uint8Array(0), mtime, true);
  }

  addFile(name: string, data: Uint8Array, mtime = new Date()) {
    this.add(name, data, mtime, false);
  }

  private add(name: string, data: Uint8Array, mtime: Date, isDir: boolean) {
    if (this.central.length + 1 > ZIP_MAX_ENTRIES) throw tooLarge(`Too many files to zip (max ${ZIP_MAX_ENTRIES})`);
    if (data.byteLength >= ZIP_MAX_BYTES) throw tooLarge("A file is too large to zip (max 4 GB)");
    const nameBytes = this.encoder.encode(name);
    if (nameBytes.length > 0xffff) throw new RunnerError("bad_request", "A file name is too long to zip");
    const crc = crc32(data);
    let method = 0;
    let body = data;
    if (data.byteLength > 0) {
      const deflated = deflateRawSync(data);
      if (deflated.byteLength < data.byteLength) {
        method = 8;
        body = new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength);
      }
    }
    const { time, date } = dosDateTime(mtime);
    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true); // version needed: 2.0
    v.setUint16(6, 0x0800, true); // UTF-8 names
    v.setUint16(8, method, true);
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, body.byteLength, true);
    v.setUint32(22, data.byteLength, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    // Room for this entry, its central record (46 + name) and the end record (22).
    const projected =
      this.offset + header.byteLength + body.byteLength + this.centralSize() + 46 + nameBytes.length + 22;
    if (projected > this.maxBytes) throw tooLarge(`The zip is larger than the limit (${this.maxBytes} bytes)`);
    if (projected > ZIP_MAX_BYTES) throw tooLarge("The zip would pass 4 GB");
    this.central.push({
      name: nameBytes,
      method,
      time,
      date,
      crc,
      compressed: body.byteLength,
      size: data.byteLength,
      offset: this.offset,
      isDir,
    });
    this.chunks.push(header, body);
    this.offset += header.byteLength + body.byteLength;
  }

  private centralSize() {
    let n = 0;
    for (const e of this.central) n += 46 + e.name.length;
    return n;
  }

  /** The finished archive. */
  finish(): Uint8Array {
    const cdStart = this.offset;
    const parts: Uint8Array[] = [...this.chunks];
    for (const e of this.central) {
      const rec = new Uint8Array(46 + e.name.length);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true); // made by: 2.0, MS-DOS attributes
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, e.method, true);
      v.setUint16(12, e.time, true);
      v.setUint16(14, e.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.compressed, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, 0, true); // extra
      v.setUint16(32, 0, true); // comment
      v.setUint16(34, 0, true); // disk
      v.setUint16(36, 0, true); // internal attributes
      v.setUint32(38, e.isDir ? 0x10 : 0, true); // external: MS-DOS directory bit
      v.setUint32(42, e.offset, true);
      rec.set(e.name, 46);
      parts.push(rec);
    }
    const cdSize = this.centralSize();
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(4, 0, true);
    v.setUint16(6, 0, true);
    v.setUint16(8, this.central.length, true);
    v.setUint16(10, this.central.length, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, cdStart, true);
    v.setUint16(20, 0, true);
    parts.push(end);
    const total = cdStart + cdSize + 22;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }
}

/**
 * Zips a folder (its contents under `<prefix>/`). Symlinks are skipped, and so
 * is an agent browser's profile (its logins never leave the computer), and
 * whatever `skip` names.
 * Stops with `too_large` once the archive passes `maxBytes`, and refuses to
 * read more than `maxReadBytes` of uncompressed data.
 */
export async function zipFolder(
  dir: string,
  opts: {
    prefix: string;
    maxBytes: number;
    maxReadBytes?: number;
    workspaceReal?: string;
    skip?: (abs: string) => boolean;
  },
): Promise<Uint8Array> {
  const zip = new ZipWriter(opts.maxBytes);
  const maxRead = Math.min(opts.maxReadBytes ?? Math.max(opts.maxBytes * 20, 64 * 1024 * 1024), ZIP_MAX_BYTES - 1);
  let read = 0;
  const prefix = opts.prefix.replace(/\/+$/, "");
  const walk = async (abs: string, rel: string) => {
    const items = await readdir(abs, { withFileTypes: true });
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const childAbs = path.join(abs, item.name);
      if (opts.skip?.(childAbs)) continue;
      if (opts.workspaceReal && !isInside(opts.workspaceReal, childAbs)) continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      const name = prefix ? `${prefix}/${childRel}` : childRel;
      if (item.isDirectory()) {
        if (inBrowserProfile(childAbs)) continue;
        const st = await stat(childAbs);
        zip.addDirectory(name, st.mtime);
        await walk(childAbs, childRel);
      } else if (item.isFile()) {
        const st = await stat(childAbs);
        read += st.size;
        if (read > maxRead) throw tooLarge("The folder is too large to zip");
        zip.addFile(name, await readFile(childAbs), st.mtime);
      }
      // Sockets, FIFOs and devices are skipped.
    }
  };
  if (prefix) zip.addDirectory(prefix, (await stat(dir)).mtime);
  await walk(dir, "");
  return zip.finish();
}

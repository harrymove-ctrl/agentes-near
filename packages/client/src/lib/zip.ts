/**
 * Reads a .zip in the browser, with no library: the central directory gives
 * the entries, and each one inflates on demand with the native
 * `DecompressionStream("deflate-raw")`. Handles zip64 offsets; refuses
 * encrypted entries and methods other than stored/deflate.
 */
export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  name: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** Its bytes; never more than `size` (`ZipError("too_large")`). */
  read(): Promise<Uint8Array>;
}

export class ZipError extends Error {
  constructor(readonly code: "not_zip" | "corrupt" | "encrypted" | "method" | "too_large") {
    super(`zip: ${code}`);
  }
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const MAX32 = 0xffffffff;

/** Inflates `data`, stopping as soon as it passes `max` bytes (a zip bomb declares a small size). */
async function inflate(data: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ZipError("too_large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** IBM code page 850's upper half (Western Europe's Windows): a zip's names when its UTF-8 flag (bit 11) is clear. */
export const CP850_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** A name as the zip wrote it: UTF-8 when flagged, or when it reads as UTF-8 (many tools don't flag it); else CP850. */
function entryName(bytes: Uint8Array, utf8: boolean): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    if (utf8) return new TextDecoder().decode(bytes);
    return Array.from(bytes, (b) => (b < 128 ? String.fromCharCode(b) : (CP850_HIGH[b - 128] as string))).join("");
  }
}

export async function readZip(file: Blob): Promise<ZipEntry[]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 22) throw new ZipError("not_zip");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not_zip");
  let count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if ((count === 0xffff || offset === MAX32) && eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) {
    const record = Number(view.getBigUint64(eocd - 12, true));
    count = Number(view.getBigUint64(record + 32, true));
    offset = Number(view.getBigUint64(record + 48, true));
  }
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || view.getUint32(offset, true) !== CENTRAL) throw new ZipError("corrupt");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    let compressed = view.getUint32(offset + 20, true);
    let size = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    let local = view.getUint32(offset + 42, true);
    const name = entryName(buf.subarray(offset + 46, offset + 46 + nameLen), (flags & 0x800) !== 0).replace(/\\/g, "/");
    // zip64: the real sizes and offset sit in the extra field 0x0001, in this order, when maxed out.
    let at = offset + 46 + nameLen;
    const extraEnd = at + extraLen;
    while (at + 4 <= extraEnd) {
      const id = view.getUint16(at, true);
      const len = view.getUint16(at + 2, true);
      if (id === 0x0001) {
        let p = at + 4;
        if (size === MAX32) {
          size = Number(view.getBigUint64(p, true));
          p += 8;
        }
        if (compressed === MAX32) {
          compressed = Number(view.getBigUint64(p, true));
          p += 8;
        }
        if (local === MAX32) local = Number(view.getBigUint64(p, true));
      }
      at += 4 + len;
    }
    offset = extraEnd + commentLen;
    if (name.endsWith("/")) continue;
    const encrypted = (flags & 1) === 1;
    const start = local;
    const length = compressed;
    out.push({
      name,
      size,
      async read() {
        if (encrypted) throw new ZipError("encrypted");
        if (view.getUint32(start, true) !== 0x04034b50) throw new ZipError("corrupt");
        const from = start + 30 + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
        const data = buf.subarray(from, from + length);
        if (method === 0) {
          if (data.length > size) throw new ZipError("too_large");
          return data;
        }
        if (method === 8) return inflate(data, size);
        throw new ZipError("method");
      },
    });
  }
  return out;
}

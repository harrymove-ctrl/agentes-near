/**
 * Just enough TrueType for PDFs: metrics, the character map and a glyph
 * subset (only the glyphs a document uses keep their outlines; the tables a
 * PDF reader doesn't need are dropped). Pure TypeScript.
 */
export interface TrueTypeFont {
  name: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  /** Glyph id of a character (0 = missing). */
  glyphOf(codePoint: number): number;
  /** Advance width of a glyph, in font units. */
  advance(gid: number): number;
  /** A font file with only these glyphs' outlines (plus .notdef and composite parts). */
  subset(gids: Iterable<number>): Uint8Array;
}

interface Table {
  offset: number;
  length: number;
}

export function parseTrueType(bytes: Uint8Array, name: string): TrueTypeFont {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at);
  const i16 = (at: number) => view.getInt16(at);
  const u32 = (at: number) => view.getUint32(at);
  const tables = new Map<string, Table>();
  const count = u16(4);
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(bytes[rec] ?? 0, bytes[rec + 1] ?? 0, bytes[rec + 2] ?? 0, bytes[rec + 3] ?? 0);
    tables.set(tag, { offset: u32(rec + 8), length: u32(rec + 12) });
  }
  const table = (tag: string) => {
    const t = tables.get(tag);
    if (!t) throw new Error(`font ${name}: no ${tag} table`);
    return t;
  };
  const head = table("head");
  const unitsPerEm = u16(head.offset + 18);
  const bbox: [number, number, number, number] = [
    i16(head.offset + 36),
    i16(head.offset + 38),
    i16(head.offset + 40),
    i16(head.offset + 42),
  ];
  const longLoca = i16(head.offset + 50) === 1;
  const hhea = table("hhea");
  const ascent = i16(hhea.offset + 4);
  const descent = i16(hhea.offset + 6);
  const numberOfHMetrics = u16(hhea.offset + 34);
  const numGlyphs = u16(table("maxp").offset + 4);
  const os2 = tables.get("OS/2");
  const capHeight = os2 && os2.length >= 90 ? i16(os2.offset + 88) : Math.round(ascent * 0.7);
  const hmtx = table("hmtx");
  const advance = (gid: number) => u16(hmtx.offset + Math.min(gid, numberOfHMetrics - 1) * 4);

  // cmap: format 12 (full Unicode) when present, else format 4 (BMP).
  // A subset we wrote has no cmap (PDFs map by glyph id): every character is then glyph 0.
  const cmap = tables.get("cmap") ?? { offset: 0, length: 0 };
  let format4 = -1;
  let format12 = -1;
  for (let i = 0; cmap.length > 0 && i < u16(cmap.offset + 2); i++) {
    const rec = cmap.offset + 4 + i * 8;
    const platform = u16(rec);
    const encoding = u16(rec + 2);
    const at = cmap.offset + u32(rec + 4);
    const format = u16(at);
    if (platform === 3 && encoding === 10 && format === 12) format12 = at;
    if (platform === 0 && format === 12 && format12 < 0) format12 = at;
    if (((platform === 3 && encoding === 1) || platform === 0) && format === 4 && format4 < 0) format4 = at;
  }
  const cache = new Map<number, number>();
  const glyphOf = (cp: number): number => {
    const hit = cache.get(cp);
    if (hit !== undefined) return hit;
    let gid = 0;
    if (format12 >= 0) {
      const groups = u32(format12 + 12);
      for (let g = 0; g < groups; g++) {
        const at = format12 + 16 + g * 12;
        const start = u32(at);
        const end = u32(at + 4);
        if (cp >= start && cp <= end) {
          gid = u32(at + 8) + (cp - start);
          break;
        }
      }
    } else if (format4 >= 0 && cp <= 0xffff) {
      const segX2 = u16(format4 + 6);
      const ends = format4 + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        if (cp > u16(ends + s)) continue;
        const start = u16(starts + s);
        if (cp < start) break;
        const range = u16(ranges + s);
        const delta = u16(deltas + s);
        if (range === 0) gid = (cp + delta) & 0xffff;
        else {
          const g = u16(ranges + s + range + (cp - start) * 2);
          gid = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        break;
      }
    }
    cache.set(cp, gid);
    return gid;
  };

  const loca = table("loca");
  const glyf = table("glyf");
  const glyphRange = (gid: number): [number, number] =>
    longLoca
      ? [u32(loca.offset + gid * 4), u32(loca.offset + gid * 4 + 4)]
      : [u16(loca.offset + gid * 2) * 2, u16(loca.offset + gid * 2 + 2) * 2];

  function subset(used: Iterable<number>): Uint8Array {
    const keep = new Set<number>([0]);
    const queue = [...used].filter((g) => g > 0 && g < numGlyphs);
    while (queue.length > 0) {
      const gid = queue.pop() as number;
      if (keep.has(gid)) continue;
      keep.add(gid);
      const [start, end] = glyphRange(gid);
      if (end <= start) continue;
      const at = glyf.offset + start;
      if (i16(at) >= 0) continue; // simple glyph
      // Composite: walk its components.
      let p = at + 10;
      for (;;) {
        const flags = u16(p);
        queue.push(u16(p + 2));
        p += 4 + (flags & 0x0001 ? 4 : 2);
        if (flags & 0x0008) p += 2;
        else if (flags & 0x0040) p += 4;
        else if (flags & 0x0080) p += 8;
        if (!(flags & 0x0020)) break;
      }
    }
    // New glyf (outlines only for kept glyphs, 4-byte aligned) and a long loca.
    const parts: Uint8Array[] = [];
    const offsets = new Uint32Array(numGlyphs + 1);
    let size = 0;
    for (let gid = 0; gid < numGlyphs; gid++) {
      offsets[gid] = size;
      if (!keep.has(gid)) continue;
      const [start, end] = glyphRange(gid);
      if (end <= start) continue;
      const data = bytes.subarray(glyf.offset + start, glyf.offset + end);
      const padded = (data.length + 3) & ~3;
      const copy = new Uint8Array(padded);
      copy.set(data);
      parts.push(copy);
      size += padded;
    }
    offsets[numGlyphs] = size;
    const newGlyf = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      newGlyf.set(p, at);
      at += p.length;
    }
    const newLoca = new Uint8Array((numGlyphs + 1) * 4);
    const lv = new DataView(newLoca.buffer);
    for (let i = 0; i <= numGlyphs; i++) lv.setUint32(i * 4, offsets[i] ?? 0);
    const newHead = bytes.slice(head.offset, head.offset + head.length);
    new DataView(newHead.buffer).setInt16(50, 1); // long loca
    new DataView(newHead.buffer).setUint32(8, 0); // checksum adjustment: not checked by PDF readers
    const raw = (tag: string) => {
      const t = tables.get(tag);
      return t ? bytes.subarray(t.offset, t.offset + t.length) : null;
    };
    const out: [string, Uint8Array][] = [];
    for (const tag of [
      "OS/2",
      "cvt ",
      "fpgm",
      "glyf",
      "head",
      "hhea",
      "hmtx",
      "loca",
      "maxp",
      "name",
      "post",
      "prep",
    ]) {
      const data = tag === "glyf" ? newGlyf : tag === "loca" ? newLoca : tag === "head" ? newHead : raw(tag);
      if (data) out.push([tag, data]);
    }
    return assemble(out);
  }

  return { name, unitsPerEm, ascent, descent, capHeight, bbox, glyphOf, advance, subset };
}

function checksum(data: Uint8Array) {
  let sum = 0;
  const padded = new Uint8Array((data.length + 3) & ~3);
  padded.set(data);
  const v = new DataView(padded.buffer);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

/** A TrueType file from tables (sorted by tag, 4-byte aligned). */
function assemble(tables: [string, Uint8Array][]): Uint8Array {
  tables.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const n = tables.length;
  let pow = 1;
  let log = 0;
  while (pow * 2 <= n) {
    pow *= 2;
    log++;
  }
  const headerSize = 12 + n * 16;
  let size = headerSize;
  for (const [, data] of tables) size += (data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, n);
  v.setUint16(6, pow * 16);
  v.setUint16(8, log);
  v.setUint16(10, n * 16 - pow * 16);
  let offset = headerSize;
  tables.forEach(([tag, data], i) => {
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[rec + k] = tag.charCodeAt(k);
    v.setUint32(rec + 4, checksum(data));
    v.setUint32(rec + 8, offset);
    v.setUint32(rec + 12, data.length);
    out.set(data, offset);
    offset += (data.length + 3) & ~3;
  });
  return out;
}

/**
 * Joins two AAC recordings into one `.m4a`, in plain TypeScript. A recorder's file can only be played once it is
 * stopped, so pausing to listen ends a stretch and going on starts another; what is sent has to be one file. Both come
 * from the same recorder settings, so the first file's sample description holds for all of it: its samples are
 * copied in order into one chunk, and the tables that index them are written anew.
 */
const TEXT = new TextDecoder("latin1");

interface Box {
  type: string;
  /** The box's content, past its header. */
  start: number;
  end: number;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function boxes(file: Uint8Array, from: number, to: number): Box[] {
  const v = view(file);
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = v.getUint32(at);
    const type = TEXT.decode(file.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) throw new Error("m4a: bad box");
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

function find(file: Uint8Array, within: Box | null, type: string): Box {
  const box = boxes(file, within?.start ?? 0, within?.end ?? file.length).find((b) => b.type === type);
  if (!box) throw new Error(`m4a: no ${type}`);
  return box;
}

interface Track {
  moov: Box;
  trak: Box;
  mdia: Box;
  stbl: Box;
  /** Every sample, in order: where it is and how long it is. */
  offsets: number[];
  sizes: number[];
  /** `[count, delta]` runs. */
  deltas: [number, number][];
  /** In the track's own time scale. */
  duration: number;
}

function readTrack(file: Uint8Array): Track {
  const v = view(file);
  const moov = find(file, null, "moov");
  const trak = find(file, moov, "trak");
  const mdia = find(file, trak, "mdia");
  const stbl = find(file, find(file, mdia, "minf"), "stbl");

  const stsz = find(file, stbl, "stsz");
  const fixed = v.getUint32(stsz.start + 4);
  const count = v.getUint32(stsz.start + 8);
  const sizes = Array.from({ length: count }, (_, i) => fixed || v.getUint32(stsz.start + 12 + i * 4));

  const stts = find(file, stbl, "stts");
  const deltas: [number, number][] = [];
  for (let i = 0, n = v.getUint32(stts.start + 4); i < n; i++) {
    deltas.push([v.getUint32(stts.start + 8 + i * 8), v.getUint32(stts.start + 12 + i * 8)]);
  }

  const inner = boxes(file, stbl.start, stbl.end);
  const wide = inner.find((b) => b.type === "co64");
  const stco = wide ?? find(file, stbl, "stco");
  const chunks = v.getUint32(stco.start + 4);
  const chunkAt = (i: number) =>
    wide ? Number(v.getBigUint64(stco.start + 8 + i * 8)) : v.getUint32(stco.start + 8 + i * 4);

  const stsc = find(file, stbl, "stsc");
  const runs = v.getUint32(stsc.start + 4);
  const offsets: number[] = [];
  let sample = 0;
  for (let run = 0; run < runs; run++) {
    const first = v.getUint32(stsc.start + 8 + run * 12) - 1;
    const perChunk = v.getUint32(stsc.start + 12 + run * 12);
    const next = run + 1 < runs ? v.getUint32(stsc.start + 8 + (run + 1) * 12) - 1 : chunks;
    for (let chunk = first; chunk < next; chunk++) {
      let at = chunkAt(chunk);
      for (let i = 0; i < perChunk && sample < count; i++) {
        offsets.push(at);
        at += sizes[sample] ?? 0;
        sample++;
      }
    }
  }
  if (offsets.length !== count) throw new Error("m4a: tables disagree");
  const duration = deltas.reduce((sum, [n, delta]) => sum + n * delta, 0);
  return { moov, trak, mdia, stbl, offsets, sizes, deltas, duration };
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  view(out).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const words = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  const v = view(out);
  values.forEach((value, i) => {
    v.setUint32(i * 4, value);
  });
  return out;
};

const raw = (file: Uint8Array, b: Box) => {
  const header = file.subarray(b.start - 8, b.start);
  return box(TEXT.decode(header.subarray(4)), file.subarray(b.start, b.end));
};

/** A duration field of a `mvhd`, `tkhd` or `mdhd` copy, version 0 or 1. */
function setDuration(content: Uint8Array, at32: number, at64: number, value: number) {
  const v = view(content);
  if (content[0] === 1) v.setBigUint64(at64, BigInt(value));
  else v.setUint32(at32, value);
}

/** Joined samples of `a` then `b`, in a new file. Throws on anything it can't read: the caller keeps both files. */
export function joinM4a(a: Uint8Array, b: Uint8Array): Uint8Array {
  const first = readTrack(a);
  const second = readTrack(b);
  const v = view(a);
  const mdhd = find(a, first.mdia, "mdhd");
  const mvhd = find(a, first.moov, "mvhd");
  const version = a[mdhd.start];
  const trackScale = v.getUint32(mdhd.start + (version === 1 ? 20 : 12));
  const movieScale = v.getUint32(mvhd.start + (a[mvhd.start] === 1 ? 20 : 12));
  const secondScale = view(b).getUint32(
    find(b, second.mdia, "mdhd").start + (b[find(b, second.mdia, "mdhd").start] === 1 ? 20 : 12),
  );
  if (secondScale !== trackScale) throw new Error("m4a: different time scales");

  const sizes = [...first.sizes, ...second.sizes];
  const dataSize = sizes.reduce((sum, s) => sum + s, 0);
  const trackDuration = first.duration + second.duration;
  const movieDuration = Math.round((trackDuration / trackScale) * movieScale);

  const deltas = [...first.deltas, ...second.deltas];
  const stts = box("stts", words(0, deltas.length, ...deltas.flat()));
  const stsz = box("stsz", words(0, 0, sizes.length, ...sizes));
  const stsc = box("stsc", words(0, 1, 1, sizes.length, 1));
  const stsd = raw(a, find(a, first.stbl, "stsd"));
  const build = (dataAt: number) => {
    const stco = box("stco", words(0, 1, dataAt));
    const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
    const minfBox = find(a, first.mdia, "minf");
    const minf = box(
      "minf",
      ...boxes(a, minfBox.start, minfBox.end).map((c) => (c.type === "stbl" ? stbl : raw(a, c))),
    );
    const mdia = box(
      "mdia",
      ...boxes(a, first.mdia.start, first.mdia.end).map((c) => {
        if (c.type === "minf") return minf;
        if (c.type !== "mdhd") return raw(a, c);
        const copy = a.slice(c.start, c.end);
        setDuration(copy, 16, 24, trackDuration);
        return box("mdhd", copy);
      }),
    );
    // An edit list describes the old length, and players read a track fine without one.
    const trak = box(
      "trak",
      ...boxes(a, first.trak.start, first.trak.end)
        .filter((c) => c.type !== "edts")
        .map((c) => {
          if (c.type === "mdia") return mdia;
          if (c.type !== "tkhd") return raw(a, c);
          const copy = a.slice(c.start, c.end);
          setDuration(copy, 20, 28, movieDuration);
          return box("tkhd", copy);
        }),
    );
    return box(
      "moov",
      ...boxes(a, first.moov.start, first.moov.end).map((c) => {
        if (c.type === "trak") return trak;
        if (c.type !== "mvhd") return raw(a, c);
        const copy = a.slice(c.start, c.end);
        setDuration(copy, 16, 24, movieDuration);
        return box("mvhd", copy);
      }),
    );
  };

  const ftyp = raw(a, find(a, null, "ftyp"));
  // The table's size doesn't depend on the number it holds, so a first pass gives where the data lands.
  const moov = build(ftyp.length + build(0).length + 8);
  const out = new Uint8Array(ftyp.length + moov.length + 8 + dataSize);
  const outView = view(out);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  const mdatAt = ftyp.length + moov.length;
  outView.setUint32(mdatAt, 8 + dataSize);
  out.set([0x6d, 0x64, 0x61, 0x74], mdatAt + 4);
  let at = mdatAt + 8;
  const copy = (file: Uint8Array, track: Track) => {
    track.offsets.forEach((offset, i) => {
      const size = track.sizes[i] ?? 0;
      out.set(file.subarray(offset, offset + size), at);
      at += size;
    });
  };
  copy(a, first);
  copy(b, second);
  return out;
}

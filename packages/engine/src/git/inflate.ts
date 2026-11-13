/**
 * A small DEFLATE decoder (RFC 1951, after zlib's `puff`). Node's zlib can't
 * tell how many input bytes a stream used, and a git pack is many zlib
 * streams back to back with no lengths, so walking a pack needs this.
 * With `keep: false` only the last 32 KiB are kept (enough for back
 * references): blobs are skipped without holding them in memory.
 */

const LENS = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTS = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const WINDOW = 32768;

export class InflateError extends Error {}

interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

function construct(lengths: ArrayLike<number>, n: number, offset = 0): Huffman {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  for (let s = 0; s < n; s++) count[lengths[offset + s] as number] = (count[lengths[offset + s] as number] ?? 0) + 1;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = (offs[len] as number) + (count[len] as number);
  for (let s = 0; s < n; s++) {
    const len = lengths[offset + s] as number;
    if (len !== 0) {
      const at = offs[len] as number;
      symbol[at] = s;
      offs[len] = at + 1;
    }
  }
  return { count, symbol };
}

let FIXED: { lencode: Huffman; distcode: Huffman } | null = null;
function fixed() {
  if (FIXED) return FIXED;
  const lengths = new Uint8Array(288 + 30);
  for (let s = 0; s < 144; s++) lengths[s] = 8;
  for (let s = 144; s < 256; s++) lengths[s] = 9;
  for (let s = 256; s < 280; s++) lengths[s] = 7;
  for (let s = 280; s < 288; s++) lengths[s] = 8;
  for (let s = 288; s < 318; s++) lengths[s] = 5;
  FIXED = { lencode: construct(lengths, 288), distcode: construct(lengths, 30, 288) };
  return FIXED;
}

class State {
  pos: number;
  bitbuf = 0;
  bitcnt = 0;
  out: Uint8Array;
  n = 0;
  constructor(
    readonly src: Uint8Array,
    start: number,
    readonly keep: boolean,
    readonly maxOut: number,
  ) {
    this.pos = start;
    this.out = new Uint8Array(keep ? 1024 : WINDOW);
  }
  bits(need: number) {
    let val = this.bitbuf;
    while (this.bitcnt < need) {
      if (this.pos >= this.src.length) throw new InflateError("unexpected end of data");
      val |= (this.src[this.pos++] as number) << this.bitcnt;
      this.bitcnt += 8;
    }
    this.bitbuf = val >>> need;
    this.bitcnt -= need;
    return val & ((1 << need) - 1);
  }
  put(byte: number) {
    if (this.n >= this.maxOut) throw new InflateError("object too large");
    if (this.keep) {
      if (this.n === this.out.length) {
        const bigger = new Uint8Array(this.out.length * 2);
        bigger.set(this.out);
        this.out = bigger;
      }
      this.out[this.n] = byte;
    } else this.out[this.n & (WINDOW - 1)] = byte;
    this.n++;
  }
  back(dist: number) {
    if (dist > this.n || dist > WINDOW) throw new InflateError("distance too far back");
    const i = this.n - dist;
    return this.out[this.keep ? i : i & (WINDOW - 1)] as number;
  }
  decode(h: Huffman) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.count[len] as number;
      if (code - count < first) return h.symbol[index + (code - first)] as number;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError("bad code");
  }
}

function stored(s: State) {
  s.bitbuf = 0;
  s.bitcnt = 0;
  if (s.pos + 4 > s.src.length) throw new InflateError("unexpected end of data");
  const len = (s.src[s.pos] as number) | ((s.src[s.pos + 1] as number) << 8);
  const nlen = (s.src[s.pos + 2] as number) | ((s.src[s.pos + 3] as number) << 8);
  if (len !== (~nlen & 0xffff)) throw new InflateError("bad stored block");
  s.pos += 4;
  if (s.pos + len > s.src.length) throw new InflateError("unexpected end of data");
  for (let i = 0; i < len; i++) s.put(s.src[s.pos++] as number);
}

function codes(s: State, lencode: Huffman, distcode: Huffman) {
  for (;;) {
    let symbol = s.decode(lencode);
    if (symbol < 256) s.put(symbol);
    else if (symbol === 256) return;
    else {
      symbol -= 257;
      if (symbol >= 29) throw new InflateError("bad length");
      const len = (LENS[symbol] as number) + s.bits(LEXT[symbol] as number);
      const d = s.decode(distcode);
      if (d >= 30) throw new InflateError("bad distance");
      const dist = (DISTS[d] as number) + s.bits(DEXT[d] as number);
      for (let i = 0; i < len; i++) s.put(s.back(dist));
    }
  }
}

function dynamic(s: State) {
  const nlen = s.bits(5) + 257;
  const ndist = s.bits(5) + 1;
  const ncode = s.bits(4) + 4;
  if (nlen > 286 || ndist > 30) throw new InflateError("bad counts");
  const lengths = new Uint8Array(320);
  for (let i = 0; i < ncode; i++) lengths[ORDER[i] as number] = s.bits(3);
  const lencode = construct(lengths, 19);
  const all = new Uint8Array(nlen + ndist);
  let index = 0;
  while (index < nlen + ndist) {
    const symbol = s.decode(lencode);
    if (symbol < 16) all[index++] = symbol;
    else {
      let len = 0;
      let repeat: number;
      if (symbol === 16) {
        if (index === 0) throw new InflateError("repeat with no first length");
        len = all[index - 1] as number;
        repeat = 3 + s.bits(2);
      } else if (symbol === 17) repeat = 3 + s.bits(3);
      else repeat = 11 + s.bits(7);
      if (index + repeat > nlen + ndist) throw new InflateError("too many lengths");
      while (repeat--) all[index++] = len;
    }
  }
  codes(s, construct(all, nlen), construct(all, ndist, nlen));
}

/** Raw DEFLATE from `start`: the output (or, with `keep: false`, only its size) and where the stream ended. */
export function inflateRaw(src: Uint8Array, start: number, options: { keep?: boolean; maxOut?: number } = {}) {
  const s = new State(src, start, options.keep ?? true, options.maxOut ?? 512 * 1024 * 1024);
  let last = 0;
  do {
    last = s.bits(1);
    const type = s.bits(2);
    if (type === 0) stored(s);
    else if (type === 1) codes(s, fixed().lencode, fixed().distcode);
    else if (type === 2) dynamic(s);
    else throw new InflateError("bad block type");
  } while (!last);
  return { data: s.keep ? s.out.subarray(0, s.n) : null, size: s.n, end: s.pos };
}

/** A zlib stream (2-byte header, DEFLATE, 4-byte Adler-32): output and the offset right after it. */
export function inflateZlib(src: Uint8Array, start: number, options: { keep?: boolean; maxOut?: number } = {}) {
  const cmf = src[start];
  const flg = src[start + 1];
  if (cmf === undefined || flg === undefined || (cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0) {
    throw new InflateError("not a zlib stream");
  }
  if (flg & 0x20) throw new InflateError("zlib dictionaries are not used by git");
  const raw = inflateRaw(src, start + 2, options);
  return { ...raw, end: raw.end + 4 };
}

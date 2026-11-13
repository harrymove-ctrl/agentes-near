import { CP850_HIGH } from "@agenteschat/client/lib/zip";

/** Archives built in tests, as the tools people export with write them (`tar`, Python's `tarfile`, zip). */
const enc = new TextEncoder();

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export interface TarEntry {
  name: string;
  data?: string | Uint8Array;
  /** ustar type flag: "0" file, "2" symlink, "5" folder, "x" pax header. */
  type?: string;
  link?: string;
}

/** A ustar archive, as `tar` and Python's `tarfile` write it. */
export function tar(entries: TarEntry[], { checksum = true } = {}) {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? enc.encode(e.data) : (e.data ?? new Uint8Array());
    const h = new Uint8Array(512);
    const put = (at: number, s: string) => h.set(enc.encode(s), at);
    put(0, e.name);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${data.length.toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, e.type ?? "0");
    if (e.link) put(157, e.link);
    put(257, "ustar\0");
    put(263, "00");
    const sum = h.reduce((a, b) => a + b, 0) + (checksum ? 0 : 1);
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return concat(blocks);
}

/** A pax header record for a path longer than the 100 bytes of a ustar name. */
export function paxPath(path: string): TarEntry {
  const body = ` path=${path}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length++;
  return { name: "PaxHeader/long", type: "x", data: `${length}${body}` };
}

/** A .zip with stored entries; `sizes` can lie about an entry's unpacked size, as a zip bomb does. */
export function zip(
  files: Record<string, string | Uint8Array>,
  sizes: Record<string, number> = {},
  options: { deflate?: boolean; cp437?: boolean } = {},
) {
  const flags = options.cp437 ? 0 : 0x800;
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const [name, content] of Object.entries(files)) {
    // As old Windows tools write names: CP850, the UTF-8 flag clear.
    const n = options.cp437
      ? Uint8Array.from(name, (c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 128 + CP850_HIGH.indexOf(c)))
      : enc.encode(name);
    const raw = typeof content === "string" ? enc.encode(content) : content;
    const size = sizes[name] ?? raw.length;
    const d = options.deflate ? Bun.deflateSync(raw.slice()) : raw;
    const method = options.deflate ? 8 : 0;
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(flags),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(d.length),
      ...u32(size),
      ...u16(n.length),
      ...u16(0),
    ]);
    parts.push(local, n, d);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(flags),
        ...u16(method),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(d.length),
        ...u32(size),
        ...u16(n.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      n,
    );
    offset += local.length + n.length + d.length;
  }
  const cd = concat(central);
  const count = Object.keys(files).length;
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(count),
    ...u16(count),
    ...u32(cd.length),
    ...u32(offset),
    ...u16(0),
  ]);
  return concat([...parts, cd, end]);
}

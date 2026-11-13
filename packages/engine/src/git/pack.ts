import { createHash } from "node:crypto";
import { inflateZlib } from "./inflate";

export const ZERO_OID = "0".repeat(40);

/** One ref update a `git push` asks for. */
export interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * The commands at the start of a `git-receive-pack` request: pkt-lines
 * (`<old> <new> <ref>`, capabilities after a NUL on the first) up to a flush,
 * then the pack. Returns where the pack starts.
 */
export function parseReceivePackRequest(body: Uint8Array): {
  commands: RefCommand[];
  packStart: number;
  pushOptions: boolean;
  capabilities: string[];
} {
  const commands: RefCommand[] = [];
  let pos = 0;
  let pushOptions = false;
  let capabilities: string[] = [];
  const text = new TextDecoder();
  for (;;) {
    if (pos + 4 > body.length) throw new Error("truncated push request");
    const len = Number.parseInt(text.decode(body.subarray(pos, pos + 4)), 16);
    if (Number.isNaN(len)) throw new Error("bad pkt-line");
    if (len === 0) {
      pos += 4;
      break;
    }
    if (len < 4 || pos + len > body.length) throw new Error("bad pkt-line length");
    let line = text.decode(body.subarray(pos + 4, pos + len));
    pos += len;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      capabilities = line
        .slice(nul + 1)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (capabilities.includes("push-options")) pushOptions = true;
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, "");
    if (line.startsWith("shallow ") || line.startsWith("push-cert")) continue;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (!m) throw new Error("bad push command");
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  // Push options (when negotiated) come as another pkt-line section before the pack.
  if (pushOptions) {
    for (;;) {
      if (pos + 4 > body.length) break;
      const len = Number.parseInt(text.decode(body.subarray(pos, pos + 4)), 16);
      pos += len === 0 ? 4 : len;
      if (len === 0) break;
    }
  }
  return { commands, packStart: pos, pushOptions, capabilities };
}

export interface PackCommit {
  oid: string;
  parents: string[];
}

/** Object count and the commits (with their parents) in a pack; deltified commits are counted but not read. */
export function readPack(
  data: Uint8Array,
  start = 0,
  options: { maxObjects?: number; maxInflatedBytes?: number; maxCommitBytes?: number } = {},
) {
  if (data.length - start === 0) return { objects: 0, commits: [] as PackCommit[] };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (new TextDecoder().decode(data.subarray(start, start + 4)) !== "PACK") throw new Error("not a pack");
  const version = view.getUint32(start + 4);
  if (version !== 2 && version !== 3) throw new Error("unsupported pack version");
  const count = view.getUint32(start + 8);
  if (count > (options.maxObjects ?? 1_000_000)) throw new Error("too many objects");
  let pos = start + 12;
  let inflatedTotal = 0;
  const commits: PackCommit[] = [];
  for (let i = 0; i < count; i++) {
    if (pos >= data.length) throw new Error("truncated pack object");
    let c = data[pos++] as number;
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) {
      if (pos >= data.length || shift > 49) throw new Error("invalid pack object size");
      c = data[pos++] as number;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > (options.maxInflatedBytes ?? 128 * 1024 * 1024) - inflatedTotal
    )
      throw new Error("pack exceeds uncompressed size limit");
    if (type === 1 && size > (options.maxCommitBytes ?? 2 * 1024 * 1024)) throw new Error("commit exceeds size limit");
    if (type === 6) {
      // OFS_DELTA: a variable-length offset to the base.
      do c = data[pos++] as number;
      while (c & 0x80);
    } else if (type === 7) pos += 20; // REF_DELTA: the base's id.
    const isCommit = type === 1;
    const inflated = inflateZlib(data, pos, { keep: isCommit, maxOut: Math.max(size, 1) });
    if (inflated.size !== size) throw new Error("pack object size mismatch");
    inflatedTotal += inflated.size;
    pos = inflated.end;
    if (isCommit && inflated.data) {
      const header = new TextEncoder().encode(`commit ${inflated.data.length}\0`);
      const oid = createHash("sha1").update(header).update(inflated.data).digest("hex");
      const head = new TextDecoder().decode(inflated.data.subarray(0, Math.min(inflated.data.length, 64 * 1024)));
      // Parents as git reads them (`parse_commit_buffer`): only the `parent` lines right after the `tree` line. Git
      // ignores a `parent` line anywhere else, so counting it would pass a root commit off as a fast-forward.
      const lines = head.split("\n");
      const parents: string[] = [];
      for (const line of /^tree [0-9a-f]{40}$/.test(lines[0] ?? "") ? lines.slice(1) : []) {
        const p = /^parent ([0-9a-f]{40})$/.exec(line);
        if (!p) break;
        parents.push(p[1] as string);
      }
      commits.push({ oid, parents });
    }
  }
  return { objects: count, commits };
}

/**
 * Whether `newOid` descends from `oldOid` using the commits of the pack.
 * `outside` lists commits the walk reached that aren't in the pack (they
 * exist upstream): the caller asks GitHub about those.
 */
export function walkToOld(commits: PackCommit[], oldOid: string, newOid: string) {
  const byId = new Map(commits.map((c) => [c.oid, c]));
  const seen = new Set<string>();
  const outside = new Set<string>();
  const queue = [newOid];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === oldOid) return { reached: true, outside: [] as string[] };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = byId.get(oid);
    if (!commit) {
      outside.add(oid);
      continue;
    }
    queue.push(...commit.parents);
  }
  return { reached: false, outside: [...outside] };
}

/** pkt-line encoding (for error replies). */
export const pkt = (line: string) => {
  const bytes = new TextEncoder().encode(line);
  return `${(bytes.length + 4).toString(16).padStart(4, "0")}${line}`;
};

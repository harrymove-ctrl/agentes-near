/**
 * Bytes served in parts (`Range: bytes=a-b`), so a player starts at once and jumps anywhere without fetching the whole
 * file first: voice clips and uploaded videos.
 */

/** `bytes=a-b` of an object of `size`: where it starts and ends; null when absent; "bad" when it can't be served. */
export function rangeOf(header: string | undefined, size: number): { start: number; end: number } | "bad" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return "bad";
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start > end || start >= size ? "bad" : { start, end };
}

/**
 * `bytes` with `headers`, whole (200) or the part `range` asks for (206); 416 for a part that isn't there. Always says
 * it takes ranges.
 */
export function rangedResponse(bytes: Uint8Array, range: string | undefined, headers: Record<string, string>) {
  const size = bytes.length;
  const all = { ...headers, "accept-ranges": "bytes" };
  const part = rangeOf(range, size);
  if (part === "bad") {
    return new Response(null, { status: 416, headers: { ...all, "content-range": `bytes */${size}` } });
  }
  if (!part) {
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { ...all, "content-length": String(size) } });
  }
  const slice = bytes.subarray(part.start, part.end + 1);
  return new Response(slice as Uint8Array<ArrayBuffer>, {
    status: 206,
    headers: {
      ...all,
      "content-length": String(slice.length),
      "content-range": `bytes ${part.start}-${part.end}/${size}`,
    },
  });
}

/** Reserved system-mode TCP ports, outside Linux's usual ephemeral range. */
export const BROWSER_PORT_FIRST = 10_000;
export const BROWSER_PORT_LAST = 29_999;
export const BROWSER_UID_BUCKET = 10_000;

export type BrowserPorts = { cdp: number; stream: number };

/** A UID's pair is permanent within its 10,000-UID bucket, including across runner restarts. */
export function browserPortsForUid(uid: number): BrowserPorts {
  if (!Number.isInteger(uid) || uid < 1000 || uid > 59_999) throw new Error(`Invalid agent uid ${uid}`);
  const first = BROWSER_PORT_FIRST + 2 * (uid % BROWSER_UID_BUCKET);
  return { cdp: first, stream: first + 1 };
}

/** A host's configured UID range must map injectively into the reserved pair range. */
export function validateBrowserUidRange([first, last]: [number, number]) {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1000 ||
    last > 59_999 ||
    first > last ||
    Math.floor(first / BROWSER_UID_BUCKET) !== Math.floor(last / BROWSER_UID_BUCKET)
  ) {
    throw new Error("System agent uid range must fit within one 10,000-uid block for browser port isolation");
  }
}

/**
 * The browser pairs of a computer's uid range, first to last: no agent may bind in it but on its own pair. The
 * Cloud's 20000-20999 gives 10000-11999, which leaves the Kotlin daemon's 17001-17999 free.
 */
export function browserBand(range: [number, number]): [number, number] {
  validateBrowserUidRange(range);
  return [browserPortsForUid(range[0]).cdp, browserPortsForUid(range[1]).stream];
}

/** Where Linux keeps the range bind(0) picks from, for IPv4 and IPv6 alike. */
export const EPHEMERAL_RANGE_FILE = "/proc/sys/net/ipv4/ip_local_port_range";

/** `bind(0)` must never be handed a port in the band: the bind policy only sees the port 0 it was asked for. */
export function checkEphemeralRange(text: string, [bandFirst, bandLast]: [number, number]) {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  if (!match || first < 1 || last > 65_535 || first > last) {
    throw new Error("Cannot read Linux's ip_local_port_range for browser port isolation");
  }
  if (first <= bandLast && last >= bandFirst) {
    throw new Error(
      `Linux's ephemeral port range ${first}-${last} overlaps reserved browser ports ${bandFirst}-${bandLast}`,
    );
  }
}

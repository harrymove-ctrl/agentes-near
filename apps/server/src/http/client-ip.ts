/**
 * The client's address behind a reverse proxy. Shared by every route that
 * rate limits or records where a request came from.
 */
import { BlockList, isIP } from "node:net";
import { limitIp } from "@agenteschat/adapters";

/**
 * Loopback, private, shared (CGNAT, 100.64.0.0/10) and link-local addresses:
 * where a hosting platform's own proxies sit. Tailnet and LAN clients have
 * them too, so `clientIp` skips them only while a public hop is left.
 */
export function isInternal(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, "").match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** `TRUSTED_PROXIES` as the config parses it, built once per list. An entry that isn't an address or a range is skipped. */
const trustedLists = new WeakMap<readonly string[], BlockList>();
function trustedList(proxies: readonly string[]) {
  let list = trustedLists.get(proxies);
  if (list) return list;
  list = new BlockList();
  for (const entry of proxies) {
    const [address = "", bits] = entry.split("/");
    const family = isIP(address);
    if (!family) continue;
    const type = family === 6 ? "ipv6" : "ipv4";
    try {
      if (bits === undefined) list.addAddress(address, type);
      else list.addSubnet(address, Number(bits), type);
    } catch {
      // A prefix out of range.
    }
  }
  trustedLists.set(proxies, list);
  return list;
}

/**
 * The client's address: walking `x-forwarded-for` from the right (what
 * proxies appended), the first one that is neither internal nor one of
 * `TRUSTED_PROXIES` (a public proxy in front, such as Cloudflare's). When
 * every hop is, as for a tailnet client behind `tailscale serve`, the last one
 * that isn't a trusted proxy: the address the nearest proxy saw. Entries
 * further left, and `x-real-ip` while that header exists, come from the client
 * and can be anything, so they never key a limit. Without the header, the
 * `x-real-ip` a proxy may set.
 */
export function clientIp(
  forwardedFor: string | undefined,
  realIp: string | undefined,
  trustedProxies: readonly string[] | undefined,
): string {
  const hops = (forwardedFor ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const trusted = trustedProxies?.length ? trustedList(trustedProxies) : null;
  const isTrusted = (hop: string) => {
    const family = isIP(hop);
    return trusted !== null && family !== 0 && trusted.check(hop, family === 6 ? "ipv6" : "ipv4");
  };
  let nearest: string | undefined;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (isTrusted(hop)) continue;
    if (!isInternal(hop)) return hop;
    nearest ??= hop;
  }
  return nearest ?? hops.at(-1) ?? (realIp?.trim() || "unknown");
}

/** `clientIp` of a request's headers, past the proxies of `TRUSTED_PROXIES`. */
export const requestIp = (
  headers: { get(name: string): string | null | undefined },
  trustedProxies: readonly string[] | undefined,
) => clientIp(headers.get("x-forwarded-for") ?? undefined, headers.get("x-real-ip") ?? undefined, trustedProxies);

/** `limitIp` of a request's client: what every per-IP rate limit counts. */
export const requestLimitIp = (
  headers: { get(name: string): string | null | undefined },
  trustedProxies: readonly string[] | undefined,
) => limitIp(requestIp(headers, trustedProxies));

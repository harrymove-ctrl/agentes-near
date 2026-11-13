import { isIPv6 } from "node:net";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Throttling for our own endpoints (posting messages, WebSocket frames).
 * Sign-in has its own limiter inside Better Auth. Core: in-memory fixed
 * window, per process. Cloud: Redis.
 */
export interface RateLimiter {
  consume(key: string, rule: { limit: number; windowMs: number }): Promise<RateLimitResult>;
}

export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async consume(key, rule) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + rule.windowMs };
        windows.set(key, w);
      }
      w.count++;
      if (windows.size > 50_000) {
        for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
      }
      return {
        allowed: w.count <= rule.limit,
        remaining: Math.max(0, rule.limit - w.count),
        resetAt: new Date(w.resetAt),
      };
    },
  };
}

/**
 * The part of an address a rate limit counts: an IPv4 address whole, an IPv6 one by its /64, which one customer
 * usually holds whole (each of its 2^64 addresses would get a fresh count otherwise), as Better Auth counts its own.
 */
export function limitIp(ip: string): string {
  const address = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (!isIPv6(address)) return address;
  const [head = "", tail] = (address.split("%")[0] ?? "").toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // An IPv4 tail (`64:ff9b::192.0.2.1`) takes two groups' room.
  const room = 8 - left.length - right.reduce((n, group) => n + (group.includes(".") ? 2 : 1), 0);
  const groups = tail === undefined ? left : [...left, ...Array<string>(room).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

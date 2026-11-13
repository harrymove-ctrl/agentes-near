import { expect, test } from "bun:test";
import { limitIp } from "@agenteschat/adapters";
import { loadConfig } from "@agenteschat/config";
import { clientIp } from "../src/http/client-ip";

test("a public client behind a proxy that appends its own internal hop", () => {
  expect(clientIp("203.0.113.7, 100.64.0.2", undefined, undefined)).toBe("203.0.113.7");
  // Whatever the client put in front is never the key.
  expect(clientIp("10.9.8.7, 203.0.113.7, 100.64.0.2", "198.51.100.1", undefined)).toBe("203.0.113.7");
});

test("a tailnet client behind tailscale serve, which sets the header to the client alone", () => {
  expect(clientIp("100.101.102.103", undefined, undefined)).toBe("100.101.102.103");
  expect(clientIp("fd7a:115c:a1e0::9001:b818", undefined, undefined)).toBe("fd7a:115c:a1e0::9001:b818");
  // Nothing in front sets x-real-ip, so the client can: it must not pick its own key.
  expect(clientIp("100.101.102.103", "203.0.113.50", undefined)).toBe("100.101.102.103");
  // Behind a proxy that appends, a made-up internal address in front doesn't win either.
  expect(clientIp("10.0.0.1, 100.101.102.103", undefined, undefined)).toBe("100.101.102.103");
});

test("without x-forwarded-for, the x-real-ip a proxy sets", () => {
  expect(clientIp(undefined, " 198.51.100.4 ", undefined)).toBe("198.51.100.4");
  expect(clientIp("", undefined, undefined)).toBe("unknown");
});

test("TRUSTED_PROXIES: a public proxy in front (Cloudflare's) is walked past, never taken for the client", () => {
  const { TRUSTED_PROXIES } = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    AGENTES_SECRET: "x".repeat(48),
    TRUSTED_PROXIES: "173.245.48.0/20, 2400:cb00::/32",
  });
  // Without it, every visitor looks like the proxy and shares its counts.
  expect(clientIp("198.51.100.9, 173.245.48.5", undefined, undefined)).toBe("173.245.48.5");
  expect(clientIp("198.51.100.9, 173.245.48.5", undefined, TRUSTED_PROXIES)).toBe("198.51.100.9");
  expect(clientIp("2001:db8::9, 2400:cb00:2049::1", undefined, TRUSTED_PROXIES)).toBe("2001:db8::9");
  // What the client wrote further left still never counts.
  expect(clientIp("203.0.113.1, 198.51.100.9, 173.245.48.5", undefined, TRUSTED_PROXIES)).toBe("198.51.100.9");
  // A tailnet client behind a trusted proxy on the network: the client, not the proxy.
  expect(clientIp("100.101.102.103, 10.0.0.5", undefined, ["10.0.0.5"])).toBe("100.101.102.103");
  // An entry that isn't an address or a range is skipped, and the others still count.
  expect(clientIp("198.51.100.9, 173.245.48.5", undefined, ["cloudflare", "10.0.0.0/99", "173.245.48.0/20"])).toBe(
    "198.51.100.9",
  );
});

test("limitIp: IPv4 whole, IPv6 by its /64, however the address is written", () => {
  expect(limitIp("203.0.113.7")).toBe("203.0.113.7");
  expect(limitIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  const net = "2001:db8:1:2::/64";
  for (const ip of ["2001:db8:1:2:3:4:5:6", "2001:0DB8:0001:0002::9", "2001:db8:1:2::", "2001:db8:1:2:ffff::1"]) {
    expect(limitIp(ip)).toBe(net);
  }
  expect(limitIp("2001:db8:1:3::1")).not.toBe(net);
  expect(limitIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(limitIp("::1:2:3:4:5:6:7")).toBe("0:1:2:3::/64");
  expect(limitIp("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  expect(limitIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  expect(limitIp("unknown")).toBe("unknown");
});

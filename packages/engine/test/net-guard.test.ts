import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { OutboundAddressError } from "@agenteschat/adapters";
import { assertPublicHttpsUrl, isBlockedAddress, publicHttpsFetch } from "../src/net-guard";

/**
 * The SSRF guard must classify an address by what the socket connects to, not by
 * how it is spelled. IPv6 has several spellings of the same internal address
 * (hex IPv4-mapped, IPv4-compatible, fully expanded) that a prefix-string check
 * misses, which would let a typed-in URL reach loopback or the cloud metadata IP.
 */

test("blocks internal addresses in every IPv6 spelling", () => {
  const blocked = [
    // Controls that a prefix check already caught.
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "fd00:ec2::254",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    // Spellings a prefix check missed (regression cases).
    "::ffff:7f00:1", // hex IPv4-mapped 127.0.0.1
    "::ffff:a9fe:a9fe", // hex IPv4-mapped 169.254.169.254 (metadata)
    "0:0:0:0:0:0:0:1", // fully expanded loopback
    "0:0:0:0:0:ffff:127.0.0.1", // expanded IPv4-mapped
    "::7f00:1", // IPv4-compatible 127.0.0.1
    "::a9fe:a9fe", // IPv4-compatible 169.254.169.254
    "[::ffff:a9fe:a9fe]", // bracketed literal
  ];
  for (const ip of blocked) expect(isBlockedAddress(ip)).toBe(true);
});

test("still allows public addresses", () => {
  expect(isBlockedAddress("93.184.216.34")).toBe(false);
  expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false); // public IPv6 (Cloudflare DNS)
});

test("assertPublicHttpsUrl refuses a hex IPv4-mapped metadata literal", async () => {
  await expect(assertPublicHttpsUrl("https://[::ffff:a9fe:a9fe]/latest/meta-data/")).rejects.toThrow();
  await expect(assertPublicHttpsUrl("https://[0:0:0:0:0:0:0:1]/")).rejects.toThrow();
});

test("assertPublicHttpsUrl still accepts a public host", async () => {
  const url = await assertPublicHttpsUrl("https://example.com/mcp", async () => ["93.184.216.34"]);
  expect(url.hostname).toBe("example.com");
});

/**
 * `node:https`'s `request` as far as the guarded fetch uses it: what it was asked (its options and body), answered
 * with `reply` once the request ends. Nothing touches the network.
 */
function fakeHttps(reply: { status: number; headers?: Record<string, string>; body?: string }) {
  const sent: { options: Record<string, unknown>; body: unknown }[] = [];
  const request = ((options: Record<string, unknown>, callback: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(body?: unknown): void; destroy(error?: Error): void };
    req.destroy = (error) => {
      if (error) req.emit("error", error);
      req.emit("close");
    };
    req.end = (body) => {
      sent.push({ options, body });
      const res = Object.assign(new EventEmitter(), {
        statusCode: reply.status,
        headers: reply.headers ?? {},
        pause: () => {},
        resume: () => {},
        destroy: () => {},
      });
      queueMicrotask(() => {
        callback(res);
        if (reply.body) res.emit("data", Buffer.from(reply.body));
        res.emit("end");
        req.emit("close");
      });
    };
    return req;
  }) as unknown as typeof httpsRequest;
  return { request, sent };
}

const refusal = (work: Promise<unknown>) => work.then(() => null).catch((e: unknown) => e);

test("publicHttpsFetch (ADR 0144): an address on our own network is refused before any connection", async () => {
  const https = fakeHttps({ status: 200 });
  const resolved: Record<string, { address: string; family: number }[]> = {
    "vault.acme.example": [{ address: "10.0.0.5", family: 4 }],
    "split.acme.example": [
      { address: "93.184.216.34", family: 4 },
      { address: "::ffff:7f00:1", family: 6 },
    ],
  };
  const guarded = publicHttpsFetch({ resolve: async (host) => resolved[host] ?? [], request: https.request });
  for (const url of [
    "http://vault.acme.example/api",
    "https://user:pw@vault.acme.example/api",
    "https://localhost/api",
    "https://vault.corp.internal/api",
    "https://printer.local/api",
    "https://127.0.0.1/api",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::ffff:a9fe:a9fe]/",
    // A name that resolves to a private address, or to one among public ones.
    "https://vault.acme.example/identity/connect/token",
    "https://split.acme.example/api",
  ]) {
    expect(await refusal(guarded(url))).toBeInstanceOf(OutboundAddressError);
  }
  expect(https.sent).toEqual([]);
  // A name that doesn't resolve fails as a network failure does, not as a refused address.
  expect(await refusal(guarded("https://nowhere.acme.example/"))).toBeInstanceOf(TypeError);
});

test("publicHttpsFetch connects to the address it checked (IPv4 first), never follows a redirect", async () => {
  const https = fakeHttps({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' });
  const guarded = publicHttpsFetch({
    resolve: async () => [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ],
    request: https.request,
  });
  const res = await guarded("https://vault.acme.example/identity/connect/token?x=1", {
    method: "POST",
    headers: { accept: "application/json" },
    body: "grant_type=client_credentials",
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.json()).toEqual({ ok: true });
  const [first] = https.sent;
  expect(first?.options).toMatchObject({
    hostname: "vault.acme.example",
    servername: "vault.acme.example",
    method: "POST",
    path: "/identity/connect/token?x=1",
    headers: { accept: "application/json", "content-length": "29" },
  });
  expect(new TextDecoder().decode(first?.body as Uint8Array)).toBe("grant_type=client_credentials");
  // The socket's lookup answers only the pinned address, whatever the name resolves to by then.
  const lookup = first?.options.lookup as (
    host: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: unknown, family?: number) => void,
  ) => void;
  const pinned = await new Promise((resolve) => lookup("vault.acme.example", { all: true }, (_e, a) => resolve(a)));
  expect(pinned).toEqual([{ address: "93.184.216.34", family: 4 }]);

  const moved = publicHttpsFetch({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: fakeHttps({ status: 302, headers: { location: "https://169.254.169.254/" } }).request,
  });
  expect(await refusal(moved("https://vault.acme.example/api/sync"))).toBeInstanceOf(TypeError);
});

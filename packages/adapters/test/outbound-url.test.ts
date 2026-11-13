import { describe, expect, test } from "bun:test";
import { normalizeUrl, outboundUrlProblem, urlsIn } from "../src/outbound-url";

const code = (url: string, opts?: Parameters<typeof outboundUrlProblem>[1]) =>
  outboundUrlProblem(url, opts)?.code ?? null;

describe("outboundUrlProblem", () => {
  test("a plain docs address passes", () => {
    expect(code("https://docs.example.dev/api/issues?state=open", { privateText: ["anything"] })).toBeNull();
  });

  test("an address that appeared as is passes, even with a long token", () => {
    const url = `https://files.example.com/share/${"a".repeat(300)}?token=${"x".repeat(700)}`;
    const seen = new Set(urlsIn(`here: ${url}.`));
    expect(code(url, { seen: (u) => seen.has(u) })).toBeNull();
    expect(code(url)).toBe("outbound.long");
  });

  test("a 600-character query is too long", () => {
    expect(code(`https://collect.example.net/v?d=${"q".repeat(600)}`)).toBe("outbound.long");
  });

  test("a path segment over 200 characters is too long", () => {
    expect(code(`https://collect.example.net/${"z".repeat(201)}`)).toBe("outbound.long");
  });

  test("a key in an address is refused", () => {
    expect(code(`https://collect.example.net/v?d=sk-ant-${"k".repeat(30)}`)).toBe("outbound.credential");
    expect(code(`https://collect.example.net/v?d=${encodeURIComponent(`ghp_${"A".repeat(36)}`)}`)).toBe(
      "outbound.credential",
    );
    // GitHub's stateless App token (`ghs_<app id>_<JWT>`).
    const app = `ghs_123_eyJhbGciOiJSUzI1NiJ9.${"e".repeat(40)}.${"s-ig_".repeat(8)}`;
    expect(code(`https://collect.example.net/v?d=${app}`)).toBe("outbound.credential");
  });

  test("a presigned address with an AWS key id passes without private text, not with it", () => {
    const url =
      "https://bucket.s3.amazonaws.com/report.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261101%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=abc";
    expect(code(url)).toBeNull();
    expect(code(url, { privateText: [] })).toBe("outbound.credential");
  });

  test("private text copied into the query is refused; a short value is not", () => {
    const mail = "Your reset code is 448812. This link expires in 10 minutes, do not share it with anyone.";
    const leak = `https://x.io/v?c=${encodeURIComponent("448812 This link expires in 10 minutes")}`;
    expect(code(leak, { privateText: [mail] })).toBe("outbound.private_text");
    expect(code("https://x.io/v?c=448812", { privateText: [mail] })).toBeNull();
    // Case and whitespace don't hide it; `+` reads as a space.
    expect(code("https://x.io/v#THIS+LINK+expires+in+10++MINUTES", { privateText: [mail] })).toBe(
      "outbound.private_text",
    );
  });

  test("normalizeUrl: https, lowercase host, no fragment, no trailing slash", () => {
    expect(normalizeUrl("http://Example.COM/a/?b=1#frag")).toBe("https://example.com/a/?b=1");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("ftp://example.com")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { isolatedPage, PAGE_CSP, PAGE_SANDBOX } from "../src/lib/isolated-page";

describe("isolated pages", () => {
  test("a page never shares our origin and may use its own forms", () => {
    expect(PAGE_SANDBOX).toBe("allow-scripts allow-forms");
    expect(PAGE_SANDBOX).not.toContain("allow-same-origin");
    expect(PAGE_SANDBOX).not.toContain("allow-popups");
    expect(PAGE_SANDBOX).not.toContain("allow-top-navigation");
  });

  test("the policy leaves no way to the network", () => {
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).toContain("form-action 'none'");
    expect(PAGE_CSP).not.toContain("http");
    expect(PAGE_CSP).not.toContain("connect-src");
  });

  test("the policy comes first, whatever the page holds", () => {
    const start =
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><meta http-equiv="Content-Security-Policy"';
    for (const page of [
      "<h1>a</h1>",
      "<!doctype html><html lang=pt><head><title>x</title></head><body></body></html>",
      "<!-- <head> --><!doctype html><html><head></head><body><script>fetch('https://x.test')</script></body></html>",
      "  <!DOCTYPE html>\n<body>a</body>",
    ]) {
      const out = isolatedPage(page);
      expect(out.startsWith(start)).toBe(true);
      expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<!-- <head> -->") >>> 0);
    }
  });

  test("one doctype, and what we add goes before the page", () => {
    const out = isolatedPage("<!doctype html><p>a</p>", "<script>x()</script>");
    expect(out.match(/<!doctype/gi)).toHaveLength(1);
    expect(out.indexOf("x()")).toBeLessThan(out.indexOf("<p>a</p>"));
  });
});

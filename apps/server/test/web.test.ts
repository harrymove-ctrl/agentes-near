import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";

/**
 * One process serves the API and the built web app (apps/web → WEB_DIR).
 * Client-side routes fall back to
 * index.html; /api/* never does.
 */
let dir: string;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agentes-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  mkdirSync(join(dir, "runner"));
  writeFileSync(join(dir, "runner", "agentes-runner.mjs"), "#!/usr/bin/env node\nconsole.log('runner')");
  app = createApp({ edition: "cloud", version: "test", modules: [], pingDatabase: async () => {}, webDir: dir });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("web app serving", () => {
  test("serves built assets", async () => {
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
    // Mermaid's bundle is one of them, run by a sandboxed frame (an opaque origin) as a classic script: it must be
    // JavaScript and loadable from another origin.
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cross-origin-resource-policy")).toBeNull();
  });

  test("hashed assets open from disk; index.html is always revalidated", async () => {
    const asset = await app.request("/assets/app.js");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    for (const path of ["/", "/org/abc/c/def"]) {
      const res = await app.request(path);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("a build file that isn't there is a 404 nobody keeps, never index.html", async () => {
    for (const path of ["/assets/missing.js", "/assets/index-old.css"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).not.toContain('<div id="root">');
    }
  });

  test("client-side routes get index.html", async () => {
    for (const path of ["/", "/login", "/org/abc/c/def", "/invite/some-token"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  test("unknown API routes stay JSON 404s", async () => {
    const res = await app.request("/api/app/nothing-here");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("API answers are never stored, even at a path that ends like a file", async () => {
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    const missing = await app.request("/api/app/x.png");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  test("every response refuses framing and pins the base URI (clickjacking defense)", async () => {
    for (const path of ["/", "/login", "/api/health"]) {
      const res = await app.request(path);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
  });

  test("a frame on our pages can't navigate to another site", async () => {
    const policy = (await app.request("/")).headers.get("content-security-policy") ?? "";
    const frames = policy.split(";").find((d) => d.trim().startsWith("frame-src")) ?? "";
    expect(frames).toContain("blob:");
    expect(frames).not.toContain("*");
    expect(frames).not.toContain("https: ");
  });

  test("the runner bundle: JavaScript, revalidated, and never index.html when missing", async () => {
    const res = await app.request("/runner/agentes-runner.mjs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("runner");
    const missing = await app.request("/runner/other.mjs");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('<div id="root">');
  });
});

import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isStartPage, START_FILE } from "@agenteschat/adapters/browser-start";
import { chromeLaunchArgs, domainAllowed, isWebPage } from "../../runner/browser";
import { prepareStartPage, startLocale, unsafeStartFolder } from "../../runner/start-page";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

/** The agent's details the page carries, as its script reads them. */
const pageData = (html: string) =>
  JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/.exec(html)?.[1] ?? "null");

test("the start page is one self-contained file: no network, no other file, the agent's details inside", () => {
  const home = tempDir("start-page-");
  dirs.push(home);
  const dir = path.join(home, "start");
  const evil = { name: "</script><script>alert(1)</script>", handle: "ada" };
  const data = { locale: "pt-BR", egress: { ip: "8.8.8.8", country: "US" } };
  const file = prepareStartPage(dir, evil, data);
  expect(file).toBe(path.join(dir, START_FILE));
  const html = readFileSync(file, "utf8");
  // Chrome loads nothing beside a file:// page reliably: style, script, font and picture are all inside.
  expect(html).not.toMatch(/\b(src|href)="(?!data:)/);
  expect(html).not.toContain("{{");
  expect(html).toContain("data:font/woff2;base64,");
  expect(html).toContain("default-src 'none'");
  expect(html).not.toContain("https://");
  expect(html).not.toContain("fetch(");
  // A name can't close the script its details sit in.
  expect(html.match(/<\/script>/g)?.length).toBe(2);
  expect(pageData(html)).toMatchObject({ name: evil.name, locale: "pt-BR" });
  // Chrome reads the page's language from the markup: the agent's, and no Translate bubble over it.
  expect(html).toContain('<html lang="pt-BR" translate="no">');
  expect(html).toContain('<meta name="google" content="notranslate">');
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toMatch(/<a\b|<button\b/);
  // The desktop's band right below the window shows the agentes.chat logo: the page carries no second one, and
  // fades into that band's tone (desktop-look.ts's backdrop, 0.81 0.90 1.00).
  expect(html).not.toContain("agentes<b>.chat");
  expect(html).not.toContain("wallpaper.png");
  expect(html).toContain("linear-gradient(transparent,#cfe6ff)");
  // The same details: the file isn't written again. New ones: it is.
  const before = statSync(file).mtimeMs;
  prepareStartPage(dir, evil, data);
  expect(statSync(file).mtimeMs).toBe(before);
  prepareStartPage(dir, { name: "Ada", handle: "ada" }, { locale: "en", egress: null });
  expect(pageData(readFileSync(file, "utf8"))).toEqual({ name: "Ada", locale: "en", egress: null, flag: null });
  expect(readFileSync(file, "utf8")).toContain('<html lang="en" translate="no">');
});

test("the start page's folder: this user's and closed to others; on Windows the mode says nothing, so it isn't read", () => {
  const folder = (mode: number, uid = 501, directory = true) => ({ isDirectory: () => directory, uid, mode });
  expect(unsafeStartFolder(folder(0o755), "linux", 501)).toBe(false);
  expect(unsafeStartFolder(folder(0o750), "darwin", 501)).toBe(false);
  // Writable by the group or by everyone, someone else's, or not a folder at all.
  expect(unsafeStartFolder(folder(0o775), "linux", 501)).toBe(true);
  expect(unsafeStartFolder(folder(0o757), "linux", 501)).toBe(true);
  expect(unsafeStartFolder(folder(0o755, 0), "linux", 501)).toBe(true);
  expect(unsafeStartFolder(folder(0o755, 501, false), "linux", 501)).toBe(true);
  // Windows gives every ordinary folder 0o666 and no owner id.
  expect(unsafeStartFolder(folder(0o666, 0), "win32", undefined)).toBe(false);
  expect(unsafeStartFolder(folder(0o666, 0, false), "win32", undefined)).toBe(true);
});

test("Chrome opens on the start page file; it and Chrome's new tab page are the only pages the allowlist lets by", () => {
  expect(startLocale("pt-PT")).toBe("pt-BR");
  expect(startLocale("de")).toBe("en");
  expect(startLocale()).toBe("en");
  const file = `/opt/agentes-runner/browser/start/2001/${START_FILE}`;
  const url = pathToFileURL(file).href;
  for (const page of [url, "chrome://newtab/", "chrome://new-tab-page/"]) {
    expect(isStartPage(page)).toBe(true);
    expect(domainAllowed(page, ["example.com"])).toBe(true);
  }
  expect(domainAllowed("file:///etc/passwd", ["example.com"])).toBe(false);
  expect(domainAllowed("chrome-extension://mbgkclemiokgppkieijlfaoehgdjlhbl/start.html", ["example.com"])).toBe(false);
  // The agent itself never opens it: only web pages.
  expect(isWebPage(url)).toBe(false);
  expect(isWebPage("chrome://settings/")).toBe(false);
  const args = chromeLaunchArgs("156.0.1.2", "/profile", "linux", "en", true, undefined, 0, file, true);
  expect(args.at(-1)).toBe(url);
  // Google Chrome ignores extensions loaded from the command line: none is.
  expect(args.some((a) => a.startsWith("--load-extension"))).toBe(false);
  expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  // A page to open again (a move, a restart) wins over the start page.
  expect(chromeLaunchArgs("156.0.1.2", "/p", "linux", "en", true, "https://shop.example/", 0, file).at(-1)).toBe(
    "https://shop.example/",
  );
  expect(chromeLaunchArgs(null, "/profile")).not.toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
});

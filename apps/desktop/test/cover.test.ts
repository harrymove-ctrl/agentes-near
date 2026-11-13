import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coverTailnet } from "../src/control/local-server";
import { STUCK_STEPS_MS, stuckAction } from "../src/cover/stuck";
import { desktopEn } from "../src/i18n/keys.en";
import { desktopPtBR } from "../src/i18n/keys.pt-BR";

const COVER = join(import.meta.dir, "../src/cover");
const read = (file: string) => readFileSync(file, "utf8");

test("the cover names only fonts its own page loads (it doesn't load the app's styles)", () => {
  const sheets = [...read(join(COVER, "main.ts")).matchAll(/^import "([^"]+\.css)";$/gm)].map((m) =>
    read(Bun.resolveSync(m[1] as string, COVER)),
  );
  const loaded = sheets.flatMap((css) =>
    [...css.matchAll(/@font-face\s*{[^}]*?font-family:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  );
  const named = [...read(join(COVER, "cover.css")).matchAll(/font(?:-family)?:([^;]+);/g)].flatMap((m) =>
    [...(m[1] as string).matchAll(/"([^"]+)"/g)].map((q) => q[1]),
  );
  expect(named.length).toBeGreaterThan(0);
  for (const family of named) expect(loaded).toContain(family);
});

test("Tailscale off over the server here: the Mac's app, Windows' icon by the clock, the terminal elsewhere", () => {
  for (const app of [true, false]) {
    expect(coverTailnet("windows", { state: "off", app })).toBe("tailnetTray");
    expect(coverTailnet("linux", { state: "off", app })).toBe("tailnetUp");
  }
  expect(coverTailnet("mac", { state: "off", app: true })).toBe("openTailscale");
  // Only the command-line tool (Homebrew's): nothing to open, the command instead.
  expect(coverTailnet("mac", { state: "off", app: false })).toBe("tailnetUp");
  // Not read: its app.
  expect(coverTailnet("mac", null)).toBe("openTailscale");
  // What follows "Connect Tailscale on this PC to open agentes.chat.": no sudo on Windows, the command elsewhere.
  for (const { cover } of [desktopEn, desktopPtBR]) {
    expect(cover.openTailscale).toBeTruthy();
    expect(cover.tailnetTray).not.toMatch(/sudo|terminal/);
    expect(cover.tailnetUp).toContain("sudo tailscale up");
  }
});

test("a page that never paints while its server answers: loaded again, then with the cache cleared, then said", () => {
  const [reload, fresh, say] = STUCK_STEPS_MS;
  expect(stuckAction(reload - 1, 0)).toBeNull();
  expect(stuckAction(reload + 1, 0)).toEqual({ step: 1, action: "reload" });
  // Each step once per showing.
  expect(stuckAction(reload + 2, 1)).toBeNull();
  expect(stuckAction(fresh + 1, 1)).toEqual({ step: 2, action: "fresh" });
  expect(stuckAction(say + 1, 2)).toEqual({ step: 3, action: "say" });
  expect(stuckAction(say + 60_000, 3)).toBeNull();
  // A check that comes late still goes one step at a time: it loads again before it says anything.
  expect(stuckAction(say + 1, 0)).toEqual({ step: 1, action: "reload" });
  expect(stuckAction(say + 4_000, 1)).toEqual({ step: 2, action: "fresh" });
  for (const { cover } of [desktopEn, desktopPtBR]) {
    expect(cover.stuck).toBeTruthy();
    expect(cover.showAnyway).toBeTruthy();
  }
});

test("the cover never steps aside on its own while the page hasn't painted", () => {
  const main = read(join(COVER, "main.ts"));
  // Only the person's "Show it anyway" hides it; the old 15 s give-up left a blank window.
  expect(main.match(/invoke\("cover_hide"\)/g)).toHaveLength(1);
  expect(main).toContain('words.showAnyway, () => void invoke("cover_hide")');
});

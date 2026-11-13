import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import appConfig, { LEGACY_REDIRECTS } from "../app.config";

const APP = join(import.meta.dir, "..", "app");

describe("legacy routes", () => {
  test("the removed paths go to Conversas", () => {
    expect(LEGACY_REDIRECTS.map((r) => r.source).sort()).toEqual(["/chats", "/home"]);
    for (const r of LEGACY_REDIRECTS) expect(r.destination).toBe("/");
  });

  test("Conversas is the app's `/` and no redirect shadows a real route", () => {
    expect(existsSync(join(APP, "(app)", "(tabs)", "(chats)", "index.tsx"))).toBe(true);
    for (const r of LEGACY_REDIRECTS) {
      const name = r.source.slice(1);
      expect(existsSync(join(APP, `${name}.tsx`))).toBe(false);
      expect(existsSync(join(APP, "(app)", `${name}.tsx`))).toBe(false);
      expect(existsSync(join(APP, "(app)", "(tabs)", name))).toBe(false);
    }
  });

  test("the expo-router plugin carries them", () => {
    // biome-ignore lint/suspicious/noExplicitAny: the config's own type is loose here.
    const config = appConfig({ config: {} } as any);
    const router = config.plugins?.find((p) => Array.isArray(p) && p[0] === "expo-router");
    expect(router).toEqual(["expo-router", { redirects: LEGACY_REDIRECTS }]);
  });
});

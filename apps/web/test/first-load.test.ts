import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
const SOURCES = files(SRC).map((f) => ({ path: relative(SRC, f), code: readFileSync(f, "utf8") }));
/** The source files that import `name` (a module's file name, by its alias or a relative path). */
const importers = (name: string) =>
  SOURCES.filter((s) => new RegExp(`from "(?:@/[\\w/-]+|\\.{1,2}(?:/[\\w-]+)*)/${name}"`).test(s.code))
    .map((s) => s.path)
    .sort();

test("the computers' screens and the import load with their own pages, never with the app (#1)", () => {
  expect(importers("Machines")).toEqual(["components/devices/DevicePage.tsx", "components/devices/DevicesSection.tsx"]);
  expect(importers("DevicePage")).toEqual(["pages/SettingsPage.tsx"]);
  expect(importers("DevicesSection")).toEqual(["components/devices/DevicePage.tsx", "pages/SettingsPage.tsx"]);
  expect(importers("ImportFlow")).toEqual([
    "pages/NewAgentPage.tsx",
    "pages/SettingsPage.tsx",
    "pages/onboarding/TeamSourceBody.tsx",
  ]);
  // Pages only routes import, which the router splits out of the first load.
  for (const page of ["SettingsPage", "NewAgentPage", "OnboardingPage"])
    for (const by of importers(page)) expect({ page, by }).toEqual({ page, by: expect.stringMatching(/^routes\//) });
});

test("the onboarding's import loads when its team step shows it, never with the onboarding's first screens", () => {
  // Only `TeamSource`'s `lazy(() => import(…))` reaches the import's views and hook.
  expect(importers("TeamSourceBody")).toEqual([]);
  const light = SOURCES.find((s) => s.path === "pages/onboarding/TeamSource.tsx")?.code ?? "";
  expect(light).toContain('import("./TeamSourceBody")');
  // Types alone from the import's modules: their readers (every app's parser, the archive reader) stay behind.
  const heavy = /^import (?!type )[^;]*from "[^"]*\/(?:ImportFlow|import|import-flow|import\/[\w-]+)";/gm;
  expect(light.match(heavy)).toBeNull();
});

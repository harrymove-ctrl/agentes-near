import { describe, expect, test } from "bun:test";
import {
  browserTrailHosts,
  browserTrailKind,
  browserTrailOf,
  browserTrailPages,
  desktopTrailOf,
  isScreenTool,
} from "../src/browser";

const step = (tool: string, at: string, detail?: string) => ({ tool, at: `2026-10-24T12:${at}:00.000Z`, detail });

describe("what the agent did on its desktop (meta.desktop)", () => {
  test("read apart from the browser's steps, dropping anything malformed", () => {
    const meta = {
      browser: { steps: [step("browser_open", "01", "shop.example")] },
      desktop: { steps: [step("desktop_open", "02", "Files"), { tool: "desktop_read" }, "x"] },
    };
    expect(desktopTrailOf(meta)).toEqual([
      { tool: "desktop_open", detail: "Files", at: "2026-10-24T12:02:00.000Z", failed: false },
    ]);
    expect(browserTrailOf(meta).map((s) => s.tool)).toEqual(["browser_open"]);
    expect(desktopTrailOf({ desktop: { steps: "x" } })).toEqual([]);
    expect(desktopTrailOf(undefined)).toEqual([]);
  });

  test("grouped by the app each open started, whole names, never a link", () => {
    const steps = desktopTrailOf({
      desktop: {
        steps: [
          step("desktop_read", "00"),
          step("desktop_open", "01", "Text Editor/notes"),
          step("desktop_type", "02"),
          step("desktop_open_file", "03"),
          step("desktop_open", "04", "Files"),
          { ...step("desktop_double_click", "05"), failed: true },
        ],
      },
    });
    const pages = browserTrailPages(steps);
    expect(pages.map((p) => [p.site, p.host, p.path, p.link, p.steps.length])).toEqual([
      [null, null, "", false, 1],
      // An app's name is whole: a slash in it isn't a path.
      ["Text Editor/notes", "Text Editor/notes", "", false, 3],
      ["Files", "Files", "", false, 2],
    ]);
    expect(browserTrailHosts(steps)).toEqual(["Text Editor/notes", "Files"]);
    expect(steps.map(browserTrailKind)).toEqual(["read", "open", "act", "open", "open", "failed"]);
    expect(browserTrailKind({ tool: "desktop_screenshot", failed: false })).toBe("shot");
    // The browser's pages still are links.
    expect(
      browserTrailPages([{ tool: "browser_open", detail: "shop.example/a", at: "", failed: false }])[0],
    ).toMatchObject({ host: "shop.example", path: "/a", link: true });
  });

  test("a screen's tools, with or without the bridge's prefix", () => {
    expect(isScreenTool("desktop_do", "desktop")).toBe(true);
    expect(isScreenTool("mcp__agentes__desktop_read", "desktop")).toBe(true);
    expect(isScreenTool("desktop_do", "browser")).toBe(false);
    expect(isScreenTool("run_code", "desktop")).toBe(false);
    expect(isScreenTool(null, "desktop")).toBe(false);
  });
});

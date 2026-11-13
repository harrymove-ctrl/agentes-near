import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { en } from "@agenteschat/i18n";
import { toolActivity } from "../src/lib/activity";

const ENGINE = join(import.meta.dir, "../../engine/src");

/** Not tools a person reads about: the choice to stay silent, and an approval rule's own name. */
const NO_LINE = new Set(["pass", "command"]);

/** Every tool the engine defines: `name: "…"` in its tool files, the `*_TOOL` names, and `BUILTIN_TOOL_INFO`. */
function engineTools() {
  const names = new Set<string>();
  for (const file of readdirSync(ENGINE, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(ENGINE, file), "utf8");
    if (/tools?\b|tools\/|blocks|works/.test(file))
      for (const m of source.matchAll(/\bname:\s*"([a-z]+(?:_[a-z0-9]+)+)"/g)) names.add(m[1] ?? "");
    for (const m of source.matchAll(/export const [A-Z_]+_TOOL\s*=\s*"([a-z_]+)"/g)) names.add(m[1] ?? "");
  }
  const access = readFileSync(join(ENGINE, "access.ts"), "utf8");
  const info = access.slice(
    access.indexOf("BUILTIN_TOOL_INFO: Record"),
    access.indexOf("\n};", access.indexOf("BUILTIN_TOOL_INFO: Record")),
  );
  for (const m of info.matchAll(/^ {2}([a-z_]+): \{/gm)) names.add(m[1] ?? "");
  return [...names].filter((n) => !NO_LINE.has(n)).sort();
}

describe("the engine's tools and the words for them", () => {
  const tools = engineTools();

  test("the scan finds the engine's tools", () => {
    expect(tools.length).toBeGreaterThan(100);
    for (const name of ["web_search", "show_block", "send_dm", "vault_list"]) expect(tools).toContain(name);
  });

  test("each has its own line: never a made-up app, never the tool's raw name", () => {
    const unworded = tools.filter((name) => ["consulting", "usingTool"].includes(toolActivity(name).kind));
    expect(unworded).toEqual([]);
  });

  test("each line has words while it runs and once it is done", () => {
    const { activity, work } = en.chat;
    const kinds = new Set(tools.map((name) => toolActivity(name).kind));
    expect([...kinds].filter((k) => !(k in activity) || !(k in work.step))).toEqual([]);
  });

  test("a word before an underscore names no app: only a catalog connector's prefix or the event's label does", () => {
    expect(toolActivity("himetrica_get").kind).toBe("usingTool");
    expect(toolActivity("himetrica_get", "Himetrica")).toMatchObject({ kind: "consulting", app: "Himetrica" });
    expect(toolActivity("github_list_issues")).toMatchObject({ kind: "consulting", app: "GitHub" });
  });
});

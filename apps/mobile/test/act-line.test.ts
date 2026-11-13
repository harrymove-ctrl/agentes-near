import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("words and their actions wrap as the web's .ac-actline: the words from their one-line width, the action under them", () => {
  const line = readFileSync(join(SRC, "ui/ActLine.ts"), "utf8");
  expect(line).toContain('row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-start" }');
  expect(line).toContain('text: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 }');
  // The old row (an action at the row's end under words kept to 170) is gone everywhere.
  const old = files(SRC).filter((f) => /\bACT_ROW\b|from "\.\/ActRow"/.test(readFileSync(f, "utf8")));
  expect(old.map((f) => relative(SRC, f))).toEqual([]);
  for (const user of [
    "features/chat/TeamChecks.tsx",
    "features/chat/cards.tsx",
    "ui/SectionHeader.tsx",
    "features/agents/ImportAgents.tsx",
    "features/agents/NewAgentScreen.tsx",
    "features/push/PushOfferLine.tsx",
  ])
    expect(readFileSync(join(SRC, user), "utf8")).toContain("ACT_LINE.row");
});

test("an import's head keeps its name whole: Trocar arquivo beside it while it fits, under it otherwise", () => {
  const imp = readFileSync(join(SRC, "features/agents/ImportAgents.tsx"), "utf8");
  const head = imp.slice(
    imp.indexOf("<SourceMark card={origin.card} size={44} />"),
    imp.indexOf("onPress={imp.reset}"),
  );
  expect(head).toContain("<View style={[ACT_LINE.row, styles.line]}>");
  expect(head).not.toContain("numberOfLines");
});

test("a section's header: its way on beside the title while the title fits its line, under it otherwise, never cut", () => {
  const header = readFileSync(join(SRC, "ui/SectionHeader.tsx"), "utf8");
  expect(header).toContain("<View style={[ACT_LINE.row, styles.h]}>");
  expect(header).toContain("style={[ACT_LINE.text, styles.title]}");
  // The count is in the title's words, so a wrapped title keeps it on its last line.
  expect(header.indexOf("<Count")).toBeLessThan(header.indexOf("</Text>"));
  expect(header).not.toContain("numberOfLines");
  expect(header).not.toContain('marginLeft: "auto"');
});

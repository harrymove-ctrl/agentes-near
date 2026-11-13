import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CARD_PAD, GROUPED_ROW, SCREEN_X, TOOL_H, TOUCH } from "../src/ui/rhythm";

const SRC = join(import.meta.dir, "../src");
const source = (file: string) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("the phone's page rhythm: sides 16, cards 16 inside, a toolbar's controls 32 with a 44 target, grouped rows 52", () => {
  expect(SCREEN_X).toBe(16);
  expect(CARD_PAD).toBe(16);
  expect(TOOL_H).toBe(32);
  expect(TOUCH).toBe(44);
  // A wrapping row's label starts where a one-line row's does: its 22-point line centred in 52.
  expect(GROUPED_ROW).toEqual({ minHeight: 52, padX: 16, padY: 10, tallPadY: 15 });
});

test("the kit's screens, grouped rows and toolbar controls read those numbers instead of their own", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).not.toMatch(/minHeight: 50|paddingHorizontal: 14|\b14 \+ LEAD/);
  expect(grouped).toContain("minHeight: GROUPED_ROW.minHeight");
  expect(source("Segmented.tsx")).toContain("minHeight: TOOL_H - 2 * PAD");
  expect(source("Filters.tsx")).toContain("minHeight: TOOL_H");
  expect(source("Filters.tsx")).toContain("gap: 8");
  expect(source("LargeTitleScreen.tsx")).toContain("paddingHorizontal: SCREEN_X");
  expect(source("SectionHeader.tsx")).toContain("paddingHorizontal: SCREEN_X");
  expect(source("Row.tsx")).toContain("paddingHorizontal: CARD_PAD");
});

test("a small button and a card's footer button are the web's 32, their targets grown to 44 above and below only", () => {
  const button = source("Button.tsx");
  expect(button).toContain("const SMALL = { height: TOOL_H, radius: 10, padding: 12");
  expect(button).toMatch(/card: SMALL,\s*sm: SMALL,/);
  expect(button).toContain("const grow = (TOUCH - height) / 2;");
  expect(button).toContain("return grow > 0 ? { top: grow, bottom: grow } : undefined;");
  expect(button).toContain("hitSlop={slopOf(s.height)}");
  expect(source("HoldButton.tsx")).toContain("hitSlop={slopOf(s.height)}");
  // Nothing sizes a button of its own past the kit's sizes.
  const sized = files(SRC).filter((f) => /<(Button|HoldButton)\b[^>]*\bminHeight/.test(readFileSync(f, "utf8")));
  expect(sized.map((f) => relative(SRC, f))).toEqual([]);
});

test("a chip's label wraps inside it instead of ending in …, its icon on the first line; one line is the 24 pill", () => {
  const chip = source("Chip.tsx");
  const label = chip.slice(chip.indexOf("<RNText maxFontSizeMultiplier"), chip.indexOf("{label}"));
  expect(label).not.toContain("numberOfLines");
  expect(chip).toContain('alignItems: "flex-start"');
  expect(chip).toContain("paddingVertical: (HEIGHT - LINE) / 2");
  expect(chip).toContain("borderRadius: HEIGHT / 2");
  expect(chip).toContain('<View style={{ height: line, justifyContent: "center" }}>');
});

test("an icon button in a row or a heading is the toolbar's 32, its target still a finger's 44", () => {
  const button = source("IconButton.tsx");
  expect(button).toContain("const side = small ? TOOL_H : SIZE;");
  expect(button).toContain("hitSlop={small ? (TOUCH - TOOL_H) / 2 : 4}");
});

test("a strip that scrolls sideways under a screen's title runs edge to edge, its first item on the title's line", () => {
  expect(source("Filters.tsx")).toContain("paddingHorizontal: SCREEN_X");
  const tasks = readFileSync(join(SRC, "features/issues/IssuesScreen.tsx"), "utf8");
  expect(tasks).toContain("paddingLeft: SCREEN_X");
  expect(tasks).toContain("width - PEEK - SCREEN_X");
});

test("no screen keeps a 20-point side of its own: screens read SCREEN_X and cards CARD_PAD", () => {
  // A button's own padding isn't a screen's side.
  const NOT_A_SIDE = new Set(["ui/Button.tsx"]);
  const offenders = files(SRC)
    .filter((path) => !NOT_A_SIDE.has(relative(SRC, path)))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /\b(padding|paddingHorizontal|marginHorizontal): 20\b/.test(line) ? [`${relative(SRC, path)}:${i + 1}`] : [],
        ),
    );
  expect(offenders).toEqual([]);
});

test("a group's header can carry an ⓘ for the whole group, its text under the header", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).toMatch(/export function GroupedHeader\(\{ children, aside, hint \}/);
  expect(grouped).toContain('useInfoHint({ ...hint, variant: "footnote" })');
});

test("a row's ⓘ sits right after its label, and a short fact about its value goes on the value's line", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).toContain("<Row {...props} said={hint.text} labelAfter={info.button} />");
  expect(grouped).toMatch(/<View style=\{styles\.labelLine\}>\s*<Text variant="body"/);
  expect(grouped).toMatch(/\{valueNote \? \(\s*<Text variant="footnote" tone="faint" numberOfLines=\{1\}>/);
});

test("no screen keeps a grouped row of its own at the old 50: its rows and fields read GROUPED_ROW", () => {
  // Not a grouped list's rows: the chat's receipt cards (a 50 row around a 32 action), a new channel's bordered name
  // field and the sheets' title bars (Novo, Compartilhar).
  const CARD_ROWS = new Set([
    "features/chat/TeamChecks.tsx",
    "features/chat/ReachLines.tsx",
    "features/new/NewChannelForm.tsx",
    "features/new/parts.tsx",
    "features/new/NewScreen.tsx",
    "features/share/ShareScreen.tsx",
  ]);
  const offenders = files(join(SRC, "features"))
    .filter((path) => !CARD_ROWS.has(relative(SRC, path)))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) => (/\bminHeight: 50\b/.test(line) ? [`${relative(SRC, path)}:${i + 1}`] : [])),
    );
  expect(offenders).toEqual([]);
});

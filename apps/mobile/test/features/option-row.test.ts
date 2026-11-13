import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPTION_ROW } from "../../src/ui/option-row";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("OptionRow (#46, A11)", () => {
  test("the web's numbers on touch: a face of 24, 10 above and below it, a one-line row of 44", () => {
    expect(OPTION_ROW).toEqual({ face: 24, pad: 10, height: 44 });
    expect(OPTION_ROW.face + 2 * OPTION_ROW.pad).toBe(OPTION_ROW.height);
  });

  test("the composer's pickers: every row one size, the name and, muted on its line, the handle and the role", () => {
    const mention = src("features/chat/MentionPicker.tsx");
    expect(mention).toContain("const FACE = OPTION_ROW.face;");
    expect(mention).toContain("paddingVertical: OPTION_ROW.pad,");
    expect(mention).toContain("minHeight: OPTION_ROW.height,");
    // @todos leads with a glyph as wide as a face: its row is the others' size.
    expect(mention).toContain("everyone: { width: FACE, height: FACE");
    expect(mention).not.toContain("<View style={styles.tx}>");
    expect(src("features/chat/ChannelPicker.tsx")).toContain("minHeight: OPTION_ROW.height,");
  });

  test("every list to pick people or agents from draws its faces at that one size", () => {
    for (const file of [
      "features/issues/IssueScreen.tsx",
      "features/issues/NewIssueForm.tsx",
      "features/routines/RoutineForm.tsx",
      "features/chat/sheets.tsx",
      "features/vault/parts.tsx",
      "features/outages/SwitchComputerSheet.tsx",
    ]) {
      expect({ file, one: src(file).includes("size={OPTION_ROW.face}") }).toEqual({ file, one: true });
    }
    // The task's assignee sheet: no face of another size beside the one "Ninguém" leads with a glyph.
    expect(src("features/issues/IssueScreen.tsx")).not.toContain("<Face who={who} size={26}");
    expect(src("features/issues/NewIssueForm.tsx")).not.toContain("size={26}");
  });

  test("a task's Responsável shows who it is by their face, as a select shows its choice (#47)", () => {
    const screen = src("features/issues/IssueScreen.tsx");
    expect(screen).toMatch(
      /key: "assignee",[\s\S]{0,160}leading: <Face who=\{i\.assignee\} size=\{OPTION_ROW\.face\} live=\{false\} \/>/,
    );
    expect(screen).toContain(': { icon: "agent" as const }),');
    // The new task's Quem faz and a routine's agent lead with the chosen face too.
    expect(src("features/issues/NewIssueForm.tsx")).toContain(
      "leading={who ? <Face who={who} size={OPTION_ROW.face} live={false} /> : undefined}",
    );
    expect(src("features/routines/RoutineForm.tsx")).toContain(
      "leading={agent ? <AgentFace agentId={agent.id} size={OPTION_ROW.face} live={false} /> : undefined}",
    );
  });

  test("screens import it from the design system", () => {
    expect(src("ui/index.ts")).toContain('export { OPTION_ROW } from "./option-row";');
  });
});

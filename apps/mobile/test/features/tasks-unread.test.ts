import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");

describe("Tarefas in Você", () => {
  test("shows the red badge for a mention not read in a task's conversation, as Conversas does", () => {
    const me = source("me/MeScreen.tsx");
    expect(me).toContain("const tasksUnread = useTasksUnreadMarks();");
    expect(me).toContain("valueLeading: <MentionCount count={tasksUnread.mentions} />");
  });
});

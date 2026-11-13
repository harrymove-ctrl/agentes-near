import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const src = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("a routine's triggers, on the phone too", () => {
  test("a routine's email trigger offers only the mailboxes its agent reads, as the web's", () => {
    const form = src("features/routines/RoutineForm.tsx");
    expect(form).toContain("triggerChoices(");
    expect(form).toContain("useAgentMail(");
  });
});

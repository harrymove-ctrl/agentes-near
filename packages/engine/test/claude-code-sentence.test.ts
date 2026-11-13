import { expect, test } from "bun:test";
import { claudeCodeSentence } from "../src/sandbox-tools";

const SESSION = "11111111-1111-4111-8111-111111111111";

test("a computer someone connected keeps running Claude Code from the shell", () => {
  const text = claudeCodeSentence(SESSION, true);
  expect(text).toContain(`claude -p --session-id ${SESSION}`);
  expect(text).toContain('executor "claude"');
});

test("the workspace's own computer never sends an agent to a shell with no sign-in", () => {
  const text = claudeCodeSentence(SESSION, true, true);
  expect(text).not.toContain("claude -p");
  expect(text).toContain('start_task with executor "claude"');
  expect(text).toContain("never ask anyone to sign in");
});

test("without background tasks it offers nothing it can't do", () => {
  expect(claudeCodeSentence(SESSION, false, true)).not.toContain("start_task");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8").replace(/\s+/g, " ");

test("an agent my message named won't answer me: the phone hears why and says it over the composer, as the web", () => {
  const live = src("features/chat/live.ts");
  // My own topic's `agent.unavailable` for this conversation: the line, and that agent's "pensando…" goes.
  expect(live).toContain("isAgentUnavailable(event) && event.channelId === channelId");
  expect(live).toMatch(/dismissRun\(state\.streams, `pending:\$\{e\.agentId\}:\$\{e\.threadId \?\? e\.messageId\}`\)/);
  const chat = src("features/chat/ChatScreen.tsx");
  expect(chat).toContain("<UnavailableLines notices={notices} />");
  // Worded in the person's language from what the server sent, never its English (`text`).
  const lines = src("features/chat/ReachLines.tsx");
  expect(lines).toMatch(/unavailableNotice\( ?t, n,/);
  expect(lines).not.toContain("n.text");
});

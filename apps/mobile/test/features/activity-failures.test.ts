import { expect, test } from "bun:test";
import { runFailedLines } from "../../src/features/activity/logic";
import { notification, translator } from "./fixtures";

const NAMES: Record<string, string> = { a1: "Ada", a2: "Atlas", a3: "Nova" };
const failure = (agentId: string) => ({ key: `k-${agentId}`, agentId, channelId: "c1", messageId: `m-${agentId}` });

test("agents that failed for one cause: one title saying how many and why, who they are under it", async () => {
  const t = await translator("pt-BR");
  const grouped = notification({
    id: "n1",
    kind: "run_failed",
    count: 3,
    latest: { reason: "not_logged_in", plan: "Claude", failures: ["a1", "a2", "a3"].map(failure) },
  });
  expect(runFailedLines(t, grouped, (id) => NAMES[id] ?? "")).toEqual({
    title: "3 agentes não conseguiram continuar: a conta do Claude foi desconectada",
    sub: "Ada, Atlas e mais 1",
  });
  const en = await translator("en");
  // A cause with no words of its own still says how many.
  const unknown = { ...grouped, latest: { ...grouped.latest, reason: "error" } };
  expect(runFailedLines(en, unknown, (id) => NAMES[id] ?? "")?.title).toBe("3 agents couldn't go on");
  // One agent: the row it always was.
  const lone = notification({
    id: "n2",
    kind: "run_failed",
    latest: { reason: "budget_exceeded", failures: [failure("a1")] },
  });
  expect(runFailedLines(t, lone, (id) => NAMES[id] ?? "")).toBeNull();
});

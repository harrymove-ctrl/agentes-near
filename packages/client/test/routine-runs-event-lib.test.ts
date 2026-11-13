import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import { applyWorkspaceEvent } from "../src/realtime/machines";

test("a routine's run queued, started or ended: its runs, Rotinas and its webhook's calls are read again", () => {
  const qc = new QueryClient();
  const watched = [keys.routines("o1"), keys.routineRuns("o1", "r1"), keys.routineHook("o1", "r1")];
  for (const key of [...watched, keys.agents("o1")]) qc.setQueryData(key, []);
  expect(applyWorkspaceEvent(qc, "o1", { type: "routine.runs", routineId: "r1" } as { type: string })).toBe(true);
  const stale = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
  for (const key of watched) expect(stale(key)).toBe(true);
  expect(stale(keys.agents("o1"))).toBe(false);
});

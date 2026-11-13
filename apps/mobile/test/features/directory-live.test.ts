import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyWorkspaceEvent, keys } from "@agenteschat/client";
import { QueryClient } from "@tanstack/react-query";

const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

test("the phone hears the team and the channels change, whatever screen is open", () => {
  const events = src("features/shared/userEvents.ts");
  expect(events).toContain("applyWorkspaceEvent(qc, orgId, event)");
  const qc = new QueryClient();
  const lists = [keys.agents("o1"), keys.channels("o1"), keys.dms("o1"), keys.roster("o1", "c1")];
  for (const key of lists) qc.setQueryData(key, []);
  applyWorkspaceEvent(qc, "o1", { type: "agents.changed" });
  applyWorkspaceEvent(qc, "o1", { type: "channels.changed" });
  for (const key of lists) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
});

test("a reconnect reads everything again, and coming back to the app reads what went stale", () => {
  expect(src("providers/realtime.tsx")).toContain("c.onReconnect(() => void queryClient.invalidateQueries())");
  const query = src("providers/query.ts");
  expect(query).toContain("refetchOnWindowFocus: true");
  expect(query).toContain('focusManager.setFocused(s === "active")');
});

test("the channel's members screen and the mention picker read the shared roster", () => {
  for (const f of ["features/chat/ChannelMembers.tsx", "features/chat/MentionPicker.tsx"])
    expect(src(f)).toContain("useRoster");
});

test("adding to a channel: the ones being added keep their rows, and nobody reads as in already, until the sheet moves on", () => {
  expect(src("features/chat/ChannelMembers.tsx")).toMatch(
    /const inChannel = useHeldWhile\(\s*new Set\(\(roster\.data \?\? \[\]\)[^;]*\),\s*add\.isPending \|\| add\.isSuccess,\s*\);/,
  );
});

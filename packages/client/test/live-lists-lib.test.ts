import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import type { ChannelEvent } from "../src/api/types";
import { applyConversationEvent, applyWorkspaceEvent } from "../src/realtime/machines";

const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
const filled = (keyList: (readonly unknown[])[]) => {
  const qc = new QueryClient();
  for (const key of keyList) qc.setQueryData(key, []);
  return qc;
};

test("artifacts.changed: the Drive's lists and its trash read again, a file's own content does not", () => {
  const list = keys.artifactList("o1", { q: "plano" });
  const trash = [...keys.artifacts("o1"), "trash"];
  const one = keys.artifact("o1", "f1", 2);
  const other = keys.artifactList("o2", {});
  const qc = filled([list, trash, one, other]);
  expect(applyWorkspaceEvent(qc, "o1", { type: "artifacts.changed" })).toBe(true);
  expect(stale(qc, list)).toBe(true);
  expect(stale(qc, trash)).toBe(true);
  expect(stale(qc, one)).toBe(false);
  expect(stale(qc, other)).toBe(false);
});

test("wiki.page.updated: the open wiki (tree, page, trash) reads again", () => {
  const lists = [keys.wikiTree("o1"), keys.wikiPage("o1", "deploy"), keys.wikiTrash("o1")];
  const qc = filled([...lists, keys.wikiTree("o2")]);
  expect(applyWorkspaceEvent(qc, "o1", { type: "wiki.page.updated" })).toBe(true);
  for (const key of lists) expect(stale(qc, key)).toBe(true);
  expect(stale(qc, keys.wikiTree("o2"))).toBe(false);
});

test("the calendar reads again when it changed, when I'm invited and when an agent proposes an event", () => {
  for (const type of ["calendar.changed", "calendar.invited", "calendar.proposal"]) {
    const qc = filled([keys.calendarRange("o1", "2026-11-01")]);
    expect(applyWorkspaceEvent(qc, "o1", { type })).toBe(true);
    expect(stale(qc, keys.calendarRange("o1", "2026-11-01"))).toBe(true);
  }
});

test("routines.changed: Rotinas reads again", () => {
  const qc = filled([keys.routines("o1")]);
  expect(applyWorkspaceEvent(qc, "o1", { type: "routines.changed" })).toBe(true);
  expect(stale(qc, keys.routines("o1"))).toBe(true);
});

test("memory.changed: every agent's memory list reads again, nothing else of theirs", () => {
  const qc = filled([keys.memory("o1", "a1"), keys.memory("o1", "a2"), keys.agentDetail("o1", "a1")]);
  expect(applyWorkspaceEvent(qc, "o1", { type: "memory.changed" })).toBe(true);
  expect(stale(qc, keys.memory("o1", "a1"))).toBe(true);
  expect(stale(qc, keys.memory("o1", "a2"))).toBe(true);
  expect(stale(qc, keys.agentDetail("o1", "a1"))).toBe(false);
});

test("a file saved or changed in the open conversation: its cards and viewer read again", () => {
  const qc = filled([keys.artifact("o1", "f1"), keys.messages("o1", "c1")]);
  const event = { type: "artifact.updated", channelId: "c1", artifact: { id: "f1" } } as unknown as ChannelEvent;
  expect(applyConversationEvent(qc, "o1", event)).toBe(true);
  expect(stale(qc, keys.artifact("o1", "f1"))).toBe(true);
  expect(stale(qc, keys.messages("o1", "c1"))).toBe(false);
});

test("a file deleted in the open conversation: its cards say so (the conversation reads again)", () => {
  const qc = filled([keys.messages("o1", "c1"), keys.messages("o1", "c2")]);
  const event = { type: "artifact.deleted", channelId: "c1", artifactId: "f1" } as unknown as ChannelEvent;
  expect(applyConversationEvent(qc, "o1", event)).toBe(true);
  expect(stale(qc, keys.messages("o1", "c1"))).toBe(true);
  expect(stale(qc, keys.messages("o1", "c2"))).toBe(false);
});

test("an agent changed its memory in the open conversation: that agent's memory list reads again", () => {
  const qc = filled([keys.memory("o1", "a1"), keys.memory("o1", "a2")]);
  const event = {
    type: "memory.updated",
    channelId: "c1",
    threadId: null,
    agentId: "a1",
    runId: "r1",
    update: {},
  } as unknown as ChannelEvent;
  expect(applyConversationEvent(qc, "o1", event)).toBe(true);
  expect(stale(qc, keys.memory("o1", "a1"))).toBe(true);
  expect(stale(qc, keys.memory("o1", "a2"))).toBe(false);
});

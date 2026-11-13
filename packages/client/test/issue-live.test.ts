import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import { applyIssueActivityEvent } from "../src/api/queries";
import type { IssueActivity } from "../src/api/types";

const line = (id: string, kind: IssueActivity["kind"] = "comment"): IssueActivity => ({
  id,
  kind,
  author: { type: "agent", id: "a1" },
  text: kind === "comment" ? "Feito." : "changed the status",
  createdAt: "2026-11-02T12:00:00.000Z",
});

const comment = (issueId: string, activity: IssueActivity) => ({
  type: "issue.comment",
  channelId: "c1",
  issueId,
  activity,
});

test("someone else's comment on the open task lands at the end of its activity, once", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.issueActivity("o1", "i1"), [line("x1")]);
  expect(applyIssueActivityEvent(qc, "o1", "i1", comment("i1", line("x2")))).toBe(true);
  // The same line again (my own comment's echo, a reconnect): not doubled.
  applyIssueActivityEvent(qc, "o1", "i1", comment("i1", line("x2")));
  const list = qc.getQueryData<IssueActivity[]>(keys.issueActivity("o1", "i1"));
  expect(list?.map((a) => a.id)).toEqual(["x1", "x2"]);
});

test("another task's activity, or another event, leaves this one as it was", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.issueActivity("o1", "i1"), [line("x1")]);
  expect(applyIssueActivityEvent(qc, "o1", "i1", comment("i2", line("y1")))).toBe(false);
  expect(applyIssueActivityEvent(qc, "o1", "i1", { type: "issue.updated" })).toBe(false);
  expect(qc.getQueryData<IssueActivity[]>(keys.issueActivity("o1", "i1"))?.map((a) => a.id)).toEqual(["x1"]);
});

test("a task with no channel: the org broadcast (no channelId) counts too", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.issueActivity("o1", "i1"), []);
  const { channelId: _, ...broadcast } = comment("i1", line("x1"));
  expect(applyIssueActivityEvent(qc, "o1", "i1", broadcast)).toBe(true);
  expect(qc.getQueryData<IssueActivity[]>(keys.issueActivity("o1", "i1"))).toHaveLength(1);
});

test("an event (a status change) also refreshes the open task; a comment doesn't", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.issueActivity("o1", "i1"), []);
  qc.setQueryData(keys.issue("o1", 7), { id: "i1" });
  applyIssueActivityEvent(qc, "o1", "i1", comment("i1", line("x1")));
  expect(qc.getQueryState(keys.issue("o1", 7))?.isInvalidated).toBe(false);
  applyIssueActivityEvent(qc, "o1", "i1", comment("i1", line("x2", "event")));
  expect(qc.getQueryState(keys.issue("o1", 7))?.isInvalidated).toBe(true);
});

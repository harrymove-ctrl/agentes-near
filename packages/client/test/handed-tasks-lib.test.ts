import { expect, test } from "bun:test";
import { handedTasksOf } from "../src/lib/issues";

test("the tasks a right hand's reply handed on, as its chips read them (ADR 0137 §13)", () => {
  const task = { issueId: "i1", number: 42, title: "Campanha de Natal", agentId: "a1", channelId: "c1", rootId: "r1" };
  expect(handedTasksOf({ tasks: [task] })).toEqual([task]);
  // Without where its conversation is, there is no chip to open.
  expect(handedTasksOf({ tasks: [{ ...task, rootId: undefined }] })).toEqual([]);
  expect(handedTasksOf({ tasks: "nope" })).toEqual([]);
  expect(handedTasksOf(null)).toEqual([]);
});

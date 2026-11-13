import { expect, test } from "bun:test";
import { setMyReaction } from "../src/lib/reactions";

test("mine adds, comes off, drops an empty pill and leaves a list that already says so", () => {
  const on = setMyReaction([], "🙌", "me", true);
  expect(on).toEqual([{ reaction: "🙌", count: 1, userIds: ["me"], agentIds: [] }]);
  expect(setMyReaction(on, "🙌", "me", true)).toBe(on);
  expect(setMyReaction(on, "🙌", "me", false)).toEqual([]);
  const shared = setMyReaction([{ reaction: "🙌", count: 1, userIds: ["ana"], agentIds: [] }], "🙌", "me", true);
  expect(shared[0]?.userIds).toEqual(["ana", "me"]);
  expect(shared[0]?.count).toBe(2);
  const agents = [{ reaction: "🙌", count: 1, userIds: ["me"], agentIds: ["ada"] }];
  expect(setMyReaction(agents, "🙌", "me", false)[0]?.agentIds).toEqual(["ada"]);
});

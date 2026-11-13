import { describe, expect, test } from "bun:test";
import { agentReactionOf, playAgentReaction, REACTION_SECONDS, reactionPose } from "../src/agent/live";

describe("the agent's face when a person reacts", () => {
  test("👍: happy, then hearts, with a small hop at the start", () => {
    const start = reactionPose("up", 0.15, false);
    expect(start.pose.expression).toBe("happy");
    expect(start.hop).toBeGreaterThan(0);
    const later = reactionPose("up", 1, false);
    expect(later.pose.expression).toBe("heart");
    expect(later.hop).toBe(0);
  });

  test("👎: surprised, then a thoughtful look up and aside", () => {
    expect(reactionPose("down", 0.2, false).pose.expression).toBe("surprised");
    const thinking = reactionPose("down", 1, false).pose;
    expect(thinking.expression).toBeUndefined();
    expect(thinking.look?.[0]).toBeLessThan(0);
    expect(thinking.look?.[1]).toBeLessThan(0);
  });

  test("reduced motion: only the expression changes (no hop, no turn)", () => {
    for (const [kind, e] of [
      ["up", 0.15],
      ["up", 1],
      ["down", 0.2],
      ["down", 1],
    ] as const) {
      const face = reactionPose(kind, e, true);
      expect(face.hop).toBe(0);
      expect(face.pose.turn).toEqual([0, 0]);
      expect(face.pose.squash ?? 0).toBe(0);
    }
    expect(reactionPose("up", 1, true).pose.expression).toBe("heart");
  });

  test("playAgentReaction: the face plays for its key for about 1.6 s", () => {
    expect(REACTION_SECONDS).toBeCloseTo(1.6);
    playAgentReaction("msg-1", "down");
    expect(agentReactionOf("msg-1")?.kind).toBe("down");
    expect(agentReactionOf("msg-2")).toBeNull();
    expect(agentReactionOf(undefined)).toBeNull();
  });
});

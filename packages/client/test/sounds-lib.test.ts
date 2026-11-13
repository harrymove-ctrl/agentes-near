import { afterEach, describe, expect, test } from "bun:test";
import type { SoundName } from "../src/lib/sounds";
import { playSound, setSoundPlayer, soundForNotification } from "../src/lib/sounds";

const fresh = { waiting: false, count: 1, readAt: null, doneAt: null };

describe("soundForNotification", () => {
  test("by what it is: waits on you, someone called you, a conversation, work ended or went wrong", () => {
    expect(soundForNotification({ ...fresh, kind: "approval", waiting: true }, false)).toBe("attention");
    expect(soundForNotification({ ...fresh, kind: "agent_question", waiting: true }, false)).toBe("attention");
    expect(soundForNotification({ ...fresh, kind: "mention" }, false)).toBe("mention");
    expect(soundForNotification({ ...fresh, kind: "dm" }, false)).toBe("reply");
    expect(soundForNotification({ ...fresh, kind: "mission_finished" }, false)).toBe("done");
    expect(soundForNotification({ ...fresh, kind: "routine_failed" }, false)).toBe("error");
    expect(soundForNotification({ ...fresh, kind: "reaction" }, false)).toBeNull();
  });

  test("once: a merge into one already there, a read or a done one plays nothing", () => {
    expect(soundForNotification({ ...fresh, kind: "mention", count: 2 }, false)).toBeNull();
    expect(soundForNotification({ ...fresh, kind: "mention", readAt: "2026-10-26T12:00:00Z" }, false)).toBeNull();
    expect(soundForNotification({ ...fresh, kind: "approval", doneAt: "2026-10-26T12:00:00Z" }, false)).toBeNull();
  });

  test("in the background, a conversation stays quiet; what matters still plays", () => {
    expect(soundForNotification({ ...fresh, kind: "dm" }, true)).toBeNull();
    expect(soundForNotification({ ...fresh, kind: "mention" }, true)).toBe("mention");
    expect(soundForNotification({ ...fresh, kind: "approval", waiting: true }, true)).toBe("attention");
    expect(soundForNotification({ ...fresh, kind: "routine_finished" }, true)).toBe("done");
  });

  test("anything else waiting on you asks for attention", () => {
    expect(soundForNotification({ ...fresh, kind: "issue_assigned", waiting: true }, false)).toBe("attention");
  });
});

describe("playSound", () => {
  afterEach(() => setSoundPlayer(null));

  test("goes to the app's player; without one it is silence", () => {
    const heard: SoundName[] = [];
    playSound("send");
    setSoundPlayer((name) => heard.push(name));
    playSound("stop");
    expect(heard).toEqual(["stop"]);
  });

  test("a failing player never breaks what played it", () => {
    setSoundPlayer(() => {
      throw new Error("no audio");
    });
    expect(() => playSound("send")).not.toThrow();
  });
});

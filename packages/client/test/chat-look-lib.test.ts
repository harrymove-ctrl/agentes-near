import { expect, test } from "bun:test";
import {
  CHAT_TEXT_SIZES,
  chatLookOf,
  facesShown,
  firstUnreadId,
  mineOnRight,
  openAtOf,
  opensAtLastRead,
  textSizeOf,
} from "../src/lib/chat-look";

test("Tamanho do texto: five steps, smallest first, the middle one until the person picks", () => {
  expect(CHAT_TEXT_SIZES).toEqual(["xs", "sm", "md", "lg", "xl"]);
  expect(textSizeOf(undefined)).toBe("md");
  expect(textSizeOf({ dmStyle: "left" })).toBe("md");
  expect(textSizeOf({ textSize: "xs" })).toBe("xs");
});

const said = (id: string, author: { type: "person" | "agent"; id: string }, createdAt: string) => ({
  id,
  author,
  createdAt,
});

test("whoever hasn't chosen: channels on the left, DMs in light bubbles", () => {
  expect(chatLookOf(undefined, false)).toEqual({ style: "left", tone: "light" });
  expect(chatLookOf({}, true)).toEqual({ style: "bubbles", tone: "light" });
});

test("in a personal workspace every conversation opens in bubbles; a team's channels stay on the left (ADR 0159)", () => {
  expect(chatLookOf(undefined, false, true)).toEqual({ style: "bubbles", tone: "light" });
  expect(chatLookOf({}, true, true)).toEqual({ style: "bubbles", tone: "light" });
  expect(chatLookOf({}, false, false)).toEqual({ style: "left", tone: "light" });
});

test("the person's own choice wins over a personal workspace's default", () => {
  expect(chatLookOf({ channelStyle: "left", channelTone: "strong" }, false, true)).toEqual({
    style: "left",
    tone: "strong",
  });
  expect(chatLookOf({ dmStyle: "compact" }, true, true)).toEqual({ style: "compact", tone: "light" });
});

test("channels and DMs each keep their own choice", () => {
  const prefs = { channelStyle: "compact", dmStyle: "comfortable", channelTone: "strong" } as const;
  expect(chatLookOf(prefs, false)).toEqual({ style: "compact", tone: "strong" });
  expect(chatLookOf(prefs, true)).toEqual({ style: "comfortable", tone: "light" });
});

test("my rows stand apart only in the styles that keep the right side", () => {
  expect(["comfortable", "left", "bubbles", "compact"].map((s) => mineOnRight(s as never))).toEqual([
    true,
    false,
    true,
    false,
  ]);
});

test("a DM drops the other side's face where my rows keep the right side; channels and the other looks keep it", () => {
  const styles = ["comfortable", "left", "bubbles", "compact"] as const;
  expect(styles.map((s) => facesShown(s, true))).toEqual([false, true, false, true]);
  expect(styles.map((s) => facesShown(s, false))).toEqual([true, true, true, true]);
});

test("it opens at the last read message until the person picks the newest, and only with something unread", () => {
  expect(openAtOf(undefined)).toBe("read");
  expect(openAtOf({ dmStyle: "left" })).toBe("read");
  expect(openAtOf({ openAt: "latest" })).toBe("latest");
  expect(opensAtLastRead(undefined, 3)).toBe(true);
  expect(opensAtLastRead({}, 3)).toBe(true);
  expect(opensAtLastRead({ openAt: "read" }, 3)).toBe(true);
  // An explicit choice of the newest message stays theirs.
  expect(opensAtLastRead({ openAt: "latest" }, 3)).toBe(false);
  expect(opensAtLastRead(undefined, 0)).toBe(false);
  expect(opensAtLastRead({ openAt: "read" }, 0)).toBe(false);
});

test("the first unread message is past the read mark and not mine", () => {
  const list = [
    said("a", { type: "agent", id: "ada" }, "2026-11-05T10:00:00.000Z"),
    said("b", { type: "person", id: "me" }, "2026-11-05T11:00:00.000Z"),
    said("c", { type: "agent", id: "ada" }, "2026-11-05T12:00:00.000Z"),
  ];
  expect(firstUnreadId(list, "2026-11-05T10:30:00.000Z", "me")).toBe("c");
  expect(firstUnreadId(list, "2026-11-05T12:30:00.000Z", "me")).toBeNull();
  expect(firstUnreadId(list, null, "me")).toBe("a");
});

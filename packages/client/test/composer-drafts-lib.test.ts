import { expect, test } from "bun:test";
import { DRAFT_TTL_MS, draftKeyOf, MAX_DRAFTS, readDraftBook, withDraft } from "../src/lib/composer-drafts";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");

test("a thread's composer has its own draft; a channel's (or DM's) is the channel's", () => {
  expect(draftKeyOf("c1")).toBe("channel:c1");
  expect(draftKeyOf("c1", null)).toBe("channel:c1");
  expect(draftKeyOf("c1", "t1")).toBe("thread:t1");
});

test("a typed text is kept and read back; a blank one removes the entry", () => {
  let book = withDraft({}, "channel:c1", "half a thought", NOW);
  book = withDraft(book, "thread:t1", "reply", NOW);
  const read = readDraftBook(JSON.stringify(book), NOW + 1000);
  expect(read["channel:c1"]).toEqual({ text: "half a thought", at: NOW });
  expect(read["thread:t1"]?.text).toBe("reply");
  expect(withDraft(read, "channel:c1", "   ", NOW)["channel:c1"]).toBeUndefined();
});

test("nothing, broken JSON or the wrong shape read as an empty book; bad and blank entries are skipped", () => {
  expect(readDraftBook(null, NOW)).toEqual({});
  expect(readDraftBook("{oops", NOW)).toEqual({});
  expect(readDraftBook("[1,2]", NOW)).toEqual({});
  const raw = JSON.stringify({
    a: { text: "ok", at: NOW },
    b: { text: 3, at: NOW },
    c: { text: "  ", at: NOW },
    d: "text",
  });
  expect(Object.keys(readDraftBook(raw, NOW))).toEqual(["a"]);
});

test("old drafts expire", () => {
  const raw = JSON.stringify({
    old: { text: "old", at: NOW - DRAFT_TTL_MS - 1 },
    recent: { text: "new", at: NOW - 1 },
  });
  expect(Object.keys(readDraftBook(raw, NOW))).toEqual(["recent"]);
});

test("the book keeps only the most recent drafts", () => {
  let book = {};
  for (let i = 0; i < MAX_DRAFTS + 5; i++) book = withDraft(book, `channel:${i}`, `text ${i}`, NOW + i);
  const keys = Object.keys(book);
  expect(keys).toHaveLength(MAX_DRAFTS);
  expect(keys).not.toContain("channel:0");
  expect(keys).toContain(`channel:${MAX_DRAFTS + 4}`);
});

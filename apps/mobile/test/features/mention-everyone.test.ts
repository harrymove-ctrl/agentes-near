import { describe, expect, test } from "bun:test";
import {
  everyoneSuggestion,
  isEveryoneMention,
  mentionsReader,
  offersEveryone,
} from "@agenteschat/client/lib/everyone";
import { parseBlocks } from "../../src/features/chat/logic";
import { insertMention, mentionQuery } from "../../src/features/chat/mentions";

describe("@todos on the phone", () => {
  test("offered first to who may mention everyone, never in a DM", () => {
    const allowed = { permissions: ["read", "post", "mention_everyone"] };
    expect(offersEveryone(allowed, false)).toBe(true);
    expect(offersEveryone(allowed, true)).toBe(false);
    expect(offersEveryone({ permissions: ["read", "post"] }, false)).toBe(false);
  });

  test("in the reader's language, as they type it", () => {
    expect(everyoneSuggestion("", "pt-BR")).toBe("todos");
    expect(everyoneSuggestion("To", "pt-BR")).toBe("todos");
    expect(everyoneSuggestion("ev", "en")).toBe("everyone");
    expect(everyoneSuggestion("ev", "pt-BR")).toBeNull();
    expect(everyoneSuggestion("全", "ja")).toBe("全員");
    const token = mentionQuery("oi @全", 5);
    expect(token).toEqual({ start: 3, query: "全" });
    expect(insertMention("oi @全", token as NonNullable<typeof token>, "全員").text).toBe("oi @全員 ");
  });

  test("a message's word of any script is a mention, and its mention of everyone only with the flag", () => {
    const [block] = parseBlocks("@全員 deploy às 15h");
    expect(block?.kind === "paragraph" && block.inline[0]).toEqual({ kind: "mention", text: "@全員" });
    expect(isEveryoneMention({ mentionsEveryone: true }, "全員")).toBe(true);
    expect(isEveryoneMention({ mentionsEveryone: true }, "Todos")).toBe(true);
    expect(isEveryoneMention({}, "todos")).toBe(false);
    expect(isEveryoneMention({ mentionsEveryone: true }, "ana")).toBe(false);
  });

  test("a mention of everyone marks the row as mentioning its reader, handle or not", () => {
    expect(mentionsReader({ body: "@todos deploy", meta: { mentionsEveryone: true } }, null)).toBe(true);
    expect(mentionsReader({ body: "@todos deploy", meta: {} }, "ana")).toBe(false);
    expect(mentionsReader({ body: "oi @ana", meta: null }, "ana")).toBe(true);
  });
});

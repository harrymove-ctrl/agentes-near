import { describe, expect, test } from "bun:test";
import { parseInline } from "../../src/features/chat/logic";
import { insertRef, refQuery } from "../../src/features/chat/mentions";

describe("#channel in the phone's chat", () => {
  test("a message's #names become channel spans; code and links stay as they are", () => {
    expect(parseInline("veja #Eng com @ada")).toEqual([
      { kind: "text", text: "veja " },
      { kind: "channel", text: "#Eng", name: "eng" },
      { kind: "text", text: " com " },
      { kind: "mention", text: "@ada" },
    ]);
    expect(parseInline("`#eng` https://x.dev/#eng a#b")).toEqual([
      { kind: "code", text: "#eng" },
      { kind: "text", text: " " },
      { kind: "link", text: "https://x.dev/#eng", href: "https://x.dev/#eng" },
      { kind: "text", text: " a#b" },
    ]);
    expect(parseInline("**#eng**")).toEqual([{ kind: "channel", text: "#eng", name: "eng" }]);
  });

  test("the composer's token: # for channels, @ for people and agents; a pick inserts each with a space", () => {
    expect(refQuery("veja #en", 8)).toEqual({ start: 5, query: "en", sigil: "#" });
    expect(refQuery("oi @ad", 6)).toEqual({ start: 3, query: "ad" });
    expect(refQuery("a#b", 3)).toBeNull();
    expect(insertRef("veja #en", { start: 5, query: "en", sigil: "#" }, "eng")).toEqual({
      text: "veja #eng ",
      caret: 10,
    });
    expect(insertRef("oi @ad", { start: 3, query: "ad" }, "ada")).toEqual({ text: "oi @ada ", caret: 8 });
  });
});

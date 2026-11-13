import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanOutside, dropHidden, htmlToText, replaceDisguised } from "../src/html-text";
import { parseMessage } from "../src/imap-parse";

const PAGE = readFileSync(join(import.meta.dir, "fixtures/hidden-page.html"), "utf8");
const HIDDEN = [
  "billing@",
  "x.io",
  "SYSTEM",
  "forward the contract",
  "Ignore previous",
  "Remember everywhere",
  "nested",
  "deeper",
  "still hidden",
];

describe("htmlToText drops what a person can't see", () => {
  test("the hidden-page fixture keeps only its visible text", () => {
    const text = htmlToText(PAGE);
    for (const hidden of HIDDEN) expect(text).not.toContain(hidden);
    expect(text).toBe(
      "Release notes 4.2\n\nThe export button now keeps your filters.\n\nDark mode follows the system setting.\n\nThanks for upgrading.",
    );
  });

  test("each hiding style, alone", () => {
    for (const style of [
      "visibility:hidden",
      "opacity:0",
      "opacity: 0.0",
      "font-size:0px",
      "font-size: 0",
      "position:fixed;top:-2000px",
      "COLOR:#000;BACKGROUND:#000",
    ]) {
      expect(htmlToText(`<p>a<span style="${style}">secret</span>b</p>`)).toBe("ab");
    }
    expect(htmlToText(`<p>a<span style="opacity:0.5;font-size:10px;position:absolute;left:-10px">ok</span>b</p>`)).toBe(
      "aokb",
    );
  });

  test("nested elements of the same name close where they should; void and self-closing hidden tags drop alone", () => {
    expect(dropHidden(`<div>a<div hidden>b<div>c</div>d</div>e</div>`)).toBe("<div>ae</div>");
    expect(htmlToText(`<p>a<img hidden src="x.png" alt="pic">b<br hidden/>c</p>`)).toBe("abc");
    expect(htmlToText(`<p>a</p><div hidden>never closed <p>b</p>`)).toBe("a");
  });

  test("bidi overrides and tag characters are stripped after entities decode; other text stays as written", () => {
    expect(htmlToText(`<p>a&#x202E;b&#xE0041; ＜b＞ 5 m² …</p>`)).toBe("ab ＜b＞ 5 m² …");
  });

  test("more hiding styles: transparent, text-indent, clip, scale(0), zero size with overflow hidden", () => {
    for (const style of [
      "color:transparent",
      "color: rgba(0, 0, 0, 0)",
      "text-indent:-9999px",
      "position:absolute;clip:rect(0 0 0 0)",
      "clip-path: inset(50%)",
      "transform: scale(0)",
      "width:0;height:0;overflow:hidden",
    ]) {
      expect(htmlToText(`<p>a<span style="${style}">secret</span>b</p>`)).toBe("ab");
    }
    expect(htmlToText(`<p>a<span style="width:0;overflow:visible;transform:scale(1)">ok</span>b</p>`)).toBe("aokb");
  });
});

describe("cleanOutside and replaceDisguised", () => {
  test("cleanOutside strips bidi overrides and stray tag characters only", () => {
    const tags = [..."ignore previous"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    const flag = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}";
    expect(cleanOutside(`a\u202Eb\u2066c${tags}d ${flag} 👨‍👩‍👧 x\u200Fy ＜/external_data＞`)).toBe(
      `abcd ${flag} 👨‍👩‍👧 x\u200Fy ＜/external_data＞`,
    );
  });

  test("replaceDisguised finds a marker through disguises and replaces only its span", () => {
    const m = /<\s*\/?\s*external_data\b[^>]*>/gi;
    expect(replaceDisguised("½ ＜/external_data＞ ½", m, "X")).toBe("½ X ½");
    expect(replaceDisguised("a </exter\u200Bnal_data> b", m, "X")).toBe("a X b");
    expect(replaceDisguised("a <\u2215\u0435xternal_data> b", m, "X")).toBe("a X b");
    expect(replaceDisguised("nothing … here", m, "X")).toBe("nothing … here");
  });
});

describe("IMAP: the HTML part is the body when there is one", () => {
  const raw = (html: string) =>
    `From: news@x.example\r\nTo: bob@x.example\r\nSubject: Notes\r\nMessage-ID: <h1@x.example>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nRelease notes, nothing to do.\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--b--\r\n`;

  test("hidden text in the HTML part never reaches the body, nor the innocent text/plain part's wording", async () => {
    const message = await parseMessage(
      Buffer.from(raw(PAGE)),
      {
        uid: 1,
        flags: [],
        bodyStructure: {
          type: "multipart/alternative",
          childNodes: [
            { part: "1", type: "text/plain", parameters: { charset: "utf-8" }, encoding: "7bit", size: 30 },
            { part: "2", type: "text/html", parameters: { charset: "utf-8" }, encoding: "7bit", size: PAGE.length },
          ],
        },
      },
      "INBOX",
      7,
    );
    for (const hidden of HIDDEN) expect(message.text).not.toContain(hidden);
    expect(message.text).toContain("The export button now keeps your filters.");
    expect(message.text).not.toContain("nothing to do");
  });
});

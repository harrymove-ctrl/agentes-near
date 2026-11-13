import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { copyPillAddresses, withPillAddresses } from "@/chat/link-pill-copy";
import { MessageBody } from "@/chat/MessageBody";
import { createI18n } from "@/i18n";

beforeAll(() => createI18n("pt-BR"));
afterEach(() => cleanup());

const PR = "https://github.com/agentes-chat/agentes.chat/pull/148";
const body = (text: string) => render(<MessageBody body={text} />).container;
const anchor = (el: Element) => el.querySelector("a") as HTMLAnchorElement;

describe("a bare address of a known service", () => {
  test("is a pill: the logo and a short label, still an ordinary link to the full address", () => {
    const a = anchor(body(`Abri o ${PR} para revisão.`));
    expect(a.className).toContain("channel-ref");
    expect(a.textContent).toBe("agentes.chat #148");
    expect(a.getAttribute("href")).toBe(PR);
    expect(a.getAttribute("title")).toBe(PR);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.tagName).toBe("A");
    expect((a.querySelector(".link-pill__mark") as HTMLElement).style.getPropertyValue("--connector-icon")).toContain(
      "/connectors/github.svg",
    );
  });

  test("a pull request and an issue tell which they are by icon, and to a screen reader by name", () => {
    const pull = anchor(body(PR));
    const issue = anchor(body("https://github.com/agentes-chat/agentes.chat/issues/148"));
    expect(pull.querySelector("svg")?.innerHTML).not.toBe(issue.querySelector("svg")?.innerHTML);
    expect(pull.getAttribute("aria-label")).toBe("GitHub Pull request agentes.chat #148");
    expect(issue.getAttribute("aria-label")).toBe("GitHub Issue agentes.chat #148");
  });

  test("with no title in the address, a word in the reader's language", () => {
    expect(anchor(body("https://docs.google.com/document/d/1AbC/edit")).textContent).toBe("Documento");
  });

  test("inside bold, a list and a table too", () => {
    const el = body(`**${PR}**\n\n- ${PR}\n\n| a |\n| --- |\n| ${PR} |`);
    expect(el.querySelectorAll("strong a.link-pill, li a.link-pill, td a.link-pill")).toHaveLength(3);
  });

  test("a link with its own words and an unknown address stay as written", () => {
    const own = anchor(body(`[o PR de ontem](${PR})`));
    expect(own.textContent).toBe("o PR de ontem");
    expect(own.className).toBe("ac-link");
    const unknown = anchor(body("https://example.com/a/pull/1"));
    expect(unknown.textContent).toBe("https://example.com/a/pull/1");
    expect(unknown.className).toBe("ac-link");
  });

  test("a link whose words are another address stays as written, with no pill inside it", () => {
    const el = body(`[${PR}](https://github.com/agentes-chat/agentes.chat/pull/9)`);
    expect(el.querySelector(".link-pill")).toBeNull();
    expect(el.textContent).toContain(PR);
  });

  test("written as its own link's words, it is still a bare address", () => {
    expect(anchor(body(`[${PR}](${PR})`)).textContent).toBe("agentes.chat #148");
  });

  test("in a table its words keep their column: only a word too long for the line breaks", () => {
    const css = readFileSync(join(import.meta.dir, "../src/layout.css"), "utf8");
    expect(css.match(/\.link-pill \{[^}]*\}/)?.[0]).toContain("overflow-wrap: break-word");
  });

  test("inside code it stays code", () => {
    expect(body(`\`${PR}\``).querySelector("a")).toBeNull();
  });
});

describe("copying a selection with a pill", () => {
  const one = (text: string, href: string, skip = 0) => ({ text, href, skip });

  test("each pill's words become its address, in order", () => {
    const pills = [
      one("agentes.chat #1", "https://github.com/a/agentes.chat/pull/1"),
      one("agentes.chat #2", "https://github.com/a/agentes.chat/pull/2"),
    ];
    expect(withPillAddresses("ver agentes.chat #1 e agentes.chat #2.", pills)).toBe(
      "ver https://github.com/a/agentes.chat/pull/1 e https://github.com/a/agentes.chat/pull/2.",
    );
  });

  test("the same words written before a pill stay", () => {
    const doc = "https://docs.google.com/document/d/1/edit";
    expect(withPillAddresses("Documento: Documento", [one("Documento", doc, 1)])).toBe(`Documento: ${doc}`);
  });

  const copied = (selected: Node, target?: Element) => {
    const set: string[] = [];
    const prevented: boolean[] = [];
    const selection = document.getSelection() as Selection;
    selection.selectAllChildren(selected);
    copyPillAddresses({
      clipboardData: { setData: (_kind: string, text: string) => set.push(text) },
      preventDefault: () => prevented.push(true),
      target: target ?? document.body,
    } as unknown as ClipboardEvent);
    selection.removeAllRanges();
    return { set, prevented };
  };

  test("the copy event takes the address; with no pill selected the browser copies as usual", () => {
    const el = body(`Abri o ${PR} hoje.`);
    expect(copied(el).set.join("")).toContain(PR);
    const other = render(<p>Só texto</p>).container;
    expect(copied(other).prevented).toHaveLength(0);
  });

  test("a field's own text is left to the browser", () => {
    const el = body(PR);
    const field = document.createElement("textarea");
    expect(copied(el, field).prevented).toHaveLength(0);
  });

  test("the app listens for it", () => {
    const main = readFileSync(join(import.meta.dir, "../src/main.tsx"), "utf8");
    expect(main).toContain(`document.addEventListener("copy", copyPillAddresses)`);
  });
});

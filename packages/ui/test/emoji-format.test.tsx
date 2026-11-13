import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import {
  applyFormat,
  Composer,
  type ComposerFormatLabels,
  EMOJI_CATEGORIES,
  EMOJIS,
  EmojiPicker,
  type EmojiPickerLabels,
  EmojiPickerPopover,
  formatShortcut,
  insertText,
  readRecentEmoji,
  searchEmoji,
  wrapSelection,
} from "../src";

afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {}
});

const body = () => within(document.body);
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));

const LABELS: EmojiPickerLabels = {
  dialog: "Emojis",
  search: "Buscar emoji",
  noResults: "Nenhum emoji encontrado.",
  recent: "Usados recentemente",
  results: "Resultados",
  categories: {
    smileys: "Carinhas",
    people: "Pessoas e gestos",
    nature: "Natureza",
    food: "Comida e bebida",
    activities: "Atividades",
    travel: "Viagens e lugares",
    objects: "Objetos",
    symbols: "Símbolos",
  },
};

const FORMAT: ComposerFormatLabels = {
  toolbar: "Formatação",
  bold: "Negrito",
  italic: "Itálico",
  strike: "Tachado",
  code: "Código",
  codeBlock: "Bloco de código",
  link: "Link",
  bulletList: "Lista com marcadores",
  numberedList: "Lista numerada",
  quote: "Citação",
  linkText: "texto",
};

describe("formatting helpers", () => {
  test("wrapping toggles: bold, italic, strikethrough, inline code", () => {
    const bold = applyFormat("olá mundo", 4, 9, "bold");
    expect(bold).toEqual({ value: "olá **mundo**", start: 6, end: 11 });
    // Again on the same selection: unwrapped.
    expect(applyFormat(bold.value, bold.start, bold.end, "bold")).toEqual({ value: "olá mundo", start: 4, end: 9 });
    // Selecting the markers too also unwraps.
    expect(applyFormat("**x**", 0, 5, "bold")).toEqual({ value: "x", start: 0, end: 1 });
    expect(applyFormat("a b", 2, 3, "italic").value).toBe("a _b_");
    expect(applyFormat("a b", 2, 3, "strike").value).toBe("a ~~b~~");
    expect(applyFormat("rode npm i", 5, 10, "code").value).toBe("rode `npm i`");
    // Spaces stay outside the markers.
    expect(wrapSelection("x word y", 1, 7, "**").value).toBe("x **word** y");
    // Nothing selected: the markers, with the caret between them.
    expect(applyFormat("oi ", 3, 3, "bold")).toEqual({ value: "oi ****", start: 5, end: 5 });
  });

  test("code block, link and line formats", () => {
    expect(applyFormat("veja: const a = 1", 6, 17, "codeBlock").value).toBe("veja: \n```\nconst a = 1\n```");
    const block = applyFormat("const a = 1", 0, 11, "codeBlock");
    expect(block.value).toBe("```\nconst a = 1\n```");
    expect(applyFormat(block.value, 0, block.value.length, "codeBlock").value).toBe("const a = 1");
    const link = applyFormat("o painel", 2, 8, "link", { link: "texto" });
    expect(link.value).toBe("o [painel](https://)");
    expect(link.value.slice(link.start, link.end)).toBe("https://");
    expect(applyFormat("https://a.dev", 0, 13, "link").value).toBe("[https://a.dev](https://a.dev)");
    expect(applyFormat("um\ndois", 0, 7, "bulletList").value).toBe("- um\n- dois");
    expect(applyFormat("- um\n- dois", 0, 11, "bulletList").value).toBe("um\ndois");
    expect(applyFormat("- um\n- dois", 0, 11, "numberedList").value).toBe("1. um\n2. dois");
    expect(applyFormat("ideia", 2, 2, "quote").value).toBe("> ideia");
    expect(applyFormat("", 0, 0, "numberedList")).toEqual({ value: "1. ", start: 3, end: 3 });
    expect(insertText("oi !", 3, 3, "🎉")).toEqual({ value: "oi 🎉!", start: 5, end: 5 });
  });

  test("shortcuts: ⌘/Ctrl + B, I, E, K, ⇧X, ⇧E, ⇧7/8/9", () => {
    const k = (key: string, extra: Partial<{ shiftKey: boolean; code: string; ctrlKey: boolean }> = {}) =>
      formatShortcut({
        key,
        metaKey: !extra.ctrlKey,
        ctrlKey: Boolean(extra.ctrlKey),
        shiftKey: false,
        altKey: false,
        ...extra,
      });
    expect(k("b")).toBe("bold");
    expect(k("i", { ctrlKey: true })).toBe("italic");
    expect(k("e")).toBe("code");
    expect(k("k")).toBe("link");
    expect(k("X", { shiftKey: true })).toBe("strike");
    expect(k("E", { shiftKey: true })).toBe("codeBlock");
    expect(k("&", { shiftKey: true, code: "Digit7" })).toBe("numberedList");
    expect(k("*", { shiftKey: true, code: "Digit8" })).toBe("bulletList");
    expect(k("(", { shiftKey: true, code: "Digit9" })).toBe("quote");
    expect(formatShortcut({ key: "b", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBeNull();
  });
});

describe("emoji data", () => {
  test("every category has emoji; search by English keyword", () => {
    for (const c of EMOJI_CATEGORIES) expect(EMOJIS.some((e) => e.category === c)).toBe(true);
    expect(searchEmoji("thumbs").map((e) => e.emoji)).toEqual(["👍", "👎"]);
    expect(searchEmoji("party").map((e) => e.emoji)).toContain("🎉");
    expect(searchEmoji("zzzzqq")).toEqual([]);
    // Unique (each emoji is one cell and one reaction).
    expect(new Set(EMOJIS.map((e) => e.emoji)).size).toBe(EMOJIS.length);
  });
});

describe("EmojiPicker", () => {
  test("renders categories as grids, searches, and says when nothing matches", async () => {
    render(<EmojiPicker labels={LABELS} onPick={() => {}} />);
    expect(body().getByRole("grid", { name: "Carinhas" })).toBeTruthy();
    expect(body().getByRole("grid", { name: "Símbolos" })).toBeTruthy();
    const search = body().getByRole("searchbox", { name: "Buscar emoji" });
    await act(async () => fireEvent.change(search, { target: { value: "rocket" } }));
    const results = body().getByRole("grid", { name: "Resultados" });
    expect(within(results).getByRole("button", { name: "rocket" }).textContent).toBe("🚀");
    await act(async () => fireEvent.change(search, { target: { value: "nada-assim" } }));
    expect(body().getByRole("status").textContent).toBe("Nenhum emoji encontrado.");
  });

  test("every grid has its eight columns, so a short one starts on the left, and it never scrolls sideways", async () => {
    localStorage.setItem("agentes:emoji-recent", JSON.stringify(["🎉"]));
    render(<EmojiPicker labels={LABELS} onPick={() => {}} />);
    expect(body().getByRole("grid", { name: "Usados recentemente" }).querySelectorAll("button").length).toBe(1);
    for (const grid of body().getAllByRole("grid")) expect(grid.querySelectorAll("colgroup > col").length).toBe(8);
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-emoji__grid col")).toContain("width: 12.5%;");
    expect(rule(".ac-emoji__grid td")).not.toContain("width");
    expect(rule(".ac-emoji__scroll")).toContain("overflow-x: hidden;");
    expect(rule(".ac-emoji-popover")).toContain("overflow-x: hidden;");
  });

  test("keyboard: ArrowDown enters the grid, arrows move, Enter picks; picks become recent", async () => {
    const picked: string[] = [];
    const { unmount } = render(<EmojiPicker labels={LABELS} onPick={(e) => picked.push(e)} />);
    const search = body().getByRole("searchbox", { name: "Buscar emoji" });
    await act(async () => fireEvent.keyDown(search, { key: "ArrowDown" }));
    const first = EMOJIS[0]?.emoji ?? "";
    expect(document.activeElement?.textContent).toBe(first);
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" }));
    expect(document.activeElement?.textContent).toBe(EMOJIS[1]?.emoji);
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" }));
    expect(document.activeElement?.textContent).toBe(EMOJIS[9]?.emoji);
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" }));
    await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" }));
    expect(document.activeElement === search).toBe(true);
    await act(async () => fireEvent.change(search, { target: { value: "tada" } }));
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    expect(picked).toEqual(["🎉"]);
    expect(readRecentEmoji()).toEqual(["🎉"]);
    unmount();
    render(<EmojiPicker labels={LABELS} onPick={() => {}} />);
    const recent = body().getByRole("grid", { name: "Usados recentemente" });
    expect(
      within(recent)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["🎉"]);
  });

  test("in a popover: opens from its trigger, Esc closes and gives the focus back", async () => {
    const picked: string[] = [];
    render(
      <EmojiPickerPopover
        labels={LABELS}
        onPick={(e) => picked.push(e)}
        trigger={
          <button type="button" aria-label="Reagir">
            +
          </button>
        }
      />,
    );
    const trigger = body().getByRole("button", { name: "Reagir" });
    await act(async () => fireEvent.click(trigger));
    await tick();
    const dialog = body().getByRole("dialog", { name: "Emojis" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "thumbs up" })));
    await tick();
    expect(picked).toEqual(["👍"]);
    expect(body().queryByRole("dialog", { name: "Emojis" })).toBeNull();
    await act(async () => fireEvent.click(trigger));
    await tick();
    const search = body().getByRole("searchbox", { name: "Buscar emoji" });
    await act(async () => {
      fireEvent.keyDown(search, { key: "Escape" });
    });
    await tick();
    expect(body().queryByRole("dialog", { name: "Emojis" })).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
  });
});

describe("Composer toolbar", () => {
  function Harness({ sent }: { sent: string[] }) {
    const [v, setV] = useState("deploy amanhã");
    return (
      <Composer
        value={v}
        onChange={setV}
        onSend={(t) => sent.push(t)}
        label="Mensagem para #eng"
        sendLabel="Enviar"
        format={FORMAT}
        emoji={{ ...LABELS, button: "Emoji" }}
      />
    );
  }

  test("buttons and shortcuts wrap the selection; the emoji goes in at the caret", async () => {
    const sent: string[] = [];
    render(<Harness sent={sent} />);
    const box = body().getByRole("textbox", { name: "Mensagem para #eng" }) as HTMLTextAreaElement;
    // The formatting bar floats over selected text: none before there is some.
    expect(body().queryByRole("toolbar", { name: "Formatação" })).toBeNull();
    box.focus();
    box.setSelectionRange(7, 13);
    // React only reports a select whose range differs from the last one it saw, in any test: the focus reports it too.
    await act(async () => {
      fireEvent.select(box);
      fireEvent.focus(box);
    });
    const toolbar = body().getByRole("toolbar", { name: "Formatação" });
    // One tab stop; the tooltip tells the shortcut.
    const bold = within(toolbar).getByRole("button", { name: "Negrito" });
    expect(bold.getAttribute("tabindex")).toBe("0");
    expect(bold.getAttribute("title")).toMatch(/^Negrito \((⌘|Ctrl) B\)$/);
    await act(async () => fireEvent.click(bold));
    expect(box.value).toBe("deploy **amanhã**");
    box.setSelectionRange(0, 6);
    await act(async () => fireEvent.keyDown(box, { key: "i", ctrlKey: true }));
    expect(box.value).toBe("_deploy_ **amanhã**");
    await act(async () =>
      fireEvent.keyDown(within(toolbar).getByRole("button", { name: "Negrito" }), { key: "ArrowRight" }),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Itálico");
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Emoji" })));
    await tick();
    await act(async () =>
      fireEvent.click(within(body().getByRole("dialog", { name: "Emojis" })).getByRole("button", { name: "rocket" })),
    );
    await tick();
    expect(box.value).toBe("_deploy_ **amanhã**🚀");
    expect(document.activeElement === box).toBe(true);
  });

  test("files: attachments only can be sent; uploads in progress hold the send", async () => {
    const sent: string[] = [];
    const { rerender } = render(
      <Composer
        value=""
        onChange={() => {}}
        onSend={(t) => sent.push(t)}
        label="Mensagem"
        sendLabel="Enviar"
        attachLabel="Anexar arquivo"
        onFiles={() => {}}
        canSendEmpty
        sendBlocked
      />,
    );
    const send = body().getByRole("button", { name: "Enviar" });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(body().getByRole("button", { name: "Anexar arquivo" }).hasAttribute("disabled")).toBe(false);
    rerender(
      <Composer
        value=""
        onChange={() => {}}
        onSend={(t) => sent.push(t)}
        label="Mensagem"
        sendLabel="Enviar"
        attachLabel="Anexar arquivo"
        onFiles={() => {}}
        canSendEmpty
      />,
    );
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Enviar" })));
    expect(sent).toEqual([""]);
  });
});

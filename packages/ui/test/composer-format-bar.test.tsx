import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { Composer, type ComposerFormatLabels, type ComposerProps, FORMAT_KINDS } from "../src";
import { EDGE_ROOM, placeOverSelection, TIP_GAP } from "../src/floating";

afterEach(cleanup);

const body = () => within(document.body);
const css = () => Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();

const FORMAT: ComposerFormatLabels = {
  toolbar: "Formatação",
  bold: "Negrito",
  italic: "Itálico",
  strike: "Tachado",
  code: "Código",
  codeBlock: "Bloco de código",
  link: "Link",
  bulletList: "Lista",
  numberedList: "Lista numerada",
  quote: "Citação",
  linkText: "texto",
};
const EMOJI = {
  button: "Emoji",
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

function Box({ start = "deploy amanhã", ...rest }: { start?: string } & Partial<ComposerProps>) {
  const [v, setV] = useState(start);
  return (
    <Composer
      value={v}
      onChange={setV}
      onSend={() => {}}
      label="Mensagem para #eng"
      sendLabel="Enviar"
      attachLabel="Anexar arquivo"
      onFiles={() => {}}
      format={FORMAT}
      emoji={EMOJI}
      {...rest}
    />
  );
}
const box = () => body().getByRole("textbox", { name: "Mensagem para #eng" }) as HTMLTextAreaElement;
const bar = () => body().queryByRole("toolbar", { name: "Formatação" });
const select = (start: number, end: number) =>
  act(async () => {
    box().focus();
    box().setSelectionRange(start, end);
    fireEvent.select(box());
  });

describe("the composer's row", () => {
  test("attach and emoji, the text, send, in that order, and no formatting button without a selection", () => {
    render(<Box />);
    const card = box().closest(".ac-composer") as HTMLElement;
    const row = card.querySelector(".ac-composer__row") as HTMLElement;
    const names = Array.from(row.querySelectorAll("button, textarea")).map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Anexar arquivo", "Emoji", "Mensagem para #eng", "Enviar"]);
    expect(bar()).toBeNull();
    for (const kind of FORMAT_KINDS) expect(body().queryByRole("button", { name: FORMAT[kind] })).toBeNull();
  });

  test("the microphone sits before send where the browser records", () => {
    const had = {
      recorder: Object.getOwnPropertyDescriptor(window, "MediaRecorder"),
      audio: Object.getOwnPropertyDescriptor(window, "AudioContext"),
      devices: Object.getOwnPropertyDescriptor(navigator, "mediaDevices"),
    };
    const put = (on: object, name: string, value: unknown) =>
      Object.defineProperty(on, name, { configurable: true, value });
    put(window, "MediaRecorder", function MediaRecorder() {});
    put(window, "AudioContext", function AudioContext() {});
    put(navigator, "mediaDevices", { getUserMedia: async () => ({}) });
    try {
      const labels = {
        record: "Gravar áudio",
        recording: "Gravando",
        pause: "Pausar",
        resume: "Continuar",
        discard: "Apagar",
        send: "Enviar áudio",
        listen: "Ouvir",
        stopListening: "Parar",
        keys: "Enter envia · Esc apaga",
        keysHold: "Solte para enviar",
        keysPaused: "Enter envia",
        left: (s: number) => `faltam ${s} s`,
      };
      render(<Box voice={{ scope: "c", onTake: () => {}, onNotice: () => {}, labels }} />);
      const row = document.querySelector(".ac-composer__row") as HTMLElement;
      const names = Array.from(row.querySelectorAll("button, textarea")).map((el) => el.getAttribute("aria-label"));
      expect(names).toEqual(["Anexar arquivo", "Emoji", "Mensagem para #eng", "Gravar áudio", "Enviar"]);
    } finally {
      const back = (on: object, name: string, was?: PropertyDescriptor) =>
        was ? Object.defineProperty(on, name, was) : Reflect.deleteProperty(on, name);
      back(window, "MediaRecorder", had.recorder);
      back(window, "AudioContext", had.audio);
      back(navigator, "mediaDevices", had.devices);
    }
  });

  test("pills keep a line over the row, a DM's chip opens the row, and the card's empty room is the text box's", () => {
    const { unmount } = render(<Box pills={<button type="button">Ada</button>} />);
    const card = box().closest(".ac-composer") as HTMLElement;
    expect(card.querySelector(":scope > .ac-composer__pills")).toBeTruthy();
    expect(fireEvent.mouseDown(card.querySelector(".ac-composer__pills") as HTMLElement)).toBe(false);
    fireEvent.mouseUp(card);
    expect(document.activeElement).toBe(box());
    unmount();
    render(<Box inlinePills pills={<span className="ac-composer__agent">Ada</span>} />);
    const row = document.querySelector(".ac-composer__row") as HTMLElement;
    expect(row.firstElementChild?.className).toBe("ac-composer__pills");
    expect(row.firstElementChild?.textContent).toBe("Ada");
  });
});

describe("formatting floats over the selection", () => {
  test("selecting text shows every action, named, with its shortcut", async () => {
    render(<Box />);
    await select(7, 13);
    const toolbar = bar() as HTMLElement;
    expect(toolbar.hasAttribute("data-open")).toBe(true);
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(FORMAT_KINDS.map((k) => FORMAT[k]));
    expect(buttons[0]?.getAttribute("title")).toMatch(/^Negrito \((⌘|Ctrl) B\)$/);
    expect(buttons[8]?.getAttribute("title")).toMatch(/^Citação \((⌘|Ctrl) ⇧ 9\)$/);
    // One tab stop, right after the text box.
    expect(buttons.map((b) => b.getAttribute("tabindex"))).toEqual(["0", ...Array(8).fill("-1")]);
    expect(box().nextElementSibling).toBe(toolbar);
  });

  test("Negrito wraps the selection and keeps it selected, the bar still there; pressing it takes no focus", async () => {
    render(<Box />);
    await select(7, 13);
    const bold = within(bar() as HTMLElement).getByRole("button", { name: "Negrito" });
    expect(fireEvent.mouseDown(bold)).toBe(false);
    fireEvent.mouseUp(bold);
    await act(async () => fireEvent.click(bold));
    expect(box().value).toBe("deploy **amanhã**");
    expect([box().selectionStart, box().selectionEnd]).toEqual([9, 15]);
    expect(document.activeElement).toBe(box());
    expect(bar()?.hasAttribute("data-open")).toBe(true);
    await act(async () => fireEvent.click(within(bar() as HTMLElement).getByRole("button", { name: "Negrito" })));
    expect(box().value).toBe("deploy amanhã");
  });

  test("it hides when the selection collapses, when typing replaces it and when the box loses the focus", async () => {
    render(<Box />);
    await select(0, 6);
    expect(bar()).toBeTruthy();
    await select(3, 3);
    expect(bar()).toBeNull();
    const kept = document.querySelector(".ac-formatbar") as HTMLElement;
    expect(kept.getAttribute("aria-hidden")).toBe("true");
    expect(kept.hasAttribute("inert")).toBe(true);
    await select(0, 13);
    expect(bar()).toBeTruthy();
    await act(async () => fireEvent.blur(box(), { relatedTarget: document.body }));
    expect(bar()).toBeNull();
  });

  test("the keys reach it: the focus goes to the bar and the selection stays, arrows move, Escape goes back", async () => {
    render(<Box />);
    await select(7, 13);
    const toolbar = bar() as HTMLElement;
    const bold = within(toolbar).getByRole("button", { name: "Negrito" });
    await act(async () => {
      fireEvent.blur(box(), { relatedTarget: bold });
      bold.focus();
    });
    expect(bar()).toBeTruthy();
    await act(async () => fireEvent.keyDown(bold, { key: "ArrowRight" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Itálico");
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" }));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Citação");
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" }));
    expect(document.activeElement).toBe(box());
    expect([box().selectionStart, box().selectionEnd]).toEqual([7, 13]);
  });

  test("shortcuts work with a selection and without one", async () => {
    render(<Box />);
    await select(0, 6);
    await act(async () => fireEvent.keyDown(box(), { key: "i", ctrlKey: true }));
    expect(box().value).toBe("_deploy_ amanhã");
    await select(box().value.length, box().value.length);
    expect(bar()).toBeNull();
    await act(async () => fireEvent.keyDown(box(), { key: "b", metaKey: true }));
    expect(box().value).toBe("_deploy_ amanhã****");
    await act(async () => fireEvent.keyDown(box(), { key: "x", metaKey: true, shiftKey: true }));
    expect(box().value).toContain("~~");
  });

  test("a locked box has no bar, and a multi-line selection over very long unbroken text shows it all the same", async () => {
    const { unmount } = render(<Box disabled />);
    await act(async () => {
      box().setSelectionRange(0, 6);
      fireEvent.select(box());
    });
    expect(document.querySelector(".ac-formatbar")).toBeNull();
    unmount();
    const long = `${"a".repeat(600)}\nsegunda linha\n${"b".repeat(600)}`;
    render(<Box start={long} />);
    await select(10, long.length - 10);
    expect(within(bar() as HTMLElement).getAllByRole("button")).toHaveLength(9);
    await act(async () => fireEvent.click(within(bar() as HTMLElement).getByRole("button", { name: "Citação" })));
    expect(
      box()
        .value.split("\n")
        .every((line) => line.startsWith("> ")),
    ).toBe(true);
  });
});

describe("where the bar goes (placeOverSelection)", () => {
  const BAR = { width: 356, height: 40 };
  const column = { left: 280, right: 1000 };

  test("centred over the selection, a gap above it", () => {
    const at = placeOverSelection({ left: 500, right: 560, top: 700, bottom: 722 }, BAR, column, 1280);
    expect(at).toEqual({ left: 530 - BAR.width / 2, top: 700 - TIP_GAP - BAR.height });
  });

  test("a selection at either end of the column: the bar stays inside the column", () => {
    const start = placeOverSelection({ left: 290, right: 300, top: 700, bottom: 722 }, BAR, column, 1280);
    expect(start.left).toBe(column.left);
    const end = placeOverSelection({ left: 980, right: 1000, top: 700, bottom: 722 }, BAR, column, 1280);
    expect(end.left + BAR.width).toBe(column.right);
  });

  test("no room over the top line: it goes under the selection, never on it", () => {
    const selection = { left: 500, right: 560, top: 20, bottom: 42 };
    const at = placeOverSelection(selection, BAR, column, 1280);
    expect(at.top).toBe(selection.bottom + TIP_GAP);
    const lines = { left: 290, right: 990, top: 30, bottom: 118 };
    expect(placeOverSelection(lines, BAR, column, 1280).top).toBe(lines.bottom + TIP_GAP);
  });

  test("a multi-line selection: over its first line, centred on its width", () => {
    const at = placeOverSelection({ left: 290, right: 990, top: 600, bottom: 688 }, BAR, column, 1280);
    expect(at.top + BAR.height).toBe(600 - TIP_GAP);
    expect(at.left).toBe(640 - BAR.width / 2);
  });

  test("320 wide: the wrapped bar (the column's width, two rows) starts at the column's left, inside the window", () => {
    const narrow = { left: 10, right: 310 };
    const wrapped = { width: 300, height: 76 };
    const at = placeOverSelection({ left: 200, right: 300, top: 500, bottom: 522 }, wrapped, narrow, 320);
    expect(at.left).toBeGreaterThanOrEqual(narrow.left);
    expect(at.left + wrapped.width).toBeLessThanOrEqual(320 - EDGE_ROOM + 2);
    expect(at.top + wrapped.height).toBe(500 - TIP_GAP);
    // One still wider than its column never leaves from the left.
    expect(placeOverSelection({ left: 200, right: 300, top: 500, bottom: 522 }, BAR, narrow, 320).left).toBe(10);
  });
});

describe("the bar's CSS", () => {
  test("it fades in and out, still for reduced motion, wraps on a narrow composer and floats over the page", async () => {
    const sheet = await css();
    const rule = (selector: string) => {
      const at = sheet.indexOf(`\n${selector} {`);
      expect(at).toBeGreaterThan(-1);
      return sheet.slice(at, sheet.indexOf("}", at));
    };
    expect(rule(".ac-formatbar")).toContain("flex-wrap: wrap");
    // Unplaced or closed, it stays in the text's cell: a bar as wide as its buttons would scroll a 320px page sideways.
    expect(rule(".ac-formatbar")).toContain("max-width: 100%");
    expect(rule(".ac-formatbar")).toContain("z-index: var(--z-floating)");
    expect(rule(".ac-formatbar")).toContain("opacity: 0");
    expect(rule(".ac-formatbar")).toContain("visibility: hidden");
    expect(rule(".ac-formatbar[data-open]")).toContain("opacity: 1");
    expect(sheet).toMatch(/@starting-style \{\s*\.ac-formatbar\[data-open\] \{\s*opacity: 0;/);
    expect(sheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.ac-formatbar,\s*\.ac-formatbar\[data-open\] \{\s*transition: none;/,
    );
    expect(rule(".ac-formatbar__btn")).toContain("height: var(--control-h-sm)");
    // Long unbroken text stays in its column: the text's cell may shrink, the buttons never do.
    expect(rule(".ac-composer__text")).toContain("min-width: 0");
    expect(rule(".ac-composer__tools")).toContain("flex: none");
  });
});

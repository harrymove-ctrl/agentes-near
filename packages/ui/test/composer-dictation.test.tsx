import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer } from "../src/components/Composer";

// The DOM is one window for every test file: put the browser's clipboard back for the files after this one.
const browserClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  if (browserClipboard) Object.defineProperty(navigator, "clipboard", browserClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

// Dictation apps (Wispr Flow and the like) put the words on the clipboard, press ⌘V for the person and put the old
// clipboard back a moment later; others insert through the accessibility API, an input with no key pressed.
// The box is the browser's own textarea: it must leave both to the browser and take the text from the input event.

let typed: string[] = [];
let asyncReads = 0;

function ChatBox() {
  const [value, setValue] = useState("");
  return (
    <Composer
      value={value}
      onChange={(v) => {
        typed.push(v);
        setValue(v);
      }}
      onSend={() => {}}
      label="Mensagem para Ada"
      sendLabel="Enviar"
      mentions={{ search: () => [], listLabel: "Pessoas e agentes" }}
      onFiles={() => {}}
    />
  );
}

function setup() {
  typed = [];
  asyncReads = 0;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      readText: async () => {
        asyncReads++;
        return "";
      },
      read: async () => {
        asyncReads++;
        return [];
      },
    },
  });
  render(<ChatBox />);
  const box = screen.getByLabelText("Mensagem para Ada") as HTMLTextAreaElement;
  box.focus();
  return box;
}

/** A paste whose clipboard the dictation app puts back right after the event went out. */
function paste(box: HTMLTextAreaElement, data: Record<string, string>, restored: Record<string, string>) {
  let clip = data;
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      get types() {
        return Object.keys(clip);
      },
      files: [],
      items: [],
      getData: (type: string) => clip[type] ?? "",
    },
  });
  box.dispatchEvent(event);
  clip = restored;
  return event;
}

/** What the browser does once nothing cancelled the paste or the insert: the text goes in, then `input`. */
async function browserInserts(box: HTMLTextAreaElement, text: string) {
  await act(async () => fireEvent.input(box, { target: { value: box.value + text } }));
}

describe("dictated text lands in the message box", () => {
  test("⌘V with the clipboard put back right after: the paste is the browser's, read nowhere later", async () => {
    const box = setup();
    const event = paste(box, { "text/plain": "ditado pelo Flow" }, { "text/plain": "o que estava copiado" });
    expect(event.defaultPrevented).toBe(false);
    await browserInserts(box, "ditado pelo Flow");
    expect(asyncReads).toBe(0);
    expect(box.value).toBe("ditado pelo Flow");
    expect(typed.at(-1)).toBe("ditado pelo Flow");
  });

  test("text with HTML beside it pastes as text (the browser's plain-text paste into the textarea)", async () => {
    const box = setup();
    const event = paste(box, { "text/html": "<p>com <b>HTML</b></p>", "text/plain": "com HTML" }, {});
    expect(event.defaultPrevented).toBe(false);
    await browserInserts(box, "com HTML");
    expect(box.value).toBe("com HTML");
  });

  test("an insert with no key pressed (accessibility, a dictation keyboard) is not filtered", async () => {
    const box = setup();
    const before = new Event("beforeinput", { bubbles: true, cancelable: true });
    Object.assign(before, { inputType: "insertText", data: "falado" });
    box.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    await browserInserts(box, "falado");
    expect(box.value).toBe("falado");
    expect(typed).toEqual(["falado"]);
  });
});

test("a click in the card's empty room puts the caret in the box; a button keeps its own click", () => {
  render(
    <Composer
      value=""
      onChange={() => {}}
      onSend={() => {}}
      label="Message"
      sendLabel="Send"
      pills={<button type="button">Ada</button>}
    />,
  );
  const box = screen.getByLabelText("Message");
  const row = document.querySelector(".ac-composer__pills") as HTMLElement;
  expect(fireEvent.mouseDown(row)).toBe(false);
  expect(document.activeElement).toBe(box);
  (document.activeElement as HTMLElement).blur();
  expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Ada" }))).toBe(true);
  expect(document.activeElement).not.toBe(box);
});

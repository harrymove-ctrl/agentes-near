import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { fireEvent } from "@testing-library/react";
import { movesByKeys, trackInput } from "../src";

afterEach(() => {
  document.body.innerHTML = "";
});

const styles = (name: string) => Bun.file(new URL(`../src/styles/${name}`, import.meta.url).pathname).text();

describe("focus rings only for the keys", () => {
  test("a key that moves the focus turns them on, one that moves nothing doesn't; a press turns them off", () => {
    trackInput();
    const html = document.documentElement;
    // Other test files in the same process may have pressed keys: start from a press, as a page load with the mouse would.
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    document.body.innerHTML =
      '<button type="button">Ver perfil</button><textarea></textarea><input type="radio" name="r"><input type="radio" name="r">';
    const [button, box, radio, radio2] = [...document.querySelectorAll<HTMLElement>("button, textarea, input")];
    if (!button || !box || !radio || !radio2) throw new Error("no controls");
    const mode = () => [html.hasAttribute("data-pointer") ? "pointer" : "keys", movesByKeys()];
    /** A key, and where the focus goes while it is down: the browser's move, or a script's a moment later. */
    const press = (
      on: HTMLElement,
      key: string,
      to?: HTMLElement,
      held: { metaKey?: boolean; altKey?: boolean } = {},
    ) => {
      fireEvent.keyDown(on, { key, ...held });
      to?.focus();
      fireEvent.keyUp(on, { key, ...held });
    };
    expect(mode()).toEqual(["pointer", false]);
    box.focus();
    // Typing, the caret, sending, closing, Tab that picks a mention, an arrow that scrolls: the focus stays.
    for (const key of ["a", "ArrowDown", "Home", "Enter", "Escape", "Tab", "PageDown"]) press(box, key);
    // Shortcuts, also one that focuses something (⌘K, the palette's field).
    press(box, "k", button, { metaKey: true });
    press(button, "ArrowDown", box, { metaKey: true });
    // What a script focuses once the key is up: a card that opens under the pointer right after that Tab.
    press(box, "Tab");
    button.focus();
    expect(mode()).toEqual(["pointer", false]);
    press(button, "Tab", box);
    expect(mode()).toEqual(["keys", true]);
    fireEvent.pointerDown(button, { pointerType: "touch" });
    expect(mode()).toEqual(["pointer", false]);
    // Arrows between radios move the focus; ⌥Tab is how Safari reaches a button.
    press(radio, "ArrowRight", radio2);
    expect(mode()).toEqual(["keys", true]);
    fireEvent.pointerDown(button, { pointerType: "mouse" });
    press(radio2, "Tab", button, { altKey: true });
    expect(mode()).toEqual(["keys", true]);
  });

  test("the ring is a gray one a pixel off the control; while the pointer leads, not even the browser's own", async () => {
    const tokens = await styles("tokens.css");
    expect(tokens).toContain("--focus-color: var(--line-strong);");
    expect(tokens).toContain("--focus-ring: 0 0 0 1px var(--raised), 0 0 0 3px var(--focus-color);");
    const css = await styles("components.css");
    expect(css).toContain("html[data-pointer] :focus-visible {\n  outline: none;\n}");
    // Nothing focused by the keys keeps the browser's own ring.
    expect(css).toContain(
      ":where(html:not([data-pointer])) :where(:focus-visible) {\n  outline: 2px solid var(--focus-color);\n  outline-offset: 1px;\n}",
    );
    expect(css).toContain(
      "html:not([data-pointer]) .ac-btn:focus-visible {\n  outline: none;\n  box-shadow: var(--focus-ring);",
    );
  });
});

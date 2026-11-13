import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { composes, copies, isModifier, keyInit, macCopy, pastes } from "@/lib/keys";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("the keys the computer dialog reads", () => {
  test("pastes: the browser's own paste keys, on any layout", () => {
    expect(pastes(key({ key: "v", code: "KeyV", metaKey: true }), true)).toBe(true);
    expect(pastes(key({ key: "V", code: "KeyV", metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(pastes(key({ key: "v", code: "KeyV", ctrlKey: true }), false)).toBe(true);
    expect(pastes(key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(pastes(key({ key: "Insert", code: "Insert", shiftKey: true }), false)).toBe(true);
    // Ctrl+V on a Mac is the computer's own key there; ⌘ elsewhere isn't the browser's paste.
    expect(pastes(key({ key: "v", code: "KeyV", ctrlKey: true }), true)).toBe(false);
    expect(pastes(key({ key: "v", code: "KeyV", metaKey: true }), false)).toBe(false);
    // A layout without Latin letters names V by its place; Dvorak by its letter.
    expect(pastes(key({ key: "м", code: "KeyV", ctrlKey: true }), false)).toBe(true);
    expect(pastes(key({ key: "v", code: "Period", ctrlKey: true }), false)).toBe(true);
    // Dvorak's K sits where a US keyboard has V.
    expect(pastes(key({ key: "k", code: "KeyV", ctrlKey: true }), false)).toBe(false);
    // AltGr (Ctrl+Alt on Windows) types a character, never pastes.
    expect(pastes(key({ key: "v", code: "KeyV", ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(pastes(key({ key: "v", code: "KeyV" }), false)).toBe(false);
  });

  test("copies: the Linux desktop's copy keys; ⌘C is the Mac's own", () => {
    expect(copies(key({ key: "c", code: "KeyC", ctrlKey: true }))).toBe(true);
    expect(copies(key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(copies(key({ key: "Insert", code: "Insert", ctrlKey: true }))).toBe(true);
    expect(copies(key({ key: "c", code: "KeyC", metaKey: true }))).toBe(false);
    expect(copies(key({ key: "c", code: "KeyC", ctrlKey: true, altKey: true }))).toBe(false);
  });

  test("macCopy: ⌘C only on Apple", () => {
    expect(macCopy(key({ key: "c", code: "KeyC", metaKey: true }), true)).toBe(true);
    expect(macCopy(key({ key: "c", code: "KeyC", metaKey: true }), false)).toBe(false);
    expect(macCopy(key({ key: "C", code: "KeyC", metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(macCopy(key({ key: "c", code: "KeyC", ctrlKey: true }), true)).toBe(false);
  });

  test("composes: what the browser turns into text itself", () => {
    expect(composes(key({ key: "Dead", code: "Quote" }))).toBe(true);
    expect(composes(key({ key: "Process", code: "KeyA" }))).toBe(true);
    expect(composes(key({ key: "Unidentified" }))).toBe(true);
    expect(composes(key({ key: "a", keyCode: 229 } as KeyboardEventInit))).toBe(true);
    expect(composes(key({ key: "a", code: "KeyA", isComposing: true }))).toBe(true);
    expect(composes(key({ key: "a", code: "KeyA" }))).toBe(false);
  });

  test("isModifier and keyInit: a held modifier, and a key replayed as it came", () => {
    expect(isModifier("MetaRight")).toBe(true);
    expect(isModifier("ControlLeft")).toBe(true);
    expect(isModifier("KeyA")).toBe(false);
    expect(isModifier("")).toBe(false);
    expect(keyInit(key({ key: "A", code: "KeyA", location: 0, repeat: true, shiftKey: true }))).toMatchObject({
      key: "A",
      code: "KeyA",
      location: 0,
      repeat: true,
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
  });
});

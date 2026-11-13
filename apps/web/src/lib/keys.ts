/** The letter a shortcut names: the key's own letter, or on a layout without Latin letters its place on a US keyboard (as browsers do). */
const letterOf = (e: KeyboardEvent) =>
  /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : "";

/**
 * A key the browser turns into text itself: a dead key, an input method's, a phone keyboard's. Safari fires the key
 * that ends a composition after `compositionend`, still with keyCode 229.
 */
export const composes = (e: KeyboardEvent) =>
  e.isComposing || e.keyCode === 229 || e.key === "Dead" || e.key === "Process" || e.key === "Unidentified";

/** The browser's paste keys: ⌘V on Apple, Ctrl+V elsewhere (with Shift too), and Shift+Insert. */
export const pastes = (e: KeyboardEvent, apple: boolean) =>
  (letterOf(e) === "v" && !e.altKey && (apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) ||
  (e.key === "Insert" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey);

/** ⌘C on Apple. */
export const macCopy = (e: KeyboardEvent, apple: boolean) =>
  apple && letterOf(e) === "c" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;

/** Keys that copy on a Linux desktop: Ctrl+C, Ctrl+Shift+C (a terminal's) or Ctrl+Insert. */
export const copies = (e: KeyboardEvent) =>
  e.ctrlKey && !e.metaKey && !e.altKey && (letterOf(e) === "c" || e.key === "Insert");

/** Shift, Control, Alt or Meta, left or right (`KeyboardEvent.code`). */
export const isModifier = (code: string) => /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code);

/** The lock keys' state a key event carries: replayed with it, the other side keeps them in step. */
export const locksOf = (e: KeyboardEvent): KeyboardEventInit => ({
  modifierCapsLock: e.getModifierState("CapsLock"),
  modifierNumLock: e.getModifierState("NumLock"),
});

/** A key event's own fields, to replay it as a new event elsewhere. */
export const keyInit = (e: KeyboardEvent): KeyboardEventInit => ({
  key: e.key,
  code: e.code,
  location: e.location,
  repeat: e.repeat,
  ctrlKey: e.ctrlKey,
  shiftKey: e.shiftKey,
  altKey: e.altKey,
  metaKey: e.metaKey,
  ...locksOf(e),
  modifierAltGraph: e.getModifierState("AltGraph"),
});

/** Keys that stay the person's own on a screen they watch: moving the focus, Esc, lone modifiers and locks, F keys. */
const NOT_AIMED = /^(Tab|Escape|Shift|Control|Alt|AltGraph|Meta|Fn|CapsLock|NumLock|ScrollLock|F\d{1,2})$/;

/**
 * A key pressed on a watched screen that was meant for it: a paste, or any key but a shortcut (Ctrl, ⌘ or Alt held) and
 * `NOT_AIMED`. What the browser or the app does with the others stays theirs.
 */
export const aimsAtScreen = (e: KeyboardEvent, apple: boolean) =>
  pastes(e, apple) || (!e.ctrlKey && !e.metaKey && !e.altKey && !composes(e) && !NOT_AIMED.test(e.key));

/** Typing in a field (a text box, a select, an editable text): single-key shortcuts and Esc are the field's. */
export const typingInField = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/** Whether the key landed in a text field that has something in it (not a checkbox or the like, which hold no text). */
export const holdsText = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  const field = target.closest<HTMLElement>(
    "textarea, input:not([type=checkbox], [type=radio], [type=range], [type=button], [type=submit]), [contenteditable='true'], [contenteditable='']",
  );
  if (!field) return false;
  return Boolean(("value" in field ? String(field.value) : (field.textContent ?? "")).trim());
};

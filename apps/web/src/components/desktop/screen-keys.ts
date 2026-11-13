import { isApple } from "@agenteschat/ui";
import type RFB from "@novnc/novnc";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { liveCanvas } from "@/lib/canvas";
import { composes, copies, isModifier, keyInit, locksOf, macCopy, pastes } from "@/lib/keys";
import { CONTROL, INSERT, PASTE_MAX_BYTES, pasteBytes, SHIFT } from "./paste";

/** What the computer copies this soon after the person's copy keys goes to their clipboard. */
const COPY_WAIT_MS = 2_000;

/**
 * The person's keyboard on the agent's screen while in control (ADR 0058 §16). It goes to `field`, a text field
 * nobody sees, never to noVNC's canvas: only an editable element gets a paste in every browser (Safari and the Mac
 * app included), and only there do dead keys and input methods compose. Each key is replayed on noVNC's canvas, so
 * noVNC keeps its own key logic; composed text is typed as characters; a paste goes through the computer's clipboard.
 * The person's clipboard is read only in a paste they made, and written only with what the computer copies within
 * 2 s of their own copy keys. Returns what noVNC's `clipboard` event calls.
 */
export function useScreenKeys({
  field,
  screen,
  rfb,
  active,
  onRefused,
  onCopied,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  /** noVNC's target: its canvas is inside. */
  screen: RefObject<HTMLDivElement | null>;
  rfb: RefObject<RFB | null>;
  /** In control (the field is there). */
  active: boolean;
  onRefused: (why: "tooLong" | "textOnly") => void;
  /** What the computer copied after the person's copy keys, and whether it is in their clipboard now. */
  onCopied: (text: string, written: boolean) => void;
}) {
  const on = useRef({ onRefused, onCopied });
  on.current = { onRefused, onCopied };
  const waiting = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    const el = field.current;
    if (!active || !el) return;
    const apple = isApple();
    /** Keys replayed down and not up yet, by `code`. */
    const down = new Map<string, KeyboardEventInit>();
    /** Caps Lock and Num Lock as the last key had them: noVNC syncs the computer's to what each key it gets says. */
    let locks: KeyboardEventInit = {};
    let tick: ReturnType<typeof setTimeout> | undefined;
    // On noVNC's own canvas, not a picture held over it while the mode switches (`holdPicture`). Cancelable: the
    // dialog's own Esc listener sees a replayed Esc too, and must be able to keep the dialog open.
    const replay = (type: "keydown" | "keyup", init: KeyboardEventInit) => {
      const canvas = screen.current && liveCanvas(screen.current);
      canvas?.dispatchEvent(new KeyboardEvent(type, { ...init, cancelable: true }));
    };
    /** Presses `keys` there with none of the person's held modifiers on (⌘ is Alt there), then holds those again. */
    const press = (keys: (typeof SHIFT)[]) => {
      const held = [...down.values()].filter((k) => isModifier(k.code ?? ""));
      for (const k of held) replay("keyup", k);
      for (const k of keys) rfb.current?.sendKey(k.keysym, k.code, true);
      for (const k of [...keys].reverse()) rfb.current?.sendKey(k.keysym, k.code, false);
      for (const k of held) replay("keydown", k);
    };
    const paste = (text: string) => {
      rfb.current?.clipboardPasteFrom(text);
      press([SHIFT, INSERT]);
    };
    /** What the field composed (an accent, an input method's words, a phone keyboard's), typed there. */
    const typeOut = () => {
      const text = el.value;
      el.value = "";
      // noVNC types one UTF-16 unit per key: an emoji goes as a paste.
      if ([...text].some((c) => c.length > 1)) paste(text);
      // With no code, noVNC presses and lets go of the key's character.
      else for (const key of text) replay("keydown", { key, ...locks });
    };
    const copyBack = () => {
      const next = new Promise<string>((resolve, reject) => {
        const settle = (text: string) => {
          clearTimeout(timer);
          if (waiting.current === settle) waiting.current = null;
          resolve(text);
        };
        const timer = setTimeout(() => {
          if (waiting.current === settle) waiting.current = null;
          reject(new Error("nothing copied"));
        }, COPY_WAIT_MS);
        waiting.current = settle;
      });
      const notWritten = () =>
        next.then(
          (text) => on.current.onCopied(text, false),
          () => {},
        );
      try {
        const blob = next.then((text) => new Blob([text], { type: "text/plain" }));
        // Rejected when nothing is copied in time, which only fails the write.
        blob.catch(() => {});
        // Started in the keydown itself, the text to come: Safari allows no later write.
        void navigator.clipboard
          .write([new ClipboardItem({ "text/plain": blob })])
          .then(() => next.then((text) => on.current.onCopied(text, true)), notWritten);
      } catch {
        void notWritten();
      }
    };
    const keydown = (e: KeyboardEvent) => {
      e.stopPropagation();
      locks = locksOf(e);
      if (composes(e) || pastes(e, apple)) return;
      e.preventDefault();
      if (macCopy(e, apple)) {
        press([CONTROL, INSERT]);
        return copyBack();
      }
      const init = keyInit(e);
      down.set(e.code, init);
      replay("keydown", init);
      if (copies(e)) copyBack();
    };
    const keyup = (e: KeyboardEvent) => {
      e.stopPropagation();
      e.preventDefault();
      down.delete(e.code);
      replay("keyup", keyInit(e));
    };
    const pasted = (e: ClipboardEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return on.current.onRefused("textOnly");
      if (pasteBytes(text) > PASTE_MAX_BYTES) return on.current.onRefused("tooLong");
      paste(text.replaceAll("\r\n", "\n"));
    };
    const input = (e: Event) => {
      const { inputType, isComposing } = e as InputEvent;
      if (isComposing) return;
      if (inputType === "deleteContentBackward" || inputType === "insertLineBreak" || inputType === "insertParagraph") {
        el.value = "";
        return replay("keydown", { key: inputType === "deleteContentBackward" ? "Backspace" : "Enter", ...locks });
      }
      typeOut();
    };
    // Some browsers fill in the value after `compositionend`: read it a tick later, as xterm.js does.
    const composed = () => {
      clearTimeout(tick);
      tick = setTimeout(typeOut, 0);
    };
    // noVNC lets go of its keys only when the window loses focus, not when its canvas does.
    const blur = () => {
      for (const k of down.values()) replay("keyup", k);
      down.clear();
    };
    const listeners: [string, EventListener][] = [
      ["keydown", keydown as EventListener],
      ["keyup", keyup as EventListener],
      ["paste", pasted as EventListener],
      ["input", input],
      ["compositionend", composed],
      ["blur", blur],
    ];
    for (const [name, fn] of listeners) el.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of listeners) el.removeEventListener(name, fn);
      clearTimeout(tick);
      blur();
      waiting.current = null;
    };
  }, [active, field, screen, rfb]);

  return useCallback((text: string) => waiting.current?.(text), []);
}

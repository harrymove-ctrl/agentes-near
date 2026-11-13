import { useEffect, useRef, useState } from "react";
import { holdsText } from "@/lib/keys";

/** What takes Esc before any panel. */
const LAYERS = '[role="dialog"], [role="menu"], [role="listbox"], dialog[open], [data-esc-layer]';

/** The panels open now, the newest last: Esc closes that one alone (a panel can open over another). */
const open: object[] = [];

/**
 * Esc closes this panel, wherever the focus is, unless something nearer has a use for it: a dialog, menu or picker
 * over it, anything marked `data-esc-layer` (not one of those, yet it takes Esc wherever the focus is, or a close would
 * lose it: a voice note, staged files), a text field with something in it (unless `data-esc-free`: the panel closing
 * loses nothing there), a field marked `data-esc-own` (the main composer while Esc there stops an agent, a field whose
 * Esc leaves a step). It listens first, so nothing under the panel acts on that Esc; the conversation's own Esc skips
 * one whose target is in a panel. The focus goes back to what opened the panel, else to the conversation's composer.
 * Undefined `close`: not a panel here (a thread shown as a page).
 */
export function useEscClose(close: (() => void) | undefined) {
  // Read on the first render, before a field inside takes the focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const latest = useRef(close);
  latest.current = close;
  const active = Boolean(close);
  useEffect(() => {
    if (!active) return;
    const me = {};
    open.push(me);
    let escaped = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || open.at(-1) !== me || document.querySelector(LAYERS)) return;
      const from = e.target instanceof Element ? e.target : null;
      if (from?.closest("[data-esc-own]") || (holdsText(from) && !from?.closest("[data-esc-free]"))) return;
      e.preventDefault();
      escaped = true;
      latest.current?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      open.splice(open.indexOf(me), 1);
      if (!escaped || document.activeElement !== document.body) return;
      opener?.focus({ preventScroll: true });
      if (document.activeElement === document.body)
        document.querySelector<HTMLElement>('[id^="composer-"]')?.focus({ preventScroll: true });
    };
  }, [active, opener]);
}

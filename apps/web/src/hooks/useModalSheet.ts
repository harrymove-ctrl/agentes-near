import { type RefObject, useEffect, useState } from "react";

/** The opener of a sheet that just went, for one taking its place in the same commit (opened from inside it). */
let handedOver: HTMLElement | null = null;

/** What floats over every sheet, in <body>, and stays in reach while one is open: the toasts and the notices' island. */
const OVER_SHEETS = ".ac-toasts, .ni-wrap";

/**
 * A full-screen sheet over the page (phone): while it is mounted, focus is inside it and everything behind it is
 * inert, except the elements matching `keep` (its scrim, which closes it) and what floats over every sheet
 * (`OVER_SHEETS`). When it goes, focus returns to what had it
 * before, unless something else already took it (a panel the sheet opened). A sheet that replaced another (Ver perfil
 * from a thread) was opened from inside it, gone by then: the focus goes back to what opened the first. Nothing left
 * of either (a popover's row): the conversation's composer, as Esc does (`useEscClose`).
 */
export function useModalSheet(sheet: RefObject<HTMLElement | null>, keep?: string) {
  // Read on the first render, before a field inside takes the focus (`autoFocus`).
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const replaced = handedOver;
    const behind: HTMLElement[] = [];
    for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sib of Array.from(parent.children))
        if (
          sib !== node &&
          sib instanceof HTMLElement &&
          !sib.inert &&
          !sib.matches(OVER_SHEETS) &&
          !(keep && sib.matches(keep))
        )
          behind.push(sib);
    }
    for (const b of behind) b.inert = true;
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      for (const b of behind) b.inert = false;
      const now = document.activeElement;
      const lost = !now || now === document.body || el.contains(now);
      const back = opener?.isConnected ? opener : replaced?.isConnected ? replaced : null;
      if (lost) (back ?? document.querySelector<HTMLElement>('[id^="composer-"]'))?.focus({ preventScroll: true });
      handedOver = back;
      queueMicrotask(() => {
        if (handedOver === back) handedOver = null;
      });
    };
  }, [sheet, keep, opener]);
}

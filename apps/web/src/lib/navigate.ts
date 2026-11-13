import type { MouseEvent } from "react";

/** Leaves the app for an external URL (OAuth providers). Replaceable in tests. */
let impl = (url: string) => window.location.assign(url);

export const navigateAway = (url: string) => impl(url);

export function setNavigateAway(next: (url: string) => void) {
  impl = next;
}

/**
 * A link that also opens its target in place (a panel, a dialog over the page): a plain click opens it there; a
 * modified or middle click still follows the link (a new tab, its page).
 */
export function inPlaceClick(e: MouseEvent, open: () => void) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  open();
}

import type { MachineAccountKind } from "@agenteschat/client";
import { inDesktopApp } from "./desktop";

/** A provider's sign-in or key page: its own window beside the app. */
const FEATURES = "popup,width=520,height=760";

/**
 * Opens `url` as a popup. Called from the click itself (browsers block popups opened later). Null when the browser
 * refused it; the caller then offers a link. The page it opens can't reach back into the app (`opener`).
 */
export function openPopup(url: string): Window | null {
  let w: Window | null = null;
  try {
    w = window.open(url, "_blank", FEATURES);
  } catch {
    return null;
  }
  try {
    if (w) w.opener = null;
  } catch {
    // already another site's
  }
  return w;
}

/**
 * A popup for a sign-in whose address isn't known yet, on our page that says what's happening (`/conectando`). Not in
 * the desktop app, whose windows are the browser's: a page of ours would take over the app's window (main_window.rs).
 */
export const openWaitingPopup = (kind: MachineAccountKind) =>
  inDesktopApp() ? null : openPopup(`/conectando?kind=${kind}`);

/** Sends the waiting popup to `url`, in its place in the popup's history (closed meanwhile: nothing). */
export function sendPopup(w: Window | null, url: string) {
  try {
    if (w && !w.closed) w.location.replace(url);
  } catch {
    // gone, or not ours any more
  }
}

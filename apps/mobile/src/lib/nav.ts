import { light } from "@agenteschat/tokens";

/**
 * Pure helpers for the native navigation (tab bar, headers, sheets). No React Native imports, so the
 * unit tests can load them.
 */

/** The text of a tab's badge: nothing at zero, the count up to 99, then "99+". */
export function tabBadge(count: number): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return count > 99 ? "99+" : String(Math.floor(count));
}

/**
 * iOS before 26 has no Liquid Glass: a transparent native header needs a blur of its own there.
 * `version` is `Platform.Version` (a string like "18.4" on iOS, the API level number on Android).
 */
export function needsHeaderBlur(os: string, version: string | number): boolean {
  if (os !== "ios") return false;
  const major = Number.parseInt(String(version), 10);
  return Number.isFinite(major) && major < 26;
}

export { contrastRatio } from "@agenteschat/ui/sky/math";

/**
 * The unread badge of the tab bar: a classic red with white text in both themes. iOS always draws badge
 * text in white (UIKit has no text color for tab badges), so the background must be dark enough for it;
 * the light theme's danger red is, and it stays legible on the dark bar too.
 */
export const TAB_BADGE = { background: light.danger, text: "#ffffff" } as const;

/** A quick double tap's two presses fall within this. */
export const AGAIN_MS = 600;

/**
 * `push` that takes the same screen pushed again within `AGAIN_MS` as the same tap (a double tap): it goes once, so
 * Back never shows that screen again. Another screen, or the same one later, goes as asked.
 */
export function pushOnce<A extends unknown[]>(push: (...args: A) => void, now: () => number = Date.now) {
  let last: { to: string; at: number } | null = null;
  return (...args: A) => {
    const to = JSON.stringify(args[0]);
    const at = now();
    if (last && last.to === to && at - last.at < AGAIN_MS) return;
    last = { to, at };
    push(...args);
  };
}

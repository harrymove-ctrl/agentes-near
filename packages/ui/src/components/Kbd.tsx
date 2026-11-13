import type { HTMLAttributes } from "react";
import { cx } from "../cx";

/** A keyboard hint: "⌘", "↵", "esc". Decorative next to a label that already says the action. */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx("ac-kbd", className)} {...rest} />;
}

/** Apple platforms (macOS, iOS, iPadOS): ⌘ is the shortcut key there, as noVNC also assumes. */
export const isApple = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "⌘" on Apple platforms, "Ctrl" elsewhere. */
export const modKey = () => (isApple() ? "⌘" : "Ctrl");

/** A shortcut in a sentence, as the platform writes it: "⌘C" on Apple platforms, "Ctrl+C" elsewhere. */
export const shortcut = (key: string) => (isApple() ? `⌘${key}` : `Ctrl+${key}`);

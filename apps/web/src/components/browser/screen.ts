import type { ScreenKind } from "@agenteschat/client";
import type { IconName } from "@agenteschat/ui";
import type { TFunction } from "i18next";

/**
 * The cards' words by screen: the desktop's own wording where it has one (`desktop.*`), else the
 * browser's (`browser.*`), so the desktop's namespace holds only what differs.
 */
export function screenT(t: TFunction, screen: ScreenKind) {
  const loose = t as unknown as (keys: string[], options?: Record<string, unknown>) => string;
  return (key: string, options?: Record<string, unknown>) =>
    screen === "browser" ? loose([`browser.${key}`], options) : loose([`${screen}.${key}`, `browser.${key}`], options);
}

export const screenIcon = (screen: ScreenKind): IconName => (screen === "desktop" ? "computer" : "globe");

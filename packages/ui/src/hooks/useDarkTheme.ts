import { useSyncExternalStore } from "react";

const subscribeTheme = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};

/**
 * The page's theme as drawn (`data-theme` on <html>), for drawings that pick colors in script: the chat's charts,
 * widgets and their dither tiles.
 */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.dataset.theme === "dark",
    () => false,
  );
}

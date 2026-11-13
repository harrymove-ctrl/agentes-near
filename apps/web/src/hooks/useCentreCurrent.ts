import { prefersReducedMotion } from "@agenteschat/ui";
import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * A strip that scrolls sideways (the settings' sections on a phone) brings its current item (`[aria-current]`) to
 * its middle, or as near as its ends allow: at once as it opens, gliding when another item becomes current. Only
 * the strip scrolls, never the page.
 */
export function useCentreCurrent(strip: RefObject<HTMLElement | null>, current: string) {
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again each time another item is current
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    place(el, opened.current && !prefersReducedMotion() ? "smooth" : "instant");
    opened.current = true;
    // A first visit can lay the strip out before the web font arrives, and the font changes every item's width.
    // `ready`, not `loadingdone`: WebKit fires no `loadingdone` for a font a stylesheet loads.
    if (document.fonts?.status !== "loading") return;
    let live = true;
    void document.fonts.ready.then(() => live && place(el, "instant"));
    return () => {
      live = false;
    };
  }, [strip, current]);
  // A phone turned, or a window narrowed until the column became a strip.
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.getBoundingClientRect().width;
    const resized = new ResizeObserver(() => {
      const now = el.getBoundingClientRect().width;
      if (now === width) return;
      width = now;
      place(el, "instant");
    });
    resized.observe(el);
    return () => resized.disconnect();
  }, [strip]);
}

function place(strip: HTMLElement, behavior: ScrollBehavior) {
  const item = strip.querySelector("[aria-current]");
  if (!item) return;
  const box = strip.getBoundingClientRect();
  const at = item.getBoundingClientRect();
  strip.scrollTo({ left: strip.scrollLeft + at.left + at.width / 2 - (box.left + box.width / 2), behavior });
}

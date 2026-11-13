import { type RefObject, useLayoutEffect } from "react";

/**
 * A column that scrolls on its own fades out at an edge only while there is more to scroll past it (no hard cut): sets
 * `data-fade-top` and `data-fade-bottom` on it from its scroll position, which its CSS turns into a mask (the
 * sidebar's list, a new agent's card). A row that scrolls sideways (`axis: "x"`) gets `data-fade-start` and
 * `data-fade-end` (a new agent's band on a narrow phone). Checked on scroll, when it or its children resize, and when
 * `deps` change (content that loads or swaps without resizing them).
 */
export function useScrollEdges(ref: RefObject<HTMLElement | null>, deps: readonly unknown[], axis: "x" | "y" = "y") {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const edges = () => {
      if (axis === "x") {
        el.dataset.fadeStart = String(el.scrollLeft > 1);
        el.dataset.fadeEnd = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
        return;
      }
      el.dataset.fadeTop = String(el.scrollTop > 1);
      el.dataset.fadeBottom = String(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    edges();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(edges);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    el.addEventListener("scroll", edges, { passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener("scroll", edges);
    };
  }, [ref, axis, ...deps]);
}

import { type RefObject, useCallback, useEffect, useState } from "react";

/** The ends of a sideways scroller with more past them; undefined: it all fits, or it isn't drawn yet. */
export type ScrollSides = "start" | "end" | "both" | undefined;

/**
 * Which ends of a sideways scroller have more past them, kept as it scrolls or resizes (and as its content does):
 * what fades at its edges and which arrows it offers (a carousel, the task board, a table in a message).
 */
export function useScrollSides(ref: RefObject<HTMLElement | null>): ScrollSides {
  const [sides, setSides] = useState<ScrollSides>(undefined);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setSides(start && end ? "both" : start ? "start" : end ? "end" : undefined);
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(el);
    if (el.firstElementChild) resize?.observe(el.firstElementChild);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      resize?.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [ref, measure]);
  return sides;
}

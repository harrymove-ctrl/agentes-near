import { useEffect, useState } from "react";

/** A touch screen: the main pointer is a finger. */
export const TOUCH = "(pointer: coarse)";

/** A screen whose main pointer can't rest over anything (a phone, a tablet): no hover, so no tooltip shows. */
export const HOVERLESS = "(hover: none)";

/** Whether `query` (a CSS media query) matches at this moment. */
export const matchesNow = (query: string) =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

/** Whether `query` (a CSS media query) matches now, kept current as the window changes. */
export function useMatchMedia(query: string) {
  const [matches, setMatches] = useState(() => matchesNow(query));
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

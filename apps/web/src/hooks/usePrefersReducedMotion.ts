import { useEffect, useState } from "react";

const REDUCE = "(prefers-reduced-motion: reduce)";

const reducedNow = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;

/** Whether the person asked for less motion (follows changes to the setting). */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(reducedNow);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCE);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

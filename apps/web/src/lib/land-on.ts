import { type RefObject, useEffect } from "react";

const LANDED_MS = 2400;

/**
 * Lands on the item a link named (`data-item-id` under `root`) once it is on the page (`ready`): centered, and lit for
 * a moment (`.is-landed`).
 */
export function useLandOn(root: RefObject<HTMLElement | null>, id: string | undefined, ready: boolean) {
  useEffect(() => {
    if (!id || !ready) return;
    const el = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-item-id]") ?? []).find(
      (e) => e.dataset.itemId === id,
    );
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("is-landed");
    const timer = setTimeout(() => el.classList.remove("is-landed"), LANDED_MS);
    return () => {
      clearTimeout(timer);
      el.classList.remove("is-landed");
    };
  }, [root, id, ready]);
}

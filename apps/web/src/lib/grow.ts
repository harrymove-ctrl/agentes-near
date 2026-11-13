import { type RefObject, useEffect, useRef } from "react";

/**
 * A dialog that grows out of the card it was opened from (the code and chart cards' full screen): call
 * `remember()` before opening; once `open`, the dialog (`selector`) starts on the card's box and settles in
 * the middle, its parts fading in. Phones (bottom sheets) and reduced motion skip it.
 */
export function useGrowFrom(open: boolean, card: RefObject<HTMLElement | null>, selector: string) {
  const from = useRef<DOMRect | null>(null);
  useEffect(() => {
    const start = from.current;
    if (!open || !start) return;
    from.current = null;
    if (matchMedia("(prefers-reduced-motion: reduce), (max-width: 640px)").matches) return;
    const frame = requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>(selector);
      if (!dialog) return;
      const end = dialog.getBoundingClientRect();
      if (!end.width || !end.height) return;
      const x = start.left - innerWidth / 2;
      const y = start.top - innerHeight / 2;
      dialog.animate(
        [
          {
            transformOrigin: "0 0",
            transform: `translate(${x}px, ${y}px) scale(${start.width / end.width}, ${start.height / end.height})`,
          },
          { transformOrigin: "0 0", transform: "translate(-50%, -50%)" },
        ],
        { duration: 420, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
      );
      for (const part of Array.from(dialog.children))
        part.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 200,
          delay: 140,
          easing: "ease-out",
          fill: "backwards",
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, selector]);
  return () => {
    from.current = card.current?.getBoundingClientRect() ?? null;
  };
}

/** The page's theme as drawn: it lives with the drawings in `@agenteschat/ui`. */
export { useDarkTheme } from "@agenteschat/ui";

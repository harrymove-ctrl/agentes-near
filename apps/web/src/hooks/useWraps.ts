import { type RefObject, useLayoutEffect, useState } from "react";

const runsPastFirstLine = (el: HTMLElement) => {
  const line = Number.parseFloat(getComputedStyle(el).lineHeight);
  return line > 0 && el.clientHeight > line * 1.5;
};

/** Whether an element's text runs past its first line, read before new words paint and again as they reflow. */
export function useWraps(ref: RefObject<HTMLElement | null>) {
  const [wraps, setWraps] = useState(false);
  // Read after every render too: React applies what a ResizeObserver reports only after that frame has painted, so the
  // first words, or new ones, would paint once with the last answer.
  useLayoutEffect(() => {
    if (ref.current) setWraps(runsPastFirstLine(ref.current));
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWraps(runsPastFirstLine(el)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return wraps;
}

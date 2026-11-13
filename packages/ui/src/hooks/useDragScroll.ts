import { type RefObject, useEffect } from "react";

/** How far a press moves before it pans: a shaky click stays a click. */
const SLOP = 3;
/** Speed kept per 16 ms after the release, and below what (px/ms) the glide stops. */
const FRICTION = 0.95;
const STOP = 0.02;
/** Only the last moves count toward the speed at release: a pause before letting go means no glide. */
const SAMPLE_MS = 80;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A sideways scroller a mouse drags, as Trello's board: a press on its empty space (`from`, matched by the pressed
 * element itself, so words, cards and buttons inside keep their own press) and a drag moves it, and it glides on a
 * little after the release unless the system asks for less motion. Shift and the wheel slide it too. A finger and a pen
 * already pan it natively.
 */
export function useDragScroll(ref: RefObject<HTMLElement | null>, from: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let glide = 0;
    const stopGlide = () => cancelAnimationFrame(glide);
    const onDown = (e: PointerEvent) => {
      stopGlide();
      if (e.button !== 0 || e.pointerType !== "mouse" || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (!(e.target instanceof Element) || !e.target.matches(from)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      // No text selection starts from the press; the focus leaves what had it, as any press on empty space does.
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body)
        document.activeElement.blur();
      const x0 = e.clientX;
      const left0 = el.scrollLeft;
      let panning = false;
      let moves: { x: number; t: number }[] = [];
      const onMove = (m: PointerEvent) => {
        if (m.pointerId !== e.pointerId) return;
        if (!panning && Math.abs(m.clientX - x0) < SLOP) return;
        if (!panning) {
          panning = true;
          el.style.cursor = "grabbing";
        }
        el.scrollLeft = left0 - (m.clientX - x0);
        moves = [...moves.filter((p) => m.timeStamp - p.t < SAMPLE_MS), { x: m.clientX, t: m.timeStamp }];
      };
      const onUp = (u: PointerEvent) => {
        if (u.pointerId !== e.pointerId) return;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        el.style.cursor = "";
        const first = moves[0];
        const last = moves.at(-1);
        if (!panning || !first || !last || last.t === first.t || u.timeStamp - last.t > SAMPLE_MS || reduced()) return;
        let v = (first.x - last.x) / (last.t - first.t);
        let at = performance.now();
        const step = (now: number) => {
          const dt = now - at;
          at = now;
          const was = el.scrollLeft;
          el.scrollLeft += v * dt;
          v *= FRICTION ** (dt / 16);
          if (Math.abs(v) > STOP && el.scrollLeft !== was) glide = requestAnimationFrame(step);
        };
        glide = requestAnimationFrame(step);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    };
    // The wheel or a trackpad takes over from a glide. Shift and an up-and-down wheel go sideways, over a column that
    // scrolls up and down too: the system does it on some (macOS hands over sideways deltas), not on all.
    const onWheel = (e: WheelEvent) => {
      stopGlide();
      if (!e.shiftKey || e.deltaX || !e.deltaY || e.ctrlKey) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientWidth : 1);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stopGlide();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("wheel", onWheel);
    };
  }, [ref, from]);
}

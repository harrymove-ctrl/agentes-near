import { type RefObject, useEffect, useRef } from "react";
import { HORIZON_CELL as CELL, horizonCrest, horizonHeight, horizonTones, HORIZON_WAVE as WAVE } from "../sky/horizon";
import { bayerAt } from "../sky/math";
import type { AgentColor } from "./AgentLook";

export { horizonCrest, horizonHeight, horizonTones } from "../sky/horizon";

/** A CSS color as "#rrggbb" (color-mix and color() too), read back from one painted pixel; translucent → fallback. */
function hexOf(css: string, fallback: string): string {
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return fallback;
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gr = 0, b = 0, a = 0] = g.getImageData(0, 0, 1, 1).data;
  if (a < 255) return fallback;
  return `#${[r, gr, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Where `holder`'s content ends: its children's lowest edge (the holder itself may be stretched to the card). */
function contentBottom(holder: HTMLElement): number {
  let bottom = holder.getBoundingClientRect().top;
  for (const child of holder.children) {
    if (child instanceof HTMLElement && child.hidden) continue;
    bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
  }
  return bottom;
}

/**
 * The agents' horizon at the foot of a card with room to spare: a low, still Bayer dither from the card's own ground
 * into the sky's light tones. It measures the room between `content`'s children and the card's bottom (the card is the
 * canvas's parent, positioned, a stacking context: the canvas sits under its text), and draws nothing when that room
 * is small, so a full card never has it.
 */
export function CardHorizon({
  content,
  color = "sky",
}: {
  /** The element holding the card's content; where its children end is where the room starts. */
  content: RefObject<HTMLElement | null>;
  color?: AgentColor;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const card = canvas?.parentElement;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !card || !ctx) return;
    const draw = () => {
      const inner = content.current;
      const box = card.getBoundingClientRect();
      const room = inner ? box.bottom - contentBottom(inner) : 0;
      const height = horizonHeight(room);
      if (!height || !box.width) {
        canvas.hidden = true;
        return;
      }
      canvas.hidden = false;
      const w = Math.ceil(box.width / CELL);
      const h = Math.ceil(height / CELL);
      canvas.width = w;
      canvas.height = h;
      canvas.style.height = `${h * CELL}px`;
      const dark = document.documentElement.dataset.theme === "dark";
      const surface = hexOf(getComputedStyle(card).backgroundColor, dark ? "#191918" : "#f6f6f4");
      const tones = horizonTones(color, surface, dark);
      const last = tones.length - 1;
      ctx.clearRect(0, 0, w, h);
      for (let x = 0; x < w; x++) {
        const crest = horizonCrest((box.left + x * CELL) / WAVE);
        for (let y = Math.ceil(crest * h); y < h; y++) {
          const f = Math.min(1, 0.2 + ((y / h - crest) / (1 - crest)) * 0.85);
          const k = f * last;
          const lo = Math.floor(k);
          const i = Math.min(last, lo + (k - lo > bayerAt(x, y) ? 1 : 0));
          if (i === 0) continue;
          ctx.fillStyle = tones[i] ?? surface;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    };
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const size = new ResizeObserver(draw);
    size.observe(card);
    if (content.current) {
      size.observe(content.current);
      for (const child of content.current.children) size.observe(child);
    }
    // Content swapped (an empty line for the rows): watch the new children too.
    const swapped = new MutationObserver(() => {
      for (const child of content.current?.children ?? []) size.observe(child);
      draw();
    });
    if (content.current) swapped.observe(content.current, { childList: true });
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      size.disconnect();
      swapped.disconnect();
      theme.disconnect();
    };
  }, [content, color]);
  return <canvas ref={ref} className="ac-card-horizon" aria-hidden="true" tabIndex={-1} hidden />;
}

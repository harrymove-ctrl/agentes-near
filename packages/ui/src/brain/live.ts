/**
 * Living engines: one shared loop draws every engine portrait on screen from
 * the portrait engine (portrait.js), about 11 times a second. Only visible
 * portraits are drawn; with reduced motion each one is drawn once, still (and
 * again when what it shows changes).
 */
import { type BrainAgentLook, type BrainPortraitKind, type BrainPortraitState, drawBrain } from "./portrait.js";

export interface LiveBrain {
  canvas: HTMLCanvasElement;
  /** Read each frame: what to draw. */
  look: () => { kind: BrainPortraitKind; state: BrainPortraitState; agentLook?: BrainAgentLook };
}

/** The still frame shown with reduced motion (the line half written, the code half typed). */
export const STILL_T = 1.2;

const brains = new Set<LiveBrain>();
const visible = new WeakSet<Element>();
let timer: ReturnType<typeof setTimeout> | 0 = 0;
let observer: IntersectionObserver | null = null;

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches === true;
const now = () => (typeof performance === "object" ? performance.now() : Date.now()) / 1000;
const isDark = (el: Element) => el.closest("[data-theme]")?.getAttribute("data-theme") === "dark";

/** How many portraits the loop is drawing (tests). */
export function liveBrainCount() {
  return brains.size;
}

/** Draws one portrait now (a still frame when motion is reduced). */
export function drawLiveBrain(b: LiveBrain, t = now()) {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = b.canvas.getContext("2d");
  } catch {
    return;
  }
  if (!ctx) return;
  const { kind, state, agentLook } = b.look();
  drawBrain(ctx, kind, state, { dark: isDark(b.canvas), t: reduced() ? STILL_T : t, agentLook });
}

function tick() {
  timer = 0;
  const t = now();
  if (typeof document === "undefined" || !document.hidden)
    for (const b of brains) if (visible.has(b.canvas)) drawLiveBrain(b, t);
  schedule();
}

function schedule() {
  if (timer || !brains.size || reduced()) return;
  timer = setTimeout(() => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(tick);
    else tick();
  }, 90);
}

/** Starts drawing a portrait; returns the cleanup. */
export function addLiveBrain(b: LiveBrain): () => void {
  brains.add(b);
  if (typeof IntersectionObserver === "function") {
    observer ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
    });
    observer.observe(b.canvas);
  } else visible.add(b.canvas);
  drawLiveBrain(b);
  schedule();
  return () => {
    brains.delete(b);
    observer?.unobserve(b.canvas);
    visible.delete(b.canvas);
  };
}

/**
 * Living computers: one shared loop draws every computer portrait on screen
 * from the portrait engine (portrait.js), about 11 times a second. Only
 * visible portraits are drawn; with reduced motion each one is drawn once,
 * still (and again when its kind or state changes).
 */
import { COMPUTER_ART, type ComputerState, drawComputer, type PortraitKind } from "./portrait.js";

export interface LiveComputer {
  canvas: HTMLCanvasElement;
  /** Read each frame: what to draw. */
  look: () => { kind: PortraitKind; state: ComputerState };
}

const computers = new Set<LiveComputer>();
const visible = new WeakSet<Element>();
let timer: ReturnType<typeof setTimeout> | 0 = 0;
let observer: IntersectionObserver | null = null;

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches === true;
const now = () => (typeof performance === "object" ? performance.now() : Date.now()) / 1000;
const isDark = (el: Element) => el.closest("[data-theme]")?.getAttribute("data-theme") === "dark";

/** How many portraits the loop is drawing (tests). */
export function liveComputerCount() {
  return computers.size;
}

/** Draws one portrait now (`t` 0 when motion is reduced: a still frame). */
export function drawLiveComputer(c: LiveComputer, t = now()) {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = c.canvas.getContext("2d");
  } catch {
    return;
  }
  if (!ctx) return;
  const { kind, state } = c.look();
  // The canvas is as wide as the kind's art: the grid's first drawn column lands on its left edge.
  ctx.setTransform(1, 0, 0, 1, -COMPUTER_ART[kind][0], 0);
  drawComputer(ctx, kind, state, { dark: isDark(c.canvas), t: reduced() ? 0 : t });
}

function tick() {
  timer = 0;
  const t = now();
  if (typeof document === "undefined" || !document.hidden)
    for (const c of computers) if (visible.has(c.canvas)) drawLiveComputer(c, t);
  schedule();
}

function schedule() {
  if (timer || !computers.size || reduced()) return;
  timer = setTimeout(() => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(tick);
    else tick();
  }, 90);
}

/** Starts drawing a portrait; returns the cleanup. */
export function addLiveComputer(c: LiveComputer): () => void {
  computers.add(c);
  if (typeof IntersectionObserver === "function") {
    observer ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
    });
    observer.observe(c.canvas);
  } else visible.add(c.canvas);
  drawLiveComputer(c);
  schedule();
  return () => {
    computers.delete(c);
    observer?.unobserve(c.canvas);
    visible.delete(c.canvas);
  };
}

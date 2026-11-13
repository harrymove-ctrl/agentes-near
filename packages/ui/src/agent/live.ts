/**
 * Living agents: one shared loop draws every agent avatar on screen from the
 * agent engine (engine.js). Only visible avatars are drawn: about 24 times a
 * second while the agent works, reacts or follows the gaze, about 12 at rest
 * (every blink still shows; a slow turn reads the same); with reduced motion
 * each one is drawn once, still. A page can set a gaze point (the landing's
 * pointer): avatars inside an element marked `data-gaze` turn their heads
 * toward it.
 */
import { avatarSky } from "../sky/avatar";
import {
  ACCESSORY_REACH,
  bodyTones,
  type DrawAgentOptions,
  drawAccessory,
  drawAgent,
  drawSleep,
  EYE_COLOR,
  idlePose,
  type Pose,
  sleepPose,
} from "./engine.js";

export interface LiveAgent {
  canvas: HTMLCanvasElement;
  /** The avatar's box (the body), for size and gaze. */
  box: HTMLElement;
  /** Read each frame: what to draw. */
  look: () => {
    color?: DrawAgentOptions["color"];
    eyes?: DrawAgentOptions["eyes"];
    accessory?: string;
    state: "idle" | "thinking" | "writing" | "waiting" | "sleeping";
    expression?: Pose["expression"];
    seed: number;
    /** Plays the transient face started by `playAgentReaction` with this key (e.g. a message id). */
    reactionKey?: string;
    /** Stands in its tile: its own pixel sky fills the box and the agent stands inside it. */
    framed?: boolean;
  };
}

/** A person's 👍 (`up`) or 👎 (`down`) on what this agent wrote. */
export type AgentReaction = "up" | "down";
/** How long the face lasts before the agent goes back to idle. */
export const REACTION_SECONDS = 1.6;
const reactions = new Map<string, { kind: AgentReaction; t0: number }>();
const clock = () => (typeof performance === "object" ? performance.now() : Date.now());

/**
 * The face for a reaction `e` seconds in: 👍 is
 * happy, then hearts, with a small hop at the start; 👎 is surprised, then a
 * thoughtful look up and aside. With reduced motion only the expression
 * changes (no hop, no turn). `hop` is a fraction of the body's size.
 */
export function reactionPose(kind: AgentReaction, e: number, still: boolean): { pose: Pose; hop: number } {
  if (kind === "up") {
    const expression = e < 0.65 ? "happy" : "heart";
    if (still) return { pose: { expression, blink: false, turn: [0, 0], squash: 0 }, hop: 0 };
    return {
      pose: {
        expression,
        blink: false,
        turn: [0, -0.2],
        squash: Math.sin(e * 13) * 0.8 * Math.max(0, 1 - e / 1.2),
      },
      hop: e < 0.6 ? Math.abs(Math.sin((e * Math.PI) / 0.3)) * 0.07 : 0,
    };
  }
  if (e < 0.55)
    return {
      pose: { expression: "surprised", blink: false, turn: still ? [0, 0] : [0, -0.1], squash: still ? 0 : -0.6 },
      hop: 0,
    };
  return {
    pose: { expression: undefined, blink: false, look: [-0.28, -0.32], turn: still ? [0, 0] : [-0.4, -0.3], squash: 0 },
    hop: 0,
  };
}

/** The reaction playing for `key` and how far in it is (seconds), or null. */
export function agentReactionOf(key: string | undefined): { kind: AgentReaction; elapsed: number } | null {
  if (!key) return null;
  const r = reactions.get(key);
  if (!r) return null;
  const elapsed = (clock() - r.t0) / 1000;
  if (elapsed > REACTION_SECONDS) {
    reactions.delete(key);
    return null;
  }
  return { kind: r.kind, elapsed };
}

/**
 * Every avatar drawn with `reactionKey === key` makes the reaction's face for
 * ~1.6 s, then goes back to idle. With reduced motion the loop stands still,
 * so the faces are drawn at each change.
 */
export function playAgentReaction(key: string, kind: AgentReaction) {
  reactions.set(key, { kind, t0: clock() });
  const redraw = () => {
    for (const a of agents) if (a.look().reactionKey === key) drawLive(a, clock() / 1000);
  };
  redraw();
  if (reduced()) {
    for (const ms of [600, 700, (REACTION_SECONDS + 0.05) * 1000]) setTimeout(redraw, ms);
  } else if (!raf && agents.size && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
}

const agents = new Set<LiveAgent>();
const visible = new WeakSet<HTMLElement>();
let raf = 0;
let last = 0;
let lastRest = 0;
let gaze: { x: number; y: number } | null = null;
let observer: IntersectionObserver | null = null;
/** Frame gaps (ms): an agent at work, and one at rest. */
const ACTIVE_MS = 40;
const REST_MS = 80;

// Read every frame for every avatar: kept here instead of asking the page (a layout read, a media query).
const sizes = new WeakMap<HTMLElement, number>();
let resizes: ResizeObserver | null = null;
let darkCache = new WeakMap<Element, boolean>();
let motionQuery: MediaQueryList | null | undefined;
const reduced = () => {
  if (motionQuery === undefined) {
    motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    // Motion allowed again: the loop starts moving.
    motionQuery?.addEventListener?.("change", () => {
      if (!motionQuery?.matches && !raf && agents.size && typeof requestAnimationFrame === "function")
        raf = requestAnimationFrame(tick);
    });
  }
  return motionQuery?.matches === true;
};

const sizeOf = (box: HTMLElement) => sizes.get(box) ?? box.clientWidth;

/** How many agents the loop is drawing (tests). */
export function liveAgentCount() {
  return agents.size;
}

/** The current gaze point (client coordinates), if a page set one. */
export function getGaze() {
  return gaze;
}

/** Where avatars inside `[data-gaze]` look (client coordinates), or null to let them wander. */
export function setGaze(point: { x: number; y: number } | null) {
  gaze = point;
}

/** In the app expressions are rare (one every ~18 s per agent); thinking speeds the head up. */
function poseFor(a: ReturnType<LiveAgent["look"]>, t: number, box: HTMLElement, gazing: boolean): Pose {
  if (a.state === "sleeping") return sleepPose(reduced() ? undefined : t, a.seed);
  if (a.state === "writing") return { writing: true, turn: [Math.sin(t * 1.3 + a.seed) * 0.15, 0.1] };
  // Waiting on you: looking up out of its card, blinking, now and then a glance aside.
  if (a.state === "waiting") {
    const pose: Pose = idlePose(t, a.seed, { every: 99, expressions: [] });
    const g = Math.sin(t * 0.35 + a.seed * 2);
    pose.expression = undefined;
    pose.turn = [g > 0.85 ? 0.45 : g < -0.9 ? -0.4 : 0.05, -0.32];
    pose.look = [0, -0.12];
    return pose;
  }
  const pose: Pose = idlePose(t, a.seed, { active: a.state === "thinking", every: 18 });
  if (a.state === "thinking") pose.expression = undefined;
  if (a.expression) pose.expression = a.expression;
  if (gazing && gaze && a.state !== "thinking") {
    const r = box.getBoundingClientRect();
    const k = (v: number) => Math.max(-1, Math.min(1, v));
    pose.turn = [k((gaze.x - (r.left + r.width / 2)) / 380), k((gaze.y - (r.top + r.height / 2)) / 300)];
  }
  return pose;
}

const isDark = (el: Element) => {
  let dark = darkCache.get(el);
  if (dark === undefined) {
    dark = el.closest("[data-theme]")?.getAttribute("data-theme") === "dark";
    darkCache.set(el, dark);
  }
  return dark;
};

/**
 * Draws one agent now. Framed: the canvas is the tile (the agent's sky, then
 * the agent standing in it). Unframed: the canvas is a bit larger than the
 * box, with room for accessories.
 */
export function drawLive(agent: LiveAgent, t: number) {
  const { canvas, box } = agent;
  const size = sizeOf(box);
  if (!size) return;
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return;
  }
  if (!ctx) return;
  const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  if (agent.look().framed) {
    drawFramed(agent, ctx, size, dpr, t);
    return;
  }
  const R = ACCESSORY_REACH;
  const w = Math.round(size * (1 + R.left + R.right) * dpr);
  const h = Math.round(size * (1 + R.top + R.bottom) * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  const look = agent.look();
  const s = size * dpr;
  const { pose, hop: lift } = livePose(agent, t);
  const hop = lift * s;
  drawAgent(ctx, R.left * s, R.top * s - hop, s, {
    color: look.color,
    eyes: look.eyes,
    pose,
    cells: size <= 28 ? 8 : 16,
    after: decorate(agent, t),
  });
}

/** The pose for this frame, with a playing reaction's face and hop (a fraction of the body). */
function livePose(agent: LiveAgent, t: number): { pose: Pose; hop: number } {
  const look = agent.look();
  const gazing = !!gaze && !!agent.box.closest("[data-gaze]");
  const still = reduced();
  const pose = poseFor(look, still ? 0 : t, agent.box, gazing);
  const playing = agentReactionOf(look.reactionKey);
  if (!playing) return { pose, hop: 0 };
  const face = reactionPose(playing.kind, playing.elapsed, still);
  return { pose: { ...pose, ...face.pose }, hop: face.hop };
}

/**
 * The tile: the agent's pixel sky fills the
 * canvas; the agent stands centered, feet near the bottom edge, smaller with
 * an accessory so it has room above (at every size: the agent is always itself).
 */
function drawFramed(agent: LiveAgent, ctx: CanvasRenderingContext2D, size: number, dpr: number, t: number) {
  const { canvas, box } = agent;
  const s = Math.round(size * dpr);
  if (canvas.width !== s || canvas.height !== s) {
    canvas.width = s;
    canvas.height = s;
  }
  ctx.clearRect(0, 0, s, s);
  const look = agent.look();
  const sky = avatarSky(look.color, s, isDark(box));
  if (sky) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sky, 0, 0, s, s);
  }
  const inner = s * (look.accessory ? 0.6 : 0.66);
  const x = (s - inner) / 2;
  const y = s - inner - s * (look.accessory ? 0.1 : 0.14);
  const { pose, hop } = livePose(agent, t);
  drawAgent(ctx, x, y - hop * inner, inner, {
    color: look.color,
    eyes: look.eyes,
    pose,
    cells: size <= 32 ? 12 : undefined,
    after: decorate(agent, t),
  });
}

/** What sits on the body: its accessory, then a sleeping agent's zz (the body's darkest tone on a light page). */
function decorate(agent: LiveAgent, t: number): DrawAgentOptions["after"] {
  const look = agent.look();
  const accessory = look.accessory;
  const sleeping = look.state === "sleeping";
  if (!accessory && !sleeping) return undefined;
  const ink = sleeping ? (isDark(agent.box) ? EYE_COLOR : (bodyTones(look.color)[0] ?? EYE_COLOR)) : "";
  return (g, side, frame) => {
    if (accessory) drawAccessory(g, side, accessory, frame, t, look.state === "thinking");
    if (sleeping) drawSleep(g, side, frame, ink, reduced() ? undefined : t);
  };
}

/** Redraws every agent at once (a new theme changes their skies; the loop may be standing still). */
function redrawAll() {
  darkCache = new WeakMap();
  const t = clock() / 1000;
  for (const a of agents) drawLive(a, t);
}

let themeWatch: MutationObserver | null = null;
function watchTheme() {
  if (themeWatch || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  themeWatch = new MutationObserver(redrawAll);
  // Subtree: a page can theme its own part (the landing's `data-theme`).
  themeWatch.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["data-theme"] });
}

/** Working, waiting on someone, making a face or following the gaze: drawn at the full rate (asleep: at rest's). */
const busy = (a: LiveAgent) => {
  const look = a.look();
  if ((look.state !== "idle" && look.state !== "sleeping") || (look.reactionKey && reactions.has(look.reactionKey)))
    return true;
  return Boolean(gaze && a.box.closest("[data-gaze]"));
};

function tick(now: number) {
  raf = 0;
  if (now - last >= ACTIVE_MS) {
    last = now;
    const rest = now - lastRest >= REST_MS;
    if (rest) lastRest = now;
    const t = now / 1000;
    // A full-screen menu is open (MenuOverlay): the app behind is blurred, so its avatars hold still
    // (each frame there would blur the whole screen again); the ones in the menu keep moving.
    const covered = typeof document !== "undefined" && document.documentElement.dataset.menuOverlay !== undefined;
    for (const a of agents) {
      if (!visible.has(a.box) || !(rest || busy(a))) continue;
      if (covered && !a.box.closest(".ac-mo")) continue;
      drawLive(a, t);
    }
  }
  if (agents.size && !reduced()) raf = requestAnimationFrame(tick);
}

/** Starts drawing an agent; returns the cleanup. */
export function addLiveAgent(agent: LiveAgent): () => void {
  agents.add(agent);
  watchTheme();
  if (typeof IntersectionObserver === "function") {
    observer ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target as HTMLElement);
        else visible.delete(e.target as HTMLElement);
      }
    });
    observer.observe(agent.box);
  } else visible.add(agent.box);
  if (typeof ResizeObserver === "function") {
    resizes ??= new ResizeObserver((entries) => {
      const t = clock() / 1000;
      for (const e of entries) {
        const box = e.target as HTMLElement;
        sizes.set(box, box.clientWidth);
        for (const a of agents) if (a.box === box) drawLive(a, t);
      }
    });
    resizes.observe(agent.box);
  }
  drawLive(agent, typeof performance === "object" ? performance.now() / 1000 : 0);
  if (!raf && !reduced() && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
  return () => {
    agents.delete(agent);
    observer?.unobserve(agent.box);
    resizes?.unobserve(agent.box);
    sizes.delete(agent.box);
    visible.delete(agent.box);
  };
}

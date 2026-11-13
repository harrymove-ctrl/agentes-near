import {
  cx,
  type Expression,
  mix,
  PixelSky,
  parseColor,
  pixelOf,
  prefersReducedMotion,
  type SkyFrame,
  type SkyOptions,
} from "@agenteschat/ui";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import "./arrival.css";

/*
 * The team on a pixel sky (ADR 0160): the agents the person has, standing under a sky that is night while they have
 * no AI and day once they think. Decorative, as every sky is: what it says is said in words beside it.
 */

/** Top to horizon, as the sky's tones go: deep first. */
const NIGHT = ["#050814", "#070c1e", "#0a122e", "#0e1a43", "#13245a", "#182f73", "#203f8f", "#2b53ad"];
const DAY = ["#2468dc", "#2b74e6", "#3f88f5", "#5a9dff", "#78b4ff", "#a6cfff", "#cfe6ff", "#eef7ff"];
/** The day on a dark page: the same blues, deeper, so the sky doesn't glare beside dark surfaces. */
const DAY_DARK = ["#0b2459", "#0e2d6c", "#123881", "#174496", "#1d51aa", "#2660bd", "#3170cd", "#4183dc"];

const STAR = pixelOf("#eaf1ff");
const MOON = pixelOf("#f3f6ff");
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5;
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
/** A pixel cloud: circles on a flat base, in sky pixels around its anchor. */
const PUFFS = [
  [0, 0, 3.2],
  [4.2, 0.6, 2.4],
  [-4, 0.8, 2.2],
  [1.6, -1.8, 2.4],
  [7.4, 1.4, 1.5],
  [-6.8, 1.5, 1.4],
] as const;
/** Where the clouds sit (u, v) and how big: away from the middle, where the team and the words are. */
const CLOUDS = [
  [0.17, 0.34, 1],
  [0.84, 0.5, 0.8],
] as const;

/** 0: not a cloud; 1: its body; 2: its underside, drawn every other pixel. */
function cloudAt(x: number, y: number, w: number, h: number) {
  for (const [u, v, k] of CLOUDS) {
    const ax = u * w;
    const ay = v * h;
    if (y > ay + 2.2 * k) continue;
    for (const [px, py, r] of PUFFS)
      if ((x - ax - px * k) ** 2 + (y - ay - py * k) ** 2 <= (r * k) ** 2) return y > ay + 0.9 * k ? 2 : 1;
  }
  return 0;
}

/** Stars and a moon that go as the day comes, clouds that come with it. `quiet`: the top share kept plain (words). */
function paintOver(f: SkyFrame, day: number, quiet: number) {
  const { buf, w, h, tones } = f;
  const cloud = tones[tones.length - 1] ?? STAR;
  const night = 1 - day;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = y / h;
      if (v >= quiet && v < 0.62 && hash(x, y) < 0.008 * night) buf[y * w + x] = STAR;
      if (day > 0.3) {
        const c = cloudAt(x, y, w, h);
        if (c !== 0 && bayer(x, y) < (day - 0.3) * (c === 1 ? 4 : 0.8)) buf[y * w + x] = cloud;
      }
    }
  if (night < 0.25) return;
  const mx = Math.round(w * 0.8);
  const my = Math.round(h * (quiet > 0 ? 0.3 : 0.16) + day * 10);
  const dot = (x: number, y: number, color: number) => {
    if (x >= 0 && x < w && y >= 0 && y < h) buf[y * w + x] = color;
  };
  for (let dy = -2; dy < 6; dy++)
    for (let dx = -2; dx < 6; dx++) {
      const round = (dx - 1.5) ** 2 + (dy - 1.5) ** 2 <= 12;
      if (round) dot(mx + dx, my + dy, MOON);
    }
  // The bite that makes it a crescent, in the sky's own deepest tone.
  const deep = tones[0] ?? MOON;
  for (let dy = -2; dy < 2; dy++) for (let dx = 2; dx < 6; dx++) if (dx - dy >= 3) dot(mx + dx, my + dy, deep);
}

const isDark = (surface: string) => {
  const [r, g, b] = parseColor(surface);
  return (r + g + b) / 3 < 110;
};

/** The sky's options at `day` (0 night, 1 day), drawn by the shared sky engine. */
export function teamSky(day: number, quiet = 0): SkyOptions {
  return {
    pixel: 4,
    surface: "--raised",
    light: 0,
    sprites: 0,
    palette: (surface) => NIGHT.map((n, i) => mix(n, (isDark(surface) ? DAY_DARK : DAY)[i] ?? n, day)),
    base: (u, v) => {
      const sun = day * 0.2 * Math.exp(-(((u - 0.5) * 1.5) ** 2 + ((v - 1.05) * 2.4) ** 2));
      return Math.min(1, Math.max(0, v ** 0.9 * 0.9 + 0.05 * Math.sin(u * 5.2 + v * 3) + sun));
    },
    after: (f) => paintOver(f, day, quiet),
  };
}

/** How long the night takes to become day. */
export const DAWN_MS = 1700;

/**
 * 0 while `on` is false; once it turns true, 0 to 1 over `DAWN_MS` (at once with reduced motion). True from the
 * start: 1, with no dawn to watch.
 */
export function useDawn(on: boolean) {
  const [day, setDay] = useState(on ? 1 : 0);
  const was = useRef(on);
  useEffect(() => {
    const before = was.current;
    was.current = on;
    if (on === before) return;
    if (!on) {
      setDay(0);
      return;
    }
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      setDay(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / DAWN_MS);
      setDay(k * k * (3 - 2 * k));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return day;
}

export interface SceneAgent {
  id: string;
  name: string;
}

/**
 * `agents` (at most four, the one that leads drawn larger) under the sky. `asleep`: every one sleeps; else they are
 * up, `writing` or making `expression`. `children` stand beside them (a plan's mark, an envelope).
 */
export function TeamScene({
  agents,
  lead,
  day = 1,
  asleep = false,
  writing = false,
  expression,
  shape = "band",
  quiet = 0,
  className,
  children,
}: {
  agents: readonly SceneAgent[];
  /** The agent drawn larger (the right hand); none: the first. */
  lead?: string;
  day?: number;
  asleep?: boolean;
  writing?: boolean;
  expression?: Expression;
  /** `band`: a strip over a dialog. `tall`: a dialog's whole side, the team at its foot. */
  shape?: "band" | "tall";
  /** The top share of the sky kept without stars, for words over it. */
  quiet?: number;
  className?: string;
  children?: ReactNode;
}) {
  const options = useMemo(() => teamSky(day, quiet), [day, quiet]);
  const first = lead ?? agents[0]?.id;
  return (
    <div className={cx("team-scene", `team-scene--${shape}`, className)} aria-hidden="true">
      <PixelSky options={options} />
      <div className="team-scene__row">
        <div className="team-scene__cast" data-awake={asleep ? undefined : ""}>
          {agents.map((a, i) => (
            <span
              key={a.id}
              className="team-scene__agent"
              data-lead={a.id === first ? "" : undefined}
              style={{ "--i": i } as CSSProperties}
            >
              <AgentAvatar
                agentId={a.id}
                name={a.name}
                size="lg"
                framed={false}
                state={asleep ? "sleeping" : writing ? "writing" : "idle"}
                expression={asleep || writing ? undefined : expression}
              />
            </span>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The agents a scene shows: the right hand in front (second in the row), then the others, four at most. */
export function sceneTeam<A extends SceneAgent>(agents: readonly A[], lead: A | undefined): A[] {
  const rest = agents.filter((a) => a.id !== lead?.id).slice(0, lead ? 3 : 4);
  if (!lead) return rest;
  return rest.length > 1 ? [rest[0] as A, lead, ...rest.slice(1)] : [lead, ...rest];
}

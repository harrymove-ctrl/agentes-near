/**
 * The engines' portraits, defined once: what an agent thinks and works with
 * (ADR 0032).
 * Every place that shows an engine at 48 px and up draws it from here: the
 * agent page's "Motor", the desktop app's Ferramentas, the phone app, and
 * plain HTML pages that import this file as is (so it stays plain JavaScript
 * with types in portrait.d.ts; its only import is the agent engine, by a
 * relative path).
 *
 * Our own drawings, never the vendors' marks: each engine is told apart by its
 * tool, its temperature and what the screen shows, with the agent's own small
 * pixel self beside the tool, using it.
 *   claude_code  a warm console; a line written by hand grows on its screen
 *   codex        a cool terminal over a stacked code block, the code between braces
 *   agent        the agent alone, thinking (a thought bubble): no tool, through the API
 * The agent is drawn from the agent engine in its own look (color, eyes,
 * accessory) when one is given, the default look otherwise.
 * States: idle · working (the line writes / the code types / the agent looks
 * around and thinks) · off (not installed or computer offline: the screen goes
 * dark and the agent sleeps; the caller also desaturates).
 * Drawn on a 48×48 grid (one canvas pixel per cell), scaled by whole numbers so
 * every pixel stays crisp.
 */
import {
  ACCESSORIES,
  ACCESSORY_CHECK,
  ACCESSORY_PALETTE,
  bodyFrame,
  bodyTones,
  eyeShapes,
  gradientOf,
  idlePose,
  inBody,
  mixHex,
  rgbOf,
  spriteBody,
  toneAt,
} from "../agent/engine.js";

/** The grid's side, in cells. */
export const BRAIN_GRID = 48;
export const BRAIN_KINDS = ["claude_code", "codex", "agent"];
export const BRAIN_STATES = ["idle", "working", "off"];

const N = BRAIN_GRID;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const ALU = ["#fbfbf9", "#eeeeea", "#dcdcd7", "#c4c4be", "#a3a39d", "#7d7d77"];
/* Claude Code: warm paper frame, a warm dark screen, clay ink. */
const WARM = ["#fdfaf5", "#f5ede2", "#e8dccb", "#d2c1a9", "#ae977d", "#806b56"];
const WSCR = ["#1d1815", "#251f1a", "#30271f"];
const CLAY = { hi: "#f2a982", mid: "#d4744a", lo: "#9c4b2a" };
/* Codex: cool slate frame, a cold screen, mint and ice code. */
const COOL = ["#f7f9fb", "#eaeef2", "#d6dde4", "#b9c3cd", "#8f9ba8", "#67737f"];
const COOL_BACK = ["#eef2f5", "#e0e6eb", "#cbd3db", "#b1bbc6", "#8f9ba8", "#67737f"];
const CSCR = ["#0e1317", "#131a1f", "#19232a"];
const MINT = "#6fd6bf";
const ICE = "#9cc0d8";
const SLATE = "#5f7b90";

function painter(ctx) {
  const set = (x, y, c) => {
    if (c && x >= 0 && y >= 0 && x < N && y < N) {
      ctx.fillStyle = c;
      ctx.fillRect(x, y, 1, 1);
    }
  };
  /* A dithered ramp across a box: `f(x, y)` from 0 to 1 picks between the tones (ordered dither). */
  const ramp = (x0, y0, w, h, tones, f) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const v = Math.max(0, Math.min(1, f((x - x0) / Math.max(1, w - 1), (y - y0) / Math.max(1, h - 1))));
        const k = v * (tones.length - 1);
        const lo = Math.floor(k);
        set(x, y, tones[Math.min(tones.length - 1, lo + (k - lo > BAYER[(x & 3) + (y & 3) * 4] ? 1 : 0))]);
      }
  };
  const box = (x, y, w, h, c) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set(i, j, c);
  };
  const clear = (...pts) => {
    for (const [x, y] of pts) ctx.clearRect(x, y, 1, 1);
  };
  const bits = (x, y, rows, colors) =>
    rows.forEach((r, j) => {
      for (let i = 0; i < r.length; i++) if (colors[r[i]]) set(x + i, y + j, colors[r[i]]);
    });
  return { set, ramp, box, clear, bits };
}

/* A soft floor shadow: sparse dither that fades out to the sides. */
function shadow(p, cx, y, w, dark) {
  const c = dark ? "rgba(0,0,0,.55)" : "rgba(23,23,22,.16)";
  for (let x = cx - w; x <= cx + w; x++)
    for (let j = 0; j < 2; j++) {
      const edge = 1 - Math.abs(x - cx) / w;
      if (edge > BAYER[(x & 3) + ((y + j) & 3) * 4] * (j ? 1.6 : 1)) p.set(x, y + j, c);
    }
}

/* A window: dithered frame, rounded corners, three title dots; returns the screen box. */
function windowFrame(p, x, y, w, h, tones) {
  p.ramp(x, y, w, h, tones, (u, v) => 0.04 + 0.28 * v + 0.08 * u);
  for (let i = x + 1; i < x + w - 1; i++) {
    p.set(i, y, tones[3]);
    p.set(i, y + h - 1, tones[4]);
  }
  for (let j = y + 1; j < y + h - 1; j++) {
    p.set(x, j, tones[3]);
    p.set(x + w - 1, j, tones[4]);
  }
  p.clear([x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]);
  for (const k of [0, 1, 2]) p.set(x + 3 + k * 2, y + 2, tones[3]);
  return { sx: x + 2, sy: y + 5, sw: w - 4, sh: h - 7 };
}

const screenFill = (p, s, tones, state) =>
  p.ramp(s.sx, s.sy, s.sw, s.sh, tones, (u, v) => (state === "off" ? 0.04 : 0.1 + 0.8 * u * v));

/* Claude Code's screen: a prompt, some output, and a line written by hand (it grows while working). */
function ccScreen(p, s, state, t) {
  screenFill(p, s, WSCR, state);
  if (state === "off") return;
  const x = s.sx + 2;
  const y = s.sy + 2;
  p.set(x, y, CLAY.mid);
  p.set(x + 1, y + 1, CLAY.mid);
  p.set(x, y + 2, CLAY.mid);
  p.box(x + 3, y + 1, Math.min(9, s.sw - 9), 1, "rgba(245,237,226,.72)");
  p.box(x, y + 5, Math.min(15, s.sw - 6), 1, "rgba(174,151,125,.55)");
  p.box(x, y + 7, Math.min(11, s.sw - 6), 1, "rgba(174,151,125,.55)");
  if (state === "idle" && t % 1.6 < 0.9) p.box(x + 4 + Math.min(9, s.sw - 9), y, 2, 3, CLAY.mid);
  const base = s.sy + s.sh - 5;
  const full = s.sw - 7;
  const len = state === "working" ? 3 + Math.floor((t * 7) % (full - 2)) : full - 4;
  let tip = [x, base];
  for (let i = 0; i <= len; i++) {
    const yy = base + Math.round(Math.sin(i * 0.75) * 1.3);
    p.set(x + i, yy, CLAY.hi);
    tip = [x + i, yy];
  }
  if (state === "working" && t % 0.5 < 0.3) p.box(tip[0] + 2, base - 1, 1, 3, CLAY.mid);
}

/* Codex's screen: braces, indented code that types in while working, a cursor. */
const BRACE_L = ["..XX", ".X..", ".X..", ".X..", ".X..", "X...", ".X..", ".X..", ".X..", ".X..", "..XX"];
const BRACE_R = BRACE_L.map((r) => [...r].reverse().join(""));
function cxScreen(p, s, state, t) {
  screenFill(p, s, CSCR, state);
  if (state === "off") return;
  const top = s.sy + Math.floor((s.sh - 11) / 2);
  p.bits(s.sx + 2, top, BRACE_L, { X: MINT });
  p.bits(s.sx + s.sw - 6, top, BRACE_R, { X: MINT });
  const lines = [
    [0, 9, ICE],
    [2, 11, SLATE],
    [2, 7, MINT],
    [4, 8, SLATE],
    [0, 5, ICE],
  ];
  const x0 = s.sx + 8;
  const maxw = s.sw - 16;
  const typed = (t * 3.2) % (lines.length + 2);
  let end = null;
  lines.forEach(([ind, len, c], i) => {
    let L = Math.min(len, maxw - ind);
    if (state === "working") {
      const k = typed - i;
      if (k <= 0) return;
      if (k < 1) L = Math.max(1, Math.round(L * k));
    }
    const y = top + 1 + i * 2;
    p.box(x0 + ind, y, L, 1, c);
    end = [x0 + ind + L + 1, y];
  });
  if (end && (state === "working" || t % 1.6 < 0.9)) p.box(end[0], end[1] - 1, 1, 2, MINT);
}

/*
 * The agent's accessory on its n-cell body: the engine's 16×16 accessory grid
 * sampled down to whole cells (nearest), so it stays pixel art at any size.
 */
function pixAccessory(p, x0, y0, n, name, frame, t, active) {
  const a = ACCESSORIES[name];
  if (!a) return;
  const k = n / 16;
  const hx = Math.round((frame.head?.[0] ?? 0) * n);
  const hy = Math.round((frame.head?.[1] ?? 0) * n);
  const w = Math.max(...a.rows.map((r) => r.length));
  for (let dy = Math.floor(a.oy * k); dy < Math.ceil((a.oy + a.rows.length) * k); dy++)
    for (let dx = Math.floor(a.ox * k); dx < Math.ceil((a.ox + w) * k); dx++) {
      const gx = Math.floor((dx + 0.5) / k);
      const gy = Math.floor((dy + 0.5) / k);
      let ch = a.rows[gy - a.oy]?.[gx - a.ox];
      if (!ch || ch === " ") continue;
      if (ACCESSORY_CHECK[ch]) ch = ACCESSORY_CHECK[ch][(gx + gy) & 1];
      const c =
        ch === "A" ? (active && Math.floor(t * 3) % 2 ? "#ffd0c9" : "#ff6b5e") : (ACCESSORY_PALETTE[ch] ?? "#000000");
      p.set(x0 + dx + hx, y0 + dy + hy, c);
    }
}

/* Our pixel agent, from the engine's body, dither and eyes (n odd keeps the eyes symmetric). */
function pixAgent(p, x0, y0, n, me, look, t, active) {
  const tones = bodyTones(me.color);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (inBody((x + 0.5) / n, (y + 0.5) / n)) p.set(x0 + x, y0 + y, tones[toneAt(x, y, n, look.pose.turn)]);
    }
  for (const e of eyeShapes(look.style, look.pose)) {
    const ew = Math.max(1, Math.round(e.w * n));
    const eh = Math.max(1, Math.round(e.h * n));
    p.box(
      x0 + Math.round((e.x + e.w / 2) * n - ew / 2),
      y0 + Math.round((e.y + e.h / 2) * n - eh / 2),
      ew,
      eh,
      "#ffffff",
    );
  }
  if (me.accessory && me.accessory !== "none")
    pixAccessory(p, x0, y0, n, me.accessory, bodyFrame(look.pose), t, active);
}

/* Idle: blinks, glances a little. Working: looks around (or at its tool). Off: sleepy. */
function lookFor(state, t, eyes, seed = 0, toward = null) {
  if (state === "off") return { style: "sleepy", pose: { turn: [0, 0.2] } };
  const ip = idlePose(t, seed, { active: state === "working", expressions: [] });
  const k = state === "working" ? 0.11 : 0.05;
  let look = [ip.turn[0] * k, ip.turn[1] * k * 0.7];
  let turn = ip.turn.map((v) => v * (state === "working" ? 0.6 : 0.3));
  if (toward) {
    // Keeps its eyes on the tool, glancing back now and then.
    const glance = state === "working" && (t + seed) % 4 > 3.2;
    look = glance
      ? [0.02, -0.02]
      : [toward[0] * 0.09, toward[1] * 0.05 + (state === "working" ? 0.02 * Math.sin(t * 6) : 0)];
    turn = glance ? [0.1, 0] : toward.map((v) => v * 0.55);
  }
  return { style: eyes || "round", pose: { look, turn, blink: ip.blink } };
}

/* A soft glow behind the thinking agent, in its own color. */
function halo(p, cx, cy, r, dark, color) {
  const [top, bottom] = gradientOf(color);
  const [R, G, B] = rgbOf(bottom);
  const tones = dark ? [`rgba(${R},${G},${B},.13)`, `rgba(${R},${G},${B},.26)`] : [mixHex(top, "#ffffff", 0.5), top];
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const k = 1 - d / r;
      if (k * 0.7 > BAYER[(x & 3) + (y & 3) * 4]) p.set(x, y, tones[k > 0.6 ? 1 : 0]);
    }
}

/* A thought bubble with three dots; while working one dot after the other lights up. */
function bubble(p, x, y, state, t, color) {
  if (state === "off") return;
  const w = 14;
  const h = 8;
  p.box(x, y, w, h, "#ffffff");
  for (let i = x + 1; i < x + w - 1; i++) {
    p.set(i, y, ALU[3]);
    p.set(i, y + h - 1, ALU[4]);
  }
  for (let j = y + 1; j < y + h - 1; j++) {
    p.set(x, j, ALU[3]);
    p.set(x + w - 1, j, ALU[4]);
  }
  p.clear([x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]);
  p.box(x, y + h + 1, 2, 2, "#ffffff");
  p.set(x, y + h + 1, ALU[3]);
  p.set(x - 1, y + h + 4, ALU[4]);
  const on = Math.floor(t * 3) % 3;
  for (let i = 0; i < 3; i++)
    p.box(
      x + 3 + i * 3,
      y + 3,
      2,
      2,
      state === "working" && i === on ? spriteBody(color) : ALU[state === "working" ? 3 : 4],
    );
}

const bobAt = (state, t, phase = 0) => (state === "working" && Math.sin(t * 5 + phase) > 0.5 ? -1 : 0);

const DRAW = {
  claude_code(p, state, dark, t, me) {
    shadow(p, 23, 40, 21, dark);
    const s = windowFrame(p, 2, 7, 33, 31, WARM);
    ccScreen(p, s, state, t);
    pixAgent(p, 33, 27 + bobAt(state, t), 13, me, lookFor(state, t, me.eyes, 2, [-1, -0.3]), t, state === "working");
  },
  codex(p, state, dark, t, me) {
    shadow(p, 23, 40, 21, dark);
    windowFrame(p, 6, 3, 31, 28, COOL_BACK);
    const s = windowFrame(p, 2, 8, 32, 30, COOL);
    cxScreen(p, s, state, t);
    pixAgent(p, 33, 27 + bobAt(state, t, 1), 13, me, lookFor(state, t, me.eyes, 3, [-1, -0.3]), t, state === "working");
  },
  agent(p, state, dark, t, me) {
    if (state !== "off") halo(p, 22, 25, 20, dark, me.color);
    shadow(p, 23, 39, 14, dark);
    pixAgent(p, 12, 16 + bobAt(state, t), 21, me, lookFor(state, t, me.eyes, 1), t, state === "working");
    bubble(p, 33, 2, state, t, me.color);
  },
};

/**
 * Draws an engine's portrait on a 48×48 context (one cell per canvas pixel).
 * `agentLook` is the agent's own look ({ color, eyes, accessory }); without
 * it, the default agent (sky, round eyes).
 */
export function drawBrain(ctx, kind, state, { dark = false, t = 0, agentLook } = {}) {
  ctx.clearRect(0, 0, N, N);
  const draw = DRAW[kind] ?? DRAW.agent;
  const st = BRAIN_STATES.includes(state) ? state : "idle";
  draw(painter(ctx), st, dark, t, agentLook ?? {});
}

/**
 * The connected computers' portraits, defined once.
 * Every place that shows a computer at 48 px and up draws it from here: the
 * computers list, the computer page, `/conectar`, the agent's computer, the
 * desktop app, and plain HTML pages that import this file as is (so it stays
 * plain JavaScript with types in portrait.d.ts and no imports).
 *
 * Our own drawings, never the vendors' marks: each system is told apart by its
 * device and what its screen shows.
 *   mac      an aluminum laptop with the screen notch; the screen shows our sky with a pixel agent
 *   windows  a light monitor on a stand; a window and a taskbar over the sky
 *   linux    a server tower: drive bays, vents, a green light (most Linux machines are servers)
 *   android  a phone with a silver rail and a punch-hole camera (a phone reached through a computer)
 *   iphone   a phone with a darker rail, rounder corners and the island
 * The screen goes dark when the computer is offline and dims when it's paused.
 * Drawn on a 48×48 grid (one canvas pixel per cell), scaled by whole numbers so
 * every pixel stays crisp.
 */

/** The grid's side, in cells. */
export const COMPUTER_GRID = 48;
export const COMPUTER_KINDS = ["mac", "windows", "linux"];
/** Phones people plug into a computer: drawn by the same engine, told apart by the camera and the rail. */
export const PHONE_KINDS = ["android", "iphone"];
export const COMPUTER_STATES = ["online", "paused", "offline"];
/**
 * The columns each drawing covers, shadow included, in every state and frame: [first, count]. A portrait's box
 * is this wide, so its pixels meet the row's edge like any other lead (the tower is half the grid's width).
 */
export const COMPUTER_ART = {
  mac: [3, 42],
  windows: [4, 40],
  linux: [12, 25],
  android: [13, 23],
  iphone: [13, 23],
};
/**
 * The rows each drawing covers, in every state and frame: [first, count]. The box keeps the whole grid's height, so
 * a row that starts text at a picture's top (`.ac-faceline`) starts it at the drawing's first row instead.
 */
export const COMPUTER_ROWS = { mac: [6, 33], windows: [5, 39], linux: [3, 42], android: [4, 42], iphone: [4, 42] };

const N = COMPUTER_GRID;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const ALU = ["#fbfbf9", "#eeeeea", "#dcdcd7", "#c4c4be", "#a3a39d", "#7d7d77"];
const GRAPHITE = ["#3a3a37", "#262624", "#161615"];
const SKY = ["#0a2f5e", "#0b4590", "#0063d1", "#2f80e0", "#5ea0ee", "#8cc3ff", "#c6e1ff"];
const NIGHT = ["#141413", "#1b1b1a", "#222220"];
/* A dark screen on a dark surface: a step lighter than the surface, so the switched-off computer keeps its shape. */
const NIGHT_ON_DARK = ["#2a2a28", "#323230", "#3b3b38"];
const OK = "#5fc48a";
const WARN = "#e0a84a";

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
  return { set, ramp, box, clear };
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

/* What a screen shows: our sky (deep at the top, the horizon glowing at the bottom), dark when off. */
function screen(p, x, y, w, h, state, t, dark) {
  if (state === "offline") {
    p.ramp(x, y, w, h, dark ? NIGHT_ON_DARK : NIGHT, (u, v) => 0.2 + 0.6 * u * v);
    return;
  }
  p.ramp(x, y, w, h, SKY, (u, v) => 0.1 + 0.85 * v * v + 0.06 * Math.sin(u * 6 + t));
  if (state === "paused")
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if ((i + j) % 2) p.set(i, j, "rgba(20,20,19,.55)");
}

/* The brand's pixel agent: a 5×4 deep body with white eyes (they close while paused). */
function agent(p, x, y, state, t) {
  const body = "#04203f";
  const bob = state === "online" && Math.sin(t * 2) > 0.3 ? -1 : 0;
  p.box(x, y + bob, 5, 4, body);
  p.set(x + 4, y + 3 + bob, null);
  const closed = state !== "online" || t % 4 > 3.85;
  if (closed) {
    p.set(x + 1, y + 2 + bob, "#fff");
    p.set(x + 3, y + 2 + bob, "#fff");
  } else {
    p.set(x + 1, y + 1 + bob, "#fff");
    p.set(x + 1, y + 2 + bob, "#fff");
    p.set(x + 3, y + 1 + bob, "#fff");
    p.set(x + 3, y + 2 + bob, "#fff");
  }
}

const light = (state) => (state === "offline" ? ALU[4] : state === "paused" ? WARN : OK);

/* Whether cell (x, y)'s centre is inside the rounded box at (x0, y0), w×h, corner radius r. */
function inRounded(x, y, x0, y0, w, h, r) {
  const qx = Math.max(x0 + r - (x + 0.5), 0, x + 0.5 - (x0 + w - r));
  const qy = Math.max(y0 + r - (y + 0.5), 0, y + 0.5 - (y0 + h - r));
  return qx * qx + qy * qy <= r * r;
}

/* The phones' shared body, standing on its foot (cols 14..33, rows 4..43): a metal rail lit from the top left, a
   black bezel, the rounded screen. `rail` is [lit, turning, shaded]. */
const PHONE = { x: 14, y: 4, w: 20, h: 40 };
function phone(p, state, dark, t, rail, r) {
  const { x: x0, y: y0, w, h } = PHONE;
  shadow(p, 24, y0 + h, 11, dark);
  const sx = x0 + 2;
  const sy = y0 + 2;
  screen(p, sx, sy, w - 4, h - 4, state, t, dark);
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      if (!inRounded(x, y, x0, y0, w, h, r)) continue;
      if (inRounded(x, y, sx, sy, w - 4, h - 4, r - 2)) continue;
      const out = (dx, dy) => !inRounded(x + dx, y + dy, x0, y0, w, h, r);
      const lit = out(-1, 0) || out(0, -1);
      const shaded = out(1, 0) || out(0, 1);
      p.set(x, y, lit && shaded ? rail[1] : lit ? rail[0] : shaded ? rail[2] : GRAPHITE[2]);
    }
  if (state === "offline") return;
  // The status bar (the time on the left, the battery on the right) and the home bar.
  p.box(17, 7, 2, 1, "rgba(255,255,255,.85)");
  p.box(29, 7, 2, 1, "rgba(255,255,255,.85)");
  p.box(21, 40, 6, 1, "rgba(4,32,63,.5)");
  agent(p, 22, 17, state, t);
}

const DRAW = {
  mac(p, state, dark, t) {
    shadow(p, 24, 37, 21, dark);
    // Lid: a graphite bezel with rounded corners, the screen inside.
    p.box(7, 6, 34, 26, GRAPHITE[2]);
    p.clear([7, 6], [40, 6]);
    screen(p, 9, 8, 30, 22, state, t, dark);
    if (state !== "offline") {
      p.box(9, 8, 30, 1, "rgba(255,255,255,.55)");
      agent(p, 22, 18, state, t);
    }
    p.box(22, 8, 4, 2, GRAPHITE[2]); // the notch
    // Hinge and base: brushed aluminum, the thumb scoop in the front, rounded ends.
    p.box(7, 32, 34, 1, ALU[5]);
    p.ramp(3, 33, 42, 3, ALU, (u, v) => 0.15 + 0.55 * v + 0.15 * Math.abs(u - 0.5));
    p.box(20, 33, 8, 1, ALU[3]);
    p.clear([3, 35], [44, 35]);
    p.box(5, 36, 38, 1, ALU[5]);
  },
  windows(p, state, dark, t) {
    shadow(p, 24, 42, 14, dark);
    // A light monitor: rounded frame with a thin edge, a deeper chin with a power light.
    p.ramp(4, 5, 40, 28, ALU, (_u, v) => 0.05 + 0.25 * v);
    for (let x = 5; x < 43; x++) {
      p.set(x, 5, ALU[3]);
      p.set(x, 32, ALU[4]);
    }
    for (let y = 6; y < 32; y++) {
      p.set(4, y, ALU[3]);
      p.set(43, y, ALU[4]);
    }
    p.clear([4, 5], [43, 5], [4, 32], [43, 32]);
    screen(p, 6, 7, 36, 22, state, t, dark);
    if (state !== "offline") {
      // A window over the sky, and the taskbar with its start mark.
      p.box(11, 10, 17, 11, "#ffffff");
      p.box(11, 10, 17, 2, "#dfe3e8");
      p.set(25, 10, ALU[4]);
      p.set(26, 10, ALU[4]);
      for (const r of [14, 16, 18]) p.box(13, r, r === 18 ? 8 : 12, 1, "#c9ced6");
      p.box(6, 26, 36, 3, "rgba(236,240,245,.92)");
      p.box(8, 27, 2, 1, GRAPHITE[0]);
      p.box(11, 27, 2, 1, GRAPHITE[0]);
      p.box(15, 27, 3, 1, ALU[4]);
      p.box(19, 27, 3, 1, ALU[4]);
      agent(p, 32, 16, state, t);
    }
    p.set(39, 30, light(state));
    // Neck and foot.
    p.ramp(21, 33, 6, 6, ALU, (u) => 0.25 + 0.4 * u);
    p.ramp(13, 39, 22, 3, ALU, (u, v) => 0.1 + 0.45 * v + 0.15 * Math.abs(u - 0.5));
    p.clear([13, 41], [34, 41]);
  },
  linux(p, state, dark, t) {
    shadow(p, 24, 43, 13, dark);
    // A server tower: light body shaded from the left, a darker side edge.
    p.ramp(13, 3, 22, 40, ALU, (u, v) => 0.05 + 0.35 * u + 0.1 * v);
    for (let y = 4; y < 42; y++) {
      p.set(13, y, ALU[3]);
      p.set(34, y, ALU[5]);
    }
    for (let x = 14; x < 34; x++) {
      p.set(x, 3, ALU[3]);
      p.set(x, 42, ALU[5]);
    }
    p.clear([13, 3], [34, 3], [13, 42], [34, 42]);
    // Two drive bays with slots and a light each.
    for (const y of [7, 11]) {
      p.box(16, y, 16, 3, ALU[2]);
      p.box(16, y, 16, 1, ALU[1]);
      p.box(18, y + 1, 9, 1, ALU[4]);
      const on = state === "online" && (t * 3 + y) % 2 > 0.7;
      p.set(30, y + 1, state === "offline" ? ALU[4] : on ? OK : "#2f7a4f");
    }
    // A small status screen: a prompt on black (the terminal, Linux's face).
    p.box(16, 17, 16, 7, state === "offline" ? NIGHT[1] : "#141413");
    if (state !== "offline") {
      p.set(18, 19, OK);
      p.set(19, 20, OK);
      p.set(18, 21, OK);
      if (state === "online" ? t % 1 > 0.5 : true) p.box(21, 21, 3, 1, OK);
      p.box(21, 19, 7, 1, "rgba(95,196,138,.45)");
    }
    // Vents.
    for (let y = 27; y < 36; y += 2) for (let x = 16; x < 32; x += 2) p.set(x, y, ALU[4]);
    // Power button and light.
    p.box(22, 38, 3, 2, ALU[3]);
    p.set(23, 38, ALU[5]);
    p.set(27, 39, light(state));
  },
  /* A modern Android phone: a silver rail, a punch-hole camera, app icons over a search bar, buttons on the right. */
  android(p, state, dark, t) {
    phone(p, state, dark, t, [ALU[3], ALU[4], ALU[5]], 4);
    p.box(23, 7, 2, 2, GRAPHITE[2]);
    if (state !== "offline") {
      for (const x of [17, 21, 25, 29]) p.box(x, 31, 2, 2, "#ffffff");
      p.box(17, 35, 14, 2, "rgba(255,255,255,.9)");
    }
    p.box(34, 13, 1, 3, ALU[5]);
    p.box(34, 18, 1, 6, ALU[5]);
  },
  /* An iPhone: a darker rail, rounder corners, the Dynamic Island, a dock, the action and volume buttons on the left. */
  iphone(p, state, dark, t) {
    phone(p, state, dark, t, [ALU[5], GRAPHITE[0], GRAPHITE[1]], 5);
    p.box(21, 7, 6, 2, GRAPHITE[2]);
    if (state !== "offline") {
      for (let y = 32; y < 36; y++)
        for (let x = 16; x < 32; x++)
          if (!((x === 16 || x === 31) && (y === 32 || y === 35))) p.set(x, y, "rgba(255,255,255,.25)");
      for (const x of [17, 21, 25, 29]) p.box(x, 33, 2, 2, "#ffffff");
    }
    p.box(13, 11, 1, 2, GRAPHITE[0]);
    p.box(13, 14, 1, 4, GRAPHITE[0]);
    p.box(13, 19, 1, 4, GRAPHITE[0]);
    p.box(34, 15, 1, 6, GRAPHITE[1]);
  },
};

/**
 * Draws a computer's portrait on `ctx`, one cell per unit (a 48×48 canvas, or
 * any context scaled to that grid). Clears the grid first. `t` is the time in
 * seconds (the screen's shimmer, the agent's bob and blink, the drive lights);
 * pass 0 for a still frame. `dark` deepens the floor shadow and lifts a switched-off screen off the dark surface.
 */
export function drawComputer(ctx, kind, state, { dark = false, t = 0 } = {}) {
  ctx.clearRect(0, 0, N, N);
  const draw = DRAW[kind] ?? DRAW.linux;
  draw(painter(ctx), COMPUTER_STATES.includes(state) ? state : "offline", dark, t);
}

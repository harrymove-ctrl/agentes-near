/**
 * The agent, defined once. Every place that draws an agent reads its shape,
 * eyes, colors and dither from here: the avatar (`Avatar`), the logo and the
 * favicon, the pixel agents in the sky, the landing's giant and plain HTML
 * pages that import this file as is (so it stays plain JavaScript with types
 * in engine.d.ts and no imports).
 *
 * Coordinates are fractions of the body's box (0..1, y down). The body is a
 * square with radius 29% on three corners and the cut corner at bottom-left;
 * the eyes are the logo's: two narrow white pills.
 */

/** Top and bottom of each agent color. Sky is the landing's blue, the same in both themes. */
export const AGENT_GRADIENTS = {
  sky: ["#8cc3ff", "#0063d1"],
  indigo: ["#7d8bff", "#3f4fd6"],
  violet: ["#ae8cf7", "#6e45d1"],
  rose: ["#f58aa6", "#c9406a"],
  amber: ["#f3c25c", "#c07d0b"],
  green: ["#5fcf8b", "#1f8a4c"],
  teal: ["#4cd0c0", "#0f8f86"],
  graphite: ["#9a9a95", "#4a4a47"],
};

/** Eyes are white on every agent, everywhere. */
export const EYE_COLOR = "#ffffff";

/** The body: radius on three corners and the cut corner (bottom-left), as fractions of the side. */
export const BODY_RADIUS = 0.29;
export const BODY_CUT = 0.054;

/** Eye centers (x) and each eye style: size and vertical center. `arc` = happy (∩), `lid` = sleepy (half). */
export const EYE_X = [0.375, 0.625];
export const EYE_STYLES = {
  round: { w: 0.093, h: 0.27, cy: 0.465 },
  dots: { w: 0.093, h: 0.12, cy: 0.48 },
  wide: { w: 0.12, h: 0.33, cy: 0.46 },
  happy: { w: 0.15, h: 0.09, cy: 0.45, kind: "arc" },
  sleepy: { w: 0.13, h: 0.07, cy: 0.52, kind: "lid" },
};
/** While words arrive the eyes are short dashes. */
export const WRITING_EYE = { w: 0.15, h: 0.065, cy: 0.52 };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** "#rrggbb" → [r, g, b]. */
export function rgbOf(hex) {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` → `b` by `k` (0..1), as "#rrggbb". */
export function mixHex(a, b, k) {
  const A = rgbOf(a);
  const B = rgbOf(b);
  return `#${A.map((v, i) =>
    Math.round(v + (B[i] - v) * k)
      .toString(16)
      .padStart(2, "0"),
  ).join("")}`;
}

/** Whether `v` is a custom agent color: "#rrggbb". */
export function isHexColor(v) {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
}

/** A color's name under `look.colors.*`: a preset's own, or "custom" for a "#rrggbb". */
export function colorKey(color) {
  return isHexColor(color) ? "custom" : color;
}

/** "#rrggbb" → [hue 0..360, saturation 0..1, value 0..1] (the picker's space). */
export function hexToHsv(hex) {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

/** [hue 0..360, saturation 0..1, value 0..1] → "#rrggbb". */
export function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function hexToHsl(hex) {
  const [h, s, v] = hexToHsv(hex);
  const l = v * (1 - s / 2);
  return [h, l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l];
}

function hslToHex(h, s, l) {
  const v = l + s * Math.min(l, 1 - l);
  return hsvToHex(h, v ? 2 * (1 - l / v) : 0, v);
}

/** WCAG relative luminance of "#rrggbb" (0 black .. 1 white). */
export function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two "#rrggbb" (1 to 21). */
export function contrastOf(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * An agent's @mention chip in a theme: a solid tint of its color, so the chip reads the same on a page, a row or a
 * bubble, and its own color pushed toward black (or white in the dark) until the text passes WCAG AA on that tint.
 */
export function mentionTone(color, dark = false) {
  const [top, bottom] = gradientOf(color);
  const background = dark ? mixHex("#181817", bottom, 0.34) : mixHex("#ffffff", bottom, 0.16);
  const base = dark ? top : bottom;
  let ink = base;
  for (let k = 0.05; k <= 1 && contrastOf(ink, background) < 4.5; k += 0.05) {
    ink = mixHex(base, dark ? "#ffffff" : "#000000", k);
  }
  return { background, ink };
}

/**
 * A custom color's [top, bottom], built like the presets: the bottom is the color itself, its lightness held
 * between graphite's and a level where the white eyes and text still read (luminance ≤ 0.28, about 3:1 against
 * white, which also keeps it off a dark theme's background); the top is the same hue 26 points lighter.
 */
export function customGradient(hex) {
  const [h, s, l0] = hexToHsl(hex);
  let l = Math.max(0.28, Math.min(0.55, l0));
  let bottom = hslToHex(h, s, l);
  while (luminance(bottom) > 0.28 && l > 0.2) {
    l -= 0.01;
    bottom = hslToHex(h, s, l);
  }
  // The top is capped too: yellow, lime or cyan 26 points lighter would be near white, washing out the body's
  // light tones behind the eyes and vanishing on light surfaces. No custom top reads worse than amber's.
  let lt = Math.min(0.78, l + 0.26);
  let top = hslToHex(h, s, lt);
  while ((luminance(top) > 0.59 || luminance(mixHex(bottom, top, 0.5)) > 0.405) && lt > l) {
    lt -= 0.01;
    top = hslToHex(h, s, lt);
  }
  return [top, bottom];
}

/** Where the custom color picker starts: the custom color itself, or the current preset's own tone. */
export function pickerStart(color) {
  return isHexColor(color) ? color.toLowerCase() : gradientOf(color)[1];
}

/** The preset closest to a color by hue (graphite when nearly gray): for places that only have the presets' pictures. */
export function nearestPreset(color) {
  if (!isHexColor(color)) return color in AGENT_GRADIENTS ? color : "sky";
  const [h, s] = hexToHsl(color.toLowerCase());
  if (s < 0.15) return "graphite";
  let best = "sky";
  let gap = 360;
  for (const [name, [, bottom]] of Object.entries(AGENT_GRADIENTS)) {
    if (name === "graphite") continue;
    const d = Math.abs(hexToHsl(bottom)[0] - h) % 360;
    const dd = Math.min(d, 360 - d);
    if (dd < gap) [best, gap] = [name, dd];
  }
  return best;
}

/** An agent color's [top, bottom]: a preset, a custom "#rrggbb", or sky for anything else. */
export function gradientOf(color) {
  return AGENT_GRADIENTS[color] ?? (isHexColor(color) ? customGradient(color.toLowerCase()) : AGENT_GRADIENTS.sky);
}

/**
 * Five body tones, deep (0) to light (4). `deep` runs one step deeper, for a
 * big agent on a light halo (the landing's giant), so its top still reads.
 */
export function bodyTones(color, deep = false) {
  const [top, bottom] = gradientOf(color);
  if (deep)
    return [mixHex(bottom, "#000000", 0.5), mixHex(bottom, "#000000", 0.22), bottom, mixHex(bottom, top, 0.5), top];
  return [mixHex(bottom, "#000000", 0.38), bottom, mixHex(bottom, top, 0.5), top, mixHex(top, "#ffffff", 0.5)];
}

/** The small pixel agents' body: deep enough for white eyes (navy on the sky). */
export function spriteBody(color) {
  return !color || color === "sky" ? "#04203f" : mixHex(gradientOf(color)[1], "#000000", 0.45);
}

/** Dither cells per side for a body of `px` pixels: about 2.5–15 screen pixels per cell. */
export function ditherCells(px) {
  return px <= 20 ? 8 : px <= 28 ? 10 : px <= 40 ? 14 : px <= 64 ? 18 : px <= 160 ? 22 : 26;
}

/** Whether (u, v) is inside the body. */
export function inBody(u, v) {
  const r = BODY_RADIUS;
  const c = BODY_CUT;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  if (u < r && v < r) return (u - r) ** 2 + (v - r) ** 2 <= r * r;
  if (u > 1 - r && v < r) return (u - 1 + r) ** 2 + (v - r) ** 2 <= r * r;
  if (u > 1 - r && v > 1 - r) return (u - 1 + r) ** 2 + (v - 1 + r) ** 2 <= r * r;
  if (u < c && v > 1 - c) return (u - c) ** 2 + (v - 1 + c) ** 2 <= c * c;
  return true;
}

/** The body's outline as an SVG path at (x, y), side `s`. */
export function bodyPath(x = 0, y = 0, s = 1) {
  const r = BODY_RADIUS * s;
  const c = BODY_CUT * s;
  const f = (n) => Number(n.toFixed(3));
  return [
    `M${f(x + r)} ${f(y)}`,
    `H${f(x + s - r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + s)} ${f(y + r)}`,
    `V${f(y + s - r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + s - r)} ${f(y + s)}`,
    `H${f(x + c)}`,
    `A${f(c)} ${f(c)} 0 0 1 ${f(x)} ${f(y + s - c)}`,
    `V${f(y + r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}`,
    "Z",
  ].join("");
}

/**
 * Tone index (0..4) of the cell (x, y) of an n×n body: light top-left to deep
 * bottom-right, Bayer-dithered. `turn` [tx, ty] (-1..1) moves the light: the
 * side turned away gets darker, which reads as the head turning (pseudo-3D).
 */
export function toneAt(x, y, n, turn) {
  const u = (x + 0.5) / n;
  const v = (y + 0.5) / n;
  const tx = turn ? turn[0] : 0;
  const ty = turn ? turn[1] : 0;
  const f = 0.92 - 0.75 * v - 0.12 * u - 0.16 * tx * (u - 0.5) - 0.12 * ty * (v - 0.5);
  const k = Math.max(0, Math.min(4, f * 4));
  const lo = Math.floor(k);
  return Math.min(4, k - lo > BAYER[(x & 3) + (y & 3) * 4] ? lo + 1 : lo);
}

/** The body as an SVG string: n×n cells, one rect per run of a tone in a row (the shape is clipped by whoever shows it). */
export function bodySvg(color, n, deep = false) {
  const tones = bodyTones(color, deep);
  const rects = [];
  for (let y = 0; y < n; y++) {
    let start = 0;
    let run = -1;
    for (let x = 0; x <= n; x++) {
      const idx = x < n ? toneAt(x, y, n) : -1;
      if (idx !== run) {
        if (run >= 0) rects.push(`<rect x="${start}" y="${y}" width="${x - start}" height="1" fill="${tones[run]}"/>`);
        start = x;
        run = idx;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

/**
 * Passing expressions (a pose, not the agent's look): they replace the eye
 * style for a moment. Each eye gets a kind the renderers know how to draw.
 */
export const EXPRESSIONS = {
  closed: { w: 0.17, h: 0.08, cy: 0.5, kind: "cup" },
  happy: { w: 0.17, h: 0.1, cy: 0.45, kind: "arc" },
  dizzy: { w: 0.23, h: 0.23, cy: 0.465, kind: "spiral" },
  heart: { w: 0.2, h: 0.19, cy: 0.465, kind: "heart" },
  star: { w: 0.22, h: 0.22, cy: 0.465, kind: "star" },
  cross: { w: 0.16, h: 0.16, cy: 0.465, kind: "cross" },
  surprised: { w: 0.17, h: 0.23, cy: 0.46, kind: "ring" },
  angry: { w: 0.12, h: 0.22, cy: 0.48, kind: "slant" },
  wink: { w: 0.093, h: 0.27, cy: 0.465, kind: "pill", right: { w: 0.17, h: 0.08, cy: 0.5, kind: "cup" } },
};

/**
 * The two eyes for a style and a pose, as boxes in body fractions:
 * `{ x, y, w, h, kind, side }`. Kinds: "pill", "arc" (∩), "lid" (half),
 * "cup" (∪, closed), "spiral" (@), "heart", "star", "cross" (×), "ring" (O),
 * "slant" (angry). Pose: `writing` (dashes), `blink`, `expression` (one of
 * EXPRESSIONS), `look` [dx, dy] in fractions and `turn` [tx, ty] in -1..1:
 * the eyes slide toward the turn and the far one narrows (pseudo-3D).
 */
export function eyeShapes(style = "round", pose = {}) {
  const ex = pose.writing ? null : EXPRESSIONS[pose.expression];
  const base = pose.writing ? { ...WRITING_EYE, kind: "pill" } : (ex ?? EYE_STYLES[style] ?? EYE_STYLES.round);
  const [lx, ly] = pose.look ?? [0, 0];
  const [tx, ty] = pose.turn ?? [0, 0];
  // The face turns with the body (drawAgent); the eyes only lean a little toward where it looks.
  const dx = lx + 0.025 * tx;
  const dy = ly + 0.02 * ty;
  const spread = 1;
  return EYE_X.map((cx, side) => {
    const e = side === 1 && base.right ? base.right : base;
    const kind = e.kind ?? "pill";
    const blink = pose.blink && (kind === "pill" || kind === "ring" || kind === "slant");
    // The eye on the side the head turns to is farther away: narrower.
    const far = (side === 1 && tx > 0) || (side === 0 && tx < 0) ? Math.abs(tx) : 0;
    const w = e.w * (1 - 0.12 * far);
    const h = blink ? Math.max(0.03, e.h * 0.12) : e.h;
    const center = 0.5 + (cx - 0.5) * spread + dx;
    return { x: center - w / 2, y: e.cy - h / 2 + dy, w, h, kind: blink ? "pill" : kind, side };
  });
}

/** Draws the eyes on a 2D canvas for a body at (x, y), side `s`. */
export function drawEyes(ctx, x, y, s, shapes, color = EYE_COLOR) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1.4, s * 0.055);
  for (const e of shapes) {
    const ex = x + e.x * s;
    const ey = y + e.y * s;
    const w = e.w * s;
    const h = e.h * s;
    const cx = ex + w / 2;
    const cy = ey + h / 2;
    const lw = ctx.lineWidth;
    ctx.beginPath();
    switch (e.kind) {
      case "arc":
        ctx.ellipse(cx, ey + h, Math.max(0.5, w / 2 - lw / 2), h, 0, Math.PI, 0);
        ctx.stroke();
        break;
      case "cup":
        ctx.ellipse(cx, ey, Math.max(0.5, w / 2 - lw / 2), h, 0, 0, Math.PI);
        ctx.stroke();
        break;
      case "lid":
        ctx.ellipse(cx, ey, w / 2, h, 0, 0, Math.PI);
        ctx.fill();
        break;
      case "spiral": {
        // @: one and a half turns from a small core, a thinner line so it stays open.
        const turns = 1.6;
        ctx.lineWidth = lw * 0.75;
        const r = Math.min(w, h) / 2 - lw / 2;
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * turns * Math.PI * 2;
          const rr = r * (0.18 + 0.82 * (i / 48));
          const px = cx + Math.cos(a) * rr;
          const py = cy + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.lineWidth = lw;
        break;
      }
      case "heart": {
        const t = ey + h * 0.3;
        ctx.moveTo(cx, ey + h);
        ctx.bezierCurveTo(ex - w * 0.1, ey + h * 0.55, ex, ey - h * 0.1, cx, t);
        ctx.bezierCurveTo(ex + w, ey - h * 0.1, ex + w * 1.1, ey + h * 0.55, cx, ey + h);
        ctx.fill();
        break;
      }
      case "star": {
        const r = Math.min(w, h) / 2;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
          const rr = i % 2 ? r * 0.32 : r;
          const px = cx + Math.cos(a) * rr;
          const py = cy + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "cross":
        ctx.moveTo(ex + lw / 2, ey + lw / 2);
        ctx.lineTo(ex + w - lw / 2, ey + h - lw / 2);
        ctx.moveTo(ex + w - lw / 2, ey + lw / 2);
        ctx.lineTo(ex + lw / 2, ey + h - lw / 2);
        ctx.stroke();
        break;
      case "ring":
        ctx.ellipse(cx, cy, Math.max(0.5, w / 2 - lw / 2), Math.max(0.5, h / 2 - lw / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "slant": {
        // A pill with its top cut down toward the middle (brows pulled in).
        const inner = e.side === 0 ? ex + w : ex;
        const outer = e.side === 0 ? ex : ex + w;
        ctx.moveTo(outer, ey);
        ctx.lineTo(inner, ey + h * 0.38);
        ctx.lineTo(inner, ey + h - w / 2);
        ctx.quadraticCurveTo(inner, ey + h, cx, ey + h);
        ctx.quadraticCurveTo(outer, ey + h, outer, ey + h - w / 2);
        ctx.closePath();
        ctx.fill();
        break;
      }
      default:
        ctx.roundRect(ex, ey, w, h, Math.min(w, h) / 2);
        ctx.fill();
    }
  }
}

const hash = (a, b) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

/**
 * An agent's idle life at time `t` (seconds): it turns its head toward a new
 * spot every couple of seconds (faster while `active`), blinks, breathes
 * (`squash`), and now and then shows an expression for a moment. `seed`
 * keeps several agents out of step; `every` (seconds, default 6.5) spaces the
 * expressions (each lasts 1.7 s). Returns a pose for drawAgent/eyeShapes.
 */
export function idlePose(t, seed = 0, opts = {}) {
  const period = opts.active ? 1.2 : 2.6;
  const at = t / period + seed * 3.1;
  const i = Math.floor(at);
  const target = (j) => [(hash(j, seed) * 2 - 1) * 0.85, (hash(j + 0.5, seed + 1) * 2 - 1) * 0.5];
  const a = target(i);
  const b = target(i + 1);
  const k = ease(Math.min(1, (at - i) * 2.4));
  const turn = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  const blink = (t + seed * 1.7) % 3.9 < 0.12;
  const squash = Math.sin(t * (opts.active ? 4 : 2.1) + seed) * (opts.active ? 0.7 : 0.35);
  let expression;
  const list = opts.expressions ?? Object.keys(EXPRESSIONS);
  if (list.length) {
    const every = opts.every ?? 6.5;
    const slot = Math.floor((t + seed * 5) / every);
    const phase = (t + seed * 5) % every;
    if (phase > every - 1.7) expression = list[Math.floor(hash(slot, seed + 2) * list.length)];
  }
  return { turn, blink, squash, expression };
}

/**
 * How the body sits for a pose: scale and shift (pseudo-3D turn and breath),
 * around the bottom middle. Accessories use `head` (a parallax shift in body
 * fractions, smaller than the eyes').
 */
export function bodyFrame(pose = {}) {
  const [tx, ty] = pose.turn ?? [0, 0];
  const sq = pose.squash ?? 0;
  return {
    sx: 1 + 0.035 * sq,
    sy: 1 - 0.045 * sq,
    dx: 0,
    // Accessories sit on the turning face; a touch of lean so hats feel on top of the head.
    head: [0.02 * tx, 0.015 * ty - 0.03 * sq],
  };
}

const noise = (x, y) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Draws a whole agent on a 2D canvas at (x, y), side `s` (canvas pixels).
 * Options: `color`, `eyes` (style), `pose` (see eyeShapes; `turn` and
 * `squash` also turn and breathe the body), `cells` (dither grid, default
 * from the size), `deep` tones, `progress` (0..1: the body forming from the
 * sky, cells arriving from the bottom-left with noise; eyes show once formed),
 * `withEyes` (default true) and `after(ctx, s, frame)`, called in the body's
 * own space (0..s) to draw on it (accessories).
 */
export function drawAgent(ctx, x, y, s, opts = {}) {
  const n = opts.cells ?? ditherCells(s);
  const tones = bodyTones(opts.color, opts.deep);
  const progress = opts.progress ?? 1;
  const pose = opts.pose ?? {};
  const frame = bodyFrame(pose);
  const p = s / n;
  // Pseudo-3D: the agent is a block with depth. Turning narrows the front face
  // (cos) and shows the side; looking down/up shows the top/bottom. The block
  // is drawn as stacked slices from the back to the front (a pixel extrusion).
  const [tx, ty] = pose.turn ?? [0, 0];
  const ax = tx * 0.62;
  const ay = ty * 0.42;
  const depth = s * 0.3;
  const fw = s * Math.cos(ax);
  const fh = s * Math.cos(ay);
  const backX = -Math.sin(ax) * depth;
  const backY = -Math.sin(ay) * depth;
  // Front face placed so the whole block stays centred in the box.
  const fx = (s - fw) / 2 - backX / 2;
  const fy = (s - fh) / 2 - backY / 2;
  ctx.save();
  ctx.translate(x + s / 2, y + s);
  ctx.scale(frame.sx, frame.sy);
  ctx.translate(-s / 2, -s);
  const radii = (w, h) =>
    [w * BODY_RADIUS, w * BODY_RADIUS, w * BODY_RADIUS, w * BODY_CUT].map((r) => Math.min(r, h / 2));
  if (progress >= 1 && (Math.abs(backX) > 0.5 || Math.abs(backY) > 0.5)) {
    const slices = Math.max(2, Math.round(Math.hypot(backX, backY) / (s / 24)));
    for (let k = slices; k >= 1; k--) {
      const f = k / slices;
      // Back slices darkest; the one right behind the face catches a little light (the edge).
      ctx.fillStyle = k === 1 ? tones[1] : k % 2 && slices > 3 ? tones[0] : mixHex(tones[0], tones[1], 0.35);
      ctx.beginPath();
      ctx.roundRect(fx + backX * f, fy + backY * f, fw, fh, radii(fw, fh));
      ctx.fill();
    }
  }
  // The front face: the dithered body, the eyes and whatever sits on it, squeezed by the turn.
  ctx.translate(fx, fy);
  ctx.scale(fw / s, fh / s);
  ctx.save();
  if (progress >= 1) {
    ctx.beginPath();
    ctx.roundRect(0, 0, s, s, [s * BODY_RADIUS, s * BODY_RADIUS, s * BODY_RADIUS, s * BODY_CUT]);
    ctx.clip();
  }
  for (let cy = 0; cy < n; cy++)
    for (let cx = 0; cx < n; cx++) {
      const u = (cx + 0.5) / n;
      const v = (cy + 0.5) / n;
      const tone = tones[toneAt(cx, cy, n, pose.turn)];
      if (progress < 1) {
        if (!inBody(u, v)) continue;
        const order = 0.55 * noise(cx, cy) + 0.45 * ((1 - v) * 0.6 + u * 0.4);
        const show = progress * 1.15 - order;
        if (show <= 0) continue;
        ctx.fillStyle = show < 0.08 ? "#eef7ff" : tone;
      } else ctx.fillStyle = tone;
      const x0 = Math.round(cx * p);
      const y0 = Math.round(cy * p);
      ctx.fillRect(x0, y0, Math.round((cx + 1) * p) - x0 + 0.5, Math.round((cy + 1) * p) - y0 + 0.5);
    }
  ctx.restore();
  if (opts.withEyes !== false && progress > 0.92) drawEyes(ctx, 0, 0, s, eyeShapes(opts.eyes, pose));
  if (opts.after && progress > 0.92) opts.after(ctx, s, frame);
  ctx.restore();
}

/**
 * A small pixel agent for the skies: n×n rows of "X" (body), "o" (eye) and
 * "." (empty), from the same shape and eyes (n = 9 gives the classic sprite).
 */
export function spriteGrid(n = 9, style = "round") {
  const eyes = eyeShapes(style);
  const rows = [];
  for (let y = 0; y < n; y++) {
    let row = "";
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      if (!inBody(u, v)) row += ".";
      else row += eyes.some((e) => u >= e.x && u <= e.x + e.w && v >= e.y && v <= e.y + e.h) ? "o" : "X";
    }
    rows.push(row);
  }
  return rows;
}

/* ---------- Accessories: pixel art on the body's 16×16 grid ---------- */

/** Accessory colors. A lowercase letter in CHECK is a 2-tone checker (dither) of two of these. */
export const ACCESSORY_PALETTE = {
  K: "#1d1d1b",
  k: "#3a3a37",
  W: "#ffffff",
  R: "#d0473c",
  r: "#9e3029",
  Y: "#f2c14e",
  y: "#c99a2e",
  P: "#ec6f9a",
  p: "#b9466f",
  B: "#3b82c4",
  G: "#23272e",
  g: "#7d8796",
  N: "#e0604f",
  n: "#a84436",
  V: "#8f6ff0",
  F: "#ffffff",
  f: "#f7c9da",
  O: "#f2c14e",
  M: "#5b6270",
  L: "#3fae6a",
};
export const ACCESSORY_CHECK = { c: ["K", "k"], h: ["Y", "y"], s: ["R", "r"], m: ["N", "n"] };
const CHECK = ACCESSORY_CHECK;

/**
 * Each accessory as rows of palette letters on the body's 16×16 grid: (ox, oy)
 * is where row 0 starts, (0, 0) being the body's top-left; they may reach
 * past the body. "A" is the antenna's light (it blinks while the agent works).
 */
export const ACCESSORIES = {
  hat: {
    ox: 2,
    oy: -6,
    rows: [
      "  KKKKKKKK  ",
      "  KkKKKKKK  ",
      "  KkKKKKKK  ",
      "  KKKKKKKK  ",
      "  RRRRRRRR  ",
      "KKKKKKKKKKKK",
      " KKKKKKKKKK ",
    ],
  },
  cap: {
    ox: 1,
    oy: -3,
    rows: ["    GGgGGG        ", "  GGGgGGGGGG      ", " GGGGGGGGGGGG     ", " GGGGGGGGGGGGKKKKK"],
  },
  headphones: {
    ox: -1,
    oy: -3,
    rows: [
      "     KKKKKKKK     ",
      "   KK        KK   ",
      "  K            K  ",
      " K              K ",
      " K              K ",
      "K                K",
      "K                K",
      "K                K",
      "KKK            KKK",
      "KgK            KgK",
      "KgK            KgK",
      "KgK            KgK",
      "KKK            KKK",
    ],
  },
  bow: {
    ox: 10,
    oy: -3,
    rows: ["PP   PP", "PPP PPP", "PPPpPPP", "PPP PPP", "PP   PP"],
  },
  crown: {
    ox: 3,
    oy: -5,
    rows: ["Y   YY   Y", "YY  YY  YY", "YhYYYYYYhY", "YYYRYYBYYY", "yyyyyyyyyy"],
  },
  antenna: {
    ox: 6,
    oy: -6,
    rows: [" AA ", "AAAA", " AA ", " kk ", " kk ", " kk ", "KKKK"],
  },
  headset: {
    ox: -1,
    oy: -3,
    rows: [
      "     kkkkkkkk     ",
      "   kk        kk   ",
      "  k            k  ",
      " k              k ",
      " k              k ",
      "k                k",
      "k                k",
      "k                k",
      "KKK              k",
      "KgK               ",
      "KgK               ",
      "KgK               ",
      "KKK               ",
      " k                ",
      " k                ",
      "  k               ",
      "   kkMM           ",
    ],
  },
  beanie: {
    ox: 1,
    oy: -5,
    rows: [
      "      WW      ",
      "     WWWW     ",
      "   NNNNNNNN   ",
      "  NNNNNNNNNN  ",
      " NNNNNNNNNNNN ",
      "mmmmmmmmmmmmmm",
      "mmmmmmmmmmmmmm",
    ],
  },
  party: {
    ox: 7,
    oy: -8,
    rows: ["   W   ", "  WWW  ", "   V   ", "  VVV  ", "  YYY  ", " VVVVV ", " YYYYY ", "VVVVVVV"],
  },
  flower: {
    ox: 10,
    oy: -3,
    rows: [" FfF ", "FFOFF", "fOOOf", "FFOFF", " FfF ", "  L  ", " LL  "],
  },
  scarf: {
    ox: -1,
    oy: 12,
    rows: [
      " ssssssssssssssss ",
      "RRRRRRRRRRRRRRRRRR",
      "ssssssssssssssssRR",
      "             RRR  ",
      "             sss  ",
      "             RRR  ",
      "             R R  ",
    ],
  },
};

/** The accessories an agent can wear ("none" first). */
export const ACCESSORY_NAMES = ["none", ...Object.keys(ACCESSORIES)];

/** How far an accessory reaches past the body, in body fractions: room to leave around a drawn agent. */
export const ACCESSORY_REACH = { top: 9 / 16, left: 1 / 16, right: 2 / 16, bottom: 7 / 16 };

/**
 * Draws an accessory on a body of side `s` in the body's own space (inside
 * drawAgent's `after`): `frame` adds the head's parallax, `t` and `active`
 * blink the antenna.
 */
export function drawAccessory(ctx, s, name, frame, t = 0, active = false) {
  const a = ACCESSORIES[name];
  if (!a) return;
  const u = s / 16;
  const hx = (frame?.head?.[0] ?? 0) * s;
  const hy = (frame?.head?.[1] ?? 0) * s;
  for (let j = 0; j < a.rows.length; j++) {
    const row = a.rows[j];
    for (let i = 0; i < row.length; i++) {
      let ch = row[i];
      if (ch === " ") continue;
      const gx = a.ox + i;
      const gy = a.oy + j;
      if (CHECK[ch]) ch = CHECK[ch][(gx + gy) & 1];
      ctx.fillStyle =
        ch === "A" ? (active && Math.floor(t * 3) % 2 ? "#ffd0c9" : "#ff6b5e") : (ACCESSORY_PALETTE[ch] ?? "#000000");
      ctx.fillRect(gx * u + hx, gy * u + hy, u + 0.6, u + 0.6);
    }
  }
}

/**
 * The two pixel z's of a sleeping agent, on the body's 16×16 grid: in the cut of the head's rounded top-right corner and
 * up and right from it. A tile leaves a bare head 4.8 cells above and 4.1 to its right: both fit there.
 */
const SLEEP_Z = ["###", "  #", " # ", "###"];
export const SLEEP_SPOTS = [
  [14.5, -2.6],
  [17, -4.8],
];

/**
 * A sleeping agent's "zz" (paused until its plan or budget is back), drawn in the body's own space like an accessory
 * (inside drawAgent's `after`), in `color`. With `t` the high one comes and goes; without it (still frames, reduced
 * motion) both show.
 */
export function drawSleep(ctx, s, frame, color, t) {
  const u = s / 16;
  const hx = (frame?.head?.[0] ?? 0) * s;
  const hy = (frame?.head?.[1] ?? 0) * s;
  // The high z comes and goes (a third of the time away): both stay readable as "zz", not one "z" alone.
  const rising = t !== undefined && Math.floor(t / 0.8) % 3 === 0;
  ctx.fillStyle = color;
  SLEEP_SPOTS.forEach(([ox, oy], k) => {
    if (rising && k === 1) return;
    for (let j = 0; j < SLEEP_Z.length; j++)
      for (let i = 0; i < SLEEP_Z[j].length; i++)
        if (SLEEP_Z[j][i] === "#") ctx.fillRect((ox + i) * u + hx, (oy + j) * u + hy, u + 0.6, u + 0.6);
  });
}

/** A sleeping agent's pose: eyes closed, the head a little down, breathing slowly (still: no breath). */
export function sleepPose(t, seed = 0) {
  return { expression: "closed", turn: [0, 0.15], squash: t === undefined ? 0 : Math.sin(t * 1.1 + seed) * 0.3 };
}

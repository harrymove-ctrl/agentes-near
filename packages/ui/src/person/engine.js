/**
 * A person's pixel portrait. A portrait is a small recipe (build, skin, hair,
 * beard, glasses, what they wear, mood, background) drawn on a 32×32 grid; the
 * background is the sky's dither in the agents' colors (ADR 0166). Nothing here
 * is an image: every piece comes from row masks, so any piece fits any other.
 * Plain JavaScript with types in engine.d.ts, like the agent engine, so plain
 * HTML pages can import it as is.
 */
import { AGENT_GRADIENTS, bodyTones, mixHex, toneAt } from "../agent/engine.js";

export const N = 32;
const INK = "#1d1722";

export const SKINS = {
  s1: { base: "#fbd9bd", shade: "#eab594", blush: "#f4a48f" },
  s2: { base: "#f3c49c", shade: "#dea377", blush: "#ea917b" },
  s3: { base: "#e0a878", shade: "#c48a59", blush: "#d57f67" },
  s4: { base: "#c58a5c", shade: "#a66d43", blush: "#b9634f" },
  s5: { base: "#9c6440", shade: "#7f4d2f", blush: "#8f4638" },
  s6: { base: "#6f432b", shade: "#56311f", blush: "#683026" },
};

export const HAIR_COLORS = {
  black: "#2a2430",
  dark: "#4a2f24",
  brown: "#7a4a2c",
  auburn: "#b4522a",
  blond: "#e9b949",
  gray: "#9a9aa2",
  white: "#e4e4e8",
  pink: "#e86a9a",
  blue: "#4f7fe0",
};

export const CLOTHES_COLORS = {
  navy: "#27365f",
  black: "#2b2a30",
  white: "#f1f0ec",
  gray: "#8b8d96",
  wine: "#8c2f45",
  green: "#2f7d55",
  mustard: "#d9a02b",
  blue: "#3b78d8",
  pink: "#e27aa0",
};

export const HAIRS = [
  "none",
  "buzz",
  "short",
  "side",
  "quiff",
  "curly",
  "afro",
  "bob",
  "bangs",
  "long",
  "wavy",
  "curls",
  "bun",
  "pony",
  "spiky",
  "mohawk",
  "braids",
  "pigtails",
  "crew",
  "fade",
  "slick",
  "flat",
  "undercut",
  "mullet",
  "dreads",
  "medium",
  "receding",
];
export const BEARDS = ["none", "stubble", "mustache", "goatee", "strap", "full", "long"];
export const BUILDS = ["m", "f"];
export const GLASSES = ["none", "round", "square", "gold", "tinted", "shades"];
export const EXTRAS = [
  "none",
  "headband",
  "bandana",
  "bow",
  "flower",
  "headphones",
  "cap",
  "beanie",
  "hat",
  "crown",
  "scarf",
];
export const CLOTHES = [
  "tee",
  "vneck",
  "tank",
  "shirt",
  "suit",
  "blazer",
  "jacket",
  "hoodie",
  "turtle",
  "overall",
  "polo",
  "dress",
];
export const MOODS = ["smile", "grin", "laugh", "calm", "wink", "wow"];
export const EARS_LIST = ["none", "studs", "pearls", "hoops", "drops"];
export const NECKS = ["none", "necklace", "pearls", "choker", "bowtie", "muffler"];
export const LIPS = {
  none: null,
  nude: "#b5695a",
  pink: "#e2607f",
  red: "#c2334d",
  wine: "#7a1f3a",
  purple: "#8e44ad",
  black: "#2a2430",
};
export const SHADOWS = {
  none: null,
  rose: "#e8839f",
  violet: "#9a6fe0",
  blue: "#4f8fe0",
  green: "#3fa877",
  gold: "#d9a02b",
  smoky: "#4a4350",
};
export const BLUSHES = ["soft", "strong", "none"];
export const MARKS = ["none", "freckles", "mole", "scar", "bandaid", "piercing"];
export const EYES = { dark: null, brown: "#6b3d1f", blue: "#2f66c9", green: "#2f8a57", gray: "#70778a" };
export const BGS = Object.keys(AGENT_GRADIENTS);

/** What each build is offered first (every piece stays valid on either: this is only what the builder lists). */
export const CATALOG = {
  m: {
    hair: [
      "short",
      "side",
      "quiff",
      "spiky",
      "buzz",
      "none",
      "curly",
      "afro",
      "mohawk",
      "long",
      "bun",
      "pony",
      "braids",
      "crew",
      "fade",
      "slick",
      "flat",
      "undercut",
      "mullet",
      "dreads",
      "medium",
      "receding",
    ],
    ear: ["none", "studs", "hoops"],
    neck: ["none", "necklace", "bowtie", "muffler"],
    extra: ["none", "cap", "beanie", "hat", "bandana", "headphones", "crown"],
    clothes: ["tee", "polo", "vneck", "tank", "shirt", "suit", "blazer", "jacket", "hoodie", "turtle"],
    lips: ["none"],
    shadow: ["none"],
    blush: ["soft", "none"],
  },
  f: {
    hair: [
      "long",
      "wavy",
      "curls",
      "bob",
      "bangs",
      "bun",
      "pony",
      "braids",
      "pigtails",
      "medium",
      "dreads",
      "afro",
      "curly",
      "short",
      "side",
      "buzz",
      "none",
    ],
    beard: ["none"],
    neck: ["none", "necklace", "pearls", "choker", "muffler"],
    extra: ["none", "headband", "bow", "flower", "bandana", "scarf", "hat", "beanie", "cap", "headphones", "crown"],
    clothes: ["tee", "vneck", "tank", "dress", "shirt", "blazer", "jacket", "hoodie", "turtle", "overall"],
  },
};

export const DEFAULT = {
  build: "m",
  skin: "s2",
  hair: "short",
  hairColor: "brown",
  beard: "none",
  glasses: "none",
  extra: "none",
  ear: "none",
  neck: "none",
  lips: "none",
  shadow: "none",
  blush: "soft",
  mark: "none",
  eyes: "dark",
  clothes: "tee",
  clothesColor: "navy",
  mood: "smile",
  bg: "sky",
};

/* ── masks ── */
const key = (x, y) => y * N + x;
/** Rows "y:x0-x1[,x0-x1]" → a mask (a set of cell keys). */
function rows(spec) {
  const m = new Set();
  for (const line of spec.trim().split(/\s+/)) {
    const [y, spans] = line.split(":");
    for (const span of spans.split(",")) {
      const [a, b = a] = span.split("-").map(Number);
      for (let x = a; x <= b; x++) if (x >= 0 && x < N && +y >= 0 && +y < N) m.add(key(x, +y));
    }
  }
  return m;
}
function ellipse(cx, cy, rx, ry) {
  const m = new Set();
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) m.add(key(x, y));
  return m;
}
const union = (...ms) => new Set(ms.flatMap((m) => [...m]));
const minus = (a, b) => new Set([...a].filter((k) => !b.has(k)));
const mirror = (m) => new Set([...m].map((k) => key(N - 1 - (k % N), Math.floor(k / N))));
const both = (m) => union(m, mirror(m));

const FACE = rows(
  "8:11-20 9:10-21 10:9-22 11:9-22 12:9-22 13:9-22 14:9-22 15:9-22 16:9-22 17:9-22 18:9-22 19:9-22 20:10-21 21:11-20 22:12-19",
);
const EARS = both(rows("14:8 15:8 16:8"));
const FACE_F = rows(
  "8:11-20 9:10-21 10:9-22 11:9-22 12:9-22 13:9-22 14:9-22 15:9-22 16:9-22 17:9-22 18:9-22 19:10-21 20:11-20 21:12-19 22:13-18",
);
const NECK_F = rows("22:14-17 23:14-17 24:14-17 25:14-17");
const BODY_F = rows("25:11-20 26:8-23 27:6-25 28:5-26 29:5-26 30:5-26 31:5-26");
const NECK = rows("22:13-18 23:13-18 24:13-18 25:13-18");
const BODY = rows("25:10-21 26:7-24 27:5-26 28:4-27 29:4-27 30:4-27 31:4-27");

/** The cap of hair every short cut shares. */
const CAP = rows("5:11-20 6:9-22 7:8-23 8:8-23 9:8-23 10:8-9,22-23 11:8-9,22-23 12:8,23");

const HAIR_SHAPES = {
  none: {},
  buzz: { front: rows("7:11-20 8:9-22 9:9-22 10:9,22 11:9,22"), thin: true },
  short: { front: union(CAP, rows("10:10-12,19-21")) },
  side: { front: union(CAP, rows("4:12-18 5:9-20 10:10-19 11:10-16 12:10-12")) },
  quiff: { front: union(CAP, rows("2:14-19 3:12-21 4:11-22 5:10-22 10:18-21")) },
  curly: {
    front: union(
      rows(
        "3:11-13,15-17,19-21 4:9-22 5:8-23 6:7-24 7:7-24 8:7-24 9:7-24 10:7-10,21-24 11:7-9,22-24 12:7-8,23-24 13:7,24",
      ),
      rows("10:12-13,17-18"),
    ),
    curl: true,
  },
  afro: {
    front: union(
      minus(ellipse(15.5, 8.5, 11.2, 8.2), rows("10:11-20 11:10-21 12:9-22 13:9-22 14:9-22 15:9-22 16:9-22 17:9-22")),
      rows("2:10-12,14-17,19-21"),
    ),
    curl: true,
  },
  bob: {
    back: rows(
      "8:6-25 9:6-25 10:6-25 11:6-25 12:6-25 13:6-25 14:6-25 15:6-25 16:6-25 17:6-25 18:6-25 19:6-25 20:6-25 21:7-24 22:8-23",
    ),
    front: union(
      CAP,
      rows(
        "4:12-19 5:9-22 6:7-24 7:6-25 8:6-25 9:6-25 10:6-11,21-25 11:6-9,22-25 12:6-8,23-25 13:6-8,23-25 14:6-7,24-25 15:6-7,24-25 16:6-7,24-25 17:6-7,24-25 18:6-8,23-25 19:6-8,23-25 20:6-9,22-25 21:7-9,22-24",
      ),
    ),
  },
  bangs: {
    back: rows(
      "8:6-25 9:6-25 10:6-25 11:6-25 12:6-25 13:6-25 14:6-25 15:6-25 16:6-25 17:6-25 18:6-25 19:6-25 20:6-25 21:6-25 22:6-25 23:6-25 24:7-24",
    ),
    front: union(
      CAP,
      rows(
        "4:12-19 5:9-22 6:7-24 7:6-25 8:6-25 9:6-25 10:6-25 11:6-25 12:6-8,23-25 13:6-8,23-25 14:6-7,24-25 15:6-7,24-25 16:6-7,24-25 17:6-7,24-25 18:6-7,24-25 19:6-8,23-25 20:6-8,23-25 21:6-8,23-25 22:6-9,22-25 23:7-9,22-24",
      ),
    ),
  },
  long: {
    back: rows(
      "8:6-25 9:6-25 10:5-26 11:5-26 12:5-26 13:5-26 14:5-26 15:5-26 16:5-26 17:5-26 18:5-26 19:5-26 20:5-26 21:5-26 22:5-26 23:5-26 24:5-26 25:5-26 26:5-26 27:5-26 28:5-26 29:6-25",
    ),
    front: union(
      CAP,
      rows(
        "4:12-19 5:9-22 6:7-24 7:6-25 8:6-25 9:6-25 10:5-10,20-26 11:5-9,22-26 12:5-8,23-26 13:5-8,23-26 14:5-7,24-26 15:5-7,24-26 16:5-7,24-26 17:5-7,24-26 18:5-7,24-26 19:5-8,23-26 20:5-8,23-26 21:5-8,23-26 22:5-9,22-26 23:5-9,22-26 24:5-9,22-26 25:5-8,23-26 26:5-6,25-26 27:5-6,25-26 28:5,26",
      ),
    ),
  },
  wavy: {
    back: rows(
      "8:6-25 9:5-26 10:4-27 11:4-27 12:5-26 13:5-26 14:4-27 15:4-27 16:5-26 17:5-26 18:4-27 19:4-27 20:5-26 21:5-26 22:4-27 23:4-27 24:5-26 25:5-26 26:4-27 27:4-27 28:5-26 29:5-26 30:6-25",
    ),
    front: union(
      CAP,
      rows(
        "4:11-20 5:8-23 6:6-25 7:5-26 8:5-26 9:5-26 10:4-11,20-27 11:4-9,22-27 12:5-8,23-26 13:5-8,23-26 14:4-7,24-27 15:4-7,24-27 16:5-7,24-26 17:5-7,24-26 18:4-7,24-27 19:4-8,23-27 20:5-8,23-26 21:5-8,23-26 22:4-9,22-27 23:4-9,22-27 24:5-9,22-26 25:5-8,23-26 26:4-7,24-27 27:4-6,25-27 28:5-6,25-26 29:5,26",
      ),
    ),
    wave: true,
  },
  curls: {
    back: rows(
      "7:5-26 8:4-27 9:4-27 10:3-28 11:3-28 12:3-28 13:3-28 14:3-28 15:3-28 16:3-28 17:3-28 18:3-28 19:3-28 20:3-28 21:3-28 22:3-28 23:4-27 24:4-27 25:4-27 26:5-26 27:6-25",
    ),
    front: union(
      rows(
        "3:10-12,14-17,19-21 4:8-23 5:6-25 6:5-26 7:4-27 8:4-27 9:4-27 10:3-10,21-28 11:3-9,22-28 12:3-8,23-28 13:3-8,23-28 14:3-7,24-28 15:3-7,24-28 16:3-7,24-28 17:3-7,24-28 18:3-7,24-28 19:3-8,23-28 20:3-8,23-28 21:3-8,23-28 22:3-9,22-28 23:4-9,22-27 24:4-8,23-27 25:4-7,24-27 26:5-6,25-26",
      ),
      rows("10:12-13,18-19"),
    ),
    curl: true,
  },
  bun: { front: union(CAP, rows("0:14-17 1:13-18 2:12-19 3:12-19 4:12-19 10:10-11,20-21")) },
  spiky: {
    front: union(
      CAP,
      rows(
        "0:15 1:10,15-16,21 2:10-11,15-16,20-21 3:7,10-12,14-17,19-21,24 4:7-8,10-12,14-17,19-21,23-24 5:7-24 6:8-23 10:10-11,14-15,18-19,21 11:10,14,19",
      ),
    ),
    spike: true,
  },
  mohawk: { front: rows("1:14-17 2:13-18 3:13-18 4:13-18 5:13-18 6:13-18 7:13-18 8:13-18 9:14-17") },
  braids: {
    front: union(
      CAP,
      rows(
        "4:12-19 10:6-10,21-25 11:6-9,22-25 12:6-8,23-25 13:6-8,23-25 14:5-7,24-26 15:5-7,24-26 16:6-8,23-25 17:6-8,23-25 18:5-7,24-26 19:5-7,24-26 20:6-8,23-25 21:6-8,23-25 22:5-7,24-26 23:5-7,24-26 24:6-8,23-25 25:6-8,23-25 26:6-7,24-25 27:6-7,24-25",
      ),
    ),
    braid: true,
  },
  pigtails: {
    back: both(rows("8:4-7 9:3-7 10:2-7 11:2-7 12:2-7 13:2-7 14:3-7 15:3-7 16:4-6 17:4-6 18:5")),
    front: union(CAP, rows("4:12-19 10:10-12,19-21")),
  },
  crew: { front: rows("6:10-21 7:9-22 8:8-23 9:8-23 10:8,23 11:8,23") },
  fade: {
    front: rows("4:11-20 5:10-21 6:9-22 7:9-22 8:9-22 9:10-21"),
    fade: both(rows("8:8 9:8-9 10:8-9 11:8-9 12:8-9 13:9")),
  },
  slick: { front: union(CAP, rows("4:11-20")), slick: true },
  flat: { front: union(CAP, rows("2:9-22 3:8-23 4:8-23 5:8-23 6:8-23")) },
  undercut: {
    front: rows("3:12-21 4:10-22 5:9-23 6:9-23 7:9-23 8:9-23 9:10-23 10:16-23 11:20-23"),
    fade: rows("8:8 9:8-9 10:8-9 11:8-9 12:8-9 13:9"),
  },
  mullet: {
    back: rows("15:7-24 16:6-25 17:6-25 18:6-25 19:6-25 20:6-25 21:6-25 22:6-25 23:6-25 24:6-25 25:7-24"),
    front: union(CAP, rows("4:12-19 10:10-13,18-21")),
  },
  dreads: {
    back: rows(
      "8:6-25 9:6-25 10:6-25 11:6-25 12:6-25 13:6-25 14:6-25 15:6-25 16:6-25 17:6-25 18:6-25 19:6-25 20:6-25 21:6-25 22:6-25",
    ),
    front: union(
      CAP,
      rows(
        "3:10,13,16,19,22 4:9-22 10:6-10,21-25 11:6-9,22-25 12:6-8,23-25 13:6-8,23-25 14:6-8,23-25 15:6-8,23-25 16:6-8,23-25 17:6-8,23-25 18:6-8,23-25 19:6-8,23-25 20:6-8,23-25 21:6-8,23-25 22:6,8,23,25",
      ),
    ),
    braid: true,
  },
  medium: {
    back: rows(
      "8:7-24 9:7-24 10:7-24 11:7-24 12:7-24 13:7-24 14:7-24 15:7-24 16:7-24 17:7-24 18:7-24 19:7-24 20:7-24 21:8-23",
    ),
    front: union(
      CAP,
      rows(
        "4:12-19 10:7-11,20-24 11:7-9,22-24 12:7-8,23-24 13:7-8,23-24 14:7,24 15:7,24 16:7,24 17:7-8,23-24 18:7-8,23-24 19:7-8,23-24 20:8,23",
      ),
    ),
  },
  receding: { front: rows("6:11-20 7:9-22 8:8-23 9:8-11,14-17,20-23 10:8-9,22-23 11:8,23") },
  pony: {
    back: rows(
      "7:23-27 8:24-28 9:24-28 10:24-28 11:24-28 12:24-28 13:25-28 14:25-28 15:25-28 16:25-27 17:25-27 18:25-27 19:26-27 20:26",
    ),
    front: union(CAP, rows("4:12-19 10:10-13 11:10-11")),
  },
};

const BEARD_SHAPES = {
  none: null,
  stubble: rows("16:9,22 17:9-10,21-22 18:9-11,20-22 19:9-12,19-22 20:10-21 21:11-20 22:12-19 17:13-18"),
  mustache: rows("17:12-19 18:12,19"),
  goatee: rows("17:12-19 18:12,19 19:12,19 20:12-19 21:13-18 22:13-18"),
  strap: rows("15:9,22 16:9,22 17:9,22 18:9,22 19:9-10,21-22 20:10-11,20-21 21:11-20 22:12-19"),
  long: rows(
    "14:9,22 15:9,22 16:9-10,21-22 17:9-22 18:9-12,19-22 19:9-12,19-22 20:9-22 21:10-21 22:10-21 23:11-20 24:11-20 25:12-19 26:13-18",
  ),
  full: rows(
    "14:9,22 15:9,22 16:9-10,21-22 17:9-19,21-22 17:20 18:9-12,19-22 19:9-12,19-22 20:9-22 21:10-21 22:11-20 23:12-19",
  ),
};

/* ── drawing ── */
function paint(buf, mask, fill, outline = INK) {
  if (outline)
    for (const k of mask) {
      const x = k % N,
        y = Math.floor(k / N);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const X = x + dx,
          Y = y + dy;
        if (X >= 0 && X < N && Y >= 0 && Y < N && !mask.has(key(X, Y))) buf[key(X, Y)] = outline;
      }
    }
  for (const k of mask) buf[k] = typeof fill === "function" ? fill(k % N, Math.floor(k / N)) : fill;
}
const dot = (buf, spec, color) => {
  for (const k of rows(spec)) buf[k] = color;
};

function hairFill(color, shape, mask) {
  const hi = mixHex(color, "#ffffff", 0.28);
  const lo = mixHex(color, "#000000", 0.28);
  return (x, y) => {
    if (shape.braid && y > 12 && (x < 10 || x > 21)) return y % 4 === 1 ? lo : y % 4 === 3 ? hi : color;
    if (shape.spike && y <= 4) return (x + y * 2) % 5 === 0 ? lo : y <= 1 ? hi : color;
    if (shape.slick && y <= 9 && x % 3 === 0) return lo;
    if (shape.curl) return (x + y * 3) % 5 === 0 ? lo : (x * 2 + y) % 7 === 0 ? hi : color;
    // light at the top left, shade along the bottom edge
    if (!mask.has(key(x, y + 1)) && y > 9) return lo;
    if (shape.wave && (x + Math.floor(y / 2)) % 6 === 0 && y > 9) return lo;
    if (y >= 6 && y <= 7 && x >= 11 && x <= 15) return hi;
    if (y === 8 && x >= 10 && x <= 12) return hi;
    return color;
  };
}

/** A recipe → 32×32 colors, row by row (null = background). */
export function drawPerson(recipe) {
  const r = cleanRecipe(recipe);
  const buf = new Array(N * N).fill(null);
  const skin = SKINS[r.skin] ?? SKINS.s2;
  const hairC = HAIR_COLORS[r.hairColor] ?? HAIR_COLORS.brown;
  const hairInk = mixHex(hairC, INK, 0.72);
  const cloth = CLOTHES_COLORS[r.clothesColor] ?? CLOTHES_COLORS.navy;
  const clothLo = mixHex(cloth, "#000000", 0.25);
  const clothHi = mixHex(cloth, "#ffffff", 0.22);
  const clothInk = mixHex(cloth, INK, 0.75);
  const skinInk = mixHex(skin.shade, INK, 0.5);
  const shape = HAIR_SHAPES[r.hair] ?? {};
  const hatted = ["cap", "beanie", "hat", "scarf"].includes(r.extra);
  const fem = r.build === "f";
  const face = fem ? FACE_F : FACE;
  const body = fem ? BODY_F : BODY;

  // hair behind the head
  if (shape.back && r.extra !== "scarf") paint(buf, shape.back, hairFill(hairC, shape, shape.back), hairInk);

  // body and clothes
  paint(buf, body, (x, _y) => (x <= 5 || x >= 26 ? clothLo : cloth), clothInk);
  // the neck goes after the body, so the clothes' outline does not cover it
  paint(buf, fem ? NECK_F : NECK, (_x, y) => (y <= 23 ? mixHex(skin.base, skin.shade, 0.6) : skin.base), skinInk);
  const shirt = r.clothesColor === "white" ? "#dfe6f2" : "#f6f5f1";
  if (r.clothes === "tee") {
    dot(buf, "25:12-19 26:13-18", skin.base);
    dot(buf, "27:13-18 26:12,19 25:11,20", clothInk);
  } else if (r.clothes === "shirt") {
    dot(buf, "25:13-18", skin.base);
    dot(buf, "26:15-16", skin.shade);
    dot(buf, "26:12-14,17-19 27:13-14,17-18", clothHi);
    dot(buf, "25:11-12,19-20 27:12,15-16,19 28:13-14,17-18", clothInk);
    dot(buf, "29:16 31:16", clothLo);
  } else if (r.clothes === "suit" || r.clothes === "blazer") {
    dot(buf, "25:12-19 26:12-19 27:13-18 28:13-18 29:14-17 30:14-17 31:15-16", shirt);
    dot(buf, "25:11,20 26:11,20 27:12,19 28:12,19 29:13,18 30:13,18 31:14,17", clothInk);
    dot(buf, "27:9-11,20-22 28:10-11,20-21", clothHi);
    if (r.clothes === "suit") {
      const tie = r.clothesColor === "wine" ? "#27365f" : "#8c2f45";
      dot(buf, "25:13-18", skin.base);
      dot(buf, "26:15-16 27:15-16 28:15-16 29:15-16 30:15-16 31:15-16", tie);
      dot(buf, "26:13-14,17-18", "#ffffff");
    } else dot(buf, "25:13-18 26:14-17", skin.base);
  } else if (r.clothes === "hoodie") {
    dot(buf, "23:10-12,19-21 24:9-12,19-22 25:10-12,19-21", cloth);
    dot(buf, "22:10-12,19-21 23:9,22 24:8,23", clothInk);
    dot(buf, "25:13-18", skin.base);
    dot(buf, "26:13-18", clothInk);
    dot(buf, "27:14,17 28:14,17", clothHi);
  } else if (r.clothes === "vneck") {
    dot(buf, "25:12-19 26:13-18 27:14-17 28:15-16", skin.base);
    dot(buf, "25:11,20 26:12,19 27:13,18 28:14,17 29:15-16", clothInk);
  } else if (r.clothes === "polo") {
    dot(buf, "25:13-18", skin.base);
    dot(buf, "25:11-12,19-20 26:12-14,17-19", clothHi);
    dot(buf, "26:15-16", skin.shade);
    dot(buf, "27:12-14,17-19 27:15-16 28:15-16 29:15-16", clothLo);
    dot(buf, "28:16", "#f6f5f1");
  } else if (r.clothes === "dress") {
    for (const k of body) {
      const x = k % N,
        y = Math.floor(k / N);
      if (y >= 26 && (x <= 9 || x >= 22)) buf[k] = x === 9 || x === 22 ? clothInk : skin.base;
    }
    dot(buf, "25:12-19 26:11-20 27:11-20 28:12-14,17-19", skin.base);
    dot(buf, "25:11,20 26:10,21 27:10,21", cloth);
    dot(buf, "28:11,15-16,20 29:12-14,17-19", clothInk);
  } else if (r.clothes === "tank") {
    for (const k of body) {
      const x = k % N,
        y = Math.floor(k / N);
      if (y >= 26 && (x <= 9 || x >= 22)) buf[k] = x === 9 || x === 22 ? clothInk : skin.base;
    }
    dot(buf, "25:12-19 26:12-19 27:13-18", skin.base);
    dot(buf, "25:11,20 26:11,20 27:12,19 28:13-18", clothInk);
  } else if (r.clothes === "jacket") {
    dot(buf, "25:13-18", skin.base);
    dot(buf, "26:14-17", shirt);
    dot(buf, "25:11-12,19-20 26:11-13,18-20", clothHi);
    dot(buf, "27:13-18 24:11-12,19-20", clothInk);
    dot(buf, "28:15-16 29:15-16 30:15-16 31:15-16", clothInk);
    dot(buf, "28:16 30:16", "#c9c9d2");
  } else if (r.clothes === "overall") {
    for (const k of body) buf[k] = shirt;
    dot(buf, "25:13-18 26:14-17", skin.base);
    dot(buf, "26:10-12,19-21 27:10-12,19-21 28:10-12,19-21 29:9-22 30:9-22 31:9-22", cloth);
    dot(buf, "28:9,13,18,22 27:9,13,18,22 26:13,18", clothInk);
    dot(buf, "29:11,20", "#f4c531");
  } else if (r.clothes === "turtle") {
    dot(buf, "23:13-18 24:12-19 25:12-19", clothHi);
    dot(buf, "22:13-18 23:12,19 24:11,20 26:12-19", clothInk);
  }

  // around the neck (before the head: the chin stays on top)
  const neckW = fem ? "14-17" : "13-18";
  if (r.neck === "necklace") {
    dot(buf, "25:13,18 26:14,17 27:15-16", "#f4c531");
    dot(buf, "28:15-16", "#4cd0c0");
  } else if (r.neck === "pearls") {
    dot(buf, "25:13,18 26:14-17", "#ffffff");
    dot(buf, "26:15,17 25:18", "#c9c9d6");
  } else if (r.neck === "choker") dot(buf, `24:${neckW}`, "#2a2430");
  else if (r.neck === "bowtie") {
    paint(buf, rows("25:13-18 26:13-14,17-18"), "#c2334d", INK);
    dot(buf, "25:15-16", "#7a1f3a");
  } else if (r.neck === "muffler")
    paint(
      buf,
      rows("22:12-19 23:11-20 24:11-20 25:12-19 26:17-19 27:17-19 28:17-19"),
      (x, y) => ((x + y) % 4 < 1 ? "#f6f5f1" : "#d6455d"),
      "#5a1525",
    );

  // head
  paint(buf, union(face, EARS), skin.base, skinInk);
  dot(buf, "15:8,23", skin.shade);

  // beard (inside the face only; the full and the long one go past the chin)
  const beard = BEARD_SHAPES[r.beard];
  if (beard) {
    const over = r.beard === "full" || r.beard === "long";
    const m = over ? beard : new Set([...beard].filter((k) => face.has(k)));
    if (r.beard === "stubble")
      paint(buf, m, mixHex(skin.base, hairC === HAIR_COLORS.blond ? "#8a6a3a" : hairC, 0.34), null);
    else paint(buf, m, (x, y) => ((x + y) % 4 === 0 ? mixHex(hairC, "#000000", 0.2) : hairC), over ? hairInk : null);
  }
  const bearded = r.beard === "full" || r.beard === "long";

  // face
  const framed = ["round", "square", "gold", "tinted"].includes(r.glasses);
  const lens = r.glasses === "tinted" ? mixHex(skin.base, "#e8537a", 0.38) : mixHex(skin.base, "#ffffff", 0.2);
  const eyeBg = framed ? lens : skin.base;
  if (framed) dot(buf, "13:11-14,17-20 14:11-14,17-20 15:11-14,17-20", lens);
  const brow = r.hair === "none" && r.beard === "none" ? mixHex(skin.shade, INK, 0.55) : hairInk;
  dot(
    buf,
    r.mood === "wow" ? (fem ? "10:11-12,19-20" : "10:11-13,18-20") : fem ? "11:11-12,19-20" : "11:11-13,18-20",
    brow,
  );
  const eye = "#231a22";
  if (r.glasses !== "shades") {
    if (r.mood === "laugh") dot(buf, "13:12-13,18-19 14:11,14,17,20", eye);
    else {
      dot(buf, "13:12-13,18-19 14:12-13,18-19 15:12-13,18-19", eye);
      if (EYES[r.eyes]) dot(buf, "14:12-13,18-19 15:12-13,18-19", EYES[r.eyes]);
      dot(buf, "13:12,18", "#ffffff");
      if (fem) dot(buf, "13:11,20", eye);
      if (r.mood === "wink") {
        dot(buf, "13:18-20 15:18-19", eyeBg);
        dot(buf, "14:17", eye);
      }
      if (r.mood === "calm") {
        dot(buf, "13:11-13,18-20", eyeBg);
        dot(buf, "14:12,18", "#ffffff");
        if (fem) dot(buf, "14:11,20", eye);
      }
    }
  }
  if (SHADOWS[r.shadow] && r.glasses !== "shades")
    dot(buf, "12:12-13,18-19", mixHex(SHADOWS[r.shadow], skin.base, 0.2));
  if (!bearded && r.beard !== "stubble") {
    if (r.blush === "soft") dot(buf, "17:10-11,20-21", skin.blush);
    else if (r.blush === "strong") dot(buf, "16:10-11,20-21 17:10-12,19-21", mixHex(skin.blush, "#e8537a", 0.55));
  }
  if (r.mark === "freckles") dot(buf, "16:11,20 17:10,12,19,21 16:13,18", mixHex(skin.shade, "#7a4a2c", 0.45));
  else if (r.mark === "mole") dot(buf, "18:20", "#4a2f24");
  else if (r.mark === "scar") dot(buf, "15:20 16:21 17:21", mixHex(skin.base, "#ffffff", 0.55));
  else if (r.mark === "bandaid") {
    dot(buf, "16:14-17", "#f0cfa0");
    dot(buf, "16:15-16", "#fbe9cc");
  } else if (r.mark === "piercing") dot(buf, "17:16", "#e3e3ea");
  const lip = LIPS[r.lips] ?? mixHex(skin.blush, INK, 0.62);
  if (r.mood === "grin" || r.mood === "laugh") {
    dot(buf, "18:13-18", lip);
    dot(buf, "19:14-17", "#ffffff");
    dot(buf, "20:14-17", lip);
  } else if (r.mood === "calm") dot(buf, "19:14-17", bearded ? skin.blush : lip);
  else if (r.mood === "wow") {
    dot(buf, "18:15-16 19:14,17 20:15-16", bearded ? skin.blush : lip);
    dot(buf, "19:15-16", "#5a1f2a");
  } else dot(buf, "18:13,18 19:14-17", bearded ? skin.blush : lip);

  // shaved sides under a longer top
  if (shape.fade && r.extra !== "scarf")
    paint(
      buf,
      shape.fade,
      (x, y) => ((x + y) % 2 ? mixHex(skin.base, hairC, 0.55) : mixHex(skin.base, hairC, 0.75)),
      null,
    );

  // hair in front
  if (r.extra === "scarf") {
    // the scarf covers all the hair
  } else if (shape.front && !hatted) {
    if (shape.thin)
      paint(
        buf,
        shape.front,
        (x, y) => ((x + y) % 2 ? mixHex(skin.base, hairC, 0.55) : mixHex(skin.base, hairC, 0.75)),
        null,
      );
    else paint(buf, shape.front, hairFill(hairC, shape, shape.front), hairInk);
  } else if (shape.front && hatted && !shape.thin) {
    // under a hat only what falls at the sides shows
    const sides = new Set([...shape.front].filter((k) => Math.floor(k / N) >= 10));
    paint(buf, sides, hairFill(hairC, shape, sides), hairInk);
  }

  // glasses
  const frame = "#1b1b22";
  if (r.glasses === "round" || r.glasses === "gold") {
    dot(
      buf,
      "12:11-14,17-20 13:10,15,16,21 14:10,15,16,21 15:10,15,16,21 16:11-14,17-20 14:9,22",
      r.glasses === "gold" ? "#c9962a" : "#3b2f3a",
    );
  } else if (r.glasses === "square" || r.glasses === "tinted") {
    dot(
      buf,
      "12:10-21 13:10,15,16,21 14:10,15,16,21 15:10,15,16,21 16:10-21 14:9,22",
      r.glasses === "tinted" ? "#7a2740" : frame,
    );
  } else if (r.glasses === "shades") {
    dot(buf, "12:10-21 13:9-22 14:10-15,16-21 15:10-14,17-21 16:11-13,18-20", frame);
    dot(buf, "13:11-12,18-19 14:11,18", "#6d74a8");
  }

  // earrings and what goes on the head
  if (r.extra !== "headphones" && r.extra !== "scarf") {
    if (r.ear === "hoops") {
      dot(buf, "17:7-8,23-24 18:7,24 19:7-8,23-24", "#f4c531");
      dot(buf, "18:8,23", "#b8860b");
    } else if (r.ear === "studs") dot(buf, "17:8,23", "#f4c531");
    else if (r.ear === "pearls") dot(buf, "17:8,23", "#f6f5f1");
    else if (r.ear === "drops") {
      dot(buf, "17:8,23 18:8,23", "#f4c531");
      dot(buf, "19:8,23", "#4cd0c0");
    }
  }
  if (r.extra === "headband") {
    dot(buf, "6:9-22 7:8-23", clothHi);
    dot(buf, "7:8-23", cloth);
    dot(buf, "5:9-22 8:8-23", clothInk);
  } else if (r.extra === "bandana") {
    paint(
      buf,
      rows("7:8-23 8:8-23 8:24-25 9:24"),
      (x, y) => ((x * 3 + y) % 5 === 0 ? "#f6f5f1" : "#d6455d"),
      "#5a1525",
    );
  } else if (r.extra === "bow") {
    paint(
      buf,
      rows("3:18-19,23-24 4:18-24 5:18-24 6:18-19,23-24"),
      (x, _y) => (x === 21 || x === 22 ? "#b93a5e" : "#e8537a"),
      INK,
    );
  } else if (r.extra === "flower") {
    paint(
      buf,
      rows("3:20-21 4:19-22 5:19-22 6:20-21"),
      (x, y) => ((x === 20 || x === 21) && (y === 4 || y === 5) ? "#f4c531" : "#f6a6c1"),
      INK,
    );
  } else if (r.extra === "crown") {
    paint(
      buf,
      rows("1:10,13,15-16,18,21 2:10-11,13-18,20-21 3:10-21 4:10-21"),
      (x, y) =>
        y === 4 && (x === 12 || x === 15 || x === 16 || x === 19) ? "#d6455d" : y === 3 ? "#f4c531" : "#e0ac1c",
      "#6b4a08",
    );
  } else if (r.extra === "hat") {
    paint(
      buf,
      rows("1:11-20 2:10-21 3:10-21 4:10-21 5:10-21 6:10-21 7:5-26 8:5-26"),
      (_x, y) => (y === 5 || y === 6 ? clothLo : y >= 7 ? clothHi : cloth),
      clothInk,
    );
  } else if (r.extra === "scarf") {
    const m = minus(
      rows(
        "4:11-20 5:9-22 6:8-23 7:7-24 8:7-24 9:6-25 10:6-25 11:6-25 12:6-25 13:6-25 14:6-25 15:6-25 16:6-25 17:6-25 18:6-25 19:6-25 20:6-25 21:6-25 22:6-25 23:7-24 24:7-24 25:8-23 26:10-21",
      ),
      rows(
        "10:11-20 11:10-21 12:10-21 13:10-21 14:10-21 15:10-21 16:10-21 17:10-21 18:10-21 19:10-21 20:11-20 21:12-19",
      ),
    );
    paint(buf, m, (x, y) => (x <= 7 || x >= 24 || y >= 24 ? clothLo : y <= 6 && x <= 15 ? clothHi : cloth), clothInk);
  } else if (r.extra === "headphones") {
    const m = union(
      rows("2:11-20 3:9-22 4:7-9,22-24 5:6-7,24-25 6:6-7,24-25 7:6-7,24-25 8:6-7,24-25 9:6-7,24-25 10:6-7,24-25"),
    );
    paint(buf, m, "#3a3a44", INK);
    paint(
      buf,
      both(rows("11:5-8 12:5-8 13:5-8 14:5-8 15:5-8 16:5-8 17:5-8")),
      (x, y) => (x === 6 && y < 14 ? "#8c8c98" : "#55555f"),
      INK,
    );
  } else if (r.extra === "cap") {
    paint(
      buf,
      rows("3:11-20 4:9-22 5:8-23 6:8-23 7:8-23 8:8-23 9:8-23"),
      (x, y) => (y <= 4 && x < 15 ? clothHi : cloth),
      clothInk,
    );
    paint(buf, rows("9:8-27 10:10-27"), clothLo, clothInk);
    dot(buf, "9:8-23", clothLo);
  } else if (r.extra === "beanie") {
    paint(
      buf,
      rows("0:15-16 1:14-17 2:11-20 3:9-22 4:8-23 5:8-23 6:8-23 7:7-24 8:7-24 9:7-24 10:7-24"),
      (x, y) => (y <= 1 ? "#f6f5f1" : y >= 8 ? (x % 2 ? clothHi : cloth) : cloth),
      clothInk,
    );
  }
  return buf;
}

/** The background: the sky's dither in the chosen color, on the portrait's own grid. */
export function bgAt(color, x, y) {
  const tones = bodyTones(color);
  return tones[Math.min(4, toneAt(x, y, N) + 1)];
}

/** A color field's value as CSS (a color, or the background's gradient), for the builder's swatches; null for the rest. */
export function swatchOf(field, value) {
  if (field === "skin") return SKINS[value]?.base ?? null;
  if (field === "hairColor") return HAIR_COLORS[value] ?? null;
  if (field === "clothesColor") return CLOTHES_COLORS[value] ?? null;
  if (field === "eyes") return value in EYES ? (EYES[value] ?? "#231a22") : null;
  if (field === "bg" && AGENT_GRADIENTS[value]) return `linear-gradient(160deg, ${AGENT_GRADIENTS[value].join(", ")})`;
  return null;
}

/** The cells a size shows: small faces (up to 48 px) frame the face alone, 24 cells; larger ones the whole bust. */
export function cropFor(px) {
  return px <= 48 ? "face" : "full";
}

/**
 * Paints the portrait on a canvas, `px` device pixels wide: each cell is a
 * whole number of pixels (rounded up), so the canvas may come out a bit larger
 * than asked and whoever shows it scales it down. False where there is no 2D
 * context.
 */
export function renderPerson(canvas, recipe, { crop = "full", px = 256 } = {}) {
  const r = cleanRecipe(recipe);
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return false;
  const buf = drawPerson(r);
  const [x0, y0, n] = crop === "face" ? [4, 3, 24] : [0, 0, N];
  const cell = Math.max(1, Math.ceil(px / n));
  canvas.width = cell * n;
  canvas.height = cell * n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = buf[key(x + x0, y + y0)] ?? bgAt(r.bg, x + x0, y + y0);
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  return true;
}

/* ── recipes ── */
/** Every recipe field in the order the code writes them, with the values each takes. */
export const FIELDS = {
  build: BUILDS,
  skin: Object.keys(SKINS),
  hair: HAIRS,
  hairColor: Object.keys(HAIR_COLORS),
  beard: BEARDS,
  glasses: GLASSES,
  extra: EXTRAS,
  ear: EARS_LIST,
  neck: NECKS,
  lips: Object.keys(LIPS),
  shadow: Object.keys(SHADOWS),
  blush: BLUSHES,
  mark: MARKS,
  eyes: Object.keys(EYES),
  clothes: CLOTHES,
  clothesColor: Object.keys(CLOTHES_COLORS),
  mood: MOODS,
  bg: BGS,
};

/** A whole recipe: unknown fields are dropped and unknown values fall back to the default. */
export function cleanRecipe(recipe) {
  const out = {};
  for (const [field, values] of Object.entries(FIELDS)) {
    const v = recipe?.[field];
    out[field] = values.includes(v) ? v : DEFAULT[field];
  }
  return out;
}

/** The code kept with the photo: "1." and the values in `FIELDS` order ("1.f.s3.wavy.dark.…"). */
export function encodeRecipe(recipe) {
  const r = cleanRecipe(recipe);
  return `1.${Object.keys(FIELDS)
    .map((field) => r[field])
    .join(".")}`;
}

/** The recipe a code holds, or null when it is not one. Fields a newer code adds are ignored. */
export function decodeRecipe(code) {
  if (typeof code !== "string" || !code.startsWith("1.")) return null;
  const values = code.slice(2).split(".");
  const fields = Object.keys(FIELDS);
  if (values.length < fields.length) return null;
  return cleanRecipe(Object.fromEntries(fields.map((field, i) => [field, values[i]])));
}

/** What marks a photo as a drawn portrait: the fragment after the photo's address, which never reaches the server. */
export const PORTRAIT_MARK = "#px=";

/** The recipe of a photo address that carries one (`…/1a2b.png#px=1.f.s3.…`), else null. */
export function recipeOfUrl(url) {
  const at = typeof url === "string" ? url.indexOf(PORTRAIT_MARK) : -1;
  return at < 0 ? null : decodeRecipe(url.slice(at + PORTRAIT_MARK.length));
}

function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A portrait at random (the same one for the same `seed`), of the build asked for when one is given. */
export function randomPerson(seed = Math.random(), wanted) {
  const rnd = rng(seed);
  const pick = (list, weights) => {
    if (!weights) return list[Math.floor(rnd() * list.length)];
    let t = rnd() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) {
      t -= weights[i];
      if (t < 0) return list[i];
    }
    return list[0];
  };
  const drawn = pick(BUILDS);
  const build = wanted ?? drawn;
  const f = build === "f";
  //                    none buzz short side quiff curly afro bob bangs long wavy curls bun pony spiky mohawk braids pigtails
  const hair = pick(
    HAIRS,
    f
      ? [0.2, 0.3, 0.6, 0.8, 0.3, 2, 2, 4, 4, 5, 5, 4, 3, 3, 0.2, 0.2, 2, 1.2, 0, 0, 0, 0, 0, 0, 0.6, 1.5, 0]
      : [1.5, 3, 5, 4, 4, 3, 2, 0.4, 0.2, 0.6, 0.5, 0.5, 0.5, 0.6, 2, 0.5, 0.3, 0, 2, 3, 2, 1, 2, 0.8, 1, 1.5, 1],
  );
  return {
    build,
    skin: pick(Object.keys(SKINS)),
    hair,
    hairColor: pick(Object.keys(HAIR_COLORS), [5, 6, 6, 2, 4, 2, 1, 0.5, 0.5]),
    beard: f ? "none" : pick(BEARDS, [6, 2, 1, 1, 0.6, 3, 0.6]),
    glasses: pick(GLASSES, [8, 2, 2, 1, 0.5, 0.5]),
    //                     none headband bandana bow flower phones cap beanie hat crown scarf
    extra: pick(
      EXTRAS,
      f ? [9, 0.8, 0.4, 0.8, 0.8, 0.5, 0.4, 0.5, 0.4, 0.1, 0.6] : [10, 0, 0.4, 0, 0, 0.8, 1, 0.8, 0.5, 0.1, 0],
    ),
    ear: pick(EARS_LIST, f ? [4, 2, 2, 3, 1.5] : [12, 0.5, 0, 0.3, 0]),
    neck: pick(NECKS, f ? [8, 1.5, 1, 0.8, 0, 0.5] : [12, 0.5, 0, 0, 0.6, 0.5]),
    lips: f ? pick(Object.keys(LIPS), [3, 2, 2, 2, 1, 0.3, 0.2]) : "none",
    shadow: f ? pick(Object.keys(SHADOWS), [8, 1, 0.6, 0.6, 0.4, 0.4, 0.8]) : "none",
    blush: pick(BLUSHES, f ? [5, 2, 1] : [5, 0.3, 2]),
    mark: pick(MARKS, [10, 1.2, 0.8, 0.3, 0.2, 0.5]),
    eyes: pick(Object.keys(EYES), [5, 3, 1.5, 1, 0.8]),
    clothes: pick(CLOTHES, f ? [3, 3, 2, 2, 0, 3, 2, 2, 2, 1, 0, 3] : [4, 1.5, 1, 3, 2, 2, 2, 3, 1.5, 0, 2, 0]),
    clothesColor: pick(Object.keys(CLOTHES_COLORS), [4, 3, 3, 2, 2, 2, 2, 2, 1]),
    mood: pick(MOODS, [5, 4, 1.5, 1.5, 0.8, 0.4]),
    bg: pick(BGS),
  };
}

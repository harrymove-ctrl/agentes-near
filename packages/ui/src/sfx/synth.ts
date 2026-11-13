/**
 * The app's sounds, synthesized: oscillators, envelopes, filtered noise and a short room, computed sample by
 * sample. No audio file and no service (ADR 0070): the web plays the samples through Web Audio, the phone
 * app writes them to a WAV in its cache. Pure and deterministic (the noise is seeded), so every platform and
 * every render hear the same sound.
 */

export const SAMPLE_RATE = 44100;

/** The three looks a person picks from (Settings): wood, glass, soft 8-bit. `tactile` is the default. */
export const SOUND_STYLES = ["tactile", "sky", "pixel"] as const;
export type SoundStyle = (typeof SOUND_STYLES)[number];
export const DEFAULT_SOUND_STYLE: SoundStyle = "tactile";

export const SOUNDS = ["send", "reply", "done", "attention", "approved", "error", "stop", "mention"] as const;
export type SoundName = (typeof SOUNDS)[number];

export const isSoundStyle = (v: unknown): v is SoundStyle => (SOUND_STYLES as readonly unknown[]).includes(v);

const SR = SAMPLE_RATE;
/** E major pentatonic: any two of these sound fine together, so every melody stays friendly. */
const NOTE = {
  E3: 164.81,
  E4: 329.63,
  G4: 392.0,
  "G#4": 415.3,
  B4: 493.88,
  E5: 659.25,
  "G#5": 830.61,
  B5: 987.77,
  E6: 1318.51,
  "G#6": 1661.22,
  B6: 1975.53,
  E7: 2637.02,
} as const;
type Note = keyof typeof NOTE;

const add = (out: Float32Array, i: number, v: number) => {
  out[i] = (out[i] as number) + v;
};

function polyblep(t: number, dt: number) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

type Wave = "sine" | "pulse";
/** `pulse`: a band-limited 25 % pulse (the chip's voice). */
function wave(kind: Wave, p: number, dt: number) {
  if (kind === "sine") return Math.sin(2 * Math.PI * p);
  let v = p < 0.25 ? 1 : -1;
  v += polyblep(p, dt);
  v -= polyblep((p + 0.75) % 1, dt);
  return v;
}

/** Attack (linear), then an exponential fall to -60 dB over `d` seconds. */
const env = (t: number, a: number, d: number) => (t < 0 ? 0 : t < a ? t / a : Math.exp((-6.9 * (t - a)) / d));

type Partial = readonly [ratio: number, amp: number, decay: number];
const PURE: Partial[] = [[1, 1, 1]];

interface ToneOptions {
  t?: number;
  freq: number;
  d?: number;
  a?: number;
  g?: number;
  kind?: Wave;
  partials?: readonly Partial[];
  /** Starts at `from`×freq and slides to freq over `glide` seconds. */
  from?: number;
  glide?: number;
  /** A stepped envelope (the chip's volume register). */
  steps?: number;
}

function tone(out: Float32Array, o: ToneOptions) {
  const { t = 0, freq, d = 0.4, a = 0.003, g = 1, kind = "sine", partials = PURE, from = 1, glide = 0, steps = 0 } = o;
  const start = Math.floor(t * SR);
  const n = Math.ceil((a + d * 1.2) * SR);
  for (const [ratio, amp, dm] of partials) {
    let p = 0;
    for (let i = 0; i < n && start + i < out.length; i++) {
      const ti = i / SR;
      const k = glide ? Math.min(1, ti / glide) : 1;
      const dt = (freq * ratio * (from + (1 - from) * k)) / SR;
      p = (p + dt) % 1;
      let e = env(ti, a, d * dm);
      if (steps) e = Math.ceil(e * steps) / steps;
      add(out, start + i, wave(kind, p, dt) * e * amp * g);
    }
  }
}

type Filter = "lp" | "hp" | "bp";
/** A biquad (RBJ cookbook) in place. */
function biquad(x: Float32Array, type: Filter, fc: number, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * Math.min(fc, SR * 0.45)) / SR;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  const [b0, b1, b2] =
    type === "lp"
      ? [(1 - cs) / 2, 1 - cs, (1 - cs) / 2]
      : type === "hp"
        ? [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2]
        : [al, 0, -al];
  const a0 = 1 + al;
  const a1 = -2 * cs;
  const a2 = 1 - al;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] as number;
    const v = (b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = v;
    x[i] = v;
  }
  return x;
}

interface NoiseOptions {
  t?: number;
  d?: number;
  a?: number;
  g?: number;
  type?: Filter;
  fc?: number;
  q?: number;
  /** Sweeps the filter from `from`×fc to fc over `glide` seconds. */
  from?: number;
  glide?: number;
}

/** A filtered noise burst: air, a click, a mallet's hit. Seeded, so every render is the same. */
function noise(out: Float32Array, o: NoiseOptions) {
  const { t = 0, d = 0.05, a = 0.001, g = 0.3, type = "bp", fc = 2000, q = 1, from = 1, glide = 0 } = o;
  const start = Math.floor(t * SR);
  const n = Math.ceil((a + d * 1.2) * SR);
  const tmp = new Float32Array(n);
  let seed = 22222;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    tmp[i] = (seed / 2147483647) * 2 - 1;
  }
  if (glide) {
    // The sweep in short blocks.
    for (let b = 0; b < n; b += 256) {
      const k = Math.min(1, b / SR / glide);
      biquad(tmp.subarray(b, b + 256), type, fc * (from + (1 - from) * k), q);
    }
  } else biquad(tmp, type, fc, q);
  for (let i = 0; i < n && start + i < out.length; i++) add(out, start + i, (tmp[i] as number) * env(i / SR, a, d) * g);
}

/** A small Schroeder room (four damped combs, two all-passes), mixed under the dry sound. */
function reverb(x: Float32Array, mix: number, size: number, fb = 0.72) {
  const wet = new Float32Array(x.length);
  for (const s of [0.0297, 0.0371, 0.0411, 0.0437]) {
    const len = Math.round(s * SR * size);
    const b = new Float32Array(len);
    let k = 0;
    let lp = 0;
    for (let i = 0; i < x.length; i++) {
      const y = b[k] as number;
      lp = y * 0.55 + lp * 0.45;
      b[k] = (x[i] as number) + lp * fb;
      k = (k + 1) % len;
      add(wet, i, y / 4);
    }
  }
  for (const s of [0.005, 0.0017]) {
    const g = 0.7;
    const len = Math.round(s * SR);
    const b = new Float32Array(len);
    let k = 0;
    for (let i = 0; i < wet.length; i++) {
      const bo = b[k] as number;
      const y = -g * (wet[i] as number) + bo;
      b[k] = (wet[i] as number) + g * y;
      wet[i] = y;
      k = (k + 1) % len;
    }
  }
  for (let i = 0; i < x.length; i++) add(x, i, (wet[i] as number) * mix);
  return x;
}

/** The silent tail cut, the ends de-clicked, the peak set. */
function finish(x: Float32Array, peak: number) {
  let end = x.length;
  while (end > 1 && Math.abs(x[end - 1] as number) < 2e-4) end--;
  const y = x.slice(0, Math.min(x.length, end + Math.round(0.01 * SR)));
  let m = 0;
  for (const v of y) m = Math.max(m, Math.abs(v));
  const gain = (peak * 0.89) / (m || 1);
  const fadeIn = Math.round(0.001 * SR);
  const fadeOut = Math.round(0.012 * SR);
  for (let i = 0; i < y.length; i++) {
    let g = gain;
    if (i < fadeIn) g *= i / fadeIn;
    if (i > y.length - fadeOut) g *= (y.length - i) / fadeOut;
    y[i] = (y[i] as number) * g;
  }
  return y;
}

interface NoteOptions {
  d?: number;
  g?: number;
  from?: number;
  glide?: number;
}
type Voice = (out: Float32Array, t: number, note: Note, o?: NoteOptions) => void;

/** One note in each style. */
const VOICE: Record<SoundStyle, Voice> = {
  // Wood: a marimba bar (1 : 3.93 : 9.2) an octave down, dry, with the mallet's tick.
  tactile: (out, t, note, o = {}) => {
    const freq = NOTE[note] / 2;
    const g = o.g ?? 1;
    const partials: Partial[] = [
      [1, 1, 1],
      [3.93, 0.22, 0.3],
      [9.2, 0.05, 0.12],
    ];
    tone(out, { t, freq, d: (o.d ?? 0.5) * 0.45, a: 0.001, g, partials });
    noise(out, { t, d: 0.012, g: 0.25 * g, type: "bp", fc: freq * 4, q: 1.5 });
  },
  // Glass: near-harmonic partials that die fast; the room comes after (POST).
  sky: (out, t, note, o = {}) => {
    const partials: Partial[] = [
      [1, 1, 1],
      [2.0, 0.22, 0.55],
      [3.01, 0.07, 0.3],
      [4.18, 0.05, 0.2],
    ];
    tone(out, { t, freq: NOTE[note], d: o.d ?? 0.5, a: 0.004, g: o.g ?? 1, from: o.from, glide: o.glide, partials });
  },
  // Chip: a 25 % pulse with a stepped envelope, softened by the low-pass after.
  pixel: (out, t, note, o = {}) =>
    tone(out, {
      t,
      freq: NOTE[note],
      d: (o.d ?? 0.5) * 0.6,
      a: 0.001,
      g: (o.g ?? 1) * 0.5,
      kind: "pulse",
      steps: 12,
      from: o.from,
      glide: o.glide,
    }),
};

const POST: Record<SoundStyle, (x: Float32Array) => Float32Array> = {
  tactile: (x) => biquad(x, "lp", 7000),
  sky: (x) => reverb(biquad(x, "lp", 9000), 0.22, 1.1),
  pixel: (x) => biquad(x, "lp", 3600),
};

type Score = (out: Float32Array, v: Voice, style: SoundStyle) => void;

/** Each sound: its peak (how loud it is next to the others) and its notes; clicks differ per style. */
const SCORE: Record<SoundName, [peak: number, score: Score]> = {
  send: [
    0.55,
    (o, v, s) => {
      if (s === "tactile") {
        noise(o, { d: 0.018, g: 0.6, type: "bp", fc: 2600, q: 2.5 });
        v(o, 0.002, "E6", { d: 0.08, g: 0.35 });
      } else if (s === "sky") {
        noise(o, { d: 0.07, g: 0.18, type: "bp", fc: 5000, q: 0.8, from: 0.4, glide: 0.06 });
        v(o, 0.015, "E6", { d: 0.16, g: 0.45, from: 0.84, glide: 0.05 });
      } else {
        v(o, 0, "B5", { d: 0.06, g: 0.7 });
        v(o, 0.035, "E6", { d: 0.1, g: 0.7 });
      }
    },
  ],
  reply: [
    0.75,
    (o, v) => {
      v(o, 0, "G#5", { d: 0.32 });
      v(o, 0.075, "B5", { d: 0.45 });
    },
  ],
  done: [
    0.8,
    (o, v) => {
      v(o, 0, "E5", { d: 0.3, g: 0.8 });
      v(o, 0.07, "G#5", { d: 0.3, g: 0.8 });
      v(o, 0.14, "B5", { d: 0.35, g: 0.85 });
      v(o, 0.21, "E6", { d: 0.8 });
    },
  ],
  // Waits for the person (an approval, a question): the one meant to be noticed, so it says it twice.
  attention: [
    0.9,
    (o, v) => {
      v(o, 0, "E6", { d: 0.28 });
      v(o, 0.12, "B5", { d: 0.32 });
      v(o, 0.42, "E6", { d: 0.28, g: 0.7 });
      v(o, 0.54, "B5", { d: 0.45, g: 0.7 });
    },
  ],
  approved: [
    0.8,
    (o, v, s) => {
      if (s === "tactile") noise(o, { d: 0.015, g: 0.5, type: "bp", fc: 1800, q: 2 });
      else v(o, 0, "B6", { d: 0.05, g: 0.3 });
      for (const n of ["E5", "B5", "E6"] as const) v(o, 0.055, n, { d: 0.6, g: 0.55 });
    },
  ],
  error: [
    0.7,
    (o, v) => {
      v(o, 0, "B4", { d: 0.25 });
      v(o, 0.12, "G4", { d: 0.4 });
    },
  ],
  stop: [
    0.65,
    (o, v, s) => {
      if (s === "tactile") {
        noise(o, { d: 0.02, g: 0.5, type: "bp", fc: 900, q: 3 });
        v(o, 0, "E4", { d: 0.1, g: 0.8 });
      } else if (s === "sky") {
        tone(o, { freq: 190, from: 1.4, glide: 0.05, d: 0.09, g: 0.9 });
        noise(o, { d: 0.04, g: 0.15, type: "lp", fc: 1500 });
      } else {
        v(o, 0, "E4", { d: 0.06 });
        v(o, 0.04, "E3", { d: 0.12 });
      }
    },
  ],
  mention: [
    0.85,
    (o, v, s) => {
      const grace = s === "pixel" ? 0.03 : 0.045;
      v(o, 0, "E6", { d: 0.6 });
      v(o, grace, "G#6", { d: 0.25, g: 0.3 });
      v(o, grace * 2, "B6", { d: 0.3, g: 0.25 });
      if (s === "pixel") v(o, grace * 3, "E7", { d: 0.2, g: 0.2 });
    },
  ],
};

/** One sound's samples (mono, `SAMPLE_RATE`, peak under 0.9). */
export function renderSound(style: SoundStyle, name: SoundName): Float32Array {
  const [peak, score] = SCORE[name];
  const out = new Float32Array(Math.ceil(1.8 * SR));
  score(out, VOICE[style], style);
  return finish(POST[style](out), peak);
}

/** Samples as a 16-bit mono WAV file. */
export function wavBytes(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return bytes;
}

/**
 * The trackpad's lesson, a worklet: until the first touch ever, a pixel finger shows each gesture on the empty pad.
 * It only draws, on the pad and on the app's own cursor: nothing here ever reaches the agent's computer.
 */

export interface PadLesson {
  x: number;
  y: number;
  tailX: number;
  tailY: number;
  /** How far each of two fingers sits from their middle; 0 is one finger. */
  spread: number;
  on: number;
  ringX: number;
  ringY: number;
  /** A tap's ring, 0..1; -1 is none. */
  ringT: number;
  cursorX: number;
  cursorY: number;
  cursorScale: number;
}

export const LESSON_SECONDS = 9;
const TRAIL = 0.12;

const ease = (k: number) => {
  "worklet";
  return k * k * (3 - 2 * k);
};

const spotAt = (t: number, w: number, h: number) => {
  "worklet";
  if (t < 3.2) {
    const k = ease(Math.min(1, t / 2.6));
    return { x: w * 0.3 + w * 0.36 * k, y: h * 0.62 - h * 0.26 * Math.sin(k * Math.PI * 0.9), k, spread: 0 };
  }
  if (t < 5.4) return { x: w * 0.5, y: h * 0.5, k: 1, spread: 0 };
  const k = ease(Math.min(1, Math.max(0, (t - 5.6) / 2.6)));
  return { x: w * 0.5, y: h * 0.72 - h * 0.42 * k, k: 1 - k, spread: w * 0.06 };
};

export function padLesson(seconds: number, width: number, height: number): PadLesson {
  "worklet";
  const t = seconds % LESSON_SECONDS;
  const now = spotAt(t, width, height);
  const before = spotAt(Math.max(0, t - TRAIL), width, height);
  const tapping = t >= 3.2 && t < 5.2;
  const beat = tapping ? (t - 3.2) % 1 : 0;
  const press = tapping && beat < 0.18 ? Math.sin((Math.PI * beat) / 0.18) : 0;
  return {
    x: now.x,
    y: now.y,
    tailX: before.spread === now.spread ? before.x : now.x,
    tailY: before.spread === now.spread ? before.y : now.y,
    spread: now.spread,
    on: t > LESSON_SECONDS - 0.5 ? (LESSON_SECONDS - t) / 0.5 : Math.min(1, t / 0.3),
    ringX: width * 0.5,
    ringY: height * 0.5,
    ringT: tapping ? Math.min(1, beat / 0.6) : -1,
    cursorX: 80 * now.k,
    cursorY: -46 * Math.sin(now.k * Math.PI * 0.9),
    cursorScale: 1 - 0.16 * press,
  };
}

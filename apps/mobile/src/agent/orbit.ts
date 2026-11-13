import { type AgentColorName, bodyTones, mixHex } from "@agenteschat/ui/agent/engine";

/** The 3×3 ring the orbit walks, clockwise from the top-left. */
export const RING: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [2, 2],
  [1, 2],
  [0, 2],
  [0, 1],
];

/** Which ring cell leads at time `ms` (one step every 110 ms; 0 when still). */
export const orbitHead = (ms: number, still = false) => (still ? 0 : Math.floor(ms / 110) % 8);

/** Each ring cell's color and opacity for a head position, in the agent's body tones over `surface`. */
export function orbitCells(color: AgentColorName, surface: string, head: number) {
  const tn = bodyTones(color);
  const faint = mixHex(tn[tn.length - 1] ?? "#999999", surface, 0.55);
  return RING.map(([x, y], k) => {
    const age = (head - k + 8) % 8;
    const fill = age === 0 ? tn[0] : age === 1 ? tn[1] : age === 2 ? tn[2] : faint;
    return { x, y, color: fill ?? faint, opacity: age <= 2 ? 1 : 0.5 };
  });
}

/** The neutral orbit's ink opacities by age (head, trail, trail, rest): "enviando", "lê na próxima pausa". */
export const INK_ALPHAS = [1, 0.62, 0.38, 0.16] as const;

/** Each ring cell's ink opacity for a head position (the neutral orbit, no agent color). */
export const inkOrbitCells = (head: number) =>
  RING.map(([x, y], k) => {
    const age = Math.min(3, (head - k + 8) % 8);
    return { x, y, opacity: INK_ALPHAS[age] ?? 0.16 };
  });

/** The stop square's opacity: it breathes 1 → 0.6 → 1 every 1.6 s (solid when still). */
export const stopBreath = (ms: number, still = false) =>
  still ? 1 : 0.8 + 0.2 * Math.cos((2 * Math.PI * (ms % 1600)) / 1600);

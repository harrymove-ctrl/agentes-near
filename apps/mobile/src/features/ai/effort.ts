/** The effort ramp's math (worklets: they run on the UI thread during the drag). */

/** How far the fill reaches under a finger at `x`, in steps: never empty, since the lowest step is a choice too. */
export function effortReach(x: number, width: number, steps: number): number {
  "worklet";
  if (width <= 0) return 0.3;
  return Math.min(steps, Math.max(0.3, (x / width) * steps));
}

/** The step a reach lands on: the one the fill has entered. */
export function effortStep(reach: number, steps: number): number {
  "worklet";
  return Math.min(steps - 1, Math.max(0, Math.ceil(reach) - 1));
}

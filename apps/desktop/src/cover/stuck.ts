/**
 * The server answers but the page never painted (cover.rs): it loads again after the first wait, again with the
 * web cache cleared after the second, and after the third the cover says it didn't open. Never a blank window.
 */
export const STUCK_STEPS_MS = [12_000, 24_000, 36_000] as const;

export type StuckAction = "reload" | "fresh" | "say";

/**
 * What the cover does now, `waited` ms into a showing with `taken` steps already done; null: nothing new. One step
 * per check, in order: a check that comes late (the window was hidden) still loads again before it says anything.
 */
export function stuckAction(waited: number, taken: number): { step: number; action: StuckAction } | null {
  const due = STUCK_STEPS_MS.filter((ms) => waited > ms).length;
  if (due <= taken) return null;
  const step = taken + 1;
  return { step, action: step === 1 ? "reload" : step === 2 ? "fresh" : "say" };
}

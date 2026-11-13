/**
 * Organize on the phone (ADR 0135), pure: where a held widget lands as the finger carries it, the order that results,
 * and the small drawing of a size. The ones marked `worklet` also run on the UI thread, inside the drag.
 */

/** The place a row lands: where it started plus how far the finger went, one row per `step` (row and gap). */
export function dragTarget(start: number, offset: number, step: number, count: number): number {
  "worklet";
  if (count <= 0 || step <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(start + offset / step)));
}

/** `ids` with the one at `from` moved to `to`. */
export function moveIndex(ids: readonly string[], from: number, to: number): string[] {
  "worklet";
  const next = [...ids];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/**
 * A board's items with its widgets in the order of `ids`; the fixed tiles keep their places (the phone lists only the
 * widgets). An id that isn't a widget is skipped; a widget missing from `ids` keeps its turn after them.
 */
export function orderWidgets<T extends { id: string; type: "widget" | "tile" }>(
  items: readonly T[],
  ids: readonly string[],
): T[] {
  const widgets = items.filter((item) => item.type === "widget");
  const byId = new Map(widgets.map((w) => [w.id, w]));
  const queue = [...ids.flatMap((id) => byId.get(id) ?? []), ...widgets.filter((w) => !ids.includes(w.id))];
  let k = 0;
  return items.map((item) => (item.type === "widget" ? (queue[k++] ?? item) : item));
}

/** A size drawn on the phone's 2-column board: S half a row, M the whole row, L the whole row and twice as tall. */
export function footprint(size: "s" | "m" | "l"): { cols: 1 | 2; rows: 1 | 2 } {
  return size === "s" ? { cols: 1, rows: 1 } : size === "m" ? { cols: 2, rows: 1 } : { cols: 2, rows: 2 };
}

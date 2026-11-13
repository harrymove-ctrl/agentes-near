/**
 * Room every floating layer (menu, list, popover, hover card, tooltip) keeps from the viewport's edges: `--space-3`.
 * `.ac-popover, .ac-menu--dropdown` in `styles/components.css` cap their width at twice this.
 */
export const EDGE_ROOM = 12;

/** How far a tip (`Tip`) stands from the element it is about. */
export const TIP_GAP = 6;

/**
 * Where a tip goes in the window (`Tip`): `TIP_GAP` over its element, under it when the window has no room over it, its
 * start, middle or end on the element's, moved along only as far as it takes to stay `EDGE_ROOM` inside the window.
 */
export function placeTip(
  anchor: { left: number; top: number; right: number; bottom: number },
  tip: { width: number; height: number },
  align: "start" | "center" | "end",
  windowWidth: number,
) {
  const x =
    align === "start"
      ? anchor.left
      : align === "end"
        ? anchor.right - tip.width
        : (anchor.left + anchor.right - tip.width) / 2;
  const over = anchor.top - TIP_GAP - tip.height;
  return {
    left: Math.max(EDGE_ROOM, Math.min(x, windowWidth - EDGE_ROOM - tip.width)),
    top: over >= EDGE_ROOM ? over : anchor.bottom + TIP_GAP,
  };
}

/**
 * How far a popover moves over its trigger to show whole: a card taller than the room on its side (its height clamped to
 * that room, and still overflowing) gains what it lacks over `base`, the room it had before moving, up to the whole
 * window between the edges. 0 for one that fits, or that its own cap clamps (a menu's 280px scrolls where it is).
 * Measured from `base`, not from the room now: one that already moved but isn't placed again yet asks the same, not more.
 */
export function pullToFit(box: {
  scroll: number;
  client: number;
  height: number;
  room: number;
  base: number;
  window: number;
}) {
  if (box.scroll <= box.client || !(box.height >= box.room - 1)) return 0;
  const natural = box.scroll + box.height - box.client;
  return Math.max(0, Math.ceil(Math.min(natural - box.base, box.window - 2 * EDGE_ROOM - box.base)));
}

/**
 * Where a bar about selected text goes (the composer's formatting): `placeTip` centred over the selection, under it
 * when the window has no room over it (it never sits on the selected text), then kept inside its `column` (the
 * composer's own left and right). One wider than the column starts at the column's left.
 */
export function placeOverSelection(
  selection: { left: number; top: number; right: number; bottom: number },
  bar: { width: number; height: number },
  column: { left: number; right: number },
  windowWidth: number,
) {
  const at = placeTip(selection, bar, "center", windowWidth);
  return { left: Math.max(column.left, Math.min(at.left, column.right - bar.width)), top: at.top };
}

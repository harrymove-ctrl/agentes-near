/**
 * The presence badge in pixels (ADR 0084): a 9×9 shape in the agents' body (the cut corner bottom left), two tones
 * of dither like their bodies, a white mark (busy: a bar; away: a clock; out of office: an arrow out the door, §12),
 * an empty outline for offline and a dotted one for hidden, and a one-cell ring in the surface's color around it.
 * Pure data: the web draws it as SVG (`PresenceBadge`), the phone with react-native-svg.
 */

export type BadgePresence = "online" | "away" | "busy" | "out" | "offline" | "hidden";

/** What each cell is: the badge's tones, the white mark, or the surface behind (`ring`). */
export type BadgeTone = "base" | "light" | "deep" | "mark" | "ring";

export interface BadgeCell {
  x: number;
  y: number;
  tone: BadgeTone;
}

const SHAPE = [
  ".#######.",
  "#########",
  "#########",
  "#########",
  "#########",
  "#########",
  "#########",
  "#########",
  "########.",
];
const N = SHAPE.length;
const MARKS: Partial<Record<BadgePresence, readonly (readonly [number, number])[]>> = {
  busy: [
    [4, 2],
    [4, 3],
    [4, 4],
    [4, 5],
    [4, 6],
  ],
  away: [
    [2, 4],
    [3, 4],
    [4, 4],
    [4, 5],
    [4, 6],
  ],
  out: [
    [3, 5],
    [4, 2],
    [4, 3],
    [4, 4],
    [4, 5],
    [4, 6],
    [5, 5],
  ],
};

const inShape = (r: number, c: number) => SHAPE[r]?.[c] === "#";
const onEdge = (r: number, c: number) =>
  inShape(r, c) &&
  [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].some(([a, b]) => !inShape(r + (a ?? 0), c + (b ?? 0)));

/** The cells of a badge, `ring` adding a one-cell border; `size` is the side in cells (9, or 11 with the ring). */
export function badgeCells(presence: BadgePresence, ring = true): { size: number; cells: BadgeCell[] } {
  const o = ring ? 1 : 0;
  const hollow = presence === "offline" || presence === "hidden";
  const marks = new Set((MARKS[presence] ?? []).map(([r, c]) => `${r},${c}`));
  const cells: BadgeCell[] = [];
  for (let r = -o; r < N + o; r++) {
    for (let c = -o; c < N + o; c++) {
      const at = { x: c + o, y: r + o };
      if (!inShape(r, c)) {
        const touches = [-1, 0, 1].some((a) => [-1, 0, 1].some((b) => inShape(r + a, c + b)));
        if (ring && touches) cells.push({ ...at, tone: "ring" });
        continue;
      }
      if ((hollow && !onEdge(r, c)) || (presence === "hidden" && (r + c) % 2 === 1)) {
        if (ring) cells.push({ ...at, tone: "ring" });
        continue;
      }
      if (marks.has(`${r},${c}`)) {
        cells.push({ ...at, tone: "mark" });
        continue;
      }
      // Light at the top left, deep at the bottom right, like the agents' dither.
      const tone = (r + c) % 2 === 0 && r + c <= 5 ? "light" : (r + c) % 2 === 1 && r + c >= 11 ? "deep" : "base";
      cells.push({ ...at, tone });
    }
  }
  return { size: N + 2 * o, cells };
}

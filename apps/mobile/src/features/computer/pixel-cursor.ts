/*
 * The person's pointer on the agent's screen (ADR 0098): a pixel arrow, in the brand's dither. Its tip, the first cell,
 * is where a click lands. Rows of cells: `#` the light rim, `.` the body, a space nothing.
 */
const ROWS = [
  "#",
  "##",
  "#.#",
  "#..#",
  "#...#",
  "#....#",
  "#.....#",
  "#......#",
  "#.......#",
  "#........#",
  "#.....#####",
  "#..#..#",
  "#.##..#",
  "##  #..#",
  "    #..#",
  "     ##",
];

/** The same 4×4 Bayer matrix as the sky: the body fades through it, top to bottom. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export const CURSOR_CELLS = { width: 13, height: 18 } as const;

export type CursorCell = { x: number; y: number; tone: "rim" | "body" | "light" };

/** Every cell of the arrow, and which of its three colors it takes. */
export function cursorCells(): CursorCell[] {
  return ROWS.flatMap((row, y) =>
    [...row].flatMap((cell, x): CursorCell[] => {
      if (cell === " ") return [];
      if (cell === "#") return [{ x, y, tone: "rim" }];
      const shade = (BAYER[y % 4]?.[x % 4] ?? 0) + 0.5;
      return [{ x, y, tone: y / (ROWS.length - 1) > shade / 16 ? "body" : "light" }];
    }),
  );
}

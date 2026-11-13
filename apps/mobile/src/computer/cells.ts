import {
  COMPUTER_GRID,
  type ComputerKind,
  type ComputerState,
  drawComputer,
  type PortraitKind,
} from "@agenteschat/ui/computer/portrait";

/**
 * A computer portrait (the shared engine, `@agenteschat/ui/computer/portrait`) recorded as pixel cells so
 * a Skia canvas can replay it (./ComputerPortrait.tsx). Pure TypeScript: no React Native, no Skia, so it
 * runs in `bun test`.
 *
 * The engine paints 1×1 cells on a 48×48 grid, some of them translucent over others (the paused screen,
 * the shadow). Each cell keeps its stack of colors (an opaque color starts it over, `clearRect` empties
 * it); the frame comes out as layers, every layer one rectangle list per color, so the replay draws one
 * path per tone and still blends in the canvas's order.
 */

/** `PortraitKind`: a computer, or a phone a computer reaches (the same engine draws both). */
export type { ComputerKind, ComputerState, PortraitKind };

/** One layer's cells of one color: flat [x, y, x, y, …] on the 48 grid. */
export interface CellRun {
  color: string;
  cells: number[];
}

const N = COMPUTER_GRID;
const opaque = (color: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color);

/** The 2D context subset the portrait engine uses (`fillStyle`, `fillRect`, `clearRect`), as cell stacks. */
export class CellRecorder {
  fillStyle: unknown = "#000000";
  readonly stacks: (string[] | undefined)[] = new Array(N * N);

  fillRect(x: number, y: number, w: number, h: number) {
    const color = typeof this.fillStyle === "string" ? this.fillStyle : "#000000";
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(N, y + h); j++)
      for (let i = Math.max(0, Math.floor(x)); i < Math.min(N, x + w); i++) {
        const k = j * N + i;
        const stack = this.stacks[k];
        if (!stack || opaque(color)) this.stacks[k] = [color];
        else stack.push(color);
      }
  }

  clearRect(x: number, y: number, w: number, h: number) {
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(N, y + h); j++)
      for (let i = Math.max(0, Math.floor(x)); i < Math.min(N, x + w); i++) this.stacks[j * N + i] = undefined;
  }

  /** Layer by layer (bottom first), one run per color in first-seen order. */
  runs(): CellRun[] {
    const out: CellRun[] = [];
    for (let layer = 0; ; layer++) {
      const byColor = new Map<string, number[]>();
      for (let k = 0; k < this.stacks.length; k++) {
        const color = this.stacks[k]?.[layer];
        if (!color) continue;
        let list = byColor.get(color);
        if (!list) {
          list = [];
          byColor.set(color, list);
        }
        list.push(k % N, Math.floor(k / N));
      }
      if (!byColor.size) return out;
      for (const [color, cells] of byColor) out.push({ color, cells });
    }
  }
}

/** One frame of a computer's portrait as cell runs. `t` in seconds (0 or a fixed time: a still frame). */
export function portraitFrame(kind: PortraitKind, state: ComputerState, dark: boolean, t: number): CellRun[] {
  const rec = new CellRecorder();
  drawComputer(rec, kind, state, { dark, t });
  return rec.runs();
}

/** Cells → one SVG path of unit squares (Skia builds one path per run). */
export function cellsToSvg(cells: readonly number[]): string {
  let d = "";
  for (let i = 0; i + 1 < cells.length; i += 2) d += `M${cells[i]} ${cells[i + 1]}h1v1h-1Z`;
  return d;
}

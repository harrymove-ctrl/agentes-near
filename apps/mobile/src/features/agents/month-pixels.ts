import { type AgentColorName, bodyTones, mixHex } from "@agenteschat/ui/agent/engine";
import { CellGrid, type CellRun, column } from "../browser/trail-pixels";

/**
 * The agent's month in pixels on its profile, the web's drawing (`MonthRuns` in `@agenteschat/ui`
 * `RunPixels.tsx`, the agent page's Atividade tab) as cell lists a Skia canvas replays: a dithered column per
 * day in the agent's tones, as tall as that day's runs over the busiest day's; a day with a failure wears a cap
 * in the danger tone; a day without runs, and every day to come, is a dot on the line. Lower than the web's
 * (a line under the section's count, not a chart of its own). Pure TypeScript, so it runs in `bun test`.
 */

/** Points per cell (the web's 2 px cells). */
export const MONTH_CELL = 2;
/** The picture's height in cells. */
export const MONTH_ROWS = 20;

/** A day of the month with runs (`runsByDay` of the agent's detail). */
export interface MonthDay {
  day: number;
  runs: number;
  failed: number;
}

/** The month as the server counts it (UTC, like its days): how many days, and which one is today. */
export function monthNow(now: Date): { days: number; today: number } {
  return {
    days: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate(),
    today: now.getUTCDate(),
  };
}

/** The picture's width in cells for a box `width` points wide: at least three cells a day. */
export const monthWidth = (width: number, days: number) => Math.max(days * 3, Math.round(width / MONTH_CELL));

/** The surface, the danger tone and the dots' tone, as six-digit hex (the mixer reads six digits). */
export interface MonthTones {
  raised: string;
  danger: string;
  dot: string;
}

export function monthCells(
  w: number,
  days: number,
  today: number,
  perDay: readonly MonthDay[],
  color: AgentColorName,
  tones: MonthTones,
): CellRun[] {
  const t = bodyTones(color);
  const at = (i: number) => t[i] ?? "#888888";
  const ok = [at(1), at(1), at(2), at(3)];
  const failed = [tones.danger, tones.danger, mixHex(tones.danger, tones.raised, 0.45)];
  const byDay = new Map(perDay.map((d) => [d.day, d]));
  const max = Math.max(1, ...perDay.map((d) => d.runs));
  const slot = w / days;
  const colW = Math.max(2, Math.floor(slot * 0.62));
  const base = MONTH_ROWS - 1;
  const out = new CellGrid();
  for (let d = 1; d <= days; d++) {
    const x0 = Math.round((d - 1) * slot + (slot - colW) / 2);
    const day = byDay.get(d);
    if (d > today || !day || day.runs === 0) {
      out.put(x0 + Math.floor(colW / 2), base, tones.dot);
      continue;
    }
    const h = Math.max(2, Math.round((day.runs / max) * (MONTH_ROWS - 5)));
    column(out, x0, colW, h, base, ok);
    if (day.failed > 0) column(out, x0, colW, 2, base - h - 1, failed);
  }
  return out.runs();
}

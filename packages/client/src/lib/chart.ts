/**
 * Charts in messages: an agent writes a ```chart block with a
 * small JSON of data; the web and the phone app draw it. This is the shared half: reading and checking the
 * block (data only, never code: anything off and the block shows as plain code), formatting values, and the
 * same data as a table (the card's "Tabela" and the full screen).
 */

export type ChartType = "bar" | "line" | "pie" | "number";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  subtitle?: string;
  /** "%", "R$", "$", "€" or a short suffix ("ms", "h"). */
  unit?: string;
  labels: string[];
  series: ChartSeries[];
  /** `number`: the big value and a line under it ("+0,8 pp vs semana anterior"). */
  value?: number;
  delta?: string;
}

/** Points per chart: past this, the data belongs in a Drive table. */
export const CHART_MAX_POINTS = 24;
const MAX_SERIES = 3;
const TYPES: readonly ChartType[] = ["bar", "line", "pie", "number"];

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : null;

/** The block's JSON as a chart, or null when it isn't one we can draw honestly. */
export function parseChart(source: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const type = (o.type === "kpi" ? "number" : o.type) as ChartType;
  if (!TYPES.includes(type)) return null;
  const title = text(o.title, 120);
  if (!title) return null;
  const labels = Array.isArray(o.labels) ? o.labels.map((l) => text(l, 60)) : [];
  if (labels.some((l) => l === null) || labels.length > CHART_MAX_POINTS) return null;
  const series: ChartSeries[] = [];
  for (const s of Array.isArray(o.series) ? o.series : []) {
    if (!s || typeof s !== "object") return null;
    const values = (s as { values?: unknown }).values;
    if (!Array.isArray(values) || values.length !== labels.length) return null;
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
    series.push({ name: text((s as { name?: unknown }).name, 40) ?? "", values: values as number[] });
  }
  if (series.length > MAX_SERIES) return null;
  const spec: ChartSpec = { type, title, labels: labels as string[], series };
  const subtitle = text(o.subtitle, 160);
  if (subtitle) spec.subtitle = subtitle;
  const unit = text(o.unit, 8);
  if (unit) spec.unit = unit;
  if (type === "number") {
    if (typeof o.value !== "number" || !Number.isFinite(o.value)) return null;
    spec.value = o.value;
    const delta = text(o.delta, 60);
    if (delta) spec.delta = delta;
    return spec;
  }
  if (labels.length < 2 || series.length === 0) return null;
  if (type === "pie") {
    const values = series[0]?.values ?? [];
    if (series.length !== 1 || values.some((v) => v < 0) || values.reduce((a, b) => a + b, 0) <= 0) return null;
  }
  return spec;
}

const PREFIX = new Set(["R$", "US$", "$", "€", "£"]);

/** 15 → "15%", 1200 → "R$ 1.200", 6.7 → "6,7%" (pt-BR), 120 with "ms" → "120 ms". */
export function formatChartValue(value: number, unit: string | undefined, locale: string): string {
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1 }).format(value);
  if (!unit) return n;
  if (unit === "%") return `${n}%`;
  return PREFIX.has(unit) ? `${unit} ${n}` : `${n} ${unit}`;
}

/** The pie's shares, 0..1, in order. */
export function chartShares(spec: ChartSpec): number[] {
  const values = spec.series[0]?.values ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  return values.map((v) => (total > 0 ? v / total : 0));
}

/** The same data as a table: the labels, then one column per series (and the share, for a pie). */
export function chartTable(
  spec: ChartSpec,
  locale: string,
  words: { item: string; share: string },
): { header: string[]; rows: string[][] } {
  const header = [words.item, ...spec.series.map((s) => s.name || words.item)];
  const shares = spec.type === "pie" ? chartShares(spec) : null;
  if (shares) header.push(words.share);
  const rows = spec.labels.map((label, i) => {
    const row = [label, ...spec.series.map((s) => formatChartValue(s.values[i] ?? 0, spec.unit, locale))];
    if (shares) row.push(formatChartValue(Math.round((shares[i] ?? 0) * 1000) / 10, "%", locale));
    return row;
  });
  return { header, rows };
}

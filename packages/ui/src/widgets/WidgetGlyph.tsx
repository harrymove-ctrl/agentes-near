import type { ReactNode } from "react";
import type { WidgetKind } from "./spec";

/** Each format's small drawing (28×24), in `currentColor`. */
const GLYPHS: Record<WidgetKind | "auto", ReactNode> = {
  auto: (
    <path
      d="M14 3v4M14 17v4M5 12h4M19 12h4M8 6l2 2M18 16l2 2M8 18l2-2M18 8l2-2"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  ),
  kpi: (
    <text
      x="14"
      y="17"
      textAnchor="middle"
      fontSize="13"
      fontWeight="700"
      fill="currentColor"
      style={{ fontFamily: "var(--font-sans)", fontVariantNumeric: "tabular-nums" }}
    >
      42
    </text>
  ),
  line: (
    <path
      d="M3 18l6-6 5 3 9-9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  bars: <path d="M5 20V12M11 20V6M17 20V10M23 20V15" stroke="currentColor" strokeWidth="3.2" />,
  list: (
    <path
      d="M4 7h3M10 7h14M4 12h3M10 12h14M4 17h3M10 17h10"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  ),
  text: <path d="M4 7h20M4 12h20M4 17h13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  goal: (
    <>
      <rect x="3" y="9" width="22" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="5" y="11" width="11" height="3" fill="currentColor" />
    </>
  ),
};

/**
 * The small drawing of a widget's format (ADR 0135), for the format chips and lists: a number, a line, bars, a list,
 * a summary, a goal, or "auto". Decorative: the chip's word names it.
 */
export function WidgetGlyph({ kind, size = 28 }: { kind: WidgetKind | "auto"; size?: number }) {
  return (
    <svg
      className="ac-wglyph"
      viewBox="0 0 28 24"
      width={size}
      height={Math.round((size * 24) / 28)}
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[kind] ?? GLYPHS.auto}
    </svg>
  );
}

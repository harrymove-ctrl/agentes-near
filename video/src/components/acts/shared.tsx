import React from "react";

export const ANTON = '"Anton", Impact, sans-serif';
export const INTER_TIGHT = '"Inter Tight", -apple-system, BlinkMacSystemFont, sans-serif';
export const SERIF_ITALIC = '"Instrument Serif", Georgia, serif';
export const MONO = '"Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
export const BRAND = '"Funnel Display", "Inter Tight", sans-serif';
export const DOTO = '"Doto", "Commit Mono", monospace';

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function quartOut(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 4);
}

export function expoOut(t: number): number {
  const x = clamp01(t);
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
}

export function backOut(t: number): number {
  const x = clamp01(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function segProgress(t: number, start: number, dur: number, ease = quartOut): number {
  if (dur <= 0) return t >= start ? 1 : 0;
  return ease(clamp01((t - start) / dur));
}

export const CursorArrow: React.FC<{
  x: number;
  y: number;
  label?: string;
  color?: string;
  scale?: number;
}> = ({ x, y, label, color = "#141414", scale = 1 }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      transform: `scale(${scale})`,
      transformOrigin: "top left",
      pointerEvents: "none",
      zIndex: 80,
      display: "flex",
      alignItems: "flex-start",
      gap: 6,
    }}
  >
    <svg width="30" height="34" viewBox="0 0 28 32" fill="none">
      <path
        d="M3 2L24 16.5L13.5 18.5L19.5 28L15.5 30L9.5 20.5L3 26V2Z"
        fill={color}
        stroke="#FFFFFF"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
    </svg>
    {label ? (
      <span
        style={{
          marginTop: 18,
          padding: "4px 10px",
          borderRadius: 999,
          backgroundColor: color,
          color: "#FFFFFF",
          fontFamily: INTER_TIGHT,
          fontSize: 13,
          fontWeight: 700,
          boxShadow: "0 6px 16px rgba(0,0,0,0.22)",
        }}
      >
        {label}
      </span>
    ) : null}
  </div>
);

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../sky/engine";

/** Units a number takes before it, as the chat's charts write them ("$18,420"). */
const PREFIX_UNITS = new Set(["R$", "US$", "$", "€", "£"]);

/** Fraction digits a widget's number shows: none from 1000 up, one from 10, two below. */
export const widgetDigits = (value: number) => {
  const a = Math.abs(value);
  return Number.isInteger(value) || a >= 1000 ? 0 : a >= 10 ? 1 : 2;
};

const formats = new Map<string, Intl.NumberFormat>();

/** A widget's number in the reader's language: "18.420", "3,9" (pt-BR), "18,420", "3.9" (en). */
export function formatWidgetNumber(value: number, locale: string, digits = widgetDigits(value)): string {
  const key = `${locale}|${digits}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    } catch {
      f = new Intl.NumberFormat("en", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
    }
    formats.set(key, f);
  }
  return f.format(value);
}

/** A value with its unit, as a bar's label reads: "$41", "41%", "41 ms". */
export function formatWithUnit(value: number, unit: string | undefined, locale: string): string {
  const n = formatWidgetNumber(value, locale);
  if (!unit) return n;
  if (PREFIX_UNITS.has(unit)) return `${unit} ${n}`;
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
}

const COUNT_MS = 800;

/**
 * The number shown while a new value counts up from the one before (an update's data arriving): eased out over
 * 0.8 s, at once with reduced motion. The first value shows as it is.
 */
export function useCountUp(value: number): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value) return;
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / COUNT_MS);
      setShown(start + (value - start) * (1 - (1 - k) ** 3));
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      setShown(value);
    };
  }, [value]);
  return shown;
}

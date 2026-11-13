import { useEffect, useRef } from "react";
import { useDarkTheme } from "../hooks/useDarkTheme";
import { Icon } from "../icons/Icon";
import { prefersReducedMotion } from "../sky/engine";
import { bayerAt, parseColor } from "../sky/math";
import { DitherLine } from "./ChartPieces";
import { formatWidgetNumber, formatWithUnit, useCountUp, widgetDigits } from "./format";
import type {
  BarsWidgetSpec,
  GoalWidgetSpec,
  KpiWidgetSpec,
  LineWidgetSpec,
  ListWidgetSpec,
  TextWidgetSpec,
  WidgetSpec,
  WidgetStatus,
} from "./spec";
import { WIDGET_CELL, widgetTones } from "./tiles";

export interface WidgetBodyProps {
  spec: WidgetSpec | null;
  status: WidgetStatus;
  /** The agent who looks after it: its color, as `AgentAvatar` takes it. */
  color: string;
  size: { w: 1 | 2; h: 1 | 2 };
  /** The reader's language, for numbers. */
  locale: string;
  /** While it is built: "Theo is building the widget and the routine that will update it…". */
  buildingText?: string;
  /** A number's trend line is drawn by the card, edge to edge at its bottom (`WidgetBleed`), not in the body. */
  sparkApart?: boolean;
}

/**
 * What a widget draws (ADR 0135), by kind: one big number with how it moved and its trend, a goal's progress, bars,
 * a line, a short list, a few sentences. Charts in the chat's style (a clean stroke over a 2px dither in the agent's
 * tones); numbers in the app's font, bold, tabular. Being built, the agent's dither moves under the words. A note
 * keeps to two lines and ends in an ellipsis past them (`wk-clamp`), never cut inside a word.
 */
export function WidgetBody({ spec, status, color, size, locale, buildingText, sparkApart = false }: WidgetBodyProps) {
  if (status === "building" || !spec) {
    return (
      <div className="wk-build">
        <BuildingDither color={color} still={status !== "building"} />
        {buildingText && <p>{buildingText}</p>}
      </div>
    );
  }
  switch (spec.kind) {
    case "kpi":
      return <KpiBody spec={spec} color={color} locale={locale} spark={!sparkApart} />;
    case "goal":
      return <GoalBody spec={spec} locale={locale} />;
    case "bars":
      return <BarsBody spec={spec} size={size} locale={locale} />;
    case "line":
      return <LineBody spec={spec} color={color} size={size} locale={locale} />;
    case "list":
      return <ListBody spec={spec} />;
    case "text":
      return <TextBody spec={spec} />;
  }
}

function KpiBody({
  spec,
  color,
  locale,
  spark,
}: {
  spec: KpiWidgetSpec;
  color: string;
  locale: string;
  spark: boolean;
}) {
  const shown = useCountUp(spec.value);
  return (
    <>
      <div className="wk-num" data-value={spec.value}>
        {spec.prefix && <small className="wk-num__pre">{spec.prefix}</small>}
        <span>{formatWidgetNumber(shown, locale, widgetDigits(spec.value))}</span>
        {spec.suffix && <small className="wk-num__suf">{spec.suffix}</small>}
      </div>
      {(spec.delta || spec.note) && (
        <div className="wk-sub wk-clamp">
          {spec.delta && <b className={spec.delta.up ? "wk-up" : "wk-down"}>{spec.delta.text}</b>}
          {spec.delta && spec.note ? " " : null}
          {spec.note}
        </div>
      )}
      {spark && spec.spark && spec.spark.length > 1 && (
        <DitherLine className="wk-spark" values={spec.spark} color={color} height={40} bleed dot />
      )}
    </>
  );
}

function GoalBody({ spec, locale }: { spec: GoalWidgetSpec; locale: string }) {
  const pct = Math.max(0, Math.min(100, spec.pct));
  const shown = useCountUp(pct);
  return (
    <>
      <div className="wk-num">
        <span>{formatWidgetNumber(shown, locale, 0)}</span>
        <small className="wk-num__pct">%</small>
      </div>
      <div className="wk-goal__track">
        <div className="wk-goal__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="wk-sub">
        {spec.line}
        {spec.note && <span className="wk-sub__note wk-clamp">{spec.note}</span>}
      </div>
    </>
  );
}

function BarsBody({ spec, size, locale }: { spec: BarsWidgetSpec; size: { w: 1 | 2; h: 1 | 2 }; locale: string }) {
  const max = Math.max(0, ...spec.values) || 1;
  // A narrow widget keeps its bars readable: the first ones that fit.
  const room = size.w === 1 ? 5 : 12;
  const labels = spec.labels.slice(0, room);
  return (
    <>
      {spec.unit && <div className="wk-cap">{spec.unit}</div>}
      <div className="wk-bars">
        {labels.map((label, i) => {
          const value = spec.values[i] ?? 0;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: the bars of one widget, in order
              key={i}
              className="wk-bar"
              data-alert={i === spec.alertIndex || undefined}
              title={`${label}: ${formatWithUnit(value, spec.unit, locale)}`}
            >
              {/* Only the number: the unit is the tag above the bars, said once. */}
              <span className="wk-bar__v">{formatWidgetNumber(value, locale)}</span>
              <span className="wk-bar__b" style={{ height: `${Math.max(4, (Math.max(0, value) / max) * 100)}%` }} />
            </div>
          );
        })}
      </div>
      <div className="wk-axis">
        {labels.map((label, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the labels, in order
          <span key={i}>{label}</span>
        ))}
      </div>
      {spec.note && <p className="wk-note wk-clamp">{spec.note}</p>}
    </>
  );
}

function LineBody({
  spec,
  color,
  size,
  locale,
}: {
  spec: LineWidgetSpec;
  color: string;
  size: { w: 1 | 2; h: 1 | 2 };
  locale: string;
}) {
  const last = spec.values[spec.values.length - 1];
  // Seven labels at most under the line: the first, the last and evenly between.
  const step = Math.max(1, Math.ceil(spec.labels.length / 7));
  return (
    <>
      {spec.unit && <div className="wk-cap">{spec.unit}</div>}
      <DitherLine className="wk-line" values={spec.values} color={color} height={size.h === 2 ? 210 : 96} dot />
      <div className="wk-axis wk-axis--line">
        {spec.labels.map((label, i) =>
          i % step === 0 || i === spec.labels.length - 1 ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the labels, in order
            <span key={i}>{label}</span>
          ) : null,
        )}
      </div>
      {spec.note ? (
        <p className="wk-note wk-clamp">{spec.note}</p>
      ) : last !== undefined ? (
        <div className="wk-sub">{formatWithUnit(last, spec.unit, locale)}</div>
      ) : null}
    </>
  );
}

function ListBody({ spec }: { spec: ListWidgetSpec }) {
  return (
    <ul className="wk-list">
      {spec.rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows, in order
        <li key={i}>
          <Icon name={row.tone === "warn" ? "alert" : row.tone === "ok" ? "check" : "document"} size={16} />
          <span className="wk-list__t">{row.text}</span>
          {row.meta && (
            <span className="wk-list__s" data-tone={row.tone}>
              {row.meta}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function TextBody({ spec }: { spec: TextWidgetSpec }) {
  return (
    <ul className="wk-text">
      {spec.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the sentences, in order
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * A widget being built: the agent's dither with a wave walking across it (one frame, still, with reduced motion or
 * when nothing is being built).
 */
export function BuildingDither({ color, still = false }: { color: string; still?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dark = useDarkTheme();
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const [r, g, b] = parseColor(widgetTones(color, dark).fill);
    const draw = (t: number) => {
      const cols = Math.max(1, Math.round((el.clientWidth || 240) / WIDGET_CELL));
      const rows = Math.max(1, Math.round((el.clientHeight || 64) / WIDGET_CELL));
      if (el.width !== cols || el.height !== rows) {
        el.width = cols;
        el.height = rows;
      }
      const img = ctx.createImageData(cols, rows);
      const phase = (t / 1400) % 1;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const u = x / cols;
          const near = Math.max(0, 0.55 - Math.abs(u - phase) * 2.2);
          const v = 0.12 + near + 0.08 * Math.sin(u * 12 + y * 0.6 + t / 400);
          if (v <= bayerAt(x, y)) continue;
          const i = (y * cols + x) * 4;
          img.data[i] = r;
          img.data[i + 1] = g;
          img.data[i + 2] = b;
          img.data[i + 3] = 255;
        }
      ctx.putImageData(img, 0, 0);
    };
    if (still || prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      draw(700);
      return;
    }
    // About 20 frames a second: a slow wave, a light load beside a board of live widgets.
    let frame = 0;
    let drawn = -Infinity;
    const tick = (t: number) => {
      if (t - drawn >= 50) {
        draw(t);
        drawn = t;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [color, dark, still]);
  return <canvas ref={canvas} className="wk-build__dither" />;
}

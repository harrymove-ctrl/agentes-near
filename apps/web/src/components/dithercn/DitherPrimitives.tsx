import type React from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  bayerThreshold,
  DITHER_TONE_HEX,
  type DitherColorTone,
} from "./DitherEngine";

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* 1. DitherCard                                                              */
/* -------------------------------------------------------------------------- */

export interface DitherCardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: DitherColorTone;
  glow?: boolean;
  interactive?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

export function DitherCard({
  tone = "blue",
  glow = true,
  interactive = true,
  padding = "md",
  header,
  footer,
  className,
  style,
  children,
  onPointerMove,
  ...rest
}: DitherCardProps) {
  const [spot, setSpot] = useState({ x: "85%", y: "14%" });

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (interactive) {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const px = Math.round(((e.clientX - rect.left) / rect.width) * 100);
        const py = Math.round(((e.clientY - rect.top) / rect.height) * 100);
        setSpot({ x: `${px}%`, y: `${py}%` });
      }
    }
    onPointerMove?.(e);
  };

  return (
    <div
      className={joinClasses("dcn-card", className)}
      data-tone={tone}
      data-pad={padding}
      data-interactive={interactive ? "true" : "false"}
      style={
        {
          "--spot-x": spot.x,
          "--spot-y": spot.y,
          ...style,
        } as React.CSSProperties
      }
      onPointerMove={handlePointerMove}
      {...rest}
    >
      {glow && <div className="dcn-card__spotlight" aria-hidden="true" />}
      <div className="dcn-card__rim" aria-hidden="true" />
      <div className="dcn-card__inner">
        {header && <div className="dcn-card__head">{header}</div>}
        {children}
        {footer && <div className="dcn-card__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. BenchoRollingCounter                                                    */
/* -------------------------------------------------------------------------- */

export interface BenchoRollingCounterProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  className?: string;
}

export function BenchoRollingCounter({
  value,
  prefix = "",
  suffix = "",
  decimals = 0,
  className,
}: BenchoRollingCounterProps) {
  const [display, setDisplay] = useState(value);
  const currentRef = useRef(value);

  useEffect(() => {
    const startVal = currentRef.current;
    if (startVal === value) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      currentRef.current = value;
      setDisplay(value);
      return;
    }

    const startTime = performance.now();
    const duration = 380;
    let raf = 0;

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const p = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = startVal + (value - startVal) * eased;
      currentRef.current = next;
      setDisplay(next);
      if (p < 1) {
        raf = window.requestAnimationFrame(tick);
      } else {
        currentRef.current = value;
        setDisplay(value);
      }
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [value]);

  const formatted = display.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. DitherStatCard                                                          */
/* -------------------------------------------------------------------------- */

export interface DitherStatCardProps {
  label: string;
  value: number | string;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  delta?: string;
  deltaDirection?: "up" | "down" | "neutral";
  deltaGood?: "up" | "down" | "neutral";
  series?: number[];
  subtitle?: string;
  tone?: DitherColorTone;
  className?: string;
}

function DitherSparklineCanvas({
  series,
  tone,
}: {
  series: number[];
  tone: DitherColorTone;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || series.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = 132;
    const h = 32;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = max - min || 1;
    const [r, g, b] = DITHER_TONE_HEX[tone].rgb;

    const img = ctx.createImageData(w, h);
    const data = img.data;

    for (let x = 0; x < w; x++) {
      const fx = (x / (w - 1)) * (series.length - 1);
      const i0 = Math.floor(fx);
      const i1 = Math.min(series.length - 1, i0 + 1);
      const frac = fx - i0;
      const v0 = series[i0] ?? 0;
      const v1 = series[i1] ?? v0;
      const val = (v0 + (v1 - v0) * frac - min) / span;
      const curveY = h - 4 - val * (h - 8);

      for (let y = 0; y < h; y++) {
        const idx = (y * w + x) * 4;
        if (Math.abs(y - curveY) <= 1.1) {
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 240;
        } else if (y > curveY) {
          const depth = 1 - (y - curveY) / (h - curveY + 1);
          const threshold = bayerThreshold(x, y, 4);
          if (depth * 0.85 > threshold) {
            data[idx] = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 175;
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [series, tone]);

  return (
    <div className="dcn-stat__spark" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

export interface DitherSparklineProps {
  series: number[];
  tone?: DitherColorTone;
  label?: string;
  valueText?: string;
  className?: string;
}

export function DitherSparkline({
  series,
  tone = "mint",
  label,
  valueText,
  className,
}: DitherSparklineProps) {
  return (
    <div
      className={joinClasses("dcn-sparkline-widget", className)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      {(label || valueText) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {label && (
            <span
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 11,
                color: "rgba(186, 200, 232, 0.78)",
              }}
            >
              {label}
            </span>
          )}
          {valueText && (
            <strong
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 13,
                color: "#f4f6fb",
              }}
            >
              {valueText}
            </strong>
          )}
        </div>
      )}
      <DitherSparklineCanvas series={series} tone={tone} />
    </div>
  );
}

export function DitherStatCard({
  label,
  value,
  prefix = "",
  suffix = "",
  decimals = 0,
  delta,
  deltaDirection = "neutral",
  deltaGood = "up",
  series = [32, 38, 36, 44, 52, 48, 61, 68, 72, 84],
  subtitle,
  tone = "blue",
  className,
}: DitherStatCardProps) {
  const sentiment =
    deltaDirection === "neutral" || deltaGood === "neutral"
      ? "neutral"
      : deltaDirection === deltaGood
        ? "good"
        : "bad";

  return (
    <div className={joinClasses("dcn-stat", className)} data-tone={tone}>
      <div className="dcn-stat__top">
        <span className="dcn-stat__label">{label}</span>
        {delta && (
          <span className="dcn-stat__delta" data-sentiment={sentiment}>
            {deltaDirection === "up" ? "▲" : deltaDirection === "down" ? "▼" : "•"} {delta}
          </span>
        )}
      </div>

      <div className="dcn-stat__value">
        {typeof value === "number" ? (
          <BenchoRollingCounter
            value={value}
            prefix={prefix}
            suffix={suffix}
            decimals={decimals}
          />
        ) : (
          <span>
            {prefix}
            {value}
            {suffix}
          </span>
        )}
      </div>

      {subtitle && <div className="dcn-stat__sub">{subtitle}</div>}

      <DitherSparklineCanvas series={series} tone={tone} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. DitherGauge                                                             */
/* -------------------------------------------------------------------------- */

export interface DitherGaugeProps {
  value: number;
  max?: number;
  label: string;
  sublabel?: string;
  size?: number;
  segments?: number;
  tone?: DitherColorTone;
  showPercent?: boolean;
  valueText?: string;
  className?: string;
}

export function DitherGauge({
  value,
  max = 100,
  label,
  sublabel,
  size = 136,
  segments = 28,
  tone = "blue",
  showPercent = true,
  valueText,
  className,
}: DitherGaugeProps) {
  const ratio = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const activeCount = Math.round(ratio * segments);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.39;
  const startAngle = -215;
  const sweepAngle = 250;
  const accent = DITHER_TONE_HEX[tone].accent;

  const blocks = useMemo(() => {
    const out: Array<{
      x: number;
      y: number;
      angle: number;
      active: boolean;
      isLead: boolean;
      ditherStep: number;
    }> = [];
    for (let i = 0; i < segments; i++) {
      const t = segments > 1 ? i / (segments - 1) : 0;
      const deg = startAngle + t * sweepAngle;
      const rad = (deg * Math.PI) / 180;
      out.push({
        x: cx + Math.cos(rad) * radius,
        y: cy + Math.sin(rad) * radius,
        angle: deg + 90,
        active: i < activeCount,
        isLead: i === Math.max(0, activeCount - 1) && activeCount > 0,
        ditherStep: i % 3,
      });
    }
    return out;
  }, [activeCount, cx, cy, radius, segments, startAngle, sweepAngle]);

  const displayValue =
    valueText ?? (showPercent ? `${Math.round(ratio * 100)}%` : String(value));

  return (
    <div
      className={joinClasses("dcn-gauge", className)}
      data-tone={tone}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div className="dcn-gauge__dial" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          {blocks.map((b, i) => {
            const fill = b.active
              ? accent
              : "currentColor";
            const opacity = b.isLead
              ? 1
              : b.active
                ? 0.65 + (i / segments) * 0.35
                : b.ditherStep === 0
                  ? 0.24
                  : 0.11;
            const w = b.isLead ? 5 : 4;
            const h = b.isLead ? 13 : 10;
            return (
              <rect
                key={i}
                x={b.x - w / 2}
                y={b.y - h / 2}
                width={w}
                height={h}
                rx={1}
                fill={fill}
                opacity={opacity}
                transform={`rotate(${b.angle} ${b.x} ${b.y})`}
              />
            );
          })}
        </svg>
        <div className="dcn-gauge__center">
          <span className="dcn-gauge__val">{displayValue}</span>
          {sublabel && <span className="dcn-gauge__sub">{sublabel}</span>}
        </div>
      </div>
      <span className="dcn-gauge__label">{label}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. DitherProgressBar                                                       */
/* -------------------------------------------------------------------------- */

export interface DitherProgressBarProps {
  value: number;
  max?: number;
  label?: string;
  valueText?: string;
  tone?: DitherColorTone;
  height?: number;
  showSteps?: boolean;
  className?: string;
}

export function DitherProgressBar({
  value,
  max = 100,
  label,
  valueText,
  tone = "blue",
  height = 14,
  showSteps = true,
  className,
}: DitherProgressBarProps) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));

  return (
    <div
      className={joinClasses("dcn-progress", className)}
      data-tone={tone}
      role="progressbar"
      aria-label={label ?? "Progress"}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      {(label || valueText) && (
        <div className="dcn-progress__head">
          <span className="dcn-progress__label">{label}</span>
          <span className="dcn-progress__val">
            {valueText ?? `${Math.round(pct)}%`}
          </span>
        </div>
      )}
      <div className="dcn-progress__track" style={{ height }}>
        <div
          className="dcn-progress__fill"
          style={{
            width: `${pct}%`,
            backgroundSize: showSteps ? "100% 100%, 3px 3px" : "100% 100%, 0 0",
          }}
        >
          {pct > 0 && <span className="dcn-progress__edge" />}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 6. DitherHeatmap                                                           */
/* -------------------------------------------------------------------------- */

export interface DitherHeatmapDatum {
  date?: string;
  count: number;
  label?: string;
}

export interface DitherHeatmapProps {
  weeks?: number;
  data?: Array<number | DitherHeatmapDatum>;
  title?: string;
  summary?: string;
  tone?: DitherColorTone;
  className?: string;
}

function buildDefaultHeatmapCells(totalDays: number): DitherHeatmapDatum[] {
  const out: DitherHeatmapDatum[] = [];
  for (let i = 0; i < totalDays; i++) {
    const wave = Math.sin(i * 0.21) + Math.cos(i * 0.08);
    const burst = (i * 37 + 13) % 19;
    const count =
      burst > 14 ? 7 + (burst % 4) : wave > 0.65 ? 4 : wave > 0 ? 2 : burst > 8 ? 1 : 0;
    const dayOffset = totalDays - 1 - i;
    out.push({
      date: `T-${dayOffset}d`,
      count,
    });
  }
  return out;
}

export function DitherHeatmap({
  weeks = 53,
  data,
  title = "ACTIVITY MATRIX (53 WEEKS)",
  summary = "1,143 signed receipts across 371 days",
  tone = "green",
  className,
}: DitherHeatmapProps) {
  const totalCells = weeks * 7;
  const cells = useMemo(() => {
    if (!data || data.length === 0) {
      return buildDefaultHeatmapCells(totalCells);
    }
    const normalized: DitherHeatmapDatum[] = [];
    for (let i = 0; i < totalCells; i++) {
      const entry = data[i];
      if (typeof entry === "number") {
        normalized.push({ date: `Day ${i + 1}`, count: entry });
      } else if (entry) {
        normalized.push(entry);
      } else {
        normalized.push({ date: `Day ${i + 1}`, count: 0 });
      }
    }
    return normalized;
  }, [data, totalCells]);

  const maxCount = useMemo(
    () => Math.max(1, ...cells.map((c) => c.count)),
    [cells],
  );
  const [hovered, setHovered] = useState<DitherHeatmapDatum | null>(null);

  const levelOf = (count: number): 0 | 1 | 2 | 3 | 4 => {
    if (count <= 0) return 0;
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.78) return 3;
    return 4;
  };

  return (
    <div className={joinClasses("dcn-heatmap", className)} data-tone={tone}>
      <div className="dcn-heatmap__head">
        <span className="dcn-heatmap__title">{title}</span>
        <span className="dcn-heatmap__summary">{summary}</span>
      </div>

      <div className="dcn-heatmap__scroll">
        <div className="dcn-heatmap__grid" role="grid" aria-label={title}>
          {cells.map((cell, i) => {
            const level = levelOf(cell.count);
            const hint = cell.label ?? `${cell.date ?? `Day ${i + 1}`}: ${cell.count} events`;
            return (
              <button
                key={i}
                type="button"
                className="dcn-heatmap__cell"
                data-level={level}
                title={hint}
                aria-label={hint}
                onMouseEnter={() => setHovered(cell)}
                onFocus={() => setHovered(cell)}
              />
            );
          })}
        </div>
      </div>

      <div className="dcn-heatmap__foot">
        <span>
          {hovered
            ? hovered.label ?? `${hovered.date ?? "Selected"}: ${hovered.count} signed receipts`
            : "Hover any cell to inspect daily ledger density"}
        </span>
        <span className="dcn-heatmap__legend" aria-hidden="true">
          <span>Sparse</span>
          <span className="dcn-heatmap__cell" data-level="0" />
          <span className="dcn-heatmap__cell" data-level="1" />
          <span className="dcn-heatmap__cell" data-level="2" />
          <span className="dcn-heatmap__cell" data-level="3" />
          <span className="dcn-heatmap__cell" data-level="4" />
          <span>Solid</span>
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 7. DitherUptimeBar                                                         */
/* -------------------------------------------------------------------------- */

export interface DitherUptimeDay {
  label: string;
  status: "up" | "degraded" | "down" | "idle";
  latencyMs?: number;
  detail?: string;
}

export interface DitherUptimeBarProps {
  days: DitherUptimeDay[];
  title?: string;
  uptimePercent?: string;
  tone?: DitherColorTone;
  className?: string;
}

export function DitherUptimeBar({
  days,
  title = "TEE Enclave & RPC Uptime",
  uptimePercent = "99.98%",
  tone = "green",
  className,
}: DitherUptimeBarProps) {
  const [selected, setSelected] = useState<DitherUptimeDay | null>(null);

  return (
    <div className={joinClasses("dcn-uptime", className)} data-tone={tone}>
      <div className="dcn-uptime__head">
        <span className="dcn-uptime__title">{title}</span>
        <span className="dcn-uptime__pct">{uptimePercent}</span>
      </div>
      <div className="dcn-uptime__bars">
        {days.map((day, idx) => (
          <button
            key={`${day.label}-${idx}`}
            type="button"
            className="dcn-uptime__bar"
            data-status={day.status}
            title={`${day.label}: ${day.status}${day.latencyMs !== undefined ? ` (${day.latencyMs}ms)` : ""}`}
            aria-label={`${day.label}: ${day.status}`}
            onMouseEnter={() => setSelected(day)}
            onFocus={() => setSelected(day)}
          />
        ))}
      </div>
      <div className="dcn-uptime__meta">
        {selected
          ? `${selected.label} · ${selected.status.toUpperCase()}${selected.latencyMs !== undefined ? ` · ${selected.latencyMs}ms` : ""}${selected.detail ? ` · ${selected.detail}` : ""}`
          : `${days.length} intervals checked · hover any bar for probe telemetry`}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 8. DitherButton                                                            */
/* -------------------------------------------------------------------------- */

export interface DitherButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  tone?: DitherColorTone;
  loading?: boolean;
}

export function DitherButton({
  variant = "primary",
  size = "md",
  tone = "blue",
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: DitherButtonProps) {
  return (
    <button
      type={type}
      className={joinClasses("dcn-btn", className)}
      data-variant={variant}
      data-size={size}
      data-tone={tone}
      disabled={disabled || loading}
      {...rest}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* 9. DitherTabs                                                              */
/* -------------------------------------------------------------------------- */

export interface DitherTabItem {
  id: string;
  label: string;
  badge?: string | number;
  testId?: string;
}

export interface DitherTabsProps {
  items: DitherTabItem[];
  value: string;
  onChange: (id: string) => void;
  tone?: DitherColorTone;
  ariaLabel?: string;
  className?: string;
}

export function DitherTabs({
  items,
  value,
  onChange,
  tone = "blue",
  ariaLabel = "Tabs",
  className,
}: DitherTabsProps) {
  return (
    <div
      className={joinClasses("dcn-tabs", className)}
      data-tone={tone}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="dcn-tab"
            data-testid={item.testId ?? `tab-${item.id}`}
            aria-selected={selected}
            onClick={() => onChange(item.id)}
          >
            <span>{item.label}</span>
            {item.badge !== undefined && (
              <span className="dcn-tab__badge">{item.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 10. MdxcnFrame                                                             */
/* -------------------------------------------------------------------------- */

export interface MdxcnFrameProps {
  title: string;
  badge?: string;
  codeContent?: string;
  codeLabels?: [string, string];
  tone?: DitherColorTone;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function MdxcnFrame({
  title,
  badge,
  codeContent,
  codeLabels = ["VIEW", "MD"],
  tone = "blue",
  children,
  className,
  style,
}: MdxcnFrameProps) {
  const [showCode, setShowCode] = useState(false);

  return (
    <section
      className={joinClasses("mdx-frame", className)}
      data-tone={tone}
      style={style}
      aria-label={title}
    >
      <span className="mdx-frame__corner" data-pos="tl" aria-hidden="true">+</span>
      <span className="mdx-frame__corner" data-pos="tr" aria-hidden="true">+</span>
      <span className="mdx-frame__corner" data-pos="bl" aria-hidden="true">+</span>
      <span className="mdx-frame__corner" data-pos="br" aria-hidden="true">+</span>

      <div className="mdx-frame__header">
        <span className="mdx-frame__title">[ {title} ]</span>
        {(badge || codeContent) && (
          <div className="mdx-frame__controls">
            {badge && <span className="mdx-frame__badge">{badge}</span>}
            {codeContent && (
              <button
                type="button"
                className="mdx-frame__toggle"
                onClick={() => setShowCode((v) => !v)}
              >
                {showCode ? codeLabels[0] : codeLabels[1]}
              </button>
            )}
          </div>
        )}
      </div>

      {showCode && codeContent ? (
        <pre className="mdx-frame__code">{codeContent}</pre>
      ) : (
        children
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 11. BenchoSloshSlider                                                      */
/* -------------------------------------------------------------------------- */

export interface BenchoSloshMarker {
  value: number;
  label: string;
  tone?: DitherColorTone;
}

export interface BenchoSloshSliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  label?: string;
  formatValue?: (v: number) => string;
  markers?: BenchoSloshMarker[];
  tone?: DitherColorTone;
  disabled?: boolean;
  className?: string;
}

export function BenchoSloshSlider({
  value,
  min = 5,
  max = 100,
  step = 1,
  onChange,
  label,
  formatValue,
  markers,
  tone = "blue",
  disabled = false,
  className,
}: BenchoSloshSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const lastValueRef = useRef(value);
  const physicsRef = useRef({ disp: 0, vel: 0, tilt: 0 });
  const [waveState, setWaveState] = useState({ disp: 0, tilt: 0 });
  const gradId = useId();

  useEffect(() => {
    const delta = value - lastValueRef.current;
    lastValueRef.current = value;
    if (Math.abs(delta) > 0.001) {
      physicsRef.current.vel += Math.max(-18, Math.min(18, delta * 0.45));
      physicsRef.current.tilt = Math.max(-2.2, Math.min(2.2, delta * 0.14));
    }
  }, [value]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;

    const stepPhysics = () => {
      const p = physicsRef.current;
      const force = -0.18 * p.disp - 0.14 * p.vel;
      p.vel += force;
      p.disp += p.vel;
      p.tilt *= 0.86;

      if (Math.abs(p.disp) > 0.02 || Math.abs(p.vel) > 0.02 || Math.abs(p.tilt) > 0.01) {
        setWaveState({ disp: p.disp, tilt: p.tilt });
      } else if (p.disp !== 0 || p.tilt !== 0) {
        p.disp = 0;
        p.vel = 0;
        p.tilt = 0;
        setWaveState({ disp: 0, tilt: 0 });
      }
      raf = window.requestAnimationFrame(stepPhysics);
    };

    raf = window.requestAnimationFrame(stepPhysics);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const ratio = Math.max(0, Math.min(1, max > min ? (value - min) / (max - min) : 0));
  const pct = ratio * 100;

  const updateFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || disabled) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const rawRatio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const rawValue = min + rawRatio * (max - min);
    const snapped = Math.round((rawValue - min) / step) * step + min;
    const clamped = Math.max(min, Math.min(max, Number(snapped.toFixed(4))));
    if (clamped !== value) {
      onChange(clamped);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateFromClientX(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || disabled) return;
    updateFromClientX(e.clientX);
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next = value;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      next = Math.min(max, value + step);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      next = Math.max(min, value - step);
    } else if (e.key === "Home") {
      next = min;
    } else if (e.key === "End") {
      next = max;
    } else {
      return;
    }
    e.preventDefault();
    onChange(next);
  };

  const waveAmp = Math.max(-10, Math.min(10, waveState.disp));
  const wavePath = `M 0 18 Q 25 ${18 - waveAmp} 50 18 T 100 18 L 100 36 L 0 36 Z`;
  const formatted = formatValue ? formatValue(value) : String(value);

  return (
    <div
      className={joinClasses("slosh-slider", className)}
      data-tone={tone}
      data-disabled={disabled ? "true" : "false"}
    >
      {(label || formatValue) && (
        <div className="slosh-slider__head">
          <span className="slosh-slider__label">{label}</span>
          <span className="slosh-slider__val">{formatted}</span>
        </div>
      )}

      <div
        ref={trackRef}
        className="slosh-slider__track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label ?? "Slider"}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={formatted}
        style={{ transform: `rotate(${waveState.tilt.toFixed(2)}deg)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        <div className="slosh-slider__liquid" style={{ width: `${pct}%` }}>
          <svg
            className="slosh-slider__wave"
            viewBox="0 0 100 36"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0.05" />
              </linearGradient>
            </defs>
            <path d={wavePath} fill={`url(#${gradId})`} />
          </svg>
        </div>

        <div
          className="slosh-slider__handle"
          style={{ left: `clamp(10px, ${pct}%, calc(100% - 10px))` }}
          aria-hidden="true"
        />
      </div>

      {markers && markers.length > 0 && (
        <div className="slosh-slider__markers">
          {markers.map((m) => (
            <button
              key={`${m.label}-${m.value}`}
              type="button"
              className="slosh-slider__marker"
              disabled={disabled}
              onClick={() => onChange(Math.max(min, Math.min(max, m.value)))}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import React from "react";

export const MONO = '"Commit Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
export const SANS = '"Inter Display", -apple-system, BlinkMacSystemFont, sans-serif';
export const BRAND = '"Funnel Display", "Inter Display", sans-serif';
export const DOTO = '"Doto", "Commit Mono", monospace';

export const TOKENS = {
  bg: "#0f0f0e",
  side: "#0b0d11",
  pane: "#181817",
  raised: "#1c1c1b",
  raised2: "#242423",
  ink: "#efefec",
  ink2: "#d6d6d2",
  muted: "#a3a39e",
  agent: "#5aa8ff",
  agent2: "#8cc3ff",
  nearGreen: "#00ec97",
  ok: "#5fc48a",
  warn: "#e0a84a",
  danger: "#f08a80",
  line: "rgba(255, 255, 255, 0.11)",
  line2: "rgba(255, 255, 255, 0.18)",
};

/**
 * mdxcn.dev dashed crosshair frame: `+---- [ TITLE ] ----+`
 */
export const MdxcnFrame: React.FC<{
  title: string;
  accent?: string;
  badge?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, accent = TOKENS.agent, badge, children, style }) => {
  return (
    <div
      style={{
        position: "relative",
        border: "1px dashed rgba(255, 255, 255, 0.22)",
        backgroundColor: "rgba(12, 14, 19, 0.90)",
        borderRadius: 6,
        padding: "26px 24px 22px",
        boxShadow: "0 20px 52px rgba(0, 0, 0, 0.55)",
        ...style,
      }}
    >
      {/* 4 corner '+' crosshairs */}
      {[
        { top: -9, left: -5 },
        { top: -9, right: -5 },
        { bottom: -9, left: -5 },
        { bottom: -9, right: -5 },
      ].map((pos, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            ...pos,
            fontFamily: MONO,
            fontSize: 15,
            fontWeight: 700,
            color: accent,
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          +
        </span>
      ))}

      {/* Top bracket title */}
      <div
        style={{
          position: "absolute",
          top: -12,
          left: 18,
          right: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            backgroundColor: "#0c0e13",
            padding: "2px 10px",
            fontFamily: MONO,
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: accent,
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: 4,
          }}
        >
          [ {title} ]
        </span>
        {badge ? (
          <span
            style={{
              backgroundColor: "#0c0e13",
              padding: "2px 10px",
              fontFamily: MONO,
              fontSize: 12,
              fontWeight: 600,
              color: TOKENS.ok,
              border: "1px solid rgba(95, 196, 138, 0.35)",
              borderRadius: 4,
            }}
          >
            {badge}
          </span>
        ) : null}
      </div>

      {children}
    </div>
  );
};

/**
 * dithercn.dev Stat Card with tabular figure, delta badge, and deterministic stepped bar sparkline
 */
export const DitherStatCard: React.FC<{
  label: string;
  value: string;
  delta: string;
  color?: string;
  bars?: number[];
}> = ({
  label,
  value,
  delta,
  color = TOKENS.agent,
  bars = [0.35, 0.48, 0.42, 0.64, 0.58, 0.78, 0.74, 0.92, 0.88, 1.0],
}) => {
  return (
    <div
      style={{
        position: "relative",
        padding: "16px 18px",
        borderRadius: 10,
        backgroundColor: "rgba(20, 22, 27, 0.94)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 12,
          letterSpacing: "0.06em",
          color: TOKENS.muted,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginTop: 8,
          gap: 10,
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 28,
            fontWeight: 700,
            color: TOKENS.ink,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 99,
            backgroundColor: `${color}22`,
            color,
            border: `1px solid ${color}55`,
          }}
        >
          {delta}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 4,
          height: 26,
          marginTop: 12,
        }}
      >
        {bars.map((b, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${Math.round(b * 100)}%`,
              borderRadius: 2,
              background:
                i >= bars.length - 2
                  ? color
                  : `repeating-linear-gradient(0deg, ${color}bb 0px, ${color}bb 2px, transparent 2px, transparent 4px)`,
              opacity: 0.45 + 0.55 * (i / bars.length),
            }}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * dithercn.dev Stepped Bayer-Cell Progress Bar with solid leading edge
 */
export const DitherProgressBar: React.FC<{
  ratio: number;
  color?: string;
  height?: number;
  segments?: number;
}> = ({ ratio, color = TOKENS.nearGreen, height = 14, segments = 24 }) => {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * segments);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        height,
        padding: 3,
        borderRadius: 6,
        backgroundColor: "rgba(255, 255, 255, 0.05)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
      }}
    >
      {Array.from({ length: segments }).map((_, i) => {
        const isFilled = i < filled;
        const isEdge = i === filled - 1;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: "100%",
              borderRadius: 2,
              backgroundColor: isFilled
                ? isEdge
                  ? "#ffffff"
                  : color
                : "rgba(255, 255, 255, 0.06)",
              opacity: isFilled ? (isEdge ? 1 : 0.45 + 0.55 * (i / Math.max(1, filled))) : 0.4,
            }}
          />
        );
      })}
    </div>
  );
};

/**
 * bencho.dev/blocks/slosh deterministic liquid meniscus slider for Remotion 60 FPS.
 * Fill ratio + velocity produce a realistic tilted liquid meniscus wave.
 */
export const BenchoSloshSlider: React.FC<{
  valueUsd: number;
  minUsd?: number;
  maxUsd?: number;
  velocity: number;
  phase: number;
}> = ({ valueUsd, minUsd = 5, maxUsd = 100, velocity, phase }) => {
  const ratio = Math.max(0.05, Math.min(0.95, (valueUsd - minUsd) / (maxUsd - minUsd)));
  const fillPct = Math.round(ratio * 100);
  const tiltDeg = Math.max(-2.5, Math.min(2.5, velocity * 0.22));
  const sloshAmp = Math.min(10, Math.abs(velocity) * 0.75 + 2.2);
  const waveY = Math.sin(phase * 6.5) * sloshAmp;

  return (
    <div
      style={{
        transform: `rotate(${tiltDeg.toFixed(2)}deg)`,
        padding: "16px 20px",
        borderRadius: 16,
        backgroundColor: "rgba(18, 22, 30, 0.96)",
        border: "1px solid rgba(90, 168, 255, 0.35)",
        boxShadow: "0 14px 36px rgba(0, 0, 0, 0.45)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 13, color: TOKENS.muted, letterSpacing: "0.06em" }}>
          OUTLAYER TDX PER-TX CAP (BENCHO SLOSH)
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 28,
            fontWeight: 700,
            color: TOKENS.nearGreen,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          ${valueUsd.toFixed(2)} / tx
        </span>
      </div>

      {/* Capsule track */}
      <div
        style={{
          position: "relative",
          height: 40,
          borderRadius: 999,
          backgroundColor: "#0a0d14",
          border: "1px solid rgba(255, 255, 255, 0.16)",
          overflow: "hidden",
        }}
      >
        {/* Liquid Fill */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${fillPct}%`,
            background: "linear-gradient(90deg, #1b65d8 0%, #5aa8ff 68%, #00ec97 100%)",
          }}
        >
          {/* Sloshing Meniscus Crest */}
          <div
            style={{
              position: "absolute",
              right: -12,
              top: -6 + waveY,
              width: 24,
              height: 52,
              borderRadius: "50%",
              backgroundColor: "rgba(255, 255, 255, 0.35)",
              filter: "blur(2px)",
            }}
          />
        </div>

        {/* Thumb handle */}
        <div
          style={{
            position: "absolute",
            left: `calc(${fillPct}% - 14px)`,
            top: 6,
            width: 28,
            height: 28,
            borderRadius: "50%",
            backgroundColor: "#ffffff",
            boxShadow: "0 2px 10px rgba(0, 0, 0, 0.55)",
            border: "3px solid #0b0d11",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontFamily: MONO,
          fontSize: 12,
          color: TOKENS.muted,
        }}
      >
        <span>$5.00 min</span>
        <span style={{ color: TOKENS.agent2 }}>HARDWARE ENCLAVE LIMIT: $100.00 / DAY</span>
        <span>$100.00 max</span>
      </div>
    </div>
  );
};

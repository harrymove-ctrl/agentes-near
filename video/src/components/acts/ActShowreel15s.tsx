import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { ANTON, INTER_TIGHT, SERIF_ITALIC, clamp01, expoOut, quartOut, backOut } from "./shared";

interface ActProps {
  durationInFrames: number;
}

/**
 * ActShowreel15s (0-900f @ 60fps = 15.0s):
 * Motion-designer showreel combining:
 *   - 97 BPM kinetic wave + spinning letter rings (0..7.5s)
 *   - 3D isometric UI burst cards for key NEAR metrics (7.5..12.5s)
 *   - 3-line poster lockup fade-in (12.5..15s)
 *
 * Metrics shown: 1Click 358.13 wNEAR · OutLayer $25/tx Cap · x402 H100 TEE · 38,420 $AGENTES Burn
 */
export const ActShowreel15s: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Remap to virtual 15.0s timeline regardless of actual fps
  const t = (frame / fps) * (15.0 / (durationInFrames / fps));

  const beatDur = 60 / 97; // 0.6186s
  const beatIdx = Math.floor(t / beatDur);
  const beatFrac = (t % beatDur) / beatDur;
  const beatPunch = 1 + 0.048 * Math.exp(-beatFrac * 8.5);

  const PALETTES = [
    { bg: "#D8F8E8", ink: "#00A86B", accent: "#FF2E93" },
    { bg: "#13294B", ink: "#74B3FF", accent: "#FF5DA2" },
    { bg: "#FDF6E9", ink: "#F05A28", accent: "#D81B78" },
    { bg: "#1B4332", ink: "#A8F5C8", accent: "#FF70A6" },
  ];

  // ── Phase 1 (0..4.2s): full-frame kinetic text wave ──────────────────────
  if (t < 4.2) {
    const pal = PALETTES[beatIdx % PALETTES.length];
    const rows = [
      { text: "THINGS ARE MOVING · AGENTES NEAR · ", pink: false, dir: 1 },
      { text: "1CLICK 358.13 wNEAR · +16 BPS · ", pink: false, dir: 1 },
      { text: "OUTLAYER TDX · $25/TX CAP · ", pink: true, dir: -1 },
      { text: "X402 H100 TEE · $1.84/HR · ", pink: false, dir: 1 },
      { text: "38,420 $AGENTES BURN · ML-DSA-65 PQ · ", pink: false, dir: 1 },
    ];
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: pal.bg,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "28px 0",
          overflow: "hidden",
        }}
      >
        {rows.map((r, rIdx) => {
          const phase = t * 3.1 + rIdx * 0.85;
          const waveY = Math.sin(phase) * 18;
          const slideX = ((t * 210 * r.dir + rIdx * 120) % 640) - 320;
          const color = r.pink ? pal.accent : pal.ink;
          return (
            <div
              key={rIdx}
              style={{
                whiteSpace: "nowrap",
                fontFamily: ANTON,
                fontSize: 162,
                lineHeight: 0.96,
                letterSpacing: "-0.015em",
                color,
                transform: `translate3d(${slideX}px, ${waveY}px, 0) scale(${beatPunch.toFixed(4)})`,
              }}
            >
              {r.text.repeat(3)}
            </div>
          );
        })}
      </div>
    );
  }

  // ── Phase 2 (4.2..7.5s): spinning letter rings ───────────────────────────
  if (t < 7.5) {
    const localT = t - 4.2;
    const pRing = PALETTES[(beatIdx + 1) % PALETTES.length];
    const rings = [
      { r: 440, speed: 0.55, color: pRing.ink, text: "AGENTES·NEAR·SLACK·FOR·TEAMS·AI·" },
      { r: 300, speed: -0.78, color: pRing.accent, text: "OUTLAYER·TDX·1CLICK·X402·" },
      { r: 165, speed: 1.05, color: pRing.ink, text: "ML-DSA-65·NEAR·PQ·" },
    ];
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: pRing.bg,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ position: "relative", width: 1000, height: 1000, transform: `scale(${beatPunch.toFixed(4)})` }}>
          {rings.map((ring, rIdx) => {
            const chars = ring.text.split("");
            const rotBase = localT * ring.speed * 58;
            return chars.map((ch, cIdx) => {
              const angle = (cIdx / chars.length) * 360 + rotBase;
              return (
                <span
                  key={`${rIdx}-${cIdx}`}
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    fontFamily: ANTON,
                    fontSize: 92,
                    lineHeight: 1,
                    color: ring.color,
                    transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${ring.r}px)`,
                    transformOrigin: "center center",
                  }}
                >
                  {ch}
                </span>
              );
            });
          })}
        </div>
      </div>
    );
  }

  // ── Phase 3 (7.5..12.5s): 3D isometric UI burst cards ───────────────────
  if (t < 12.5) {
    const localT = t - 7.5;
    const metrics = [
      { label: "1CLICK", value: "358.13", unit: "wNEAR", accent: "#00EC97", bg: "#0d2a1f" },
      { label: "OUTLAYER", value: "$25", unit: "/tx Cap", accent: "#F59E0B", bg: "#1a1200" },
      { label: "X402 H100 TEE", value: "$1.84", unit: "/hr GPU", accent: "#38BDF8", bg: "#001a2a" },
      { label: "$AGENTES BURN", value: "38,420", unit: "burned", accent: "#EC4899", bg: "#1a0010" },
    ];

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "#05060a",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 36,
        }}
      >
        {metrics.map((m, idx) => {
          const delay = idx * 0.22;
          const prog = expoOut(clamp01((localT - delay) / 0.55));
          // isometric tilt + float
          const isoAngle = -18 + idx * 2;
          const floatY = Math.sin(localT * 1.4 + idx * 1.1) * 10;
          const beatScale = beatPunch * (0.92 + 0.08 * prog);
          return (
            <div
              key={m.label}
              style={{
                width: 360,
                height: 220,
                borderRadius: 20,
                backgroundColor: m.bg,
                border: `2px solid ${m.accent}30`,
                boxShadow: `0 20px 60px ${m.accent}22, 0 2px 8px rgba(0,0,0,0.6)`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                opacity: prog,
                transform: `perspective(900px) rotateX(${isoAngle}deg) rotateY(${3 - idx * 2}deg) scale(${(beatScale * prog).toFixed(4)}) translateY(${(floatY + (1 - prog) * 80).toFixed(2)}px)`,
              }}
            >
              <div style={{ fontFamily: INTER_TIGHT, fontSize: 13, fontWeight: 700, color: m.accent, letterSpacing: "0.12em" }}>
                {m.label}
              </div>
              <div style={{ fontFamily: ANTON, fontSize: 72, lineHeight: 1, color: "#F7F7F2", letterSpacing: "-0.02em" }}>
                {m.value}
              </div>
              <div style={{ fontFamily: INTER_TIGHT, fontSize: 18, fontWeight: 500, color: `${m.accent}cc` }}>
                {m.unit}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── Phase 4 (12.5..15.0s): 3-line poster lockup ──────────────────────────
  const localT = t - 12.5;
  const line1 = expoOut(clamp01(localT / 0.38));
  const line2 = expoOut(clamp01((localT - 0.5) / 0.38));
  const line3 = expoOut(clamp01((localT - 1.0) / 0.38));

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: "#0E1726",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 96px",
        overflow: "hidden",
      }}
    >
      {[
        { label: "AGENTES NEAR", prog: line1, color: "#F7F7F2", serif: false },
        { label: "SLACK FOR TEAMS", prog: line2, color: "#00EC97", serif: false },
        { label: "& AI SWARMS.", prog: line3, color: "#FF4FA3", serif: true },
      ].map((ln, idx) => (
        <div
          key={idx}
          style={{
            fontFamily: ln.serif ? SERIF_ITALIC : INTER_TIGHT,
            fontStyle: ln.serif ? "italic" : "normal",
            fontWeight: ln.serif ? 400 : 800,
            fontSize: ln.serif ? 196 : 164,
            lineHeight: 0.96,
            letterSpacing: "-0.03em",
            color: ln.color,
            opacity: ln.prog,
            transform: `translateY(${(1 - ln.prog) * 60}px) scale(${(beatPunch * (0.98 + 0.02 * ln.prog)).toFixed(4)})`,
            transformOrigin: "left center",
          }}
        >
          {ln.label}
        </div>
      ))}
    </div>
  );
};

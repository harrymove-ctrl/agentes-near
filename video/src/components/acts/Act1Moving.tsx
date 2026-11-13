import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { ANTON, INTER_TIGHT, SERIF_ITALIC, clamp01, expoOut, quartOut } from "./shared";

interface ActProps {
  durationInFrames: number;
}

const PALETTES = [
  { bg: "#D8F8E8", ink: "#00A86B", accent: "#FF2E93" },
  { bg: "#13294B", ink: "#74B3FF", accent: "#FF5DA2" },
  { bg: "#FDF6E9", ink: "#F05A28", accent: "#D81B78" },
  { bg: "#1B4332", ink: "#A8F5C8", accent: "#FF70A6" },
];

/**
 * Act 1 (0..12s): "Things Are Moving" — 97 BPM Kinetic Type Wave
 * - Full-frame wavy text rows riding synced sine wave (green L->R, 1 pink R->L)
 * - Every beat (0.6185s @ 97 BPM) flips bg & type to tone-on-tone pair
 * - Spinning concentric rings of ONE large letter size sitting baseline-to-baseline
 * - Beat-snapping rows + letter ripple -> 3 stacked full-frame Apple-style lines
 */
export const Act1Moving: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const actualDur = durationInFrames / fps;
  const t = (frame / fps) * (12.0 / actualDur);

  const beatDur = 60 / 97; // 0.61855s
  const beatIdx = Math.floor(t / beatDur);
  const beatFrac = (t % beatDur) / beatDur;
  const beatPunch = 1 + 0.045 * Math.exp(-beatFrac * 8.5);
  const pal = PALETTES[beatIdx % PALETTES.length];

  // Phase 1 (0..4.2s): Full-frame wavy text rows
  // Phase 2 (4.2..7.2s): Spinning concentric baseline-to-baseline letter rings
  // Phase 3 (7.2..9.6s): Beat-snapping rows + character letter ripple
  // Phase 4 (9.6..12.0s): 3 stacked full-frame lines with beat punches

  if (t < 4.2) {
    const rows = [
      { text: "THINGS ARE MOVING · NEAR INTENTS · ", pink: false, dir: 1 },
      { text: "AGENTES NEAR · AUTONOMOUS SWARMS · ", pink: false, dir: 1 },
      { text: "OUTLAYER INTEL TDX · ZERO KEYS · ", pink: true, dir: -1 },
      { text: "ONE CLICK SETTLEMENT · 1CLICK SOLVERS · ", pink: false, dir: 1 },
      { text: "TERRACE CONVICTION · ML-DSA-65 · ", pink: false, dir: 1 },
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

  if (t < 7.2) {
    const localT = t - 4.2;
    const pRing = PALETTES[(beatIdx + 1) % PALETTES.length];
    const rings = [
      { r: 440, speed: 0.55, color: pRing.ink, text: "AGENTES·NEAR·SLACK·FOR·TEAMS·" },
      { r: 300, speed: -0.78, color: pRing.accent, text: "OUTLAYER·TDX·1CLICK·" },
      { r: 165, speed: 1.05, color: pRing.ink, text: "ML-DSA-65·X402·" },
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
        <div
          style={{
            position: "relative",
            width: 1000,
            height: 1000,
            transform: `scale(${beatPunch.toFixed(4)})`,
          }}
        >
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

  if (t < 9.6) {
    const localT = t - 7.2;
    const snapIdx = Math.floor(localT / beatDur);
    const pSnap = PALETTES[(beatIdx + 2) % PALETTES.length];
    const words = ["KINETIC", "AUTONOMOUS", "VERIFIABLE"];

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: pSnap.bg,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 14,
          overflow: "hidden",
        }}
      >
        {words.map((word, wIdx) => {
          const offset = ((snapIdx + wIdx) % 2 === 0 ? 1 : -1) * (1 - expoOut(beatFrac)) * 120;
          return (
            <div
              key={word}
              style={{
                display: "flex",
                transform: `translateX(${offset}px)`,
              }}
            >
              {word.split("").map((ch, cIdx) => {
                const rippleY = Math.sin(localT * 11.0 - cIdx * 0.55 + wIdx * 1.2) * 26;
                return (
                  <span
                    key={cIdx}
                    style={{
                      fontFamily: ANTON,
                      fontSize: 225,
                      lineHeight: 0.9,
                      color: wIdx === 1 ? pSnap.accent : pSnap.ink,
                      transform: `translateY(${rippleY}px)`,
                      display: "inline-block",
                    }}
                  >
                    {ch}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  // 9.6..12.0s: 3 stacked full-frame lines with Apple-like beat punches
  const localT = t - 9.6;
  const line1 = expoOut(clamp01(localT / 0.35));
  const line2 = expoOut(clamp01((localT - 0.55) / 0.35));
  const line3 = expoOut(clamp01((localT - 1.1) / 0.35));

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

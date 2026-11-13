import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { ANTON, BRAND, CursorArrow, DOTO, INTER_TIGHT, MONO, SERIF_ITALIC, clamp01, expoOut, quartOut } from "./shared";

interface ActProps {
  durationInFrames: number;
}

/**
 * Act 7 (67..80s): "ONE workspace · Agentes NEAR" 5s Sting @ 108 BPM + Final Agentes NEAR Lockup
 * - First 5s (relative t 0..5.0s): Charcoal #1E1E1E, Off-White #F5F3EE, Violet #5B3FD6, Tomato #E5483A
 *   - Cursor "you" sweeps in -> draws circle + handles -> duplicates circle+rect+triangle w/ Layers panel
 *   - Shapes morph into Anton O N E -> panels slide out -> cursor clicks ✓ (0.1s silence before 3.3s hit)
 *   - Tomato block wipe flips canvas to #5B3FD6 with ONE, "workspace" italic + "AGENTES NEAR 2026"
 * - Final 8s (relative t 5.0..13.0s): Reveals Agentes NEAR Motion Editor + Slack for Teams & AI Agents lockup!
 */
export const Act7OneLockup: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const actualDur = durationInFrames / fps;
  const isTeaser = actualDur < 9.0;
  const stingDur = isTeaser ? 3.6 : 5.0;
  const tSting = (frame / fps) * (5.0 / stingDur);

  if (tSting < 5.0) {
    // 0..3.3s: Vector workspace -> 3.3..5.0s: Tomato wipe -> #5B3FD6 Lockup
    const cursorIn = expoOut(clamp01(tSting / 0.35));
    const circleDraw = quartOut(clamp01((tSting - 0.35) / 0.5));
    const dupShapes = quartOut(clamp01((tSting - 0.95) / 0.6));
    const morphOne = quartOut(clamp01((tSting - 1.75) / 0.75));
    const panelsOut = quartOut(clamp01((tSting - 2.45) / 0.45));
    const wipeProg = quartOut(clamp01((tSting - 3.3) / 0.38));

    if (tSting >= 3.3) {
      const reveal = expoOut(clamp01((tSting - 3.55) / 0.55));
      return (
        <div style={{ position: "absolute", inset: 0, backgroundColor: "#5B3FD6", overflow: "hidden" }}>
          {/* Tomato Block Wipe */}
          {wipeProg < 1 ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                backgroundColor: "#E5483A",
                transform: `translateX(${wipeProg * 1920}px)`,
                zIndex: 30,
              }}
            />
          ) : null}

          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              transform: `scale(${0.92 + 0.08 * reveal})`,
              opacity: reveal,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
              <span style={{ fontFamily: ANTON, fontSize: 220, lineHeight: 0.9, color: "#F5F3EE", letterSpacing: "0.02em" }}>
                ONE
              </span>
              <span style={{ fontFamily: SERIF_ITALIC, fontStyle: "italic", fontSize: 164, color: "#F5F3EE" }}>
                workspace
              </span>
            </div>
            <div
              style={{
                marginTop: 18,
                padding: "8px 22px",
                borderRadius: 999,
                backgroundColor: "#E5483A",
                color: "#F5F3EE",
                fontFamily: MONO,
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: "0.18em",
              }}
            >
              AGENTES NEAR 2026
            </div>
          </div>
        </div>
      );
    }

    // Vector canvas phase (0..3.3s)
    const showGlyphs = morphOne > 0.45;
    const cursorX =
      tSting < 1.0
        ? 220 + cursorIn * 520
        : tSting < 2.6
          ? 740 + dupShapes * 380
          : 1120 + panelsOut * 340;
    const cursorY = tSting < 2.6 ? 260 + circleDraw * 220 : 480 - panelsOut * 310;

    return (
      <div style={{ position: "absolute", inset: 0, backgroundColor: "#F5F3EE", overflow: "hidden" }}>
        {/* Left Layers Panel */}
        <div
          style={{
            position: "absolute",
            left: 56 - panelsOut * 420,
            top: 90,
            width: 310,
            backgroundColor: "#1E1E1E",
            color: "#F5F3EE",
            borderRadius: 18,
            padding: 22,
            boxShadow: "0 20px 44px rgba(0,0,0,0.22)",
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 13, color: "#A3A39E", marginBottom: 14 }}>AGENTES LAYERS</div>
          {["O · Team Channels", "N · OutLayer Agents", "E · Motion Studio"].map((ly, idx) => (
            <div
              key={ly}
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                marginBottom: 8,
                backgroundColor: idx === 0 ? "#5B3FD6" : "rgba(255,255,255,0.06)",
                fontFamily: MONO,
                fontSize: 13,
              }}
            >
              {ly}
            </div>
          ))}
        </div>

        {/* Top-Right Check Button ✓ */}
        <div
          style={{
            position: "absolute",
            right: 72,
            top: 88,
            padding: "14px 28px",
            borderRadius: 999,
            backgroundColor: tSting >= 2.95 ? "#E5483A" : "#1E1E1E",
            color: "#F5F3EE",
            fontFamily: INTER_TIGHT,
            fontSize: 24,
            fontWeight: 800,
            transform: `translateY(${-panelsOut * 20}px)`,
          }}
        >
          ✓ Launch
        </div>

        {/* 3 Morphing Shapes -> Anton O N E */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 56,
          }}
        >
          {!showGlyphs ? (
            <>
              {/* Circle + selection handles */}
              <div style={{ position: "relative", width: 220, height: 220, transform: `scale(${circleDraw})` }}>
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: "50%",
                    border: "28px solid #1E1E1E",
                  }}
                />
                <div style={{ position: "absolute", inset: -10, border: "2px dashed #5B3FD6" }} />
              </div>

              {/* Rect */}
              <div
                style={{
                  width: 200,
                  height: 220,
                  borderRadius: 16,
                  backgroundColor: "#5B3FD6",
                  transform: `scale(${dupShapes})`,
                  opacity: dupShapes,
                }}
              />

              {/* Triangle */}
              <svg
                width="220"
                height="220"
                viewBox="0 0 220 220"
                style={{ transform: `scale(${dupShapes})`, opacity: dupShapes }}
              >
                <polygon points="110,12 208,208 12,208" fill="#E5483A" />
              </svg>
            </>
          ) : (
            <div style={{ display: "flex", gap: 44, transform: `scale(${0.88 + 0.12 * morphOne})` }}>
              {["O", "N", "E"].map((ch, idx) => (
                <span
                  key={ch}
                  style={{
                    fontFamily: ANTON,
                    fontSize: 320,
                    lineHeight: 0.9,
                    color: idx === 1 ? "#5B3FD6" : idx === 2 ? "#E5483A" : "#1E1E1E",
                  }}
                >
                  {ch}
                </span>
              ))}
            </div>
          )}
        </div>

        <CursorArrow x={cursorX} y={cursorY} label="you" color="#5B3FD6" scale={1.15} />
      </div>
    );
  }

  // Final 8s (or 3.4s in teaser): Agentes NEAR SaaS Motion Studio + Slack for Teams & AI Agents Lockup
  const lockT = (frame / fps) - stingDur;
  const lockIn = expoOut(clamp01(lockT / 0.65));
  const creep = 1 + clamp01(lockT / Math.max(1, actualDur - stingDur)) * 0.03;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: "#05060A",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {/* Clean Subtle Night Nebula Glow */}
      <div
        style={{
          position: "absolute",
          width: 1100,
          height: 620,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(90,168,255,0.20) 0%, rgba(0,236,151,0.08) 45%, transparent 72%)",
          filter: "blur(36px)",
        }}
      />

      <div
        style={{
          position: "relative",
          textAlign: "center",
          transform: `scale(${(0.94 + 0.06 * lockIn) * creep})`,
          opacity: lockIn,
          padding: "0 80px",
        }}
      >
        <div
          style={{
            display: "inline-block",
            padding: "8px 20px",
            borderRadius: 999,
            backgroundColor: "rgba(0, 236, 151, 0.14)",
            border: "1px solid rgba(0, 236, 151, 0.45)",
            fontFamily: MONO,
            fontSize: 15,
            fontWeight: 700,
            color: "#00EC97",
            letterSpacing: "0.10em",
          }}
        >
          13 NEAR TRACKS · OUTLAYER TDX · 1CLICK INTENTS · ML-DSA-65
        </div>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 12, marginTop: 26 }}>
          <span style={{ fontFamily: BRAND, fontSize: 118, fontWeight: 700, color: "#FFFFFF", letterSpacing: "-0.04em" }}>
            Agentes
          </span>
          <span style={{ fontFamily: DOTO, fontSize: 106, fontWeight: 700, color: "#00EC97" }}>
            NEAR
          </span>
        </div>

        <div style={{ marginTop: 14, fontFamily: INTER_TIGHT, fontSize: 34, fontWeight: 600, color: "#CBD5E1" }}>
          Slack for Teams + AI Agents · Interactive Motion Studio Live at /ocelli
        </div>

        <div
          style={{
            display: "inline-block",
            marginTop: 34,
            padding: "14px 30px",
            borderRadius: 14,
            backgroundColor: "rgba(255, 255, 255, 0.06)",
            border: "1px solid rgba(255, 255, 255, 0.18)",
            fontFamily: MONO,
            fontSize: 22,
            color: "#F4F6FB",
          }}
        >
          MIT License · github.com/harrymove-ctrl/agentes-near
        </div>
      </div>
    </div>
  );
};

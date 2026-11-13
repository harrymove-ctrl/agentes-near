import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ANTON, INTER_TIGHT, MONO } from "./shared";

interface ActProps {
  durationInFrames: number;
}

/**
 * Embossed Black Label-Maker Tape printing letter-by-letter
 */
const LabelTape: React.FC<{
  text: string;
  charsVisible: number;
  rotate?: number;
  fontSize?: number;
}> = ({ text, charsVisible, rotate = -2, fontSize = 36 }) => {
  const shown = text.slice(0, Math.max(0, Math.min(text.length, charsVisible)));
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 3,
        padding: "10px 18px",
        backgroundColor: "#141414",
        borderRadius: 4,
        borderTop: "2px solid #3A3A38",
        borderBottom: "3px solid #050505",
        boxShadow: "4px 6px 0px rgba(20,20,20,0.35)",
        transform: `rotate(${rotate}deg)`,
      }}
    >
      {shown.split("").map((ch, idx) => (
        <span
          key={idx}
          style={{
            fontFamily: MONO,
            fontSize,
            fontWeight: 700,
            color: "#F6F0E2",
            textShadow: "0 -1px 0 rgba(255,255,255,0.45), 0 1px 0 #000",
            letterSpacing: "0.08em",
          }}
        >
          {ch === " " ? "\u00A0" : ch}
        </span>
      ))}
    </div>
  );
};

/**
 * Jagged Torn SVG Paper Edge Overlay
 */
const TornPaperEdge: React.FC<{ fill: string; flip?: boolean }> = ({ fill, flip }) => (
  <svg
    viewBox="0 0 1920 80"
    preserveAspectRatio="none"
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      top: flip ? undefined : 0,
      bottom: flip ? 0 : undefined,
      width: "100%",
      height: 54,
      transform: flip ? "scaleY(-1)" : undefined,
      pointerEvents: "none",
    }}
  >
    <path
      d="M0,0 L1920,0 L1920,42 L1830,68 L1740,28 L1620,62 L1500,34 L1380,72 L1260,30 L1140,66 L1020,24 L900,64 L780,32 L660,70 L540,26 L420,62 L300,34 L180,68 L70,28 L0,52 Z"
      fill={fill}
    />
  </svg>
);

/**
 * Act 6 (55..67s): "Agentes NEAR · OutLayer TDX Vault" — 12s Paper Collage Stop-Motion @ 120 BPM, 12fps On-Twos!
 * Strict palette: #F05A28, #3BA55C, #141414, Cream #F6F0E2, Kraft #C89D66
 * Quantized strictly to 12fps (`Math.floor(frame / 5)`).
 */
export const Act6Molote: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Quantize to 12fps On-Twos!
  const qFrame = Math.floor(frame / 5) * 5;
  const actualDur = durationInFrames / fps;
  const t = (qFrame / fps) * (12.0 / actualDur);

  const HalftoneOverlay = () => (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: "radial-gradient(rgba(20,20,20,0.14) 2px, transparent 2px)",
        backgroundSize: "14px 14px",
        pointerEvents: "none",
      }}
    />
  );

  // Beat 1 (0..3s): Orange + Kraft collage + stars + TDX Vault cutout + AGENTES NEAR / OUTLAYER TDX tape
  if (t < 3.0) {
    const step = Math.floor(t * 4);
    const wiggle = (step % 2 === 0 ? 1 : -1) * 1.8;
    const c1 = Math.floor((t - 0.3) * 16);
    const c2 = Math.floor((t - 1.0) * 16);

    return (
      <div style={{ position: "absolute", inset: 0, backgroundColor: "#F05A28", overflow: "hidden" }}>
        <HalftoneOverlay />
        {/* Kraft paper diagonal slab */}
        <div
          style={{
            position: "absolute",
            left: -120,
            top: 180,
            width: 1180,
            height: 760,
            backgroundColor: "#C89D66",
            transform: `rotate(${-6 + wiggle * 0.4}deg)`,
            border: "5px solid #141414",
            boxShadow: "16px 16px 0px #141414",
          }}
        />
        <TornPaperEdge fill="#F6F0E2" />

        {/* Paper Stars */}
        {[
          { x: 180, y: 180, s: 1.1, col: "#F6F0E2" },
          { x: 1560, y: 210, s: 1.3, col: "#3BA55C" },
          { x: 1480, y: 780, s: 0.9, col: "#F6F0E2" },
        ].map((st, idx) => (
          <div
            key={idx}
            style={{
              position: "absolute",
              left: st.x,
              top: st.y,
              fontSize: 96 * st.s,
              color: st.col,
              transform: `rotate(${(step + idx) * 12}deg)`,
              textShadow: "4px 4px 0px #141414",
            }}
          >
            ★
          </div>
        ))}

        {/* White-bordered OutLayer TDX Vault Cutout */}
        <div
          style={{
            position: "absolute",
            left: 1190,
            top: 520,
            width: 540,
            height: 540,
            transform: `translate(-50%, -50%) rotate(${wiggle * 1.4}deg)`,
            filter: "drop-shadow(0 0 0 #F6F0E2) drop-shadow(12px 12px 0 #141414)",
          }}
        >
          <Img src={staticFile("photos/speaker-cutout.png")} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </div>

        {/* Embossed Label-Maker Tapes */}
        <div style={{ position: "absolute", left: 130, top: 340, display: "flex", flexDirection: "column", gap: 22 }}>
          <LabelTape text="AGENTES NEAR" charsVisible={c1} rotate={-3} fontSize={58} />
          <LabelTape text="OUTLAYER TDX" charsVisible={c2} rotate={2} fontSize={52} />
        </div>
      </div>
    );
  }

  // Beat 2 (3..6s): Cream + multi-paper S A F E + TDX Vault + stepped pulses + $25/TX CAP · $45 BLOCKED
  if (t < 6.0) {
    const localT = t - 3.0;
    const step = Math.floor(localT * 4);
    const wavePulse = 1 + (step % 2) * 0.14;
    const letters = [
      { ch: "S", bg: "#F05A28", fg: "#F6F0E2", rot: -5 },
      { ch: "A", bg: "#3BA55C", fg: "#F6F0E2", rot: 4 },
      { ch: "F", bg: "#C89D66", fg: "#141414", rot: -3 },
      { ch: "E", bg: "#141414", fg: "#F6F0E2", rot: 5 },
    ];
    return (
      <div style={{ position: "absolute", inset: 0, backgroundColor: "#F6F0E2", overflow: "hidden" }}>
        <HalftoneOverlay />
        <TornPaperEdge fill="#3BA55C" flip />

        {/* Multi-paper S A F E */}
        <div style={{ position: "absolute", left: 120, top: 180, display: "flex", gap: 20 }}>
          {letters.map((lt, idx) => (
            <div
              key={lt.ch}
              style={{
                width: 195,
                height: 260,
                backgroundColor: lt.bg,
                border: "5px solid #141414",
                boxShadow: "10px 10px 0px #141414",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: ANTON,
                fontSize: 175,
                color: lt.fg,
                transform: `rotate(${lt.rot + (step % 2 === 0 ? 1.5 : -1.5) * (idx % 2 === 0 ? 1 : -1)}deg)`,
              }}
            >
              {lt.ch}
            </div>
          ))}
        </div>

        {/* Stepped Enclave Waves + TDX Vault */}
        <div
          style={{
            position: "absolute",
            right: 260,
            top: 520,
            transform: `translate(0, -50%) scale(${wavePulse})`,
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div style={{ width: 390, height: 390 }}>
            <Img src={staticFile("photos/speaker-cutout.png")} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {[90, 150, 210].map((h, i) => (
              <div
                key={i}
                style={{
                  width: 22,
                  height: h,
                  backgroundColor: i % 2 === 0 ? "#F05A28" : "#3BA55C",
                  border: "4px solid #141414",
                }}
              />
            ))}
          </div>
        </div>

        <div style={{ position: "absolute", left: 130, bottom: 160 }}>
          <LabelTape text="$25/TX CAP · $45 BLOCKED" charsVisible={Math.floor(localT * 18)} rotate={-2} fontSize={40} />
        </div>
      </div>
    );
  }

  // Beat 3 (6..9s): Green + taped live workspace Polaroid + "Zero key leaks!" + 1CLICK SOLVERS / ML-DSA-65 PQ
  if (t < 9.0) {
    const localT = t - 6.0;
    const step = Math.floor(localT * 4);
    return (
      <div style={{ position: "absolute", inset: 0, backgroundColor: "#3BA55C", overflow: "hidden" }}>
        <HalftoneOverlay />
        <TornPaperEdge fill="#F05A28" />

        {/* Taped Live Agentes NEAR Polaroid */}
        <div
          style={{
            position: "absolute",
            left: 140,
            top: 170,
            width: 820,
            backgroundColor: "#F6F0E2",
            padding: "24px 24px 68px",
            border: "5px solid #141414",
            boxShadow: "16px 16px 0px #141414",
            transform: `rotate(${-3 + (step % 2) * 1.2}deg)`,
          }}
        >
          {/* Kraft Masking Tape Corners */}
          <div
            style={{
              position: "absolute",
              top: -24,
              left: 80,
              width: 180,
              height: 48,
              backgroundColor: "#C89D66",
              border: "3px solid #141414",
              transform: "rotate(-12deg)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: -22,
              right: 80,
              width: 180,
              height: 48,
              backgroundColor: "#C89D66",
              border: "3px solid #141414",
              transform: "rotate(10deg)",
            }}
          />
          <div style={{ height: 540, overflow: "hidden", border: "3px solid #141414" }}>
            <Img src={staticFile("photos/friends-photo.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        </div>

        {/* Speech Bubbles + Label Tape Specs */}
        <div style={{ position: "absolute", right: 120, top: 240, display: "flex", flexDirection: "column", gap: 34, alignItems: "flex-end" }}>
          <div
            style={{
              padding: "22px 34px",
              backgroundColor: "#F6F0E2",
              border: "5px solid #141414",
              borderRadius: 26,
              boxShadow: "10px 10px 0px #141414",
              fontFamily: INTER_TIGHT,
              fontSize: 42,
              fontWeight: 800,
              color: "#141414",
              transform: `rotate(${step % 2 === 0 ? 2 : -1}deg)`,
            }}
          >
            Zero key leaks!
          </div>
          <LabelTape text="1CLICK SOLVERS" charsVisible={Math.floor(localT * 15)} rotate={-3} fontSize={42} />
          <LabelTape text="ML-DSA-65 PQ" charsVisible={Math.floor((localT - 0.6) * 15)} rotate={2} fontSize={42} />
        </div>
      </div>
    );
  }

  // Beat 4 (9..12s): Orange + cream band + SHIP + v2.0 + TDX Vault + 13 NEAR TRACKS
  const localT = t - 9.0;
  const step = Math.floor(localT * 4);
  return (
    <div style={{ position: "absolute", inset: 0, backgroundColor: "#F05A28", overflow: "hidden" }}>
      <HalftoneOverlay />
      {/* Cream Band */}
      <div
        style={{
          position: "absolute",
          left: -40,
          right: -40,
          top: 320,
          height: 410,
          backgroundColor: "#F6F0E2",
          borderTop: "6px solid #141414",
          borderBottom: "6px solid #141414",
          transform: `rotate(${-2 + (step % 2) * 0.6}deg)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 140px",
        }}
      >
        <div>
          <div style={{ fontFamily: MONO, fontSize: 32, fontWeight: 700, color: "#3BA55C", letterSpacing: "0.14em" }}>
            SHIP
          </div>
          <div style={{ fontFamily: ANTON, fontSize: 220, lineHeight: 0.88, color: "#141414" }}>
            v2.0
          </div>
        </div>
        <div style={{ width: 290, height: 290, transform: `rotate(${step % 2 === 0 ? 6 : -4}deg)` }}>
          <Img src={staticFile("photos/speaker-cutout.png")} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </div>
      </div>

      <div style={{ position: "absolute", left: "50%", bottom: 110, transform: "translateX(-50%)" }}>
        <LabelTape text="13 NEAR TRACKS" charsVisible={Math.floor(localT * 16)} rotate={-2} fontSize={44} />
      </div>
    </div>
  );
};

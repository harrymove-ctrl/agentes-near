import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { INTER_TIGHT, MONO, clamp01, expoOut, quartOut } from "./shared";

interface ActProps {
  durationInFrames: number;
}

/**
 * Act 5 (45..55s): "AI Assistant Tool Graph"
 * Clean dark #0D1017 UI:
 * - Assistant bar rises -> connector expands into central hub
 * - 5 tool nodes ([Images], [1Click Swap], [OutLayer TDX], [Terrace Bet], [x402 Compute]) burst outward
 * - Glowing pulses travel along every line
 * - [Images] opens into detailed preview card with live visual preview & description
 */
export const Act5Graph: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const actualDur = durationInFrames / fps;
  const t = (frame / fps) * (10.0 / actualDur);

  const barRise = expoOut(clamp01(t / 0.6));
  const hubOpen = expoOut(clamp01((t - 0.9) / 0.65));
  const burst = expoOut(clamp01((t - 1.7) / 0.85));
  const pulsePhase = clamp01((t - 2.6) / 2.8);
  const cardOpen = expoOut(clamp01((t - 5.2) / 0.8));

  const hubX = 960;
  const hubY = 470 - cardOpen * 70;

  const nodes = [
    { id: "images", label: "[Images]", sub: "Lookbook + Plates", x: 380, y: 260, accent: "#5AA8FF" },
    { id: "swap", label: "[1Click Swap]", sub: "Multi-Solver Route", x: 350, y: 650, accent: "#00EC97" },
    { id: "tdx", label: "[OutLayer TDX]", sub: "$25/tx Cap Guard", x: 960, y: 170, accent: "#00EC97" },
    { id: "bet", label: "[Terrace Bet]", sub: "wNEAR Conviction", x: 1540, y: 260, accent: "#F2B01E" },
    { id: "x402", label: "[x402 Compute]", sub: "$1.84/hr H100", x: 1550, y: 650, accent: "#FF4FA3" },
  ];

  const promptText = "Agentes NEAR: orchestrate 1Click swap under $25 TDX cap & render Lookbook";
  const typedLen = Math.min(promptText.length, Math.floor(clamp01(t / 1.3) * promptText.length));

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: "#0D1017",
        overflow: "hidden",
      }}
    >
      {/* Subtle Blueprint Dot Grid */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      {/* SVG Edges + Glowing Energy Pulses */}
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {/* Assistant Bar -> Hub Connector */}
        <line
          x1={960}
          y1={890}
          x2={hubX}
          y2={890 - (890 - hubY) * hubOpen}
          stroke="#5AA8FF"
          strokeWidth="3"
          strokeOpacity={0.75}
        />

        {nodes.map((nd, idx) => {
          const nx = hubX + (nd.x - hubX) * burst;
          const ny = hubY + (nd.y - hubY) * burst;
          const pulseU = (pulsePhase * 2.4 + idx * 0.18) % 1;
          const px = hubX + (nx - hubX) * pulseU;
          const py = hubY + (ny - hubY) * pulseU;

          return (
            <g key={nd.id}>
              <line
                x1={hubX}
                y1={hubY}
                x2={nx}
                y2={ny}
                stroke={nd.accent}
                strokeWidth="2.5"
                strokeOpacity={0.42 * burst}
              />
              {t >= 2.6 && burst > 0.8 ? (
                <>
                  <circle cx={px} cy={py} r={11} fill={nd.accent} fillOpacity={0.28} />
                  <circle cx={px} cy={py} r={5} fill="#FFFFFF" />
                </>
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* Central AI Hub */}
      {t >= 0.9 ? (
        <div
          style={{
            position: "absolute",
            left: hubX,
            top: hubY,
            transform: `translate(-50%, -50%) scale(${hubOpen})`,
            padding: "22px 34px",
            borderRadius: 20,
            backgroundColor: "#141A26",
            border: "2px solid #5AA8FF",
            boxShadow: "0 0 64px rgba(90, 168, 255, 0.30)",
            textAlign: "center",
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 12, color: "#00EC97", letterSpacing: "0.08em" }}>
            DEEPSEEK-V4.1 TEE · ORCHESTRATOR
          </div>
          <div style={{ marginTop: 6, fontFamily: INTER_TIGHT, fontSize: 28, fontWeight: 800, color: "#F4F6FB" }}>
            @ada Tool Hub
          </div>
        </div>
      ) : null}

      {/* 5 Bursting Tool Nodes */}
      {nodes.map((nd, idx) => {
        const nx = hubX + (nd.x - hubX) * burst;
        const ny = hubY + (nd.y - hubY) * burst;
        const isImages = idx === 0;
        const glow = isImages && cardOpen > 0.2 ? `0 0 42px ${nd.accent}66` : "0 14px 32px rgba(0,0,0,0.45)";
        return (
          <div
            key={nd.id}
            style={{
              position: "absolute",
              left: nx,
              top: ny,
              transform: `translate(-50%, -50%) scale(${0.4 + 0.6 * burst})`,
              opacity: burst,
              padding: "16px 22px",
              borderRadius: 14,
              backgroundColor: "#131722",
              border: `1.5px solid ${nd.accent}`,
              boxShadow: glow,
              minWidth: 230,
            }}
          >
            <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: nd.accent }}>{nd.label}</div>
            <div style={{ fontFamily: INTER_TIGHT, fontSize: 14, color: "#CBD5E1", marginTop: 4 }}>{nd.sub}</div>
          </div>
        );
      })}

      {/* Detailed [Images] Preview Card Opening Smoothly */}
      {t >= 5.2 ? (
        <div
          style={{
            position: "absolute",
            left: 160,
            top: 340,
            width: 560,
            backgroundColor: "#141923",
            border: "2px solid #5AA8FF",
            borderRadius: 20,
            padding: 22,
            boxShadow: "0 28px 80px rgba(0,0,0,0.68)",
            transform: `translateY(${(1 - cardOpen) * 40}px) scale(${0.86 + 0.14 * cardOpen})`,
            opacity: cardOpen,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: "#5AA8FF" }}>
              [Images] · LIVE ASSET OUTPUT
            </span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: "#00EC97" }}>ML-DSA-65 SIGNED</span>
          </div>
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ height: 190, borderRadius: 12, overflow: "hidden" }}>
              <Img src={staticFile("photos/look-1-butter.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
            <div style={{ height: 190, borderRadius: 12, overflow: "hidden" }}>
              <Img src={staticFile("photos/look-3-terracotta.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          </div>
          <div style={{ marginTop: 14, fontFamily: INTER_TIGHT, fontSize: 18, fontWeight: 600, color: "#F4F6FB" }}>
            Campaign lookbook plates rendered inside OutLayer enclave with verified x402 compute receipt.
          </div>
        </div>
      ) : null}

      {/* Bottom AI Assistant Prompt Bar */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 64,
          width: 1080,
          transform: `translate(-50%, ${(1 - barRise) * 140}px)`,
          opacity: barRise,
          padding: "20px 28px",
          borderRadius: 18,
          backgroundColor: "#141822",
          border: "1.5px solid rgba(90, 168, 255, 0.55)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.65)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 18,
        }}
      >
        <div style={{ fontFamily: MONO, fontSize: 18, color: "#F4F6FB" }}>
          <span style={{ color: "#00EC97", marginRight: 10 }}>&gt;</span>
          {promptText.slice(0, typedLen)}
        </div>
        <div
          style={{
            padding: "8px 16px",
            borderRadius: 10,
            backgroundColor: "#5AA8FF",
            color: "#05060A",
            fontFamily: MONO,
            fontSize: 13,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          5 TOOLS ACTIVE
        </div>
      </div>
    </div>
  );
};

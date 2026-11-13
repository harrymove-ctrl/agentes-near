import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ANTON, CursorArrow, INTER_TIGHT, MONO, SERIF_ITALIC, clamp01, expoOut, quartOut } from "./shared";

interface ActProps {
  durationInFrames: number;
}

/**
 * Act 3 (20..30s): "Agentes 2.0" — 10s Intent-to-Timeline Flow (116 BPM)
 * Strict flat palette: Navy #16233F, Bone #F2EEE5, Magenta #C2185B, Sun #F2B01E
 */
export const Act3Cutline: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const actualDur = durationInFrames / fps;
  const t = (frame / fps) * (10.0 / actualDur);

  // Giant cropped "SHIP" drifting behind
  const cutDriftX = -120 + t * 28;

  if (t < 4.8) {
    const c1 = expoOut(clamp01(t / 0.32));
    const c2 = expoOut(clamp01((t - 0.15) / 0.32));
    const c3 = expoOut(clamp01((t - 0.30) / 0.32));
    const c4 = expoOut(clamp01((t - 0.45) / 0.32));
    const cursorMove = quartOut(clamp01((t - 0.85) / 0.65));
    const runClicked = t >= 1.6;
    const ripple = clamp01((t - 1.6) / 0.45);
    const wire1 = quartOut(clamp01((t - 2.0) / 0.65));
    const wire2 = quartOut(clamp01((t - 2.5) / 0.65));
    const isDone = t >= 3.4;
    const zoomPush = quartOut(clamp01((t - 4.15) / 0.65));

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "#F2EEE5",
          overflow: "hidden",
          transform: `scale(${1 + zoomPush * 1.4})`,
          filter: zoomPush > 0.1 ? `blur(${Math.round(zoomPush * 8)}px)` : undefined,
        }}
      >
        {/* Giant Cropped SHIP Background */}
        <div
          style={{
            position: "absolute",
            left: cutDriftX,
            top: -80,
            fontFamily: ANTON,
            fontSize: 640,
            lineHeight: 0.85,
            color: "rgba(22, 35, 63, 0.08)",
            userSelect: "none",
          }}
        >
          SHIP
        </div>

        {/* SVG Magenta Connections */}
        <svg
          width="1920"
          height="1080"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <path
            d="M 540 340 C 700 340, 700 500, 860 500"
            fill="none"
            stroke="#C2185B"
            strokeWidth="8"
            strokeDasharray="480"
            strokeDashoffset={480 * (1 - wire1)}
          />
          <path
            d="M 540 720 C 700 720, 700 560, 860 560"
            fill="none"
            stroke="#C2185B"
            strokeWidth="8"
            strokeDasharray="480"
            strokeDashoffset={480 * (1 - wire1)}
          />
          <path
            d="M 1180 530 C 1300 530, 1320 530, 1420 530"
            fill="none"
            stroke="#F2B01E"
            strokeWidth="8"
            strokeDasharray="300"
            strokeDashoffset={300 * (1 - wire2)}
          />
        </svg>

        {/* Left Node Cards: Live Agentes NEAR Thumbnails + Waveform */}
        <div
          style={{
            position: "absolute",
            left: 160 - (1 - c1) * 260,
            top: 170,
            width: 380,
            backgroundColor: "#16233F",
            color: "#F2EEE5",
            borderRadius: 18,
            padding: 18,
            border: "4px solid #16233F",
            boxShadow: "10px 10px 0px #F2B01E",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {["photos/thumb-skyline.jpg", "photos/thumb-skate.jpg", "photos/thumb-cooking.jpg"].map(
              (src) => (
                <div key={src} style={{ height: 82, borderRadius: 8, overflow: "hidden" }}>
                  <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
              )
            )}
          </div>
          <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 13 }}>
            <span style={{ color: "#F2B01E" }}>WORKSPACE · 3 CHANNELS</span>
            <span>LIVE TEE</span>
          </div>
        </div>

        {/* Waveform Card + 1CLICK + TDX GUARD */}
        <div
          style={{
            position: "absolute",
            left: 160 - (1 - c2) * 260,
            top: 560,
            width: 380,
            backgroundColor: "#F2EEE5",
            border: "4px solid #16233F",
            borderRadius: 18,
            padding: "20px 22px",
            boxShadow: "10px 10px 0px #C2185B",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: INTER_TIGHT, fontSize: 22, fontWeight: 800, color: "#16233F" }}>
              1CLICK + TDX GUARD
            </span>
            <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "#C2185B" }}>
              $25 CAP
            </span>
          </div>
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 5, height: 52 }}>
            {[0.4, 0.85, 0.55, 1.0, 0.72, 0.92, 0.48, 0.95, 0.65, 0.88, 0.5, 0.76, 0.42].map(
              (h, idx) => (
                <div
                  key={idx}
                  style={{
                    flex: 1,
                    height: `${Math.round(h * 100)}%`,
                    backgroundColor: idx % 3 === 0 ? "#C2185B" : "#16233F",
                    borderRadius: 3,
                  }}
                />
              )
            )}
          </div>
        </div>

        {/* Navy-on-Sun "A" Sticker */}
        <div
          style={{
            position: "absolute",
            left: 690,
            top: 150 - (1 - c3) * 140,
            width: 112,
            height: 112,
            borderRadius: 24,
            backgroundColor: "#F2B01E",
            border: "4px solid #16233F",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: ANTON,
            fontSize: 72,
            color: "#16233F",
            transform: "rotate(-8deg)",
          }}
        >
          A
        </div>

        {/* Central Run Hub Node */}
        <div
          style={{
            position: "absolute",
            left: 860,
            top: 410 + (1 - c3) * 140,
            width: 320,
            backgroundColor: "#16233F",
            color: "#F2EEE5",
            borderRadius: 20,
            padding: "24px 26px",
            boxShadow: "12px 12px 0px #F2B01E",
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 12, color: "#F2B01E" }}>AGENTES ENGINE</div>
          <div style={{ marginTop: 6, fontFamily: INTER_TIGHT, fontSize: 28, fontWeight: 800 }}>
            Intent Execution
          </div>
          <div style={{ marginTop: 18, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div
              style={{
                position: "relative",
                padding: "10px 24px",
                borderRadius: 999,
                backgroundColor: isDone ? "#F2B01E" : runClicked ? "#C2185B" : "#F2EEE5",
                color: isDone ? "#16233F" : runClicked ? "#F2EEE5" : "#16233F",
                fontFamily: INTER_TIGHT,
                fontSize: 18,
                fontWeight: 800,
              }}
            >
              {isDone ? "DONE ✓" : runClicked ? "RUNNING" : "Run"}
              {runClicked && ripple < 1 ? (
                <div
                  style={{
                    position: "absolute",
                    inset: -ripple * 24,
                    borderRadius: 999,
                    border: "3px solid #C2185B",
                    opacity: 1 - ripple,
                  }}
                />
              ) : null}
            </div>
            <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: "#F2EEE5" }}>
              {isDone ? "13/13" : runClicked ? `${Math.round(wire1 * 13)}/13` : "00/13"}
            </span>
          </div>
        </div>

        {/* Output Preview Node */}
        <div
          style={{
            position: "absolute",
            left: 1420 + (1 - c4) * 260,
            top: 390,
            width: 340,
            backgroundColor: "#F2EEE5",
            border: "4px solid #16233F",
            borderRadius: 18,
            padding: 18,
            boxShadow: "12px 12px 0px #16233F",
          }}
        >
          <div style={{ height: 180, borderRadius: 10, overflow: "hidden" }}>
            <Img
              src={staticFile("photos/thumb-pier.jpg")}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </div>
          <div style={{ marginTop: 12, fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "#16233F" }}>
            AGENTES NEAR · LIVE WORKSPACE
          </div>
        </div>

        <CursorArrow
          x={640 + cursorMove * 280}
          y={760 - cursorMove * 210}
          color="#C2185B"
          scale={1.1}
        />
      </div>
    );
  }

  // Magenta block wipe transition (4.8..5.6s)
  if (t < 5.6) {
    const wipe = quartOut(clamp01((t - 4.8) / 0.6));
    return (
      <div style={{ position: "absolute", inset: 0, backgroundColor: "#16233F" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "#C2185B",
            transform: `translateX(${(wipe - 0.5) * 180}px)`,
          }}
        />
      </div>
    );
  }

  // 5.6..8.2s: Paper unfold into 3-track timeline + live Agentes NEAR preview monitor + "v2.0" stamp
  if (t < 8.2) {
    const unfold = expoOut(clamp01((t - 5.6) / 0.55));
    const playheadPct = clamp01((t - 5.8) / 2.2);
    const stamp = expoOut(clamp01((t - 7.35) / 0.25));
    const tcFrames = Math.floor(playheadPct * 240);

    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "#16233F",
          padding: "70px 110px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          overflow: "hidden",
        }}
      >
        {/* Live Agentes NEAR Workspace Monitor */}
        <div
          style={{
            display: "flex",
            gap: 36,
            alignItems: "center",
            transform: `scale(${0.92 + 0.08 * unfold})`,
            opacity: unfold,
          }}
        >
          <div
            style={{
              width: 820,
              height: 460,
              borderRadius: 18,
              border: "5px solid #F2EEE5",
              overflow: "hidden",
              position: "relative",
              boxShadow: "14px 14px 0px #C2185B",
            }}
          >
            <Img
              src={staticFile("photos/thumb-pier.jpg")}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
            <div
              style={{
                position: "absolute",
                top: 18,
                left: 20,
                padding: "6px 14px",
                backgroundColor: "#16233F",
                color: "#F2B01E",
                fontFamily: MONO,
                fontSize: 16,
                fontWeight: 700,
                borderRadius: 8,
              }}
            >
              00:0{Math.floor(tcFrames / 60)}:{String(tcFrames % 60).padStart(2, "0")}
            </div>
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: MONO, fontSize: 16, color: "#F2B01E", letterSpacing: "0.08em" }}>
              INTENT TIMELINE · 116 BPM
            </div>
            <div style={{ marginTop: 12, fontFamily: ANTON, fontSize: 108, lineHeight: 0.9, color: "#F2EEE5" }}>
              AGENTES
            </div>
            {t >= 7.35 ? (
              <div
                style={{
                  display: "inline-block",
                  marginTop: 18,
                  padding: "10px 26px",
                  backgroundColor: "#F2B01E",
                  color: "#16233F",
                  fontFamily: ANTON,
                  fontSize: 56,
                  borderRadius: 12,
                  transform: `scale(${stamp}) rotate(-4deg)`,
                }}
              >
                v2.0
              </div>
            ) : null}
          </div>
        </div>

        {/* 3-Track Intent & Enclave Timeline Editor */}
        <div
          style={{
            position: "relative",
            backgroundColor: "#F2EEE5",
            borderRadius: 18,
            padding: "24px 28px",
            border: "4px solid #F2EEE5",
            transform: `scaleY(${unfold})`,
            transformOrigin: "top center",
          }}
        >
          {/* Playhead */}
          <div
            style={{
              position: "absolute",
              left: `calc(28px + ${Math.round(playheadPct * 94)}%)`,
              top: 10,
              bottom: 10,
              width: 5,
              backgroundColor: "#C2185B",
              zIndex: 10,
            }}
          />
          {[
            { label: "1CLK", color: "#16233F", widths: ["26%", "34%", "36%"] },
            { label: "TDX", color: "#C2185B", widths: ["18%", "42%", "32%"] },
            { label: "PQ", color: "#F2B01E", widths: ["94%"] },
          ].map((tr) => (
            <div key={tr.label} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
              <span style={{ width: 54, fontFamily: MONO, fontSize: 14, fontWeight: 700, color: "#16233F" }}>
                {tr.label}
              </span>
              <div style={{ flex: 1, display: "flex", gap: 10 }}>
                {tr.widths.map((w, idx) => (
                  <div
                    key={idx}
                    style={{
                      width: w,
                      height: 44,
                      borderRadius: 8,
                      backgroundColor: tr.color,
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 8.2..10.0s: Final Poster ("SHIP", "Agentes 2.0", Instrument Serif Italic "released")
  const p = expoOut(clamp01((t - 8.2) / 0.45));
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: "#16233F",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          fontFamily: ANTON,
          fontSize: 680,
          color: "#C2185B",
          opacity: 0.25,
          transform: `scale(${0.92 + 0.08 * p})`,
        }}
      >
        SHIP
      </div>
      <div
        style={{
          position: "relative",
          textAlign: "center",
          transform: `translateY(${(1 - p) * 32}px)`,
          opacity: p,
        }}
      >
        <div style={{ fontFamily: ANTON, fontSize: 168, lineHeight: 0.92, color: "#F2EEE5" }}>
          Agentes 2.0
        </div>
        <div
          style={{
            marginTop: 8,
            fontFamily: SERIF_ITALIC,
            fontStyle: "italic",
            fontSize: 108,
            color: "#F2B01E",
          }}
        >
          released
        </div>
      </div>
    </div>
  );
};

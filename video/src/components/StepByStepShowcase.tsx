import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import {
  ANTON,
  CursorArrow,
  INTER_TIGHT,
  MONO,
  clamp01,
  expoOut,
  quartOut,
} from "./acts/shared";

export interface ShowcaseStep {
  badge: string;
  title: string;
  image: string;
  metric: string;
  whatItIs: string;
  whyItHelps: string;
  cursorTarget: [number, number];
}

export interface ShowcaseConfig {
  chapterBadge: string;
  headline: string;
  accent: string;
  bgStyle: string;
  steps: [ShowcaseStep, ShowcaseStep, ShowcaseStep] | ShowcaseStep[];
}

interface StepByStepShowcaseProps {
  durationInFrames: number;
  config: ShowcaseConfig;
}

const BG_THEMES: Record<string, { bg: string; glow1: string; glow2: string }> = {
  obsidian: {
    bg: "#090D16",
    glow1: "rgba(56, 189, 248, 0.18)",
    glow2: "rgba(0, 236, 151, 0.12)",
  },
  emerald: {
    bg: "#071312",
    glow1: "rgba(0, 236, 151, 0.20)",
    glow2: "rgba(56, 189, 248, 0.14)",
  },
  cobalt: {
    bg: "#0A1022",
    glow1: "rgba(56, 189, 248, 0.22)",
    glow2: "rgba(46, 75, 255, 0.18)",
  },
  amber: {
    bg: "#120F0A",
    glow1: "rgba(245, 158, 11, 0.20)",
    glow2: "rgba(0, 236, 151, 0.12)",
  },
  magenta: {
    bg: "#130B16",
    glow1: "rgba(236, 72, 153, 0.20)",
    glow2: "rgba(245, 158, 11, 0.14)",
  },
  violet: {
    bg: "#0E0B1A",
    glow1: "rgba(168, 85, 247, 0.22)",
    glow2: "rgba(56, 189, 248, 0.14)",
  },
};

export const StepByStepShowcase: React.FC<StepByStepShowcaseProps> = ({
  durationInFrames,
  config,
}) => {
  const frame = useCurrentFrame();
  const steps = config.steps;
  const stepCount = Math.max(1, steps.length);
  const framesPerStep = durationInFrames / stepCount;
  const activeIdx = Math.min(stepCount - 1, Math.floor(frame / framesPerStep));
  const stepLocalFrame = frame - activeIdx * framesPerStep;
  const stepProgress = clamp01(stepLocalFrame / Math.max(1, framesPerStep));

  const enter = expoOut(clamp01(stepLocalFrame / 14));
  const clickRipple = clamp01((stepLocalFrame - 16) / 18);

  const activeStep = steps[activeIdx] || steps[0];
  const prevStep = steps[Math.max(0, activeIdx - 1)] || activeStep;
  const theme = BG_THEMES[config.bgStyle] || BG_THEMES.obsidian;

  // Smooth cursor interpolation from previous target to active target
  const moveU = quartOut(clamp01(stepLocalFrame / 18));
  const startX = activeIdx === 0 ? 960 : prevStep.cursorTarget[0];
  const startY = activeIdx === 0 ? 640 : prevStep.cursorTarget[1];
  const cursorX = startX + (activeStep.cursorTarget[0] - startX) * moveU;
  const cursorY = startY + (activeStep.cursorTarget[1] - startY) * moveU;

  // Subtle 3D tilt & zoom-pan on the macOS stage window
  const rotY = -8 + Math.sin(stepProgress * Math.PI) * 3.5;
  const rotX = 4 - Math.cos(stepProgress * Math.PI) * 2.0;
  const zoom = 1.0 + 0.04 * enter;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: theme.bg,
        overflow: "hidden",
        padding: "46px 76px 148px 76px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      {/* Bayer Blueprint Grid + Ambient Glows */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: -120,
          top: -140,
          width: 720,
          height: 720,
          borderRadius: "50%",
          backgroundColor: theme.glow1,
          filter: "blur(110px)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: -120,
          bottom: -140,
          width: 680,
          height: 680,
          borderRadius: "50%",
          backgroundColor: theme.glow2,
          filter: "blur(110px)",
          pointerEvents: "none",
        }}
      />

      {/* Top Chapter Header + 3-Step Progress Rail */}
      <div
        style={{
          position: "relative",
          zIndex: 5,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 28,
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "6px 14px",
              borderRadius: 999,
              backgroundColor: "rgba(255,255,255,0.06)",
              border: `1.5px solid ${config.accent}`,
              fontFamily: MONO,
              fontSize: 13,
              fontWeight: 700,
              color: config.accent,
              letterSpacing: "0.08em",
            }}
          >
            <span>●</span>
            <span>{config.chapterBadge}</span>
          </div>
          <div
            style={{
              marginTop: 10,
              fontFamily: INTER_TIGHT,
              fontSize: 40,
              fontWeight: 800,
              color: "#F8FAFC",
              letterSpacing: "-0.02em",
            }}
          >
            {config.headline}
          </div>
        </div>

        {/* 3-Step Horizontal Progress Rail */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {steps.map((st, idx) => {
            const isCurrent = idx === activeIdx;
            const isDone = idx < activeIdx;
            return (
              <div
                key={st.badge}
                style={{
                  padding: "10px 18px",
                  borderRadius: 14,
                  backgroundColor: isCurrent
                    ? config.accent
                    : isDone
                      ? "rgba(0, 236, 151, 0.14)"
                      : "rgba(255, 255, 255, 0.05)",
                  border: isCurrent
                    ? `2px solid #FFFFFF`
                    : isDone
                      ? "1.5px solid rgba(0, 236, 151, 0.55)"
                      : "1.5px solid rgba(255, 255, 255, 0.12)",
                  color: isCurrent ? "#05060A" : "#F8FAFC",
                  fontFamily: MONO,
                  fontSize: 13,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  boxShadow: isCurrent
                    ? `0 0 28px ${config.accent}66`
                    : undefined,
                }}
              >
                <span>{isDone ? "✓" : `0${idx + 1}`}</span>
                <span>{st.badge.replace(/^STEP 0\d · /, "")}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Split Stage: Left 3-Step Cards + 2-Line Explainer | Right Tilted 3D macOS Window */}
      <div
        style={{
          position: "relative",
          zIndex: 5,
          display: "grid",
          gridTemplateColumns: "1.02fr 1.18fr",
          gap: 40,
          alignItems: "center",
          flex: 1,
          marginTop: 22,
        }}
      >
        {/* Left Column: Active Step Detail + 2-Line Explainer Callout Card */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          {/* Step Stack */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {steps.map((st, idx) => {
              const isCurrent = idx === activeIdx;
              const isDone = idx < activeIdx;
              return (
                <div
                  key={st.badge}
                  style={{
                    padding: isCurrent ? "20px 24px" : "14px 20px",
                    borderRadius: 18,
                    backgroundColor: isCurrent
                      ? "rgba(20, 26, 38, 0.96)"
                      : "rgba(15, 20, 30, 0.62)",
                    border: isCurrent
                      ? `2px solid ${config.accent}`
                      : "1px solid rgba(255,255,255,0.10)",
                    boxShadow: isCurrent
                      ? `0 18px 48px rgba(0,0,0,0.55), 0 0 24px ${config.accent}33`
                      : undefined,
                    transform: isCurrent
                      ? `translateX(${(1 - enter) * -18}px)`
                      : undefined,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: MONO,
                        fontSize: 12,
                        fontWeight: 700,
                        color: isCurrent
                          ? config.accent
                          : isDone
                            ? "#00EC97"
                            : "#94A3B8",
                        letterSpacing: "0.08em",
                      }}
                    >
                      {isDone ? `✓ ${st.badge}` : st.badge}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: INTER_TIGHT,
                        fontSize: isCurrent ? 25 : 19,
                        fontWeight: 800,
                        color: isCurrent ? "#FFFFFF" : "#CBD5E1",
                      }}
                    >
                      {st.title}
                    </div>
                  </div>
                  <div
                    style={{
                      padding: "8px 14px",
                      borderRadius: 10,
                      backgroundColor: isCurrent
                        ? config.accent
                        : "rgba(255,255,255,0.07)",
                      color: isCurrent ? "#05060A" : "#E2E8F0",
                      fontFamily: MONO,
                      fontSize: 13,
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {st.metric}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 2-Line Explainer Callout Card (Line 1: What it is / Line 2: Why it helps you) */}
          <div
            style={{
              padding: "22px 26px",
              borderRadius: 20,
              backgroundColor: "rgba(13, 18, 28, 0.96)",
              border: `2px solid ${config.accent}`,
              boxShadow: "0 24px 60px rgba(0,0,0,0.65)",
              transform: `translateY(${(1 - enter) * 16}px)`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  backgroundColor: "rgba(56, 189, 248, 0.16)",
                  border: "1px solid rgba(56, 189, 248, 0.45)",
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#38BDF8",
                  flexShrink: 0,
                }}
              >
                WHAT IT IS
              </span>
              <span
                style={{
                  fontFamily: INTER_TIGHT,
                  fontSize: 19,
                  fontWeight: 600,
                  color: "#F8FAFC",
                  lineHeight: 1.32,
                }}
              >
                {activeStep.whatItIs}
              </span>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                paddingTop: 12,
                borderTop: "1px solid rgba(255,255,255,0.10)",
              }}
            >
              <span
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  backgroundColor: "rgba(0, 236, 151, 0.16)",
                  border: "1px solid rgba(0, 236, 151, 0.45)",
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#00EC97",
                  flexShrink: 0,
                }}
              >
                WHY IT HELPS YOU
              </span>
              <span
                style={{
                  fontFamily: INTER_TIGHT,
                  fontSize: 19,
                  fontWeight: 700,
                  color: "#00EC97",
                  lineHeight: 1.32,
                }}
              >
                {activeStep.whyItHelps}
              </span>
            </div>
          </div>
        </div>

        {/* Right Column: Tilted 3D macOS Window Stage with Real Product Plate */}
        <div
          style={{
            perspective: 1500,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              position: "relative",
              width: 900,
              height: 590,
              borderRadius: 24,
              backgroundColor: "#111622",
              border: `3px solid ${config.accent}`,
              boxShadow: `0 36px 90px rgba(0,0,0,0.75), 0 0 48px ${config.accent}33`,
              overflow: "hidden",
              transform: `rotateY(${rotY.toFixed(2)}deg) rotateX(${rotX.toFixed(2)}deg) scale(${zoom.toFixed(3)})`,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* macOS Dark Glass Window Bar */}
            <div
              style={{
                height: 46,
                backgroundColor: "#0B0F17",
                borderBottom: "1px solid rgba(255,255,255,0.10)",
                padding: "0 20px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    backgroundColor: "#EF4444",
                  }}
                />
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    backgroundColor: "#F59E0B",
                  }}
                />
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    backgroundColor: "#10B981",
                  }}
                />
                <span
                  style={{
                    marginLeft: 12,
                    fontFamily: MONO,
                    fontSize: 13,
                    fontWeight: 700,
                    color: "#E2E8F0",
                  }}
                >
                  agentes-near-production.up.railway.app/ocelli ·{" "}
                  {activeStep.badge}
                </span>
              </div>
              <span
                style={{
                  padding: "4px 12px",
                  borderRadius: 999,
                  backgroundColor: config.accent,
                  color: "#05060A",
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {activeStep.metric}
              </span>
            </div>

            {/* Product Plate Image Viewport */}
            <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
              <Img
                src={staticFile(activeStep.image)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  objectPosition: "center 22%",
                  transform: `scale(${(1.02 + 0.03 * stepProgress).toFixed(3)})`,
                }}
              />

              {/* Floating Verified Telemetry Pill Inside Stage */}
              <div
                style={{
                  position: "absolute",
                  right: 22,
                  bottom: 22,
                  padding: "12px 20px",
                  borderRadius: 14,
                  backgroundColor: "rgba(9, 13, 22, 0.92)",
                  border: `2px solid ${config.accent}`,
                  boxShadow: "0 16px 40px rgba(0,0,0,0.65)",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span
                  style={{
                    fontFamily: ANTON,
                    fontSize: 32,
                    color: config.accent,
                    lineHeight: 1,
                  }}
                >
                  0{activeIdx + 1}
                </span>
                <div>
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      color: "#94A3B8",
                    }}
                  >
                    VERIFIED ON NEAR + OUTLAYER TDX
                  </div>
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 16,
                      fontWeight: 700,
                      color: "#FFFFFF",
                    }}
                  >
                    {activeStep.metric}
                  </div>
                </div>
              </div>

              {/* Click Ripple + Cursor */}
              {stepLocalFrame >= 16 && clickRipple < 1 ? (
                <div
                  style={{
                    position: "absolute",
                    left: cursorX - 380,
                    top: cursorY - 190,
                    width: 24 + clickRipple * 96,
                    height: 24 + clickRipple * 96,
                    borderRadius: "50%",
                    border: `3px solid ${config.accent}`,
                    transform: "translate(-50%, -50%)",
                    opacity: 1 - clickRipple,
                    pointerEvents: "none",
                  }}
                />
              ) : null}
              <CursorArrow
                x={Math.max(120, Math.min(780, cursorX - 380))}
                y={Math.max(90, Math.min(460, cursorY - 190))}
                label={activeStep.badge.split("·")[0].trim()}
                color={config.accent}
                scale={1.08}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

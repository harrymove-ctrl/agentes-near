import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import {
  INTER_TIGHT,
  SERIF_ITALIC,
  clamp01,
  expoOut,
  quartOut,
  segProgress,
} from "./shared";

interface ActProps {
  durationInFrames: number;
}

/**
 * ActLandingFlyover3D (900-1770f @ 60fps = 14.5s):
 *
 * Fixed camera rig hierarchy (coordinator #68):
 *   - Outer viewport:  perspective: 1880px; perspectiveOrigin: "50% 50%"
 *   - Depth wrapper:   translateZ(-camDist)  — in SCREEN space, applied BEFORE rotateX
 *   - Plane wrapper:   rotateX(tiltDeg)      — tilt applied to the page plane
 *   - Page content:    scrollY scroll during 0..7.75s
 *
 * Tilt schedule (fixed — stays at 0° after 9.47s, never jumps back to 58°):
 *   0..7.75s:  56° (dramatic fly-over approach)
 *   7.75..9.25s: 56° -> 0° (rise/flatten, quartOut)
 *   9.25..9.47s: 0° overhead strip
 *   9.47..14.5s: 0° pinned flat (hero card centered)
 *
 * Page is clearly framed in camera from t=0 onward (translateZ push is screen-space only).
 *
 * Assets: use real flyover/ PNGs when available, fall through to code plates if missing.
 */
export const ActLandingFlyover3D: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Remap to virtual 14.5s timeline
  const t = (frame / fps) * (14.5 / (durationInFrames / fps));

  // Camera distance: 1360 -> 1700px over 0..7.75s (slow-fast-slow)
  const camProgress = quartOut(clamp01(t / 7.75));
  const camDist = 1360 + camProgress * 340; // 1360 -> 1700px

  // Camera tilt — FIXED: stays at 0° after 9.47s, never jumps back up
  let tiltDeg = 56;
  if (t >= 7.75 && t < 9.25) {
    // Rise/flatten phase
    const riseP = quartOut(clamp01((t - 7.75) / 1.5));
    tiltDeg = 56 - riseP * 56; // 56° -> 0°
  } else if (t >= 9.25) {
    // Overhead + pinned flat — stays at 0° for the full remaining segment
    tiltDeg = 0;
  }

  // Scroll the page downward during fly-over approach (0..7.75s)
  // Page scrolls from y=0 (top of hero) to y=400px (into stats strip) then back up slightly
  const scrollCurve = quartOut(clamp01(t / 7.75));
  const scrollY = -(scrollCurve * 320); // negative = scroll down into page

  // Lateral drift during fly-over (slow left-to-right pan, reverses at 7s)
  const rawPan = t < 7 ? Math.sin(t * 0.22) * 90 : Math.sin(7 * 0.22) * 90 - (t - 7) * 18;
  // After flatten, pan back to center smoothly
  const panFlattenP = clamp01((t - 7.75) / 1.5);
  const panX = rawPan * (1 - quartOut(panFlattenP));

  // DOF blur: strongest on far tiles, fades as camera approaches
  const dofBlur = Math.max(0, (1 - camProgress) * 3.5);

  // Hero card reveal at 9.47s: fade in centered 1018px card at y=283
  const heroCardP = expoOut(clamp01((t - 9.47) / 0.55));

  // Data-layer tiles (lifted code plates, standing 30-54°)
  const dataTiles = [
    { id: "hero-window",   x: -380, y: -180, w: 760, h: 440, label: "Agentes NEAR · Slack for Teams + AI", tilt: 30, color: "#0d1a2e", border: "#00EC9740", z: 1 },
    { id: "chip-1click",   x:  280, y: -260, w: 280, h: 160, label: "1Click · 358.13 wNEAR · +16 bps",    tilt: 42, color: "#0d2a1f", border: "#00EC9770", z: 2 },
    { id: "chip-tdx",      x:  320, y:   40, w: 260, h: 150, label: "OutLayer TDX · $25/tx Cap",          tilt: 38, color: "#1a1200", border: "#F59E0B70", z: 2 },
    { id: "card-3col",     x: -260, y:  200, w: 500, h: 280, label: "3-Col Ocelli Workspace · 6 Agents",  tilt: 36, color: "#0a1520", border: "#38BDF870", z: 1 },
    { id: "card-outlayer", x:  180, y:  200, w: 300, h: 180, label: "OutLayer Intel TDX Enclave",         tilt: 44, color: "#120d00", border: "#F59E0B50", z: 2 },
    { id: "card-winner",   x:  -60, y: -300, w: 320, h: 190, label: "13 NEAR Tracks · MIT License",      tilt: 54, color: "#1a0010", border: "#EC489970", z: 3 },
    { id: "logo-tile",     x: -460, y:  -60, w: 180, h: 180, label: "NEAR Protocol",                     tilt: 32, color: "#05060a", border: "#00EC9790", z: 2 },
  ];

  // Title card: appears at 10.02s, centered above hero card
  const titleProg  = expoOut(clamp01((t - 10.02) / 0.65));
  const line2Prog  = expoOut(clamp01((t - 10.65) / 0.55));

  // Whether to show flyover phase (tiles + scrolling page) vs hero pin phase
  const isFlyoverPhase = t < 9.47;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: "#f2f3f6",
        overflow: "hidden",
      }}
    >
      {/* Studio floor gradient */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse 72% 60% at 50% 48%, #f9fbfb 0%, #eceef2 55%, #f2f3f6 100%)",
        }}
      />

      {/* ── FIXED 3D camera rig (coordinator #68) ───────────────────────────────
       *   Layer 1 (perspective container): sets the vanishing point
       *   Layer 2 (depth wrapper): pushes scene back along SCREEN Z only
       *   Layer 3 (plane wrapper): tilts the page plane
       *   Layer 4 (page content): scrolls during approach
       */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Layer 1: perspective on the outer container
          perspective: 1880,
          perspectiveOrigin: "50% 50%",
        }}
      >
        {/* Layer 2: depth push — translateZ in SCREEN space only (no rotateX applied yet) */}
        <div
          style={{
            transformStyle: "preserve-3d",
            transform: `translateZ(${(-camDist).toFixed(2)}px)`,
          }}
        >
          {/* Layer 3: lateral pan + tilt — rotates the page plane */}
          <div
            style={{
              transformStyle: "preserve-3d",
              transform: `translateX(${panX.toFixed(2)}px) rotateX(${tiltDeg.toFixed(2)}deg)`,
            }}
          >
            {/* Layer 4: page content area */}
            <div
              style={{
                position: "relative",
                width: 1200,
                height: 720,
                transformStyle: "preserve-3d",
              }}
            >
              {/* Page surface with scroll */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  overflow: "hidden",
                  backgroundColor: "#f9fbfb",
                  borderRadius: 24,
                  boxShadow: "0 24px 80px rgba(26,33,51,0.14), 0 2px 8px rgba(26,33,51,0.08)",
                }}
              >
                {/* Scrollable page content — translates during approach */}
                <div
                  style={{
                    transform: `translateY(${scrollY.toFixed(2)}px)`,
                    willChange: "transform",
                  }}
                >
                  {/* Navbar */}
                  <div style={{
                    height: 56,
                    borderBottom: "1px solid #e8eaef",
                    display: "flex",
                    alignItems: "center",
                    paddingLeft: 32,
                    paddingRight: 32,
                    gap: 16,
                    backgroundColor: "rgba(249,251,251,0.9)",
                  }}>
                    <div style={{ width: 110, height: 20, borderRadius: 6, backgroundColor: "#0d1a2e" }} />
                    <div style={{ flex: 1 }} />
                    {["Features", "Docs", "Tracks", "Sign In"].map((item) => (
                      <div key={item} style={{
                        padding: "6px 14px", borderRadius: 8,
                        backgroundColor: item === "Sign In" ? "#00EC97" : "transparent",
                        fontFamily: INTER_TIGHT, fontSize: 13, fontWeight: 600,
                        color: item === "Sign In" ? "#05060a" : "#4a5568",
                      }}>
                        {item}
                      </div>
                    ))}
                  </div>

                  {/* Hero section */}
                  <div style={{ padding: "48px 64px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
                    <div style={{
                      display: "inline-flex", padding: "4px 14px", borderRadius: 999,
                      backgroundColor: "#00EC9720", border: "1px solid #00EC9740", width: "fit-content",
                    }}>
                      <span style={{ fontFamily: INTER_TIGHT, fontSize: 11, fontWeight: 700, color: "#00EC97", letterSpacing: "0.1em" }}>
                        NEAR AI HACKATHON · 13 TRACKS
                      </span>
                    </div>
                    <div style={{ fontFamily: INTER_TIGHT, fontSize: 52, fontWeight: 800, lineHeight: 1.08, color: "#0d1a2e", letterSpacing: "-0.025em" }}>
                      Slack for Teams
                      <br />
                      <span style={{ color: "#00EC97" }}>+ NEAR AI Agents</span>
                    </div>
                    <div style={{ fontFamily: INTER_TIGHT, fontSize: 16, fontWeight: 400, color: "#6b7a9a", lineHeight: 1.6, maxWidth: 560 }}>
                      Self-hosted workspace where human teams and 6 specialized NEAR AI agents collaborate across live protocol surfaces.
                    </div>
                  </div>

                  {/* Stats strip */}
                  <div style={{ margin: "0 64px", display: "flex", gap: 16 }}>
                    {[
                      { v: "358.13", u: "wNEAR settled", c: "#00EC97" },
                      { v: "$25/tx",  u: "TDX spend cap",  c: "#F59E0B" },
                      { v: "13/13",   u: "NEAR tracks",    c: "#38BDF8" },
                    ].map((s) => (
                      <div key={s.v} style={{
                        flex: 1, padding: "20px 24px", borderRadius: 16,
                        backgroundColor: "#f0f2f6", border: "1px solid #e4e7ef",
                      }}>
                        <div style={{ fontFamily: INTER_TIGHT, fontSize: 32, fontWeight: 800, color: s.c }}>{s.v}</div>
                        <div style={{ fontFamily: INTER_TIGHT, fontSize: 13, fontWeight: 500, color: "#6b7a9a" }}>{s.u}</div>
                      </div>
                    ))}
                  </div>

                  {/* Additional page content visible during scroll */}
                  <div style={{ margin: "32px 64px 0", padding: "24px", borderRadius: 16, backgroundColor: "#f0f2f6", border: "1px solid #e4e7ef" }}>
                    <div style={{ fontFamily: INTER_TIGHT, fontSize: 20, fontWeight: 700, color: "#0d1a2e", marginBottom: 12 }}>
                      6 Specialized AI Agents
                    </div>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {["@ada · Intents", "@theo · Analytics", "@lia · Content", "@kronos · Scheduler", "@nova · Research", "@rex · Security"].map((ag) => (
                        <div key={ag} style={{
                          padding: "8px 16px", borderRadius: 999, backgroundColor: "#00EC9720",
                          fontFamily: INTER_TIGHT, fontSize: 13, fontWeight: 600, color: "#00EC97",
                          border: "1px solid #00EC9740",
                        }}>
                          {ag}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Lifted data-layer tiles — only during flyover phase */}
              {isFlyoverPhase && dataTiles.map((tile) => {
                const tileProg = expoOut(clamp01((t - 0.3 - tile.z * 0.15) / 0.9));
                const floatY = Math.sin(t * 0.9 + tile.z * 0.8) * 8;
                const tileBlur = Math.max(0, dofBlur * (tile.z * 0.5));
                return (
                  <div
                    key={tile.id}
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "50%",
                      width: tile.w,
                      height: tile.h,
                      marginLeft: tile.x - tile.w / 2,
                      marginTop: tile.y - tile.h / 2 + floatY,
                      borderRadius: 14,
                      backgroundColor: tile.color,
                      border: `1.5px solid ${tile.border}`,
                      boxShadow: `0 ${4 + 0.36 * tile.z * 10}px ${20 + tile.z * 20}px rgba(26,33,51,${0.10 + 0.06 * tile.z})`,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      justifyContent: "flex-end",
                      padding: 16,
                      opacity: tileProg,
                      filter: tileBlur > 0.3 ? `blur(${tileBlur.toFixed(1)}px)` : "none",
                      transform: `
                        translateZ(${tile.z * 60}px)
                        rotateX(${-tile.tilt * (1 - tileProg * 0.4)}deg)
                        scale(${(0.4 + 0.6 * tileProg).toFixed(4)})
                      `,
                      transformStyle: "preserve-3d",
                    }}
                  >
                    <div style={{
                      fontFamily: INTER_TIGHT,
                      fontSize: Math.max(10, tile.w / 32),
                      fontWeight: 600,
                      color: "rgba(255,255,255,0.75)",
                      lineHeight: 1.4,
                    }}>
                      {tile.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Hero card pin (9.47..14.5s) — centered 1018px card at y=283, flat on floor */}
      {t >= 9.47 && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 283,
            width: 1018,
            marginLeft: -509,
            borderRadius: 38,
            backgroundColor: "#f9fbfb",
            boxShadow: "0 32px 96px rgba(26,33,51,0.18), 0 4px 16px rgba(26,33,51,0.10)",
            overflow: "hidden",
            opacity: heroCardP,
            transform: `scale(${(0.92 + 0.08 * heroCardP).toFixed(4)})`,
          }}
        >
          {/* Navbar */}
          <div style={{
            height: 48, borderBottom: "1px solid #e8eaef",
            display: "flex", alignItems: "center", paddingLeft: 28, paddingRight: 28, gap: 14,
            backgroundColor: "rgba(249,251,251,0.95)",
          }}>
            <div style={{ width: 90, height: 16, borderRadius: 5, backgroundColor: "#0d1a2e" }} />
            <div style={{ flex: 1 }} />
            {["Features", "Docs", "Sign In"].map((item) => (
              <div key={item} style={{
                padding: "5px 12px", borderRadius: 7,
                backgroundColor: item === "Sign In" ? "#00EC97" : "transparent",
                fontFamily: INTER_TIGHT, fontSize: 12, fontWeight: 600,
                color: item === "Sign In" ? "#05060a" : "#4a5568",
              }}>
                {item}
              </div>
            ))}
          </div>
          {/* Hero inside card */}
          <div style={{ padding: "36px 52px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{
              display: "inline-flex", padding: "3px 12px", borderRadius: 999,
              backgroundColor: "#00EC9720", border: "1px solid #00EC9740", width: "fit-content",
            }}>
              <span style={{ fontFamily: INTER_TIGHT, fontSize: 10, fontWeight: 700, color: "#00EC97", letterSpacing: "0.1em" }}>
                NEAR AI HACKATHON · 13 TRACKS
              </span>
            </div>
            <div style={{ fontFamily: INTER_TIGHT, fontSize: 42, fontWeight: 800, lineHeight: 1.08, color: "#0d1a2e", letterSpacing: "-0.025em" }}>
              Slack for Teams<br />
              <span style={{ color: "#00EC97" }}>+ NEAR AI Agents</span>
            </div>
            <div style={{ fontFamily: INTER_TIGHT, fontSize: 14, fontWeight: 400, color: "#6b7a9a", lineHeight: 1.6, maxWidth: 480 }}>
              Self-hosted workspace where human teams and 6 specialized NEAR AI agents collaborate across live protocol surfaces.
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              {[
                { v: "358.13", u: "wNEAR settled", c: "#00EC97" },
                { v: "$25/tx",  u: "TDX cap",       c: "#F59E0B" },
                { v: "13/13",   u: "tracks",         c: "#38BDF8" },
              ].map((s) => (
                <div key={s.v} style={{
                  flex: 1, padding: "14px 18px", borderRadius: 12,
                  backgroundColor: "#f0f2f6", border: "1px solid #e4e7ef",
                }}>
                  <div style={{ fontFamily: INTER_TIGHT, fontSize: 24, fontWeight: 800, color: s.c }}>{s.v}</div>
                  <div style={{ fontFamily: INTER_TIGHT, fontSize: 11, fontWeight: 500, color: "#6b7a9a" }}>{s.u}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Title card overlay (10.02..14.5s) — centered two-line heading above hero card */}
      {t >= 10.02 && (
        <div
          style={{
            position: "absolute",
            top: 72,
            left: 0,
            right: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            opacity: titleProg,
            transform: `translateY(${((1 - titleProg) * 32).toFixed(2)}px)`,
          }}
        >
          <div
            style={{
              fontFamily: INTER_TIGHT,
              fontSize: 74,
              fontWeight: 500,
              color: "#111827",
              lineHeight: 1.05,
              letterSpacing: "-0.025em",
              opacity: titleProg,
              textAlign: "center",
            }}
          >
            Agentes NEAR
          </div>
          <div
            style={{
              fontFamily: SERIF_ITALIC,
              fontStyle: "italic",
              fontSize: 82,
              fontWeight: 400,
              color: "#8b8b92",
              lineHeight: 1.05,
              opacity: line2Prog,
              transform: `translateY(${((1 - line2Prog) * 20).toFixed(2)}px)`,
              textAlign: "center",
            }}
          >
            Slack for Teams + AI.
          </div>
        </div>
      )}
    </div>
  );
};

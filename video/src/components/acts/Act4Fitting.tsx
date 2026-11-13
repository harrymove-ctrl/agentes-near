import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { CursorArrow, INTER_TIGHT, MONO, clamp01, expoOut, quartOut } from "./shared";

interface ActProps {
  durationInFrames: number;
}

/**
 * Act 4 (30..45s): "Fitting" — 15s Lookbook Launch (60fps)
 * Warm paper #EEE9E0 + subtle Cobalt #2E4BFF (top-right) & Butter #F3D36B (bottom-left) soft blurs,
 * Ink #141414, grotesk + uppercase mono labels across all 11 beats!
 */
export const Act4Fitting: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const actualDur = durationInFrames / fps;
  const t = (frame / fps) * (15.0 / actualDur);

  const PaperBase: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ position: "absolute", inset: 0, backgroundColor: "#EEE9E0", overflow: "hidden" }}>
      {/* Cobalt top-right soft blur */}
      <div
        style={{
          position: "absolute",
          right: -140,
          top: -160,
          width: 680,
          height: 680,
          borderRadius: "50%",
          backgroundColor: "rgba(46, 75, 255, 0.22)",
          filter: "blur(95px)",
        }}
      />
      {/* Butter bottom-left soft blur */}
      <div
        style={{
          position: "absolute",
          left: -140,
          bottom: -160,
          width: 640,
          height: 640,
          borderRadius: "50%",
          backgroundColor: "rgba(243, 211, 107, 0.36)",
          filter: "blur(95px)",
        }}
      />
      {children}
    </div>
  );

  // Beat 1 (0..1.2s): "fitting" + cobalt dot + yellow BETA
  if (t < 1.2) {
    const p = expoOut(clamp01(t / 0.4));
    return (
      <PaperBase>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
            transform: `scale(${0.92 + 0.08 * p})`,
            opacity: p,
          }}
        >
          <span style={{ fontFamily: INTER_TIGHT, fontSize: 132, fontWeight: 800, color: "#141414", letterSpacing: "-0.04em" }}>
            fitting
          </span>
          <span style={{ width: 28, height: 28, borderRadius: "50%", backgroundColor: "#2E4BFF", marginTop: 48 }} />
          <span
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              backgroundColor: "#F3D36B",
              fontFamily: MONO,
              fontSize: 16,
              fontWeight: 700,
              color: "#141414",
              marginBottom: 56,
            }}
          >
            BETA
          </span>
        </div>
      </PaperBase>
    );
  }

  // Beat 2 (1.2..3.0s): "One garment. Every look." + tilted paper garment & 5 mini looks
  if (t < 3.0) {
    const localT = t - 1.2;
    const wipe = quartOut(clamp01((localT - 0.3) / 0.45));
    const drop = expoOut(clamp01((localT - 0.45) / 0.5));
    return (
      <PaperBase>
        <div style={{ position: "absolute", inset: "110px 100px", display: "grid", gridTemplateColumns: "1fr 1fr", alignItems: "center", gap: 48 }}>
          <div>
            <div style={{ fontFamily: INTER_TIGHT, fontSize: 88, fontWeight: 800, lineHeight: 1.02, color: "#141414" }}>
              One garment.
            </div>
            <div style={{ position: "relative", display: "inline-block", marginTop: 12, padding: "4px 18px" }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${Math.round(wipe * 100)}%`,
                  backgroundColor: "#2E4BFF",
                  borderRadius: 12,
                }}
              />
              <span style={{ position: "relative", fontFamily: INTER_TIGHT, fontSize: 88, fontWeight: 800, color: wipe > 0.4 ? "#EEE9E0" : "#141414" }}>
                Every look.
              </span>
            </div>
          </div>

          <div style={{ position: "relative", height: 680 }}>
            <div
              style={{
                position: "absolute",
                left: 60,
                top: 40,
                width: 440,
                height: 540,
                backgroundColor: "#FFFFFF",
                padding: 16,
                borderRadius: 20,
                boxShadow: "0 24px 64px rgba(20,20,20,0.16)",
                transform: `translateY(${(1 - drop) * -260}px) rotate(-4deg)`,
              }}
            >
              <Img
                src={staticFile("photos/garment-cobalt-overshirt.jpg")}
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 12 }}
              />
            </div>
            {["look-1-butter.jpg", "look-3-terracotta.jpg", "look-4-sage.jpg"].map((lk, idx) => (
              <div
                key={lk}
                style={{
                  position: "absolute",
                  right: idx * 36,
                  bottom: idx * 32,
                  width: 170,
                  height: 220,
                  backgroundColor: "#FFFFFF",
                  padding: 8,
                  borderRadius: 14,
                  boxShadow: "0 14px 36px rgba(20,20,20,0.18)",
                  transform: `translateY(${(1 - drop) * 180}px) rotate(${(idx - 1) * 5}deg)`,
                }}
              >
                <Img src={staticFile(`photos/${lk}`)} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 8 }} />
              </div>
            ))}
          </div>
        </div>
      </PaperBase>
    );
  }

  // Beat 3 (3.0..4.0s): Cobalt full wipe "Meet Studio" (Studio on butter block)
  if (t < 4.0) {
    const p = expoOut(clamp01((t - 3.0) / 0.35));
    return (
      <div style={{ position: "absolute", inset: 0, backgroundColor: "#2E4BFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 22, transform: `scale(${0.86 + 0.14 * p})` }}>
          <span style={{ fontFamily: INTER_TIGHT, fontSize: 112, fontWeight: 800, color: "#FFFFFF" }}>Meet</span>
          <span
            style={{
              padding: "8px 28px",
              borderRadius: 18,
              backgroundColor: "#F3D36B",
              fontFamily: INTER_TIGHT,
              fontSize: 112,
              fontWeight: 800,
              color: "#141414",
            }}
          >
            Studio
          </span>
        </div>
      </div>
    );
  }

  // Beat 4 (4.0..5.6s): 3 white 20px panels GARMENT / MODELS / SCENES + cursor drop
  if (t < 5.6) {
    const p = expoOut(clamp01((t - 4.0) / 0.45));
    const cDrop = quartOut(clamp01((t - 4.4) / 0.7));
    return (
      <PaperBase>
        <div style={{ position: "absolute", inset: "110px 96px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 28 }}>
          {[
            { tag: "01 · GARMENT", title: "Cobalt Wool Overshirt", img: "photos/garment-cobalt-overshirt.jpg" },
            { tag: "02 · MODELS", title: "6 Editorial Talent", img: "photos/model-1.jpg" },
            { tag: "03 · SCENES", title: "5 Studio Backdrops", img: "photos/look-1-butter.jpg" },
          ].map((panel, i) => (
            <div
              key={panel.tag}
              style={{
                backgroundColor: "#FFFFFF",
                borderRadius: 20,
                padding: 24,
                boxShadow: "0 20px 50px rgba(20,20,20,0.08)",
                transform: `translateY(${(1 - p) * (40 + i * 24)}px)`,
                opacity: p,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "#2E4BFF" }}>{panel.tag}</div>
                <div style={{ marginTop: 8, fontFamily: INTER_TIGHT, fontSize: 28, fontWeight: 800, color: "#141414" }}>
                  {panel.title}
                </div>
              </div>
              <div style={{ height: 520, borderRadius: 14, overflow: "hidden", marginTop: 18 }}>
                <Img src={staticFile(panel.img)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
            </div>
          ))}
        </div>
        <CursorArrow x={240 + cDrop * 120} y={140 + cDrop * 240} color="#2E4BFF" scale={1.15} />
      </PaperBase>
    );
  }

  // Beat 5 (5.6..7.0s): 3x2 MODELS grid selecting 1, 3, 5 (3 SELECTED)
  if (t < 7.0) {
    const localT = t - 5.6;
    const selectedSet = new Set([
      ...(localT >= 0.2 ? [0] : []),
      ...(localT >= 0.5 ? [2] : []),
      ...(localT >= 0.8 ? [4] : []),
    ]);
    return (
      <PaperBase>
        <div style={{ position: "absolute", inset: "90px 160px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
            <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: "#141414" }}>MODELS · SELECT TALENT</span>
            <span
              style={{
                padding: "8px 18px",
                borderRadius: 999,
                backgroundColor: "#2E4BFF",
                color: "#FFFFFF",
                fontFamily: MONO,
                fontSize: 16,
                fontWeight: 700,
              }}
            >
              {selectedSet.size} SELECTED
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 22, flex: 1 }}>
            {[1, 2, 3, 4, 5, 6].map((n, idx) => {
              const sel = selectedSet.has(idx);
              return (
                <div
                  key={n}
                  style={{
                    position: "relative",
                    borderRadius: 20,
                    overflow: "hidden",
                    backgroundColor: "#FFFFFF",
                    border: sel ? "5px solid #2E4BFF" : "2px solid rgba(20,20,20,0.08)",
                    boxShadow: "0 16px 38px rgba(20,20,20,0.09)",
                  }}
                >
                  <Img
                    src={staticFile(`photos/model-${n}.jpg`)}
                    style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 20%" }}
                  />
                  {sel ? (
                    <div
                      style={{
                        position: "absolute",
                        top: 16,
                        right: 16,
                        width: 40,
                        height: 40,
                        borderRadius: "50%",
                        backgroundColor: "#2E4BFF",
                        color: "#FFFFFF",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontFamily: INTER_TIGHT,
                        fontSize: 22,
                        fontWeight: 800,
                      }}
                    >
                      ✓
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </PaperBase>
    );
  }

  // Beat 6 (7.0..8.2s): Whip-pan SCENES (Butter, Blush, Terracotta, Sage — 3 selected)
  if (t < 8.2) {
    const pan = expoOut(clamp01((t - 7.0) / 0.45));
    const scenes = [
      { name: "BUTTER", hex: "#F3D36B", sel: true },
      { name: "BLUSH", hex: "#F2B5C4", sel: false },
      { name: "TERRACOTTA", hex: "#D96B43", sel: true },
      { name: "SAGE", hex: "#94B49F", sel: true },
    ];
    return (
      <PaperBase>
        <div
          style={{
            position: "absolute",
            inset: "120px 100px",
            transform: `translateX(${(1 - pan) * 320}px)`,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: "#141414", marginBottom: 24 }}>
            SCENES · 3 PAPER BACKDROPS SELECTED
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 24, height: 520 }}>
            {scenes.map((sc) => (
              <div
                key={sc.name}
                style={{
                  borderRadius: 22,
                  backgroundColor: sc.hex,
                  padding: 26,
                  border: sc.sel ? "5px solid #2E4BFF" : "2px solid rgba(20,20,20,0.12)",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 700, color: "#141414" }}>{sc.name}</span>
                  {sc.sel ? (
                    <span
                      style={{
                        padding: "4px 12px",
                        borderRadius: 999,
                        backgroundColor: "#2E4BFF",
                        color: "#FFFFFF",
                        fontFamily: MONO,
                        fontSize: 13,
                        fontWeight: 700,
                      }}
                    >
                      ✓
                    </span>
                  ) : null}
                </div>
                <div style={{ fontFamily: MONO, fontSize: 14, color: "#141414" }}>{sc.hex}</div>
              </div>
            ))}
          </div>
        </div>
      </PaperBase>
    );
  }

  // Beat 7 (8.2..9.4s): "Create lookbook" press + cobalt rings
  if (t < 9.4) {
    const localT = t - 8.2;
    const press = localT >= 0.35 ? 0.94 + 0.06 * expoOut((localT - 0.35) / 0.25) : 1;
    const ring = clamp01((localT - 0.35) / 0.7);
    return (
      <PaperBase>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {[0, 0.22, 0.44].map((offset, idx) => {
            const rp = clamp01(ring - offset);
            return (
              <div
                key={idx}
                style={{
                  position: "absolute",
                  width: 380 + rp * 540,
                  height: 120 + rp * 540,
                  borderRadius: 999,
                  border: "4px solid #2E4BFF",
                  opacity: rp > 0 ? (1 - rp) * 0.75 : 0,
                }}
              />
            );
          })}
          <div
            style={{
              padding: "30px 64px",
              borderRadius: 999,
              backgroundColor: "#2E4BFF",
              color: "#FFFFFF",
              fontFamily: INTER_TIGHT,
              fontSize: 44,
              fontWeight: 800,
              transform: `scale(${press})`,
              boxShadow: "0 24px 60px rgba(46,75,255,0.35)",
            }}
          >
            Create lookbook
          </div>
          <CursorArrow x={1020} y={550} color="#141414" scale={1.2} />
        </div>
      </PaperBase>
    );
  }

  // Beat 8 (9.4..11.0s): Grid reveal under paper veil + "A whole campaign. / In minutes."
  if (t < 11.0) {
    const veil = quartOut(clamp01((t - 9.4) / 0.75));
    return (
      <PaperBase>
        <div style={{ position: "absolute", inset: "90px 100px", display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 40, alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: INTER_TIGHT, fontSize: 78, fontWeight: 800, lineHeight: 1.02, color: "#141414" }}>
              A whole campaign.
            </div>
            <div style={{ marginTop: 10, fontFamily: INTER_TIGHT, fontSize: 78, fontWeight: 800, color: "#2E4BFF" }}>
              In minutes.
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, opacity: veil }}>
            {["look-1-butter.jpg", "look-2-cream.jpg", "look-3-terracotta.jpg", "look-4-sage.jpg"].map((lk) => (
              <div key={lk} style={{ height: 340, borderRadius: 18, overflow: "hidden", backgroundColor: "#FFFFFF", padding: 8 }}>
                <Img src={staticFile(`photos/${lk}`)} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 12 }} />
              </div>
            ))}
          </div>
        </div>
      </PaperBase>
    );
  }

  // Beat 9 (11.0..12.6s): 5 looks arc fan-out + "Download all"
  if (t < 12.6) {
    const fan = expoOut(clamp01((t - 11.0) / 0.55));
    const looks = [
      "look-1-butter.jpg",
      "look-2-cream.jpg",
      "look-3-terracotta.jpg",
      "look-4-sage.jpg",
      "look-5-greyblue.jpg",
    ];
    return (
      <PaperBase>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative", width: 1500, height: 620 }}>
            {looks.map((lk, idx) => {
              const offset = idx - 2;
              const x = 750 + offset * 255 * fan;
              const y = 310 + Math.abs(offset) * 34 * fan;
              const rot = offset * 8 * fan;
              return (
                <div
                  key={lk}
                  style={{
                    position: "absolute",
                    left: x,
                    top: y,
                    width: 310,
                    height: 430,
                    borderRadius: 20,
                    backgroundColor: "#FFFFFF",
                    padding: 10,
                    boxShadow: "0 24px 56px rgba(20,20,20,0.16)",
                    transform: `translate(-50%, -50%) rotate(${rot}deg)`,
                  }}
                >
                  <Img src={staticFile(`photos/${lk}`)} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 12 }} />
                </div>
              );
            })}
          </div>
          <div
            style={{
              marginTop: 28,
              padding: "16px 36px",
              borderRadius: 999,
              backgroundColor: "#141414",
              color: "#EEE9E0",
              fontFamily: MONO,
              fontSize: 20,
              fontWeight: 700,
            }}
          >
            Download all (5 RAW + 4K)
          </div>
        </div>
      </PaperBase>
    );
  }

  // Beat 10 (12.6..14.0s): 3 3D-tilted white phones ("Wool Overshirt", COBALT · $148, Add to bag)
  if (t < 14.0) {
    const p = expoOut(clamp01((t - 12.6) / 0.45));
    return (
      <PaperBase>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 44,
            perspective: 1400,
          }}
        >
          {["look-1-butter.jpg", "look-3-terracotta.jpg", "look-5-greyblue.jpg"].map((lk, i) => (
            <div
              key={lk}
              style={{
                width: 330,
                height: 670,
                borderRadius: 42,
                backgroundColor: "#FFFFFF",
                padding: 18,
                border: "4px solid #141414",
                boxShadow: "0 30px 70px rgba(20,20,20,0.18)",
                transform: `translateY(${(1 - p) * 120}px) rotateY(${(i - 1) * -14}deg)`,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div style={{ height: 450, borderRadius: 26, overflow: "hidden" }}>
                <Img src={staticFile(`photos/${lk}`)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
              <div>
                <div style={{ fontFamily: INTER_TIGHT, fontSize: 22, fontWeight: 800, color: "#141414" }}>
                  Wool Overshirt
                </div>
                <div style={{ fontFamily: MONO, fontSize: 14, color: "#2E4BFF", fontWeight: 700, marginTop: 4 }}>
                  COBALT · $148
                </div>
                <div
                  style={{
                    marginTop: 14,
                    padding: "12px 0",
                    borderRadius: 999,
                    backgroundColor: "#141414",
                    color: "#FFFFFF",
                    textAlign: "center",
                    fontFamily: INTER_TIGHT,
                    fontSize: 16,
                    fontWeight: 700,
                  }}
                >
                  Add to bag
                </div>
              </div>
            </div>
          ))}
        </div>
      </PaperBase>
    );
  }

  // Beat 11 (14.0..15.0s): "fitting." + BETA + FITTING.STUDIO
  return (
    <PaperBase>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontFamily: INTER_TIGHT, fontSize: 136, fontWeight: 800, color: "#141414", letterSpacing: "-0.04em" }}>
            fitting<span style={{ color: "#2E4BFF" }}>.</span>
          </span>
          <span
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              backgroundColor: "#F3D36B",
              fontFamily: MONO,
              fontSize: 16,
              fontWeight: 700,
              color: "#141414",
              marginBottom: 56,
            }}
          >
            BETA
          </span>
        </div>
        <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 20, letterSpacing: "0.18em", color: "#141414" }}>
          FITTING.STUDIO
        </div>
      </div>
    </PaperBase>
  );
};

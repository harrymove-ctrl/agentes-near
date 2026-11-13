import React from "react";
import { Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ANTON, INTER_TIGHT, SERIF_ITALIC, clamp01, expoOut, quartOut } from "./shared";

interface ActProps {
  durationInFrames: number;
}

/**
 * Act 2 (12..20s): "Yapp" — 8s Viral Post & Giant 99K Like Counter (104 BPM)
 * Strict flat palette: #111111, #F7F7F2, #D81B78, #3DA35D (zero gradients!)
 */
export const Act2Yapp: React.FC<ActProps> = ({ durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const actualDur = durationInFrames / fps;
  const t = (frame / fps) * (8.0 / actualDur);

  // 0..1.5s: cropped Anton counter rolling from 0 + rounded post card slams in (expo-out 0.3s)
  const cardSlam = expoOut(clamp01(t / 0.32));
  const typedText = "Launch day. Please act ";
  const italicWord = "normal.";
  const totalChars = typedText.length + italicWord.length;
  const typedCount =
    t < 1.45 ? 0 : Math.min(totalChars, Math.floor(clamp01((t - 1.45) / 1.15) * totalChars));

  // Counter value: 0 -> 12 (0..1.5s) -> 40K (1.5..3.0s) -> 99K (3.0..4.5s)
  let counterText = "00";
  if (t < 1.5) {
    counterText = String(Math.round(quartOut(t / 1.5) * 14)).padStart(2, "0");
  } else if (t < 3.0) {
    const val = Math.round(14 + quartOut((t - 1.5) / 1.35) * 26);
    counterText = `${val}K`;
  } else {
    const val = Math.round(40 + quartOut((t - 3.0) / 1.1) * 59);
    counterText = `${val}K`;
  }

  // Layout shifts low-left at 2.1s, then pulls back into final layered poster at 6.0s
  const shiftLeft = quartOut(clamp01((t - 2.0) / 0.45));
  const pullBack = quartOut(clamp01((t - 6.0) / 0.6));

  // Light shake when hitting 99K (3.9..4.55s)
  const is99k = t >= 3.9;
  const shakeX = is99k && t < 4.58 ? Math.sin(t * 74) * 9 : 0;
  const shakeY = is99k && t < 4.58 ? Math.cos(t * 62) * 6 : 0;

  // Hard silence cut at 4.6..4.8s -> Reply sticker slaps in at 4.8s
  const replySlam = expoOut(clamp01((t - 4.8) / 0.25));
  const magentaWipe = quartOut(clamp01((t - 4.82) / 0.35));
  const topTagStamp = expoOut(clamp01((t - 5.35) / 0.2));
  const replyText = "Too late. We're excited.";
  const replyChars =
    t < 5.05 ? 0 : Math.min(replyText.length, Math.floor(clamp01((t - 5.05) / 0.4) * replyText.length));

  const postX = 960 - shiftLeft * 410 + pullBack * 55 + shakeX * 0.4;
  const postY = 540 + shiftLeft * 145 - pullBack * 95 + shakeY * 0.4;
  const postScale = (1 - 0.14 * shiftLeft - 0.08 * pullBack) * (0.72 + 0.28 * cardSlam);

  const counterX = 1320 - pullBack * 80 + shakeX;
  const counterY = 470 - shiftLeft * 40 - pullBack * 40 + shakeY;

  const visibleMain = typedText.slice(0, Math.min(typedCount, typedText.length));
  const visibleItalic =
    typedCount > typedText.length ? italicWord.slice(0, typedCount - typedText.length) : "";

  const reactions = [
    { at: 2.05, label: "♥", x: 640, y: 270, bg: "#D81B78" },
    { at: 2.35, label: "👍", x: 820, y: 230, bg: "#3DA35D" },
    { at: 2.65, label: "♥", x: 960, y: 290, bg: "#D81B78" },
    { at: 3.25, label: "🔥", x: 1120, y: 210, bg: "#111111" },
  ];

  const avatars = [
    { at: 3.15, src: "photos/model-1.jpg", x: 1560, y: 170, rot: -8 },
    { at: 3.35, src: "photos/model-2.jpg", x: 1680, y: 270, rot: 7 },
    { at: 3.55, src: "photos/model-3.jpg", x: 1520, y: 740, rot: -5 },
    { at: 3.75, src: "photos/model-5.jpg", x: 1690, y: 790, rot: 9 },
  ];

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: "#F7F7F2",
        overflow: "hidden",
      }}
    >
      {/* Flat Magenta Block Accent on Final Poster & Reply */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: `${Math.round(magentaWipe * 34)}%`,
          backgroundColor: "#D81B78",
        }}
      />

      {/* Giant Cropped Anton Like Counter */}
      <div
        style={{
          position: "absolute",
          left: counterX,
          top: counterY,
          transform: `translate(-50%, -50%) scale(${1 + pullBack * -0.08})`,
          fontFamily: ANTON,
          fontSize: 440,
          lineHeight: 0.84,
          letterSpacing: "-0.02em",
          color: t >= 3.9 ? "#D81B78" : "#111111",
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        {counterText}
      </div>

      {/* Floating Flat Reaction Pills */}
      {reactions.map((rx, i) => {
        const p = expoOut(clamp01((t - rx.at) / 0.22));
        if (t < rx.at) return null;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: rx.x,
              top: rx.y - p * 44,
              transform: `scale(${p})`,
              padding: "10px 18px",
              borderRadius: 999,
              backgroundColor: rx.bg,
              color: "#F7F7F2",
              fontFamily: INTER_TIGHT,
              fontSize: 28,
              fontWeight: 800,
              border: "3px solid #111111",
            }}
          >
            {rx.label}
          </div>
        );
      })}

      {/* Avatar Cards Piling Around at 99K */}
      {avatars.map((av, i) => {
        const p = expoOut(clamp01((t - av.at) / 0.25));
        if (t < av.at) return null;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: av.x,
              top: av.y,
              width: 118,
              height: 118,
              borderRadius: 18,
              border: "4px solid #111111",
              overflow: "hidden",
              backgroundColor: "#F7F7F2",
              transform: `translate(-50%, -50%) rotate(${av.rot}deg) scale(${p})`,
            }}
          >
            <Img
              src={staticFile(av.src)}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </div>
        );
      })}

      {/* Main Post Card */}
      <div
        style={{
          position: "absolute",
          left: postX,
          top: postY,
          width: 780,
          transform: `translate(-50%, -50%) scale(${postScale})`,
          backgroundColor: "#F7F7F2",
          border: "5px solid #111111",
          borderRadius: 28,
          padding: "36px 40px",
          boxShadow: "14px 14px 0px #111111",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 76,
              height: 76,
              borderRadius: 999,
              border: "3px solid #111111",
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            <Img
              src={staticFile("photos/avatar-sam.jpg")}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </div>
          <div>
            <div style={{ fontFamily: INTER_TIGHT, fontSize: 30, fontWeight: 800, color: "#111111" }}>
              Sam Rivera
            </div>
            <div style={{ fontFamily: INTER_TIGHT, fontSize: 20, fontWeight: 600, color: "#555550" }}>
              @sam · #near-intents-arena
            </div>
          </div>
        </div>

        <div
          style={{
            marginTop: 26,
            fontFamily: INTER_TIGHT,
            fontSize: 48,
            fontWeight: 700,
            lineHeight: 1.15,
            color: "#111111",
            minHeight: 112,
          }}
        >
          {visibleMain}
          <span
            style={{
              fontFamily: SERIF_ITALIC,
              fontStyle: "italic",
              fontWeight: 400,
              fontSize: 56,
              color: "#D81B78",
            }}
          >
            {visibleItalic}
          </span>
          {t >= 1.45 && t < 2.85 ? (
            <span style={{ display: "inline-block", width: 4, height: 46, backgroundColor: "#111111", marginLeft: 4 }} />
          ) : null}
        </div>

        <div
          style={{
            marginTop: 22,
            paddingTop: 18,
            borderTop: "3px solid #111111",
            display: "flex",
            justifyContent: "space-between",
            fontFamily: INTER_TIGHT,
            fontSize: 20,
            fontWeight: 700,
            color: "#111111",
          }}
        >
          <span>{t >= 3.9 ? "99,412 LIKES" : `${counterText} LIKES`}</span>
          <span style={{ color: "#3DA35D" }}>14.2K REPOSTS</span>
        </div>
      </div>

      {/* Tilted Reply Sticker (slams in at 4.8s after hard silence cut!) */}
      {t >= 4.8 ? (
        <div
          style={{
            position: "absolute",
            left: 1140 - pullBack * 40,
            top: 760 - pullBack * 30,
            width: 640,
            transform: `translate(-50%, -50%) rotate(${-3.5 + pullBack * 1.5}deg) scale(${0.75 + 0.25 * replySlam})`,
            backgroundColor: "#111111",
            color: "#F7F7F2",
            border: "5px solid #111111",
            borderRadius: 24,
            padding: "28px 34px",
            boxShadow: "14px 14px 0px #3DA35D",
          }}
        >
          {t >= 5.35 ? (
            <div
              style={{
                position: "absolute",
                top: -22,
                right: 26,
                padding: "6px 16px",
                borderRadius: 8,
                backgroundColor: "#3DA35D",
                color: "#111111",
                fontFamily: INTER_TIGHT,
                fontSize: 18,
                fontWeight: 800,
                border: "3px solid #111111",
                transform: `scale(${topTagStamp}) rotate(4deg)`,
              }}
            >
              Top reply
            </div>
          ) : null}

          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 54,
                height: 54,
                borderRadius: 999,
                overflow: "hidden",
                border: "2px solid #F7F7F2",
              }}
            >
              <Img
                src={staticFile("photos/avatar-reply.jpg")}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </div>
            <div style={{ fontFamily: INTER_TIGHT, fontSize: 22, fontWeight: 700, color: "#3DA35D" }}>
              @ada · Agentes NEAR
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              fontFamily: INTER_TIGHT,
              fontSize: 40,
              fontWeight: 800,
              color: "#F7F7F2",
            }}
          >
            {replyText.slice(0, replyChars)}
          </div>
        </div>
      ) : null}
    </div>
  );
};

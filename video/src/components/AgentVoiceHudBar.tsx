import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { INTER_TIGHT, MONO, clamp01, expoOut } from "./acts/shared";

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface UtteranceRecord {
  id: string;
  chapter: number;
  speaker: string;
  speaker_label: string;
  speaker_role: string;
  speaker_accent: string;
  start_frame: number;
  duration_frames: number;
  voice_offset_sec: number;
  voice_duration_sec?: number;
  step_badge: string;
  text: string;
  caption: string;
  words: WordTimestamp[];
}

interface AgentVoiceHudBarProps {
  utterances: UtteranceRecord[];
  totalFrames: number;
}

export const AgentVoiceHudBar: React.FC<AgentVoiceHudBarProps> = ({
  utterances,
  totalFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const active =
    utterances.find(
      (u) => frame >= u.start_frame && frame < u.start_frame + u.duration_frames
    ) || utterances[utterances.length - 1];

  if (!active) return null;

  const localSec = (frame - active.start_frame) / fps - active.voice_offset_sec;
  const enter = expoOut(clamp01((frame - active.start_frame) / 10));
  const overallPct = Math.round((frame / Math.max(1, totalFrames)) * 100);

  // Determine active word index inside the utterance's word list
  const words = active.words || [];
  let activeWordIdx = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (localSec >= words[i].start - 0.04) {
      activeWordIdx = i;
    }
  }

  // Sliding window of up to 14 words around activeWordIdx so the karaoke line always fits cleanly on 1 line
  const windowSize = 14;
  const startWord =
    words.length <= windowSize
      ? 0
      : Math.max(
          0,
          Math.min(words.length - windowSize, activeWordIdx - 5)
        );
  const visibleWords = words.slice(startWord, startWord + windowSize);

  return (
    <div
      style={{
        position: "absolute",
        left: 56,
        right: 56,
        bottom: 24,
        zIndex: 80,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        padding: "14px 24px",
        borderRadius: 18,
        backgroundColor: "rgba(8, 11, 18, 0.90)",
        border: `1.5px solid ${active.speaker_accent}`,
        boxShadow: "0 18px 48px rgba(0, 0, 0, 0.65)",
        transform: `translateY(${(1 - enter) * 14}px)`,
      }}
    >
      {/* Left: Active Speaker Pill + Animated 5-Bar V-Drill Waveform */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            height: 26,
            padding: "0 10px",
            borderRadius: 8,
            backgroundColor: "rgba(255,255,255,0.06)",
          }}
        >
          {[0, 1, 2, 3, 4].map((b) => {
            const wave =
              localSec >= 0
                ? 0.35 +
                  0.65 * Math.abs(Math.sin(frame * 0.42 + b * 1.15))
                : 0.25;
            return (
              <span
                key={b}
                style={{
                  width: 4,
                  height: `${Math.round(wave * 20)}px`,
                  borderRadius: 2,
                  backgroundColor: active.speaker_accent,
                }}
              />
            );
          })}
        </div>

        <div>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 13,
              fontWeight: 700,
              color: active.speaker_accent,
              letterSpacing: "0.06em",
            }}
          >
            {active.speaker_label}
          </div>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: "#94A3B8",
            }}
          >
            {active.step_badge}
          </div>
        </div>
      </div>

      {/* Center: Word-by-Word Karaoke Caption Stream */}
      <div
        style={{
          flex: 1,
          textAlign: "center",
          fontFamily: INTER_TIGHT,
          fontSize: 22,
          fontWeight: 700,
          color: "#F8FAFC",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {visibleWords.length > 0 ? (
          visibleWords.map((w, idx) => {
            const globalIdx = startWord + idx;
            const isCurrent = globalIdx === activeWordIdx;
            const isPast = globalIdx < activeWordIdx;
            return (
              <span
                key={`${globalIdx}-${w.word}`}
                style={{
                  display: "inline-block",
                  marginRight: 7,
                  padding: isCurrent ? "2px 8px" : "2px 0",
                  borderRadius: 6,
                  backgroundColor: isCurrent
                    ? active.speaker_accent
                    : "transparent",
                  color: isCurrent
                    ? "#05060A"
                    : isPast
                      ? "#FFFFFF"
                      : "rgba(226, 232, 240, 0.68)",
                }}
              >
                {w.word}
              </span>
            );
          })
        ) : (
          <span>{active.caption}</span>
        )}
      </div>

      {/* Right: Chapter & V-Drill Audio Status Badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            backgroundColor: "rgba(236, 72, 153, 0.14)",
            border: "1px solid rgba(236, 72, 153, 0.45)",
            fontFamily: MONO,
            fontSize: 11,
            fontWeight: 700,
            color: "#EC4899",
          }}
        >
          DAN TRANH + 808 V-DRILL
        </span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 12,
            fontWeight: 700,
            color: "#CBD5E1",
          }}
        >
          CH 0{active.chapter}/07 · {overallPct}%
        </span>
      </div>
    </div>
  );
};

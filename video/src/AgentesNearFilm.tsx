import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import manifest from "./scene-manifest.json";
import { BRAND, DOTO, MONO, SANS, TOKENS } from "./components/DitherPrimitives";
import {
  SceneChannelsSwarm,
  SceneCorpusKyvera,
  SceneHeroOcelli,
  SceneOutLayerGuard,
  SceneTerraceIntents,
  SceneTracksLockup,
} from "./components/Scenes";

interface WordTiming {
  word: string;
  start: number;
  end: number;
}

interface SceneRecord {
  id: string;
  scene: number;
  title: string;
  speaker: string;
  speaker_label: string;
  speaker_role: string;
  start_frame: number;
  duration_frames: number;
  voice_offset_sec: number;
  voice_duration_sec: number;
  text: string;
  caption: string;
  words: WordTiming[];
}

function useAgentesFonts() {
  const [handle] = useState(() => delayRender("Loading Agentes NEAR local fonts"));
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const faces = [
          new FontFace(
            "Commit Mono",
            `url(${staticFile("fonts/CommitMono-Regular.woff2")}) format("woff2")`
          ),
          new FontFace(
            "Inter Display",
            `url(${staticFile("fonts/InterDisplay-Regular.woff2")}) format("woff2")`
          ),
          new FontFace(
            "Funnel Display",
            `url(${staticFile("fonts/funnel-display-latin.woff2")}) format("woff2")`
          ),
          new FontFace(
            "Doto",
            `url(${staticFile("fonts/doto-latin.woff2")}) format("woff2")`
          ),
        ];
        const loaded = await Promise.all(faces.map((f) => f.load()));
        if (!cancelled) {
          const fonts = document.fonts as FontFaceSet & { add?: (font: FontFace) => void };
          loaded.forEach((f) => fonts.add?.(f));
        }
      } catch {
        // Fallback fonts remain ready
      } finally {
        if (!cancelled) continueRender(handle);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [handle]);
}

function findActiveScene(scenes: SceneRecord[], frame: number): SceneRecord {
  for (let i = scenes.length - 1; i >= 0; i--) {
    if (frame >= scenes[i].start_frame) return scenes[i];
  }
  return scenes[0];
}

const TopFilmHud: React.FC<{ scene: SceneRecord; cutLabel: string }> = ({ scene, cutLabel }) => {
  return (
    <div
      style={{
        position: "absolute",
        top: 24,
        left: 72,
        right: 72,
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 18px",
        borderRadius: 10,
        backgroundColor: "rgba(9, 12, 18, 0.84)",
        border: "1px solid rgba(255, 255, 255, 0.14)",
        fontFamily: MONO,
        fontSize: 13,
        letterSpacing: "0.06em",
        color: TOKENS.ink2,
        zIndex: 60,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: BRAND, fontSize: 16, fontWeight: 700, color: "#fff" }}>
          agentes<span style={{ fontFamily: DOTO, color: TOKENS.nearGreen }}>.near</span>
        </span>
        <span style={{ color: TOKENS.muted }}>·</span>
        <span style={{ color: TOKENS.agent2 }}>SCENE {scene.scene}/6</span>
        <span style={{ color: TOKENS.ink }}>{scene.title.toUpperCase()}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: TOKENS.muted }}>{cutLabel}</span>
        <span
          style={{
            padding: "3px 9px",
            borderRadius: 6,
            backgroundColor: "rgba(0, 236, 151, 0.14)",
            border: "1px solid rgba(0, 236, 151, 0.42)",
            color: TOKENS.nearGreen,
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          OUTLAYER TDX + 1CLICK LIVE
        </span>
      </div>
    </div>
  );
};

const DualHostDialogueBar: React.FC<{ scene: SceneRecord; globalFrame: number }> = ({
  scene,
  globalFrame,
}) => {
  const { fps } = useVideoConfig();
  const sceneSec = (globalFrame - scene.start_frame) / fps;
  const relVoiceSec = sceneSec - scene.voice_offset_sec;
  const isAlex = scene.speaker === "alex";
  const accent = isAlex ? TOKENS.agent : TOKENS.nearGreen;

  const speaking = scene.words.some((w) => relVoiceSec >= w.start && relVoiceSec <= w.end + 0.08);
  const waveBase = speaking ? 0.5 + 0.5 * Math.abs(Math.sin(sceneSec * 16.0)) : 0.12;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 22,
        left: 96,
        right: 96,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 20px",
        borderRadius: 12,
        backgroundColor: "rgba(9, 12, 18, 0.90)",
        border: `1.5px solid ${accent}66`,
        boxShadow: "0 14px 36px rgba(0, 0, 0, 0.48)",
        zIndex: 70,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "6px 12px",
          borderRadius: 8,
          backgroundColor: `${accent}20`,
          border: `1px solid ${accent}`,
          flexShrink: 0,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 99, backgroundColor: accent }} />
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: accent }}>
          {scene.speaker_label.toUpperCase()}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 3, height: 14 }}>
          {[0.65, 1.0, 0.78, 0.55].map((w, idx) => (
            <div
              key={idx}
              style={{
                width: 3,
                height: 3 + waveBase * 11 * w,
                borderRadius: 2,
                backgroundColor: accent,
              }}
            />
          ))}
        </div>
      </div>

      <div
        style={{
          fontFamily: SANS,
          fontSize: 18,
          fontWeight: 500,
          color: "#f4f6fb",
          lineHeight: 1.32,
          letterSpacing: "-0.01em",
        }}
      >
        {scene.caption}
      </div>
    </div>
  );
};

/**
 * Smooth non-flashing scene wrapper: crisp 10-frame subtle zoom/fade seam
 * with zero black frames and zero harsh flash transitions.
 */
const SceneWrapper: React.FC<{
  durationInFrames: number;
  isFirst?: boolean;
  isLast?: boolean;
  children: React.ReactNode;
}> = ({ durationInFrames, isFirst, isLast, children }) => {
  const frame = useCurrentFrame();
  const enterOpacity = isFirst
    ? 1
    : interpolate(frame, [0, 10], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      });
  const exitOpacity = isLast
    ? 1
    : interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.in(Easing.cubic),
      });
  const opacity = Math.min(enterOpacity, exitOpacity);

  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const SceneRouter: React.FC<{ sceneIndex: number; durationInFrames: number }> = ({
  sceneIndex,
  durationInFrames,
}) => {
  switch (sceneIndex) {
    case 1:
      return <SceneHeroOcelli durationInFrames={durationInFrames} />;
    case 2:
      return <SceneChannelsSwarm durationInFrames={durationInFrames} />;
    case 3:
      return <SceneTerraceIntents durationInFrames={durationInFrames} />;
    case 4:
      return <SceneOutLayerGuard durationInFrames={durationInFrames} />;
    case 5:
      return <SceneCorpusKyvera durationInFrames={durationInFrames} />;
    case 6:
    default:
      return <SceneTracksLockup durationInFrames={durationInFrames} />;
  }
};

export const AgentesNearDemoFilm: React.FC = () => {
  useAgentesFonts();
  const frame = useCurrentFrame();
  const scenes = manifest.demo_scenes as SceneRecord[];
  const activeScene = findActiveScene(scenes, frame);

  return (
    <AbsoluteFill style={{ backgroundColor: "#05060a" }}>
      <Audio src={staticFile("audio/demo-mix.wav")} />

      {scenes.map((sc, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === scenes.length - 1;
        const overlap = isLast ? 0 : 10;
        return (
          <Sequence
            key={sc.id}
            from={sc.start_frame}
            durationInFrames={sc.duration_frames + overlap}
          >
            <SceneWrapper
              durationInFrames={sc.duration_frames + overlap}
              isFirst={isFirst}
              isLast={isLast}
            >
              <SceneRouter sceneIndex={sc.scene} durationInFrames={sc.duration_frames} />
            </SceneWrapper>
          </Sequence>
        );
      })}

      <TopFilmHud scene={activeScene} cutLabel="FULL LAUNCH DEMO (1:34)" />
      <DualHostDialogueBar scene={activeScene} globalFrame={frame} />
    </AbsoluteFill>
  );
};

export const AgentesNearXTeaserFilm: React.FC = () => {
  useAgentesFonts();
  const frame = useCurrentFrame();
  const scenes = manifest.teaser_scenes as SceneRecord[];
  const activeScene = findActiveScene(scenes, frame);

  return (
    <AbsoluteFill style={{ backgroundColor: "#05060a" }}>
      <Audio src={staticFile("audio/teaser-mix.wav")} />

      {scenes.map((sc, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === scenes.length - 1;
        const overlap = isLast ? 0 : 8;
        return (
          <Sequence
            key={sc.id}
            from={sc.start_frame}
            durationInFrames={sc.duration_frames + overlap}
          >
            <SceneWrapper
              durationInFrames={sc.duration_frames + overlap}
              isFirst={isFirst}
              isLast={isLast}
            >
              <SceneRouter sceneIndex={sc.scene} durationInFrames={sc.duration_frames} />
            </SceneWrapper>
          </Sequence>
        );
      })}

      <TopFilmHud scene={activeScene} cutLabel="X LAUNCH CUT (0:45)" />
      <DualHostDialogueBar scene={activeScene} globalFrame={frame} />
    </AbsoluteFill>
  );
};

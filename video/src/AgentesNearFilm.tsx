import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  continueRender,
  delayRender,
  staticFile,
} from "remotion";
import manifest from "./scene-manifest.json";
import {
  Act1Moving,
  Act2Yapp,
  Act3Cutline,
  Act4Fitting,
  Act5Graph,
  Act6Molote,
  Act7OneLockup,
} from "./components/MotionActs";

interface ActRecord {
  id: string;
  act: number;
  name: string;
  style: string;
  bpm: number;
  start_frame: number;
  duration_frames: number;
}

function usePhase2Fonts() {
  const [handle] = useState(() => delayRender("Loading Phase 2 Google & Studio Fonts"));
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const specs: Array<[string, string, FontFaceDescriptors?]> = [
          ["Anton", "fonts/Anton-400-normal.woff2", { weight: "400", style: "normal" }],
          ["Instrument Serif", "fonts/InstrumentSerif-400-italic.woff2", { weight: "400", style: "italic" }],
          ["Inter Tight", "fonts/InterTight-500-normal.woff2", { weight: "500", style: "normal" }],
          ["Inter Tight", "fonts/InterTight-600-normal.woff2", { weight: "600", style: "normal" }],
          ["Inter Tight", "fonts/InterTight-700-normal.woff2", { weight: "700", style: "normal" }],
          ["Inter Tight", "fonts/InterTight-800-normal.woff2", { weight: "800", style: "normal" }],
          ["Commit Mono", "fonts/CommitMono-Regular.woff2", { weight: "400", style: "normal" }],
          ["Funnel Display", "fonts/funnel-display-latin.woff2", { weight: "700", style: "normal" }],
          ["Doto", "fonts/doto-latin.woff2", { weight: "700", style: "normal" }],
        ];
        const loaded = await Promise.all(
          specs.map(([family, file, desc]) =>
            new FontFace(family, `url(${staticFile(file)}) format("woff2")`, desc).load()
          )
        );
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

const ActRouter: React.FC<{ actIndex: number; durationInFrames: number }> = ({
  actIndex,
  durationInFrames,
}) => {
  switch (actIndex) {
    case 1:
      return <Act1Moving durationInFrames={durationInFrames} />;
    case 2:
      return <Act2Yapp durationInFrames={durationInFrames} />;
    case 3:
      return <Act3Cutline durationInFrames={durationInFrames} />;
    case 4:
      return <Act4Fitting durationInFrames={durationInFrames} />;
    case 5:
      return <Act5Graph durationInFrames={durationInFrames} />;
    case 6:
      return <Act6Molote durationInFrames={durationInFrames} />;
    case 7:
    default:
      return <Act7OneLockup durationInFrames={durationInFrames} />;
  }
};

export const AgentesNearDemoFilm: React.FC = () => {
  usePhase2Fonts();
  const acts = manifest.demo_acts as ActRecord[];

  return (
    <AbsoluteFill style={{ backgroundColor: "#05060a" }}>
      <Audio src={staticFile("audio/demo-mix.wav")} />
      {acts.map((a) => (
        <Sequence key={a.id} from={a.start_frame} durationInFrames={a.duration_frames}>
          <ActRouter actIndex={a.act} durationInFrames={a.duration_frames} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const AgentesNearXTeaserFilm: React.FC = () => {
  usePhase2Fonts();
  const acts = manifest.teaser_acts as ActRecord[];

  return (
    <AbsoluteFill style={{ backgroundColor: "#05060a" }}>
      <Audio src={staticFile("audio/teaser-mix.wav")} />
      {acts.map((a) => (
        <Sequence key={a.id} from={a.start_frame} durationInFrames={a.duration_frames}>
          <ActRouter actIndex={a.act} durationInFrames={a.duration_frames} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

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
import {
  ShowcaseConfig,
  StepByStepShowcase,
} from "./components/StepByStepShowcase";
import {
  AgentVoiceHudBar,
  UtteranceRecord,
} from "./components/AgentVoiceHudBar";

interface VisualRecord {
  id: string;
  chapter: number;
  chapter_title: string;
  kind: "act" | "showcase";
  act?: number;
  start_frame: number;
  duration_frames: number;
  showcase?: ShowcaseConfig;
}

function useStudioFonts() {
  const [handle] = useState(() =>
    delayRender("Loading Agentes NEAR Studio Fonts")
  );
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const specs: Array<[string, string, FontFaceDescriptors?]> = [
          [
            "Anton",
            "fonts/Anton-400-normal.woff2",
            { weight: "400", style: "normal" },
          ],
          [
            "Instrument Serif",
            "fonts/InstrumentSerif-400-italic.woff2",
            { weight: "400", style: "italic" },
          ],
          [
            "Inter Tight",
            "fonts/InterTight-500-normal.woff2",
            { weight: "500", style: "normal" },
          ],
          [
            "Inter Tight",
            "fonts/InterTight-600-normal.woff2",
            { weight: "600", style: "normal" },
          ],
          [
            "Inter Tight",
            "fonts/InterTight-700-normal.woff2",
            { weight: "700", style: "normal" },
          ],
          [
            "Inter Tight",
            "fonts/InterTight-800-normal.woff2",
            { weight: "800", style: "normal" },
          ],
          [
            "Commit Mono",
            "fonts/CommitMono-Regular.woff2",
            { weight: "400", style: "normal" },
          ],
          [
            "Funnel Display",
            "fonts/funnel-display-latin.woff2",
            { weight: "700", style: "normal" },
          ],
          [
            "Doto",
            "fonts/doto-latin.woff2",
            { weight: "700", style: "normal" },
          ],
        ];
        const loaded = await Promise.all(
          specs.map(([family, file, desc]) =>
            new FontFace(
              family,
              `url(${staticFile(file)}) format("woff2")`,
              desc
            ).load()
          )
        );
        if (!cancelled) {
          const fonts = document.fonts as FontFaceSet & {
            add?: (font: FontFace) => void;
          };
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

const VisualBlockRouter: React.FC<{ visual: VisualRecord }> = ({ visual }) => {
  if (visual.kind === "showcase" && visual.showcase) {
    return (
      <StepByStepShowcase
        durationInFrames={visual.duration_frames}
        config={visual.showcase}
      />
    );
  }
  switch (visual.act) {
    case 1:
      return <Act1Moving durationInFrames={visual.duration_frames} />;
    case 2:
      return <Act2Yapp durationInFrames={visual.duration_frames} />;
    case 3:
      return <Act3Cutline durationInFrames={visual.duration_frames} />;
    case 4:
      return <Act4Fitting durationInFrames={visual.duration_frames} />;
    case 5:
      return <Act5Graph durationInFrames={visual.duration_frames} />;
    case 6:
      return <Act6Molote durationInFrames={visual.duration_frames} />;
    case 7:
    default:
      return <Act7OneLockup durationInFrames={visual.duration_frames} />;
  }
};

export const AgentesNearDemoFilm: React.FC = () => {
  useStudioFonts();
  const visuals = manifest.demo_visuals as unknown as VisualRecord[];
  const utterances = manifest.demo_utterances as unknown as UtteranceRecord[];

  return (
    <AbsoluteFill style={{ backgroundColor: "#05060a" }}>
      <Audio src={staticFile("audio/demo-mix.wav")} />
      {visuals.map((v) => (
        <Sequence
          key={v.id}
          from={v.start_frame}
          durationInFrames={v.duration_frames}
        >
          <VisualBlockRouter visual={v} />
        </Sequence>
      ))}
      <AgentVoiceHudBar utterances={utterances} totalFrames={7200} />
    </AbsoluteFill>
  );
};

export const AgentesNearXTeaserFilm: React.FC = () => {
  useStudioFonts();
  const visuals = manifest.teaser_visuals as unknown as VisualRecord[];
  const utterances = manifest.teaser_utterances as unknown as UtteranceRecord[];

  return (
    <AbsoluteFill style={{ backgroundColor: "#05060a" }}>
      <Audio src={staticFile("audio/teaser-mix.wav")} />
      {visuals.map((v) => (
        <Sequence
          key={v.id}
          from={v.start_frame}
          durationInFrames={v.duration_frames}
        >
          <VisualBlockRouter visual={v} />
        </Sequence>
      ))}
      <AgentVoiceHudBar utterances={utterances} totalFrames={1800} />
    </AbsoluteFill>
  );
};

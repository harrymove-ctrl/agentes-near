import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  continueRender,
  delayRender,
  staticFile,
} from "remotion";
import {
  Act2Yapp,
  Act3Cutline,
  Act4Fitting,
  Act5Graph,
  Act6Molote,
  Act7OneLockup,
  ActShowreel15s,
  ActLandingFlyover3D,
} from "./components/MotionActs";

// ── Font loader ──────────────────────────────────────────────────────────────
function useStudioFonts() {
  const [handle] = useState(() =>
    delayRender("Loading Agentes NEAR Studio Fonts")
  );
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

// ── Demo composition: 5400 frames = 90.0s @ 60fps ───────────────────────────
// Act layout (all frame values @ 60fps):
//   Act 1: ActShowreel15s   0..900f    (15.0s)
//   Act 2: ActLandingFlyover3D 900..1770f (14.5s)
//   Act 3: Act2Yapp (8.0s)  1770..2250f
//   Act 4: Act3Cutline (12.0s) 2250..2970f
//   Act 5: Act4Fitting (15.0s) 2970..3870f
//   Act 6: Act5Graph (9.0s)  3870..4410f
//   Act 7: Act6Molote (11.0s) 4410..5070f
//   Act 8: Act7OneLockup (5.5s) 5070..5400f (clipped to 5400)

export const AgentesNearDemoFilm: React.FC = () => {
  useStudioFonts();

  return (
    <AbsoluteFill style={{ backgroundColor: "#05060a" }}>
      <Audio src={staticFile("audio/demo-mix.wav")} />

      {/* Act 1: 15s Motion Showreel */}
      <Sequence from={0} durationInFrames={900}>
        <ActShowreel15s durationInFrames={900} />
      </Sequence>

      {/* Act 2: 14.5s 3D Studio Page Fly-Over */}
      <Sequence from={900} durationInFrames={870}>
        <ActLandingFlyover3D durationInFrames={870} />
      </Sequence>

      {/* Act 3: 8.0s Viral 99K Intent Counter */}
      <Sequence from={1770} durationInFrames={480}>
        <Act2Yapp durationInFrames={480} />
      </Sequence>

      {/* Act 4: 12.0s Intent Engine Node Graph */}
      <Sequence from={2250} durationInFrames={720}>
        <Act3Cutline durationInFrames={720} />
      </Sequence>

      {/* Act 5: 15.0s One Slack Showcase */}
      <Sequence from={2970} durationInFrames={900}>
        <Act4Fitting durationInFrames={900} />
      </Sequence>

      {/* Act 6: 9.0s @ada 5-node Tool Hub */}
      <Sequence from={3870} durationInFrames={540}>
        <Act5Graph durationInFrames={540} />
      </Sequence>

      {/* Act 7: 11.0s OutLayer TDX Zine Drop */}
      <Sequence from={4410} durationInFrames={660}>
        <Act6Molote durationInFrames={660} />
      </Sequence>

      {/* Act 8: 5.5s ONE Workspace Finale */}
      <Sequence from={5070} durationInFrames={330}>
        <Act7OneLockup durationInFrames={330} />
      </Sequence>
    </AbsoluteFill>
  );
};

// ── X Teaser composition: 1800 frames = 30.0s @ 60fps ───────────────────────
// Layout:
//   ActShowreel15s  0..900f    (15.0s)
//   ActLandingFlyover3D 900..1800f (15.0s, slightly extended)

export const AgentesNearXTeaserFilm: React.FC = () => {
  useStudioFonts();

  return (
    <AbsoluteFill style={{ backgroundColor: "#05060a" }}>
      <Audio src={staticFile("audio/teaser-mix.wav")} />

      {/* Showreel 15s */}
      <Sequence from={0} durationInFrames={900}>
        <ActShowreel15s durationInFrames={900} />
      </Sequence>

      {/* 3D Fly-Over 15s */}
      <Sequence from={900} durationInFrames={900}>
        <ActLandingFlyover3D durationInFrames={900} />
      </Sequence>
    </AbsoluteFill>
  );
};

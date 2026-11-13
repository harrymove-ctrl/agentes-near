import React from "react";
import { Composition } from "remotion";
import { AgentesNearDemoFilm, AgentesNearXTeaserFilm } from "./AgentesNearFilm";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Demo: 90.0s @ 60fps = 5400 frames */}
      <Composition
        id="AgentesNearDemo"
        component={AgentesNearDemoFilm}
        durationInFrames={5400}
        fps={60}
        width={1920}
        height={1080}
      />
      {/* X Teaser: 30.0s @ 60fps = 1800 frames */}
      <Composition
        id="AgentesNearXTeaser"
        component={AgentesNearXTeaserFilm}
        durationInFrames={1800}
        fps={60}
        width={1920}
        height={1080}
      />
    </>
  );
};

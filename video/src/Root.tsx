import React from "react";
import { Composition } from "remotion";
import { AgentesNearDemoFilm, AgentesNearXTeaserFilm } from "./AgentesNearFilm";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AgentesNearDemo"
        component={AgentesNearDemoFilm}
        durationInFrames={7200}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="AgentesNearXTeaser"
        component={AgentesNearXTeaserFilm}
        durationInFrames={1800}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};

import type { Builder } from "../../../../../libs/film-kit/film/engine.ts";
import {
  buildFinaleLockupScene,
  buildOutlayerGuardScene,
  buildSolverWorkspaceScene,
  buildStudioFlyoverScene,
  buildTactileHookScene,
} from "../../shared/studio-scenes.ts";

export const CUSTOM: Record<string, Builder> = {
  t01: buildTactileHookScene("teaser"),
  t02: buildStudioFlyoverScene("teaser"),
  t03: buildSolverWorkspaceScene("teaser"),
  t04: buildOutlayerGuardScene("teaser"),
  t05: buildFinaleLockupScene("teaser"),
};

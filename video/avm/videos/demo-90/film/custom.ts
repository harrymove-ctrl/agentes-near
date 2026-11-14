import type { Builder } from "../../../../../libs/film-kit/film/engine.ts";
import {
  buildCutlineFlowScene,
  buildEconomyArenaScene,
  buildFinaleLockupScene,
  buildOutlayerGuardScene,
  buildSolverWorkspaceScene,
  buildStudioFlyoverScene,
  buildTactileHookScene,
} from "../../shared/studio-scenes.ts";

export const CUSTOM: Record<string, Builder> = {
  s01: buildTactileHookScene("full"),
  s02: buildStudioFlyoverScene("full"),
  s03: buildCutlineFlowScene(),
  s04: buildSolverWorkspaceScene("full"),
  s05: buildOutlayerGuardScene("full"),
  s06: buildEconomyArenaScene(),
  s07: buildFinaleLockupScene("full"),
};

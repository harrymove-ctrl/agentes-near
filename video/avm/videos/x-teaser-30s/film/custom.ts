import type { Builder } from "../../../../../libs/film-kit/film/engine.ts";
import {
  buildTourCliAndLockupScene,
  buildTourEconomyCutScene,
  buildTourEntryScene,
  buildTourKronosChatScene,
  buildTourOutlayerCutScene,
} from "../../shared/product-tour-scenes.ts";

export const CUSTOM: Record<string, Builder> = {
  t01: buildTourEntryScene("cut"),
  t02: buildTourKronosChatScene(1.25),
  t03: buildTourOutlayerCutScene(),
  t04: buildTourEconomyCutScene(),
  t05: buildTourCliAndLockupScene("cut"),
};

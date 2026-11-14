import type { Builder } from "../../../../../libs/film-kit/film/engine.ts";
import {
  buildTourCliAndLockupScene,
  buildTourCorpusKanmaniScene,
  buildTourEntryScene,
  buildTourKronosChatScene,
  buildTourMotionStudioScene,
  buildTourOneClickScene,
  buildTourOutlayerFullScene,
  buildTourTerraceScene,
} from "../../shared/product-tour-scenes.ts";

export const CUSTOM: Record<string, Builder> = {
  s01: buildTourEntryScene("full"),
  s02: buildTourKronosChatScene(1.0),
  s03: buildTourOneClickScene(),
  s04: buildTourOutlayerFullScene(),
  s05: buildTourTerraceScene(),
  s06: buildTourCorpusKanmaniScene(),
  s07: buildTourMotionStudioScene(),
  s08: buildTourCliAndLockupScene("full"),
};

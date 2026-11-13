import { STICKER_STILL_T, type StickerLook, type StickerMood, stickerSeed } from "@agenteschat/ui/agent/stickers";
import { Canvas, createPicture, Picture } from "@shopify/react-native-skia";
import { createContext, memo, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useReducedMotion } from "@/ui/theme";
import { frameClock } from "./clock";
import { useFrameTime } from "./live";
import { replay } from "./skia-ctx";
import { STICKER_FPS, stickerFrame } from "./sticker";
import type { StickerStage } from "./sticker-stage";

/** The stage of the list the stickers are in (none: they stand still). */
export const StickerStageContext = createContext<StickerStage | null>(null);

const noStage = () => () => undefined;

/** Whether the sticker that goes by `id` on its list's stage may play now. */
export function useStickerLive(id: string | undefined): boolean {
  const stage = useContext(StickerStageContext);
  return useSyncExternalStore(stage?.subscribe ?? noStage, () => Boolean(stage && id && stage.isLive(id)));
}

/** `useFrameTime`'s answer while not playing: never a moment of the clock. */
const STOPPED = -1;

function StickerCanvasView({
  look,
  mood,
  size,
  seed,
  live,
  playFor,
  from,
}: {
  look: StickerLook;
  mood: StickerMood;
  size: number;
  /** Keeps stickers side by side out of step: the agent's id. */
  seed: string;
  live: boolean;
  /** Plays once, for this many seconds from when it shows, then stands at its still frame; without it, it loops. */
  playFor?: number;
  /** When that one play started on the frame clock, if before it showed here (it then goes on, not again). */
  from?: number;
}) {
  const reduced = useReducedMotion();
  const [shownAt] = useState(() => frameClock.time());
  const start = from ?? shownAt;
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (playFor === undefined) return;
    const id = setTimeout(() => setDone(true), Math.max(0, start + playFor - frameClock.time()) * 1000);
    return () => clearTimeout(id);
  }, [playFor, start]);
  const t = useFrameTime(live && !reduced && !done, STOPPED, STICKER_FPS);
  const { color, eyes, accessory } = look;
  const picture = useMemo(() => {
    const once = playFor === undefined ? undefined : Math.min(Math.max(0, t - start), playFor);
    const at = t === STOPPED ? STICKER_STILL_T : (once ?? t + stickerSeed(seed));
    const ops = stickerFrame({ color, eyes, accessory }, mood, size, at);
    return createPicture((canvas) => replay(canvas, ops), { width: size, height: size });
  }, [color, eyes, accessory, mood, size, seed, t, start, playFor]);
  return (
    <Canvas style={{ width: size, height: size }}>
      <Picture picture={picture} />
    </Canvas>
  );
}

/**
 * An agent's sticker on a Skia canvas, drawn by the shared agent engine: never any other way. While `live` it plays
 * on the one frame clock, at `STICKER_FPS`, its seed keeping it out of step with its neighbors; with reduced motion,
 * on a screen that isn't showing or with the app in the background it holds its still frame. A sticker that plays
 * once (`playFor`) ends on a frame drawn like its still one, so stopping shows no jump.
 */
export const StickerCanvas = memo(
  StickerCanvasView,
  (a, b) =>
    a.mood === b.mood &&
    a.size === b.size &&
    a.seed === b.seed &&
    a.live === b.live &&
    a.playFor === b.playFor &&
    a.from === b.from &&
    a.look.color === b.look.color &&
    a.look.eyes === b.look.eyes &&
    a.look.accessory === b.look.accessory,
);

import { drawSticker, STICKER_STILL_T, type StickerLook, type StickerMood } from "@agenteschat/ui/agent/stickers";
import { asCtx, type CompiledOp, compile, RecordingContext } from "./recorder";

/**
 * A sticker's rate on the shared clock (every other tick of its 25): a frame costs a recording and a Skia picture on
 * the JS thread, and this pixel art reads as well at half the rate.
 */
export const STICKER_FPS = 12.5;

/**
 * One frame of an agent's sticker (ADR 0091) as drawing commands: the shared `drawSticker` draws with the engine's
 * 2D subset, the recorder keeps it, and `replay` (./skia-ctx.ts) draws it on a Skia canvas, as agents' avatars are.
 * `t` is the moment of its loop (`StickerCanvas` adds the sticker's seed to the clock); standing still, its still
 * frame (`STICKER_STILL_T`). Pure: no React Native, no Skia, so it runs in `bun test`.
 */
export function stickerFrame(look: StickerLook, mood: StickerMood, size: number, t = STICKER_STILL_T): CompiledOp[] {
  const rec = new RecordingContext();
  drawSticker(asCtx(rec), look, mood, t, size);
  return compile(rec.commands);
}

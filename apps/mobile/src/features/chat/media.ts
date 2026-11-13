import type { Message } from "@agenteschat/client";
import { MEDIA_AFTER_KEY, messageMediaOf } from "@agenteschat/client/lib/media";
import { masonryColumns } from "@agenteschat/ui/media-grid";

/**
 * GIFs and stickers in chat (ADR 0091), the phone's pure rules: how big a GIF shows, when the sticker or GIF an agent
 * adds after its own reply reads as part of that reply, how the picker lays out what it finds, and which stickers
 * may play.
 */

/** The widest a GIF shows in a message (points): bigger than a sticker, never a banner. */
export const MESSAGE_GIF_MAX = 260;
/** The tallest a GIF shows (points): a tall one gets narrower instead of filling the screen. */
export const MESSAGE_GIF_MAX_HEIGHT = 320;
/** A sticker's side in a message (points): bigger than an emoji, smaller than a GIF. */
export const MESSAGE_STICKER = 110;
/**
 * Stickers playing at once in a conversation: the newest in view. A frame is drawn on the JS thread, and a screen of
 * them must not take it from the list and the keyboard; the rest hold their still frame.
 */
export const MESSAGE_LIVE_STICKERS = 3;
/** Stickers playing at once in the picker: the first ones in view. */
export const PICKER_LIVE_STICKERS = 8;
/** A sticker's side in the picker (points): four to a row. */
export const PICKER_STICKER = 72;
/** Columns of the picker's GIFs. */
export const GIF_COLUMNS = 2;
/** The space between the picker's GIFs (points). */
export const GIF_GAP = 6;
/** GIFs stay mounted this far past what shows (points): each is a playing image, and the pages pile up. */
export const GIF_AHEAD = 320;
/** The next page loads this far before the end (points). */
export const GIF_MORE_AHEAD = 480;
/** The picker's height against the window's: a short sheet, the conversation still there behind it. */
const PICKER_SHARE = 0.62;
/** What the sheet takes around the picker: the status bar's room, the grabber, its paddings (points). */
const PICKER_CHROME = 140;
/** The least the picker takes with the keyboard up (points): the box, the chips and a row of results. */
const PICKER_LEAST = 240;

/**
 * A GIF's box at its own proportions: as wide as the file, up to `MESSAGE_GIF_MAX` and the room the row has
 * (`room`, 0 while not measured yet), never taller than `MESSAGE_GIF_MAX_HEIGHT`. Sizes it doesn't know draw 4:3.
 */
export function gifBox(width: number, height: number, room = 0): { width: number; height: number } {
  const known = width > 0 && height > 0;
  const w = known ? width : 4;
  const h = known ? height : 3;
  const widest = Math.min(MESSAGE_GIF_MAX, room > 0 ? room : MESSAGE_GIF_MAX, known ? w : MESSAGE_GIF_MAX);
  let outW = widest;
  let outH = (widest * h) / w;
  if (outH > MESSAGE_GIF_MAX_HEIGHT) {
    outH = MESSAGE_GIF_MAX_HEIGHT;
    outW = (MESSAGE_GIF_MAX_HEIGHT * w) / h;
  }
  return { width: Math.max(1, Math.round(outW)), height: Math.max(1, Math.round(outH)) };
}

/** The reply an agent's silent sticker or GIF follows (`meta.mediaAfter`), or null for any other message. */
export function mediaAfterOf(meta: Message["meta"]): string | null {
  const after = meta?.[MEDIA_AFTER_KEY];
  return typeof after === "string" ? after : null;
}

/**
 * The sticker or GIF right under the reply it follows, from the same agent: it reads as the end of that reply
 * (grouped under it, whatever the reply carries), never as a message of its own.
 */
export function continuesReply(
  prev: Pick<Message, "id" | "author"> | null | undefined,
  m: Pick<Message, "author" | "meta">,
): boolean {
  const reply = mediaAfterOf(m.meta);
  return Boolean(
    reply && prev && prev.id === reply && prev.author.type === m.author.type && prev.author.id === m.author.id,
  );
}

/** The picker's height: short, and it fits in the room left above the keyboard (the sheet would scroll otherwise). */
export function pickerHeight(windowHeight: number, keyboard: number): number {
  const room = windowHeight - keyboard - PICKER_CHROME;
  return Math.max(PICKER_LEAST, Math.min(Math.round(windowHeight * PICKER_SHARE), Math.round(room)));
}

/** A found GIF's place in the picker's scroll (points). */
export interface GifPlace<T> {
  item: T;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The masonry (`masonryColumns`, the web's order) as places in `room` points of width: each GIF at its own proportions
 * holds its place before its file loads, and `height` is the whole scroll's.
 */
export function masonryPlaces<T extends { width: number; height: number }>(
  items: T[],
  room: number,
): { places: GifPlace<T>[]; height: number } {
  const width = Math.max(0, (room - GIF_GAP * (GIF_COLUMNS - 1)) / GIF_COLUMNS);
  const places: GifPlace<T>[] = [];
  let height = 0;
  masonryColumns(items, GIF_COLUMNS).forEach((column, c) => {
    let y = 0;
    for (const item of column) {
      const h = Math.round(width * (item.width > 0 && item.height > 0 ? item.height / item.width : 1));
      places.push({ item, x: c * (width + GIF_GAP), y, width, height: h });
      y += h + GIF_GAP;
    }
    height = Math.max(height, y > 0 ? y - GIF_GAP : 0);
  });
  return { places, height };
}

/** A span of the scroll (`y`, `height`) near what shows from `top` for `viewport` points. */
export const nearView = (span: { y: number; height: number }, top: number, viewport: number) =>
  span.y + span.height >= top - GIF_AHEAD && span.y <= top + viewport + GIF_AHEAD;

/** Scrolled close enough to the end for the next page. */
export const nearEnd = (top: number, viewport: number, content: number) => top + viewport >= content - GIF_MORE_AHEAD;

/**
 * The agents whose stickers the picker offers: the conversation's (`here`), in the team's order; where it has none (a
 * person's DM, a channel of only people) the whole team, since any agent's sticker may go anywhere in the workspace.
 */
export function stickerAgentsFor<T extends { id: string }>(team: readonly T[], here: readonly string[]): T[] {
  const inConversation = team.filter((a) => here.includes(a.id));
  return inConversation.length > 0 ? inConversation : [...team];
}

/** The ids (top to bottom) of the picker's sections in view, from each one's measured place in the scroll. */
export function sectionsInView<T extends { id: string; y: number; height: number }>(
  sections: readonly T[],
  top: number,
  viewport: number,
): string[] {
  return [...sections]
    .sort((a, b) => a.y - b.y)
    .filter((s) => s.y + s.height > top && s.y < top + viewport)
    .map((s) => s.id);
}

/** A sticker's name on the picker's stage. */
export const stickerCellId = (agentId: string, mood: string) => `${agentId}:${mood}`;

/** The picker's stickers that may play, from its sections in view: the first ones, by the agent and the mood. */
export const pickerLiveIds = (inView: readonly string[], moods: (agentId: string) => readonly string[]) =>
  inView
    .flatMap((agentId) => moods(agentId).map((mood) => stickerCellId(agentId, mood)))
    .slice(0, PICKER_LIVE_STICKERS);

/**
 * The messages whose sticker may play, from the list's rows in view: the newest `MESSAGE_LIVE_STICKERS`, top to
 * bottom. A row of anything else takes no place.
 */
export function stickerRowsOnScreen(
  rows: readonly { index: number; item: { kind: string; message?: Pick<Message, "id" | "meta"> } }[],
): string[] {
  return [...rows]
    .sort((a, b) => a.index - b.index)
    .flatMap(({ item }) =>
      item.kind === "message" && item.message && messageMediaOf(item.message.meta)?.kind === "sticker"
        ? [item.message.id]
        : [],
    )
    .slice(-MESSAGE_LIVE_STICKERS);
}

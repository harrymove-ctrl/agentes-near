import { STICKER_MOODS, type StickerMood } from "./agent/stickers";
import { fold } from "./search";

/*
 * The GIF and sticker pickers' pure rules (ADR 0091), apart from their DOM components so the phone app lays out and
 * searches the same way.
 */

/**
 * Splits items into `count` columns, each into the shortest one so far (by height over width): the masonry's
 * order. A new page goes after the ones placed, so nothing on screen moves when more arrive.
 */
export function masonryColumns<T extends { width: number; height: number }>(items: T[], count: number): T[][] {
  const columns: T[][] = Array.from({ length: count }, () => []);
  const heights: number[] = Array.from({ length: count }, () => 0);
  for (const item of items) {
    let at = 0;
    for (let i = 1; i < count; i++) if ((heights[i] ?? 0) < (heights[at] ?? 0)) at = i;
    columns[at]?.push(item);
    heights[at] = (heights[at] ?? 0) + (item.width > 0 && item.height > 0 ? item.height / item.width : 1);
  }
  return columns;
}

/** The moods a search finds for an agent: all of an agent whose name matches, else those whose words do. */
export function stickerMoodsFor(
  query: string,
  name: string,
  words: { moods: Record<StickerMood, string>; moodWords?: Partial<Record<StickerMood, string>> },
): StickerMood[] {
  const q = fold(query.trim());
  if (!q || fold(name).includes(q)) return [...STICKER_MOODS];
  return STICKER_MOODS.filter((m) => fold(`${words.moods[m]} ${words.moodWords?.[m] ?? ""}`).includes(q));
}

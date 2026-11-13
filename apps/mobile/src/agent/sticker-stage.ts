/**
 * Which stickers play (ADR 0091): a list of many rows tells its stage what is in view, and each sticker asks only
 * whether it is on it, so a row redraws when its own answer changes, not on every scroll. Covered (a sheet over the
 * conversation) nobody plays. Pure, so it is tested without a screen.
 */
export interface StickerStage {
  setOnScreen(ids: readonly string[]): void;
  setCovered(covered: boolean): void;
  isLive(id: string): boolean;
  subscribe(listener: () => void): () => void;
}

export function createStickerStage(): StickerStage {
  let onScreen = new Set<string>();
  let covered = false;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    setOnScreen(ids) {
      if (ids.length === onScreen.size && ids.every((id) => onScreen.has(id))) return;
      onScreen = new Set(ids);
      tell();
    },
    setCovered(next) {
      if (next === covered) return;
      covered = next;
      tell();
    },
    isLive: (id) => !covered && onScreen.has(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

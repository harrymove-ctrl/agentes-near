/**
 * Who watches which agent's browser on one realtime socket (ADR 0040 §7).
 * Several views of the same agent (the card on its message, the bar, the full
 * live view) share one watch on the server: `browser.unwatch` goes only a
 * moment after the last one leaves, so a re-render or a remount (React's
 * StrictMode, a list that re-keys) doesn't stop and start the stream on the
 * computer. Each view that starts sends `browser.watch` again all the same:
 * a view that came later never heard the server's answer to the first (who is
 * in control, the newest page), and a page that isn't repainting sends nothing
 * else.
 *
 * Each view says how many frames a second it needs (ADR 0040 §7.1): a small picture (a closed card, a peek) needs
 * one, an open view whatever the stream sends. The socket asks the server for the most any view of that agent needs:
 * with `browser.watch`, and with `browser.fps` when that changes, so a card opening or closing never restarts the view.
 */

/** How long after the last view leaves before `browser.unwatch` (a view coming back meanwhile keeps it). */
export const BROWSER_UNWATCH_DELAY_MS = 1500;

/**
 * Frames a second a view asks for (ADR 0040 §7.1): `preview` for a picture too small to need more, `control` while
 * a person drives. `max` (the server's `BROWSER_VIEW.maxFps`) adds no limit of its own: the stream's rate holds.
 */
export const BROWSER_FPS = { preview: 1, control: 15, max: 15 } as const;

/** A view's rate as the server takes it: none is no limit of its own (`max`); anything else within 1..max. */
export function browserFps(maxFps?: number): number {
  if (maxFps === undefined || Number.isNaN(maxFps)) return BROWSER_FPS.max;
  return Math.min(BROWSER_FPS.max, Math.max(1, maxFps));
}

/** `browser.watch` asking for `fps` (left out when it adds no limit, as every watch said before rates existed). */
export function browserWatchFrame(
  agentId: string,
  fps: number,
): Extract<BrowserWatchesFrame, { type: "browser.watch" }> {
  return fps < BROWSER_FPS.max ? { type: "browser.watch", agentId, maxFps: fps } : { type: "browser.watch", agentId };
}

/** One view's watch: call it when the view leaves; `setMaxFps` when the rate it needs changes (opened, closed). */
export interface BrowserWatch {
  (): void;
  setMaxFps(maxFps?: number): void;
}

export interface BrowserWatcher {
  /**
   * One view of this agent's browser starts, needing `maxFps` frames a second (none: the stream's own rate); call
   * the result when it leaves.
   */
  acquire(agentId: string, maxFps?: number): BrowserWatch;
  /** Watch again now (the server dropped the watch: a retry after `reconnecting`, an ended stream). */
  rewatch(agentId: string): void;
}

export interface BrowserWatches extends BrowserWatcher {
  /** After the socket (re)opened: every agent someone is looking at is watched again (the server forgot them). */
  resumeAll(): void;
  /** Agents watched now (tests, debugging). */
  watching(): string[];
}

/** What the watches send on the socket. */
export type BrowserWatchesFrame =
  | { type: "browser.watch"; agentId: string; maxFps?: number }
  | { type: "browser.unwatch"; agentId: string }
  | { type: "browser.fps"; agentId: string; maxFps: number };

export function createBrowserWatches(options: {
  send(frame: BrowserWatchesFrame): void;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  unwatchDelayMs?: number;
}): BrowserWatches {
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const delay = options.unwatchDelayMs ?? BROWSER_UNWATCH_DELAY_MS;
  type Entry = { views: Map<number, number>; leaving: unknown; asked: number };
  /** Each agent's views (each one's rate), the pending unwatch, and the rate the server was last asked for. */
  const entries = new Map<string, Entry>();
  let nextView = 1;
  const rateOf = (views: Map<number, number>) => Math.max(1, ...views.values());
  const watch = (agentId: string, entry: Entry) => {
    entry.asked = rateOf(entry.views);
    options.send(browserWatchFrame(agentId, entry.asked));
  };
  /** A view's rate changed or a view left: the server hears it only when the most any of them needs did. */
  const retune = (agentId: string, entry: Entry) => {
    if (entry.views.size === 0) return;
    const fps = rateOf(entry.views);
    if (fps === entry.asked) return;
    entry.asked = fps;
    options.send({ type: "browser.fps", agentId, maxFps: fps });
  };
  return {
    acquire(agentId, maxFps) {
      const view = nextView++;
      let entry = entries.get(agentId);
      if (entry) {
        // Back before the unwatch went out: the watch on the server still holds.
        if (entry.leaving !== null) {
          timers.clearTimeout(entry.leaving);
          entry.leaving = null;
        }
      } else {
        entry = { views: new Map(), leaving: null, asked: BROWSER_FPS.max };
        entries.set(agentId, entry);
      }
      entry.views.set(view, browserFps(maxFps));
      watch(agentId, entry);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const e = entries.get(agentId);
        if (!e?.views.delete(view)) return;
        if (e.views.size > 0) {
          retune(agentId, e);
          return;
        }
        e.leaving = timers.setTimeout(() => {
          const now = entries.get(agentId);
          if (!now || now.views.size > 0) return;
          entries.delete(agentId);
          options.send({ type: "browser.unwatch", agentId });
        }, delay);
      };
      const setMaxFps = (fps?: number) => {
        const e = entries.get(agentId);
        if (released || !e?.views.has(view)) return;
        e.views.set(view, browserFps(fps));
        retune(agentId, e);
      };
      return Object.assign(release, { setMaxFps });
    },
    rewatch(agentId) {
      const e = entries.get(agentId);
      if (e && e.views.size > 0) watch(agentId, e);
    },
    resumeAll() {
      for (const [agentId, e] of entries) if (e.views.size > 0) watch(agentId, e);
    },
    watching: () => [...entries.entries()].filter(([, e]) => e.views.size > 0).map(([id]) => id),
  };
}

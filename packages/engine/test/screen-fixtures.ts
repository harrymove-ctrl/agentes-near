import type { ScreenKind } from "@agenteschat/adapters";
import {
  observeSnapshot,
  type ScreenAction,
  type ScreenActOutcome,
  type ScreenImage,
  type ScreenRegion,
  type ScreenSurface,
} from "../src";

/** An XFCE desktop as the runner writes it: the panel, Thunar in front, and its window buttons. */
export const THUNAR = `- toolbar "Panel"
  - button "Applications" [ref=e1]
  - button "Files - Thunar" [window, active, ref=e2]
  - button "Terminal - agent@desktop: ~" [window, ref=e3]
  - button "Pay [window, active]" [ref=e4]
- window "Files - Thunar" [active, ref=e20]
  - toolbar
    - button "Back" [ref=e25]
    - textbox "Location" [ref=e29]: /home/agent/
  - list "Files" [ref=e30]
    - listitem "report.pdf" [ref=e31]
    - listitem "Documents" [ref=e32]
  - status: 8 folders | 6 files`;

/**
 * A screen whose text a test sets, as a surface: every action and every capture recorded, the next
 * action failed on demand, images from `capture` (with `regions`, close-ups too).
 */
export function fakeScreen(
  text: string,
  options: {
    kind?: ScreenKind;
    url?: string;
    title?: string;
    capture?: (region?: ScreenRegion) => ScreenImage | null;
    regions?: boolean;
  } = {},
) {
  let current = text;
  let failNext: string | null = null;
  const actions: ScreenAction[] = [];
  const captures: (ScreenRegion | undefined)[] = [];
  const look = () =>
    observeSnapshot({
      text: current,
      url: options.url ?? "desktop://thunar/main",
      title: options.title ?? "Files - Thunar",
    });
  const make = options.capture;
  const surface: ScreenSurface & {
    actions: ScreenAction[];
    captures: (ScreenRegion | undefined)[];
    show(next: string): void;
    fail(error: string): void;
  } = {
    kind: options.kind ?? "desktop",
    actions,
    captures,
    show(next) {
      current = next;
    },
    fail(error) {
      failNext = error;
    },
    async observe() {
      return look();
    },
    async perform(action): Promise<ScreenActOutcome> {
      actions.push(action);
      if (failNext) {
        const error = failNext;
        failNext = null;
        return { ok: false, error };
      }
      return { ok: true, observation: look() };
    },
    ...(make
      ? {
          async capture(region?: ScreenRegion) {
            captures.push(region);
            return make(region);
          },
          ...(options.regions ? { regions: true } : {}),
        }
      : {}),
  };
  return surface;
}

/** The whole 1280×800 desktop as an image. */
export const screenImage = (marks: ScreenImage["marks"] = []): ScreenImage => ({
  data: "FULL",
  width: 1280,
  height: 800,
  viewport: { width: 1280, height: 800 },
  marks,
});

/** A close-up of `region` at the screen's native size: a real image (one pixel), since a close-up is enlarged. */
export const closeUpOf = (region: ScreenRegion): ScreenImage => ({
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPom7XoPwAGTgLKI4t8IAAAAABJRU5ErkJggg==",
  width: region.width,
  height: region.height,
  viewport: { width: region.width, height: region.height },
  origin: { x: region.x, y: region.y },
});

/** A clock that moves 100 ms each time it is read: waits and graces end without real time passing. */
export function ticking() {
  let t = 0;
  return () => {
    t += 100;
    return t;
  };
}

/** Steps' actions without the pauses of waits and checks. */
export const acted = (actions: ScreenAction[]) => actions.filter((a) => a.kind !== "pause");

import { setTimeout as sleep } from "node:timers/promises";
import type { DesktopAction, DesktopLookReply, DesktopRegion, MachineReplies } from "@agenteschat/adapters";
import {
  normalizeWords,
  observeSnapshot,
  type ScreenAction,
  type ScreenActOutcome,
  type ScreenImage,
  type ScreenObservation,
  type ScreenSurface,
} from "../screen";

/**
 * The agent's desktop as a screen (ADR 0062): each action of a plan is one
 * `desktop.act`, which acts, waits for the screen to settle and looks again
 * in one round trip; a look is `desktop.look`, an image `desktop.capture`
 * (of a region too, for close-ups of small targets). Apps are named in words
 * and started by their desktop entry. Web pages belong to the browser.
 */

export type DesktopApp = MachineReplies["desktop.apps"]["apps"][number];

/** How one tool call reaches the agent's desktop (its computer and agent bound). Each throws the agent's words. */
export interface DesktopLink {
  look(): Promise<DesktopLookReply>;
  act(action: DesktopAction, settle: boolean): Promise<MachineReplies["desktop.act"]>;
  capture(region?: DesktopRegion): Promise<MachineReplies["desktop.capture"]>;
  apps(): Promise<DesktopApp[]>;
}

/** Why a web address isn't opened on the desktop. */
export const BROWSER_HINT =
  "web pages open in your browser: use browser_do for them (on the desktop, `open` takes an app or a file)";

export const observationOf = (look: DesktopLookReply): ScreenObservation =>
  observeSnapshot({ text: look.snapshot, url: look.address, title: look.title, refs: look.refs });

function imageOf(shot: MachineReplies["desktop.capture"]): ScreenImage {
  const r = shot.region;
  return {
    data: shot.data,
    width: shot.width,
    height: shot.height,
    viewport: r ? { width: r.width, height: r.height } : shot.screen,
    ...(r ? { origin: { x: r.x, y: r.y } } : {}),
    marks: shot.marks,
  };
}

/** Apps listed when the agent's words name none of them. */
const APPS_LISTED = 40;

/**
 * The app the agent named: the one whose name or entry id is its words, else
 * whose kind ("File Manager") is, else the one that shares the most words with
 * them (its name counting double; "files" finds "File Manager"). A tie, or
 * nothing in common, lists the apps to name one from.
 */
export function pickApp(named: string, apps: DesktopApp[]): { id: string } | { error: string } {
  const termsOf = (s: string) =>
    normalizeWords(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1);
  const asked = termsOf(named.replace(/^\s*(the|o|a)\s+/i, "").replace(/\s+app\s*$/i, ""));
  const entry = (a: DesktopApp) => a.id.replace(/\.desktop$/, "");
  const same = (s: string) => asked.length > 0 && termsOf(s).join(" ") === asked.join(" ");
  const one = (list: DesktopApp[]) => (list.length === 1 ? { id: (list[0] as DesktopApp).id } : null);
  const exact =
    one(apps.filter((a) => same(a.name) || same(entry(a)))) ??
    one(apps.filter((a) => a.generic !== undefined && same(a.generic)));
  if (exact) return exact;
  const wanted = asked.map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
  const hits = (s: string) => {
    const text = termsOf(s).join(" ");
    return wanted.filter((t) => text.includes(t)).length;
  };
  const ranked = apps
    .map((a) => ({ a, score: 2 * hits(a.name) + hits(a.generic ?? "") + hits(entry(a)) }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score);
  const [best, next] = ranked;
  if (best && (!next || next.score < best.score)) return { id: best.a.id };
  const names = (list: DesktopApp[]) => list.map((a) => JSON.stringify(a.name)).join(", ");
  if (best) {
    const tied = ranked.filter((r) => r.score === best.score).map((r) => r.a);
    return { error: `"${named}" could be ${names(tied.slice(0, 5))}: name one as written` };
  }
  const more = apps.length > APPS_LISTED ? ` and ${apps.length - APPS_LISTED} more` : "";
  return { error: `there is no app called "${named}" here; the apps: ${names(apps.slice(0, APPS_LISTED))}${more}` };
}

/** The runner's action for a step's, or why the desktop doesn't do it. */
function desktopAction(action: Exclude<ScreenAction, { kind: "launch" | "pause" }>): DesktopAction | string {
  switch (action.kind) {
    case "open":
      return BROWSER_HINT;
    case "back":
      return "a desktop has no back: press the app's own keys (alt+Left) or click its Back button";
    case "type_secret":
      return "passwords aren't typed into desktop apps: a person signs in (desktop_ask_person)";
    case "select":
      return "ref" in action.at
        ? { kind: "select", at: action.at, value: action.value }
        : "a list is picked by its element, not a point on the screen";
    default:
      return action;
  }
}

export interface DesktopSurfaceOptions {
  link: DesktopLink;
  /** The call's: a pause ends when it is aborted. */
  signal?: AbortSignal;
  /** Every look, as it happens (the caller keeps the last one). */
  onLook?: (o: ScreenObservation) => void;
  /** Every action the computer did, as sent (an app by its desktop entry, a file by its path). */
  onAct?: (action: DesktopAction) => void;
}

/** The desktop as a `ScreenSurface`: plans and reports say "screen", and close-ups of regions are taken. */
export function desktopSurface(options: DesktopSurfaceOptions): ScreenSurface {
  const { link } = options;
  let apps: Promise<DesktopApp[]> | null = null;
  const seen = (o: ScreenObservation) => {
    options.onLook?.(o);
    return o;
  };
  return {
    kind: "desktop",
    regions: true,
    async observe() {
      return seen(observationOf(await link.look()));
    },
    async perform(action, { settle }): Promise<ScreenActOutcome> {
      try {
        if (action.kind === "pause") {
          // Waiting needs nothing of the computer.
          await sleep(action.ms, undefined, { signal: options.signal }).catch(() => {});
          return { ok: true, observation: null };
        }
        let act: DesktopAction;
        if (action.kind === "launch") {
          apps ??= link.apps();
          const app = pickApp(action.app, await apps);
          if ("error" in app) return { ok: false, error: app.error };
          act = { kind: "launch", app: app.id };
        } else {
          const mapped = desktopAction(action);
          if (typeof mapped === "string") return { ok: false, error: mapped };
          act = mapped;
        }
        const reply = await link.act(act, settle);
        options.onAct?.(act);
        return { ok: true, observation: reply.look ? seen(observationOf(reply.look)) : null };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async capture(region) {
      try {
        return imageOf(await link.capture(region));
      } catch {
        return null;
      }
    },
  };
}

/**
 * Where an agent browsed, after the run (`meta.browser` on its message): the browser calls the
 * server kept (tool, the site of an open, when), never anything of the page itself (ADR 0040 §7).
 * The same for its desktop (`meta.desktop`, ADR 0062): the app an open started instead of the site.
 */

import type { ScreenKind } from "../api/types";

/** One call in the agent's browser (or on its desktop), as the message keeps it. */
export interface BrowserTrailStep {
  tool: string;
  /** The site of an open: host and path, no query string ("airbnb.com.br/rooms/48213"); an app on the desktop. */
  detail: string | null;
  at: string;
  failed: boolean;
  /** The shared browser profile it ran in, by its name then (ADR 0110); null: the agent's own browser. */
  profileName?: string | null;
}

/** The calls made on one page (or in one app): from an open (or a new tab) to the next one. */
export interface BrowserTrailPage {
  /** The page's address without the scheme, or the app's name; null before the first open. */
  site: string | null;
  host: string | null;
  path: string;
  steps: BrowserTrailStep[];
  /** A web address (it opens in the person's own browser), not an app. */
  link: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The steps on a message (`meta.browser.steps`, `meta.desktop.steps`), checked; empty when it didn't use that screen. */
export function screenTrailOf(meta: unknown, screen: ScreenKind): BrowserTrailStep[] {
  const kept = isObject(meta) ? meta[screen] : null;
  const steps = isObject(kept) ? kept.steps : null;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((s) =>
    isObject(s) && typeof s.tool === "string" && typeof s.at === "string" && !Number.isNaN(Date.parse(s.at))
      ? [
          {
            tool: s.tool,
            detail: typeof s.detail === "string" && s.detail ? s.detail : null,
            at: s.at,
            failed: s.failed === true,
            ...(typeof s.profileName === "string" && s.profileName ? { profileName: s.profileName } : {}),
          },
        ]
      : [],
  );
}

export const browserTrailOf = (meta: unknown) => screenTrailOf(meta, "browser");

/** The profile a trail ended in (the card's chip); null for the agent's own browser. */
export const trailProfile = (steps: BrowserTrailStep[]) => steps.at(-1)?.profileName ?? null;
export const desktopTrailOf = (meta: unknown) => screenTrailOf(meta, "desktop");

/** The opens that start a new page in the trail, and whether what they open is a web address. */
const OPENS: Record<string, { link: boolean }> = {
  browser_open: { link: true },
  browser_tabs: { link: true },
  desktop_open: { link: false },
};

/** "airbnb.com.br/rooms/1" → ["airbnb.com.br", "/rooms/1"]. */
export function splitSite(site: string): [string, string] {
  const i = site.indexOf("/");
  return i < 0 ? [site, ""] : [site.slice(0, i), site.slice(i)];
}

/** The trail by page: an open with a site (or an app) starts a page, the calls after it belong to it. */
export function browserTrailPages(steps: BrowserTrailStep[]): BrowserTrailPage[] {
  const pages: BrowserTrailPage[] = [];
  for (const s of steps) {
    const open = s.detail !== null && Object.hasOwn(OPENS, s.tool) ? OPENS[s.tool] : undefined;
    const last = pages.at(-1);
    if (!last || open) {
      // An app's name is whole ("Text Editor"), never a host and a path.
      const [host, path] = !open || !s.detail ? [null, ""] : open.link ? splitSite(s.detail) : [s.detail, ""];
      pages.push({ site: open ? s.detail : null, host, path, steps: [s], link: open?.link ?? false });
    } else last.steps.push(s);
  }
  return pages;
}

/** The sites (or apps) it visited, in order of first visit ("airbnb.com.br", "google.com"). */
export function browserTrailHosts(steps: BrowserTrailStep[]): string[] {
  const hosts: string[] = [];
  for (const p of browserTrailPages(steps)) if (p.host && !hosts.includes(p.host)) hosts.push(p.host);
  return hosts;
}

/** From its first call to its last. */
export function browserTrailSpanMs(steps: BrowserTrailStep[]): number {
  const first = steps[0];
  const last = steps.at(-1);
  return first && last ? Math.max(0, Date.parse(last.at) - Date.parse(first.at)) : 0;
}

/** A page's address to open in the person's own browser; null for anything that isn't a plain host. */
export function browserTrailHref(site: string | null): string | null {
  if (!site || !/^[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(site)) return null;
  return `https://${site}`;
}

/**
 * What a step was, for its pixel column: an open is the whole
 * column, reading most of it, an action a stub, a print two cells; a failure the whole column in red.
 */
export type BrowserTrailKind = "open" | "read" | "act" | "shot" | "failed";

export function browserTrailKind(s: Pick<BrowserTrailStep, "tool" | "failed">): BrowserTrailKind {
  if (s.failed) return "failed";
  if (Object.hasOwn(OPENS, s.tool) || s.tool === "desktop_open_file") return "open";
  if (s.tool === "browser_read" || s.tool === "desktop_read") return "read";
  if (s.tool === "browser_screenshot" || s.tool === "desktop_screenshot") return "shot";
  return "act";
}

/** One line of the list: a step, or two that alternate ("Leu a página e clicou"), `times` in a row. */
export interface BrowserTrailLine {
  steps: BrowserTrailStep[];
  times: number;
}

const sameStep = (a: BrowserTrailStep | undefined, b: BrowserTrailStep | undefined) =>
  Boolean(a && b && a.tool === b.tool && a.failed === b.failed && a.detail === b.detail);

/** How many times `steps[i, i + n)` repeats from `i` on. */
function repeats(steps: BrowserTrailStep[], i: number, n: number) {
  let k = 1;
  while (steps.slice(i, i + n).every((s, j) => sameStep(s, steps[i + k * n + j]))) k++;
  return k;
}

/** A page's steps as lines, repeats folded: a pair that alternates first, then the same step in a row. */
export function browserTrailLines(steps: BrowserTrailStep[]): BrowserTrailLine[] {
  const lines: BrowserTrailLine[] = [];
  let i = 0;
  while (i < steps.length) {
    const pair = i + 1 < steps.length && !sameStep(steps[i], steps[i + 1]) ? repeats(steps, i, 2) : 1;
    const n = pair >= 2 ? 2 : 1;
    const times = n === 2 ? pair : repeats(steps, i, 1);
    lines.push({ steps: steps.slice(i, i + n), times });
    i += n * times;
  }
  return lines;
}

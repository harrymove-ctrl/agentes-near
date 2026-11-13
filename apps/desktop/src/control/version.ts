import { CLOUD_SERVER } from "@agenteschat/client/lib/server";

/**
 * The "new version" check (ADR 0036 §9): `GET https://app.agentes.chat/api/desktop/latest?target=…&arch=…`
 * at start and every 6 hours. A newer version shows the notes and "Update and reopen" (the Tauri
 * updater, `update_install`); the download link and the manual steps are the fallback.
 */

/** Where the app's own updates come from, whichever server it opens. */
export const SITE_URL = CLOUD_SERVER;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The release's target for Rust's OS name (`std::env::consts::OS`), as the updater names it too. */
export function targetParam(os: string): string {
  if (os === "macos" || os === "darwin") return "darwin";
  return os;
}

export interface LatestRelease {
  version: string;
  url: string;
  sha256?: string;
  notes?: string;
  publishedAt?: string;
  minVersion?: string;
}

/** Our arch names in the URL: Node's (`arm64`, `x64`), from Rust's (`aarch64`, `x86_64`). */
export function archParam(rustArch: string): string {
  if (rustArch === "aarch64" || rustArch === "arm64") return "arm64";
  if (rustArch === "x86_64" || rustArch === "x64") return "x64";
  return rustArch;
}

export function latestUrl(os: string, rustArch: string, site: string = SITE_URL): string {
  const query = new URLSearchParams({ target: targetParam(os), arch: archParam(rustArch) });
  return `${site}/api/desktop/latest?${query}`;
}

interface Parsed {
  nums: number[];
  pre: string[];
}

function parse(v: string): Parsed | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m?.[1]) return null;
  return { nums: m[1].split(".").map(Number), pre: m[2] ? m[2].split(".") : [] };
}

/** Semver order: -1, 0 or 1. Unparseable versions sort first. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  const n = Math.max(pa.nums.length, pb.nums.length, 3);
  for (let i = 0; i < n; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export const isNewer = (latest: string, current: string) => compareVersions(latest, current) > 0;

/** The endpoint's JSON, checked; null when it isn't a release we can use. */
export function parseLatest(json: unknown): LatestRelease | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.version !== "string" || !parse(o.version)) return null;
  // The download opens in the browser: only our site, over https.
  if (typeof o.url !== "string" || !(o.url === SITE_URL || o.url.startsWith(`${SITE_URL}/`))) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    version: o.version,
    url: o.url,
    sha256: str(o.sha256),
    notes: str(o.notes),
    publishedAt: str(o.publishedAt),
    minVersion: str(o.minVersion),
  };
}

export interface UpdateState {
  latest: LatestRelease | null;
  /** A newer version exists. */
  available: boolean;
  /** Below `minVersion`: the app must be updated to keep working. */
  required: boolean;
}

export function updateStateOf(current: string, latest: LatestRelease | null): UpdateState {
  if (!latest) return { latest: null, available: false, required: false };
  const available = isNewer(latest.version, current);
  const required = !!latest.minVersion && compareVersions(current, latest.minVersion) < 0;
  return { latest, available, required };
}

/** The notes as list items: one per non-empty line, without a leading "-" or "*". */
export function noteLines(notes: string | undefined): string[] {
  return (notes ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** Preferences › Updates › "Install updates by itself, at night": unset, on while the server runs here. */
export const AUTO_UPDATE_PREF = "autoUpdate";

export const autoUpdateOn = (pref: boolean | null, serverHere: boolean) => pref ?? serverHere;

/** The night's install window, local time: from 03:00 until 05:00. */
const NIGHT_FROM = 3;
const NIGHT_UNTIL = 5;

/**
 * The night `now` falls in, while it is inside the install window ("2026-11-12"), else null: one try per night.
 */
export function installNight(now: Date): string | null {
  const hour = now.getHours();
  if (hour < NIGHT_FROM || hour >= NIGHT_UNTIL) return null;
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

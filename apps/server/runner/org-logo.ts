import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FetchFn } from "./pairing";

/**
 * The organization's logo for the desktop app (ADR 0036). After each
 * `welcome` the runner asks `GET /api/machines/org-logo` with its token (and
 * the cached ETag) and keeps the bytes in `<home>/org-logo.json`; the app
 * asks for it over the control channel (`org.logo`) as a `data:` URL, so the
 * token never reaches the web view.
 */

export const ORG_LOGO_FILE = "org-logo.json";
/** Bigger logos are not kept (the site crops them to 512×512, far below this). */
export const ORG_LOGO_MAX_BYTES = 512 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface CachedLogo {
  etag: string;
  contentType: string;
  base64: string;
}

export const orgLogoPath = (home: string) => path.join(home, ORG_LOGO_FILE);

/** The cached logo, or null when there is none or it can't be read. */
export function readCachedLogo(home: string): CachedLogo | null {
  try {
    const v = JSON.parse(readFileSync(orgLogoPath(home), "utf8")) as Partial<CachedLogo>;
    if (typeof v.etag !== "string" || typeof v.contentType !== "string" || typeof v.base64 !== "string") return null;
    return { etag: v.etag, contentType: v.contentType, base64: v.base64 };
  } catch {
    return null;
  }
}

export function removeCachedLogo(home: string) {
  rmSync(orgLogoPath(home), { force: true });
}

function writeCachedLogo(home: string, logo: CachedLogo) {
  const file = orgLogoPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(logo), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows
  }
  renameSync(tmp, file);
}

/** `data:image/png;base64,…` for the app; null for a type the app shouldn't draw. */
export function logoDataUrl(logo: CachedLogo | null): string | null {
  if (!logo || !TYPES.has(logo.contentType)) return null;
  return `data:${logo.contentType};base64,${logo.base64}`;
}

/**
 * Brings the cached logo up to date. Returns the logo now cached (the same
 * object when nothing changed). A network error or an unexpected status keeps
 * what is cached; 404 removes it; a logo too big or of another type is not kept.
 */
export async function syncOrgLogo(opts: {
  home: string;
  server: string;
  token: string;
  cached: CachedLogo | null;
  fetch?: FetchFn;
}): Promise<CachedLogo | null> {
  const { home, cached } = opts;
  const url = new URL(opts.server);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/machines/org-logo`;
  url.search = "";
  url.hash = "";
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url.toString(), {
      headers: { authorization: `Bearer ${opts.token}`, ...(cached ? { "if-none-match": cached.etag } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return cached;
  }
  if (res.status === 304) return cached;
  const drop = () => {
    removeCachedLogo(home);
    return null;
  };
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return drop();
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return cached;
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const etag = res.headers.get("etag") ?? "";
  if (!TYPES.has(contentType) || !etag || Number(res.headers.get("content-length") ?? "0") > ORG_LOGO_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return drop();
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return cached;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > ORG_LOGO_MAX_BYTES) return drop();
  const logo: CachedLogo = { etag, contentType, base64: Buffer.from(bytes).toString("base64") };
  if (cached && cached.etag === logo.etag && cached.base64 === logo.base64) return cached;
  try {
    writeCachedLogo(home, logo);
  } catch {
    // kept in memory until the next connection
  }
  return logo;
}

import { randomBytes } from "node:crypto";
import { docsUrl } from "@agenteschat/i18n/docs";
import { isPublicHostName, publicHostAddress, type ResolveHost, resolveHostDns } from "../net-guard";

/**
 * AI apps (ADR 0119): the addresses, scopes and token shapes of this server as an MCP server and its own
 * OAuth 2.1 authorization server. One helper for every address, so the metadata, the 401 challenge and the
 * address shown in Settings never drift apart.
 */

/** Each scope brings the ones before it: `write` sends tasks, `manage` creates agents, routines and skills. */
export const APP_SCOPES = ["read", "write", "manage"] as const;
export type AppScope = (typeof APP_SCOPES)[number];
/** The access a person picks on the consent page or for a token: its widest scope. */
export type AppAccess = AppScope;

/** The scopes an access grants: itself and every scope before it. */
export const appScopesFor = (access: AppAccess): AppScope[] => APP_SCOPES.slice(0, APP_SCOPES.indexOf(access) + 1);

/** The widest scope held, as Settings shows it. */
export const appAccessOf = (scopes: readonly string[]): AppAccess =>
  [...APP_SCOPES].reverse().find((s) => scopes.includes(s)) ?? "read";

export const ACCESS_TOKEN_PREFIX = "aga_";
export const REFRESH_TOKEN_PREFIX = "agf_";
export const PERSONAL_TOKEN_PREFIX = "agp_";
export const DCR_CLIENT_PREFIX = "agcl_";

export const APP_LIMITS = {
  requestMs: 30 * 60_000,
  codeMs: 120_000,
  accessMs: 3600_000,
  /** Cursor's refresh is reported flaky: its access tokens live a working day. */
  cursorAccessMs: 8 * 3600_000,
  /** Sliding: each refresh starts it again. A grant unused this long is revoked. */
  refreshMs: 90 * 86_400_000,
  /** A rotated refresh token presented again within this: a client's retry, not a theft. */
  refreshGraceMs: 60_000,
  personalTokensPerWorkspace: 10,
  personalTokenNameChars: 60,
  clientNameChars: 64,
  redirectUris: 10,
  redirectUriChars: 512,
  stateChars: 4096,
} as const;

/** The server's base address with no trailing slash: the issuer, and the base of every other address. */
export function appsUrls(publicUrl: string) {
  const issuer = publicUrl.replace(/\/+$/, "");
  return {
    issuer,
    /** What people paste into their app, and the OAuth resource identifier. */
    resource: `${issuer}/mcp`,
    resourceMetadata: `${issuer}/.well-known/oauth-protected-resource/mcp`,
    authorize: `${issuer}/api/oauth/authorize`,
    token: `${issuer}/api/oauth/token`,
    register: `${issuer}/api/oauth/register`,
    revoke: `${issuer}/api/oauth/revoke`,
    consentPage: `${issuer}/autorizar`,
    docs: docsUrl("en", "apps-de-ia"),
    /** PNG first: clients that draw icons must support PNG, SVG only should (and directories ask for 512 px). */
    icon: `${issuer}/icon-512.png`,
    iconSvg: `${issuer}/favicon.svg`,
  };
}

/**
 * A `resource` parameter compared the way clients spell it (RFC 8707): lowercase host, no default port, and at
 * most one trailing slash dropped. Null when it isn't a URL.
 */
export function normalizeResource(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.hash || url.search) return null;
    const port = url.port && !(url.protocol === "https:" && url.port === "443") ? `:${url.port}` : "";
    const path = url.pathname.replace(/\/$/, "");
    return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}`;
  } catch {
    return null;
  }
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `length` random base62 characters (rejection sampling, so every character is equally likely). */
export function randomBase62(length = 43): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Scopes as stored, from a space-separated request: unknown ones (and `offline_access`) dropped, none = all. The
 * widest one asked brings the ones before it (sending tasks without reading their replies is no use).
 */
export function parseScopes(raw: string | undefined | null): AppScope[] {
  const asked = new Set((raw ?? "").split(/\s+/).filter(Boolean));
  const known = APP_SCOPES.filter((s) => asked.has(s));
  return known.length === 0 ? [...APP_SCOPES] : appScopesFor(appAccessOf(known));
}

const reachable = new Map<string, boolean>();

/**
 * Whether apps that call from their own servers (claude.ai, ChatGPT) can reach this server: https on a public DNS
 * name that doesn't resolve to a private address (split DNS). A self-hosted server on a private host can't take
 * them, so what needs them is hidden there. Resolved once per process; a failed lookup is retried next time.
 */
export async function reachableFromInternet(
  publicUrl: string,
  resolve: ResolveHost = resolveHostDns,
): Promise<boolean> {
  const known = reachable.get(publicUrl);
  if (known !== undefined) return known;
  let host: string;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || !isPublicHostName(url.hostname)) return false;
    host = url.hostname;
  } catch {
    return false;
  }
  const resolved = await publicHostAddress(host, resolve);
  if (!resolved.ok && resolved.reason === "unreachable") return true;
  reachable.set(publicUrl, resolved.ok);
  return resolved.ok;
}

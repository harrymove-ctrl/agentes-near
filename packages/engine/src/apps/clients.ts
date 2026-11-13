import { isIP } from "node:net";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { fetchPublicDocument, type PublicDocument } from "../net-guard";
import { APP_LIMITS, DCR_CLIENT_PREFIX, randomBase62 } from "./urls";

const { oauthAppClients } = schema;

/**
 * The apps that connect (ADR 0119 §1.6): registered here (DCR) or named by the https address of their metadata
 * document (CIMD). Only a name and return addresses are kept; logos, home pages and pinned scopes an app sends are
 * dropped, so nothing an app claims about itself reaches a consent screen except its name, shown as unverified.
 */

/** The one custom scheme accepted: Cursor's own callback. Every other custom scheme can be claimed by any program. */
export const CURSOR_CALLBACK = "cursor://anysphere.cursor-mcp/oauth/callback";

/** Control, format (zero-width, direction), invisible and line-breaking characters: none belongs in a name. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;

export const cleanAppName = (name: unknown, max: number = APP_LIMITS.clientNameChars): string | null => {
  if (typeof name !== "string") return null;
  const clean = name.replace(HIDDEN, "").replace(/\s+/g, " ").trim();
  return clean ? [...clean].slice(0, max).join("") : null;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const isLoopbackUrl = (url: URL) => url.protocol === "http:" && LOOPBACK.has(url.hostname);

const parseUrl = (raw: string) => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** Whether an app may register this return address: https, http on this computer, or Cursor's own callback. */
export function redirectUriAllowed(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > APP_LIMITS.redirectUriChars) return false;
  if (raw === CURSOR_CALLBACK) return true;
  const url = parseUrl(raw);
  if (!url || url.hash || raw.includes("#") || url.username || url.password) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  return isLoopbackUrl(url);
}

/**
 * A presented return address against an app's list: exact, except that an address on this computer matches any
 * port (RFC 8252 §7.3: a native app gets one from the system when it starts listening) and any of the loopback
 * names, on the same scheme and path.
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  const got = parseUrl(presented);
  if (!got || !isLoopbackUrl(got) || got.hash) return false;
  return registered.some((candidate) => {
    const want = parseUrl(candidate);
    return !!want && isLoopbackUrl(want) && want.pathname === got.pathname && want.search === got.search;
  });
}

export type RegistrationResult =
  | {
      ok: true;
      client: {
        client_id: string;
        client_id_issued_at: number;
        client_name?: string;
        redirect_uris: string[];
        grant_types: string[];
        response_types: string[];
        token_endpoint_auth_method: "none";
      };
    }
  | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata" | "rate_limited"; description: string };

/**
 * `POST /api/oauth/register` (RFC 7591): always a public client with PKCE, whatever it asked for. `admit` runs once
 * the request is valid (the global cap counts registrations, not attempts).
 */
export async function registerApp(
  db: Database,
  body: unknown,
  admit: () => Promise<boolean> = async () => true,
): Promise<RegistrationResult> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { ok: false, error: "invalid_client_metadata", description: "Send a JSON object" };
  const input = body as Record<string, unknown>;
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > APP_LIMITS.redirectUris)
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description: `redirect_uris needs 1 to ${APP_LIMITS.redirectUris} addresses`,
    };
  const bad = uris.find((u) => !redirectUriAllowed(u));
  if (bad !== undefined)
    return {
      ok: false,
      error: "invalid_redirect_uri",
      description:
        "Each redirect URI must be https, http on localhost, 127.0.0.1 or [::1], or Cursor's callback, with no fragment",
    };
  if (!(await admit()))
    return { ok: false, error: "rate_limited", description: "Too many registrations. Try again later." };
  const name = cleanAppName(input.client_name);
  const id = `${DCR_CLIENT_PREFIX}${randomBase62(32)}`;
  const [row] = await db
    .insert(oauthAppClients)
    .values({ id, kind: "dcr", name, redirectUris: [...new Set(uris as string[])] })
    .returning();
  if (!row) throw new Error("client not stored");
  return {
    ok: true,
    client: {
      client_id: row.id,
      client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
      ...(row.name ? { client_name: row.name } : {}),
      redirect_uris: row.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

// ── CIMD ──────────────────────────────────────────────────────────────────────

const CIMD = {
  cacheMs: 300_000,
  failureMs: 20_000,
  staleMs: 86_400_000,
  maxBytes: 64 * 1024,
  timeoutMs: 3_000,
  inFlight: 3,
  queue: 6,
};

/** Fetches an app's metadata document. Swapped in tests (no network). */
export type FetchAppDocument = (url: URL) => Promise<PublicDocument>;

export const fetchAppDocument: FetchAppDocument = (url) =>
  fetchPublicDocument(url, { maxBytes: CIMD.maxBytes, timeoutMs: CIMD.timeoutMs });

/** Whether a `client_id` names a metadata document: https, a path, no user, fragment, IP address or localhost. */
export function cimdClientIdUrl(raw: string): URL | null {
  if (!raw.startsWith("https://")) return null;
  const url = parseUrl(raw);
  if (url?.protocol !== "https:" || url.pathname === "/" || !url.pathname) return null;
  if (url.username || url.password || url.hash || raw.includes("#")) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || isIP(host)) return null;
  return url;
}

/** Failures stay briefly, in this process only: a blip must not lock a real app out for long. */
const failures = new Map<string, number>();
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(work: () => Promise<T>): Promise<T | "busy"> {
  if (running >= CIMD.inFlight) {
    if (waiting.length >= CIMD.queue) return "busy";
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

type CimdDoc = { name: string | null; redirectUris: string[] };

function parseCimd(clientId: string, doc: PublicDocument): CimdDoc | null {
  if (!doc.contentType?.toLowerCase().includes("application/json")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(doc.body.toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  // The document must claim the address it came from, or any page could pose as another app.
  if (d.client_id !== clientId) return null;
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > APP_LIMITS.redirectUris) return null;
  if (!uris.every(redirectUriAllowed)) return null;
  const method = d.token_endpoint_auth_method ?? "none";
  // A client that signs its requests (ChatGPT's private_key_jwt) still connects as a public one with PKCE.
  if (method !== "none" && method !== "private_key_jwt") return null;
  return { name: cleanAppName(d.client_name), redirectUris: uris as string[] };
}

export type ResolvedApp = schema.OauthAppClient;

/**
 * The app behind a `client_id`: a registered one, or a metadata document fetched (and kept 5 minutes; an older
 * copy up to a day old when a new fetch fails). `busy` when too many documents are being fetched now.
 */
export async function resolveApp(
  db: Database,
  clientId: string,
  fetchDoc: FetchAppDocument = fetchAppDocument,
  now = new Date(),
): Promise<ResolvedApp | "busy" | null> {
  if (!clientId || clientId.length > 2048) return null;
  const [row] = await db.select().from(oauthAppClients).where(eq(oauthAppClients.id, clientId));
  if (row?.kind === "dcr") return row;
  const url = cimdClientIdUrl(clientId);
  if (!url) return null;
  const fresh = row?.fetchedAt && now.getTime() - row.fetchedAt.getTime() < CIMD.cacheMs;
  if (row && fresh) return row;
  const stale = row?.fetchedAt && now.getTime() - row.fetchedAt.getTime() < CIMD.staleMs ? row : null;
  const failedAt = failures.get(clientId);
  if (failedAt && now.getTime() - failedAt < CIMD.failureMs) return stale;
  const doc = await slot(async () => {
    try {
      return parseCimd(clientId, await fetchDoc(url));
    } catch {
      return null;
    }
  });
  if (doc === "busy") return stale ?? "busy";
  if (!doc) {
    failures.set(clientId, now.getTime());
    if (failures.size > 10_000) failures.clear();
    return stale;
  }
  failures.delete(clientId);
  const [saved] = await db
    .insert(oauthAppClients)
    .values({ id: clientId, kind: "cimd", name: doc.name, redirectUris: doc.redirectUris, fetchedAt: now })
    .onConflictDoUpdate({
      target: oauthAppClients.id,
      set: { name: doc.name, redirectUris: doc.redirectUris, fetchedAt: now },
      setWhere: eq(oauthAppClients.kind, "cimd"),
    })
    .returning();
  return saved ?? null;
}

/** Test hook: forget fetch failures between tests. */
export const resetAppDocumentFailures = () => failures.clear();

// ── How an app is shown ──────────────────────────────────────────────────────

export type AppDisplayKind = "verified" | "https" | "loopback" | "app_scheme";

/** A known app's mark, only from an address it proved: its metadata document's host or where its codes go. */
const BRAND_HOSTS: Record<string, string> = {
  "claude.ai": "claude",
  "claude.com": "claude",
  "chatgpt.com": "openai",
  "cursor.com": "cursor",
  "www.cursor.com": "cursor",
  "vscode.dev": "vscode",
  "insiders.vscode.dev": "vscode",
};

/** Names an unverified app may not take without a warning, and the hosts that own each. */
const RESERVED: [word: string, hosts: string[]][] = [
  ["claude", ["claude.ai", "claude.com"]],
  ["chatgpt", ["chatgpt.com", "openai.com"]],
  ["openai", ["chatgpt.com", "openai.com"]],
  ["cursor", ["cursor.com", "www.cursor.com"]],
  ["agentes", []],
];

const brandOf = (host: string | null) => (host ? (BRAND_HOSTS[host.toLowerCase()] ?? null) : null);

export interface AppIdentity {
  displayKind: AppDisplayKind;
  name: string;
  host: string | null;
  brand: string | null;
  /** Where the browser goes back to, as shown: a host (with its port on this computer) or `scheme://host`. */
  returnsTo: string;
  /** An unverified app named like a known one whose address isn't that one's. */
  reservedNameWarning: boolean;
  /** Cursor's access tokens live longer (its refresh is flaky). */
  cursor: boolean;
}

/**
 * How the consent page, the list in Settings and the "via" tag show an app: from this request's return address
 * (never the one the app registered first), and from its metadata document's host when it has one. Only a known
 * app's own host is shown as verified with its name as the title. A return address on this computer is always a
 * program there, whatever document it names: any local program can start a sign-in with a known app's `client_id`
 * and its own port (the CIMD spec's localhost impersonation).
 */
export function appIdentity(
  client: Pick<ResolvedApp, "id" | "kind" | "name">,
  redirectUri: string,
  ownHost?: string,
): AppIdentity {
  const redirect = parseUrl(redirectUri);
  const returnsTo = redirect
    ? redirect.protocol === "http:" || redirect.protocol === "https:"
      ? redirect.host
      : `${redirect.protocol}//${redirect.host}`
    : "";
  const cursor =
    redirectUri === CURSOR_CALLBACK || redirect?.hostname === "cursor.com" || redirect?.hostname === "www.cursor.com";
  const fallbackName = client.name ?? "";
  let identity: Omit<AppIdentity, "reservedNameWarning" | "returnsTo" | "cursor">;
  if (redirectUri === CURSOR_CALLBACK) {
    identity = { displayKind: "app_scheme", name: "Cursor", host: null, brand: "cursor" };
  } else if (redirect && isLoopbackUrl(redirect)) {
    identity = { displayKind: "loopback", name: fallbackName, host: null, brand: null };
  } else if (client.kind === "cimd") {
    const host = parseUrl(client.id)?.hostname.toLowerCase() ?? null;
    const brand = brandOf(host);
    identity = {
      displayKind: brand ? "verified" : "https",
      name: fallbackName || (host ?? ""),
      host,
      brand,
    };
  } else {
    const host = redirect?.hostname ?? null;
    identity = { displayKind: "https", name: fallbackName || (host ?? ""), host, brand: brandOf(host) };
  }
  const folded = identity.name.toLowerCase();
  const host = identity.host?.toLowerCase() ?? (identity.displayKind === "app_scheme" ? "cursor.com" : null);
  const reservedNameWarning = RESERVED.some(
    ([word, hosts]) =>
      folded.includes(word) &&
      !(host && (hosts.includes(host) || (word === "agentes" && ownHost && host === ownHost.toLowerCase()))),
  );
  return { ...identity, returnsTo, reservedNameWarning, cursor };
}

/** Marks an app as used (a token was issued to it): a registration with no connection goes 90 days after its last use. */
export async function touchApp(db: Database, clientId: string) {
  await db
    .update(oauthAppClients)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(oauthAppClients.id, clientId),
        sql`coalesce(${oauthAppClients.lastUsedAt}, 'epoch') < now() - interval '1 minute'`,
      ),
    );
}

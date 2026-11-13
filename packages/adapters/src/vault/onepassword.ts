/**
 * 1Password as a Vault source (ADR 0144): a service account the person creates with access to one vault only (the
 * connection refuses one that sees more), read through 1Password's own SDK. A service account made with read and
 * write access to the vault also keeps new logins and changes a login's username or password; one that only reads
 * is refused by 1Password at the write, which comes out as `read_only`.
 *
 * - The SDK is loaded when a 1Password connection is first used, never at boot: a server with no such connection
 *   never loads it. If it can't load here, the source says `unsupported`.
 * - Service accounts have read limits, so `list` reads item overviews (one call) and a full item only when it is new
 *   or changed since the last list: the usernames it finds are kept in memory per connection, keyed by the item's
 *   ref and its `updatedAt`. Nothing secret is kept: a password is read in `reveal` and returned, never stored.
 * - The SDK takes no abort signal: every call is bounded by a 15 s timeout (we stop waiting; the call ends on its
 *   own). An SDK client is reused for 10 minutes per connection.
 * - The SDK's errors are mapped to our codes by their class and their text. Their text is never passed on: it may
 *   carry the token.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { SECRET_NAME } from "../secret-box";
import { type VaultMatch, vaultOrigin } from "./site";
import {
  type VaultConnection,
  type VaultConnectResult,
  type VaultItemKind,
  type VaultLoginChange,
  type VaultNewLogin,
  type VaultSecretField,
  type VaultSource,
  type VaultSourceDescriptor,
  VaultSourceError,
  type VaultSourceErrorCode,
  type VaultSourceItem,
} from "./source";

export const ONEPASSWORD_SOURCE_KIND = "onepassword";

/** The part of an item list filter this source uses (the SDK's `ItemListFilter`). */
export type OnePasswordItemFilter = { type: "ByState"; content: { active: boolean; archived: boolean } };

/** The part of a vault overview this source reads. */
export interface OnePasswordVault {
  id: string;
  title: string;
}

/** The part of an item overview this source reads (no secret is in an overview). */
export interface OnePasswordOverview {
  id: string;
  title: string;
  category: string;
  vaultId: string;
  websites: { url: string; autofillBehavior: string }[];
  updatedAt: Date | string;
  state?: string;
}

/** The part of a full item this source reads. */
export interface OnePasswordItem {
  id: string;
  title: string;
  category: string;
  vaultId: string;
  fields: { id: string; title: string; sectionId?: string; fieldType: string; value: string }[];
  websites?: { url: string; label?: string; autofillBehavior: string }[];
  updatedAt?: Date | string;
}

/** What this source sends to create a login (the SDK's `ItemCreateParams`). */
export interface OnePasswordNewItem {
  category: "Login";
  vaultId: string;
  title: string;
  fields: { id: string; title: string; fieldType: string; value: string }[];
  websites?: { url: string; label: string; autofillBehavior: string }[];
  notes?: string;
}

/** The part of the SDK's client this source uses. The real `@1password/sdk` module satisfies it. */
export interface OnePasswordClient {
  vaults: { list(params?: { decryptDetails?: boolean }): Promise<OnePasswordVault[]> };
  items: {
    list(vaultId: string, ...filters: OnePasswordItemFilter[]): Promise<OnePasswordOverview[]>;
    get(vaultId: string, itemId: string): Promise<OnePasswordItem>;
    getAll(
      vaultId: string,
      itemIds: string[],
    ): Promise<{ individualResponses: { content?: OnePasswordItem; error?: { type: string } }[] }>;
    create(params: OnePasswordNewItem): Promise<OnePasswordItem>;
    /** Replaces the item with what is given: always the item as `get` returned it, with only our change. */
    put(item: OnePasswordItem): Promise<OnePasswordItem>;
  };
}

type ErrorClass = new (...args: never[]) => Error;

/** What this source passes to `createClient`. */
export interface OnePasswordClientConfig {
  auth: string;
  integrationName: string;
  integrationVersion: string;
}

/** The part of the SDK module this source uses (tests pass a fake through `loadSdk`). */
export interface OnePasswordSdk {
  createClient(config: OnePasswordClientConfig): Promise<OnePasswordClient>;
  RateLimitExceededError?: ErrorClass;
  AuthExpiredError?: ErrorClass;
}

export interface OnePasswordSourceOptions {
  /** Loads the SDK (default: `import("@1password/sdk")`, once). */
  loadSdk?: () => Promise<OnePasswordSdk>;
  /** The clock for the client's lifetime and `retryAt` (tests pass a fake). */
  now?: () => number;
  /** Per SDK call; 15 s by default. */
  timeoutMs?: number;
  /** Reported to 1Password with every call, with the name `agentes.chat`. */
  integrationVersion?: string;
}

const TIMEOUT_MS = 15_000;
const CLIENT_TTL_MS = 10 * 60_000;
/** Service accounts' limits are counted per hour: the next sync (10 minutes on) is the earliest worth trying. */
const RATE_LIMIT_RETRY_MS = 10 * 60_000;
const INTEGRATION_NAME = "agentes.chat";
const INTEGRATION_VERSION = "v1.0.0";
const READ_BATCH = 50;
const ACTIVE_ONLY: OnePasswordItemFilter = { type: "ByState", content: { active: true, archived: false } };
/** 1Password ids are 26 base-32 characters; anything else is no ref of ours. */
const ITEM_ID = /^[a-z0-9]{1,64}$/i;

const MESSAGES = {
  token: "Paste a service account token. It starts with ops_.",
  connection: "This connection is missing settings. Connect it again.",
  unsupported: "1Password can't be used on this server.",
  authFailed: "1Password didn't accept this token. Create a new one and connect again.",
  noVault: "The service account can't see any vault. Give it access to the vault with your agents' logins.",
  vaultGone: "The service account can no longer see this vault.",
  manyVaults: "The service account sees more than one vault. Give it access to one vault only.",
  notFound: "This item is no longer in the vault.",
  readOnly: "This service account can only read this vault.",
  notALogin: "This item isn't a login.",
  rateLimited: "1Password asked us to wait before reading more.",
  unreachable: "Couldn't reach 1Password.",
  timeout: "1Password took too long to answer.",
  cancelled: "The request was cancelled.",
} as const;

const fail = (code: VaultSourceErrorCode, message: string, retryAt?: string) =>
  new VaultSourceError(code, message, retryAt);

const DESCRIPTOR: VaultSourceDescriptor = {
  kind: ONEPASSWORD_SOURCE_KIND,
  name: "1Password",
  kinds: ["login", "key"],
  steps: [
    "Create a vault in 1Password only for your agents and move into it the logins they may use",
    "Create a service account with access to that vault only (read and write, if your agents should save new logins there)",
    "Paste the service account token here",
  ],
  fields: [{ id: "token", kind: "secret", label: "Service account token", required: true, placeholder: "ops_…" }],
  helpUrl: "https://developer.1password.com/docs/service-accounts/get-started/",
};

async function importSdk(): Promise<OnePasswordSdk> {
  const mod = await import("@1password/sdk");
  // The SDK types what it takes with string enums (`ItemCategory.Login` is "Login"); this source sends those strings.
  if (typeof mod.createClient === "function") return mod as unknown as OnePasswordSdk;
  // The SDK is CommonJS: some loaders only give its exports as `default`.
  const fallback = (mod as unknown as { default?: OnePasswordSdk }).default;
  if (fallback && typeof fallback.createClient === "function") return fallback;
  throw new Error("The 1Password SDK has no createClient");
}

function kindOf(category: string): VaultItemKind | null {
  if (category === "Login") return "login";
  if (category === "ApiCredentials") return "key";
  return null;
}

function stampOf(value: Date | string | undefined): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? value : new Date(time).toISOString();
  }
  return "";
}

/** 1Password's autofill behavior to our rule: anywhere fills the whole site, exact domain the origin, never nothing. */
function matchOf(autofill: string): VaultMatch | null {
  if (autofill === "AnywhereOnWebsite") return "site";
  if (autofill === "Never") return null;
  // ExactDomain, and any behavior the SDK may add later: the narrower rule.
  return "exact";
}

function websitesOf(websites: OnePasswordOverview["websites"] | undefined): { url: string; match: VaultMatch }[] {
  const out: { url: string; match: VaultMatch }[] = [];
  const seen = new Set<string>();
  for (const website of websites ?? []) {
    const match = matchOf(website.autofillBehavior);
    // Only HTTPS addresses, kept as their origin: a path or a query never leaves the source.
    const origin = typeof website.url === "string" ? vaultOrigin(website.url) : null;
    if (!match || !origin || seen.has(`${match} ${origin}`)) continue;
    seen.add(`${match} ${origin}`);
    out.push({ url: origin, match });
  }
  return out;
}

/** The variable name for a key: the title when it is one (`OPENAI_API_KEY`), else the title upper-snaked. */
export function keyNameFromTitle(title: string): string | undefined {
  const trimmed = title.trim();
  if (SECRET_NAME.test(trimmed)) return trimmed;
  let snake = trimmed
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!snake) return undefined;
  if (/^[0-9]/.test(snake)) snake = `KEY_${snake}`;
  snake = snake.slice(0, 64).replace(/_+$/, "");
  return SECRET_NAME.test(snake) ? snake : undefined;
}

/** A login's username from its full item: the built-in field, else a visible field titled so. Never a hidden one. */
function usernameOf(item: OnePasswordItem): string | undefined {
  const fields = item.fields ?? [];
  const field =
    fields.find((f) => f.id === "username" && f.fieldType !== "Concealed") ??
    fields.find((f) => !f.sectionId && /^(username|user name|email)$/i.test(f.title) && f.fieldType !== "Concealed");
  const value = field?.value?.trim();
  return value || undefined;
}

/** The one secret a reveal returns: a login's password or an API credential's credential. */
function secretOf(item: OnePasswordItem, field: VaultSecretField): string | undefined {
  const fields = item.fields ?? [];
  const concealed = (f: OnePasswordItem["fields"][number]) => f.fieldType === "Concealed";
  let found: OnePasswordItem["fields"][number] | undefined;
  if (item.category === "Login" && field === "password") {
    found = fields.find((f) => f.id === "password") ?? fields.find((f) => concealed(f) && /password/i.test(f.title));
  } else if (item.category === "ApiCredentials" && field === "key") {
    found =
      fields.find((f) => f.id === "credential") ??
      fields.find((f) => concealed(f) && /credential|key|token/i.test(f.title));
  }
  return found?.value || undefined;
}

/** A login as `list` gives it, from its full item. Never a concealed field. */
function loginOf(item: OnePasswordItem): VaultSourceItem {
  const websites = websitesOf(item.websites);
  const username = usernameOf(item);
  const updatedAt = stampOf(item.updatedAt) || undefined;
  return {
    ref: item.id,
    kind: "login",
    title: item.title?.trim() || "Login",
    ...(websites.length > 0 ? { websites } : {}),
    ...(username ? { username } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** The item with one built-in field set (added when the item has none by that id), everything else as it was. */
function withField(item: OnePasswordItem, id: "username" | "password", value: string): OnePasswordItem {
  const fieldType = id === "password" ? "Concealed" : "Text";
  const has = item.fields.some((f) => f.id === id);
  return {
    ...item,
    fields: has
      ? item.fields.map((f) => (f.id === id ? { ...f, value } : f))
      : [...item.fields, { id, title: id, fieldType, value }],
  };
}

function isSdkError(err: unknown, cls: ErrorClass | undefined, name: string): boolean {
  if (typeof cls === "function" && err instanceof cls) return true;
  return err instanceof Error && err.constructor?.name === name;
}

type Context = "connect" | "list" | "reveal" | "write";

/** What the SDK's untyped errors say, by kind (read only to pick a code, never passed on). */
const SAYS_RATE_LIMITED = /rate.?limit|too many requests|\b429\b/i;
const SAYS_AUTH_FAILED =
  /unauthori[sz]ed|forbidden|\b40[13]\b|authenticat|invalid.{0,40}token|token.{0,40}(invalid|expired|revoked)|signature/i;
/**
 * A token the SDK can't use, in its own words (SDK 0.5.0): "bad service account token, please rotate it",
 * "service account token base64 decoding failed, please create another token", "secret key was the wrong length",
 * "account couldn't be found". Connecting again with it can't work.
 */
const SAYS_BAD_TOKEN =
  /bad service account token|create (another|a new) token|secret key|account (couldn't|could not) be found/i;
/**
 * A write the service account may not make. 1Password's own words for it speak of permissions ("you do not have the
 * right permissions to perform this action"); a refusal by status alone is taken the same way, since the same token
 * has just read the vault.
 */
const SAYS_NO_PERMISSION = /permission|forbidden|not allowed|read.?only|\b403\b/i;
/** A missing item or vault (the SDK 0.5.0 says "item couldn't be found"). */
const SAYS_NOT_FOUND = /not.?found|no item|could(n't| not) be found|does ?n[o']t exist|\b404\b/i;

/**
 * Our code for an SDK failure. The SDK raises typed errors only for rate limits and expired sessions; anything else
 * is a plain `Error` whose text is all there is, so it is read here (and only here) to pick a code.
 */
function classify(err: unknown, sdk: OnePasswordSdk | null, context: Context, now: number): VaultSourceError {
  if (err instanceof VaultSourceError) return err;
  const retryAt = () => new Date(now + RATE_LIMIT_RETRY_MS).toISOString();
  if (isSdkError(err, sdk?.RateLimitExceededError, "RateLimitExceededError")) {
    return fail("rate_limited", MESSAGES.rateLimited, retryAt());
  }
  if (isSdkError(err, sdk?.AuthExpiredError, "AuthExpiredError")) return fail("auth_failed", MESSAGES.authFailed);
  const said = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (SAYS_RATE_LIMITED.test(said)) return fail("rate_limited", MESSAGES.rateLimited, retryAt());
  if (context === "write" && SAYS_NO_PERMISSION.test(said)) return fail("read_only", MESSAGES.readOnly);
  if (SAYS_AUTH_FAILED.test(said) || SAYS_BAD_TOKEN.test(said)) return fail("auth_failed", MESSAGES.authFailed);
  if (context !== "connect" && SAYS_NOT_FOUND.test(said)) {
    return context === "list" ? fail("no_vault", MESSAGES.vaultGone) : fail("not_found", MESSAGES.notFound);
  }
  return fail("unreachable", MESSAGES.unreachable);
}

interface ClientEntry {
  fingerprint: string;
  client: Promise<OnePasswordClient>;
  expiresAt: number;
}

interface ReadCache {
  fingerprint: string;
  /** `ref + "\n" + updatedAt` → what the full read found. Never a secret. */
  reads: Map<string, { username?: string }>;
}

/** 1Password through a service account (ADR 0144). One instance serves every connection of the server process. */
export function createOnePasswordSource(options: OnePasswordSourceOptions = {}): VaultSource {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const integrationVersion = options.integrationVersion ?? INTEGRATION_VERSION;
  const loadSdk = options.loadSdk ?? importSdk;
  let sdkPromise: Promise<OnePasswordSdk> | null = null;
  let sdk: OnePasswordSdk | null = null;
  const clients = new Map<string, ClientEntry>();
  const caches = new Map<string, ReadCache>();
  const fingerprintKey = globalThis.crypto.getRandomValues(new Uint8Array(32));

  const fingerprint = (token: string, vaultId: string) =>
    Array.from(hmac(sha256, fingerprintKey, new TextEncoder().encode(`${vaultId}\n${token}`)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

  async function theSdk(): Promise<OnePasswordSdk> {
    if (!sdkPromise) {
      sdkPromise = loadSdk().then(
        (loaded) => {
          sdk = loaded;
          return loaded;
        },
        () => {
          // Tried again on the next call: the failure may have been passing.
          sdkPromise = null;
          throw fail("unsupported", MESSAGES.unsupported);
        },
      );
    }
    return sdkPromise;
  }

  /**
   * Runs an SDK call and waits for it at most `timeoutMs`, or until `signal` aborts; maps its failure (thrown or
   * rejected) to our codes.
   */
  function bounded<T>(call: () => Promise<T>, context: Context, signal?: AbortSignal): Promise<T> {
    let work: Promise<T>;
    try {
      work = Promise.resolve(call());
    } catch (err) {
      work = Promise.reject(err);
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = () => finish(() => reject(fail("unreachable", MESSAGES.cancelled)));
      const timer = setTimeout(() => finish(() => reject(fail("unreachable", MESSAGES.timeout))), timeoutMs);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => finish(() => resolve(value)),
        (err) => finish(() => reject(classify(err, sdk, context, now()))),
      );
    });
  }

  function readConnection(connection: VaultConnection) {
    const token = connection.secret.token ?? "";
    const vaultId = connection.config.vaultId ?? "";
    if (!token || !vaultId) throw fail("invalid_input", MESSAGES.connection);
    return { token, vaultId, fingerprint: fingerprint(token, vaultId) };
  }

  /** The connection's client: kept (fresh: false) or newly created (fresh: true). */
  async function clientFor(connection: VaultConnection, signal?: AbortSignal) {
    const { token, vaultId, fingerprint: print } = readConnection(connection);
    const kept = clients.get(connection.id);
    if (kept && kept.fingerprint === print && kept.expiresAt > now()) {
      return { client: await bounded(() => kept.client, "list", signal), vaultId, print, fresh: false };
    }
    const loaded = await theSdk();
    let client: Promise<OnePasswordClient>;
    try {
      client = Promise.resolve(
        loaded.createClient({ auth: token, integrationName: INTEGRATION_NAME, integrationVersion }),
      );
    } catch (err) {
      client = Promise.reject(err);
    }
    // Kept while it is being created too, so calls at the same moment share one sign-in.
    const entry: ClientEntry = { fingerprint: print, client, expiresAt: now() + CLIENT_TTL_MS };
    clients.set(connection.id, entry);
    client.catch(() => {
      if (clients.get(connection.id) === entry) clients.delete(connection.id);
    });
    return { client: await bounded(() => client, "list", signal), vaultId, print, fresh: true };
  }

  /** Runs `work` with the connection's client; an auth failure on a kept client tries a new one once. */
  async function withClient<T>(
    connection: VaultConnection,
    signal: AbortSignal | undefined,
    work: (client: OnePasswordClient, vaultId: string, print: string) => Promise<T>,
  ): Promise<T> {
    const first = await clientFor(connection, signal);
    try {
      return await work(first.client, first.vaultId, first.print);
    } catch (err) {
      if (!(err instanceof VaultSourceError) || err.code !== "auth_failed") throw err;
      clients.delete(connection.id);
      if (first.fresh) throw err;
      const again = await clientFor(connection, signal);
      try {
        return await work(again.client, again.vaultId, again.print);
      } catch (retryErr) {
        if (retryErr instanceof VaultSourceError && retryErr.code === "auth_failed") clients.delete(connection.id);
        throw retryErr;
      }
    }
  }

  return {
    kind: ONEPASSWORD_SOURCE_KIND,

    describe: () => structuredClone(DESCRIPTOR),

    async connect(input, signal): Promise<VaultConnectResult> {
      const token = (input.token ?? "").trim();
      if (!/^ops_[A-Za-z0-9+/=_.-]{20,8192}$/.test(token)) throw fail("invalid_input", MESSAGES.token);
      const loaded = await theSdk();
      const client = await bounded(
        () => loaded.createClient({ auth: token, integrationName: INTEGRATION_NAME, integrationVersion }),
        "connect",
        signal,
      );
      const vaults = await bounded(() => client.vaults.list({ decryptDetails: true }), "connect", signal);
      if (vaults.length === 0) throw fail("no_vault", MESSAGES.noVault);
      const vault = vaults[0];
      if (vaults.length > 1 || !vault) throw fail("many_vaults", MESSAGES.manyVaults);
      const name = vault.title?.trim() || "1Password";
      return { label: name, config: { vaultId: vault.id, vaultName: name }, secret: { token } };
    },

    async list(connection, signal): Promise<VaultSourceItem[]> {
      return withClient(connection, signal, async (client, vaultId, print) => {
        const overviews = await bounded(() => client.items.list(vaultId, ACTIVE_ONLY), "list", signal);
        const wanted = overviews.filter(
          (o) => kindOf(o.category) && o.state !== "archived" && (!o.vaultId || o.vaultId === vaultId),
        );
        const cacheKey = (o: OnePasswordOverview) => `${o.id}\n${stampOf(o.updatedAt)}`;
        const previous = caches.get(connection.id);
        const known = previous?.fingerprint === print ? previous.reads : new Map<string, { username?: string }>();
        const reads = new Map<string, { username?: string }>();
        const toRead: OnePasswordOverview[] = [];
        for (const overview of wanted) {
          if (kindOf(overview.category) !== "login") continue;
          const hit = known.get(cacheKey(overview));
          if (hit) reads.set(cacheKey(overview), hit);
          else toRead.push(overview);
        }
        const gone = new Set<string>();
        for (let at = 0; at < toRead.length; at += READ_BATCH) {
          const batch = toRead.slice(at, at + READ_BATCH);
          const ids = batch.map((o) => o.id);
          const answer = await bounded(() => client.items.getAll(vaultId, ids), "list", signal);
          const responses = answer.individualResponses ?? [];
          const byId = new Map(batch.map((o) => [o.id, o]));
          for (let index = 0; index < responses.length; index++) {
            const response = responses[index];
            const item = response?.content;
            if (item) {
              const overview = byId.get(item.id);
              // Keyed by the overview's stamp: the next list compares overviews, not full items.
              if (overview) reads.set(cacheKey(overview), { username: usernameOf(item) });
              continue;
            }
            // An item listed but gone when read was deleted in between: it is left out of this list. Another
            // failure leaves it in without a username, and it is read again next time (nothing was cached).
            const overview = responses.length === batch.length ? batch[index] : undefined;
            if (overview && response?.error?.type === "itemNotFound") gone.add(overview.id);
          }
        }
        caches.set(connection.id, { fingerprint: print, reads });

        const items: VaultSourceItem[] = [];
        for (const overview of wanted) {
          if (gone.has(overview.id)) continue;
          const kind = kindOf(overview.category);
          const title = overview.title?.trim() || (kind === "key" ? "Key" : "Login");
          const updatedAt = stampOf(overview.updatedAt) || undefined;
          if (kind === "key") {
            const keyName = keyNameFromTitle(title);
            items.push({
              ref: overview.id,
              kind,
              title,
              ...(keyName ? { keyName } : {}),
              ...(updatedAt ? { updatedAt } : {}),
            });
            continue;
          }
          const websites = websitesOf(overview.websites);
          const username = reads.get(cacheKey(overview))?.username;
          items.push({
            ref: overview.id,
            kind: "login",
            title,
            ...(websites.length > 0 ? { websites } : {}),
            ...(username ? { username } : {}),
            ...(updatedAt ? { updatedAt } : {}),
          });
        }
        return items;
      });
    },

    async reveal(connection, ref, field: VaultSecretField, signal): Promise<string> {
      if (!ITEM_ID.test(ref)) throw fail("not_found", MESSAGES.notFound);
      return withClient(connection, signal, async (client, vaultId) => {
        const item = await bounded(() => client.items.get(vaultId, ref), "reveal", signal);
        if (!item || item.id !== ref || (item.vaultId && item.vaultId !== vaultId)) {
          throw fail("not_found", MESSAGES.notFound);
        }
        const value = secretOf(item, field);
        if (!value) throw fail("not_found", MESSAGES.notFound);
        return value;
      });
    },

    async createLogin(connection, login: VaultNewLogin, signal): Promise<VaultSourceItem> {
      return withClient(connection, signal, async (client, vaultId) => {
        const params: OnePasswordNewItem = {
          category: "Login",
          vaultId,
          title: login.title,
          fields: [
            ...(login.username
              ? [{ id: "username", title: "username", fieldType: "Text", value: login.username }]
              : []),
            { id: "password", title: "password", fieldType: "Concealed", value: login.password },
          ],
          ...(login.website
            ? {
                websites: [
                  {
                    url: login.website,
                    label: "website",
                    autofillBehavior: login.match === "site" ? "AnywhereOnWebsite" : "ExactDomain",
                  },
                ],
              }
            : {}),
          ...(login.notes ? { notes: login.notes } : {}),
        };
        const created = await bounded(() => client.items.create(params), "write", signal);
        if (!created?.id) throw fail("unreachable", MESSAGES.unreachable);
        return loginOf(created);
      });
    },

    async updateLogin(connection, ref, change: VaultLoginChange, signal): Promise<VaultSourceItem> {
      if (!ITEM_ID.test(ref)) throw fail("not_found", MESSAGES.notFound);
      return withClient(connection, signal, async (client, vaultId) => {
        const item = await bounded(() => client.items.get(vaultId, ref), "reveal", signal);
        if (!item || item.id !== ref || (item.vaultId && item.vaultId !== vaultId)) {
          throw fail("not_found", MESSAGES.notFound);
        }
        if (item.category !== "Login") throw fail("invalid_input", MESSAGES.notALogin);
        let next = item;
        if (change.username !== undefined) next = withField(next, "username", change.username);
        if (change.password !== undefined) next = withField(next, "password", change.password);
        if (next === item) return loginOf(item);
        return loginOf(await bounded(() => client.items.put(next), "write", signal));
      });
    },
  };
}

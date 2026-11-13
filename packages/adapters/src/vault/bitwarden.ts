/**
 * Bitwarden and Vaultwarden as a Vault source (ADR 0144): a client of their API written here, so there is no CLI to
 * download and nothing on disk. It signs in with the account's personal API key, opens the account with its master
 * password, and reads the logins of one folder. It also keeps a new login in that folder (the API key is the whole
 * account's, so there is no read-only kind); it never changes a login already there: Bitwarden replaces a whole
 * login on every edit, passkeys and attachments included, and what this client doesn't read it can't send back.
 *
 * - The master password opens the whole account, so the connect card asks for an account made only for agents.
 * - Only the folder's own logins count: personal (no organization), not in the trash, of the login type.
 * - `list` decrypts names, usernames and websites; a password is decrypted only in `reveal`, from that one login.
 * - The user key lives in memory, per connection, for 10 minutes at most (then the account is opened again).
 * - JSON from Bitwarden and from Vaultwarden differ in casing (`Name` / `name`): every field is read either way.
 * - Every network call has a 15 s timeout. A 401 on a kept session signs in again once; nothing else retries.
 * - The server's address is typed by a person: the server passes a `fetch` that connects only to public addresses
 *   (`publicHttpsFetch`), and an address it refuses comes back as `invalid_input`.
 * - Key derivations (Argon2id is pure JS, in the server's memory) run one at a time per workspace and two at most
 *   across the process, so one workspace's account can't hold everyone else's up.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { OutboundAddressError } from "../outbound-url";
import { readCapped } from "../read-capped";
import {
  BitwardenCryptoError,
  type BitwardenKdf,
  decryptString,
  decryptSymmetricKey,
  decryptUserKey,
  deriveMasterKey,
  encryptString,
  type SymmetricKey,
  toBase64,
} from "./bitwarden-crypto";
import { type VaultMatch, vaultOrigin } from "./site";
import {
  type VaultConnection,
  type VaultConnectResult,
  type VaultNewLogin,
  type VaultSecretField,
  type VaultSource,
  type VaultSourceDescriptor,
  VaultSourceError,
  type VaultSourceErrorCode,
  type VaultSourceItem,
} from "./source";

export const BITWARDEN_SOURCE_KIND = "bitwarden";

export interface BitwardenSourceOptions {
  /**
   * How the server reaches Bitwarden: the server passes one that connects only to public addresses
   * (`publicHttpsFetch`, ADR 0144); tests pass a fake. An `OutboundAddressError` it throws is `invalid_input`.
   */
  fetch?: typeof fetch;
  /** The clock for the key's lifetime and `retryAt` (tests pass a fake). */
  now?: () => number;
  /** Per request; 15 s by default. */
  timeoutMs?: number;
}

const TIMEOUT_MS = 15_000;
/** The longest the user key stays in memory for one connection (ADR 0144). */
const KEY_TTL_MS = 10 * 60_000;
/** An access token is not reused in its last minute. */
const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_RETRY_MS = 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
/** A sync of an account made for agents is small; this only stops a runaway answer. */
const MAX_SYNC_BYTES = 32 * 1024 * 1024;
/** Bitwarden's device type for SDK clients. */
const DEVICE_TYPE = "21";
const DEVICE_NAME = "agentes.chat";
const DEFAULT_FOLDER = "Agents";
const CIPHER_TYPE_LOGIN = 1;

const CLOUD: Record<string, { identityUrl: string; apiUrl: string }> = {
  "bitwarden.com": { identityUrl: "https://identity.bitwarden.com", apiUrl: "https://api.bitwarden.com" },
  "bitwarden.eu": { identityUrl: "https://identity.bitwarden.eu", apiUrl: "https://api.bitwarden.eu" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Our own words for every failure: a provider's text may carry a token, so it is never passed on. */
const MESSAGES = {
  server: "Choose bitwarden.com, bitwarden.eu or your own server.",
  serverUrl: "Type your server's address, starting with https://.",
  clientId: "Paste the client_id of the account's API key. It starts with user.",
  clientSecret: "Paste the client_secret of the account's API key.",
  masterPassword: "Type the account's master password.",
  folder: "Type the name of the folder with the logins your agents may use.",
  connection: "This connection is missing settings. Connect it again.",
  authFailed: "Bitwarden didn't accept this API key. Check the client_id and client_secret.",
  locked: "The master password doesn't open this account.",
  noMasterPassword: "This account has no master password. Use an account that signs in with a master password.",
  kdf: "This account's encryption settings can't be used here. Keep Bitwarden's default settings for this account.",
  unsupported: "This account uses encryption this connection can't read yet.",
  folderMissing: "There's no folder with this name in the account.",
  notFound: "This login is no longer in the folder.",
  notSaved: "Bitwarden didn't accept the new login. The account may not be allowed to keep logins of its own.",
  rateLimited: "Bitwarden asked us to wait before trying again.",
  privateServer:
    "This server's address is on a private or internal network, which this server doesn't connect to. Use its public HTTPS address.",
  unreachable: "Couldn't reach the Bitwarden server.",
  timeout: "The Bitwarden server took too long to answer.",
  cancelled: "The request was cancelled.",
  unreadable: "The server didn't answer like Bitwarden. Check the server address.",
  tooLarge: "The account sent more than we read. Keep only your agents' logins in it.",
} as const;

const fail = (code: VaultSourceErrorCode, message: string, retryAt?: string) =>
  new VaultSourceError(code, message, retryAt);

// ---- JSON as either server writes it -------------------------------------------------------------------------

/** A field by its PascalCase name, also found as camelCase or in any other casing (Bitwarden vs Vaultwarden). */
function pick(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, name)) return record[name];
  const camel = name.charAt(0).toLowerCase() + name.slice(1);
  if (Object.hasOwn(record, camel)) return record[camel];
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) if (key.toLowerCase() === lower) return record[key];
  return undefined;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

function int(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{1,10}$/.test(value)) return Number(value);
  return undefined;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const sameId = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

const fold = (name: string) => name.normalize("NFC").trim().toLowerCase();

// ---- Settings ------------------------------------------------------------------------------------------------

interface Endpoints {
  identityUrl: string;
  apiUrl: string;
}

interface Credentials {
  clientId: string;
  clientSecret: string;
  masterPassword: string;
}

/** `https://host[/path]` for a self-hosted server, without a trailing slash, or null. */
function selfHostedBase(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  // A web vault address is often pasted as is (`https://vault.acme.example/#/vault`): the fragment and query go.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** An `https:` address kept in a connection's config, or null. */
function httpsUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? raw.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

function readCredentials(source: Record<string, string>): Credentials {
  const clientId = (source.clientId ?? "").trim();
  const clientSecret = (source.clientSecret ?? "").trim();
  // The master password is used exactly as typed: spaces are allowed in it.
  const masterPassword = source.masterPassword ?? "";
  if (!/^user\.[A-Za-z0-9-]{1,100}$/.test(clientId)) throw fail("invalid_input", MESSAGES.clientId);
  if (!clientSecret || clientSecret.length > 512 || /\s/.test(clientSecret)) {
    throw fail("invalid_input", MESSAGES.clientSecret);
  }
  if (!masterPassword || masterPassword.length > 1024) throw fail("invalid_input", MESSAGES.masterPassword);
  return { clientId, clientSecret, masterPassword };
}

interface ConnectionSettings {
  endpoints: Endpoints;
  folder: string;
  deviceId: string;
  credentials: Credentials;
}

function readConnection(connection: VaultConnection): ConnectionSettings {
  const identityUrl = httpsUrl(connection.config.identityUrl);
  const apiUrl = httpsUrl(connection.config.apiUrl);
  const folder = (connection.config.folder ?? "").trim();
  if (!identityUrl || !apiUrl || !folder) throw fail("invalid_input", MESSAGES.connection);
  let credentials: Credentials;
  try {
    credentials = readCredentials(connection.secret);
  } catch {
    throw fail("invalid_input", MESSAGES.connection);
  }
  const deviceId = connection.config.deviceId ?? "";
  return {
    endpoints: { identityUrl, apiUrl },
    folder,
    deviceId: UUID.test(deviceId) ? deviceId : connection.id,
    credentials,
  };
}

// ---- HTTP ----------------------------------------------------------------------------------------------------

interface Http {
  fetch: typeof fetch;
  now: () => number;
  timeoutMs: number;
}

interface Answer {
  status: number;
  /** The parsed JSON, `undefined` when the body was empty or not JSON. */
  body: unknown;
  retryAfter: string | null;
}

/** `retryAt` from a `Retry-After` header (seconds or a date), a minute from now when it says nothing usable. */
function retryAt(header: string | null, now: number): string {
  if (header && /^\d{1,7}$/.test(header.trim())) return new Date(now + Number(header.trim()) * 1000).toISOString();
  const date = header ? Date.parse(header) : Number.NaN;
  return new Date(Number.isNaN(date) || date < now ? now + DEFAULT_RETRY_MS : date).toISOString();
}

async function send(http: Http, url: string, init: RequestInit, maxBytes: number, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(http.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const failure = () => {
    const message = signal?.aborted ? MESSAGES.cancelled : timeout.aborted ? MESSAGES.timeout : MESSAGES.unreachable;
    return fail("unreachable", message);
  };
  let res: Response;
  try {
    // A redirect could carry the API key's secret to another host: Bitwarden's endpoints never redirect.
    res = await http.fetch(url, { ...init, signal: combined, redirect: "error" });
  } catch (err) {
    // The guarded fetch refused the host (private, loopback, link-local, internal): what the person typed is wrong.
    if (err instanceof OutboundAddressError) throw fail("invalid_input", MESSAGES.privateServer);
    throw failure();
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(res, maxBytes);
  } catch {
    throw failure();
  }
  if (!bytes) throw fail("unreachable", MESSAGES.tooLarge);
  let body: unknown;
  if (bytes.length > 0) {
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      body = undefined;
    }
  }
  return { status: res.status, body, retryAfter: res.headers.get("retry-after") } satisfies Answer;
}

/** What a non-success answer means. `notFound` is what a 404 means for this call. */
function failureOf(http: Http, answer: Answer, notFound: VaultSourceError): VaultSourceError {
  if (answer.status === 429) return fail("rate_limited", MESSAGES.rateLimited, retryAt(answer.retryAfter, http.now()));
  if (answer.status === 400 || answer.status === 401 || answer.status === 403) {
    return fail("auth_failed", MESSAGES.authFailed);
  }
  if (answer.status === 404) return notFound;
  if (answer.status >= 500) return fail("unreachable", MESSAGES.unreachable);
  return fail("unreachable", MESSAGES.unreadable);
}

const apiHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`,
  accept: "application/json",
  "device-type": DEVICE_TYPE,
});

async function apiGet(
  http: Http,
  url: string,
  accessToken: string,
  options: { maxBytes?: number; notFound?: VaultSourceError; signal?: AbortSignal | undefined } = {},
): Promise<unknown> {
  const answer = await send(
    http,
    url,
    { method: "GET", headers: apiHeaders(accessToken) },
    options.maxBytes ?? MAX_BODY_BYTES,
    options.signal,
  );
  if (answer.status !== 200) {
    throw failureOf(http, answer, options.notFound ?? fail("unreachable", MESSAGES.unreadable));
  }
  if (!answer.body || typeof answer.body !== "object") throw fail("unreachable", MESSAGES.unreadable);
  return answer.body;
}

/**
 * Sends a new cipher. A 400 here is the server turning the login down (a policy that forbids personal items, a field
 * too long), not the API key: the session stays.
 */
async function apiPost(http: Http, url: string, accessToken: string, body: unknown, signal?: AbortSignal) {
  const answer = await send(
    http,
    url,
    {
      method: "POST",
      headers: { ...apiHeaders(accessToken), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    MAX_BODY_BYTES,
    signal,
  );
  if (answer.status === 400) throw fail("unsupported", MESSAGES.notSaved);
  if (answer.status !== 200) throw failureOf(http, answer, fail("unreachable", MESSAGES.unreadable));
  if (!answer.body || typeof answer.body !== "object") throw fail("unreachable", MESSAGES.unreadable);
  return answer.body;
}

// ---- Signing in and opening the account ----------------------------------------------------------------------

interface Token {
  accessToken: string;
  expiresAt: number;
  protectedUserKey: string | undefined;
  kdf: BitwardenKdf | undefined;
}

/** The KDF settings as the token answer gives them: top level, or (newer servers) under the unlock options. */
function readKdf(body: unknown): BitwardenKdf | undefined {
  const nested = pick(pick(pick(body, "UserDecryptionOptions"), "MasterPasswordUnlock"), "Kdf");
  const top = pick(body, "Kdf");
  const type = int(top) ?? int(pick(nested, "KdfType"));
  const iterations = int(pick(body, "KdfIterations")) ?? int(pick(nested, "Iterations"));
  const memory = int(pick(body, "KdfMemory")) ?? int(pick(nested, "Memory"));
  const parallelism = int(pick(body, "KdfParallelism")) ?? int(pick(nested, "Parallelism"));
  if (type === 0 && iterations) return { type: "pbkdf2", iterations };
  if (type === 1 && iterations && memory && parallelism) {
    return { type: "argon2id", iterations, memoryMiB: memory, parallelism };
  }
  return undefined;
}

async function requestToken(
  http: Http,
  endpoints: Endpoints,
  credentials: Credentials,
  deviceId: string,
  signal?: AbortSignal,
): Promise<Token> {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "api",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    deviceType: DEVICE_TYPE,
    deviceIdentifier: deviceId,
    deviceName: DEVICE_NAME,
  });
  const answer = await send(
    http,
    `${endpoints.identityUrl}/connect/token`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        accept: "application/json",
        "device-type": DEVICE_TYPE,
      },
      body: form.toString(),
    },
    MAX_BODY_BYTES,
    signal,
  );
  if (answer.status !== 200) throw failureOf(http, answer, fail("unreachable", MESSAGES.unreadable));
  const accessToken = text(pick(answer.body, "access_token"));
  if (!accessToken) throw fail("unreachable", MESSAGES.unreadable);
  const expiresIn = int(pick(answer.body, "expires_in")) ?? 3600;
  const unlock = pick(pick(answer.body, "UserDecryptionOptions"), "MasterPasswordUnlock");
  return {
    accessToken,
    expiresAt: http.now() + expiresIn * 1000,
    protectedUserKey: text(pick(answer.body, "Key")) ?? text(pick(unlock, "MasterKeyEncryptedUserKey")),
    kdf: readKdf(answer.body),
  };
}

async function profileEmail(http: Http, apiUrl: string, accessToken: string, signal?: AbortSignal) {
  const body = await apiGet(http, `${apiUrl}/accounts/profile`, accessToken, { signal });
  const email = text(pick(body, "Email"))?.trim();
  if (!email) throw fail("unreachable", MESSAGES.unreadable);
  return email;
}

/** Key derivations running at once across the process: each Argon2id one holds up to 128 MiB (ADR 0144). */
const MAX_DERIVATIONS = 2;

/** Runs heavy work in a queue of its own, or stops waiting for it when the caller's signal aborts. */
export type DerivationQueue = <T>(orgId: string, work: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/**
 * Key derivations (ADR 0144): one at a time per workspace, `MAX_DERIVATIONS` at most across the process. A workspace
 * whose account asks for the heaviest settings waits on itself and takes one slot at most, so the others go on.
 * Work whose caller gave up before its turn (`signal` aborted) never starts.
 */
export function derivationQueue(slots = MAX_DERIVATIONS): DerivationQueue {
  const tails = new Map<string, Promise<unknown>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (running < slots) {
      running++;
      return;
    }
    // Handed over by the one that ends (`running` stays counted for it).
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return <T>(orgId: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const turn = async () => {
      if (signal?.aborted) throw fail("unreachable", MESSAGES.cancelled);
      await slot();
      try {
        if (signal?.aborted) throw fail("unreachable", MESSAGES.cancelled);
        return await work();
      } finally {
        release();
      }
    };
    const previous = tails.get(orgId) ?? Promise.resolve();
    const run = previous.then(turn, turn);
    const tail = run.catch(() => undefined);
    tails.set(orgId, tail);
    // The workspace's queue is forgotten once nothing waits in it.
    void tail.then(() => {
      if (tails.get(orgId) === tail) tails.delete(orgId);
    });
    return untilAborted(run, signal);
  };
}

async function openUserKey(
  queue: DerivationQueue,
  orgId: string,
  token: Token,
  email: string,
  masterPassword: string,
  signal?: AbortSignal,
): Promise<SymmetricKey> {
  const protectedKey = token.protectedUserKey;
  const kdf = token.kdf;
  if (!protectedKey) throw fail("unsupported", MESSAGES.noMasterPassword);
  if (!kdf) throw fail("unsupported", MESSAGES.kdf);
  let masterKey: Uint8Array;
  try {
    masterKey = await queue(orgId, () => deriveMasterKey(masterPassword, email, kdf), signal);
  } catch (err) {
    if (err instanceof BitwardenCryptoError) throw fail("unsupported", MESSAGES.kdf);
    throw err;
  }
  try {
    return decryptUserKey(protectedKey, masterKey);
  } catch (err) {
    if (!(err instanceof BitwardenCryptoError)) throw err;
    if (err.reason === "mac" || err.reason === "padding") throw fail("locked", MESSAGES.locked);
    throw fail("unsupported", MESSAGES.unsupported);
  } finally {
    masterKey.fill(0);
  }
}

// ---- Folders and ciphers -------------------------------------------------------------------------------------

/** The folder whose decrypted name is `wanted` (case-insensitive), from a sync's or `/folders`' list. */
function findFolder(folders: unknown[], userKey: SymmetricKey, wanted: string): { id: string; name: string } | null {
  const target = fold(wanted);
  for (const folder of folders) {
    const id = text(pick(folder, "Id"));
    const encrypted = text(pick(folder, "Name"));
    if (!id || !encrypted) continue;
    let name: string;
    try {
      name = decryptString(encrypted, userKey);
    } catch (err) {
      if (err instanceof BitwardenCryptoError) continue;
      throw err;
    }
    if (fold(name) === target) return { id, name: name.trim() };
  }
  return null;
}

/** A login of the agents' folder: personal, not in the trash, of the login type. */
function isFolderLogin(cipher: unknown, folderId: string): boolean {
  return (
    !!text(pick(cipher, "Id")) &&
    int(pick(cipher, "Type")) === CIPHER_TYPE_LOGIN &&
    !pick(cipher, "OrganizationId") &&
    !pick(cipher, "DeletedDate") &&
    sameId(text(pick(cipher, "FolderId")), folderId)
  );
}

/** The cipher's own key when it has one (wrapped in the user key), else the user key. */
function cipherKey(cipher: unknown, userKey: SymmetricKey): SymmetricKey {
  const wrapped = text(pick(cipher, "Key"));
  return wrapped ? decryptSymmetricKey(wrapped, userKey) : userKey;
}

function decryptOptional(value: unknown, key: SymmetricKey): string | undefined {
  const encrypted = text(value);
  return encrypted ? decryptString(encrypted, key) : undefined;
}

/**
 * Bitwarden's URI match detection to our rule: default (null) and base domain (0) fill on the whole site; host (1),
 * starts with (2), exact (3) and regular expression (4) only on the exact origin; never (5) leaves the website out.
 * An unknown value takes the narrower rule.
 */
function matchOf(value: unknown): VaultMatch | null {
  if (value === null || value === undefined) return "site";
  const match = int(value);
  if (match === 0) return "site";
  if (match === 5) return null;
  return "exact";
}

function websitesOf(uris: unknown[], key: SymmetricKey): { url: string; match: VaultMatch }[] {
  const out: { url: string; match: VaultMatch }[] = [];
  const seen = new Set<string>();
  for (const entry of uris) {
    const match = matchOf(pick(entry, "Match"));
    const encrypted = text(pick(entry, "Uri"));
    if (!match || !encrypted) continue;
    let raw: string;
    try {
      raw = decryptString(encrypted, key);
    } catch (err) {
      if (err instanceof BitwardenCryptoError) continue;
      throw err;
    }
    // Only HTTPS addresses, kept as their origin: a path or a query never leaves the source.
    const origin = vaultOrigin(raw);
    if (!origin || seen.has(`${match} ${origin}`)) continue;
    seen.add(`${match} ${origin}`);
    out.push({ url: origin, match });
  }
  return out;
}

/** One login's metadata. A login we can't decrypt is left out (it isn't ours to read). Never the password. */
function itemOf(cipher: unknown, userKey: SymmetricKey): VaultSourceItem | null {
  const ref = text(pick(cipher, "Id"));
  if (!ref) return null;
  try {
    const key = cipherKey(cipher, userKey);
    const login = pick(cipher, "Login");
    const username = decryptOptional(pick(login, "Username"), key)?.trim() || undefined;
    const websites = websitesOf(list(pick(login, "Uris")), key);
    const name = decryptOptional(pick(cipher, "Name"), key)?.trim();
    const updatedAt = isoDate(pick(cipher, "RevisionDate"));
    const first = websites[0];
    const title = name || username || (first ? new URL(first.url).host : "Login");
    return {
      ref,
      kind: "login",
      title,
      ...(websites.length > 0 ? { websites } : {}),
      ...(username ? { username } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  } catch (err) {
    if (err instanceof BitwardenCryptoError) return null;
    throw err;
  }
}

/** Bitwarden's URI match detection for our rule: base domain (0) for the whole site, host (1) for the origin. */
const MATCH_BASE_DOMAIN = 0;
const MATCH_HOST = 1;

/**
 * A new login as Bitwarden's clients send one (`CipherRequestModel`): every text an EncString of type 2 under the
 * user key, no key of its own. A website goes with its checksum (the SHA-256 of the address, in base64, encrypted
 * too), which clients check when a login has its own key.
 */
function newCipher(login: VaultNewLogin, folderId: string, userKey: SymmetricKey) {
  const enc = (value: string) => encryptString(value, userKey);
  return {
    type: CIPHER_TYPE_LOGIN,
    folderId,
    organizationId: null,
    favorite: false,
    reprompt: 0,
    name: enc(login.title),
    notes: login.notes ? enc(login.notes) : null,
    login: {
      username: login.username ? enc(login.username) : null,
      password: enc(login.password),
      totp: null,
      uris: login.website
        ? [
            {
              uri: enc(login.website),
              uriChecksum: enc(toBase64(sha256(new TextEncoder().encode(login.website)))),
              match: login.match === "site" ? MATCH_BASE_DOMAIN : MATCH_HOST,
            },
          ]
        : [],
    },
  };
}

// ---- The source ----------------------------------------------------------------------------------------------

interface Session {
  fingerprint: string;
  accessToken: string;
  userKey: SymmetricKey;
  expiresAt: number;
  /** The folder's id once a sync found it (a reveal then needs one call). */
  folderId?: string;
  timer: ReturnType<typeof setTimeout>;
}

const DESCRIPTOR: VaultSourceDescriptor = {
  kind: BITWARDEN_SOURCE_KIND,
  name: "Bitwarden",
  kinds: ["login"],
  warning:
    "Use an account only for your agents. Its master password opens the whole account, so nothing personal should be in it.",
  steps: [
    "Create a Bitwarden account only for your agents and a folder named Agents with the logins they may use",
    "In that account, open Settings, Security, Keys and copy the API key",
    "Fill in the fields below",
  ],
  fields: [
    {
      id: "server",
      kind: "choice",
      label: "Server",
      required: true,
      initial: "bitwarden.com",
      choices: [
        { value: "bitwarden.com", label: "bitwarden.com" },
        { value: "bitwarden.eu", label: "bitwarden.eu" },
        { value: "self", label: "Self-hosted" },
      ],
    },
    {
      id: "serverUrl",
      kind: "url",
      label: "Server address",
      required: false,
      placeholder: "https://vault.acme.example",
    },
    { id: "clientId", kind: "text", label: "client_id", required: true, placeholder: "user.…" },
    { id: "clientSecret", kind: "secret", label: "client_secret", required: true },
    { id: "masterPassword", kind: "secret", label: "Master password", required: true },
    { id: "folder", kind: "text", label: "Folder", required: true, initial: DEFAULT_FOLDER },
  ],
  helpUrl: "https://bitwarden.com/help/personal-api-key/",
};

/** Bitwarden and Vaultwarden (ADR 0144). One instance serves every connection of the server process. */
export function createBitwardenSource(options: BitwardenSourceOptions = {}): VaultSource {
  const http: Http = {
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
  };
  const queue = derivationQueue();
  const sessions = new Map<string, Session>();
  const opening = new Map<string, Promise<Session>>();
  /** Keys a session to what opened it, so changed settings or credentials never reuse an old key. */
  const fingerprintKey = globalThis.crypto.getRandomValues(new Uint8Array(32));

  const fingerprint = (settings: ConnectionSettings) => {
    const { endpoints, credentials, deviceId } = settings;
    const material = JSON.stringify([
      endpoints.identityUrl,
      endpoints.apiUrl,
      deviceId,
      credentials.clientId,
      credentials.clientSecret,
      credentials.masterPassword,
    ]);
    return Array.from(hmac(sha256, fingerprintKey, new TextEncoder().encode(material)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  };

  const forget = (connectionId: string, session?: Session) => {
    const current = sessions.get(connectionId);
    if (!current || (session && current !== session)) return;
    clearTimeout(current.timer);
    sessions.delete(connectionId);
  };

  async function openSession(
    connection: VaultConnection,
    settings: ConnectionSettings,
    print: string,
  ): Promise<Session> {
    const connectionId = connection.id;
    // Not bound to one caller's signal: a session may serve several calls. Each request has its own timeout.
    const token = await requestToken(http, settings.endpoints, settings.credentials, settings.deviceId);
    // Read each time the account is opened: the email is the key derivation's salt and may have changed.
    const email = await profileEmail(http, settings.endpoints.apiUrl, token.accessToken);
    const userKey = await openUserKey(queue, connection.orgId, token, email, settings.credentials.masterPassword);
    const expiresAt = Math.min(http.now() + KEY_TTL_MS, token.expiresAt - TOKEN_MARGIN_MS);
    const lifetime = Math.max(0, Math.min(KEY_TTL_MS, expiresAt - http.now()));
    const session: Session = {
      fingerprint: print,
      accessToken: token.accessToken,
      userKey,
      expiresAt,
      // Drops the key even if no call comes back for it (a removed connection, an idle server).
      timer: setTimeout(() => forget(connectionId, session), lifetime),
    };
    session.timer.unref?.();
    return session;
  }

  /** The connection's session: kept (fresh: false) or newly opened (fresh: true). */
  async function sessionFor(connection: VaultConnection, settings: ConnectionSettings, signal?: AbortSignal) {
    const print = fingerprint(settings);
    const kept = sessions.get(connection.id);
    if (kept && kept.fingerprint === print && kept.expiresAt > http.now()) return { session: kept, fresh: false };
    if (kept) forget(connection.id, kept);
    let pending = opening.get(connection.id);
    if (!pending) {
      pending = openSession(connection, settings, print).finally(() => opening.delete(connection.id));
      opening.set(connection.id, pending);
    }
    const session = await untilAborted(pending, signal);
    if (session.fingerprint !== print) return sessionFor(connection, settings, signal);
    const current = sessions.get(connection.id);
    if (current !== session) {
      if (current) forget(connection.id, current);
      sessions.set(connection.id, session);
    }
    return { session, fresh: true };
  }

  /** Runs `work` with the connection's session; a 401 on a kept session signs in again once. */
  async function withSession<T>(
    connection: VaultConnection,
    signal: AbortSignal | undefined,
    work: (session: Session, settings: ConnectionSettings) => Promise<T>,
  ): Promise<T> {
    const settings = readConnection(connection);
    const first = await sessionFor(connection, settings, signal);
    try {
      return await work(first.session, settings);
    } catch (err) {
      if (!(err instanceof VaultSourceError) || err.code !== "auth_failed") throw err;
      forget(connection.id, first.session);
      if (first.fresh) throw err;
      const again = await sessionFor(connection, settings, signal);
      try {
        return await work(again.session, settings);
      } catch (retryErr) {
        const denied = retryErr instanceof VaultSourceError && retryErr.code === "auth_failed";
        if (denied) forget(connection.id, again.session);
        throw retryErr;
      }
    }
  }

  /** The agents' folder's id: what a sync found, else asked for now. */
  async function folderIdOf(session: Session, settings: ConnectionSettings, signal?: AbortSignal) {
    if (session.folderId) return session.folderId;
    const folders = await apiGet(http, `${settings.endpoints.apiUrl}/folders`, session.accessToken, { signal });
    const folder = findFolder(list(pick(folders, "Data")), session.userKey, settings.folder);
    if (!folder) throw fail("folder_missing", MESSAGES.folderMissing);
    session.folderId = folder.id;
    return folder.id;
  }

  return {
    kind: BITWARDEN_SOURCE_KIND,

    describe: () => structuredClone(DESCRIPTOR),

    async connect(input, signal, context): Promise<VaultConnectResult> {
      const server = (input.server ?? "bitwarden.com").trim();
      let endpoints: Endpoints;
      if (server === "self") {
        const base = selfHostedBase(input.serverUrl ?? "");
        if (!base) throw fail("invalid_input", MESSAGES.serverUrl);
        endpoints = { identityUrl: `${base}/identity`, apiUrl: `${base}/api` };
      } else {
        const cloud = Object.hasOwn(CLOUD, server) ? CLOUD[server] : undefined;
        if (!cloud) throw fail("invalid_input", MESSAGES.server);
        endpoints = cloud;
      }
      const credentials = readCredentials(input);
      const folderName = (input.folder ?? DEFAULT_FOLDER).trim() || DEFAULT_FOLDER;
      if (folderName.length > 200) throw fail("invalid_input", MESSAGES.folder);
      const deviceId = input.deviceId && UUID.test(input.deviceId) ? input.deviceId : globalThis.crypto.randomUUID();

      const token = await requestToken(http, endpoints, credentials, deviceId, signal);
      const email = await profileEmail(http, endpoints.apiUrl, token.accessToken, signal);
      // Queued with the workspace's other derivations; without one named (a module's own call), in a queue of its own.
      const orgId = context?.orgId ?? `connect:${deviceId}`;
      const userKey = await openUserKey(queue, orgId, token, email, credentials.masterPassword, signal);
      const sync = await apiGet(http, `${endpoints.apiUrl}/sync?excludeDomains=true`, token.accessToken, {
        maxBytes: MAX_SYNC_BYTES,
        signal,
      });
      const folder = findFolder(list(pick(sync, "Folders")), userKey, folderName);
      if (!folder) throw fail("folder_missing", MESSAGES.folderMissing);
      return {
        label: folder.name,
        config: {
          server,
          identityUrl: endpoints.identityUrl,
          apiUrl: endpoints.apiUrl,
          folder: folder.name,
          email,
          deviceId,
        },
        secret: { ...credentials },
      };
    },

    async list(connection, signal): Promise<VaultSourceItem[]> {
      return withSession(connection, signal, async (session, settings) => {
        const sync = await apiGet(http, `${settings.endpoints.apiUrl}/sync?excludeDomains=true`, session.accessToken, {
          maxBytes: MAX_SYNC_BYTES,
          signal,
        });
        const folder = findFolder(list(pick(sync, "Folders")), session.userKey, settings.folder);
        if (!folder) throw fail("folder_missing", MESSAGES.folderMissing);
        session.folderId = folder.id;
        const items: VaultSourceItem[] = [];
        for (const cipher of list(pick(sync, "Ciphers"))) {
          if (!isFolderLogin(cipher, folder.id)) continue;
          const item = itemOf(cipher, session.userKey);
          if (item) items.push(item);
        }
        return items;
      });
    },

    async reveal(connection, ref, field: VaultSecretField, signal): Promise<string> {
      // Bitwarden holds logins only; a cipher id is a UUID (never a path).
      if (field !== "password" || !UUID.test(ref)) throw fail("not_found", MESSAGES.notFound);
      return withSession(connection, signal, async (session, settings) => {
        const folderId = await folderIdOf(session, settings, signal);
        const cipher = await apiGet(http, `${settings.endpoints.apiUrl}/ciphers/${ref}`, session.accessToken, {
          notFound: fail("not_found", MESSAGES.notFound),
          signal,
        });
        if (!isFolderLogin(cipher, folderId) || !sameId(text(pick(cipher, "Id")), ref)) {
          throw fail("not_found", MESSAGES.notFound);
        }
        let password: string | undefined;
        try {
          password = decryptOptional(pick(pick(cipher, "Login"), "Password"), cipherKey(cipher, session.userKey));
        } catch (err) {
          if (err instanceof BitwardenCryptoError) throw fail("not_found", MESSAGES.notFound);
          throw err;
        }
        if (!password) throw fail("not_found", MESSAGES.notFound);
        return password;
      });
    },

    async createLogin(connection, login: VaultNewLogin, signal): Promise<VaultSourceItem> {
      return withSession(connection, signal, async (session, settings) => {
        const folderId = await folderIdOf(session, settings, signal);
        const created = await apiPost(
          http,
          `${settings.endpoints.apiUrl}/ciphers`,
          session.accessToken,
          newCipher(login, folderId, session.userKey),
          signal,
        );
        // Read back with the account's key, as a sync would: an answer that isn't our login in our folder isn't kept.
        const item = isFolderLogin(created, folderId) ? itemOf(created, session.userKey) : null;
        if (!item) throw fail("unreachable", MESSAGES.unreadable);
        return item;
      });
    },
  };
}

/** Waits for `work`, or stops waiting when `signal` aborts (the work itself goes on for whoever else waits). */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(fail("unreachable", MESSAGES.cancelled));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(fail("unreachable", MESSAGES.cancelled));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

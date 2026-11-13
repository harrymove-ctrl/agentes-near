/**
 * Fakes for the Vault's sources (ADR 0144), shared by their tests: a Bitwarden server whose data is encrypted with
 * the same primitives the client decrypts with, and a 1Password SDK. Both put the secrets they hold into their own
 * raw errors on purpose, so the tests can prove a source never passes a provider's text on.
 */
import {
  type BitwardenKdf,
  deriveMasterKey,
  encryptBytes,
  encryptString,
  type SymmetricKey,
  stretchMasterKey,
  symmetricKeyFrom,
} from "../../src/vault/bitwarden-crypto";
import type {
  OnePasswordClient,
  OnePasswordItem,
  OnePasswordNewItem,
  OnePasswordOverview,
  OnePasswordSdk,
  OnePasswordVault,
} from "../../src/vault/onepassword";

// ---- Bitwarden ------------------------------------------------------------------------------------------------

export const FAKE_BW = {
  email: "Agents@Acme.example",
  masterPassword: "fake master password 7f3a",
  clientId: "user.6f1c0d2e-4b7a-4c1e-9a55-0c2f6b1d9e01",
  clientSecret: "fakeClientSecret9a8b7c6d5e",
} as const;

export interface FakeLogin {
  id: string;
  name: string;
  /** The folder's name; null or absent: no folder. */
  folder?: string | null;
  username?: string;
  password?: string;
  uris?: { uri: string; match?: number | null }[];
  organizationId?: string;
  deletedDate?: string;
  /** Cipher type; 1 (login) by default. */
  type?: number;
  /** Encrypted with a key of its own (wrapped in the user key), as newer clients do. */
  ownKey?: boolean;
  /** Encrypted with a key that isn't the account's (what an organization's cipher looks like to us). */
  foreignKey?: boolean;
}

export interface FakeBitwardenOptions {
  email?: string;
  masterPassword?: string;
  clientId?: string;
  clientSecret?: string;
  kdf?: BitwardenKdf;
  folders?: string[];
  logins?: FakeLogin[];
  /** Vaultwarden and older servers differ from Bitwarden's in casing: the client reads both. */
  casing?: "pascal" | "camel";
  /** Newer servers: the KDF and the protected key only under `UserDecryptionOptions.MasterPasswordUnlock`. */
  unlockOptionsOnly?: boolean;
  identityUrl?: string;
  apiUrl?: string;
  expiresIn?: number;
}

export interface FakeCall {
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
}

const randomKey = (): { bytes: Uint8Array; key: SymmetricKey } => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(64));
  return { bytes, key: symmetricKeyFrom(bytes) };
};

/** PascalCase keys to camelCase, deeply (`access_token` stays as is). */
function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(entries.map(([k, v]) => [k.charAt(0).toLowerCase() + k.slice(1), camelize(v)]));
}

export async function createFakeBitwarden(options: FakeBitwardenOptions = {}) {
  const email = options.email ?? FAKE_BW.email;
  const masterPassword = options.masterPassword ?? FAKE_BW.masterPassword;
  const clientId = options.clientId ?? FAKE_BW.clientId;
  const clientSecret = options.clientSecret ?? FAKE_BW.clientSecret;
  const kdf: BitwardenKdf = options.kdf ?? { type: "pbkdf2", iterations: 5_000 };
  const identityUrl = options.identityUrl ?? "https://identity.bitwarden.com";
  const apiUrl = options.apiUrl ?? "https://api.bitwarden.com";
  const shape = (body: unknown) => (options.casing === "camel" ? camelize(body) : body);

  const user = randomKey();
  const masterKey = await deriveMasterKey(masterPassword, email, kdf);
  const protectedUserKey = encryptBytes(user.bytes, stretchMasterKey(masterKey));

  const folderNames = options.folders ?? ["Agents", "Personal"];
  const folders = folderNames.map((name) => ({
    Id: globalThis.crypto.randomUUID(),
    Name: encryptString(name, user.key),
    RevisionDate: "2026-10-01T12:00:00.000Z",
  }));
  const folderId = (name: string | null | undefined) =>
    name ? (folders[folderNames.indexOf(name)]?.Id ?? globalThis.crypto.randomUUID()) : null;

  const ciphers = (options.logins ?? []).map((login) => {
    const own = login.ownKey ? randomKey() : null;
    const key = login.foreignKey ? randomKey().key : (own?.key ?? user.key);
    const enc = (text: string | undefined) => (text === undefined ? null : encryptString(text, key));
    return {
      Id: login.id,
      OrganizationId: login.organizationId ?? null,
      FolderId: folderId(login.folder),
      Type: login.type ?? 1,
      Key: own ? encryptBytes(own.bytes, user.key) : null,
      Name: enc(login.name),
      Notes: enc("a note that may hold anything"),
      Reprompt: 0,
      RevisionDate: "2026-10-02T08:30:00.000Z",
      DeletedDate: login.deletedDate ?? null,
      Login: {
        Username: enc(login.username),
        Password: enc(login.password),
        Totp: null,
        Uris: (login.uris ?? []).map((u) => ({ Uri: enc(u.uri), Match: u.match ?? null })),
      },
    };
  });

  const state = {
    /** Every request fails as a network error would (with a secret in the error's text). */
    down: false,
    /** Every request answers HTML, as a wrong address would. */
    html: false,
    /** The token endpoint answers 429 with this Retry-After. */
    rateLimitRetryAfter: null as string | null,
    /** Every API call answers 401, whatever the token. */
    rejectAll: false,
    /** Requests never answer (until aborted). */
    hang: false,
    /** A new cipher is turned down with a 400, as a policy against personal items does. */
    refuseNew: false,
  };
  const calls: FakeCall[] = [];
  const issued = new Set<string>();
  const revoked = new Set<string>();
  let tokens = 0;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers });

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url: href, headers, ...(body !== undefined ? { body } : {}) });
    // As a real fetch does: an aborted signal fails the request at once.
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (state.hang) {
      return new Promise<Response>((_, reject) => {
        const abort = () => reject(new DOMException(`aborted ${clientSecret}`, "AbortError"));
        init?.signal?.addEventListener("abort", abort);
      });
    }
    if (state.down) throw new TypeError(`connect ECONNREFUSED while sending ${clientSecret} for ${masterPassword}`);
    if (state.html) {
      return new Response("<html><body>Welcome</body></html>", { headers: { "content-type": "text/html" } });
    }

    if (href === `${identityUrl}/connect/token` && method === "POST") {
      if (state.rateLimitRetryAfter !== null) {
        return json({ error: "rate_limited", detail: clientSecret }, 429, { "retry-after": state.rateLimitRetryAfter });
      }
      const form = new URLSearchParams(body ?? "");
      if (
        form.get("grant_type") !== "client_credentials" ||
        form.get("client_id") !== clientId ||
        form.get("client_secret") !== clientSecret
      ) {
        return json({ error: "invalid_client", error_description: `no client for ${form.get("client_secret")}` }, 400);
      }
      tokens += 1;
      const accessToken = `fake-access-token-${tokens}-${globalThis.crypto.randomUUID()}`;
      issued.add(accessToken);
      const kdfFields =
        kdf.type === "pbkdf2"
          ? { Kdf: 0, KdfIterations: kdf.iterations, KdfMemory: null, KdfParallelism: null }
          : { Kdf: 1, KdfIterations: kdf.iterations, KdfMemory: kdf.memoryMiB, KdfParallelism: kdf.parallelism };
      const unlock = {
        Kdf: {
          KdfType: kdfFields.Kdf,
          Iterations: kdfFields.KdfIterations,
          Memory: kdfFields.KdfMemory,
          Parallelism: kdfFields.KdfParallelism,
        },
        MasterKeyEncryptedUserKey: protectedUserKey,
        Salt: email.toLowerCase(),
      };
      const tokenBody = {
        access_token: accessToken,
        expires_in: options.expiresIn ?? 3600,
        token_type: "Bearer",
        scope: "api",
        ...(options.unlockOptionsOnly ? {} : { Key: protectedUserKey, ...kdfFields }),
        PrivateKey: encryptString("not a real private key", user.key),
        ResetMasterPassword: false,
        UserDecryptionOptions: {
          HasMasterPassword: true,
          ...(options.unlockOptionsOnly ? { MasterPasswordUnlock: unlock } : {}),
        },
      };
      // The token endpoint keeps its OAuth names (snake_case) and Bitwarden's own in either casing.
      return json(shape(tokenBody));
    }

    if (href.startsWith(`${apiUrl}/`)) {
      const token = (headers.authorization ?? "").replace(/^Bearer /, "");
      if (state.rejectAll || !issued.has(token) || revoked.has(token)) return json({ message: "Invalid token" }, 401);
      const [path = "", query = ""] = href.slice(apiUrl.length).split("?");
      if (path === "/accounts/profile" && method === "GET") {
        return json(shape({ Id: globalThis.crypto.randomUUID(), Email: email, Name: "Agents", Key: protectedUserKey }));
      }
      if (path === "/sync" && method === "GET") {
        if (new URLSearchParams(query).get("excludeDomains") !== "true") return json({ message: "domains too" }, 400);
        return json(shape({ Object: "sync", Profile: { Email: email }, Folders: folders, Ciphers: ciphers }));
      }
      if (path === "/folders" && method === "GET") return json(shape({ Object: "list", Data: folders }));
      const cipherPath = /^\/ciphers\/([^/]+)$/.exec(path);
      if (cipherPath && method === "GET") {
        const found = ciphers.find((c) => c.Id === cipherPath[1]);
        return found ? json(shape(found)) : json({ message: "Resource not found." }, 404);
      }
      if (path === "/ciphers" && method === "POST") {
        if (state.refuseNew) return json({ message: `policy forbids it (${clientSecret})` }, 400);
        // As clients send it: camelCase, every text already an EncString.
        const sent = JSON.parse(body ?? "{}") as {
          type: number;
          folderId: string | null;
          organizationId: string | null;
          name: string;
          notes: string | null;
          reprompt: number;
          login: {
            username: string | null;
            password: string | null;
            totp: string | null;
            uris: { uri: string; uriChecksum?: string; match: number | null }[];
          };
        };
        const created = {
          Id: globalThis.crypto.randomUUID(),
          OrganizationId: sent.organizationId,
          FolderId: sent.folderId,
          Type: sent.type,
          Key: null,
          Name: sent.name,
          Notes: sent.notes,
          Reprompt: sent.reprompt,
          RevisionDate: "2026-11-10T09:00:00.000Z",
          DeletedDate: null,
          Login: {
            Username: sent.login.username,
            Password: sent.login.password,
            Totp: sent.login.totp,
            Uris: sent.login.uris.map((u) => ({ Uri: u.uri, UriChecksum: u.uriChecksum ?? null, Match: u.match })),
          },
        };
        ciphers.push(created as (typeof ciphers)[number]);
        return json(shape(created));
      }
    }
    throw new Error(`unexpected request ${method} ${href}`);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    state,
    folders,
    /** The account's key, for a test to open what the client encrypted. */
    userKey: user.key,
    /** How many access tokens the identity server gave. */
    tokens: () => tokens,
    /** Every token given so far stops working (a new one works). */
    revokeTokens: () => {
      for (const token of issued) revoked.add(token);
    },
    /** The calls to a path of the API or the identity server. */
    callsTo: (path: string) => calls.filter((c) => new URL(c.url).pathname.endsWith(path)),
  };
}

// ---- 1Password ------------------------------------------------------------------------------------------------

export const FAKE_OP_TOKEN = "ops_eyJmYWtlIjoic2VydmljZSBhY2NvdW50In0fakeTokenA1B2C3D4E5";

export interface FakeOpItem {
  id: string;
  title: string;
  category: string;
  websites?: { url: string; autofillBehavior: string }[];
  username?: string;
  password?: string;
  credential?: string;
  updatedAt?: string;
  state?: "active" | "archived";
}

export type FakeOpMethod =
  | "createClient"
  | "vaults.list"
  | "items.list"
  | "items.get"
  | "items.getAll"
  | "items.create"
  | "items.put";

export function createFakeOnePassword(
  options: { token?: string; vaults?: OnePasswordVault[]; items?: FakeOpItem[] } = {},
) {
  const token = options.token ?? FAKE_OP_TOKEN;
  class RateLimitExceededError extends Error {}
  class AuthExpiredError extends Error {}
  const state = {
    vaults: options.vaults ?? [{ id: "vaultagents0000000000000001", title: "Agents" }],
    items: (options.items ?? []).map((item) => ({ ...item })),
    /** Calls to `failOn` (or every call, with "all") throw what `failWith` makes, until cleared. */
    failOn: null as FakeOpMethod | "all" | null,
    failWith: null as (() => unknown) | null,
    /** Calls never answer. */
    hang: false,
    /** The service account was made with read access only: writes are refused in 1Password's words. */
    readOnly: false,
  };
  const calls = {
    createClient: [] as { integrationName: string; integrationVersion: string }[],
    get: [] as string[],
    getAll: [] as string[][],
    itemsList: 0,
    vaultsList: [] as unknown[],
    create: [] as OnePasswordNewItem[],
    put: [] as OnePasswordItem[],
  };

  const mayWrite = () => {
    if (state.readOnly) {
      throw new Error(
        `you do not have the right permissions to perform this action: not sufficient permissions (${token})`,
      );
    }
  };
  const fieldValue = (item: OnePasswordItem | OnePasswordNewItem, id: string) =>
    item.fields.find((f) => f.id === id)?.value;

  const gate = async (method: FakeOpMethod) => {
    if (state.hang) await new Promise(() => undefined);
    if ((state.failOn === "all" || state.failOn === method) && state.failWith) throw state.failWith();
  };

  const vaultOf = () => state.vaults[0]?.id ?? "";
  const overview = (item: FakeOpItem): OnePasswordOverview => ({
    id: item.id,
    title: item.title,
    category: item.category,
    vaultId: vaultOf(),
    websites: item.websites ?? [],
    updatedAt: new Date(item.updatedAt ?? "2026-10-01T10:00:00.000Z"),
    state: item.state ?? "active",
  });
  const full = (item: FakeOpItem): OnePasswordItem => ({
    id: item.id,
    title: item.title,
    category: item.category,
    vaultId: vaultOf(),
    updatedAt: new Date(item.updatedAt ?? "2026-10-01T10:00:00.000Z"),
    websites: item.websites ?? [],
    fields: [
      ...(item.username !== undefined
        ? [{ id: "username", title: "username", fieldType: "Text", value: item.username }]
        : []),
      ...(item.password !== undefined
        ? [{ id: "password", title: "password", fieldType: "Concealed", value: item.password }]
        : []),
      ...(item.credential !== undefined
        ? [{ id: "credential", title: "credential", fieldType: "Concealed", value: item.credential }]
        : []),
      { id: "notes", title: "notes", fieldType: "Text", value: "free text" },
    ],
  });

  const client: OnePasswordClient = {
    vaults: {
      async list(params) {
        calls.vaultsList.push(params);
        await gate("vaults.list");
        return state.vaults;
      },
    },
    items: {
      async list(_vaultId, ...filters) {
        calls.itemsList += 1;
        await gate("items.list");
        const archived = filters.some((f) => f.content.archived);
        return state.items.filter((i) => archived || i.state !== "archived").map(overview);
      },
      async get(vaultId, itemId) {
        calls.get.push(itemId);
        await gate("items.get");
        const item = state.items.find((i) => i.id === itemId);
        if (!item || vaultId !== vaultOf()) throw new Error(`item ${itemId} not found (service account ${token})`);
        return full(item);
      },
      async getAll(_vaultId, itemIds) {
        calls.getAll.push([...itemIds]);
        await gate("items.getAll");
        return {
          individualResponses: itemIds.map((id) => {
            const item = state.items.find((i) => i.id === id);
            return item ? { content: full(item) } : { error: { type: "itemNotFound" } };
          }),
        };
      },
      async create(params) {
        calls.create.push(structuredClone(params));
        await gate("items.create");
        mayWrite();
        const password = fieldValue(params, "password");
        const username = fieldValue(params, "username");
        const item: FakeOpItem = {
          id: `created${String(state.items.length).padStart(19, "0")}`,
          title: params.title,
          category: params.category,
          websites: params.websites ?? [],
          ...(username !== undefined ? { username } : {}),
          ...(password !== undefined ? { password } : {}),
          updatedAt: "2026-11-10T09:00:00.000Z",
        };
        state.items.push(item);
        return full(item);
      },
      async put(next) {
        calls.put.push(structuredClone(next));
        await gate("items.put");
        mayWrite();
        const item = state.items.find((i) => i.id === next.id);
        if (!item) throw new Error(`item ${next.id} not found (service account ${token})`);
        const password = fieldValue(next, "password");
        const username = fieldValue(next, "username");
        if (password !== undefined) item.password = password;
        if (username !== undefined) item.username = username;
        item.updatedAt = "2026-11-10T09:30:00.000Z";
        return full(item);
      },
    },
  };

  const sdk: OnePasswordSdk = {
    RateLimitExceededError,
    AuthExpiredError,
    async createClient(config) {
      calls.createClient.push({
        integrationName: config.integrationName,
        integrationVersion: config.integrationVersion,
      });
      await gate("createClient");
      // The real SDK's text for a bad token; this one carries the token, which must never come out.
      if (config.auth !== token) throw new Error(`invalid service account token: ${config.auth}`);
      return client;
    },
  };

  return { sdk, state, calls, RateLimitExceededError, AuthExpiredError };
}

import { MAX_SECRET_BYTES, SECRET_NAME, VaultSourceError } from "@agenteschat/adapters";
import {
  connectVaultSource,
  createVaultItem,
  deleteVaultConnection,
  deleteVaultItem,
  getVaultItem,
  importVaultCsv,
  listVault,
  NotFoundError,
  syncVaultConnection,
  TooManyError,
  updateVaultConnection,
  updateVaultItem,
  ValidationError,
  type VaultDeps,
  VaultRefusal,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Vault"];

/** The most a CSV import may be (ADR 0144): the file as text, and the request that carries it as a JSON string. */
export const VAULT_CSV_MAX_CHARS = 2 * 1024 * 1024;
/** Escaping a CSV into JSON can grow it (quotes, line breaks): room for that, not for a bigger file. */
const IMPORT_BODY_BYTES = 5 * 1024 * 1024;

/** Per person, so nobody tests a password manager's credentials in bulk through this server (ADR 0144). */
const SOURCE_CHECKS = { limit: 10, windowMs: 60_000 };
const IMPORTS = { limit: 10, windowMs: 60_000 };

// ── Schemas (the apps' `packages/client/src/vault/types.ts`, field for field) ─────────────────────────────────

const Kind = z.enum(["login", "key", "contact"]);
const Scope = z.enum(["personal", "team"]).openapi({
  description: "`personal`: only its owner sees it. `team`: who manages credentials edits it; its audience sees it.",
});
const Match = z.enum(["exact", "site"]).openapi({
  description:
    "`exact`: only this address (`https://host[:port]`). `site`: every HTTPS page of its registrable domain.",
});

/**
 * May be empty: the engine names the item after its website's host, its variable or its contact's name, and refuses
 * with `vault.title_required` only when there is none (ADR 0144). The apps send an empty title on purpose.
 */
const Title = z.string().trim().max(120).openapi({
  description: "Empty: named after the login's host, the key's variable name or the contact's name.",
});
const Description = z.string().trim().max(300);
const Website = z.string().trim().min(1).max(2048);
const Username = z.string().trim().max(200);
/** Never trimmed: a password may start or end with a space. */
const SecretValue = z.string().min(1).max(MAX_SECRET_BYTES);
/** Its format is the engine's check (400 `vault.key_name_invalid`), a code the apps say in the person's words. */
const KeyName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .openapi({
    description: `An environment variable name (\`ACME_API_KEY\`, \`${SECRET_NAME.source}\`), not one the computer reserves.`,
  });

const contactField = z.string().trim().max(300).optional();
export const VaultContactFields = z
  .object({
    fullName: contactField,
    company: contactField,
    document: contactField.openapi({ description: "CPF, CNPJ, VAT or any tax id." }),
    email: contactField,
    phone: contactField,
    address: contactField,
    address2: contactField,
    city: contactField,
    region: contactField,
    postalCode: contactField,
    country: contactField,
  })
  .openapi("VaultContactFields");

export const VaultAccess = z
  .object({
    everyone: z
      .boolean()
      .openapi({ description: "Team items: everyone in the workspace. Ignored for personal items." }),
    roleIds: z.array(z.uuid()).max(100).openapi({ description: "The workspace's own roles whose people see it." }),
    userIds: z.array(z.string().min(1).max(200)).max(500),
    allAgents: z.boolean().openapi({
      description: "Every agent may use it (for a personal item: any agent, when its owner is the one asking).",
    }),
    agentIds: z.array(z.uuid()).max(200),
  })
  .openapi("VaultAccess");

export const VaultItem = z
  .object({
    id: z.uuid(),
    kind: Kind,
    scope: Scope,
    ownerUserId: z.string().nullable().openapi({ description: "The owner of a personal item." }),
    title: z.string(),
    description: z.string(),
    website: z.string().nullable().openapi({ description: "Login: `https://host[:port]`." }),
    match: Match,
    username: z.string().nullable(),
    keyName: z.string().nullable().openapi({ description: "Key: the variable name." }),
    keyHint: z.string().nullable().openapi({ description: "Key: its last 4 characters, to tell keys apart." }),
    hasSecret: z.boolean().openapi({ description: "Login or key: a value is saved. The value itself never is here." }),
    contact: VaultContactFields.nullable().openapi({
      description: "A contact's fields, only in one item's details: null in the list, and for logins and keys.",
    }),
    connectionId: z.uuid().nullable().openapi({ description: "Null: kept here (built-in)." }),
    sourceName: z.string().nullable().openapi({ description: "The source's brand name when external (`1Password`)." }),
    accessFromConnection: z.boolean().openapi({
      description: "External items follow their connection's access until someone changes theirs.",
    }),
    access: VaultAccess.openapi({ description: "The access that applies now (the connection's when it follows it)." }),
    missing: z.boolean().openapi({ description: "Gone from its source at the last sync." }),
    createdByUserId: z.string().nullable(),
    createdByAgentId: z.uuid().nullable(),
    lastUsedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    can: z
      .object({ edit: z.boolean(), delete: z.boolean() })
      .openapi({ description: "What the viewer may do with it." }),
  })
  .openapi("VaultItem");

const VaultUse = z
  .object({
    id: z.uuid(),
    action: z.enum(["fill", "key", "read", "show", "copy", "create", "edit"]),
    agentId: z.uuid().nullable(),
    userId: z.string().nullable().openapi({ description: "The person who showed, copied, created or edited it." }),
    onBehalfOfUserId: z.string().nullable().openapi({ description: "The person an agent worked for." }),
    routineName: z.string().nullable().openapi({ description: "A routine's name when a routine was behind it." }),
    origin: z.string().nullable().openapi({ description: "Where a login was typed (`https://host`)." }),
    at: z.string(),
  })
  .openapi("VaultUse");

const VaultItemDetail = VaultItem.extend({
  uses: z.array(VaultUse).openapi({ description: "The newest 30, newest first." }),
  unreadable: z.boolean().openapi({
    description:
      "A contact whose saved fields can't be read on this server: `contact` is null, and a person saves them again.",
  }),
}).openapi("VaultItemDetail");

const VaultConnection = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    name: z.string().openapi({ description: "Brand name (`1Password`)." }),
    readOnly: z.boolean().openapi({
      description: "Its credential may only read: agents save no new login there until it is connected again.",
    }),
    scope: Scope,
    ownerUserId: z.string().nullable(),
    label: z.string().openapi({ description: "What it reads (a vault's or a folder's name)." }),
    config: z.record(z.string(), z.string()).openapi({
      description: "Settings safe to show (server address, folder). Its credentials never come back.",
    }),
    access: VaultAccess.openapi({ description: "Default access of its items." }),
    status: z.enum(["ready", "error", "syncing"]),
    errorCode: z.string().nullable().openapi({ description: "Why it failed (`auth_failed`, `locked`…) when `error`." }),
    itemCount: z.number().int(),
    syncedAt: z.string().nullable(),
    can: z.object({ edit: z.boolean() }),
  })
  .openapi("VaultConnection");

const VaultConnectField = z
  .object({
    id: z.string(),
    kind: z.enum(["text", "secret", "url", "email", "choice"]),
    label: z.string().openapi({ description: "English; the apps translate `vault.source.<kind>.field.<id>`." }),
    required: z.boolean(),
    placeholder: z.string().optional(),
    choices: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    initial: z.string().optional(),
  })
  .openapi("VaultConnectField");

const VaultSourceInfo = z
  .object({
    kind: z.string(),
    name: z.string(),
    kinds: z.array(Kind),
    steps: z.array(z.string()),
    fields: z.array(VaultConnectField),
    warning: z.string().optional(),
    helpUrl: z.string().optional(),
  })
  .openapi("VaultSourceInfo");

const VaultOverview = z
  .object({
    items: z.array(VaultItem),
    connections: z.array(VaultConnection),
    sources: z.array(VaultSourceInfo).openapi({ description: "The password managers this server can connect." }),
    canManageTeam: z.boolean().openapi({ description: "The viewer may create team items and team connections." }),
  })
  .openapi("VaultOverview");

const ItemInput = z
  .object({
    kind: Kind,
    scope: Scope,
    title: Title,
    description: Description.optional(),
    website: Website.optional(),
    match: Match.optional(),
    username: Username.optional(),
    secret: SecretValue.optional().openapi({ description: "Login password or key value. Never sent back." }),
    keyName: KeyName.optional(),
    contact: VaultContactFields.optional(),
    access: VaultAccess.optional().openapi({
      description:
        "Absent: a personal item for every agent of its owner; a team item for everyone in the workspace and no agent yet.",
    }),
  })
  .openapi("VaultItemInput");

const ItemPatch = z
  .object({
    title: Title.optional(),
    description: Description.optional(),
    website: Website.optional(),
    match: Match.optional(),
    username: Username.optional(),
    secret: SecretValue.optional().openapi({ description: "A new value; absent keeps the saved one." }),
    keyName: KeyName.optional(),
    contact: VaultContactFields.optional(),
    access: VaultAccess.optional(),
    accessFromConnection: z
      .boolean()
      .optional()
      .openapi({ description: "External items: `true` goes back to the connection's access." }),
  })
  .openapi("VaultItemPatch");

/** What a person typed into a source's connect form, by field id. Sealed at rest, never sent back. */
const SourceInput = z
  .record(z.string().min(1).max(64), z.string().max(4096))
  .refine((input) => Object.keys(input).length <= 20, "At most 20 fields");

const ConnectInput = z
  .object({
    kind: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9_-]+$/),
    scope: Scope,
    input: SourceInput,
    access: VaultAccess.optional(),
  })
  .openapi("VaultConnectInput");

const ConnectionPatch = z
  .object({
    access: VaultAccess.optional(),
    input: SourceInput.optional().openapi({ description: "New credentials (reconnect)." }),
  })
  .openapi("VaultConnectionPatch");

const ImportInput = z
  .object({
    csv: z.string().min(1).max(VAULT_CSV_MAX_CHARS).openapi({
      description: "The file's text (Chrome, 1Password, Bitwarden or any CSV with url and password). Never kept.",
    }),
    scope: Scope,
    dryRun: z.boolean().openapi({ description: "`true`: only count what would happen; nothing is written." }),
  })
  .openapi("VaultImportInput");

const ImportResult = z
  .object({
    added: z.number().int(),
    updated: z.number().int(),
    skipped: z.array(
      z.object({ reason: z.enum(["duplicate", "not_https", "no_password", "invalid"]), count: z.number().int() }),
    ),
    format: z.enum(["chrome", "1password", "bitwarden", "generic"]).openapi({ description: "The file's format." }),
  })
  .openapi("VaultImportResult");

/**
 * "Save to the Vault" on a secret request's card (ADR 0144): the value once more, sent after its sealed box went to
 * the computer, so the server can seal it for the Vault.
 */
export const SecretToVaultInput = z
  .object({
    value: SecretValue,
    username: Username.optional().openapi({
      description: "Logins: the username to keep with it (empty: none). Absent: the request's own.",
    }),
    scope: Scope,
    allAgents: z.boolean(),
    agentIds: z.array(z.uuid()).max(200),
  })
  .openapi("SecretToVaultInput");

const ItemParams = OrgParams.extend({ itemId: z.uuid() });
const ConnectionParams = OrgParams.extend({ connectionId: z.uuid() });

const tooMany = { 429: errorResponse("Too many tries (`rate_limited`)") };

/** What every Vault call of a person needs (ADR 0144), from the server's adapters (a module's sources included). */
export function vaultDepsOf(deps: AppDeps): VaultDeps {
  const { adapters } = deps;
  return {
    db: deps.db,
    keyWrapper: adapters.keyWrapper,
    keyWrappers: [adapters.keyWrapper, ...adapters.legacyKeyWrappers],
    sources: adapters.vaultSources ?? {},
    pubsub: adapters.pubsub,
  };
}

/**
 * A password manager's refusal (`VaultSourceError`) as the API's own error, `vault.source.<code>` (a 429 when it
 * asks us to wait), and an agent-side refusal that reached a person's call as a plain one. The message is ours,
 * never the provider's, which may carry a token (ADR 0144).
 */
export async function vaultCall<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof VaultSourceError) {
      const code = `vault.source.${error.code}`;
      if (error.code === "rate_limited") {
        throw new TooManyError(error.message, code, error.retryAt ? { retryAt: error.retryAt } : undefined);
      }
      throw new ValidationError(error.message, code);
    }
    if (error instanceof VaultRefusal) {
      // Never tells someone without access that the item exists.
      if (error.code === "not_found" || error.code === "not_shared") throw new NotFoundError();
      throw new ValidationError(error.message, `vault.${error.code}`);
    }
    throw error;
  }
}

/**
 * Nothing of the Vault stays in a cache on the way (a proxy, the browser's back button). Every `/api` answer gets
 * this by default; said here as well, so a change to that default never lets a value or a contact be cached.
 */
const noStore = (c: Context) => c.header("Cache-Control", "no-store");

/**
 * The Vault (ADR 0144): logins, keys and contacts the workspace's agents use without seeing a password or a key.
 * Personal items are their owner's alone (admins included: they never see them); team items are edited by who has
 * `manage_credentials` and seen by their audience. No answer here carries a value: once saved, a password or a key
 * never comes back to an app (§2).
 */
export function vaultRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use(
    "/organizations/:orgId/vault/import",
    bodyLimit({
      maxSize: IMPORT_BODY_BYTES,
      onError: (c) => apiError(c, 413, "vault.csv_too_large", "The file is too large (max 2 MB)", { maxMb: 2 }),
    }),
  );
  const limited = async (key: string, rule: { limit: number; windowMs: number }) => {
    if (!(await deps.adapters.rateLimiter.consume(key, rule)).allowed) {
      throw new TooManyError("Too many tries. Wait a minute.");
    }
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/vault",
      tags,
      security,
      summary: "The Vault as this person sees it: items, connections, sources to connect",
      description:
        "Every member: their personal items, the team items whose audience they are in (all of them with `manage_credentials`), and the connections they may see. Never a password or a key.",
      request: { params: OrgParams },
      responses: { 200: json(VaultOverview), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const overview = await listVault(vaultDepsOf(deps), c.get("user").id, orgId);
      noStore(c);
      return c.json(overview, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/vault/items/{itemId}",
      tags,
      security,
      summary: "One item with its recent uses",
      description: "404 for an item this person can't see, as for one that doesn't exist.",
      request: { params: ItemParams },
      responses: { 200: json(VaultItemDetail), ...errors },
    }),
    async (c) => {
      const { orgId, itemId } = c.req.valid("param");
      const item = await getVaultItem(vaultDepsOf(deps), c.get("user").id, orgId, itemId);
      noStore(c);
      return c.json(item, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/vault/items",
      tags,
      security,
      summary: "Save a login, a key or a contact",
      description:
        "Any member saves personal items; team items take `manage_credentials` (403 `vault.team_needs_permission`). 400 `vault.not_https` for a website that isn't HTTPS, `vault.key_name_reserved`, `vault.audience_invalid`, `vault.agents_invalid`; 409 `vault.key_name_taken`, `vault.too_many_items`.",
      request: { params: OrgParams, body: body(ItemInput) },
      responses: { 201: json(VaultItem), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await createVaultItem(vaultDepsOf(deps), c.get("user").id, orgId, c.req.valid("json")), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/vault/items/{itemId}",
      tags,
      security,
      summary: "Change an item, its value or who has access",
      description:
        "Its owner for a personal item; `manage_credentials` for a team one (403 otherwise). An external item's fields from its source are read-only (400 `vault.external_read_only`): only its access, variable name and description change here.",
      request: { params: ItemParams, body: body(ItemPatch) },
      responses: { 200: json(VaultItem), ...errors },
    }),
    async (c) => {
      const { orgId, itemId } = c.req.valid("param");
      const patch = c.req.valid("json");
      return c.json(await updateVaultItem(vaultDepsOf(deps), c.get("user").id, orgId, itemId, patch), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/vault/items/{itemId}",
      tags,
      security,
      summary: "Delete an item (an external one only leaves the Vault; its source keeps it)",
      request: { params: ItemParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, itemId } = c.req.valid("param");
      await deleteVaultItem(vaultDepsOf(deps), c.get("user").id, orgId, itemId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/vault/import",
      tags,
      security,
      summary: "Import logins from a passwords file (CSV), or count what an import would do",
      description:
        "Chrome, 1Password, Bitwarden or any CSV with url and password columns, up to 2 MB and 5000 rows; the file is never kept. Only HTTPS addresses. A team import takes `manage_credentials`. 400 `vault.csv_unrecognized`, `vault.csv_too_many_rows`; 413 `vault.csv_too_large`.",
      request: { params: OrgParams, body: body(ImportInput) },
      responses: {
        200: json(ImportResult),
        ...errors,
        413: errorResponse("The file is too large (`vault.csv_too_large`)"),
        ...tooMany,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      await limited(`vault-import:${userId}`, IMPORTS);
      return c.json(await importVaultCsv(vaultDepsOf(deps), userId, orgId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/vault/connections",
      tags,
      security,
      summary: "Connect a password manager: checked now, then its items are read",
      description:
        "A personal connection for any member; a team one takes `manage_credentials`. 400 `vault.source_unknown` for a source this server doesn't have, `vault.source.<code>` when the password manager refuses (`auth_failed`, `locked`, `many_vaults`, `no_vault`, `folder_missing`, `unreachable`, `unsupported`, `invalid_input`); 429 `vault.source.rate_limited`. The credentials are sealed and never come back. 10 tries a minute per person.",
      request: { params: OrgParams, body: body(ConnectInput) },
      responses: { 201: json(VaultConnection), ...errors, ...tooMany },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      await limited(`vault-source:${userId}`, SOURCE_CHECKS);
      const connection = await vaultCall(connectVaultSource(vaultDepsOf(deps), userId, orgId, c.req.valid("json")));
      return c.json(connection, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/vault/connections/{connectionId}",
      tags,
      security,
      summary: "Change a connection's default access, or reconnect it with new credentials",
      description:
        "Its owner for a personal one; `manage_credentials` for a team one. New credentials are checked first.",
      request: { params: ConnectionParams, body: body(ConnectionPatch) },
      responses: { 200: json(VaultConnection), ...errors, ...tooMany },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      const userId = c.get("user").id;
      const patch = c.req.valid("json");
      if (patch.input) await limited(`vault-source:${userId}`, SOURCE_CHECKS);
      const connection = await vaultCall(updateVaultConnection(vaultDepsOf(deps), userId, orgId, connectionId, patch));
      return c.json(connection, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/vault/connections/{connectionId}/sync",
      tags,
      security,
      summary: "Read the password manager's items again now",
      request: { params: ConnectionParams },
      responses: { 200: json(VaultConnection), ...errors, ...tooMany },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      const userId = c.get("user").id;
      await limited(`vault-source:${userId}`, SOURCE_CHECKS);
      const connection = await vaultCall(syncVaultConnection(vaultDepsOf(deps), userId, orgId, connectionId));
      return c.json(connection, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/vault/connections/{connectionId}",
      tags,
      security,
      summary: "Disconnect a password manager: its items leave the Vault (the password manager keeps them)",
      request: { params: ConnectionParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      await deleteVaultConnection(vaultDepsOf(deps), c.get("user").id, orgId, connectionId);
      return c.body(null, 204);
    },
  );

  return app;
}

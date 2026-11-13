import type { KeyWrapper } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";
import {
  checkOpenRouterKey,
  customModelOf,
  customModelsOf,
  type EndpointStyle,
  ensureOpenRouterModels,
  isAutoModel,
  isCustomModel,
  isKnownProvider,
  isOpenRouterModel,
  listedModels,
  type ModelInfo,
  modelInfo,
  modelProvider,
  PROVIDERS,
  type ProviderId,
  parseCustomModel,
} from "@agenteschat/providers";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { openSecret, sealSecret } from "./crypto";
import {
  cleanEndpointModels,
  ENDPOINT_NO_KEY,
  type EndpointModel,
  type EndpointNet,
  endpointAddress,
  loadEndpointModels,
  type StoredEndpoint,
} from "./endpoints";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { KeyCheck, ModelGateway } from "./gateway";
import { requirePermission } from "./organizations";
import { orgModelProvider } from "./router";
import { billingHold } from "./standing";

const { providerCredentials } = schema;

/** Associated data binding a sealed key to its organization and row. */
const aadFor = (orgId: string, credentialId: string) => `provider-credential|${orgId}|${credentialId}`;

/** Public view of a credential. The key itself is never returned by any API. */
export interface CredentialSummary {
  id: string;
  provider: ProviderId;
  label: string;
  keyHint: string;
  /** Last characters of the workspace id the key is scoped to, if one is set. */
  workspaceIdHint: string | null;
  /** The workspace's default key (used by agents without their own key, router, summaries). */
  isDefault?: boolean;
  /** A workspace endpoint's address, API style and models (`custom`, ADR 0146). Not secret. */
  endpoint?: StoredEndpoint;
  /** The agents that think with it (`listCredentials`): what removing it would change. */
  usedBy?: { id: string; name: string }[];
  /** On a key just saved: `ok` a real call passed, `unchecked` the provider gave no answer about the key. */
  check?: KeyCheckState;
  createdAt: Date;
  revokedAt: Date | null;
}

/** What a test call could say of a key that was kept. */
export type KeyCheckState = "ok" | "unchecked";

const summary = (row: typeof providerCredentials.$inferSelect): CredentialSummary => ({
  id: row.id,
  provider: row.provider as ProviderId,
  label: row.label,
  keyHint: row.keyHint,
  workspaceIdHint: row.workspaceId ? row.workspaceId.slice(-6) : null,
  ...(row.options?.endpoint ? { endpoint: row.options.endpoint } : {}),
  createdAt: row.createdAt,
  revokedAt: row.revokedAt,
});

function cleanWorkspaceId(id: string | null | undefined) {
  const v = id?.trim();
  if (!v) return null;
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(v)) throw new ValidationError("workspaceId looks invalid");
  return v;
}

/** A key's change in the audit log: the provider, its name and last four characters, never the key. */
function auditCredential(
  db: Executor,
  orgId: string,
  actorId: string,
  action: string,
  row: { id: string; provider: string; label: string; keyHint: string | null },
) {
  return recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action,
    target: { type: "credential", id: row.id },
    details: { provider: row.provider, label: row.label, ...(row.keyHint ? { keyHint: row.keyHint } : {}) },
  });
}

/** The cache key of `openRouterInUse`: about the whole server, no org's. */
const OPENROUTER_IN_USE = "*:openrouter-in-use";

/**
 * Whether any workspace on this server has an OpenRouter key that isn't revoked: OpenRouter's model list is read
 * only then (ADR 0087). Cached like credential rows.
 */
export async function openRouterInUse(db: Executor): Promise<boolean> {
  return (await caches.credentials.getOrLoad(OPENROUTER_IN_USE, async () => {
    const [row] = await db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(and(eq(providerCredentials.provider, "openrouter"), isNull(providerCredentials.revokedAt)))
      .limit(1);
    return row !== undefined;
  })) as boolean;
}

/**
 * A model's entry, for a setting someone picks: OpenRouter's list is read first only while it is in use. A workspace
 * endpoint's model (ADR 0146) is found only for its own organization.
 */
export async function modelInfoFor(db: Executor, model: string, orgId?: string): Promise<ModelInfo | undefined> {
  if (isCustomModel(model)) {
    if (!orgId) return undefined;
    await loadEndpointModels(db, orgId);
    return customModelOf(orgId, model);
  }
  if (isOpenRouterModel(model) && (await openRouterInUse(db))) await ensureOpenRouterModels(model);
  return modelInfo(model);
}

/**
 * Every model for the pickers: the catalog's, then OpenRouter's (its list read first only while it is in use), then
 * the endpoint models of `orgIds` (ADR 0146).
 */
export async function pickerModels(db: Executor, orgIds: readonly string[] = []): Promise<[string, ModelInfo][]> {
  if (await openRouterInUse(db)) await ensureOpenRouterModels();
  for (const orgId of orgIds) await loadEndpointModels(db, orgId);
  return [...listedModels(), ...orgIds.flatMap((orgId) => customModelsOf(orgId))];
}

/**
 * An OpenRouter key is checked with OpenRouter before it is stored (no model call): a refused key or one that only
 * manages keys is never kept. A check that gets no answer either way lets it be saved.
 */
async function checkKey(provider: string, apiKey: string, http?: typeof fetch) {
  if (provider !== "openrouter") return;
  const state = await checkOpenRouterKey(apiKey, http);
  if (state === "invalid") throw new ValidationError("The provider didn't accept this key.", "provider_key_invalid");
  if (state === "management")
    throw new ValidationError("This is a management key. Create a regular API key.", "provider_key_management");
}

/** The test call a key goes through (the gateway's `verifyKey`), absent on a server with no model gateway. */
export type KeyVerifier = ModelGateway["verifyKey"];

/**
 * What a test call means for a key. A refusal (no such key, no credit, no permission) is never kept: it comes back with
 * the provider's name and words. A provider that gives no answer about the key doesn't stop anything.
 */
function passedCheck(providerId: string, result: KeyCheck | undefined) {
  if (result?.state === "refused") {
    const provider = PROVIDERS[providerId as ProviderId]?.label ?? providerId;
    throw new ValidationError(`${provider} refused this key.`, `provider_key_${result.refusal}`, {
      provider,
      said: result.said,
    });
  }
  return result?.state === "ok" ? result : null;
}

/** A key is no way around a billing hold: it would only sit there reading as ready. */
async function assertKeysOpen(db: Database, orgId: string) {
  if (await billingHold(db, orgId)) {
    throw new ForbiddenError("API keys open with the workspace's agentes.chat plan", "credentials.plan_hold");
  }
}

/** Stores an org's provider API key, encrypted (envelope encryption). */
export async function createCredential(
  db: Database,
  keyWrapper: KeyWrapper,
  actorId: string,
  orgId: string,
  input: {
    provider: ProviderId;
    label: string;
    apiKey: string;
    workspaceId?: string | null;
    /** OpenAI organization and project ids, when the key needs them. */
    organization?: string | null;
    project?: string | null;
    /** Make it the workspace's default key (onboarding does this in the same call). */
    makeDefault?: boolean;
    /** `custom` only, and required there: the endpoint's address, API style and models (ADR 0146). */
    endpoint?: { style: EndpointStyle; baseURL: string; models: EndpointModel[] };
  },
  /** Outbound HTTP for the provider's key check (tests: a fake); `net`: how endpoints may be reached. */
  opts: { fetch?: typeof fetch; net?: EndpointNet; verify?: KeyVerifier } = {},
): Promise<CredentialSummary> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  await assertKeysOpen(db, orgId);
  if (!isKnownProvider(input.provider)) throw new ValidationError(`Unknown provider ${input.provider}`);
  const custom = input.provider === "custom";
  if (custom !== Boolean(input.endpoint))
    throw new ValidationError(custom ? "An endpoint needs its address and models" : "Only an endpoint has an address");
  // A key-less server (a local Ollama) gets a word the SDKs accept.
  const apiKey = input.apiKey.trim() || (custom ? ENDPOINT_NO_KEY : "");
  if (apiKey.length < (custom ? 1 : 8)) throw new ValidationError("apiKey looks too short");
  const endpoint: StoredEndpoint | undefined = input.endpoint && {
    style: input.endpoint.style,
    baseURL: await endpointAddress(input.endpoint.baseURL, input.endpoint.style, opts.net ?? { allowPrivate: false }),
    models: cleanEndpointModels(input.endpoint.models),
  };
  await checkKey(input.provider, apiKey, opts.fetch);
  const options = cleanOptions(input);
  const workspaceId = cleanWorkspaceId(input.workspaceId);
  const passed = custom
    ? null
    : passedCheck(
        input.provider,
        await opts.verify?.({
          orgId,
          provider: input.provider,
          key: { apiKey, ...(workspaceId ? { workspaceId } : {}), ...options },
        }),
      );
  const id = crypto.randomUUID();
  const sealed = await sealSecret(keyWrapper, apiKey, aadFor(orgId, id));
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(providerCredentials)
      .values({
        id,
        orgId,
        provider: input.provider,
        label: input.label,
        secretCiphertext: sealed.ciphertext,
        wrappedDataKey: sealed.wrappedDataKey,
        kekId: sealed.kekId,
        keyHint: apiKey === ENDPOINT_NO_KEY ? "" : apiKey.slice(-4),
        workspaceId,
        options: { ...options, ...(endpoint ? { endpoint } : {}) },
        createdByUserId: actorId,
      })
      .returning();
    if (input.makeDefault) await setDefault(tx, orgId, input.provider, id);
    if (r) await auditCredential(tx, orgId, actorId, "credential.added", r);
    return r;
  });
  if (!row) throw new Error("credential insert returned nothing");
  invalidateDefaults(orgId);
  if (input.provider === "openrouter") {
    caches.credentials.delete(OPENROUTER_IN_USE);
    // Its models, ready for the pickers.
    void ensureOpenRouterModels();
  }
  await passed?.record(row.id);
  return {
    ...summary(row),
    isDefault: input.makeDefault === true,
    ...(custom ? {} : { check: passed ? ("ok" as const) : ("unchecked" as const) }),
  };
}

/**
 * Tries a stored key again (admins), before an agent is pointed at it: a key kept before this check, or one whose
 * credit ran out since, gets the same answer as on save.
 */
export async function checkCredential(
  db: Database,
  gateway: Pick<ModelGateway, "verifyStoredKey">,
  actorId: string,
  orgId: string,
  credentialId: string,
): Promise<KeyCheckState> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const stored = await gateway.verifyStoredKey(orgId, credentialId);
  if (!stored) throw new NotFoundError("Credential not found");
  const passed = passedCheck(stored.provider, stored.result);
  await passed?.record(credentialId);
  return passed ? "ok" : "unchecked";
}

function cleanOptions(input: { organization?: string | null; project?: string | null }) {
  const out: { organization?: string; project?: string } = {};
  for (const key of ["organization", "project"] as const) {
    const v = input[key]?.trim();
    if (!v) continue;
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(v)) throw new ValidationError(`${key} looks invalid`);
    out[key] = v;
  }
  return out;
}

/** Forgets which credential is each provider's default for an org, and its endpoints (after any key or settings change). */
export function invalidateDefaults(orgId: string) {
  caches.credentials.deletePrefix(`${orgId}:default:`);
  caches.credentials.delete(`${orgId}:endpoints`);
}

/** Makes a key its provider's default (and the legacy single default), in the caller's transaction. */
async function setDefault(tx: Executor, orgId: string, provider: string, credentialId: string) {
  const patch = sql`coalesce(${schema.organizationSettings.defaultCredentialIds}, '{}'::jsonb) || jsonb_build_object(${provider}::text, ${credentialId}::text)`;
  await tx
    .insert(schema.organizationSettings)
    .values({ orgId, defaultCredentialId: credentialId, defaultCredentialIds: { [provider]: credentialId } })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { defaultCredentialId: credentialId, defaultCredentialIds: patch, updatedAt: new Date() },
    });
}

/** "Make default": a key becomes its provider's default for the workspace (admins). */
export async function makeDefaultCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    );
  if (!row) throw new NotFoundError("Credential not found");
  await setDefault(db, orgId, row.provider, credentialId);
  await auditCredential(db, orgId, actorId, "credential.default_changed", row);
  invalidateDefaults(orgId);
  return { ...summary(row), isDefault: true };
}

/** The workspace's default keys: per provider, plus the legacy single default. */
export async function defaultCredentials(db: Database, orgId: string) {
  const [row] = await db
    .select({
      id: schema.organizationSettings.defaultCredentialId,
      ids: schema.organizationSettings.defaultCredentialIds,
    })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  return { legacy: row?.id ?? null, perProvider: (row?.ids ?? {}) as Partial<Record<string, string>> };
}

/** The workspace's default credential id (legacy single default), if one is set. */
export async function defaultCredentialId(db: Database, orgId: string) {
  return (await defaultCredentials(db, orgId)).legacy;
}

/** Removing a default key would leave its provider without one: refused unless the person said to go on (`release`). */
async function refuseIfDefault(db: Database, orgId: string, credentialId: string) {
  const d = await defaultCredentials(db, orgId);
  if (d.legacy === credentialId || Object.values(d.perProvider).includes(credentialId)) {
    throw new ConflictError(
      "This is the workspace's default key. Make another key the default first.",
      "credential.default",
    );
  }
}

/** The key stops being a default: its provider's next call takes the newest key left, as with no default set. */
async function dropDefault(tx: Executor, orgId: string, credentialId: string) {
  await tx
    .update(schema.organizationSettings)
    .set({
      defaultCredentialId: sql`nullif(${schema.organizationSettings.defaultCredentialId}, ${credentialId}::uuid)`,
      defaultCredentialIds: sql`coalesce((select jsonb_object_agg(key, value) from jsonb_each(${schema.organizationSettings.defaultCredentialIds}) where value <> to_jsonb(${credentialId}::text)), '{}'::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.organizationSettings.orgId, orgId));
}

/**
 * The key a provider's calls take with no key of their own, of an org's keys oldest first: its default, the single
 * default of old when it is of that provider, else its newest (`resolveKey`'s order).
 */
export function providerKeyOf<K extends { id: string; provider: string; revokedAt: Date | null }>(
  rows: readonly K[],
  defaults: Awaited<ReturnType<typeof defaultCredentials>>,
  provider: string | undefined,
) {
  const live = rows.filter((r) => r.provider === provider && !r.revokedAt);
  const chosen = provider ? defaults.perProvider[provider] : undefined;
  return live.find((r) => r.id === chosen) ?? live.find((r) => r.id === defaults.legacy) ?? live.at(-1) ?? null;
}

export async function listCredentials(db: Database, actorId: string, orgId: string): Promise<CredentialSummary[]> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const [rows, defaults, agents, autoProvider] = await Promise.all([
    db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.orgId, orgId))
      .orderBy(asc(providerCredentials.createdAt)),
    defaultCredentials(db, orgId),
    db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        credentialId: schema.agents.credentialId,
        model: schema.agents.model,
        brain: schema.agents.brain,
      })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.archivedAt))),
    orgModelProvider(db, orgId),
  ]);
  const isDefault = (r: typeof providerCredentials.$inferSelect) =>
    defaults.perProvider[r.provider] ? defaults.perProvider[r.provider] === r.id : defaults.legacy === r.id;
  // An agent with no key of its own thinks with its provider's key all the same: removing that one changes it too.
  const keyOf = (a: (typeof agents)[number]) => {
    const own = parseCustomModel(a.model)?.credentialId ?? a.credentialId;
    if (own || a.brain !== "model") return own;
    return providerKeyOf(rows, defaults, isAutoModel(a.model) ? autoProvider : modelProvider(a.model))?.id;
  };
  const usedBy = (id: string) => agents.filter((a) => keyOf(a) === id).map((a) => ({ id: a.id, name: a.name }));
  return rows.map((r) => ({ ...summary(r), isDefault: isDefault(r), usedBy: usedBy(r.id) }));
}

/** Revoked keys stay stored (usage records point at them) but can no longer be decrypted for calls. */
export async function revokeCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  await refuseIfDefault(db, orgId, credentialId);
  const [row] = await db
    .update(providerCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Credential not found");
  await auditCredential(db, orgId, actorId, "credential.revoked", row);
  caches.credentials.delete(`${orgId}:${credentialId}`);
  invalidateDefaults(orgId);
}

/**
 * A credential that isn't revoked, as stored (its key still sealed). Org-scoped. The row is cached;
 * the key is decrypted per call and never cached.
 */
export async function usableCredentialRow(db: Executor, orgId: string, credentialId: string) {
  return (await caches.credentials.getOrLoad(`${orgId}:${credentialId}`, async () => {
    const [r] = await db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, credentialId),
          eq(providerCredentials.orgId, orgId),
          isNull(providerCredentials.revokedAt),
        ),
      );
    return r ?? null;
  })) as typeof providerCredentials.$inferSelect | null;
}

/**
 * Decrypts a credential for a model call. Backend-only: the Model Gateway is
 * its only caller. Org-scoped: a credential id from another org is not found.
 */
export async function decryptCredential(
  db: Database,
  keyWrappers: KeyWrapper[],
  orgId: string,
  credentialId: string,
): Promise<{
  provider: ProviderId;
  apiKey: string;
  workspaceId?: string;
  options?: { organization?: string; project?: string; endpoint?: StoredEndpoint };
} | null> {
  const row = await usableCredentialRow(db, orgId, credentialId);
  if (!row) return null;
  const apiKey = await openSecret(
    keyWrappers,
    { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    aadFor(orgId, row.id),
  );
  return {
    provider: row.provider as ProviderId,
    apiKey,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    options: row.options ?? {},
  };
}

/**
 * Replaces the key of a credential, keeping its id (agents keep pointing at
 * it). The old ciphertext is overwritten; usage history is untouched.
 */
export async function rotateCredential(
  db: Database,
  keyWrapper: KeyWrapper,
  actorId: string,
  orgId: string,
  credentialId: string,
  input: {
    apiKey: string;
    label?: string;
    workspaceId?: string | null;
    organization?: string | null;
    project?: string | null;
  },
  /** Outbound HTTP for the provider's key check (tests: a fake). */
  opts: { fetch?: typeof fetch; verify?: KeyVerifier } = {},
): Promise<CredentialSummary> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  await assertKeysOpen(db, orgId);
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 8) throw new ValidationError("apiKey looks too short");
  // The values are checked before the credential is read: a bad one is refused whatever the credential.
  const values = {
    ...(input.label ? { label: input.label } : {}),
    ...(input.workspaceId !== undefined ? { workspaceId: cleanWorkspaceId(input.workspaceId) } : {}),
    ...(input.organization !== undefined || input.project !== undefined ? { options: cleanOptions(input) } : {}),
  };
  const current = await usableCredentialRow(db, orgId, credentialId);
  if (!current) throw new NotFoundError("Credential not found");
  await checkKey(current.provider, apiKey, opts.fetch);
  const custom = current.provider === "custom";
  const scoped = values.workspaceId ?? current.workspaceId;
  const passed = custom
    ? null
    : passedCheck(
        current.provider,
        await opts.verify?.({
          orgId,
          provider: current.provider,
          key: {
            apiKey,
            ...(scoped ? { workspaceId: scoped } : {}),
            ...cleanOptions(values.options ?? current.options),
          },
        }),
      );
  const sealed = await sealSecret(keyWrapper, apiKey, aadFor(orgId, credentialId));
  const [row] = await db
    .update(providerCredentials)
    .set({
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      keyHint: apiKey.slice(-4),
      ...values,
      // An endpoint's address and models stay as they are.
      ...(values.options && current.options.endpoint
        ? { options: { ...values.options, endpoint: current.options.endpoint } }
        : {}),
    })
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Credential not found");
  await auditCredential(db, orgId, actorId, "credential.key_changed", row);
  caches.credentials.delete(`${orgId}:${credentialId}`);
  invalidateDefaults(orgId);
  await passed?.record(row.id);
  return { ...summary(row), ...(custom ? {} : { check: passed ? ("ok" as const) : ("unchecked" as const) }) };
}

/**
 * Deletes a credential for good (the sealed key is gone). Refused while it is a default or agents use it, with what
 * stands in the way, since they would move to another key without anyone choosing. `release`: the person read what
 * happens and goes on: those agents lose their pin and resolve as any agent with no key of its own (the provider's
 * default, its newest key, the platform's), or say they have no AI.
 */
export async function deleteCredential(
  db: Database,
  actorId: string,
  orgId: string,
  credentialId: string,
  options: { release?: boolean } = {},
) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const users = await db
    .select({ id: schema.agents.id, handle: schema.agents.handle, name: schema.agents.name })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        eq(schema.agents.credentialId, credentialId),
        isNull(schema.agents.archivedAt),
      ),
    );
  if (!options.release) {
    await refuseIfDefault(db, orgId, credentialId);
    if (users.length > 0) {
      throw new ConflictError(
        `In use by ${users.map((u) => `@${u.handle}`).join(", ")}. Point them at another key first.`,
        "credential.in_use",
        { agents: users.map((u) => u.name).join(", ") },
      );
    }
  }
  const deleted = await db.transaction(async (tx) => {
    if (options.release) await dropDefault(tx, orgId, credentialId);
    return tx
      .delete(providerCredentials)
      .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.orgId, orgId)))
      .returning({
        id: providerCredentials.id,
        provider: providerCredentials.provider,
        label: providerCredentials.label,
        keyHint: providerCredentials.keyHint,
      });
  });
  if (!deleted[0]) throw new NotFoundError("Credential not found");
  await auditCredential(db, orgId, actorId, "credential.deleted", deleted[0]);
  caches.credentials.delete(`${orgId}:${credentialId}`);
  for (const u of users) caches.agents.delete(`${orgId}:${u.id}`);
  invalidateDefaults(orgId);
}

/** How many active agents use each credential. */
export async function credentialUsage(db: Database, orgId: string) {
  const rows = await db
    .select({ credentialId: schema.agents.credentialId })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.archivedAt)));
  const counts = new Map<string, number>();
  for (const r of rows) if (r.credentialId) counts.set(r.credentialId, (counts.get(r.credentialId) ?? 0) + 1);
  return counts;
}

/** Providers this org can call: it has an active key of its own, or the platform offers one. */
export async function availableProviders(
  db: Database,
  orgId: string,
  platform: {
    available?(orgId: string, provider: string): Promise<boolean>;
    resolve(orgId: string, provider: string): Promise<unknown>;
  },
  providers: string[],
) {
  const rows = await db
    .select({ provider: providerCredentials.provider })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.orgId, orgId), isNull(providerCredentials.revokedAt)));
  const own = new Set(rows.map((r) => r.provider));
  const out = new Map<string, { own: boolean; platform: boolean }>();
  for (const p of providers) {
    const viaPlatform = platform.available
      ? await platform.available(orgId, p)
      : (await platform.resolve(orgId, p)) !== null;
    out.set(p, { own: own.has(p), platform: viaPlatform });
  }
  return out;
}

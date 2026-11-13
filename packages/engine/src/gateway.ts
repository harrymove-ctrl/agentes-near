import type { ErrorReporter, KeyWrapper, PlatformCredentials, PubSub, SearchKind } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gte, isNull, lt, rowsOf, schema, sql } from "@agenteschat/db";
import {
  costNanoUsd,
  customModelOf,
  type EmbeddingProvider,
  type EmbeddingResult,
  type Endpoint,
  embeddingCostNanoUsd,
  ensureOpenRouterModels,
  estimateTokens,
  isCustomModel,
  isKnownModel,
  isOpenRouterModel,
  type KeyRefusal,
  keyCheckRequest,
  keyFailureWords,
  keyRefusalOf,
  type ModelInfo,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  maxCostNanoUsd,
  modelInfo,
  modelProvider,
  openRouterListed,
  outputTokensWithin,
  PROVIDERS,
  ProviderError,
  parseCustomModel,
  promptChars,
  type SystemPrompt,
  type ToolSpec,
} from "@agenteschat/providers";
import { type Agent, getAgent } from "./agents";
import { caches } from "./cache";
import { decryptCredential, usableCredentialRow } from "./credentials";
import { loadEndpointModels } from "./endpoints";
import { BudgetExceededError, MissingCredentialError, NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { maySql, type RolePermission } from "./permissions";
import { addPersonSpend, assertPersonUnderLimit, personSpendAdded } from "./person-usage";
import { assertCanWork, standingRefusal } from "./standing";
import { redactCredentials } from "./tool-detail";
import { budgetPercent, monthStartUtc, withEffectiveBudget } from "./usage";

const {
  usageRecords,
  agentBudgetPeriods,
  budgetReservations,
  providerCredentials,
  organizationSettings,
  organizationMembers,
  personUsageMonths,
} = schema;

export interface ModelGatewayDeps {
  db: Database;
  /** Current wrapper first, then legacy ones (rotation). */
  keyWrappers: KeyWrapper[];
  providers: Record<string, ModelProvider>;
  platformCredentials: PlatformCredentials;
  now?: () => Date;
  /** Embeddings for search (optional: without it search is full-text only). */
  embeddings?: GatewayEmbeddings;
  /** Where an embeddings outage is reported, once (ADR 0104); absent: not reported. */
  errors?: ErrorReporter;
  /** Called when an agent's monthly spend crosses 80% (`warning`) or 100% (`exhausted`) of its budget. */
  onBudgetThreshold?(event: {
    agent: Agent;
    level: "warning" | "exhausted";
    spentNanoUsd: number;
    budgetNanoUsd: number;
  }): Promise<void> | void;
}

export interface GatewayEmbeddings {
  provider: EmbeddingProvider;
  apiKey: string;
  /** The kinds of documents that get vectors (`EMBEDDINGS_KINDS`); absent: every kind. */
  kinds?: readonly SearchKind[];
  /** How long a query's vector may take before search goes on with words (`EMBEDDINGS_QUERY_TIMEOUT_MS`). */
  queryTimeoutMs?: number;
}

export const EMBED_QUERY_TIMEOUT_MS = 1500;
/** Only stops a hung server from holding an indexing job: a CPU server takes minutes over a long batch. */
export const EMBED_DOCUMENT_TIMEOUT_MS = 5 * 60_000;
/** Embedding calls failed in a row before the outage is reported, once until one succeeds again. */
export const EMBED_FAILURES_REPORTED = 3;

export const BUDGET_WARNING_RATIO = 0.8;

/** A model call made by an agent: billed to the agent's credential and budget. */
export interface GatewayCall {
  orgId: string;
  agentId: string;
  /**
   * The agent row, when the caller already has it (saves a lookup). A run on
   * "Automático" passes it with the model it chose: the call is priced,
   * reserved and recorded at that model.
   */
  agent?: Agent;
  runId?: string;
  /**
   * The person behind the run (ADR 0141): recorded on the usage row, added to their month and checked against their
   * limit before the call. Absent or null: nobody's (an agent's own work).
   */
  personId?: string | null;
  system: SystemPrompt;
  messages: ModelMessage[];
  maxTokens: number;
  tools?: ToolSpec[];
  /** How hard the model thinks (set by "Automático"); absent: the provider's default. */
  effort?: ModelRequest["effort"];
  /** How long the stable prefix stays cached (`ModelRequest.cacheTtl`); absent: 5 minutes. */
  cacheTtl?: ModelRequest["cacheTtl"];
  /** The per-turn notes, read after the history (`ModelRequest.notes`). */
  notes?: ModelRequest["notes"];
  /** The agent's conversation, the same on each of its calls (`StreamOptions.session`). */
  session?: string;
  onDelta(text: string): void;
  signal?: AbortSignal;
}

/**
 * A model call made for the organization (router, summaries): billed to the
 * org's default credential, recorded with `agent_id` null (or the agent it
 * was made for) and its `kind`.
 */
export interface OrgCall {
  orgId: string;
  kind: "router" | "summary";
  model: string;
  system: SystemPrompt;
  messages: ModelMessage[];
  maxTokens: number;
  outputSchema?: Record<string, unknown>;
  /** Tools the model may call (an endpoint's test call, ADR 0146); none run here. */
  tools?: ToolSpec[];
  effort?: ModelRequest["effort"];
  /** Agent the call is about, if any (recorded, not billed to its budget). */
  agentId?: string | null;
  runId?: string;
  signal?: AbortSignal;
}

export interface GatewayResult extends ModelResult {
  usageRecordId: string;
  costNanoUsd: number;
  /** Output cap actually sent (may be lower than asked to fit the remaining budget). */
  maxTokens: number;
}

/** Reservations older than this are considered abandoned (a worker died mid-call) and released. */
export const RESERVATION_TTL_MS = 15 * 60_000;
/** Below this many output tokens a call isn't worth making: the budget counts as exhausted. */
export const MIN_OUTPUT_TOKENS = 256;
/** A test call that takes longer says the key couldn't be checked: it never holds a person's save up for long. */
export const KEY_CHECK_TIMEOUT_MS = 15_000;

/** A key and what its calls carry, for `verifyKey`. */
export interface KeyToVerify {
  orgId: string;
  provider: string;
  key: { apiKey: string; workspaceId?: string; organization?: string; project?: string };
}

/** What a test call said of a key. `said`: the provider's words, with no secret in them. */
export type KeyCheck =
  | { state: "ok"; record(credentialId: string): Promise<void> }
  | { state: "unchecked" }
  | { state: "refused"; refusal: KeyRefusal; said: string };

const periodOf = (now: Date) => monthStartUtc(now).toISOString().slice(0, 10);

/** The call's own key first: a key of an unusual shape is one no pattern knows. */
const withoutKey = (text: string, apiKey: string) => redactCredentials(apiKey ? text.replaceAll(apiKey, "••••") : text);

/**
 * A provider failure as it leaves the gateway: its words (a refused request keeps the API's) with credentials masked,
 * and who answered, on whose key. The key it ran on goes by its value: not every provider's has a shape we know.
 */
const masked = (
  error: unknown,
  provider: string,
  key: { apiKey: string; credentialId: string | null; endpoint?: Endpoint },
) => {
  if (!(error instanceof ProviderError)) return error;
  const clean = (text: string) => withoutKey(text, key.apiKey);
  const out = new ProviderError(
    clean(error.message),
    error.retryable,
    error.status,
    error.partial,
    error.said && clean(error.said),
  );
  // A workspace's own endpoint has no name of its own: people know it by its address.
  out.provider = key.endpoint
    ? redactCredentials(key.endpoint.baseURL.replace(/^https?:\/\//, "").split("/")[0] ?? "")
    : provider;
  out.platformKey = key.credentialId === null;
  return out;
};

/**
 * The only way to call a model (docs/adr/0007, 0012). For every call:
 * 0. refuse it for a workspace on hold or suspended, or a held agent (`standing.ts`);
 * 1. resolve the model from the catalog, OpenRouter's list or the workspace's own endpoint (ADR 0146) (agent's
 *    model, or the fixed org-call model);
 * 2. agent calls: atomically reserve the worst-case cost against the agent's
 *    monthly counter (row lock), shrinking `maxTokens` to fit the budget. An endpoint model without prices costs 0:
 *    its calls never use the budget up (tokens are still recorded), and an agent whose budget priced calls used up
 *    stops on it too;
 * 3. decrypt the org's credential (or ask the platform-credential adapter);
 * 4. stream through the provider interface;
 * 5. record tokens and cost with `org_id`, `agent_id` and `kind`, and settle
 *    the reservation to the actual cost — also when the stream fails midway
 *    (partial usage, flagged `partial`).
 * Keys exist in memory only for the duration of the call.
 */
export function createModelGateway(deps: ModelGatewayDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps;
  let embedFailures = 0;

  const providerFor = (provider: string) => {
    const p = deps.providers[provider];
    if (!p) throw new MissingCredentialError(`No provider registered for ${provider}`);
    return p;
  };

  type Key = {
    apiKey: string;
    workspaceId?: string;
    organization?: string;
    project?: string;
    /** A workspace endpoint's address and API style (ADR 0146). */
    endpoint?: Endpoint;
    credentialId: string | null;
  };
  const label = (provider: string) => (PROVIDERS as Record<string, { label: string }>)[provider]?.label ?? provider;
  const noKey = (provider: string) =>
    new MissingCredentialError(`Add an API key for ${label(provider)} in the workspace settings`);
  const keyOf = (c: Awaited<ReturnType<typeof decryptCredential>>, credentialId: string | null): Key | null =>
    c
      ? {
          apiKey: c.apiKey,
          workspaceId: c.workspaceId,
          organization: c.options?.organization,
          project: c.options?.project,
          ...(c.options?.endpoint
            ? { endpoint: { style: c.options.endpoint.style, baseURL: c.options.endpoint.baseURL } }
            : {}),
          credentialId,
        }
      : null;

  /**
   * One resolution order for every call: the agent's own credential → the
   * org's default for that provider (the default credential when it is of
   * that provider, else the org's newest key of that provider) → the platform
   * key for that provider, only if configured. Never a silent failure.
   */
  async function resolveKey(orgId: string, provider: string, agentCredentialId?: string | null): Promise<Key> {
    if (agentCredentialId) {
      const credential = await decryptCredential(db, deps.keyWrappers, orgId, agentCredentialId);
      if (!credential) {
        throw new MissingCredentialError("This agent's API key was revoked. Pick another one in the agent's settings.");
      }
      if (credential.provider !== provider) {
        throw new MissingCredentialError(
          `This agent's model is from ${label(provider)}, but the chosen key is from ${label(credential.provider)}`,
        );
      }
      return keyOf(credential, agentCredentialId) as Key;
    }
    const defaultId = await orgDefaultCredentialId(orgId, provider);
    if (defaultId) {
      const credential = await decryptCredential(db, deps.keyWrappers, orgId, defaultId);
      if (credential && credential.provider === provider) return keyOf(credential, defaultId) as Key;
    }
    const platform = await deps.platformCredentials.resolve(orgId, provider);
    if (!platform) throw noKey(provider);
    return { apiKey: platform.apiKey, workspaceId: platform.workspaceId, credentialId: null };
  }

  /** The org's default credential for a provider (cached; invalidated when keys or settings change). */
  async function orgDefaultCredentialId(orgId: string, provider: string): Promise<string | null> {
    return (await caches.credentials.getOrLoad(`${orgId}:default:${provider}`, async () => {
      const [settings] = await db
        .select({
          perProvider: organizationSettings.defaultCredentialIds,
          id: organizationSettings.defaultCredentialId,
          provider: providerCredentials.provider,
        })
        .from(organizationSettings)
        .leftJoin(
          providerCredentials,
          and(
            eq(providerCredentials.id, organizationSettings.defaultCredentialId),
            isNull(providerCredentials.revokedAt),
          ),
        )
        .where(eq(organizationSettings.orgId, orgId));
      const perProvider = (settings?.perProvider ?? {}) as Partial<Record<string, string>>;
      if (perProvider[provider]) return perProvider[provider] as string;
      if (settings?.id && settings.provider === provider) return settings.id;
      const [newest] = await db
        .select({ id: providerCredentials.id })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.orgId, orgId),
            eq(providerCredentials.provider, provider),
            isNull(providerCredentials.revokedAt),
          ),
        )
        .orderBy(desc(providerCredentials.createdAt))
        .limit(1);
      return newest?.id ?? null;
    })) as string | null;
  }

  /** A workspace endpoint's model names its own credential (ADR 0146): that key, whatever the agent's. */
  const pinnedKey = (model: string) => parseCustomModel(model)?.credentialId ?? null;
  const agentKey = (agent: Agent, provider: string) =>
    resolveKey(agent.orgId, provider, pinnedKey(agent.model) ?? agent.credentialId);
  const orgKey = (orgId: string, provider: string, model: string) => resolveKey(orgId, provider, pinnedKey(model));

  /**
   * A model's entry from the catalog or OpenRouter's list (read first when due), or why there is none. Called once
   * its key resolved: no key, no read of OpenRouter's list.
   */
  async function infoFor(orgId: string, model: string): Promise<ModelInfo> {
    if (isCustomModel(model)) {
      await loadEndpointModels(db, orgId);
      const own = customModelOf(orgId, model);
      if (own) return own;
      throw new ValidationError(
        "This model was removed from its endpoint. Pick another model in the agent's settings.",
      );
    }
    if (isOpenRouterModel(model)) await ensureOpenRouterModels(model);
    const info = modelInfo(model);
    if (info) return info;
    if (!isOpenRouterModel(model)) throw new ValidationError(`Model ${model} is not in the catalog`);
    // Without its list no call can be priced: like an outage, the run tries again later.
    if (!openRouterListed()) {
      const outage = new ProviderError("could not reach provider", true);
      outage.provider = label("openrouter");
      throw outage;
    }
    throw new ValidationError(`OpenRouter doesn't list ${model} anymore. Pick another model in the agent's settings.`);
  }

  /** The output cap sent: the call's, within the most the model may write. */
  const capOf = (maxTokens: number, info: ModelInfo) => Math.min(maxTokens, info.maxOutputTokens ?? maxTokens);

  /** Usage of a stream that failed midway: what the provider reported, else counted or estimated. */
  async function partialUsage(
    error: ProviderError,
    provider: ModelProvider,
    request: ModelRequest,
    key: { apiKey: string; workspaceId?: string; organization?: string; project?: string },
  ): Promise<ModelUsage | null> {
    const p = error.partial;
    if (!p) return null;
    let inputTokens = p.inputTokens;
    if (inputTokens === null) {
      try {
        inputTokens = provider.countTokens ? await provider.countTokens(request, key) : null;
      } catch {
        inputTokens = null;
      }
      inputTokens ??= estimateTokens(promptChars(request));
    }
    return {
      inputTokens,
      outputTokens: p.outputTokens ?? estimateTokens(p.outputChars),
      cacheReadTokens: p.cacheReadTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      ...(p.cacheWriteLongTokens ? { cacheWriteLongTokens: p.cacheWriteLongTokens } : {}),
    };
  }

  async function recordUsage(
    tx: Executor,
    input: {
      orgId: string;
      agentId: string | null;
      kind: "agent" | "router" | "summary";
      runId?: string;
      personId?: string | null;
      credentialId: string | null;
      provider: string;
      model: string;
      requestedModel: string;
      usage: ModelUsage;
      /** What the provider says the call cost; absent: priced from the catalog. */
      reportedCost?: number;
      partial: boolean;
    },
  ) {
    // Price by the model that answered (a server-side fallback may differ), if we know it.
    const pricedModel = isKnownModel(input.model) ? input.model : input.requestedModel;
    const cost = input.reportedCost ?? costNanoUsd(pricedModel, input.usage, now());
    const [record] = await tx
      .insert(usageRecords)
      .values({
        orgId: input.orgId,
        agentId: input.agentId,
        kind: input.kind,
        runId: input.runId,
        personId: input.personId ?? null,
        credentialId: input.credentialId,
        provider: input.provider,
        model: input.model,
        requestedModel: input.requestedModel,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        costNanoUsd: cost,
        partial: input.partial,
        createdAt: now(),
      })
      .returning({ id: usageRecords.id });
    if (!record) throw new Error("usage insert returned nothing");
    return { id: record.id, cost };
  }

  /**
   * Reserves the worst-case cost of a call against the agent's counter for
   * this month, under a row lock. Returns the reservation and the output cap
   * that fits. Throws BudgetExceededError when nothing useful fits.
   */
  async function reserve(
    agent: Agent,
    model: string,
    promptTokens: number,
    maxTokens: number,
    longCache = false,
  ): Promise<{
    reservation: Pick<typeof budgetReservations.$inferSelect, "id" | "agentId" | "periodStart"> | null;
    maxTokens: number;
  }> {
    // No budget (callers pass the effective one, so only defensive): nothing to reserve.
    if (agent.monthlyBudgetNanoUsd === null) return { reservation: null, maxTokens };
    const at = now();
    const period = periodOf(at);
    // Fast path, one statement: the worst case fits under the budget → reserve it atomically.
    const amount = maxCostNanoUsd(model, promptTokens, maxTokens, longCache);
    const id = Bun.randomUUIDv7();
    const fast = rowsOf<{ ok: number }>(
      await db.execute(sql`with upd as (
          update ${agentBudgetPeriods}
          set reserved_nano_usd = reserved_nano_usd + ${amount}, updated_at = now()
          where agent_id = ${agent.id} and period_start = ${period}::date
            and spent_nano_usd + reserved_nano_usd + ${amount} <= ${agent.monthlyBudgetNanoUsd}
          returning agent_id
        ), res as (
          insert into ${budgetReservations} (id, org_id, agent_id, period_start, amount_nano_usd, expires_at, created_at)
          select ${id}::uuid, ${agent.orgId}::uuid, ${agent.id}::uuid, ${period}::date, ${amount},
                 ${new Date(at.getTime() + RESERVATION_TTL_MS).toISOString()}::timestamptz, now()
          from upd
          returning id
        )
        select count(*)::int as ok from res`),
    );
    if (Number(fast[0]?.ok ?? 0) > 0) return { reservation: { id, agentId: agent.id, periodStart: period }, maxTokens };
    // Slow path (first call of the month, expired reservations, or the cap must shrink): locked transaction.
    return db.transaction(async (tx) => {
      await tx
        .insert(agentBudgetPeriods)
        .values({
          orgId: agent.orgId,
          agentId: agent.id,
          periodStart: period,
          // First call of the month (or first since budgets existed): start from the agent's own recorded calls
          // (`agentSpendThisMonth`).
          spentNanoUsd: sql`(select coalesce(sum(${usageRecords.costNanoUsd}), 0) from ${usageRecords}
            where ${usageRecords.orgId} = ${agent.orgId} and ${usageRecords.agentId} = ${agent.id}
            and ${usageRecords.kind} = 'agent'
            and ${usageRecords.createdAt} >= ${monthStartUtc(at).toISOString()}::timestamptz)`,
        })
        .onConflictDoNothing();
      // Abandoned reservations (crashed workers) stop counting.
      const expired = await tx
        .delete(budgetReservations)
        .where(
          and(
            eq(budgetReservations.agentId, agent.id),
            eq(budgetReservations.periodStart, period),
            lt(budgetReservations.expiresAt, at),
          ),
        )
        .returning({ amount: budgetReservations.amountNanoUsd });
      const [row] = await tx
        .select()
        .from(agentBudgetPeriods)
        .where(and(eq(agentBudgetPeriods.agentId, agent.id), eq(agentBudgetPeriods.periodStart, period)))
        .for("update");
      if (!row) throw new Error("budget period row missing");
      const reserved = row.reservedNanoUsd - expired.reduce((n, e) => n + e.amount, 0);

      let cap = maxTokens;
      if (agent.monthlyBudgetNanoUsd !== null) {
        const left = agent.monthlyBudgetNanoUsd - row.spentNanoUsd - reserved;
        cap = Math.min(maxTokens, outputTokensWithin(model, promptTokens, left, longCache));
        if (left <= 0 || cap < Math.min(MIN_OUTPUT_TOKENS, maxTokens)) {
          if (expired.length > 0)
            await tx
              .update(agentBudgetPeriods)
              .set({ reservedNanoUsd: Math.max(0, reserved) })
              .where(and(eq(agentBudgetPeriods.agentId, agent.id), eq(agentBudgetPeriods.periodStart, period)));
          const room = agent.monthlyBudgetNanoUsd - row.spentNanoUsd;
          const byReservations =
            reserved > 0 &&
            room > 0 &&
            outputTokensWithin(model, promptTokens, room, longCache) >= Math.min(MIN_OUTPUT_TOKENS, maxTokens);
          throw new BudgetExceededError(agent.id, row.spentNanoUsd, agent.monthlyBudgetNanoUsd, byReservations);
        }
      }
      const amount = maxCostNanoUsd(model, promptTokens, cap, longCache);
      const [reservation] = await tx
        .insert(budgetReservations)
        .values({
          orgId: agent.orgId,
          agentId: agent.id,
          periodStart: period,
          amountNanoUsd: amount,
          expiresAt: new Date(at.getTime() + RESERVATION_TTL_MS),
        })
        .returning();
      await tx
        .update(agentBudgetPeriods)
        .set({ reservedNanoUsd: Math.max(0, reserved) + amount, updatedAt: at })
        .where(and(eq(agentBudgetPeriods.agentId, agent.id), eq(agentBudgetPeriods.periodStart, period)));
      if (!reservation) throw new Error("reservation insert returned nothing");
      return { reservation, maxTokens: cap };
    });
  }

  /** Releases a reservation and adds `actual` to the spent counter, in the caller's transaction. */
  async function settle(
    tx: Executor,
    reservation: Pick<typeof budgetReservations.$inferSelect, "id" | "agentId" | "periodStart"> | null,
    actual: number,
    agent?: Agent,
  ) {
    if (!reservation) {
      if (!agent) return actual;
      const [row] = await tx
        .insert(agentBudgetPeriods)
        .values({ orgId: agent.orgId, agentId: agent.id, periodStart: periodOf(now()), spentNanoUsd: actual })
        .onConflictDoUpdate({
          target: [agentBudgetPeriods.agentId, agentBudgetPeriods.periodStart],
          set: { spentNanoUsd: sql`${agentBudgetPeriods.spentNanoUsd} + ${actual}`, updatedAt: now() },
        })
        .returning({ spent: agentBudgetPeriods.spentNanoUsd });
      return row?.spent ?? actual;
    }
    const [released] = await tx
      .delete(budgetReservations)
      .where(eq(budgetReservations.id, reservation.id))
      .returning({ amount: budgetReservations.amountNanoUsd });
    const updated = await tx
      .update(agentBudgetPeriods)
      .set({
        spentNanoUsd: sql`${agentBudgetPeriods.spentNanoUsd} + ${actual}`,
        reservedNanoUsd: sql`greatest(0, ${agentBudgetPeriods.reservedNanoUsd} - ${released?.amount ?? 0})`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(agentBudgetPeriods.agentId, reservation.agentId),
          eq(agentBudgetPeriods.periodStart, reservation.periodStart),
        ),
      )
      .returning({ spent: agentBudgetPeriods.spentNanoUsd });
    return updated[0]?.spent ?? actual;
  }

  /**
   * After a successful agent call, one statement: the usage record, the
   * reservation released, the spend counter updated and the person's month
   * added to (no transaction round trips; a remote database costs one round
   * trip here).
   */
  async function settleCall(input: {
    agent: Agent;
    reservation: Pick<typeof budgetReservations.$inferSelect, "id" | "agentId" | "periodStart"> | null;
    runId?: string;
    personId?: string | null;
    credentialId: string | null;
    provider: string;
    model: string;
    usage: ModelUsage;
    reportedCost?: number;
  }) {
    const { agent, usage } = input;
    const pricedModel = isKnownModel(input.model) ? input.model : agent.model;
    // ponytail: OpenRouter may route to an upstream dearer than its listed price, so a call can spend past what it
    // reserved; the counter takes the reported cost. Its `provider.max_price` would cap the route.
    const cost = input.reportedCost ?? costNanoUsd(pricedModel, usage, now());
    const id = Bun.randomUUIDv7();
    const period = input.reservation?.periodStart ?? periodOf(now());
    const at = now().toISOString();
    const rows = rowsOf<{ spent: string | number; person_spent: string | number | null }>(
      await db.execute(sql`with d as (
          delete from ${budgetReservations} where id = ${input.reservation?.id ?? null}::uuid returning amount_nano_usd
        ), u as (
          insert into ${usageRecords} (id, org_id, agent_id, kind, run_id, credential_id, provider, model, requested_model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_nano_usd, partial, person_id, created_at)
          values (${id}::uuid, ${agent.orgId}::uuid, ${agent.id}::uuid, 'agent', ${input.runId ?? null}::uuid,
            ${input.credentialId}::uuid, ${input.provider}, ${input.model}, ${agent.model}, ${usage.inputTokens},
            ${usage.outputTokens}, ${usage.cacheReadTokens}, ${usage.cacheWriteTokens}, ${cost}, false,
            ${input.personId ?? null}, ${at}::timestamptz)
          returning id
        ), p as (
          insert into ${agentBudgetPeriods} (org_id, agent_id, period_start, spent_nano_usd, reserved_nano_usd, updated_at)
          values (${agent.orgId}::uuid, ${agent.id}::uuid, ${period}::date, ${cost}, 0, now())
          on conflict (agent_id, period_start) do update set
            spent_nano_usd = ${agentBudgetPeriods}.spent_nano_usd + excluded.spent_nano_usd,
            reserved_nano_usd = greatest(0, ${agentBudgetPeriods}.reserved_nano_usd - coalesce((select amount_nano_usd from d), 0)),
            updated_at = now()
          returning spent_nano_usd
        ), member as (
          -- The person's month must never fail this statement and lose the call's usage record. The key-share lock
          -- makes a removal racing this statement wait for it, and skips a membership already removed (even one the
          -- snapshot still shows), so the foreign key below always holds.
          select org_id, user_id from ${organizationMembers}
          where org_id = ${agent.orgId}::uuid and user_id = ${input.personId ?? null}::text and ${cost}::bigint > 0
          for key share
        ), m as (
          insert into ${personUsageMonths} (org_id, person_id, period_start, spent_nano_usd, updated_at)
          select org_id, user_id, ${periodOf(now())}::date, ${cost}::bigint, ${at}::timestamptz from member
          on conflict (org_id, person_id, period_start) do update set
            spent_nano_usd = ${personUsageMonths}.spent_nano_usd + excluded.spent_nano_usd,
            updated_at = excluded.updated_at
          returning spent_nano_usd
        )
        select (select spent_nano_usd from p) as spent, (select count(*) from u) as inserted,
          (select spent_nano_usd from m) as person_spent`),
    );
    const personSpent = rows[0]?.person_spent;
    return {
      record: { id, cost },
      spent: Number(rows[0]?.spent ?? cost),
      personSpent: personSpent === null || personSpent === undefined ? null : Number(personSpent),
    };
  }

  /** Tells the agent's owner when spend crosses 80% and 100% of the budget (once each per month). */
  async function checkThresholds(agent: Agent, spent: number, actual: number) {
    const budget = agent.monthlyBudgetNanoUsd;
    if (budget === null || budget <= 0 || !deps.onBudgetThreshold) return;
    const before = spent - actual;
    if (before < budget && spent >= budget) return budgetExhausted(agent, spent);
    if (before < budget * BUDGET_WARNING_RATIO && spent >= budget * BUDGET_WARNING_RATIO) {
      await deps.onBudgetThreshold({ agent, level: "warning", spentNanoUsd: spent, budgetNanoUsd: budget });
    }
  }

  /**
   * `budget.exhausted` once per agent and month, whether spend crossed the budget or a call was refused: the first
   * one inserts a finished outbox row whose dedupe key says so (never a job to run).
   */
  async function budgetExhausted(agent: Agent, spent: number) {
    const budget = agent.monthlyBudgetNanoUsd;
    if (budget === null || budget <= 0 || !deps.onBudgetThreshold) return;
    const [first] = await db
      .insert(schema.outbox)
      .values({
        orgId: agent.orgId,
        kind: "budget.exhausted",
        payload: { agentId: agent.id },
        status: "done",
        completedAt: now(),
        dedupeKey: `budget.exhausted:${agent.id}:${periodOf(now())}`,
      })
      .onConflictDoNothing()
      .returning({ id: schema.outbox.id });
    if (first) await deps.onBudgetThreshold({ agent, level: "exhausted", spentNanoUsd: spent, budgetNanoUsd: budget });
  }

  return {
    /**
     * Whether the agent's model brain can be called at all: its model is in
     * the catalog or is OpenRouter's, its provider is registered and a key would
     * resolve (its own, the org's default, or the platform's), in `resolveKey`'s
     * order. OpenRouter's list is checked by the call (`infoFor`): no list is an
     * outage it waits out, and a model it stopped listing fails with words of its
     * own, neither of them "no AI". Used by the computer brains' fallback
     * (ADR 0032 §5 "Fallback, by what exists") and the AI status (`ai-status.ts`).
     * No call is made and no key is decrypted: a page load must not unwrap every
     * key (a network call per key with a KMS wrapper).
     */
    async hasModelCredential(agent: Pick<Agent, "orgId" | "model" | "credentialId">): Promise<boolean> {
      const provider = modelProvider(agent.model);
      if (!provider || !deps.providers[provider]) return false;
      const usable = async (id: string) => (await usableCredentialRow(db, agent.orgId, id))?.provider === provider;
      try {
        const own = pinnedKey(agent.model) ?? agent.credentialId;
        if (own) return await usable(own);
        const defaultId = await orgDefaultCredentialId(agent.orgId, provider);
        if (defaultId && (await usable(defaultId))) return true;
        const platform = deps.platformCredentials;
        return platform.available
          ? await platform.available(agent.orgId, provider)
          : (await platform.resolve(agent.orgId, provider)) !== null;
      } catch {
        return false;
      }
    },

    /** An agent's model call (runs). Streams deltas through `onDelta`. */
    async stream(call: GatewayCall): Promise<GatewayResult> {
      await assertCanWork(db, call.orgId, call.agentId);
      const row =
        call.agent && call.agent.id === call.agentId && call.agent.orgId === call.orgId
          ? call.agent
          : await getAgent(db, call.orgId, call.agentId);
      if (!row || row.archivedAt) throw new NotFoundError("Agent not found");
      // Every agent has a budget: its own, else the organization's default.
      const agent = await withEffectiveBudget(db, row);
      const providerId = modelProvider(agent.model);
      if (!providerId) throw new ValidationError(`Model ${agent.model} is not in the catalog`);
      const provider = providerFor(providerId);
      const key = await agentKey(agent, providerId);
      const info = await infoFor(agent.orgId, agent.model);

      const request: ModelRequest = {
        model: agent.model,
        system: call.system,
        messages: call.messages,
        maxTokens: capOf(call.maxTokens, info),
        tools: call.tools,
        ...(call.effort ? { effort: call.effort } : {}),
        ...(call.cacheTtl ? { cacheTtl: call.cacheTtl } : {}),
        ...(call.notes ? { notes: call.notes } : {}),
        signal: call.signal,
      };
      // Conservative prompt estimate (3 chars/token) so the reservation is an upper bound in practice.
      const promptTokens = Math.ceil(promptChars(request) / 3);
      // Only Claude's own API is asked for (and bills) 1-hour writes at our catalog prices; OpenRouter reports its cost.
      const longCache = request.cacheTtl === "1h" && providerId === "anthropic";
      // ponytail: the person's month is checked, not reserved, so calls in flight together can pass the limit by
      // one step each (as a plan's can, ADR 0141); a reservation like the agent's would close it.
      const personId = call.personId ?? null;
      if (personId) await assertPersonUnderLimit(db, agent.orgId, personId, now());
      const { reservation, maxTokens } = await reserve(
        agent,
        agent.model,
        promptTokens,
        request.maxTokens,
        longCache,
      ).catch(async (error: unknown) => {
        // The refusal itself is when the budget ran out for the owner (spend rarely crosses it on a call).
        if (error instanceof BudgetExceededError && !error.byReservations)
          await budgetExhausted(agent, error.spentNanoUsd).catch(() => {});
        throw error;
      });
      request.maxTokens = maxTokens;

      let result: ModelResult;
      try {
        result = await provider.stream(request, {
          apiKey: key.apiKey,
          workspaceId: key.workspaceId,
          organization: key.organization,
          project: key.project,
          endpoint: key.endpoint,
          ...(call.session ? { session: call.session } : {}),
          onDelta: call.onDelta,
        });
      } catch (error) {
        const usage = error instanceof ProviderError ? await partialUsage(error, provider, request, key) : null;
        let actual = 0;
        await db.transaction(async (tx) => {
          if (usage) {
            const record = await recordUsage(tx, {
              orgId: call.orgId,
              agentId: agent.id,
              kind: "agent",
              runId: call.runId,
              personId,
              credentialId: key.credentialId,
              provider: providerId,
              model: agent.model,
              requestedModel: agent.model,
              usage,
              partial: true,
            });
            actual = record.cost;
          }
          await settle(tx, reservation, actual, agent);
        });
        if (personId && usage)
          await addPersonSpend(db, { orgId: agent.orgId, personId, amountNanoUsd: actual, at: now() });
        throw masked(error, label(providerId), key);
      }

      const { record, spent, personSpent } = await settleCall({
        agent,
        reservation,
        runId: call.runId,
        personId,
        credentialId: key.credentialId,
        provider: providerId,
        model: result.model,
        usage: result.usage,
        reportedCost: result.costNanoUsd,
      });
      await checkThresholds(agent, spent, record.cost);
      if (personId && personSpent !== null)
        await personSpendAdded(
          db,
          { orgId: agent.orgId, personId, amountNanoUsd: record.cost, at: now() },
          personSpent,
        );
      const refused = result.thinking?.refused;
      return {
        ...result,
        // The refusal that sent the call again without its thinking: a provider's words, masked like its errors.
        ...(refused ? { thinking: { ...result.thinking, refused: withoutKey(refused, key.apiKey) } } : {}),
        usageRecordId: record.id,
        costNanoUsd: record.cost,
        maxTokens,
      };
    },

    /**
     * Usage of a non-model service called for an org (e.g. the Jev router):
     * recorded like every call, with its kind and provider, billed to the server's own key (`platform`).
     */
    async recordExternalUsage(input: {
      orgId: string;
      /** The agent and run the call was for (recorded, not billed to its budget). */
      agentId?: string | null;
      runId?: string;
      /** `agent`: a tool's own service for an agent's run (web search), never billed to its budget. */
      kind: "router" | "agent";
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costNanoUsd: number;
    }) {
      const [row] = await db
        .insert(usageRecords)
        .values({
          orgId: input.orgId,
          agentId: input.agentId ?? null,
          runId: input.runId,
          kind: input.kind,
          credentialId: null,
          provider: input.provider,
          model: input.model,
          requestedModel: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          costNanoUsd: input.costNanoUsd,
          billedTo: "platform",
          createdAt: now(),
        })
        .returning({ id: usageRecords.id });
      return row?.id ?? null;
    },

    /** Whether embeddings are available (else search falls back to full-text only). */
    hasEmbeddings: () => deps.embeddings !== undefined,

    /**
     * Embeds texts for the organization's search index (kind `embedding`, no agent), within a timeout: a query's is
     * short, a run waits on it. Null when no embedding provider is configured, when none of `kinds` gets vectors (the
     * kinds the texts are, or that a query searches; absent: any), or on a workspace that may not work. Throws when
     * the provider fails, and callers go on with words alone; the failure that makes `EMBED_FAILURES_REPORTED` in a
     * row is reported.
     */
    async embed(call: {
      orgId: string;
      texts: string[];
      inputType: "document" | "query";
      kinds?: readonly SearchKind[];
    }) {
      const embeddings = deps.embeddings;
      if (!embeddings || call.texts.length === 0) return null;
      const embedded = embeddings.kinds;
      const wanted = call.kinds?.length ? call.kinds : embedded;
      if (embedded && !wanted?.some((k) => embedded.includes(k))) return null;
      // Null, not a refusal: people on a hold still read and search, with full text alone.
      if (await standingRefusal(db, call.orgId)) return null;
      const { provider, apiKey } = embeddings;
      const timeoutMs =
        call.inputType === "query" ? (embeddings.queryTimeoutMs ?? EMBED_QUERY_TIMEOUT_MS) : EMBED_DOCUMENT_TIMEOUT_MS;
      let result: EmbeddingResult;
      try {
        result = await provider.embed(call.texts, {
          apiKey,
          inputType: call.inputType,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (++embedFailures === EMBED_FAILURES_REPORTED) {
          try {
            deps.errors?.capture(error, {
              cause: "embeddings",
              provider: provider.id,
              model: provider.model,
              input_type: call.inputType,
            });
          } catch {
            // A report that can't be made never fails a search.
          }
        }
        throw error;
      }
      embedFailures = 0;
      const cost = embeddingCostNanoUsd(result.model, result.tokens);
      await db.insert(usageRecords).values({
        orgId: call.orgId,
        agentId: null,
        kind: "embedding",
        credentialId: null,
        provider: provider.id,
        model: result.model,
        requestedModel: provider.model,
        inputTokens: result.tokens,
        outputTokens: 0,
        costNanoUsd: cost,
        createdAt: now(),
      });
      return result;
    },

    /**
     * One cheap real call with a key that isn't saved yet (or was just changed), so "connected" is never a guess. A
     * held workspace calls no model: its key stays unchecked. What the call used is recorded once the key has its row
     * (`record`), as a `summary` call of the organization.
     */
    async verifyKey(input: KeyToVerify): Promise<KeyCheck> {
      const provider = deps.providers[input.provider];
      if (!provider || (await standingRefusal(db, input.orgId))) return { state: "unchecked" };
      if (input.provider === "openrouter") await ensureOpenRouterModels().catch(() => {});
      const request = keyCheckRequest(input.provider, AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS));
      if (!request) return { state: "unchecked" };
      try {
        const result = await provider.stream(request, { ...input.key, onDelta: () => {} });
        return {
          state: "ok",
          record: async (credentialId) => {
            await recordUsage(db, {
              orgId: input.orgId,
              agentId: null,
              kind: "summary",
              credentialId,
              provider: input.provider,
              model: result.model,
              requestedModel: request.model,
              usage: result.usage,
              reportedCost: result.costNanoUsd,
              partial: false,
            });
          },
        };
      } catch (error) {
        const refusal = error instanceof ProviderError ? keyRefusalOf(error) : null;
        if (!refusal || !(error instanceof ProviderError)) return { state: "unchecked" };
        return { state: "refused", refusal, said: withoutKey(keyFailureWords(error.message), input.key.apiKey) };
      }
    },

    /** `verifyKey` on a stored key; null when the org has no such key. The key stays here, only the result leaves. */
    async verifyStoredKey(orgId: string, credentialId: string) {
      const credential = await decryptCredential(db, deps.keyWrappers, orgId, credentialId);
      if (!credential) return null;
      const { provider, apiKey, workspaceId, options } = credential;
      if (provider === "custom") return { provider, result: { state: "unchecked" } as KeyCheck };
      const key = {
        apiKey,
        ...(workspaceId ? { workspaceId } : {}),
        ...(options?.organization ? { organization: options.organization } : {}),
        ...(options?.project ? { project: options.project } : {}),
      };
      return { provider, result: await this.verifyKey({ orgId, provider, key }) };
    },

    /** A call for the organization (router, summaries). Not streamed to anyone; no agent budget. */
    async complete(call: OrgCall): Promise<GatewayResult> {
      await assertCanWork(db, call.orgId);
      const providerId = modelProvider(call.model);
      if (!providerId) throw new ValidationError(`Model ${call.model} is not in the catalog`);
      const provider = providerFor(providerId);
      const key = await orgKey(call.orgId, providerId, call.model);
      const info = await infoFor(call.orgId, call.model);
      const request: ModelRequest = {
        model: call.model,
        system: call.system,
        messages: call.messages,
        maxTokens: capOf(call.maxTokens, info),
        ...(call.tools ? { tools: call.tools } : {}),
        outputSchema: call.outputSchema,
        effort: call.effort,
        signal: call.signal,
      };
      const base = {
        orgId: call.orgId,
        agentId: call.agentId ?? null,
        kind: call.kind,
        runId: call.runId,
        credentialId: key.credentialId,
        provider: providerId,
        requestedModel: call.model,
      };
      let result: ModelResult;
      try {
        result = await provider.stream(request, {
          apiKey: key.apiKey,
          workspaceId: key.workspaceId,
          endpoint: key.endpoint,
          onDelta: () => {},
        });
      } catch (error) {
        const usage = error instanceof ProviderError ? await partialUsage(error, provider, request, key) : null;
        if (usage) await recordUsage(db, { ...base, model: call.model, usage, partial: true });
        throw masked(error, label(providerId), key);
      }
      const record = await recordUsage(db, {
        ...base,
        model: result.model,
        usage: result.usage,
        reportedCost: result.costNanoUsd,
        partial: false,
      });
      return { ...result, usageRecordId: record.id, costNanoUsd: record.cost, maxTokens: request.maxTokens };
    },
  };
}

export type ModelGateway = ReturnType<typeof createModelGateway>;

/** Reserved and spent amounts of an agent this month (from the gateway's counter). */
export async function agentBudgetState(db: Database, orgId: string, agentId: string, at = new Date()) {
  const [row] = await db
    .select()
    .from(agentBudgetPeriods)
    .where(
      and(
        eq(agentBudgetPeriods.orgId, orgId),
        eq(agentBudgetPeriods.agentId, agentId),
        gte(agentBudgetPeriods.periodStart, periodOf(at)),
      ),
    );
  return { spentNanoUsd: row?.spentNanoUsd ?? 0, reservedNanoUsd: row?.reservedNanoUsd ?? 0 };
}

/**
 * Budget hook that tells the agent's owner over the WebSocket
 * (`budget.warning` / `budget.exhausted`); an agent without an owner tells
 * the organization's admins.
 */
export function notifyOwnerOnBudget(pubsub: PubSub, db?: Database): NonNullable<ModelGatewayDeps["onBudgetThreshold"]> {
  return async ({ agent, level, spentNanoUsd, budgetNanoUsd }) => {
    const recipients = agent.ownerUserId ? [agent.ownerUserId] : db ? await adminIds(db, agent.orgId) : [];
    for (const userId of recipients) {
      // A percentage only: owners who aren't admins never see money.
      await publishUserEvent(pubsub, agent.orgId, userId, {
        type: `budget.${level}`,
        agentId: agent.id,
        percent: budgetPercent(spentNanoUsd, budgetNanoUsd),
      });
    }
  };
}

/**
 * Who in an organization may `permission` (ADR 0085), owners included: by default who manages agents, who
 * decides when an agent has no owner.
 */
export async function adminIds(db: Database, orgId: string, permission: RolePermission = "manage_agents") {
  const rows = await db
    .select({ userId: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(
      and(eq(schema.organizationMembers.orgId, orgId), maySql(orgId, schema.organizationMembers.userId, permission)),
    );
  return rows.map((r) => r.userId);
}

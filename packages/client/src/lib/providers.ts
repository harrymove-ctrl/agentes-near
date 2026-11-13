import type { TFunction } from "i18next";
import type { AiStatus, Credential, Model } from "../api/types";

interface ProviderEntry {
  id: string;
  label: string;
  /** How its keys start, as the key field's example; none where the provider publishes no prefix. */
  placeholder?: string;
  /** What its keys look like: only to catch paste mistakes (loose where the provider publishes no format). */
  pattern: RegExp;
  /** Where the provider hands out keys. */
  site: string;
  /** Where credit is added at the provider, where it has a page of its own for that. */
  credit?: string;
  /** It also sells coding plans, whose keys only work in coding tools. */
  plans?: boolean;
  /** Its name is masculine in Portuguese ("do Claude", "do Gemini"); the others are feminine ("da OpenAI"). */
  masculine?: boolean;
  /** Its free tier lets the provider use what is sent: billing should be on. */
  billing?: boolean;
  /** It passes what is sent on to other providers, as the account's privacy settings at it allow. */
  privacy?: boolean;
}

/**
 * Model providers the workspace can bring a key for, the most used first, the same ids as the backend catalog
 * (`packages/providers/src/catalog.ts`). The server validates keys for real.
 */
export const PROVIDERS = [
  {
    id: "anthropic",
    label: "Claude",
    placeholder: "sk-ant-…",
    pattern: /^sk-ant-[A-Za-z0-9_-]{16,}$/,
    site: "platform.claude.com/settings/keys",
    credit: "platform.claude.com/settings/billing",
    masculine: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "sk-…",
    pattern: /^sk-(?!ant-|or-)[A-Za-z0-9_-]{16,}$/,
    site: "platform.openai.com/api-keys",
    credit: "platform.openai.com/settings/organization/billing/overview",
  },
  {
    id: "gemini",
    label: "Gemini",
    placeholder: "AQ.…",
    // AI Studio's keys: "AQ." since 2026-05-28 (bound to a service account), "AIza" before.
    pattern: /^(?:AQ\.[A-Za-z0-9._-]{20,}|AIza[A-Za-z0-9_-]{30,})$/,
    site: "aistudio.google.com/api-keys",
    masculine: true,
    billing: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    placeholder: "sk-or-v1-…",
    pattern: /^sk-or-v\d+-[A-Za-z0-9]{32,}$/,
    site: "openrouter.ai/keys",
    credit: "openrouter.ai/settings/credits",
    privacy: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    placeholder: "sk-…",
    pattern: /^sk-[A-Za-z0-9]{16,}$/,
    site: "platform.deepseek.com/api_keys",
    credit: "platform.deepseek.com/top_up",
  },
  {
    id: "moonshot",
    label: "Kimi",
    placeholder: "sk-…",
    pattern: /^sk-[A-Za-z0-9]{16,}$/,
    site: "platform.kimi.ai/console/api-keys",
    plans: true,
  },
  {
    id: "zai",
    label: "Z.ai",
    pattern: /^(?!sk-|AQ\.|AIza)[A-Za-z0-9._-]{16,}$/,
    site: "z.ai/manage-apikey/apikey-list",
    plans: true,
  },
  {
    id: "minimax",
    label: "MiniMax",
    // `sk-cp-` keys are its coding plan's.
    pattern: /^(?!sk-ant-|sk-cp-|sk-or-|AQ\.|AIza)[A-Za-z0-9._-]{16,}$/,
    site: "platform.minimax.io/user-center/basic-information/interface-key",
    plans: true,
  },
] as const satisfies readonly ProviderEntry[];

export type ProviderId = (typeof PROVIDERS)[number]["id"];

/**
 * A provider's entry by its id, or by its label (run errors name the provider by label); undefined for one
 * this client doesn't know (it then shows what it was given).
 */
export const providerOf = (id: string): ProviderEntry | undefined =>
  PROVIDERS.find((p) => p.id === id || p.label === id);
export const providerLabel = (id: string) => providerOf(id)?.label ?? id;
/**
 * A saved key's line under its name: "Claude · termina em 1a2b", or only "termina em 1a2b" when its name is already the
 * provider's (a key named after nothing else, as most are), never "Claude" over "Claude · …".
 */
export const keyLine = (t: TFunction, key: Pick<Credential, "label" | "provider" | "keyHint">) =>
  keyNamedAfterProvider(key)
    ? t("vault.item.endsIn", { hint: key.keyHint })
    : t("newAgent.otherKeyDesc", { provider: providerLabel(key.provider), hint: key.keyHint });
/** A key whose name is only its provider's ("Claude"): a line under it needn't say the provider again. */
export const keyNamedAfterProvider = (key: Pick<Credential, "label" | "provider">) =>
  key.label.trim().toLocaleLowerCase() === providerLabel(key.provider).toLocaleLowerCase();
export const isProviderId = (id: string): id is ProviderId => PROVIDERS.some((p) => p.id === id);
export const keyLooksValid = (provider: ProviderId, key: string) =>
  (providerOf(provider)?.pattern ?? /.{8,}/).test(key.trim());

/**
 * The providers whose keys look like this one. Often several (any `sk-` key could be OpenAI's, DeepSeek's,
 * Kimi's or MiniMax's), so the person says which instead of the app guessing.
 */
export const providersForKey = (key: string) => PROVIDERS.filter((p) => p.pattern.test(key.trim()));

/** Whose a pasted key is: the one provider whose keys look like it, else the one asked for, else the first that fits. */
export function providerGuess(key: string | undefined, asked?: string): ProviderId {
  const fits = key ? providersForKey(key) : [];
  const guess = (fits.length === 1 ? fits[0]?.id : undefined) ?? asked ?? fits[0]?.id;
  return guess && isProviderId(guess) ? guess : "anthropic";
}

/**
 * The ⓘ on the key panel's first step, web and phone: for a maker that also sells coding plans, where a plan's key
 * goes; for one whose free tier may use what is sent, to turn on billing; for a router, who may keep what is sent.
 */
export const keyStepHint = (p: ProviderEntry) =>
  p.plans
    ? "connectAi.key.notPlan"
    : p.billing
      ? "connectAi.key.billing"
      : p.privacy
        ? "connectAi.key.privacy"
        : undefined;

/** Live keys per provider. */
export function providersWithKeys(credentials: Credential[]) {
  return new Set(credentials.filter((c) => !c.revokedAt).map((c) => c.provider as string));
}

export interface ModelChoice {
  model: Model;
  available: boolean;
}

/**
 * Models grouped by provider, each marked usable or not. Uses `model.available`
 * when the server sends it (expected on `GET …/models`); until then a model is
 * usable when the workspace has a key for its provider, or, for Claude, when the
 * platform key is on (the only one a server offers). A long list's models the
 * workspace can't use are left out: only its good picks show, to say a key opens them.
 */
export function modelChoices(models: Model[], credentials: Credential[], platform: boolean) {
  const withKey = providersWithKeys(credentials);
  const live = new Set(credentials.filter((c) => !c.revokedAt).map((c) => c.id));
  const groups = new Map<string, ModelChoice[]>();
  for (const model of models) {
    // A workspace endpoint's models (ADR 0146), under its name: only this workspace's, only while its key lives.
    const group = model.endpoint?.name ?? model.provider;
    const available =
      model.available ??
      (model.endpoint
        ? live.has(model.endpoint.credentialId)
        : withKey.has(model.provider) || (platform && model.provider === "anthropic"));
    if ((model.pick === false || model.endpoint) && !available) continue;
    groups.set(group, [...(groups.get(group) ?? []), { model, available }]);
  }
  return [...groups.entries()];
}

/** The ids of the models `modelChoices` marks usable. */
export const usableModels = (choices: ReturnType<typeof modelChoices>) =>
  new Set(choices.flatMap(([, list]) => list.filter((c) => c.available).map((c) => c.model.id)));

/**
 * "Automático": the value an agent's model, a computer brain's model or
 * its effort holds when each run picks them (the server's `auto-model.ts`).
 */
export const AUTO = "auto";
export const isAuto = (value: string | null | undefined) => value === AUTO;

/** A workspace key runs this agent model: Automático (it follows the key), or one of the key's provider's. */
export const keyRuns = (
  key: Pick<Credential, "id" | "provider">,
  model: string | undefined,
  models: readonly Model[],
) =>
  isAuto(model) ||
  models.some(
    (m) => m.id === model && m.provider === key.provider && (!m.endpoint || m.endpoint.credentialId === key.id),
  );

/**
 * Whose API an agent's model runs on: the model's provider; for Automático, the one provider the workspace can use
 * (undefined when it can use several, or the model is unknown).
 */
export function apiProviderOf(model: string | null | undefined, models: readonly Model[]): string | undefined {
  if (!isAuto(model)) return models.find((m) => m.id === model)?.provider;
  const usable = new Set(models.filter((m) => m.available).map((m) => m.provider));
  return usable.size === 1 ? [...usable][0] : undefined;
}

/** The maker of the key an agent on Automático thinks with, as the AI status says (none while it can't think). */
export const autoMakerOf = (
  status: { agents: readonly Pick<AiStatus["agents"][number], "agentId" | "provider">[] } | undefined,
  agentId: string,
) => status?.agents.find((a) => a.agentId === agentId)?.provider;

/**
 * What an agent on an API key thinks with, by name: its model ("Sonnet 5.5"), or on Automático the maker of the key it
 * runs on (`autoMakerOf`: "Claude"), the way the right hand's panel names its key. "Automático" only while no key is
 * known. `label`: the model's label in the catalog.
 */
export const apiModelName = (t: TFunction, model: string, label: string | undefined, maker: string | undefined) =>
  isAuto(model) ? (maker ? providerLabel(maker) : t("brain.auto.label")) : (label ?? model);

/** Automático's sizes and the server's own tier rule (`modelForTier`): a tier's default reads as the one that runs. */
export { MODEL_TIERS, nearestTier } from "@agenteschat/providers/catalog";

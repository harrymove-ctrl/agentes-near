import type { Adapters } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import type { ModelProvider } from "@agenteschat/providers";
import type { OpenAPIHono } from "@hono/zod-openapi";

/**
 * Which build of agentes.chat is running.
 * - `selfhost`: the open-source server, started by `apps/server/src/main.ts`.
 * - `cloud`: our hosted service: this same server, with Cloud-only behavior
 *   switched on by environment variables (ADR 0002 §5).
 */
export type Edition = "selfhost" | "cloud";

export interface ModuleContext {
  config: Config;
  db: Database;
  edition: Edition;
  version: string;
  /** Adapters after every module's overrides were applied. */
  adapters: Adapters;
}

/** What a module may replace. Later modules win over earlier ones. */
export interface AdapterOverrides extends Partial<Adapters> {
  /** Model providers by id (e.g. `anthropic`), merged over the core ones. */
  modelProviders?: Record<string, ModelProvider>;
  /**
   * Vault sources by kind (ADR 0144), merged over the core ones: a module adds a source or replaces one of the same
   * kind. null turns every external source off.
   */
  vaultSources?: Adapters["vaultSources"];
}

/**
 * Extension point that lets optional modules (Cloud-only behavior among them)
 * add behaviour without the core ever importing them. The core only knows
 * this interface. Modules are public code: outside contributions come in under
 * the AGPL with no contributor license agreement, so nothing private may run
 * in this process (ADR 0002 §5).
 *
 * Rule enforced by `bun run check:boundaries`: nothing under `apps/` or
 * `packages/` may import `@agenteschat/cloud` or `@agenteschat/ee`.
 */
export interface AgentesModule {
  /** Stable identifier, e.g. `cloud-billing`. Shown in logs and `/api/health`. */
  name: string;
  /**
   * Replace core adapters (search backend per org, pub/sub, presence, rate
   * limiter, key wrapping, platform credentials, model providers). Called once
   * at boot, before routes are registered.
   */
  adapters?(
    ctx: Omit<ModuleContext, "adapters"> & { defaults: Adapters },
  ): AdapterOverrides | Promise<AdapterOverrides>;
  /** Mount routes under `/api/...`. Runs once at startup, after migrations. */
  registerRoutes?(app: OpenAPIHono, ctx: ModuleContext): void;
  /** Called once after the server starts listening. */
  onStart?(ctx: ModuleContext): Promise<void> | void;
  /** Called on graceful shutdown. */
  onStop?(): Promise<void> | void;
}

/** Applies each module's overrides over the defaults, in order. */
export async function resolveAdapters(
  modules: AgentesModule[],
  ctx: Omit<ModuleContext, "adapters">,
  defaults: Adapters,
  defaultProviders: Record<string, ModelProvider>,
): Promise<{ adapters: Adapters; modelProviders: Record<string, ModelProvider>; overridden: string[] }> {
  let adapters = { ...defaults };
  let modelProviders = { ...defaultProviders };
  const overridden: string[] = [];
  for (const module of modules) {
    if (!module.adapters) continue;
    const {
      modelProviders: providers,
      vaultSources: sources,
      ...rest
    } = await module.adapters({ ...ctx, defaults: adapters });
    for (const key of Object.keys(rest)) overridden.push(`${module.name}:${key}`);
    adapters = { ...adapters, ...rest };
    if (providers) {
      for (const key of Object.keys(providers)) overridden.push(`${module.name}:modelProviders.${key}`);
      modelProviders = { ...modelProviders, ...providers };
    }
    if (sources === null) {
      overridden.push(`${module.name}:vaultSources`);
      adapters = { ...adapters, vaultSources: null };
    } else if (sources) {
      for (const kind of Object.keys(sources)) overridden.push(`${module.name}:vaultSources.${kind}`);
      adapters = { ...adapters, vaultSources: { ...adapters.vaultSources, ...sources } };
    }
  }
  return { adapters, modelProviders, overridden };
}

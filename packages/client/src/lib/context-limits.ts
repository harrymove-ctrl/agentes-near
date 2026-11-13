import { CONTEXT_LIMITS, type ContextLimit, contextLimitsFor } from "@agenteschat/providers/context-limits";

export * from "@agenteschat/providers/context-limits";

/** A context size as the apps write it, in every language: `200K`, `400K`, `1M`. */
export const contextSize = (tokens: number) =>
  tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`;

/** A coding plan's model id says a 1M window with Claude Code's `[1m]`; otherwise the catalog doesn't know it here. */
const planWindow = (modelId: string | undefined) => (modelId?.endsWith("[1m]") ? 1_000_000 : undefined);

/**
 * The limits "Configuração avançada" offers with a model: those under its window. "Automático" (or a model the
 * catalog doesn't know) may be any model of its line, so every limit; the smaller one wins at run time anyway.
 */
export function contextChoices(
  model: { contextWindow?: number; modelId?: string } | undefined,
): readonly ContextLimit[] {
  const window = model?.contextWindow ?? planWindow(model?.modelId);
  return window ? contextLimitsFor(window) : CONTEXT_LIMITS;
}

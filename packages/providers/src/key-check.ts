import { cheapModelOf } from "./catalog";
import type { ModelRequest, ProviderError } from "./types";

/** Why a key can't think, as a test call shows: the provider refused it, it has no credit, or it may not make calls. */
export type KeyRefusal = "invalid" | "no_credit" | "denied";

const NO_CREDIT =
  /no prepaid credit|insufficient[ _](?:credits?|quota|balance|funds)|credit balance|requires more credits|exceeded your current quota/i;
const BAD_KEY =
  /invalid (?:x-)?(?:provider )?api[ _-]?key|incorrect api key|api[ _]key[ _]not[ _]valid|api_key_invalid/i;

/**
 * What a failed test call says of the key, or null when it says nothing of it (a rate limit, an outage, a model this
 * key's project doesn't offer). Claude says no credit on a 400 and OpenAI on a 429, so the words come first.
 */
export function keyRefusalOf(error: Pick<ProviderError, "status" | "message">): KeyRefusal | null {
  if (error.status === 402 || NO_CREDIT.test(error.message)) return "no_credit";
  if (error.status === 401 || BAD_KEY.test(error.message)) return "invalid";
  return error.status === 403 && !/\bmodel/i.test(error.message) ? "denied" : null;
}

/** The provider's own words in a failure the adapters shaped as `what (status code): words`. */
export const keyFailureWords = (message: string) => /\): (.+)$/.exec(message)?.[1] ?? "";

/** The cheapest real call a key can make: enough for the provider to bill it, so no credit shows too. */
export function keyCheckRequest(provider: string, signal: AbortSignal): ModelRequest | null {
  const model = cheapModelOf(provider);
  if (!model) return null;
  return {
    model,
    system: "Answer with one word.",
    messages: [{ role: "user", content: "Say ok." }],
    maxTokens: 16,
    effort: "none",
    signal,
  };
}

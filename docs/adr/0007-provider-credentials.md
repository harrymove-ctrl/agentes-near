# 0007. Provider credentials and the Model Gateway

- Status: Accepted
- Date: 2026-10-14
- Bring-your-own keys in both editions; a platform key and KMS only on the Cloud.

## Decision

**Credentials** (`provider_credentials`) belong to the organization. Envelope encryption:

1. A fresh random 256-bit data key encrypts the API key (AES-256-GCM).
2. A `KeyWrapper` adapter wraps the data key. Core: `local:v1`, a key derived from `AGENTES_SECRET` (HKDF, purpose `provider-credentials-kek`). Cloud: a KMS module.
3. Both ciphertexts are bound to `provider-credential|<org_id>|<id>` as associated data: a row copied into another organization does not decrypt.
4. `kek_id` is stored per row; old wrappers stay usable for unwrapping (`legacyKeyWrappers`) during rotation.
5. Only `key_hint` (last 4 characters) is ever returned by the API. Data keys are zeroed after use.

**The Model Gateway** (`@agenteschat/engine` `createModelGateway`) is the only code that calls a model. For each call it:

1. loads the agent (org-scoped) and its model from `MODEL_CATALOG`;
2. **checks the budget before calling**: month-to-date spend of the agent (UTC calendar month, from `usage_records`) must be below `monthly_budget_nano_usd`, else `BudgetExceededError` and no call;
3. decrypts the agent's credential, or asks the `PlatformCredentials` adapter when the agent has none (core: none → `MissingCredentialError`);
4. streams through the `ModelProvider` interface (`@agenteschat/providers`);
5. writes a `usage_records` row with `org_id`, `agent_id`, `run_id`, credential, tokens (input, output, cache read/write) and cost.

**Providers.** `createAnthropicProvider` uses the official SDK's streaming (`client.beta.messages.stream` + `finalMessage()`), a cache breakpoint on the system prompt, and Anthropic's server-side refusal fallback (`fallbacks: "default"`) for models flagged in the catalog (Sonnet 5.5, Opus 5.5). Errors become `ProviderError { retryable }`. Tests use `createFakeProvider`.

**Prices** are integers in nano-USD per token in `MODEL_CATALOG` (Sonnet 5.5: $2 / $10 per MTok; Haiku 5.5: $0.10 / $0.50, long-context rates above 100K prompt tokens). Cost is computed with the model that actually answered (a fallback may differ) and stored, so history is never repriced.

## Consequences

- Keys never reach the client and never appear in logs; they live in memory only during a call.
- The budget check is not a reservation: concurrent runs of one agent can overshoot by up to one call each. A reservation (or `SELECT … FOR UPDATE` on a per-agent counter) is a follow-up if that matters.
- A call that fails mid-stream records no usage (the provider reports usage at the end). Accepted for now.
- Models outside the catalog are rejected at agent creation: every call must be priceable.

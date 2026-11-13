# 0012. Budget reservation, usage kinds and partial usage

- Status: Accepted
- Date: 2026-10-14
- Refines 0007: budget reservation, router usage, mid-stream failures.

## Context

0007 checked the monthly budget by summing `usage_records` before each call. Two concurrent runs of one agent could both pass the check and overshoot. Router calls have no agent, and a stream that failed midway recorded nothing although the provider billed it.

## Decision

**Reservation.** `agent_budget_periods (agent_id, period_start)` holds `spent_nano_usd` and `reserved_nano_usd` for a calendar month (UTC). Before an agent call the Model Gateway, in one transaction:

1. upserts the month's row (first row of a month starts from the recorded usage, so budgets set mid-month count earlier spend);
2. deletes this agent's expired reservations (a worker died mid-call; TTL 15 min, longer than any call we allow);
3. locks the row (`SELECT … FOR UPDATE`);
4. computes the worst-case cost: prompt tokens estimated at 3 characters/token, priced at the most expensive input rate (cache write), plus `maxTokens` at the output rate (long-context prices when the prompt may cross the threshold);
5. if the agent has a budget, shrinks `maxTokens` to what fits in `budget − spent − reserved`; below 256 output tokens (or nothing left) the call is refused with `BudgetExceededError` before any provider is contacted;
6. inserts a `budget_reservations` row and adds it to `reserved`.

After the call (success or failure) one transaction writes the usage record, deletes the reservation, subtracts it from `reserved` and adds the actual cost to `spent`. Concurrent runs serialize on the row lock, so the sum of open reservations plus spend never exceeds the budget. The counter is maintained for every agent call, budget or not, so setting a budget later is immediate. The prompt estimate is an upper bound in practice, not a proof; the settle step always records the real cost.

**Usage kinds.** `usage_records.agent_id` is nullable and `kind` is one of `agent | router | embedding | summary`. Org-level calls (`gateway.complete`, used by the router and summaries) carry `org_id`, `kind`, and optionally the agent they concern. They are billed to the organization's credential: `organization_settings.default_credential_id`, else the newest active credential of the provider, else the platform key (Cloud).

**Partial usage.** Providers attach `ProviderError.partial` when a stream dies midway: the input-token count from the start-of-stream event if it arrived, output tokens reported so far, and the characters received. The gateway fills gaps: the input count from the provider's count-tokens API, else a local estimate (4 characters/token); output tokens from the provider's count, else estimated from the received characters. The record is flagged `partial = true`, and the reservation settles to that cost.

**Provider neutrality.** The gateway and everything above it use only the neutral types of `@agenteschat/providers` (`ModelRequest`, `ModelResult`, `ContentBlock` with `tool_use` / `tool_result` / `opaque`, JSON-Schema `outputSchema`, an `effort` hint). `provider_credentials.provider` is text validated against `PROVIDERS`, so adding a provider (e.g. OpenAI) is a catalog entry plus an adapter, without a migration.

## Consequences

- A call near the end of a budget gets a smaller output cap instead of overshooting.
- `agentSpendThisMonth` (sum of records) and the counter agree because the gateway is the only writer of both.
- Prices live in `MODEL_CATALOG`; they were checked against the official list on 2026-10-14.

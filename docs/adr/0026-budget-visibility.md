# 0026. Every agent has a budget; only admins see money

- Status: Accepted. Superseded in part by ADR 0077 (2026-10-28): the sandbox's budget check before a command (no computer time is metered)
- Date: 2026-10-16
- Refines 0012 (budget reservation).

## Context

Every member saw dollars: the sidebar showed what their agents spent ("US$ 1.56 this month"), each agent reply carried `usage.costUsd`, and the agent page, routines, forum topics, the agent's computer and the 80%/100% alerts all showed amounts. Budgets were optional (`agents.monthly_budget_nano_usd` null = no cap). Members need to know how much of a budget is left, not what it cost: money is for whoever manages usage, so the product speaks in shares of a budget.

## Decision

**Every agent has a budget.** `organization_settings.default_agent_budget_nano_usd` (not null, default US$ 50) is the budget of every agent whose own budget is null. Admins set the default and can override any agent. `effectiveAgentBudget` / `withEffectiveBudget` (`packages/engine/src/usage.ts`) resolve it; the Model Gateway reserves against the effective budget on every agent call (0012's "no budget, no reservation" path is only defensive now), and so does the sandbox check. Changing the default needs no counter resync: counters hold spend, not the cap. The default is cached per org (`caches.orgs` key `{orgId}:agent-budget`), invalidated by `updateOrgSettings`.

**Percentages for everyone, money for `view_usage`.** `canViewCost` = the person has `view_usage` (owners and admins). The rule is enforced in the API, not only in the app:

- `GET …/overview` → `budgetUsedPercent`: this month's spend of the active agents over the sum of their effective budgets (the workspace's 100%). No `myAgentsSpendUsd`.
- Agent list and detail → `budgetUsedPercent`; `monthlyBudgetUsd` (and, in the detail, `defaultBudgetUsd` when the agent follows the default) only for admins.
- Message `usage` → model and tokens only. Runs → tokens only; run steps drop `costNanoUsd`.
- Routines → no budget fields (routine caps were removed on 2026-10-17, migration 0065: a routine runs on its agent's budget). Agent computer → no cost.
- `budget.warning` / `budget.exhausted` events carry `percent`; the email says "usou 80% do orçamento".
- Admins see amounts in one place: `GET …/usage/report` (Settings → Usage) adds `defaultAgentBudgetUsd` and, per agent, the effective `monthlyBudgetUsd`, `budgetIsDefault` and `budgetUsedPercent`. `GET/PATCH …/settings` carries `defaultAgentBudgetUsd` for admins.

Tokens stay visible: hiding them buys nothing.

## Consequences

- Agents that had no cap now stop at the workspace default; the default is generous on purpose and admins can raise it.
- `apps/server/test/cost-visibility.test.ts` fails if a member's response for the overview, agents, agent detail, settings, messages or routines mentions `usd` or `cost`.
- An org-level cap can sit on top later: the gateway would reserve against an org counter before the agent's, and members would still see percentages.

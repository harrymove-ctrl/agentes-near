# 0141. Usage per person and a monthly limit per person

- Status: Accepted (built: db, engine, server, the shared client, the web and the phone app)
- Date: 2026-11-03
- Extends: ADR 0012 (the Model Gateway's reservation), ADR 0026 (money only with `view_usage`), ADR 0053 (who is behind a run), ADR 0063 (plan usage and its API equivalent), ADR 0085 (roles)
- Code: db `packages/db/src/schema/runtime.ts` (`usage_records.person_id`, `person_usage_months`), `schema/agents.ts` (`organization_settings.person_limits`), migration `usage_per_person`; engine `person-usage.ts` (`personLimitsOf`, `resolveLimit`, `assertPersonUnderLimit`, `addPersonSpend`, `notifyPersonLimit`, `requestMoreUsage`, `raisePersonLimit`, `refuseMoreUsage`, `setPersonLimits`), `person-usage-report.ts` (`peopleUsage`, `personUsageDetail`, `peopleUsageCsv`, `liveWork`), `gateway.ts` (`GatewayCall.personId`), `brains/claude-code.ts` (`recordPlanUsage`), `executor.ts` (`failPersonLimit`), `runs.ts` (`PERSON_LIMIT`); server `routes/app/person-usage.ts`; client `lib/person-usage.ts`, `lib/action-cards.ts` (`personLimitCardOf`); web `components/PeopleUsage.tsx`; phone `features/usage/people.tsx`

## Context

A paying workspace with 15 people asked to see what each person does with the agents and how much they use, and to cap it per person. Every model call was already recorded per agent, and every run already knew the person behind it (ADR 0053), but nothing joined the two, and the only caps were per agent.

## Decision

### 1. The person behind each call

- `usage_records.person_id` (nullable, no foreign key: the history outlives a member who left; index on `(org_id, person_id, created_at)`) is a snapshot of the person behind the run at call time: `accountablePerson(runAuthority(run))`, the person who asked, else a routine's creator. Nobody for an agent's own work, the router, embeddings and summaries.
- The executor works it out once per turn and passes it to the brain (`BrainTurn.personId`): the model brain hands it to the gateway (`GatewayCall.personId`), a plan brain's turns record it with their tokens (`recordPlanUsage`).
- The team's right hand (ADR 0137) counts for nobody: it is the product's own help, onboarding first.

### 2. One unit: US$ a month

- `person_usage_months (org_id, person_id, period_start)` counts the person's month: the API cost of each call, and for a plan's turn the API price of its tokens (`apiNano`, ADR 0063). One unit for everything, since a request count says nothing about cost.
- Limits live in `organization_settings.person_limits`: the workspace default, a limit per role, a limit per person (an exception), what happens at the limit (`block` by default, or `notify`) and the 80% notice (on). Off by default: no default, no role and no person has one until an admin sets it.
- The rule (`resolveLimit`): owners have none; a raise for this month wins; then the person's own; then the highest of their roles' (a role with none means none); then the default.
- A raise (`raised_limit_nano_usd`) holds for its month only; the next month starts from the settings again.

### 3. Enforced where the money is spent

- The Model Gateway checks the person's month before each call made for them (`assertPersonUnderLimit`), next to the agent's reservation, and adds the call's cost after it (`addPersonSpend`). A plan brain's turn is checked by the executor before it starts (no gateway call), and its tokens are added when recorded.
- The person's month is checked, not reserved: calls in flight together can pass the limit by one step each, as a plan's estimate already can. A reservation like the agent's (ADR 0012) would close it if it matters.
- While no limit exists anywhere, the gateway reads only the cached settings for a person.

### 4. At the limit

- The run ends with `person_limit` and, in a conversation, the agent posts a card in place of an answer (`meta.actionCard.kind = 'person_limit'`): "Você chegou ao seu limite de uso deste mês", when it renews, `Pedir mais` and `Ver meu uso`, for the person the limit was checked for (`PersonLimitError.personId`); anyone else in the channel reads who reached it. Its text, which the phone and previews show, says "Quem pediu chegou ao limite de uso deste mês", so a reader who isn't that person never reads it as their own. Nobody is notified of the failure: the card is the news. A routine's run fails with the same code, which Rotinas words.
- The run ends rather than waiting for a raise like a budget's wait: a wait of its own would touch every usage wait (`USAGE_WAIT_CODES`) for a case the card already explains. The person asks again once raised.
- `Pedir mais` notifies who may decide (`configure` and `view_usage`) with a waiting `usage_limit` notification: the limit, this month's requests, the agent most used and where the limit comes from, and `Aumentar para US$ X este mês` (half again, in whole dollars) or `Recusar`, inline on the web and the phone. Asking again while nobody answered tells nobody again. A raise or a refusal resolves it, tells the person (in percentages) and moves their cards to "pode continuar" or "recusado". Audited as `usage.limit_raised`, `usage.limit_refused`.
- At 80% the person hears it (percentages only); at 100% who decides hears it; with `notify`, nothing stops and the person hears they are past it.
- Each `usage_limit` notice has its own push words in the 14 languages (`push/messages`): the person's in percentages, who decides with the person's name.

### 5. What admins see, and what they never see

- Settings › Orçamento e uso gets tabs: Resumo (what was there) and Pessoas for `view_usage` (each person's use in a period, requests, the agents used most, the month against the limit, the agents they look after and created, what they do now), with a person's drawer (limit, use per day by agent, agents, recent work, agents created, a link to Auditoria), Limites, a CSV (one row per person per day, never a message's text) and "Agora" (the runs at work now).
- Admins never see what a DM says, person to person or person to agent: a DM's work shows as a count and its cost, never a title. A private channel the viewer isn't in shows as "num canal privado"; a public one is named, since they may join and read it. A name in the CSV that starts with `= + - @` gets a leading `'`, so a spreadsheet never runs it as a formula. The agents' tool actions stay in Auditoria, as they are the company's business. There is no switch to read DMs; adding one later would be a published policy with a banner for everyone, never a silent setting.
- Members see only their own month, as Seu uso, in percentages of their limit, never money (ADR 0026).
- Who created an agent comes from the audit log's `agent.created`, so agents made before have no creator.

## Consequences

- One column and one counter answer "what does each person use", and the limit rides the gateway's existing step before each call.
- The live list polls every 15 s while Pessoas is open; the runs' realtime events could drive it instead.
- Plan usage is an estimate at API prices, and a person can pass their limit by one step.

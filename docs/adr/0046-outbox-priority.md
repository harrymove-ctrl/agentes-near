# 0046. Outbox priority: a person waiting goes first

- Status: Proposed
- Date: 2026-10-21
- Extends: ADR 0005 (Postgres outbox)

## Context

`claimJobs` (`packages/engine/src/outbox.ts`) takes due jobs ordered only by `next_attempt_at`, up to 20 in flight per process (`maxInFlight`). Every kind of job competes equally:

- a person's message (`agent_run.execute` from a mention, DM or the router);
- an agent's message, a consultation, an `ask_user` answer;
- background load: `routine.run` (up to 100 due routines per 30 s tick), reflections, consolidation, `search.index`, summaries, push, e-mail polling.

A routine firing at 09:00 in thirty agents fills every slot, and the message a person just sent waits behind them. Nothing measures that wait today.

## Decision

### A priority per job

New column `outbox.priority smallint not null default 2`:

| Priority | Meaning | Jobs |
| --- | --- | --- |
| 0 | A person is waiting | runs woken by a person's message, an approval decision, an `ask_user` answer, "Continuar" |
| 1 | Agent to agent | runs woken by an agent's message, `ask_agent`, `tell_agent` (ADR 0048), a background work finishing (ADR 0045), a routine's handoff (ADR 0047) |
| 2 | Background | `routine.run`, webhooks, reflections, consolidation, indexing, summaries, push, mail |

`enqueue` takes `priority`. `createAgentRuns` derives it from what woke the run: the trigger message's author (person or agent) and the trigger meta (routine, consultation). Jobs without a priority stay at 2.

### Claim order

`order by priority, next_attempt_at` with a partial index on `(priority, next_attempt_at) where status = 'pending'`.

### Reserved slots

The pump keeps 4 of its 20 slots for priority 0. When 16 jobs of priority 1–2 are in flight, the claim asks only for priority 0 (`where priority = 0`). A burst of background work never takes the last slots.

### Aging

At claim time, the effective priority is `greatest(0, priority - floor(extract(epoch from now() - created_at) / 120))`: a job loses one level every 2 minutes it waits. Background work is delayed under load, never starved.

### Measure

- `queue_wait_ms` (claim time − `created_at`) per job, logged by the pump with kind and priority.
- On `agent_run.execute`, also stored on the run's `context` step, so the run trail shows how long the person waited before the agent even started.
- p95 of priority 0 above 2 s is a warning in the logs.

## Consequences

- One migration (column + index). `enqueue` callers that matter set the priority; the rest default to background.
- Under normal load nothing changes: there are free slots and every job is claimed at once.
- Not in scope: a per-agent queue across conversations. Different conversations of the same agent keep running in parallel, as today.

# 0127. Agent work analytics for the operator

- Status: Accepted (built: the operator API's reads, for an operator's console to call)
- Date: 2026-11-02
- Amends: ADR 0056 §4 (two analytics reads)
- Extends: ADR 0103 (the analytics reads), ADR 0063 (the plan card's API price)
- Code: `packages/engine/src/work-analytics.ts`, `apps/server/src/operator/analytics.ts`, migration `0181_work_analytics_indexes`

## Context

A workspace with 15 agents on one 8 GB computer ran about 800 Claude Code turns in a day, most of them agents answering agents, each around 46K cache-write, 466K cache-read and 3K output tokens. A hundred turns failed `computer_busy` after waiting 30 minutes for room, and a person's delegated request waited about two hours. Its plan ran out. Nothing showed the people who run the instance such a workspace coming, or whether a fix worked: the analytics reads counted connectors only, and the usage views are per workspace, for its own people.

## Decision

Two reads under ADR 0056's token, from what is already stored (`agent_runs`, `agent_run_steps`, `messages`, `usage_records`), nothing new written:

- `GET /analytics/work?from&to`: every workspace, with a row per workspace (`workspaces`).
- `GET /analytics/work/orgs/{orgId}?from&to`: one workspace, with a row per agent (`agents`).

`from` and `to` are UTC days, at most 90 (`400 analytics.range`). Up to 2 days the series is by hour (`bucket: "hour"`, `at` `YYYY-MM-DDTHH`), else by day. Each answer has `totals`, `series` and its rows (most tokens first, at most 500, then `more`), each with the same parts:

- **Turns** (runs created in the dates), by origin: `routine` (its trigger carries a routine: its run, its reminder, its report), `longWork` (long work and other background runs), `agent` (the trigger is another agent's message, or the run is two or more agent replies deep: `hop >= 2`), `followUp`, `person`, `other` (the trigger is gone), in that order. A notice the agent posts to itself (`deliverNotice`) counts by its kind: another agent's answer (`consult_reply`, an `agent_note` from an `@handle`) is `agent`, a person's question relayed to a DM (wiki-dm's `agent_note`) is `person`, the rest (`follow_up`, `wake_skipped`, a wait's, proposal's or poll's result, a check-in) is `followUp`, the agent coming back to its own work. By outcome: `done`, `canceled`, `active`, `failed`, and the failures by reason read from the stored error as the app does (`runErrorDetail`): `computerBusy` (runs from before a wait for room stopped failing them), `noAi` (no AI, no key, a revoked or wrong key), `paused` (the workspace or the agent on hold or paused, the budget spent), `failedOther`.
- **Waits:** turns that waited for room on a computer (a `brain_unavailable` step with `busy`, written once per wait), the most waiting at once (a wait lasts until the run's next step, its end or now, with no cap: a run waits for room until it runs, ADR 0032 "Calm waits"; the executor writes a `roomFound` context step when the computer takes the turn, since the turn's own first step can come minutes later), and for person-started turns the median and p90 seconds from the run's creation to its reply message, with `personFailed` next to them: a failed turn has no reply, so the times alone would look better as things get worse. A turn that hands the work to another agent replies at once: the wait for that agent is not covered.
- **Tokens** (usage recorded in the dates): input, output, cache read and cache write; `costUsd`, what an API billed (`cost_nano_usd`); `apiEquivalentUsd`, everything at API prices, a plan's tokens priced like the plan card's "≈ … pela API" (`apiNano`, the catalog's base prices); `byPayer` (`plan`, `workspace_key`, `platform_key` for this server's model key or a key since removed, `platform` for this server's own services); `perTurn`, the usage made in a run (not the router, embeddings or this server's own services) over the distinct turns that spent tokens.
- `agentShare`: agent-to-agent turns over all turns.

Counts and ids only: no message, no name. The console names workspaces from `GET /orgs`; agents are shown by id (`GET /orgs/{orgId}` has only their count).

Each read is four statements with `grouping sets`, so the totals, the series and the rows come from one pass each. `agent_runs.created_at` and `usage_records.created_at` get an index of their own for the reads across workspaces, and `agent_run_steps` a partial one on `run_id` for its `brain_unavailable` errors, so finding a run's waits reads none of its other steps. The joins to `messages` bound its `created_at` by the run's (a trigger before, a reply after), so each lookup reads one monthly partition.

## Consequences

- Operators see a workspace whose agents mostly talk to each other, whose turns wait for room or fail busy, and what its plan would cost through the API, and can check a fix by the day or the hour.
- Waits of runs created before the dates aren't counted, and a peak is read only where a wait starts or ends.
- Two more indexes to keep on every run and every model call, and a small one on the rare wait steps.

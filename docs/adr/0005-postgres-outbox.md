# 0005. Postgres outbox and in-process workers, no Redis/BullMQ

- Status: Accepted
- Date: 2026-10-14
- Supersedes an earlier plan to run jobs on Redis/BullMQ.

## Decision

- One table, `outbox`, is both the transactional outbox and the job queue. Rows are written in the same transaction as the change that causes them (`enqueue(tx, …)`): a message and its `message.posted` event commit together or not at all.
- Workers claim due rows with `SELECT … FOR UPDATE SKIP LOCKED` and set a lease (`locked_until`, default 2 minutes, renewed every third of it while the handler runs). An expired lease makes the row claimable again (crash recovery), except the job of an agent run still `running`: the stale-run sweep takes that one (`recoverStaleRuns`), and fails the run when a tool call was cut in half instead of running it again. Renewing, finishing and failing a job are fenced by its claim (`locked_by`, one per worker process, and the attempt it was claimed for), so a late worker can't overwrite a later claim, not even its own. A worker that shuts down hands the jobs it still runs back to the queue, due at once (`releaseJobs`, again not a run still `running`), and a handler that stops for the shutdown throws an error with `handback: true`: neither spends an attempt.
- Failures retry with backoff (5 s → 3 h) up to `max_attempts`, then the row is `failed`. Handlers throw `PermanentJobError` to skip retries; errors with `retryable: false` (e.g. provider auth errors) also stop. Handlers get `finalAttempt` so they can fail cleanly.
- Optional `dedupe_key` (unique) makes enqueueing idempotent.
- Finished jobs (`done`, `failed`) keep their content 30 days: then the daily tick clears their `payload` and `last_error` (`clearOldOutboxPayloads`). The row stays, so its `dedupe_key` still refuses a second enqueue.
- Workers run inside the server process (`apps/server/src/workers.ts`): the outbox every second (plus `wake()` right after a post with mentions), message partition maintenance daily. Safe on several replicas.
- Job kinds today: `message.posted` (dispatch @mentions) and `agent_run.execute`.

## Consequences

- Self-host stays one container + Postgres.
- Handlers must be idempotent (a job can run twice after a lease expiry). Ours are: runs are unique per (trigger, agent) and the run state machine uses compare-and-set.
- If Cloud ever needs more throughput: tune batch size, adopt pg-boss, or add a Redis-backed adapter switched on by an env var (ADR 0002). The `outbox` contract stays.

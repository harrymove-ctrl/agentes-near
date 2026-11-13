# 0163. Jobs at scale: workspaces take turns, runs sized by memory, worker processes

- Status: Accepted
- Date: 2026-11-09
- Amends: 0053 §10 (its addendum of 2026-11-09), 0005 (how the outbox claims)
- Code: engine `outbox.ts` (`claimWhere`, `turnKey`, `laneLimits`, `memoryBudget`, `resizeLanes`, `laneAlarm`,
  `claimLaneAlarm`, `RUN_MEMORY_BYTES`, `APP_JOB_KINDS`), `cache.ts` (`shareCacheInvalidations`); db `client.ts`
  (`MIGRATIONS_LOCK`); server `start.ts` (`SERVER_ROLE`, the lanes' limits at boot), `workers.ts` (the late beats,
  `slowLaneMessage`), `routes/health.ts` (`workerHealth`); config `OUTBOX_MAX_IN_FLIGHT_CEILING`, `SERVER_ROLE`; tests
  `outbox.test.ts`, `run-cost.test.ts`, `cache-share.test.ts`, db `migrate-lock.test.ts`

## Context

ADR 0053's addendum of 2026-11-09 split the job pump into a quick lane and a long one, and let the slots grow while
jobs wait, but no further than 4 jobs per database connection: 64 slots by default. More people would bring the same
waits back. Claims were also first come, first served across workspaces, so a burst of routines in one workspace made
every other workspace's routines wait behind it.

## Decision

1. **Workspaces take turns.** In each lane, a claim ranks the due jobs per workspace, oldest first, after the jobs of
   that lane the workspace already runs on any process (`processing`, lease live), and takes the lowest ranks: round
   robin, with credit for what each one holds. One workspace's burst queues only that workspace; a workspace alone
   uses every slot. Jobs of no workspace (an email to an address, an account's contact) take turns by kind
   (`coalesce(org_id::text, kind)`, bytewise), so a backfill of one kind holds back neither the workspaces nor the
   other kinds: a sync of every account's contact, say, and the sign-in emails. The ranking runs in materialized
   CTEs without locks (a window function can't take `FOR UPDATE`); the outer select locks with
   `FOR UPDATE … SKIP LOCKED` and checks the due condition again. It ranks every due job of the lane, however long
   one workspace's backlog is: the claim read them all before too, since the due condition's two states (pending, and
   a lease run out) can't come in order from the partial indexes, and it now sorts them by workspace as well.
2. **Runs hold no database connection while they wait.** Every transaction in the engine and the server (350 sites)
   was scanned for anything awaited besides the database, and the flagged ones read: none waits on a model, a tool
   or a computer. The gateway reserves the budget, streams outside any transaction, then settles; a call to a computer
   held by another process polls its `machine_rpc` row in short reads; secrets are sealed before their transaction.
   So the database bounds only the quick lane, and memory bounds the long one.
3. **Lanes sized by what bounds them.** Quick jobs read and write more than they wait: at most 4 per connection
   (`DATABASE_POOL_MAX`) run at once, claims included. Measured by `run-cost.test.ts` (100 real runs through the
   executor and the gateway, the fake model held after its first words, PGlite in the same process): a waiting run
   holds about 115 KB of heap; with all 100 waiting, timers fire at most 2 ms late; a run's whole life costs about
   47 ms of CPU, the database's work included. `RUN_MEMORY_BYTES` assumes 4 MB, and the long lane grows to as many
   runs as half the process's memory holds beside what it held at boot: about 400 on a 4 GB container, about 1,900 on
   16 GB. Its memory (`memoryBudget`) is its container's limit (`process.constrainedMemory()` on Linux), and on a
   computer it shares, as with the database and the speech server of the compose file, no more than it holds plus what
   was free there when it started. Runs that hold far more (images) meet the live brake below.
   `OUTBOX_MAX_IN_FLIGHT_CEILING` is now optional, a cap over both lanes. On the built-in database the slots stay
   where they start.
4. **Growth, and what stops it.** Every 30 s, a lane whose jobs waited over 2 s doubles, within its limit and the
   total's, quick first; one that waited for nothing and used half its slots or fewer halves, never below where it
   started. Nothing grows while the processor is busy (over 30 of the step's 300 timer beats late by 100 ms or more,
   each beat a long block swallowed counted), the database is slow (a `select 1` over 100 ms, waiting for a
   connection included) or the process holds over 70% of its memory; past 85%, the long lane halves. The runs it
   holds go on, no new one starts until they fit, and quick jobs keep their own slots.
5. **Worker processes.** `SERVER_ROLE=worker` runs the jobs and the timers, with no app, API, sockets, operator API
   or usage report; over HTTP it answers `/api/health` alone, so its container turns healthy and a deploy that waits
   for it goes on. Every process claims from the same queue without two holding a job at once (a job whose process
   stopped mid-way runs again once its lease ends), and the turns count every process's jobs. A worker reaches
   computers through the process that holds their socket (`machine_rpc`), and leaves pushes to the app
   (`APP_JOB_KINDS`): a push waits while its person has the app open, which in core only the process holding their
   socket knows (`Presence` is in memory). PostgreSQL only.
   - Migrations: processes booting together take turns on an advisory lock (`MIGRATIONS_LOCK`, on a connection of
     its own): drizzle's migrator takes none, and two of them would both apply, and both record, a migration with no
     DDL, which every later boot then refuses. A worker may leave them to the app (`RUN_MIGRATIONS_ON_BOOT=false`).
   - Caches: an invalidation of the per-process caches (scopes, members, credentials, settings) made in one process
     is published over the Postgres pub/sub and applied in every other one, which never publishes it again. A process
     whose LISTEN came back after a gap forgets everything it cached: what was sent meanwhile never reached it.
   - The way to scale: when jobs keep waiting, add a worker process (SELF_HOSTING.md, "More at once: worker
     processes"). Each one adds as many jobs at once as the app runs, with its own `DATABASE_POOL_MAX` connections
     and one it listens on.
6. **Told when to add one.** A lane whose wait (the p90 of its claims, or its oldest job still due) stays over its
   threshold for 5 minutes (quick jobs 5 s, agents' runs 30 s, routines 5 minutes) goes to the error reporter,
   naming the lane and saying to add a worker process, or, on the built-in database, to raise `OUTBOX_MAX_IN_FLIGHT`
   or move to PostgreSQL. Once per lane and hour across every process: the first to record it tells (a finished
   outbox row keyed by the lane and the hour). No page shows it: none shows the job queue today.

## Consequences

- A claim reads every due job of its lane and sorts them by workspace: under a millisecond at everyday backlogs, about
  60 ms for 100,000 due jobs on PGlite, where the claim before turns took about 25 ms. Past backlogs like that, the
  way on is an index on (workspace, due) and a lateral per workspace (`ponytail:` in `claimWhere`).
- Turns count jobs, not their length: a workspace keeps the slots its long runs hold, and the next free slot goes to
  whoever holds fewer.
- One process may run hundreds of agents' runs at once. Model providers' rate limits apply to each workspace's own
  keys, and computers keep their own lines.
- Tests: a workspace running jobs on another worker claims after one running none; jobs of no workspace take turns by
  kind; one workspace's burst of 20 routines leaves another's 3 their turns, and a backlog of 10,050 leaves another
  workspace its turn; two pumps on one database never claim a job twice and share the turns; quick jobs stay within
  their lane's limit; each brake and the shedding, quick jobs still claimed under runs left over a shed; the memory a
  process counts on beside a database; one alarm per lane and hour; a run's cost under its budget; a worker leaves
  pushes to the app; cache invalidations across processes, and a LISTEN gap that clears them; the worker's health
  check. On a real server only (`TEST_DATABASE_URL`): a claim skips the jobs another worker is taking, and
  processes booting together record each migration once.

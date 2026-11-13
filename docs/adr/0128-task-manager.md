# 0128. The task manager: see every agent's tasks, stop them, and the agent is told

- Status: Accepted (built)
- Date: 2026-11-02
- Extends: ADR 0008 (runs), 0015 (tool gateway: `tool_call` steps), 0032 ("Calm waits": the computer's line), 0053 (routines' background runs), 0084 (agent status), 0121 (long work)
- Code: engine `packages/engine/src/task-manager.ts` (`taskManager`, `agentActivity`, `taskSteps`), `run-stopped.ts` (`tellAgentStopped`, `setStopReason`, `stoppedText`), `cancel.ts` (`cancelRun` takes `reason` and `tell`), `notices.ts` (`run_stopped`), `notification-producers.ts`; server `routes/app/management.ts` (`GET …/task-manager`, `GET …/task-manager/{id}/steps`, `POST …/runs/{id}/stop-reason`, `reason` on `POST …/runs/{id}/cancel`); client `lib/task-manager.ts`, `lib/notices.ts` (`stoppedNoticeOf`), `api/queries.ts` (`useTaskManager`, `useStopTasks`, `useStopReason`); web and phone screens and the chat's strip

## Context

People wanted one place, like an operating system's task manager, to see what every agent is doing right now, what each task is using, and to stop any of it; and, inside a conversation with an agent, the same view for that agent alone.

Most of it existed in pieces: `GET …/active-runs` lists the runs in progress in the conversations a person is in, the gateway records every tool call as a `tool_call` step with its app, service and a short label (what the chat's live chip shows), and `cancelRun` stops a run of any kind. Two things were missing:

- **The agent wasn't told.** A running run that was stopped posts what it wrote with "_Stopped by …_", but a queued or waiting run ended silently, a routine's background run ended silently (ADR 0053 §6.7), and nobody could say why. The next turn didn't know its task had been taken away, so an agent could pick it up again on its own.
- **One view across conversations.** The live events go to each channel's subscribers; a page that follows every conversation at once can't subscribe to all of them without sending a private DM's activity to people who don't read it.

## Decision

### 1. One read: `GET …/task-manager`

`taskManager(db, userId, orgId, { since })` returns:

- `tasks`: runs still on (queued, running, waiting for an ok or an answer, or waiting on no person: `held` says whether on its computer with no room for the turn, its computer away, its plan's limit or the budget, from the executor's `waitingForBrain`), newest first, at most 100. Visibility is the `active-runs` rule (the conversations the caller is in, never someone else's DM or a private channel they're not in) plus the routines' background runs for admins (`manage_agents`) and for the agent's owner, who could not see them anywhere before. Each task carries its label (the long work's title, else the thread's, never the words of its first message: with neither, the apps say where it is), the routine behind it, the long work's plan, who asked, its brain, the agent's computer, `now` (its latest `tool_call` step: tool, label, app, service, icon, when), how many tool calls so far, and `canStop` (who asked, the agent's owner, an admin; `cancelRun` checks again).
- `ended`: what ended since `since` (default the last 24 h; the apps ask for today), at most 50, with who stopped it.
- `activity`: per agent, tool calls per minute over the last 60 minutes, counts only, for the line on each agent's card.

No cost and no tokens: this is where people stop work, not where they audit spend (that stays in Usage).

A run waiting on no person's answer also carries `wait`: its code, the plan or budget (`key`), the model and scope of a model's own limit, how far a pause got and its window (from its `usage_wait` step, so a routine's run with no card has them too), when the limit resets and whether the caller may press Continuar agora. `taskWaitWords` turns it into the row's two lines, on the web and the phone ("Pausada: plano a 95% da semana", "Volta sáb às 18:00"); `taskWaitGroups` finds the rows on one limit, which get one line over them, with Continuar agora on a pause (`POST …/task-manager/continue`, `continuePausedRuns`: the card's and Rotinas' rules, each run on its own, its card saying who let it go on, a refusal for all of them returned as is). The Tempo column warms only for work at it: a wait for a known reason isn't stuck.

A task's steps ("Ver passos") come from `taskSteps` (`GET …/task-manager/{runId}/steps`), with the same visibility: each call with the chat chip's fields and how it ended, never a connector's input or a tool's output (only a permission check's answer, which says whether a command ran). The full trail (`GET …/runs/{runId}`) still needs usage access.

The page asks again every 3 s while it is shown (`TASK_MANAGER_POLL_MS`). Polling an authorized read keeps the visibility rule in one SQL query; per-person real-time fan-out can come later if the poll turns out too slow.

### 2. "Using now" comes from the gateway's own record

The program a task uses is its latest `tool_call` step, mapped by the same `toolActivity` the chat's chips use: the agent's browser, its desktop, a terminal (code and commands), an app (a connector, a mailbox, a database, with its logo), or one of our own tools. A computer brain's turn shows the brain (Claude Code, Codex, Cursor) with what it last called through the bridge inside it; its own built-in tools (its shell, its file edits) aren't recorded as steps, so between bridge calls the line just says the brain.

There is no per-task CPU: computers report only their own load, sampled every few minutes. The column says where a task runs (the agent's computer, or our servers) instead.

### 3. Stopping tells the agent

`cancelRun(…, { reason })`, after `stopRun`, calls `tellAgentStopped`: a `run_stopped` notice in the conversation the task belonged to (where it answers; a routine's room for a routine), through `deliverNotice` with `wake: false`. Stopping means stop, so nothing starts; the agent reads the notice as an event before its next turn there ("[A person stopped your task]: Ana stopped your task «…» while you worked on it. What you already did or posted stays as it is. Their reason, in their words: «…». Don't pick it up again on your own: only when someone asks you to."). People see one line ("You stopped this task · Dev was told"); it never notifies, and conversation previews, unread counts and a thread's activity skip it (`QUIET_NOTICES`, `quietNoticeSql`).

Two stops tell nothing: "stop and send" (the message sent with it says what to do, `stopMessageId` or `tell: false` in `steering.ts`) and an agent stopping its own background work on a person's word (`work-tools.ts`).

The reason can come with the stop (the "stop all" confirmation) or after it: `setStopReason` (`POST …/runs/{id}/stop-reason`) lets whoever stopped it add one, once; the notice's text changes and the agent reads it on its next turn.

### 4. The computer's line

The engine keeps a line for a shared computer's room and shows it (ADR 0032, "Calm waits", `computer-queue.ts`: `computerQueue`, `GET …/machines/{machineId}/queue`, the "Fila do computador" dialog on the web and sheet on the phone). The task manager reads that line rather than keeping its own:

- A task waiting for room carries `line`: its computer, its place, how many are in line, whether a person waits on it and when it should start (`estimatedStartAt`), all taken from `computerQueue`, so the order and the estimate are the queue's own.
- `computers` (in the same read) counts, per computer with work, the turns running and waiting: everyone may see how full a computer is.
- "Ver fila" (a computer's row, a task waiting for room) opens the queue's own dialog or sheet.

Computers report no live memory, only the last day's average; the line says "full" by having people in it, not by a gauge.

### 5. Where people see it

- **The page** (web; on the phone, a pushed screen with the list): the agents as cards with their last half hour, a table of tasks grouped by agent with state, what each uses, how long, where it runs and Stop, the routines' background runs apart, and what ended today. Stopping several asks first, with an optional reason.
- **In a DM with an agent**: a pill in the header ("3 tarefas · 1 espera você") opens the agent's tasks in the thread panel on the web (a pushed screen on the phone, as a thread): its tasks with their steps and Stop, "Stop all" with its confirmation, and, for a task in line, its place and the computer's line.

## Consequences

- An agent always knows when a person took a task away, and why when they said it, including a routine's run and a task stopped before it started.
- Admins and owners finally see routines' background runs while they run.
- The page costs one query every 3 s per open page; its subqueries are bounded (100 runs, the run's own steps by `run_id`, the last hour of steps).
- A computer brain's own tool use between bridge calls isn't visible in "using now".

## Addendum (2026-11-05): work agents ask of each other

A coordinator delegated to three agents in their private conversations. The computer filled up with that work, the task manager said "1 trabalhando" and the cards "Livre", because the list followed the conversations the caller is in and no person is a member of those. Nothing could be stopped.

- **Who sees it.** `seesRunSql` (`computer-queue.ts`) is the one rule: the conversation's members, plus, for what no person is a member of (routines' background runs, agents' private conversations), admins and the agent's owner. The task manager, a task's steps and the line's rows read it. Other people's DMs stay theirs. A member behind the chain who is neither sees a count, as anyone else does.
- **Their own section.** `delegation` says who asked and what started the chain (a person, a routine); "Pedidas por agentes" groups them by the agent that asked. There is no conversation to open: `betweenAgents` hides "Abrir na conversa", and the steps are what the panel shows.
- **Counts for the rest.** `hidden` counts everything `visibleRuns` leaves out, per agent too, so the page's "trabalhando" covers what the computers' rows count and a busy agent's card never says "Livre". Never what the work is.
- **Stopping a chain.** `cancelRun` with `chain` (`stopHelpers`): every open ask below the run closes top first and as told, so nobody it asked for wakes; a wake that never started goes; an ask unread in a colleague's inbox leaves it, or the stop would hand it on. The runs nobody else waits on stop and are told by name, with the person's reason, and the run stopped reads which agents stopped with it. A run another ask still waits on goes on, with what it asked. If the run ended as the stop came, what it asked still stops and its agent reads that. Every stop of a run that has helpers takes them along: its row, "Parar tudo" of its agent, and a row of the line.
- **Stopping one helper.** Its asker is told who stopped it and not to ask again or hand it on unless a person asks (`endedWhy`), and wakes with that. The task's panel says so before the stop.
- **The line's rows.** Each carries `canOpen` and `canStop`. A row opens the task (`?task=` on the web, its screen on the phone) and stops it; `where.agents` replaces "uma conversa privada" for who may see that work. The dialog says what fills the computer (`queueFillText`).
- **No run holds room while it waits for a helper.** `ask_agent` and `tell_agent` return at once and the turn ends with the run `done` (`wakesLater`): what's left is a warm CLI, which closes when a turn needs the room.

# 0045. The conversation run stays short: long work goes to background work the agent reports on

- Status: Superseded by ADR 0121 (never built)
- Date: 2026-10-21
- Extends: ADR 0008 (agent runs), ADR 0032 (one engine, swappable brains), ADR 0034 (agents consult each other)
- Related: ADR 0029 (missions, and sending while the agent works)

## Context

A run holds its conversation for up to `AGENT_MAX_TOOL_TURNS` (25 then, a backstop of 200 since the ADR 0015 addendum of 2026-10-31) model calls (`executor.ts`). While it works:

- New messages only reach it between steps, as "[Nova mensagem de X, enquanto você trabalhava]" (`pending_message_ids`, `dispatch.ts`). The agent can't answer a quick side question without first finishing or abandoning the long task.
- "Stop and send" (ADR 0029) can cut a model call, but the agent still carries the whole task in the same loop.
- The person sees "trabalhando…" with no idea of what is happening, and a long investigation ends in `too_many_tool_calls` instead of a report.

Missions (ADR 0029) solve this for work measured in hours, with a plan, a worktree and reviews. Most asks are in between: a few minutes of reading logs, querying a database, checking a PR. They don't deserve a mission, but they shouldn't hold the chat either.

## Decision

### Two kinds of run for the same agent

- **Conversation run** (today's run): answers in the conversation, short. New cap: 8 model calls.
- **Background work** (`agent_runs.kind = 'work'`, new column, default `'conversation'`): a child run of the same agent, `parent_run_id` and `parent_thread_root_id` recorded. It never posts to a conversation. Its own cap is 100 model calls; at `max − max(2, ceil(max/10))` it gets a wrap-up message ("Stop starting new work. Write your final report now: what you found, what you did, what is left.").

### Tools for the conversation run

- `start_work({ title, brief })`: the brief must stand alone (the work doesn't see the conversation). Returns at once with the work id. Title ≤ 60 chars, brief ≤ 8,000.
- `check_work({ id? })`: status, last status line, steps so far.
- `steer_work({ id, message })`: queued for the work's next step, the same way `pending_message_ids` reaches a run today.
- `stop_work({ id } | { all: true })`.

The prompt rule ("How you work"): if an ask would take more than two rounds of tool calls, start background work, tell the person in one line what you are doing, and end your turn. Never wait for or poll the work; you are woken when it ends.

### Who the work acts for

- Same agent, same person behind it (`personBehindRun`, the agent's audience), same scopes, same monthly budget. Nothing is granted.
- `ask_user` and approvals from the work surface in the parent conversation with the work's title, exactly as they do for a run today. The work waits in `waiting_input` / `waiting_approval`.

### Limits

- At most 2 active works per agent and conversation, 4 per agent overall. A fifth `start_work` is `queued` (status visible in `check_work`), not refused.
- Hop counting: the work inherits the parent's hop; its completion wakes the parent at the same hop (no new hop is spent on a self-report).

### Waking the parent

When the work ends (`done`, `failed`, `canceled`), an `agent_run.work_finished` job (priority 1, ADR 0046) creates a conversation run on the parent thread whose trigger is a hidden system message: "Background work «title» finished: <final report, ≤ 16,000 chars>". The run writes the reply in the agent's voice, where the original ask was made (`replyThreadOf`). If the conversation run is still active, the report joins it through `pending_message_ids` instead.

Two works ending at once produce one wake with both reports (dedupe key per parent thread, 5 s window).

### Status line

- `set_status({ text })` (≤ 50 chars, "revendo os logs de ontem") for both kinds of run, sent in the same batch as the first tool call. Published as `agent.status` and shown next to the agent's name in "Trabalhando agora" (`working.ts`) and in the conversation's working indicator.
- A work with no status shows its title.

### Brains

The model brain first. Claude Code and Codex keep `machine_tasks` (ADR 0029 §4) for long work, since their turn already runs on the computer. They get the same prompt rule pointing at `start_task`.

## Consequences

- The chat stays responsive during long asks; the person can ask something else, steer or stop the work.
- One extra model call per long ask (the conversation run that writes the final answer). Cheap next to the work itself, and it keeps the voice consistent.
- `agent_runs` gains `kind` and `parent_run_id` (new migration). Existing queries that list "the agent's active run" must filter `kind = 'conversation'`.
- Evals: `eval:behavior` gains cases for "starts work instead of doing it inline", "doesn't poll", "final answer reflects the report".

## Alternatives considered

- **Raise the 25-call cap.** Makes the chat block longer.
- **Always use missions.** Too heavy (plan, worktree, reviews) for a few minutes of reading.

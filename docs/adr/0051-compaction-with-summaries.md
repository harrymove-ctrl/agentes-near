# 0051. Compaction with summaries: inside long runs, and when a conversation goes quiet

- Status: Proposed
- Date: 2026-10-21
- Extends: `fitContextWindow` (`packages/engine/src/context-budget.ts`), thread summaries (`context/summaries.ts`, ADR 0017)
- Related: ADR 0050 (anchor and epoch), ADR 0045 (background work up to 100 steps)

## Context

- Inside a run, when a request would not fit the window, `fitContextWindow` replaces old tool results (≥ 1,000 chars) with "[Result removed… call again]", Jev picking which. Nothing is summarized: the model loses what it learned from those results and may call the same tools again. With background work up to 100 steps (ADR 0045), this happens more often.
- Across runs, history is cut at 30 messages. The thread summary (`ensureThreadSummary`) is generated on the reply path, only when the thread is already truncated (`force: true`), so the person pays its latency.

## Decision

### Inside a run: summarize the old steps

- Trigger: estimated input above 90% of the model's window, or above 150k tokens, whichever comes first.
- First, the existing cheap step: placeholders for old tool results. If the request still passes 80% after that, summarize.
- The summary call (usage kind `summary`, through the Model Gateway) gets the run's older steps and writes a block "# What I've done in this task so far": goal, decisions taken, files and sources read with the key facts, actions done, what is left. ≤ 10,000 tokens.
- The transcript keeps the system prompt, the trigger, the summary block and the last 6 steps intact (a tool call is never split from its result). The new transcript is saved (`saveTranscript`), so resumes and recovery agree.
- On error, the run continues with placeholders only (as today) and the error is a step.

### Between runs: summarize when the thread goes quiet

- Job `thread.compact` (priority 2, ADR 0046) runs 20 minutes after the last message of a thread with more than 30 messages since its anchor (debounced: a new message pushes it back).
- It updates the thread summary, moves the anchor (ADR 0050) to the last summarized message, keeps the 10 most recent messages after it, and bumps the thread's epoch.
- The next run finds the summary ready; the reply path no longer calls `ensureThreadSummary({ force: true })` except as a fallback when no summary exists and the history doesn't fit.

### Epoch

`threads.compaction_epoch` (new column) increases with each compaction. Frozen prompt sections (ADR 0050) are renewed only on a new epoch.

## Consequences

- Long runs keep their findings instead of re-reading; long threads start fast.
- Summaries cost model calls in the background; they are attributed to the agent (kind `summary`) and count toward its budget, as today's thread summaries do.
- `eval:behavior` gains a long-run case: after compaction the agent doesn't repeat calls already summarized and finishes the task.

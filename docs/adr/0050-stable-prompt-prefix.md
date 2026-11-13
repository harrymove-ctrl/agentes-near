# 0050. A stable prompt prefix per conversation: frozen sections, updates as messages, an anchored history

- Status: Proposed
- Date: 2026-10-21
- Revises: prompt assembly in `buildRunContext` (`packages/engine/src/context.ts`) and the extras added in `executor.ts`
- Related: ADR 0043 (tools and context on demand), ADR 0051 (compaction)

## Context

Within one run, caching works: system blocks marked `cache` get a breakpoint and top-level automatic caching covers the growing tool loop (`packages/providers/src/anthropic.ts`). Across runs of the same agent in the same conversation, almost nothing is reused:

- **History is a sliding window** of the last `AGENT_CONTEXT_MESSAGES` (30). Every new message shifts the start, so the conversation prefix differs on every run.
- **Per-run blocks sit in the middle:** "# Where you are", "# Your team", capabilities and skills are rebuilt each run; "# What you know (memory)", "# Organization wiki" and "# Earlier in this thread (summary)" are pushed by the executor after "# Now", which changes every run.
- Measured: cache reads were 0 on one agent's runs.
- Claude Code and Codex sessions are resumed with their original system prompt, so memory, "Where you are" and "Now" go stale.

## Decision

### Frozen sections per agent and thread

- New table `prompt_snapshots`: `(org_id, agent_id, thread_root_id)` → `epoch`, and per section `{ text, sha256 }`. Sections: `org`, `instructions`, `how_you_work`, `capabilities`, `skills`, `team`, `where`, `memory`, `wiki`, `summary`.
- The first run in a thread renders every section and stores the snapshot. Later runs of the same agent there send the stored text byte for byte, in a fixed order, stable blocks first.
- The snapshot is rebuilt only when the thread's epoch changes (compaction, ADR 0051), when the agent's instructions or brain change, or when it is older than 24 h.

### Changes travel as an update message

- Each run re-renders the sections and compares hashes with the snapshot.
- A changed section produces an `# Update` block appended at the end of the conversation, before the trigger message: "Memory, new since earlier: …", "Team: @iris joined.", "Where you are: this thread is now in #ops." Only the difference: new or removed lines, at most 2,000 chars, else "Memory changed: use search_context".
- The snapshot isn't rewritten until the next epoch, so the next run sends the same prefix and the same update (marked "Already told: …" so the model doesn't react twice).
- **Claude Code / Codex:** the same update block is prepended to the prompt of a resumed session. This fixes the stale system prompt of a resumed session without restarting it.

### Anchored history

- The history starts at the thread's anchor: the last message covered by the thread summary (ADR 0051), or the thread's first message. It no longer slides by one on every message.
- When the history from the anchor passes 60 messages (or the token budget), compaction moves the anchor and bumps the epoch.

### "Now" really last

Order: frozen sections (cache breakpoint after `where`) → history from the anchor (automatic caching) → `# Update` → `# Now` → the trigger message.

### Measure

- `model_call` step: `cache_read_tokens / input_tokens`, the epoch, and the sections whose hash changed (`prefix_changed`).
- Target: above 70% cache reads on the second and later runs of an active conversation.

## Consequences

- Cheaper and faster replies in long conversations, with every provider that caches prefixes.
- An agent may see memory "as of" its last compaction plus updates, never silently stale: every change is either in the frozen section or in an update.
- New migration for `prompt_snapshots`. The snapshot is cache, not truth: deleting it only costs one cold run.

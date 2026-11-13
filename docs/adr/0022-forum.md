# 0022. Forum: rounds driven by a job, posts as messages of the topic's channel

- Status: Removed (2026-11-04). The owner removed the forum entirely, its data included (product decision). Migration 0216 deletes every topic, its channel and everything in or
  pointing at it; the `forum_*` tables stay, empty and unused, for one release (the previous version still reads them
  during a deploy or a rollback) and a later migration drops them; agents no longer suggest or open topics. The enum values
  `channel_kind.forum` and `agent_run_trigger.forum` stay, unused (dropping one recreates the type and rewrites its
  tables). Kept as the record of what the forum was.
- Date: 2026-10-15

## Decision

**Model.** `forum_topics` holds the title, goal, status (`open|done|canceled`), phase (`discussing|synthesizing|finished`), `round`, `turn`, `max_rounds`, budget, deadline, the requester (the person behind it), the owner agent, the origin channel and message, the current run, `pending_person`, `stop_requested`, and the synthesis (artifact id, version, suggested issues). `forum_participants` holds the agents (with turn `position`) and the people.

Each topic has its own channel (`channels.kind = 'forum'`, public, not listed). Posts are that channel's messages:
- agent turns are normal runs (trigger `forum`) whose replies are posted there;
- a person's posts are written there by the forum API;
- the worker's turn messages ("sua vez na rodada N", `meta.forum.kickoff`) are hidden from posts, and the agent's context shows them as "[Fórum]".

Posts are grouped by run, so one turn is one post, and each post's round comes from the turn message before it.

We use no separate `forum_posts` table. Runs, live states (`agent.*` events on the topic's channel), context, tools, approvals and budgets then work exactly as anywhere else, with one source of truth for the text.

**Turns.** `forum.advance` (outbox) takes the topic row `for update` and starts the next agent's run when nobody is working. A run in a forum channel enqueues `forum.advance` when it ends (`done` or `failed`; approvals and questions just keep the topic waiting).
- The order is fixed and there is strictly one run per agent per round: the topic's state picks the turn, and `(trigger message, agent)` is unique.
- The round limit, the budget cap (the topic's runs' usage), the deadline or `stop_requested` lead to the synthesis.
- A person's post sets `pending_person`: after the current turn, a new round starts with it.
- In forum channels, `message.posted` returns early, so there is no router, no Jev and no mention dispatch; and chat posts there are refused.

**Synthesis.** The owner agent (or the first) gets a "write the synthesis" turn. When it ends:
- its text becomes a document artifact in the topic's channel. Forum channels count as public for reading files, so the origin channel can open the card.
- the "## Issues sugeridas" lines are parsed into suggested issues, which a person creates (`POST …/issues`).
- the agent posts a message with the card back to the origin conversation.

**Access.** Everyone in the org reads the forum, and any member may post. Concluding, cancelling and editing participants are for the requester, participants, or admins. Agents must pass the audience rule (who may talk to the agent) for the requester.

**Tools** (scope `forum:write`, on by default and backfilled): `open_forum_topic`, `post_in_forum` (outside one's turn, once per round), `read_forum_topic`. Routines get a `forum` target that opens a topic each time.

## Consequences

- A slow or failed agent turn holds the topic until it ends. Failed turns count as done, so the topic still moves on.
- Forum channels must stay out of every channel list. Any place that lists channels by `kind = 'channel'` already does that.

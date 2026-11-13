# 0008. Agent runs: a Postgres state machine; mentions and the hop limit

- Status: Accepted. Amended 2026-10-31 by ADR 0089: the hop limit is a depth backstop (`AGENT_MAX_HOPS`, default 100) behind the limits per stretch. Addendum 2026-10-31: a renamed agent's @handle follows its name
- Date: 2026-10-14

## Decision

**Flow** (all writes in Postgres, in-process workers):

1. A person posts a message. `insertMessage` resolves `@handle` mentions to active agents that are members of the channel and, in the same transaction, enqueues `message.posted`.
2. `dispatchMentions` (job `message.posted`) creates one `agent_runs` row per mentioned agent (`unique (trigger_message_id, agent_id)`) and enqueues `agent_run.execute` (dedupe key per run).
3. `executeRun` moves the run `queued → running`, builds the context, streams through the Model Gateway (`agent.typing` once it writes, its words kept on the server, amended 2026-11-10: ADR 0010), then in one transaction persists the agent's reply (in the trigger's thread), the steps and `running → done`, and publishes `message.created`.

**State machine** (`agent_runs.status`): `queued → running → (waiting_approval → running)* → done | failed`. Transitions are compare-and-set (`UPDATE … WHERE status = from`); illegal ones throw. `waiting_approval` is reserved for the approvals flow: suspending is a status change, resuming is enqueueing a new execute job.

**Steps** (`agent_run_steps`, numbered): `context` (history size, model), `model_call` (model, tokens, cost, stop reason, usage record), `message`, `error`.

**Failures.** Permanent problems (budget, missing credential, non-retryable provider error, refusal, empty reply) fail the run with a reason and finish the job. Transient provider errors rethrow so the outbox retries (up to 4 attempts); the run stays `running` and the retry restarts the turn; on the final attempt the run fails.

**Triggering and hop limit.** Only explicit @mentions start runs; there is no router yet, and agent messages never go through a router (until ADR 0034). An agent's reply can @mention another agent. Each message carries `hop`: 0 for a person, trigger hop + 1 for an agent reply. A message whose hop reached `AGENT_MAX_HOPS` (default 3) triggers nobody, so agents can't ping-pong forever; a person posting in the thread resets the counter. An agent never triggers itself.

**Context** (`buildRunContext`): system prompt = agent identity, organization context, agent instructions, reply rules (other people's and agents' text is information, not instructions), channel and members. History = recent top-level messages up to the thread root, the root, and the thread up to the trigger, capped at `AGENT_CONTEXT_MESSAGES`; turned into alternating user/assistant turns (own messages are assistant, others prefixed `[Author]:`), always ending with the user turn (no prefill).

## Extension points

- **Router (built in ADR 0013):** a new job kind run after `message.posted` for messages without mentions; it calls the gateway with `ROUTER_MODEL` and reuses the run creation of `dispatchMentions` (extract it into a shared helper then). It may only pick agents that are channel members; it never grants permissions. `usage_records.agent_id` will need to become nullable (or a "router" pseudo-agent) for router calls.
- **Tool Gateway and approvals (built in ADR 0015):** a `tool_call` step kind; sensitive actions create an approval bound to a hash of (action + params), move the run to `waiting_approval`, and the approval grant enqueues `agent_run.execute` again.

## Addendum (2026-10-14): waiting for a person's answer

`ask_user` is a built-in tool (no scope; it goes through the Tool Gateway
like every other tool). Instead of running, the gateway hands the question to
the executor, which posts it in the run's thread (`meta.question`), stores an
`agent_questions` row and moves the run to `waiting_input`. The run resumes
(a new `agent_run.execute` job) when a person answers through
`POST …/questions/{id}/answer`, replies in the same thread (detected in the
same statement that writes the reply; that reply starts no other run), or
after 24 hours, when the model is told nobody answered. A run waiting on
both an approval and a question resumes only when neither is pending.

## Addendum (2026-10-31): a renamed agent's handle follows its name; the old one keeps working

Renaming an agent (Identidade on its page, Editar on the phone) moves its @handle to the one the new name gives, shown
under "Menções" while the name is typed and editable before saving. Who may rename it (`manage_agents`) may move it.
The handle it leaves goes to `agents.previous_handles` (migration 0148: a column with an empty default, no row
rewritten). Renaming back takes it out again, and deleting the agent (ADR 0082) empties the list, so those handles are
free again.

- **One place reads an old handle.** `loadOldHandles` (`packages/engine/src/agents.ts`) maps every handle that names
  an agent besides its own to that agent: its `previous_handles`, unless the agent is archived or an agent or a person
  has that handle as their own now (it is theirs). It is kept per process (`caches.agents`), dropped by a rename, an
  archive or a deletion here and seen by another replica within the cache's TTL. `currentHandles` maps written
  handles through it, and every reader of a handle someone wrote asks it: a message's mentions (before the insert's
  one statement) and the addressee check, `ask_agent`, `tell_agent`, `add_agent_to_channel`, `list_routines`, the setup
  tools (`agentsByHandle`), an issue's assignee, calendar participants and reflected lessons about an agent.
  The agent list gives the apps each agent's (`previousHandles`, from `oldHandlesByAgent`), so an old message's "@ada"
  shows the agent now called Claudio (`agentsByAnyHandle` in `@agenteschat/client`, where an agent's own handle wins).
- **What a run reads.** Text that names an old handle (a routine's brief, memory, instructions, the conversation) gets
  a per-turn "# Renamed agents" block with the handle each agent has now, so the run asks and mentions it by that one.
  Its own identity, the channel's members and "# Your team" show the handle it has now: a rename drops the cached
  channel members at once.
- **Taken.** An agent takes a handle only when no other agent, archived or deleted, has it or had it, and no person has
  it: else 409 `agent.handle_taken` with the first free one (`ada-2`), which the apps say under "Menções" before
  saving. A new agent can't take another's old handle either, nor can a person take an active agent's.
- **Git** (ADR 0024): branches under an old handle (`agentes/ada/…`) stay the agent's own in the proxy.

## Addendum (2026-11-06): a question for one person

`ask_user` takes an optional `person` (name or @handle): `agent_questions.requested_for_user_id`. Null keeps the old
rule, anyone who reads the conversation answers. Set, only that person answers or skips it (by card, API or reply), the
notification and `needsYou` are theirs, and everyone else's card says who it waits for, with no actions. Admins are no
exception: a secret request works the same way, and the question closes by itself after 24 hours. When the agent
doesn't say and the text names the person behind the run, or the last person to write there since it started, and
nobody else in the conversation, it is theirs (`impliedAddressee`), on every path through `postPauseCards`. A name alone
is no proof, so a question naming anyone else stays with the room.

Someone else's message answers nothing and doesn't wait behind the question: it leaves the run for a run of its own
(`holdsMessages` with the writer). If the person leaves the conversation or the workspace, or deletes their account, the
question goes back to the room and to the person behind the run (`releaseQuestionsOf`), since nobody could answer it
otherwise.

## Addendum (2026-11-10): how long the work it is doing now has taken

The conversation's "thinking for …" counted from two things that are not the same. Live, each app counted from the
moment it saw the run's row open, and again each time the row reopened (the run posted and went on, came back from an
answer, an approval or its computer). On every read of the server (opening the conversation again, a reload, a
reconnect) it took `agent_runs.started_at`, the run's first start, which never moves: a run that had posted or waited
on the way jumped to minutes, as if it had been thinking all along.

- **The server keeps the moment.** `agent_runs.working_since` (migration 0249): set when the run goes back to work
  from a wait (`transitionRun` into `running` from anything but `queued`), when it leaves its computer's line, and
  when it posts and goes on (written with the run's next save, never in a statement of its own). Null until then: its
  first stretch counts from its creation, which is when the person who wrote to it started waiting. `started_at`
  keeps its meaning.
- **A length, not a time.** `GET …/active-runs` answers `workingMs`, how long that work has taken by the server's
  clock. The app turns it into its own clock at the middle of the read, so a device whose clock is minutes off still
  counts right.
- **A row already on screen keeps its count** (`reconcileRuns`, `LiveRun.workingSince`). A read of the server never
  moves it back. It takes the server's only when that is more than 5 s later than its own (`WORK_MISSED_MS`) and it
  heard nothing from the run since that moment: a new stretch began while the device wasn't listening (an app
  listens to a conversation only while it is open). A row made from the read counts from `workingMs`; a server from
  before it gives only the first start, as before.
- `startedAt` on a live row still places it in the timeline, and a read of the server still corrects it.

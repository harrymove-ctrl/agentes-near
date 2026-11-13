# 0049. Agents may pass: silence is a normal outcome in rooms

- Status: Proposed. Amended 2026-10-31 by ADR 0089's addendum: a run another agent's @mention woke may pass too
- Date: 2026-10-21
- Extends: ADR 0013 (router), ADR 0034 (an agent's message may bring in one more agent)

## Context

When the router picks an agent (`routeMessage`, `packages/engine/src/router.ts`), the agent's run always ends in a message. The router decides on the message alone (and a little history) within ~2 s; the agent decides with its full context and tools. Common cases where the run shouldn't post:

- After reading the thread, the agent has nothing to add.
- Another agent answered the same message while this one was starting (up to `maxAgents` 4 run in parallel).
- The message was small talk between people that the router scored just above `minScore`.

Today these produce a redundant reply, or a reply saying there's nothing to add. Only routines can stay quiet (`NO_REPLY`), and ADR 0047 removes that.

## Decision

### Who may pass

Runs not called by name: `trigger = 'router'`, and agent chime-ins (`AGENT_CHIME_IN_SCORE`). Runs from a mention, a DM, `ask_agent`, `tell_agent` with a question, approvals and `ask_user` answers must answer.

### How

- Built-in tool `pass({ reason })` (reason ≤ 200 chars, stored, never shown): the run ends `done` with no message. Ending the turn with no text has the same effect.
- Prompt block for these runs: "# Why you were called\nNobody called you by name; you were brought in because you might have something to add. If you don't, or another agent already answered, pass: staying quiet in a room is normal."
- `agent.passed` is published so the working indicator disappears at once, without a message.

### Answered while starting

Agents' replies to the same trigger already reach a running agent through `pending_message_ids`. The executor checks before the first model call too: when another agent posted on the same trigger after the run was claimed, that reply is in the context as a new message, so the agent can pass.

### Feedback for the router

- `routing_decisions` gains `outcome`: `answered | passed | canceled`, filled when the run ends.
- Per agent and channel, a pass rate above 40% over the last 50 router picks is a signal the router calls it too often. First version: shown to the agent's owner in the agent page's diagnostics ("Entrou em 50 conversas sem ser chamado e ficou quieto em 22"), no automatic tuning.
- Later, the rate feeds per-agent `minScore` offsets (separate decision).

## Consequences

- Rooms with several agents get fewer redundant replies.
- A passed run still costs one model call. The router stays the cheap first filter; this is the second, better-informed one.
- `eval:mentions` / `eval:behavior` gain: picked agent passes when another agent already answered; picked agent with something new answers; named agent never passes.

## Addendum (2026-10-31): a run another agent's mention woke may pass

An agent's @mention now wakes the agent it names unless the judge is sure the message needs nothing from it (ADR 0089, addendum), so some of those runs find nothing to do. A run another agent's message woke by mention (trigger `mention`, hop 2 or more, `byAnotherAgent` in `reply-policy.ts`) may pass, with its own "# Why you were called": do what the message hands you, and on a thanks, an ok, a sign-off or a name, pass at once. A person's mention, a DM, a consultation, the agent's own lines and a person's click on that message (Continuar, "Responder agora", hop 1) still answer.

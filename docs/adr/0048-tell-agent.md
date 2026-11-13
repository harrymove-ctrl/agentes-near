# 0048. `tell_agent`: a note to another agent without waiting

- Status: Superseded 2026-10-31 by ADR 0095: every note is a tracked row, and what comes of it goes back to the sender's conversation by itself, as the answer kind. Earlier amended 2026-10-31 by ADR 0089: a reply to a note goes back when the judge reads something in it, with no length or "?" rule, and notes count toward the stretch's limits instead of a hop limit
- Date: 2026-10-21
- Extends: ADR 0034 (agents consult each other), ADR 0046 (outbox priority)

## Context

`ask_agent` (`packages/engine/src/consultations.ts`) is synchronous: the asking run pauses on a `waitId` until the other agent answers or `CONSULTATION_TTL_MS` (15 min) passes. That fits "I need this to continue". It doesn't fit:

- "Let @infra know the deploy changed variable X."
- "@dev, tell me when the PR is merged."
- Handing a finding to the agent that owns the area, while the current agent carries on with the person.

Today agents either block on `ask_agent` or post in a channel with `post_message`, which brings people and the router into a conversation between agents.

## Decision

### The tool

`tell_agent({ agent, message, urgent? })`, built in like `ask_agent`:

- Delivers `message` (≤ 8,000 chars) as a message in the private DM between the two agents (`openAgentDm`, key `a:<id>|a:<id>`) and returns at once: "Sent. If @x replies, it comes back to you as a new message."
- Same checks as `ask_agent`: active agent of the org, not itself, one the person behind the run can talk to, on behalf of that person (`personBehindRun`), the recipient's own scopes and budget.
- One recipient per call.

### When the recipient reads it

- **Default:** the note waits. It is added to the recipient's next run in that agent DM, or, if none comes within 1 h, a priority-2 run picks it up.
- **`urgent: true`:** a priority-1 run (ADR 0046) on the agent DM. If the recipient has an active background work or routine (ADR 0045, 0047), the note also goes to that work's `pending_message_ids` and is read at its next step. A conversation run with a person is never interrupted: the note is read when it ends.

### Replies

The recipient's reply in the agent DM wakes the sender with a run on the original thread (`reply_to_run_id` recorded on the note), as a hidden message "@x replied: …". The sender answers the person there if it matters, or stays quiet (ADR 0049 lets it pass).

### No acknowledgement ping-pong

- Prompt (both sides): "Reply to a note only when you have something to add. Never reply just to confirm or thank."
- Code: a reply to a note whose text is only an acknowledgement (Jev, "is this only an acknowledgement?" ≥ 0.7; without Jev, under 40 chars with no question mark and no link) is delivered but wakes nobody.
- Hops: each note is one agent hop; `AGENT_MAX_HOPS` (3) applies across notes, consultations and messages alike.
- Dedupe: the same text to the same agent within 1 h is dropped (`dedupe_key` = hash of sender, recipient, normalized text).

### Data

`agent_notes` (new): `id, org_id, from_agent_id, to_agent_id, message_id, person_id, urgent, reply_to_run_id, chain, created_at, read_at`. `chain` follows the same no-cycle rule as `agent_consultations.chain`.

### UI

The note shows in the person's conversation as the "Mensagem de @agente" card planned in ADR 0034, collapsed, with the agent DM one tap away (read-only for the person behind it, an admin, or the agents' owners).

## Consequences

- Agents can coordinate without blocking the person's conversation.
- The agent DM becomes auditable from the conversation that caused it.
- `ask_agent` stays for answers needed now; the tool descriptions say when to use each one.

# 0013. Router: code picks candidates, a strategy scores them, policy decides

- Status: Accepted
- Date: 2026-10-14
- Extends 0008.

## Decision

A person's message without mentions enqueues `message.posted`; the handler calls `routeMessage` when `ROUTER_ENABLED`. Agent messages never go through the router (changed by ADR 0034).

1. **Candidates are chosen by code**: active agents that are members of the channel with `channel_members.auto_reply = true`. Nothing else can be picked.
2. **A `RouterStrategy` only scores them**: `decide({ orgId, channel, message, thread, candidates }) → { agents: [{ agentId, score }], needsAgent?, reason?, usageRecordId? }`. It never adds candidates or grants anything.
3. **Policy is applied by code** (`selectAgents`): drop scores below `ROUTER_MIN_SCORE` (default 0.5), nobody if `needsAgent` is below it, best first, at most 2. The hop limit is checked before routing.
4. Runs are created with the shared `createAgentRuns` helper (trigger `router`), the same one mentions use.
5. **Every decision is stored** in `routing_decisions` (unique per message): strategy name, every candidate's score, the need-any-agent score, who was picked, the reason, the usage record. That makes strategies comparable later.

**Core strategy (`llm`)**: one structured-output call through `gateway.complete` (kind `router`, billed to the org's credential), `effort: "low"`, JSON Schema output whose `handle` field is an enum of the candidates. The model is `organization_settings.router_model` or the deployment's `ROUTER_MODEL`. Message text is wrapped as data. Malformed output means nobody answers. Since ADR 0074 it is the organization's small model on any of its keys, with the least thinking it allows, and malformed output is a failure.

**Failures**: transient errors rethrow (outbox retry); permanent ones (no credential, rejected request) or the final attempt store a decision with `error` and pick nobody. Replaced by ADR 0074: a failing step is noted in `error` and the next one decides in the same job, and rules in code end the chain.

**Other strategies** plug in through `JobDeps.router.strategy`. Planned: an optional external classifier (TypeSafe Jev, `POST https://api.typesafe.ai/v1/systemone`, one question per candidate plus "does this need any agent?"), enabled by env only (or, since ADR 0073, by the key the installation's owner adds in Settings), never required, and recording its usage like every other model call. Since ADR 0074 it is the first step of the router's chain.

## Addendum (2026-10-20): up to four agents

Since ADR 0034 (2026-10-17) policy picks at most `DEFAULT_ROUTER_POLICY.maxAgents` (4, `packages/engine/src/router.ts`) instead of 2, so a message to the room can wake several agents; an agent's own message still brings in at most one.

## Addendum (2026-10-28): one agent unless it is for every agent

Up to four agents meant every agent that could help took a question with one answer: "how many subscriptions today?" woke the PM and the researcher, who ran the same query and posted the same list. Each step now also says `for_everyone`, the probability that the message speaks to all the agents and each one has its own answer (the small model and the plan in the answer schema, Jev as a Noul with two or more candidates). `selectAgents` picks the best agent alone unless it is at least `FOR_EVERYONE_THRESHOLD` (0.5); then up to `maxAgents`. A step that doesn't say means one.

## Addendum (2026-10-30): the conversation before it, and a person's messages in a row

"boa tarde walter" and, a second later, "como esta hoje" in #general: the first got "No agent will answer without an @", and the second woke Ada, who had spoken there a few minutes before to someone else. Each message was decided alone, with the six messages before it, and "whoever spoke last here" gave Ada the follow-up's lower bar.

1. **What the router reads** (`ROUTER_SLICE` in `packages/engine/src/router.ts`): the channel's newest 12 messages (or the thread's, after the message it is under) from the last 30 minutes, oldest first, each cut to 500 characters, the oldest dropped past 4,000 in all. At most about 1,500 tokens: under US$ 0.0002 a decision on Jev or Claude Haiku 5.5. Each message says its author (a person by name, an agent as `@handle`) and who it names by @ or by name (`names`: a whole first name or handle of a person of the workspace or of an agent there, any case and accent). What it decides on is marked: `<message>` for the small model and a plan, `latest_message` for Jev.
2. **A person's messages in a row get one decision** (`ROUTER_QUIET_MS`, 2.5 s, set by the server in `apps/server/src/engine.ts`): a person's message waits until 2.5 s after it was written. When the same person's next message in the same place (the channel's timeline, or the thread), before anyone else's, is one the router decides on itself, its job stops (`continued`: no decision, no receipt) and that one decides for both, one per line in what it decides on, with everyone they name. Only a message the router decides on itself (`routable`) is part of a run, and any other ends it on both sides: one that mentions an agent (it starts its own runs as before), an answer to an agent's question, or one delivered to a run in progress. The message right before such a one is decided alone: "boa tarde walter" and then "@ada como está hoje" give the greeting nobody, and Ada answers the mention. What it decides on stays within the 4,000 characters a step reads of it (`ROUTER_MESSAGE_CHARS`), as one message did: the message takes what it needs, and the lines before it are cut to 500 characters each, the oldest left out first. "Responder agora" decides the message it is pressed on alone, at once. The wait holds a worker slot for at most 2.5 s, like a Jev call; a delayed job of its own is the upgrade if routing ever runs short of slots. An agent the router picks starts up to 2.5 s later than before.
3. **Who a person speaks to** is whom their message names, else whom their messages right before it named (same place, within the 10 minutes of continuity, nobody else in between). When that is a person and no agent, no agent continues with them: no continuity hint, no lower bar, no short follow-up, and R3 of ADR 0074 doesn't pick. A reply to an agent (R1), also one followed by more messages of the same person, still goes to it. A message that names a person in passing ("e o walter?" to the agent just talking) is decided at the normal bar too.
4. **The rules, in every step's words** (the small model's and a plan's system prompt, Jev's questions): messages a person sends in a row continue the same address; a message to a person, by @ or by name, is for that person; greetings and small talk between people get no agent; an agent answers only when the message speaks to it (by @, by name or by its role), asks it or anyone something it can help with, speaks to the agents as a group, or continues a conversation it was part of; when in doubt, nobody, and the receipt offers "Call an agent" as before. A person alone in a channel with its one agent is told to every step (`aloneWith`): what they write to the room is for it, as R2 says. The modes stay: a DM's agent answers every message without the router, and an agent with auto-reply off answers only an @mention.
5. **Still one call per decision**: Jev's one request with its questions, one small-model call, or one plan route. A run of messages costs one call instead of one per message, and reads no more than one message did (about 1,300 tokens).

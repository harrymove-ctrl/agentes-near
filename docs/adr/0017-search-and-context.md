# 0017. Search, derived context and a self-improving memory loop

- Status: Accepted
- Date: 2026-10-14

## Search

`search_documents` is the core index: one row per message, context item, issue or file, fed by outbox jobs (`search.index`, `search.reindex`). Full-text uses a generated `tsvector` with the `simple` configuration (Portuguese and English alike); vectors (`vector(1024)`, HNSW cosine) are optional. A query runs both rankings and fuses them with reciprocal-rank fusion plus a small recency bonus; vector hits beyond cosine distance 0.75 are dropped. Visibility travels with each document: `channel_ids` must ALL be visible to the reader (most restrictive of the sources; empty = whole org), enforced in SQL. Readers: a person's channels; an agent's channels, resolved at query time. `SearchIndexResolver.forOrg` lets the Cloud swap the backend per org.

Embeddings go through the Model Gateway (`gateway.embed`, usage kind `embedding`, no agent). Providers: `EmbeddingProvider` (Voyage adapter via REST, optional by env; a deterministic fake for tests). Without one, search is full-text only.

## Context items

`context_items` holds derived context and agent memory in one table: `thread_summary`, `period_summary`, `decision`, `fact`, `preference`, `open_question`, `entity_profile`, plus `note` and `lesson` (owned by an agent, or shared as a team playbook when `agent_id` is null). Items are never overwritten: a new version supersedes the old (`superseded_by`, archived), and only people delete. Each item carries `source_ids`, visibility (`channel_ids`), `trust` (`high` from org members; `low` when any source came from outside the team: webhooks, tool output), `evidence`, `verified`, `confidence`, `relevance`, `recurrence` and `pinned`.

## The loop

1. **Capture** (`context.reflect`, when a thread grows by `REFLECT_EVERY_MESSAGES` or idles for `REFLECT_IDLE_MINUTES`): the summary model reads the thread, reactions on agent replies, and the outcomes of its agents, and returns structured items citing refs (`m3`, `o1`). Code, not the model, derives everything that matters: visibility (the thread's channel), trust (untrusted if any source is), and evidence per source: a person's message is `human`, another agent's message is an `agent` claim, the subject agent's own message is `self`, a recorded outcome about that agent is `outcome`, and people's 👍/👎 on an agent reply are `human`. Items without valid sources, with credentials, or that try to change permissions/approvals are dropped. Usage kind `summary`, billed to the org. Bounded by `REFLECT_MAX_PER_THREAD`; it reads messages and outcomes only (never its own outputs) and posts nothing, so it can't extend agent chains.
2. **Consolidate** (inline on every write, and `context.consolidate` daily): same subject and near-identical content (word Jaccard ≥ 0.8) merges (evidence united, recurrence +1); a different claim on the same subject supersedes the old one, keeping history. Daily: dedupe, relevance decay for unused items (×0.95 after 7 days), archive below 0.1 after 30 days (pinned never), refresh weekly period summaries of busy channels, entity profiles grow incrementally.
3. **Learn from feedback**: refused approvals (with the reason) become an `approval_refused` outcome plus a verified lesson; a person's correction of an agent reply becomes a verified lesson; 👍/👎 adjust the relevance of the items the run used and feed the next reflection; edits by people create new versions with human evidence.
4. **Outcomes** (`outcomes`): ground truth tied to agent, run and step: tool results (e.g. a successful merge records `pr_merged` with the PR as subject), approvals, and webhooks (reverts, rollbacks, error spikes, reopened issues). `attributeSubject` ties a later outcome to the agent behind the earlier one.
5. **Trust weighting**: outcome > human > agent claim > self-assessment. Verified = at least one outcome or human piece of evidence. Agent claims alone stay `unverified` (used as labeled hints); an agent can't confirm its own lesson; agents agreeing with each other never verifies.
6. **Promote with a human gate**: a verified, high-trust item seen at least twice (or with confidence ≥ 0.8 and relevance ≥ 0.7) produces a `context_proposals` row: the target text (agent instructions, or the org context for shared items) with a "Learned" bullet, stored as a line diff against the SHA-256 of the current text. The agent's owner or an admin (org context: admins) accepts or rejects; accepting a proposal whose base text changed marks it stale. Nothing is applied automatically.
7. **Use**: the run's context adds a "What you know" block after the cached prefix (org context + instructions stay first for prompt caching): pinned items always, the agent's own notes and lessons, shared lessons, and items retrieved for the trigger message (hybrid search with any-word matching + relevance), each of the top 5 hits followed by up to 3 items the memory judge linked to it (`related_ids`, ADR 0028; same visibility filter), within a character budget. Only items whose every source channel is the run's channel or a public one are injected, so private context never leaks into another channel. Unverified items are labeled hints; untrusted items are labeled data. Inclusions are logged (`context_usage`) and raise relevance. Long threads use their summary instead of the full history.
8. **Agent tools** (Tool Gateway): `search_context`, `get_summary`, `expand` (`context:read`), `remember`, `forget` (`memory:write`).

## Guardrails

Memory never carries permissions, scopes or secrets: credential-like text and text that tries to bypass approvals or grant permissions are refused at write time (people, agents and reflection alike). Permissions come only from `agent_scopes` and approvals. Low-trust items are never promoted. Everything is listable and editable by people (`/context-items`, `/proposals`). A person sees only items whose every channel they can read (an agent's memories page and the old versions it quotes too), and a proposal only when they can see every item behind it; admins see every proposal. An agent's owner who isn't an admin edits, archives or deletes only the items they can see; the others answer "not found".

## Addendum (2026-11-01): agents reuse past work

An agent that solved something by figuring it out (a new API, several tries, a key asked with `request_secret`, a script) used to start over when asked the same thing again: reflection reads only the thread's messages (not the tool calls, where the address and the command are), `remember` saves only what a person asks for, `search_context` didn't see tool calls, and nothing told the agent which secrets its computer already holds. Now, with no extra model call on ordinary turns:

1. **Look first.** "How you work" says to check memory and `search_context` for how the same or a similar task was done before, and to reuse the method, the script and the secrets already held.
2. **`search_context` covers the agent's own earlier tool calls**: without `kinds`, it also matches the query's words against the inputs of the agent's own `tool_call` steps of the last 90 days in the channels its search may read (the run's channel and its public ones), and lists the best five with whether each worked (`[your earlier step]`). A step must match two of the query's words (one when the query has one), common words left out, so an unrelated search carries no steps. Words, not embeddings: a call's input is code and addresses. Steps are not indexed (an embedding per step would cost more than it saves); the scan is bounded by the agent's own runs.
3. **`save_how_to`** (`memory:write`, granted by default): after something that took figuring out, the agent saves a short how-to on its own (title + the exact way: address, command, the secret's name, where the script is). It is the existing memory: a `note` scoped to the agent (`created_by_kind = agent`, self evidence), with the run's channel as its source (`channel_ids = [channel]`): one worked out in a public channel reaches every run of the agent, one from a DM or a private channel stays there, as any other private context. It is `trust = high` only when a person is behind the run (the same check as `remember`); a routine's or a webhook's run may have read it in a page or an email, so it is kept at `trust = low` and shown as untrusted data. How-tos stay out of the agent's own-items slot of the prompt (which holds the rules people asked it to keep) and come in only when the request matches them, so many saved how-tos never crowd those rules out. The description asks for the method only, without the conversation's private details, and the credential guard still refuses keys. Saving under the same title supersedes the old version. No receipt card: it is the agent's own note, listed and editable on its memory page. Memory retrieval puts the items matching the trigger in the run's prompt, so the next similar request reads it. "What you can do" asks to keep scripts it will run again in `scripts/` in its folder (or the shared folder, when the computer has one).
4. **Secrets on your computer**: the run's context lists the secrets delivered to the computer its tools act on (in a mission's thread, the mission's, ADR 0029) and not removed (name and where: an environment variable, a file, a site's password), never values, and says not to ask for them again unless one is refused or stopped working.

Reflection was left as it is: the agent knows the exact details when it finishes, a background pass reading tool calls would be a second model call to rebuild them.

## Addendum (2026-11-03): reading a conversation, and where an agent was asked

ADR 0138 adds `read_conversation` (`context:read`, on demand): a message by id or link with those around it, or a
channel's or thread's messages, each with who wrote it, where and its link, within the same channels as
`search_context` (the run's channel and the agent's public channels; the agents' DM keeps its per-person rule).
`search_context` message hits now name their author, place and link. One narrow exception: from a conversation where
the agent sent a message because of another (`send_dm`'s `meta.agentDm`, `post_message`'s `meta.postedFrom`, with
`fromMessageId`), that origin message alone may be read, quoted and linked when the person behind the run is in its
conversation and, unless it is a public channel, so is every person in the conversation the agent speaks in; otherwise
its later runs learn only who asked, and the channel only when it is public.

## Addendum (2026-11-06): what a person says in a DM stays in that DM

An agent's reply in a channel is read by everyone there, so a DM reaches a conversation only as far as code lets it:

- "Your recent work with X in other conversations" lists a DM's or a private channel's work only when every person in
  the conversation is in it too, the rule `originNotes` already followed. A public channel's work always shows. Files
  still come when the person asks (`list_artifacts`, `share_artifact`).
- The origin note of a message sent from a DM names nobody to someone outside that DM: "Someone asked…".
- `remember` with `everywhere` in a DM saves a person-scoped item: it reaches that person's runs, in any conversation,
  and no one else's. Elsewhere it stays agent-wide.
- Memories from a DM are never proposed for an agent's instructions or the org context (`proposeFromItem`): the
  proposal would show them to who decides, and once accepted every run reads them. Neither is a person's preference.
- A person's preferences stay theirs: `consolidateItem` merges them only within one person, and a mission's
  `get_context` passes `personMayRead`.
- A consulted agent reads the person's DM with it only when everyone where they asked is in that DM: the asking agent
  relays the answer there.
- `meta.agentDm` and `meta.postedFrom` carry no requester: they reach every reader, and nothing read it.
- `send_dm` no longer tells the agent to say who asked and why when the asking was in a DM, and one line in the prompt
  states the rule.
- Migration 0236 gives memories already saved "everywhere" from a DM back to the person who said them.
- "Everyone" there is everyone who reads the conversation (`channelReaderSql`, the rule of `requireChannelAccess`):
  its members, administrators in any channel they aren't in (ADR 0151), and a task's readers in its conversation.
  The recent-work block and `peopleAllIn` (origin notes, `originReadable`, a consulted agent's DM) count them all.

Not enforced by code: what the model itself writes in a `send_dm` or `post_message` from a DM, a person's `rule` (it
holds for all the agent's work when its giver decides the agent's approvals, so its text reads in others' runs), and
what a computer brain keeps in its own files. Those rest on the prompt line. A preference kept "everywhere" from a DM
still reads in that person's own runs in a channel, where everyone reads the reply, and in the memory list of who holds
`review_memory`.

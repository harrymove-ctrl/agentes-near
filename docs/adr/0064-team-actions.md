# 0064. Team actions: every outside action is searchable, and agents check before repeating one

- Status: Proposed
- Date: 2026-10-24
- Builds on: ADR 0053 (who is behind a run, the policy table, the routine room, the command policy on every brain), the hybrid search (`search.ts`, `packages/adapters/src/search.ts`)
- Code: `packages/engine/src/team-actions.ts` (targets, commands, the check, the record, search), `tools/gateway.ts` (where it runs), `executor.ts` (the reply's `meta.teamChecks`), `management.ts` (the switch), `packages/db/src/schema/team-actions.ts`; web `components/TeamChecks.tsx`, `pages/SearchPage.tsx`, `pages/SettingsPage.tsx`

## Context

A person running several agents on the same kind of work hits the same wall: the agents don't see each other's work. A user of another product put it this way: with four outbound agents, they had to build a shared tracker by hand "so my 4 outbound bots don't email the same company twice". The same happens outside sales. Two agents answer the same customer. Two routines post the same report. An agent opens a second PR for a bug a teammate is already fixing.

What we have doesn't cover it:

- **Shared channels.** Agents in the same channel read each other. Routines don't: each one works in its own routine room, and other runs' searches never reach it, on purpose (`agentSearchChannels`, `search.ts:192`).
- **Org memory.** The reflect job extracts facts and entity profiles after conversations. It is late (two agents acting minutes apart both miss it) and it keeps facts, not actions.
- **Search.** `search_context` covers messages, memory items, tasks, files and wiki. The actions themselves are not indexed. An email an agent sent without writing about it in the chat can't be found.
- **Tasks.** The board answers "who is on it" for work that is a task. One email, one reply or one post doesn't become a task, and it shouldn't (hundreds of cards).
- **`remember`.** It writes to the agent's own memory, and only when a person asks.

Nothing keeps the actions themselves, and nothing looks at them before an agent acts.

Everything with an effect outside already passes through us:

- API brain tools, and the MCP tools Claude Code and Codex use, go through the Tool Gateway. `run-policy.ts` already classifies them, and `external` is the class of writes to connected apps.
- Claude Code asks the server (`permission_prompt`) for every command that isn't a plain read (`localVerdict` in `command-policy.ts`).
- Codex's sandbox has no network. A command that needs it asks the server.

So `gh pr create`, `git push`, `curl -X POST` and a connector's `send_email` all reach a point where we can record them and check them.

We don't want this in the prompt. A team log in every context grows without bound and is almost always irrelevant. It should be searchable, and it should reach an agent only at the moment it is about to repeat something.

## Decision

### 1. Every outside action becomes a short record

A new table, `team_actions`:

| Column | What |
|---|---|
| `id`, `org_id`, `created_at` | as everywhere |
| `agent_id`, `run_id` | who did it, in which run |
| `channel_id` | where it belongs, for visibility (see §3) |
| `source` | `tool` (the gateway ran it), `approval` (a person approved it, `executeApproved`), `command` (`permission_prompt` allowed a computer command) |
| `tool` | the tool or command name (`mail_sales_send`, `gh pr create`) |
| `summary` | the app and what it was about (`GitHub · Corrige login com Google`), or the command line, credentials masked, cut to 300 characters; never a body |
| `targets` | normalized identifiers of what the action touched (see §2), at most 10 |
| `reason` | the `why` the agent gave when it acted after a notice (see §4), else null |
| `ref` | a command waiting for a person: its prompt's request id (the row goes away if they say no) |

Indexes are `(org_id, created_at)`, `(org_id, ref)` and a GIN index on `targets`. There is no foreign key to the agent: the team's history stays when an agent is deleted.

When a row is written:

- **Gateway:** after an outside call succeeds: the policy's `external` class and `open_pull_request`. A mailbox counts only when it sends (`mail:send`); moving, labelling or deleting mail touches nobody outside.
- **`executeApproved`:** after an approved action runs.
- **`permission_prompt`:** when it allows a command that leaves the computer:
  - `gh` writes (`pr create`, `pr comment`, `pr merge`, `issue create`, `issue comment`);
  - `git push`;
  - a `curl`/`wget`/`http` call that isn't a GET.

  For computer brains we see the permission, not the outcome, so the row means "allowed". For our purpose that is close enough. A command that waits for a person (a mission's command card) is recorded while it waits, with its request id in `ref`, and removed when the person says no or it expires.

Reads, searches, internal changes (tasks, memory, wiki, Drive) and posts in our own chat are not team actions. They are already visible where they happen.

Each row is indexed as a new search kind, `action` (`registerDocumentBuilder("action")`, through the outbox like the others). Its body is the summary plus the targets.

### 2. Targets: identifiers, not meaning

`callTargets` (`team-actions.ts`) reads the strings in the call's input and keeps what it can recognize. Free text (body, text, message, title, subject…) and the sender (`from`) are never read: a name in a message isn't who it goes to.

- email addresses (lowercased);
- phone numbers (digits only, with the country code; BR is the default when none is given);
- URLs (scheme, host and path, lowercased, without query or fragment);
- GitHub references: `owner/repo#123` for issues and PRs, `owner/repo@branch` for branches. For commands, the repository comes from the mission's worktree or `-R`.
- our own ids that leave with the action (a task id in a PR body).

Field names help: `to`, `cc`, `bcc`, `recipient(s)`, `email`, `phone`, `number`, `chat_id`, `url`, `repo`, `issue`, `pull_number`, `branch`. An action where nothing is recognized is still recorded and searchable by its summary. It just never triggers a check.

Matching by meaning ("a second PR for the same bug" with no shared identifier) is not in this version (see "Later").

### 3. Visibility: search by channel, the check by org

- **Search.** An action is visible to whoever can see its channel: people through ⌘K, agents through `search_context` (`agentSearchChannels`, unchanged).
  - A run in a channel or DM: that conversation.
  - A routine's run: where the routine delivers (`routines.target`). For a channel target, that channel. For a DM or artifact target, the DM between the agent and the routine's creator. Never the routine room.
- **The check (§4)** looks across the whole org, because a duplicate is a duplicate even when the first one happened somewhere the second agent can't see. When the matching action is outside what the acting agent can see, the notice says only that someone on the team did it and when. It gives no name, summary or place.

### 4. The check: one notice, at the moment of acting

Before an outside action runs, the gateway (and `permission_prompt` for commands) runs one query:

- the same org;
- `targets` overlapping the call's targets;
- created in the last 30 days;
- not from this run.

It takes at most 3 rows, newest first.

- **Nothing found:** the call proceeds. Nothing is added to the model's context.
- **Found:** the call is held once per (run, target), as an error result with the code `team.action_seen`. The agent gets a short answer instead of the action:

  > Not done: the team already did this.
  > - Theo already acted on compras@cafebrasa.com.br 2 h ago in #vendas: (summary)
  >
  > Don't repeat it. If it's still needed (a follow-up, a correction, an answer to a reply), call it again with a `why` saying why. Say in your reply what you didn't do and why.

  When the earlier action was by the same agent, the line starts with "You". When it is outside the agent's view (§3), it says "Someone on the team already acted on … (in a conversation you can't see)", with no name, summary or place.
  - The summary goes inside `untrustedBlock`, because a summary can carry outside text.
  - The next outside call on one of those targets in the same run goes through. A `why` in its input is taken out before the tool's schema is checked (the tool never sees it) and kept on the new row (`reason`); without one, the reason is "went on after the notice". Computer commands can't carry a `why`: the same command asked again goes through.
- **Approvals.** The check runs before an approval card is created, so a person is never asked to approve a duplicate the agent hasn't seen.
- The hold is a notice, not a block. The agent may have a good reason: a follow-up, a correction, an answer to a reply.
- A check that fails for any reason (the database, a bug) never stops the action: it only misses a notice. Recording never fails the call either.

Each held call is a row in `team_action_checks` (`org_id`, `run_id`, `agent_id`, `message_id`, `tool`, `targets`, `matches` as shown to the agent, `outcome` `held` or `repeated`, `reason`). It is both the "already told" state of the run and what the reply shows (§5).

### 5. What people see

- **In the chat ("B · Explica" in the prototype).** When the run posts its reply, its `held` checks not yet on a message go into the reply's `meta.teamChecks` (agent and channel names resolved then) and get its `message_id`. Under the message, each is a row in the receipts' style: "Não repeti: Theo já tinha feito isso com … há 2 h", the summary and the channel, and "Ver", which opens the conversation where it happened. The sentence is the app's (pt-BR and en), never the model's. A check the agent went past (`repeated`) shows nothing: it did act.
- **In search.** "Buscar no workspace" gets a "Team actions" tab and group ("Ações do time"), shown above messages and context. Each row shows the summary, who did it, where and when. Agents find the same with `search_context` (kind `action`).
- **On the phone app.** The same row under the reply (`features/chat/TeamChecks.tsx`) and an "Ações do time" group and chip in Busca. The switch stays on the web, with the other workspace settings.
- **Settings.** The workspace settings get one switch, "Agents check what the team already did before acting" ("Agentes conferem o que o time já fez antes de agir"). It is on for every workspace (new ones and existing ones) and only admins change it.
  - Off means no checks and no notices.
  - Actions are still recorded and searchable, so turning it back on works right away.

  It is stored as `organization_settings.action_check boolean not null default true` (an org without a settings row counts as on).

### 6. Cost

- **Writing:** one row and one indexing job per outside action. Outside actions are a small part of all tool calls (dozens per agent per day).
- **Checking:** one indexed query per outside call. There is no model call.
- **Tokens:** zero when nothing is found, and one line (about 60 tokens) when something is.

## Later

- **Matching by meaning:** "the same bug" without a shared PR, branch or task. Full-text and vector candidates, then a calibrated Jev question ("is this the same work?") only when there are candidates, within a 1 s budget.
- The approval card showing the earlier action, for an action that becomes a card after the notice.
- **"C · Pergunta" for actions that can't be undone:** an email to a customer, a refund, a public post. The agent asks the person instead of deciding alone.
- **Claims:** "I'm on X until Friday", a hold an agent takes before acting.
- A setting for the 30-day window, and retention rules for `team_actions`.

## What we looked at

- **A team log in every prompt.** It grows without bound, is almost always irrelevant and breaks the stable prompt prefix (ADR 0050). Rejected.
- **Agents writing to a shared memory themselves.** Like the user's hand-built Notion tracker, it depends on every agent remembering to write and to read. Ours is written by the system from the actions and read by the system before the next one.
- **A new screen** for the log, or a companies page. The prototype tried a "Caderno do time" and an "Empresas" list. Both were too specific (sales) and a new place to keep track of. Search plus a notice in the chat cover it.
- **Tasks for every action.** That would mean hundreds of cards.

## Consequences

- An agent may hit a notice for a legitimate follow-up. It answers with a `why` and goes on: one extra tool turn.
- A shared address (`support@` of a customer contacted twice for different reasons) produces notices that don't matter. The cost is the same extra turn.
- An agent could learn to add a `why` to everything. A short behavior eval measures how often a notice is respected, before and after prompt changes.
- For computer brains, a recorded command means "allowed", not "done". A command that failed still counts for 30 days.
- Actions done by people outside our app (a person emailing from their own Gmail) are not seen.
- Tests:
  - target extraction;
  - the gateway's hold, `why` and repeat;
  - the command path;
  - visibility (hidden details);
  - the switch;
  - the search builder.

  They run on PGlite with the fake provider.

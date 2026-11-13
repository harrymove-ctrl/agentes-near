# 0034. Agents talk to each other: private consultations and chiming in

- Status: Accepted (built; UI pending a prototype). Amended 2026-10-31 by ADR 0089: an agent's mention of another agent is no longer limited to once in a row (the judge reads every one, with the message it answers; the stretch limits stop a loop); §4's chime-in rule stays. Amended 2026-10-31 by ADR 0095: notes are tracked like questions, nothing expires while a colleague works, and what an agent hands on rolls up into its answer (addendum below)
- Date: 2026-10-17
- Extends: ADR 0013 (router), ADR 0015 (approvals), ADR 0032 (agent engine)

## Context

Agents only talked to people. Another agent woke up only through an explicit @mention that a judge read as "act now", once in a row, and the router ignored agents' messages (ADR 0013). Three problems showed up in #general on 2026-10-17:

1. "theo conta pro pessoal…" got no answer. Jev scored Theo 1.0 ("best @theo, confidence 0.99") but its separate "should any agent reply?" Noul said 0.22, and `selectAgents` treated that as a veto.
2. A dev agent that needs something from the infra agent mid-task has no way to ask and wait. It can only post an @mention and end its run.
3. "@Theo" sent alone after the request was read as an empty message: the prompt said to answer only the current message.

Agents should be able to ask each other privately, and a message to the room may wake several of them.

## Decision

**1. `ask_agent`: a private consultation that the asking run waits on.**
- A built-in tool (no scope) with `agent` (handle) and `question`. Code allows only an active agent of the org other than the asker, one the person behind the run can talk to, one with an AI to think with (ADR 0061: its run would only fail with `no_ai`, so the tool says so and who can connect one, and `tell_agent` too), and one not already in the chain.
- The question is posted in the **private DM between the two agents**: a `dm` channel with key `a:<id>|a:<id>` and the two agents as its only members. No person reads it or sees it in their DMs. The consulted agent runs there (`trigger = dm`) with its own scopes; nothing is granted. Sensitive actions still need a person's approval.
- The asking run pauses on the call's `waitId` (the generic wait of `run-resume.ts`, as for missions). When the consulted run ends, `onConsultedRunFinished` takes its reply and resumes the asker with `@infra answered: …`. A failed run resumes it with the failure. After `CONSULTATION_TTL_MS` (15 min) a worker resumes it without an answer.
- `agent_consultations` (migration 0064) holds the asking run, both agents, the DM, the question message, the consulted run, the wait, `chain` (the agents already in the chain), status and answer.
- Limits: no cycles (the consulted agent can't ask back anyone in `chain`) and at most `MAX_CONSULTATION_CHAIN` = 2 agents deep (Dev → Infra → one more). Inside an agents' DM, `ask_user` is refused (no person reads it) and agent messages start nobody by mention.
- The asker's next reply carries `meta.consulted` (`agentId`, `consultationId`, `status`) for the "message from @infra" card, and `agent.consulted` is published on the asker's channel.

**2. The router may pick a clear choice even when "needs any agent" is low.** `RouterPolicy.clearPickScore` (default 0.8): an agent scored this high answers even when the need-any-agent score is under the gate.

**3. A message to the room may wake up to four agents** (`maxAgents` 2 → 4). Each agent is still scored on its own and must clear the threshold.

**4. Agents' messages go through the router too (revises ADR 0013).** An agent's message without mentions, in a channel and outside a mission's thread, is routed with a stricter policy:
- the author is never a candidate, and neither is any agent that already spoke in the recent history;
- at most one agent is picked, and only a clear pick (`AGENT_CHIME_IN_SCORE` = 0.75);
- never from an answer to an answer (`hop >= 2`);
- no continuity;
- since ADR 0074 (6), only Jev or a small model reads it: never a plan, never a rule.

Receipts are published only when someone is picked.

**5. Prompt.** When the current message only calls the agent (its handle or name, or a nudge such as "e aí?"), the agent answers the same person's previous message. The "other agents here" line tells the agent to use `ask_agent` instead of telling the person to go ask.

## Consequences

- Costs go up only when agents are actually picked. Every agent message without mentions costs one router call (Jev ≈ free, LLM fallback a cheap model). Consulted runs bill to the consulted agent's budget as usual.
- The agents' DM is invisible in the app for now. An audit view ("see the conversation") can come later from `agent_consultations`.
- The UI for the "message from @agent" card and the grouped "Theo, Iris and 2 more are working…" indicator comes after a prototype is approved.
- A consulted run that pauses for an approval keeps the consultation open; the asker resumes when that run ends or when the 15 minutes run out.

## Addendum (2026-10-18): addressees, no duplicate requests, on-behalf-of authority

Incident (#tech): "@atlas, when an error comes in ask @ada to analyze it and write a technical analysis on the issue" started both agents (each @ starts a run). Atlas updated its routine and answered. Ada, in parallel, asked Atlas privately to update the routine; in that consultation Atlas's routine tools refused ("only a person's direct request"), and its reply was surfaced next to its own "done". Ada then said the two answers contradicted and that it couldn't read Atlas's routines.

**1. Addressee vs referenced.** A person's message that mentions two or more agents of the channel is classified before the insert (`classifyAddressees` in `messages.ts`, `personMentionAddressees` in `judge.ts`): one Noul per mentioned agent, "is the person asking this agent to act or answer now?". Agents at or above `ADDRESSEE_THRESHOLD` (0.5) get a run; the others are *referenced*: stored in `meta.referencedAgentIds`, no run, no steering of their active run, excluded from the `message.posted` safety net. The acting agent's prompt says who is only mentioned. Fail-open: no judge, an error, `ADDRESSEE_TIMEOUT_MS` (2.5 s), or nobody above the threshold keeps the previous behaviour (every mentioned agent acts). One mention never calls the judge. The decision is stored in `routing_decisions` (`addressees-<judge>`). Receipts carry `referenced` (list API and `message.routed`); the app shows "Only mentioned" and never "nobody will answer" because of it. A mention run now also hears which other agents got the same message (the routing decision's `selected`), as router runs already did.

**2. No duplicate requests.** `ask_agent` checks the target agent's runs first: a run on the asker's trigger message (active or done), or an active run in the asker's thread, means the person already asked it. No consultation is created; the asker gets "@x is already working on this person's request (run …); wait for its answer" or the answer it already gave (`data.duplicateOf`). The tool description and the "other agents here" prompt line say not to relay to an agent what the person asked it directly.

**3. On-behalf-of authority.** Tools that need a person's request (routines and reminders, `schedule-tools.ts`) resolve the person with `personBehindRun` (`requester.ts`): the trigger's author when a person wrote it; for a consulted run, the person at the root of the chain, following only consultation links, each checked against `agent_consultations` (message, asking run). No person at the root, no authority. The consulted agent still acts within its own scopes and the person's permissions (`requireRoutineEditor`). A routine or reminder created inside a consultation lands in the conversation where the person asked (`consultationOrigin`), not in the agents' DM. The consulted agent's prompt says it acts for the person behind the request.

**4. Reading across agents.** `list_routines` takes `agent` (a handle, or `all`) and `id`: any agent reads the org's routines to verify. Instructions are hidden when the routine answers in a private conversation that neither the reading agent nor the person is in; agents the person can't talk to are left out. Editing stays with the routine's own agent; `update_routine` on another agent's routine is refused with a clear message. `issues:read` joins the default scopes of new agents (`issues:write` already implied it).

**5. Surfacing.** With 2 and 3 the contradictory consultation reply no longer happens. Not done: replacing a surfaced consultation card with the latest state when the consulted agent's direct answer in the channel says otherwise.

Evals: `ops-addressee-routine-mentions-other-agent`, `ops-consulted-on-behalf-edits-routine`, `dev-reads-other-agent-routine` (`packages/engine/eval/behavior-cases.json`; the harness now seeds other agents, routines and consultations).


## Addendum (2026-10-29): the questions inside the reply that asked

An agent that asks several agents in one turn (`ask_agent` is async) showed one "asking…" line at a time: the live state is kept per asking run, and only the answers that came back were visible, each as its own `consult_reply` card further down.

**1. The list.** `GET /organizations/{orgId}/channels/{channelId}/consultations` (`consultationsIn`) returns the latest 50 questions asked from the conversation, by asking run: who was asked, the question, `status`, `waiting` (`approval` or `input` while the consulted run is held on a person, `computer` while it waits for its computer to come back, which no person can move: read from `agent_runs.waiting_machine_id`, never the transcript) and, once closed, the answer, or the reason it couldn't answer. The question and the answer are cut to the lengths the `consult_reply` notice already shows in that conversation; nothing else of the agents' DM is exposed, and the same channel access applies.

**2. Events.** `agent.consulting` and `agent.consulted` stay as they were; `agent.consultation` (asking run, consultation id) says an open question changed without closing: when the consulted run stops on a person or on its computer, and when it goes back to work (an approval decided, a question answered, a secret given or declined, its computer back). Every resume passes through the executor's claim of a held run, which announces it for runs in an agents' DM (`announceConsultationChange`); the lookup reads only open questions (`target_run_id` has no index, and none was added). The apps reload the list on the three, and every 20 s while a question is out. A consulted run stopped while no worker executes it (queued, or held on a person or its computer) never reaches the end of a run, so `stopRun` closes its open questions at once for runs in an agents' DM (`onConsultedRunStopped`): the asker gets the usual `consult_reply` notice and `agent.consulted` (`failed`) instead of the 15-minute expiry. A running one is closed by its worker, and closing touches only open questions, so the asker hears it once; a run stopped because its questions expired finds none open, and a run its workspace stopped hands nothing on.

**3. The apps.** The reply of the asking run carries the questions as one more step of its work, the same tool block: "Perguntou a 3 colegas · 1 de 3" while answers are out (open), one line per agent (working, waiting for an approval or an answer, answered with the start of the answer, couldn't, didn't in time), each opening to the question and the full answer. A `consult_reply` notice folds away when the reply that asked is at most 3 rows from it (`CONSULT_NEAR_ROWS`, about what a phone shows above the box); farther up it becomes one quiet line, "Atlas respondeu à pergunta da Ada · Ver", that goes to that reply and opens its block at the answer, so an answer arriving always leaves a sign where the person reads; when that reply isn't loaded (not paged in, or older than the list) the notice keeps its card. The working line leaves out the "asking…" of a run whose block sits among the last rows (it shows every question with its clock); with the reply farther up the line keeps saying it. On the phone an answered line also shows the start of the answer. A question whose consulted agent waits for its computer reads "espera o computador voltar", still out but not on a person. Distances and "Ver" use the run's message that draws the block (the last on the web, the first on the phone); "Ver" scrolls there and briefly marks it, on the phone with a neutral flash on the block. A reply that already carries `meta.consulted` cards (the old waited path) keeps them, without the block. The block opens while answers are out and folds by itself once the last one is in. On the web the run's last message shows it, on the phone its first (its rows don't know their neighbours).

**4. A consulted agent asks the person where they asked.** Both tools were refused in an agents' DM (no person reads it), so a consulted agent missing a decision or a token could only answer without it. Now its questions (`ask_user`) and secret requests (`request_secret`), like its approvals, go to the conversation where the person asked (`consultationOrigin`), never to the agents' DM. The cards and their rows (`agent_questions`, `secret_requests`) carry that conversation, so the usual checks hold there: anyone who can read it answers the question, and only the person behind the run (`personBehindRun`, addendum of 2026-10-18 §3) gives the secret; either way the consulted run resumes in its DM and its answer goes back as before. This replaces "inside an agents' DM, `ask_user` is refused" (Decision §1) for consulted runs only: both tools are still refused there when the run answers no question (a note) or nobody is behind it (`consultedFor`). The consulted agent's prompt is unchanged (it still says not to ask the asking agent questions back): when it should ask the person instead is left for an eval.

Not done: the asker waiting for every answer before it goes on (each answer still wakes it), sending one answer ahead of the others, and asking again from the line.

## Addendum (2026-10-30): the two agents' conversation, opened

A question showed only its state, the question and the answer: what the consulted agent did to get there, and what it asked the person on the way, stayed out of reach, and an answer read without the conversation around it.

**1. Opened over the conversation, like a thread.** On the web each line of the reply's block opens the question in the panel the threads use (`.thread-panel` over the channel, the channel keeps its width under it): "Theo ⇄ Iris", the question as it went into their DM, what the consulted agent wrote there (its tool steps as the conversation draws them) and the cards it posted where the person asked (an approval, a question, a secret request), in order. "Ver" on an answer that arrived far from its reply opens it too, and so does the card of an answer (`meta.consulted` on a reply, a `consult_reply` notice kept as a card; since 2026-11-02, when unfolding a long question and answer inside the card stretched the conversation). In a thread view, which has no panel, and inside the panel itself, the line and the card still open in place. Since 2026-11-03 a thread no longer floats: it opens in the members column's place beside the channel (wider than it, no scrim, the members back when it closes; a full-screen sheet on a phone), while this question's panel still floats over the channel.

**2. Only this question's part of the DM.** `GET /organizations/{orgId}/channels/{channelId}/consultations/{consultationId}` (`consultationConversation`) returns, from the question on, the question message, the consulted run's messages in the DM (by `agent_run_id`) and that run's cards in the asking conversation; never the rest of what the two agents say to each other, which may be for other people in conversations this one can't read. The question comes first, then the latest 99 of the rest. A consulted run still at work takes the next question for the same person, which may come from another conversation (`startOrJoinRun`): when its run also answers a question asked elsewhere, its words in the DM are left out (they could be about that one) and the panel shows the answer alone, with its cards here. That check reads the questions posted in the DM since the run started (`meta.consultation`), not `target_run_id`, which has no index. Same channel access as the list; 404 when the question wasn't asked from that conversation. This widens §1 of the addendum of 2026-10-29 ("nothing else of the agents' DM is exposed"): whoever reads the asking conversation now reads what the consulted run wrote for that question, the same people who already see its answer and its cards, for the same person (addendum of 2026-10-18 §3).

**3. Read only.** People never write in the agents' DM. The panel says so and offers "Falar com o Theo", which closes it and mentions the asking agent in the composer; that agent owns the task and passes anything on (`tell_agent`). Writing to the consulted agent directly would leave the asker out of what changed, make a third place to talk (the conversation, its threads, the DM), and need a person in the DM and an authority for the run it starts. The messages in the panel act on nothing (no feedback, no menu, no reply); the cards keep their buttons, and deciding there decides everywhere.

**4. Whom a card helps.** The list carries `consultedRunId`: a card the consulted run posted where the person asked says "ajudando o Theo · Ver conversa".

**5. Freshness.** The DM sends the page no events: the panel reloads every 4 s while the question is out (`CONSULT_CONVERSATION_POLL_MS`) and, its key sitting under the list's, with the list on every consult event.

**6. On the phone.** Each line pushes a screen of its own (`/consultation/<id>?channel=<id>`), the same conversation read only under the pushed bar ("Theo ⇄ Iris", where it was asked). "Falar com o Theo" goes back with "@theo " in that conversation's field, taken once by its screen in view (`composer-request.ts`). "Ver" on an answer that arrived far opens it too, so does an answer's card (inside that screen it opens in place), and the consulted run's cards say whom they help, as on the web.

**7. Long messages between agents, in the conversation (2026-11-02).** An agent's message to another agent (its run was started by that agent's message: `meta.toAgent`, set by `runMessageMeta` on every message the run posts, except when the trigger is the agent's own notice; `meta.joined` before it; or it opens by mentioning another agent) shows its first paragraph and "Ler tudo · mais N linhas" once it runs past about 12 lines (`foldTalk` in `@agenteschat/client/lib/agent-talk`, lines estimated at the web's and the phone's widths). "Ler tudo" opens its thread: the panel beside the chat on the web (pressed while it shows), the thread's screen on the phone. In a thread view, and where a message is read only, it stays whole. Messages to people never fold.

Not done: the consulted agent's prompt still says no person reads the agents' DM; it should say that whoever reads the asking conversation reads what it writes for that question. That prompt change waits for an eval.

## Addendum (2026-10-30): archived agents are out of reach

Archiving an agent (`archiveAgent`) keeps its channel memberships, history and memory. Runs kept reaching for it: the channel's members in "Where you are" came from the memberships with no archived check, so the other agents saw it as present, with what it could do, and mentioned or asked it. `ask_agent` and `tell_agent` answered "There is no agent @x in this organization" both for an archived agent and for a handle nobody has.

**1. Rosters.** What a run reads of its channel's members leaves archived agents out, as "# Your team" and `find_agent` (`loadTeam`) already did. Archiving drops the cached members of the org's channels at once.

**2. One answer for a handle that reaches no agent** (`noAgentText` in `team.ts`), in every tool that takes agents' handles: `ask_agent`, `tell_agent`, `add_agent_to_channel`, `list_routines`, `offer_connect_ai`, and `create_channel`. An archived agent: "@x is archived: nothing you send reaches it. Don't try it again. If the work needs it, tell the person." Any other handle: "No agent @x here." with up to three closest handles (edit distance) among the agents the person behind the run can talk to, the ones `find_agent` lists.

**3. Named in what the run reads.** When the instructions, memory, wiki pages or the conversation name an archived agent's @handle, a "# Archived agents" block says it is archived, not to ask or mention it, and to tell the person when the work counted on it. A handle that a person holds now is not called archived (people's handles don't check agents'). The archived handles are cached per process like the team, so a run costs no extra statement on a warm server. The block is per turn, like the memory found for the trigger (ADR 0053 §10): a computer brain (Claude Code, Codex) reads it in "# This turn" on each run's first turn, so a session that started earlier, which reads its system prompt only when it starts, gets it too.

**4. Unchanged.** A mention of an archived agent already started nothing (the message insert, the mention dispatch and the router skip archived agents), and the "@" pickers on the web and the phone list only active agents (`GET …/agents`).

Not done: restoring an archived agent (there is no restore, so the refusal points to none). Issue assignees and calendar participants, where one field takes people and agents, still answer that nobody has the name. A computer brain's session keeps the "# Your team" it started with, so an agent archived since can stay listed there until the session ends; `ask_agent` and `tell_agent` still refuse it with the archived answer.

## Addendum (2026-10-31): hand-offs are tracked and come back (ADR 0095)

- **Notes are rows.** `tell_agent` writes a row in `agent_consultations` with `kind` `note`, in the same transaction as its message and `startOrJoinRun`, with its `chain`. What comes of it goes back to the sender's conversation as a `consult_reply` notice (`refs.kind` `note`), for the person behind it; the notes of one turn come back together (`reportHandOffs`). `MAX_CONSULTATION_CHAIN` counts note links too.
- **No expiry while a colleague works.** A question or note whose run is queued, running, waiting on a person or its computer, or waiting on what it handed on gets 15 more minutes each time, and that run is never stopped. Only one nobody started, or whose run is gone, expires.
- **Roll-up.** An agent that answers a question or note and hands part of it on keeps its answer open, and what comes back joins it before it goes back. Nothing starts a run in an agents' DM to read a result.
- **Cards.** A note's recipient answers the person behind it: its approval, question and secret cards land where that person asked.

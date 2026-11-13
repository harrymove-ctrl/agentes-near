# 0092. Agents propose changes to their teammates; whoever may make each change decides it

- Status: Accepted. Amended 2026-11-03 by ADR 0137 (§5): the right hand's own card changes a teammate's model, AI account, budget, owner, audience, channels, reply mode and archiving, each row decided by whoever may make that change, applied as them, out of date on its own and with Undo. Amended 2026-11-06 (§5): a change the person who asked may decide, in their own words, applies at once with Undo
- Date: 2026-10-31
- Extends: ADR 0017 §6 (proposals with a human gate), ADR 0081 (agents propose, a person decides), ADR 0085 (workspace roles)
- Code: `packages/engine/src/context/proposals.ts`, `packages/engine/src/context/tools.ts` (`propose_instruction_change`), `packages/engine/src/access.ts` (`resolveApps`, `withAccessLines`, `accessInputOf`), `packages/db/src/schema/context.ts`, `apps/server/src/routes/app/memory.ts`, `packages/client/src/lib/proposals.ts`, `packages/client/src/api/queries.ts` (`useCardProposals`, `useDecideProposals`), `apps/web/src/components/ChatCards.tsx`, `apps/web/src/pages/ProposalsPage.tsx`, `apps/mobile/src/features/agents/InstructionProposalCard.tsx`

## Context

People ask one agent to change the others ("adiciona nas instruções da Ada, da Lia e do Atlas: responder sempre em português"). The agent refused and said only the person could do it, because `propose_instruction_change` could only propose for the agent that called it. The proposal machinery already worked for any agent: a line diff against a hash of the text, stale when the text changed, decided by the agent's owner or whoever reviews memory, and a refusal that teaches the agent not to propose it again.

The owner decided on 2026-10-31 that the same card also changes teammates' roles and turns their apps on or off, not only their instructions.

## Decision

### 1. The tool

`propose_instruction_change` (under `memory:write`, a default scope) takes `target`: `my_instructions`, `agents` or `org_context`.

- With `agents`, `agents` names whose instructions change (1 to 25 handles, the caller may be one). `roles` gives an agent a new role, and `access` turns an app on or off for it: a connected app by its name, catalog id or `connector:<id>`, or a built-in scope such as `browser:use`. That is `request_permission`'s unit, and mailboxes and databases stay on their own screens. The caller's own apps are never proposed here: it asks with `request_permission`.
- `change` adds a rule under "Learned". With `replaces`, the exact text is swapped for `change`, or removed (with its line) when `change` is empty. A swap applies only where the text appears exactly once, and `$&` stays as written.
- It needs a person behind the run (`personBehindCall`), and only names agents that person can talk to (the audience rule). One agent out of reach refuses the whole card, naming it, and nothing is posted.
- The rows are built first, then checked once across the card: `checkContent` for secrets on every line they add, then one permission-text judge call on those lines, each line they take out (marked "Removes:") and the new roles. A swap's own words are only a fragment, so they are never what is judged: "Nunca faça" → "Faça" is judged as the line it makes.
- What can't be proposed is left off the card, and the tool result says why: the text to swap missing or repeated (with the agent's current text, up to 2,000 characters, to retry with), a rule already there, a text that would pass its editor's limit (instructions 50,000, the org context 20,000), a role already set, an app already on or off, or an app that would stay on through every tool being on or through its write scope.
- The description tells the agent never to say only the person can make the change, and who decides each kind of change. The result names whom each row the person who asked can't decide waits for.
- The memory update's text (the message body when the model writes nothing after the call) names agents by bare handle, so it mentions nobody.

### 2. One row per agent and kind of change

Each change is a `context_proposals` row: `agent_instructions`, `agent_role` or `agent_access` (new targets), or `org_context`. Every row keeps the agent that proposed it (`proposed_by_agent_id`, set null if that agent is deleted). A role row keeps the role in the diff and `proposed_text`; an access row keeps its lines (`access`: id, English label, on or off) and the hash of the agent's grants that `setAgentAccess` replaces (sorted keys, so their order doesn't matter).

All rows go in in one insert. The memory update carries every id (`proposalIds`), and `proposalId` is still the first, for older apps. A card reads its rows by id (`GET /proposals?ids=`, a card of one row too), since the list holds only the newest 200, pending ones first. Deciding a row reads it back by id.

### 3. Deciding a row

Each row is decided by whoever may make that change on the agent's page today:

| Row | Who decides | Applied by |
|---|---|---|
| Instructions | The agent's owner, or `review_memory` (unchanged) | The proposal itself, as before |
| Role | `manage_agents` | `updateAgent`, as the person |
| Apps | `manage_agents`; the agent's owner too when every line turns an app off | `setAgentAccess`, as the person |
| Org context | `review_memory` (unchanged) | The proposal itself, as before |

- A role or app row goes through the editors' own functions inside the row's transaction, as the person who clicked. So it never does more than they could on the agent's page, and the editors write their own audit rows (`agent.updated`, `agent.access_changed`).
- The row is stale when what it was made against changed (the text, the role or the grants), when the agent was archived or deleted, or when an app it turns on was disconnected since. Each row commits on its own, so a stale one never blocks the others.
- A role or app row is taken as proposed or refused: only instructions and the org context can be edited before accepting.
- Accepting writes `proposal.accepted` and refusing `proposal.refused` to the audit log, with the proposer.
- A refusal's lesson ("don't propose this again") lands on the agent that proposed it. It is the change itself (the lines it adds or removes, the role, the apps), whichever agent it was for, so the rows of one card make one lesson.
- An app turned off drops its scope with the tools turned on one by one (as the Access tab's "none"), or every grant on its connection. Denials stay either way, so the agent's owner may apply a row that only turns apps off.

### 4. The card

- One row: the existing card ("Theo propõe · instruções da Ada", "papel da Ada", "acesso da Ada"), with Aceitar mudança and Recusar, and Editar for text only.
- Several rows: "Theo propõe · instruções de 3 agentes" (or "mudanças em N agentes", or "mudanças para a Ada" when they are one agent's). Each text change shows once, over the agents it changes alike. Each row has the agent's face, name, its role as "Papel: Dev → Revisora" or its apps as chips ("Ligar: Linear", "Desligar: Usar um navegador", `request_permission`'s own words), and a switch. A row the viewer can't decide says whom it waits for, and its switch stays off.
- "Aceitar para todos" while every open row is chosen, else "Aceitar para N", and Recusar, both on the chosen rows. The client sends one request per row and refreshes once (`useDecideProposals`), the accepted agents' role and apps too. Rows that went stale meanwhile are counted in a toast.
- The diff is the design system's neutral one: added lines bold on a soft band, removed ones struck through.
- The phone gets the same card (no Editar). Before, it showed these proposals as plain text.

### 5. What the card never changes

Model, key, budget, owner, audience, channels, reply mode, the coordinator flag and archiving. There is no Undo: the person reads the change before accepting, which makes it their own edit, as Salvar on the agent's page.

### 6. The agent that proposed is told

A proposal suspends no run, so accepting one woke nothing, and the agent couldn't say it had happened.

- The agent's message that shows the card says which run proposed it and which rows are on it (`meta.memoryUpdates`, no new column). When the card's last open row is decided, the agent gets one `proposal_result` notice in the conversation where it proposed (`deliverNoticeToRun`, so a run still active reads it at its next step, and one that ended wakes), written after the row commits. Partial decisions on a card still end in one notice, whoever made them, and it says what became of each row: accepted (already in effect), refused (don't propose it again unless someone asks), or not applied because what it was made against changed. The notice names the run that proposed it (`refs.runId`), so the run it wakes goes on for whoever was behind that run (ADR 0053), on their AI: without it, the right hand's follow-up had nobody behind it and refused the workspace's plan.
- A card where every row went stale changed nothing, so it says nothing: the person who clicked already got the refusal.
- A proposal no message shows (a memory promotion, a card not posted yet) gets no notice. A failure to deliver never fails the decision.
- The rows of the card are locked while the notice is written, and `refs.proposalCardId` on the message means two last rows decided at once still send one.

## Consequences

- Nothing escalates. Applying calls the editors as the person, instructions grant nothing, and the permission-text judge refuses text that tries to change permissions or approvals.
- A version from before this one, run on the migrated database, reads a role or app row as an org-context proposal, and accepting it there goes stale (the hash is of the role or the grants), so it changes nothing.
- The migration adds two enum values and two columns (`0140_proposal_proposer`).

## Alternatives considered

- **A new card kind with Undo** (`meta.actionCard`, `team_change`): a second proposal system next to `context_proposals`, a 24-hour Undo of grants and its own states. The existing rows already give per-agent deciders, staleness and lessons.
- **An approval row**: all or nothing, no diff, and decided by `approve_actions` or the agent's owner, who may not edit instructions or give apps.
- **Only the coordinator may propose**: brings back the refusal customers hit, for every other agent.
- **"Passa a usar {{app}}"** on the chips: built-in scopes are named by what they do ("Usar um navegador"), which reads badly after it. `request_permission`'s "Ligar: …" reads well for both.

## Amendment (2026-11-06): what the person who asked may decide applies at once

### Context

A customer moving 18 agents clicked one card per change, for changes he had just typed himself and could decide himself. §5 said "no Undo, the person reads it first". The owner decided that when the person who asked may decide it, the card only adds a click.

### Decision

- **The rule (`ownWords`, `context/learn.ts`).** A row applies when the tool is called, with a receipt and Desfazer in place of a card, when all of this holds: the run is high trust (`learnTrust`: a person behind it and no outside content read, ADR 0120), the message that started it is that person's own (not a colleague's or a notice's), nobody else wrote into it or answered its question while it worked, it read nothing others wrote with no outside mark (a task, a wiki page, a summary, a teammate's answer, `team_status`: `OTHERS_WORDS`, since such a title can be text an agent copied from an email), and that person may decide the row now (`mayDecide`, `maySettle`).
- **Covered.** Instructions, a role and apps (`propose_instruction_change`, `applyAsked`), settings (`propose_settings_change`, the card posted already done, with its own Desfazer) and a skill (`update_skill`, whatever "Agentes melhoram as skills sozinhos" or a lock says, as who may decide could accept the card anyway).
- **Not covered, still a card.** The org context, which every agent reads. A file of a skill that runs on computers. Deleting an agent, which has no Undo. An agent's settings row on itself (ADR 0139: an agent raising its own budget is the person's).
- **Receipts.** `agent.settings_changed`, its `fields` then `instructions`, `role` or `apps` for those rows. Their texts sit in the action's `before` column, never in `params`, which everyone in the conversation reads. Desfazer refuses once someone changed it since, as any receipt. An instructions row is put back only by its owner or who may decide it, never by the owner of the agent that proposed it.

### Consequences

- `read_conversation` and `read_artifact` still count as outside (ADR 0120 stays), so a change made right after reading a file is a card, one click. How often that happens is worth watching.

# 0124. Choice cards: a decision the person answers with one click

- Status: Accepted
- Date: 2026-11-02
- Extends: ADR 0113 (live blocks and polls), 0053 (`ask_user`), 0121 (owner decisions on long work, below)
- Code: `packages/engine/src/blocks.ts` (`ask_choices`, `answerChoices`, `getChoices`, `choiceReplyText`), `artifacts.ts` (kind `choices`, `choicesText`, limits), `context.ts` (`ASK_CHOICES_LINE`, `PLAIN_WORDS_LINE`), `tools/run-policy.ts` (`HERE`), `access.ts`, `events.ts` (`choices.updated`); server `routes/app/artifacts.ts` (`GET …/choices/{id}`, `POST …/choices/{id}/answer`); client `lib/choices.ts`, `useChoices`, `useAnswerChoices`; web `components/blocks/ChoicesCard.tsx`; phone `features/blocks/ChoicesCard.tsx`; migration `0178_choice_cards.sql`

## Context

Agents often end a reply with a menu written as text: "Você tem duas opções: 1. … 2. … Quer que eu…?". The person then types "a 2" or a sentence that repeats the option. `ask_user` already offers 2 to 4 choices, but it pauses the run and waits up to a day, which fits a question asked in the middle of work, not an offer at the end of a reply. A live block (ADR 0113) can hold choices, but it runs a page in a frame, and a pick is an act of the person's: a page could make one for whoever opened it. A vote (`start_poll`) is for a group and stays open.

The same review found agents naming their tools in replies ("por um pedido que eu te mando (`browser_ask_person`)", "pelo `request_secret`"). People who aren't technical get nothing from that.

## Decision

**A card of choices, drawn by the apps.** `ask_choices({ title, questions: [{ question, options: [{ label, description? }] }] })`: 1 to 5 questions, 2 to 6 options each (A to F), a short line of description when it helps. One question shows its options as big rows lettered A, B, C. Several questions go one at a time, with step dots, Back and Next. A close button folds the card for the reader into one line that opens it again.

**A click answers.** On the last open question, the pick is sent at once: `POST …/choices/{id}/answer` with the option of each question. The answer reaches the agent as the person's own message, addressed to the agent in a channel as a block's reply is (`replyAsPerson`, shared with `replyToBlock`): "question label", one line per question, the question there even for one: the agent's history shows its own reply text, not the card it sent, so a bare "Sim" would answer nothing it can see. The apps show that message as one compact line (a check and the pick), and the card turns read-only with what was picked and by whom, for everyone (`choices.updated`).

**Once.** `choice_answers` holds one row per card (its primary key is the artifact), so the first answer in wins and a second gets 409 `choices.answered`. If posting the message fails, the row is removed and the card stays open.

**Stored as a conversation artifact.** Kind `choices`, out of the Drive like blocks and polls, so it keeps channel visibility, `meta.artifacts` on the reply and the trash. The questions are the content; the answer is the table. Migration `0178_choice_cards.sql` adds the enum value and the table (`org_id`, `user_id`, `picks int[]`, `message_id`).

**Who gets it.** No scope, like `ask_user` and the blocks, and `HERE` in the run policy, so a routine's room refuses it. The blocks source lists it only to a run a person is behind (`runAuthorityById` → `person`), in a conversation people read (never an agents' DM), on every brain through the gateway and the MCP bridge.

**When.** The prompt line (`ASK_CHOICES_LINE`, only where the tool is listed): when the reply ends by asking the person to pick between a few clear options, put them on a card instead of a numbered list, one short line around it, and end the turn; never for an open question, a secret or an approval. The tool's description says the same and that `ask_user` stays for a question asked mid-work.

**Plain words.** Every brain reads `PLAIN_WORDS_LINE` in "# How to reply": never name tools or functions to people, say what is being done in plain words; a tool's name only for someone clearly technical who it helps, or when asked about the tools. The language line no longer says tool names stay as they are.

**Keyboard.** On the web the rows are buttons in a group: a letter key picks its option, Up and Down move between rows, Enter or Space picks the focused one, Left and Right move between questions. On the phone each row is a button with its letter and description read out.

## Long work (ADR 0121): the owner's decisions

Approved as recommended:

1. A long work's card made in a DM or a private channel stays with whoever reads that conversation. "Mostrar para todos" stays the way to show it to the whole workspace. This was already how it worked; a test now holds it.
2. Continuar also shows under the end of a work whose run failed on its AI provider (`run.provider_error`, `run.provider_unavailable`). `continueRun` takes that end (`agent_works.result_message_id`, `meta.workEnd`) as the stopped reply, reopens the same work and marks `meta.workEnd.continuedRunId`. Other failures still can't be continued.
3. A finished work's anchor keeps no promise. The line under it says "Terminou em N min" (or "Não terminou", "Parado por …"). The anchor's text is dimmed, the server's automatic anchor drops its "próximo update" sentence (`work_auto_movedOver`), and an agent's anchor drops a last sentence that promises a time. `work_in_background` now asks for `say` without a time, since the line under it carries the live promise.

## Consequences

- An agent that ignores the line still writes its options as text. Nothing refuses that.
- Anyone who can read the conversation may answer, as with `ask_user`. In a channel, the first person to click decides for everyone. The card shows who picked.
- Closing a card is per reader and lasts for the session. It doesn't decline anything for the agent.
- The pick is a normal message, so it starts a run the same way a typed answer would, and the agent reads it in its history.

## Alternatives considered

- **Extend `ask_user`.** It would hold the run up to a day for what is really the end of a reply, and its answer isn't a message in the conversation.
- **A live block with `<ac-choice>`.** A page in a frame could make the pick itself, and every brain would pay for the kit manual to draw buttons.
- **The answer in the message's meta instead of a table.** Two people clicking at once both win, and the card would need its message id to answer.

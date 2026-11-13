# 0147. How agents talk to you: simple by default, technical by choice

- Status: Accepted (built)
- Date: 2026-11-04
- Extends: ADR 0053 (who is behind a run), ADR 0122 (fourteen languages), ADR 0137 (the right hand's greeting cards)
- Code: db `packages/db/src/schema/tenancy.ts` (`organization_members.agent_style`, migration `0217_agent_style.sql`); engine `agent-style.ts` (`AGENT_STYLES`, `agentStyleOf`, `saveAgentStyle`, `TECHNICAL_STYLE_LINE`, `set_reply_style`), `context.ts` (`PLAIN_WORDS_LINE`, `personNotes`), `organizations.ts` (`setAgentStyle`, `Membership.agentStyle`), `tools/directory.ts` (`RARE_TOOLS`), `tools/run-policy.ts`; server `routes/app/management.ts` (`PUT …/me/agent-style`), `routes/app/account.ts` (`agentStyle` in `GET /me`), `engine.ts`; client `api/queries.ts` (`useSetAgentStyle`), `lib/right-hand.ts` (`introCards` `style`), `lib/markdown.ts` (`detailsAt`); web `components/AccountSettings.tsx`, `RightHandIntro.tsx` (`StyleCard`), `lib/markdown.tsx`, `layout.css` (`.md__details`); phone `features/me/PreferencePages.tsx` (`AgentStylePage`), `MeScreen.tsx`, `app/(app)/me/agent-style.tsx`, `features/right-hand/Intro.tsx`, `features/chat/logic.ts` (`parseBlocks`), `MessageText.tsx` (`Details`)

## Context

People who don't code read agents' replies as a wall: a request for the GitHub app's access to one repository came as three paragraphs of folder names, commit hashes, file paths, HTTP codes and JSON keys. A person said that at a glance they thought about not reading at all and approving every button that appeared. That is the opposite of what approvals are for.

The prompt already said not to name tools, and to write like a colleague texting. Nothing said to lead with what the person must do, nor kept paths and codes out, and a technical person had no way to ask for the details.

## Decision

### 1. One choice per person and workspace, Simples until changed

`organization_members.agent_style`: `simple`, `technical`, or null (never picked). Null reads as simple. Per workspace like `show_activity` and `timezone`: a developer may want details at work and not in a side project. It is set in Sua conta (web Settings, phone Você), by the right hand's question, or by asking any agent.

### 2. Simple is the rule every agent reads; technical is a line in the turn

The simple rules sit in "# How to reply" (`PLAIN_WORDS_LINE`), for everyone: lead with what happened and what the person must do, in one or two short everyday sentences; no tool names, paths, hashes, codes, JSON keys or internal names unless the person must type or click them or is clearly technical; a step of theirs is a short numbered list of what to click; more only when asked, or last in a collapsed block.

A person who chose technical gets `TECHNICAL_STYLE_LINE` among the per-turn blocks: paths, codes, ids and tool names are welcome, details may go in the text, and what goes with an approval or a card stays plain.

Why the default in the system text and not in the turn: the system text is cached and shared by every agent of the workspace, the turn is paid again on every call. Most people get the default, so it costs nothing per turn, and a DM "oi" stays under its ceiling.

### 3. Whose style

The person behind the run (ADR 0053): the trigger's author for a DM or channel message, and for a routine's brief (written as its creator). With no author (another agent's mention), `runAuthority` finds the person, else the routine's creator (`wikiPersonOf`). The agents' DM gets no line: no person reads it, and the asking agent words the answer for its own person. For a message a person wrote, the style is read in the same statement as the app language, so a run reads nothing more before the model call.

### 4. Asking once, and changing it by saying so

Under the right hand's greeting, once an AI is connected and while the person never picked, a card asks "Como prefere que eu fale com você?" with two answers. A tap saves it and the card goes, on every device. It is drawn by the app (ADR 0137 §6), so it costs no model call.

`set_reply_style` lets any agent save it when the person asks ("fala mais simples", "pode ser técnico"). It acts only for the person behind the run (`personBehindCall`) and refuses when nobody is. It loads on demand with the conversation's rarer tools, so it adds nothing to every prompt but a word in that group's label.

### 5. Collapsed details in Markdown

Agents write `<details><summary>Details</summary> … </details>` (the label in the reply's language), the HTML every model knows. The shared parser (`detailsAt`) reads it as a block whose body is Markdown of its own, on one line or many, `</details>` ending its last line (a nested block or one inside fenced code doesn't close it; unclosed while streaming, it runs to the end). The web draws a native `<details>`, the phone a row that opens on tap. Every other HTML stays text. The wiki editor's parse leaves it off, so a page keeps its source as written.

### 6. Cards

Approval and action cards keep their own app-written text. What the agent writes with them follows the same rule in both modes (`TECHNICAL_STYLE_LINE` says so).

## Consequences

- Replies to most people get shorter, with the action first; the details are one tap away.
- A technical person's turns cost about 170 characters more.
- The plain-words rule is now longer for everyone (about 90 characters more in a DM "oi").

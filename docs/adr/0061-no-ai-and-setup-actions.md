# 0061. No AI connected, and agents that set up the workspace

- Status: Accepted; amended 2026-11-04 (§5, a plan's panel never waits with no end; §5, the real reason a plan can't sign in yet)
- Date: 2026-10-24
- Extends: ADR 0032 (brains and the fallback to the model), ADR 0037 (act with undo), ADR 0041 (plan sign-ins on a computer), ADR 0043 (tool groups chosen by the judge), ADR 0053 (who is behind a run)
- Out of scope for now: invitation and app cards, agents creating agents or changing their own brain, plan sign-in from the phone app

## Context

A new workspace often has no AI yet: onboarding asks for an API key people may not have, many self-hosters only have a Claude or ChatGPT plan, and a computer's command-line tool can be signed out. Today a message nobody @mentioned hits `MissingCredentialError` in the router and nobody answers, silently. A mentioned agent's run fails with the provider's English error, shown once as an alert that's gone after a reload.

People also just ask: "usar meu plano do Claude", "conecta o GitHub". Agents do much of what people do in the app, but nothing about setting it up.

## Decision

### 1. What "has AI" means

`ai-status.ts`, built from the pieces the executor already uses:

- **Model brain:** a usable credential exists for the agent's provider. An `auto` agent resolves its provider first (`autoProvider`), since `auto` isn't in the model catalog. The check looks for a usable credential row (or the platform's key) and never decrypts, so a page load doesn't unwrap every key.
- **Computer brain:** `computerBrainUnavailable`:
  - nothing → `ready`;
  - `no_computer`, `cli_missing`, `not_logged_in` or `codex_missing` → `ready` when the agent may fall back to the model brain and has a credential (ADR 0032), else `no_ai`;
  - anything else (offline, paused, plan limit) → `ready` with a fallback, else `waiting`, which keeps today's waiting card.
- **The organization has AI** (`any`) when at least one agent that isn't archived is `ready` or `waiting`: a computer that's asleep is not "no AI".
- `GET /api/app/organizations/{orgId}/ai-status` (members) returns each agent's state and `any`, computed per request with no cache and no secrets.
- An agent out of budget is not "no AI", and never gets this copy.

This changes one behavior: a signed-out or missing command-line tool used to make the run wait for the computer, and the wait ended only when the computer came back online, never on a sign-in. It's now `no_ai`, with Connect and "Responder agora".

### 2. A run that can't think fails right away

- The check runs right after the agent's row is read, before the Automático judge, the tool-group judge (ADR 0043) and the run's `running` event. The run fails with `no_ai`, before any model call or context.
- A run already under way that meets a signed-out or missing command-line tool, with nothing to fall back on, fails the same way instead of waiting.
- Its agent posts one no-AI card: `bodyCode: "no_ai"`, `meta.noAi = { agentId, forUserId, reason, intent, provider?, autoOpen?, runId }`, and `message.handled` carries `reason: "no_ai"`.
  - At most one per agent and conversation every 6 hours, or one per conversation when the whole organization has no AI.
  - The card doesn't start the router, like other notices.
- Background runs (routines) post nothing. They fail with `no_ai`, and Rotinas says the agent has no AI connected.
- The live "failed" alert is hidden for `no_ai`: the card says it.

### 3. Messages nobody mentioned

- The organization-level check runs in the `message.posted` job before `routeMessage`, whatever the router. Jev only scores, and never throws `MissingCredentialError`.
- With no AI, the `no_ai` routing decision is stored, the router isn't called, and `message.routed` carries `reason: "no_ai"` with the intent (§4).
- An organization whose only AI is a plan, with no Jev, has nothing to route with. Its messages say to mention an agent (`reason: "mention_needed"`), not that nobody will answer: mentioned agents do answer.

### 4. What the person wants (Jev, optional)

- With `TYPESAFE_API_KEY` set, when a message meets no AI (the organization has none, or the agent asked has none), Jev reads it (up to 4,000 characters) and picks, calibrated:
  - an intent: `claude`, `chatgpt`, `api_key`, `any` or `task`;
  - a provider from the catalog, or none.
- Mentioning a product, asking a price, cancelling a subscription, or using a product for a task is `task`.
- A step is suggested from a probability of 0.6. The Connect dialog opens by itself only at 0.9 or more and never for `any` (the server marks it `autoOpen`), and only for the message's author, once, in a visible window. Below that, the card offers the suggested step as its button. At 0.6, questions about prices, a cancellation and a prompt injection opened dialogs nobody asked for; with prices, cancelling and using a product for a task as `task`, Jev put the injection at 0.61.
- Without Jev, or when it fails or takes more than 2 seconds, the intent is `task`: the Connect button only, with no guessing from keywords.
- Jev's answer only picks a dialog step; it grants nothing. Its usage is recorded as router usage.

### 5. Connect, then the agent answers by itself

**The Connect dialog**, `open({ intent?, provider?, agentId?, from? })`:

- `any`: the choice of a Claude plan, a ChatGPT plan or an API key.
- A plan goes to the account sign-in on the agent's computer (ADR 0041); once the account is in, "Usar meu plano" makes it the agent's brain, with the plan warning shown first.
- A plan's panel never waits with no end (amended 2026-11-04). When the Cloud's computer says ready and the agent's view still has none, the view and the accounts are asked again once, for at most `CATCH_UP_MS` (8 s, `catchUp` in `lib/no-ai.ts`), with the sign-in loading meanwhile. Still none after that, and the panel says no computer is there, with Conectar um computador (`missing`). A read that fails with nothing to show says so, with Tentar de novo. The web and the phone share these gates. The right hand gets these gates like any agent: its view carries the computer its plan signs in on (ADR 0137 §1).
- A plan that can't sign in yet says the real reason (amended 2026-11-04). The Cloud used to show one line ("Ainda não está pronto no …") for every reason, so a computer whose programs were reported missing after a reconnect read as broken for every plan. One helper (`gateLine` in `lib/no-ai.ts`, web and phone) maps the gate, its reason and the edition to the line. On the Cloud the computer is ours, so it says what the computer is doing and what comes next, never blaming the person, with no technical words but the program's name: the program being installed (`not_installed`) or updated (`outdated`), the agentes.chat program out of date with an update on its way (`runner_old`, and `keys` there), the computer not able to run it yet (`exec_off`), getting ready (`no_computer`), restarting or reconnecting (offline); each of those comes back by itself (`gateRechecks`). A program not allowed there (`tool_off`) says to ask support. Self-host keeps its own lines (the person's computer, what to do there). Usar uma chave de API agora is always there. The live re-check: the runner's `executors.changed` (protocol 41) now refreshes the agents' brain views and accounts (`machine.updated` with `executors`, `applyMachineEvent`), as a reconnect does, and the phone's first run, which has no socket, asks again every 5 s while the line says it comes back by itself (`pollsPlan`).
- An API key goes to the key dialog, with the provider already picked.
- It shows what that person may do: keys need `manage_credentials` (admins), changing who thinks for an agent needs its owner or an admin, and a sign-in on a computer needs whoever may add accounts there.
- The banner above the composer (the organization has no AI, or a DM's agent has none), the card, the receipt under a message ("Ninguém vai responder: falta uma IA") and the "Sem IA" chip by an agent's name all open it.

**"Responder agora"** is `POST /api/app/organizations/{orgId}/messages/{id}/answer-now`, with the card's id or the person's message id:

- While there is still no AI: 409 `ai.still_missing`, and the card keeps its button.
- The card stands for its conversation: its agent's newest run there. The person's message: the runs it started.
- When that run failed with `no_ai`: in one transaction, the run is deleted (it did nothing, and its steps cascade), and a run starts again on the person's own message (`startOrJoinRun`). The requester, the authority (ADR 0053) and the context are the normal ones, and `(trigger_message_id, agent_id)` stays unique. Audited as `run.answered_after_connect`.
- Only a run that did nothing starts over: no tool ran, nothing was posted, no approval was asked. A run that resumed (after an approval or a question), or met a signed-out tool in a later turn, gets 409 `run.not_restartable` and stays as it is, because starting over would do its work again and deleting it would lose its approvals and questions. The person asks again.
- Otherwise, when a `no_ai` routing decision exists: it's deleted and `routeMessage` is called directly. Enqueueing `message.posted` again would do nothing, because its dedupe key already exists in the outbox.
- A second call starts nothing new: it returns the runs that answer the message.
- Who may press it: the person who asked, the agent's owner or an admin (the same people as Continuar). It's rate limited like other changes.
- A connection made from the card answers by itself. One made anywhere else leaves "Responder agora" on the card.

### 6. Onboarding can skip the key

The key step gets "Conectar depois". The agents are created without one, and the no-AI states guide from there.

### 7. API keys pasted in the chat

- Before sending, the chat composer (channels, threads and DMs, where people ask agents) looks for key shapes: `sk-ant-…`, `sk-proj-…` or `sk-…` of 20 characters or more, `AIza…`. A hyphenated word like `sk-learn` isn't one: a key has a long random run with digits.
- Admins get "save it as an organization key"; everyone else gets "remove it" or "send anyway".
- It runs in the browser only: nothing is sent until the person chooses.

"Just ask" makes people paste keys where every person and agent in the conversation reads them.

### 8. Agents that set up the workspace

**Action cards.** An action that needs a person's credentials or consent becomes a card:

- The card is an agent message with `meta.actionCard = { kind, forUserId, params }`. Its button opens the app's own dialog, filled in.
- Cards keep no state: "done" comes from live data (the AI is ready, the invitation exists, the app is connected).
- A Connect card (`offer_connect_ai`) names the agents to connect, by default the agent itself for a plan. It reads "Conectado" once they can think, and for a plan's card once they think with that plan. A card for the organization's key names no agent and stays a button: nothing live says which key it was for.

**Direct actions.** Internal, reversible ones act directly, with an Undo receipt (ADR 0037):

- `create_channel` acts as the person behind the run, with that person's rights, and adds the people and agents asked for. Adding an agent needs its owner or an admin; one refused, nothing is created. Undo archives the channel (`channel.created`), unless someone already wrote there (it would hide their messages); Redo brings it back.

**The tools:**

- First `offer_connect_ai` and `create_channel`.
- Later, `offer_invites`: its button opens the invite dialog with the emails filled in and the role set to member. Only the person can change the role, and the tool has no admin or owner role.
- Later, `offer_connect_app`; creating agents, connecting computers and changing an agent's brain come after, as proposals.
- Never: roles, removing members, deleting the organization, approvals.

**The group:**

- Tool groups follow the scope prefix, and an empty scope is a core group listed in every run. So the tools get a scope prefix of their own, `setup:`, granted to agents by default. The judge (ADR 0043) loads them only when a message is about setting up.
- At most 3 cards and 5 channels per run.
- The tools check their input (emails, the catalog's ids) and never receive or return secrets.

## Consequences

- Nothing fails silently for want of an AI, and the person's own message gets its answer once one is connected, with no retyping.
- In an organization with no AI, each message costs one more cheap check, and with Jev one short call.
- With Jev set, the text of a message in an organization with no AI reaches Jev to read its intent. `SELF_HOSTING.md`'s list of what optional services receive says so.
- A prompt injection can at most create a channel, which can be undone, or show a card that a person must click.

## Alternatives considered

- **Leave the run waiting, and resume the organization's waiting runs when a key or account is added** (like runs waiting for a computer): no endpoint and no deleted runs, but it answers old messages nobody is waiting for anymore.
- **Guess the intent from keywords without Jev:** wrong too often, in both languages. The Connect button is enough.
- **Agents that connect an AI or send invitations themselves:** they would hold credentials or act for a person without a click.

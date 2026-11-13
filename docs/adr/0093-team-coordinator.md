# 0093. The team's coordinator

- Status: Superseded 2026-11-03 by ADR 0137: the team's right hand replaces the coordinator, its switch, its rule and its column's use; a person alone with two or more agents gets the top-scored one when the message needs an agent, and the best placed one for a greeting or small talk too (ADR 0137 §5)
- Date: 2026-10-31
- Code: `packages/db/src/schema/agents.ts` (`agents.coordinator`, index `agents_one_coordinator`, migration 0141), `packages/engine/src/agents.ts` (`createAgent`, `setCoordinator`, `archiveAgent`), `packages/engine/src/agent-deletion.ts`, `packages/engine/src/router.ts`, `packages/engine/src/context.ts`, `packages/engine/src/events.ts`, `apps/server/src/routes/app/agents.ts`, `packages/client/src/lib/coordinator.ts`, `packages/client/src/realtime/machines.ts`, `apps/web/src/pages/agent/SettingsTab.tsx`, `apps/web/src/components/CoordinatorChip.tsx`, `apps/mobile/src/features/agents/AgentEditScreen.tsx`

## Context

Customers asked to pin one agent that takes what no other agent takes, the way some agent apps send everything through one bot. The router (ADR 0074) picks agents for a person's message that mentions nobody, and often picks none:

- a message that needs an agent but fits no one ("alguém pode me ajudar com uma coisa?");
- a person alone in a channel with several agents. The router knows "this person is alone here" only when the channel has exactly one agent (R2), so a "bom dia!" to a new team got no answer.

## Decision

1. **One agent per workspace coordinates the team.** It is a column, `agents.coordinator`, with a unique index on `org_id` over active agents (`coordinator and archived_at is null`), so the database keeps it to one. Being the coordinator gives no scope, key or permission: the Tool Gateway doesn't change.
2. **Who has it.**
   - The first agent created in a workspace claims it in `createAgent`, only when no active agent is older. The claim runs in a savepoint: of two first agents made at the same moment only the older one claims it, and with the same time the index turns the second claim down without failing its creation. Onboarding creates Theo first when he is kept, otherwise Ada. Imports and the API go through the same `createAgent`.
   - Workspaces made before this get none. The migration adds the column as false for every agent and fills nothing in; an admin turns it on.
   - `setCoordinator` (`manage_agents`, through `PATCH …/agents/{agentId}` with `coordinator`) moves it in one transaction, under a lock per workspace so the last of two saves wins, or turns it off and leaves nobody. It is audited as `agent.coordinator` (with the agent it came `from`), and the org event `agent.coordinator` makes every open app read its agents again. It stays out of `updateAgent`, so an agent's owner who may change its look or audience can't change it.
   - Archiving or deleting the coordinator clears the flag: nobody coordinates until someone picks another agent.
3. **Where it coordinates.** In every channel where it is a member set to "Por conta própria" (`channel_members.auto_reply`), not on operator hold, and the person who wrote may talk to it: exactly where it is a router candidate. Set to "Quando alguém chama" in a channel, it doesn't coordinate there. To send everything through it, the other agents of that channel are set to "Quando alguém chama". The channel's creator, the agent's owner and `manage_channels` set it, from the web menu and the phone's channel members alike (`api.chat.setAutoReply`, `PATCH …/channels/{channelId}/members/agents/{agentId}`, `setChannelAgentAutoReply`).
4. **The rule, after the router's selection.** A person's message with no mention that the policy gave to nobody goes to the coordinator when:
   - it needs an agent: `needs_agent` at or above the gate `selectAgents` uses (0.5, or 0.35 when the coordinator is the channel's only candidate); or
   - the person is alone in the channel with two or more candidates, whatever the need (R2 for a team; the coordinator may still pass on an "ok"). With the coordinator as the only candidate, R2 already told the strategy that the person is alone with it (`aloneWith`, under the lower gate), so its "nobody" stands.

   Never when another agent already answered it (`already_answered` ≥ 0.7, which every step of the chain gives: Jev, and the small model and the plan through the router's question), when it is addressed to a person, or for an agent's message. Mentions, replies to an agent, follow-ups, the chain, the scores and every threshold stay as they were: an agent that passes its threshold keeps its topic. The decision is stored as strategy `rule:coordinator`, its reason starts with `coordinator`, and it is decided by `{ step: "rule", rule: "coordinator" }`. It is an ordinary router run (`trigger` `router`, not a follow-up), so the coordinator may pass.
5. **When no step of the chain could read the message** (ADR 0074 §4): R1 to R3 apply as before, then R4 sends it to the coordinator only when the person is alone with the agents and names no person. Otherwise nobody answers, as before: a rule for every message nobody could read would start a run for each during an outage.
6. **Its prompt.** In a channel with other agents, the coordinator's "# Where you are" says that it coordinates the team: what nobody took comes to it, it does what is its own, and it hands the rest to the agent whose job it is with an @mention, one agent per line. When no other person is among the channel's members, it also reads that what the person writes to the room is for the team: it answers a greeting or a question, and only a thanks or an ok needs no answer. Without that line its run, one that may pass, reads only "# Why you were called", which passes on a greeting. Hand-offs need nothing new: the mention starts the delegate, which answers the person directly, and the person's next follow-up goes to it.
7. **In the apps** (pt-BR and en):
   - Web: the switch "Coordena o time" with its help in the agent page's Configurações › Identidade, saved with the page's Salvar, for `manage_agents` only (others read it). Under it, "Hoje quem coordena é o Theo." (with "Só um agente coordena por vez." while it is being turned on) or "Ninguém coordena o time agora.". The chip "Coordena o time" with a flag on the profile card and the page's hero, its help as the tooltip. The members popover's chip reads "coordena o time" and the channel details' line "Coordena o time: pega o que ninguém pegou", both only where it answers on its own and something reads the messages that mention nobody. The receipt's last line reads "O Theo coordena o time" with the flag. Archiving or deleting it says the team will have none.
   - Phone: the same switch and lines on Editar agente, a line with the flag on the agent's profile, the sentence on Apagar, the line in a channel's members and the flag on the receipt.

## Consequences

- Silence becomes an answer: a message that needed an agent and got none, and anything from a person alone with several agents. Each is one ordinary turn on the coordinator's own budget.
- The router makes no new model call: the small model's and the plan's answer carry one more number, `already_answered`. It adds one "is the person alone here" query, only in a channel the coordinator is in, when nobody was picked and the need is below the gate.
- A coordinator with no AI is picked and posts the no-AI card; one over its monthly budget is stopped before any call, as any agent. A busy coordinator reads the message at its run's next step.
- Imports and exports don't carry the coordinator.
- Older builds show the receipt's last line as its raw key, "receipts.by.coordinator", since i18next returns the key it doesn't know: a web tab until it reloads, the phone until it is reinstalled (it has no over-the-air updates). The phone build ships in the same release. The flag they don't have never breaks the receipt: an icon name a build doesn't know is drawn as a ring.
- `reason like 'coordinator%'` in `routing_decisions` counts its picks. Before launch, `selected_agent_ids = '{}' and needs_agent_score >= 0.5` bounded them.

## Alternatives considered

- **A coordinator per channel, or a lead per group:** more to set and to explain. A pick per channel can come later as a third "Quando responde" option without undoing this.
- **Raising the other agents' thresholds when a coordinator exists:** it would change today's routing in every channel. "Quando alguém chama" already gives the strict way.
- **A summary after each hand-off, or waking the coordinator when its delegates finish:** more turns for little.
- **A manager agent with a person's permissions:** ADR 0081 rejected it; the coordinator gains nothing.
- **Giving existing workspaces their oldest active agent:** decided against on 2026-10-31. An admin turns it on.

## Addendum (2026-11-01): the coordinator is a tier of R5

ADR 0074's R5 ("a message for the agents always gets one") subsumes §4 and §5. The coordinator takes a person's message nobody was picked for when it is for the agents and the person talks with no agent: the agent replied to, last talked to or that just spoke comes first. Its need gate drops from the pick gate (0.5) to `DEFAULT_NEED` (0.25), and the ack guard, the people-talking check and the hourly cap of default picks apply. Its decision keeps strategy `rule:coordinator`, with the reason `coordinator; default`. When no step of the chain could read the message it is the coordinator's after R1 to R4 too, also with other people in the channel, under the same guards.

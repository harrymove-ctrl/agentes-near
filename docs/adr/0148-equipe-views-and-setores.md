# 0148. Equipe's views and setores

- Status: Accepted (built: db, engine, server, the shared client, the web and the phone app)
- Date: 2026-11-04
- Extends: ADR 0083 (groups of agents: they are shown as setores), 0137 (the right hand: the team map's drag is its settings card), 0141 (usage per person: shown on Equipe too)
- Code: db `packages/db/src/schema/agents.ts` (`agent_groups.color`, `icon`, `lead_user_id`, `backup_user_id`), migration `0219_sectors.sql`; engine `agent-groups.ts` (`AgentGroupView`, `AgentGroupPatch`, `lookOf`), `team.ts` (`getTeam`: `channelIds`), `team-map.ts` (`proposeChannelMove`); server `routes/app/agents.ts` (the groups' new fields, `channelIds` on `GET …/team`, `POST …/team/channel-move`); client `api/types.ts` (`AgentGroup`, `AgentGroupPatch`, `TeamAgent.channelIds`), `api/queries.ts` (`useProposeChannelMove`, `useAgentGroupAction`), `lib/team-views.ts` (`filterTeam`, `sortTeam`, `reportsTo`, `chartByPerson`, `mapColumns`, `sectorReach`, `sectorGap`); web `pages/TeamPage.tsx`, `team.css`, `components/team/*` (`TeamList`, `TeamChart`, `TeamMap`, `TeamSectors`, `TeamUsage`, `shared`), `AgentGroups.tsx` (the dialog's color and icon), `Sidebar.tsx` (a setor's mark on its header), `PeopleUsage.tsx` (`PeopleTab` exported); phone `features/team/*` (`TeamScreen`, `TeamEntry`, `logic.ts`), `app/(app)/team.tsx`, `features/agents/AgentsScreen.tsx`

## Context

Equipe was a pixel sky of agents around their people, a feed of agents asking each other, and a "Grupos de agentes" card. People asked where their agents live, who reports to whom, and how the team works together. A beginner also asked for the team as a whole, not agent by agent. The concepts "Where agents live" (round 2) and "Team Setup" (D, the team as a map) were approved with all their recommended parts.

The workspace's groups of agents (ADR 0083) were the sidebar's AGENTES sections, but nothing said what they were. They read like channels.

## Decision

### 1. One page, five views

Equipe's header names the counts (`14 pessoas · 12 agentes · 5 setores`) and a segmented control picks the view, remembered in this browser: Lista, Organograma, Mapa, Setores and Governança e uso. Lista is the default. All of them read `GET …/team`, the groups, the directory and the channels the person sees. Nothing is computed twice: the views' rules are `@agenteschat/client/lib/team-views`, and the web and the phone draw the same ones.

- **Lista**: Agentes and Pessoas tabs. The agents' table has agent, role, setor, responsible, where it is (its channels, `+N`) and now (working, waiting for me, no AI, available). It has a search by name, role or channel's name, the filters Meus, Trabalhando agora, Esperando você and Sem responsável, sortable columns, and Agrupar por setor, responsável or nothing. Who manages agents changes an agent's setor from the row's menu. People rows show their roles, the agents they look after and the setores they lead or cover. The archived agents' card stays under Lista.
- **Organograma**: by person, the workspace on top with its right hand under it, then one column per person with the agents that report to them. An agent reports to its owner, else to its setor's lead, else to nobody (`Sem responsável`). By setor, one frame per setor in its color with `Responsáveis: …`. Who manages agents drags an agent to another setor (ADR 0083's move, with Desfazer).
- **Mapa** (Team Setup D): the people who look after the agents on top, one column per channel with its agents (an agent in every channel it is in), what each does (its instructions' first line, on its first card), its routines in the column of the channel they post to, and how many of its requests wait for approval. Dashed lines join agents that asked each other in the last day (the consultations the sky used to draw). The right hand sits under them. The channels with no agent are chips under the columns. The map is read-only: dropping an agent on another channel calls `POST …/team/channel-move`. That posts the right hand's settings card (ADR 0137 §4) in the person's DM with it, with a join row (answering as it did where it was) and a leave row when it came from a channel. A toast opens the DM. Nothing moves until whoever may applies it, and "Pedir a um admin" works as on any card.
- **Setores**: §2.
- **Governança e uso**: Settings › Orçamento e uso › Pessoas (ADR 0141), the same component and data, for who sees money (each person's use, the drawer, Limites, Agora). Everyone else sees Seu uso. A link goes to Settings, where it stays.

### 2. Setores are the groups

The groups of agents are shown as setores everywhere: the copy says "setor" ("department" in English), the Equipe card is gone, and the sidebar's AGENTES sections, the agent page's field and the phone's sections keep reading the same rows. One source of truth: `agent_groups`.

- A setor has a color and an icon. They are one of the roles' colors (never sky, the agents' own) and one of the roles' icons, checked by the engine (`agent_group.bad_color`, `bad_icon`). It also has a lead and a substitute, each a member of the workspace (`agent_group.not_member`) or nobody. The color and icon are the setor's mark on its card, its frame and its sidebar header. The new agent-group dialog gains the roles' pickers.
- **Equipe › Setores**: one card per setor in two columns. Each card has its mark, name, people and agents counts, Responsável and Substituto (pickers for who manages agents), its agents (draggable between cards), its people (the lead, the substitute and its agents' owners), the channels its agents are in and their routines. A setor with no lead or no substitute ends in an amber line. A muted `Sem setor` card holds the agents in none and takes drops. "Falar com Lodi" opens the right hand's DM with "Me ajuda a organizar o time em setores." typed and not sent.
- Who manages agents creates, edits, orders and deletes setores, exactly as groups (ADR 0083 §3). Members read them.

### 3. The phone

Agentes gets an Equipe row that pushes Equipe: Lista by setor, Organograma by person (the right hand under the workspace) and Mapa by channel, as sections of the app's rows (`teamSections`). The map's line says to drag on the web or talk to the right hand. Setores and Governança e uso stay on the web.

### 4. Strings

Every string is in the 14 languages. The old sky, card and feed strings are gone.

## Consequences

- The sky's live animation of a consultation is gone. The map's dashed lines show the same pairs without motion.
- A setor's people are derived (lead, substitute, owners). Linking a setor to a role (its people) and to a channel category (its channels), the "2 dias fora" check, approvals going to the substitute and the onboarding templates are the concept's later steps and aren't built here.
- An agent in many channels shows in many map columns. Its consultation lines start at its first card.
- The map measures its cards to draw lines (one `ResizeObserver`). Below 720 px the lines hide and the columns stack.

## Alternatives considered

- **Moving an agent by dragging on the map at once**: the concept asked for a proposal, and a channel change has deciders (its owner or who manages agents). The right hand's card already decides, applies, audits and undoes it.
- **A new `sectors` table**: the groups already are the sidebar's sections and the agent page's field. Four columns keep one source of truth.

## Addendum (2026-11-07): Responde a, a supervisor agent between a person and the agents

### Context

A customer wanted to put one agent of his own between himself and the sectors in Mapa and Organograma. `reportsTo` could only answer a person (the owner beats the setor's lead), so nothing could change the picture.

### Decision

- **One nullable column, `agents.reports_to_agent_id`** (migration 0240), same workspace, `on delete set null`. A supervisor is any agent others report to: no flag, no role, no permission. The owner stays accountable (approvals, plan, budget); the supervisor is who it tells.
- **Refused** (`lineRefusal`): itself, the right hand at either end, a loop, more than 3 agents top to bottom (`MAX_LINE_DEPTH`: the right hand, 3, and a specialist fit `MAX_CONSULTATION_CHAIN`). Set by who manages agents, at once, with Desfazer (`setReportsTo`, `PUT /organizations/{orgId}/agent-lines`: changes in order, all or none, answering what they were, which the same call puts back). Audited as `agent.reports_to_changed`. The right hand proposes it with one more line on its settings card (`reports_to`, group `admin`).
- **What it changes: where information goes by default, never what anyone may do.** The supervisor's context lists its reports always, past `TEAM_IN_PROMPT`, and a report's says who it reports to and to ask it when work stalls with nobody to ask (`# Your line`, only when there is a line). The two may always call each other (`inLine`, before `mayCall`'s lists); audience still applies. A supervisor gets `team_status` over its reports and their tasks, as the person behind the run sees them, and none with nobody behind it. Where others read the reply too (any conversation but that person's own DM with it), it names only places anyone may read and tasks that conversation may name, and leaves out what waits for the person. Approvals stay with people; the router, channels and wakes don't change.
- **Organograma.** By person: a supervisor sits in its line's top person's column with its reports indented under it, joined by a line, and a count. Who manages agents drags an agent onto another agent to make it report there, onto a person to clear it, and a setor's frame onto an agent for all its agents, each with Desfazer. By setor, the frame says its supervisor.
- **Mapa.** A band of supervisors between the people and the channels, only when one exists, with a solid line to each report; dashed lines stay consultations. A column whose agents all report to one shows that face on its header. Dropping an agent on a supervisor in the band sets it at once. While who manages agents drags one, the band also offers every agent it may report to, so the first supervisor is made on the Mapa too. Below 720 px the lines hide and each card reads "Responde a Nina".
- **Setores.** A Supervisor row under Substituto: a picker of agents that sets the setor's agents, and "1 agente sem supervisor · Aplicar" when one doesn't (an agent moved in later keeps its own).
- **Agent page and Lista.** "Responde a" in Configurações next to Setor, applied at once with Desfazer, with "Só diz a quem este agente presta contas. Não dá nenhuma permissão."; a supervisor's page lists who reports to it. The same choice in the Lista row's menu.
- **Phone.** Organograma indents a supervisor's reports under it, the channel cards say who each reports to, the setor rows name the supervisor, and the agent's edit screen has Responde a with Desfazer. No drag.

### Consequences

- An agent moved into a setor later doesn't inherit its supervisor: the setor card says so with Aplicar. A setor column (`agent_groups.lead_agent_id`) waits until that is annoying.
- A failed routine doesn't wake its supervisor on its own; its prompt says to ask it.

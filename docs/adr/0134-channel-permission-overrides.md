# 0134. Channel permissions: exceptions per role or person

- Status: Accepted (built)
- Date: 2026-11-03
- Extends: ADR 0085 (roles and permissions, "Next: exceptions per channel"), 0125 (who sees a channel)
- Code: `packages/db/src/schema/chat.ts` (`channel_permission_overrides`), migration `0194_channel_permissions.sql`;
  `packages/engine/src/permissions.ts` (`CHANNEL_KEYS`, `channelPermissions`, `channelMaySql`, `channelOverridesSql`),
  `channels.ts` (`requireChannelAccess`, `managesChannel`, `listChannels` `can`, `postRefusal`),
  `channel-permissions.ts` (`listChannelOverrides`, `setChannelOverride`), `audience.ts` (`audienceSql` with
  `channelId`, `notifyBlocked`), `messages.ts`, `router.ts`, `dispatch.ts`, `routine-state.ts`; server
  `routes/app/channels.ts` (`GET`/`PUT …/channels/{channelId}/permissions`), `chat.ts`, `schemas.ts`; client
  `lib/permissions.ts`, `api/*`; web `components/ChannelPermissions.tsx`, `pages/ChannelPage.tsx` (channel settings),
  `components/members/MembersColumn.tsx`; phone `features/chat/ChatScreen.tsx`, `ChannelMembers.tsx`

## Context

Roles (ADR 0085) decide what someone may do in the whole workspace. A workspace wants some channels to differ: an
announcements channel where only the managers write, a channel whose agents only some people call, a person who
looks after one channel without managing all of them. Discord does this with per-channel overrides (deny, inherit,
allow per role or member). People who never used Discord need it said plainly.

## Decision

1. **Three keys, per channel.** A channel may change `post` (Enviar mensagens: write, reply in threads, pin),
   `talk_to_agents` (Chamar agentes: the person's messages wake the channel's agents) and `manage_channels`
   (Gerenciar o canal: name, who sees it, members, agents' reply mode, archive, these exceptions) for a role
   (`everyone`, "Todos", included) or a person. One row per target in `channel_permission_overrides`, with `allow`
   and `deny` key lists; a check constraint keeps them apart and within the three keys. At most 100 rows per channel.
   Rows go with their channel, their role, or the person leaving the workspace (foreign keys, cascade).
2. **Left out on purpose.** Who sees a channel stays ADR 0125's choice (Público, Privado, Departamentos ou papéis,
   plus people added by name): one model for seeing, no View deny until guests arrive. Pinning follows Enviar
   mensagens. Routines and webhooks post as their creator, so they follow the creator's Enviar mensagens there.
   Agents get no exceptions: they are in the channel or not, with their reply mode, and act by their scopes.
3. **Discord's order.** For each key: an owner or `administrator` is always allowed (nobody gets locked out); else
   start from the workspace keys, apply `everyone`'s exception, then the person's roles' (any allow wins over a deny,
   so someone in both "Vendas: Negar" and "Gerência: Permitir" sends), then their own (last word). `manage_channels`
   held in the workspace is never taken away; an exception only adds it, and only while the person is in the channel
   (as for its creator), so it never lets anyone into a channel they can't see. With no rows, every check is
   exactly what it was.
4. **One rule, two forms.** `channelPermissions` (code) and `channelMaySql` (SQL, for checks inside one statement);
   a test runs every combination through both. `requireChannelAccess` reads the exceptions in its one query and
   returns the person's channel keys, so every caller that checks `can(membership, "post")` or `speakerOf(membership)`
   follows without change: sending, threads, voice, blocks, pins, routines and reminders. `managesChannel` reads them
   with one indexed query. The message insert, the router and dispatch pass the channel to `audienceSql`; a DM or a
   mission keep the workspace key. A routine whose creator may no longer send there pauses
   (`creator_no_access`, through `personCanPost`), and one whose creator may no longer call agents there pauses
   (`audience`). An agent's `post_message` for a person needs that person's Enviar mensagens in the target channel.
5. **Who changes them.** Whoever manages the channel, and nobody gives what they can't do (ADR 0085 §7): someone
   who isn't an owner changes only keys they hold in that channel, and only for `everyone`, roles below their own and
   people below them, never themselves. Empty allow and deny remove the row. Audited as
   `channel.permissions_changed`; an org broadcast (`channel.permissions`) makes the apps refetch the channel list
   and an open permissions page. Refusals: 403 `channel.permission_forbidden`; sending where an exception stops it:
   403 `channel.post_denied`; a mention there wakes nobody and only the author hears `channel.agents_denied`.
6. **Apps.** The channel list carries `can { post, callAgents, manage }`. Who manages a channel gets its settings with
   a nav on the left as in Settings (Visão geral, Permissões, Membros; Arquivar and Apagar at its foot; stacked on a
   phone-width screen). Permissões holds "Quem pode entrar" and "Permissões avançadas": `Todos` and every role or
   person with an exception on the left, a "+" to add one, and per key a three-way Negar ✕ / Padrão / Permitir ✓ with
   its one line and what Padrão means now. Everyone else keeps the read-only details. Where I can't send, a quiet line
   takes the composer's place, on the phone too. The members column and the phone's members sheet say "Quem pode ver
   este canal". Editing exceptions stays on the web.

## Consequences

- No data change: existing channels behave as before (tests prove it with no rows, in code and in SQL).
- Each channel check reads a few more indexed rows (the channel's exceptions for `everyone`, the person's roles and the
  person); the channel list computes `can` per channel.
- Putting an agent in a channel (`placesAgentsIn`) still reads the workspace's `post`.
- Open: the members caption is accurate for an invite-only channel; on a public or role channel more people may see it
  than the list shows (a mode-aware caption is the alternative). Whether "Fixar mensagens" needs its own key.

# 0125. A channel for departments or roles

- Status: Accepted (built)
- Date: 2026-11-02
- Extends: ADR 0014 (live revocation), 0080 (channel details), 0085 (roles and permissions, an agent's audience)
- Code: `packages/db/src/schema/chat.ts` (`channels.audience_role_ids`), migration `0179_channel_audience.sql`;
  `packages/engine/src/channels.ts` (`channelAudienceSql`, `channelRoleIds`, `dropRoleLeavers`,
  `announceChannelLeavers`, `listChannels`, `channelCard`, `joinChannel`, `createChannel`), `management.ts`
  (`updateChannel`), `roles.ts` (`setMemberRoles`, `deleteRole`), `apps/tools.ts` (`list_channels` text); server
  `routes/app/chat.ts`, `channels.ts`, `schemas.ts`; client `lib/channel-access.ts`; web
  `components/NewChannelDialog.tsx` (`ChannelAccessChoice`), `components/roles/RoleChecklist.tsx`,
  `pages/ChannelPage.tsx` (details), `chat/ChannelRef.tsx`, `components/CommandMenu.tsx`; phone
  `features/chat/ChannelRefText.tsx`

## Context

A channel was public (anyone in the workspace sees and joins it) or private (only who is added). Workspaces organise
people by role ("Vendas", "Suporte", "Financeiro"): roles (ADR 0085) are the departments. An agent's audience can
already be "whoever holds one of these roles, now or later"; channels had nothing like it, so a department channel
was a private channel kept by hand.

## Decision

1. **A private channel with roles.** `channels.audience_role_ids` (uuid[], empty by default). A private channel with
   roles is "Departamentos ou papéis": whoever holds one of them **at the time** sees it in their list and on a
   `#channel` card, and may join it. Everyone else gets what a private channel gives them: nothing listed, a 404 card,
   a refused join. A public channel never keeps roles (the server clears them, and refuses them on create).
2. **See and join, not automatic membership.** The channel is listed for the role's people like a public one (not a
   member yet, with Entrar); its messages still need membership, so every check that reads messages (HTTP, WebSocket,
   search, notifications, agents' routing and tools, MCP) is the same membership check as before, unchanged. Anything
   that tests `visibility = 'public'` keeps treating the channel as private: a place that was missed fails closed.
3. **Membership follows the roles.** Losing a role (taken from the person, or the role deleted) takes them out of the
   channels limited to it, unless they hold another of the channel's roles or created it; a channel that drops a role
   takes out the members holding it and none of the remaining ones. Turning the channel invite only (no roles) or
   public keeps everyone in. Someone added by name who never held a dropped role stays. Each removal ends their live
   subscription first (`membership.revoked`), then their sidebar and the channel hear `channel.member_removed`.
   Deleting a role also takes it off every channel.
4. **Who picks.** Anyone who may create a channel may limit it to any of the workspace's custom roles (not
   `everyone`, which is "Público"); changing it later is for its creator or `manage_channels`, as for its name.
   At most 100 roles.
5. **Apps.** "Quem pode entrar" has a third card, "Departamentos ou papéis", with the roles to tick (the same rows as
   an agent's audience, `RoleChecklist`), in Criar canal and in the channel's details (saved on each change once a
   role is ticked; hidden for #general). The phone joins such a channel from its card like a public one
   (`joinable`); choosing who may join stays on the web, as private channels did.

## Consequences

- No new permission, no change to messages, search, routing or the WebSocket.
- A member who wasn't in a role keeps a channel they joined by name; an admin removes them by hand if needed.
- (Replaced by ADR 0151: administrators see every channel.) Admins saw a role channel only as anyone does: when they hold one of its roles or are in it, as with private
  channels. There is no listing of every channel for `manage_channels`.
- Joining a role channel, taking a role away (from a person or by deleting it) and changing a channel's roles take the
  workspace's `org-members` lock, so a join at the same moment as a removal never leaves someone without the role in.
  A rename or topic change leaves the roles as they are.
- Going public from the channel's details asks first: it opens every past message to the workspace. A role change
  without any role ticked is not saved and says so. Role changes refresh everyone's channel list (`org.members`).
- Open: creating private and role channels on the phone (it only creates public channels today).

# 0129. Agents start what the UI does; Connectors and MCPs

- Status: Accepted (built)
- Date: 2026-11-03
- Extends: ADR 0061 (action cards, `setup:write`), 0081 (proposed agents), 0090 (invitations), 0107 (Composio)
- Code: engine `setup-tools.ts` (`offer_connect_app`, `offer_invites`, `catalogConnector`, `mcpAddress`), `agent-proposals.ts` (`deciderCanOpen` takes a permission), `tools/directory.ts` (the setup group's label, the find-tools hint); client `lib/action-cards.ts` (`ConnectAppCard`, `InviteCard`, `connectAppDone`, `inviteDone`), `lib/connected.ts` (`isMcpItem`); web `Connectors.tsx` (two cards), `ConnectFlow.tsx` (`url` filled in), `ActionCard.tsx`; phone `ConnectorsScreen.tsx` (MCPs strip, `?connect=` / `?mcp=`), `ConnectSheet.tsx` (`AddressSheet url`), `InvitePeople.tsx` (`?emails=`), `ai/OfferCard.tsx`

## Context

People connect MCP servers through "Can't find it" in the catalog, so a person who uses a service through its MCP server doesn't find where to add it. And people ask agents in the chat ("connect https://…/mcp", "connect an MCP", "invite ana@…"), while agents could offer only an AI connection, a channel or a new agent (ADR 0061 §8 left apps and invitations for later).

## Decision

### 1. The standing rule

Anything a person can do in the UI, an agent can start: directly, within its permissions and the asker's rights (reversible, with an Undo receipt), or by showing the person our own UI to confirm (an action card whose button opens the app's dialog, filled in). Credentials, keys and sign-ins are always typed into our UI, never into the chat or the model. What only a person decides stays theirs: approvals, roles, removing members, billing, deleting a workspace or an account. The list of UI actions against agent tools, with the gaps in order, is kept with this decision's work and grows a card at a time.

### 2. Connectors and MCPs

- Settings' section is "Connectors and MCPs" (every language), with two cards: Connectors (the catalog's services, one-click servers, services through Composio, mailboxes, databases) and MCPs: every server connected by its address that the catalog doesn't list (`isMcpItem`: custom, no catalog entry, not Composio), old and new.
- "Add MCP" on the MCPs card opens connecting by address directly; empty, one line says servers connected by their address show up there. "Can't find it" still leads there too.
- The phone's Connectors screen has the same split: an MCPs strip with an "Add MCP" tile and the same empty line.

### 3. `offer_connect_app`

- Input: `app` (a catalog service by id or name) or `url` (an `https://` address with no user or password), and `why`. An address of a one-click server becomes that catalog entry. Neither: the card opens connecting by address and the person types it. The agent asks for the address first when a person wants an MCP server and gave none.
- The card (`meta.actionCard = { kind: "connect_app", params: { connector?, url?, why } }`, `bodyCode` `action_connect_app` with `name`, or `action_add_mcp`) opens the same connect dialog as Settings (on the phone, Connectors with the same sheet), with the address filled in. Done from live data: a connection of that entry, or a server at that address.
- An unknown name is refused with "ask for its MCP server's address".

### 4. `offer_invites`

- Input: 1 to 20 emails (checked, lower-cased, deduplicated) and `why`. The card (`kind: "invite_people"`, `bodyCode` `action_invite_people`) opens the invite dialog (on the phone, Convidar pessoas) with the addresses, as members; roles change only in the dialog. Done once each address is invited or a member.

### 5. Who may do it

- Both tools are in `setup:write` (granted by default, a tool group the judge loads when a message is about setting up), count toward the 3 cards per run, and need a person behind the run for invitations.
- When the person who asked may not (`manage_connectors`, `invite_people`), the card is posted only if someone who may can open the conversation (`deciderCanOpen` with that permission), and the tool tells the agent to say an admin does it from the card and offer to ask one; otherwise nothing is posted and the agent is told to offer to ask one (`request_approval`, or a channel an admin reads).
- Agents' hints that point to the page say "Settings › Connectors and MCPs" (and the Portuguese the app shows).

### 6. Skills (amended 2026-11-03)

- `offer_install_skill` (`url`, a GitHub link, and `why`) posts a card (`kind: "install_skill"`, `bodyCode` `action_install_skill`) whose button opens Instalar skill with the link read and its skills listed to pick; who manages agents (`manage_agents`) installs there. Done once the library has a skill from that link. Agents are told to use it instead of installing into their CLI's own skills folder, where only they would have it.
- `update_skill_from_source` (`name` or `all`) runs the update from the link (ADR 0020, amended 2026-11-03) for a person who manages agents, with a `skill.updated` receipt (Undo restores the whole version before); an update that changes files that run, or a person who can't, gets a card (`kind: "update_skills"`, `bodyCode` `action_update_skills`) whose buttons open each skill.
- Both are in `skills:read`, loaded on demand (`find_tools`, the "more" group: the prompt names them), count toward the 3 cards per run and follow §5 for who may.

## Consequences

- A prompt injection gets at most a card a person must click, with an address shown on it; the connect itself runs the same server checks as Settings (SSRF guard, OAuth, review of tools).
- The existing Connectors region on the web lost its MCP rows to the new card; tests that looked for a custom server in "Conectores" now look in "MCPs".

## Alternatives considered

- **One list with a "MCP" badge:** keeps the page as it was and doesn't answer where to add an MCP.
- **Agents connecting with a key pasted in the chat:** the key would be read by everyone in the conversation and by the model.

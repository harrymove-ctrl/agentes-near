# 0038. Agents use people's mailboxes: Composio for Gmail/Outlook, our IMAP/SMTP connector for the rest

- Status: Accepted (built; not yet tried against real Composio or IMAP servers)
- Date: 2026-10-18
- Extends: ADR 0015 (Tool Gateway and approvals), ADR 0016 (connectors), ADR 0007 (credentials)
- Out of scope: an address of the agent's own (`ana@org.agentes.chat`), which gets its own ADR

## Context

People want agents to read, triage and answer their email. We studied two open-source products that do this:

- **OpenBot (CopilotKit):**
  - Gmail and Outlook go only through Composio. Composio holds the OAuth and exposes actions such as `GMAIL_FETCH_EMAILS` and `GMAIL_SEND_EMAIL`.
  - An admin grants actions to each bot, one by one. An app is Personal (acts as the asker) or Shared (one team account).
  - Drive, Notion and web search are its own reviewed connectors.
  - Inbound mail reaches a bot only through a receive-only `trigger-<id>@domain` address (SES).
- **OpenMausBot:**
  - Every external app goes through Composio, behind a Cloudflare broker that keeps the project key out of the desktop build.
  - Each bot has three layers of access: on/off, an exact tool list per service, and read or write per app. The read/write split comes from the action's verb.
  - Every send asks "Send on your behalf?" by default; an alternative is allow with a cap of 25 per day.
  - A new email wakes a bot through Composio triggers. The Gmail filter becomes a Gmail search, and the payload is wrapped as untrusted.

Neither has an IMAP client, and neither gives the bot its own sending address. Both keep permissions and approvals on their side; Composio only executes.

### Constraints

- **Google's restricted scopes:** reading Gmail (`gmail.readonly`, `gmail.modify`) requires app verification and a yearly CASA security assessment for whoever owns the OAuth app. With Composio's managed app, that is Composio. Sending only (`gmail.send`) is a lighter, sensitive scope.
- **Apple:** there is no email API or OAuth for iCloud Mail, so Composio can't help. The only way in is IMAP (`imap.mail.me.com:993`) and SMTP (`smtp.mail.me.com:587`) with an app-specific password. Custom domains on iCloud+ work the same way: you log in with the Apple ID and send from the domain alias. The same IMAP/SMTP path covers hosting mail (Locaweb, Hostinger, cPanel), Fastmail, Zoho and Yahoo, which are common among small companies in Brazil.

## Decision

### Which path for which mailbox

| Mailbox | Path |
| --- | --- |
| Gmail, Outlook / Microsoft 365 | Composio, with its managed OAuth app |
| iCloud (including custom domains), hosting mail, Fastmail, Zoho, Yahoo, any IMAP | Our IMAP/SMTP connector, using an app password and presets per provider |
| Apps with an official MCP server that connects today (GitHub, Linear, Notion, Supabase, Stripe…) | Direct MCP (ADR 0016). Amended by ADR 0107: a service whose server refuses us, or has none, goes through Composio when this server has it (Google Drive, Slack, HubSpot, Figma…); GitHub never does |

### Composio is a `ToolSource`, not a policy

- It plugs in as a tool source behind the Tool Gateway, like an MCP connection. The org connects once, and each agent gets a subset (ADR 0016).
- **Only explicit actions are exposed.** The meta-tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL`, `COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_PROXY_EXECUTE`) never are, because each of them is a way around per-tool grants.
- The Composio project key lives only on the server; agents and clients never see it. The Composio user id is our org id, plus the person's id for personal accounts.
- Access is decided only by our grants, approvals and per-call checks.

### Per-call checks (`checkCall`)

Email needs rules about a call's arguments. These go in a standard per-call hook, declared by the connector and run by the gateway before a run and again before an approved action executes:

- **Read:** search, read and list folders. It can be limited to folders, senders or domains, and a time window. Reads never ask (ADR 0037).
- **Draft:** creates a draft in the mailbox and never sends.
- **Send / reply / forward:** a sensitive tool, so every call asks for approval in the chat by default, showing the exact recipients and body (ADR 0015).
  - Optional settings: allowed recipients or domains, a daily cap per agent, and which From address to use.
  - **From:** a mailbox keeps its other addresses (`mail_accounts.aliases`: iCloud custom domains, Gmail "send as") and the one new mail goes out from (`default_from`). A reply, forward or reply draft goes out from the address the message reached (our own From, then To, then Cc, then `Delivered-To`/`X-Original-To` for an alias); new mail from `default_from`. An agent pinned to one address (`mail_agent_policies.from_address`, one of the mailbox's) uses only that one. The model may pick another of the mailbox's addresses, never one outside it. The connect flow offers the From addresses of the sent folder's recent mail.
  - An agent can be set to "send without asking" only when it has an allowed-recipients list.
- **Organize:** move, flag and archive.
- **Delete:** off. If turned on, it always asks.

Send detection never trusts the tool name alone. Each email tool declares its effect, and anything undeclared counts as a send.

### Our IMAP/SMTP connector

- **Libraries:** `imapflow` and `nodemailer`. Running them on Bun needs a spike first. If they fail, the fallback is a small protocol client behind the same interface.
- **Credentials:** the app password is sealed with envelope encryption like the other connection secrets. It is opened only in worker memory, for one call, and never returned to clients or put into prompts.
- **Network:** TLS only, with certificate verification. The host comes from a preset; for a custom host, `net-guard` blocks private and metadata addresses.
- **Read-only at the protocol level:** read tools open folders with `EXAMINE` (not `SELECT`) and fetch with `BODY.PEEK`. A bug on our side then can't change the mailbox or mark mail as read.
- **Parsing:**
  - MIME, attachments (metadata, with download on request into the Drive), HTML to text, charsets.
  - Replies keep the thread (`In-Reply-To`, `References`).
  - Long threads are cut to the latest messages, plus a summary.
- **Setup screen:** one simple question per step. Pick the provider, then follow Apple's (or the host's) steps to create an app password, then paste it. The screen suggests a dedicated mailbox or alias for agents.

### Inbound mail (routines)

- **Composio:** a trigger such as `GMAIL_NEW_GMAIL_MESSAGE` posts a signed webhook into our webhook receiver, and that enqueues a routine run for the agent.
  - The filter (from, subject, label) is pushed to the source as a Gmail search, so unrelated mail never becomes a billed event.
  - Events are deduplicated by message id, and bursts merge into one run.
  - An expired account marks the routine "Reconnect".
  - Reconnecting signs in again on the same mailbox. The new Composio account takes the refused one's place (the old one goes without revoking the grant, since the person is granting the same app again), the mailbox keeps its agents and rules, and its routines get new triggers. Signing in to another address doesn't replace it.
- **IMAP:** first version polls every few minutes per watched folder, through an outbox job.
  - It tracks the last seen UID per folder and resets when `UIDVALIDITY` changes.
  - The first run starts from now, not from the whole history.
  - IDLE (one persistent connection per mailbox) comes later, only if latency matters.
- **In both cases** the content enters the context wrapped as untrusted external data. A run started by inbound mail can never approve its own send.

### Prerequisite

The `checkCall` hook in the gateway, with the GitHub repository check moved onto it.

KMS is not a prerequisite for email. Gmail and Outlook through Composio store no token of ours. IMAP passwords are sealed the same way as the provider keys, GitHub tokens and MCP OAuth tokens we already store. A KMS-backed `KeyWrapper` (ADR 0007) would protect every credential, this one included.

### Order

1. `checkCall`.
2. Gmail/Outlook through Composio: read, draft, and send with approval.
3. Composio inbound triggers into routines.
4. IMAP/SMTP read and send.
5. IMAP inbound by polling.

## Consequences

- People get Gmail and Outlook without us going through Google's verification and CASA. In exchange:
  - The consent screen says "Composio". Showing agentes.chat needs our own Google OAuth app, and then verification and CASA are ours.
  - Composio is a data processor under the LGPD, and sees email content (`SELF_HOSTING.md` lists what it receives).
  - We depend on their pricing:
    - Pro is $29 a month, then about $0.0003–0.0005 per call.
    - **Triggers cost $0.003 per event**, so filtering at the source is mandatory.
- **Exit:** registering our own Google app and passing its assessment would move Gmail in-house behind the same tool names. Accounts connected earlier stay on the old auth config until they reconnect.
- **IMAP app passwords can't be scoped at the provider.** Our scopes protect against the agent (prompt injection from mail), not against someone who steals the credential from us. The screen suggests a dedicated mailbox. The KMS from ADR 0007 makes stealing the credential harder for every credential, this one included.
- **Prompt injection through inbound mail is reduced, not removed.** The defences are untrusted wrapping, approval on send, recipient lists, and runs started by inbound mail never approving their own sends. The agent screen warns about "reads outside mail + sends without asking".
- **Tests** use a fake Composio source and a fake IMAP/SMTP server (no network), following ADR 0003.
- **Self-host:** Composio is an adapter turned on by `COMPOSIO_API_KEY` (any install can bring its own project). The IMAP/SMTP connector works in core (`MAIL_IMAP_ENABLED`).

## As built

- Contract: `packages/adapters/src/mail.ts`; Composio `composio.ts` (REST v3.1); IMAP/SMTP `imap.ts` (`imapflow`, `nodemailer`, `mailparser`) and `mail-presets.ts`; fakes `mail-fake.ts`. Engine: `packages/engine/src/mail/*`. Tables: migration 0071. Routes: `apps/server/src/routes/app/mail.ts`, `POST /api/webhooks/composio`. Wiring: `mailAdapters` in `apps/server/src/start.ts`.
- Per-call checks: `ToolDefinition.checkCall` and `tools/checks.ts`; the GitHub repository check is the first connector-wide one.
- Tools per mailbox: `mail_<slug>_<verb>` (search, read, folders, attachment into the Drive as an untrusted file, draft, send, reply, forward, move, mark, archive, trash).
- Mail grants are changed only by the mail API: replacing an agent's scopes keeps them, and "all tools" never includes `mail:` scopes.
- A run started by inbound mail, and later runs in that thread, always ask before sending, even when the policy allows sending without asking.
- IMAP host names are resolved and refused when they point to private, loopback or metadata addresses. They are checked once before connecting, not pinned against DNS rebinding.
- Presets: iCloud, Yahoo, Zoho (and Zoho custom domains), Fastmail, Locaweb, Hostinger, GoDaddy, Titan and IONOS. KingHost and UOL Host are left out because no official settings page was found; those mailboxes use "Outro servidor".
- Outlook has no brand icon (Simple Icons removed it at Microsoft's request); the card shows a letter tile.
- A MillionSend inbox was a fourth path (`via = millionsend`), ADR 0102, withdrawn on 2026-11-02.

## Amendment (2026-10-31): connectors through Composio

ADR 0107 uses the same Composio project for connectors, not only mailboxes: one client, the same user id (`org_<orgId>`), explicit actions only, no meta tool. Its calls are counted with the mailboxes' (`composio_usage`, `COMPOSIO_CALLS_PER_MONTH`), its expired accounts come through the same webhook and reconcile, and its accounts are deleted at Composio without revoking (Composio's Google and Microsoft apps may share one grant with a mailbox). For the same reason, disconnecting a mailbox revokes its grant only when no live connector on the same provider's app, of the mailbox's account or of one it can't name, may share it.

## Addendum (2026-11-01): only the mailbox's owner gives access

Product decision: a mailbox is personal to whoever connected it, so only that person gives an agent access to it.

- **Giving or widening** (any scope the agent doesn't already hold, or any rule change, since a looser rule is access too) is only for the person who connected the mailbox (`mail_accounts.created_by_user_id`), and only for an agent they can talk to (`canTalkTo`, ADR 0085). It doesn't need `manage_agents`. Anyone else gets 403 `mail.owner_only`, with the owner's name in its params. An admin is refused too.
- **Taking away** stays open: the mailbox's owner, admins and the agent's owner may lower or remove an agent's access to any mailbox. When someone other than the owner lowers it, the saved rules stay as they were and the rules they sent are ignored.
- The mailbox's own settings follow the same rule (`updateMailAccount`): only its owner turns an action back on (out of `offActions`), stops one asking (out of `askActions`) or adds an address agents may send as. Anyone with `manage_connectors` still narrows them (more actions off or asking, fewer aliases) and changes the label, the password and the default From. In Conectores, "O que faz" is read-only for anyone but the owner, and "Quem usa" ends after the levels for them (their rules would be ignored).
- The owner, for an agent that doesn't talk to them (say it thinks with someone else's plan), may still lower or remove its access, keeping the saved rules, but not give or widen it.
- One click by someone other than the asker: the new agent may think with the clicker's plan account and then answers only the clicker, so the asker can't give it their mailbox until its owner lets them talk to it. The agent hears exactly that in the result, so it can tell them.
- An agent's mailbox rules need the mailbox's folders, so its owner may list them too (`listMailFolders`: the owner or `manage_agents`).
- `MailAccount.ownerUserId` says who connected each mailbox. On the agent page (web and phone), someone else's mailbox is read-only and says who gives it, with "Remover acesso" for admins and the agent's owner. The shared rule is `mailAccessOf` in `packages/client/src/lib/mail.ts`. In Conectores, the mailbox's "Quem usa" step offers anyone else only the levels below what each agent has. "Criar agente" lists only the creator's own mailboxes.
- `propose_agent` (ADR 0081): the card's mailbox line is the viewer's to give only when it's their own mailbox, admin or not. Otherwise it says who must give it. One click gives only the clicker's own mailboxes.
- `request_permission` and teammate change cards (ADR 0092) never name mailboxes, and `setAgentScopes` and `setAgentAccess` keep mail grants as they are, so `setAgentMail` is the only way a mail grant is made.
- Grants made before this stay as they are. No data is rewritten.
- If the owner's account is deleted (`created_by_user_id` becomes null), nobody can give access to that mailbox. It has to be connected again by someone.

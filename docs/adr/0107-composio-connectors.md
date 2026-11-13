# 0107. Connectors through Composio, and no native Google Drive

- Status: Proposed (built: the server, the shared client, the web and the phone app; each service ships after `bun run composio:check`, §12)
- Date: 2026-10-31
- Amends: ADR 0016 (the catalog loses Drive and its address field, presets gain a Composio way), ADR 0038 (which path serves which service), ADR 0015 ("Aprovar sempre" for Composio actions), ADR 0088 (the purge also forgets Composio connector accounts, and a mailbox's grant stays while a connector may share it)
- Builds on: ADR 0099 (several accounts per connector)
- Code: `packages/engine/src/connectors/composio.ts`, `presets.ts`, `listing.ts`, `custom.ts`, `connections.ts`, `mcp.ts`, `catalog.ts`, `packages/engine/src/mail/inbound.ts`, `mail/accounts.ts` (`composioGrantShared`), `workspace-deletion.ts`, `notification-producers.ts`, `packages/adapters/src/composio.ts`, `mail.ts`, `mail-fake.ts`, `read-capped.ts`, `apps/server/src/start.ts`, `engine.ts`, `workers.ts`, `routes/app/connectors.ts`, `routes/app/connectors-custom.ts`, `apps/server/scripts/composio-check.ts`, `packages/db/src/schema/connectors.ts`, migration `0141_composio_connectors`, `packages/config/src/schema.ts`, `packages/config/src/connectors.ts`, `packages/client/src/lib/composio.ts`, `connected.ts`, `apps/web/src/components/ConnectorCatalog.tsx`, `ConnectFlow.tsx`, `Connectors.tsx`, `apps/web/src/pages/SettingsPage.tsx`, `apps/mobile/src/features/connectors/*`, `apps/mobile/src/features/usage/UsageScreen.tsx`, `packages/i18n`

## Context

- The native Google Drive connector was not a Drive integration: the catalog entry `drive` was "any Drive-like MCP server", at an address the admin typed, signed in with Google OAuth (the restricted `drive` scope) or an API key. Google's restricted scope needs a yearly CASA assessment paid by the app's owner, and `drive.file` reaches only the files a person picks. No Cloud workspace had a native Drive connection.
- Composio already serves Gmail and Outlook mailboxes (ADR 0038) with its own verified OAuth apps. The same project key reaches about 1,700 toolkits, 125 of them with Composio's own OAuth app.
- Many services people ask for had no path here: Google Calendar, Sheets and Docs, Slack, HubSpot, Microsoft 365. Eleven one-click presets sat at "Em breve" because their vendors refused our OAuth registration: Asana, Square, Intercom, Mercado Pago, Semrush, Gamma, Dropbox, Meta Ads, RevenueCat, Vercel and Figma.
- Product decision: remove the native Drive connector, connect Drive through Composio, and add the other major services the same way. Connectors of our own can replace them when revenue allows.
- Product decision, later that day: only services that are plug-and-play through Composio. One that Composio connects only with a key the person pastes (Vercel, Meta Ads, Semrush, Gamma) or with an app of ours (X) would add to the Composio bill for what a connector of our own could do, so it stays out.

## Decision

### 1. One way per service, in a fixed order

Each service appears once in "Adicionar conector", through the first way that works on this server (`connectorListing`, `presetWay`):

1. Our own connector, when this server is set up for it (GitHub, and Sentry or Linear with their OAuth apps).
2. The vendor's MCP server, when it connects today (a preset not marked `soon`).
3. Composio, when this server has `COMPOSIO_API_KEY`.
4. "Em breve", for a `soon` preset that Composio doesn't serve here.
5. Otherwise the service is listed as unavailable: `find_tools` says this server can't connect it, and the apps hide it (§9).

A service never shows twice. When a vendor approves our registration later, its preset drops `soon` and wins again for new connections; accounts already connected through Composio keep working until someone disconnects them. GitHub never goes through Composio: Composio's GitHub actions would bypass the agent's repository list. Gmail and Outlook mailboxes stay as ADR 0038 built them. This replaces ADR 0038's row "apps with a good official MCP: direct MCP, never through Composio": an official MCP server that refuses us no longer keeps a service out.

### 2. The first set: 15 services

Google Drive first, then Composio's own popularity order (composio.dev/toolkits, read 2026-10-31, rank in brackets), then the services outside its top 50. Each signs in with Composio's own OAuth app (§3), so it needs no app of ours and nothing for the person to paste.

| # | Service (`id`) | Toolkit | Sign-in | Replaces or sits beside |
| --- | --- | --- | --- | --- |
| 1 | Google Drive (`drive`) | `googledrive` | Composio's Google app [3] | Replaces the native `drive` entry |
| 2 | Google Calendar (`google-calendar`) | `googlecalendar` | Composio's Google app [2] | New |
| 3 | Google Sheets (`google-sheets`) | `googlesheets` | Composio's Google app [6] | New |
| 4 | Slack (`slack`) | `slack` | Composio's Slack app [10] | New |
| 5 | Google Docs (`google-docs`) | `googledocs` | Composio's Google app [12] | New |
| 6 | HubSpot (`hubspot`) | `hubspot` | Composio's HubSpot app [14] | New |
| 7 | Asana (`asana`) | `asana` | Composio's Asana app [17] | The `soon` preset's Composio way |
| 8 | Microsoft Teams (`microsoft-teams`) | `microsoft_teams` | Composio's Microsoft app [23] | New |
| 9 | Salesforce (`salesforce`) | `salesforce` | Composio's app, plus the org's subdomain [27] | New |
| 10 | Figma (`figma`) | `figma` | Composio's Figma app [41] | The `soon` preset's Composio way |
| 11 | OneDrive (`onedrive`) | `one_drive` | Composio's Microsoft app | New |
| 12 | Zendesk (`zendesk`) | `zendesk` | Composio's app, plus the subdomain | New |
| 13 | Intercom (`intercom`) | `intercom` | Composio's Intercom app | The `soon` preset's Composio way |
| 14 | Dropbox (`dropbox`) | `dropbox` | Composio's Dropbox app | The `soon` preset's Composio way |
| 15 | Square (`square`) | `square` | Composio's Square app | The `soon` preset's Composio way |

- **Stay "Em breve":** RevenueCat and Mercado Pago, which Composio has no toolkit for, and Vercel, Meta Ads, Semrush and Gamma, which it connects only with a key the person pastes.
- **Left out:** X. Composio dropped its own X app, so X would take an X developer app of ours.
- **Unchanged:** GitHub, the Gmail and Outlook mailboxes, IMAP mailboxes, and the presets that connect today. Composio has toolkits for many of them, and they stay on the vendor's MCP server.
- **Google, one toolkit per app,** not Composio's Google Super: a smaller consent per service, and an admin can give an agent Calendar without Drive.
- **Next, not now:** Zoom, Box, Trello, Excel, SharePoint, Google Slides and Tasks, and Outlook Calendar, each only if Composio's own app signs in to it. Pipedrive, Shopify and LinkedIn Ads need apps of our own, so they stay out.
- **Social networks, added 2026-11-10** in a `social` category: Instagram, Facebook (Pages), LinkedIn, YouTube, Pinterest, Reddit and WhatsApp (Business), each on Composio's own app (its docs said "Composio-managed OAuth available" for each that day; WhatsApp also takes a key, never offered). Each lists only what that app can do: Instagram leaves out comments (the app lacks Meta's comment-management permission), LinkedIn posts as the signed-in member only (company pages need `r_organization_admin`, which LinkedIn refuses beside `w_member_social`), YouTube keeps to actions of 1 or 50 quota units on Composio's shared Google project, Reddit leaves out the inbox, wiki, moderation and votes (the app asks for none of them, and Reddit allows only votes a person casts), and WhatsApp sends but reads no incoming message (the Cloud API delivers those by webhook only). Uploads that take a file Composio holds stay out everywhere: the actions that fetch a public URL do it. Discord stays out: its actions are the app's own (commands, entitlements), and a person's sign-in can't post to channels.

### 3. A Composio way on a preset

A Composio service is a preset (`presets.ts`) with a `composio` field. A `soon` preset gets the field too, so each service stays one object:

```ts
composio?: {
  toolkit: string // "googledrive"
  version: string // pinned, "20261022_00"
  auth: "managed" // Composio's own OAuth app, the only sign-in a way takes
  actions: readonly string[] // the explicit actions agents get
  ask?: readonly string[] // always ask, whatever their words say
  prefix?: string // when the actions' prefix isn't the toolkit's
}
```

- **Its address** is `https://backend.composio.dev/api/v3.1/toolkits/<toolkit>` (`composioToolkitUrl`). Nothing ever fetches it: it only names the service, and `withComposio` never hands it to MCP. A Composio-only entry has it as its `serverUrl`. `presetForServer` matches either address of a preset, so the listing, `find_tools` and the connect flow find a Composio connection's service, and the apps match a connection to its card by that address (`fromServer`, `connectedIds`).
- **The listing** emits each preset with the address of the way §1 picked, `kind: "remote_mcp"` and `via: "composio"` (also on a Composio-only entry this server can't connect). Keeping `remote_mcp` means apps already installed connect it as a server by address through the route they call today (`POST …/connectors/custom`), with no update. `POST …/connectors/presets/{id}/connect` takes the address of the way §1 picked. `ServerCatalog` carries the Composio state, so the catalog route and `missingConnectors` agree.
- **The sign-in is plug-and-play:** Composio's own OAuth app, which the Composio client (`packages/adapters/src/composio.ts`) finds or creates once per toolkit, as Gmail's is, unless an auth config named in `COMPOSIO_AUTH_CONFIGS` (`toolkit=ac_…` pairs: an OAuth app of the server's own, or a white label) replaces it. A service Composio connects only with a key the person pastes or with an app of ours gets no way (Context). Every way says `auth: "managed"`, and a test checks each preset.
- `COMPOSIO_GMAIL_AUTH_CONFIG_ID` and `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` stay. `ComposioToolkit` widens to any toolkit slug, and `COMPOSIO_MAIL_TRIGGERS` keeps its two keys under `ComposioMailToolkit`.

### 4. Connecting, on the web, the phone and the desktop app

A Composio connection is a server connected by address: a `connector_connections` row `custom:{id}` at the toolkit's address, with `composio_account_id` and no secret. So "O que faz", "Quem pode usar", the agent's access tree, grants, approvals, "Aprovar sempre" rules and disconnecting work as for any MCP server, and ADR 0099's accounts apply as they are.

1. **Conectar.** The apps send the entry's address (and `connectionId` for Reconectar) to the routes they already call. `connectCustomServer` sees a Composio address and, instead of probing a server, creates a Connect Link for the user `org_<orgId>` with the callback `/api/app/connectors/oauth/callback?state=<state>` (`beginComposioConnect`). It stores an `oauth_states` row (the state's hash, the person, `returnTo`, `connection_id`, no PKCE verifier) with the link's connected account (`composio_account_id`), and answers `{ status: "oauth", authorizeUrl }`: the link with our `state` appended, which the phone reads to recognize its return. The state lasts 10 minutes, as Composio's pending account does.
2. **Composio's page.** The person signs in to the service there (Salesforce and Zendesk also ask for the subdomain). The page is Composio's and in English, and the consent screen says "Composio". Step 1 of the dialog says so in one line. The apps show no key field for Composio entries.
3. **The return.** Composio sends the browser to our callback with `status` and `connected_account_id` added. The callback reads `status=failed` as `connector_error=unfinished` and passes `connected_account_id` on as the authorization `code`. The web finishes with its session; the phone and the desktop app get `state` and `code` through their links and finish with `POST …/connectors/oauth/complete`.
4. **Completing** (`completeComposioOAuth`, from `completeOAuth`): the usual state checks (known, unused, unexpired, the person who started it, still an admin), then the `code` must equal the account stored at step 1. Composio's callback parameters prove nothing on their own; this binds the account to the person who started it, and someone else who opens the link comes back without that person's session. The account is read until `ACTIVE` (up to 10 reads, 1 s apart); a sign-in Composio failed or never finished is refused (409 `connector.unfinished`) and deleted there without revoking: its state is used up, so nothing here could finish one still pending, which might turn active later. Its id and name come from the entry's account action when it has one (ADR 0099's `account`, which may read one object: `GOOGLEDRIVE_GET_ABOUT` for Drive), else its name from Composio's `displayName`, else a number.
5. **Stored** by `storeCustomConnection` with the Composio account and no secret. The route then lists the tools (`syncCustomTools`) and applies our classification (`acceptCustomSuggestion`), as for a preset. The web lands on `?connected=custom:{id}&outcome=…`; the phone on the account's tools.
6. **Several accounts.** "Adicionar outra conta" runs the same flow and ADR 0099 decides: a new row "Google Drive (ana@acme.com)" or "Google Drive 2", tools `google_drive_2_…`, starting with no agent. The same account again only swaps in the new Composio account (`same_account`), and the one it replaces is deleted there.
7. **Reconectar** runs the same flow with `connectionId`: the row keeps its name, tools and grants and gets the new Composio account. Another account is refused (409 `connector.other_account`) when the entry can tell, and that sign-in is deleted at Composio. The replaced account is deleted at Composio without revoking (§8).

`connected.ts` shows no host for a Composio account (`viaComposio`: `backend.composio.dev` means nothing to people), the phone's account screen says "Pela Composio" where it showed a server's address, and both catalogs say "Pela Composio" in how a service connects.

### 5. Tools

- **Explicit actions only** (ADR 0038). Each entry lists 8 to 20 actions: the reads people ask for, the everyday writes, and the sends, deletes, shares and publishes, which ask. No raw query, GraphQL, SQL or proxy action, no `COMPOSIO_` meta tool, nothing on a whole account's permissions or billing.
- **Listing.** A session per connection (`composioSession`) stands in for MCP behind `McpConnect`; `withComposio` wraps the server's `connect` in `engine.ts` and in the connector routes. It lists a toolkit's tools once per pinned version and client (`GET /api/v3.1/tools`, filtered to the entry's actions), since every account of a toolkit has the same schemas; an empty answer isn't kept. Pinning keeps the schema the model sees and the one that runs the same.
- **Names.** The action without its toolkit's prefix, in lower case, after the connection's tool prefix: `GOOGLEDRIVE_FIND_FILE` is `google_drive_find_file`, and `google_drive_2_find_file` on a second account. Grants and denials of single tools are keyed by these names, and a connector of our own can later serve the same names. A test checks that each action starts with its prefix and that no two map to one name.
- **Levels** come from Composio's tags and our classifier. The session reports `readOnlyHint` when Composio tags the action `readOnlyHint` and it doesn't ask; `destructiveHint` when Composio tags it `destructiveHint`, when `actionLevel` calls it sensitive, or when the entry's `ask` names it. `syncCustomTools` then classifies as for any server. Nothing syncs on its own, so the tool source also reads the session's `destructiveHint` on each listing: an action a later `ask` list or pinned version makes ask asks on every connection at once, and is never approved for good.
- **`ask` lists** cover what the words don't show: Google Calendar's event writes (they can invite people), Drive's permissions and Dropbox's and OneDrive's links (they share), YouTube's comment moderation (it can ban the author) and Pinterest's board changes (a secret board made public shows its pins). Posting and commenting on the social networks don't ask. Instagram's publish step and LinkedIn's link share are posts too: writes whatever their words say (`POSTING_ACTIONS` in `classify.ts`, the only actions `publish` and `share` don't make sensitive), which admins can still make ask. Replies and sends ask.
- **Approvals.** A sensitive action asks on every call, its card titled "{account}: {action}" with the arguments. "Aprovar sempre" (ADR 0015) is offered for an action that asks only because of its level: the source sets `rememberAs` to the tool's own name (`create_folder`) when the tool isn't sensitive and its action isn't one that always asks (`alwaysAsks`: deploy, release, run, execute, trigger, a query). The gateway still decides each call.
- **Running.** `executeTool(slug, { connectedAccountId, userId: "org_<orgId>" }, input, version)`, the call mail makes, plus the pinned version. Write calls are audited (`connector.tool_changed`), and output is untrusted. An answer loses its credential fields (`access_token`, `refresh_token`, at any depth, `withoutTokens`) before anything reads it: Facebook lists a person's Pages with each Page's token, which would let an agent act around its approvals.
- **Files.** A file in the answer (an object with Composio's short-lived `s3url`, or inline bytes, read by the helper mail uses for attachments, `composioFile`) is downloaded at once by `keepComposioFiles` in `mcp.ts`. The answer carries the service's data too, so every link `composioFile` follows (a nested `file`, `response_data`, `url`, `download_url`…) passes the SSRF guard of ADR 0019 right where it is fetched, never through a redirect, and is read only up to the Drive's 50 MB (`FileTooLargeError`: the agent hears the file is too large to keep). Text that fits half the result limit comes back as text, anything else is kept in the workspace's Drive as untrusted content (`createFileArtifact`), and the answer names the file. The link never reaches the model.
- **On demand.** Each connection is its own group (ADR 0043), loaded when the run needs it.

### 6. Who can use it

As for any server (ADR 0099 §5): every account of a service is every agent's at "Ler e escrever" (`connector:*`), and the dialog ends on a short confirmation with "Quem pode usar" under "Ajustar". Sensitive actions ask at any level.

### 7. Counting, showing and capping calls

Composio bills each tool call to our project, and its limits are per project, shared by every workspace on the server. As published on 2026-10-31: the free plan stops at 100,000 calls a month (20,000 through Composio's own apps); Pro is US$ 29 a month with US$ 29 of usage, then US$ 0.0003 a call (US$ 0.0005 through Composio's own apps), plus US$ 0.0001 per direct call past 10,000 a month.

- **Count.** `composio_usage` (`org_id`, `month`, `calls`, `capped_at`), one row per workspace and calendar month (UTC). The client runs `meterComposio` (wired in `start.ts`) before every tool call: connectors, mail tools, and the address and account reads. The workspace comes from the call's user id (`org_<orgId>`). One statement adds one only while the count is under the cap, so a capped workspace never reaches Composio. Listing tools and reading accounts aren't tool calls and aren't counted.
- **Cap.** `COMPOSIO_CALLS_PER_MONTH`, per workspace; 0 (the default) for none: a self-hosted server pays its own project. The Cloud starts at 5,000. At the cap, Composio tools answer `composio.monthly_limit` ("This workspace used its 5,000 Composio calls for November. They come back on December 1."), and the workspace's connector admins get one notification that month (`composio_limit`, in the inbox; it opens Uso).
- **Show.** `GET /api/app/organizations/{orgId}/usage/composio` answers `calls`, `limit` and `month`. Configurações › Uso, on the web and the phone, has one line: "Composio: 1.234 de 5.000 chamadas em novembro". Conectores shows the same line past 80% of a cap. These are calls, not money: every member sees them.
- Trigger events aren't counted: connectors create none (§11).

### 8. Errors, expired accounts, disconnecting

- **The account stopped working** (a `MailAuthError`). The row gets `status = needs_reconnect` and `last_error`; its tools leave the agents' lists, `find_tools` says the service needs reconnecting, and Conectores shows "Reconectar" on its row (the phone, a line on the account's screen). Composio's `connected_account.expired` webhook does the same: `handleComposioWebhook` also marks connector rows by `composio_account_id`.
- **Recovery.** The 15-minute `mailReconcile` tick also reads the connector rows marked `needs_reconnect`, and one Composio reports `ACTIVE` again goes back to `active` (`reconcileComposioConnectors`). Healthy rows aren't read.
- **Our key refused** (401 or 403, `ComposioKeyError`). The call says Composio refused this server's key, the server logs it, and the account isn't marked.
- **Busy or down** (Composio's own 429, 5xx, a timeout). The call says to try again in a minute. Nothing retries on its own.
- **The action failed** (`successful: false`, a `ComposioActionError`: bad input, not found, the service's quota). Composio's message comes back as the tool's error, as untrusted text, whatever its words say: "quota exceeded" or "unavailable" there is the service's answer, not Composio's health.
- **Disconnecting** (`revokeConnection`, behind both disconnect routes) also deletes the account at Composio with `revoke_on_delete=false`, best effort after the commit. It never revokes: Composio's Google and Microsoft apps may share one grant across toolkits and across our workspaces, so a revoke could cut a mailbox or another workspace's connection of the same account. The confirmation adds that the service's own account settings can remove Composio there too.
- **Mailboxes.** Disconnecting a mailbox and the purge revoke its grant (ADR 0088 §3) only when no live connector on the same provider's app may share it (`composioGrantShared`): Drive, Docs, Sheets and Calendar for Gmail, OneDrive and Teams for Outlook, of the mailbox's account, or of an account the entry can't name.
- **Deleting a workspace** (`revokeGrants`, ADR 0088) deletes its Composio connector accounts the same way, disconnected ones included, before its mailboxes, so they don't keep those grants. It also deletes the account of every Connect Link the workspace made (`oauth_states.composio_account_id`): a sign-in that never finished, or one someone else finished on the link, which no connection holds. These are our own records, not Composio's listing by user id, so no filter read differently can reach another workspace's accounts.

### 9. Without `COMPOSIO_API_KEY`

- Composio-only services are listed as unavailable, with `via: "composio"`. The web and the phone hide them, unless one is still connected, and for admins the catalog ends with one line: "Google Drive, Slack e mais 8 serviços conectam pela Composio. Para ligar, quem administra este servidor define COMPOSIO_API_KEY (veja SELF_HOSTING.md)."
- The `soon` presets stay "Em breve".
- `find_tools` says this server can't connect them.
- Accounts left on a server whose key was removed keep their rows and show no tools until it comes back.
- A self-hosted server brings its own Composio project: every service works at once, on Composio's own apps.

### 10. Removing the native Google Drive connector

- **Catalog.** The `drive` entry leaves `catalog.ts`, and `ConnectorDefinition.serverUrl` is a plain string. The Drive branch of `startOAuth` goes, and so does the `serverUrl` override of `startOAuth` and `createApiKeyConnection`. The routes drop `serverUrl` from `…/oauth/start` and `POST …/connectors` (an older app's extra field is ignored).
- **Listing.** `needsServerUrl` goes from the listing, the route's schema and both apps' address fields for catalog entries. The Composio preset keeps the id `drive`, so `CONNECTOR_BRANDS.drive`, both apps' suggestion lists, `connectors.descriptions.drive` and the name `drive` in `find_tools` keep working.
- **Config.** `CONNECTOR_GOOGLE_CLIENT_ID` and `CONNECTOR_GOOGLE_CLIENT_SECRET` leave `schema.ts` and `connectorOAuthApps`. A server that still sets them ignores them. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` stay: they are Sign in with Google.
- **i18n.** `scopes.drive_files_read`, `drive_files_write` and `drive_files_share` go.
- **Dead keys.** `gdrive` goes from `capabilities.ts`, `tools/directory.ts`, `agent-status.ts`, `packages/client/src/lib/activity.ts` and the Team page: no scope or tool name ever had that prefix. `activity.ts` knows Composio Drive's tool names (`google_drive_…`) and its accounts' names.
- **Rows.** migration 0156 disconnects any native `drive` row as `revokeConnection` does (its grants and "Aprovar sempre" rules deleted, `revoked_at` set). Only a self-hosted server can have one.
- **Kept, unrelated:** the built-in Drive (`drive:read`, `drive:write`), Settings › Armazenamento's "Google Drive: Em breve" (ADR 0019), the agent import's `google-drive` labels.

### 11. Out of scope now

- Composio triggers for connectors (a new Drive file or a Slack message starting a routine).
- Composio sessions (its tool router) and their MCP address. Direct execution stays, the path mail uses. Moving waits until direct calls pass 10,000 a month or Composio deprecates them.
- OAuth apps of our own for a white-labelled consent, and a connect page in pt-BR.
- Connections per person: accounts belong to the workspace (`org_<orgId>`).
- Binary uploads to a service, per-call checks (`checkCall`) such as allowed share recipients or asking for a calendar event only when it invites people, caps per plan, Composio's cost on invoices, and Composio's own approvals and firewall.

### 12. Before each service ships

`bun run composio:check` reads `COMPOSIO_API_KEY` and, without writing, prints for each entry the toolkit's sign-in schemes (Composio's own app has to be one, §3), the scopes of that app (`GET /toolkits/{slug}`), and whether each listed action (and the account action) exists at the pinned version, with its tags; it exits non-zero when one is missing. `--account ca_…` reads a test account: its toolkit, status, `displayName` and granted scopes. `--links` (it writes) opens two Connect Links for one throwaway user on Drive with `state` appended and deletes both pending accounts after.

- **Drive ships only if Composio's Google app grants the full `https://www.googleapis.com/auth/drive` scope.** Full access is the reason for the change. If it grants less, Drive waits and the other services ship.
- **On the Cloud, all of this comes before the change merges**, with the cap (5,000) and a spend limit at Composio already in place: once deployed, every service goes live at once, and past its plan's limit Composio pauses the whole project, mailboxes included. An entry that fails the check loses its `composio` way first.

### 13. Schema (migration 0156)

- `connector_connections`: `composio_account_id` (indexed), `status` (`active` or `needs_reconnect`, default `active`), `last_error`.
- `oauth_states`: `composio_account_id`; the PKCE verifier columns may be null (a Composio sign-in has none).
- `composio_usage`: as in §7, with `org_id` and a unique key on (`org_id`, `month`).
- The native `drive` rows' disconnect (§10).
- Config: `COMPOSIO_AUTH_CONFIGS` and `COMPOSIO_CALLS_PER_MONTH` join `COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SECRET` and the two mail auth config ids in a "Composio" section.

## Consequences

- 15 services become connectable without an app of ours or a key to paste, and the Drive connector that couldn't reach a workspace's files goes.
- Composio sees what agents read and write in those services. The privacy policy, SELF_HOSTING.md and README.md say which services go through it. Consent screens say "Composio". Microsoft tenants may need an admin's consent, and a Slack workspace that allows only Marketplace apps shows a warning.
- Provider quotas on Composio's own apps are shared by all of Composio's customers.
- Composio's prices changed at least twice since July 2026: check them before setting ours.
- An action Composio renames in a new version arrives, after the version moves, as a new tool waiting in "Precisam da sua decisão", like a preset's new tool.
- A sign-in finished at Composio whose return never reached us stays there as an unused account; it is never stored here.
- Tests run on PGlite with the fake Composio client (`mail-fake.ts` gains `listTools`, `executeTool` and `fetchFile`): `packages/engine/test/composio-connectors.test.ts`, the connector routes in `apps/server/test/connectors.test.ts`, the purge, the client's and the apps' pieces.

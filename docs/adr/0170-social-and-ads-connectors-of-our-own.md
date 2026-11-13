# 0170. Social and ads connectors of our own: X, TikTok, Threads, Meta Ads and Telegram

- Status: Proposed
- Date: 2026-11-10
- Extends: ADR 0016 (connectors: the workspace connects once, our scope catalog, agent grants), ADR 0107 (Composio only
  on its own OAuth app), ADR 0156 (tools of ours beside a catalog connector), ADR 0015 (Tool Gateway and approvals),
  ADR 0103 (connector usage), ADR 0053 (routines fired by events)
- Code (to build): `packages/engine/src/connectors/catalog.ts` (five entries, `native`, the OAuth options),
  `connectors/native/` (`index.ts`: the tool source and `call`; `telegram.ts`, `x.ts`, `threads.ts`, `meta-ads.ts`,
  `tiktok.ts`), `connectors/connections.ts` (options and hooks), `connectors/mcp.ts` (skips native entries),
  `connectors/listing.ts` (brands, `needsApp`), `packages/config/src/connectors.ts` and `schema.ts` (the apps'
  variables), `apps/server/src/engine.ts` (the source), `apps/server/src/routes/social.ts` (Telegram's updates, Meta's
  deauthorize and data deletion, the media link), `apps/server/src/workers.ts` (token sweep, Telegram polling), a
  migration (`telegram_updates`), the apps' copy and icons (web `ConnectFlow.tsx`, `ConnectorCatalog.tsx`, phone
  `ConnectSheet.tsx`, `ConnectionScreen.tsx`), SELF_HOSTING.md, `docs/social-apps-checklist.md`

## Context

Product decision: Composio connects a service only on Composio's own OAuth app (`ComposioWay.auth: "managed"`,
`presets.ts:68-87`, checked by `connectors-presets.test.ts`). A service where Composio needs a person's key or a
developer app of ours gets a connector of ours. Among the big social and marketing services that is X, TikTok, Threads,
Meta Ads, Telegram (a bot token) and Snapchat. Instagram, Facebook Pages, LinkedIn, YouTube, Pinterest, Reddit and
WhatsApp connect through Composio's own apps, in another change.

### What this builds on (main at 95ad692)

- **Catalog connectors.** `CONNECTOR_CATALOG` (`catalog.ts:66-253`: GitHub, Sentry, Linear) maps each tool to one of
  our scopes (`ConnectorTool`, `catalog.ts:18-35`: `scope`, `sensitive`, `title` for the approval card, `ours` for a
  tool we serve). Each entry names its MCP server and its OAuth endpoints (`ConnectorDefinition.oauth`,
  `catalog.ts:49-62`). `connectorOAuthApps` (`packages/config/src/connectors.ts:4-13`) reads the apps from
  `CONNECTOR_GITHUB_*`, `CONNECTOR_SENTRY_*` and `CONNECTOR_LINEAR_*` (`schema.ts:589-599`, `649-670`).
  `CONNECTOR_GOOGLE_*` left with ADR 0107 (`0107-composio-connectors.md:141`).
- **OAuth.** `startOAuth` (`connections.ts:606-656`): random state (only its hash stored), PKCE S256 with the verifier
  sealed, 10 minutes, bound to the person. One redirect URI for every connector,
  `{PUBLIC_URL}/api/app/connectors/oauth/callback` (`connections.ts:176-177`); the phone and the desktop app finish
  through their deep links
  (`oauth-return.ts:9-25`, `routes/app/connectors.ts:323-404`, `…/oauth/complete`). `completeOAuth`
  (`connections.ts:765-823`) swaps the code in `tokenRequest` (`675-706`: the client secret in the form; a refused
  client is `MisconfiguredError`, a refused sign-in `TokenRefused`, a 5xx or 429 a busy provider).
- **Connections and tokens.** `storeConnection` (`connections.ts:224-307`) seals
  `{ accessToken, refreshToken, apiKey }` with envelope encryption: a fresh data key, wrapped by the installation's
  `KeyWrapper` (a KEK derived from `AGENTES_SECRET`, a KMS on the Cloud: `crypto.ts:83-127`), bound to
  `connector-connection|org|id` (`connections.ts:173`). One live connection per catalog connector and workspace
  (unique index, `packages/db/src/schema/connectors.ts:107`): connecting again replaces it and moves grants and
  "Aprovar sempre" (`connections.ts:283-287`); a first one gives every agent `connector:*` (`grantToEveryAgent`,
  `112-141`).
  `connectionHeaders` refreshes a token a minute before it ends (`832-848`), one refresh at a time across replicas
  through the `refreshing_until` lease (`863-903`), which keeps rotating refresh tokens safe; a refused refresh marks
  the connection `needs_reconnect` (`markToReconnect`, `715-725`). `revokeAtProvider` revokes GitHub's token only
  (`387-409`).
- **Tools of ours on a connection.** `createGitToolSource` (`git/tools.ts:98-200`) serves GitHub's `ours` tools with
  the connection's id and scope (`connectorScope("github", "git.read")`) and usage `via: "native"`
  (`schema/connectors.ts:330`). `createConnectorToolSource` (`mcp.ts:238-526`) lists a catalog connector's MCP tools,
  skips `ours` (`mcp.ts:462`), and marks results `external`. ADR 0156's GitHub App is the other native path: tokens per
  installation (`git/github-app.ts`, `github-call.ts:134`), set from `GITHUB_APP_*` or made from Settings
  (`github-app-settings.ts:63`).
- **Composio presets.** `McpPreset` (`presets.ts:30-66`); `meta-ads` is Meta's own MCP server, `soon`
  (`presets.ts:933-941`). Errors reach the agent as a cause and one way out (`composioFailure`, `composio.ts:327-357`);
  calls are counted per workspace and month with an optional cap (`meterComposio`, `composio.ts:375-408`,
  `COMPOSIO_CALLS_PER_MONTH`, `schema.ts:750`).
- **Tool Gateway.** `ToolDefinition` (`tools/types.ts:88-201`: `scope`, `connectionId`, `connector`, `sensitive`,
  `external`, `ahead`, `describe`, `checkCall`, `rememberAs`) from any `ToolSource` (`types.ts:213-216`). Grants are
  `*`, `connector:*`, `tool:` and `deny:` rows (`tools/scopes.ts:268-277`). The run policy reads a connection's tool as
  a read when its scope ends in `.read` and it isn't sensitive, else as a write to a connected app
  (`run-policy.ts:204-221`), which a routine asks a person for unless its creator allowed it (`run-policy.ts:18-26`).
  Sensitive tools ask on every call (`gateway.ts:68-71`); "Aprovar sempre" only where the tool has `rememberAs` and
  nothing in its names always asks (`gateway.ts:139-160`); approvals are bound to the call's hash and last 24 hours
  (`gateway.ts:220-227`). Connector-wide argument checks by scope prefix: `tools/checks.ts:11-18`.
- **Approvals.** The agent's owner or whoever holds `approve_actions` decides; `request_permission` is admins'
  (`approvals.ts:451-484`); covers pass a person's approvals on (`approvals.ts:535`); rules in `approval-rules.ts:9-17`.
- **Self-hosting.** Every variable lives once in `schema.ts` (`EnvVarDefinition`, `schema.ts:13-40`; `bun run docs:env`
  writes `.env.example`). SELF_HOSTING.md documents the sign-in clients (line 726), Composio (740-741, 796-808), the
  GitHub App (973-1012) and what needs a public URL (664-681). `reachableFromInternet`
  (`engine/src/apps/urls.ts:114`) tells whether the internet reaches this server.

### The services (vendors' pages, read 2026-11-10)

- **Telegram.** Bot API 10.4 ([changelog](https://core.telegram.org/bots/api-changelog)). A token from @BotFather
  (`/newbot`, `/token` makes a new one), no review, free ([bots](https://core.telegram.org/bots)). A bot can't start
  a conversation; in groups privacy mode (on by default, off for admin bots) limits what it sees; updates are kept
  24 hours and there is no history method; `getUpdates` and a webhook exclude each other; the webhook sends
  `X-Telegram-Bot-Api-Secret-Token` ([API](https://core.telegram.org/bots/api)). About one message a second per chat,
  20 a minute per group, 30 a second in all, then 429 with `retry_after` ([FAQ](https://core.telegram.org/bots/faq)).
  Uploads up to 50 MB (photos 10 MB), downloads 20 MB. A manager bot with Bot Management Mode can create a bot for a
  person from a `t.me/newbot/…` link and read its token (`getManagedBotToken`,
  [features](https://core.telegram.org/bots/features)).
- **X.** Pay-per-use credits only; legacy Basic and Pro moved to it in 2026
  ([pricing](https://docs.x.com/x-api/getting-started/pricing)): a post $0.015, a post with a URL $0.20, $0.005 per post
  read, $0.010 per user read; reads of the app owner's own account $0.001; at most 3 million post reads a month.
  Self-serve lost following, likes and quote posts on 2026-04-20 ([changelog](https://docs.x.com/changelog)). Replies
  only where the post's author summoned the account ([manage posts](https://docs.x.com/x-api/posts/manage-tweets/integrate));
  an app whose AI writes replies needs X's approval first, automated accounts carry the Automated label, no unsolicited
  mentions, no auto-likes ([guidelines](https://docs.x.com/developer-guidelines)). Express and informed consent before
  acting for someone, "a person authenticating into your service does not by itself constitute consent"
  ([policy](https://docs.x.com/developer-terms/policy)). The pay-per-use terms are for "applications with a limited
  number of end-users", above which X asks for Enterprise ([PPU agreement](https://docs.x.com/developer-terms/ppu-agreement)).
  OAuth 2.0 with PKCE at `x.com/i/oauth2/authorize`, token and revoke at `api.x.com/2/oauth2/…`, access tokens for 2
  hours, the code swapped within 30 seconds
  ([OAuth 2.0](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)); refresh tokens
  (`offline.access`) single use, about 6 months
  ([refresh](https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange)); confidential clients
  in HTTP Basic, never in the form, and one live grant per app and X account, so a second sign-in revokes the first
  ([X's Ads MCP page](https://docs.x.com/x-ads-api/mcp)). Callback URLs match exactly, 10 at most
  ([apps](https://docs.x.com/fundamentals/developer-apps)). Per user: 100 posts and 50 deletes per
  15 minutes, 300 mention or search reads; per app 10,000 posts a day; `x-rate-limit-reset` on 429
  ([rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)). Media upload works with user tokens
  (`media.write`).
- **Threads.** Meta app with the Threads use case and its own Threads app id and secret. Each permission
  (`threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`,
  `threads_manage_mentions`, `threads_manage_insights`, `threads_delete`, …) needs App Review and a published app for
  people without a role; before that only Threads testers ([get started](https://developers.facebook.com/documentation/threads/get-started));
  advanced access needs business verification ([app review](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/content)).
  Code at `threads.com/oauth/authorize`, a 1-hour token from `graph.threads.com/oauth/access_token`, exchanged for a
  60-day one (`th_exchange_token`) that refreshes once at least 24 hours old (`th_refresh_token`)
  ([long-lived tokens](https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens)). A post is
  a container then a publish; media must be at a public URL Meta fetches; 500 characters; 250 posts, 1,000 replies and
  100 deletes per 24 hours, read at `threads_publishing_limit`
  ([overview](https://developers.facebook.com/documentation/threads/overview)). No price on Meta's pages.
- **Meta Ads.** Marketing API v27.0, a version every four months, each kept at least 90 days after the next
  ([changelog](https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog)).
  Another business's ad accounts need full (advanced) access to `ads_read` and `ads_management`, App Review and a
  verified business ([authorization](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization),
  [business verification](https://developers.facebook.com/documentation/development/release/business-verification)),
  plus the Marketing API full access tier: 500 calls in 15 days under 15% errors. Facebook Login for Business with a
  configuration (`config_id`) gives a business integration system-user token that doesn't expire by default
  ([Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business));
  redirect URIs match exactly (Strict Mode). Rate limits are points per app and ad account (60 in development, 9,000
  with full access) and hourly business use case limits, with `X-Ad-Account-Usage` and `X-Business-Use-Case-Usage`
  ([rate limiting](https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting));
  budgets change at most 4 times an hour per ad set. Campaigns need `special_ad_categories`; delete can't be undone.
  Meta's own Ads MCP server takes only employee system-user tokens
  ([Ads MCP](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started)),
  so it can't stand in for a customer's sign-in.
- **TikTok.** Login Kit for Web at `www.tiktok.com/v2/auth/authorize/` with `client_key` and comma-separated scopes,
  no PKCE on the web (`code_verifier` is for mobile and desktop), redirect URIs https, static, 10 at most
  ([Login Kit for Web](https://developers.tiktok.com/docs/en/login-kit-web)). Access tokens last 2 hours, refresh
  tokens 180 days and rotate on every refresh (another page still says a year); revoke at `/v2/oauth/revoke/`
  ([access token](https://developers.tiktok.com/docs/en/oauth-get-a-user-access-token)). Scopes `user.info.basic`,
  `user.info.profile`, `user.info.stats`, `video.list`, `video.upload` (to the creator's drafts) and `video.publish`
  (Direct Post), approved with the app ([scopes](https://developers.tiktok.com/docs/en/tiktok-api-scopes)); review
  takes days to two weeks, with demo videos, and refuses apps for private use
  ([app review](https://developers.tiktok.com/docs/en/app-review-guidelines)). Until TikTok audits the app, Direct
  Post reaches at most 5 people a day, private accounts only, as `SELF_ONLY`; after it, about 15 posts a day per
  creator, shared by every app. Each post needs TikTok's own screen: the creator's nickname, a privacy choice with no
  default, comments, duet and stitch unchecked, the commercial content disclosure, the music confirmation, a preview,
  and nothing sent before the person consents; "a utility tool to help upload contents to the account(s) you or your
  team manages" and copying from other platforms are refused
  ([guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)). Drafts: at most 5 pending a day,
  finished by the creator in TikTok ([upload](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video)).
  Photos come only from a verified URL prefix; video from one too, or in 5 to 64 MB chunks
  ([media](https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide)). Six post calls a minute
  per token; the Display API lists public videos, 20 a page. Comments aren't in Login Kit: TikTok API for Business's
  Accounts API has them, for business accounts, after its own access form and never for individual developers
  ([Accounts API](https://business-api.tiktok.com/portal/docs?id=1737944384433218)). No fee on its pages.
- **Snapchat.** The Public Profile API posts Stories, Saved Stories and Spotlight to Public Profiles and reads their
  stats, but it is "currently allowlist only": an OAuth app made in a Snap business account, its client id sent to a
  Snap contact, no form ([get started](https://developers.snap.com/marketing-api/Public-Profile-API/GetStarted)).
  Creative Kit opens Snapchat with the content and the person posts it
  ([Creative Kit](https://developers.snap.com/snap-kit/creative-kit/overview)); Login Kit reads no content; the
  Marketing API is ads only. Without Snap's allowlist, no server posts to or reads a customer's Snapchat.

## Decision

1. **One module, on the catalog path.** Each service is a `CONNECTOR_CATALOG` entry (`x`, `tiktok`, `threads`,
   `meta-ads`, `telegram`) marked `native: true`: it has no MCP server (its `serverUrl` names the vendor's API base,
   stored and never opened), and every tool is `ours`. The tools run in `connectors/native/<service>.ts`, served by one
   `createNativeConnectorToolSource` (`connectors/native/index.ts`) registered in `apps/server/src/engine.ts` beside
   the connector source. `mcp.ts` skips native entries (one guard where it lists catalog connections). Each tool is
   built as `git/tools.ts` builds its own: `scope: connectorScope(id, scope)`, the connection's id, usage
   `{ key: id, via: "native", tool }` (ADR 0103), the connection's label and tool prefix (`x_create_post`), `sensitive`
   and `title` from the catalog, `ahead: true` (not on TikTok's, whose card reads the creator's options at the time),
   `describe` for the card, and `external: true` on every read that returns other people's words (mentions, replies,
   searches, messages). The id `meta-ads` is the preset's: with the Meta app
   on the server our connector wins, without it the preset stays "Em breve" (`offersCatalog`, `listing.ts:129-130`).
   Everything else is reused as it is: `connector_connections`, `oauth_states`, `agent_scopes`, `approval_rules`, the
   callback, the phone's and desktop's returns, grants, levels and approvals. A service file imports no engine module
   at run time: the source hands it `call`, so `connections.ts` can import its hooks without a cycle.
2. **OAuth: three options and one app field.** `ConnectorDefinition.oauth` gains `clientAuth: "basic"` (X takes the
   confidential client in HTTP Basic and refuses it in the form), `clientIdParam` (TikTok names it `client_key` in the
   authorize URL, the token call and the refresh) and `pkce: false` (TikTok's web flow takes none, Meta's two flows
   document none). An app may carry `configId` (Meta's Login for Business configuration): `startOAuth` then sends
   `config_id` and `override_default_response_type=true` instead of `scope`. A service file may add four hooks, which
   `connections.ts` calls: `account(token)` once after a sign-in or a pasted key (`@handle` and the vendor's id, stored
   as `account_label` and `account_id`, shown on the row: `connected.ts:74`); `exchange(token)` right after the code
   (Threads: the 60-day token); `refresh(secret)` where a refresh isn't the OAuth refresh grant (Threads:
   `th_refresh_token`), with `refreshBefore` (Threads: 7 days) since `expiring` (`connections.ts:850-851`) wants a
   refresh token today; `revoke(secret)` on disconnect, best effort (X `POST /2/oauth2/revoke`, TikTok
   `/v2/oauth/revoke/`, Telegram `deleteWebhook`; Meta documents none for these tokens, and its deauthorize callback
   reports a removal made on Meta's side). One account per service and workspace, like every catalog connector:
   connecting again is Reconectar.
3. **Tokens.** Sealed as today, never returned (`connectionView`). Telegram's secret adds `webhookSecret`. X and
   TikTok: 2-hour tokens and single-use refresh tokens (X's about 6 months, TikTok's 180 days), safe under the lease;
   X's code must be swapped within 30 seconds, so the phone's and desktop's hand-off do nothing else first. Threads:
   60 days, refreshed on use within 7 days of the end, and by a sweep on the worker loop
   (`every("connectorTokens", 12 h)`, as `mailReconcile` is, `workers.ts:422`) for tokens no call refreshed. Meta Ads:
   the system-user token has no end (`token_expires_at` null). A token the vendor refuses marks the connection to
   reconnect. X keeps one live grant per X account and app: the same account connected in a second workspace ends the
   first's, which then shows Reconectar, and X's connect dialog says an account works in one workspace at a time.
4. **Tools and what asks.** Product rule: ordinary writes, publishing included, run on their own for an agent that has
   the write scope; what destroys or grants access asks a person, and money too. Grants work as for any connection
   (every agent gets `connector:*` on a first connection; levels per agent on its page). "Aprovar sempre" is offered on
   deletes and moderation, never on spend or access. A routine's writes keep ADR 0053's rule (its creator's own
   actions). Reads end in `.read`, so the run policy reads them as reads.

   | Service | Scope (`id:`) | Tools | Asks |
   | --- | --- | --- | --- |
   | Telegram | `messages.read` | `list_chats`, `read_messages`, `get_chat` | no |
   | | `messages.write` | `send_message`, `send_file` (from the Drive), `edit_message`, `pin_message` | no |
   | | | `delete_message`, `ban_member` | yes, "Aprovar sempre" offered |
   | | | `create_invite_link` (lets people in) | yes, every time |
   | X | `posts.read` | `get_my_posts`, `get_mentions`, `get_post`, `search_recent`, `get_user` | no |
   | | `posts.write` | `create_post` (text, up to 4 pictures or a video from the Drive) | no |
   | | | `delete_post` | yes, "Aprovar sempre" offered |
   | Threads | `posts.read` | `get_my_posts`, `get_replies`, `get_mentions`, `get_insights` | no |
   | | `posts.write` | `create_post` (text, pictures, video, carousel), `reply`, `hide_reply` | no |
   | | | `delete_post` | yes, "Aprovar sempre" offered |
   | Meta Ads | `ads.read` | `list_ad_accounts`, `list_campaigns`, `list_ad_sets`, `list_ads`, `get_insights` | no |
   | | `ads.write` | `create_campaign`, `create_ad_set`, `create_ad` (all paused), `update`, `pause` | no |
   | | | `activate`, `set_budget` (they spend) | yes, every time |
   | | | `archive`, `delete` | yes, "Aprovar sempre" offered |
   | TikTok | `videos.read` | `get_profile`, `list_videos`, `get_creator_info`, `get_post_status` | no |
   | | `videos.write` | `upload_draft` (a Drive video to the creator's drafts) | yes, TikTok wants consent per upload |
   | | | `publish` (Direct Post, once audited) | yes, on TikTok's post card |

   TikTok's rules set its asks, and "Aprovar sempre" isn't offered there: content goes to TikTok only after the person
   consents. `upload_draft` asks with the video and its caption; the creator finishes in TikTok. `publish` asks on
   TikTok's post card, on the web and the phone: the creator's nickname and picture from `creator_info`, the title the
   agent wrote (editable), a privacy choice with no default, comments, duet and stitch unchecked and greyed where the
   creator turned them off, the commercial content switch with its two kinds, the music confirmation line and a
   preview, Publish disabled until the choices are made; the person's choices go with the approval. `publish` is
   offered only with `CONNECTOR_TIKTOK_DIRECT_POST=on`, after the audit: before it, a post would be private.

   Not built: X replies until X approves AI-written replies for the app, and quotes, likes, follows and DMs (gone from
   self-serve or unsolicited by X's rules); Threads keyword search (its own review); Meta's people and Page
   permissions (`business_management` writes). X needs express consent before agents post: its connect dialog says
   plainly that agents given X post on the account by themselves, that deleting asks, and that each agent's page
   narrows it; connecting after reading it is the consent, audited as `connector.connected`. Campaigns, ad sets and
   ads are always created paused, with `special_ad_categories` (empty unless the agent names one) and Meta's
   idempotency key, and `update` changes names, targeting and creatives, never status or budget, so nothing spends
   until a person approves `activate` or `set_budget`. Media goes from the Drive: pushed to X
   (chunked upload), Telegram (multipart) and Meta Ads (`adimages`). Threads and TikTok fetch it, from a link of ours
   that works for 1 hour (`/api/connector-media/{token}`, an HMAC with a new `KeyPurpose`, `crypto.ts:18-26`; TikTok
   wants that prefix verified in its app), only on a server the internet reaches. Elsewhere TikTok's video goes in
   chunks, and Threads' and TikTok's pictures can't: the tool says so (post text, or put the server on a public
   address).
5. **Telegram's updates.** Agents can't read a chat they haven't heard: the bot's updates are its only source. They come
   by webhook where the internet reaches the server (`setWebhook` with a random secret, at
   `POST /api/webhooks/telegram/{connectionId}`, the header compared in constant time, rate-limited like the other
   webhooks), else by `getUpdates` every 30 seconds on the worker loop, as IMAP mailboxes are polled
   (`workers.ts:412`). Both feed `ingestTelegramUpdates`, which keeps one row per update in `telegram_updates`
   (`org_id`, connection, `update_id` unique, chat id, type and title, sender's name, text, kind, received at; 30
   days), so `list_chats` follows `my_chat_member` (added, removed, made admin) and `read_messages` reads a chat's last
   ones. A message in a private chat with the bot, or one in a group that mentions or answers it, fires the routines
   whose trigger is that bot (ADR 0053 events, dedupe `telegram:{connectionId}:{update_id}`), so an agent can answer
   people on Telegram through a routine its creator set up.
6. **Errors and limits, in words, with one way out.** One `call` per service maps the vendor's answer to the tool
   result the agent reads (`isError`, `data.code`), as `composioFailure` does, and the agent's reply carries it to the
   person:
   - `connector.needs_reconnect` (HTTP 401, Meta's code 190, TikTok's `access_token_invalid`, Telegram's 401): the
     connection is marked, its row on the web and the phone shows Reconectar, and the agent says who can do it.
   - `connector.rate_limited` with `retryAt`: from `x-rate-limit-reset`, `retry_after`, Meta's
     `estimated_time_to_regain_access` (codes 4, 17, 613, 80000-80014) or a quota (Threads' 250 posts a day, TikTok's
     `spam_risk_too_many_posts` and 5 pending drafts): "X takes no more posts from @acme until 14:32 UTC. Nothing was
     posted." Never retried in a loop; the agent can come back then (`follow_up`).
   - `connector.capped`: the workspace's month for X is used (`CONNECTOR_X_CALLS_PER_MONTH`, counted and announced
     once to its connector admins as Composio's calls are), or X's own usage cap for the server's app.
   - `connector.refused`: a vendor rule or a review not passed yet (a reply X doesn't allow, a permission Meta hasn't
     approved, TikTok's private-only posts before its audit): the vendor's words as untrusted text, and for the server's
     owner what to do (the checklist's step).
   - `connector.unknown_result`: a write that timed out may have happened: "check with get_my_posts before posting
     again".

   Reads take small pages (10 by default, 50 at most), since X bills per post returned.
7. **Where it shows, web and phone.** Nothing new to find: the entries come from `GET /connectors/catalog`
   (`routes/app/connectors.ts:164-195`) into Adicionar conector on the web (`ConnectorCatalog.tsx`) and the phone
   (`ConnectSheet.tsx`): X, TikTok, Threads and Telegram under `social` (Redes sociais, the category the Composio social
   services add; `marketing` until it lands), Meta Ads under `marketing`. Each gets its brand in `CONNECTOR_BRANDS`
   (`listing.ts:19-91`; Meta's is there, X, TikTok, Threads and Telegram from Simple Icons) and its name and description
   in both languages. The OAuth ones connect with their button (`ConnectFlow.tsx:303`, `ConnectSheet.tsx:558`); Telegram
   with the token field (`ConnectFlow.tsx:358`, `ConnectSheet.tsx:581`), its steps in BotFather beside it. The row shows
   the account (`@handle`). Telegram's connection screen lists its chats and how to add the bot to a group or a channel
   (an admin, to post in a channel). An entry this server can't connect says why instead of "Em breve" for every case
   (`ConnectorCatalog.tsx:589`): the listing marks `needsApp` (an OAuth-only entry without its app), and the apps say
   "Needs an X app on this server", with the guide for the server's owner; on the Cloud it stays "Em breve" until the
   vendor approves the app.
8. **Cloud and self-hosting.** One code path; a service is on where its variables are set, read by
   `connectorOAuthApps`: `CONNECTOR_X_CLIENT_ID` and `_SECRET`, `CONNECTOR_TIKTOK_CLIENT_KEY` and `_SECRET`,
   `CONNECTOR_THREADS_APP_ID` and `_SECRET`, `CONNECTOR_META_ADS_APP_ID`, `_SECRET` and `_CONFIG_ID`, each documented
   in `schema.ts` with the redirect URI, plus `CONNECTOR_X_CALLS_PER_MONTH` (0, the default: no cap) and
   `CONNECTOR_TIKTOK_DIRECT_POST` (on once the app passed TikTok's audit). Telegram needs nothing: each workspace brings
   its bot. The Cloud sets its own apps; a self-hoster registers theirs, step by step in SELF_HOSTING.md ("Social and
   ads apps", written with each phase) and `docs/social-apps-checklist.md`. What needs a public URL grows by
   Telegram's webhook (polling otherwise), Threads' and TikTok's media, and Meta's deauthorize and data deletion
   callbacks (`/api/webhooks/meta/deauthorize`, `/api/webhooks/meta/data-deletion`: the `signed_request` checked with
   the app secret, then that Meta account's connections dropped and a confirmation code answered). Calls to Meta carry
   the agent-identifying User-Agent Meta asks for.
9. **Snapchat isn't built.** No public API lets an app post to or read a customer's Snapchat: the Public Profile API is
   allowlisted by Snap, through a contact, and covers Public Profiles only. Adicionar conector doesn't list it (an "Em
   breve" for something that may never come would mislead). If Snap allowlists the app, it becomes a sixth entry on
   this path (an OAuth app from a Snap business account, the `snapchat-profile-api` scope, 1-hour tokens, media
   uploaded encrypted in chunks), with its own ADR.
10. **Build order.** Each phase is one pull request with tests on PGlite and a fake vendor (no network), web and phone
    together.
    1. **Telegram**, needing nothing from the server's owner: `native` and the mcp guard, the tool source and `call`,
       `account` on a pasted key, the tools, updates by webhook or polling, the chats list on both apps; then the
       routine trigger.
    2. **X**: `clientAuth`, `account`, `revoke`, the monthly cap, the tools and the consent line. Its app needs no
       review, only credits.
    3. Then **Threads**, **TikTok** and **Meta Ads** in the order their reviews pass (each waits on Meta's App Review or
       TikTok's audit): Threads with `exchange`, `refresh`, the sweep, the media link and Meta's callbacks; TikTok
       with `clientIdParam`, reads and drafts first, Direct Post and its card after the audit; Meta Ads with
       `configId`, reads first, writes when full access is granted.
    4. Later, when asked: several accounts per service (an agency's brands: `storeConnection` replacing by account
       instead of connector, and the unique index moved to `(org_id, connector, account_id)`; tool prefixes already
       number, `x_2`), one-tap Telegram bots through a manager bot of ours, X replies once X approves them.

## Consequences

- Five services Composio can't sign in to on its own app get connectors of ours, and Snapchat a plain answer, with no
  MCP server and no new token store: five catalog entries, one tool source, four optional hooks, three OAuth options
  and one app field.
- Agents post where they're given the scope, as people asked; deletes, bans and invite links ask, and nothing spends
  money on Meta without a person. Vendor rules that are stricter win (X's replies, TikTok's post card).
- The server's owner registers and pays for the apps, gets them reviewed, and keeps X's credits topped up; on the Cloud
  that's agentes.chat. Until a review passes, a service shows "Em breve" there and the reason on a self-hosted server.
- X's pay-per-use terms are written for apps with a limited number of end users: a Cloud with many workspaces may be
  moved to Enterprise by X, which `CONNECTOR_X_CALLS_PER_MONTH` doesn't change. The way out then is a workspace's own X
  app, sealed per workspace as the server's GitHub App is per server, which this ADR doesn't build.
- One account per service per workspace until agencies ask for more.

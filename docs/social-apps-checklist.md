# Social and ads apps: what to register

For whoever runs a server: the Cloud's owner or a self-hoster. ADR 0170 is the design. Each service turns on when its
variables are set, in the server's environment only; secrets never go anywhere else. Prices are the vendors' public
ones, read on 2026-11-10.

Every OAuth app takes one redirect URI, the same for all of them:

- `{PUBLIC_URL}/api/app/connectors/oauth/callback`
- On the Cloud: `https://app.agentes.chat/api/app/connectors/oauth/callback`

Meta's two apps also take two callbacks, which ship with the Threads phase:

- `{PUBLIC_URL}/api/webhooks/meta/deauthorize`
- `{PUBLIC_URL}/api/webhooks/meta/data-deletion`

| Service | Register | Review | Cost | Variables |
| --- | --- | --- | --- | --- |
| Telegram | nothing | none | free | none |
| X | console.x.com app | none, except to allow AI replies | pay-per-use credits | `CONNECTOR_X_*` |
| Threads | Meta app, Threads use case | App Review, business verification | no fee listed | `CONNECTOR_THREADS_*` |
| Meta Ads | Meta business app, Login for Business | App Review, business verification, access tier | no fee listed | `CONNECTOR_META_ADS_*` |
| TikTok | TikTok for Developers app | app review, then the posting audit | no fee listed | `CONNECTOR_TIKTOK_*` |
| Snapchat | not possible without Snap's allowlist | | | |

## Telegram

Nothing for the server. Each workspace makes its own bot: @BotFather, `/newbot`, then it pastes the token in Settings ›
Connectors and MCPs › Telegram. To read and post in a group, it adds the bot there; to post in a channel, it makes the
bot an admin. Free ([bots](https://core.telegram.org/bots)).

## X

1. https://console.x.com: accept the Developer Agreement and describe the use. The description binds the app, so keep
   it to what's built: "Team workspace where AI agents post on the team's own X account, with the account owner's
   consent. No replies, likes, follows or direct messages." X allows up to 3 apps (development, staging, production).
2. New App, named agentes.chat, website `https://agentes.chat`. The name and the website show as each post's source.
3. User authentication settings: OAuth 2.0, type Web App, Automated App or Bot (a confidential client), permissions
   Read and write. Callback URL: the redirect URI above, exactly (a test server: `http://127.0.0.1:<port>/…`, not
   `localhost`). Add the terms and privacy pages if it asks for them.
4. Scopes the server asks for: `tweet.read tweet.write users.read media.write offline.access`.
5. Credits: a verified phone number, then buy credits; set the spending limit per billing cycle and, if wanted,
   auto-recharge. Public prices: a post $0.015, a post with a link $0.20, $0.005 per post read, $0.010 per user read.
   The first purchase adds $20 and the first auto-recharge is matched up to $50, for 3 months
   ([pricing](https://docs.x.com/x-api/getting-started/pricing), [free credits](https://docs.x.com/x-api/getting-started/free-credits)).
6. Decide on X's terms: pay-per-use is for "applications with a limited number of end-users"; above that X asks for
   Enterprise ([PPU agreement](https://docs.x.com/developer-terms/ppu-agreement)).
7. Later, to let agents reply: ask X to approve AI-written replies through https://help.x.com/forms/platform
   ([guidelines](https://docs.x.com/developer-guidelines)).
8. Variables: `CONNECTOR_X_CLIENT_ID` and `CONNECTOR_X_CLIENT_SECRET` (the OAuth 2.0 client id and secret, not the API
   key), and `CONNECTOR_X_CALLS_PER_MONTH` for a cap per workspace (0: none).

## Threads

1. https://developers.facebook.com/apps: Create app, use case Access the Threads API, in the company's business
   portfolio. The app gets its own Threads app id and secret: use those, not the main app's.
2. The use case's settings: the redirect URI above, the deauthorize callback as the uninstall URL and the data deletion
   callback as the delete URL.
3. Permissions: `threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`,
   `threads_manage_mentions`, `threads_manage_insights`, `threads_delete`.
4. To test before review: App roles › Roles › add Threads testers; each accepts in Threads, Settings › Account ›
   Website permissions.
5. App settings › Basic: an icon of 512 to 1024 px, the privacy policy URL, the data deletion URL, the category and the
   data protection contact Meta asks for in the EU.
6. Business verification of the portfolio (Business settings › Security center), needed for advanced access.
7. App Review: for each permission, what it's for and a screen recording (signing in, linking the account, writing and
   publishing a post, the post here and in Threads), with steps and a test account for the reviewer. Then publish the
   app ([app review](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review/content)).
8. Variables: `CONNECTOR_THREADS_APP_ID` and `CONNECTOR_THREADS_APP_SECRET`.

## Meta Ads

1. https://developers.facebook.com/apps: Create app, type Business, use case Create & manage ads with Marketing API.
   A separate app from Threads'. The type can't change later.
2. Facebook Login for Business › Configurations: a new configuration with a system-user access token that never
   expires, the assets Ad accounts and Pages, and `ads_read`, `ads_management`, `business_management`,
   `pages_show_list`, `pages_read_engagement`. Its Configuration ID is a variable below
   ([Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)).
3. Facebook Login for Business › Settings: the redirect URI above in Valid OAuth Redirect URIs, Strict Mode on, and
   the two Meta callbacks.
4. Business verification of the portfolio that owns the app, and Meta's Tech Provider steps (access verification),
   since the app serves other businesses.
5. App Review: advanced access to the five permissions above, each with what it's for and a screen recording (signing
   in, choosing the ad account, campaigns and results on screen), reviewer steps, the privacy policy, data deletion,
   icon and category. Then publish the app.
6. Marketing API access tier: full access comes after 500 calls in 15 days with errors under 15%. Make them with a
   sandbox ad account, which spends nothing
   ([authorization](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization)).
7. Variables: `CONNECTOR_META_ADS_APP_ID`, `CONNECTOR_META_ADS_APP_SECRET` and `CONNECTOR_META_ADS_CONFIG_ID`.

## TikTok

1. https://developers.tiktok.com › Manage apps › Connect an app, owned by the company's organization, platform Web.
2. App details: name, icon, category and description; the terms (`TERMS_URL`), privacy (`PRIVACY_URL`) and website
   URLs, each verified (the domain by DNS). The website must be a real site about the product, with terms and privacy
   linked without opening a menu.
3. Products: Login Kit, with the redirect URI above (https, no parameters), and the Content Posting API. Verify the
   domain of `PUBLIC_URL` (Cloud: `app.agentes.chat`) for media TikTok pulls from links.
4. Scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.upload`, `video.publish`.
5. Demo videos from a sandbox (Manage apps › Sandbox): up to 5, 50 MB each, with a written explanation per product
   and scope. Describe a team workspace where people and their agents make content and post it to the team's TikTok:
   TikTok refuses tools for uploading to accounts a team manages and copying from other platforms
   ([guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)).
6. Submit; review takes several days to two weeks
   ([app review](https://developers.tiktok.com/docs/en/app-review-guidelines)).
7. Then the Content Posting API audit, with usage estimates:
   https://developers.tiktok.com/application/content-posting-api. Until it passes, Direct Post is private and reaches
   at most 5 people a day; after it, set `CONNECTOR_TIKTOK_DIRECT_POST=on`.
8. Variables: `CONNECTOR_TIKTOK_CLIENT_KEY` and `CONNECTOR_TIKTOK_CLIENT_SECRET`.

## Snapchat

No public API posts or reads for a customer. To ask anyway: in a Snap business account, Business Details › OAuth apps
(not the Developer Portal), make an OAuth app, then email its client id and the intended use to a Snap contact for the
Public Profile API allowlist ([get started](https://developers.snap.com/marketing-api/Public-Profile-API/GetStarted)).
Nothing to set until Snap says yes.

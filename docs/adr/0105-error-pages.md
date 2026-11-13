# 0105. Error pages: one family, in our look and the person's words

- Status: Accepted (built: the web app, the server, core's Caddy, the phone app and the desktop app's windows)
- Date: 2026-10-31
- Code: `apps/web/public/unavailable.html` (the static page), `docker-compose.yml` (`caddyfile`, `unavailable-page`), `scripts/unavailable-page.ts`, `apps/web/index.html` (the boot fallback), `apps/web/src/components/ErrorScreen.tsx`, `apps/web/src/hooks/useServerBack.ts`, `apps/web/src/lib/app-version.ts` (`reloadForNewVersion`), `apps/web/src/lib/return-notices.ts`, `packages/client/src/api/http.ts` (`NetworkError`), `packages/client/src/lib/errors.ts` (`noAnswer`, `errorText`, `authErrorText`, `providerRefusalText`, `oauthReturnText`), `packages/client/src/lib/error-boundary.ts`, `apps/server/src/app.ts`, `apps/server/src/auth.ts` (`onAPIError.errorURL`), `apps/server/src/routes/app/context.ts` (`signInFirst`, `oauthFailure`), `apps/mobile/app/_layout.tsx`, `apps/desktop/src/main.tsx`

## Context

A customer met the router's own "Something went wrong!" screen. ADR 0104 replaced that one crash screen, but people met many others: a proxy's 502 while a deploy restarted the server, a blank page when the app's files changed under an open tab, "Failed to fetch" and "Bad Gateway" in toasts, Better Auth's own error page on a native install, raw JSON after a connector's sign-in in a browser without our session, and English words in a Portuguese app.

## Decision

1. **One look and one voice.** Every page that says something failed uses the design system's tokens in both themes, our type, the primary button, our icons and pixel art. Inside the app it is the crash screen's frame (`page page--mid`, a title, an `EmptyState` with one sentence and one button). A whole page outside the app is the sign-in page's column: the mark, a 460 px column with a title, one sentence and one button, the pixel orbit while it waits, the pixel horizon below. Each says what happened, what happens next and the one way on, in the person's language (pt-BR by default), never a raw error.
2. **Three ways to serve it.**
   - Inside the app (React): `ErrorScreen` and its variants (a crash, a request that got no answer, a page from before a deploy), a boundary above the app's providers, every toast, alert and `ErrorState` through `errorText`, the sign-in page's refusal line, the phone's `ScreenError` and the desktop app's windows.
   - The static page, `apps/web/public/unavailable.html`, self-contained (no app code, inline styles from the tokens, under 16 KB), which asks the server by itself and opens the address once it answers: it asks for the address, never following a redirect, or for `/api/health` when the address is under `/api/`, so a sign-in's or a connector's one-time return runs only when the page opens it. Caddy serves it whenever its upstream fails.
   - A service's own HTML: index.html's boot fallback inline (the app's own files are what failed), the server sending failed sign-in navigations to the sign-in page.
3. **Always a 503.** Caddy turns its 502, 503 and 504 into the static page with status 503. Cloudflare replaces an origin's 502 or 504 with its own page but passes a 503 through. For the same reason the server answers a computer's error (`MachineRequestError`) with a 503 and its `machine.*` code: a 502 would never reach the app.
4. **No report, no code, for what isn't a crash.** A request that got no answer (`NetworkError`, or only the proxy's answer: `noAnswer`) and a page's file from before a deploy (`vite:preloadError`, which reloads into the new version at most once a minute) are not reported and show no code. A report's code shows only where a report went out.
5. **Where the static page lives.** Its source is `apps/web/public/unavailable.html`, so the app also serves it at `/unavailable.html`. Its copies: inside `docker-compose.yml` as the `unavailable-page` config (self-hosters download the compose file alone, so `bun run sync:unavailable` writes it there and a test keeps the two equal, and the page has no `$`, which Compose would read as a variable), in agentes.chat Cloud's own Caddy configuration, and on an nginx server, downloaded once from its own app (SELF_HOSTING.md).
6. **Sign-in and OAuth returns land on our pages.** Better Auth's error landing is the sign-in page (`onAPIError.errorURL`), which says each of its codes by what the person can do. A provider's return that needs a session and finds none in that browser goes to the sign-in page first (`signInFirst`) and finishes after. A return that didn't connect lands where it started with a code, never the error's words (`?connector_error=`, `?github_app_error=`), which the app says as a toast.

## What stays agentes.chat Cloud's

Holding requests while a service restarts (Caddy's `lb_try_duration`), so short restarts show nothing at all, stays Cloud-only, as do the Cloudflare handling, billing's pages and the operator console's. Self-hosters get the same static page through core's compose file (the https profile) and an nginx snippet, and every in-app change.

## Consequences

- A self-hosted server on the https profile shows our page during a restart instead of an empty response. The tailscale profile has none: `tailscale serve` has no error page, and putting Caddy behind it would change the client address the app trusts.
- The static page is a second copy of the app's tokens and language rule: a test compares its colors with tokens.css, and its language rule mirrors `savedLocale` and `appLocale`.
- English readers still see the server's own words for a 4xx it doesn't translate, which it writes for people. Everyone else reads "Algo deu errado. Tente de novo."
- A `connector_error` or `github_app_error` from before this change (a message) reads as "Não deu para conectar".
- Gmail's and Outlook's return keeps working without a session: it never needed one, and from the desktop app it can't have one.

## Alternatives considered

- Caddy's own error page, or Cloudflare's: not our look, not our words, and Cloudflare's custom pages need its paid plan.
- A service worker that serves the page offline: only people with notifications on register one (ADR 0071), and a fetch handler in it is a risk for every request.
- A 502 or 504 for the static page: Cloudflare would replace it with its own.
- Retrying a failed form post: the page asks with a GET and loads the address without its hash, so a form is never sent twice.

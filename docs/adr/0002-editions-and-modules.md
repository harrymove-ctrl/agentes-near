# 0002. One codebase, two editions, modules and adapters

- Status: Accepted
- Date: 2026-10-14. Revised 2026-10-21: no contributor license agreement, so nothing private runs in the server process (§5)

## Context

agentes.chat ships as open source (AGPL-3.0, self-hosted) and as agentes.chat Cloud (paid, ours). Two codebases would drift; Cloud-only behavior (billing, platform keys, KMS, Redis, Turbopuffer) must stay off for self-hosters without forking the server.

## Decision

1. **One server.** `apps/server` is the complete product. `src/main.ts` starts the self-hosted edition; `startServer({ edition, modules })` in `src/start.ts` is shared.
2. **Cloud is the same server.** The Cloud runs this image, with Cloud-only behavior switched on by environment variables and public modules (§5); anything private runs as a separate service.
3. **`AgentesModule` is the only extension point** (`packages/modules`): `registerRoutes`, `onStart`, `onStop`, and `adapters()`, which returns overrides for:
   | Adapter | Core default | Cloud (expected) |
   | --- | --- | --- |
   | `SearchIndexResolver.forOrg(orgId)` | Postgres (stub today) | Turbopuffer per plan |
   | `PubSub` | Postgres LISTEN/NOTIFY (memory in tests) | Redis pub/sub |
   | `Presence` | in-memory | Redis with TTL |
   | `RateLimiter` | in-memory fixed window | Redis |
   | `KeyWrapper` | key derived from `AGENTES_SECRET` | KMS |
   | `PlatformCredentials` | none | platform provider key |
   | `modelProviders` | Anthropic | more providers |
   Modules are applied in order; each sees the adapters resolved so far; later modules win. Overrides are logged at boot.
4. **Boundary enforced.** `bun run check:boundaries` fails if anything under `apps/` or `packages/` imports or depends on `@agenteschat/cloud` or `@agenteschat/ee`.
5. **Licensing:** public code (`apps/`, `packages/`) is AGPL-3.0-only. Outside contributions come in under that same license (inbound = outbound) with no contributor license agreement, so we hold them only under the AGPL: we can't license them commercially, and Cloud-only code that runs in the server process forms one program with them and must be published under the AGPL too (section 13 reaches network users). Cloud-only behavior is therefore public code switched on by environment variables, or a separate private service that talks over the network; never a private module in the server process. Modules given to `startServer` (2, 3) are public code; private Cloud services live only in the private repo. There is no `ee/` folder.
   *Amendment (2026-11-06):* `NOTICE` states one additional term under AGPL-3.0 section 7(b): every copy, modified version or work based on it with an interactive user interface keeps "Based on agentes.chat by Codari Global, LLC" in its Appropriate Legal Notices, found from its settings or menus. The apps show it with the version, the license and a source code link (`SOURCE_URL`, AGPL section 13) in an About screen (web Settings, phone Você, desktop Preferences › Updates and the Mac's About panel), on every server and with no setting or environment variable that hides it.
   *Amendment (2026-11-08):* agentes.chat Cloud (`isAgentesCloud(PUBLIC_URL)`, `cloud` in `GET /api/app/auth-config`) shows no About screen in the web and phone apps: it is agentes.chat itself. Every other server keeps it as above, and the desktop app's Preferences › Updates and the Mac's About panel keep it everywhere.
6. **Multi-tenant from day one.** Every tenant-owned table has `org_id` (a test asserts it). Self-host is an install with one organization.
7. **Metering in the core.** Usage records are written by the core in both editions; only Cloud turns them into invoices and limits.

## Consequences

- The core knows no plans: e.g. the search backend per org is decided by whatever `SearchIndexResolver` is registered.
- The job queue is not an adapter: the outbox contract stays in Postgres in both editions (ADR 0005).

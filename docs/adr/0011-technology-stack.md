# 0011. Technology stack

- Status: Accepted
- Date: 2026-10-14
- Supersedes an earlier plan for Next.js with Redis/BullMQ.

## Decision

| Concern | Choice |
| --- | --- |
| Runtime, packages | Bun workspaces (`apps/*`, `packages/*`) |
| HTTP API | Hono + `@hono/zod-openapi` (Zod schemas drive validation and `/api/openapi.json`); Scalar at `/api/reference` |
| Real-time | Native `Bun.serve` WebSocket (ADR 0010) |
| Database | PostgreSQL 15+ with pgvector; Drizzle ORM + postgres.js; SQL migrations committed |
| Auth | Better Auth (ADR 0006) |
| Jobs | Postgres outbox, in-process workers (ADR 0005) |
| Models | Anthropic SDK behind a provider interface (ADR 0007) |
| Lint / format | Biome |
| Tests | `bun test` on PGlite (ADR 0003) |
| Web app | Vite SPA served by this server from `WEB_DIR` (built from `apps/web`) |

## Packages

`@agenteschat/config` (env schema) · `db` (schema, migrations, client) · `adapters` (edition-swappable interfaces + core defaults) · `providers` (model provider interface, Anthropic, catalog, fake) · `modules` (`AgentesModule`) · `engine` (domain services, gateway, outbox, runs) · `server` (`apps/server`: HTTP, WebSocket, auth, workers, boot).

## Consequences

- One process to self-host; no Next.js second process.
- Import Drizzle operators from `@agenteschat/db`, never `drizzle-orm` directly (two copies break its types).

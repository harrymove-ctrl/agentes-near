# Contributing to agentes.chat

Thanks for your interest. This document covers running the code, the checks a pull request must
pass, the conventions that matter, and how contributions are licensed.

## Where things happen

- **Questions and ideas:** [GitHub Discussions](https://github.com/agentes-chat/agentes-chat/discussions).
- **Bugs and concrete feature requests:** issues (please use the issue forms).
- **Security problems:** never a public issue. See [SECURITY.md](SECURITY.md).

## Run it for development

You need [Bun](https://bun.sh) (the version in `packageManager` in `package.json`) and a PostgreSQL
15 or newer database with the pgvector extension available.

```sh
bun install
cp .env.example .env   # set DATABASE_URL and AGENTES_SECRET (openssl rand -base64 48)
bun run dev
```

`bun run dev` starts the server on port 3000, which applies the migrations at start, and the web
app on Vite at http://localhost:5173, which passes `/api` and the WebSocket to the server. Open
http://localhost:5173 and create an account: the first one owns the instance. Model keys are added
per organization in the app (**Settings → API keys**), not in `.env`.

Give development a database of its own, never a production one. To run the production image
instead, build it and start it with the compose file ([SELF_HOSTING.md](SELF_HOSTING.md), "From
source"). The phone app builds on EAS ([apps/mobile/README.md](apps/mobile/README.md)) and the
desktop app (macOS, Windows and Linux) in the Desktop workflow (`.github/workflows/desktop.yml`).

## Checks

CI does not start by itself on a pull request: a maintainer runs it on the branch before merging. These must pass:

| Check | Command |
| --- | --- |
| Lint and format (Biome) | `bun run lint` (`bun run format` fixes what it can) |
| `apps/` and `packages/` never import Cloud or `ee` code; comments and docs cite ADRs, not the maintainers' private notes | `bun run check:boundaries` |
| No npm dependency under GPL, AGPL, a source-available or proprietary license, or none | `bun run check:licenses` |
| Typecheck | `bun run typecheck` |
| Build | `bun run build` |
| Migrations match the schema | `bun run db:generate <name>` creates nothing |
| Tests | `bun test <paths>` |
| No secrets in the history | gitleaks, with `.gitleaks.toml` |

`bun run ci:local` runs all of these in CI's order and prints a PASS/FAIL table (it needs `shellcheck` and
`gitleaks` installed). Booting the image with `docker-compose.yml` is the one CI check it leaves out.

Tests run on in-memory PGlite with a fake model provider: no `.env`, no Docker, no network. CI runs
the browser-DOM tests (`apps/web`, `packages/ui`) in a process of their own, apart from the backend
tests (`packages/*`, `apps/server`) and the phone and desktop tests (`apps/mobile/test`,
`apps/desktop/test`); run them the same way, or just the files you touched
(`bun test packages/engine/test/router.test.ts`). A pull request that touches the server, the web
app, a package or the Docker files also boots the image with `docker-compose.yml`.

## Conventions that matter

- **Migrations are immutable.** Change the schema in `packages/db/src/schema`, then run
  `bun run db:generate <name>`. A committed migration never changes; a fix is a new migration.
- **Environment variables** are declared only in `packages/config/src/schema.ts`. Then run
  `bun run docs:env`, which regenerates `.env.example`.
- **Drizzle operators** come from `@agenteschat/db`, never from `drizzle-orm` directly.
- **The edition boundary:** `apps/` and `packages/` never import `ee` or Cloud code. Cloud-only
  behavior plugs in through `AgentesModule` and adapters
  ([ADR 0002](docs/adr/0002-editions-and-modules.md)).
- **Every tenant-owned table has `org_id`** (a test enforces it).
- **Model calls go through the Model Gateway** (`packages/engine/src/gateway.ts`), which checks the
  budget first and records tokens and cost per agent and organization. Keys never reach a client.
- **User-facing text** goes through `packages/i18n` (`en.ts` and `pt-BR.ts`); the phone app keeps
  its own keys in `apps/mobile/src/i18n`.
- **Decisions** that shape the code are recorded in [docs/adr](docs/adr).

## Pull requests

- Open an issue or a discussion before a large change, so we agree on the direction first.
- Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org),
  with a scope where one fits: `feat(web): …`, `fix(engine): …`, `docs: …`.
- Keep pull requests focused, and add or update tests where behavior changes.

## Licensing of your contribution

- agentes.chat is AGPL-3.0-only ([LICENSE](LICENSE)). A package published under MIT says so in
  its own LICENSE, and contributions to it are MIT: today that is the setup CLI, `packages/setup`
  (`@agenteschat/setup`).
- Inbound = outbound: your contribution is licensed under the license of the code it goes into.
  Here that is AGPL-3.0-only together with the additional permission under section 7 for app
  stores (at the top of [NOTICE](NOTICE)), so your code ships in the phone and desktop apps
  like the rest. [GitHub's Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
  (section D.6) already license contributions under the repository's license.
- There is no contributor license agreement to sign and no DCO sign-off. You keep the copyright in
  your contribution.
- Submit only your own code, or code under MIT, BSD, ISC, Apache-2.0 or MPL-2.0 (whole files, with
  their notices). Never GPL, AGPL, unlicensed or proprietary code.
- AI-assisted code is fine. You answer for its origin.

## Names and logos

Forks need their own name, logo, app icon and bundle ID. See [TRADEMARKS.md](TRADEMARKS.md).

## Code of conduct

Everyone participating is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

# 0004. Configuration through one env var schema; one master secret

- Status: Accepted
- Date: 2026-10-14

## Decision

- Every environment variable is declared once in `packages/config/src/schema.ts` (Zod schema, description, section, default, secret flag). `loadConfig()` reports all problems at once.
- `bun run docs:env` generates `.env.example`; a config test fails when it is stale.
- Only `bun run dev` / `start` need `DATABASE_URL` and `AGENTES_SECRET`. Tests, lint and typecheck never read `.env`.
- One master secret, `AGENTES_SECRET`. Purpose keys are derived with HKDF-SHA256 (`@agenteschat/engine` `deriveSecret`): `sessions` (Better Auth secret) and `provider-credentials-kek` (key-encryption key, ADR 0007). Purpose names are frozen.
- Model defaults are config: `AGENT_DEFAULT_MODEL=claude-sonnet-5-5`, `ROUTER_MODEL=claude-haiku-5-5` (reserved until the router exists). Prices are code (`MODEL_CATALOG`), not config.
- Secrets are masked by `redactConfig` when the config is logged.

## Consequences

- Rotating `AGENTES_SECRET` makes stored credentials unreadable unless the old key is kept as a legacy `KeyWrapper` (rotation tooling is a follow-up).

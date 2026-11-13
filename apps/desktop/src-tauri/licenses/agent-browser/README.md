# agent-browser

The app bundles `agent-browser` (Vercel Labs, https://github.com/vercel-labs/agent-browser) as a sidecar next to the runner, which drives each agent's browser with it (ADR 0040). Its version and SHA-256 are pinned in `packages/adapters/src/machine-protocol.ts` (`AGENT_BROWSER_VERSION`, `AGENT_BROWSER_SHA256`).

- `LICENSE`: agent-browser, Apache License 2.0. The project ships no NOTICE file.
- `LICENSE-axe-core.txt`, `LICENSE-axe-core-THIRD-PARTY.txt`: axe-core (Mozilla Public License 2.0), embedded in the agent-browser binary for its accessibility audits.

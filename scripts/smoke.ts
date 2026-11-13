/**
 * `bun run smoke`: real-environment check (reads `.env`). The script lives in
 * the server package so workspace packages resolve; see
 * `apps/server/scripts/smoke.ts`. Never part of `bun test`.
 */
import "../apps/server/scripts/smoke";

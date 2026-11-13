/**
 * The daily stall-and-noise report (`autonomy-report.ts` in the engine) as a table, for the people who run the
 * server. Reads only.
 *
 *   bun run report:autonomy [--day YYYY-MM-DD] [--org <workspace id>]
 *
 * `--day`: a UTC day, yesterday by default. `--org`: that workspace alone, whatever its state; else every active one.
 * In the server's container: `docker compose exec agentes bun run report:autonomy`.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "@agenteschat/config";
import { createDatabase } from "@agenteschat/db";
import { autonomyReport, autonomyTable } from "@agenteschat/engine";

const { values } = parseArgs({ options: { day: { type: "string" }, org: { type: "string" } } });
const day = values.day ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
  console.error("--day takes a UTC day, like 2026-10-30");
  process.exit(2);
}
if (values.org && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.org)) {
  console.error("--org takes a workspace's id");
  process.exit(2);
}

const config = loadConfig();
const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
try {
  const report = await autonomyReport(database.db, { day, orgId: values.org ?? null, router: config.ROUTER_ENABLED });
  console.log(autonomyTable(report));
} finally {
  await database.close();
}

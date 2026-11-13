/**
 * The image's entrypoint. `main.ts migrate` (`docker compose run --rm agentes migrate`)
 * only prepares the database the way boot does, then exits: an upgrade can
 * migrate while the previous version still serves. `main.ts setup` is the
 * self-host setup (`npx @agenteschat/setup`) for servers without Node, run in
 * the directory mounted as the working directory. `main.ts telemetry`
 * (`docker compose run --rm agentes telemetry`) prints the next usage report
 * and sends nothing.
 */
import { loadConfig } from "@agenteschat/config";
import { createDatabase } from "@agenteschat/db";
import { passwordLinkByEmail } from "@agenteschat/engine";
import { createLogger } from "./logger";
import { prepareDatabase, startServer } from "./start";
import { printTelemetry } from "./telemetry";
import { zenModule } from "./zen/module";

if (process.argv[2] === "setup") {
  const { main } = await import("@agenteschat/setup/src/cli");
  const code = await main(process.argv.slice(3), { image: true });
  // Once stdout has drained: a piped `--json` result arrives whole.
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(code);
}

if (process.argv[2] === "migrate") {
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: config.DATABASE_POOL_MAX });
  await prepareDatabase(database, createLogger(config.LOG_LEVEL));
  await database.close();
  process.exit(0);
}

// `main.ts password-link <email>` (`docker compose run --rm agentes password-link ana@example.com`, ADR 0158): a
// new-password link for that account, for a server that sends no email.
if (process.argv[2] === "password-link") {
  const email = process.argv[3] ?? "";
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
  const link = await passwordLinkByEmail(database.db, config.PUBLIC_URL, email);
  await database.close();
  if (!link) {
    process.stderr.write(`No account here uses ${email}.\n`);
    process.exit(1);
  }
  process.stdout.write(`${link.url}\n`);
  process.stderr.write(`Works once, until ${link.expiresAt.toLocaleString()}.\n`);
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}

if (process.argv[2] === "telemetry") {
  const config = loadConfig();
  const database = createDatabase({ url: config.DATABASE_URL, poolMax: 1 });
  await printTelemetry(database.db, config);
  await database.close();
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}

await startServer({ edition: "selfhost", modules: [zenModule] });

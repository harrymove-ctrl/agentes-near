import { createECDH } from "node:crypto";
import { type Config, configSchema, envVars } from "./schema";

export { composioAuthConfigs, connectorOAuthApps, githubAppConfig } from "./connectors";
export { type Config, type EnvVarDefinition, type EnvVarName, envVars } from "./schema";

/** agentes.chat's own servers: their legal pages are their own, and their mail goes out from agentes.chat. */
const OFFICIAL_HOSTS = new Set(["app.agentes.chat", "agentes.chat", "www.agentes.chat"]);

/** Whether a VAPID public key (an uncompressed P-256 point) belongs to this private key (`d`), both base64url. */
function vapidPairMatches(publicKey: string, privateKey: string): boolean {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKey.replace(/=+$/, ""), "base64url"));
    return ecdh.getPublicKey().equals(Buffer.from(publicKey.replace(/=+$/, ""), "base64url"));
  } catch {
    return false;
  }
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Parses and validates configuration from environment variables.
 * Throws `ConfigError` listing every problem at once, so a self-hoster can fix
 * their `.env` in a single pass.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty strings as unset so `FOO=` in a .env file falls back to the default.
  const raw = Object.fromEntries(Object.keys(envVars).map((key) => [key, env[key] === "" ? undefined : env[key]]));
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const key = String(issue.path[0]);
        const missing = raw[key] === undefined;
        return missing ? `${key} is required` : `${key}: ${issue.message}`;
      }),
    );
  }
  const config = result.data;
  if (config.HOST_COMPUTER_TOKEN && config.ALLOW_SIGNUP) {
    throw new ConfigError([
      "HOST_COMPUTER_TOKEN can't be set with ALLOW_SIGNUP=true: this server's computer runs agents on the machine itself, so people join only by invitation",
    ]);
  }
  // Its requests are read only through the operator API: without it every workspace would wait forever.
  if (config.MACHINE_PROVISIONING === "external" && !config.OPERATOR_API_TOKEN) {
    throw new ConfigError(["MACHINE_PROVISIONING=external needs OPERATOR_API_TOKEN"]);
  }
  // The screen's text leaves only through the operator API's review door: without it nobody could read it.
  if (config.SESSION_SCREENING && !config.OPERATOR_API_TOKEN) {
    throw new ConfigError(["SESSION_SCREENING needs OPERATOR_API_TOKEN"]);
  }
  if (config.MACHINE_PROVISIONING === "external" && config.HOST_COMPUTER_TOKEN) {
    throw new ConfigError([
      "HOST_COMPUTER_TOKEN can't be set with MACHINE_PROVISIONING=external: every workspace gets its own computer, and no other computer joins it",
    ]);
  }
  if (Boolean(config.BILLING_URL) !== Boolean(config.BILLING_LINK_SECRET)) {
    throw new ConfigError(["BILLING_URL and BILLING_LINK_SECRET go together: set both or neither"]);
  }
  // Only the billing service lifts that hold, through the operator API: without them a new workspace would wait forever.
  if (config.BILLING_HOLD_NEW_WORKSPACES && !(config.BILLING_URL && config.OPERATOR_API_TOKEN)) {
    throw new ConfigError([
      "BILLING_HOLD_NEW_WORKSPACES=true needs BILLING_URL, BILLING_LINK_SECRET and OPERATOR_API_TOKEN",
    ]);
  }
  // With no slot left over, no agent run would ever start.
  if (config.OUTBOX_QUICK_SLOTS >= config.OUTBOX_MAX_IN_FLIGHT) {
    throw new ConfigError(["OUTBOX_QUICK_SLOTS must be below OUTBOX_MAX_IN_FLIGHT: agents' runs need the slots left"]);
  }
  if (
    config.OUTBOX_MAX_IN_FLIGHT_CEILING !== undefined &&
    config.OUTBOX_MAX_IN_FLIGHT_CEILING < config.OUTBOX_MAX_IN_FLIGHT
  ) {
    throw new ConfigError([
      "OUTBOX_MAX_IN_FLIGHT_CEILING can't be below OUTBOX_MAX_IN_FLIGHT, where the job slots start",
    ]);
  }
  // A worker shares the server's database; the built-in one belongs to one process.
  if (config.SERVER_ROLE === "worker" && config.DATABASE_URL.startsWith("pglite:")) {
    throw new ConfigError([
      "SERVER_ROLE=worker needs a PostgreSQL DATABASE_URL: the built-in database serves one process",
    ]);
  }
  // Half a pair means the bot check was meant to be on: it never runs quietly off.
  if (Boolean(config.TURNSTILE_SITE_KEY) !== Boolean(config.TURNSTILE_SECRET_KEY)) {
    throw new ConfigError(["TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY go together: set both, or neither"]);
  }
  // A key pair or nothing (ADR 0071): half a pair can't sign.
  if (Boolean(config.WEB_PUSH_VAPID_PUBLIC_KEY) !== Boolean(config.WEB_PUSH_VAPID_PRIVATE_KEY)) {
    throw new ConfigError([
      "WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY go together: set both or neither",
    ]);
  }
  // Halves of two pairs would get every push refused, with nothing at boot to say why.
  if (
    config.WEB_PUSH_VAPID_PUBLIC_KEY &&
    config.WEB_PUSH_VAPID_PRIVATE_KEY &&
    !vapidPairMatches(config.WEB_PUSH_VAPID_PUBLIC_KEY, config.WEB_PUSH_VAPID_PRIVATE_KEY)
  ) {
    throw new ConfigError(["WEB_PUSH_VAPID_PUBLIC_KEY isn't the public half of WEB_PUSH_VAPID_PRIVATE_KEY"]);
  }
  const site = new URL(config.PUBLIC_URL);
  if (OFFICIAL_HOSTS.has(site.hostname)) {
    config.TERMS_URL ??= `${site.origin}/terms`;
    config.PRIVACY_URL ??= `${site.origin}/privacy`;
    config.EMAIL_FROM ??= "agentes.chat <ping@agentes.chat>";
  }
  return config;
}

/** Returns a copy of the config safe to log: secret values are masked. */
export function redactConfig(config: Config): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      const def = envVars[key as keyof typeof envVars] as { secret?: boolean };
      return [key, def.secret ? "********" : value];
    }),
  );
}

/**
 * Config for tests: fixed secret, no real database. Never use outside tests.
 * Lets `bun test` run with no `.env` present.
 */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused/test",
    AGENTES_SECRET: "test-secret-".padEnd(48, "x"),
    PUBLIC_URL: "http://localhost:3000",
    ...overrides,
  });
}

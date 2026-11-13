import { boolean, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/**
 * The organization's switch and defaults for its agents' computers (connected computers, ADR 0025):
 * whether they run code at all, a command's default timeout, and a person's approval before each run.
 * No row = the defaults.
 */
export const orgSandboxSettings = pgTable("org_sandbox_settings", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(true),
  /** Default timeout of one command, in seconds. */
  execTimeoutSeconds: integer().notNull().default(60),
  /** Every `run_code` / `run_skill_script` waits for a person's approval. */
  requireApproval: boolean().notNull().default(false),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

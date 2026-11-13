import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MachineLoadRecord } from "./machines";

/**
 * The usage report's state for the whole installation (ADR 0060 §5): one row, made at the server's
 * first start. Not a tenant's, so no `org_id`.
 */
export const instanceTelemetry = pgTable(
  "instance_telemetry",
  {
    id: integer().primaryKey().default(1),
    /** Random, made once: the only id the report carries. */
    instanceId: uuid().notNull().defaultRandom(),
    /** The installation owner's switch in Settings; `TELEMETRY=off` wins over it. */
    enabled: boolean().notNull().default(true),
    /** When the server last started (the report's uptime). */
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** How busy the server's host got over the last day, as its last sample left it. */
    hostLoad: jsonb().$type<MachineLoadRecord>(),
    /** The last day's samples behind `hostLoad` (epoch ms), so a restarted server keeps its day. */
    hostSamples: jsonb().$type<{ at: number; load: number; memory: number }[]>(),
    /** When the next report is due; kept so a restart neither delays it nor sends it twice in a day. */
    nextReportAt: timestamp({ withTimezone: true }),
    /**
     * Who has the installation's own settings (this switch, the Jev key, ADR 0073): its first account, pinned so
     * the next oldest never inherits them. No foreign key: a deleted owner's id keeps matching nobody.
     */
    ownerUserId: text(),
  },
  (t) => [check("instance_telemetry_one_row", sql`${t.id} = 1`)],
);

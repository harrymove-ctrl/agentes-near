import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { organizations } from "./tenancy";
import { routines } from "./work";

/** A fixed tile of a person's home board, placed among its widgets (ADR 0135 §9). */
export interface DashboardHomeTile {
  key: "waiting" | "working";
  position: number;
  w: 1 | 2;
  h: 1 | 2;
}

/**
 * An agent asks to show a board to more people than the person it made it for (ADR 0135 §11): pending until that
 * person publishes it or keeps it to themselves.
 */
export interface DashboardProposalRow {
  audience: "workspace" | "roles";
  roleIds: string[];
  agentId: string;
  /** The run that asked, when one did. */
  runId: string | null;
  /** The agent's reason, shown on the request. */
  why: string;
  /** ISO time it asked. */
  at: string;
}

/**
 * Dashboards (ADR 0135): a board of widgets that agents keep up to date. `kind` `home` is a person's own board on
 * Home (one per person, always private); `board` is any other. Who sees it: `audience` `workspace` (every
 * member), `roles` (whoever holds one of `audience_role_ids` at the time, ADR 0085, as a channel's audience, ADR
 * 0125) or `private` (its owner only). Who edits: `edit_policy` `viewers` (whoever sees it), `owner` (its owner
 * and admins) or `roles` (whoever sees it and holds one of `edit_role_ids`, besides its owner and admins). An agent
 * that made it is `owner_agent_id` ("created by"); the person it made it for owns it.
 */
export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `board` | `home`. */
    kind: text().notNull().default("board"),
    /** Empty for a home board: the apps show its own name in the reader's language. */
    title: text().notNull(),
    about: text().notNull().default(""),
    /** The person who owns it (for an agent's board, the person it was made for); null once they are gone. */
    ownerUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** The agent that made it, shown as its author. */
    ownerAgentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    /** The agent run that made it. */
    createdByRunId: uuid(),
    /** `workspace` | `roles` | `private`. */
    audience: text().notNull().default("private"),
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** `viewers` | `owner` | `roles`. */
    editPolicy: text().notNull().default("owner"),
    /** With `roles`: the roles whose holders edit it, when they also see it (ADR 0135 §8); else empty. */
    editRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Shown first in the list (its owner or an admin sets it). */
    pinned: boolean().notNull().default(false),
    /** Order in the list among the pinned or the rest, lowest first. */
    position: doublePrecision().notNull().default(0),
    /** A home board's fixed tiles ("Waiting on you", "Working now") and where they sit; empty for a board. */
    homeTiles: jsonb().$type<DashboardHomeTile[]>().notNull().default([]),
    /** An agent's pending request to show it to more people. */
    proposal: jsonb().$type<DashboardProposalRow>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Deleted: gone from every list; its widgets' routines were deleted with it. */
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("dashboards_org_audience").on(t.orgId, t.audience).where(sql`${t.deletedAt} is null`),
    index("dashboards_org_owner").on(t.orgId, t.ownerUserId).where(sql`${t.deletedAt} is null`),
    // One home board per person and workspace.
    uniqueIndex("dashboards_one_home")
      .on(t.orgId, t.ownerUserId)
      .where(sql`${t.kind} = 'home' and ${t.deletedAt} is null`),
  ],
);

/**
 * A widget (ADR 0135): what it shows (`spec`, a `WidgetSpec` from `@agenteschat/ui/widgets/spec`), the agent that
 * looks after it and how it is redone. A scheduled one has a routine (`routine_id`, its target `{ type: "widget" }`)
 * whose background run redoes it in place through `update_widget`, posting nothing in chat. `status`: `building`
 * (its first run), `ok`, `updating` (a run is redoing it; the last data stays), `failed` (`failure_code`, and the
 * agent's own words in `failure_detail`).
 */
export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    dashboardId: uuid()
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    title: text().notNull(),
    /** What the person asked it to show: the refresh run's instructions. */
    prompt: text().notNull().default(""),
    /** What the person picked: `auto` or a kind. */
    format: text().notNull().default("auto"),
    /** The kind it shows now; null until a `building` widget with `auto` gets its first data. */
    kind: text(),
    spec: jsonb().$type<Record<string, unknown>>(),
    /** What the agent read to build it (names of connections or sites), as it said. */
    sources: text().array().notNull().default(sql`'{}'::text[]`),
    /** Order on its board, lowest first. */
    position: doublePrecision().notNull().default(0),
    w: integer().notNull().default(1),
    h: integer().notNull().default(1),
    /** `half` | `hour` | `day` | `week` | `manual`. */
    schedule: text().notNull().default("manual"),
    alertEnabled: boolean().notNull().default(false),
    /** "drops 20% below yesterday"; empty: when something is off. */
    alertCondition: text().notNull().default(""),
    /** Who hears its alerts: whoever turned them on or last changed the condition. */
    alertUserId: text().references(() => users.id, { onDelete: "set null" }),
    routineId: uuid().references(() => routines.id, { onDelete: "set null" }),
    /** `building` | `ok` | `updating` | `failed`. */
    status: text().notNull().default("building"),
    failureCode: text(),
    failureDetail: text(),
    /** Pinned from this chat message (its chart block); null when asked of an agent. */
    sourceMessageId: uuid(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** The agent run that made it (an agent's `create_widget`). */
    createdByRunId: uuid(),
    /** Its last good update. */
    refreshedAt: timestamp({ withTimezone: true }),
    lastAlertAt: timestamp({ withTimezone: true }),
    /** A person named it (on create, on confirm or with Rename): its agent never renames it (ADR 0135 §17). */
    titleSetByUser: boolean().notNull().default(false),
    /**
     * A test of a widget not made yet ("Test" in New widget, ADR 0135 §16): on no board's list, seen only by its
     * creator, its routine never scheduled; confirmed (moved onto a board) or deleted within a day.
     */
    draft: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index("dashboard_widgets_board").on(t.dashboardId, t.position),
    index("dashboard_widgets_agent").on(t.orgId, t.agentId),
    // The workspace's cap on scheduled widgets counts these.
    index("dashboard_widgets_scheduled").on(t.orgId).where(sql`${t.schedule} <> 'manual'`),
    index("dashboard_widgets_routine").on(t.routineId).where(sql`${t.routineId} is not null`),
    // A person's drafts (their cap) and the sweep of old ones.
    index("dashboard_widgets_drafts").on(t.orgId, t.createdByUserId).where(sql`${t.draft} = true`),
  ],
);

/** A widget's history (ADR 0135 §6): each update or failure, with what it showed then; the latest few are kept. */
export const dashboardWidgetUpdates = pgTable(
  "dashboard_widget_updates",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    widgetId: uuid()
      .notNull()
      .references(() => dashboardWidgets.id, { onDelete: "cascade" }),
    routineRunId: uuid(),
    agentRunId: uuid(),
    /** `ok` | `failed`. */
    status: text().notNull(),
    /** The agent's one line for this update ("$18,420 · +12% vs. yesterday"). */
    summary: text().notNull().default(""),
    spec: jsonb().$type<Record<string, unknown>>(),
    /** The alert it raised, in the agent's words; null when none. */
    alert: text(),
    failureCode: text(),
    /** A person's change request this update answered. */
    change: text(),
    costNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    tokens: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboard_widget_updates_widget").on(t.widgetId, t.createdAt)],
);

import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { machines } from "./machines";
import { agentRuns } from "./runtime";
import { organizations } from "./tenancy";

/**
 * A person's turn on one of an agent's screens (ADR 0040 §6): the agent
 * asked (`ask`, from `browser_ask_person`, its run suspended) or a person
 * watching took over (`takeover`). One record per handoff: who, when, the
 * result. Frames and what the person typed are never stored.
 */
export const browserHandoffs = pgTable(
  "browser_handoffs",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    /** The run waiting on it (`ask`); null for a take over outside a run. */
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    machineId: uuid().notNull(),
    /** Which screen: the machine protocol's `ScreenKind` (this package can't import it). */
    screen: text().$type<"browser" | "desktop">().notNull().default("browser"),
    kind: text().$type<"ask" | "takeover">().notNull(),
    /** What the agent asked for, in its words ("Sign in to Stripe with the shop's test account"). */
    instructions: text().notNull().default(""),
    /**
     * `pending` (nobody opened it), `active` (a person in control), then `done | failed | expired | cancelled`, or
     * `withdrawn` (the agent no longer needs it, `withdraw_request`).
     */
    status: text()
      .$type<"pending" | "active" | "done" | "failed" | "expired" | "cancelled" | "withdrawn">()
      .notNull()
      .default("pending"),
    /** Who it was asked of (whoever asked for the work, else the agent's owner). */
    requestedForUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Who is (or was) in control. */
    controllerUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** The person's note when it failed ("it asked for Ana's phone code"). */
    note: text(),
    /**
     * While `pending`: the agent's deadline (nobody opened it). While
     * `active`: there is no deadline; this is how long control survives the
     * controller's live view going away (pushed while they watch).
     */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /**
     * When the agent read its page after a person had control (ended). Until
     * then its other browser tools refuse: the page changed under it.
     */
    pageReadAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }),
    index().on(t.orgId, t.status),
    index().on(t.agentId, t.status),
    // One open handoff per agent's screen: two people (or a person and the agent) can't race in.
    uniqueIndex("browser_handoffs_one_open").on(t.agentId, t.screen).where(sql`${t.status} in ('pending', 'active')`),
  ],
);

/**
 * A browser profile (ADR 0110): a named Chrome on one computer that the workspace logs in to once and lends to the
 * agents granted it. One driver at a time: the turn (`held_*`) is taken or renewed by every command in one
 * statement that also checks the grant, and held either by an agent's run or by a person in control.
 */
export const browserProfiles = pgTable(
  "browser_profiles",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The computer it lives on; set once (moving it is creating it again there). */
    machineId: uuid().notNull(),
    name: text().notNull(),
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
    /** The run holding the turn, with its agent; null while free or while a person holds it. */
    heldByRunId: uuid(),
    heldByAgentId: uuid(),
    /** The person in control (Fazer login); agents wait while they hold it. */
    heldByUserId: text(),
    /** The turn ends then unless renewed (2 minutes after an agent's last command). */
    heldUntil: timestamp({ withTimezone: true }),
    heldSince: timestamp({ withTimezone: true }),
    /** When an agent last drove it ("Fechado · usado há 2 dias"). */
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }).onDelete("cascade"),
    // Names are unique among the workspace's live profiles, ignoring case.
    uniqueIndex("browser_profiles_name").on(t.orgId, sql`lower(${t.name})`).where(sql`${t.deletedAt} is null`),
    index().on(t.heldByRunId),
  ],
);

/** Which agents may use a profile. A grant is never cached: the turn statement reads it on every command. */
export const browserProfileGrants = pgTable(
  "browser_profile_grants",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    profileId: uuid().notNull(),
    agentId: uuid().notNull(),
    grantedBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.agentId] }),
    foreignKey({
      columns: [t.orgId, t.profileId],
      foreignColumns: [browserProfiles.orgId, browserProfiles.id],
    }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.agentId),
  ],
);

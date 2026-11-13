import { and, asc, type Database, desc, eq, gt, or, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { decodeCursor, encodeCursor } from "./cursor";
import { getOrgLimits, orgMeters } from "./limits";
import { maySql } from "./permissions";
import { OPERATOR_STANDING_COLUMNS, type StandingState } from "./standing";

/**
 * Reads of the operator API (ADR 0056): who and what is in a workspace, never what anyone wrote there,
 * and never a credential, token or password hash. Every field is picked by name for that reason.
 */

const { organizations, organizationMembers, organizationInvitations, users, sessions, agents, channels, machines } =
  schema;

const RECENT_SESSIONS = 10;

// In a select list over one table drizzle writes columns without their table, so in a subquery a bare
// "id" would be the subquery's own: the outer workspace is named in full.
const ORG_ID = sql.raw(`"organizations"."id"`);
const memberCount = sql<number>`(select count(*) from ${organizationMembers}
  where ${organizationMembers.orgId} = ${ORG_ID})`.mapWith(Number);
const agentCount = sql<number>`(select count(*) from ${agents}
  where ${agents.orgId} = ${ORG_ID} and ${agents.archivedAt} is null and ${agents.builtin} is null)`.mapWith(Number);

// Cut to milliseconds (what a JS Date and the cursor carry), so paging compares exactly what it returned.
export const orgCreatedAtMs = sql<Date>`date_trunc('milliseconds', ${organizations.createdAt})`.mapWith(
  (v: string | Date) => new Date(v),
);
/** A page of workspaces ends at this key: `[createdAt (ms), id]`. */
export const OrgCursor = z.tuple([z.iso.datetime(), z.uuid()]);

export interface OperatorOrgQuery {
  /** An org id, part of its name, or part of a member's email; any case. */
  q?: string;
  createdAfter?: Date;
  standing?: StandingState;
  limit: number;
  /** `next` of the previous page. */
  cursor?: string;
}

/** Workspaces, newest first, in keyset pages: a workspace created while paging never shifts a page. */
export async function operatorListOrgs(db: Database, query: OperatorOrgQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, OrgCursor) : null;
  const q = query.q?.trim();
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      createdAt: orgCreatedAtMs,
      standing: organizations.standing,
      members: memberCount,
      agents: agentCount,
    })
    .from(organizations)
    .where(
      and(
        query.standing ? eq(organizations.standing, query.standing) : undefined,
        q
          ? or(
              z.uuid().safeParse(q).success ? eq(organizations.id, q) : undefined,
              sql`strpos(lower(${organizations.name}), lower(${q}::text)) > 0`,
              sql`exists (select 1 from ${organizationMembers}
                join ${users} on ${users.id} = ${organizationMembers.userId}
                where ${organizationMembers.orgId} = ${organizations.id}
                  and strpos(lower(${users.email}), lower(${q}::text)) > 0)`,
            )
          : undefined,
        query.createdAfter ? gt(organizations.createdAt, query.createdAfter) : undefined,
        after
          ? sql`(${orgCreatedAtMs}, ${organizations.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(orgCreatedAtMs), desc(organizations.id))
    .limit(query.limit + 1);
  const orgs = rows.slice(0, query.limit);
  const last = orgs.at(-1);
  const next = rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null;
  return { orgs, next };
}

/**
 * One workspace: its owners and admins, how much is in it, its limits (ADR 0079) with what it uses of them, and its
 * deletion and the operator's deletion hold, each null when there is none. Null when there is none with that id.
 */
/** The operator API's role names (its contract): an owner, someone holding `administrator` (ADR 0085), a member. */
const operatorRole = (orgId: unknown, userId: unknown) =>
  sql<"owner" | "admin" | "member">`case when ${organizationMembers.role} = 'owner' then 'owner'
    when ${maySql(orgId, userId, "administrator")} then 'admin' else 'member' end`;

export async function operatorOrg(db: Database, orgId: string) {
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      createdAt: organizations.createdAt,
      standing: OPERATOR_STANDING_COLUMNS,
      deletion: {
        dueAt: organizations.deletionDueAt,
        requestedAt: organizations.deletionRequestedAt,
        requestedBy: organizations.deletionRequestedBy,
      },
      deletionHold: { heldAt: organizations.deletionHoldAt, reason: organizations.deletionHoldReason },
      counts: {
        members: memberCount,
        agents: agentCount,
        channels: sql<number>`(select count(*) from ${channels} where ${channels.orgId} = ${ORG_ID}
          and ${channels.kind} <> 'dm' and ${channels.archivedAt} is null)`.mapWith(Number),
        machines: sql<number>`(select count(*) from ${machines} where ${machines.orgId} = ${ORG_ID}
          and ${machines.deletedAt} is null)`.mapWith(Number),
        invitations: sql<number>`(select count(*) from ${organizationInvitations}
          where ${organizationInvitations.orgId} = ${ORG_ID}
            and ${organizationInvitations.acceptedAt} is null and ${organizationInvitations.expiresAt} > now())`.mapWith(
          Number,
        ),
      },
    })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!row) return null;
  const { deletion, deletionHold, ...org } = row;
  const [admins, limits, meters] = await Promise.all([
    db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: operatorRole(orgId, organizationMembers.userId),
        createdAt: users.createdAt,
        lastSeenAt: organizationMembers.lastSeenAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), maySql(orgId, organizationMembers.userId, "administrator")))
      .orderBy(asc(organizationMembers.role), asc(organizationMembers.createdAt)),
    getOrgLimits(db, orgId),
    orgMeters(db, orgId),
  ]);
  return {
    ...org,
    deletion: deletion.dueAt ? { ...deletion, dueAt: deletion.dueAt } : null,
    deletionHold: deletionHold.heldAt ? { ...deletionHold, heldAt: deletionHold.heldAt } : null,
    admins,
    limits,
    meters,
  };
}

/** One account: its workspaces and its newest sessions on record. Null when there is none with that id. */
export async function operatorUser(db: Database, userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt,
      blockedAt: users.blockedAt,
      blockedReason: users.blockedReason,
      workArea: users.workArea,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return null;
  const [orgs, recent] = await Promise.all([
    db
      .select({
        orgId: organizations.id,
        name: organizations.name,
        role: operatorRole(organizationMembers.orgId, organizationMembers.userId),
        joinedAt: organizationMembers.createdAt,
        lastSeenAt: organizationMembers.lastSeenAt,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizationMembers.createdAt)),
    db
      .select({ ip: sessions.ipAddress, userAgent: sessions.userAgent, createdAt: sessions.createdAt })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(desc(sessions.createdAt))
      .limit(RECENT_SESSIONS),
  ]);
  return { ...user, orgs, sessions: recent };
}

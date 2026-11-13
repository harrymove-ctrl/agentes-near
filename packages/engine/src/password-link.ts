import { randomUUID } from "node:crypto";
import { and, type Database, type Executor, eq, like, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { randomToken } from "./crypto";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { getMembership, pinnedOwner, requireActiveMembership } from "./organizations";

const { organizationMembers, users, verifications } = schema;

/**
 * A new-password link on a server that sends no email (ADR 0158): made by a workspace owner for a member who forgot
 * their password, or by whoever runs the server from its command line. It is the reset link the email would carry:
 * Better Auth's `POST /api/auth/reset-password` takes its token (a `reset-password:<token>` verification whose value
 * is the account), and `/reset-password?token=` is the page that asks for the new password.
 */

/** How long a link works. */
export const PASSWORD_LINK_TTL_MS = 60 * 60_000;
const RESET_PREFIX = "reset-password:";

export interface PasswordLink {
  url: string;
  expiresAt: Date;
}

/**
 * A new link for `userId`: any earlier one stops working. The verification is written as Better Auth writes it: this
 * server stores identifiers as they are (auth.ts sets no `storeIdentifier`), so its reset endpoint finds it.
 */
export async function issuePasswordLink(
  db: Executor,
  publicUrl: string,
  userId: string,
  now = new Date(),
): Promise<PasswordLink> {
  await db
    .delete(verifications)
    .where(and(like(verifications.identifier, `${RESET_PREFIX}%`), eq(verifications.value, userId)));
  const token = randomToken(18);
  const expiresAt = new Date(now.getTime() + PASSWORD_LINK_TTL_MS);
  await db.insert(verifications).values({
    id: randomUUID(),
    identifier: `${RESET_PREFIX}${token}`,
    value: userId,
    expiresAt,
  });
  return { url: `${publicUrl.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`, expiresAt };
}

/**
 * An owner of `orgId` makes the link for its member `targetId`. Refused where it could take over an account the
 * owner doesn't answer for: on a server that emails (the person asks for their own link), for themselves, for the
 * server's owner (who signs in on its computer), and for anyone who also belongs to a workspace the actor doesn't
 * own. Recorded in the workspace's audit log, never the link.
 */
export async function memberPasswordLink(
  db: Database,
  deps: { publicUrl: string; emailDelivers: boolean },
  actorId: string,
  orgId: string,
  targetId: string,
  now = new Date(),
): Promise<PasswordLink> {
  if (deps.emailDelivers) {
    throw new ConflictError(
      "This server emails the link: the person asks for it on the sign-in page",
      "password_link.email",
    );
  }
  const actor = await requireActiveMembership(db, actorId, orgId);
  if (actor.role !== "owner") throw new ForbiddenError("Only an owner of the workspace makes a new-password link");
  if (targetId === actorId) throw new ForbiddenError("Change your own password in your account settings");
  const target = await getMembership(db, targetId, orgId, { includeBlocked: true });
  if (!target) throw new NotFoundError("That user is not a member");
  if (targetId === (await pinnedOwner(db))) {
    throw new ForbiddenError("The server's owner signs in on the computer it runs on", "password_link.server_owner");
  }
  const theirs = await db
    .select({ orgId: organizationMembers.orgId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, targetId));
  for (const { orgId: other } of theirs) {
    if (other === orgId) continue;
    const there = await getMembership(db, actorId, other);
    if (there?.role !== "owner") {
      throw new ForbiddenError("They also belong to a workspace you don't own", "password_link.other_workspace");
    }
  }
  return db.transaction(async (tx) => {
    const link = await issuePasswordLink(tx, deps.publicUrl, targetId, now);
    const [person] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, targetId));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "member.password_link",
      target: { type: "person", id: targetId },
      details: {
        ...(person ? { name: person.name, email: person.email } : {}),
        expiresAt: link.expiresAt.toISOString(),
      },
    });
    return link;
  });
}

/** The command line's link (`password-link <email>`): whoever runs the server can already read its database. */
export async function passwordLinkByEmail(
  db: Database,
  publicUrl: string,
  email: string,
  now = new Date(),
): Promise<PasswordLink | null> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase()));
  return user ? issuePasswordLink(db, publicUrl, user.id, now) : null;
}

import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { managesChannel } from "./channels";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { getMembership, outranks, requireActiveMembership } from "./organizations";
import {
  CHANNEL_KEYS,
  type ChannelKey,
  channelOverridesSql,
  channelPermissions,
  isChannelKey,
  parseOverrides,
} from "./permissions";

const { channelPermissionOverrides: overrides, channels, orgRoles } = schema;

/** The most exceptions a channel holds, as `CHANNEL_ROLES_MAX`. */
export const CHANNEL_OVERRIDES_MAX = 100;

export type OverrideTarget = { type: "role"; id: string } | { type: "person"; id: string };

export interface ChannelOverrideView {
  /** A role (`everyone`, "Todos", included) or a person. */
  target: OverrideTarget;
  allow: ChannelKey[];
  deny: ChannelKey[];
}

const forbidden = (message: string) => new ForbiddenError(message, "channel.permission_forbidden");

/** The channel and the actor's membership, when the actor manages it (`managesChannel`). */
async function managedChannel(db: Database, actorId: string, orgId: string, channelId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel || channel.archivedAt || channel.kind !== "channel") throw new NotFoundError("Channel not found");
  if (!(await managesChannel(db, membership, actorId, channel))) {
    throw forbidden("Only who manages this channel changes its permissions");
  }
  return { channel, membership };
}

const view = (r: typeof overrides.$inferSelect): ChannelOverrideView => ({
  target: r.userId ? { type: "person", id: r.userId } : { type: "role", id: r.roleId ?? "" },
  allow: r.allow.filter(isChannelKey),
  deny: r.deny.filter(isChannelKey),
});

/** A channel's exceptions (ADR 0134), for whoever manages it. */
export async function listChannelOverrides(db: Database, actorId: string, orgId: string, channelId: string) {
  await managedChannel(db, actorId, orgId, channelId);
  const rows = await db
    .select()
    .from(overrides)
    .where(and(eq(overrides.orgId, orgId), eq(overrides.channelId, channelId)))
    .orderBy(asc(overrides.updatedAt));
  return { keys: CHANNEL_KEYS, overrides: rows.map(view) };
}

/**
 * Sets one exception of a channel (ADR 0134); empty `allow` and `deny` remove it. Whoever manages the channel, and
 * nobody gives what they can't do (ADR 0085 §7): someone who isn't an owner changes only keys they hold here, and
 * only for `everyone`, a role below their own or a person below them (never themselves). Audited; everyone's apps
 * refetch the channel list. Returns the row, or null once removed.
 */
export async function setChannelOverride(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  input: { target: OverrideTarget; allow: readonly string[]; deny: readonly string[] },
  options: { pubsub?: PubSub } = {},
): Promise<ChannelOverrideView | null> {
  const { membership } = await managedChannel(db, actorId, orgId, channelId);
  const allow = [...new Set(input.allow)];
  const deny = [...new Set(input.deny)];
  if (![...allow, ...deny].every(isChannelKey)) throw new ValidationError("Unknown permission");
  if (allow.some((k) => deny.includes(k))) throw new ValidationError("A permission is either allowed or denied");
  const { target } = input;
  const owner = membership.role === "owner";
  if (target.type === "role") {
    const [role] = await db
      .select({ kind: orgRoles.kind, position: orgRoles.position })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.id, target.id)));
    if (!role) throw new ValidationError("That role is not one of the workspace's");
    if (role.kind === "custom" && !outranks(membership, role.position)) {
      throw forbidden("You only change roles below your own");
    }
  } else {
    const person = await getMembership(db, target.id, orgId);
    if (!person) throw new ValidationError("That person is not a member of this organization");
    if (!owner && (target.id === actorId || person.role === "owner" || !outranks(membership, person.rank))) {
      throw forbidden("You only change people below you");
    }
  }
  const which = and(
    eq(overrides.channelId, channelId),
    target.type === "role" ? eq(overrides.roleId, target.id) : eq(overrides.userId, target.id),
  );
  const [before] = await db.select().from(overrides).where(which);
  if (!owner) {
    // Their own keys in this channel: what they hold is what they may hand out or take away.
    const [own] = rowsOf<{ o: Parameters<typeof parseOverrides>[0] }>(
      await db.execute(
        sql`select ${channelOverridesSql(sql`${orgId}::uuid`, sql`${channelId}::uuid`, sql`${actorId}::text`)} as o`,
      ),
    );
    const held = channelPermissions(membership.permissions, parseOverrides(own?.o));
    const was = (k: string) => (before?.allow.includes(k) ? 1 : before?.deny.includes(k) ? -1 : 0);
    const now = (k: string) => (allow.includes(k) ? 1 : deny.includes(k) ? -1 : 0);
    if (CHANNEL_KEYS.some((k) => was(k) !== now(k) && !held.has(k))) {
      throw forbidden("You only change permissions you hold here");
    }
  }
  const at = new Date();
  let row: typeof overrides.$inferSelect | undefined;
  if (allow.length === 0 && deny.length === 0) {
    await db.delete(overrides).where(which);
  } else if (before) {
    [row] = await db
      .update(overrides)
      .set({ allow, deny, updatedAt: at })
      .where(eq(overrides.id, before.id))
      .returning();
  } else {
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(overrides)
      .where(eq(overrides.channelId, channelId));
    if ((count?.n ?? 0) >= CHANNEL_OVERRIDES_MAX) {
      throw new ValidationError(`At most ${CHANNEL_OVERRIDES_MAX} exceptions per channel`);
    }
    [row] = await db
      .insert(overrides)
      .values({
        orgId,
        channelId,
        ...(target.type === "role" ? { roleId: target.id } : { userId: target.id }),
        allow,
        deny,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target:
          target.type === "role" ? [overrides.channelId, overrides.roleId] : [overrides.channelId, overrides.userId],
        set: { allow, deny, updatedAt: at },
      })
      .returning();
  }
  caches.channels.delete(`${orgId}:${channelId}`);
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "channel.permissions_changed",
    target: { type: "channel", id: channelId },
    channelId,
    details: {
      target,
      from: before ? { allow: before.allow, deny: before.deny } : null,
      to: row ? { allow, deny } : null,
    },
  });
  await publishOrgEvent(options.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "channel.permissions", channelId },
  });
  return row ? view(row) : null;
}

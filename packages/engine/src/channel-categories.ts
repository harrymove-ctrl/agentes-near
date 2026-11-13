import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { managesChannel } from "./channels";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { requireActiveMembership, requirePermission } from "./organizations";

const { channelCategories, channels } = schema;

export type ChannelCategory = typeof channelCategories.$inferSelect;

/** A category's name as people see it in the sidebar. */
export const CATEGORY_NAME_MAX = 40;

interface Options {
  pubsub?: PubSub;
}

/** Everyone in the org refetches the sidebar's layout (no names in the event: private channels stay private). */
async function layoutChanged(orgId: string, options: Options) {
  await publishOrgEvent(options.pubsub, { type: "org.broadcast", orgId, event: { type: "channels.layout" } });
}

function cleanName(name: string) {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new ValidationError("category name is empty");
  if (clean.length > CATEGORY_NAME_MAX)
    throw new ValidationError(`category name: at most ${CATEGORY_NAME_MAX} characters`);
  return clean;
}

/** Names are unique per organization ignoring case ("Marketing" and "marketing" are the same category). */
async function requireFreeName(db: Executor, orgId: string, name: string, except?: string) {
  const [row] = await db
    .select({ id: channelCategories.id })
    .from(channelCategories)
    .where(and(eq(channelCategories.orgId, orgId), sql`lower(${channelCategories.name}) = lower(${name})`));
  if (row && row.id !== except) throw new ConflictError(`The category ${name} already exists`);
}

async function requireCategory(db: Executor, orgId: string, categoryId: string) {
  const [row] = await db
    .select()
    .from(channelCategories)
    .where(and(eq(channelCategories.orgId, orgId), eq(channelCategories.id, categoryId)));
  if (!row) throw new NotFoundError("Category not found");
  return row;
}

/** The org's categories, in sidebar order. */
export async function listChannelCategories(db: Database, actorId: string, orgId: string): Promise<ChannelCategory[]> {
  await requirePermission(db, actorId, orgId, "read");
  return db
    .select()
    .from(channelCategories)
    .where(eq(channelCategories.orgId, orgId))
    .orderBy(asc(channelCategories.position), asc(channelCategories.name));
}

/**
 * The channels of one category (null: those with none), in sidebar order. Only named channels that aren't
 * archived: DMs never sit in the sidebar's categories.
 */
async function channelsIn(db: Executor, orgId: string, categoryId: string | null) {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
        categoryId ? eq(channels.categoryId, categoryId) : isNull(channels.categoryId),
      ),
    )
    .orderBy(asc(channels.position), asc(channels.name));
  return rows.map((r) => r.id);
}

/** Writes `ids` into `categoryId` at positions 0..n (moving any of them there from elsewhere). */
async function writeOrder(db: Executor, orgId: string, categoryId: string | null, ids: string[]) {
  for (const [position, id] of ids.entries()) {
    await db
      .update(channels)
      .set({ categoryId, position })
      .where(and(eq(channels.orgId, orgId), eq(channels.id, id)));
  }
}

/**
 * Where a new channel goes in a category (null: the channels with none). A group nobody arranged by hand has
 * every position at 0 and reads by name, so the new one joins at 0 and keeps that order; once someone
 * arranged it (positions 0..n), the new one goes to its end.
 */
export async function endOfCategory(db: Executor, orgId: string, categoryId: string | null) {
  const [row] = await db
    .select({ n: sql<number | null>`max(${channels.position})::int` })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
        categoryId ? eq(channels.categoryId, categoryId) : isNull(channels.categoryId),
      ),
    );
  const max = Number(row?.n ?? 0);
  return max > 0 ? max + 1 : 0;
}

/** A category a channel may be put in: it belongs to the org. */
export async function requireCategoryInOrg(db: Executor, orgId: string, categoryId: string) {
  return requireCategory(db, orgId, categoryId);
}

/**
 * A new category at the end of the sidebar (admins: it's the org's layout), optionally taking `channelIds`
 * along, in the order given.
 */
export async function createChannelCategory(
  db: Database,
  actorId: string,
  orgId: string,
  input: { name: string; channelIds?: string[] },
  options: Options = {},
): Promise<ChannelCategory> {
  await requirePermission(db, actorId, orgId, "manage_channels");
  const name = cleanName(input.name);
  await requireFreeName(db, orgId, name);
  try {
    const category = await db.transaction(async (tx) => {
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${channelCategories.position}) + 1, 0)::int` })
        .from(channelCategories)
        .where(eq(channelCategories.orgId, orgId));
      const [row] = await tx
        .insert(channelCategories)
        .values({ orgId, name, position: Number(last?.n ?? 0), createdByUserId: actorId })
        .returning();
      if (!row) throw new Error("category insert returned nothing");
      const wanted = [...new Set(input.channelIds ?? [])];
      if (wanted.length) {
        const found = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.orgId, orgId),
              eq(channels.kind, "channel"),
              isNull(channels.archivedAt),
              inArray(channels.id, wanted),
            ),
          );
        if (found.length !== wanted.length) throw new NotFoundError("Channel not found");
        await writeOrder(tx, orgId, row.id, wanted);
      }
      return row;
    });
    await layoutChanged(orgId, options);
    return category;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`The category ${name} already exists`);
    throw error;
  }
}

/** Renames a category (admins). */
export async function renameChannelCategory(
  db: Database,
  actorId: string,
  orgId: string,
  categoryId: string,
  input: { name: string },
  options: Options = {},
): Promise<ChannelCategory> {
  await requirePermission(db, actorId, orgId, "manage_channels");
  await requireCategory(db, orgId, categoryId);
  const name = cleanName(input.name);
  await requireFreeName(db, orgId, name, categoryId);
  try {
    const [row] = await db
      .update(channelCategories)
      .set({ name })
      .where(and(eq(channelCategories.orgId, orgId), eq(channelCategories.id, categoryId)))
      .returning();
    if (!row) throw new NotFoundError("Category not found");
    await layoutChanged(orgId, options);
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`The category ${name} already exists`);
    throw error;
  }
}

/** Deletes a category (admins); its channels go to the end of the ones with no category, in their order. */
export async function deleteChannelCategory(
  db: Database,
  actorId: string,
  orgId: string,
  categoryId: string,
  options: Options = {},
) {
  await requirePermission(db, actorId, orgId, "manage_channels");
  await requireCategory(db, orgId, categoryId);
  await db.transaction(async (tx) => {
    const moving = await channelsIn(tx, orgId, categoryId);
    const loose = await channelsIn(tx, orgId, null);
    await writeOrder(tx, orgId, null, [...loose, ...moving]);
    await tx
      .delete(channelCategories)
      .where(and(eq(channelCategories.orgId, orgId), eq(channelCategories.id, categoryId)));
  });
  await layoutChanged(orgId, options);
}

/** Moves a category before another one (null: to the end), renumbering them all (admins). */
export async function placeChannelCategory(
  db: Database,
  actorId: string,
  orgId: string,
  categoryId: string,
  input: { beforeCategoryId: string | null },
  options: Options = {},
) {
  await requirePermission(db, actorId, orgId, "manage_channels");
  await requireCategory(db, orgId, categoryId);
  if (input.beforeCategoryId === categoryId) return;
  if (input.beforeCategoryId) await requireCategory(db, orgId, input.beforeCategoryId);
  await db.transaction(async (tx) => {
    const ordered = (
      await tx
        .select({ id: channelCategories.id })
        .from(channelCategories)
        .where(eq(channelCategories.orgId, orgId))
        .orderBy(asc(channelCategories.position), asc(channelCategories.name))
    )
      .map((r) => r.id)
      .filter((id) => id !== categoryId);
    const at = input.beforeCategoryId ? ordered.indexOf(input.beforeCategoryId) : -1;
    ordered.splice(at >= 0 ? at : ordered.length, 0, categoryId);
    for (const [position, id] of ordered.entries()) {
      await tx
        .update(channelCategories)
        .set({ position })
        .where(and(eq(channelCategories.orgId, orgId), eq(channelCategories.id, id)));
    }
  });
  await layoutChanged(orgId, options);
}

/**
 * Puts a channel in a category (null: on top, with none), before `beforeChannelId` of that category or at its
 * end. The channel's creator or an admin, as for renaming it.
 */
export async function placeChannel(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  input: { categoryId: string | null; beforeChannelId?: string | null },
  options: Options = {},
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.id, channelId),
        eq(channels.kind, "channel"),
        isNull(channels.archivedAt),
      ),
    );
  if (!channel) throw new NotFoundError("Channel not found");
  if (!(await managesChannel(db, membership, actorId, channel))) {
    throw new ForbiddenError("Only the channel's creator or an admin can move it");
  }
  if (input.categoryId) await requireCategory(db, orgId, input.categoryId);
  if (input.beforeChannelId === channelId) return;
  await db.transaction(async (tx) => {
    const ids = (await channelsIn(tx, orgId, input.categoryId)).filter((id) => id !== channelId);
    const at = input.beforeChannelId ? ids.indexOf(input.beforeChannelId) : -1;
    ids.splice(at >= 0 ? at : ids.length, 0, channelId);
    await writeOrder(tx, orgId, input.categoryId, ids);
  });
  await layoutChanged(orgId, options);
}

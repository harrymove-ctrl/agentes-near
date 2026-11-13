import type { Channel } from "@agenteschat/client";
import { can, managesChannel } from "@agenteschat/client/lib/permissions";

/** The person's membership: what they may do (`OrgSummary.permissions`, ADR 0085). */
type Membership = Parameters<typeof can>[0];

/** Who manages channels arranges the categories (ADR 0080). */
export const arrangesCategories = (org: Membership) => can(org, "manage_channels");

/** Who may put a channel in a category: who manages it, as for renaming it. */
export const movesChannel = managesChannel;

/** The pushed screens. */
export const categoryHrefs = {
  /** "Categoria" of a channel: pick where it sits. */
  pick: (channelId: string) => `/channel-category?channelId=${encodeURIComponent(channelId)}` as const,
  /** "Nova categoria", taking that channel along when there is one. */
  create: (channelId?: string) =>
    (channelId ? `/channel-category-new?channelId=${encodeURIComponent(channelId)}` : "/channel-category-new") as
      | `/channel-category-new?channelId=${string}`
      | "/channel-category-new",
  /** "Categorias": the order, and each one to rename or delete. */
  manage: "/channel-categories" as const,
  /** One category. */
  edit: (categoryId: string) => `/channel-category-edit?id=${encodeURIComponent(categoryId)}` as const,
};

/** Moves `id` one step up (-1) or down (+1) in `ids`: the id it then sits before (null: the end). */
export function stepBefore(ids: readonly string[], id: string, step: -1 | 1): string | null | undefined {
  const i = ids.indexOf(id);
  const to = i + step;
  if (i < 0 || to < 0 || to >= ids.length) return undefined;
  const rest = ids.filter((x) => x !== id);
  return rest[to] ?? null;
}

/**
 * A channel among the ones of its category (or the ones with none), in the list's order: where it is, how many
 * they are, and the move one step up or down (undefined at either end).
 */
export function channelSteps(channels: readonly Pick<Channel, "id" | "categoryId">[], channelId: string) {
  const categoryId = channels.find((c) => c.id === channelId)?.categoryId ?? null;
  const ids = channels.filter((c) => (c.categoryId ?? null) === categoryId).map((c) => c.id);
  const move = (step: -1 | 1) => {
    const before = stepBefore(ids, channelId, step);
    return before === undefined ? undefined : { channelId, categoryId, beforeChannelId: before };
  };
  return { at: ids.indexOf(channelId), count: ids.length, up: move(-1), down: move(1) };
}

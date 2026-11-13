import { and, type Database, type Executor, eq, isNull, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { ForbiddenError, NotFoundError } from "../errors";
import { can, type Membership, requireActiveMembership } from "../organizations";
import { maySql } from "../permissions";
import { DASHBOARD_ERRORS, type DashboardRow, type WidgetRow } from "./types";

const { dashboards, dashboardWidgets } = schema;

/**
 * Who sees, edits and manages a board (ADR 0135 §8).
 *
 * - **Sees:** a board that isn't deleted and is the viewer's own (`owner_user_id`), or `workspace` (every member), or
 *   `roles` when the viewer holds one of `audience_role_ids` at the time (`organization_member_roles`, as
 *   `channelAudienceSql`) or is an admin. A `private` board and a `home` board are their owner's alone, admins
 *   included. A `roles` board with no role left is its owner's (and admins') alone.
 * - **Edits** (title, about, widgets, layout, refresh, change requests): its owner and admins, and who sees it when
 *   `edit_policy` is `viewers`, or who sees it and holds one of `edit_role_ids` at the time when it is `roles` (seeing
 *   comes first: an edit role whose holders don't see the board gives them nothing). A home board: its owner only.
 * - **Manages** (share, delete, pin): its owner and admins; never for a home board but by its owner (no share or
 *   delete at all for a home board).
 * - **Admin**: `can(membership, "administrator")` (owners hold it too).
 * - **Shows to others** (`audience` other than `private` on create or share): needs `post`.
 */

export interface DashboardViewer {
  userId: string;
  /** The viewer's roles (`Membership.roleIds`), not `everyone`. */
  roleIds: readonly string[];
  admin: boolean;
  /** May show a board to others (`post`). */
  mayPublish: boolean;
}

export type DashboardNeed = "see" | "edit" | "manage";

export interface DashboardRights {
  see: boolean;
  edit: boolean;
  manage: boolean;
}

/** The viewer of a membership (`userId`: whose it is; a membership doesn't carry it). */
export function viewerOf(membership: Membership, userId = ""): DashboardViewer {
  return {
    userId,
    roleIds: membership.roleIds,
    admin: can(membership, "administrator"),
    mayPublish: can(membership, "post"),
  };
}

type RightsFields = Pick<
  DashboardRow,
  "kind" | "audience" | "audienceRoleIds" | "editPolicy" | "editRoleIds" | "ownerUserId" | "deletedAt"
>;

const NO_RIGHTS: DashboardRights = { see: false, edit: false, manage: false };

/** What `viewer` may do with `board` (`dashboards` row), from the row alone. */
export function dashboardRights(board: RightsFields, viewer: DashboardViewer): DashboardRights {
  if (board.deletedAt) return NO_RIGHTS;
  const owner = viewer.userId !== "" && board.ownerUserId === viewer.userId;
  // A private board and a home board are their owner's alone, admins included (ADR 0135 §8).
  const shared =
    board.kind !== "home" &&
    (board.audience === "workspace" ||
      (board.audience === "roles" &&
        (viewer.admin || board.audienceRoleIds.some((id) => viewer.roleIds.includes(id)))));
  if (!owner && !shared) return NO_RIGHTS;
  if (board.kind === "home") return { see: true, edit: owner, manage: owner };
  const edit =
    owner ||
    viewer.admin ||
    board.editPolicy === "viewers" ||
    (board.editPolicy === "roles" && board.editRoleIds.some((id) => viewer.roleIds.includes(id)));
  return { see: true, edit, manage: owner || viewer.admin };
}

const asSql = (v: SQL | string): SQL => (typeof v === "string" ? sql`${v}` : v);

/**
 * The "sees it" rule as SQL over `dashboards` aliased `alias`, for lists in one statement: `userId` the viewer, `admin`
 * whether they are an admin. Excludes deleted boards.
 */
export function dashboardSeerSql(alias: string, userId: SQL | string, admin: boolean): SQL {
  const d = sql.raw(alias);
  const u = asSql(userId);
  const roles = admin
    ? sql`true`
    : sql`exists (select 1 from organization_member_roles dmr where dmr.org_id = ${d}.org_id
        and dmr.user_id = ${u} and dmr.role_id = any(${d}.audience_role_ids))`;
  return sql`(${d}.deleted_at is null and (${d}.owner_user_id = ${u} or (${d}.kind = 'board'
    and (${d}.audience = 'workspace' or (${d}.audience = 'roles' and ${roles})))))`;
}

const notFound = () => new NotFoundError("Dashboard not found", DASHBOARD_ERRORS.notFound);
const forbidden = () => new ForbiddenError("You can't change this dashboard", DASHBOARD_ERRORS.forbidden);

/**
 * The board and the viewer, or `dashboard.not_found` (404) when it doesn't exist or they can't see it, and
 * `dashboard.forbidden` (403) when they see it but `need` is more. Also refuses a closed workspace
 * (`requireActiveMembership`).
 */
export async function requireDashboard(
  db: Database,
  actorId: string,
  orgId: string,
  dashboardId: string,
  need: DashboardNeed,
): Promise<{ board: DashboardRow; viewer: DashboardViewer; membership: Membership }> {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const viewer = viewerOf(membership, actorId);
  const [board] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.orgId, orgId), eq(dashboards.id, dashboardId), isNull(dashboards.deletedAt)));
  if (!board) throw notFound();
  const rights = dashboardRights(board, viewer);
  if (!rights.see) throw notFound();
  if (!rights[need]) throw forbidden();
  return { board, viewer, membership };
}

/**
 * A widget and its board, with the same rule on the board (`widget.not_found` when the board is hidden). A draft
 * (ADR 0135 §16) is its creator's alone, whatever the board's audience: anyone else gets `widget.not_found`.
 */
export async function requireWidget(
  db: Database,
  actorId: string,
  orgId: string,
  widgetId: string,
  need: DashboardNeed,
): Promise<{ widget: WidgetRow; board: DashboardRow; viewer: DashboardViewer; membership: Membership }> {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const viewer = viewerOf(membership, actorId);
  const [row] = await db
    .select({ widget: dashboardWidgets, board: dashboards })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(
      and(
        eq(dashboardWidgets.orgId, orgId),
        eq(dashboardWidgets.id, widgetId),
        eq(dashboards.orgId, orgId),
        isNull(dashboards.deletedAt),
      ),
    );
  const rights = !row
    ? NO_RIGHTS
    : row.widget.draft
      ? row.widget.createdByUserId === actorId
        ? { see: true, edit: true, manage: true }
        : NO_RIGHTS
      : dashboardRights(row.board, viewer);
  if (!row || !rights.see) throw new NotFoundError("Widget not found", DASHBOARD_ERRORS.widgetNotFound);
  if (!rights[need]) throw forbidden();
  return { widget: row.widget, board: row.board, viewer, membership };
}

type AudienceFields = Pick<DashboardRow, "kind" | "audience" | "audienceRoleIds" | "ownerUserId">;

/** "The member aliased `om` (an `organization_members` row) sees `board`", as SQL, for counting. */
function memberSeesSql(board: AudienceFields): SQL {
  const owner = board.ownerUserId ? sql`om.user_id = ${board.ownerUserId}` : sql`false`;
  if (board.kind === "home" || board.audience === "private") return owner;
  if (board.audience === "workspace") return sql`true`;
  if (board.audience !== "roles") return owner;
  const admin = maySql(sql`om.org_id`, sql`om.user_id`, "administrator");
  const roles =
    board.audienceRoleIds.length === 0
      ? sql`false`
      : sql`exists (select 1 from organization_member_roles vmr where vmr.org_id = om.org_id
          and vmr.user_id = om.user_id and vmr.role_id = any(array[${sql.join(
            board.audienceRoleIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::uuid[]))`;
  return sql`(${owner} or ${admin} or ${roles})`;
}

/** How many members see `board` now (the list's count and the Share dialog). */
export async function dashboardViewerCount(
  db: Executor,
  board: Pick<DashboardRow, "orgId" | "kind" | "audience" | "audienceRoleIds" | "ownerUserId">,
): Promise<number> {
  const [row] = rowsOf<{ n: number | string }>(
    await db.execute(sql`select count(*)::int as n from organization_members om
      join users u on u.id = om.user_id
      where om.org_id = ${board.orgId}::uuid and u.blocked_at is null and u.deletion_due_at is null
        and ${memberSeesSql(board)}`),
  );
  return Number(row?.n ?? 0);
}

/** A workspace's members as the "sees it" rule needs them, read once for a list of boards. */
export interface AudienceMember {
  userId: string;
  roleIds: string[];
  admin: boolean;
}

/** Every member who isn't blocked, with their roles and whether they are an admin (`dashboardListViewerCounts`). */
export async function audienceMembers(db: Executor, orgId: string): Promise<AudienceMember[]> {
  const rows = rowsOf<{ user_id: string; role_ids: string[] | null; admin: boolean }>(
    await db.execute(sql`select om.user_id,
        coalesce((select array_agg(mr.role_id::text) from organization_member_roles mr
          where mr.org_id = om.org_id and mr.user_id = om.user_id), '{}'::text[]) as role_ids,
        ${maySql(sql`om.org_id`, sql`om.user_id`, "administrator")} as admin
      from organization_members om join users u on u.id = om.user_id
      where om.org_id = ${orgId}::uuid and u.blocked_at is null and u.deletion_due_at is null`),
  );
  return rows.map((r) => ({ userId: r.user_id, roleIds: r.role_ids ?? [], admin: r.admin === true }));
}

/** How many of `members` see `board` (the same rule as `dashboardViewerCount`, in memory). */
export function countViewers(board: AudienceFields, members: readonly AudienceMember[]): number {
  let n = 0;
  for (const m of members) {
    const viewer: DashboardViewer = { userId: m.userId, roleIds: m.roleIds, admin: m.admin, mayPublish: false };
    if (dashboardRights({ ...board, editPolicy: "owner", editRoleIds: [], deletedAt: null }, viewer).see) n++;
  }
  return n;
}

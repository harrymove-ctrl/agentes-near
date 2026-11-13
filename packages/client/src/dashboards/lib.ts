import type { TFunction } from "i18next";
import { activityVerb, toolActivity } from "../lib/activity";
import { capitalize } from "../lib/format";
import type {
  DashboardAudience,
  DashboardEditPolicy,
  DashboardKind,
  DashboardLayoutInput,
  DashboardSummary,
  HomeTile,
  Widget,
  WidgetCostEstimate,
  WidgetSchedule,
  WidgetStep,
} from "./types";

/**
 * What the web and the phone share about boards (ADR 0135), without React: the list's groups, who has access in
 * Share, a board's order of widgets and tiles, Organize's moves, a failure's words and the cost line.
 */

/**
 * A board as the person may change it: as its `canEdit` and `canManage` say, and not at all while the workspace is
 * being deleted (ADR 0088 §7), so no way into a change shows.
 */
export const frozenBoard = <B extends Pick<DashboardSummary, "canEdit" | "canManage">>(
  board: B,
  org: { deletion?: unknown } | null | undefined,
): B => (org?.deletion ? { ...board, canEdit: false, canManage: false } : board);

const byOrder = (a: DashboardSummary, b: DashboardSummary) =>
  Number(b.pinned) - Number(a.pinned) || a.position - b.position || a.title.localeCompare(b.title);

/** The Dashboards list: the workspace's, the viewer's roles', and only theirs; pinned first, then by position. */
export function dashboardGroups(list: readonly DashboardSummary[]): {
  workspace: DashboardSummary[];
  roles: DashboardSummary[];
  mine: DashboardSummary[];
} {
  const boards = list.filter((d) => d.kind === "board").sort(byOrder);
  return {
    workspace: boards.filter((d) => d.audience === "workspace"),
    roles: boards.filter((d) => d.audience === "roles"),
    mine: boards.filter((d) => d.audience === "private"),
  };
}

export type DashboardAccess = "edits" | "sees" | "none";

/**
 * What one person may do on a board with this audience (Share's "Who has access"), by the same rule as the server:
 * its owner edits; admins see every board but private ones and edit what they see; others see a `workspace` board,
 * or a `roles` one when they hold one of its roles, and edit it when `viewers` edit or, with `roles`, when they hold
 * one of its edit roles (seeing comes first).
 */
export function dashboardAccessOf(
  person: { userId: string; roleIds: readonly string[]; admin: boolean },
  board: {
    kind: DashboardKind;
    audience: DashboardAudience;
    roleIds: readonly string[];
    editPolicy: DashboardEditPolicy;
    editRoleIds?: readonly string[];
    ownerUserId: string | null;
  },
): DashboardAccess {
  if (board.ownerUserId === person.userId) return "edits";
  if (board.kind === "home" || board.audience === "private") return "none";
  const sees =
    board.audience === "workspace" || person.admin || board.roleIds.some((id) => person.roleIds.includes(id));
  if (!sees) return "none";
  if (person.admin || board.editPolicy === "viewers") return "edits";
  const byRole = board.editPolicy === "roles" && (board.editRoleIds ?? []).some((id) => person.roleIds.includes(id));
  return byRole ? "edits" : "sees";
}

// ── Who edits ────────────────────────────────────────────────────────────────

/** Who edits a board as New dashboard and Share draft it: the policy and, with `roles`, the roles. */
export interface DashboardEditors {
  editPolicy: DashboardEditPolicy;
  editRoleIds: string[];
}

/**
 * Whether the holders of a role see a board with this audience: only they can edit it through that role (editing
 * isn't seeing, ADR 0135 §8), so "Who edits" offers the others disabled.
 */
export function roleSeesBoard(
  board: { audience: DashboardAudience; roleIds: readonly string[] },
  roleId: string,
): boolean {
  return board.audience === "workspace" || (board.audience === "roles" && board.roleIds.includes(roleId));
}

/** Who edits once these roles are picked: `roles` with them, or `owner` (you and admins) when none is left. */
export function withEditRoles<T extends DashboardEditors>(draft: T, roleIds: readonly string[]): T {
  const ids = [...new Set(roleIds)];
  return ids.length > 0
    ? { ...draft, editPolicy: "roles", editRoleIds: ids }
    : { ...draft, editPolicy: "owner", editRoleIds: [] };
}

/** A role checked or unchecked in "Who edits" (checking one while `viewers` or `owner` starts the roles' list). */
export function toggleEditRole<T extends DashboardEditors>(draft: T, roleId: string): T {
  const now = draft.editPolicy === "roles" ? draft.editRoleIds : [];
  return withEditRoles(draft, now.includes(roleId) ? now.filter((id) => id !== roleId) : [...now, roleId]);
}

/**
 * The draft after "Who sees" changed: edit roles whose holders no longer see the board are dropped, and with none
 * left it is edited by you and admins (`owner`), never by more people than before.
 */
export function fitEditRoles<T extends DashboardEditors & { audience: DashboardAudience; roleIds: string[] }>(
  draft: T,
): T {
  if (draft.editPolicy !== "roles") return draft;
  const kept = draft.editRoleIds.filter((id) => roleSeesBoard(draft, id));
  return kept.length === draft.editRoleIds.length ? draft : withEditRoles(draft, kept);
}

/** What New dashboard and Share send for who edits: the roles only with `roles`. */
export function editorsInput(draft: DashboardEditors): DashboardEditors {
  return { editPolicy: draft.editPolicy, editRoleIds: draft.editPolicy === "roles" ? draft.editRoleIds : [] };
}

/** "Who edits" in a few words, as the web's dropdown and the phone's row show it. */
export type EditorsSummary = { kind: "viewers" } | { kind: "owner" } | { kind: "roles"; names: string[] };

/** The summary of who edits; roles gone from the workspace are left out (none left reads as `owner`). */
export function editorsSummary(
  draft: DashboardEditors,
  roles: readonly { id: string; name: string }[],
): EditorsSummary {
  if (draft.editPolicy === "viewers") return { kind: "viewers" };
  const names = roles.filter((r) => draft.editRoleIds.includes(r.id)).map((r) => r.name);
  if (draft.editPolicy !== "roles" || names.length === 0) return { kind: "owner" };
  return { kind: "roles", names };
}

/** The summary as text: "Everyone who sees it", "Only you and admins", "Sales", "Sales and Board" or "3 roles". */
export function editorsText(t: TFunction, summary: EditorsSummary): string {
  if (summary.kind !== "roles") return t(`dashboards.edit.${summary.kind}`);
  const [first = "", second = ""] = summary.names;
  if (summary.names.length === 1) return first;
  if (summary.names.length === 2) return t("dashboards.edit.twoRoles", { first, second });
  return t("dashboards.edit.manyRoles", { count: summary.names.length });
}

/** One cell of a board: a widget, or a home board's fixed tile. */
export type BoardItem =
  | { type: "widget"; id: string; position: number; w: 1 | 2; h: 1 | 2; widget: Widget }
  | { type: "tile"; id: HomeTile["key"]; position: number; w: 1 | 2; h: 1 | 2; tile: HomeTile };

/** A board's widgets and tiles in their order (a tile first on a tie). */
export function boardItems(widgets: readonly Widget[], tiles: readonly HomeTile[] = []): BoardItem[] {
  const items: BoardItem[] = [
    ...tiles.map((tile) => ({
      type: "tile" as const,
      id: tile.key,
      position: tile.position,
      w: tile.w,
      h: tile.h,
      tile,
    })),
    ...widgets.map((widget) => ({
      type: "widget" as const,
      id: widget.id,
      position: widget.layout.position,
      w: widget.layout.w,
      h: widget.layout.h,
      widget,
    })),
  ];
  return items.sort((a, b) => a.position - b.position || (a.type === b.type ? 0 : a.type === "tile" ? -1 : 1));
}

/** `items` with `id` moved to where `targetId` is (before it, or after it when moving down); else the same order. */
export function moveItem<T extends { id: string }>(items: readonly T[], id: string, targetId: string): T[] {
  const from = items.findIndex((x) => x.id === id);
  const to = items.findIndex((x) => x.id === targetId);
  if (from < 0 || to < 0 || from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** `items` with one resized. */
export function resizeItem<T extends { id: string; w: 1 | 2; h: 1 | 2 }>(
  items: readonly T[],
  id: string,
  size: { w: 1 | 2; h: 1 | 2 },
): T[] {
  return items.map((x) => (x.id === id ? { ...x, w: size.w, h: size.h } : x));
}

/** What "Done" in Organize saves: positions 0, 1, 2… in the order shown, and each size. */
export function layoutOf(items: readonly BoardItem[]): DashboardLayoutInput {
  const widgets: DashboardLayoutInput["widgets"] = [];
  const tiles: HomeTile[] = [];
  items.forEach((item, position) => {
    if (item.type === "tile") tiles.push({ key: item.id, position, w: item.w, h: item.h });
    else widgets.push({ id: item.id, position, w: item.w, h: item.h });
  });
  return tiles.length ? { widgets, tiles } : { widgets };
}

/** Failure codes with words of their own under `widgets.failure.*`; any other reads as `error`. */
export const WIDGET_FAILURE_CODES = [
  "agent_reported",
  "no_update",
  "error",
  "budget_exceeded",
  "waiting_computer",
  "waiting_plan",
  "waiting_budget",
  "creator_left",
  "creator_no_access",
  "agent_archived",
  "audience",
  "failing",
  "stopped",
  "missing_credential",
  "timeout",
  "invalid_data",
] as const;
export type WidgetFailureCode = (typeof WIDGET_FAILURE_CODES)[number];

/** The `widgets.failure.*` key of a failure code. `agent_reported` shows the agent's own words instead. */
export function widgetFailureKey(code: string): `widgets.failure.${WidgetFailureCode}` {
  const known = (WIDGET_FAILURE_CODES as readonly string[]).includes(code) ? (code as WidgetFailureCode) : "error";
  return `widgets.failure.${known}`;
}

/** The cost line of "New widget": a day, a week, only when asked, on a plan, or nothing known. */
export type WidgetCostLine =
  | { kind: "day"; usd: number }
  | { kind: "week"; usd: number }
  | { kind: "manual" }
  | { kind: "plan" }
  | { kind: "unknown" };

export function widgetCostLine(
  schedule: WidgetSchedule,
  estimate: WidgetCostEstimate | null | undefined,
): WidgetCostLine {
  if (schedule === "manual") return { kind: "manual" };
  if (!estimate) return { kind: "unknown" };
  if (estimate.billedTo === "plan") return { kind: "plan" };
  const usd = schedule === "week" ? estimate.perWeekUsd : estimate.perDayUsd;
  if (usd === null) return { kind: "unknown" };
  return schedule === "week" ? { kind: "week", usd } : { kind: "day", usd };
}

/** The widgets of a board that are updating or being built (a sweep on each). */
export const busyWidgets = (widgets: readonly Widget[]) =>
  widgets.filter((w) => w.status === "updating" || w.status === "building");

/** A build that takes longer than this says it is still at it. */
export const WIDGET_STILL_MS = 45_000;

/**
 * The building card's step line, in the chat's own words for a call ("Consultando o Stripe", "Pesquisando na web"),
 * never a tool's name; "Pensando" between calls, and its own words for the call that hands the data in.
 */
export function widgetStepWords(t: TFunction, step: WidgetStep | null | undefined, locale?: string): string {
  if (!step?.tool) return t("dashboards.newWidget.thinking");
  if (step.tool === "update_widget" && !step.connector) return t("dashboards.newWidget.finishing");
  const activity = toolActivity(step.tool, step.connector, null, { service: step.service });
  return capitalize(activityVerb(t, activity), locale);
}

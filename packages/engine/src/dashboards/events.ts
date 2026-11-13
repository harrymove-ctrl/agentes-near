import type { PubSub } from "@agenteschat/adapters";
import { publishOrgEvent, publishUserEvent } from "../events";
import type { DashboardRow, WidgetStatus } from "./types";

/**
 * Live updates of boards and widgets (ADR 0135 §13). Only ids and a widget's status go out: what each person may see
 * stays behind the boards' own endpoints, which the apps call again. A private or home board's events go to its
 * owner alone; any other board's to the whole workspace (as `routine.runs` does), and so does a change that took a
 * board away from people (`wide`), so their lists drop it.
 */

/** A board changed: its title, who sees it, its layout, a widget added or removed, a request pending, deleted. */
export const DASHBOARD_CHANGED = "dashboard.changed";
/** A widget's data or status changed (a refresh started, ended or failed). */
export const DASHBOARD_WIDGET = "dashboard.widget";

export type DashboardEvent =
  | { type: typeof DASHBOARD_CHANGED; orgId: string; dashboardId: string; deleted?: true }
  | {
      type: typeof DASHBOARD_WIDGET;
      orgId: string;
      dashboardId: string;
      widgetId: string;
      status: WidgetStatus | "removed";
    };

type Target = Pick<DashboardRow, "id" | "orgId" | "kind" | "audience" | "ownerUserId">;

async function publish(pubsub: PubSub | undefined, board: Target, event: DashboardEvent, wide: boolean) {
  const own = board.kind === "home" || board.audience === "private";
  if (own && !wide) {
    if (board.ownerUserId) await publishUserEvent(pubsub, board.orgId, board.ownerUserId, event);
    return;
  }
  await publishOrgEvent(pubsub, { type: "org.broadcast", orgId: board.orgId, event });
}

/**
 * `board` changed. `wide`: it may have left people who saw it before (made private or narrower, deleted, or moved
 * between owners), so everyone's lists hear it.
 */
export function publishDashboardChanged(
  pubsub: PubSub | undefined,
  board: Target,
  options: { wide?: boolean; deleted?: boolean } = {},
) {
  const event: DashboardEvent = {
    type: DASHBOARD_CHANGED,
    orgId: board.orgId,
    dashboardId: board.id,
    ...(options.deleted ? { deleted: true as const } : {}),
  };
  return publish(pubsub, board, event, options.wide === true || options.deleted === true);
}

/**
 * A widget of `board` changed (`removed`: it was taken off). A draft's (`draft` with its `createdByUserId`, ADR 0135
 * §16) goes to its creator alone, whoever sees the board: nobody else knows it exists.
 */
export async function publishWidgetChanged(
  pubsub: PubSub | undefined,
  board: Target,
  widget: { id: string; status: WidgetStatus | "removed"; draft?: boolean; createdByUserId?: string | null },
) {
  const event: DashboardEvent = {
    type: DASHBOARD_WIDGET,
    orgId: board.orgId,
    dashboardId: board.id,
    widgetId: widget.id,
    status: widget.status,
  };
  if (widget.draft) {
    if (widget.createdByUserId) await publishUserEvent(pubsub, board.orgId, widget.createdByUserId, event);
    return;
  }
  await publish(pubsub, board, event, false);
}

/** A widget row's event fields (its draft flag and creator included). */
export const widgetEvent = (
  row: { id: string; draft: boolean; createdByUserId: string | null },
  status: WidgetStatus | "removed",
) => ({ id: row.id, status, draft: row.draft, createdByUserId: row.createdByUserId });

import type { QueryClient } from "@tanstack/react-query";
import { keys } from "../api/keys";

/** A board changed (ADR 0135): its title, who sees it, its layout, a widget added or removed, deleted. */
export const DASHBOARD_CHANGED = "dashboard.changed";
/** A widget's data or status changed. */
export const DASHBOARD_WIDGET = "dashboard.widget";

export type DashboardEvent =
  | { type: "dashboard.changed"; orgId: string; dashboardId: string; deleted?: true }
  | {
      type: "dashboard.widget";
      orgId: string;
      dashboardId: string;
      widgetId: string;
      status: "building" | "ok" | "updating" | "failed" | "removed";
    };

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * A board or widget event, from the workspace's broadcast or the person's own topic (a private or home board's):
 * only ids come, so the boards it touches are fetched again (only the ones on screen refetch). True when it was one.
 * The web (`realtime/context.tsx`) and the phone (`features/shared/userEvents.ts`) call it with every event.
 */
export function applyDashboardEvent(qc: QueryClient, orgId: string, event: { type: string }): boolean {
  if (event.type !== DASHBOARD_CHANGED && event.type !== DASHBOARD_WIDGET) return false;
  const e = event as Partial<Record<"dashboardId" | "widgetId" | "status", unknown>> & { deleted?: unknown };
  void qc.invalidateQueries({ queryKey: keys.dashboardList(orgId) });
  void qc.invalidateQueries({ queryKey: keys.dashboardHome(orgId) });
  if (isString(e.dashboardId)) {
    if (e.deleted === true) qc.removeQueries({ queryKey: keys.dashboard(orgId, e.dashboardId) });
    else void qc.invalidateQueries({ queryKey: keys.dashboard(orgId, e.dashboardId) });
  }
  if (event.type === DASHBOARD_WIDGET && isString(e.widgetId)) {
    if (e.status === "removed") qc.removeQueries({ queryKey: keys.widget(orgId, e.widgetId) });
    else void qc.invalidateQueries({ queryKey: keys.widget(orgId, e.widgetId) });
  }
  // A list of blocks to pin doesn't change with a board; cost and suggestions neither.
  return true;
}

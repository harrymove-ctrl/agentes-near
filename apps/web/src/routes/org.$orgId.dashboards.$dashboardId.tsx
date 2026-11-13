import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { DashboardPage } from "@/pages/DashboardPage";

/** A widget opened in the board's side panel, from a notification or a link (ADR 0135 §14). */
function widgetSearch(search: Record<string, unknown>): { widget?: string } {
  const v = search.widget;
  return typeof v === "string" && v ? { widget: v } : {};
}

/** One dashboard; `?widget=<id>` opens that widget's panel. */
export const Route = createFileRoute("/org/$orgId/dashboards/$dashboardId")({
  validateSearch: widgetSearch,
  component: function Page() {
    const { dashboardId } = Route.useParams();
    return (
      <Main>
        <DashboardPage key={dashboardId} dashboardId={dashboardId} />
      </Main>
    );
  },
});

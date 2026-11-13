import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { HomePage } from "@/pages/HomePage";

/** A widget of My Home opened in its side panel, from a notification or a link (ADR 0135). */
function widgetSearch(search: Record<string, unknown>): { widget?: string } {
  const v = search.widget;
  return typeof v === "string" && v ? { widget: v } : {};
}

/** Home: what waits on me, what my agents are doing, my widgets (ADR 0108, ADR 0135). `?widget=<id>` opens one. */
export const Route = createFileRoute("/org/$orgId/home")({
  validateSearch: widgetSearch,
  component: () => (
    <Main>
      <HomePage />
    </Main>
  ),
});

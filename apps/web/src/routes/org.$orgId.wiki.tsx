import { createFileRoute } from "@tanstack/react-router";
import { WikiPage } from "@/pages/WikiPage";

/** The wiki's home; `?new=Título` opens "Nova página" (a missing `[[link]]`). */
export const Route = createFileRoute("/org/$orgId/wiki")({
  validateSearch: (search: Record<string, unknown>): { new?: string } =>
    typeof search.new === "string" ? { new: search.new } : {},
  component: function Page() {
    const { new: newTitle } = Route.useSearch();
    return (
      <main className="shell__main shell__main--wiki">
        <WikiPage newTitle={newTitle} />
      </main>
    );
  },
});

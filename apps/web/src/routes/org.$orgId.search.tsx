import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SearchPage } from "@/pages/SearchPage";

/** "Buscar no workspace" (sidebar); `?in={channelId}` opens it scoped to that channel or DM (its header's search). */
export const Route = createFileRoute("/org/$orgId/search")({
  validateSearch: (search: Record<string, unknown>): { in?: string } =>
    typeof search.in === "string" && search.in ? { in: search.in } : {},
  component: function Search() {
    const scope = Route.useSearch().in;
    return (
      <Main>
        <SearchPage key={scope} scope={scope} />
      </Main>
    );
  },
});

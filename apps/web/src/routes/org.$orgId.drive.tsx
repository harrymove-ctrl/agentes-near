import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { openSearch } from "@/lib/open-param";
import { DrivePage } from "@/pages/DrivePage";

/** Drive: every artifact the viewer can see. `?artifact=…&v=…` opens one (shared links); `?open=…` its details. */
export const Route = createFileRoute("/org/$orgId/drive")({
  validateSearch: (search: Record<string, unknown>): { artifact?: string; v?: number; open?: string | number } => ({
    ...openSearch(search),
    artifact: typeof search.artifact === "string" ? search.artifact : undefined,
    v: typeof search.v === "number" && search.v > 0 ? search.v : undefined,
  }),
  component: function Page() {
    const { artifact, v } = Route.useSearch();
    return (
      <Main>
        <DrivePage open={artifact ? { id: artifact, version: v } : undefined} />
      </Main>
    );
  },
});

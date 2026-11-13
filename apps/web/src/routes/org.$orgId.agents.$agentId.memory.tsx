import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { MemoryPage } from "@/pages/MemoryPage";

/** An agent's memory; `?item=` opens it at one memory. */
export const Route = createFileRoute("/org/$orgId/agents/$agentId/memory")({
  validateSearch: (search: Record<string, unknown>): { item?: string } => ({
    item: typeof search.item === "string" ? search.item : undefined,
  }),
  component: function Memory() {
    return (
      <Main>
        <MemoryPage agentId={Route.useParams().agentId} item={Route.useSearch().item} />
      </Main>
    );
  },
});

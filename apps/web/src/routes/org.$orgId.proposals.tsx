import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { ProposalsPage } from "@/pages/ProposalsPage";

export const Route = createFileRoute("/org/$orgId/proposals")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    agent: typeof search.agent === "string" ? search.agent : undefined,
  }),
  component: function Proposals() {
    return (
      <Main>
        <ProposalsPage agentId={Route.useSearch().agent} />
      </Main>
    );
  },
});

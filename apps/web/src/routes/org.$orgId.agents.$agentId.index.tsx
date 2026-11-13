import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { agentSearch } from "@/lib/agent-edit";
import { AgentPage } from "@/pages/AgentPage";

/**
 * The agent's page; `?tab=` and `?sec=` (a section of Configurações) make links to a part of it, and `&brain=` to a
 * screen of "Quem pensa".
 */
export const Route = createFileRoute("/org/$orgId/agents/$agentId/")({
  validateSearch: agentSearch,
  component: function Agent() {
    const { agentId } = Route.useParams();
    const { tab, sec, brain } = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    return (
      <Main>
        <AgentPage
          agentId={agentId}
          tab={tab ?? "overview"}
          section={sec}
          brainAt={brain}
          onNavigate={(next, section) =>
            void navigate({
              search: { tab: next === "overview" ? undefined : next, sec: section },
              replace: true,
              resetScroll: false,
            })
          }
        />
      </Main>
    );
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { taskSearch } from "@/lib/open-param";
import { IssuesPage } from "@/pages/IssuesPage";

/**
 * Issues: board and list. `?open=131` opens an issue's
 * details, `&m=<message>` its conversation at that message. The page scrolls in the main column like every non-chat page (the
 * chat layout clips its overflow: a tall column could not be reached).
 */
export const Route = createFileRoute("/org/$orgId/issues/")({
  validateSearch: taskSearch,
  component: () => (
    <Main>
      <IssuesPage />
    </Main>
  ),
});

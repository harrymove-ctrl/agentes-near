import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { openSearch } from "@/lib/open-param";
import { ApprovalsPage } from "@/pages/ApprovalsPage";

export const Route = createFileRoute("/org/$orgId/approvals")({
  validateSearch: openSearch,
  component: () => (
    <Main>
      <ApprovalsPage />
    </Main>
  ),
});

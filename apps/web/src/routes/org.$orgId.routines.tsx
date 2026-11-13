import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { openSearch } from "@/lib/open-param";
import { RoutinesPage } from "@/pages/RoutinesPage";

/** Rotinas. `?open=<id>` opens a routine's details. */
export const Route = createFileRoute("/org/$orgId/routines")({
  validateSearch: openSearch,
  component: () => (
    <Main>
      <RoutinesPage />
    </Main>
  ),
});

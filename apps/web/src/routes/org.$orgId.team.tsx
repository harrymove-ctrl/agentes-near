import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { TeamPage } from "@/pages/TeamPage";

/** Equipe: the agents grouped by their person, and who consulted whom. */
export const Route = createFileRoute("/org/$orgId/team")({
  component: () => (
    <Main>
      <TeamPage />
    </Main>
  ),
});

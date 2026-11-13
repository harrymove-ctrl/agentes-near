import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { taskSearch } from "@/lib/open-param";
import { IssuePage } from "@/pages/IssuePage";

/** One issue. `?m=<message>`: its conversation open at that message (a notice, a link). */
export const Route = createFileRoute("/org/$orgId/issues/$number")({
  validateSearch: taskSearch,
  component: function Page() {
    const { number } = Route.useParams();
    return (
      <Main>
        <IssuePage key={number} number={Number(number)} />
      </Main>
    );
  },
});

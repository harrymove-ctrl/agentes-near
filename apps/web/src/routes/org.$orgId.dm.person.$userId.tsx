import { createFileRoute } from "@tanstack/react-router";
import { threadSearch } from "@/lib/open-param";
import { DmPage } from "@/pages/DmPage";

/** Direct message with a person (sidebar "Mensagens diretas"). */
export const Route = createFileRoute("/org/$orgId/dm/person/$userId")({
  // `?m=<message>` opens the DM at that message (a search hit); `?thread=` is the one in its panel.
  validateSearch: (search: Record<string, unknown>): { m?: string } & ReturnType<typeof threadSearch> => ({
    ...threadSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
  }),
  component: function PersonDm() {
    const { userId } = Route.useParams();
    return <DmPage key={userId} target={{ userId }} focusMessageId={Route.useSearch().m} />;
  },
});

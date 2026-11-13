import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { createFileRoute } from "@tanstack/react-router";
import { threadSearch } from "@/lib/open-param";
import { DmPage } from "@/pages/DmPage";

/** Direct message with an agent (sidebar "Agentes"). */
export const Route = createFileRoute("/org/$orgId/dm/agent/$agentId")({
  // `?m=<message>` opens the DM at that message (a search hit); `?paid`: back from paying for the workspace (the hold
  // banner says the payment is being confirmed), where a new workspace opens its right hand's DM (ADR 0137); `?thread=`
  // is the one in its panel.
  validateSearch: (search: Record<string, unknown>): { m?: string; paid?: true } & ReturnType<typeof threadSearch> => ({
    ...threadSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
    ...(isPaidReturn(search) ? { paid: true as const } : {}),
  }),
  component: function AgentDm() {
    const { agentId } = Route.useParams();
    return <DmPage key={agentId} target={{ agentId }} focusMessageId={Route.useSearch().m} />;
  },
});

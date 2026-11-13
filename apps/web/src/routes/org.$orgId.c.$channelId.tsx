import { channelMembersQuery, channelsQuery, channelThreadsQuery, messagesQuery } from "@agenteschat/client";
import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { createFileRoute } from "@tanstack/react-router";
import { threadSearch } from "@/lib/open-param";
import { ChannelPage } from "@/pages/ChannelPage";

/**
 * A channel; `?m={messageId}` (from "Copiar link") opens it at that message;
 * `?adjust={threadId}` opens "Ajustar trecho" for that thread's range; `?thread=` is the one in its panel; `?paid`:
 * back from paying for the workspace, which opens in #general (the hold banner says the payment is being confirmed).
 */
export const Route = createFileRoute("/org/$orgId/c/$channelId")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { m?: string; adjust?: string; paid?: true } & ReturnType<typeof threadSearch> => ({
    ...threadSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
    ...(typeof search.adjust === "string" && search.adjust ? { adjust: search.adjust } : {}),
    ...(isPaidReturn(search) ? { paid: true as const } : {}),
  }),
  // What the channel opens with, all at once instead of one after another; a hover on a link starts it
  // too (`defaultPreload: "intent"`). Not awaited: the page shows at once and fills in. Only for a
  // channel I'm in (the server refuses the rest until I join).
  loader: ({ context: { queryClient, api }, params: { orgId, channelId } }) => {
    void queryClient
      .ensureQueryData(channelsQuery(api, orgId))
      .then((channels) => {
        if (!channels.some((c) => c.id === channelId && c.isMember)) return;
        void queryClient.prefetchQuery(messagesQuery(api, orgId, channelId));
        void queryClient.prefetchQuery(channelMembersQuery(api, orgId, channelId));
        void queryClient.prefetchQuery(channelThreadsQuery(api, orgId, channelId, "all"));
        void queryClient.prefetchQuery(channelThreadsQuery(api, orgId, channelId, "archived"));
      })
      .catch(() => {});
  },
  component: function Channel() {
    const { m, adjust } = Route.useSearch();
    return <ChannelPage channelId={Route.useParams().channelId} focusMessageId={m} adjustThreadId={adjust} />;
  },
});

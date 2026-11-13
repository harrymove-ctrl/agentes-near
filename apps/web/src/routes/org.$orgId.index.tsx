import { channelsQuery, keys } from "@agenteschat/client";
import { noAnswer } from "@agenteschat/client/lib/errors";
import { startPlace } from "@agenteschat/client/lib/home";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { channelOfPath, isChatPath, lastPlace, opensWorkspace } from "@/lib/start";

/**
 * `/org/$orgId`: opening the workspace lands where the person chose (ADR 0108), Início by default. A personal
 * workspace (ADR 0159) with nothing chosen opens on the last conversation this browser showed, else on its right
 * hand's. A move inside the workspace, or a link that carries a request (`?connect=ai`), goes to Início, the request
 * with it.
 */
export const Route = createFileRoute("/org/$orgId/")({
  beforeLoad: async ({ context, params, search }) => {
    const home = { to: "/org/$orgId/home" as const, params, search };
    const choice = context.membership?.start;
    // A personal workspace is a conversation first (ADR 0159): with nothing else chosen it opens on one.
    const personal = context.membership?.mode === "personal";
    if (!opensWorkspace(params.orgId) || Object.keys(search).length > 0) throw redirect(home);
    const byDefault = !choice || choice.page === "home";
    if (byDefault && !personal) throw redirect(home);
    const channels = await context.queryClient
      .ensureQueryData(channelsQuery(context.api, params.orgId))
      // A list the server didn't answer for is the can't-reach screen (ErrorScreen), never a place it can't check.
      .catch((error: unknown) => {
        if (noAnswer(error)) throw error;
        return [];
      });
    const inChannel = (id: string) => channels.some((c) => c.id === id && c.isMember);
    const kept = lastPlace(params.orgId);
    const keptChannel = kept ? channelOfPath(kept) : null;
    const last = keptChannel && !inChannel(keptChannel) ? null : kept;
    if (byDefault) {
      // The conversation this browser showed last, else the right hand's; the home only with neither.
      if (last && isChatPath(last)) throw redirect({ href: last });
      const agents = await context.queryClient
        .ensureQueryData({
          queryKey: keys.agents(params.orgId),
          queryFn: () => context.api.agents.list(params.orgId),
          staleTime: 30_000,
        })
        .catch(() => []);
      const rightHand = rightHandOf(agents);
      if (rightHand)
        throw redirect({
          to: "/org/$orgId/dm/agent/$agentId",
          params: { orgId: params.orgId, agentId: rightHand.id },
        });
      throw redirect(home);
    }
    const place = startPlace(choice, { last, inChannel });
    if (place.kind === "channel")
      throw redirect({ to: "/org/$orgId/c/$channelId", params: { orgId: params.orgId, channelId: place.channelId } });
    if (place.kind === "last") throw redirect({ href: place.place });
    throw redirect(home);
  },
});

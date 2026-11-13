import { useChannels, useDms } from "@agenteschat/client";
import { useOrgId } from "../../shared/hooks";

/** The channels this person sees, DMs aside (the web's `useVisibleChannels`): where an agent may be put. */
export function useAgentChannels() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const dmIds = new Set((dms.data ?? []).map((d) => d.channelId));
  return {
    list: (channels.data ?? []).filter((ch) => !dmIds.has(ch.id)),
    ready: channels.isSuccess && !dms.isPending,
  };
}

import { useChannels } from "@agenteschat/client";
import { channelOptions } from "@agenteschat/client/lib/channel-refs";
import { type ComposerSuggestion, Icon } from "@agenteschat/ui";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/** "#" suggestions: the channels I can see (`channelOptions`), each with its topic, the ones I'm not in say so. */
export function useChannelSearch() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id).data;
  return useCallback(
    (query: string): ComposerSuggestion[] =>
      channelOptions(query, channels ?? []).map((c) => ({
        key: `channel:${c.id}`,
        insert: c.name,
        label: `#${c.name}`,
        description: c.topic || undefined,
        leading: <Icon name={c.visibility === "private" ? "lock" : "channel"} size={16} />,
        note: c.isMember ? undefined : t("channelRefs.notMember"),
      })),
    [channels, t],
  );
}

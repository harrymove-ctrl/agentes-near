import { useNotifications } from "@agenteschat/client";
import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { notificationHref } from "@/features/links/logic";
import { useColors, useOrgId } from "@/features/shared/hooks";
import { router } from "@/ui/navigation";

/**
 * A bare link to an agent's request for help in its browser (`agenteschat://handoff/<id>`): the request
 * lives in its conversation, so this finds where its notice in "Esperando você" opens (the conversation with
 * the card in control, or the agent's computer) and goes there; without it, to the activity.
 */
export default function HandoffRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const orgId = useOrgId();
  const c = useColors();
  const waiting = useNotifications(orgId, "waiting");
  useEffect(() => {
    if (!waiting.data && !waiting.isError) return;
    const notice = waiting.data?.pages.flatMap((p) => p.items).find((n) => n.source.handoffId === id);
    const href = notice ? notificationHref(notice) : null;
    router.replace(href && !href.startsWith("/handoff/") ? href : "/activity");
  }, [waiting.data, waiting.isError, id]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}

import { useChannels, useDms } from "@agenteschat/client";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect } from "react";
import { readValue, STORED, writeValue } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { router } from "@/ui/navigation";
import { useLaunched } from "../launch/launched";
import { inConversation, startHref, withPlace } from "./logic";

/** This conversation is where "Onde você parou" opens the next time the app starts (ADR 0108). */
export function useRememberPlace(href: string) {
  const { orgId } = useOrg();
  useFocusEffect(
    useCallback(() => {
      void readValue(STORED.lastPlace).then((raw) => writeValue(STORED.lastPlace, withPlace(raw, orgId, href)));
    }, [orgId, href]),
  );
}

/** Once per app start: the choice applies when the app starts, never when Conversas shows again. */
let started = false;

/**
 * When the app starts on Conversas (`focused` once the launch splash leaves), what the person chose opens over it,
 * back to Conversas. Never over a screen a notification or a link opened.
 */
export function useOpenStart(focused: boolean) {
  const { org, orgId } = useOrg();
  const launched = useLaunched();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const choice = org?.start;
  useEffect(() => {
    if (started || !launched) return;
    if (!focused || !choice || choice.page === "home") {
      started = true;
      return;
    }
    if (!channels.data || !dms.data) return;
    started = true;
    const mine = inConversation(channels.data, dms.data);
    void readValue(STORED.lastPlace).then((raw) => {
      const href = startHref(choice, raw, orgId, mine);
      if (href) router.push(href as never);
    });
  }, [launched, focused, choice, channels.data, dms.data, orgId]);
}

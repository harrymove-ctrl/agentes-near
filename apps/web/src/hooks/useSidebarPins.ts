import { useAgentGroups, useChannels, useDms, useSetSidebarView, useSidebarView } from "@agenteschat/client";
import { hiddenAgentIds } from "@agenteschat/client/lib/audience";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { dayOnePins, type PinKind, pinsOf, togglePin } from "@agenteschat/client/lib/sidebar-view";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import type { MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { useDirectory } from "./useDirectory";

/**
 * "Fixar no topo" (pins inside each sidebar section): what is pinned (on day one the person's own agents) and the menu
 * item that pins or unpins a row. Saved per person (`…/me/sidebar/view`).
 */
export function useSidebarPins() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const view = useSidebarView(org.id);
  const setView = useSetSidebarView(org.id);
  const dir = useDirectory(org.id);
  const dms = useDms(org.id).data;
  const groups = useAgentGroups(org.id).data;
  const channels = useChannels(org.id).data;
  const hidden = hiddenAgentIds(org, dir.agents);
  const listed = dir.agents.filter((a) => !hidden.has(a.id));
  const lastActive = new Map<string, string>();
  for (const d of dms ?? [])
    if (d.with.type === "agent" && d.lastMessage) lastActive.set(d.with.id, d.lastMessage.createdAt);
  const dayOne = dayOnePins(
    listed.filter((a) => !isRightHand(a)),
    me.user.id,
    lastActive,
    groups,
  );
  // A pin of something no longer in these lists holds no place.
  const known = {
    agents: listed.map((a) => a.id),
    channels: channels?.filter((c) => c.isMember).map((c) => c.id),
    people: dir.members.map((m) => m.userId),
  };
  const pins = pinsOf(view, dayOne, known);
  const toggle = (kind: PinKind, id: string) => {
    if (!togglePin(pins, kind, id)) {
      toast.show(t(`sidebarPins.full.${kind}`), "info");
      return;
    }
    setView((now) => {
      const from = pinsOf(now, dayOne, known);
      return { ...now, pins: togglePin(from, kind, id) ?? from };
    });
  };
  return {
    view,
    setView,
    pins,
    isPinned: (kind: PinKind, id: string) => pins[kind].includes(id),
    toggle,
    /** "Fixar no topo" / "Tirar do topo" for a row's menus. */
    entry: (kind: PinKind, id: string): MenuEntry => ({
      kind: "item",
      id: "pin",
      label: pins[kind].includes(id) ? t("sidebarPins.unpin") : t("sidebarPins.pin"),
      icon: "pin",
      run: () => toggle(kind, id),
    }),
  };
}

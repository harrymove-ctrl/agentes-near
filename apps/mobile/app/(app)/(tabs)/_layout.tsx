import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { NativeTabs } from "expo-router/native-tabs";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { useWaitingItems } from "@/features/chats/WaitingStrip";
import { useNow } from "@/features/shared/hooks";
import { useActiveWork, useUnreadConversations, useUnreadThreads, useWaitingCount } from "@/features/shared/queries";
import { alongWork, WorkAlongLine, workAlong } from "@/features/work-along/WorkAlong";
import { TAB_BADGE, tabBadge } from "@/lib/nav";
import { useOrg } from "@/providers/org";
import { haptics, useTheme } from "@/ui";
import { type TabGlyph, tabGlyphKey } from "@/ui/tabGlyphs";
import { tabGlyphFamily } from "@/ui/tabIcons";

const TABS: { name: string; glyph: TabGlyph; label: string; role?: "search"; teamOnly?: true }[] = [
  { name: "(chats)", glyph: "chats", label: "mobile.tabs.chats" },
  // A conversation that branches is rare for one person: a personal workspace (ADR 0159) opens Threads from You › Work.
  { name: "threads", glyph: "threads", label: "mobile.tabs.threads", teamOnly: true },
  { name: "agents", glyph: "agents", label: "mobile.tabs.agents" },
  { name: "activity", glyph: "activity", label: "mobile.tabs.activity" },
  // The search role: on iOS 26 the round button apart at the bar's end (like Music); a plain tab on Android.
  { name: "search", glyph: "search", label: "mobile.tabs.search", role: "search" },
];

/**
 * Conversas (the home), Threads (threads and missions), Agentes, Atividade and Buscar in the system tab bar
 * (UITabBarController on iOS, Liquid Glass on iOS 26; Material bottom navigation on Android). Our own glyphs on both platforms (outline, filled when
 * selected), drawn as template images the bar tints. Badges for unread conversations (Conversas: channels
 * and DMs; Threads: its rows, never both) and what waits on you. Every tab holds a stack with a native header. A
 * personal workspace (ADR 0159) leaves Threads out of the bar (`hidden`, the system bar's own way: changing it redraws
 * the tabs from Conversas); its row in You › Work opens the same list, pushed.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const personal = isPersonal(useOrg().org);
  const unread = useUnreadConversations();
  const unreadThreads = useUnreadThreads();
  const waiting = useWaitingCount();
  const counts: Record<string, number> = { "(chats)": unread, threads: unreadThreads, activity: waiting };
  // Long work and what waits on you go with you across the tabs (iOS 26: the bar's accessory, the system's glass).
  // "Espera seu ok" only where something really waits on me (the home's strip and Atividade read the same list): a
  // run held for someone else's approval, or one still marked waiting after the request was decided, said it anyway.
  const mine = useWaitingItems().items;
  const work = useActiveWork();
  const along = workAlong(alongWork(work, mine), useNow(15_000));
  return (
    <NativeTabs
      tintColor={colors.ink}
      iconColor={{ default: colors.faint, selected: colors.ink }}
      labelStyle={{ default: { color: colors.faint }, selected: { color: colors.ink } }}
      backgroundColor={colors.bg}
      // iOS draws badge text in white whatever we ask: a red dark enough for it, in both themes.
      badgeBackgroundColor={TAB_BADGE.background}
      badgeTextColor={TAB_BADGE.text}
      indicatorColor={colors.sunken}
      rippleColor={colors.plate}
      labelVisibilityMode="labeled"
      // iOS 26: reading down a list, the bar folds to the current tab and comes back on the way up (the system's own).
      minimizeBehavior="onScrollDown"
      // The system tab bars give no haptic on a tab change; ours did.
      screenListeners={{ tabPress: () => haptics.selection() }}
    >
      {along && Platform.OS === "ios" ? (
        <NativeTabs.BottomAccessory>
          <WorkAlongLine lead={along.lead} others={along.others} />
        </NativeTabs.BottomAccessory>
      ) : null}
      {TABS.map((tab) => {
        const label = t(tab.label);
        const count = counts[tab.name] ?? 0;
        const badge = tabBadge(count);
        return (
          <NativeTabs.Trigger
            key={tab.name}
            name={tab.name}
            hidden={personal && tab.teamOnly === true}
            {...(tab.role ? { role: tab.role } : {})}
            accessibilityLabel={badge ? t("mobile.tabs.withCount", { label, count }) : label}
            contentStyle={{ backgroundColor: colors.bg }}
          >
            <NativeTabs.Trigger.Icon
              renderingMode="template"
              src={{
                default: <NativeTabs.Trigger.VectorIcon family={tabGlyphFamily} name={tabGlyphKey(tab.glyph, false)} />,
                selected: <NativeTabs.Trigger.VectorIcon family={tabGlyphFamily} name={tabGlyphKey(tab.glyph, true)} />,
              }}
            />
            <NativeTabs.Trigger.Label>{label}</NativeTabs.Trigger.Label>
            {badge ? <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge> : null}
          </NativeTabs.Trigger>
        );
      })}
    </NativeTabs>
  );
}

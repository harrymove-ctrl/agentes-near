import { type Href, Link } from "expo-router";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { QUICK_REACTIONS } from "./logic";
import { type MessageActionsContext, useMessageActions } from "./sheets";

/** The system's symbol beside a menu action. */
export type MenuSymbol = NonNullable<ComponentProps<typeof Link.MenuAction>["icon"]>;

/** A menu action: its words, the system's symbol beside them, and what it does. */
export interface MenuItem {
  key: string;
  label: string;
  icon?: MenuSymbol | undefined;
  destructive?: boolean | undefined;
  onPress: () => void;
}

const noop = () => {};

/**
 * The system's context menu on a message (iOS): hold it and the platform lifts the row, dims the rest and shows the
 * reactions as a palette, then the actions in groups. No tap goes anywhere: the row's own link is kept from
 * navigating, so the menu is the one thing the hold adds. Where the platform has no such menu (Android), the row
 * is handed back as it is and its long press opens the app's sheet.
 */
export function MessageMenu({
  href,
  reactions,
  onReact,
  reactLabel,
  groups,
  children,
}: {
  href: string;
  /** The quick reactions, as one palette row at the top. */
  reactions: readonly string[];
  onReact: (emoji: string) => void;
  /** The palette's name, read aloud. */
  reactLabel: string;
  /** The actions, each group divided from the next. */
  groups: MenuItem[][];
  children: ReactNode;
}) {
  if (Platform.OS !== "ios") return <>{children}</>;
  return (
    <Link href={href as Href} asChild onPress={(e) => e.preventDefault()}>
      <Link.Trigger>{children}</Link.Trigger>
      <Link.Menu>
        <Link.Menu title={reactLabel} palette inline>
          {reactions.map((emoji) => (
            <Link.MenuAction key={emoji} onPress={() => onReact(emoji)}>
              {emoji}
            </Link.MenuAction>
          ))}
        </Link.Menu>
        {groups
          .filter((g) => g.length > 0)
          .map((group) => (
            <Link.Menu key={group[0]?.key ?? ""} inline>
              {group.map((it) => (
                <Link.MenuAction
                  key={it.key}
                  {...(it.icon ? { icon: it.icon } : {})}
                  {...(it.destructive ? { destructive: true } : {})}
                  onPress={it.onPress}
                >
                  {it.label}
                </Link.MenuAction>
              ))}
            </Link.Menu>
          ))}
      </Link.Menu>
    </Link>
  );
}

/**
 * A message's row under the system's menu, with the same actions as the app's sheet (`useMessageActions`): the
 * conversation wraps each row it lets the person act on. `href` is the message's own place, never navigated to.
 */
export function MessageMenuFor({
  context,
  href,
  children,
}: {
  context: MessageActionsContext;
  href: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  // The system closes its menu by itself: nothing to close before an action.
  const { react, groups } = useMessageActions(context, noop);
  const items: MenuItem[][] = groups.map((g) =>
    g.map((a) => ({
      key: a.key,
      label: a.label,
      icon: a.symbol,
      destructive: a.danger,
      onPress: a.onPress ?? noop,
    })),
  );
  return (
    <MessageMenu
      href={href}
      reactions={QUICK_REACTIONS}
      onReact={react}
      reactLabel={t("mobile.chat.react")}
      groups={items}
    >
      {children}
    </MessageMenu>
  );
}

import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { IconButton, type IconName, Text } from "@/ui";
import { router } from "@/ui/navigation";
import type { AppHref } from "../links/logic";
import { goBack } from "../shared/parts";

/**
 * Pieces of the forms "New" opens (the "+" of the tabs), each a native form sheet: the title row, and leaving every
 * sheet to open what was just made.
 */

/** The sheet's title, centered, with close (or back to "Novo") on the left. */
export function SheetHeader({
  title,
  icon = "x",
  onPress,
}: {
  title: string;
  icon?: Extract<IconName, "x" | "back">;
  /** Instead of closing the sheet (a page inside it goes back to the one before). */
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.head}>
      <IconButton
        icon={icon}
        label={icon === "x" ? t("mobile.common.close") : t("mobile.common.back")}
        plate
        onPress={onPress ?? (() => goBack())}
      />
      <Text variant="title" style={styles.title} accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.side} />
    </View>
  );
}

/** Closes the sheets and screens over the tabs ("New" and its forms), then opens `href` (a new conversation) there. */
export function closeSheetsAndOpen(href: AppHref) {
  if (router.canDismiss()) router.dismissAll();
  setTimeout(() => router.push(href), 60);
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 50, marginBottom: 4 },
  title: { flex: 1, textAlign: "center" },
  side: { width: 40 },
});

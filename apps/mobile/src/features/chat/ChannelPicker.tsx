import { useChannels } from "@agenteschat/client";
import { channelOptions } from "@agenteschat/client/lib/channel-refs";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { Icon, OPTION_ROW, Text, useTheme } from "@/ui";
import { useOrgId } from "../shared/hooks";

/**
 * The "#" picker (the "@" picker's card): channels I can see whose name has the query (`channelOptions`), each
 * with its topic. Tapping one inserts "#name ". Nothing when none matches.
 */
export function ChannelPicker({ query, pick }: { query: string; pick: (name: string) => void }) {
  const { t } = useTranslation();
  const { colors: c, reducedMotion } = useTheme();
  const options = channelOptions(query, useChannels(useOrgId()).data ?? [], 6);
  if (options.length === 0) return null;
  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeInDown.duration(160)}
      exiting={reducedMotion ? undefined : FadeOut.duration(100)}
      accessibilityRole="list"
      accessibilityLabel={t("mobile.channelRef.list")}
      style={[
        styles.card,
        {
          backgroundColor: c.raised,
          boxShadow: `0px 0px 0px 0.5px ${c.line2}, 0px 12px 30px -12px rgba(0, 0, 0, 0.3)`,
        },
      ]}
    >
      {options.map((o, i) => (
        <Pressable
          key={o.id}
          onPress={() => pick(o.name)}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.channelRef.a11y", { name: o.name })}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
        >
          {i > 0 ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
          <Icon name={o.visibility === "private" ? "lock" : "hash"} size={MARK} color={c.muted} />
          <View style={styles.tx}>
            <Text variant="body" numberOfLines={1} style={styles.name}>
              #{o.name}
            </Text>
            {o.topic || !o.isMember ? (
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {[o.topic, o.isMember ? null : t("mobile.channelRef.notMember")].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </Animated.View>
  );
}

/** A row's inset, its mark and the gap to the name: the hairline above starts where the name does. */
const INSET = 16;
const MARK = 18;
const GAP = 12;

const styles = StyleSheet.create({
  card: { marginHorizontal: 2, marginBottom: 8, borderRadius: 20, overflow: "hidden", paddingVertical: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: GAP,
    paddingVertical: 8,
    paddingHorizontal: INSET,
    minHeight: OPTION_ROW.height,
  },
  divider: { position: "absolute", top: 0, left: INSET + MARK + GAP, right: 0, height: StyleSheet.hairlineWidth },
  tx: { flex: 1, minWidth: 0 },
  name: { fontWeight: "600" },
});

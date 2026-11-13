import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeOut, LinearTransition } from "react-native-reanimated";
import { Icon, PressScale, Text, useTheme } from "@/ui";

/** A photo or a file picked for the next message, waiting above the field until it is sent with the words. */
export interface PendingFile {
  id: string;
  uri: string;
  name: string;
  type: string;
  /** `sending` while its upload runs (the thumbnail dims), `failed` when it didn't go (it stays, to try again). */
  state: "waiting" | "sending" | "failed";
}

/** How many go in one message. */
export const MAX_PENDING = 10;

const TILE_W = 84;
const TILE_H = 100;
const RADIUS = 12;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const TILE_OUT = FadeOut.duration(120).easing(EASE_OUT);
const TILE_MOVE = LinearTransition.duration(200).easing(EASE_OUT);

const isImage = (f: PendingFile) => f.type.startsWith("image/");
const isVideo = (f: PendingFile) => f.type.startsWith("video/");

/**
 * The pictures and files waiting to go with the next message, above the field in the field's column: each a
 * thumbnail (a file, its icon and name) with an × to take it out, then a dashed tile to add another. The words
 * typed are their caption; send sends everything in one message, and a thumbnail dims while its upload runs.
 * A tile that leaves fades and the others close the gap.
 */
export function AttachmentStrip({
  files,
  onRemove,
  onAdd,
}: {
  files: PendingFile[];
  onRemove: (id: string) => void;
  /** The "+" tile: opens the same picker as the composer's "+" (absent once the message is full). */
  onAdd?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const { colors: c, shadows, reducedMotion } = useTheme();
  if (files.length === 0) return null;
  const motion = reducedMotion ? {} : { exiting: TILE_OUT, layout: TILE_MOVE };
  return (
    <Animated.ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.bleed}
      contentContainerStyle={styles.row}
    >
      {files.map((f) => (
        <Animated.View
          key={f.id}
          {...motion}
          style={[styles.tile, f.state === "sending" && styles.sending]}
          accessible
          accessibilityLabel={t(f.state === "sending" ? "mobile.chat.attach.sending" : "mobile.chat.attach.waiting", {
            name: f.name,
          })}
        >
          <View style={[styles.thumb, { backgroundColor: c.sunken, boxShadow: shadows.e1 }]}>
            {isImage(f) || isVideo(f) ? (
              <Image source={{ uri: f.uri }} contentFit="cover" transition={0} style={StyleSheet.absoluteFill} />
            ) : (
              <View style={styles.fileIn}>
                <Icon name="file" size={22} color={c.muted} />
                <Text variant="caption" tone="muted" numberOfLines={2} style={styles.fileName}>
                  {f.name}
                </Text>
              </View>
            )}
            {isVideo(f) ? (
              <View style={styles.play}>
                <Icon name="play" size={14} color="#fff" />
              </View>
            ) : null}
            {f.state === "failed" ? (
              <View style={[styles.failed, { backgroundColor: c.danger }]}>
                <Icon name="x" size={10} color="#fff" />
              </View>
            ) : null}
          </View>
          {/* 24 drawn, 44 to the finger; outside the thumbnail's corner so it never hides the picture. */}
          <Pressable
            onPress={() => onRemove(f.id)}
            disabled={f.state === "sending"}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.chat.attach.remove", { name: f.name })}
            hitSlop={10}
            style={({ pressed }) => [styles.x, { backgroundColor: c.ink }, pressed && styles.pressed]}
          >
            <Icon name="x" size={11} color={c.bg} />
          </Pressable>
        </Animated.View>
      ))}
      {onAdd ? (
        <Animated.View {...motion} style={styles.tile}>
          <PressScale
            onPress={onAdd}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.chat.attach.more")}
            style={[styles.thumb, styles.add, { borderColor: c.line2 }]}
          >
            <Icon name="plus" size={20} color={c.faint} />
          </PressScale>
        </Animated.View>
      ) : null}
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  // Out to the box's edges (the field's column starts after the "+"): the strip scrolls under them.
  bleed: { marginHorizontal: -10 },
  row: { flexDirection: "row", gap: 8, paddingLeft: 66, paddingRight: 10, paddingTop: 8, paddingBottom: 8 },
  tile: { width: TILE_W, height: TILE_H },
  thumb: { width: TILE_W, height: TILE_H, borderRadius: RADIUS, overflow: "hidden" },
  sending: { opacity: 0.5 },
  fileIn: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, padding: 8 },
  fileName: { textAlign: "center" },
  play: {
    position: "absolute",
    left: 6,
    bottom: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  failed: {
    position: "absolute",
    left: 6,
    bottom: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  x: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  add: { borderWidth: 1, borderStyle: "dashed", alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.7 },
});

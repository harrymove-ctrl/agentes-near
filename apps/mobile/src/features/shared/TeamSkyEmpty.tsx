import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Sky, Text } from "@/ui";
import { AgentFace } from "./Face";
import { useColors, useDirectory } from "./hooks";

/** How many of the team stand on the horizon. */
const FACES = 3;
/** The faces: framed in their skies, the list's small size. */
const FACE = 36;

/**
 * A list with nothing in it, right on the page (no card, no box): the pixel sky as a horizon band, a few of the team
 * on it (the right hand first), blinking as they do in the list, then one headline and one calm line, and at most
 * one quiet action under them. Threads and Atividade empty, where the subject is the agents' work. With no agent
 * yet the sky stands alone.
 */
export function TeamSkyEmpty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  /** One way out under the words (a secondary, small `Button`), or nothing. */
  action?: ReactNode;
}) {
  const dir = useDirectory();
  const lodi = rightHandOf(dir.agents);
  const ids = [...(lodi ? [lodi.id] : []), ...dir.agents.filter((a) => a.id !== lodi?.id).map((a) => a.id)].slice(
    0,
    FACES,
  );
  return (
    <View style={styles.box}>
      <View style={styles.horizon} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Sky color="sky" depth={0.7} fade={0.35} style={StyleSheet.absoluteFill} />
        <View style={styles.faces}>
          {ids.map((id) => (
            <AgentFace key={id} agentId={id} size={FACE} live />
          ))}
        </View>
      </View>
      <Text variant="title" style={styles.center} accessibilityRole="header">
        {title}
      </Text>
      <Text variant="subhead" tone="muted" style={[styles.center, styles.text]}>
        {text}
      </Text>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

/**
 * A list that didn't load, kept on the page: one gray line with what happened and "Tentar de novo" at its end. What
 * was loaded before stays readable under it; red is kept for the destructive.
 */
export function RetryLine({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <Pressable
      onPress={onRetry}
      accessibilityRole="button"
      accessibilityLabel={`${t("common.loadFailed")}. ${t("mobile.common.retry")}`}
      hitSlop={8}
      style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
    >
      <Icon name="wifi" size={16} color={c.muted} />
      <Text variant="subhead" tone="muted" style={styles.retryText}>
        {t("common.loadFailed")}
        <Text variant="subhead" tone="ink2" style={styles.retryAct}>
          {` · ${t("mobile.common.retry")}`}
        </Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { paddingTop: 16, paddingHorizontal: 16, alignItems: "center", gap: 4 },
  // The horizon band, edge to edge inside the margin: the team stands low on it, as on the home's sky.
  horizon: {
    alignSelf: "stretch",
    height: 96,
    marginBottom: 12,
    borderRadius: 20,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 14,
  },
  faces: { flexDirection: "row", gap: 10 },
  center: { textAlign: "center" },
  text: { maxWidth: 320 },
  action: { marginTop: 12 },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 24,
    marginHorizontal: 16,
    minHeight: 44,
  },
  retryText: { flexShrink: 1 },
  retryAct: { fontWeight: "600" },
  pressed: { opacity: 0.6 },
});

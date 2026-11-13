import { type StickerLook, type StickerMood, WAVE_SECONDS } from "@agenteschat/ui/agent/stickers";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { AgentAvatar } from "@/agent/AgentAvatar";
import type { AgentLookInput } from "@/agent/looks";
import { StickerCanvas } from "@/agent/StickerCanvas";
import { Sky } from "@/sky/Sky";
import { Icon, type IconName } from "./Icon";
import { SCREEN_X } from "./rhythm";
import { Text } from "./Text";
import { useTheme } from "./theme";

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  /** A window of pixel sky with a few agents on it (only where the subject is agents). */
  sky?: boolean;
  /** Without the sky: a quiet icon over the words (a search with nothing found, an empty folder). */
  icon?: IconName;
  /** One way out under the text (a `Button`), centered at its own size. */
  action?: ReactNode;
  /**
   * The room it has: `page` a whole screen, centered in it; `panel` a part of a screen; `inline` a list in a sheet,
   * compact and never with a picture. Without it, the loose block a list stands in for.
   */
  size?: "page" | "panel" | "inline";
  /** The agent standing over the words: a place's own agent's look, or `true` for the default one. */
  agent?: StickerLook | true;
  /** What the agent does. A wave plays once and holds, the other moods loop. */
  mood?: StickerMood;
}

/** The agent's side: whole multiples of the sticker's 64-cell grid at the phones' densities. */
const AGENT_SIDE = { page: 128, panel: 96 } as const;

/** The agents standing on the sky, the middle one awake. */
const SOMEONE: readonly AgentLookInput[] = [
  { color: "green", eyes: "round", id: "empty-2" },
  { color: "indigo", eyes: "round", id: "empty-1" },
  { color: "rose", eyes: "round", id: "empty-3" },
];

/**
 * Nothing here yet, in the app's language: where the subject is agents, a window of their pixel sky with a few of
 * them on it (the middle one awake, the others resting); elsewhere a quiet icon or just the words. Then the title,
 * a line of what will be here, and one way out. Loose on the page, as the lists it stands for.
 *
 * What a place is for when nothing is in it, as on the web. First use: `size` and `agent`, a title that says what the
 * place gives, one line and one primary button (none for who can't do it: the line says who can). No results: `size`
 * and a way to clear, with no agent. All clear: `agent` with a happy mood and no button. Never for loading or an error.
 */
export function EmptyState({
  title,
  subtitle,
  sky = false,
  icon,
  action,
  size,
  agent,
  mood = "wave",
}: EmptyStateProps) {
  const { colors } = useTheme();
  const inline = size === "inline";
  return (
    <View style={[styles.wrap, size === "page" && styles.page, inline && styles.inline]}>
      {agent && !inline ? (
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <StickerCanvas
            look={agent === true ? {} : agent}
            mood={mood}
            size={AGENT_SIDE[size === "panel" ? "panel" : "page"]}
            seed="empty"
            live
            {...(mood === "wave" ? { playFor: WAVE_SECONDS } : {})}
          />
        </View>
      ) : sky ? (
        <View style={styles.window}>
          <Sky color="indigo" depth={0.75} style={StyleSheet.absoluteFill} />
          <View style={styles.crew}>
            {SOMEONE.map((look, i) => (
              <AgentAvatar key={look.id} agent={look} size={i === 1 ? 48 : 38} mode={i === 1 ? "idle" : "rest"} />
            ))}
          </View>
        </View>
      ) : icon && !inline ? (
        <View style={[styles.tile, { backgroundColor: colors.sunken, borderColor: colors.line }]}>
          <Icon name={icon} size={24} color={colors.muted} />
        </View>
      ) : null}
      <Text variant={inline ? "subhead" : "title"} accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="subhead" tone="muted" style={styles.subtitle}>
          {subtitle}
        </Text>
      ) : null}
      {action ? (
        // A row sized to its content: the button keeps its own width and height (in a column it could take
        // the flex space it sits in, and its own `alignSelf` would pin it to the left edge).
        <View style={[styles.action, inline && styles.actionInline]}>{action}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Stretched to its container's width (the sky spans it), whatever the container centers.
  wrap: { alignSelf: "stretch", alignItems: "center", paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 32 },
  page: { flex: 1, justifyContent: "center", minHeight: 360 },
  inline: { paddingHorizontal: 16, paddingVertical: 12 },
  window: {
    alignSelf: "stretch",
    height: 136,
    marginBottom: 20,
    borderRadius: 20,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 14,
  },
  crew: { flexDirection: "row", alignItems: "flex-end", gap: 14 },
  tile: {
    width: 56,
    height: 56,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
    marginBottom: 16,
  },
  title: { textAlign: "center" },
  subtitle: { textAlign: "center", marginTop: 6, maxWidth: 300 },
  action: { flexDirection: "row", alignSelf: "center", marginTop: 20 },
  actionInline: { marginTop: 12 },
});

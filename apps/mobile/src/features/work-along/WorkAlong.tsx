import type { WorkItem } from "@agenteschat/client/lib/working";
import { NativeTabs } from "expo-router/native-tabs";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { PixelOrbit, Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";

/**
 * The work the line may show: a run marked waiting stays only when something of that agent really waits on me (my
 * requests, missions and questions); otherwise it waits on someone else, or the flag outlived the decision.
 */
export function alongWork(work: readonly WorkItem[], waitingOnMe: readonly { agentId: string | null }[]): WorkItem[] {
  const mine = new Set(waitingOnMe.map((w) => w.agentId).filter((id): id is string => Boolean(id)));
  return work.filter((w) => !w.waiting || mine.has(w.agentId));
}

/** A plain answer is over before it's worth a line: a run shows once it has gone on this long. */
export const ALONG_AFTER_MS = 45_000;

/**
 * The one piece of work worth carrying across tabs: what waits on you first (a request stops an agent), then the
 * newest long work (a mission, a task, a run past `ALONG_AFTER_MS`). Null when there is none, and the line goes
 * away with it, so a quick reply never makes it flash.
 */
export function workAlong(work: readonly WorkItem[], now: number): { lead: WorkItem; others: number } | null {
  const long = work.filter((w) => w.waiting || w.kind !== "run" || now - new Date(w.since).getTime() >= ALONG_AFTER_MS);
  if (long.length === 0) return null;
  const waiting = long.filter((w) => w.waiting);
  const pool = waiting.length > 0 ? waiting : long;
  const lead = [...pool].sort((a, b) => b.since.localeCompare(a.since))[0];
  return lead ? { lead, others: long.length - 1 } : null;
}

/**
 * The line that goes with you (iOS 26's tab bar accessory, the system's own glass over the tabs): who works and on
 * what, with the orbit in their tones, or "Theo espera seu ok" in amber; "+2" when more are at it. A tap opens that
 * conversation. The system draws two copies, the full line over the bar and a short one beside the folded bar
 * (`usePlacement`), so it holds no state of its own.
 */
export function WorkAlongLine({ lead, others }: { lead: WorkItem; others: number }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const dir = useDirectory();
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const agent = dir.anyAgent(lead.agentId);
  // An agent the directory doesn't know yet (just made, or gone) still reads as a sentence.
  const name = agent?.name ?? t("mobile.along.agent");
  const color = agentLook(agent).color;
  const words = lead.waiting
    ? t("mobile.along.waits", { name })
    : lead.what
      ? t("mobile.along.on", { name, what: lead.what })
      : t("mobile.along.working", { name });
  const inline = placement === "inline";
  return (
    <Pressable
      onPress={() => router.push(chatHref(lead.channelId, lead.threadId))}
      accessibilityRole="button"
      accessibilityLabel={others > 0 ? `${words}, ${t("mobile.along.more", { count: others })}` : words}
      style={({ pressed }) => [styles.row, inline && styles.inline, pressed && styles.pressed]}
    >
      <AgentFace agentId={lead.agentId} size={24} mode={lead.waiting ? "idle" : "run"} live />
      <Text
        variant="subhead"
        numberOfLines={1}
        style={[styles.words, lead.waiting ? { color: colors.amber, fontWeight: "600" } : null]}
      >
        {words}
      </Text>
      {!inline ? (
        <View style={styles.end}>
          {lead.waiting ? null : <PixelOrbit color={color} size={14} />}
          {others > 0 ? (
            <Text variant="footnote" tone="muted" style={styles.count}>
              {t("mobile.along.more", { count: others })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
  inline: { paddingHorizontal: 12, gap: 8 },
  pressed: { opacity: 0.6 },
  words: { flex: 1, minWidth: 0 },
  end: { flexDirection: "row", alignItems: "center", gap: 8 },
  count: { fontVariant: ["tabular-nums"] },
});

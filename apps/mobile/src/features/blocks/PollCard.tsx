import { useArtifact, usePoll, useVote } from "@agenteschat/client";
import { pollAnswered, pollIsOpen, pollTally, pollToggle } from "@agenteschat/client/lib/blocks";
import { joinNames } from "@agenteschat/client/lib/format";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { photoSource } from "@/lib/photo";
import { serverUrl } from "@/lib/server";
import { Icon, Sky, Text, textLineOf, useToast } from "@/ui";
import { useFontScale } from "@/ui/text-scale";
import { leadBox } from "@/ui/type-scale";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { faceOverlap } from "./logic";

const FACES = 4;

/**
 * A vote in the conversation (ADR 0113), drawn by the app and never by a page: a vote is an act of the person's.
 * Everyone sees the marks arrive (`poll.updated`).
 */
export function PollCard({ id, version }: { id: string; version?: number }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const artifact = useArtifact(orgId, id, version);
  const query = usePoll(orgId, id);
  const vote = useVote(orgId, id);
  const fontScale = useFontScale();
  // Every option keeps the widest faces' room: the bars share one scale, each its share of one track.
  const [facesWidth, setFacesWidth] = useState(0);
  const a = artifact.data;
  const poll = query.data;
  if (a?.content.kind !== "poll" || !poll) {
    return (
      <View style={[styles.card, styles.loading, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        <ActivityIndicator color={c.faint} />
        <Text variant="footnote" tone="muted">
          {t("mobile.blocks.building")}
        </Text>
      </View>
    );
  }
  const { options, multiple, question } = a.content;
  const open = pollIsOpen(poll);
  const tally = pollTally(options, poll);
  const top = Math.max(...tally.map((o) => o.voters.length));
  const nameOf = (userId: string) => dir.memberById.get(userId)?.name ?? t("mobile.blocks.someone");
  // As the face draws it: a photo it can load, else the initials.
  const hasPhoto = (userId: string | undefined) => {
    const member = userId ? dir.memberById.get(userId) : undefined;
    return photoSource(member?.avatarUrl ?? member?.image, serverUrl(), {}) !== null;
  };
  // An option's label wraps: its box, mark and faces sit on its first line, not centred on the whole option.
  const line = textLineOf("body", fontScale);
  const closes = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(poll.closesAt),
  );
  return (
    <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      <Sky
        color={agentLook(dir.agentById.get(a.createdBy.id)).color}
        surface="raised"
        depth={0.95}
        fade={0}
        style={styles.sky}
      />
      <View style={styles.head}>
        <Text variant="subhead" style={styles.bold}>
          {question}
        </Text>
        <Text variant="footnote" tone="faint">
          {open ? t("mobile.blocks.pollCloses", { time: closes }) : t("mobile.blocks.pollClosed")}
        </Text>
      </View>
      <View style={styles.options}>
        {tally.map((o) => {
          const mine = meId !== null && o.voters.includes(meId);
          const won = !open && top > 0 && o.voters.length === top;
          return (
            <Pressable
              key={o.option}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: mine, disabled: !open }}
              accessibilityLabel={`${o.label}, ${o.voters.length}${o.voters.length ? `: ${joinNames(o.voters.map(nameOf), t)}` : ""}`}
              disabled={!open || vote.isPending || !meId}
              onPress={() => {
                if (!meId) return;
                tapHaptic();
                vote.mutate(pollToggle(poll, meId, o.option, multiple), {
                  onError: () => toast({ title: t("mobile.blocks.voteFailed"), icon: "x" }),
                });
              }}
              style={[styles.option, { borderColor: c.line2 }]}
            >
              {/* The share fills the option up to its faces, never under them: their rings stay the card's face. */}
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${o.share * 100}%`, backgroundColor: c.line }]} />
                <View style={leadBox(line, 20)}>
                  <View
                    style={[
                      styles.box,
                      { borderColor: c.faint },
                      mine && { backgroundColor: c.ink, borderColor: c.ink },
                    ]}
                  >
                    {mine ? <Icon name="check" size={13} color={c.raised} /> : null}
                  </View>
                </View>
                <Text variant="body" style={[styles.label, styles.bold]}>
                  {o.label}
                </Text>
                {won ? (
                  <View style={leadBox(line, 5)}>
                    <View style={[styles.mark, { backgroundColor: c.ok }]} />
                  </View>
                ) : null}
              </View>
              <View
                style={[styles.faces, { minHeight: line.height, minWidth: facesWidth }]}
                onLayout={(e) => {
                  const width = e.nativeEvent.layout.width;
                  setFacesWidth((w) => Math.max(w, width));
                }}
              >
                {/* Each voter's face as the conversation shows it (the photo, else the initials), ringed in the
                    option's face. */}
                {o.voters.slice(0, FACES).map((v, i, shown) => (
                  <View
                    key={v}
                    style={[styles.ring, { backgroundColor: c.raised }, i > 0 && faceOverlap(hasPhoto(shown[i - 1]))]}
                  >
                    <Face who={{ type: "person", id: v }} size={20} />
                  </View>
                ))}
                {o.voters.length > FACES ? (
                  <Text variant="caption" tone="muted">
                    {` +${o.voters.length - FACES}`}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {multiple && open ? (
        <Text variant="footnote" tone="faint" style={styles.note}>
          {t("mobile.blocks.pollMultiple")}
        </Text>
      ) : null}
      <View style={[styles.foot, { borderTopColor: c.line2 }]}>
        <View style={[styles.mark, { backgroundColor: open ? c.faint : c.ok }]} />
        <Text variant="footnote" tone="muted">
          {t("mobile.blocks.pollAnswered", { count: pollAnswered(poll), total: poll.people })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // As wide as the message, under what comes before it (the files' cards keep the same gap).
  card: {
    alignSelf: "stretch",
    marginTop: 8,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
  },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 8, opacity: 0.7 },
  head: { gap: 1, paddingHorizontal: 14, paddingTop: 12 },
  bold: { fontWeight: "600" },
  options: { gap: 6, padding: 14, paddingTop: 10 },
  // Top-aligned with 12 above and below: one line is 46 tall and centred as before, a wrapping label grows down.
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderRadius: 12,
    borderBottomLeftRadius: 4,
  },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0 },
  box: {
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    borderWidth: 1.6,
    borderRadius: 6,
    borderBottomLeftRadius: 2,
  },
  label: { flex: 1, minWidth: 0 },
  // At the end of the room every option keeps for its faces.
  faces: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end" },
  // A 20 face in a 2-point ring: 24 in all, the ring's corner the face's 30% plus the 2 between them.
  ring: { padding: 2, borderRadius: 8 },
  // The box, the label and the share's fill behind them, out to the option's left edge, top to bottom.
  track: {
    flex: 1,
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    minWidth: 0,
    marginLeft: -12,
    paddingLeft: 12,
    marginVertical: -12,
    paddingVertical: 12,
  },
  note: { marginTop: -8, marginBottom: 10, paddingHorizontal: 14 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  mark: { width: 5, height: 5 },
});

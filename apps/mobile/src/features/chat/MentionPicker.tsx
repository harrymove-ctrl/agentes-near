import { keys, useAddChannelMember, useRoster } from "@agenteschat/client";
import { everyoneSuggestion } from "@agenteschat/client/lib/everyone";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { Icon, OPTION_ROW, PressScale, Text, useTheme, useToast } from "@/ui";
import { Face } from "../shared/Face";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { type MentionOption, mentionOptions, splitMatch } from "./mentions";

/**
 * Who the conversation's members are, for the "@" picker (`type:id` keys); null = no list (a DM, or not
 * a member yet): everyone counts as in.
 */
export function useMentionMembers(channelId: string, enabled: boolean): ReadonlySet<string> | null {
  const roster = useRoster(useOrgId(), channelId, enabled);
  return useMemo(
    () => (enabled && roster.data ? new Set(roster.data.map((m) => `${m.type}:${m.id}`)) : null),
    [enabled, roster.data],
  );
}

/**
 * The "@" picker: a floating card above the composer with "Neste canal" and
 * "Fora do canal", faces, the matched part underlined, "@handle · role". Tapping a row inserts "@handle ";
 * an agent outside the channel offers "Adicionar" (adds it, then inserts). Nothing when nobody matches. Its rows are
 * OptionRows, every one one size: the face 24, the name and, muted on its line, the handle and the role.
 */
export function MentionPicker({
  query,
  pick,
  channelId,
  members,
  everyone = false,
}: {
  query: string;
  pick: (handle: string) => void;
  channelId: string;
  /** The channel's members; null = no sections and no "Adicionar" (a DM). */
  members: ReadonlySet<string> | null;
  /** The person may mention everyone here (`offersEveryone`): `@todos`, in their language, comes first. */
  everyone?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { colors: c, reducedMotion } = useTheme();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const qc = useQueryClient();
  const toast = useToast();
  const add = useAddChannelMember(orgId);
  const people = useMemo(() => [...dir.memberById.values()], [dir.memberById]);
  const options = mentionOptions({ query, agents: dir.agents, people, meId, members });
  const all = everyone ? everyoneSuggestion(query, i18n.language) : null;
  if (options.length === 0 && !all) return null;

  const addAndPick = (o: MentionOption) =>
    add.mutate(
      { channelId, member: { agentId: o.id } },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: keys.roster(orgId, channelId) });
          toast({ title: t("mobile.mention.added", { name: o.name }), agentId: o.id });
          pick(o.handle);
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );

  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeInDown.duration(160)}
      exiting={reducedMotion ? undefined : FadeOut.duration(100)}
      accessibilityRole="list"
      accessibilityLabel={t("mobile.mention.list")}
      style={[
        styles.card,
        {
          backgroundColor: c.raised,
          boxShadow: `0px 0px 0px 0.5px ${c.line2}, 0px 12px 30px -12px rgba(0, 0, 0, 0.3)`,
        },
      ]}
    >
      {all ? (
        <Pressable
          onPress={() => pick(all)}
          accessibilityRole="button"
          accessibilityLabel={`@${all}, ${t("mentions.everyone")}`}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
        >
          <View style={[styles.everyone, { backgroundColor: c.sunken }]}>
            <Icon name="members" size={14} color={c.ink2} />
          </View>
          <Text variant="body" numberOfLines={1} style={styles.tx}>
            <Text variant="body" style={styles.name}>
              @{all}
            </Text>
            <Text variant="footnote" tone="muted">
              {"  "}
              {t("mentions.everyone")}
            </Text>
          </Text>
        </Pressable>
      ) : null}
      {options.map((o, i) => {
        const prev = options[i - 1];
        const heading = members && (!prev || prev.inChannel !== o.inChannel);
        const [nb, nm, na] = splitMatch(o.name, o.match?.in === "name" ? o.match : null);
        const [hb, hm, ha] = splitMatch(o.handle, o.match?.in === "handle" ? o.match : null);
        const kind = o.type === "agent" ? o.role || t("mobile.mention.agent") : t("mobile.mention.person");
        const outside = Boolean(members) && !o.inChannel && o.type === "agent";
        return (
          <Fragment key={o.key}>
            {heading ? (
              <Text variant="caption" style={[styles.heading, { color: c.faint }]}>
                {o.inChannel ? t("mobile.mention.inChannel") : t("mobile.mention.outside")}
              </Text>
            ) : null}
            <Pressable
              onPress={() => pick(o.handle)}
              accessibilityRole="button"
              accessibilityLabel={`${o.name}, @${o.handle}`}
              style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
            >
              {i > 0 && !heading ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
              <Face who={{ type: o.type, id: o.id }} size={FACE} />
              <Text variant="body" numberOfLines={1} style={styles.tx}>
                <Text variant="body" style={styles.name}>
                  {nb}
                  {nm ? <RNText style={styles.mark}>{nm}</RNText> : null}
                  {na}
                </Text>
                <Text variant="footnote" tone="muted">
                  {"  "}@{hb}
                  {hm ? <RNText style={[styles.mark, { color: c.ink }]}>{hm}</RNText> : null}
                  {ha} · {kind}
                </Text>
              </Text>
              {outside ? (
                <PressScale
                  to={0.94}
                  onPress={() => addAndPick(o)}
                  disabled={add.isPending}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile.mention.addA11y", { name: o.name })}
                  hitSlop={9}
                  style={[styles.add, { backgroundColor: c.sunken }]}
                  contentStyle={styles.addIn}
                >
                  <Text variant="footnote" style={[styles.addText, { color: c.ink2 }]}>
                    {t("mobile.mention.add")}
                  </Text>
                </PressScale>
              ) : null}
            </Pressable>
          </Fragment>
        );
      })}
    </Animated.View>
  );
}

/** A row's inset, its face and the gap to the name: the hairline above starts where the name does. */
const INSET = 14;
const FACE = OPTION_ROW.face;
const GAP = 10;

const styles = StyleSheet.create({
  card: { marginHorizontal: 2, marginBottom: 8, borderRadius: 20, overflow: "hidden", paddingBottom: 4 },
  heading: { paddingTop: 10, paddingHorizontal: INSET, paddingBottom: 4, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: GAP,
    paddingVertical: OPTION_ROW.pad,
    paddingHorizontal: INSET,
    minHeight: OPTION_ROW.height,
  },
  divider: { position: "absolute", top: 0, left: INSET + FACE + GAP, right: 0, height: StyleSheet.hairlineWidth },
  tx: { flex: 1, minWidth: 0 },
  everyone: { width: FACE, height: FACE, borderRadius: FACE / 2, alignItems: "center", justifyContent: "center" },
  name: { fontWeight: "600" },
  mark: { textDecorationLine: "underline" },
  // A button, so a rounded rectangle rather than a pill; 26 tall with 9 of slop: the 44-point target.
  add: { minHeight: 26, paddingHorizontal: 10, borderRadius: 8 },
  addIn: { alignItems: "center", justifyContent: "center" },
  addText: { fontWeight: "600" },
});

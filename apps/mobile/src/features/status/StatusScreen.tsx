import { useSetMyStatus } from "@agenteschat/client";
import {
  AVAILABILITIES,
  clearsText,
  presenceOfAvailability,
  STATUS_SUGGESTIONS,
  UNTIL_CHOICES,
} from "@agenteschat/client/lib/presence";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  fieldText,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  MEDIA_ROW,
  MediaRow,
  PresenceBadge,
  Text,
  useTheme,
  useToast,
  WithPresence,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Gap, SettingsPage } from "../settings/parts";
import { Face } from "../shared/Face";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, successHaptic, tapHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { useMyPerson } from "./hooks";
import { draftOf, inputOf, isSuggestion, lineText, STATUS_EMOJIS, type StatusDraft, type UntilPick } from "./logic";

/** A line is at most this long (the server's limit). */
const TEXT_MAX = 100;

/** Opens Status over Você. */
export const openStatus = () => router.push("/me/status");

/**
 * Status (ADR 0084), pushed from Você on the grouped gray, "Salvar" in the bar: how people see you (a preview that
 * follows the draft), the line with its emoji key and ✕, the suggestions (each fills the line, its emoji, when it
 * clears and how you appear), "Limpar depois de" (with a line), "Aparecer como" (Online, Ausente, Ocupado, Oculto)
 * and "Limpar status" when one is saved. The emoji and the end are picked in short sheets.
 */
export function StatusScreen() {
  return (
    <SheetHostProvider>
      <StatusEditor />
    </SheetHostProvider>
  );
}

function StatusEditor() {
  const { t, i18n } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const orgId = useOrgId();
  const meId = useMeId();
  const me = useMyPerson();
  const dir = useDirectory();
  const toast = useToast();
  const sheet = useSheet();
  const set = useSetMyStatus(orgId, meId ?? undefined);
  const [draft, setDraft] = useState<StatusDraft | null>(null);
  const d = draft ?? draftOf(me);
  const edit = (patch: Partial<StatusDraft>) => setDraft((prev) => ({ ...(prev ?? draftOf(me)), ...patch }));
  const language = i18n.language || "en";
  const shown = presenceOfAvailability(d.availability);
  const text = d.text.trim();
  const name = me?.name ?? (meId ? dir.memberById.get(meId)?.name : undefined) ?? "";

  // Saving goes back at once (your row changes at once, `useSetMyStatus`); the answer comes as a toast.
  const save = () => {
    if (!meId) return;
    set.mutateAsync(inputOf(d)).then(
      () => {
        successHaptic();
        toast({ title: t("presence.saved") });
      },
      () => toast({ title: t("mobile.app.failed"), icon: "x" }),
    );
    router.back();
  };
  const clear = () => {
    if (!meId) return;
    set.mutateAsync({ status: null }).then(
      () => toast({ title: t("mobile.status.cleared") }),
      () => toast({ title: t("mobile.app.failed"), icon: "x" }),
    );
    router.back();
  };

  const untilLabel = (u: UntilPick) =>
    "choice" in u ? t(`presence.until.${u.choice}`) : u.at ? clearsText(t, language, u.at) : t("presence.until.never");
  const pickedChoice = "choice" in d.until ? d.until.choice : d.until.at ? null : "never";

  const pickEmoji = () =>
    sheet.open(
      <>
        <SheetTitle title={t("presence.emoji")} />
        <View style={styles.emojis}>
          {STATUS_EMOJIS.map((e) => (
            <Pressable
              key={e}
              onPress={() => {
                tapHaptic();
                edit({ emoji: e });
                sheet.close();
              }}
              accessibilityRole="button"
              accessibilityLabel={e}
              accessibilityState={{ selected: d.emoji === e }}
              style={({ pressed }) => [styles.emojiCell, (pressed || d.emoji === e) && { backgroundColor: c.sunken }]}
            >
              <Text style={styles.emojiText}>{e}</Text>
            </Pressable>
          ))}
        </View>
        {d.emoji ? (
          <ActionList
            items={[
              {
                key: "none",
                icon: "x",
                label: t("mobile.status.noEmoji"),
                onPress: () => {
                  edit({ emoji: null });
                  sheet.close();
                },
              },
            ]}
          />
        ) : null}
      </>,
    );

  const pickUntil = () =>
    sheet.open(
      <>
        <SheetTitle title={t("presence.clearAfter")} />
        <ActionList
          items={[
            // The end the saved line already has stays offered, chosen, until another is picked.
            ...("at" in d.until && d.until.at
              ? [
                  {
                    key: "kept",
                    label: clearsText(t, language, d.until.at),
                    trailing: <Icon name="check" size={18} color={c.ink} />,
                    onPress: () => sheet.close(),
                  },
                ]
              : []),
            ...UNTIL_CHOICES.map((u) => ({
              key: u,
              label: t(`presence.until.${u}`),
              ...(pickedChoice === u ? { trailing: <Icon name="check" size={18} color={c.ink} /> } : {}),
              onPress: () => {
                edit({ until: { choice: u } });
                sheet.close();
              },
            })),
          ]}
        />
      </>,
    );

  return (
    <SettingsPage
      title={t("mobile.status.title")}
      action={{ label: t("common.save"), onPress: save, disabled: !meId || !me }}
    >
      <Gap />
      {/* How people see you, as you edit: what it is over the row, your face and name on one line, your status under. */}
      <GroupedList>
        <View style={styles.preview}>
          <Text variant="caption" tone="faint">
            {d.availability === "hidden" ? t("presence.hiddenPreview") : t("presence.howOthersSee")}
          </Text>
          <MediaRow
            face={
              <WithPresence size={MEDIA_ROW.card.face} presence={shown} ring={c.raised}>
                <Face who={meId ? { type: "person", id: meId } : null} size={MEDIA_ROW.card.face} live={false} />
              </WithPresence>
            }
            name={name}
          >
            <Text variant="small" tone="muted">
              {text ? lineText({ emoji: d.emoji, text }) : t(`presence.${shown}`)}
            </Text>
          </MediaRow>
        </View>
      </GroupedList>

      <GroupedHeader>{t("mobile.status.doing")}</GroupedHeader>
      <View style={[styles.field, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}>
        <Pressable
          onPress={pickEmoji}
          accessibilityRole="button"
          accessibilityLabel={d.emoji ? `${t("presence.emoji")}, ${d.emoji}` : t("presence.emoji")}
          style={({ pressed }) => [styles.key, { backgroundColor: c.sunken }, pressed && styles.pressed]}
        >
          {d.emoji ? <Text style={styles.keyEmoji}>{d.emoji}</Text> : <Icon name="smile" size={20} color={c.muted} />}
        </Pressable>
        <TextInput
          value={d.text}
          onChangeText={(v) => edit({ text: v })}
          placeholder={t("mobile.status.placeholder")}
          placeholderTextColor={c.faint}
          maxLength={TEXT_MAX}
          returnKeyType="done"
          autoCapitalize="sentences"
          style={[fieldText("body"), styles.input, { color: c.ink }]}
        />
        {d.text ? (
          <Pressable
            onPress={() => edit({ text: "", emoji: null, until: { choice: "never" } })}
            accessibilityRole="button"
            accessibilityLabel={t("presence.wipe")}
            hitSlop={11}
            style={({ pressed }) => [styles.wipe, { backgroundColor: c.faint }, pressed && styles.wipePressed]}
          >
            <Icon name="x" size={12} color={c.raised} />
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.chips}
        style={styles.chipsRow}
      >
        {STATUS_SUGGESTIONS.map((s) => {
          const label = t(`presence.suggest.${s.key}`);
          const on = isSuggestion(d, label, s.emoji);
          return (
            <Pressable
              key={s.key}
              onPress={() => {
                tapHaptic();
                edit({ text: label, emoji: s.emoji, until: { choice: s.until }, availability: s.availability });
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={label}
              // A 34-point suggestion: the slop makes its target 44.
              hitSlop={{ top: 5, bottom: 5 }}
              style={({ pressed }) => [
                styles.chip,
                { backgroundColor: c.raised, boxShadow: shadows.e1 },
                on && { borderColor: c.ink },
                pressed && styles.pressed,
              ]}
            >
              <Text variant="callout" tone={on ? "ink" : "ink2"} numberOfLines={1}>
                {`${s.emoji} ${label}`}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {text ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow label={t("presence.clearAfter")} value={untilLabel(d.until)} chevron onPress={pickUntil} />
          </GroupedList>
        </>
      ) : null}

      <GroupedHeader>{t("presence.appearAs")}</GroupedHeader>
      <GroupedList>
        {AVAILABILITIES.map((a) => {
          const p = presenceOfAvailability(a);
          return (
            <GroupedRow
              key={a}
              leading={
                <View style={styles.lead}>
                  <PresenceBadge presence={p} cell={1.4} ring={null} />
                </View>
              }
              label={t(`presence.${p}`)}
              sub={t(`presence.help.${a}`)}
              subLines={2}
              checked={d.availability === a}
              onPress={() => edit({ availability: a })}
            />
          );
        })}
      </GroupedList>

      {me?.status ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow label={t("presence.clearStatus")} danger onPress={clear} />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  preview: { gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 14,
    paddingVertical: 6,
    paddingLeft: 6,
    paddingRight: 12,
  },
  key: { width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  keyEmoji: { fontSize: 21, lineHeight: 26 },
  input: { flex: 1, minWidth: 0, paddingVertical: 8, paddingHorizontal: 2 },
  wipe: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", opacity: 0.55 },
  wipePressed: { opacity: 0.3 },
  // The chips run to the screen's edges under the field.
  chipsRow: { marginHorizontal: -16 },
  chips: { gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  chip: {
    minHeight: 34,
    paddingHorizontal: 13,
    borderRadius: 17,
    borderWidth: 1.5,
    borderColor: "transparent",
    justifyContent: "center",
  },
  lead: { width: 32, alignItems: "center", justifyContent: "center" },
  emojis: { flexDirection: "row", flexWrap: "wrap", gap: 4, justifyContent: "flex-start" },
  emojiCell: { width: 52, height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  emojiText: { fontSize: 28, lineHeight: 34 },
});

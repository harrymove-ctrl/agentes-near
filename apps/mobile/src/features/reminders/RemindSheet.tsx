import { ApiError, type Message, type ReminderInput, useReminderAction } from "@agenteschat/client";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, Card, Filters, Icon, IconButton, type IconName, Locked, Text, useToast } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, successHaptic, Tile, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import {
  atDayTime,
  type ClockTime,
  checkWhen,
  dayChoices,
  dayOffsetOf,
  defaultCustom,
  deviceTimezone,
  isoWithOffset,
  MINUTE_STEP,
  type ReminderPreset,
  reminderErrorKey,
  reminderPresets,
  stepTime,
} from "./logic";

const PRESET_ICON: Record<ReminderPreset, IconName> = { inHour: "clock", tonight: "moon", tomorrowMorning: "sun" };

/** "Hoje, 19:00", "Amanhã, 9:00", "sexta, 23 de out., 14:30". */
export function useWhenLabel() {
  const { t } = useTranslation();
  const when = useWhen();
  return (at: Date, now = new Date()) => {
    const time = when.time(at.toISOString());
    const days = dayOffsetOf(at, now);
    if (days === 0) return t("mobile.remind.todayAt", { time });
    if (days === 1) return t("mobile.remind.tomorrowAt", { time });
    const day = new Intl.DateTimeFormat(when.locale, { weekday: "long", day: "numeric", month: "short" }).format(at);
    return t("mobile.remind.dayAt", { day, time });
  };
}

/**
 * "Lembrar": what (a message, or a line of text from the composer) and when
 * (a quick time, or a day and time picked here). An agent of the
 * conversation posts the reminder where it was asked.
 */
export function RemindSheet({
  channelId,
  threadId,
  message,
  initialText = "",
}: {
  channelId: string;
  /** The thread on screen (the reminder lands there). */
  threadId: string | null;
  /** "Lembrar disso" on a message: its text is what to remember. */
  message?: Message | null;
  initialText?: string;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const surface = useSurface();
  const whenLabel = useWhenLabel();
  const { locale } = useWhen();
  const action = useReminderAction(orgId);
  const [text, setText] = useState(initialText);
  const [custom, setCustom] = useState<{ dayOffset: number; time: ClockTime } | null>(null);
  // The quick times and the days are fixed while the sheet is open.
  const now = useMemo(() => new Date(), []);
  const presets = useMemo(() => reminderPresets(now), [now]);
  const days = useMemo(() => dayChoices(now, 7), [now]);
  // A message with no text of its own (a request card) still needs a line to remember.
  const needsText = !message || !previewOf(message.body);
  const ready = !needsText || text.trim().length > 0;

  const submit = (at: Date) => {
    if (!ready || action.isPending) return;
    const check = checkWhen(at, new Date());
    if (check !== "ok") {
      toast({ title: t(`mobile.remind.error.${check}`), icon: "x" });
      return;
    }
    const timezone = deviceTimezone();
    const input: ReminderInput = {
      channelId,
      at: isoWithOffset(at),
      ...(threadId ? { threadId } : {}),
      ...(message ? { messageId: message.id } : {}),
      ...(text.trim() ? { text: text.trim() } : {}),
      ...(timezone ? { timezone } : {}),
    };
    action.mutate(
      { type: "create", input },
      {
        onSuccess: () => {
          sheet.close();
          successHaptic();
          toast({ title: t("mobile.remind.done"), subtitle: whenLabel(at), icon: "clock" });
        },
        onError: (e) => {
          const key = reminderErrorKey(e instanceof ApiError ? e.code : null);
          toast({ title: t(`mobile.remind.error.${key}`), icon: "x" });
        },
      },
    );
  };

  const customAt = custom ? atDayTime(days[custom.dayOffset] ?? now, custom.time) : null;
  const customCheck = customAt ? checkWhen(customAt, new Date()) : "ok";
  const moveTime = (minutes: number) => setCustom((cur) => (cur ? { ...cur, time: stepTime(cur.time, minutes) } : cur));

  return (
    <>
      <SheetTitle leading={<Tile icon="clock" />} title={t("mobile.remind.title")} subtitle={t("mobile.remind.sub")} />
      {message ? (
        <View style={[styles.preview, surface]}>
          <Face who={message.author} size={24} live={false} />
          <Text variant="small" tone="ink2" numberOfLines={3} style={styles.grow}>
            {previewOf(textOrMedia(t, message.body, message.meta)) || t("mobile.chat.approvalPreview")}
          </Text>
        </View>
      ) : null}
      {needsText ? (
        <Locked when={action.isPending}>
          <TextArea
            value={text}
            onChangeText={setText}
            placeholder={t("mobile.remind.placeholder")}
            accessibilityLabel={t("mobile.remind.what")}
            minHeight={64}
            autoFocus={!initialText}
          />
        </Locked>
      ) : null}
      {custom === null ? (
        <ActionList
          items={[
            ...presets.map(({ preset, at }) => ({
              key: preset,
              icon: PRESET_ICON[preset],
              label: t(`mobile.remind.preset.${preset}`),
              hint: whenLabel(at, now),
              disabled: !ready || action.isPending,
              onPress: () => submit(at),
            })),
            {
              key: "custom",
              icon: "pen" as const,
              label: t("mobile.remind.custom"),
              trailing: <Icon name="right" size={18} color={c.faint} />,
              disabled: !ready,
              onPress: () => setCustom(defaultCustom(now)),
            },
          ]}
        />
      ) : (
        <>
          <Locked when={action.isPending} style={styles.custom}>
            <Filters
              items={days.map((d, i) => ({
                key: String(i),
                label:
                  i === 0
                    ? t("mobile.time.today")
                    : i === 1
                      ? t("mobile.remind.tomorrow")
                      : new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric" })
                          .format(d)
                          .replace(".", ""),
              }))}
              value={String(custom.dayOffset)}
              onChange={(key) => setCustom((cur) => (cur ? { ...cur, dayOffset: Number(key) } : cur))}
            />
            <Card>
              <View style={styles.clock}>
                <Stepper
                  value={String(custom.time.hour).padStart(2, "0")}
                  label={t("mobile.remind.hour")}
                  lessLabel={t("mobile.remind.hourLess")}
                  moreLabel={t("mobile.remind.hourMore")}
                  onLess={() => moveTime(-60)}
                  onMore={() => moveTime(60)}
                />
                <Text variant="display" tone="faint">
                  :
                </Text>
                <Stepper
                  value={String(custom.time.minute).padStart(2, "0")}
                  label={t("mobile.remind.minute")}
                  lessLabel={t("mobile.remind.minuteLess", { n: MINUTE_STEP })}
                  moreLabel={t("mobile.remind.minuteMore", { n: MINUTE_STEP })}
                  onLess={() => moveTime(-MINUTE_STEP)}
                  onMore={() => moveTime(MINUTE_STEP)}
                />
              </View>
            </Card>
          </Locked>
          <Text variant="small" tone={customCheck === "ok" ? "muted" : "danger"} style={styles.center}>
            {customAt
              ? customCheck === "ok"
                ? whenLabel(customAt, now)
                : t(`mobile.remind.error.${customCheck}`)
              : ""}
          </Text>
          <Button
            variant="primary"
            wide
            icon="clock"
            label={t("mobile.remind.submit")}
            loading={action.isPending}
            disabled={!ready || !customAt || customCheck !== "ok"}
            onPress={() => {
              if (customAt) submit(customAt);
            }}
          />
          <Button
            variant="ghost"
            wide
            label={t("mobile.remind.quick")}
            disabled={action.isPending}
            onPress={() => setCustom(null)}
          />
        </>
      )}
    </>
  );
}

/** "‹ 14 ›": a number with a step down and up (our buttons, no native picker). */
function Stepper({
  value,
  label,
  lessLabel,
  moreLabel,
  onLess,
  onMore,
}: {
  value: string;
  label: string;
  lessLabel: string;
  moreLabel: string;
  onLess: () => void;
  onMore: () => void;
}) {
  return (
    <View style={styles.stepper}>
      <IconButton icon="back" label={lessLabel} onPress={onLess} />
      <Text
        variant="display"
        style={styles.digits}
        accessibilityLabel={`${label} ${value}`}
        accessibilityLiveRegion="polite"
      >
        {value}
      </Text>
      <IconButton icon="right" label={moreLabel} onPress={onMore} />
    </View>
  );
}

const styles = StyleSheet.create({
  custom: { gap: 12 },
  grow: { flex: 1 },
  center: { textAlign: "center" },
  preview: { flexDirection: "row", gap: 10, padding: 12, borderRadius: 18 },
  clock: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 12 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 2 },
  digits: { minWidth: 48, textAlign: "center", fontVariant: ["tabular-nums"] },
});

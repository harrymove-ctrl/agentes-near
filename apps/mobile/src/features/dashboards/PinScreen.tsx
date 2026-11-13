import { useDashboards, useHomeDashboard, usePinWidget, type WidgetSchedule } from "@agenteschat/client";
import { chartBlockToWidgetSpec, sizeToLayout, type WidgetSize } from "@agenteschat/ui/widgets/spec";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked, Text, useTheme, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { useAgentLook } from "./hooks";
import { destinationsOf, HOME, pinDraftNow, realBoardId, sizeFor } from "./logic";
import { ChoiceChips, ScheduleChoice, SizeChoice } from "./parts";
import { WidgetCard } from "./WidgetView";

/**
 * "Pin to a dashboard", pushed from a message's actions (ADR 0135): the chart as a widget (which one, when the message
 * has several), whether its agent keeps it updated and how often (or "just pin" as it is), and where it goes. "Pin"
 * in the bar. The message's charts come from the actions (`setPinDraft`): a route can't carry them.
 */
export function PinScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const [draft] = useState(pinDraftNow);
  const look = useAgentLook(draft?.agentId);
  const list = useDashboards(orgId);
  const pin = usePinWidget(orgId);
  const [index, setIndex] = useState(0);
  const [keep, setKeep] = useState(false);
  // Null until the person picks one: the size follows the chart's kind (S for a number, M otherwise).
  const [size, setSize] = useState<WidgetSize | null>(null);
  const [schedule, setSchedule] = useState<WidgetSchedule>("day");
  const [dest, setDest] = useState(HOME);
  const block = draft?.blocks[index] ?? null;
  const chart = block ? chartBlockToWidgetSpec(block) : null;
  const sized = sizeFor(chart?.spec.kind ?? "bars", size);
  const destinations = destinationsOf(list.data);
  const destination = destinations.find((d) => d.id === dest) ?? (list.data ? destinations[0] : undefined);
  const home = useHomeDashboard(orgId, destination?.id === HOME);
  const target = destination ? realBoardId(destination.id, home.data?.id) : null;
  const where = destination?.home ? t("dashboards.home") : (destination?.title ?? "");
  const ready = Boolean(draft && block && chart && target) && !pin.isPending;
  const submit = () => {
    if (!ready || !draft || !block || !target) return;
    const every: WidgetSchedule = keep ? schedule : "manual";
    pin.mutate(
      { dashboardId: target, messageId: draft.messageId, block, schedule: every, size: sized },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title:
              every === "manual"
                ? t("widgets.pin.done", { where })
                : t("widgets.pin.doneUpdating", {
                    where,
                    name: look.name,
                    schedule: t(`widgets.schedulesInline.${every}`),
                  }),
          });
          goBack();
        },
        onError: failed,
      },
    );
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("widgets.pin.label")}
        solid={false}
        grouped
        action={{ label: t("dashboards.newWidget.pin"), disabled: !ready, onPress: submit }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        <Locked when={pin.isPending}>
          {draft && chart ? (
            <>
              <View style={styles.preview}>
                <WidgetCard
                  big
                  widget={{
                    title: chart.title,
                    spec: chart.spec,
                    status: "ok",
                    agentId: draft.agentId,
                    refreshedAt: null,
                    schedule: keep ? schedule : "manual",
                    ...sizeToLayout(sized),
                  }}
                  footer={null}
                />
              </View>
              {draft.blocks.length > 1 ? (
                <>
                  <GroupedHeader>{t("mobile.dashboards.pin.which")}</GroupedHeader>
                  <View style={styles.bleed}>
                    <ChoiceChips
                      items={draft.blocks.map((b, i) => ({
                        key: String(i),
                        label: chartBlockToWidgetSpec(b)?.title ?? String(i + 1),
                      }))}
                      value={String(index)}
                      onChange={(k) => setIndex(Number(k))}
                    />
                  </View>
                </>
              ) : null}

              <GroupedHeader>{t("widgets.sizes.label")}</GroupedHeader>
              <SizeChoice value={sized} onChange={setSize} />

              <View style={styles.gap} />
              <GroupedList>
                <GroupedRow
                  icon="clock"
                  label={t("dashboards.newWidget.keepUpdated")}
                  sub={keep ? t("dashboards.newWidget.steps.redoesHint") : t("dashboards.newWidget.onlyPin")}
                  toggle={keep}
                  onPress={() => setKeep((v) => !v)}
                />
              </GroupedList>
              {keep ? (
                <>
                  <View style={styles.gap} />
                  <View style={styles.bleed}>
                    <ScheduleChoice value={schedule} onChange={setSchedule} without="manual" />
                  </View>
                  <GroupedFooter>
                    {t("dashboards.newWidget.steps.redoes", {
                      name: look.name,
                      schedule: t(`widgets.schedulesInline.${schedule}`),
                    })}
                  </GroupedFooter>
                </>
              ) : null}

              <GroupedHeader>{t("dashboards.newWidget.destination")}</GroupedHeader>
              <GroupedList>
                {destinations.map((d) => (
                  <GroupedRow
                    key={d.id}
                    icon={d.home ? "home" : "chart"}
                    label={d.home ? t("dashboards.home") : (d.title ?? "")}
                    checked={d.id === destination?.id}
                    onPress={() => setDest(d.id)}
                  />
                ))}
              </GroupedList>
            </>
          ) : (
            <Text tone="muted" style={styles.gone}>
              {t("dashboards.errors.blockNotFound")}
            </Text>
          )}
        </Locked>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  preview: { paddingTop: 4 },
  bleed: { marginHorizontal: -16 },
  gap: { height: 14 },
  gone: { textAlign: "center", paddingTop: 48, paddingHorizontal: 16 },
});

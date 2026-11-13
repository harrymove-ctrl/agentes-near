import {
  useConfirmWidget,
  useDashboards,
  useHomeDashboard,
  useRemoveWidget,
  useTestWidget,
  useWidgetDraft,
  useWidgetSuggestions,
  WIDGET_STILL_MS,
  type Widget,
  type WidgetFormat,
  type WidgetSchedule,
  type WidgetSuggestion,
  widgetStepWords,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { taskClock } from "@agenteschat/client/lib/task-manager";
import {
  sizeToLayout,
  WIDGET_FORMATS,
  WIDGET_LIMITS,
  WIDGET_SCHEDULES,
  WIDGET_SIZES,
  type WidgetSize,
} from "@agenteschat/ui/widgets/spec";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  fieldText,
  GroupedFooter,
  GroupedList,
  GroupedRow,
  Icon,
  LIST_TIME,
  LineIcon,
  Locked,
  PressScale,
  systemText,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { boardHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useDirectory, useNow, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic, tapHaptic } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { closeAgentPick, openAgentPick } from "./agent-pick";
import { useAgentLook, useWidgetWords } from "./hooks";
import {
  asksInCard,
  confirmTitle,
  destinationsOf,
  HOME,
  newWidgetBarLabel,
  previewKind,
  realBoardId,
  sizeFor,
  testKeyOf,
  testPhase,
} from "./logic";
import { type PickItem, usePickMenu } from "./menu";
import { KindGlyph } from "./parts";
import { BuildingSweep, WidgetBody, WidgetCard } from "./WidgetView";

/** The longest ask and alert condition the server takes (ADR 0135). */
const PROMPT_MAX = 2000;
const CONDITION_MAX = 200;

/**
 * "New widget", pushed (never a sheet; ADR 0135). The card is the form: the ask is typed inside the card, with the
 * agent's suggestions under it while it is empty; the card's header holds its title, a bell that turns the alert on
 * (and its condition, in the card) and the size; its footer says who looks after it (a pushed screen to change) and
 * how often it updates (a pick menu). "Test" in the bar has the agent build a draft with real data in place; then the
 * ask folds into one line that opens it again, and "Create" confirms the draft. While it builds the card says the step
 * its agent is in and for how long, and Stop ends the build with the ask as it was typed. Changing the ask, the agent or the
 * format after a test marks it stale (Test again); a failed test says why, with Try again. Where it goes sits under the
 * card. Testing again or leaving deletes the draft. `dashboardId`: the board it starts on (`home` for My Home).
 */
export function NewWidgetScreen({ dashboardId }: { dashboardId: string }) {
  return (
    <SheetHostProvider>
      <NewWidget dashboardId={dashboardId} />
    </SheetHostProvider>
  );
}

function NewWidget({ dashboardId }: { dashboardId: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const widgetWords = useWidgetWords();
  const pick = usePickMenu();
  const list = useDashboards(orgId);
  const test = useTestWidget(orgId);
  const confirm = useConfirmWidget(orgId);
  const remove = useRemoveWidget(orgId);
  const agents = useMemo(() => dir.agents.filter((a) => canTalk(a)), [dir.agents]);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<WidgetSuggestion | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [format, setFormat] = useState<WidgetFormat>("auto");
  // Null until the person picks one: the size follows the kind (S for a number or a goal, M otherwise).
  const [size, setSize] = useState<WidgetSize | null>(null);
  const [schedule, setSchedule] = useState<WidgetSchedule>("hour");
  const [alert, setAlert] = useState(false);
  const [condition, setCondition] = useState("");
  const [dest, setDest] = useState(dashboardId);
  const [pickDest, setPickDest] = useState(false);
  // The test: the draft it made (as it came back, until its live view loads), and what it was asked with.
  const [tested, setTested] = useState<{ widget: Widget; key: string } | null>(null);
  // The person's title; null keeps the agent's (it names the draft when the test is done).
  const [title, setTitle] = useState<string | null>(null);
  // The ask opened again after a test (its folded line tapped).
  const [editing, setEditing] = useState(false);
  // A test being sent, and when the build under way started.
  const [sending, setSending] = useState(false);
  const [since, setSince] = useState(0);
  // The first agent until the person picks one.
  useEffect(() => {
    const first = agents[0];
    if (!agentId && first) setAgentId(first.id);
  }, [agentId, agents]);

  // A draft nobody confirmed goes away with the screen (the server also sweeps old ones).
  const removeDraft = useRef(remove.mutate);
  useLayoutEffect(() => {
    removeDraft.current = remove.mutate;
  });
  // `run`: which test the screen waits for (one stopped before its draft came back is dropped when it does).
  const live = useRef({ draftId: null as string | null, confirmed: false, gone: false, run: 0 });
  useEffect(() => {
    live.current.gone = false;
    return () => {
      live.current.gone = true;
      closeAgentPick();
      const id = live.current.draftId;
      if (id && !live.current.confirmed) {
        live.current.draftId = null;
        removeDraft.current(id);
      }
    };
  }, []);

  const look = useAgentLook(agentId);
  const suggestions = useWidgetSuggestions(orgId, agentId);
  const destinations = destinationsOf(list.data);
  // A board asked for is only known once the list is: never fall back to My Home before it is.
  const destination = destinations.find((d) => d.id === dest) ?? (list.data ? destinations[0] : undefined);
  const home = useHomeDashboard(orgId, destination?.id === HOME);
  const target = destination ? realBoardId(destination.id, home.data?.id) : null;
  const where = destination?.home ? t("dashboards.home") : (destination?.title ?? "");

  const draftQ = useWidgetDraft(orgId, tested?.widget.id ?? null);
  // A draft that is gone (swept, or removed elsewhere) is no test any more.
  const draft: Widget | null = tested && !draftQ.isError ? (draftQ.data ?? tested.widget) : null;
  const currentKey = testKeyOf(text, agentId, format);
  const phase = testPhase({ pending: sending, draft, testedKey: tested?.key ?? null, currentKey });
  const barLabel = newWidgetBarLabel(phase);
  const asking = asksInCard(phase, editing);
  // Once tested, the size follows what the agent built (unless one was picked).
  const kind = phase === "ok" && draft?.kind ? draft.kind : previewKind(format, picked?.kind ?? null);
  const sized = sizeFor(kind, size);
  const layout = sizeToLayout(sized);
  const asked = Boolean(text.trim() && agentId && target);
  const busy = sending || confirm.isPending;
  const ready = asked && !busy && phase !== "testing";

  const pickAgent = (id: string) => {
    if (id === agentId) return;
    setAgentId(id);
    setPicked(null);
  };
  // The agent's screen sends its choice back through this (the latest closure).
  const applyAgent = useRef(pickAgent);
  useLayoutEffect(() => {
    applyAgent.current = pickAgent;
  });
  const suggest = (s: WidgetSuggestion) => {
    setText(s.prompt || s.title);
    setPicked(s);
    setFormat("auto");
    if (s.alert) {
      setAlert(true);
      setCondition(s.alert);
    }
  };
  const type = (next: string) => {
    setText(next);
    if (picked && next !== (picked.prompt || picked.title)) setPicked(null);
  };
  const alertInput = { enabled: alert, condition: alert ? condition.trim() : "" };

  /** Test (and Test again, Try again): the previous draft goes, a new one is built with real data in the card. */
  const runTest = () => {
    if (!asked || !agentId || !target || busy) return;
    const previous = live.current.draftId;
    if (previous) removeDraft.current(previous);
    live.current.draftId = null;
    setTested(null);
    setEditing(false);
    const key = currentKey;
    live.current.run += 1;
    const mine = live.current.run;
    setSending(true);
    setSince(Date.now());
    test
      .mutateAsync({
        dashboardId: target,
        agentId,
        prompt: text.trim(),
        format,
        schedule,
        alert: alertInput,
        size: sized,
      })
      .then((widget) => {
        // Left or stopped while it was starting: nobody will confirm it.
        if (live.current.gone || live.current.run !== mine) {
          removeDraft.current(widget.id);
          return;
        }
        live.current.draftId = widget.id;
        setTested({ widget, key });
        setSending(false);
      })
      .catch((error: unknown) => {
        if (live.current.gone || live.current.run !== mine) return;
        setSending(false);
        failed(error);
      });
  };

  /** Stop: the build ends (its draft goes, and its run with it) and the ask is back as it was typed. */
  const stop = () => {
    live.current.run += 1;
    const building = live.current.draftId;
    live.current.draftId = null;
    if (building) removeDraft.current(building);
    setSending(false);
    setTested(null);
  };

  /** Create: the tested draft goes on the board with the size, schedule, alert and title picked now. */
  const create = () => {
    if (phase !== "ok" || !draft || !target || busy) return;
    const name = confirmTitle(title, draft.title);
    live.current.confirmed = true;
    confirm.mutate(
      {
        widgetId: draft.id,
        dashboardId: target,
        size: sized,
        schedule,
        alert: alertInput,
        ...(name ? { title: name } : {}),
      },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("dashboards.newWidget.created", { where }), agentId: draft.agentId });
          // From the board it goes on: back to it; else to that board.
          if (destination && destination.id === dashboardId) goBack();
          else router.replace(boardHref(destination?.id));
        },
        onError: (error) => {
          live.current.confirmed = false;
          failed(error);
        },
      },
    );
  };

  /** "Who looks after it": its own screen, pushed (the choice comes back through `agent-pick`). */
  const openAgents = () => {
    if (agents.length === 0) return;
    openAgentPick({ agentId, apply: (id) => applyAgent.current(id) });
    router.push("/agent-pick");
  };
  const openFormats = () =>
    pick(
      t("dashboards.newWidget.format"),
      WIDGET_FORMATS.map(
        (f): PickItem<WidgetFormat> => ({
          key: f,
          label: t(`widgets.kinds.${f}`),
          hint:
            f === "auto"
              ? t("mobile.dashboards.formatAuto", { name: look.name })
              : t(`dashboards.newWidget.formatHints.${f}`),
          leading: <KindGlyph kind={f} size={20} color={c.muted} />,
        }),
      ),
      format,
      setFormat,
    );
  // How often: the schedules' words only (what it spends is not this menu's business).
  const openSchedules = () =>
    pick(
      t("dashboards.newWidget.updates"),
      WIDGET_SCHEDULES.map(
        (s): PickItem<WidgetSchedule> => ({
          key: s,
          label: t(`widgets.schedules.${s}`),
          leading: <Icon name="clock" size={18} color={c.muted} />,
        }),
      ),
      schedule,
      setSchedule,
    );

  const suggestionList = suggestions.data?.suggestions ?? [];
  const formatWord = format === "auto" ? t("mobile.dashboards.newWidget.autoFormat") : t(`widgets.kinds.${format}`);
  const formatPick = (
    <Pressable
      onPress={openFormats}
      disabled={phase === "testing"}
      accessibilityRole="button"
      accessibilityLabel={`${t("dashboards.newWidget.format")}: ${formatWord}`}
      hitSlop={8}
      style={({ pressed }) => [styles.pickBox, { borderColor: c.line2 }, pressed && styles.pressed]}
    >
      <KindGlyph kind={format} size={13} color={c.muted} />
      <Text variant="footnote" numberOfLines={1} style={[styles.semibold, { color: c.ink2 }]}>
        {formatWord}
      </Text>
      <Icon name="down" size={13} color={c.muted} />
    </Pressable>
  );

  // ── The card's header: the agent's face, the title, the check of a good test, the bell and the size.
  const titleValue = title ?? draft?.title ?? "";
  const head = (
    <Locked when={busy} style={styles.head}>
      {agentId ? <AgentFace agentId={agentId} size={16} live={false} /> : null}
      <TextInput
        value={titleValue}
        onChangeText={setTitle}
        placeholder={
          draft
            ? t("mobile.dashboards.widget.titlePlaceholder")
            : t("mobile.dashboards.newWidget.titleHint", { name: look.name })
        }
        placeholderTextColor={c.faint}
        accessibilityLabel={t("mobile.dashboards.widget.title")}
        maxLength={WIDGET_LIMITS.title}
        returnKeyType="done"
        style={[styles.titleInput, { color: c.ink2 }]}
      />
      {phase === "ok" ? (
        <View
          style={[styles.okBadge, { backgroundColor: c.plate }]}
          accessible
          accessibilityLabel={t("mobile.dashboards.newWidget.realData")}
        >
          <Icon name="check" size={13} color={c.ink2} />
        </View>
      ) : null}
      <Pressable
        onPress={() => {
          tapHaptic();
          setAlert((v) => !v);
        }}
        accessibilityRole="switch"
        accessibilityLabel={t("widgets.alert.label")}
        accessibilityState={{ checked: alert }}
        hitSlop={8}
        style={({ pressed }) => [styles.bell, alert ? { backgroundColor: c.plate } : null, pressed && styles.pressed]}
      >
        <Icon name="bell" size={16} color={alert ? c.ink : c.muted} />
        {alert ? (
          <Text variant="caption" style={[styles.semibold, { color: c.ink }]}>
            {t("mobile.dashboards.newWidget.alerts")}
          </Text>
        ) : null}
      </Pressable>
      <View style={[styles.sizes, { backgroundColor: c.sunken }]} accessibilityRole="radiogroup">
        {WIDGET_SIZES.map((s) => {
          const on = s === sized;
          return (
            <Pressable
              key={s}
              onPress={() => setSize(s)}
              accessibilityRole="radio"
              accessibilityLabel={`${t("widgets.sizes.label")}: ${t(`widgets.sizes.${s}`)}`}
              accessibilityHint={t(`mobile.dashboards.sizeHint.${s}`)}
              accessibilityState={{ selected: on }}
              // 44 tall to the finger; across, the segments touch.
              hitSlop={{ top: 10, bottom: 10 }}
              style={({ pressed }) => [
                styles.size,
                on ? { backgroundColor: c.raised } : null,
                pressed && styles.pressed,
              ]}
            >
              <Text variant="caption" style={[styles.semibold, { color: on ? c.ink : c.muted }]}>
                {t(`widgets.sizes.${s}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Locked>
  );

  // ── Between the header and the data, after a test: the ask folded into a line, and the format.
  const above = asking ? null : (
    <Locked when={busy} style={styles.gap8}>
      <View style={styles.askedRow}>
        <Pressable
          onPress={() => setEditing(true)}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.dashboards.newWidget.editAsk")}
          accessibilityHint={text.trim()}
          disabled={phase === "testing"}
          style={({ pressed }) => [styles.asked, pressed && styles.pressed]}
        >
          <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
            {t("mobile.dashboards.newWidget.asked", { ask: text.trim() })}
          </Text>
          <Icon name="pen" size={13} color={c.muted} />
        </Pressable>
        {formatPick}
      </View>
      {phase === "stale" ? (
        <Text variant="caption" style={[styles.semibold, { color: c.warn }]}>
          {t("dashboards.newWidget.stale")}
        </Text>
      ) : null}
    </Locked>
  );

  // ── The data's place: the ask while typing it, the build, the failure, or the draft (the card's own drawing).
  let body: ReactNode;
  if (asking) {
    body = (
      <Locked when={busy} style={styles.gap10}>
        <TextInput
          value={text}
          onChangeText={type}
          multiline
          textAlignVertical="top"
          placeholder={t("dashboards.newWidget.what")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("dashboards.newWidget.what")}
          accessibilityHint={t("dashboards.newWidget.whatPlaceholder")}
          maxLength={PROMPT_MAX}
          autoFocus={editing}
          style={[styles.ask, { color: c.ink }]}
        />
        {!text.trim() && phase === "untested" && suggestionList.length > 0 ? (
          <View style={styles.suggestions}>
            {suggestionList.map((s) => (
              <PressScale
                key={s.title}
                onPress={() => suggest(s)}
                accessibilityRole="button"
                fill={false}
                style={styles.suggestionWrap}
                contentStyle={[styles.suggestion, { backgroundColor: c.chip }]}
              >
                <KindGlyph kind={s.kind} size={13} color={c.muted} />
                <Text variant="footnote" numberOfLines={1} style={[styles.semibold, { color: c.ink2 }]}>
                  {s.title}
                </Text>
              </PressScale>
            ))}
          </View>
        ) : null}
        <View style={styles.formatRow}>{formatPick}</View>
        {editing && draft?.spec ? (
          <View style={phase === "stale" ? styles.staleData : null}>
            <WidgetBody spec={draft.spec} status={draft.status} agentId={draft.agentId} big={sized === "l"} />
          </View>
        ) : null}
      </Locked>
    );
  } else if (phase === "testing") {
    body = (
      <View style={styles.gap10}>
        <BuildingSweep color={look.color} text={widgetStepWords(t, draftQ.data?.step)} height={44} />
        <BuildClock since={since} onStop={stop} />
      </View>
    );
  } else if (phase === "failed" && draft) {
    body = (
      <View style={styles.failed}>
        <View style={styles.failedLine}>
          {/* On the reason's first line (at the row's top it sat above the letters). */}
          <LineIcon variant="footnote" name="info" size={16} color={c.warn} />
          <Text variant="footnote" style={[styles.grow, { color: c.warn }]}>
            {t("dashboards.newWidget.testFailed", { reason: widgetWords.failure(draft) })}
          </Text>
        </View>
        <Button size="sm" variant="secondary" label={t("dashboards.newWidget.tryAgain")} onPress={runTest} />
      </View>
    );
  } else if (phase === "stale" && draft?.spec) {
    body = (
      <View style={styles.staleData}>
        <WidgetBody spec={draft.spec} status={draft.status} agentId={draft.agentId} big={sized === "l"} />
      </View>
    );
  }
  // Else (a good test): undefined, so the card draws the draft itself (its trend edge to edge).

  // ── The footer: the alert's condition when the bell is on, then who looks after it and how often.
  const footer = (
    <Locked when={busy} style={styles.gap10}>
      {alert ? (
        <View style={[styles.condition, { backgroundColor: c.sunken }]}>
          <Icon name="bell" size={13} color={c.muted} />
          <Text variant="footnote" tone="muted" style={styles.semibold}>
            {t("widgets.alert.condition")}
          </Text>
          <TextInput
            value={condition}
            onChangeText={setCondition}
            placeholder={t("widgets.alert.placeholder")}
            placeholderTextColor={c.faint}
            accessibilityLabel={t("widgets.alert.condition")}
            accessibilityHint={t("widgets.alert.hint")}
            maxLength={CONDITION_MAX}
            returnKeyType="done"
            style={[styles.conditionInput, { color: c.ink }]}
          />
        </View>
      ) : null}
      <View style={styles.foot}>
        <Pressable
          onPress={openAgents}
          disabled={agents.length === 0 || phase === "testing"}
          accessibilityRole="button"
          accessibilityLabel={`${t("dashboards.newWidget.who")}: ${look.name}`}
          hitSlop={FOOT_SLOP}
          style={({ pressed }) => [styles.footPick, pressed && styles.pressed]}
        >
          <Text variant="footnote" numberOfLines={1} style={[styles.semibold, { color: c.ink2 }]}>
            {look.name || t("dashboards.newWidget.theAgent")}
          </Text>
          <Icon name="down" size={13} color={c.muted} />
        </Pressable>
        <Text variant="footnote" tone="faint">
          {"·"}
        </Text>
        <Pressable
          onPress={openSchedules}
          accessibilityRole="button"
          accessibilityLabel={`${t("dashboards.newWidget.updates")}: ${t(`widgets.schedules.${schedule}`)}`}
          hitSlop={FOOT_SLOP}
          style={({ pressed }) => [styles.footPick, styles.shrink, pressed && styles.pressed]}
        >
          <Icon name="clock" size={13} color={c.muted} />
          <Text variant="footnote" numberOfLines={1} style={[styles.shrink, { color: c.ink2 }]}>
            {t(`widgets.schedulesInline.${schedule}`)}
          </Text>
          <Icon name="down" size={13} color={c.muted} />
        </Pressable>
      </View>
    </Locked>
  );

  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("dashboards.newWidget.title")}
        solid={false}
        grouped
        action={
          barLabel === "create"
            ? { label: t("mobile.dashboards.create"), disabled: busy || !target, onPress: create }
            : { label: t(`dashboards.newWidget.${barLabel}`), disabled: !ready, onPress: runTest }
        }
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        <WidgetCard
          big={sized === "l"}
          widget={{
            title: titleValue,
            kind: draft?.kind ?? kind,
            spec: draft?.spec ?? null,
            status: draft?.status ?? "ok",
            agentId: agentId ?? "",
            refreshedAt: draft?.refreshedAt ?? null,
            schedule,
            w: 2,
            h: layout.h,
          }}
          head={head}
          above={above}
          body={body}
          footer={footer}
        />
        {phase === "ok" && draft ? (
          <Text variant="caption" tone="faint" style={styles.caption}>
            {t("dashboards.newWidget.tested", {
              when: draft.refreshedAt ? widgetWords.ago(draft.refreshedAt) : "",
            })}
          </Text>
        ) : null}
        {agents.length === 0 && !dir.loading ? (
          <GroupedFooter>{t("dashboards.newWidget.noAgents")}</GroupedFooter>
        ) : null}

        {/* Only when there is a choice: with My Home alone, nothing to pick. */}
        {destinations.length > 1 ? (
          <>
            <View style={styles.gap} />
            <GroupedList>
              <GroupedRow
                icon="chart"
                label={t("dashboards.newWidget.destination")}
                value={where}
                chevron
                onPress={() => setPickDest((v) => !v)}
              />
              {pickDest
                ? destinations.map((d) => (
                    <GroupedRow
                      key={d.id}
                      label={d.home ? t("dashboards.home") : (d.title ?? "")}
                      checked={d.id === destination?.id}
                      onPress={() => {
                        setDest(d.id);
                        setPickDest(false);
                      }}
                    />
                  ))
                : null}
            </GroupedList>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * Under a build: how long it has taken, Stop at the row's end, and past a while one quiet line that it is still at
 * it. Its own component, so only it redraws each second.
 */
function BuildClock({ since, onStop }: { since: number; onStop: () => void }) {
  const { t } = useTranslation();
  const elapsed = Math.max(0, useNow(1000) - since);
  return (
    <View style={styles.gap8}>
      {elapsed >= WIDGET_STILL_MS ? (
        <Animated.View entering={FadeIn.duration(200)}>
          <Text variant="caption" tone="faint">
            {t("dashboards.newWidget.stillWorking")}
          </Text>
        </Animated.View>
      ) : null}
      <View style={styles.buildFoot}>
        <Text variant="footnote" tone="muted" accessibilityRole="timer" style={LIST_TIME}>
          {taskClock(elapsed)}
        </Text>
        <Button size="sm" variant="secondary" label={t("dashboards.newWidget.stop")} onPress={onStop} />
      </View>
    </View>
  );
}

/** The footer's two picks: 44 tall to the finger, across only as far as the dot between them. */
const FOOT_SLOP = { top: 9, bottom: 9, left: 4, right: 4 };
/** The size switch: its corner, and its segments' inside it (concentric, 2 in from its edge). */
const SIZES_R = 10;
const SIZES_PAD = 2;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  titleInput: { flex: 1, minWidth: 0, paddingVertical: 4, ...fieldText("footnote", "600") },
  okBadge: { width: 22, height: 22, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  bell: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 28,
    paddingHorizontal: 6,
    borderRadius: 10,
  },
  sizes: { flexDirection: "row", padding: SIZES_PAD, borderRadius: SIZES_R },
  size: { minWidth: 26, height: 24, borderRadius: SIZES_R - SIZES_PAD, alignItems: "center", justifyContent: "center" },
  ask: { minHeight: 56, paddingTop: 4, paddingBottom: 2, ...systemText("body", "500") },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  suggestionWrap: { maxWidth: "100%" },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 30,
    maxWidth: "100%",
    paddingHorizontal: 10,
    borderRadius: 15,
  },
  formatRow: { flexDirection: "row" },
  pickBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 28,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
  },
  askedRow: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  asked: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  staleData: { opacity: 0.38 },
  failed: { gap: 10, alignItems: "flex-start" },
  failedLine: { flexDirection: "row", alignItems: "flex-start", gap: 8, alignSelf: "stretch" },
  condition: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 40,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  conditionInput: { flex: 1, minWidth: 0, paddingVertical: 8, ...fieldText("footnote") },
  foot: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  buildFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  footPick: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 },
  caption: { textAlign: "center", paddingTop: 8 },
  semibold: { fontWeight: "600", flexShrink: 1 },
  shrink: { flexShrink: 1, minWidth: 0 },
  grow: { flex: 1, minWidth: 0 },
  gap: { height: 20 },
  pressed: { opacity: 0.6 },
  gap8: { gap: 8 },
  gap10: { gap: 10 },
});

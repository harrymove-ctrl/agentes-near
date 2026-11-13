import { type Routine, useRoutines } from "@agenteschat/client";
import { routineStateTime, routineStateWords } from "@agenteschat/client/lib/routine-view";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  Icon,
  IconButton,
  LineIcon,
  ListRow,
  SCREEN_X,
  SearchField,
  SectionHeader,
  SkeletonList,
  Text,
  useReducedMotion,
} from "@/ui";
import { router } from "@/ui/navigation";
import { routineHref, widgetHref } from "../links/logic";
import { mayCreate } from "../new/logic";
import { AgentFace } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useNamesComputers, useNow, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { SheetHostProvider } from "../shared/SheetHost";
import { useRoutineMenu, useSay, useWhenText } from "./hooks";
import {
  isAtWork,
  isDoneOnce,
  isPaused,
  isRunning,
  routineSections,
  routineTitle,
  STATUS_FILTERS,
  type StatusFilter,
  whenIcon,
} from "./logic";
import { RoutineHorizon } from "./RoutineHorizon";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;
/** While a run works (or waits), the list is asked again this often: its state and its strip move on. */
const WORKING_POLL_MS = 15_000;

/**
 * Rotinas, pushed from Você (the web's page on the phone), as Tarefas and Wiki: the large title, "Nova rotina" as the
 * bar's "+" (with none yet, the empty state's own button), the search of the system, one row of filters (Todas,
 * Ativas, Pausadas, Por evento; the sections count, not the chips), the next hours as a horizon, then "No ar" and
 * "Pausadas" in the server's order, the one-offs that already ran folded under "Concluídos". Each row is the agent's
 * face at 52, the routine's name and when it runs with its clock; what needs a look says so in the waiting color.
 * A row opens its routine; a long press its actions.
 */
export function RoutinesScreen() {
  return (
    <SheetHostProvider>
      <RoutineList />
    </SheetHostProvider>
  );
}

function RoutineList() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const meId = useMeId();
  const routines = useRoutines(orgId);
  const pull = usePullRefresh(routines.refetch);
  const now = useNow(60_000);
  const whenText = useWhenText();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [showDone, setShowDone] = useState(false);
  const list = useMemo(() => routines.data ?? [], [routines.data]);
  const sections = useMemo(
    () => routineSections(list, { status, agentId: null, query: q }, whenText),
    [list, status, q, whenText],
  );
  const working = list.some(isAtWork);
  const { refetch } = routines;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refetch(), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [working, refetch]);
  const openNew = () => router.push("/routines/new");
  const clear = () => {
    setQ("");
    setStatus("all");
  };
  const ownsAgent = Boolean(meId) && dir.agents.some((a) => a.ownerUserId === meId);
  const mayNew = mayCreate(useOrg().org, "routine", { ownsAgent });
  // A routine paused, resumed, deleted or filtered out while the person watches fades, and the rest slide into place.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  let row = 0;
  const rows = (items: Routine[]) =>
    items.map((r, i) => {
      row += 1;
      return (
        <Animated.View key={r.id} {...fade} layout={layout}>
          <RoutineListRow routine={r} divider={i > 0} live={row <= LIVE_ROWS} />
        </Animated.View>
      );
    });
  return (
    <PushedLargeTitle
      title={t("routines.title")}
      {...(mayNew ? { right: <IconButton icon="plus" label={t("routines.new")} onPress={openNew} /> } : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {routines.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : routines.isError && !routines.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.routines.loadFailed")}
          </Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void refetch()} />
        </View>
      ) : list.length === 0 ? (
        <FirstUse place="routines" acts={mayNew} label={t("routines.new")} onPress={openNew} />
      ) : (
        // Loaded, the list fades in over the spinner; the rows it starts with don't each fade again.
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            <View style={styles.search}>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder={t("routines.search")}
                accessibilityLabel={t("routines.search")}
                returnKeyType="search"
              />
            </View>
            {/* One row of filters, words only: the sections below say how many. */}
            <Filters
              items={STATUS_FILTERS.map((s) => ({ key: s, label: t(`routines.status.${s}`) }))}
              value={status}
              onChange={(k) => setStatus(k as StatusFilter)}
            />
            <RoutineHorizon routines={list} now={now} />
            {sections.live.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader
                  title={status === "paused" ? t("routines.groupPaused") : t("routines.groupLive")}
                  count={sections.live.length}
                />
                {rows(sections.live)}
              </Animated.View>
            ) : null}
            {sections.paused.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("routines.groupPaused")} count={sections.paused.length} />
                {rows(sections.paused)}
              </Animated.View>
            ) : null}
            {sections.live.length === 0 && sections.paused.length === 0 && sections.filtered ? (
              <Animated.View {...fade} layout={layout}>
                <EmptyState
                  size="inline"
                  title={t("routines.noResults")}
                  action={<Button variant="secondary" size="sm" label={t("filters.clearAll")} onPress={clear} />}
                />
              </Animated.View>
            ) : null}
            {sections.done.length > 0 && status === "all" ? (
              <Animated.View {...fade} layout={layout}>
                <Pressable
                  onPress={() => setShowDone((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showDone }}
                  hitSlop={4}
                  style={({ pressed }) => [styles.doneToggle, pressed && styles.pressed]}
                >
                  <Icon name={showDone ? "chev" : "right"} size={15} color={c.muted} />
                  <Text variant="small" tone="muted" style={styles.bold}>
                    {t("routines.doneToggle", { count: sections.done.length })}
                  </Text>
                </Pressable>
                {showDone ? rows(sections.done) : null}
              </Animated.View>
            ) : null}
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

/**
 * A routine in the list: the agent's face at 52 (asleep while paused, at work while it runs), the routine's name, and
 * when it runs with its clock (faint while paused); what needs a look (a reason it paused, failures, waiting for a
 * computer or a person) takes that line, in the waiting color. A tap opens it (a widget's routine, its widget); a
 * long press its actions.
 */
const RoutineListRow = memo(function RoutineListRow({
  routine: r,
  divider,
  live,
}: {
  routine: Routine;
  divider: boolean;
  live: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const say = useSay();
  const names = useNamesComputers();
  const whenText = useWhenText();
  const menu = useRoutineMenu(r, "list");
  const paused = isPaused(r);
  const done = isDoneOnce(r);
  const running = isRunning(r);
  const state = routineStateWords(r, routineStateTime(t, i18n.language, r), names);
  const needsLook = !done && state.tone === "waiting";
  const line = needsLook ? say(state) : whenText(r);
  const href = r.target.type === "widget" ? widgetHref(r.target.widgetId, r.target.dashboardId) : routineHref(r.id);
  const tint = needsLook ? c.amber : paused || done ? c.faint : c.muted;
  return (
    <ListRow
      divider={divider}
      leading={
        <AgentFace agentId={r.agentId} size={52} live={live} mode={running ? "run" : paused ? "rest" : "idle"} />
      }
      title={routineTitle(r)}
      sub={
        <View style={styles.when}>
          <LineIcon variant="subhead" name={needsLook ? "wait" : whenIcon(r)} size={14} color={tint} />
          <Text
            variant="subhead"
            numberOfLines={1}
            style={[styles.shrink, { color: needsLook ? c.amber : paused || done ? c.faint : c.muted }]}
          >
            {line}
          </Text>
        </View>
      }
      accessibilityLabel={[routineTitle(r), line].join(", ")}
      accessibilityActions={[{ name: "menu", label: menu.label }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "menu") menu.open();
      }}
      onLongPress={menu.open}
      delayLongPress={380}
      onPress={() => router.push(href)}
    />
  );
});

const styles = StyleSheet.create({
  when: { flexDirection: "row", alignItems: "flex-start", gap: 6, minWidth: 0 },
  shrink: { flexShrink: 1, minWidth: 0 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  search: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 10 },
  doneToggle: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: SCREEN_X, paddingVertical: 14 },
  pressed: { opacity: 0.6 },
  bold: { fontWeight: "600" },
});

import { type Issue, useIssueColumns, useIssues } from "@agenteschat/client";
import { dueLabel } from "@agenteschat/client/lib/format";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Fragment, type ReactNode, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  RefreshControl,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  Filters,
  Icon,
  IconButton,
  ListRow,
  SCREEN_X,
  SearchField,
  SectionHeader,
  Segmented,
  SkeletonList,
  Text,
  textLineOf,
  useFontScale,
  useReducedMotion,
} from "@/ui";
import { mediaRowAxis } from "@/ui/media-row";
import { router } from "@/ui/navigation";
import { mayCreate } from "../new/logic";
import { Face } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { FocusLive, PushedHeader } from "../shared/parts";
import { type BoardColumn, issueBoard, taskListSections } from "./logic";
import { BoardCard, ColumnHeader, StateWords, TaskTitle, useCardState, useColumnLabel } from "./parts";

/** Cards and rows whose agent moves (a long list stays light). */
const LIVE_CARDS = 8;
const COLUMN_GAP = 12;
/** How much of the next column shows at the edge. */
const PEEK = 41;
/** The list's leading column: the check sits where a row's face would. */
const CHECK_BOX = 52;

type TaskView = "list" | "board";

/**
 * Tasks, pushed from Você, in two views on one segmented control under the title. Lista (the default): the large
 * title and the search of the system, then one list by state, "Para você" first; each row the check in the face's
 * column of 52, the title, who has it (an agent alive while it works) and its state or due date in words; done is the
 * green check. Quadro: the stages side by side, swiped one at a time with the next one showing at the edge, the tabs
 * on top with their counts; custom board columns show as headers, each of A fazer's with "+" for a task in it. "+" in
 * the bar opens "Nova tarefa"; columns are edited on the web only. Switching views is a choice made often: it doesn't
 * animate beyond the control's own slide.
 */
export function IssuesScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const issues = useIssues(orgId);
  const [view, setView] = useState<TaskView>("list");
  const openNew = () => router.push("/issues/new");
  const mayNew = mayCreate(useOrg().org, "task");
  const empty = issues.isSuccess && (issues.data ?? []).length === 0;
  const right = mayNew ? <IconButton icon="plus" label={t("mobile.issues.new")} onPress={openNew} /> : undefined;
  const views = (
    <View style={styles.views}>
      <Segmented
        wide
        items={[
          { key: "list", label: t("mobile.issues.viewList") },
          { key: "board", label: t("mobile.issues.viewBoard") },
        ]}
        value={view}
        onChange={(k) => setView(k as TaskView)}
      />
    </View>
  );
  if (view === "board" && !empty) return <Board right={right} views={views} mayNew={mayNew} />;
  return <TaskList right={right} views={views} empty={empty} mayNew={mayNew} onNew={openNew} />;
}

/** Lista: the search, the views, then the sections ("Para você", Em andamento, Em revisão, A fazer, Feitas hoje). */
function TaskList({
  right,
  views,
  empty,
  mayNew,
  onNew,
}: {
  right: ReactNode;
  views: ReactNode;
  empty: boolean;
  mayNew: boolean;
  onNew: () => void;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const issues = useIssues(orgId);
  const pull = usePullRefresh(issues.refetch);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const sections = useMemo(() => {
    const all = issues.data ?? [];
    const shown = query ? all.filter((i) => `${i.title} #${i.number}`.toLowerCase().includes(query)) : all;
    return taskListSections(shown, meId);
  }, [issues.data, query, meId]);
  let row = 0;
  return (
    <PushedLargeTitle
      title={t("mobile.issues.title")}
      {...(right ? { right } : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {issues.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : issues.isError && !issues.data ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.issues.loadFailed")}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.common.retry")}
            onPress={() => void issues.refetch()}
          />
        </View>
      ) : empty ? (
        <FirstUse place="tasks" acts={mayNew} label={t("mobile.issues.new")} onPress={onNew} />
      ) : (
        <>
          <View style={styles.search}>
            <SearchField
              value={q}
              onChangeText={setQ}
              placeholder={t("mobile.issues.search")}
              accessibilityLabel={t("mobile.issues.search")}
              returnKeyType="search"
            />
          </View>
          {views}
          {sections.length === 0 ? (
            <Text variant="subhead" tone="faint" style={styles.none}>
              {query ? t("mobile.issues.noMatch") : t("mobile.issues.columnEmpty")}
            </Text>
          ) : null}
          <FocusLive>
            {sections.map((s) => (
              <Fragment key={s.key}>
                <SectionHeader title={t(`mobile.issues.list.${s.key}`)} count={s.items.length} />
                {s.items.map((i, n) => {
                  row += 1;
                  return <TaskRow key={i.id} issue={i} divider={n > 0} live={row <= LIVE_CARDS} />;
                })}
              </Fragment>
            ))}
          </FocusLive>
        </>
      )}
    </PushedLargeTitle>
  );
}

/**
 * A task in the list: the check (green once done, faint before), its title whole, then who has it (the agent's face,
 * moving while it works) and its one state in the board card's words ("Pergunta algo" in the attention color), else
 * its due date in words. A long name wraps beside its face, and a state that doesn't fit goes under it, whole.
 */
function TaskRow({ issue: i, divider, live }: { issue: Issue; divider: boolean; live: boolean }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const { state, words } = useCardState(i);
  const done = i.status === "done";
  const running = state?.kind === "running";
  const who = i.assignee ? dir.nameOf(i.assignee) : t("mobile.issues.nobody");
  const due = i.dueDate && !done ? dueLabel(t, i18n.language, i.dueDate) : null;
  const axis = mediaRowAxis(16, textLineOf("subhead", useFontScale()));
  return (
    <ListRow
      divider={divider}
      leading={
        <View style={styles.check}>
          <Icon name={done ? "checkc" : "circle"} size={24} color={done ? c.ok : c.faint} />
        </View>
      }
      title={<TaskTitle title={i.title} variant="title" />}
      sub={
        <View style={styles.subLine}>
          <View style={styles.person}>
            {i.assignee ? (
              <View style={{ marginTop: axis.face }}>
                <Face who={i.assignee} size={16} live={live} mode={running ? "run" : "idle"} />
              </View>
            ) : null}
            <Text variant="subhead" tone="muted" style={[styles.shrink, { paddingTop: axis.words }]}>
              {who}
              {!state && due ? ` · ${due}` : ""}
            </Text>
          </View>
          {state && words ? <StateWords issue={i} state={state} words={words} /> : null}
        </View>
      }
      accessibilityLabel={[i.title, who, words ?? due].filter(Boolean).join(", ")}
      onPress={() => router.push(`/issues/${i.number}`)}
    />
  );
}

/** Quadro: the stages side by side, as before, under the title and the views. */
function Board({ right, views, mayNew }: { right: ReactNode; views: ReactNode; mayNew: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const headerHeight = useHeaderHeight();
  const { width } = useWindowDimensions();
  const issues = useIssues(orgId);
  const columns = useIssueColumns(orgId);
  const pull = usePullRefresh(issues.refetch);
  const pager = useRef<ScrollViewInstance>(null);
  const [tab, setTab] = useState(0);
  // A tab tapped: where the pager is going, so the columns it passes on the way don't light up.
  const going = useRef<number | null>(null);
  const board = useMemo(() => issueBoard(issues.data ?? [], columns.data ?? []), [issues.data, columns.data]);
  const columnWidth = width - PEEK - SCREEN_X;
  const step = columnWidth + COLUMN_GAP;
  const columnAt = (x: number) => Math.max(0, Math.min(board.length - 1, Math.round(x / step)));
  const onPagerScroll = (x: number) => {
    const at = columnAt(x);
    if (going.current === null) setTab(at);
    else if (at === going.current && Math.abs(x - at * step) < 1) going.current = null;
  };
  const go = (index: number) => {
    going.current = index === tab ? null : index;
    setTab(index);
    pager.current?.scrollTo({ x: index * step, animated: true });
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.bg, paddingTop: Platform.OS === "ios" ? headerHeight : 0 }]}>
      <PushedHeader solid={false} {...(right ? { right } : {})} />
      <Text variant="display" accessibilityRole="header" numberOfLines={1} style={styles.title}>
        {t("mobile.issues.title")}
      </Text>
      {views}
      <Filters
        items={board.map((b) => ({
          key: b.stage,
          label: t(`mobile.issues.section.${b.stage}`),
          count: b.count,
        }))}
        value={board[tab]?.stage ?? ""}
        onChange={(k) => go(board.findIndex((b) => b.stage === k))}
      />
      <FocusLive>
        <ScrollView
          ref={pager}
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={step}
          decelerationRate="fast"
          disableIntervalMomentum
          contentContainerStyle={styles.pager}
          scrollEventThrottle={32}
          onScrollBeginDrag={() => {
            going.current = null;
          }}
          onScroll={(e) => onPagerScroll(e.nativeEvent.contentOffset.x)}
        >
          {board.map((b) => (
            <Column key={b.stage} column={b} width={columnWidth} pull={pull} mayNew={mayNew} />
          ))}
        </ScrollView>
      </FocusLive>
    </View>
  );
}

function Column({
  column: b,
  width,
  pull,
  mayNew,
}: {
  column: BoardColumn;
  width: number;
  pull: ReturnType<typeof usePullRefresh>;
  mayNew: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const columnLabel = useColumnLabel();
  // A task that moves to another stage while the person watches leaves this column and fades into its new one;
  // the rest slide into place. The cards there when the board loads don't each fade.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const layout = reduced ? undefined : LinearTransition.duration(220);
  const newIn = (column: string) => () => router.push({ pathname: "/issues/new", params: { column } });
  let card = 0;
  return (
    <ScrollView
      style={[styles.column, { width, backgroundColor: c.sunken }]}
      contentContainerStyle={[styles.columnBody, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <LayoutAnimationConfig skipEntering>
        {b.groups.length === 0 ? (
          <Animated.View {...fade}>
            <Text variant="subhead" tone="faint" style={styles.none}>
              {t("mobile.issues.columnEmpty")}
            </Text>
          </Animated.View>
        ) : null}
        {b.groups.map((g) => (
          <Fragment key={g.key}>
            {b.showColumns && g.column ? (
              <ColumnHeader
                label={columnLabel(g.column)}
                count={g.items.length}
                {...(mayNew && g.column.stage === "todo" ? { onNew: newIn(g.column.id) } : {})}
              />
            ) : null}
            {g.items.map((i) => {
              card += 1;
              return (
                <Animated.View key={i.id} {...fade} layout={layout}>
                  <BoardCard issue={i} live={card <= LIVE_CARDS} />
                </Animated.View>
              );
            })}
          </Fragment>
        ))}
      </LayoutAnimationConfig>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: { paddingHorizontal: SCREEN_X, paddingTop: 4 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  search: { paddingHorizontal: SCREEN_X, paddingBottom: 8 },
  views: { paddingHorizontal: SCREEN_X, paddingTop: 8, paddingBottom: 8 },
  check: { width: CHECK_BOX, height: CHECK_BOX, alignItems: "center", justifyContent: "center" },
  // Who has it with the date, then the state, wrapping between them, never the face alone on a line.
  subLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 2, minWidth: 0 },
  person: { flexDirection: "row", alignItems: "flex-start", gap: 4, flexShrink: 1 },
  shrink: { flexShrink: 1, minWidth: 0 },
  // Edge to edge: the columns slide under the screen's sides, the first one on the title's line.
  pager: { paddingLeft: SCREEN_X, paddingRight: PEEK - COLUMN_GAP, paddingTop: 8, gap: COLUMN_GAP },
  column: { borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  columnBody: { padding: 10, gap: 10 },
  none: { padding: 16, textAlign: "center" },
});

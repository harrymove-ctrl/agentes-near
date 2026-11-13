import type { ComputerSummary, EndedTask, ManagedTask } from "@agenteschat/client";
import {
  type AgentTasks,
  agentSummary,
  endedState,
  groupLead,
  groupTasks,
  hiddenCount,
  taskPlace,
  taskState,
  taskTime,
  taskTitle,
  taskWaitWords,
} from "@agenteschat/client/lib/task-manager";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { ComputerIcon, useComputerKind } from "@/computer/ComputerPortrait";
import {
  Button,
  Count,
  EmptyState,
  Icon,
  MEDIA_ROW,
  MediaRow,
  PixelDone,
  PixelFail,
  PixelStopped,
  SCREEN_X,
  SectionHeader,
  SkeletonList,
  Text,
  useReducedMotion,
  weights,
} from "@/ui";
import { router } from "@/ui/navigation";
import { CollapsibleSection } from "../chats/HomeSection";
import { useOpenQueue } from "../queue/QueueSheet";
import { AgentFace, OpensAgent } from "../shared/Face";
import { useEmptyLook } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { Tile } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { useStopper, useTasksToday } from "./hooks";
import {
  computerLine,
  endedLatestFirst,
  endedText,
  groupLine,
  type RowState,
  rowState,
  taskStateWords,
  taskSubline,
} from "./logic";
import { StateLine, TaskMark, WaitLines } from "./parts";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/** A task's own screen. */
const taskHref = (runId: string) => `/task-manager/${runId}` as const;

/**
 * Rows that come and go while the person watches (a task stopped, one that ended, a group folded) fade, and what
 * stays slides into place; nothing moves with reduced motion.
 */
function useRowMotion() {
  const reduced = useReducedMotion();
  return reduced
    ? { fade: {}, layout: undefined }
    : {
        fade: { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) },
        layout: LinearTransition.duration(220),
      };
}

/**
 * The task manager (ADR 0128), pushed from Agentes: what the agents are doing now, under a line that counts it
 * ("2 trabalhando · 1 espera você"). The tasks people asked for, by agent (its row says how its tasks stand and is
 * one tap: folded until opened), each a row with its state as text (the orbit while it runs, amber while it waits on
 * you) and a chevron: stopping is done on the task's own screen, never from a button in the list. Then the routines'
 * work in the background and what ended today. Above them, the computers with work, each opening its line in a sheet.
 */
export function TaskManagerScreen() {
  return (
    <SheetHostProvider>
      <TaskManager />
    </SheetHostProvider>
  );
}

function TaskManager() {
  const { t } = useTranslation();
  const look = useEmptyLook();
  const meId = useMeId();
  const tasks = useTasksToday();
  const pull = usePullRefresh(tasks.refetch);
  const now = useNow(1000);
  // Tasks being stopped from their screens read "Parando…" here too.
  const { stopping } = useStopper();
  const { fade, layout } = useRowMotion();
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [endedOpen, setEndedOpen] = useState(false);
  const view = tasks.data;
  const { groups, delegated, background } = useMemo(
    () => groupTasks(view?.tasks ?? [], stopping),
    [view?.tasks, stopping],
  );
  const ended = useMemo(() => endedLatestFirst(view?.ended ?? []), [view?.ended]);
  const all = view?.tasks ?? [];
  const sum = agentSummary(all);
  // Everyone's work counts here, as on the computers' rows; what the viewer may not see only counts.
  const working = sum.working + (view?.hidden?.working ?? 0);
  const hidden = hiddenCount(view?.hidden, null);
  // The line under the title: how many work and how many wait on you, else that nothing is on.
  const summary =
    [
      working > 0 ? t("taskManager.working", { count: working }) : null,
      sum.waiting > 0 ? t("taskManager.waiting", { count: sum.waiting }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || t("mobile.taskManager.quiet");
  const toggle = (agentId: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  const askedCount = groups.reduce((n, g) => n + g.tasks.length, 0);
  const delegatedCount = delegated.reduce((n, g) => n + g.tasks.length, 0);
  const computers = view?.computers ?? [];
  return (
    <PushedLargeTitle
      title={t("taskManager.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {tasks.isLoading ? (
        // Loading: the rows' own shape, never a spinner.
        <SkeletonList rows={4} />
      ) : tasks.isError && !view ? (
        <View style={styles.center}>
          <Text tone="muted" style={styles.centerText}>
            {t("mobile.taskManager.loadFailed")}
          </Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void tasks.refetch()} />
        </View>
      ) : (
        // Loaded, the list fades in over the spinner; the rows it starts with don't each fade again.
        <Animated.View {...fade}>
          <LayoutAnimationConfig skipEntering>
            <Text variant="subhead" tone="muted" style={styles.summary}>
              {summary}
            </Text>
            {sum.tasks + hidden > 0 ? null : (
              <EmptyState
                size="panel"
                agent={look}
                mood="deal"
                title={t("taskManager.empty.title")}
                subtitle={t("taskManager.empty.body")}
              />
            )}
            {hidden > 0 ? (
              <Text variant="footnote" tone="faint" style={styles.none}>
                {t("taskManager.hiddenLine", { count: hidden })}
              </Text>
            ) : null}
            {computers.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.queue.computers")} count={computers.length} />
                {computers.map((m, i) => (
                  <Animated.View key={m.id} {...fade} layout={layout}>
                    <ComputerRow computer={m} divider={i > 0} />
                  </Animated.View>
                ))}
              </Animated.View>
            ) : null}
            {groups.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.asked")} count={askedCount} />
                <WaitLines tasks={groups.flatMap((g) => g.tasks)} now={now} />
                {groups.map((g, i) => (
                  <AgentGroup
                    key={g.agentId}
                    group={g}
                    open={opened.has(g.agentId)}
                    onToggle={() => toggle(g.agentId)}
                    divider={i > 0}
                    live={i < LIVE_ROWS}
                    stopping={stopping}
                    now={now}
                    meId={meId}
                  />
                ))}
              </Animated.View>
            ) : null}
            {delegated.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.delegated")} count={delegatedCount} />
                <WaitLines tasks={delegated.flatMap((g) => g.tasks)} now={now} />
                {delegated.map((g, i) => (
                  <AgentGroup
                    key={g.agentId}
                    group={g}
                    flat
                    open={opened.has(`by:${g.agentId}`)}
                    onToggle={() => toggle(`by:${g.agentId}`)}
                    divider={i > 0}
                    live={i < LIVE_ROWS}
                    stopping={stopping}
                    now={now}
                    meId={meId}
                  />
                ))}
              </Animated.View>
            ) : null}
            {background.length > 0 ? (
              <Animated.View {...fade} layout={layout}>
                <SectionHeader title={t("taskManager.sections.background")} count={background.length} />
                <WaitLines tasks={background} now={now} />
                {background.map((task, i) => (
                  <Animated.View key={task.runId} {...fade} layout={layout}>
                    <TaskRow task={task} state={rowState(task, stopping)} flat divider={i > 0} now={now} meId={meId} />
                  </Animated.View>
                ))}
              </Animated.View>
            ) : null}
            {/* The same folding header as the other lists' sections (title, count, the chevron at the right). */}
            <Animated.View layout={layout}>
              <CollapsibleSection
                title={t("taskManager.ended.title")}
                count={ended.length}
                collapsed={!endedOpen}
                onToggle={() => setEndedOpen((o) => !o)}
              >
                {ended.length > 0 ? (
                  ended.map((e, i) => (
                    <Animated.View key={e.runId} {...fade} layout={layout}>
                      <EndedRow task={e} divider={i > 0} meId={meId} />
                    </Animated.View>
                  ))
                ) : (
                  <Animated.View {...fade}>
                    <Text variant="footnote" tone="faint" style={styles.none}>
                      {t("taskManager.ended.none")}
                    </Text>
                  </Animated.View>
                )}
              </CollapsibleSection>
            </Animated.View>
          </LayoutAnimationConfig>
        </Animated.View>
      )}
    </PushedLargeTitle>
  );
}

/**
 * An agent's row and, open, its tasks under it: its face (running while it works), its name with the count beside
 * it (unless the line under it says it), how its tasks stand ("1 trabalhando · 1 espera você") and the chevron that
 * folds them. One tap, the whole row.
 */
function AgentGroup({
  group,
  flat = false,
  open,
  onToggle,
  divider,
  live,
  stopping,
  now,
  meId,
}: {
  group: AgentTasks;
  /** The group of an agent that asked: its rows are other agents' tasks, each with its face. */
  flat?: boolean;
  open: boolean;
  onToggle: () => void;
  divider: boolean;
  live: boolean;
  stopping: ReadonlySet<string>;
  now: number;
  meId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const name = dir.nameOf({ type: "agent", id: group.agentId }) || t("channel.unknownAgent");
  const color = agentLook(dir.anyAgent(group.agentId)).color;
  const heldTask = group.tasks.find((task) => taskState(task) === "waiting");
  const line = groupLine(t, group, heldTask ? taskWaitWords(t, i18n.language, heldTask, now)?.state : null);
  const mark: RowState = line.mark === "working" ? "working" : line.mark === "waiting" ? "ok" : "queued";
  const time = taskTime(t, groupLead(group), now);
  const chevron = useAnimatedStyle(() => ({
    transform: [{ rotate: withTiming(open ? "0deg" : "-90deg", { duration: 200 }) }],
  }));
  const { fade, layout } = useRowMotion();
  // All working or all waiting on you: the line under the name already says how many ("2 working").
  const counted = group.tasks.length === group.working || group.tasks.length === group.waiting;
  return (
    <Animated.View {...fade} layout={layout}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${name}, ${line.text}, ${time}`}
        style={({ pressed }) => [styles.agent, pressed && { backgroundColor: c.sunken }]}
      >
        {divider ? <View style={[styles.divider, styles.agentDivider, { backgroundColor: c.line2 }]} /> : null}
        <OpensAgent agentId={group.agentId}>
          <AgentFace
            agentId={group.agentId}
            size={GROUP_FACE}
            mode={line.mark === "working" ? "run" : "idle"}
            live={live}
          />
        </OpensAgent>
        <View style={styles.grow}>
          <View style={styles.nameRow}>
            <Text variant="title" numberOfLines={1} style={styles.shrink}>
              {name}
            </Text>
            {counted ? null : <Count value={group.tasks.length} size={13} weight={weights.regular} color={c.faint} />}
          </View>
          <View style={styles.row}>
            <TaskMark state={mark} color={color} />
            <Text variant="footnote" style={[styles.shrink, { color: line.mark === "waiting" ? c.amber : c.muted }]}>
              {line.text}
            </Text>
            <Text variant="caption" tone="faint" style={styles.num}>
              · {time}
            </Text>
          </View>
        </View>
        <Animated.View style={chevron}>
          <Icon name="down" size={CHEVRON} color={c.faint} />
        </Animated.View>
      </Pressable>
      {open
        ? group.tasks.map((task, i) => (
            <Animated.View key={task.runId} {...fade} layout={layout}>
              <TaskRow task={task} state={rowState(task, stopping)} flat={flat} divider={i > 0} now={now} meId={meId} />
            </Animated.View>
          ))
        : null}
    </Animated.View>
  );
}

/**
 * A task, a 60-point row: its title, whole, its state under it (the orbit while it runs, the time; amber while it
 * waits on you) and a chevron, since it opens its own screen, where it is stopped. Under its agent's row it starts
 * at the name's column; a routine's (`flat`) is a MediaRow: its agent's face, name, where and who asked on one
 * line, the title and state under them at the row's width.
 */
function TaskRow({
  task,
  state,
  flat = false,
  divider,
  now,
  meId,
}: {
  task: ManagedTask;
  state: RowState;
  flat?: boolean;
  divider: boolean;
  now: number;
  meId: string | null;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const title = taskTitle(t, task);
  const sub = taskSubline(t, task, meId, title, (id) => dir.anyAgent(id)?.name);
  const words = taskStateWords(t, i18n.language, task, state, now);
  const agent = dir.nameOf({ type: "agent", id: task.agentId });
  const line = flat ? [agent, sub].filter(Boolean).join(" · ") : sub;
  return (
    <Pressable
      onPress={() => router.push(taskHref(task.runId))}
      accessibilityRole="button"
      accessibilityLabel={[title, line, words.state, words.next].filter(Boolean).join(", ")}
      style={({ pressed }) => [
        flat ? styles.flatTask : [styles.task, styles.indented],
        pressed && { backgroundColor: c.sunken },
      ]}
    >
      {divider ? (
        <View
          style={[styles.divider, flat ? styles.flatTaskDivider : styles.taskDivider, { backgroundColor: c.line2 }]}
        />
      ) : null}
      {flat ? (
        <View style={styles.taskText}>
          <MediaRow
            face={
              <OpensAgent agentId={task.agentId}>
                <AgentFace agentId={task.agentId} size={MEDIA_ROW.card.face} live={false} />
              </OpensAgent>
            }
            name={agent}
            meta={sub || undefined}
          >
            <Text variant="body">{title}</Text>
            <StateLine task={task} state={state} now={now} />
          </MediaRow>
        </View>
      ) : (
        <View style={styles.taskText}>
          <Text variant="body">{title}</Text>
          <StateLine task={task} state={state} now={now} />
        </View>
      )}
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/**
 * A computer with work (ADR 0128): its name, whether it has room or how many wait for it, how many run there now. It
 * opens its line (`QueueSheet`).
 */
function ComputerRow({ computer, divider }: { computer: ComputerSummary; divider: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const kind = useComputerKind(useOrgId(), computer.id);
  const openQueue = useOpenQueue();
  const line = computerLine(t, computer);
  return (
    <Pressable
      onPress={() => openQueue(computer.id)}
      accessibilityRole="button"
      accessibilityLabel={`${computer.name}, ${line}`}
      style={({ pressed }) => [styles.computer, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, styles.computerDivider, { backgroundColor: c.line2 }]} /> : null}
      <Tile size={30}>
        <ComputerIcon kind={kind} size={16} color={c.muted} />
      </Tile>
      <View style={styles.taskText}>
        <Text variant="subhead" numberOfLines={1} style={styles.medium}>
          {computer.name}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={1}>
          {line}
        </Text>
      </View>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/** One that ended today: its agent, title and place, how it ended and when. It opens its screen too. */
function EndedRow({ task, divider, meId }: { task: EndedTask; divider: boolean; meId: string | null }) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const when = useWhen();
  const title = taskTitle(t, task);
  const agentName = dir.nameOf({ type: "agent", id: task.agentId });
  const line = [agentName, taskPlace(t, task)].filter(Boolean).join(" · ");
  const how = endedText(t, task, meId);
  const state = endedState(task);
  return (
    <Pressable
      onPress={() => router.push(taskHref(task.runId))}
      accessibilityRole="button"
      accessibilityLabel={[title, line, how, when.time(task.finishedAt)].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.task, styles.flat, pressed && { backgroundColor: c.sunken }]}
    >
      {divider ? <View style={[styles.divider, styles.flatDivider, { backgroundColor: c.line2 }]} /> : null}
      <OpensAgent agentId={task.agentId}>
        <AgentFace agentId={task.agentId} size={30} live={false} />
      </OpensAgent>
      <View style={styles.taskText}>
        <Text variant="subhead" style={styles.medium}>
          {title}
        </Text>
        <Text variant="footnote" tone="muted" numberOfLines={1}>
          {line}
        </Text>
      </View>
      <View style={styles.end}>
        <View style={styles.row}>
          {state === "done" ? (
            <PixelDone size={12} />
          ) : state === "failed" ? (
            <PixelFail size={12} />
          ) : (
            <PixelStopped size={10} />
          )}
          <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
            {how}
          </Text>
        </View>
        <Text variant="caption" tone="faint" style={styles.num}>
          {when.time(task.finishedAt)}
        </Text>
      </View>
    </Pressable>
  );
}

/** An agent row's folding chevron (at its right) and face. */
const CHEVRON = 16;
const GROUP_FACE = 36;
/** Where a task's words start under its agent's row: the name's column (16 + face + 12). */
const TASK_INSET = 16 + GROUP_FACE + 12;
/** An ended task's words: after the face (16 + 30 + 12). */
const FLAT_INSET = 58;

const styles = StyleSheet.create({
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  centerText: { textAlign: "center" },
  // Under the large title's words, as Equipe's line.
  summary: { paddingHorizontal: SCREEN_X, marginTop: -4, paddingBottom: 4 },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  shrink: { flexShrink: 1 },
  medium: { fontWeight: weights.medium },
  num: { fontVariant: ["tabular-nums"] },
  task: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingVertical: 8,
    paddingRight: 16,
  },
  indented: { paddingLeft: TASK_INSET },
  flat: { paddingLeft: 16 },
  // A routine's task (a MediaRow): its words under the face at the row's width, so its hairline starts there too.
  flatTask: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 16 },
  flatTaskDivider: { left: 16 },
  taskText: { flex: 1, minWidth: 0, gap: 2 },
  divider: { position: "absolute", top: 0, right: 0, height: StyleSheet.hairlineWidth },
  agentDivider: { left: 16 },
  taskDivider: { left: TASK_INSET },
  flatDivider: { left: FLAT_INSET },
  none: { paddingHorizontal: SCREEN_X, paddingBottom: 12 },
  end: { alignItems: "flex-end", gap: 2, maxWidth: 130 },
  computer: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 16 },
  computerDivider: { left: FLAT_INSET },
});

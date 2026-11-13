import type { EndedTask, ManagedTask } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { endedState, linePlace, taskState, taskTitle } from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  GroupedHeader,
  GroupedList,
  GroupedRow,
  PixelDone,
  PixelFail,
  PixelStopped,
  SCREEN_X,
  Section,
  Text,
  weights,
} from "@/ui";
import { router } from "@/ui/navigation";
import { RunSteps } from "../chat/ToolCalls";
import { chatHref } from "../links/logic";
import { useOpenQueue } from "../queue/QueueSheet";
import { AgentFace, Face, OpensAgent } from "../shared/Face";
import { useColors, useDirectory, useMeId, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedHeader } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { useStopper, useTasksToday } from "./hooks";
import { endedText, rowState, taskSubline } from "./logic";
import { StateLine } from "./parts";

/**
 * A task's screen (ADR 0128), pushed from the task manager or an agent's tasks: whose it is (its face running while it
 * works) and how it stands, on one head; who asked and where, a row that opens the conversation; its steps so far;
 * its place in its computer's line, when it waits for room; and "Parar tarefa" as the list's red row, confirmed by
 * a system alert that says what happens. Once it ends, how it ended and how long it took.
 */
export function TaskScreen({ runId }: { runId: string }) {
  return (
    <SheetHostProvider>
      <Task runId={runId} />
    </SheetHostProvider>
  );
}

function Task({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const tasks = useTasksToday();
  const task = tasks.data?.tasks.find((x) => x.runId === runId) ?? null;
  const ended = task ? null : (tasks.data?.ended.find((x) => x.runId === runId) ?? null);
  if (!task && !ended)
    return (
      <View style={[styles.screen, { backgroundColor: c.grouped }]}>
        <PushedHeader title="" solid={false} grouped />
        <View style={styles.center}>
          {tasks.isLoading ? (
            <ActivityIndicator color={c.muted} />
          ) : (
            <Text tone="muted">{t("mobile.taskManager.gone")}</Text>
          )}
        </View>
      </View>
    );
  if (task) return <Live task={task} />;
  if (ended) return <Ended task={ended} />;
  return null;
}

/** A task still on: its state moves, and who may stop it can. */
function Live({ task }: { task: ManagedTask }) {
  const { t } = useTranslation();
  const meId = useMeId();
  const now = useNow(1000);
  const { stopping, stop } = useStopper();
  const state = rowState(task, stopping);
  const title = taskTitle(t, task);
  const inLine = state === "stopping" ? null : linePlace(task);
  const dir = useDirectory();
  const nameOf = (id: string) => dir.anyAgent(id)?.name;
  const name = nameOf(task.agentId) ?? t("channel.unknownAgent");
  // One alert, the system's: what stops and what the agent does; a task that asked other agents stops them too.
  const ask = () =>
    Alert.alert(
      t("mobile.taskManager.stopTitle", { title }),
      task.helpers ? t("taskManager.confirm.chainBody") : t("mobile.taskManager.stopBody", agentGrammar(name)),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("taskManager.confirm.stop", { count: 1 + (task.helpers ?? 0) }),
          style: "destructive",
          onPress: () => stop([task.runId], undefined, true),
        },
      ],
    );
  return (
    <Page
      task={task}
      title={title}
      state={<StateLine task={task} state={state} now={now} />}
      working={taskState(task) === "working"}
      request={taskSubline(t, task, meId, title, nameOf)}
      steps={{ calls: task.steps, live: taskState(task) === "working" }}
      line={inLine?.machineId ?? null}
      stop={task.canStop && state !== "stopping" ? ask : null}
      stopNote={
        task.delegation ? t("taskManager.delegated.stopNote", { name: nameOf(task.delegation.agentId) ?? "" }) : null
      }
    />
  );
}

/** A task that ended today: how (done, stopped and by whom, couldn't), and how long it took. */
function Ended({ task }: { task: EndedTask }) {
  const { t } = useTranslation();
  const meId = useMeId();
  const state = endedState(task);
  const title = taskTitle(t, task);
  const took = Date.parse(task.finishedAt) - Date.parse(task.startedAt ?? task.finishedAt);
  return (
    <Page
      task={task}
      title={title}
      state={
        <View style={styles.row}>
          {state === "done" ? (
            <PixelDone size={12} />
          ) : state === "failed" ? (
            <PixelFail size={12} />
          ) : (
            <PixelStopped size={10} />
          )}
          <Text variant="footnote" tone="ink2" numberOfLines={1} style={[styles.semibold, styles.shrink]}>
            {endedText(t, task, meId)}
          </Text>
          <Text variant="footnote" tone="faint" style={styles.num}>
            {`· ${formatDuration(t, took)}`}
          </Text>
        </View>
      }
      working={false}
      request={taskSubline(t, { ...task, requester: null, plan: null }, meId, title)}
      steps={{ calls: 0, live: false }}
      stop={null}
      stopNote={null}
    />
  );
}

/** The screen both kinds share: the head, who asked, the steps, the line and the red row. */
function Page({
  task,
  title,
  state,
  working,
  request,
  steps,
  line = null,
  stop,
  stopNote,
}: {
  task: Pick<ManagedTask, "runId" | "agentId" | "channelId" | "threadId" | "background" | "betweenAgents"> & {
    requester?: ManagedTask["requester"];
  };
  title: string;
  /** How it stands, under the agent's name. */
  state: ReactNode;
  working: boolean;
  /** Where it is and who asked ("#produto · Ana pediu"). */
  request: string;
  steps: { calls: number; live: boolean };
  /** It waits for room on this computer: its row opens its line (`QueueSheet`). */
  line?: string | null;
  /** Asks and stops it; null when this person can't, or it is already stopping. */
  stop: (() => void) | null;
  /** Under the red row: stopping a delegated task tells the agent that asked. */
  stopNote: string | null;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const insets = useSafeAreaInsets();
  const openQueue = useOpenQueue();
  const agent = dir.anyAgent(task.agentId);
  const requester = task.requester ?? null;
  const opens = !(task.background || task.betweenAgents);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader title={title} solid={false} grouped />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
      >
        {/* Whose it is and how it stands, on one head: the title is already in the bar. */}
        <View style={styles.head}>
          <OpensAgent agentId={task.agentId}>
            <AgentFace agentId={task.agentId} size={36} mode={working ? "run" : "idle"} />
          </OpensAgent>
          <View style={styles.grow}>
            <Text variant="title" numberOfLines={1}>
              {agent?.name ?? t("channel.unknownAgent")}
            </Text>
            {state}
          </View>
        </View>
        {request ? (
          <>
            <GroupedHeader>{t("mobile.taskManager.request")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                leading={
                  requester ? (
                    <Face who={{ type: "person", id: requester.userId }} size={28} />
                  ) : (
                    <AgentFace agentId={task.agentId} size={28} live={false} />
                  )
                }
                label={request}
                labelLines={2}
                {...(opens
                  ? { chevron: true, onPress: () => router.push(chatHref(task.channelId, task.threadId)) }
                  : {})}
              />
            </GroupedList>
          </>
        ) : null}
        <Section title={t("taskManager.panel.steps")}>
          <RunSteps runId={task.runId} color={agentLook(agent).color} calls={steps.calls} live={steps.live} />
        </Section>
        {line ? (
          <View style={styles.apart}>
            <GroupedList>
              <GroupedRow icon="laptop" label={t("taskManager.queue.see")} chevron onPress={() => openQueue(line)} />
            </GroupedList>
          </View>
        ) : null}
        {stop ? (
          <View style={styles.apart}>
            <GroupedList>
              <GroupedRow label={t("taskManager.actions.stopTask")} danger onPress={stop} />
            </GroupedList>
            {stopNote ? (
              <Text variant="footnote" tone="faint" style={styles.note}>
                {stopNote}
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  grow: { flex: 1, minWidth: 0, gap: 2 },
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  scroll: { paddingTop: 4, paddingHorizontal: SCREEN_X },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 12, paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  semibold: { fontWeight: weights.semibold },
  num: { fontVariant: ["tabular-nums"] },
  apart: { marginTop: 24 },
  note: { paddingTop: 8, paddingHorizontal: 16 },
});

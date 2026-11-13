import { type ManagedTask, useContinueTasks } from "@agenteschat/client";
import { type TaskWaitGroup, taskTime, taskWaitGroups, taskWaitGroupText } from "@agenteschat/client/lib/task-manager";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  Button,
  fieldText,
  Icon,
  MEDIA_ROW,
  MediaRow,
  PixelOrbit,
  PixelStop,
  PixelStopped,
  Text,
  useReducedMotion,
  weights,
} from "@/ui";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { isHeld, type RowState, taskStateWords } from "./logic";

/**
 * The pieces the task manager's list, a task's screen and an agent's tasks share (ADR 0128): a task's mark and state,
 * its "Parar", and the confirmation that stopping several asks for.
 */

/** A reason's length at most: the server's (ADR 0128). */
const REASON_MAX = 500;

/** A task mark's glyph; its box is 4 pt wider, so a clock's corners aren't cut. */
const MARK = 12;

/** A task's mark: the agent's orbit while it works, the waiting clock (amber: it waits on you), queued, stopping. */
export function TaskMark({ state, color, size = MARK }: { state: RowState; color: AgentColorName; size?: number }) {
  const c = useColors();
  return (
    <View style={[styles.mark, { width: size + 4, height: size + 4 }]}>
      {state === "working" ? (
        <PixelOrbit color={color} size={size} />
      ) : state === "stopping" ? (
        <PixelStopped size={size} />
      ) : state === "queued" || isHeld(state) ? (
        <Icon name="clock" size={size + 1} color={c.faint} />
      ) : (
        <Icon name="wait" size={size + 1} color={c.amber} />
      )}
    </View>
  );
}

/** The agent's color, for its orbit. */
export function useAgentColor(agentId: string): AgentColorName {
  return agentLook(useDirectory().anyAgent(agentId)).color;
}

/**
 * "Trabalhando · 6:12", "Espera seu ok · 18 min" (amber: it waits on a person), "Parando…"; a wait wraps whole, with
 * what comes next under it ("Volta sáb às 18:00", or when it should start in the computer's line).
 */
export function StateLine({ task, state, now }: { task: ManagedTask; state: RowState; now: number }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const color = useAgentColor(task.agentId);
  const waits = state === "ok" || state === "answer";
  const words = taskStateWords(t, i18n.language, task, state, now);
  const line = (
    <View style={styles.row}>
      <TaskMark state={state} color={color} />
      <Text variant="footnote" style={[styles.semibold, styles.shrink, { color: waits ? c.amber : c.ink2 }]}>
        {words.state}
      </Text>
      {state === "stopping" ? null : (
        <Text variant="caption" tone="faint" style={styles.num}>
          · {taskTime(t, task, now)}
        </Text>
      )}
    </View>
  );
  if (!words.next) return line;
  return (
    <View style={styles.stack}>
      {line}
      <Text variant="caption" tone="faint" style={styles.starts}>
        {words.next}
      </Text>
    </View>
  );
}

/** The lines over several tasks waiting on the same limit. */
export function WaitLines({ tasks, now }: { tasks: ManagedTask[]; now: number }) {
  return taskWaitGroups(tasks).map((group) => <WaitLine key={group.key} group={group} now={now} />);
}

/**
 * Why they wait, once, and Continuar agora on a pause for who may press it (the pause card's rule): nobody else sees
 * the button.
 */
function WaitLine({ group, now }: { group: TaskWaitGroup; now: number }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const failed = useFailed();
  const go = useContinueTasks(orgId);
  return (
    <View style={styles.waitLine}>
      <Text variant="subhead" tone="muted">
        {taskWaitGroupText(t, i18n.language, group, now)}
      </Text>
      {group.continuable.length > 0 ? (
        <Button
          variant="primary"
          size="sm"
          label={t("usageCard.continue")}
          loading={go.isPending}
          onPress={() => go.mutate(group.continuable, { onError: failed })}
        />
      ) : null}
    </View>
  );
}

/**
 * A task's "Parar": one tap, nothing asked (what it did stays, and the agent is told); a spinner while it stops.
 * `compact`: only the stop square on a round plate (the agent's list, where the word crowds the title).
 */
export function StopButton({
  label,
  stopping,
  onPress,
  compact = false,
}: {
  label: string;
  stopping: boolean;
  onPress: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const reduced = useReducedMotion();
  // The spinner fades in over the button it stands in for, rather than popping.
  if (stopping)
    return (
      <Animated.View
        entering={reduced ? undefined : FadeIn.duration(160)}
        style={compact ? styles.stoppingCompact : styles.stopping}
        accessible
        accessibilityLabel={t("taskManager.state.stopping")}
      >
        <ActivityIndicator size="small" color={c.muted} />
      </Animated.View>
    );
  if (compact)
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        hitSlop={8}
        style={({ pressed }) => [styles.stopCompact, { backgroundColor: c.plate }, pressed && styles.pressed]}
      >
        <PixelStop size={10} color={c.ink} moving={false} />
      </Pressable>
    );
  return (
    <Button
      variant="secondary"
      size="sm"
      label={label}
      leading={(color) => <PixelStop size={10} color={color} moving={false} />}
      onPress={onPress}
    />
  );
}

/** The optional "why" the agent reads when it is stopped. */
export function ReasonField({
  value,
  onChange,
  placeholder,
  autoFocus = false,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const c = useColors();
  return (
    <View style={[styles.field, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={placeholder}
        style={[fieldText("subhead"), styles.input, { color: c.ink }]}
        maxLength={REASON_MAX}
        autoFocus={autoFocus}
        returnKeyType="done"
      />
    </View>
  );
}

/**
 * Stopping several of an agent's tasks asks first, in place (never a floating card): how many and whose, that the
 * agent is told, an optional reason it reads, Cancelar and "Parar N".
 */
export function StopConfirm({
  agentId,
  count,
  helpers = 0,
  onCancel,
  onStop,
}: {
  agentId: string;
  count: number;
  /** One task and the agents it asked, stopped together. */
  helpers?: number;
  onCancel: () => void;
  onStop: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const [why, setWhy] = useState("");
  const name = dir.nameOf({ type: "agent", id: agentId }) || t("channel.unknownAgent");
  return (
    <View style={styles.confirm} accessibilityRole="alert">
      <MediaRow
        size="row"
        face={<AgentFace agentId={agentId} size={MEDIA_ROW.row.face} live={false} />}
        name={
          helpers
            ? t("taskManager.confirm.chainTitle", { count: helpers, name })
            : t("taskManager.confirm.title", { count, name })
        }
      >
        <Text variant="footnote" tone="muted">
          {helpers ? t("taskManager.confirm.chainBody") : t("taskManager.confirm.short", { name })}
        </Text>
      </MediaRow>
      <View style={styles.confirmRow}>
        <View style={styles.grow}>
          <ReasonField value={why} onChange={setWhy} placeholder={t("taskManager.confirm.reason")} />
        </View>
        <Button variant="ghost" size="sm" label={t("mobile.common.cancel")} onPress={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label={t("taskManager.confirm.stop", { count: count + helpers })}
          leading={(color) => <PixelStop size={10} color={color} moving={false} />}
          onPress={() => onStop(why)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  semibold: { fontWeight: weights.semibold },
  shrink: { flexShrink: 1 },
  grow: { flex: 1, minWidth: 0 },
  num: { fontVariant: ["tabular-nums"], flexShrink: 0 },
  stack: { gap: 2, minWidth: 0 },
  // Under the state's words: past its mark's box and the row's gap.
  starts: { marginLeft: MARK + 4 + 6 },
  // Said once over the tasks it holds: a line on the 16 margin, never a plate.
  waitLine: { gap: 8, alignItems: "flex-start", paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  // As tall as the button it stands in for, so the row doesn't move.
  stopping: { minWidth: 36, height: 36, alignItems: "center", justifyContent: "center" },
  stopCompact: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  stoppingCompact: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.6 },
  field: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, minHeight: 36 },
  input: { paddingVertical: 8 },
  confirm: { gap: 10 },
  confirmRow: { flexDirection: "row", alignItems: "center", gap: 8 },
});

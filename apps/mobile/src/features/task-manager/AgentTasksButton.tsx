import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Count, Icon, PressScale } from "@/ui";
import { useColors, useDirectory } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { useAgentTasks } from "./hooks";
import { type AgentTaskView, tasksBadge } from "./logic";
import { TaskMark, useAgentColor } from "./parts";

/** While an agent's DM is open its tasks are asked again this often (its work there also comes live). */
const DM_POLL_MS = 5_000;

/** An agent's tasks for its DM's header: null while it has none (or for no agent). */
export function useDmAgentTasks(agentId: string | null) {
  return useAgentTasks(agentId, { pollMs: DM_POLL_MS }).view;
}

/**
 * An agent's tasks in its DM's header (ADR 0128), beside its computer: the orbit while it works (the waiting mark
 * while it only waits on you) and how many tasks it has, with how many wait on you when some also work. A tap opens
 * the agent's tasks, pushed, the way a thread opens.
 */
export function AgentTasksButton({
  agentId,
  view,
  onPress,
}: {
  agentId: string;
  view: AgentTaskView;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const color = useAgentColor(agentId);
  const badge = tasksBadge(view);
  const name = dir.nameOf({ type: "agent", id: agentId }) || t("channel.unknownAgent");
  const waiting = view.waiting > 0 ? t("taskManager.waiting", { count: view.waiting }) : null;
  const label = [t("taskManager.strip.tasks", { name, count: badge.count }), waiting].filter(Boolean).join(", ");
  return (
    <PressScale
      to={0.9}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={styles.button}
    >
      <View style={styles.row}>
        <TaskMark state={badge.mark} color={color} size={13} />
        <Count value={badge.count} size={15} color={c.ink2} />
        {badge.waiting !== null ? (
          <>
            <View style={styles.gap} />
            <Icon name="wait" size={12} color={c.amber} />
            <Count value={badge.waiting} size={15} color={c.amber} />
          </>
        ) : null}
      </View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  // As tall and round as the bar's other buttons.
  button: { height: 40, borderRadius: 20 },
  row: { flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10 },
  gap: { width: 4 },
});

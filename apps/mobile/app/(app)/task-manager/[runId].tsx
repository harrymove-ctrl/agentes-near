import { Redirect, useLocalSearchParams } from "expo-router";
import { isSafeId } from "@/features/shared/logic";
import { FocusLive } from "@/features/shared/parts";
import { TaskScreen } from "@/features/task-manager/TaskScreen";

/** One task (`/task-manager/<runId>`): from the task manager's list or an agent's tasks (ADR 0128). */
export default function TaskRoute() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  if (!isSafeId(runId)) return <Redirect href="/task-manager" />;
  return (
    <FocusLive>
      <TaskScreen key={runId} runId={runId} />
    </FocusLive>
  );
}

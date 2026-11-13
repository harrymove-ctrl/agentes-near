import { Redirect, useLocalSearchParams } from "expo-router";
import { isSafeId } from "@/features/shared/logic";
import { AgentTasksScreen } from "@/features/task-manager/AgentTasksScreen";

/**
 * An agent's tasks (`/agent-tasks/<agentId>?channel=…&thread=…`), pushed from its DM's header (ADR 0128): the
 * conversation it came from tags its tasks there.
 */
export default function AgentTasksRoute() {
  const { agentId, channel, thread } = useLocalSearchParams<{ agentId: string; channel?: string; thread?: string }>();
  if (!isSafeId(agentId)) return <Redirect href="/task-manager" />;
  const from = isSafeId(channel) ? { channelId: channel, threadId: isSafeId(thread) ? thread : null } : null;
  return <AgentTasksScreen key={agentId} agentId={agentId} from={from} />;
}

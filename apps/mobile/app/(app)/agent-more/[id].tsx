import { useLocalSearchParams } from "expo-router";
import { AgentMoreScreen } from "@/features/agents/AgentMoreScreen";

/** A personal workspace's agent: its Advanced (ADR 0159 §3), what one person rarely needs, still all there. */
export default function AgentMoreRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentMoreScreen agentId={id ?? ""} />;
}

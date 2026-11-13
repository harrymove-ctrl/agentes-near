import { useLocalSearchParams } from "expo-router";
import { AgentAiScreen } from "@/features/ai/AgentAiScreen";

/** An agent's AI ("Pensa com" on its profile): the account it thinks with, its plan's usage, who it replies to. */
export default function AgentAiRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentAiScreen agentId={id ?? ""} />;
}

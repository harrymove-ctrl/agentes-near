import { useLocalSearchParams } from "expo-router";
import { AgentSetupScreen } from "@/features/ai/AgentSetupScreen";

/** "Usar em outros agentes" (from "Pensa com"): the agent's setup on the other agents picked. */
export default function AgentSetupRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentSetupScreen agentId={id ?? ""} />;
}

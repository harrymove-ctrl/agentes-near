import { useLocalSearchParams } from "expo-router";
import { AgentAdvancedScreen } from "@/features/ai/AgentAdvancedScreen";

/** An agent's advanced settings ("Configuração avançada" on "Pensa com"): its context window. */
export default function AgentAdvancedRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentAdvancedScreen agentId={id ?? ""} />;
}

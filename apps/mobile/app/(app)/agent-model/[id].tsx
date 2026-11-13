import { useLocalSearchParams } from "expo-router";
import { AgentModelScreen } from "@/features/ai/AgentAiScreen";

/** An agent's model ("Modelo" on its AI): Automático or one of its brain's models. */
export default function AgentModelRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentModelScreen agentId={id ?? ""} />;
}

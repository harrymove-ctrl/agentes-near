import { useLocalSearchParams } from "expo-router";
import { AgentEditScreen } from "@/features/agents/AgentEditScreen";

/** "Editar agente" (`?id=`). */
export default function AgentEditRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentEditScreen key={id} id={id} />;
}

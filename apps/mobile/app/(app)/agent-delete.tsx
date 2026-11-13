import { useLocalSearchParams } from "expo-router";
import { DeleteAgentScreen } from "@/features/agents/DeleteAgentScreen";

/** "Apagar agente" (`?id=`), pushed over "Editar agente" or, with `?proposal=`, from a removal card's row. */
export default function AgentDeleteRoute() {
  const { id, proposal } = useLocalSearchParams<{ id: string; proposal?: string }>();
  return <DeleteAgentScreen key={id} id={id} proposal={proposal} />;
}

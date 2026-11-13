import { useLocalSearchParams } from "expo-router";
import { AgentProfileScreen } from "@/features/agents/AgentProfileScreen";
import { FocusLive } from "@/features/shared/parts";

/** An agent's profile. */
export default function AgentRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <FocusLive>
      <AgentProfileScreen key={id} id={id} />
    </FocusLive>
  );
}

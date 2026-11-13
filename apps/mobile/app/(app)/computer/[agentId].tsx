import { useLocalSearchParams } from "expo-router";
import { ComputerScreen } from "@/features/computer/ComputerScreen";
import { FocusLive } from "@/features/shared/parts";

/** An agent's computer, full screen (presentation set in `_layout`; from its profile's Computador). */
export default function ComputerRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  return (
    <FocusLive>
      <ComputerScreen key={agentId} agentId={agentId} />
    </FocusLive>
  );
}

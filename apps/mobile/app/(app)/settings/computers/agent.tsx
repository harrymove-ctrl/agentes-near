import { useLocalSearchParams } from "expo-router";
import { AgentComputerScreen } from "@/features/settings/ComputersScreen";

/** Which computer an agent (`agentId`) uses, pushed over Computadores. */
export default function SettingsAgentComputerRoute() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  return <AgentComputerScreen agentId={agentId ?? ""} />;
}

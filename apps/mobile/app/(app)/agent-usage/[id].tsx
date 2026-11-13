import { useLocalSearchParams } from "expo-router";
import { AgentUsageScreen } from "@/features/usage/AgentUsageScreen";

/** An agent's Uso, as the web's agent tab: the month, the account it thinks with now, the month by account. */
export default function AgentUsageRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentUsageScreen agentId={id ?? ""} />;
}

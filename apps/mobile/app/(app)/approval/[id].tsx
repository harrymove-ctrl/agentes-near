import { useLocalSearchParams } from "expo-router";
import { ApprovalSheet } from "@/features/approvals/ApprovalSheet";
import { goBack } from "@/features/shared/parts";

/**
 * A request to approve, as a native form sheet over whatever is on screen (presentation set in
 * `_layout`; deep link `agenteschat://approval/<id>`).
 */
export default function ApprovalRoute() {
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: string }>();
  return <ApprovalSheet id={id} refuse={mode === "refuse"} onClose={goBack} />;
}

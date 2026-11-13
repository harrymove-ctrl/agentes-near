import { useLocalSearchParams } from "expo-router";
import { SwitchComputerSheet } from "@/features/outages/SwitchComputerSheet";
import { goBack } from "@/features/shared/parts";

/**
 * "Trocar o computador" for a computer that went offline, as a native form sheet over whatever is on screen
 * (presentation set in `_layout`; from the notice on Conversas and the waiting card in a chat).
 */
export default function SwitchComputerRoute() {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  return <SwitchComputerSheet machineId={machineId} onClose={goBack} />;
}

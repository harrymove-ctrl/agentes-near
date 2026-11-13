import { useLocalSearchParams } from "expo-router";
import { MachineScreen } from "@/features/settings/MachineScreen";

/** One computer (`machineId`), pushed over Computadores. */
export default function SettingsMachineRoute() {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  return <MachineScreen machineId={machineId ?? ""} />;
}

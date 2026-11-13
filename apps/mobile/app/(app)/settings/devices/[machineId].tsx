import { useLocalSearchParams } from "expo-router";
import { MachineScreen } from "@/features/settings/MachineScreen";

/** One computer (`machineId`), pushed over Dispositivos. */
export default function SettingsDeviceRoute() {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  return <MachineScreen machineId={machineId ?? ""} />;
}

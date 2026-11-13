import { useLocalSearchParams } from "expo-router";
import { RenameMachineScreen } from "@/features/settings/MachineScreen";

/** Renomear a computer (`machineId`), pushed over its page. */
export default function SettingsRenameMachineRoute() {
  const { machineId } = useLocalSearchParams<{ machineId: string }>();
  return <RenameMachineScreen machineId={machineId ?? ""} />;
}

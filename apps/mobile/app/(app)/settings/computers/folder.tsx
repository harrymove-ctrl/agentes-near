import { useLocalSearchParams } from "expo-router";
import { FolderScreen } from "@/features/settings/MachineScreen";

/** A folder (`path`) a computer (`machineId`) allows, pushed over its page. */
export default function SettingsMachineFolderRoute() {
  const { machineId, path } = useLocalSearchParams<{ machineId: string; path: string }>();
  return <FolderScreen machineId={machineId ?? ""} path={path ?? ""} />;
}

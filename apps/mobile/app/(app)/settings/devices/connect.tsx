import { useLocalSearchParams } from "expo-router";
import { ConnectScreen } from "@/features/devices/ConnectScreen";
import { connectKindOf } from "@/features/devices/logic";

/** "Conectar um dispositivo": what to connect, then another computer's app or a one-line link (`?kind=`). */
export default function SettingsConnectDeviceRoute() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  return <ConnectScreen kind={connectKindOf(kind)} />;
}

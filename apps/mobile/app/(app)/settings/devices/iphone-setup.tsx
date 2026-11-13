import { useLocalSearchParams } from "expo-router";
import { IphoneSetupScreen } from "@/features/devices/IphoneSetupScreen";

/** "Conectar este iPhone" (`?machine=`: the Mac it plugs into); the Mac's QR code opens it too. */
export default function SettingsIphoneSetupRoute() {
  // The web's QR names the computer `computer`; the phone's own links name it `machine`.
  const { machine, computer } = useLocalSearchParams<{ machine?: string; computer?: string }>();
  const id = typeof machine === "string" ? machine : typeof computer === "string" ? computer : undefined;
  return <IphoneSetupScreen machineId={id} />;
}

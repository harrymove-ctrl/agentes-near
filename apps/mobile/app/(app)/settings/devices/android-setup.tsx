import { useLocalSearchParams } from "expo-router";
import { AndroidSetupScreen } from "@/features/devices/AndroidSetupScreen";

/**
 * "Deixar agentes usarem este celular" (`?machine=`: the computer it plugs into). Also what the web's QR code opens:
 * `agenteschat://settings/devices/android-setup` or the website's `/org/<id>/settings/devices/android-setup`.
 */
export default function SettingsAndroidSetupRoute() {
  // The web's QR names the computer `computer`; the phone's own links name it `machine`.
  const { machine, computer } = useLocalSearchParams<{ machine?: string; computer?: string }>();
  const id = typeof machine === "string" ? machine : typeof computer === "string" ? computer : undefined;
  return <AndroidSetupScreen machineId={id} />;
}

import { useLocalSearchParams } from "expo-router";
import { PhoneScreen } from "@/features/devices/PhoneScreen";

/** One phone (`phoneId`), reached through a computer. */
export default function SettingsPhoneRoute() {
  const { phoneId } = useLocalSearchParams<{ phoneId: string }>();
  return <PhoneScreen phoneId={phoneId ?? ""} />;
}

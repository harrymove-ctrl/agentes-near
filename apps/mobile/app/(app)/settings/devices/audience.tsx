import { useLocalSearchParams } from "expo-router";
import { DeviceAudienceScreen } from "@/features/devices/AudienceScreen";

/** "Quem pode usar" a computer or a phone (`?id=`). */
export default function SettingsDeviceAudienceRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DeviceAudienceScreen deviceId={id ?? ""} />;
}

import { Redirect } from "expo-router";

/** Configurações › Computadores became Dispositivos: old links land there. */
export default function SettingsComputersRoute() {
  return <Redirect href="/settings/devices" />;
}

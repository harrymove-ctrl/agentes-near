export interface NetworkInfo extends EventTarget {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}
export const networkInfo = () => (navigator as Navigator & { connection?: NetworkInfo }).connection;
export function desktopEncoding(
  control: boolean,
  network?: Pick<NetworkInfo, "saveData" | "effectiveType" | "downlink" | "rtt">,
) {
  const slow =
    network?.saveData ||
    ["slow-2g", "2g"].includes(network?.effectiveType ?? "") ||
    (network?.downlink !== undefined && network.downlink < 1) ||
    (network?.rtt !== undefined && network.rtt >= 300);
  return { quality: slow ? (control ? 3 : 1) : control ? 6 : 3, compression: slow ? 6 : 2 };
}

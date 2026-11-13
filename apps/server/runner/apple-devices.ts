import net from "node:net";
import type { PhoneReason, RunnerPhone, WifiIphone } from "@agenteschat/adapters/machine-protocol";
import { udidKey } from "./usbmux";

/**
 * iPhones a Mac reaches (bring your own devices): real ones from `xcrun devicectl list devices --json-output`
 * (every device ever paired is listed; only one reachable now counts), booted simulators from
 * `xcrun simctl list devices booted -j`.
 */

type Phone = Omit<RunnerPhone, "holder">;

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as never) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The major version of "17.4.1"; 0 when unknown. */
export const majorOf = (version: string) => Number.parseInt(version, 10) || 0;

/** The first iOS that CoreDevice (devicectl, Xcode's test runs on a phone) drives. */
export const IOS_MIN = 17;

/** An iPhone devicectl lists but can't drive: iOS before 17, reached through the old MobileDevice only. */
const tooOld = (d: unknown) => {
  const os = majorOf(str(rec(rec(d).deviceProperties).osVersionNumber));
  // The version decides when devicectl gives one: a flag alone never turns a working iPhone away.
  return os > 0 ? os < IOS_MIN : rec(rec(d).connectionProperties).isMobileDeviceOnly === true;
};

const devicesOf = (json: unknown) => {
  const devices = rec(rec(rec(json).result)).devices;
  return Array.isArray(devices) ? devices : [];
};

/** An iPhone too old for devicectl that it doesn't say is plugged in: usbmuxd's list says whether it is. */
export const needsUsbList = (json: unknown) =>
  devicesOf(json).some((d) => str(rec(rec(d).connectionProperties).transportType) !== "wired" && tooOld(d));

const serialOf = (d: unknown) => str(rec(rec(d).hardwareProperties).udid) || str(rec(d).identifier);
const realIphone = (d: unknown) => {
  const hw = rec(rec(d).hardwareProperties);
  return str(hw.platform) === "iOS" && str(hw.reality) !== "virtual" && serialOf(d) !== "";
};

/**
 * `usb`: the UDIDs usbmuxd has over a cable (`udidKey`), for phones devicectl doesn't say are wired. `wifi`: the
 * UDIDs this Mac's owner picked to use over Wi-Fi (`udidKey`).
 */
export function parseDevicectl(
  json: unknown,
  usb: ReadonlySet<string> = new Set(),
  wifi: ReadonlySet<string> = new Set(),
): Phone[] {
  const out: Phone[] = [];
  for (const d of devicesOf(json)) {
    const hw = rec(rec(d).hardwareProperties);
    const conn = rec(rec(d).connectionProperties);
    const props = rec(rec(d).deviceProperties);
    if (!realIphone(d)) continue;
    const serial = serialOf(d);
    const wired = str(conn.transportType) === "wired" || (tooOld(d) && usb.has(udidKey(serial)));
    // Only a phone plugged into this Mac, or one its owner picked to use over Wi-Fi, counts: every iPhone ever paired
    // with Xcode (a family member's, a colleague's) shows up over the network whenever it is near.
    const overWifi = !wired && wifi.has(udidKey(serial));
    if (!wired && !overWifi) continue;
    const name = str(props.name);
    const phone: Phone = {
      platform: "ios",
      serial,
      kind: "device",
      model: str(hw.marketingName) || str(hw.productType) || "iPhone",
      ...(name ? { name } : {}),
      osVersion: str(props.osVersionNumber),
      state: "ready",
      transport: overWifi ? "wifi" : "usb",
    };
    if (tooOld(d)) Object.assign(phone, { state: "unsupported", reason: "os_too_old" });
    else if (str(conn.pairingState) !== "paired")
      Object.assign(phone, { state: "needs_you", reason: overWifi ? "wifi_untrusted" : "untrusted" });
    else if (overWifi && str(conn.transportType) !== "localNetwork")
      Object.assign(phone, { state: "needs_you", reason: "wifi_away" });
    else if (str(props.developerModeStatus) === "disabled") {
      Object.assign(phone, { state: "needs_you", reason: "developer_mode_off" });
    }
    out.push(phone);
  }
  return out;
}

/**
 * The iPhones on this Mac's network that trust it (paired, iOS 17 or newer), not plugged in and not in `used`
 * (`udidKey`): offered to use over Wi-Fi, never used until picked.
 */
export function wifiNearby(json: unknown, used: ReadonlySet<string> = new Set()): WifiIphone[] {
  const out: WifiIphone[] = [];
  for (const d of devicesOf(json)) {
    const conn = rec(rec(d).connectionProperties);
    const props = rec(rec(d).deviceProperties);
    if (!realIphone(d) || tooOld(d) || used.has(udidKey(serialOf(d)))) continue;
    if (str(conn.transportType) !== "localNetwork" || str(conn.pairingState) !== "paired") continue;
    const hw = rec(rec(d).hardwareProperties);
    const name = str(props.name);
    out.push({
      serial: serialOf(d),
      model: str(hw.marketingName) || str(hw.productType) || "iPhone",
      ...(name ? { name } : {}),
      osVersion: str(props.osVersionNumber),
    });
  }
  return out;
}

type Interfaces = Partial<Record<string, { address: string; family: string | number }[]>>;

/** CoreDevice's tunnel addresses are unique local IPv6 (fd00::/8), never a network's. */
const UNIQUE_LOCAL = new net.BlockList();
UNIQUE_LOCAL.addSubnet("fd00::", 8, "ipv6");

/**
 * The phone's end of CoreDevice's tunnel (`devicectl device info details --json-output`), checked: the tunnel is up,
 * and its address is unique local and on a `/64` this Mac has on one of its own `utun` interfaces
 * (`os.networkInterfaces()`), so only this Mac reaches it. Anything less is a reason, never another address. A phone
 * that didn't answer reads `tunnelState: "unavailable"` with no transport at all. `local`: this Mac's own end.
 */
export function tunnelOf(
  json: unknown,
  interfaces: Interfaces,
): { address: string; local: string } | { reason: PhoneReason } {
  const d = rec(rec(json).result);
  const conn = rec(d.connectionProperties);
  if (str(conn.pairingState) !== "paired") return { reason: "wifi_untrusted" };
  if (str(conn.tunnelState) !== "connected") return { reason: "wifi_asleep" };
  const raw = str(conn.tunnelIPAddress);
  if (net.isIPv6(raw) !== true || !UNIQUE_LOCAL.check(raw, "ipv6")) return { reason: "tunnel_down" };
  // The spelling WDA's listener and a URL both take: lower case, zeros compressed.
  const address = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  const ours = Object.entries(interfaces).flatMap(([name, list]) =>
    name.startsWith("utun")
      ? (list ?? []).filter((a) => (a.family === "IPv6" || a.family === 6) && a.address !== address)
      : [],
  );
  const local = ours
    .map((a) => a.address.split("%")[0] as string)
    .find((a) => {
      const subnet = new net.BlockList();
      subnet.addSubnet(a, 64, "ipv6");
      return subnet.check(address, "ipv6");
    });
  return local ? { address, local } : { reason: "tunnel_down" };
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-2` → `26.2`; null for watchOS, tvOS and visionOS. */
const iosRuntime = (key: string) => /\.SimRuntime\.iOS-([\d-]+)$/.exec(key)?.[1]?.replace(/-/g, ".") ?? null;

export function parseSimctl(json: unknown): Phone[] {
  const out: Phone[] = [];
  for (const [runtime, list] of Object.entries(rec(rec(json).devices))) {
    const osVersion = iosRuntime(runtime);
    if (osVersion === null || !Array.isArray(list)) continue;
    for (const d of list) {
      const s = rec(d);
      if (str(s.state) !== "Booted" || !str(s.udid)) continue;
      const model =
        /SimDeviceType\.(.+)$/
          .exec(str(s.deviceTypeIdentifier))?.[1]
          ?.replace(/-/g, " ")
          .replace(/(\d) (\d)/g, "$1.$2") ?? "iPhone";
      const name = str(s.name);
      out.push({
        platform: "ios",
        serial: str(s.udid),
        kind: "simulator",
        model,
        ...(name && name !== model ? { name } : {}),
        osVersion,
        state: "ready",
        transport: "local",
      });
    }
  }
  return out;
}

/** The phone's iOS is newer than the Mac's iPhone SDK (`xcrun --sdk iphoneos --show-sdk-version`) can drive. */
export const sdkTooOld = (osVersion: string, sdk: string | null) =>
  sdk !== null && majorOf(sdk) > 0 && majorOf(osVersion) > majorOf(sdk);

/** `devicectl device info lockState --json-output`: the phone asks for its passcode now; null when unread. */
export function parseLockState(json: unknown): boolean | null {
  const v = rec(rec(json).result).passcodeRequired;
  return typeof v === "boolean" ? v : null;
}

/** devicectl's error text for what the person must do on the iPhone, in words; null for anything else. */
export function appleNeedsYou(text: string): string | null {
  if (/explicitly trusted|Untrusted Developer|profile has not been/i.test(text)) {
    return "On the iPhone: Settings › General › VPN & Device Management, tap the developer, then Trust.";
  }
  if (/developer mode/i.test(text)) {
    return "Developer Mode is off on the iPhone: Settings › Privacy & Security › Developer Mode, then restart it.";
  }
  if (/\block(ed)?\b|passcode|could not be, unlocked/i.test(text))
    return "The iPhone is locked. Unlock it and try again.";
  return null;
}

/** An app's bundle id as the tools take it (never reaches a shell, but a predicate). */
export const APPLE_APP = /^[A-Za-z0-9][\w.-]*$/;

import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { PhoneKind, PhoneReason, PhoneState, RunnerPhone } from "@agenteschat/adapters/machine-protocol";

/**
 * Android phones through `adb` (bring your own devices): which `adb` to use, what `adb devices -l` and one
 * `adb shell` reading of a phone say. The runner never runs `kill-server` and never starts a second server:
 * another client version restarts the running one ("server version doesn't match this client; killing…"),
 * which would drop the developer's own devices, so the binary of the server already running wins.
 */

/** Where an Android SDK may be: the environment, then the installers' default folders. */
export function sdkRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (platform === "darwin") roots.push(path.join(home, "Library", "Android", "sdk"));
  else if (platform === "win32")
    roots.push(path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Android", "Sdk"));
  else roots.push(path.join(home, "Android", "Sdk"));
  return roots.filter((r): r is string => typeof r === "string" && r.trim() !== "");
}

/** The first SDK folder that exists. */
export const findSdk = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string) =>
  sdkRoots(env, platform, home).find((r) => existsSync(r)) ?? null;

/** `adb` from an SDK's platform-tools, else the first on `dirs` (the PATH). */
export function findAdb(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, dirs: string[]) {
  const exe = platform === "win32" ? "adb.exe" : "adb";
  for (const root of sdkRoots(env, platform, home)) {
    const file = path.join(root, "platform-tools", exe);
    if (existsSync(file)) return file;
  }
  for (const dir of dirs) if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  return null;
}

/**
 * The executable of the adb server listening on 5037, from its `host:server-status` answer (a protobuf whose field
 * 7 is `executable_absolute_path`). Null when none runs or it is too old to say.
 */
export function runningAdbServer(port = 5037, timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = Buffer.alloc(0);
    const done = (value: string | null) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.on("error", () => done(null));
    socket.on("connect", () => {
      const req = "host:server-status";
      socket.write(req.length.toString(16).padStart(4, "0") + req);
    });
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 8) return;
      if (data.subarray(0, 4).toString("latin1") !== "OKAY") return done(null);
      const size = Number.parseInt(data.subarray(4, 8).toString("latin1"), 16);
      if (data.length >= 8 + size) done(serverStatusPath(data.subarray(8, 8 + size)));
    });
    socket.on("end", () => done(null));
  });
}

/** Field 7 (a string) of adb's `AdbServerStatus` message. */
export function serverStatusPath(msg: Buffer): string | null {
  let at = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; at < msg.length && shift < 35; shift += 7) {
      const byte = msg[at++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
    return -1;
  };
  while (at < msg.length) {
    const key = varint();
    if (key < 0) return null;
    const type = key & 7;
    if (type === 0) varint();
    else if (type === 1) at += 8;
    else if (type === 5) at += 4;
    else if (type === 2) {
      const len = varint();
      if (len < 0 || at + len > msg.length) return null;
      if (key >>> 3 === 7) return msg.subarray(at, at + len).toString("utf8") || null;
      at += len;
    } else return null;
  }
  return null;
}

/** One line of `adb devices -l`. */
export interface AdbEntry {
  serial: string;
  /** `device`, `unauthorized`, `offline`, `no permissions`, `authorizing`, `recovery`… */
  state: string;
  /** `model:Pixel_8`, with spaces back. */
  model?: string;
}

export function parseAdbDevices(text: string): AdbEntry[] {
  const out: AdbEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [serial, word] = line.split(/\s+/);
    if (!serial || !word) continue;
    const model = /\bmodel:(\S+)/.exec(line)?.[1];
    out.push({
      serial,
      state: /\sno permissions\b/.test(line) ? "no permissions" : word,
      ...(model ? { model: model.replace(/_/g, " ") } : {}),
    });
  }
  return out;
}

export const androidKind = (serial: string): PhoneKind => (/^emulator-\d+$/.test(serial) ? "emulator" : "device");

export function androidTransport(serial: string): NonNullable<RunnerPhone["transport"]> {
  if (/^emulator-\d+$/.test(serial)) return "local";
  // `host:port` (adb connect) or an mDNS name (Wireless debugging paired in Android Studio).
  if (/:\d+$/.test(serial) || serial.includes("._adb-tls-connect._tcp")) return "wifi";
  return "usb";
}

/** What a state other than `device` means for the person. */
export function adbStateOf(state: string): { state: PhoneState; reason?: PhoneReason } {
  switch (state) {
    case "device":
      return { state: "ready" };
    case "unauthorized":
    case "authorizing":
      return { state: "needs_you", reason: "unauthorized" };
    // Linux without udev rules for the phone: the computer can't open it.
    case "no permissions":
      return { state: "needs_you", reason: "no_driver" };
    case "connecting":
      return { state: "preparing" };
    default:
      return { state: "needs_you", reason: "adb_offline" };
  }
}

/** One `adb shell` call that reads what `hello` says of a phone (`parseAndroidFacts`). */
export const FACTS_SHELL = [
  "model=ro.product.model",
  "market=ro.product.marketname",
  "release=ro.build.version.release",
  "sdk=ro.build.version.sdk",
  "abi=ro.product.cpu.abi",
  "boot=sys.boot_completed",
  "qemu=ro.boot.qemu",
  "qemu2=ro.kernel.qemu",
  "avd=ro.boot.qemu.avd_name",
  "serialno=ro.serialno",
  "patch=ro.build.version.security_patch",
]
  .map((p) => {
    const [k, prop] = p.split("=");
    return `echo "${k}=$(getprop ${prop})"`;
  })
  .concat(['echo "name=$(settings get global device_name)"', "wm size", "dumpsys battery"])
  .join("; ");

export interface AndroidFacts {
  model: string;
  osVersion: string;
  sdk: number;
  abi?: string;
  booted: boolean;
  emulator: boolean;
  /** The phone's own name (Settings › About phone › Device name), or the emulator's AVD. */
  name?: string;
  /** Its own serial (what a cable shows as adb's serial), which an adb serial over Wi-Fi isn't. */
  serialno?: string;
  /** Its security patch level, `2026-05-01`. */
  patch?: string;
  screen?: { width: number; height: number };
  power?: "ac" | "battery";
  battery?: number;
}

/** `Physical size: 1080x2400` (and `Override size:` when the person set one) from `wm size`. */
export function screenSizeOf(wmSize: string): { width: number; height: number } | null {
  const line = /Override size:\s*(\d+)x(\d+)/.exec(wmSize) ?? /Physical size:\s*(\d+)x(\d+)/.exec(wmSize);
  return line ? { width: Number(line[1]), height: Number(line[2]) } : null;
}

export function parseAndroidFacts(out: string): AndroidFacts {
  const val = (k: string) => {
    const v = new RegExp(`^${k}=(.*)$`, "m").exec(out)?.[1]?.trim() ?? "";
    return v === "null" ? "" : v;
  };
  const emulator = val("qemu") === "1" || val("qemu2") === "1";
  const avd = val("avd").replace(/_/g, " ");
  const powered = [...out.matchAll(/^\s*(?:AC|USB|Wireless|Dock) powered:\s*(true|false)/gm)].map((m) => m[1]);
  const level = /^\s*level:\s*(\d+)/m.exec(out)?.[1];
  const screen = screenSizeOf(out);
  const name = emulator ? avd : val("name");
  return {
    model: (emulator && avd) || val("market") || val("model") || "Android phone",
    osVersion: val("release"),
    sdk: Number(val("sdk")) || 0,
    ...(val("abi") ? { abi: val("abi") } : {}),
    booted: val("boot") === "1",
    emulator,
    ...(name && !emulator ? { name } : {}),
    ...(/^[\w.-]{1,100}$/.test(val("serialno")) ? { serialno: val("serialno") } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(val("patch")) ? { patch: val("patch") } : {}),
    ...(screen ? { screen } : {}),
    ...(powered.length > 0 ? { power: powered.includes("true") ? ("ac" as const) : ("battery" as const) } : {}),
    ...(level !== undefined ? { battery: Number(level) } : {}),
  };
}

/** Wakes the screen and lifts a lock screen without a PIN; `KEYGUARD_SHELL` then says whether one is left. */
export const WAKE_SHELL = "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard";
export const KEYGUARD_SHELL =
  "dumpsys window | grep -E 'mDreamingLockscreen|mShowingLockscreen|isStatusBarKeyguard'; dumpsys activity activities | grep -i keyguardshowing";
/** Whether `KEYGUARD_SHELL`'s output shows a lock screen (Android 8 to 16 name it differently); unknown reads unlocked. */
export const keyguardShowing = (out: string) =>
  /(?:mDreamingLockscreen|mShowingLockscreen|isStatusBarKeyguard|KeyguardShowing)=true/i.test(out);

/** An app id as adb's shell may take it: a package, or `package/.Activity`. Anything else never reaches a shell. */
export const ANDROID_APP = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+(\/[\w.$]+)?$/;

/** A PNG's size from its IHDR. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PNG in `screencap -p`'s output, past any text it printed first; the output itself when it has none. */
export function pngFrom(data: Buffer): Buffer {
  const at = data.indexOf(PNG_SIGNATURE);
  return at > 0 ? data.subarray(at) : data;
}

export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.subarray(12, 16).toString("latin1") !== "IHDR")
    return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/**
 * Windows lists a phone it has no USB driver for (a Pixel without Google's driver, a Galaxy without Samsung's) under
 * Other devices, and adb never sees it. PowerShell's PnP list of present USB devices with a driver problem, as JSON
 * (one object or an array; nothing when there is none). Read only.
 */
export const PNP_SHELL =
  "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'USB\\*' -and ($_.Status -ne 'OK' -or $_.ConfigManagerErrorCode -ne 0) } | Select-Object InstanceId,FriendlyName,Class,Status,ConfigManagerErrorCode | ConvertTo-Json -Compress";

/** USB vendor ids of phone makers whose phones may show up without a driver (Google, Samsung, Motorola, Xiaomi…). */
const PHONE_VENDORS = new Set([
  "18D1", // Google
  "04E8", // Samsung
  "22B8", // Motorola
  "2717", // Xiaomi
  "12D1", // Huawei
  "2A70", // OnePlus
  "22D9", // OPPO, realme
  "2D95", // vivo
  "0FCE", // Sony
  "0BB4", // HTC
  "19D2", // ZTE
  "2E04", // HMD (Nokia)
  "1004", // LG
]);
/** Classes Windows gives a device it has no driver for, or a phone's own (MTP, ADB). */
const UNKNOWN_CLASS = /^(|unknown|wpd|usbdevice|androidusbdeviceclass|adb)$/i;
const SAYS_ANDROID = /android|\badb\b/i;
/** A name that says what kind of device it is, not which phone ("ADB Interface", "SAMSUNG_Android", "MTP"). */
const GENERIC_NAME = /android|\badb\b|\bmtp\b|\busb\b|interface|composite|unknown/i;

/** A plugged phone Windows has no driver for: its USB serial (adb's own, once the driver is in) and model. */
export interface DriverlessPhone {
  serial: string;
  model: string;
}

/**
 * The phones in `PNP_SHELL`'s output: a USB device with a driver problem whose class or name says Android or ADB,
 * or one of a phone maker's in a class Windows gives a device it has no driver for. A phone's interfaces (MTP, ADB)
 * are one phone, by vendor and product id; its serial is the parent's `USB\VID_…&PID_…\<serial>`.
 */
export function driverlessPhones(json: string): DriverlessPhone[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json.trim() || "[]");
  } catch {
    return [];
  }
  const list = (Array.isArray(rows) ? rows : [rows]).filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
  );
  const byDevice = new Map<string, { serial: string | null; names: string[] }>();
  for (const r of list) {
    const id = typeof r.InstanceId === "string" ? r.InstanceId : "";
    const ids = /^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})[^\\]*\\(.+)$/i.exec(id);
    if (!ids) continue;
    const [, vid = "", pid = "", tail = ""] = ids;
    const name = typeof r.FriendlyName === "string" ? r.FriendlyName.trim() : "";
    const cls = typeof r.Class === "string" ? r.Class.trim() : "";
    const android = SAYS_ANDROID.test(name) || SAYS_ANDROID.test(cls);
    if (!android && !(PHONE_VENDORS.has(vid.toUpperCase()) && UNKNOWN_CLASS.test(cls))) continue;
    const key = `${vid}:${pid}`.toUpperCase();
    const had = byDevice.get(key) ?? { serial: null, names: [] };
    // An interface's own id (`6&2a3b4c&0&0001`) isn't the phone's serial.
    if (!tail.includes("&") && /^[\w.-]{1,100}$/.test(tail)) had.serial = tail;
    if (name) had.names.push(name);
    byDevice.set(key, had);
  }
  return [...byDevice].map(([key, d]) => ({
    serial: d.serial ?? `usb-${key.replace(":", "-").toLowerCase()}`,
    model: d.names.find((n) => !GENERIC_NAME.test(n)) ?? "Android phone",
  }));
}

/**
 * Test fake — bring your own devices. Mirrors the server's `/organizations/{orgId}/devices` routes:
 * - `GET …/devices` → `{ devices, requests }` (what `set()` gave; nothing by default)
 * - `PATCH`/`DELETE …/devices/computers/{id}`, `PATCH`/`DELETE …/devices/phones/{id}`, `POST …/phones/{id}/stop`
 * - `POST …/devices/connect-links` `{ kind }` → a link with its two one-line commands
 * - `GET …/devices/connect-links/{id}` → where it stands (`setLink()` moves it on: a computer asking, joined…)
 * - `POST …/devices/requests/{id}/approve` `{ name?, audience? }` → `{ machineId }`, `…/deny`
 * - `POST …/devices/access-requests/{id}/decide`, `POST …/runs/{id}/device-wait`
 * - `POST …/computers/{id}/wifi-pairings` → a pairing waiting for the phone (the QR way with Android's QR text);
 *   `GET …/wifi-pairings/{id}` → where it stands (`setPairing()` moves it on), `DELETE` stops it
 * - `GET …/computers/{id}/wifi-iphones` → the iPhones `setWifi()` put on that Mac's Wi-Fi; `PUT …/{serial}` moves one
 *   among the Mac's phones, over Wi-Fi and preparing
 * Every call is recorded through `record`.
 */
import type {
  ApiClient,
  ComputerDevice,
  ConnectLink,
  ConnectLinkState,
  DevicesList,
  Machine,
  PhoneDevice,
  WifiIphone,
  WifiPairing,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { clone } from "./context";

export interface FakeDevices {
  client: ApiClient["devices"];
  set(list: DevicesList): void;
  /** What the next `GET …/connect-links/{id}` answers. */
  setLink(state: ConnectLinkState): void;
  /** What the next `GET …/wifi-pairings/{id}` answers, over the pairing it started. */
  setPairing(state: Partial<WifiPairing>): void;
  /** The iPhones on `machineId`'s Wi-Fi that trust it, on offer. */
  setWifi(machineId: string, available: WifiIphone[]): void;
  list(): DevicesList;
}

/** A connected computer as the devices list shows it, for tests that only paired machines. */
const deviceOf = (m: Machine): ComputerDevice => ({
  id: m.id,
  machineKind: m.kind ?? "connected",
  name: m.name,
  os: m.os,
  arch: m.arch,
  hostname: m.hostname,
  cpus: null,
  memoryGb: null,
  ownerUserId: m.pairedBy?.id ?? null,
  belongsToWorkspace: m.kind === "managed" || m.kind === "host",
  systemMode: m.mode === "system",
  audience: { mode: "owner", userIds: [], roleIds: [] },
  status: m.online ? { kind: "ready" } : { kind: "offline", lastSeenAt: m.lastSeenAt },
  maxTasks: 1,
  toolchains: {},
  lastSeenAt: m.lastSeenAt,
  mayUse: true,
  mayManage: m.canManage,
  phones: [],
});

/**
 * `machines`: the machines fake's computers, which the list shows until a test `set()`s its own; `removeMachine`
 * takes one of those away there too (this server's own computer stops being used in the workspace).
 */
export function createFakeDevices(
  record: (method: string, ...args: unknown[]) => void,
  now: () => Date,
  machines: () => Machine[] = () => [],
  removeMachine?: (orgId: string, id: string) => Promise<void>,
): FakeDevices {
  let own: DevicesList | null = null;
  const current = (): DevicesList => own ?? { devices: machines().map(deviceOf), requests: [] };
  let link: ConnectLinkState = { status: "waiting" };
  let links = 0;
  let pairing: WifiPairing | null = null;
  let pairings = 0;
  const wifi = new Map<string, WifiIphone[]>();
  const computer = (id: string): ComputerDevice => {
    own ??= current();
    const found = own.devices.find((d) => d.id === id);
    if (!found) throw new ApiError(404, "device.not_found", "Not found");
    return found;
  };
  const phone = (id: string): PhoneDevice => {
    own ??= current();
    for (const d of own.devices) {
      const found = d.phones.find((p) => p.id === id);
      if (found) return found;
    }
    throw new ApiError(404, "device.not_found", "Not found");
  };
  const client: ApiClient["devices"] = {
    list: async (orgId) => {
      record("devices.list", orgId);
      return clone(current());
    },
    updateComputer: async (orgId, id, input) => {
      record("devices.updateComputer", orgId, id, input);
      Object.assign(computer(id), input);
      return clone(computer(id));
    },
    removeComputer: async (orgId, id) => {
      record("devices.removeComputer", orgId, id);
      if (!own && removeMachine) return removeMachine(orgId, id);
      const list = current();
      own = { ...list, devices: list.devices.filter((d) => d.id !== id) };
    },
    updatePhone: async (orgId, id, input) => {
      record("devices.updatePhone", orgId, id, input);
      Object.assign(phone(id), input);
      return clone(phone(id));
    },
    forgetPhone: async (orgId, id) => {
      record("devices.forgetPhone", orgId, id);
      own ??= current();
      for (const d of own.devices) d.phones = d.phones.filter((p) => p.id !== id);
    },
    stopPhone: async (orgId, id) => {
      record("devices.stopPhone", orgId, id);
      phone(id).status = { kind: "ready" };
    },
    createLink: async (orgId, kind) => {
      record("devices.createLink", orgId, kind);
      links += 1;
      const code = `7KQ2-M9X${links}`;
      const made: ConnectLink = {
        id: `link-${links}`,
        code,
        expiresAt: new Date(now().getTime() + 10 * 60_000).toISOString(),
        commands: {
          unix: `curl -fsSL https://app.agentes.chat/i/${code} | sh`,
          windows: `irm https://app.agentes.chat/i/${code}/ps | iex`,
        },
      };
      return made;
    },
    link: async (orgId, id) => {
      record("devices.link", orgId, id);
      return clone(link);
    },
    approveRequest: async (orgId, id, input) => {
      record("devices.approveRequest", orgId, id, input);
      const list = current();
      own = { ...list, requests: list.requests.filter((r) => r.id !== id) };
      link = { ...link, status: "joined", machineId: `m-${id}` };
      return { machineId: `m-${id}` };
    },
    denyRequest: async (orgId, id) => {
      record("devices.denyRequest", orgId, id);
      const list = current();
      own = { ...list, requests: list.requests.filter((r) => r.id !== id) };
      link = { status: "denied" };
    },
    decideAccess: async (orgId, id, decision) => {
      record("devices.decideAccess", orgId, id, decision);
    },
    deviceWait: async (orgId, runId, action) => {
      record("devices.deviceWait", orgId, runId, action);
    },
    startWifiPairing: async (orgId, machineId, input) => {
      record("devices.startWifiPairing", orgId, machineId, input);
      pairings += 1;
      const way = input.code ? "code" : "qr";
      pairing = {
        id: `00000000-0000-4000-8000-00000000000${pairings}`,
        way,
        state: way === "code" ? "pairing" : "waiting",
        ...(way === "qr" ? { qr: `WIFI:T:ADB;S:agentes-Fake${pairings}xxxxx;P:fakepassword;;` } : {}),
        expiresAt: new Date(now().getTime() + 120_000).toISOString(),
      };
      return clone(pairing);
    },
    wifiPairing: async (orgId, machineId, id) => {
      record("devices.wifiPairing", orgId, machineId, id);
      if (!pairing || pairing.id !== id) throw new ApiError(503, "machine.not_found", "No such pairing");
      const { qr: _qr, ...rest } = pairing;
      return clone(rest);
    },
    cancelWifiPairing: async (orgId, machineId, id) => {
      record("devices.cancelWifiPairing", orgId, machineId, id);
    },
    lookForPhones: async (orgId, machineId) => {
      record("devices.lookForPhones", orgId, machineId);
    },
    wifiIphones: async (orgId, machineId) => {
      record("devices.wifiIphones", orgId, machineId);
      return { available: clone(wifi.get(machineId) ?? []) };
    },
    pickIphoneOverWifi: async (orgId, machineId, serial) => {
      record("devices.pickIphoneOverWifi", orgId, machineId, serial);
      const offered = wifi.get(machineId) ?? [];
      const picked = offered.find((p) => p.serial === serial);
      if (!picked) throw new ApiError(503, "machine.phone_missing", "That iPhone isn't on this Mac's Wi-Fi now.");
      wifi.set(
        machineId,
        offered.filter((p) => p !== picked),
      );
      const mac = computer(machineId);
      mac.phones.push({
        id: `p-wifi-${serial}`,
        platform: "ios",
        phoneKind: "device",
        name: picked.name ?? picked.model,
        model: picked.model,
        osVersion: picked.osVersion,
        hostMachineId: machineId,
        transport: "wifi",
        status: { kind: "preparing", reason: "helper_missing" },
        ownerUserId: mac.ownerUserId,
        audience: null,
        mayUse: true,
        mayManage: mac.mayManage,
        lastSeenAt: now().toISOString(),
      });
      return { available: clone(wifi.get(machineId) ?? []) };
    },
  };
  return {
    client,
    set: (next) => {
      own = clone(next);
    },
    setLink: (state) => {
      link = clone(state);
    },
    setPairing: (state) => {
      if (pairing) pairing = { ...pairing, ...clone(state) };
    },
    setWifi: (machineId, available) => {
      wifi.set(machineId, clone(available));
    },
    list: () => clone(current()),
  };
}

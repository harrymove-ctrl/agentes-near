import type { PhonePairFailure, PhonePairing, PhonePairState, PubSub, WifiIphone } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { mayManageDevice, publishDevicesChanged } from "./devices";
import { ForbiddenError, NotFoundError } from "./errors";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import { getMachine } from "./machines";
import { requirePermission } from "./organizations";

const { machinePhones } = schema;

/**
 * Pairing an Android phone over Wi-Fi with a connected computer (bring your own devices): the computer's runner shows
 * Android's QR or takes the six-digit code, finds the phone on the network, pairs and connects it; the phone then
 * shows up under that computer like a cabled one. Only who may manage the computer pairs with it: the phone becomes
 * its owner's, on their adb.
 */

/** A pairing as the apps see it; `update`: the computer's agentes.chat is too old to pair over Wi-Fi. */
export interface WifiPairing {
  id: string;
  way: "qr" | "code";
  state: PhonePairState;
  reason?: PhonePairFailure | "update";
  /** Only when it starts: the QR the phone scans. */
  qr?: string;
  /** Connected: the phone's id in `GET …/devices`. */
  phoneId?: string;
  expiresAt: string;
}

const STATES: readonly PhonePairState[] = ["waiting", "pairing", "connecting", "connected", "failed"];
const FAILURES: readonly PhonePairFailure[] = [
  "mdns_off",
  "same_wifi",
  "refused",
  "timed_out",
  "outdated",
  "adb_missing",
  "canceled",
  "failed",
];

type Deps = { db: Database; hub: Pick<MachineCaller, "call"> };

async function pairingHost(db: Database, actorId: string, orgId: string, machineId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine || machine.kind === "managed") throw new NotFoundError("Device not found", "device.not_found");
  if (!mayManageDevice(membership, actorId, machine.pairedByUserId)) {
    throw new ForbiddenError("Only the computer's owner or an admin can pair phones with it", "device.forbidden");
  }
  return machine;
}

const failed = (way: "qr" | "code", reason: WifiPairing["reason"]): WifiPairing => ({
  id: "",
  way,
  state: "failed",
  reason,
  expiresAt: new Date().toISOString(),
});

/** The runner's answer, checked; connected only once the phone's row is there (its `phones.changed` landed). */
async function viewOf(db: Database, orgId: string, machineId: string, r: PhonePairing): Promise<WifiPairing> {
  const state = STATES.find((s) => s === r.state) ?? "failed";
  const reason = FAILURES.find((f) => f === r.reason);
  const view: WifiPairing = {
    id: typeof r.id === "string" ? r.id.slice(0, 64) : "",
    way: r.way === "code" ? "code" : "qr",
    state,
    ...(state === "failed" ? { reason: reason ?? "failed" } : {}),
    ...(typeof r.qr === "string" && /^WIFI:T:ADB;S:[\w-]{1,60};P:\w{1,60};;$/.test(r.qr) ? { qr: r.qr } : {}),
    expiresAt: typeof r.expiresAt === "string" && !Number.isNaN(Date.parse(r.expiresAt)) ? r.expiresAt : "",
  };
  if (state !== "connected") return view;
  const serial = typeof r.serial === "string" ? r.serial.slice(0, 200) : "";
  const [phone] = serial
    ? await db
        .select({ id: machinePhones.id })
        .from(machinePhones)
        .where(
          and(
            eq(machinePhones.orgId, orgId),
            eq(machinePhones.machineId, machineId),
            eq(machinePhones.platform, "android"),
            eq(machinePhones.serial, serial),
            isNull(machinePhones.deletedAt),
          ),
        )
    : [];
  return phone ? { ...view, phoneId: phone.id } : { ...view, state: "connecting" };
}

/**
 * A runner from before phones (`unsupported`, from the hub), or from before Wi-Fi pairing: it answers these ops as a
 * phone op naming no phone (`bad_request`). The route checks the address and code as the runner does.
 */
const tooOld = (error: unknown) =>
  error instanceof MachineRequestError && (error.code === "bad_request" || error.code === "unsupported");

/** `POST …/computers/{machineId}/wifi-pairings`: the QR way, or with `address` and `code` the six-digit way. */
export async function startWifiPairing(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
  input: { address?: string; code?: string },
): Promise<WifiPairing> {
  const machine = await pairingHost(deps.db, actorId, orgId, machineId);
  const way = input.code !== undefined ? "code" : "qr";
  let reply: PhonePairing;
  try {
    reply =
      way === "code"
        ? await deps.hub.call(machine.id, {
            op: "phone.pair.code",
            address: input.address ?? "",
            code: input.code ?? "",
          })
        : await deps.hub.call(machine.id, { op: "phone.pair.start" });
  } catch (error) {
    if (tooOld(error)) return failed(way, "update");
    if (error instanceof MachineRequestError) return failed(way, "failed");
    throw error;
  }
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "device.wifi_pairing",
    target: { type: "machine", id: machine.id },
    details: { way },
  });
  return viewOf(deps.db, orgId, machine.id, reply);
}

/** `GET …/wifi-pairings/{pairingId}`: where it stands (the QR isn't said again). */
export async function wifiPairingState(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
  pairingId: string,
): Promise<WifiPairing> {
  const machine = await pairingHost(deps.db, actorId, orgId, machineId);
  try {
    const reply = await deps.hub.call(machine.id, { op: "phone.pair.status", pairingId });
    const { qr: _qr, ...view } = await viewOf(deps.db, orgId, machine.id, reply);
    return view;
  } catch (error) {
    // The runner restarted in between, or is too old: that pairing is gone.
    if (error instanceof MachineRequestError) return { ...failed("qr", "failed"), id: pairingId };
    throw error;
  }
}

/** `DELETE …/wifi-pairings/{pairingId}`: the dialog closed; a computer gone already stopped it. */
export async function cancelWifiPairing(
  deps: Deps,
  actorId: string,
  orgId: string,
  machineId: string,
  pairingId: string,
): Promise<void> {
  const machine = await pairingHost(deps.db, actorId, orgId, machineId);
  await deps.hub.call(machine.id, { op: "phone.pair.cancel", pairingId }).catch(() => undefined);
}

/**
 * `POST …/computers/{machineId}/phone-looks`: a phone guide waits for a cabled phone, so the computer also looks for
 * one it has no USB driver for, for the next minute. Anyone who sees the computer may ask: it only reads. A computer
 * offline or too old to look simply doesn't.
 */
export async function lookForPhones(deps: Deps, actorId: string, orgId: string, machineId: string): Promise<void> {
  await requirePermission(deps.db, actorId, orgId, "read");
  const machine = await getMachine(deps.db, orgId, machineId);
  if (!machine || machine.kind === "managed") throw new NotFoundError("Device not found", "device.not_found");
  await deps.hub.call(machine.id, { op: "phone.look" }).catch(() => undefined);
}

/**
 * iPhones on a Mac's Wi-Fi (ADR 0042): the Mac lists the ones that trust it (they did over a cable once), and uses one
 * only after the person who manages the Mac picks it. Only they see the list: it names phones near the Mac, which may
 * be anyone's. `update`: the Mac's agentes.chat is too old to use iPhones over Wi-Fi.
 */
export interface WifiIphones {
  available: WifiIphone[];
  update?: true;
}

const wifiList = (r: { available?: unknown }): WifiIphone[] =>
  (Array.isArray(r.available) ? r.available : []).slice(0, 20).flatMap((p: Record<string, unknown>) => {
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
    const serial = text(p?.serial, 200);
    if (!serial) return [];
    const name = text(p.name, 200);
    return [
      { serial, model: text(p.model, 120) || "iPhone", ...(name ? { name } : {}), osVersion: text(p.osVersion, 40) },
    ];
  });

/** `GET …/computers/{machineId}/wifi-iphones`: an offline Mac lists none. */
export async function wifiIphones(deps: Deps, actorId: string, orgId: string, machineId: string): Promise<WifiIphones> {
  const machine = await pairingHost(deps.db, actorId, orgId, machineId);
  try {
    return { available: wifiList(await deps.hub.call(machine.id, { op: "phone.wifi", action: "list" })) };
  } catch (error) {
    if (tooOld(error)) return { available: [], update: true };
    return { available: [] };
  }
}

/**
 * `PUT …/wifi-iphones/{serial}` (`use`) and the forget of a phone row over Wi-Fi: the Mac uses that iPhone over Wi-Fi
 * from now on, or no longer.
 */
export async function pickIphoneOverWifi(
  deps: Deps & { pubsub?: PubSub },
  actorId: string,
  orgId: string,
  machineId: string,
  serial: string,
): Promise<WifiIphones> {
  const machine = await pairingHost(deps.db, actorId, orgId, machineId);
  let reply: { available?: unknown };
  try {
    reply = await deps.hub.call(machine.id, { op: "phone.wifi", action: "allow", serial });
  } catch (error) {
    if (tooOld(error)) return { available: [], update: true };
    throw error;
  }
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "device.iphone_wifi",
    target: { type: "machine", id: machine.id },
    details: { on: true },
  });
  await publishDevicesChanged(deps.pubsub, orgId);
  return { available: wifiList(reply) };
}

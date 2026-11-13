import { afterEach, expect, test } from "bun:test";
import {
  IPHONE_WIFI_PROTOCOL,
  orgTopic,
  PHONE_PAIRING_PROTOCOL,
  PHONE_SCREEN_PROTOCOL,
  PHONES_PROTOCOL,
  type RunnerPhone,
  STREAM_CLOSE,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  authorizePhoneStream,
  cancelWifiPairing,
  ForbiddenError,
  forgetPhone,
  isNewWork,
  issueManagedMachine,
  listDevices,
  type MachineHub,
  MachineOfflineError,
  type MachinePhoneRow,
  MachineRequestError,
  phoneStoppedBy,
  pickIphoneOverWifi,
  recheckPhoneStream,
  removeMember,
  requestTimeoutMs,
  setAgentComputerTarget,
  setWorkspaceComputers,
  startWifiPairing,
  stopPhone,
  syncMachinePhones,
  updateComputerDevice,
  updatePhoneDevice,
  ValidationError,
  wifiIphones,
  wifiPairingState,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine, RUNNER } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  setWorkspaceComputers(false);
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const pair = async (userId: string, name: string) =>
  (await pairMachine(deps(), userId, f.org.id, { name, ...RUNNER })).machineId;
const machineRow = async (id: string) =>
  (
    await f.db.select().from(schema.machines).where(eq(schema.machines.id, id))
  )[0] as typeof schema.machines.$inferSelect;
const online = (id: string) =>
  f.db.update(schema.machines).set({ online: true, lastSeenAt: new Date() }).where(eq(schema.machines.id, id));
const sync = async (machineId: string, phones: RunnerPhone[]) =>
  syncMachinePhones(f.db, await machineRow(machineId), phones);
const phoneRows = () => f.db.select().from(schema.machinePhones).orderBy(schema.machinePhones.createdAt);

const pixel: RunnerPhone = {
  platform: "android",
  serial: "33141FDH2000AB",
  kind: "device",
  model: "Pixel 8",
  osVersion: "16",
  state: "ready",
  transport: "usb",
};
const iphone: RunnerPhone = {
  platform: "ios",
  serial: "00008130-001A2B3C4D5E",
  kind: "device",
  model: "iPhone 16",
  name: "Sam's iPhone",
  osVersion: "26.1",
  state: "needs_you",
  reason: "developer_mode_off",
};
const emulator: RunnerPhone = {
  ...pixel,
  serial: "emulator-5554",
  kind: "emulator",
  model: "sdk_gphone64",
  transport: "local",
};

test("the list: the workspace's computer first, each computer's status, its phones, and who may use or change them", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const mac = await pair(f.owner.id, "MacBook");
  await pair(f.owner.id, "Build PC");
  const lab = await pair(f.owner.id, "Lab box");
  const managed = await issueManagedMachine({ db: f.db }, f.org.id, { name: "Acme computer" });
  await online(mac);
  await online(lab);
  await f.db
    .update(schema.machines)
    .set({ paused: true, size: { cpus: 8, memoryGb: 16, diskGb: 512 } })
    .where(eq(schema.machines.id, lab));
  await f.db.insert(schema.machineTasks).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    machineId: mac,
    channelId: f.general.id,
    title: "Gradle build",
    executor: "shell",
    status: "running",
  });
  const since = new Date().toISOString();
  await sync(mac, [
    { ...pixel, holder: { runId: null, agentId: f.agent.id, userId: rui.id, label: "Recording a test video", since } },
    iphone,
  ]);

  const seen = await listDevices(f.db, f.org.id, rui.id);
  expect(seen.devices.map((d) => [d.name, d.machineKind, d.status.kind])).toEqual([
    ["Acme computer", "managed", "offline"],
    ["MacBook", "connected", "busy"],
    ["Build PC", "connected", "offline"],
    ["Lab box", "connected", "paused"],
  ]);
  const [workspace, macbook, , labBox] = seen.devices;
  expect(workspace).toMatchObject({ id: managed?.machineId, hostname: "", mayUse: true, mayManage: false });
  expect(macbook).toMatchObject({
    status: { kind: "busy", running: 1, max: 3 },
    ownerUserId: f.owner.id,
    audience: { mode: "owner", userIds: [], roleIds: [] },
    mayUse: false,
    mayManage: false,
  });
  expect(labBox).toMatchObject({ cpus: 8, memoryGb: 16, status: { kind: "paused", until: null } });
  expect(macbook?.phones).toMatchObject([
    {
      name: "Pixel 8",
      platform: "android",
      transport: "usb",
      audience: { mode: "owner" },
      status: { kind: "in_use", agentName: "Dev", userId: rui.id, userName: "rui", label: "Recording a test video" },
    },
    { name: "Sam's iPhone", audience: null, status: { kind: "needs_you", reason: "developer_mode_off" } },
  ]);
  const mine = (await listDevices(f.db, f.org.id, f.owner.id)).devices[1];
  expect(mine).toMatchObject({ mayUse: true, mayManage: true });
  expect(mine?.phones.every((p) => p.mayUse && p.mayManage)).toBe(true);

  // Its computer gone quiet: its phones read offline with it.
  await f.db.update(schema.machines).set({ online: false }).where(eq(schema.machines.id, mac));
  const away = (await listDevices(f.db, f.org.id, rui.id)).devices[1]?.phones[0];
  expect(away?.status).toMatchObject({ kind: "offline", withHost: true });
});

test("phones sync: a phone keeps its name and rule moving between its owner's computers, starts over on someone else's or once forgotten", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const mac = await pair(f.owner.id, "MacBook");
  const mini = await pair(f.owner.id, "Mac mini");
  const ruiPc = await pair(rui.id, "Rui's PC");

  const first = await sync(mac, [pixel, emulator]);
  expect(first.map((p) => [p.name, p.ownerUserId, p.followsHost])).toEqual([
    ["Pixel 8", f.owner.id, false],
    ["sdk_gphone64", f.owner.id, false],
  ]);
  const phoneId = first[0]?.id as string;
  await updatePhoneDevice(deps(), f.owner.id, f.org.id, phoneId, {
    name: "Test Pixel",
    audience: { mode: "everyone", userIds: [], roleIds: [] },
  });

  // Plugged into the owner's other computer: same row, name and rule.
  const moved = await sync(mini, [pixel]);
  expect(moved).toMatchObject([{ id: phoneId, name: "Test Pixel", audienceMode: "everyone", machineId: mini }]);
  // The first computer no longer sees its emulator; the phone that moved isn't its to mark.
  const left = await sync(mac, []);
  expect(left.map((p) => [p.name, p.state])).toEqual([["sdk_gphone64", "offline"]]);

  // Another person's computer reports it: a new phone of theirs, Only them.
  const taken = await sync(ruiPc, [pixel, emulator]);
  expect(taken.find((p) => p.id === phoneId)).toMatchObject({
    name: "Pixel 8",
    ownerUserId: rui.id,
    audienceMode: "owner",
  });
  // An emulator's serial is its own computer's: two emulator-5554 are two phones.
  expect((await phoneRows()).filter((p) => p.kind === "emulator").map((p) => p.machineId)).toEqual([mac, ruiPc]);

  await updatePhoneDevice(deps(), rui.id, f.org.id, phoneId, { name: "Rui's Pixel" });
  await forgetPhone(deps(), rui.id, f.org.id, phoneId);
  expect((await listDevices(f.db, f.org.id, rui.id)).devices.find((d) => d.id === ruiPc)?.phones).toHaveLength(1);
  const back = await sync(ruiPc, [pixel, emulator]);
  expect(back.find((p) => p.id === phoneId)).toMatchObject({ name: "Pixel 8", deletedAt: null });
});

test("who can use it: the owner sets it; an admin renames, marks it the workspace's and only narrows someone's own device", async () => {
  f = await setup();
  const sam = await addMember(f.db, f.org.id, "admin", "sam");
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const laptop = await pair(rui.id, "Rui's laptop");
  const everyone = { mode: "everyone" as const, userIds: [], roleIds: [] };
  const onlySam = { mode: "people" as const, userIds: [sam.id], roleIds: [] };

  await expect(updateComputerDevice(deps(), sam.id, f.org.id, laptop, { audience: everyone })).rejects.toMatchObject({
    code: "device.widen_forbidden",
  });
  const other = await addMember(f.db, f.org.id, "member", "lia");
  await expect(updateComputerDevice(deps(), other.id, f.org.id, laptop, { name: "Mine" })).rejects.toThrow(
    ForbiddenError,
  );

  expect(await updateComputerDevice(deps(), rui.id, f.org.id, laptop, { audience: everyone })).toMatchObject({
    audience: everyone,
  });
  expect(
    await updateComputerDevice(deps(), sam.id, f.org.id, laptop, { name: "Build laptop", audience: onlySam }),
  ).toMatchObject({
    name: "Build laptop",
    audience: onlySam,
  });
  await expect(updateComputerDevice(deps(), sam.id, f.org.id, laptop, { audience: everyone })).rejects.toMatchObject({
    code: "device.widen_forbidden",
  });
  // Marked the workspace's, it is the admins' to open up.
  await updateComputerDevice(deps(), sam.id, f.org.id, laptop, { belongsToWorkspace: true });
  expect(await updateComputerDevice(deps(), sam.id, f.org.id, laptop, { audience: everyone })).toMatchObject({
    belongsToWorkspace: true,
    audience: everyone,
  });
  await expect(
    updateComputerDevice(deps(), rui.id, f.org.id, laptop, {
      audience: { mode: "people", userIds: [], roleIds: [crypto.randomUUID()] },
    }),
  ).rejects.toThrow(ValidationError);
  // People with nobody left is Only the owner.
  expect(
    await updateComputerDevice(deps(), rui.id, f.org.id, laptop, {
      audience: { mode: "people", userIds: ["user_gone"], roleIds: [] },
    }),
  ).toMatchObject({ audience: { mode: "owner" } });

  const [phone] = await sync(laptop, [iphone]);
  await expect(
    updatePhoneDevice(deps(), rui.id, f.org.id, phone?.id as string, { audience: everyone }),
  ).rejects.toMatchObject({ code: "device.follows_host" });
  const managed = await issueManagedMachine({ db: f.db }, f.org.id);
  await expect(
    updateComputerDevice(deps(), f.owner.id, f.org.id, managed?.machineId as string, { name: "x" }),
  ).rejects.toMatchObject({ code: "machine.managed" });
});

test("where workspaces have their own computer, a brought one is a target, never an agent's home", async () => {
  f = await setup();
  setWorkspaceComputers(true);
  const brought = await pair(f.owner.id, "MacBook");
  await expect(setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, brought)).rejects.toMatchObject({
    code: "device.not_home",
  });
  const managed = await issueManagedMachine({ db: f.db }, f.org.id);
  expect(
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, managed?.machineId ?? null),
  ).toMatchObject({
    kind: "machine",
  });
  setWorkspaceComputers(false);
  expect(await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, brought)).toMatchObject({
    machineId: brought,
  });
});

test("someone leaving: their own devices go with them; one marked the workspace's stays, nobody's, its phones too", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  const mac = await pair(rui.id, "Rui's Mac");
  const lab = await pair(rui.id, "Lab box");
  await f.db.update(schema.machines).set({ belongsToWorkspace: true }).where(eq(schema.machines.id, lab));
  await sync(mac, [pixel]);
  await sync(lab, [{ ...pixel, serial: "R58N12ABCDE", model: "Galaxy S24" }]);

  await removeMember(f.db, rui.id, f.org.id, rui.id, { pubsub: f.pubsub });
  const phones = await phoneRows();
  expect(phones.map((p) => [p.name, p.machineId, p.ownerUserId, p.deletedAt !== null])).toEqual([
    ["Pixel 8", null, rui.id, true],
    ["Galaxy S24", lab, null, false],
  ]);
  const seen = await listDevices(f.db, f.org.id, lia.id);
  expect(seen.devices.map((d) => [d.name, d.ownerUserId, d.mayUse])).toEqual([["Lab box", null, true]]);
  expect(seen.devices[0]?.phones.map((p) => p.mayUse)).toEqual([true]);
});

test("the computer's socket: phones and toolchains in hello, phones.changed, the hook, and no phone op for an older runner", async () => {
  f = await setup({ machines: true });
  const hub = f.machineHub as MachineHub;
  const paired = await pairMachine(deps(), f.owner.id, f.org.id, { name: "MacBook", ...RUNNER });
  const reported: MachinePhoneRow[][] = [];
  hub.setMissionHooks({
    phonesChanged: async (_machine, phones) => {
      reported.push(phones);
    },
  });
  const events: unknown[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
  const runner = fakeRunner(hub);
  await runner.hello(paired.token, { phones: [pixel], toolchains: { adb: "35.0.2", maestro: "1.40.0" } });
  await new Promise((r) => setTimeout(r, 5));
  expect((await machineRow(paired.machineId)).executors.toolchains).toEqual({ adb: "35.0.2", maestro: "1.40.0" });
  expect(reported.at(-1)?.map((p) => [p.name, p.state])).toEqual([["Pixel 8", "ready"]]);

  await runner.frame({ type: "phones.changed", phones: [] });
  await new Promise((r) => setTimeout(r, 5));
  expect(reported.at(-1)?.map((p) => p.state)).toEqual(["offline"]);
  expect(events).toContainEqual(expect.objectContaining({ event: { type: "devices.changed", orgId: f.org.id } }));
  // A hello that leaves the toolchains out keeps the last ones.
  runner.disconnect();
  const again = fakeRunner(hub);
  await again.hello(paired.token);
  expect((await machineRow(paired.machineId)).executors.toolchains).toEqual({ adb: "35.0.2", maestro: "1.40.0" });
  again.disconnect();

  const old = fakeRunner(hub);
  await old.hello(paired.token, { protocol: PHONES_PROTOCOL - 1 });
  const holder = { runId: null, agentId: null, userId: f.owner.id, since: new Date().toISOString() };
  const refused = hub.call(paired.machineId, { op: "phone.screenshot", platform: "android", serial: "x", holder });
  await expect(refused).rejects.toBeInstanceOf(MachineRequestError);
  await expect(refused).rejects.toMatchObject({ code: "unsupported" });
  old.disconnect();
  // Phones, but from before Wi-Fi pairing: no `phone.pair.*` reaches it.
  const first = fakeRunner(hub);
  await first.hello(paired.token, { protocol: PHONE_PAIRING_PROTOCOL - 1 });
  await expect(hub.call(paired.machineId, { op: "phone.pair.start" })).rejects.toMatchObject({ code: "unsupported" });
  first.disconnect();
  // From before iPhones over Wi-Fi: no `phone.wifi` reaches it.
  const second = fakeRunner(hub);
  await second.hello(paired.token, { protocol: IPHONE_WIFI_PROTOCOL - 1 });
  await expect(hub.call(paired.machineId, { op: "phone.wifi", action: "list" })).rejects.toMatchObject({
    code: "unsupported",
  });
  second.disconnect();

  const target = { platform: "android" as const, serial: "x", holder };
  expect(requestTimeoutMs({ op: "phone.flow", ...target, flow: "", timeoutSeconds: 3600 })).toBe(720_000);
  expect(requestTimeoutMs({ op: "phone.install", ...target, path: "app.apk" })).toBe(300_000);
  expect(requestTimeoutMs({ op: "phone.logs", ...target, lines: 100 })).toBe(60_000);
  expect(isNewWork({ op: "phone.release", ...target })).toBe(false);
  expect(isNewWork({ op: "phone.record", ...target, seconds: 30 })).toBe(true);
});

test("Stop: the phone's lock is let go for anyone, and the run that held it learns who stopped it", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  const mac = await pair(f.owner.id, "MacBook");
  await online(mac);
  const runId = crypto.randomUUID();
  const holder = {
    runId,
    agentId: f.agent.id,
    userId: rui.id,
    label: "Testing checkout",
    since: new Date().toISOString(),
  };
  const [phone] = await sync(mac, [{ ...emulator, holder }]);
  const calls: unknown[] = [];
  const hub = {
    call: async (machineId: string, request: unknown) => {
      calls.push({ machineId, request });
      return { released: true };
    },
  } as unknown as Parameters<typeof stopPhone>[0]["hub"];

  await expect(stopPhone({ ...deps(), hub }, lia.id, f.org.id, phone?.id as string)).rejects.toThrow(ForbiddenError);
  // The person the agent works for may stop it, like its owner and admins.
  await stopPhone({ ...deps(), hub }, rui.id, f.org.id, phone?.id as string);
  expect(calls).toEqual([
    {
      machineId: mac,
      request: { op: "phone.release", platform: "android", serial: "emulator-5554", holder, force: true },
    },
  ]);
  expect((await phoneRows())[0]?.holder).toBeNull();
  expect(await phoneStoppedBy(f.db, f.org.id, phone?.id as string, runId)).toEqual({ userId: rui.id, name: "rui" });
  expect(await phoneStoppedBy(f.db, f.org.id, phone?.id as string, crypto.randomUUID())).toBeNull();
});

test("a phone's screen: whoever may use it watches; control is the person's own hold, not while another's agent or person has it", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  const mac = await pair(f.owner.id, "MacBook");
  await online(mac);
  const [phone] = await sync(mac, [pixel]);
  const phoneId = phone?.id as string;
  let here = true;
  const hub = { isLocal: (id: string) => here && id === mac };
  const input = (userId: string, mode: "watch" | "control") => ({
    userId,
    orgId: f.org.id,
    agentId: "",
    request: { kind: "phone" as const, mode, phoneId },
  });
  const open = (userId: string, mode: "watch" | "control") =>
    authorizePhoneStream({ db: f.db, hub }, input(userId, mode));
  const holdBy = (holder: Record<string, unknown> | null) =>
    f.db
      .update(schema.machinePhones)
      .set({ holder: holder as never })
      .where(eq(schema.machinePhones.id, phoneId));

  // Only its owner, by default: a daily phone's screen shows whatever is on it.
  expect(await open(rui.id, "watch")).toEqual({ refused: STREAM_CLOSE.forbidden, reason: "forbidden" });
  expect(await open(f.owner.id, "control")).toEqual({
    machineId: mac,
    phone: {
      platform: "android",
      serial: pixel.serial,
      holder: expect.objectContaining({ runId: null, agentId: null, userId: f.owner.id }),
    },
  });
  await updatePhoneDevice(deps(), f.owner.id, f.org.id, phoneId, {
    audience: { mode: "everyone", userIds: [], roleIds: [] },
  });
  expect(await open(rui.id, "watch")).toMatchObject({ machineId: mac });
  expect(await open(rui.id, "control")).toMatchObject({ machineId: mac });

  // An agent working for Ana holds it: Rui watches, but only its owner, an admin or Ana take control.
  await holdBy({ runId: crypto.randomUUID(), agentId: f.agent.id, userId: ana.id, since: new Date().toISOString() });
  expect(await open(rui.id, "watch")).toMatchObject({ machineId: mac });
  expect(await open(rui.id, "control")).toEqual({ refused: STREAM_CLOSE.controlEnded, reason: "in_use" });
  expect(await open(ana.id, "control")).toMatchObject({ machineId: mac });
  expect(await open(f.owner.id, "control")).toMatchObject({ machineId: mac });

  // Ana in control: it's hers until she gives it back, and the recheck keeps her stream.
  await holdBy({ runId: null, agentId: null, userId: ana.id, since: new Date().toISOString() });
  expect(await open(f.owner.id, "control")).toEqual({
    refused: STREAM_CLOSE.controlEnded,
    reason: "someone_in_control",
  });
  const hers = { ...input(ana.id, "control"), id: "s", machineId: mac } as never;
  expect(await recheckPhoneStream(f.db, hers)).toBeNull();
  // Narrowed to its owner while she watched: the recheck ends it.
  await updatePhoneDevice(deps(), f.owner.id, f.org.id, phoneId, {
    audience: { mode: "owner", userIds: [], roleIds: [] },
  });
  expect(await recheckPhoneStream(f.db, hers)).toEqual({ refused: STREAM_CLOSE.forbidden, reason: "forbidden" });

  // Its computer elsewhere or away; a phone that isn't there.
  here = false;
  expect(await open(f.owner.id, "watch")).toEqual({ refused: STREAM_CLOSE.unreachable, reason: "other_server" });
  here = true;
  await f.db
    .update(schema.machines)
    .set({ protocol: PHONE_SCREEN_PROTOCOL - 1 })
    .where(eq(schema.machines.id, mac));
  expect(await open(f.owner.id, "watch")).toEqual({ refused: STREAM_CLOSE.refused, reason: "runner_outdated" });
  expect(
    await authorizePhoneStream(
      { db: f.db, hub },
      { ...input(f.owner.id, "watch"), request: { kind: "phone", mode: "watch", phoneId: crypto.randomUUID() } },
    ),
  ).toEqual({ refused: STREAM_CLOSE.notFound, reason: "no_phone" });
});

test("Wi-Fi pairing: only who may manage the computer pairs with it; connected names the phone once its row is there", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const mac = await pair(f.owner.id, "MacBook");
  await online(mac);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const calls: unknown[] = [];
  let reply: Record<string, unknown> = {
    id,
    way: "qr",
    state: "waiting",
    qr: "WIFI:T:ADB;S:agentes-Qx7Kp2Mz9a;P:p4ssW0rdAbCd;;",
    expiresAt,
  };
  let fail: Error | null = null;
  const hub = {
    call: async (machineId: string, request: unknown) => {
      calls.push({ machineId, request });
      if (fail) throw fail;
      return reply;
    },
  } as unknown as Parameters<typeof startWifiPairing>[0]["hub"];
  const d = { db: f.db, hub };

  await expect(startWifiPairing(d, rui.id, f.org.id, mac, {})).rejects.toThrow(ForbiddenError);
  expect(calls).toEqual([]);
  const started = await startWifiPairing(d, f.owner.id, f.org.id, mac, {});
  expect(started).toEqual({ id, way: "qr", state: "waiting", qr: reply.qr as string, expiresAt });
  expect(calls.at(-1)).toEqual({ machineId: mac, request: { op: "phone.pair.start" } });
  await startWifiPairing(d, f.owner.id, f.org.id, mac, { address: "192.168.1.20:37099", code: "123456" });
  expect(calls.at(-1)).toEqual({
    machineId: mac,
    request: { op: "phone.pair.code", address: "192.168.1.20:37099", code: "123456" },
  });

  // Connected, but its phones report hasn't landed: still connecting; then the phone's id. The QR isn't said again.
  reply = { id, way: "qr", state: "connected", serial: pixel.serial, qr: reply.qr, expiresAt };
  expect(await wifiPairingState(d, f.owner.id, f.org.id, mac, id)).toMatchObject({ state: "connecting" });
  const [row] = await sync(mac, [{ ...pixel, transport: "wifi" }]);
  const done = await wifiPairingState(d, f.owner.id, f.org.id, mac, id);
  expect(done).toEqual({ id, way: "qr", state: "connected", phoneId: row?.id as string, expiresAt });

  // A failure keeps its reason; a code it doesn't know reads as failed; a runner from before Wi-Fi pairing: update.
  reply = { id, way: "code", state: "failed", reason: "refused", expiresAt };
  expect(await wifiPairingState(d, f.owner.id, f.org.id, mac, id)).toMatchObject({ reason: "refused" });
  reply = { id, way: "code", state: "failed", reason: "weird", expiresAt };
  expect(await wifiPairingState(d, f.owner.id, f.org.id, mac, id)).toMatchObject({ reason: "failed" });
  fail = new MachineRequestError("bad_request", "A phone op names its phone (platform and serial)");
  expect(await startWifiPairing(d, f.owner.id, f.org.id, mac, {})).toMatchObject({ state: "failed", reason: "update" });
  fail = new MachineRequestError(
    "unsupported",
    "The computer MacBook needs an update before agents can use its phones.",
  );
  expect(await startWifiPairing(d, f.owner.id, f.org.id, mac, {})).toMatchObject({ state: "failed", reason: "update" });
  await cancelWifiPairing(d, f.owner.id, f.org.id, mac, id);
  expect(calls.at(-1)).toEqual({ machineId: mac, request: { op: "phone.pair.cancel", pairingId: id } });
  expect(isNewWork({ op: "phone.pair.start" })).toBe(false);
});

test("iPhones over Wi-Fi: only who may manage the Mac sees the offer or picks one; forgetting it lets it go there too", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const mac = await pair(f.owner.id, "MacBook");
  await online(mac);
  const near = { serial: "00008120-000A1B2C3D4E5F60", model: "iPhone 14", name: "Ana's iPhone", osVersion: "27.0" };
  const calls: unknown[] = [];
  let reply: Record<string, unknown> = { available: [near, { serial: "" }, { serial: "X".repeat(300) }] };
  let fail: Error | null = null;
  const hub = {
    call: async (machineId: string, request: unknown) => {
      calls.push({ machineId, request });
      if (fail) throw fail;
      return reply;
    },
  } as unknown as Parameters<typeof wifiIphones>[0]["hub"];
  const d = { db: f.db, hub, pubsub: f.pubsub };

  // A member who doesn't manage the Mac is never told which phones are near it.
  await expect(wifiIphones(d, rui.id, f.org.id, mac)).rejects.toThrow(ForbiddenError);
  await expect(pickIphoneOverWifi(d, rui.id, f.org.id, mac, near.serial)).rejects.toThrow(ForbiddenError);
  expect(calls).toEqual([]);
  // The runner's answer, checked: no serial is no phone, a long one is cut.
  const offer = await wifiIphones(d, f.owner.id, f.org.id, mac);
  expect(offer.available).toHaveLength(2);
  expect(offer.available[0]).toEqual(near);
  expect(offer.available[1]?.serial).toHaveLength(200);
  expect(calls.at(-1)).toEqual({ machineId: mac, request: { op: "phone.wifi", action: "list" } });
  reply = { available: [] };
  expect(await pickIphoneOverWifi(d, f.owner.id, f.org.id, mac, near.serial)).toEqual({ available: [] });
  expect(calls.at(-1)).toEqual({ machineId: mac, request: { op: "phone.wifi", action: "allow", serial: near.serial } });
  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "device.iphone_wifi"));
  expect(audit).toHaveLength(1);

  // Picked, the Mac reports it over Wi-Fi; forgetting it there stops its Wi-Fi use on the Mac, and only once the Mac
  // says so: an offline one would go on using it, so it isn't forgotten and the person is told why.
  await f.db.update(schema.machines).set({ protocol: IPHONE_WIFI_PROTOCOL }).where(eq(schema.machines.id, mac));
  const [row] = await sync(mac, [
    { ...iphone, serial: near.serial, state: "ready", reason: undefined, transport: "wifi" },
  ]);
  fail = new MachineOfflineError("MacBook", "personal");
  await expect(forgetPhone({ ...deps(), hub }, f.owner.id, f.org.id, row?.id as string)).rejects.toThrow(
    MachineOfflineError,
  );
  expect((await phoneRows()).find((p) => p.id === row?.id)?.deletedAt).toBeNull();
  fail = null;
  await forgetPhone({ ...deps(), hub }, f.owner.id, f.org.id, row?.id as string);
  expect(calls.at(-1)).toEqual({
    machineId: mac,
    request: { op: "phone.wifi", action: "forget", serial: near.serial },
  });
  // A plugged-in one may be picked too: its Mac lets go of the pick if it can, and it's forgotten here either way.
  const [cabled] = await sync(mac, [{ ...iphone, transport: "usb" }]);
  fail = new MachineOfflineError("MacBook", "personal");
  await forgetPhone({ ...deps(), hub }, f.owner.id, f.org.id, cabled?.id as string);
  expect(calls.at(-1)).toEqual({
    machineId: mac,
    request: { op: "phone.wifi", action: "forget", serial: iphone.serial },
  });
  expect((await phoneRows()).find((p) => p.id === cabled?.id)?.deletedAt).not.toBeNull();
  // A Mac from before Wi-Fi iPhones holds no pick: nothing is asked.
  await f.db
    .update(schema.machines)
    .set({ protocol: IPHONE_WIFI_PROTOCOL - 1 })
    .where(eq(schema.machines.id, mac));
  const [old] = await sync(mac, [{ ...iphone, transport: "usb" }]);
  const before = calls.length;
  await forgetPhone({ ...deps(), hub }, f.owner.id, f.org.id, old?.id as string);
  expect(calls).toHaveLength(before);

  // A Mac from before Wi-Fi iPhones (the hub refuses it), or one offline: nothing on offer.
  fail = new MachineRequestError(
    "unsupported",
    "The computer MacBook needs an update before agents can use its phones.",
  );
  expect(await wifiIphones(d, f.owner.id, f.org.id, mac)).toEqual({ available: [], update: true });
  expect(await pickIphoneOverWifi(d, f.owner.id, f.org.id, mac, near.serial)).toEqual({ available: [], update: true });
  fail = new Error("offline");
  expect(await wifiIphones(d, f.owner.id, f.org.id, mac)).toEqual({ available: [] });
  expect(isNewWork({ op: "phone.wifi", action: "allow", serial: near.serial })).toBe(false);
  expect(IPHONE_WIFI_PROTOCOL).toBeGreaterThan(PHONE_PAIRING_PROTOCOL);
});

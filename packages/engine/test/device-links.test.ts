import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  approveDeviceJoin,
  confirmDeviceCode,
  connectLinkInfo,
  connectLinkState,
  createConnectLink,
  denyDeviceCode,
  denyDeviceJoin,
  ForbiddenError,
  listDevices,
  NotFoundError,
  openConnectLink,
  pollDeviceToken,
  sha256Hex,
  startLinkedDeviceCode,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PUBLIC_URL = "https://agentes.example";
const deps = () => ({ db: f.db, pubsub: f.pubsub, publicUrl: PUBLIC_URL });
const BUILD_BOX = { name: "build-box", os: "linux", arch: "x64", hostname: "build-box", version: "1.0.0" };
const fromAddress = { ip: "203.0.113.20", approxLocation: "Lisbon, PT" };
const joinNotices = () =>
  f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "device.join_request"));

test("a connect link: a one-line install that works once, asks its maker, and joins only when they let it", async () => {
  f = await setup();
  const sam = await addMember(f.db, f.org.id, "admin", "sam");
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const link = await createConnectLink({ db: f.db }, PUBLIC_URL, rui.id, f.org.id, "server");
  expect(link.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  expect(link.commands).toEqual({
    unix: `curl -fsSL ${PUBLIC_URL}/i/${link.code} | sh`,
    windows: `irm ${PUBLIC_URL}/i/${link.code}/ps | iex`,
  });
  const [stored] = await f.db.select().from(schema.machineConnectLinks);
  expect(stored?.codeHash).toBe(sha256Hex(link.code.replace("-", "")));
  expect(await openConnectLink(f.db, link.code.toLowerCase())).toMatchObject({ id: link.id });
  expect(await connectLinkState({ db: f.db }, rui.id, f.org.id, link.id)).toEqual({ status: "waiting" });

  const started = await startLinkedDeviceCode(deps(), link.code, BUILD_BOX, fromAddress);
  expect(started).toMatchObject({ maker: { name: "rui" }, org: { name: "Acme" } });
  // Once: another computer with the same line is refused.
  await expect(startLinkedDeviceCode(deps(), link.code, BUILD_BOX, { ip: "203.0.113.21" })).rejects.toMatchObject({
    code: "machine.link_invalid",
  });
  // Its code can't be confirmed or denied by typing it: only the maker decides, from the request.
  await expect(confirmDeviceCode(deps(), sam.id, f.org.id, started.userCode, {})).rejects.toThrow(NotFoundError);
  await expect(denyDeviceCode(deps(), sam.id, started.userCode)).rejects.toThrow(NotFoundError);

  const state = await connectLinkState({ db: f.db }, rui.id, f.org.id, link.id);
  expect(state).toMatchObject({
    status: "asking",
    request: { name: "build-box", os: "linux", ip: "203.0.113.20", location: "Lisbon, PT", linkId: link.id },
  });
  const requestId = state.request?.id as string;
  // The maker hears it, waiting; so do admins in the list, never other members.
  expect(await joinNotices()).toMatchObject([
    {
      userId: rui.id,
      waiting: true,
      source: { requestId, label: "build-box" },
      // The system as a code too: the app draws its mark from it and says its name in the person's language.
      latest: {
        title: "Acme",
        text: "Linux · 203.0.113.20 · Lisbon, PT",
        os: "linux",
        ip: "203.0.113.20",
        location: "Lisbon, PT",
      },
    },
  ]);
  expect((await listDevices(f.db, f.org.id, rui.id)).requests.map((r) => r.id)).toEqual([requestId]);
  expect((await listDevices(f.db, f.org.id, sam.id)).requests.map((r) => r.id)).toEqual([requestId]);
  expect((await listDevices(f.db, f.org.id, f.owner.id)).requests).toHaveLength(1);
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  expect((await listDevices(f.db, f.org.id, lia.id)).requests).toEqual([]);
  expect(await pollDeviceToken(deps(), started.deviceCode)).toEqual({ ok: false, error: "authorization_pending" });

  // An admin sees it but doesn't let it in: only the maker.
  await expect(approveDeviceJoin(deps(), sam.id, f.org.id, requestId)).rejects.toThrow(ForbiddenError);
  const { machineId } = await approveDeviceJoin(deps(), rui.id, f.org.id, requestId, { name: "Build server" });
  const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  expect(machine).toMatchObject({ name: "Build server", pairedByUserId: rui.id, audienceMode: "everyone" });
  expect(await connectLinkState({ db: f.db }, rui.id, f.org.id, link.id)).toEqual({ status: "joined", machineId });
  expect((await joinNotices())[0]?.doneAt).not.toBeNull();
  const token = await pollDeviceToken(deps(), started.deviceCode);
  expect(token).toMatchObject({ ok: true, machineId, org: { id: f.org.id } });
  await expect(approveDeviceJoin(deps(), rui.id, f.org.id, requestId)).rejects.toThrow(NotFoundError);
  // The link was the maker's: another member can't read it.
  await expect(connectLinkState({ db: f.db }, lia.id, f.org.id, link.id)).rejects.toThrow(NotFoundError);
});

test("a computer link starts Only the maker; deny refuses the computer; an expired link says so", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const link = await createConnectLink({ db: f.db }, PUBLIC_URL, rui.id, f.org.id, "computer");
  const started = await startLinkedDeviceCode(deps(), link.code, BUILD_BOX, fromAddress);
  const requestId = (await connectLinkState({ db: f.db }, rui.id, f.org.id, link.id)).request?.id as string;
  const { machineId } = await approveDeviceJoin(deps(), rui.id, f.org.id, requestId);
  const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  expect(machine).toMatchObject({ name: "build-box", audienceMode: "owner" });
  expect(await pollDeviceToken(deps(), started.deviceCode)).toMatchObject({ ok: true });

  const second = await createConnectLink({ db: f.db }, PUBLIC_URL, rui.id, f.org.id, "computer");
  const asked = await startLinkedDeviceCode(deps(), second.code, BUILD_BOX, fromAddress);
  const secondId = (await connectLinkState({ db: f.db }, rui.id, f.org.id, second.id)).request?.id as string;
  await denyDeviceJoin(deps(), rui.id, f.org.id, secondId);
  expect(await connectLinkState({ db: f.db }, rui.id, f.org.id, second.id)).toEqual({ status: "denied" });
  expect(await pollDeviceToken(deps(), asked.deviceCode)).toEqual({ ok: false, error: "access_denied" });

  const past = new Date(Date.now() - 11 * 60_000);
  const old = await createConnectLink({ db: f.db, now: () => past }, PUBLIC_URL, rui.id, f.org.id, "server");
  expect(await openConnectLink(f.db, old.code)).toBeNull();
  await expect(startLinkedDeviceCode(deps(), old.code, BUILD_BOX, fromAddress)).rejects.toThrow(ValidationError);
  expect(await connectLinkState({ db: f.db }, rui.id, f.org.id, old.id)).toEqual({ status: "expired" });
});

test("a link's info for the desktop app: the workspace and its maker while it waits; nothing once used or expired", async () => {
  f = await setup();
  const rui = await addMember(f.db, f.org.id, "member", "rui");
  const link = await createConnectLink({ db: f.db }, PUBLIC_URL, rui.id, f.org.id, "computer");
  const info = { org: { name: "Acme" }, by: { name: "rui" }, kind: "computer" as const, expiresAt: link.expiresAt };
  expect(await connectLinkInfo(f.db, link.code)).toEqual(info);
  expect(await connectLinkInfo(f.db, link.code.replace("-", "").toLowerCase())).toEqual(info);
  expect(await connectLinkInfo(f.db, "ABCD-EFGH")).toBeNull();
  expect(await connectLinkInfo(f.db, "ABC")).toBeNull();
  expect(await connectLinkInfo(f.db, link.code, new Date(Date.parse(link.expiresAt) + 1))).toBeNull();
  await startLinkedDeviceCode(deps(), link.code, BUILD_BOX, fromAddress);
  expect(await connectLinkInfo(f.db, link.code)).toBeNull();
});

import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  authenticateMachine,
  computerTarget,
  confirmDeviceCode,
  createOrganization,
  deleteMachine,
  getDeviceCode,
  listMachines,
  pollDeviceToken,
  renameMachine,
  setAgentComputerTarget,
  startDeviceCode,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * Reconnecting a computer (ADR 0036 §5): a refused computer asks for a code
 * with the machine it was; confirmed by someone who may manage that machine
 * in its organization, the same row comes back (name, permissions, agents)
 * with a fresh token. Anything else is an ordinary new computer.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const COMPUTER = {
  name: "MacBook",
  hostname: "mac-new",
  os: "darwin",
  arch: "arm64",
  version: "1.2.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/ana/agentes",
  exec: true,
};
let ipSeq = 0;
/** A code asking to come back as `previousMachineId`, proved with `previousToken` (the token that computer had). */
const start = (previousMachineId?: string, previousToken?: string) =>
  startDeviceCode(
    { db: f.db, publicUrl: "https://agentes.chat" },
    { ...COMPUTER, ...(previousMachineId ? { previousMachineId } : {}), ...(previousToken ? { previousToken } : {}) },
    { ip: `203.0.113.${++ipSeq}` },
  );
const machineRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, id));
  if (!row) throw new Error("no machine");
  return row;
};

/** A paired machine renamed "Mac da Ana", used by `@dev`, with a folder reported. */
async function pairedWithAgent() {
  const paired = await pairMachine(deps(), f.owner.id, f.org.id, { hostname: "mac-old", name: "MacBook" });
  await renameMachine(deps(), f.owner.id, f.org.id, paired.machineId, { name: "Mac da Ana" });
  await f.db
    .update(schema.machines)
    .set({
      access: {
        folders: [{ path: "/Users/ana/notes", agents: [] }],
        tools: { claude: true, codex: false, commands: true },
      },
    })
    .where(eq(schema.machines.id, paired.machineId));
  await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, paired.machineId);
  return paired;
}

describe("reconnecting a computer", () => {
  test("after removal: the same row, name and permissions, a new token, and its agents back", async () => {
    f = await setup();
    const paired = await pairedWithAgent();
    await deleteMachine(deps(), f.owner.id, f.org.id, paired.machineId);
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toEqual({ kind: "none" });
    expect((await machineRow(paired.machineId)).previousAgentIds).toEqual([f.agent.id]);

    const s = await start(paired.machineId, paired.token);
    const view = await getDeviceCode(deps(), s.userCode, f.owner.id);
    expect(view.reconnect).toEqual({
      machineId: paired.machineId,
      name: "Mac da Ana",
      orgId: f.org.id,
      orgName: "Acme",
    });
    const confirmed = await confirmDeviceCode(deps(), f.owner.id, f.org.id, s.userCode, { name: "Ignored" });
    expect(confirmed.id).toBe(paired.machineId);
    const token = await pollDeviceToken(deps(), s.deviceCode);
    if (!token.ok) throw new Error(token.error);
    expect(token.machineId).toBe(paired.machineId);
    expect(token.name).toBe("Mac da Ana");

    const row = await machineRow(paired.machineId);
    expect(row).toMatchObject({ deletedAt: null, name: "Mac da Ana", hostname: "mac-new", runnerVersion: "1.2.0" });
    expect(row.access?.folders).toEqual([{ path: "/Users/ana/notes", agents: [] }]);
    expect(row.previousAgentIds).toEqual([]);
    expect((await authenticateMachine(f.db, token.token))?.id).toBe(paired.machineId);
    expect(await authenticateMachine(f.db, paired.token)).toBeNull();
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toMatchObject({
      kind: "machine",
      machineId: paired.machineId,
    });
    expect(await listMachines(f.db, f.owner.id, f.org.id)).toHaveLength(1);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "machine.reconnected"));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ wasRemoved: true, agents: [f.agent.id] });
  });

  test("a revoked token (row still there): the old token stops at confirm; agents stay; one moved meanwhile isn't taken back", async () => {
    f = await setup();
    const paired = await pairedWithAgent();
    const other = await pairMachine(deps(), f.owner.id, f.org.id, { hostname: "linux" });
    await deleteMachine(deps(), f.owner.id, f.org.id, paired.machineId);
    // @dev got another computer before the Mac came back.
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, other.machineId);
    const s = await start(paired.machineId, paired.token);
    await confirmDeviceCode(deps(), f.owner.id, f.org.id, s.userCode, {});
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toMatchObject({ machineId: other.machineId });

    // Now a live machine reconnects (e.g. its token was replaced): the old token stops at confirm.
    const live = await pairMachine(deps(), f.owner.id, f.org.id, { hostname: "pc" });
    const again = await start(live.machineId, live.token);
    await confirmDeviceCode(deps(), f.owner.id, f.org.id, again.userCode, {});
    expect(await authenticateMachine(f.db, live.token)).toBeNull();
    const token = await pollDeviceToken(deps(), again.deviceCode);
    expect(token).toMatchObject({ ok: true, machineId: live.machineId });
  });

  test("an uncollected reconnect stays (offline) instead of being dropped", async () => {
    f = await setup();
    const paired = await pairedWithAgent();
    await deleteMachine(deps(), f.owner.id, f.org.id, paired.machineId);
    const s = await start(paired.machineId, paired.token);
    await confirmDeviceCode(deps(), f.owner.id, f.org.id, s.userCode, {});
    const late = () => new Date(Date.now() + 11 * 60_000);
    expect(await pollDeviceToken({ ...deps(), now: late }, s.deviceCode)).toEqual({
      ok: false,
      error: "expired_token",
    });
    expect((await machineRow(paired.machineId)).deletedAt).toBeNull();
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toMatchObject({ machineId: paired.machineId });
  });

  test("no permission, another organization or an unknown id: a new computer", async () => {
    f = await setup();
    const paired = await pairedWithAgent();
    await deleteMachine(deps(), f.owner.id, f.org.id, paired.machineId);

    // A member who didn't pair it and isn't an admin.
    const carl = await addMember(f.db, f.org.id, "member", "carl");
    const byCarl = await start(paired.machineId, paired.token);
    expect((await getDeviceCode(deps(), byCarl.userCode, carl.id)).reconnect).toBeUndefined();
    const carlMachine = await confirmDeviceCode(deps(), carl.id, f.org.id, byCarl.userCode, {});
    expect(carlMachine.id).not.toBe(paired.machineId);

    // Confirmed for another organization of the owner.
    const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Other" });
    const elsewhere = await start(paired.machineId, paired.token);
    const otherMachine = await confirmDeviceCode(deps(), f.owner.id, other.id, elsewhere.userCode, {});
    expect(otherMachine.id).not.toBe(paired.machineId);
    expect(otherMachine.name).toBe("MacBook");

    // Someone outside the organization sees no reconnect.
    const zed = await addUser(f.db, "zed");
    const unknown = await start(crypto.randomUUID(), paired.token);
    expect((await getDeviceCode(deps(), unknown.userCode, zed.id)).reconnect).toBeUndefined();
    expect((await getDeviceCode(deps(), unknown.userCode, f.owner.id)).reconnect).toBeUndefined();
    const fresh = await confirmDeviceCode(deps(), f.owner.id, f.org.id, unknown.userCode, {});
    expect(fresh.id).not.toBe(paired.machineId);

    // A malformed id is ignored.
    const junk = await start("not-a-uuid", paired.token);
    expect((await confirmDeviceCode(deps(), f.owner.id, f.org.id, junk.userCode, {})).id).not.toBe(paired.machineId);

    // The removed Mac is still removed, @dev still with no computer.
    expect((await machineRow(paired.machineId)).deletedAt).not.toBeNull();
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toEqual({ kind: "none" });
  });

  test("only the computer that held the machine's token: an id alone, or another machine's token, is a new computer", async () => {
    f = await setup();
    const live = await pairedWithAgent();
    const other = await pairMachine(deps(), f.owner.id, f.org.id, { hostname: "other" });

    // Every member sees machine ids: naming a live one without its token takes nothing over.
    for (const s of [await start(live.machineId), await start(live.machineId, other.token)]) {
      expect((await getDeviceCode(deps(), s.userCode, f.owner.id)).reconnect).toBeUndefined();
      expect((await confirmDeviceCode(deps(), f.owner.id, f.org.id, s.userCode, {})).id).not.toBe(live.machineId);
    }
    expect((await authenticateMachine(f.db, live.token))?.id).toBe(live.machineId);
    expect(await computerTarget(f.db, f.org.id, f.agent.id)).toMatchObject({ machineId: live.machineId });

    // Removed: the same holds (its token hash stays for the proof, but never authenticates).
    await deleteMachine(deps(), f.owner.id, f.org.id, live.machineId);
    expect(await authenticateMachine(f.db, live.token)).toBeNull();
    const unproved = await start(live.machineId);
    expect((await getDeviceCode(deps(), unproved.userCode, f.owner.id)).reconnect).toBeUndefined();
    expect((await confirmDeviceCode(deps(), f.owner.id, f.org.id, unproved.userCode, {})).id).not.toBe(live.machineId);
    expect((await machineRow(live.machineId)).deletedAt).not.toBeNull();
  });

  test("the server's own computer never comes back as someone's computer", async () => {
    f = await setup();
    const paired = await pairMachine(deps(), f.owner.id, f.org.id, { hostname: "srv" });
    await f.db.update(schema.machines).set({ kind: "host" }).where(eq(schema.machines.id, paired.machineId));
    const s = await start(paired.machineId, paired.token);
    expect((await getDeviceCode(deps(), s.userCode, f.owner.id)).reconnect).toBeUndefined();
    expect((await confirmDeviceCode(deps(), f.owner.id, f.org.id, s.userCode, {})).id).not.toBe(paired.machineId);
    expect((await authenticateMachine(f.db, paired.token))?.id).toBe(paired.machineId);
  });

  test("the person who paired it may reconnect it without being an admin", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const paired = await pairMachine(deps(), bia.id, f.org.id, { hostname: "bia-mac", name: "Mac da Bia" });
    await deleteMachine(deps(), f.owner.id, f.org.id, paired.machineId);
    const s = await start(paired.machineId, paired.token);
    expect((await getDeviceCode(deps(), s.userCode, bia.id)).reconnect?.name).toBe("Mac da Bia");
    expect((await confirmDeviceCode(deps(), bia.id, f.org.id, s.userCode, {})).id).toBe(paired.machineId);
  });
});

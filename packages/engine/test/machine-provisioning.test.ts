import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, orgTopic, type ServerFrame } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import {
  agentComputerInfo,
  computerPreparing,
  computerSetup,
  createAgent,
  createMachineHub,
  createOrganization,
  DEVICE_CODE_TTL_MS,
  deleteMachine,
  ForbiddenError,
  issueManagedMachine,
  listMachineRequests,
  listMachines,
  type MachineHub,
  type MachineHubDeps,
  OrgPausedError,
  type ProvisioningStep,
  pollDeviceToken,
  reduceMachineAccess,
  renameMachine,
  revokeManagedMachine,
  setAgentComputerTarget,
  setOrgStanding,
  setProvisioning,
  updateOrganization,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

/**
 * The workspace's own computer from an external provisioner (ADR 0056 §10): the requests it lists, the
 * code it issues, and what the computer's first hello does.
 */

let f: Fixture;
let hub: MachineHub | null = null;
afterEach(async () => {
  setSystemTime();
  await hub?.stop();
  hub = null;
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const page = (mode: "off" | "external" = "external", query: { limit?: number; cursor?: string } = {}) =>
  listMachineRequests(f.db, mode, { limit: 50, ...query });
const requested = async () => (await page()).requests.map((r) => r.orgName);
const machineRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, id));
  if (!row) throw new Error("no machine");
  return row;
};
/** What the provisioner last said of the workspace's computer, as stored; null: nothing. */
const waitState = async (orgId = f.org.id) => {
  const [row] = await f.db
    .select({ state: schema.machineProvisioning.state })
    .from(schema.machineProvisioning)
    .where(eq(schema.machineProvisioning.orgId, orgId));
  return row?.state ?? null;
};

/**
 * `db` whose first select, in a transaction or not, says its rows came (`read`) and hands them over once `gate`
 * opens: a report that reads the workspace's standing that way writes after whatever happens meanwhile.
 */
function readThenWait(db: Database, read: () => void, gate: Promise<void>): Database {
  let first = true;
  const late = <T extends object>(query: T): T =>
    new Proxy(query, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then") {
          return (ok: (rows: unknown) => unknown, ko: (error: unknown) => unknown) =>
            (target as unknown as PromiseLike<unknown>)
              .then(async (rows) => {
                read();
                await gate;
                return rows;
              })
              .then(ok, ko);
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const next = value.apply(target, args);
          return next && typeof next === "object" ? late(next) : next;
        };
      },
    });
  const watched = <T extends object>(handle: T): T =>
    new Proxy(handle, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key === "transaction") {
          return (run: (tx: object) => unknown, ...rest: unknown[]) =>
            value.call(target, (tx: object) => run(watched(tx)), ...rest);
        }
        if (key !== "select" || !first) return value.bind(target);
        return (...args: unknown[]) => {
          first = false;
          return late(value.apply(target, args));
        };
      },
    });
  return watched(db);
}

const agentMachine = async (agentId: string) => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  return row?.machineId ?? null;
};

/** The provisioner's flow up to the token: issue a code, the computer redeems it. */
async function enrolled(orgId = f.org.id) {
  const issued = await issueManagedMachine(deps(), orgId);
  if (!issued) throw new Error("no org");
  const token = await pollDeviceToken(deps(), issued.enrollCode);
  if (!token.ok) throw new Error(`enroll failed: ${token.error}`);
  return { machineId: issued.machineId, token: token.token };
}

/** A runner saying hello over an in-memory socket (on a server that sends email with `readyEmail`), with `more` in it. */
async function hello(token: string, readyEmail: MachineHubDeps["readyEmail"] = null, more: object = {}) {
  hub ??= createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a", readyEmail });
  const sent: ServerFrame[] = [];
  let closed: string | undefined;
  const conn = hub.open({
    send: (text) => void sent.push(JSON.parse(text) as ServerFrame),
    close: (_code, reason) => {
      closed = reason;
    },
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token,
      hostname: "vm-7f3a",
      os: "linux",
      arch: "x64",
      version: "1.0.0",
      protocol: MACHINE_PROTOCOL_VERSION,
      workspace: "/var/lib/agentes-runner/work",
      exec: true,
      ...more,
    }),
  );
  const current = hub;
  return { sent, closed: () => closed, disconnect: () => current.close(conn) };
}

/** Org broadcasts of these types, as members would hear them. */
function heard(...types: string[]) {
  const events: Record<string, unknown>[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
    const event = (e as { event?: Record<string, unknown> }).event;
    if (e.type === "org.broadcast" && event && types.includes(String(event.type))) events.push(event);
  });
  return events;
}

describe("external provisioning", () => {
  test("the requests list: only with the flag, active workspaces whose computer isn't ready, oldest first", async () => {
    f = await setup();
    expect(await page("off")).toEqual({ requests: [], next: null });
    const held = await createOrganization(f.db, (await addUser(f.db, "bia")).id, { name: "Held" });
    const later = await createOrganization(f.db, (await addUser(f.db, "caio")).id, { name: "Later" });
    expect(await requested()).toEqual(["Acme", "Held", "Later"]);
    const [first] = (await page()).requests;
    expect(first).toEqual({
      orgId: f.org.id,
      orgName: "Acme",
      createdAt: expect.any(Date),
      owner: { userId: f.owner.id, email: f.owner.email },
      provisioning: null,
    });

    await setOrgStanding(deps(), held.organization.id, { state: "hold", reason: "Review", notice: "silent" });
    expect(await requested()).toEqual(["Acme", "Later"]);

    // `approval`, from an older provisioner, reads as capacity: there is no approval step.
    expect(await setProvisioning(deps(), later.organization.id, { state: "waiting", reason: "approval" })).toBe(true);
    const one = await page("external", { limit: 1 });
    expect(one.requests.map((r) => r.orgName)).toEqual(["Acme"]);
    const two = await page("external", { limit: 1, cursor: one.next ?? "" });
    expect(two.requests).toEqual([
      expect.objectContaining({
        orgName: "Later",
        provisioning: {
          state: "waiting",
          step: null,
          stage: null,
          reason: "capacity",
          since: expect.any(String),
          requestedAt: later.organization.createdAt.toISOString(),
          expectedReadyAt: null,
          specs: null,
        },
      }),
    ]);
    expect(two.next).toBeNull();

    // Ready: no longer a request.
    await hello((await enrolled()).token);
    expect(await requested()).toEqual(["Later"]);
  });

  test("progress: since restarts only on a new state or step; ready is refused until the computer is removed", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const status = () => computerSetup(f.db, "external", f.owner.id, f.org.id);
    expect(await status()).toEqual({
      mode: "external",
      state: "preparing",
      step: null,
      stage: null,
      reason: null,
      since: null,
      requestedAt: f.org.createdAt.toISOString(),
      expectedReadyAt: null,
      specs: null,
      secondsLeft: null,
      secondsWaited: expect.any(Number),
      notifyByEmail: false,
      machineId: null,
    });
    expect((await computerSetup(f.db, "off", f.owner.id, f.org.id)).mode).toBe("pair");

    const specs = { cpus: 4, memoryGb: 8, diskGb: 75 };
    const at = new Date(Date.now() + 900_000);
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "reserving", expectedReadyAt: at, specs });
    const reserving = await status();
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "reserving", expectedReadyAt: at });
    expect(await status()).toEqual({ ...reserving, secondsLeft: expect.any(Number) });
    expect(events).toHaveLength(1);
    await Bun.sleep(5);
    // A reason only goes with `waiting`; a new step with no time is the same wait, with its time.
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing", reason: "capacity" });
    const installing = await status();
    expect(installing).toMatchObject({
      state: "preparing",
      step: "installing",
      reason: null,
      expectedReadyAt: at.toISOString(),
      specs,
    });
    expect(installing.since).not.toBe(reserving.since);
    expect(events.at(-1)).toMatchObject({ type: "machine.provisioning", step: "installing", specs });
    expect(await setProvisioning(deps(), crypto.randomUUID(), { state: "problem" })).toBe(false);

    const { machineId, token } = await enrolled();
    await hello(token);
    expect(await status()).toMatchObject({ state: "ready", step: null, machineId });
    await expect(setProvisioning(deps(), f.org.id, { state: "problem" })).rejects.toMatchObject({
      code: "provisioning.ready",
    });

    // Removed: waiting again from now, with nothing reported yet.
    const revokedAt = Date.now();
    expect(await revokeManagedMachine(deps(), f.org.id, machineId)).toBe(true);
    const waiting = await status();
    expect(waiting).toMatchObject({
      state: "preparing",
      step: null,
      specs: null,
      expectedReadyAt: null,
      machineId: null,
    });
    expect(Date.parse(waiting.requestedAt ?? "")).toBeGreaterThanOrEqual(revokedAt);
    expect(waiting.since).toBe(waiting.requestedAt);
    expect(events.at(-1)).toMatchObject({
      type: "machine.provisioning",
      state: "preparing",
      requestedAt: waiting.requestedAt,
      machineId: null,
    });
    expect(await requested()).toEqual(["Acme"]);
    expect(await setProvisioning(deps(), f.org.id, { state: "problem" })).toBe(true);
    // Every later report keeps when the wait began.
    expect((await status()).requestedAt).toBe(waiting.requestedAt);
  });

  test("the stage within a step: kept with preparing only, any word, heard when it changes, since kept", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const status = () => computerSetup(f.db, "external", f.owner.id, f.org.id);
    const at = new Date(Date.now() + 600_000);
    const report = (stage?: string) =>
      setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing", stage, expectedReadyAt: at });

    await report("updating");
    const updating = await status();
    expect(updating).toMatchObject({ step: "installing", stage: "updating" });
    expect(events.at(-1)).toMatchObject({ step: "installing", stage: "updating" });
    const listed = (await page()).requests.find((r) => r.orgId === f.org.id);
    expect(listed?.provisioning).toMatchObject({ step: "installing", stage: "updating" });
    // The same report again says nothing new.
    await report("updating");
    expect(events).toHaveLength(1);
    // The restart the update needs: its people hear it, and the step it is in began when it did.
    await Bun.sleep(5);
    await report("restarting");
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ step: "installing", stage: "restarting" });
    expect((await status()).since).toBe(updating.since);
    // A word this server has no use for is kept as said: the apps read it as its step.
    await report("defragmenting");
    expect((await status()).stage).toBe("defragmenting");
    // A report without one has none, and only `preparing` has one.
    await report();
    expect((await status()).stage).toBeNull();
    expect(events.at(-1)).toMatchObject({ stage: null });
    await report("apps");
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity", stage: "apps" });
    expect(await status()).toMatchObject({ state: "waiting", stage: null });

    // Ready, then taken away: no stage left over.
    await report("apps");
    const { machineId, token } = await enrolled();
    await hello(token);
    expect(await status()).toMatchObject({ state: "ready", stage: null });
    await revokeManagedMachine(deps(), f.org.id, machineId);
    expect(await status()).toMatchObject({ state: "preparing", step: null, stage: null });
  });

  test("one wait counts down to the earliest time it was told: a later one is kept out, and it runs over", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const status = () => computerSetup(f.db, "external", f.owner.id, f.org.id);
    // A cold run as its provisioner reported it: planned again at each stage from the stage the computer was in, every
    // time later than the first, as the app install ran 50 s past its estimate. Ready came at 16:11:34.614.
    const first = Date.parse("2026-10-26T16:05:05.889Z");
    const t0 = Date.now();
    const at = (clock: string) => new Date(t0 + Date.parse(`2026-10-26T${clock}Z`) - first);
    const report = (sent: string, step: ProvisioningStep, stage: string, readyAt: string) => {
      setSystemTime(at(sent));
      return setProvisioning(deps(), f.org.id, { state: "preparing", step, stage, expectedReadyAt: at(readyAt) });
    };
    const told = at("16:10:08.587").toISOString();
    await report("16:05:05.889", "installing", "updating", "16:10:08.587");
    await report("16:06:22.927", "installing", "restarting", "16:10:41.447");
    await report("16:06:38.499", "installing", "network", "16:10:43.025");
    await report("16:06:54.782", "installing", "firewall", "16:10:44.936");
    await report("16:07:10.284", "installing", "apps", "16:10:51.961");
    // Every stage is heard, with the first time.
    expect(events.map((e) => [e.stage, e.expectedReadyAt])).toEqual(
      ["updating", "restarting", "network", "firewall", "apps"].map((stage) => [stage, told]),
    );
    expect(events.at(-1)).toMatchObject({ secondsLeft: 178 });
    setSystemTime(at("16:10:08.587"));
    expect(await status()).toMatchObject({ expectedReadyAt: told, secondsLeft: 0 });
    // Past it, the provisioner's time slides with the clock: no new time, nothing heard.
    await report("16:11:07.677", "installing", "apps", "16:11:24.500");
    expect(events).toHaveLength(5);
    expect(await status()).toMatchObject({ expectedReadyAt: told, secondsLeft: -59 });
    // The last step, still past the first time: it runs over until it is ready.
    await report("16:11:30.630", "connecting", "connecting", "16:11:43.372");
    expect(events.at(-1)).toMatchObject({ step: "connecting", expectedReadyAt: told, secondsLeft: -82 });
    for (const answer of [...events, await status()]) expect(answer).not.toHaveProperty("secondsSteady");

    // Waiting, then preparing again: a new wait, counted down to what it is told now. A part ending early brings the
    // time forward at once; a later one is kept out again.
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity" });
    await report("16:12:00.000", "reserving", "ordering", "16:26:00.000");
    expect(events.at(-1)).toMatchObject({ expectedReadyAt: at("16:26:00.000").toISOString(), secondsLeft: 840 });
    await report("16:13:00.000", "reserving", "ordering", "16:25:00.000");
    expect(events.at(-1)).toMatchObject({ expectedReadyAt: at("16:25:00.000").toISOString(), secondsLeft: 720 });
    const heardBefore = events.length;
    await report("16:13:05.000", "reserving", "ordering", "16:25:30.000");
    expect(events).toHaveLength(heardBefore);
    expect((await status()).expectedReadyAt).toBe(at("16:25:00.000").toISOString());
    // A report with no time is the same wait: its time stays, and a later one after it is still kept out.
    setSystemTime(at("16:13:10.000"));
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "reserving", stage: "ordering" });
    expect(await status()).toMatchObject({ expectedReadyAt: at("16:25:00.000").toISOString(), secondsLeft: 710 });
    await report("16:13:15.000", "reserving", "ordering", "16:26:00.000");
    expect(events).toHaveLength(heardBefore);
    expect(await status()).toMatchObject({ expectedReadyAt: at("16:25:00.000").toISOString(), secondsLeft: 705 });
    // Its computer taken away: a new wait too.
    const { machineId } = await enrolled();
    await revokeManagedMachine(deps(), f.org.id, machineId);
    await report("16:14:00.000", "starting", "wiping", "16:29:00.000");
    expect((await status()).expectedReadyAt).toBe(at("16:29:00.000").toISOString());
  });

  test("the ready time: the seconds left come from the server, a past one stays past, older words still read", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const status = () => computerSetup(f.db, "external", f.owner.id, f.org.id, true);
    const report = (expectedReadyAt?: Date, etaSeconds?: number) =>
      setProvisioning({ ...deps(), emails: true }, f.org.id, {
        state: "preparing",
        step: "installing",
        expectedReadyAt,
        etaSeconds,
      });

    const sixMinutes = new Date(Date.now() + 360_000);
    await report(sixMinutes);
    const first = await status();
    expect(first).toMatchObject({ expectedReadyAt: sixMinutes.toISOString(), notifyByEmail: true });
    expect(first.secondsLeft).toBeGreaterThan(350);
    expect(first.secondsLeft).toBeLessThanOrEqual(360);
    expect(events.at(-1)).toMatchObject({ expectedReadyAt: sixMinutes.toISOString(), notifyByEmail: true });
    // How long it has waited, counted here as well: the workspace was made two minutes ago.
    await f.db
      .update(schema.organizations)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.organizations.id, f.org.id));
    const waited = (await status()).secondsWaited ?? 0;
    expect(waited).toBeGreaterThanOrEqual(120);
    expect(waited).toBeLessThan(130);

    // It runs over: the provisioner sends "now" again and again; the first time past stays, so the wait shows late.
    const overdue = new Date(Date.now() - 90_000);
    await report(overdue);
    const heardBefore = events.length;
    await report(new Date());
    await report(new Date(Date.now() - 1000));
    expect(await status()).toMatchObject({ expectedReadyAt: overdue.toISOString() });
    expect((await status()).secondsLeft).toBeLessThanOrEqual(-90);
    // Nor does a time ahead start a countdown again: a provisioner's clock a little ahead of this one, or a new plan.
    await report(new Date(Date.now() + 10_000));
    await report(new Date(Date.now() + 120_000));
    expect(await status()).toMatchObject({ expectedReadyAt: overdue.toISOString() });
    expect(events.length).toBe(heardBefore);

    // Only `preparing` has a time.
    const later = new Date(Date.now() + 120_000);
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity", expectedReadyAt: later });
    expect(await status()).toMatchObject({
      state: "waiting",
      reason: "capacity",
      expectedReadyAt: null,
      secondsLeft: null,
    });

    // A row an older provisioner left says `approval`: it reads as capacity, and the same report keeps `since`.
    await f.db
      .update(schema.machineProvisioning)
      .set({ reason: "approval" })
      .where(eq(schema.machineProvisioning.orgId, f.org.id));
    const since = (await status()).since;
    expect((await status()).reason).toBe("capacity");
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity" });
    expect((await status()).since).toBe(since);

    // An older provisioner's countdown is a time from now, here the new wait's first.
    const sent = Date.now();
    await report(undefined, 600);
    const eta = Date.parse((await status()).expectedReadyAt ?? "");
    expect(eta).toBeGreaterThanOrEqual(sent + 600_000);
    expect(eta).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  test("the ready email is promised by a ready time over a minute ahead, waiting or a problem, until it is ready", async () => {
    f = await setup();
    const promised = async (orgId = f.org.id) => {
      const [row] = await f.db
        .select()
        .from(schema.machineProvisioning)
        .where(eq(schema.machineProvisioning.orgId, orgId));
      return row?.emailWhenReady;
    };
    const preparing = (seconds: number, orgId = f.org.id) =>
      setProvisioning(deps(), orgId, {
        state: "preparing",
        step: "starting",
        expectedReadyAt: new Date(Date.now() + seconds * 1000),
      });
    await preparing(30);
    expect(await promised()).toBe(false);
    // A later time within the same wait isn't what its people are told (they count down to the first), so it
    // promises nothing either: the email still goes if the wait itself takes over a minute.
    await preparing(90);
    expect(await promised()).toBe(false);
    const later = (await createOrganization(f.db, (await addUser(f.db, "later")).id, { name: "later" })).organization;
    await preparing(90, later.id);
    expect(await promised(later.id)).toBe(true);
    // Told once, kept: a shorter estimate doesn't take it back.
    await preparing(10, later.id);
    expect(await promised(later.id)).toBe(true);
    for (const state of ["waiting", "problem"] as const) {
      const other = await createOrganization(f.db, (await addUser(f.db, state)).id, { name: state });
      await setProvisioning(deps(), other.organization.id, { state });
      expect(await promised(other.organization.id)).toBe(true);
    }
  });

  test("issuing is idempotent per workspace: one managed row, a new code each time, the old one dead", async () => {
    f = await setup();
    const first = await issueManagedMachine(deps(), f.org.id);
    const second = await issueManagedMachine(deps(), f.org.id, { name: "Computador da Acme" });
    if (!first || !second) throw new Error("no org");
    expect(second.machineId).toBe(first.machineId);
    expect(second.enrollCode).not.toBe(first.enrollCode);
    expect(second.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(DEVICE_CODE_TTL_MS);
    const managed = await f.db
      .select()
      .from(schema.machines)
      .where(and(eq(schema.machines.orgId, f.org.id), eq(schema.machines.kind, "managed")));
    expect(managed.map((m) => [m.name, m.tokenHash, m.pairedByUserId])).toEqual([["Computador da Acme", null, null]]);
    expect(await issueManagedMachine(deps(), crypto.randomUUID())).toBeNull();

    expect(await pollDeviceToken(deps(), first.enrollCode)).toEqual({ ok: false, error: "access_denied" });
    const redeemed = await pollDeviceToken(deps(), second.enrollCode);
    expect(redeemed).toMatchObject({ ok: true, machineId: first.machineId, org: { id: f.org.id, name: "Acme" } });
    expect(await pollDeviceToken(deps(), second.enrollCode)).toEqual({ ok: false, error: "expired_token" });
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "machine.paired")));
    expect(audit).toMatchObject({ actorType: "system", actorId: null, targetId: first.machineId });

    // Not for a workspace on hold.
    await setOrgStanding(deps(), f.org.id, { state: "hold", reason: "Review", notice: "shown" });
    await expect(issueManagedMachine(deps(), f.org.id)).rejects.toBeInstanceOf(OrgPausedError);
  });

  test("its name says a computer, in its first owner's language, and follows the workspace's until renamed", async () => {
    f = await setup();
    const issued = await issueManagedMachine(deps(), f.org.id);
    if (!issued) throw new Error("no org");
    const name = async (id = issued.machineId) => (await machineRow(id)).name;
    expect(await name()).toBe("Computador da Acme");
    await updateOrganization(f.db, f.owner.id, f.org.id, { name: "Acme Labs" });
    expect(await name()).toBe("Computador da Acme Labs");
    await updateOrganization(f.db, f.owner.id, f.org.id, { context: "Clinics." });
    expect(await name()).toBe("Computador da Acme Labs");
    // A name someone gave it stays.
    await renameMachine(deps(), f.owner.id, f.org.id, issued.machineId, { name: "Servidor" });
    await updateOrganization(f.db, f.owner.id, f.org.id, { name: "Acme" });
    expect(await name()).toBe("Servidor");

    const ana = await addUser(f.db, "ana");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, ana.id));
    const { organization: beta } = await createOrganization(f.db, ana.id, { name: "Beta" });
    const english = await issueManagedMachine(deps(), beta.id);
    if (!english) throw new Error("no org");
    expect(await name(english.machineId)).toBe("Beta's computer");
    await updateOrganization(f.db, ana.id, beta.id, { name: "Beta Co" });
    expect(await name(english.machineId)).toBe("Beta Co's computer");

    // A personal workspace's (ADR 0159): its person's agents' computer, named after no workspace, so a rename stays.
    const bia = await addUser(f.db, "bia");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, bia.id));
    const { organization: home } = await createOrganization(f.db, bia.id, { name: "Personal", mode: "personal" });
    const personal = await issueManagedMachine(deps(), home.id);
    if (!personal) throw new Error("no org");
    expect(await name(personal.machineId)).toBe("Your agents' computer");
    await updateOrganization(f.db, bia.id, home.id, { name: "Home" });
    expect(await name(personal.machineId)).toBe("Your agents' computer");
  });

  test("an issued code that expires leaves the managed row; a new code still connects it", async () => {
    f = await setup();
    const issued = await issueManagedMachine(deps(), f.org.id);
    if (!issued) throw new Error("no org");
    const late = new Date(Date.now() + DEVICE_CODE_TTL_MS + 1000);
    expect(await pollDeviceToken({ ...deps(), now: () => late }, issued.enrollCode)).toEqual({
      ok: false,
      error: "expired_token",
    });
    expect((await machineRow(issued.machineId)).deletedAt).toBeNull();
    const { machineId } = await enrolled();
    expect(machineId).toBe(issued.machineId);
  });

  test("the first hello makes it ready and gives it the agents with no computer, once", async () => {
    f = await setup();
    const events = heard("machine.provisioning", "agent.computer");
    // Created while it is being prepared: no computer yet, and the agent says it is on its way.
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing" });
    const early = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, { model: "auto" });
    expect(early.machineId).toBeNull();
    expect(await agentComputerInfo({ db: f.db }, f.org.id, early.id)).toEqual({ kind: "none", preparing: true });
    // Paid, nothing reported yet: nobody can connect one here, so it is on its way too. People connecting theirs: not.
    const { organization: paid } = await createOrganization(f.db, f.owner.id, { name: "Paid just now" });
    expect(await computerPreparing({ db: f.db, workspaceComputer: { billing: true } }, paid.id)).toBe(true);
    expect(await computerPreparing({ db: f.db }, paid.id)).toBe(false);

    const { machineId, token } = await enrolled();
    const runner = await hello(token);
    expect(runner.sent[0]).toMatchObject({ type: "welcome", machineId });
    expect(await agentMachine(f.agent.id)).toBe(machineId);
    expect(await agentMachine(early.id)).toBe(machineId);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "machine.provisioning",
          state: "ready",
          step: null,
          stage: null,
          reason: null,
          since: expect.any(String),
          requestedAt: f.org.createdAt.toISOString(),
          expectedReadyAt: null,
          specs: null,
          secondsLeft: null,
          secondsWaited: expect.any(Number),
          notifyByEmail: false,
          machineId,
        },
        {
          type: "agent.computer",
          agentId: f.agent.id,
          target: { kind: "machine", machineId, name: "Computador da Acme", online: true },
        },
      ]),
    );
    expect(runner.sent.find((s) => s.type === "agents")).toMatchObject({
      agents: expect.arrayContaining([expect.objectContaining({ id: early.id })]),
    });
    const told = await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "computer_ready"));
    expect(told.map((n) => [n.userId, n.source])).toEqual([[f.owner.id, { machineId, label: "Computador da Acme" }]]);

    // Someone takes an agent off it; a reconnect leaves that choice alone and tells nobody again.
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, early.id, null);
    await runner.disconnect();
    const count = events.length;
    await hello(token);
    expect(await agentMachine(early.id)).toBeNull();
    expect(events.length).toBe(count);
    expect(
      await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "computer_ready")),
    ).toHaveLength(1);

    // New agents are born on it.
    const later = await createAgent(f.db, f.owner.id, f.org.id, { name: "Later", handle: "later" }, { model: "auto" });
    expect(later.machineId).toBe(machineId);
  });

  test("a ready computer's size is what its runner reports, so a resize shows; before, the provisioner's", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const specs = async () => (await computerSetup(f.db, "external", f.owner.id, f.org.id)).specs;
    const promised = { cpus: 4, memoryGb: 8, diskGb: 100 };
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing", specs: promised });
    const first = await enrolled();
    // A runner that reports no size leaves the provisioner's.
    await hello(first.token);
    expect(await specs()).toEqual(promised);
    expect(events.at(-1)).toMatchObject({ state: "ready", specs: promised });
    // The runner rounds memory to half a GB: the apps print whole ones.
    await hello(first.token, null, { size: { cpus: 4, memoryGb: 7.5, diskGb: 92 } });
    expect(await specs()).toEqual({ cpus: 4, memoryGb: 8, diskGb: 92 });
    // Grown once ready, which the provisioner can no longer report.
    await hello(first.token, null, { size: { cpus: 6, memoryGb: 11.5, diskGb: 184 } });
    expect(await specs()).toEqual({ cpus: 6, memoryGb: 12, diskGb: 184 });
    // Inside a container, what the container may use.
    await hello(first.token, null, { size: { cpus: 6, memoryGb: 11.5, diskGb: 184, limit: { cpus: 2, memoryGb: 4 } } });
    expect(await specs()).toEqual({ cpus: 2, memoryGb: 4, diskGb: 184 });

    // Removed, then a new one: the provisioner's while it is prepared, its runner's from its first hello on.
    await revokeManagedMachine(deps(), f.org.id, first.machineId);
    await setProvisioning(deps(), f.org.id, { state: "preparing", step: "installing", specs: promised });
    expect(await specs()).toEqual(promised);
    await hello((await enrolled()).token, null, { size: { cpus: 4, memoryGb: 8, diskGb: 92 } });
    expect(events.at(-1)).toMatchObject({ state: "ready", specs: { cpus: 4, memoryGb: 8, diskGb: 92 } });
  });

  test("the ready email: to the owners by language, once, when promised; a wait counts from the removal", async () => {
    f = await setup();
    const readyEmail = { publicUrl: "https://chat.example.com/", gateway: { hasModelCredential: async () => true } };
    const emails = async () =>
      (await f.db.select().from(schema.outbox))
        .filter((j) => j.kind === "email.send")
        .map((j) => j.payload as { key: string; to: string[]; template: Record<string, unknown> })
        .sort((a, b) => a.key.localeCompare(b.key));
    const caio = await addMember(f.db, f.org.id, "owner", "caio");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, caio.id));
    await addMember(f.db, f.org.id, "admin", "bia");

    // A spare claimed at once: no email.
    const quick = await enrolled();
    let runner = await hello(quick.token, readyEmail);
    expect(await emails()).toEqual([]);

    // An old workspace whose computer is taken away and made again at once: the wait began at the removal.
    await f.db
      .update(schema.organizations)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(schema.organizations.id, f.org.id));
    await runner.disconnect();
    await revokeManagedMachine(deps(), f.org.id, quick.machineId);
    runner = await hello((await enrolled()).token);
    expect(await emails()).toEqual([]);

    // Told it takes longer: the owners get it, each in their language; an admin doesn't.
    await runner.disconnect();
    await revokeManagedMachine(deps(), f.org.id, quick.machineId);
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity" });
    const again = await enrolled();
    await hello(again.token);
    const [readyAt] = await f.db
      .select({ since: schema.machineProvisioning.since })
      .from(schema.machineProvisioning)
      .where(eq(schema.machineProvisioning.orgId, f.org.id));
    const key = `computer_ready:${again.machineId}:${readyAt?.since.getTime()}`;
    const [pt, en] = await emails();
    expect(pt).toEqual({
      key,
      to: [f.owner.email],
      template: {
        kind: "computer_ready",
        locale: "pt-BR",
        orgName: "Acme",
        specs: null,
        needsAi: false,
        hasAgents: true,
        crew: [{}],
        url: `https://chat.example.com/org/${f.org.id}`,
      },
    });
    expect(en).toMatchObject({ key: `${key}:en`, to: [caio.email], template: { locale: "en" } });

    // A reconnect is no new ready: nothing more.
    await hello(again.token);
    expect(await emails()).toHaveLength(2);
  });

  test("the ready email: a wait over a minute with nothing promised; none from a server that sends no email", async () => {
    f = await setup();
    const queued = async () => (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    await f.db
      .update(schema.organizations)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.organizations.id, f.org.id));
    // Promised, but this server sends no email.
    await setProvisioning(deps(), f.org.id, { state: "problem" });
    await hello((await enrolled()).token);
    expect(await queued()).toEqual([]);
    await hub?.stop();
    hub = null;

    // Made over a minute ago, on a server that sends email, with no agent of its own yet: its right hand (ADR 0137)
    // is no crew, but thinks on the workspace's key, so the AI is connected.
    const other = await createOrganization(f.db, (await addUser(f.db, "caio")).id, { name: "Beta" });
    await f.db
      .update(schema.organizations)
      .set({ createdAt: new Date(Date.now() - 61_000) })
      .where(eq(schema.organizations.id, other.organization.id));
    const { token } = await enrolled(other.organization.id);
    await hello(token, { publicUrl: "https://chat.example.com", gateway: { hasModelCredential: async () => true } });
    const [email] = await queued();
    expect(email?.payload).toMatchObject({
      template: { kind: "computer_ready", orgName: "Beta", needsAi: false, hasAgents: false, crew: [] },
    });
  });

  test("the ready email goes out with the ready or not at all, and not to a workspace that isn't active", async () => {
    f = await setup();
    const readyEmail = { publicUrl: "https://chat.example.com", gateway: { hasModelCredential: async () => true } };
    const queued = async (orgId = f.org.id) =>
      (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send" && j.orgId === orgId);
    const state = async (orgId = f.org.id) => {
      const [row] = await f.db
        .select({ state: schema.machineProvisioning.state })
        .from(schema.machineProvisioning)
        .where(eq(schema.machineProvisioning.orgId, orgId));
      return row?.state;
    };
    await setProvisioning(deps(), f.org.id, { state: "problem" });
    const { token } = await enrolled();
    // The email can't be queued: the computer doesn't turn ready without it, and the next hello does both.
    await f.db.execute(
      sql.raw(
        "create function no_email() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$",
      ),
    );
    await f.db.execute(
      sql.raw(
        "create trigger no_email before insert on outbox for each row when (new.kind = 'email.send') execute function no_email()",
      ),
    );
    const first = await hello(token, readyEmail);
    expect(await state()).toBe("problem");
    expect(await queued()).toEqual([]);
    await f.db.execute(sql.raw("drop trigger no_email on outbox"));
    await first.disconnect();
    await hello(token);
    expect(await state()).toBe("ready");
    expect(await queued()).toHaveLength(1);

    // Put on hold while its computer was being made: ready, but no email telling its owners to give a first task.
    const held = await createOrganization(f.db, (await addUser(f.db, "bia")).id, { name: "Held" });
    await setProvisioning(deps(), held.organization.id, { state: "problem" });
    const heldComputer = await enrolled(held.organization.id);
    await setOrgStanding(deps(), held.organization.id, { state: "hold", reason: "Review", notice: "silent" });
    await hello(heldComputer.token);
    expect(await state(held.organization.id)).toBe("ready");
    expect(await queued(held.organization.id)).toEqual([]);
  });

  test("a workspace held, suspended or ended waits for no computer; active again, it is a request like any other", async () => {
    f = await setup();
    const events = heard("machine.provisioning");
    const standings = heard("org.standing");
    const nothing = {
      mode: "external" as const,
      state: null,
      step: null,
      stage: null,
      reason: null,
      since: null,
      requestedAt: null,
      expectedReadyAt: null,
      specs: null,
      secondsLeft: null,
      secondsWaited: null,
      notifyByEmail: true,
      machineId: null,
    };
    // Waiting for capacity, then ended before any computer came: the wait goes, and its people are told of none
    // (their apps ask again on `org.standing`).
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity" });
    expect(await waitState()).toBe("waiting");
    const end = { state: "hold", reason: "ended", notice: "shown" } as const;
    await setOrgStanding(deps(), f.org.id, end);
    expect(await waitState()).toBeNull();
    expect(standings.at(-1)).toMatchObject({ type: "org.standing", state: "hold" });
    expect(await computerSetup(f.db, "external", f.owner.id, f.org.id, true)).toEqual(nothing);
    // Nothing reported before it was held either: no wait to tell of.
    const bia = await addUser(f.db, "bia");
    const other = (await createOrganization(f.db, bia.id, { name: "Other" })).organization.id;
    await setOrgStanding(deps(), other, end);
    expect(await computerSetup(f.db, "external", bia.id, other, true)).toEqual(nothing);
    // A report sent as it was held is refused, so nothing says a computer is on its way again.
    const late = await setProvisioning(deps(), f.org.id, { state: "preparing", step: "starting" }).catch((e) => e);
    expect(late).toBeInstanceOf(OrgPausedError);
    expect(late).toMatchObject({ code: "org.paused" });
    expect(await waitState()).toBeNull();

    // Active again: a request like any other, waiting again, and its reports count.
    await setOrgStanding(deps(), f.org.id, { state: "active", reason: "reactivated", notice: "shown" });
    expect(await requested()).toEqual(["Acme"]);
    expect((await page()).requests[0]?.provisioning).toBeNull();
    expect(await computerSetup(f.db, "external", f.owner.id, f.org.id)).toMatchObject({
      state: "preparing",
      since: null,
    });
    expect(await setProvisioning(deps(), f.org.id, { state: "preparing", step: "starting" })).toBe(true);

    // A ready computer stays ready while its workspace is held or suspended; taken away then, no wait starts.
    const { machineId, token } = await enrolled();
    await hello(token);
    await setOrgStanding(deps(), f.org.id, end);
    expect(await computerSetup(f.db, "external", f.owner.id, f.org.id)).toMatchObject({ state: "ready", machineId });
    await setOrgStanding(deps(), f.org.id, { state: "suspended", reason: "Abuse", notice: "silent" });
    expect(await waitState()).toBe("ready");
    expect(await revokeManagedMachine(deps(), f.org.id, machineId)).toBe(true);
    expect(await waitState()).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: "machine.provisioning", state: null, since: null, machineId: null });
    expect(await requested()).toEqual([]);
    await setOrgStanding(deps(), f.org.id, { state: "active", reason: "Reviewed", notice: "silent" });
    expect(await requested()).toEqual(["Acme"]);
  });

  test("a report sent as the workspace is held never brings the wait back", async () => {
    f = await setup();
    const waiting = { state: "waiting", reason: "capacity" } as const;
    await setProvisioning(deps(), f.org.id, waiting);
    let read = () => {};
    const readIt = new Promise<void>((resolve) => {
      read = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The report has read the workspace active when the hold comes, and writes once the hold is done or after a
    // moment it holds the hold up: either the hold drops what the report wrote, or it waits for the report to.
    const report = setProvisioning({ ...deps(), db: readThenWait(f.db, read, gate) }, f.org.id, waiting).catch(
      (e) => e,
    );
    await readIt;
    const hold = setOrgStanding(deps(), f.org.id, { state: "hold", reason: "ended", notice: "shown" });
    await Promise.race([hold, Bun.sleep(200)]);
    release();
    await Promise.all([report, hold]);
    expect(await waitState()).toBeNull();
  });

  test("a hold that can't drop the wait isn't set: nothing is left half done for a retry to finish", async () => {
    f = await setup();
    await setProvisioning(deps(), f.org.id, { state: "waiting", reason: "capacity" });
    // The drop fails as a full disk would make it.
    await f.db.execute(
      sql.raw("create function refuse_delete() returns trigger language plpgsql as $$ begin raise 'disk full'; end $$"),
    );
    await f.db.execute(
      sql.raw(
        "create trigger refuse before delete on machine_provisioning for each row execute function refuse_delete()",
      ),
    );
    const suspend = { state: "suspended", reason: "Abuse", notice: "silent" } as const;
    await expect(setOrgStanding(deps(), f.org.id, suspend)).rejects.toThrow();
    const [org] = await f.db
      .select({ standing: schema.organizations.standing })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, f.org.id));
    expect(org?.standing).toBe("active");
    expect(await waitState()).toBe("waiting");
    await f.db.execute(sql.raw("drop trigger refuse on machine_provisioning"));
    expect(await setOrgStanding(deps(), f.org.id, suspend)).toMatchObject({ state: "suspended" });
    expect(await waitState()).toBeNull();
  });

  test("the migration drops the waits of workspaces that weren't active before the server did it itself", async () => {
    f = await setup();
    const org = async (name: string, standing: "active" | "hold" | "suspended", state: string) => {
      const made = await createOrganization(f.db, (await addUser(f.db, name.toLowerCase())).id, { name });
      const orgId = made.organization.id;
      await f.db.update(schema.organizations).set({ standing }).where(eq(schema.organizations.id, orgId));
      await f.db.insert(schema.machineProvisioning).values({ orgId, state });
      return orgId;
    };
    const waiting = await org("Waiting", "active", "waiting");
    const ended = await org("Ended", "hold", "waiting");
    const retired = await org("Retired", "hold", "preparing");
    const closed = await org("Closed", "suspended", "problem");
    const kept = await org("Kept", "hold", "ready");
    await runMigration(f.db, "idle_provisioning");
    await runMigration(f.db, "idle_provisioning");
    const rows = await f.db
      .select({ orgId: schema.machineProvisioning.orgId, state: schema.machineProvisioning.state })
      .from(schema.machineProvisioning);
    expect(Object.fromEntries(rows.map((r) => [r.orgId, r.state]))).toEqual({ [waiting]: "waiting", [kept]: "ready" });
    for (const gone of [ended, retired, closed]) expect(rows.some((r) => r.orgId === gone)).toBe(false);
  });

  test("people see it without its insides and can't remove it; the provisioner can", async () => {
    f = await setup();
    const admin = await addMember(f.db, f.org.id, "admin");
    const member = await addMember(f.db, f.org.id, "member");
    const { machineId, token } = await enrolled();
    const runner = await hello(token);
    const [view] = await listMachines(f.db, member.id, f.org.id);
    expect(view).toMatchObject({
      id: machineId,
      kind: "managed",
      hostname: "",
      os: "other",
      arch: "",
      workspace: null,
    });
    expect((await listMachines(f.db, admin.id, f.org.id))[0]).toMatchObject({ hostname: "", workspace: null });

    for (const who of [f.owner.id, admin.id]) {
      const refused = await deleteMachine(deps(), who, f.org.id, machineId).catch((e) => e);
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect(refused).toMatchObject({ code: "machine.managed" });
      // Nor turned down: nobody here could turn a tool or a folder back on.
      const hub = { call: async () => ({ access: {} }), status: async () => ({ online: true }) } as never;
      for (const input of [{ disableTool: "commands" as const }, { removeFolder: { path: "/srv/shared" } }]) {
        const reduced = await reduceMachineAccess({ ...deps(), hub }, who, f.org.id, machineId, input).catch((e) => e);
        expect(reduced).toMatchObject({ code: "machine.managed_access" });
      }
    }
    // Nobody paired it: an agent's owner may put their agent back on it.
    const own = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Mine", handle: "mine", ownerUserId: member.id },
      { model: "auto" },
    );
    await setAgentComputerTarget(deps(), member.id, f.org.id, own.id, null);
    expect(await setAgentComputerTarget(deps(), member.id, f.org.id, own.id, machineId)).toMatchObject({ machineId });

    expect(await revokeManagedMachine(deps(), crypto.randomUUID(), machineId)).toBe(false);
    expect(await revokeManagedMachine(deps(), f.org.id, machineId)).toBe(true);
    await Bun.sleep(1);
    expect(runner.closed()).toBe("revoked");
    expect((await machineRow(machineId)).deletedAt).not.toBeNull();
    expect(await agentMachine(f.agent.id)).toBeNull();
    expect(await requested()).toEqual(["Acme"]);
    expect(await revokeManagedMachine(deps(), f.org.id, machineId)).toBe(false);

    // Issued again: the same row comes back, ready again on its next first hello.
    const again = await enrolled();
    expect(again.machineId).toBe(machineId);
    await hello(again.token);
    expect(await agentMachine(f.agent.id)).toBe(machineId);
  });
});

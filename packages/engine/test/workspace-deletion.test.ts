import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import {
  type ComposioClient,
  createFakeComposioClient,
  createFakeMailConnector,
  MailError,
  orgTopic,
  type ServerFrame,
  STREAM_CLOSE,
} from "@agenteschat/adapters";
import { and, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { Glob } from "bun";
import {
  agentBrainSummaries,
  assertCanWork,
  assertInviting,
  authorizeStream,
  type ConnectorDeps,
  calendarRange,
  canViewCost,
  completeOAuth,
  composioToolkitUrl,
  consolidateItem,
  createContextToolSource,
  createInvitation,
  createJobHandlers,
  createMachineHub,
  createOrganization,
  type DeletionDeps,
  drainOutbox,
  enableOperatorEvents,
  enqueue,
  enqueueOverdueDeletions,
  getDeviceCode,
  getMembership,
  insertMessage,
  inviteLink,
  issueManagedMachine,
  joinOrganization,
  listMachineRequests,
  listMemberships,
  listRoutines,
  MACHINE_CONTROL_TOPIC,
  type MachineHub,
  ORG_DELETE_JOB,
  ORG_FILES_PURGE_JOB,
  OrgDeletingError,
  onManagedMachineHello,
  onUserCreated,
  orgStanding,
  PURGED_BY_HAND,
  postPersonMessage,
  previewInvitation,
  purgeWorkspace,
  removeMember,
  requestNewInvitation,
  requireBrowserAccess,
  requireChannelAccess,
  requirePermission,
  restoreWorkspace,
  revokeManagedMachine,
  routeMessage,
  runErrorDetail,
  scheduleDeletion,
  setBillingHold,
  setDeletionHold,
  setOrgStanding,
  setProvisioning,
  signupAdmission,
  standingRefusal,
  startDeviceCode,
  startOAuth,
  stopOrgWork,
  type ToolContext,
  unfinishedWorkspaces,
} from "../src";
import { addMember, addUser, type Fixture, SECRET, setup } from "./fixtures";
import { pairMachine, RUNNER } from "./machine-fixtures";
import { agentRunRow, channelRoutine, fire, routineRunRow } from "./routine-fixtures";

let f: Fixture;
const hubs: MachineHub[] = [];
afterEach(async () => {
  enableOperatorEvents(false);
  for (const hub of hubs.splice(0)) await hub.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DAY = 86_400_000;
/** What a deletion writes on the workspace's row: it closes until `dueAt`. */
const closing = (orgId: string, dueAt = new Date(Date.now() + 7 * DAY)) =>
  f.db.update(schema.organizations).set({ deletionDueAt: dueAt }).where(eq(schema.organizations.id, orgId));

/** Whether a call let the person through: false when it was refused because the workspace is being deleted. */
const lets = (call: Promise<unknown>) =>
  call.then(
    () => true,
    (error: unknown) => {
      if (error instanceof OrgDeletingError) return false;
      throw error;
    },
  );

const runs = () => f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);

/** A run of `@dev` on the owner's message, as a tool sees it. */
async function runContext(): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "forget that",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

describe("a workspace being deleted is read-only", () => {
  test("its people still read it and every other way in refuses it, the operator's suspension first; back open, they let people in", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const computer = await pairMachine(deps, f.owner.id, f.org.id, { name: "MacBook" });
    const comeBack = await startDeviceCode(
      { db: f.db, publicUrl: "https://agentes.chat" },
      {
        name: "MacBook",
        os: "linux",
        arch: "x64",
        hostname: "box",
        version: "0.1.0",
        previousMachineId: computer.machineId,
        previousToken: computer.token,
      },
      { ip: "203.0.113.7" },
    );
    const link = await inviteLink(f.db, SECRET, f.owner.id, f.org.id);
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "zoe@example.com", role: "member" });
    const asked = await runContext();
    const forget = (await createContextToolSource(f.context).tools(asked)).find((t) => t.name === "forget");
    if (!forget) throw new Error("no forget tool");

    const ways: [string, () => Promise<boolean>][] = [
      ["every permission check", () => lets(requirePermission(f.db, f.owner.id, f.org.id, "read"))],
      ["reading a channel", () => lets(requireChannelAccess(f.db, f.owner.id, f.org.id, f.general.id))],
      // What posts without the API too (a voice note's job).
      ["posting", () => lets(postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "still here?" }))],
      ["work", async () => (await standingRefusal(f.db, f.org.id)) === null],
      [
        "inviting",
        async () => {
          const member = await getMembership(f.db, f.owner.id, f.org.id);
          if (!member) throw new Error("no membership");
          return lets((async () => assertInviting(member))());
        },
      ],
      [
        "browser hand-offs",
        () => lets(requireBrowserAccess(f.db, f.owner.id, f.org.id, f.agent.id, undefined, "browser")),
      ],
      [
        "desktop streams",
        async () => {
          const target = await authorizeStream(
            { db: f.db, hub: { isLocal: () => false } },
            { userId: f.owner.id, orgId: f.org.id, agentId: f.agent.id, request: { kind: "desktop", mode: "watch" } },
          );
          return !("refused" in target) || target.refused !== STREAM_CLOSE.forbidden || target.reason !== "deleting";
        },
      ],
      [
        "brain settings",
        async () => {
          const agent = {
            id: f.agent.id,
            brain: "claude_code",
            brainModel: null,
            machineId: computer.machineId,
            ownerUserId: null,
          };
          return (
            (await agentBrainSummaries(f.db, f.owner.id, f.org.id, [agent])).get(f.agent.id)?.computer !== undefined
          );
        },
      ],
      [
        "context tools",
        async () => {
          const { item } = await consolidateItem(f.db, {
            orgId: f.org.id,
            kind: "fact",
            scopeType: "org",
            subject: crypto.randomUUID(),
            content: `Launch window ${crypto.randomUUID()}`,
          });
          return !(await forget.execute({ item_id: item.id }, asked)).isError;
        },
      ],
      ["usage", () => canViewCost(f.db, f.owner.id, f.org.id)],
      [
        "the computer device check",
        async () => (await getDeviceCode(deps, comeBack.userCode, f.owner.id)).reconnect !== undefined,
      ],
      ["invitation links", async () => !(await previewInvitation(f.db, link.token))?.closed],
      [
        "sign-up by invitation",
        async () =>
          (await signupAdmission(f.db, "zoe@example.com", { allowSignup: false, ownerByLink: false })) === "invitation",
      ],
      [
        "joining",
        async () => {
          const newcomer = await addUser(f.db, "newcomer");
          return lets(f.db.transaction((tx) => joinOrganization(tx, f.org.id, newcomer.id, "member")));
        },
      ],
      [
        "the provisioner's requests",
        async () =>
          (await listMachineRequests(f.db, "external", { limit: 50 })).requests.some((r) => r.orgId === f.org.id),
      ],
    ];
    const open = async () => {
      const result: Record<string, boolean> = {};
      for (const [way, check] of ways) result[way] = await check();
      return result;
    };
    const all = (value: boolean) => Object.fromEntries(ways.map(([way]) => [way, value]));
    const standing = (state: "active" | "hold" | "suspended") =>
      f.db
        .update(schema.organizations)
        .set({ standing: state, standingReason: state === "active" ? null : "review", standingNotice: "shown" })
        .where(eq(schema.organizations.id, f.org.id));

    expect(await open()).toEqual(all(true));
    const dueAt = new Date(Date.now() + 7 * DAY);
    await closing(f.org.id, dueAt);
    // Reading stays open until it goes (the API refuses its changes): what only reads.
    const reads = ["every permission check", "reading a channel", "brain settings", "usage"];
    expect(await open()).toEqual({ ...all(false), ...Object.fromEntries(reads.map((way) => [way, true])) });
    expect(await standingRefusal(f.db, f.org.id)).toMatchObject({
      code: "org.deleting",
      message: "This workspace is being deleted.",
      params: { dueAt: dueAt.toISOString() },
      retryable: false,
    });
    // Past its date, nothing says when.
    await closing(f.org.id, new Date(Date.now() - DAY));
    expect(await standingRefusal(f.db, f.org.id)).toMatchObject({ code: "org.deleting", params: undefined });
    // A hold says less than the deletion; the operator's suspension says more, and closes reading too.
    await standing("hold");
    expect(await standingRefusal(f.db, f.org.id)).toMatchObject({ code: "org.deleting" });
    await standing("suspended");
    await expect(requirePermission(f.db, f.owner.id, f.org.id, "read")).rejects.toMatchObject({
      code: "org.suspended",
    });

    await standing("active");
    await f.db.update(schema.organizations).set({ deletionDueAt: null }).where(eq(schema.organizations.id, f.org.id));
    expect(await open()).toEqual(all(true));
  });

  test("who you are and leaving stay open", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await closing(f.org.id);
    expect(await listMemberships(f.db, bia.id)).toMatchObject([
      { orgId: f.org.id, standing: { state: "active", deletionDueAt: expect.any(Date) } },
    ]);
    await removeMember(f.db, bia.id, f.org.id, bia.id);
    expect(await listMemberships(f.db, bia.id)).toEqual([]);
  });

  test("a sign-in begun before it began being deleted comes back to nothing: no connection is saved", async () => {
    f = await setup();
    await expect(githubGrant(() => closing(f.org.id))).rejects.toBeInstanceOf(OrgDeletingError);
    expect(await f.db.select().from(schema.connectorConnections)).toEqual([]);
  });

  test("asking for a new invitation tells nobody there, and the router asks no agent to answer in it", async () => {
    f = await setup();
    const { token } = await createInvitation(f.db, f.owner.id, f.org.id, { email: "zoe@example.com", role: "member" });
    await f.db.update(schema.organizationInvitations).set({ expiresAt: new Date(Date.now() - 1000) });
    await closing(f.org.id);
    await requestNewInvitation(f.db, "https://chat.example.com", token);
    expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"))).toEqual([]);

    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "anyone?",
    });
    const strategy = { name: "spy", decide: async () => ({ agents: [] }) };
    const routed = await routeMessage(
      { db: f.db, strategy, policy: { minScore: 0.5, maxAgents: 2, maxHops: 3 } },
      { orgId: f.org.id, messageId: message.id },
    );
    expect(routed).toEqual({ runs: [], skipped: "org_deleting" });
  });

  test("work stops at once: a run fails and says why, a routine's slot passes and none is ahead, a job fails for good", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    expect(routine.nextRunAt).not.toBeNull();
    const calendar = () =>
      calendarRange(
        { db: f.db },
        f.owner.id,
        f.org.id,
        new Date().toISOString(),
        new Date(Date.now() + 2 * DAY).toISOString(),
      );
    expect((await calendar()).routines.length).toBeGreaterThan(0);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev check the build",
    });
    await closing(f.org.id);
    // Its slots pass: nothing says when it runs next, nor shows a time on the calendar.
    expect(await listRoutines(f.db, f.owner.id, f.org.id)).toMatchObject([{ id: routine.id, nextRunAt: null }]);
    expect((await calendar()).routines).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
    const [run] = await runs();
    expect(run).toMatchObject({ status: "failed", error: "This workspace is being deleted." });
    expect(runErrorDetail(run?.error)).toEqual({ errorCode: "run.org_deleting" });
    expect(await fire(f, routine.id, new Date())).toMatchObject({
      status: "skipped",
      code: "org_deleting",
      agentRunId: null,
    });

    await enqueue(f.db, { orgId: f.org.id, kind: "test.work", payload: {} });
    await drainOutbox(f.db, { "test.work": () => assertCanWork(f.db, f.org.id) });
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "test.work"));
    expect(job).toMatchObject({ status: "failed", lastError: "This workspace is being deleted." });
  });

  test("what its agents had going stops, its routines' runs as being deleted", async () => {
    f = await setup();
    const fired = await fire(f, (await channelRoutine(f)).id, new Date());
    const text = new OrgDeletingError(null).message;
    await stopOrgWork({ db: f.db, pubsub: f.pubsub }, f.org.id, text, "org_deleting");
    expect(await routineRunRow(f, fired.id)).toMatchObject({ status: "canceled", code: "org_deleting" });
    const run = await agentRunRow(f, fired.agentRunId);
    expect(run).toMatchObject({ status: "canceled", error: text });
    expect(runErrorDetail(run.error)).toEqual({ errorCode: "run.org_deleting" });
  });

  test("its computer: no request, no report, no code, no ready email, and taken away it waits for none", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    // Told it takes a while: the owners are promised the ready email.
    await setProvisioning(deps, f.org.id, { state: "waiting", reason: "capacity" });
    const issued = await issueManagedMachine(deps, f.org.id);
    if (!issued) throw new Error("no org");
    await closing(f.org.id);

    expect((await listMachineRequests(f.db, "external", { limit: 50 })).requests).toEqual([]);
    await expect(setProvisioning(deps, f.org.id, { state: "preparing", step: "starting" })).rejects.toMatchObject({
      code: "org.deleting",
    });
    await expect(issueManagedMachine(deps, f.org.id)).rejects.toMatchObject({ code: "org.deleting" });

    const machine = { id: issued.machineId, orgId: f.org.id, name: "Acme's computer", kind: "managed" as const };
    const readyEmail = {
      publicUrl: "https://chat.example.com",
      gateway: { hasModelCredential: async () => true },
      machines: null,
    };
    await onManagedMachineHello({ ...deps, readyEmail }, machine);
    const emails = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
    expect(emails).toEqual([]);
    // Nor ready at all: no agent gets it, and no owner hears of it in the app or on a phone.
    expect((await f.db.select().from(schema.machineProvisioning)).map((p) => p.state)).toEqual(["waiting"]);
    expect((await f.db.select({ machineId: schema.agents.machineId }).from(schema.agents))[0]?.machineId).toBeNull();
    expect(await f.db.select().from(schema.notifications)).toEqual([]);

    const heard: Record<string, unknown>[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const event = (e as { event?: Record<string, unknown> }).event;
      if (event?.type === "machine.provisioning") heard.push(event);
    });
    expect(await revokeManagedMachine(deps, f.org.id, issued.machineId)).toBe(true);
    const waits = await f.db.select().from(schema.machineProvisioning);
    expect(waits).toEqual([]);
    expect(heard).toMatchObject([{ state: null, machineId: null }]);
  });

  test("the onboarding starts a new workspace instead of resuming one being deleted", async () => {
    f = await setup();
    const first = await createOrganization(f.db, f.owner.id, { name: "Rockets" }, { onboarding: true });
    expect((await unfinishedWorkspaces(f.db, f.owner.id)).map((u) => u.organization.id)).toEqual([
      first.organization.id,
    ]);
    await closing(first.organization.id);
    expect(await unfinishedWorkspaces(f.db, f.owner.id)).toEqual([]);
    const next = await createOrganization(f.db, f.owner.id, { name: "Rockets" }, { onboarding: true });
    expect(next.existing).toBe(false);
  });

  test("one being deleted waits for no plan; a trust hold on it still refuses a new workspace", async () => {
    f = await setup();
    const bia = await addUser(f.db, "bia");
    const first = await createOrganization(f.db, bia.id, { name: "First" }, { holdForPayment: true });
    await expect(createOrganization(f.db, bia.id, { name: "Second" }, { holdForPayment: true })).rejects.toMatchObject({
      code: "org.create_unpaid",
      params: { orgId: first.organization.id },
    });
    await closing(first.organization.id);
    const second = await createOrganization(f.db, bia.id, { name: "Second" }, { holdForPayment: true });
    expect(second.organization.standingReason).toBe("payment");

    await setOrgStanding({ db: f.db }, first.organization.id, { state: "hold", reason: "review", notice: "silent" });
    await expect(createOrganization(f.db, bia.id, { name: "Third" })).rejects.toMatchObject({
      code: "org.create_refused",
    });
  });

  test("a server's first account owns every workspace but those being deleted", async () => {
    const { db, close } = await createTestDatabase();
    try {
      await db
        .insert(schema.organizations)
        .values([{ name: "Kept" }, { name: "Going", deletionDueAt: new Date(Date.now() + 7 * DAY) }]);
      const zoe = await addUser(db, "zoe");
      await onUserCreated(db, zoe.id);
      expect((await listMemberships(db, zoe.id)).map((m) => m.orgName)).toEqual(["Kept"]);
    } finally {
      await close();
    }
  });
});

const PUBLIC_URL = "https://chat.example.com";
/** What the routes give scheduling and restoring here: the fixture's database and pub/sub, on a server that emails. */
const deletionDeps = (): DeletionDeps => ({ db: f.db, pubsub: f.pubsub, emails: { publicUrl: PUBLIC_URL } });
const orgRow = async (orgId = f.org.id) =>
  (await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)))[0] ?? null;
const jobs = (kind: string) => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, kind));
const auditOf = (action: string) => f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
const feedOf = (type: string) => f.db.select().from(schema.operatorEvents).where(eq(schema.operatorEvents.type, type));
/** The emails queued, by recipient: their outbox row's org and their template. */
const emailsOf = async (kind: string) =>
  Object.fromEntries(
    (await jobs("email.send")).flatMap((job) => {
      const { to, template } = job.payload as { to: string[]; template: { kind: string } };
      return template.kind === kind ? [[to[0], { orgId: job.orgId, ...template }]] : [];
    }),
  );
/** The database wrote the date: a test moves it back to make the purge due. */
const pastItsDate = (orgId = f.org.id) =>
  f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.organizations.id, orgId));
/** The events broadcast to a workspace's people from now on. */
function heard(orgId = f.org.id) {
  const events: Record<string, unknown>[] = [];
  f.pubsub.subscribe(orgTopic(orgId), (e) => {
    const event = (e as { event?: Record<string, unknown> }).event;
    if (event) events.push(event);
  });
  return events;
}
/** The code a call was refused with, or null when it went through. */
const refused = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: { code?: string }) => error.code ?? String(error),
  );

describe("deleting a workspace", () => {
  test("an owner's deletion: read-only and stopped now, its date 7 days out, the audit row, the feed, one email per member, and the job at the date", async () => {
    f = await setup();
    enableOperatorEvents();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, bia.id));
    await f.db.insert(schema.organizationSettings).values({ orgId: f.org.id, timezone: "America/Sao_Paulo" });
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "Europe/Lisbon" })
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, bia.id)));
    await setProvisioning({ db: f.db, pubsub: f.pubsub }, f.org.id, { state: "waiting", reason: "capacity" });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev check the build",
    });
    const events = heard();

    expect(await refused(scheduleDeletion(deletionDeps(), bia.id, f.org.id, "owner"))).toBe("forbidden");
    const { dueAt, scheduled } = await scheduleDeletion(deletionDeps(), f.owner.id, f.org.id, "owner");
    expect(scheduled).toBe(true);
    const row = await orgRow();
    expect(row).toMatchObject({ deletionDueAt: dueAt, deletionRequestedBy: f.owner.id, deletionHoldAt: null });
    expect(dueAt.getTime() - (row?.deletionRequestedAt?.getTime() ?? 0)).toBe(7 * DAY);
    expect(await refused(requirePermission(f.db, caio.id, f.org.id, "read"))).toBeNull();
    expect(await refused(assertCanWork(f.db, f.org.id))).toBe("org.deleting");

    const due = dueAt.toISOString();
    expect(await auditOf("organization.deletion_scheduled")).toMatchObject([
      { orgId: f.org.id, actorId: f.owner.id, details: { dueAt: due, via: "owner" } },
    ]);
    expect(await feedOf("organization.deletion_requested")).toMatchObject([
      { orgId: f.org.id, userId: f.owner.id, data: { dueAt: due, via: "owner" } },
    ]);
    const told = { orgId: null, kind: "workspace_deleting", orgName: "Acme", byName: "ana", dueAt: due };
    const url = `${PUBLIC_URL}/org/${f.org.id}`;
    expect(await emailsOf("workspace_deleting")).toEqual({
      [f.owner.email]: { ...told, locale: "pt-BR", timeZone: "America/Sao_Paulo", owner: true, url },
      [bia.email]: { ...told, locale: "en", timeZone: "Europe/Lisbon", owner: false, url },
      [caio.email]: { ...told, locale: "pt-BR", timeZone: "America/Sao_Paulo", owner: false, url },
    });
    expect(await jobs(ORG_DELETE_JOB)).toMatchObject([
      {
        orgId: null,
        payload: { orgId: f.org.id },
        nextAttemptAt: dueAt,
        dedupeKey: `${ORG_DELETE_JOB}:${f.org.id}:${dueAt.getTime()}`,
      },
    ]);
    expect(events).toContainEqual({
      type: "org.deleting",
      orgId: f.org.id,
      dueAt: due,
      by: { id: f.owner.id, name: "ana" },
    });
    expect(await runs()).toMatchObject([{ status: "canceled", error: "This workspace is being deleted." }]);
    expect(await f.db.select().from(schema.machineProvisioning)).toEqual([]);
  });

  test("deleting it again keeps its date, and nobody is told or queued twice", async () => {
    f = await setup();
    const first = await scheduleDeletion(deletionDeps(), f.owner.id, f.org.id, "owner");
    const outbox = await f.db.select().from(schema.outbox);
    const events = heard();
    expect(await scheduleDeletion(deletionDeps(), f.owner.id, f.org.id, "owner")).toEqual({
      dueAt: first.dueAt,
      scheduled: false,
    });
    expect(await f.db.select().from(schema.outbox)).toEqual(outbox);
    expect(await auditOf("organization.deletion_scheduled")).toHaveLength(1);
    expect(events).toEqual([]);
  });

  test("holds refuse no deletion: a trust hold and the operator's deletion hold make the purge wait, billing holds don't; a suspension refuses its owners", async () => {
    f = await setup();
    const deps = deletionDeps();
    await setOrgStanding({ db: f.db }, f.org.id, { state: "hold", reason: "review", notice: "silent" });
    expect((await scheduleDeletion(deps, f.owner.id, f.org.id, "owner")).scheduled).toBe(true);
    await pastItsDate();
    expect(await purgeWorkspace({ db: f.db }, f.org.id)).toBe(false);
    expect(await orgRow()).not.toBeNull();
    await setOrgStanding({ db: f.db }, f.org.id, { state: "active", reason: null, notice: "shown" });
    expect(await purgeWorkspace({ db: f.db }, f.org.id)).toBe(true);
    expect(await orgRow()).toBeNull();

    const bia = await addUser(f.db, "bia");
    for (const hold of ["payment", "unpaid", "ended"] as const) {
      const orgId = (await createOrganization(f.db, bia.id, { name: hold })).organization.id;
      await setBillingHold({ db: f.db }, orgId, hold);
      await scheduleDeletion(deps, bia.id, orgId, "owner");
      await pastItsDate(orgId);
      expect({ hold, purged: await purgeWorkspace({ db: f.db }, orgId) }).toEqual({ hold, purged: true });
    }

    // The operator's deletion hold: the purge waits, and nothing the workspace reads changes.
    const held = (await createOrganization(f.db, bia.id, { name: "Held" })).organization.id;
    await scheduleDeletion(deps, bia.id, held, "owner");
    const events = heard(held);
    const seen = async () => ({
      standing: await orgStanding(f.db, held),
      memberships: await listMemberships(f.db, bia.id),
      audit: await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, held)),
      notifications: await f.db.select().from(schema.notifications),
    });
    const before = await seen();
    expect(await setDeletionHold(f.db, held, { held: true, reason: "legal_hold" })).toEqual({
      heldAt: expect.any(Date),
      reason: "legal_hold",
    });
    expect(await seen()).toEqual(before);
    expect(events).toEqual([]);
    await pastItsDate(held);
    expect(await purgeWorkspace({ db: f.db }, held)).toBe(false);
    await setDeletionHold(f.db, held, { held: false, reason: null });
    expect(await purgeWorkspace({ db: f.db }, held)).toBe(true);

    const cy = await addUser(f.db, "cy");
    const suspended = (await createOrganization(f.db, cy.id, { name: "Suspended" })).organization.id;
    await setOrgStanding({ db: f.db }, suspended, { state: "suspended", reason: "abuse", notice: "shown" });
    expect(await refused(scheduleDeletion(deps, cy.id, suspended, "owner"))).toBe("org.suspended");
    expect((await orgRow(suspended))?.deletionDueAt).toBeNull();
  });
});

describe("restoring a workspace", () => {
  test("another owner restores it before its date: it opens again, everyone is told, and the deletion hold stays", async () => {
    f = await setup();
    const dora = await addMember(f.db, f.org.id, "owner", "dora");
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const { dueAt } = await scheduleDeletion(deletionDeps(), f.owner.id, f.org.id, "owner");
    await setDeletionHold(f.db, f.org.id, { held: true, reason: "legal_hold" });
    enableOperatorEvents();

    expect(await refused(restoreWorkspace(deletionDeps(), bia.id, f.org.id))).toBe("forbidden");
    await restoreWorkspace(deletionDeps(), dora.id, f.org.id);
    expect(await orgRow()).toMatchObject({
      deletionDueAt: null,
      deletionRequestedAt: null,
      deletionRequestedBy: null,
      deletionHoldAt: expect.any(Date),
      deletionHoldReason: "legal_hold",
    });
    expect(await standingRefusal(f.db, f.org.id)).toBeNull();
    expect(await auditOf("organization.deletion_canceled")).toMatchObject([
      { orgId: f.org.id, actorId: dora.id, details: { dueAt: dueAt.toISOString() } },
    ]);
    expect(await feedOf("organization.deletion_canceled")).toMatchObject([{ orgId: f.org.id, userId: dora.id }]);
    const told = { orgId: null, kind: "workspace_restored", orgName: "Acme", byName: "dora", locale: "pt-BR" };
    const url = `${PUBLIC_URL}/org/${f.org.id}`;
    expect(await emailsOf("workspace_restored")).toEqual({
      [f.owner.email]: { ...told, url },
      [dora.email]: { ...told, url },
      [bia.email]: { ...told, url },
    });

    // Deleted again, it still waits for the hold.
    await scheduleDeletion(deletionDeps(), dora.id, f.org.id, "owner");
    await pastItsDate();
    expect(await purgeWorkspace({ db: f.db }, f.org.id)).toBe(false);
  });

  test("refused past its date, when it isn't being deleted, while suspended, and for a second workspace waiting for its first plan", async () => {
    f = await setup();
    await scheduleDeletion(deletionDeps(), f.owner.id, f.org.id, "owner");
    await pastItsDate();
    expect(await refused(restoreWorkspace(deletionDeps(), f.owner.id, f.org.id))).toBe("org.not_restorable");

    const bia = await addUser(f.db, "bia");
    const open = (await createOrganization(f.db, bia.id, { name: "Open" })).organization.id;
    expect(await refused(restoreWorkspace(deletionDeps(), bia.id, open))).toBe("org.not_restorable");
    await scheduleDeletion(deletionDeps(), bia.id, open, "owner");
    await setOrgStanding({ db: f.db }, open, { state: "suspended", reason: "abuse", notice: "shown" });
    expect(await refused(restoreWorkspace(deletionDeps(), bia.id, open))).toBe("org.suspended");

    const cy = await addUser(f.db, "cy");
    const first = (await createOrganization(f.db, cy.id, { name: "First" }, { holdForPayment: true })).organization.id;
    await scheduleDeletion(deletionDeps(), cy.id, first, "owner");
    const second = (await createOrganization(f.db, cy.id, { name: "Second" }, { holdForPayment: true })).organization
      .id;
    await expect(restoreWorkspace(deletionDeps(), cy.id, first)).rejects.toMatchObject({
      code: "org.create_unpaid",
      params: { orgId: second },
    });
  });

  test("a restore begun before the date that gets the lock after it is refused: the purge may have begun", async () => {
    f = await setup();
    await scheduleDeletion(deletionDeps(), f.owner.id, f.org.id, "owner");
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: sql`now() + interval '300 milliseconds'` })
      .where(eq(schema.organizations.id, f.org.id));
    // Its transaction begins now, and it waits past the date (for a purge holding the workspace's lock).
    const waits = {
      transaction: (run: (tx: unknown) => Promise<unknown>) =>
        f.db.transaction(async (tx) => {
          await Bun.sleep(600);
          return run(tx);
        }),
    } as unknown as DeletionDeps["db"];
    expect(await refused(restoreWorkspace({ db: waits }, f.owner.id, f.org.id))).toBe("org.not_restorable");
  });
});

/** A row in each table the purge deletes by hand, all of the fixture's workspace. */
async function rowsPurgedByHand() {
  const orgId = f.org.id;
  const message = await insertMessage(f.db, {
    orgId,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "ship it",
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: message.id,
      triggerMessageId: message.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  await f.db
    .insert(schema.messageReactions)
    .values({ orgId, messageId: message.id, userId: f.owner.id, reaction: "+1" });
  await f.db
    .insert(schema.routingDecisions)
    .values({ orgId, channelId: f.general.id, messageId: message.id, strategy: "none", candidates: [] });
  await f.db.insert(schema.threadReflections).values({ orgId, threadRootId: message.id, channelId: f.general.id });
  await f.db.insert(schema.usageRecords).values({
    orgId,
    kind: "router",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    requestedModel: "claude-haiku-5-5",
    inputTokens: 1,
    outputTokens: 1,
    costNanoUsd: 1,
  });
  await f.db.insert(schema.wikiLinks).values({ orgId, fromType: "message", fromId: message.id, toSlug: "launch" });
  await f.db.insert(schema.contextUsage).values({ orgId, runId: run.id, itemId: crypto.randomUUID() });
  // A run restarted since (its row deleted) left its memory's use behind.
  await f.db.insert(schema.contextUsage).values({ orgId, runId: crypto.randomUUID(), itemId: crypto.randomUUID() });
}

const countOf = async (table: string) =>
  rowsOf<{ n: number }>(await f.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)}`))[0]?.n;

/**
 * A GitHub connection over OAuth, on a fake GitHub that records calls and drops the grant. `meanwhile` happens while
 * the person is at GitHub, between the start and the return.
 */
async function githubGrant(meanwhile?: () => Promise<unknown>) {
  const calls: { url: string; method: string }[] = [];
  const http = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "gho_token_1", token_type: "bearer", scope: "repo" });
    }
    if (url.includes("/applications/gh-client/token")) return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const deps: ConnectorDeps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    publicUrl: "https://app.example.com",
    oauthApps: { github: { clientId: "gh-client", clientSecret: "gh-secret" } },
    http,
  };
  const { state } = await startOAuth(deps, f.owner.id, f.org.id, "github");
  await meanwhile?.();
  await completeOAuth(deps, { id: f.owner.id }, { state, code: "good-code" });
  return { deps, revoked: () => calls.filter((c) => c.method === "DELETE").map((c) => c.url) };
}

const ACCOUNT_ID = "0193dddd-0000-4000-8000-000000000001";

/** A runner on `hub` that holds its answer to removing an AI account until `release()`; it answers the rest at once. */
function holdingRunner(hub: MachineHub, token: string) {
  const removals: string[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      const answer = () => hub.message(conn, JSON.stringify({ type: "result", id: frame.id, ok: true, data: {} }));
      if (frame.op !== "account" || frame.action !== "remove") return void setTimeout(answer, 1);
      removals.push(frame.accountId);
      void released.then(answer);
    },
    close() {},
  });
  const hello = () => hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true, accounts: [] }));
  return { removals, release: () => release(), hello };
}

describe("the purge", () => {
  test("before its date it waits; at its date the workspace goes with every row, its grants, files and computers", async () => {
    f = await setup();
    enableOperatorEvents();
    const computer = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
    const revoked: unknown[] = [];
    f.pubsub.subscribe(MACHINE_CONTROL_TOPIC, (e) => {
      if (e.type === "machine.revoke") revoked.push(e.machineId);
    });
    await rowsPurgedByHand();
    const github = await githubGrant();
    const deps = { db: f.db, pubsub: f.pubsub, connectors: github.deps };
    await scheduleDeletion(deletionDeps(), f.owner.id, f.org.id, "owner");
    const requestedAt = (await orgRow())?.deletionRequestedAt;
    expect(await purgeWorkspace(deps, f.org.id)).toBe(false);
    expect(await orgRow()).not.toBeNull();
    expect(github.revoked()).toEqual([]);

    await pastItsDate();
    expect(await purgeWorkspace(deps, f.org.id)).toBe(true);
    expect(await orgRow()).toBeNull();
    expect(await f.db.select().from(schema.channels)).toEqual([]);
    for (const table of PURGED_BY_HAND) expect({ table, rows: await countOf(table) }).toEqual({ table, rows: 0 });
    expect(github.revoked()).toEqual(["https://api.github.com/applications/gh-client/token"]);
    expect(await feedOf("organization.deleted")).toMatchObject([
      { orgId: f.org.id, userId: f.owner.id, data: { requestedAt: requestedAt?.toISOString(), via: "owner" } },
    ]);
    expect((await jobs(ORG_FILES_PURGE_JOB)).map((j) => [j.orgId, j.payload, j.dedupeKey])).toEqual([
      [null, { orgId: f.org.id }, null],
      [null, { orgId: f.org.id }, `${ORG_FILES_PURGE_JOB}:${f.org.id}:late`],
    ]);
    expect(Object.keys(await emailsOf("workspace_deleting"))).toEqual([f.owner.email]);
    expect(revoked).toEqual([computer.machineId]);
    // Again, or from the sweep: nothing left to do.
    expect(await purgeWorkspace(deps, f.org.id)).toBe(false);
  });

  test("its AI accounts leave its online computers first: the purge waits for the runner to sign them out", async () => {
    f = await setup();
    const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-a" });
    hubs.push(hub);
    const { machineId, token } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "mac",
      ...RUNNER,
      exec: true,
    });
    const runner = holdingRunner(hub, token);
    await runner.hello();
    await f.db.insert(schema.machineAccounts).values({
      id: ACCOUNT_ID,
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "Claude Max",
      status: "active",
      createdBy: f.owner.id,
    });
    await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
    await pastItsDate();

    const purging = purgeWorkspace({ db: f.db, pubsub: f.pubsub }, f.org.id);
    for (let i = 0; i < 200 && runner.removals.length === 0; i++) await Bun.sleep(10);
    expect(runner.removals).toEqual([ACCOUNT_ID]);
    await Bun.sleep(400);
    expect(await orgRow()).not.toBeNull();
    runner.release();
    expect(await purging).toBe(true);
    expect(await orgRow()).toBeNull();
  });

  test("a grant it can't revoke fails the job and keeps the workspace; the last attempt deletes it and logs the ids", async () => {
    f = await setup();
    const [box] = await f.db
      .insert(schema.mailAccounts)
      .values({
        orgId: f.org.id,
        provider: "gmail",
        via: "composio",
        address: "team@example.com",
        status: "active",
        externalAccountId: "ca_1",
      })
      .returning();
    if (!box) throw new Error("no mailbox");
    const composio = createFakeComposioClient();
    const client: ComposioClient = {
      ...composio.client,
      deleteConnectedAccount: async () => {
        throw new MailError("Composio answered 503", true);
      },
    };
    const warned: Record<string, unknown>[] = [];
    const handlers = createJobHandlers({
      ...f.jobDeps,
      mail: { composio: { client, connector: createFakeMailConnector().connector }, imap: null },
      log: { info: () => {}, warn: (message, data) => warned.push({ message, ...data }) },
    });
    await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
    await pastItsDate();
    const due = () =>
      f.db.update(schema.outbox).set({ nextAttemptAt: new Date() }).where(eq(schema.outbox.kind, ORG_DELETE_JOB));
    await f.db.update(schema.outbox).set({ maxAttempts: 2 }).where(eq(schema.outbox.kind, ORG_DELETE_JOB));

    await due();
    await drainOutbox(f.db, handlers, { maxBatches: 1 });
    expect(await orgRow()).not.toBeNull();
    expect(await jobs(ORG_DELETE_JOB)).toMatchObject([
      { status: "pending", attempts: 1, lastError: `Grants not revoked yet: ${box.id}` },
    ]);

    await due();
    await drainOutbox(f.db, handlers, { maxBatches: 1 });
    expect(await orgRow()).toBeNull();
    expect(await jobs(ORG_DELETE_JOB)).toMatchObject([{ status: "done" }]);
    expect(warned).toEqual([
      { message: "workspace deletion went on with grants not revoked", orgId: f.org.id, ids: [box.id] },
    ]);
  });

  test("the GitHub App is uninstalled from the workspace's GitHub accounts; one GitHub refuses waits for a retry", async () => {
    f = await setup();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const app = { appId: "123", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
    let down = true;
    const deleted: string[] = [];
    const http = {
      apiUrl: "https://api.github.test",
      fetch: (async (url: string, init: RequestInit = {}) => {
        if (init.method !== "DELETE") return new Response("unexpected", { status: 500 });
        if (url.endsWith("/32") && down) return new Response("down", { status: 502 });
        deleted.push(url);
        return new Response(null, { status: url.endsWith("/33") ? 404 : 204 });
      }) as unknown as typeof fetch,
    };
    const rows = await f.db
      .insert(schema.githubAppInstallations)
      .values(
        [31, 32, 33].map((installationId) => ({
          orgId: f.org.id,
          installationId,
          accountLogin: `acct${installationId}`,
          accountType: "Organization",
        })),
      )
      .returning();
    const handlers = createJobHandlers({ ...f.jobDeps, githubApp: { app: () => app, http } });
    await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
    await pastItsDate();
    const due = () =>
      f.db.update(schema.outbox).set({ nextAttemptAt: new Date() }).where(eq(schema.outbox.kind, ORG_DELETE_JOB));

    await due();
    await drainOutbox(f.db, handlers, { maxBatches: 1 });
    expect(await orgRow()).not.toBeNull();
    const refused = rows.find((r) => r.installationId === 32)?.id;
    expect(await jobs(ORG_DELETE_JOB)).toMatchObject([
      { status: "pending", lastError: `Grants not revoked yet: ${refused}` },
    ]);
    // Uninstalled (or already gone) ones aren't asked again.
    const left = await f.db.select().from(schema.githubAppInstallations);
    expect(left.map((r) => r.installationId)).toEqual([32]);

    down = false;
    await due();
    await drainOutbox(f.db, handlers, { maxBatches: 1 });
    expect(await orgRow()).toBeNull();
    expect([...deleted].sort()).toEqual([31, 32, 33].map((id) => `https://api.github.test/app/installations/${id}`));
  });
  test("a mailbox another workspace still uses keeps the grant they share; one nobody else uses loses it", async () => {
    f = await setup();
    const box = (address: string, externalAccountId: string, orgId = f.org.id) => ({
      orgId,
      provider: "gmail",
      via: "composio",
      address,
      status: "active",
      externalAccountId,
    });
    const team = await createOrganization(f.db, f.owner.id, { name: "Team" });
    await f.db
      .insert(schema.mailAccounts)
      .values([
        box("me@example.com", "ca_1"),
        box("team@example.com", "ca_2"),
        box("me@example.com", "ca_3", team.organization.id),
      ]);
    const composio = createFakeComposioClient();
    const mail = { composio: { client: composio.client, connector: createFakeMailConnector().connector }, imap: null };
    await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
    await pastItsDate();
    expect(await purgeWorkspace({ db: f.db, mail }, f.org.id)).toBe(true);
    expect(composio.state.deletedAccounts.sort()).toEqual(["ca_1", "ca_2"]);
    expect(composio.state.grantsKept).toEqual(["ca_1"]);
  });

  test("a mailbox's grant stays while a Drive of its Google account outlives the purge; the workspace's own goes first", async () => {
    f = await setup();
    const team = await createOrganization(f.db, f.owner.id, { name: "Team" });
    const box = (address: string, externalAccountId: string) => ({
      orgId: f.org.id,
      provider: "gmail",
      via: "composio",
      address,
      status: "active",
      externalAccountId,
    });
    const drive = (orgId: string, accountId: string, composioAccountId: string) => {
      const id = crypto.randomUUID();
      return {
        id,
        orgId,
        connector: `custom:${id}`,
        label: "Google Drive",
        toolPrefix: "google_drive",
        serverUrl: composioToolkitUrl("googledrive"),
        authType: "oauth",
        composioAccountId,
        accountId,
      };
    };
    await f.db.insert(schema.mailAccounts).values([box("me@example.com", "ca_1"), box("team@example.com", "ca_2")]);
    await f.db
      .insert(schema.connectorConnections)
      .values([
        drive(f.org.id, "me@example.com", "ca_own"),
        drive(team.organization.id, "team@example.com", "ca_team"),
      ]);
    const composio = createFakeComposioClient();
    const mail = { composio: { client: composio.client, connector: createFakeMailConnector().connector }, imap: null };
    await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
    await pastItsDate();
    expect(await purgeWorkspace({ db: f.db, mail }, f.org.id)).toBe(true);
    expect(composio.state.revokedAccounts).toEqual(["ca_1"]);
    expect(composio.state.grantsKept.sort()).toEqual(["ca_2", "ca_own"]);
  });

  test("its connectors through Composio go away there too, disconnected ones included, never revoked (ADR 0107)", async () => {
    f = await setup();
    const drive = "https://backend.composio.dev/api/v3.1/toolkits/googledrive";
    const row = (composioAccountId: string, toolPrefix: string, revokedAt: Date | null = null) => {
      const id = crypto.randomUUID();
      return {
        id,
        orgId: f.org.id,
        connector: `custom:${id}`,
        label: `Google Drive ${toolPrefix}`,
        toolPrefix,
        serverUrl: drive,
        authType: "oauth",
        composioAccountId,
        revokedAt,
      };
    };
    await f.db
      .insert(schema.connectorConnections)
      .values([row("ca_9", "google_drive"), row("ca_8", "google_drive_old", new Date())]);
    // Its Connect Links: the one that made ca_9, and one whose account no connection holds (a sign-in that never
    // finished, or one someone else finished on the link).
    const link = (composioAccountId: string) => ({
      orgId: f.org.id,
      connector: "custom",
      userId: f.owner.id,
      stateHash: crypto.randomUUID(),
      serverUrl: drive,
      composioAccountId,
      expiresAt: new Date(),
    });
    await f.db.insert(schema.oauthStates).values([link("ca_9"), link("ca_7")]);
    const composio = createFakeComposioClient();
    const mail = { composio: { client: composio.client, connector: createFakeMailConnector().connector }, imap: null };
    await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
    await pastItsDate();
    expect(await purgeWorkspace({ db: f.db, mail }, f.org.id)).toBe(true);
    expect(composio.state.deletedAccounts.sort()).toEqual(["ca_7", "ca_8", "ca_9"]);
    expect(composio.state.revokedAccounts).toEqual([]);
  });

  test("a hold that commits while the purge revokes grants wins: the workspace stays, its grants revoked", async () => {
    f = await setup();
    await f.db.insert(schema.mailAccounts).values({
      orgId: f.org.id,
      provider: "gmail",
      via: "composio",
      address: "team@example.com",
      status: "active",
      externalAccountId: "ca_1",
    });
    const composio = createFakeComposioClient();
    const client: ComposioClient = {
      ...composio.client,
      deleteConnectedAccount: async (id) => {
        // Meanwhile, an operator puts a legal hold on it.
        await setDeletionHold(f.db, f.org.id, { held: true, reason: "legal_hold" });
        await composio.client.deleteConnectedAccount(id);
      },
    };
    await scheduleDeletion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "owner");
    await pastItsDate();
    const mail = { composio: { client, connector: createFakeMailConnector().connector }, imap: null };
    expect(await purgeWorkspace({ db: f.db, mail }, f.org.id)).toBe(false);
    expect(await orgRow()).toMatchObject({ deletionHoldReason: "legal_hold" });
    expect(composio.state.deletedAccounts).toEqual(["ca_1"]);
  });
});

describe("the hourly sweep", () => {
  test("queues the purge of the workspaces past their date that nothing keeps, once an hour", async () => {
    f = await setup();
    const bia = await addUser(f.db, "bia");
    const make = async (name: string) => (await createOrganization(f.db, bia.id, { name })).organization.id;
    const [due, billing, reviewed, held, later] = [
      await make("Due"),
      await make("Billing"),
      await make("Reviewed"),
      await make("Held"),
      await make("Later"),
    ];
    for (const orgId of [due, billing, reviewed, held, later]) {
      await scheduleDeletion({ db: f.db }, bia.id, orgId, "owner");
      if (orgId !== later) await pastItsDate(orgId);
    }
    await setBillingHold({ db: f.db }, billing, "unpaid");
    await setOrgStanding({ db: f.db }, reviewed, { state: "hold", reason: "review", notice: "silent" });
    await setDeletionHold(f.db, held, { held: true, reason: "legal_hold" });
    const swept = async () =>
      (await jobs(ORG_DELETE_JOB))
        .filter((job) => /:\d{4}-\d\d-\d\dT\d\d$/.test(job.dedupeKey ?? ""))
        .map((job) => (job.payload as { orgId: string }).orgId)
        .sort();

    const now = new Date();
    expect(await enqueueOverdueDeletions(f.db, now)).toBe(2);
    expect(await enqueueOverdueDeletions(f.db, now)).toBe(2);
    expect(await swept()).toEqual([due, billing].sort());
    await enqueueOverdueDeletions(f.db, new Date(now.getTime() + 3600_000));
    expect(await swept()).toEqual([due, due, billing, billing].sort());
  });
});

describe("no orphans", () => {
  test("every table with org_id goes with its workspace: a cascade on it, a chain of them on columns never null, or by hand", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const tables = rowsOf<{ name: string }>(
        await db.execute(sql`
          select c.relname as name from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
          where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition`),
      ).map((t) => t.name);
      const keys = rowsOf<{ child: string; parent: string; columns: string; required: boolean }>(
        await db.execute(sql`
          select k.conrelid::regclass::text as child, k.confrelid::regclass::text as parent,
            string_agg(a.attname, ',' order by a.attname) as columns, bool_and(a.attnotnull) as required
          from pg_constraint k
          join pg_class c on c.oid = k.conrelid
          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
          where k.contype = 'f' and k.confdeltype = 'c' and not c.relispartition
          group by k.oid, k.conrelid, k.confrelid`),
      );
      const gone = new Set(["organizations"]);
      for (const key of keys) if (key.parent === "organizations" && key.columns === "org_id") gone.add(key.child);
      for (let more = true; more; ) {
        more = false;
        for (const key of keys) {
          if (key.required && gone.has(key.parent) && !gone.has(key.child)) {
            gone.add(key.child);
            more = true;
          }
        }
      }
      // Kept on purpose: the operator's feed (ADR 0056 §5), and the join codes' counts, gone after a day (ADR 0072).
      const kept = ["operator_events", "organization_join_code_events"];
      expect(tables.filter((t) => !gone.has(t)).sort()).toEqual([...PURGED_BY_HAND, ...kept].sort());
    } finally {
      await close();
    }
  });
});

describe("one closed predicate", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  /** A standing compared to a state: as a value, through Drizzle, or in SQL. */
  const COMPARES = [
    /\b(state|standing)\s*[!=]==?\s*["'](active|hold|suspended)["']/,
    /["'](active|hold|suspended)["']\s*[!=]==?\s*[\w.?]*\b(state|standing)\b/,
    /\b(eq|ne)\(\s*[\w.]*organizations\.standing\s*,\s*["']/,
    /\b(inArray|notInArray)\(\s*[\w.]*organizations\.standing\s*,\s*\[/,
    /standing\}?\s*(=|<>|!=|in\b|is (not )?distinct from)\s*\(?\s*'(active|hold|suspended)'/i,
  ];

  test("only standing.ts compares a workspace's standing to a state (`closedRefusal`, `workRefusal`, `openOrg`)", async () => {
    const found: string[] = [];
    for (const dir of ["packages/engine/src", "apps/server/src"]) {
      for await (const file of new Glob("**/*.ts").scan(join(REPO, dir))) {
        const path = `${dir}/${file}`;
        if (path === "packages/engine/src/standing.ts") continue;
        const lines = (await Bun.file(join(REPO, path)).text()).split("\n");
        lines.forEach((line, i) => {
          if (COMPARES.some((pattern) => pattern.test(line))) found.push(`${path}:${i + 1}`);
        });
      }
    }
    expect(found).toEqual([]);
  });
});

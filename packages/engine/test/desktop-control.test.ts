import { afterEach, describe, expect, test } from "bun:test";
import {
  DESKTOP_PROTOCOL,
  DESKTOP_SWITCH_PROTOCOL,
  type MachineRequest,
  STREAM_CLOSE,
  type StreamRequest,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  authorizeStream,
  BROWSER_SCOPE,
  type BrowserLiveMessage,
  browserHandoffRecipient,
  ConflictError,
  computerDrivers,
  createBrowserHandoffToolSource,
  createBrowserLive,
  createDesktopControl,
  createStreamBroker,
  DESKTOP_SCOPE,
  type DesktopControl,
  desktopPicture,
  desktopStatus,
  drainOutbox,
  ForbiddenError,
  finishHandoff,
  grantScopes,
  type MachineCaller,
  type MachineHub,
  type MachineStatus,
  noticeCategoryOf,
  postPersonMessage,
  type RunnerLink,
  reauthorizeStream,
  recheckStream,
  renderPush,
  requireBrowserAccess,
  requireComputerDriver,
  type Stream,
  type StreamBroker,
  setAgentHold,
  setOrgStanding,
  startTakeover,
  streamClosed,
  waitIfPersonInControl,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { type FakeSocket, fakeSocket, until } from "./stream-fixtures";

let f: Fixture;
let broker: StreamBroker | undefined;
let control: DesktopControl | undefined;
afterEach(async () => {
  broker?.stop();
  control?.close();
  broker = undefined;
  control = undefined;
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const WATCH: StreamRequest = { kind: "desktop", mode: "watch" };
const CONTROL: StreamRequest = { kind: "desktop", mode: "control" };
const TERMINAL: StreamRequest = { kind: "terminal", cols: 80, rows: 24 };
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ACCESS = {
  folders: [],
  tools: { claude: false, codex: false, commands: true, browser: true, desktop: true, terminal: true },
};

/** "sign in" makes the agent ask for help on its desktop. */
const reply = (req: ModelRequest) => {
  const last = JSON.stringify(req.messages.at(-1)?.content);
  if (last.includes("tool_result")) return { chunks: ["Ok."] };
  if (last.includes("sign in")) {
    return {
      chunks: [],
      toolUses: [{ name: "desktop_ask_person", input: { instructions: "Sign in to the bank app" } }],
    };
  }
  return { chunks: ["Feito."] };
};

/** The agent's computer as the tools see it: online, serving its browser and desktops. */
const toolHub: MachineCaller = {
  async status(id): Promise<MachineStatus | null> {
    return {
      id,
      orgId: f.org.id,
      name: "Box",
      online: true,
      execAllowed: true,
      os: "linux",
      protocol: DESKTOP_PROTOCOL,
      executors: { browser: { available: true }, desktop: { available: true }, terminal: { available: true } },
      paused: null,
      access: ACCESS,
    } as MachineStatus;
  },
  async call() {
    throw new Error("no runner for the tools in these tests");
  },
};

/**
 * The owner's agent on a Linux computer the owner paired, serving desktops (so its browser runs on its
 * desktop), with this server's stream broker and desktop control. The hub plays the runner: each
 * `stream.open` dials a data socket and says hello; `desktop.session.*` answers as a running desktop.
 */
async function start(options: { recheckMs?: number; agent?: boolean } = {}) {
  /** What the hooks saw: each stream part's mode as it started (`ready`) and ended (`closed`). */
  const hooks = { ready: [] as string[], closed: [] as string[] };
  /** The computer's side of each stream: its data socket and what the broker sent there. */
  const runners: { socket: FakeSocket; link: RunnerLink }[] = [];
  f = await setup({
    machines: true,
    reply,
    ...(options.agent ? { toolSources: [createBrowserHandoffToolSource({ machines: { hub: toolHub } })] } : {}),
  });
  const machine = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Box" });
  await f.db
    .update(schema.machines)
    .set({
      protocol: DESKTOP_PROTOCOL,
      online: true,
      lastSeenAt: new Date(),
      access: ACCESS,
      executors: { browser: { available: true }, desktop: { available: true }, terminal: { available: true } },
    })
    .where(eq(schema.machines.id, machine.machineId));
  await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(
    f.db,
    f.org.id,
    f.agent.id,
    [BROWSER_SCOPE, DESKTOP_SCOPE].map((scope) => ({ connectionId: null, scope })),
  );
  const requests: MachineRequest[] = [];
  const hub = {
    isLocal: () => true,
    status: toolHub.status,
    async call(_machineId: string, request: MachineRequest) {
      requests.push(request);
      if (request.op === "desktop.session.status")
        return { running: true, startedAt: "2026-10-24T10:00:00Z", streams: 1 };
      if (request.op !== "stream.open") return {};
      const socket = fakeSocket();
      const link = created.accept(socket.socket);
      runners.push({ socket, link });
      await created.fromRunner(
        link,
        JSON.stringify({ type: "stream.hello", token: machine.token, streamId: request.streamId }),
      );
      return { opened: true };
    },
  } as unknown as MachineHub;
  const created = createStreamBroker({
    db: f.db,
    hub,
    authorize: (input) => authorizeStream({ db: f.db, hub }, input),
    recheck: (stream) => recheckStream(f.db, stream),
    reauthorize: (stream, mode) => reauthorizeStream(f.db, stream, mode),
    onReady: (stream) => hooks.ready.push(modeOf(stream)),
    onClosed: async (stream) => {
      hooks.closed.push(modeOf(stream));
      await streamClosed(f.db, stream);
    },
    ...(options.recheckMs ? { limits: { accessRecheckMs: options.recheckMs } } : {}),
  });
  broker = created;
  control = createDesktopControl({ db: f.db, pubsub: f.pubsub, hub, streams: created });
  /** A person's viewer, once its stream is ready or refused; `switches`: one that takes its mode changing in place. */
  const opened = async (userId: string, request: StreamRequest, switches = false) => {
    const viewer = fakeSocket();
    const stream = created.open(viewer.socket, {
      userId,
      orgId: f.org.id,
      agentId: f.agent.id,
      request,
      ...(switches ? { switches } : {}),
    });
    await until(() => stream.runner !== null || viewer.closed !== null, "the stream");
    return { viewer, stream };
  };
  const open = async (userId: string, request: StreamRequest) => (await opened(userId, request)).viewer;
  const setMachine = (values: Partial<typeof schema.machines.$inferInsert>) =>
    f.db.update(schema.machines).set(values).where(eq(schema.machines.id, machine.machineId));
  const systemMode = () =>
    setMachine({
      executors: {
        browser: { available: true },
        desktop: { available: true },
        terminal: { available: true },
        mode: "system",
      },
    });
  return { machine, hub, requests, open, opened, setMachine, systemMode, hooks, runners, broker: created };
}

const modeOf = (stream: Stream) => (stream.request.kind === "desktop" ? stream.request.mode : "terminal");

/** A member of the workspace in #general who just asked the agent for work (its run is queued, live). */
async function asker(name: string, body = "@dev look at the dashboard") {
  const member = await addMember(f.db, f.org.id, "member", name);
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: member.id });
  const message = await postPersonMessage(deps(), member.id, f.org.id, f.general.id, { body });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  return { ...member, runId: run?.id as string };
}

describe("one person in control of the desktop", () => {
  test("taking over makes a desktop handoff: the others' views close (4409) and open again after the hand back", async () => {
    const { open, systemMode } = await start();
    // System mode: admins and the agent's owner drive its computer, so a second person could ask for control.
    await systemMode();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const mine = await open(f.owner.id, WATCH);
    const hers = await open(bia.id, WATCH);
    expect([mine.closed, hers.closed]).toEqual([null, null]);

    const taken = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    expect(taken).toMatchObject({
      screen: "desktop",
      kind: "takeover",
      status: "active",
      controllerUserId: f.owner.id,
    });
    await until(() => hers.closed !== null, "the hidden view");
    expect(hers.closed?.code).toBe(STREAM_CLOSE.hidden);
    expect(mine.closed).toBeNull();
    // Nobody else sees it, or takes it, while she is in control; she drives it through a control stream.
    expect((await open(bia.id, WATCH)).closed?.code).toBe(STREAM_CLOSE.hidden);
    await expect(startTakeover(deps(), bia.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
      ConflictError,
    );
    const driving = await open(f.owner.id, CONTROL);
    expect(driving.closed).toBeNull();
    expect((await open(bia.id, CONTROL)).closed?.code).toBe(STREAM_CLOSE.hidden);

    // Handed back: control ends (4410, the panel opens a watcher again) and the others watch again.
    await finishHandoff(deps(), f.owner.id, f.org.id, taken.id, { result: "done", note: "signed in" });
    await until(() => driving.closed !== null, "the end of control");
    expect(driving.closed?.code).toBe(STREAM_CLOSE.controlEnded);
    expect((await open(bia.id, WATCH)).closed).toBeNull();
    expect((await open(f.owner.id, CONTROL)).closed?.code).toBe(STREAM_CLOSE.controlEnded);
  });

  test("a member behind the agent's work may watch; control is a shell: 403 on take over, 4403 on control", async () => {
    const { open, systemMode } = await start();
    const caio = await asker("caio");
    expect((await open(caio.id, WATCH)).closed).toBeNull();
    await expect(startTakeover(deps(), caio.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await open(caio.id, CONTROL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    expect((await open(caio.id, TERMINAL)).closed?.code).toBe(STREAM_CLOSE.forbidden);

    // Every agent works as the runner's own user: only the person who paired the computer drives it, not an admin.
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await expect(requireComputerDriver(f.db, bia.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await open(bia.id, TERMINAL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    // Each agent its own user: admins and the agent's owner do; a member behind its work still doesn't.
    await systemMode();
    expect(await startTakeover(deps(), bia.id, f.org.id, f.agent.id, null, "desktop")).toMatchObject({
      controllerUserId: bia.id,
    });
    await expect(requireComputerDriver(f.db, caio.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("system mode, the agent on its owner's plan: the owner and admins who manage agents drive it, nobody else", async () => {
    const { machine, open, systemMode } = await start();
    await systemMode();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    // Caio controls computers (every member here) but doesn't manage agents; Dani is a plain member.
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const dani = await addMember(f.db, f.org.id, "member", "dani");
    const accountId = crypto.randomUUID();
    await f.db.insert(schema.machineAccounts).values({
      id: accountId,
      orgId: f.org.id,
      machineId: machine.machineId,
      kind: "claude_code",
      label: "Claude Max",
      status: "active",
      createdBy: f.owner.id,
    });
    const onPlan = (plan: boolean) =>
      f.db
        .update(schema.agents)
        .set(plan ? { brain: "claude_code", brainAccountId: accountId } : { brain: "model", brainAccountId: null })
        .where(eq(schema.agents.id, f.agent.id));
    const everyone = (keys: string[]) =>
      f.db
        .update(schema.orgRoles)
        .set({ permissions: keys })
        .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    await onPlan(true);
    // The admin drives the whole screen even on the owner's plan (ADR 0059 §8, amended 2026-11-03).
    expect((await requireComputerDriver(f.db, bia.id, f.org.id, f.agent.id)).id).toBe(machine.machineId);
    expect(await desktopStatus({ db: f.db }, bia.id, f.org.id, f.agent.id)).toMatchObject({
      canControl: true,
      controlRefusal: null,
    });
    expect((await open(bia.id, TERMINAL)).closed).toBeNull();
    // A shell reaches the sign-in as the screen does: the owner hears it too.
    expect(
      await f.db
        .select({ userId: schema.notifications.userId })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "desktop_taken"))),
    ).toEqual([{ userId: f.owner.id }]);
    // A member still doesn't.
    await expect(requireComputerDriver(f.db, dani.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startTakeover(deps(), dani.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Controlling computers without managing agents: the owner's plan is still not theirs, only its browser.
    const [base] = await f.db
      .select({ permissions: schema.orgRoles.permissions })
      .from(schema.orgRoles)
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    await everyone([...(base?.permissions ?? []), "control_computers"]);
    await expect(requireComputerDriver(f.db, caio.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await desktopStatus({ db: f.db }, caio.id, f.org.id, f.agent.id)).toMatchObject({
      canControl: false,
      controlRefusal: "owner_plan",
    });
    await expect(startTakeover(deps(), caio.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await open(caio.id, TERMINAL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    expect((await open(f.owner.id, TERMINAL)).closed).toBeNull();
    // Watching shows no shell: they still watch.
    expect((await open(caio.id, WATCH)).closed).toBeNull();
    // Back on the API, no sign-in is lent to its user: they drive it again.
    await onPlan(false);
    expect((await requireComputerDriver(f.db, caio.id, f.org.id, f.agent.id)).id).toBe(machine.machineId);
  });

  test("someone other than the owner takes control of the screen: audited each time, the owner told quietly once a day", async () => {
    const { systemMode } = await start();
    await systemMode();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const takenRows = () =>
      f.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "desktop.control_taken")));
    const notices = () =>
      f.db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "desktop_taken")));
    const takeAndHandBack = async (userId: string) => {
      const taken = await startTakeover(deps(), userId, f.org.id, f.agent.id, null, "desktop");
      await finishHandoff(deps(), userId, f.org.id, taken.id, { result: "done" });
      return taken;
    };

    // The owner's own take over: nothing to tell or record.
    await takeAndHandBack(f.owner.id);
    expect(await takenRows()).toEqual([]);
    expect(await notices()).toEqual([]);

    const first = await takeAndHandBack(bia.id);
    await takeAndHandBack(bia.id);
    const rows = await takenRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actorType: "person",
      actorId: bia.id,
      targetType: "agent",
      targetId: f.agent.id,
      details: { handoffId: first.id },
    });
    const [notice, ...more] = await notices();
    expect(more).toEqual([]);
    expect(notice).toMatchObject({
      userId: f.owner.id,
      groupKey: `desktop_taken:${f.agent.id}:${new Date().toISOString().slice(0, 10)}`,
      actors: [{ type: "user", id: bia.id }],
      source: { agentId: f.agent.id, screen: "desktop", label: f.agent.name },
    });
    // Inbox only: it never reaches a device.
    expect(noticeCategoryOf("desktop_taken", false)).toBeNull();
  });

  test("a suspended workspace: its views and terminals close at the next check and none opens; on hold they don't", async () => {
    const { open } = await start({ recheckMs: 30 });
    const watching = await open(f.owner.id, WATCH);
    const shell = await open(f.owner.id, TERMINAL);
    expect([watching.closed, shell.closed]).toEqual([null, null]);
    await setOrgStanding(deps(), f.org.id, { state: "suspended", reason: null, notice: "silent" });
    await until(() => watching.closed !== null && shell.closed !== null, "the recheck");
    expect([watching.closed?.code, shell.closed?.code]).toEqual([STREAM_CLOSE.forbidden, STREAM_CLOSE.forbidden]);
    expect((await open(f.owner.id, WATCH)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    // On hold only the agents stop: people still watch what runs.
    await setOrgStanding(deps(), f.org.id, { state: "hold", reason: null, notice: "silent" });
    expect((await open(f.owner.id, WATCH)).closed).toBeNull();
  });

  test("access is checked again while a stream is open; the controller's stream keeps their control alive", async () => {
    const { open } = await start({ recheckMs: 30 });
    const caio = await asker("caio");
    const watching = await open(caio.id, WATCH);
    expect(watching.closed).toBeNull();
    // Their run ended: they are no longer behind the agent's work.
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, caio.runId));
    await until(() => watching.closed !== null, "the recheck");
    expect(watching.closed?.code).toBe(STREAM_CLOSE.forbidden);

    const taken = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    const driving = await open(f.owner.id, CONTROL);
    const handoff = schema.browserHandoffs;
    await f.db
      .update(handoff)
      .set({ expiresAt: new Date(Date.now() + 5_000) })
      .where(eq(handoff.id, taken.id));
    const deadline = async () =>
      (await f.db.select().from(handoff).where(eq(handoff.id, taken.id)))[0]?.expiresAt.getTime() ?? 0;
    await until(async () => (await deadline()) > Date.now() + 60_000, "the controller's presence");
    expect(driving.closed).toBeNull();
  });
});

describe("the agents' computers by role (ADR 0085 §12): none, the browser, the whole computer", () => {
  /** Sets `everyone`'s keys; a role holding `keys` for `userId`. */
  const everyone = (keys: string[]) =>
    f.db
      .update(schema.orgRoles)
      .set({ permissions: keys })
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
  const giveRole = async (userId: string, keys: string[]) => {
    const [role] = await f.db
      .insert(schema.orgRoles)
      .values({ orgId: f.org.id, name: `role-${keys.join("-")}`, position: 1, permissions: keys })
      .returning();
    await f.db.insert(schema.organizationMemberRoles).values({ orgId: f.org.id, userId, roleId: role?.id ?? "" });
  };
  const ownedBy = (userId: string | null) =>
    f.db.update(schema.agents).set({ ownerUserId: userId }).where(eq(schema.agents.id, f.agent.id));
  const BASE = ["post", "create_channels", "talk_to_agents", "assign_work", "pair_computers", "edit_wiki"];

  test("a role with every agent's browser only: the browser and its requests, never the screen, control or terminal", async () => {
    const { open, systemMode, setMachine } = await start();
    await systemMode();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await giveRole(caio.id, ["control_browsers"]);
    expect((await requireBrowserAccess(f.db, caio.id, f.org.id, f.agent.id)).admin).toBe(true);
    expect(await desktopStatus({ db: f.db }, caio.id, f.org.id, f.agent.id)).toMatchObject({
      available: false,
      reason: "browser_only",
      canControl: false,
      controlRefusal: "role",
      // The browser's frames are what they see: never the screen it runs on.
      browserOnDesktop: false,
    });
    await expect(requireComputerDriver(f.db, caio.id, f.org.id, f.agent.id)).rejects.toThrow(
      "not their whole computer",
    );
    expect((await open(caio.id, WATCH)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    expect((await open(caio.id, CONTROL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    expect((await open(caio.id, TERMINAL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    await expect(startTakeover(deps(), caio.id, f.org.id, f.agent.id, null, "desktop")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // The browser is theirs to take, on its own page: the screen it runs on stays out of reach.
    const taken = await startTakeover(deps(), caio.id, f.org.id, f.agent.id);
    expect(taken.screen).toBe("browser");
    expect((await open(caio.id, CONTROL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    await finishHandoff(deps(), caio.id, f.org.id, taken.id, { result: "done" });
    // A computer whose screen is switched off has none to keep from them: no "browser only".
    await setMachine({ access: { ...ACCESS, tools: { ...ACCESS.tools, desktop: false } } });
    expect(await desktopStatus({ db: f.db }, caio.id, f.org.id, f.agent.id)).toMatchObject({
      reason: "not_allowed",
      controlRefusal: null,
    });
  });

  test("a role with the whole computer drives every agent's screen and terminal", async () => {
    const { open, systemMode } = await start();
    await systemMode();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await everyone(BASE);
    await giveRole(bia.id, ["control_computers"]);
    expect(await desktopStatus({ db: f.db }, bia.id, f.org.id, f.agent.id)).toMatchObject({ canControl: true });
    expect((await open(bia.id, WATCH)).closed).toBeNull();
    expect((await open(bia.id, TERMINAL)).closed).toBeNull();
    // Asked for help on the screen when the agent has no owner who may.
    await ownedBy(null);
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toContain(bia.id);
  });

  test("everyone's level bounds what is a person's own: their agent, their requests, the computer they connected", async () => {
    const { open, systemMode, setMachine } = await start();
    await systemMode();
    const dani = await addMember(f.db, f.org.id, "member", "dani");
    await ownedBy(dani.id);
    // The default, what any member could do before: the whole computer of their own agent.
    expect((await requireComputerDriver(f.db, dani.id, f.org.id, f.agent.id)).id).toBeTruthy();
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toEqual([dani.id]);
    expect(await browserHandoffRecipient({ db: f.db }, f.org.id, null, f.agent.id)).toBe(dani.id);

    // The browser only: its page and its requests, not the screen.
    await everyone([...BASE, "own_browsers"]);
    expect((await requireBrowserAccess(f.db, dani.id, f.org.id, f.agent.id)).owner).toBe(dani.id);
    expect(await desktopStatus({ db: f.db }, dani.id, f.org.id, f.agent.id)).toMatchObject({
      reason: "browser_only",
      controlRefusal: "role",
    });
    expect((await open(dani.id, TERMINAL)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).not.toContain(dani.id);
    expect(await browserHandoffRecipient({ db: f.db }, f.org.id, null, f.agent.id)).toBe(dani.id);

    // None: not even the browser or a request, on their own agent; the workspace's owner still has it all.
    await everyone(BASE);
    await expect(requireBrowserAccess(f.db, dani.id, f.org.id, f.agent.id)).rejects.toThrow(
      "don't give you the agents' computers",
    );
    await expect(desktopStatus({ db: f.db }, dani.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(startTakeover(deps(), dani.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await open(dani.id, WATCH)).closed?.code).toBe(STREAM_CLOSE.forbidden);
    expect(await browserHandoffRecipient({ db: f.db }, f.org.id, null, f.agent.id)).toBeNull();
    expect((await requireComputerDriver(f.db, f.owner.id, f.org.id, f.agent.id)).id).toBeTruthy();
    expect((await open(f.owner.id, TERMINAL)).closed).toBeNull();

    // A computer they connected, off system mode, is theirs only with the whole computer too.
    await setMachine({ pairedByUserId: dani.id, executors: { desktop: { available: true } } });
    await expect(requireComputerDriver(f.db, dani.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);
    await everyone([...BASE, "own_computers"]);
    expect((await requireComputerDriver(f.db, dani.id, f.org.id, f.agent.id)).id).toBeTruthy();
  });
});

describe("a desktop stream's mode changes in place (ADR 0058 §17)", () => {
  const sentText = (s: FakeSocket) => s.sent.filter((x): x is string => typeof x === "string");
  const MODE = (mode: string) => JSON.stringify({ type: "mode", mode });

  test("taking control turns the holder's own watching stream into control on the same sockets, handing back turns it back; each part is a stream of its own for the hooks", async () => {
    const { opened, setMachine, runners, hooks, broker: b } = await start();
    await setMachine({ protocol: DESKTOP_SWITCH_PROTOCOL });
    const { viewer, stream } = await opened(f.owner.id, WATCH, true);
    // Before any of the computer's bytes, the viewer hears that this socket stays when the mode changes.
    expect(viewer.sent).toEqual([MODE("watch")]);
    const runner = runners[0] as (typeof runners)[number];
    await until(() => hooks.ready.length === 1, "the watching part");

    const taken = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    await until(() => sentText(runner.socket).includes(MODE("control")), "the switch to the computer");
    expect(stream.request).toEqual(CONTROL);
    expect([viewer.closed, runner.socket.closed]).toEqual([null, null]);
    // Until the viewer took it, what it sends is its old session's: none of it reaches the computer.
    const before = runner.socket.sent.length;
    b.fromViewer(stream, Uint8Array.of(3, 1, 0, 0, 0, 0, 5, 0, 3, 32));
    expect(runner.socket.sent.length).toBe(before);
    // The computer marks where its old session ends; the viewer gets the mark, takes it, and its bytes flow again.
    await b.fromRunner(runner.link, MODE("control"));
    expect(viewer.sent.at(-1)).toBe(MODE("control"));
    b.fromViewer(stream, MODE("control"));
    b.fromViewer(stream, Uint8Array.of(82, 70, 66));
    expect(runner.socket.sent.at(-1)).toEqual(Uint8Array.of(82, 70, 66));
    // The watching part ended for the hooks (its audit), and control started (screening, where it is on).
    await until(() => hooks.ready.length === 2, "the control part");
    expect(hooks).toEqual({ ready: ["watch", "control"], closed: ["watch"] });

    await finishHandoff(deps(), f.owner.id, f.org.id, taken.id, { result: "done", note: "signed in" });
    await until(() => sentText(runner.socket).includes(MODE("watch")), "the switch back");
    expect(stream.request).toEqual(WATCH);
    expect(viewer.closed).toBeNull();
    await until(() => hooks.ready.length === 3, "the watching part again");
    expect(hooks).toEqual({ ready: ["watch", "control", "watch"], closed: ["watch", "control"] });
    const streamed = async () =>
      (await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, f.agent.id)))
        .map((a) => a.action)
        .filter((action) => action.startsWith("desktop."))
        .sort();
    await until(async () => (await streamed()).length === 2, "the audit");
    expect(await streamed()).toEqual(["desktop.controlled", "desktop.watched"]);
  });

  test("an older computer (protocol 29) or a viewer that didn't ask: control ends with 4410 and the panel opens again, as before; nothing changes mode", async () => {
    const { opened, setMachine, runners } = await start();
    const old = await opened(f.owner.id, WATCH, true);
    expect(old.viewer.sent).toEqual([]);
    const taken = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    const driving = await opened(f.owner.id, CONTROL, true);
    await finishHandoff(deps(), f.owner.id, f.org.id, taken.id, { result: "done" });
    await until(() => driving.viewer.closed !== null, "the end of control");
    expect(driving.viewer.closed?.code).toBe(STREAM_CLOSE.controlEnded);
    expect(old.stream.request).toEqual(WATCH);

    await setMachine({ protocol: DESKTOP_SWITCH_PROTOCOL });
    const plain = await opened(f.owner.id, WATCH);
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    await Bun.sleep(50);
    expect(plain.viewer.sent).toEqual([]);
    expect(plain.stream.request).toEqual(WATCH);
    expect(runners.flatMap((r) => sentText(r.socket))).toEqual(runners.map(() => '{"type":"stream.ready"}'));
  });

  test("someone else taking control still hides the view (4409); a switch the person may not have now is refused", async () => {
    const { opened, setMachine, systemMode } = await start();
    await setMachine({ protocol: DESKTOP_SWITCH_PROTOCOL });
    await systemMode();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const hers = await opened(bia.id, WATCH, true);
    const mine = await opened(f.owner.id, WATCH, true);
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    await until(() => hers.viewer.closed !== null, "the hidden view");
    expect(hers.viewer.closed?.code).toBe(STREAM_CLOSE.hidden);
    await until(() => mine.stream.request.kind === "desktop" && mine.stream.request.mode === "control", "control");

    // Control is new work: never for a held agent, nor without the desktop's own handoff in the person's name.
    const stream = mine.stream;
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: "Review" });
    expect(await reauthorizeStream(f.db, stream, "control")).toEqual({ refused: STREAM_CLOSE.refused, reason: "held" });
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: false, reason: null });
    expect(await reauthorizeStream(f.db, { ...stream, userId: bia.id }, "control")).toEqual({
      refused: STREAM_CLOSE.hidden,
      reason: "someone_in_control",
    });
    expect(await reauthorizeStream(f.db, stream, "watch")).toBeNull();
  });

  test("control refused for a switch leaves the stream watching; the panel opens again by itself if it still thinks so", async () => {
    const { opened, setMachine, runners, broker: b } = await start();
    await setMachine({ protocol: DESKTOP_SWITCH_PROTOCOL });
    const { viewer, stream } = await opened(f.owner.id, WATCH, true);
    // No handoff in the person's name: nothing to control.
    b.switchWhere((s) => s.id === stream.id, "control");
    await Bun.sleep(50);
    expect(stream.request).toEqual(WATCH);
    expect(viewer.closed).toBeNull();
    expect(sentText((runners[0] as (typeof runners)[number]).socket)).toEqual(['{"type":"stream.ready"}']);
  });
});

describe("the browser and the desktop show one window", () => {
  test("a take over of either hides both views, blocks the other's take over, and the agent's tools wait", async () => {
    const { open } = await start();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const live = createBrowserLive({
      db: f.db,
      pubsub: f.pubsub,
      hub: { isLocal: () => true, call: async () => ({}) } as unknown as MachineHub,
    });
    const card: BrowserLiveMessage[] = [];
    const { stop: stopCard } = await live.watch({ userId: bia.id, send: (m) => card.push(m) }, f.org.id, f.agent.id);
    const desktopView = await open(bia.id, WATCH);
    const message = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@dev check it" });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
    const ctx = { orgId: f.org.id, agentId: f.agent.id, runId: run?.id as string };

    // The browser's take over (over the card) hides the desktop too.
    const browser = await startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id);
    expect(browser.screen).toBe("browser");
    await until(() => desktopView.closed !== null, "the hidden desktop");
    expect(desktopView.closed?.code).toBe(STREAM_CLOSE.hidden);
    await expect(startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop")).rejects.toMatchObject({
      code: "handoff.same_window",
    });
    expect((await waitIfPersonInControl(f.db, ctx, f.pubsub, "desktop"))?.data).toMatchObject({
      handoffId: browser.id,
    });
    await finishHandoff(live.handoffDeps, f.owner.id, f.org.id, browser.id, { result: "done" });

    // The desktop's take over hides the browser's card (CDP frames) the same way.
    const desktop = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    await until(
      () => card.some((m) => m.type === "browser.status" && m.hidden && m.handoff?.screen === "desktop"),
      "the hidden card",
    );
    await expect(startTakeover(live.handoffDeps, f.owner.id, f.org.id, f.agent.id)).rejects.toMatchObject({
      code: "handoff.same_window",
    });
    expect((await waitIfPersonInControl(f.db, ctx, f.pubsub))?.data).toMatchObject({ handoffId: desktop.id });
    // The one in control of that desktop sees the card in control too: what they do there reaches the page.
    expect(await live.sendInput(f.owner.id, f.org.id, f.agent.id, [{ kind: "text", text: "a" }])).toMatchObject({
      refused: false,
    });
    expect(await live.sendInput(bia.id, f.org.id, f.agent.id, [{ kind: "text", text: "a" }])).toMatchObject({
      refused: true,
    });
    await finishHandoff(deps(), f.owner.id, f.org.id, desktop.id, { result: "done" });
    await until(() => card.at(-1)?.type === "browser.status" && !(card.at(-1) as { hidden: boolean }).hidden);
    stopCard();
    live.close();
  });

  test("helping in the browser on its window: who may drive the computer drives the whole screen, audited; who may only use the browser watches it", async () => {
    const { opened, setMachine, systemMode } = await start();
    await setMachine({ protocol: DESKTOP_SWITCH_PROTOCOL });
    await systemMode();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const isMode = (s: Stream, mode: string) => s.request.kind === "desktop" && s.request.mode === mode;
    const taken = () =>
      f.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "desktop.control_taken")));

    // The owner's own: their watching turns to control on the same sockets, and back with the hand back.
    const mine = await opened(f.owner.id, WATCH, true);
    const own = await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    expect(own.screen).toBe("browser");
    await until(() => isMode(mine.stream, "control"), "the owner's control");
    expect(mine.viewer.closed).toBeNull();
    await finishHandoff(deps(), f.owner.id, f.org.id, own.id, { result: "done" });
    await until(() => isMode(mine.stream, "watch"), "the owner watching again");
    expect(await taken()).toEqual([]);

    // An admin who may drive it: the same, and the owner's log says so.
    const hers = await opened(bia.id, WATCH, true);
    const helped = await startTakeover(deps(), bia.id, f.org.id, f.agent.id);
    await until(() => isMode(hers.stream, "control"), "her control");
    expect(await reauthorizeStream(f.db, hers.stream, "control")).toBeNull();
    expect((await taken()).map((r) => r.details)).toEqual([{ machineId: helped.machineId, handoffId: helped.id }]);
    await finishHandoff(deps(), bia.id, f.org.id, helped.id, { result: "done" });
    await until(() => isMode(hers.stream, "watch"), "her watching again");

    // Off system mode the computer is the owner's alone: she helps in the page, and her view stays watching.
    await setMachine({ executors: { browser: { available: true }, desktop: { available: true } } });
    const page = await startTakeover(deps(), bia.id, f.org.id, f.agent.id);
    await Bun.sleep(50);
    expect(isMode(hers.stream, "watch")).toBe(true);
    expect(await reauthorizeStream(f.db, hers.stream, "control")).toEqual({
      refused: STREAM_CLOSE.forbidden,
      reason: "forbidden",
    });
    expect(await taken()).toHaveLength(1);
    await finishHandoff(deps(), bia.id, f.org.id, page.id, { result: "done" });
  });

  test("a browser that doesn't run on the desktop (its switch off) keeps the two screens apart", async () => {
    const { setMachine } = await start();
    await setMachine({ access: { ...ACCESS, tools: { ...ACCESS.tools, desktop: false } } });
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id);
    const ctx = { orgId: f.org.id, agentId: f.agent.id, runId: "none" };
    expect(await waitIfPersonInControl(f.db, ctx, f.pubsub, "desktop")).toBeNull();
  });
});

describe("the agent asks for help on its desktop", () => {
  test("desktop_ask_person goes only to who may drive the computer, with a push that says where it opens", async () => {
    await start({ agent: true });
    // The agent's owner is an admin who didn't pair the computer; Caio asks for the work.
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    await asker("caio", "@dev sign in please");
    await drainOutbox(f.db, f.handlers);
    const [h] = await f.db.select().from(schema.browserHandoffs);
    expect(h).toMatchObject({ screen: "desktop", kind: "ask", status: "pending", requestedForUserId: f.owner.id });
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, f.org.id), eq(schema.messages.id, h?.id as string)));
    expect(card?.meta).toMatchObject({ bodyCode: "desktop_handoff", browserHandoff: { screen: "desktop" } });
    const notified = await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.groupKey, `browser_handoff:${h?.id}`));
    expect(notified.map((n) => n.userId)).toEqual([f.owner.id]);
    expect(notified[0]?.source).toMatchObject({ handoffId: h?.id, screen: "desktop" });
    expect(
      renderPush("pt-BR", { kind: "browser_handoff", waiting: true, actorName: "Dev", screen: "desktop" }),
    ).toEqual({
      title: "Dev precisa de você no computador",
      // "a computer" alone would read as the agent's own: a laptop, where the screen is helped.
      body: "Abra o agentes.chat num notebook para ajudar.",
    });
  });

  test("several may drive it: the card stays in the conversation when one of them is in it, else goes to the asker's DM", async () => {
    const { systemMode } = await start({ agent: true });
    // System mode, no owner: the person who paired the computer (older) and an admin both drive it; only the admin
    // is in #general.
    await systemMode();
    await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, f.agent.id));
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    await f.db
      .delete(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.userId, f.owner.id)));
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toEqual([f.owner.id, bia.id]);
    await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev sign in please" });
    await drainOutbox(f.db, f.handlers);
    const [h] = await f.db.select().from(schema.browserHandoffs);
    const [card] = await f.db
      .select({ channelId: schema.messages.channelId })
      .from(schema.messages)
      .where(eq(schema.messages.id, h?.id as string));
    expect(card?.channelId).toBe(f.general.id);
    const [notice] = await f.db
      .select()
      .from(schema.notifications)
      .where(
        and(eq(schema.notifications.groupKey, `browser_handoff:${h?.id}`), eq(schema.notifications.userId, bia.id)),
      );
    expect(notice?.source).toMatchObject({ channelId: f.general.id, messageId: h?.id });
  });

  test("several may drive it and none is in the conversation or asked: no DM opens with one of them, all get the card in the channel administrators read", async () => {
    const { systemMode } = await start({ agent: true });
    await systemMode();
    await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, f.agent.id));
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await f.db
      .delete(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.userId, f.owner.id)));
    // Caio, who asks, leaves the workspace before the run asks: he can't be asked, and no driver is in #general.
    const caio = await asker("caio", "@dev sign in please");
    await f.db.delete(schema.channelMembers).where(eq(schema.channelMembers.userId, caio.id));
    await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, caio.id));
    expect((await computerDrivers(f.db, f.org.id, f.agent.id)).sort()).toEqual([f.owner.id, bia.id].sort());
    await drainOutbox(f.db, f.handlers);
    const [h] = await f.db.select().from(schema.browserHandoffs);
    const [card] = await f.db
      .select({ channelId: schema.messages.channelId })
      .from(schema.messages)
      .where(eq(schema.messages.id, h?.id as string));
    expect(card?.channelId).toBe(f.general.id);
    expect(await f.db.select().from(schema.channels).where(eq(schema.channels.kind, "dm"))).toEqual([]);
    const notified = await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.groupKey, `browser_handoff:${h?.id}`));
    expect(notified.map((n) => n.userId).sort()).toEqual([f.owner.id, bia.id].sort());
    for (const n of notified)
      expect(n.source).toMatchObject({
        channelId: f.general.id,
        messageId: h?.id,
        handoffId: h?.id,
        agentId: f.agent.id,
        screen: "desktop",
      });
  });

  test("who is asked: the owner when they may drive it, else everyone who may; nobody on a computer nobody paired", async () => {
    const { setMachine, systemMode } = await start();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    // A plain member never drives it, in system mode either.
    await addMember(f.db, f.org.id, "member", "caio");
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toEqual([f.owner.id]);
    await systemMode();
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toEqual([bia.id]);
    await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, f.agent.id));
    expect((await computerDrivers(f.db, f.org.id, f.agent.id)).sort()).toEqual([f.owner.id, bia.id].sort());
    await setMachine({ pairedByUserId: null, executors: { desktop: { available: true } } });
    expect(await computerDrivers(f.db, f.org.id, f.agent.id)).toEqual([]);
  });
});

describe("the desktop's REST and keep-alive", () => {
  test("its state for whoever may watch: control for who drives the computer, held, and nothing to turn on or off", async () => {
    const { hub, requests, setMachine } = await start();
    const rest = { db: f.db, hub, streams: broker };
    const caio = await asker("caio");
    const owner = await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id);
    expect(owner).toEqual({
      available: true,
      reason: null,
      detail: null,
      running: true,
      startedAt: "2026-10-24T10:00:00Z",
      controllerUserId: null,
      handoff: null,
      viewers: 0,
      canControl: true,
      controlRefusal: null,
      held: false,
      browserOnDesktop: true,
    });
    expect(await desktopStatus(rest, caio.id, f.org.id, f.agent.id)).toMatchObject({
      canControl: false,
      controlRefusal: "pairer",
      held: false,
      browserOnDesktop: true,
    });
    expect(new Set(requests.map((r) => r.op))).toEqual(new Set(["desktop.session.status"]));

    // Held, the agent or its workspace: people still watch.
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: "Review" });
    expect(await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id)).toMatchObject({ available: true, held: true });
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: false, reason: null });
    await setOrgStanding(deps(), f.org.id, { state: "hold", reason: null, notice: "silent" });
    expect(await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id)).toMatchObject({ held: true });
    await setOrgStanding(deps(), f.org.id, { state: "active", reason: null, notice: "silent" });
    expect(await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id)).toMatchObject({ held: false });

    const outsider = await addMember(f.db, f.org.id, "member", "zed");
    await expect(desktopStatus(rest, outsider.id, f.org.id, f.agent.id)).rejects.toBeInstanceOf(ForbiddenError);

    // Switched off on the computer: not available, and why.
    await setMachine({ access: { ...ACCESS, tools: { ...ACCESS.tools, desktop: false } } });
    expect(await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      available: false,
      reason: "not_allowed",
      running: false,
      browserOnDesktop: false,
    });
  });

  test("whether the agent's browser runs on this screen, so its browser card shows it (ADR 0058 §7)", async () => {
    const { hub } = await start();
    const rest = { db: f.db, hub, streams: broker };
    expect(await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id)).toMatchObject({ browserOnDesktop: true });
    // Its browser last ran on another computer: that one's frames, not this screen.
    const other = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Other" });
    await f.db.update(schema.agents).set({ browserMachineId: other.machineId }).where(eq(schema.agents.id, f.agent.id));
    expect(await desktopStatus(rest, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      available: true,
      browserOnDesktop: false,
    });
    await f.db.update(schema.agents).set({ browserMachineId: null }).where(eq(schema.agents.id, f.agent.id));
    // The computer offline: nothing to show, so no screen in the card.
    const offline = { ...hub, status: async () => null } as unknown as MachineHub;
    expect(await desktopStatus({ ...rest, hub: offline }, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      available: false,
      reason: "offline",
      browserOnDesktop: false,
    });
  });

  test("asked while a view of the computer is open: the computer is wanted, and wakes from standby (ADR 0161)", async () => {
    const { hub, machine } = await start();
    const wanted: string[] = [];
    const wake = async (machineId: string, why: string) => {
      wanted.push(`${machineId}:${why}`);
    };
    const asleep = {
      ...hub,
      status: async (id: string) => ({ ...(await toolHub.status(id)), kind: "managed", online: false, standby: true }),
      wake,
    } as unknown as MachineCaller;
    expect(await desktopStatus({ db: f.db, hub: asleep }, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      available: false,
      reason: "offline",
    });
    expect(wanted).toEqual([`${machine.machineId}:view`]);
    // Awake and watched, it stays wanted.
    const awake = { ...hub, wake } as unknown as MachineCaller;
    expect(await desktopStatus({ db: f.db, hub: awake }, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      available: true,
    });
    expect(wanted).toEqual([`${machine.machineId}:view`, `${machine.machineId}:view`]);
  });

  test("a browser card's view of the screen is audited as watching, marked as the card's", async () => {
    const { machine } = await start();
    const viewer = fakeSocket();
    const stream = broker?.open(viewer.socket, {
      userId: f.owner.id,
      orgId: f.org.id,
      agentId: f.agent.id,
      request: WATCH,
      preview: true,
    });
    if (!stream) throw new Error("no broker");
    await until(() => stream.runner !== null, "the card's stream");
    broker?.close(stream);
    const watched = () =>
      f.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "desktop.watched")));
    await until(async () => (await watched()).length === 1, "the audit");
    expect((await watched())[0]?.details).toMatchObject({ machineId: machine.machineId, preview: true });
  });

  test("an open desktop handoff keeps its desktop running", async () => {
    const { requests } = await start();
    expect(await control?.keepAlive()).toBe(0);
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    expect(await control?.keepAlive()).toBe(1);
    expect(requests.at(-1)).toMatchObject({ op: "desktop.session.start", agent: { id: f.agent.id, handle: "dev" } });
    expect(await control?.keepAlive()).toBe(0);
  });
});

test("system mode is believed from a computer's first hello, and only from one that has said so since", async () => {
  f = await setup({ machines: true });
  const hub = f.machineHub as MachineHub;
  const say = async (token: string, mode?: string) => {
    const conn = hub.open({ send() {}, close() {} });
    await hub.message(
      conn,
      JSON.stringify({
        type: "hello",
        token,
        version: "0.1.0",
        protocol: DESKTOP_PROTOCOL,
        os: "linux",
        arch: "x64",
        hostname: "box",
        workspace: "/srv/agents",
        exec: true,
        desktop: { available: true, width: 1280, height: 800 },
        terminal: { available: true },
        ...(mode ? { mode } : {}),
      }),
    );
    await hub.close(conn);
  };
  const modeOf = async (machineId: string) =>
    (await f.db.select().from(schema.machines).where(eq(schema.machines.id, machineId)))[0]?.executors?.mode ?? null;

  const system = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Server" });
  await say(system.token, "system");
  await say(system.token, "system");
  expect(await modeOf(system.machineId)).toBe("system");
  // Back to single-user: from then on a hello saying otherwise is the agents' own code talking.
  await say(system.token);
  await say(system.token, "system");
  expect(await modeOf(system.machineId)).toBeNull();

  const laptop = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Laptop" });
  await say(laptop.token);
  await say(laptop.token, "system");
  await say(laptop.token, "nonsense");
  expect(await modeOf(laptop.machineId)).toBeNull();
});

test("a stream whose session ended is refused on the recheck, before anything else is read", async () => {
  f = await setup();
  const stream = { sessionToken: "ended-session-token", userId: f.owner.id, orgId: f.org.id, agentId: f.agent.id };
  expect(await recheckStream(f.db, stream as unknown as Parameters<typeof recheckStream>[1])).toEqual({
    refused: STREAM_CLOSE.forbidden,
    reason: "signed_out",
  });
});

describe("a picture of an agent's screen", () => {
  /** The computer as a picture sees it: `running` says whether its screen runs. */
  const pictureHub = (running: boolean, fails = false) => {
    const ops: string[] = [];
    const hub: MachineCaller = {
      status: toolHub.status,
      call: (async (_id: string, request: MachineRequest) => {
        ops.push(request.op);
        if (request.op === "desktop.session.status") return { running, streams: 0 };
        if (fails) throw new Error("no capture");
        return {
          data: "anBlZw==",
          width: 1280,
          height: 800,
          screen: { width: 1280, height: 800 },
          region: null,
          marks: [],
        };
      }) as MachineCaller["call"],
    };
    return { hub, ops };
  };
  const ask = (hub: MachineCaller, userId: string) => desktopPicture({ db: f.db, hub }, userId, f.org.id, f.agent.id);

  test("whoever may watch gets a recent JPEG; others asking soon after share it, and it counts as watching once", async () => {
    await start();
    const { hub, ops } = pictureHub(true);
    expect(await ask(hub, f.owner.id)).toMatchObject({
      picture: { data: "anBlZw==", width: 1280, height: 800 },
      reason: null,
    });
    await ask(hub, f.owner.id);
    expect(ops).toEqual(["desktop.session.status", "desktop.capture"]);
    const audits = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetId, f.agent.id), eq(schema.auditLog.action, "desktop.watched")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toMatchObject({ picture: true, seconds: 0 });
  });

  test("everyone asking at once shares one capture, and each of them counts as watching", async () => {
    await start();
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const { hub, ops } = pictureHub(true);
    const [mine, theirs] = await Promise.all([ask(hub, f.owner.id), ask(hub, admin.id)]);
    expect(theirs).toEqual(mine);
    expect(ops).toEqual(["desktop.session.status", "desktop.capture"]);
    const audits = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetId, f.agent.id), eq(schema.auditLog.action, "desktop.watched")));
    expect(audits.map((a) => a.actorId).sort()).toEqual([f.owner.id, admin.id].sort());
  });

  test("a screen that isn't running stays off: no capture is asked of the computer", async () => {
    await start();
    const { hub, ops } = pictureHub(false);
    expect(await ask(hub, f.owner.id)).toEqual({ picture: null, reason: "stopped" });
    expect(ops).toEqual(["desktop.session.status"]);
  });

  test("a person who can't watch gets no picture", async () => {
    await start();
    const member = await addMember(f.db, f.org.id, "member", "dani");
    const { hub, ops } = pictureHub(true);
    await expect(ask(hub, member.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(ops).toEqual([]);
  });

  test("while someone is in control, nobody else sees it, a kept picture included", async () => {
    await start();
    const admin = await addMember(f.db, f.org.id, "admin", "bia");
    const { hub, ops } = pictureHub(true);
    await ask(hub, admin.id);
    await startTakeover(deps(), f.owner.id, f.org.id, f.agent.id, null, "desktop");
    expect(await ask(hub, admin.id)).toEqual({ picture: null, reason: "hidden" });
    expect(ops).toEqual(["desktop.session.status", "desktop.capture"]);
  });

  test("a capture that fails is no picture, not an error", async () => {
    await start();
    expect(await ask(pictureHub(true, true).hub, f.owner.id)).toEqual({ picture: null, reason: "unavailable" });
  });
});

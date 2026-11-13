import { afterEach, describe, expect, test } from "bun:test";
import {
  createMemoryRateLimiter,
  DESKTOP_PROTOCOL,
  type MachineRequest,
  STREAM_CLOSE,
  STREAM_LIMITS,
  type StreamRequest,
} from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  AgentHeldError,
  auditStream,
  authorizeStream,
  createStreamBroker,
  DESKTOP_SCOPE,
  grantScopes,
  type MachineHub,
  MachineOfflineError,
  MachinePausedError,
  MachineRequestError,
  type RunnerLink,
  type StreamBroker,
  type StreamBrokerDeps,
  type StreamInput,
  setAgentHold,
  setOrgStanding,
  startTakeover,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { type FakeSocket, fakeSocket, until } from "./stream-fixtures";

let f: Fixture;
let broker: StreamBroker | undefined;
afterEach(async () => {
  broker?.stop();
  broker = undefined;
  await f?.close();
});

const WATCH: StreamRequest = { kind: "desktop", mode: "watch" };
const CONTROL: StreamRequest = { kind: "desktop", mode: "control" };
const TERMINAL: StreamRequest = { kind: "terminal", cols: 80, rows: 24 };

const paired = () => pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Box" });
type Paired = Awaited<ReturnType<typeof paired>>;

/**
 * A broker whose hub plays the runner: each `stream.open` dials a data socket,
 * says hello with the machine's token and answers once it is ready (or `reply`
 * answers instead). Every request is the computer's and every stream allowed,
 * unless `authorize` says otherwise.
 */
function brokerFor(
  machine: Paired,
  options: {
    reply?: (request: MachineRequest) => Promise<unknown>;
    authorize?: StreamBrokerDeps["authorize"];
    recheck?: StreamBrokerDeps["recheck"];
    onReady?: StreamBrokerDeps["onReady"];
    onClosed?: StreamBrokerDeps["onClosed"];
    limits?: StreamBrokerDeps["limits"];
    claim?: StreamBrokerDeps["claim"];
  } = {},
) {
  const requests: MachineRequest[] = [];
  const runners: { link: RunnerLink; socket: FakeSocket }[] = [];
  const hub = {
    async call(_machineId: string, request: MachineRequest) {
      requests.push(request);
      if (options.reply) return options.reply(request);
      if (request.op !== "stream.open") throw new Error(`unexpected ${request.op}`);
      const socket = fakeSocket();
      const link = created.accept(socket.socket);
      runners.push({ link, socket });
      await created.fromRunner(
        link,
        JSON.stringify({ type: "stream.hello", token: machine.token, streamId: request.streamId }),
      );
      return { opened: true };
    },
  } as unknown as Pick<MachineHub, "call">;
  const created = createStreamBroker({
    db: f.db,
    hub,
    authorize:
      options.authorize ??
      (async (input) => ({ machineId: machine.machineId, agent: { id: input.agentId, handle: "dev" } })),
    onReady: options.onReady,
    onClosed: options.onClosed,
    recheck: options.recheck,
    limits: options.limits,
    claim: options.claim,
  });
  broker = created;
  return { broker: created, requests, runners };
}

const input = (request: StreamRequest, agentId = f.agent.id, userId = f.owner.id): StreamInput => ({
  userId,
  orgId: f.org.id,
  agentId,
  request,
});

describe("the broker", () => {
  test("bytes both ways once the data socket is ready; what the person sent before waits; the audit keeps counts", async () => {
    f = await setup();
    const machine = await paired();
    let audited: Promise<unknown> | undefined;
    const { broker, requests, runners } = brokerFor(machine, {
      onClosed: (s) => {
        audited = auditStream(f.db, s);
      },
    });
    const viewer = fakeSocket();
    const stream = broker.open(viewer.socket, input(TERMINAL));
    expect(stream.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    broker.fromViewer(stream, new Uint8Array([108, 115, 10]));
    await until(() => stream.runner !== null, "the data socket");
    expect(requests).toEqual([
      {
        op: "stream.open",
        streamId: stream.id,
        kind: "terminal",
        cols: 80,
        rows: 24,
        agent: { id: f.agent.id, handle: "dev" },
      },
    ]);
    const runner = runners[0] as (typeof runners)[number];
    expect(runner.socket.sent).toEqual(['{"type":"stream.ready"}', new Uint8Array([108, 115, 10])]);
    const resize = JSON.stringify({ type: "resize", cols: 132, rows: 40 });
    broker.fromViewer(stream, resize);
    expect(runner.socket.sent[2]).toBe(resize);
    await broker.fromRunner(runner.link, new Uint8Array([1, 2, 3, 4]));
    await broker.fromRunner(runner.link, JSON.stringify({ type: "exit", code: 0 }));
    expect(viewer.sent).toEqual([new Uint8Array([1, 2, 3, 4]), '{"type":"exit","code":0}']);
    expect(broker.count(f.agent.id, "terminal")).toBe(1);

    // The person leaves: both sides close, and the audit says who, which agent and computer, and how many bytes.
    broker.close(stream);
    expect(runner.socket.closed?.code).toBe(STREAM_CLOSE.normal);
    expect(broker.count(f.agent.id, "terminal")).toBe(0);
    await until(() => audited !== undefined, "the audit");
    await audited;
    const rows = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "terminal.session"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: f.org.id,
      actorType: "person",
      actorId: f.owner.id,
      targetType: "agent",
      targetId: f.agent.id,
      details: { machineId: machine.machineId, seconds: 0, bytesIn: 3 + resize.length, bytesOut: 4 },
    });
  });

  test("a data socket names a live stream of its own computer, with its token, in time", async () => {
    f = await setup();
    const machine = await paired();
    const other = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Other" });
    // The test plays the runner's data sockets itself; the computer's answer never comes.
    const { broker } = brokerFor(machine, {
      reply: () => new Promise(() => {}),
      limits: { helloTimeoutMs: 30, openTimeoutMs: 500 },
    });
    const dial = async (hello: unknown) => {
      const socket = fakeSocket();
      const link = broker.accept(socket.socket);
      await broker.fromRunner(link, typeof hello === "string" ? hello : JSON.stringify(hello));
      return socket;
    };
    const viewer = fakeSocket();
    const stream = broker.open(viewer.socket, input(WATCH));
    await until(() => stream.machineId !== null, "the stream.open");
    const hello = (token: string, streamId = stream.id) => ({ type: "stream.hello", token, streamId });

    expect((await dial(hello(`agm_${"x".repeat(43)}`))).closed?.code).toBe(STREAM_CLOSE.badToken);
    expect((await dial(hello(other.token))).closed?.code).toBe(STREAM_CLOSE.badToken);
    expect((await dial(hello(machine.token, "A".repeat(43)))).closed?.code).toBe(STREAM_CLOSE.notFound);
    expect((await dial("not a hello")).closed?.code).toBe(STREAM_CLOSE.badRequest);
    expect(viewer.closed).toBeNull();
    const good = await dial(hello(machine.token));
    expect(good.closed).toBeNull();
    expect(good.sent).toEqual(['{"type":"stream.ready"}']);
    // Served already: another data socket for it is refused, and the stream goes on.
    expect((await dial(hello(machine.token))).closed?.code).toBe(STREAM_CLOSE.notFound);
    expect(good.closed).toBeNull();

    // A stream whose data socket never came: the viewer hears 4408, and its id is gone.
    const slow = fakeSocket();
    const expired = broker.open(slow.socket, input(WATCH));
    await until(() => slow.closed !== null, "the open timeout");
    expect(slow.closed?.code).toBe(STREAM_CLOSE.late);
    expect((await dial(hello(machine.token, expired.id))).closed?.code).toBe(STREAM_CLOSE.notFound);

    // A data socket that never says hello.
    const silent = fakeSocket();
    broker.accept(silent.socket);
    await until(() => silent.closed !== null, "the hello timeout");
    expect(silent.closed?.code).toBe(STREAM_CLOSE.late);
  });

  test("a data socket naming no stream of its own goes to whoever claims it: an agent browser's live view", async () => {
    f = await setup();
    const machine = await paired();
    const got: (string | Uint8Array)[] = [];
    let ended = 0;
    const claims: { id: string; machineId: string }[] = [];
    const VIEW = "B".repeat(43);
    const { broker } = brokerFor(machine, {
      claim: (id, machineId) => {
        claims.push({ id, machineId });
        return id === VIEW ? { data: (d) => void got.push(d), closed: () => void ended++ } : null;
      },
    });
    const dial = async (streamId: string) => {
      const socket = fakeSocket();
      const link = broker.accept(socket.socket);
      await broker.fromRunner(link, JSON.stringify({ type: "stream.hello", token: machine.token, streamId }));
      return { socket, link };
    };
    expect((await dial("A".repeat(43))).socket.closed?.code).toBe(STREAM_CLOSE.notFound);
    const view = await dial(VIEW);
    expect(view.socket.closed).toBeNull();
    expect(view.socket.sent).toEqual(['{"type":"stream.ready"}']);
    expect(claims.at(-1)).toEqual({ id: VIEW, machineId: machine.machineId });
    await broker.fromRunner(view.link, new Uint8Array([1, 2, 3]));
    expect(got).toEqual([new Uint8Array([1, 2, 3])]);
    broker.runnerClosed(view.link, STREAM_CLOSE.normal);
    expect(ended).toBe(1);
    // The server stopping closes a claimed socket and tells whoever claimed it.
    const again = await dial(VIEW);
    broker.stop();
    expect(again.socket.closed?.code).toBe(STREAM_CLOSE.restarting);
    expect(ended).toBe(2);
  });

  test("onReady: once per stream, once its data socket is ready; never for one that got none", async () => {
    f = await setup();
    const machine = await paired();
    const ready: string[] = [];
    const { broker } = brokerFor(machine, {
      authorize: async (i) =>
        i.userId === f.owner.id
          ? { machineId: machine.machineId, agent: { id: i.agentId, handle: "dev" } }
          : { refused: STREAM_CLOSE.forbidden, reason: "forbidden" },
      onReady: (s) => {
        ready.push(s.runner ? s.id : "before its data socket");
      },
    });
    const control = broker.open(fakeSocket().socket, input(CONTROL));
    const watch = broker.open(fakeSocket().socket, input(WATCH));
    const refused = fakeSocket();
    broker.open(refused.socket, input(WATCH, f.agent.id, "someone-else"));
    await until(() => ready.length === 2 && refused.closed !== null, "both ready, one refused");
    expect(ready.sort()).toEqual([control.id, watch.id].sort());
    // Another data socket for a stream already served is refused, and fires nothing.
    const link = broker.accept(fakeSocket().socket);
    await broker.fromRunner(link, JSON.stringify({ type: "stream.hello", token: machine.token, streamId: control.id }));
    broker.close(control);
    await Bun.sleep(10);
    expect(ready).toHaveLength(2);
  });

  test("a failed or stalled access recheck closes both sides of a private stream", async () => {
    f = await setup();
    const machine = await paired();
    for (const mode of ["rejected", "stalled"] as const) {
      const { broker: current, runners } = brokerFor(machine, {
        recheck:
          mode === "rejected"
            ? async () => {
                throw new Error("access store unavailable");
              }
            : () => new Promise<null>(() => {}),
        limits: { accessRecheckMs: 20 },
      });
      const viewer = fakeSocket();
      current.open(viewer.socket, input(WATCH));
      await until(() => viewer.closed !== null, `${mode} recheck`);
      expect(viewer.closed).toEqual({ code: STREAM_CLOSE.internal, reason: "access unavailable" });
      expect(runners[0]?.socket.closed).toEqual(viewer.closed);
      current.stop();
    }
  });

  test("the computer's answer: its refusal, offline, paused, at its cap, or a reply without a data socket", async () => {
    f = await setup();
    const machine = await paired();
    const answers: (() => Promise<unknown>)[] = [
      async () => {
        throw new MachineRequestError("desktop_unavailable", "Install the agents' desktops");
      },
      async () => {
        throw new MachineOfflineError("Box", null);
      },
      async () => {
        throw new MachinePausedError("Box", null);
      },
      async () => {
        throw new MachineRequestError("too_many_streams", "Too many");
      },
      async () => ({ opened: true }),
    ];
    const { broker } = brokerFor(machine, { reply: () => (answers.shift() as () => Promise<unknown>)() });
    const closes: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const viewer = fakeSocket();
      broker.open(viewer.socket, input(WATCH));
      await until(() => viewer.closed !== null, "the refusal");
      closes.push(viewer.closed);
    }
    expect(closes).toEqual([
      { code: STREAM_CLOSE.refused, reason: "desktop_unavailable" },
      { code: STREAM_CLOSE.unreachable, reason: "offline" },
      { code: STREAM_CLOSE.refused, reason: "machine_paused" },
      { code: STREAM_CLOSE.tooMany, reason: "too_many_streams" },
      { code: STREAM_CLOSE.late, reason: "no data socket" },
    ]);
    expect(broker.count(f.agent.id, "desktop")).toBe(0);
  });

  test("an older runner refuses a desktop that isn't running: the server starts it and opens once more", async () => {
    f = await setup();
    const machine = await paired();
    let refuse = 1;
    const { broker, requests } = brokerFor(machine, {
      reply: async (request) => {
        if (request.op === "desktop.session.start") return { display: 20, started: true };
        if (refuse-- > 0) throw new MachineRequestError("desktop_off", "The agent's desktop isn't running");
        const link = broker.accept(fakeSocket().socket);
        await broker.fromRunner(
          link,
          JSON.stringify({
            type: "stream.hello",
            token: machine.token,
            streamId: (request as { streamId: string }).streamId,
          }),
        );
        return { opened: true };
      },
    });
    const viewer = fakeSocket();
    const stream = broker.open(viewer.socket, input(WATCH));
    await until(() => stream.runner !== null, "the data socket");
    expect(viewer.closed).toBeNull();
    expect(requests.map((r) => r.op)).toEqual(["stream.open", "desktop.session.start", "stream.open"]);
    expect(requests[1]).toMatchObject({ agent: { id: f.agent.id } });

    // Still not running after its start: refused, once.
    refuse = 2;
    const again = fakeSocket();
    broker.open(again.socket, input(WATCH));
    await until(() => again.closed !== null, "the refusal");
    expect(again.closed).toEqual({ code: STREAM_CLOSE.refused, reason: "desktop_off" });
    expect(requests.slice(3).map((r) => r.op)).toEqual(["stream.open", "desktop.session.start", "stream.open"]);
  });

  test("a desktop starts for whoever opens it, unless the agent is held: then one that isn't running stays so", async () => {
    f = await setup();
    const machine = await paired();
    let held = false;
    const { broker, requests } = brokerFor(machine, {
      authorize: async (input) => ({
        machineId: machine.machineId,
        agent: { id: input.agentId, handle: "dev" },
        ...(held ? { held } : {}),
      }),
      // A computer whose desktop isn't running: it opens only a stream asked to start it.
      reply: async (request) => {
        if (request.op !== "stream.open" || request.start !== true) {
          throw new MachineRequestError("desktop_off", "The agent's desktop isn't running");
        }
        const link = broker.accept(fakeSocket().socket);
        const hello = { type: "stream.hello", token: machine.token, streamId: request.streamId };
        await broker.fromRunner(link, JSON.stringify(hello));
        return { opened: true };
      },
    });
    const viewer = fakeSocket();
    const stream = broker.open(viewer.socket, input(WATCH));
    await until(() => stream.runner !== null, "the data socket");
    expect(requests).toMatchObject([{ op: "stream.open", kind: "desktop", start: true }]);

    held = true;
    const watcher = fakeSocket();
    broker.open(watcher.socket, input(WATCH));
    await until(() => watcher.closed !== null, "the refusal");
    expect(watcher.closed).toEqual({ code: STREAM_CLOSE.refused, reason: "held" });
    expect(requests.slice(1)).toHaveLength(1);
    expect(requests[1]).not.toHaveProperty("start");
  });

  test("the hub's own refusal of a held agent's work reads as held", async () => {
    f = await setup();
    const machine = await paired();
    const { broker } = brokerFor(machine, {
      reply: async () => {
        throw new AgentHeldError();
      },
    });
    const viewer = fakeSocket();
    broker.open(viewer.socket, input(CONTROL));
    await until(() => viewer.closed !== null, "the refusal");
    expect(viewer.closed).toEqual({ code: STREAM_CLOSE.refused, reason: "held" });
  });

  test("a viewer that doesn't keep up ends the stream on both sides; too much or malformed input is 4400", async () => {
    f = await setup();
    const machine = await paired();
    const { broker, runners } = brokerFor(machine);
    const open = async (request: StreamRequest) => {
      const viewer = fakeSocket();
      const stream = broker.open(viewer.socket, input(request));
      await until(() => stream.runner !== null, "the data socket");
      return { viewer, stream, runner: runners.at(-1) as (typeof runners)[number] };
    };

    const slow = await open(WATCH);
    slow.viewer.backlog = STREAM_LIMITS.viewerBufferedMax + 1;
    await broker.fromRunner(slow.runner.link, new Uint8Array(16));
    expect(slow.viewer.closed?.code).toBe(STREAM_CLOSE.tooSlow);
    expect(slow.runner.socket.closed?.code).toBe(STREAM_CLOSE.tooSlow);

    const big = await open(WATCH);
    broker.fromViewer(big.stream, new Uint8Array((1 << 20) + 1));
    expect(big.viewer.closed?.code).toBe(STREAM_CLOSE.badRequest);
    expect(big.runner.socket.closed?.code).toBe(STREAM_CLOSE.badRequest);

    const fast = await open(WATCH);
    for (let i = 0; i < 3; i++) broker.fromViewer(fast.stream, new Uint8Array(200 << 10));
    expect(fast.viewer.closed?.code).toBe(STREAM_CLOSE.badRequest);
    expect(fast.runner.socket.sent).toHaveLength(3);

    const text = await open(WATCH);
    broker.fromViewer(text.stream, JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    expect(text.viewer.closed?.code).toBe(STREAM_CLOSE.badRequest);

    const terminal = await open(TERMINAL);
    broker.fromViewer(terminal.stream, JSON.stringify({ type: "resize", cols: 9000, rows: 30 }));
    expect(terminal.viewer.closed?.code).toBe(STREAM_CLOSE.badRequest);
  });

  test("caps: 4 viewers per desktop, 3 terminals per agent and 10 per computer; closeWhere and stop", async () => {
    f = await setup();
    const machine = await paired();
    const { broker } = brokerFor(machine);
    const open = async (request: StreamRequest, agentId = f.agent.id, userId = f.owner.id) => {
      const viewer = fakeSocket();
      const stream = broker.open(viewer.socket, input(request, agentId, userId));
      await until(() => stream.runner !== null || viewer.closed !== null, "the stream");
      return { viewer, stream };
    };
    const watchers = [];
    for (let i = 0; i < 3; i++) watchers.push(await open(WATCH));
    const bia = await open(WATCH, f.agent.id, "bia");
    expect([...watchers, bia].every((w) => w.viewer.closed === null)).toBe(true);
    expect((await open(WATCH)).viewer.closed?.code).toBe(STREAM_CLOSE.tooMany);
    // Someone took control: the others' views go, with the code their panel shows; a place is free again.
    const others = (s: { request: StreamRequest; userId: string }) =>
      s.request.kind === "desktop" && s.userId !== f.owner.id;
    expect(broker.closeWhere(others, STREAM_CLOSE.hidden)).toBe(1);
    expect(bia.viewer.closed?.code).toBe(STREAM_CLOSE.hidden);
    expect((await open(WATCH)).viewer.closed).toBeNull();
    expect(broker.count(f.agent.id, "desktop")).toBe(4);

    for (let i = 0; i < 3; i++) expect((await open(TERMINAL)).viewer.closed).toBeNull();
    expect((await open(TERMINAL)).viewer.closed?.code).toBe(STREAM_CLOSE.tooMany);
    // Other agents on the same computer: 10 terminals there at most.
    for (const agentId of ["b", "b", "b", "c", "c", "c", "d"]) {
      expect((await open(TERMINAL, agentId)).viewer.closed).toBeNull();
    }
    expect((await open(TERMINAL, "d")).viewer.closed?.code).toBe(STREAM_CLOSE.tooMany);

    broker.stop();
    expect(watchers.map((w) => w.viewer.closed?.code)).toEqual([1001, 1001, 1001]);
    expect(broker.count(f.agent.id, "desktop")).toBe(0);
  });
});

describe("a phone's screen", () => {
  test("goes to the phone's computer with no agent; pictures to a viewer, base64 for the phone app; only control's input goes back", async () => {
    f = await setup();
    const machine = await paired();
    const phone = {
      platform: "android" as const,
      serial: "emulator-5554",
      holder: { runId: null, agentId: null, userId: f.owner.id, since: "" },
    };
    const { broker, requests, runners } = brokerFor(machine, {
      authorize: async () => ({ machineId: machine.machineId, phone }),
    });
    const phoneId = crypto.randomUUID();
    const open = (mode: "watch" | "control", text = false) => {
      const viewer = fakeSocket();
      const stream = broker.open(viewer.socket, {
        userId: f.owner.id,
        orgId: f.org.id,
        agentId: "",
        request: { kind: "phone", mode, phoneId },
        ...(text ? { text: true } : {}),
      });
      return { viewer, stream };
    };
    const control = open("control");
    await until(() => control.stream.runner !== null, "the data socket");
    expect(requests[0]).toEqual({
      op: "stream.open",
      streamId: control.stream.id,
      kind: "phone",
      mode: "control",
      phoneId,
      phone,
    });
    const runner = runners[0] as (typeof runners)[number];
    await broker.fromRunner(runner.link, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(control.viewer.sent).toEqual([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]);
    const tap = JSON.stringify({ type: "tap", x: 0.5, y: 0.25 });
    broker.fromViewer(control.stream, tap);
    broker.fromViewer(control.stream, JSON.stringify({ type: "ack" }));
    expect(runner.socket.sent.slice(1)).toEqual([tap, '{"type":"ack"}']);
    // Control ended on the computer (its owner took it back): the viewer opens again as a watcher.
    broker.runnerClosed(runner.link, STREAM_CLOSE.controlEnded);
    expect(control.viewer.closed?.code).toBe(STREAM_CLOSE.controlEnded);

    // The phone app's watcher: pictures as base64 text, and a watcher's input closes it.
    const watch = open("watch", true);
    await until(() => watch.stream.runner !== null, "the watcher's data socket");
    await broker.fromRunner((runners[1] as (typeof runners)[number]).link, new Uint8Array([0xff, 0xd8, 0xff]));
    expect(watch.viewer.sent).toEqual(["/9j/"]);
    broker.fromViewer(watch.stream, tap);
    expect(watch.viewer.closed).toEqual({ code: STREAM_CLOSE.badRequest, reason: "bad frame" });
    // Bytes from a viewer go nowhere either.
    const other = open("control");
    await until(() => other.stream.runner !== null, "the third data socket");
    broker.fromViewer(other.stream, new Uint8Array([1]));
    expect(other.viewer.closed?.code).toBe(STREAM_CLOSE.badRequest);
  });

  test("at most 4 people watch one phone", async () => {
    f = await setup();
    const machine = await paired();
    const { broker } = brokerFor(machine, { authorize: async () => ({ machineId: machine.machineId }) });
    const phoneId = crypto.randomUUID();
    const viewers = Array.from({ length: 5 }, () => {
      const viewer = fakeSocket();
      broker.open(viewer.socket, {
        userId: f.owner.id,
        orgId: f.org.id,
        agentId: "",
        request: { kind: "phone", mode: "watch", phoneId },
      });
      return viewer;
    });
    await until(() => viewers.some((v) => v.closed !== null), "the fifth refused");
    expect(viewers.map((v) => v.closed?.code ?? null)).toEqual([null, null, null, null, STREAM_CLOSE.tooMany]);
  });
});

describe("a browser card's view of the screen (ADR 0058 §7)", () => {
  test("never starts the desktop, holds 3 of its 4 places, yields to a full viewer and never changes mode", async () => {
    f = await setup();
    const machine = await paired();
    let off = true;
    let refuseOnce = false;
    const { broker, requests } = brokerFor(machine, {
      authorize: async (input) => ({
        machineId: machine.machineId,
        agent: { id: input.agentId, handle: "dev" },
        switches: true,
      }),
      reply: async (request) => {
        if (request.op !== "stream.open") throw new Error(`unexpected ${request.op}`);
        if (off && request.start !== true) {
          throw new MachineRequestError("desktop_off", "The agent's desktop isn't running");
        }
        // The computer still counts the card's view that just yielded, until its data socket has closed.
        if (refuseOnce) {
          refuseOnce = false;
          throw new MachineRequestError("too_many_streams", "Too many");
        }
        const link = broker.accept(fakeSocket().socket);
        const hello = { type: "stream.hello", token: machine.token, streamId: request.streamId };
        await broker.fromRunner(link, JSON.stringify(hello));
        return { opened: true };
      },
    });
    const preview = (userId = f.owner.id): StreamInput => ({
      ...input(WATCH, f.agent.id, userId),
      preview: true,
      switches: true,
    });
    const open = async (what: StreamInput) => {
      const viewer = fakeSocket();
      const stream = broker.open(viewer.socket, what);
      await until(() => stream.runner !== null || viewer.closed !== null, "the stream");
      return { viewer, stream };
    };

    // A desktop that isn't running stays so: refused, with no start and no start after it.
    const stopped = await open(preview());
    expect(stopped.viewer.closed).toEqual({ code: STREAM_CLOSE.refused, reason: "desktop_off" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ op: "stream.open", kind: "desktop", mode: "watch" });
    expect(requests[0]).not.toHaveProperty("start");

    off = false;
    const cards = [await open(preview()), await open(preview("bia")), await open(preview("caio"))];
    expect(cards.every((c) => c.viewer.closed === null && c.stream.runner !== null)).toBe(true);
    for (const r of requests.slice(1)) expect(r).not.toHaveProperty("start");
    // A fourth card would take the last place, which stays for whoever opens the screen itself.
    expect((await open(preview("dani"))).viewer.closed).toEqual({
      code: STREAM_CLOSE.tooMany,
      reason: "too_many_streams",
    });

    // Never turned to control: no `{"type":"mode"}` frame, nothing switched.
    broker.switchWhere(() => true, "control");
    for (const c of cards) {
      expect(broker.switches(c.stream)).toBe(false);
      expect(c.stream.request).toEqual(WATCH);
      expect(c.viewer.sent).toEqual([]);
    }

    // A person opening the screen itself takes the last place, then the oldest card's.
    const first = await open(input(WATCH));
    expect(first.viewer.closed).toBeNull();
    refuseOnce = true;
    const before = requests.length;
    const second = await open(input(WATCH, f.agent.id, "bia"));
    expect(second.viewer.closed).toBeNull();
    expect(second.stream.runner).not.toBeNull();
    expect(cards[0]?.viewer.closed).toEqual({ code: STREAM_CLOSE.tooMany, reason: "preview_yield" });
    expect(cards.slice(1).every((c) => c.viewer.closed === null)).toBe(true);
    // Asked again once, after the computer's own count let go of the card's view.
    expect(requests.slice(before).map((r) => r.op)).toEqual(["stream.open", "stream.open"]);
    expect(requests.at(-1)).toMatchObject({ start: true });
    expect(broker.count(f.agent.id, "desktop")).toBe(4);
  });
});

describe("who may open which stream, and where", () => {
  const setMachine = (id: string, values: Partial<typeof schema.machines.$inferInsert>) =>
    f.db.update(schema.machines).set(values).where(eq(schema.machines.id, id));
  const refused = (code: number, reason: string) => ({ refused: code, reason });

  async function start() {
    f = await setup();
    const machine = await paired();
    await f.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, f.agent.id));
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: DESKTOP_SCOPE }]);
    await setMachine(machine.machineId, {
      protocol: DESKTOP_PROTOCOL,
      access: { folders: [], tools: { claude: false, codex: false, commands: true, desktop: true, terminal: true } },
      executors: { desktop: { available: true }, terminal: { available: true } },
    });
    const local = new Set([machine.machineId]);
    const deps = { db: f.db, hub: { isLocal: (id: string) => local.has(id) } };
    const check = (userId: string, request: StreamRequest, rateLimiter?: ReturnType<typeof createMemoryRateLimiter>) =>
      authorizeStream({ ...deps, rateLimiter }, input(request, f.agent.id, userId));
    const target = { machineId: machine.machineId, agent: { id: f.agent.id, handle: "dev", name: "Dev" } };
    return { machine, local, check, target };
  }

  test("watching follows the browser's rule; control and the terminal only the person who paired the computer", async () => {
    const { machine, check, target } = await start();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    expect(await check(f.owner.id, WATCH)).toEqual(target);
    expect(await check(bia.id, WATCH)).toEqual(target);
    expect(await check(caio.id, WATCH)).toEqual(refused(4403, "forbidden"));
    // An admin of the workspace still doesn't drive a computer someone else paired.
    expect(await check(bia.id, TERMINAL)).toEqual(refused(4403, "forbidden"));
    expect(await check(f.owner.id, TERMINAL)).toEqual(target);

    // Control: only the person in control of the desktop; while they are, nobody else watches.
    expect(await check(f.owner.id, CONTROL)).toEqual(refused(4410, "not_in_control"));
    await startTakeover({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, null, "desktop");
    expect(await check(f.owner.id, CONTROL)).toEqual(target);
    expect(await check(f.owner.id, WATCH)).toEqual(target);
    expect(await check(bia.id, WATCH)).toEqual(refused(4409, "someone_in_control"));
    expect(await check(bia.id, CONTROL)).toEqual(refused(4403, "forbidden"));

    // A computer nobody paired (a server's own): nobody drives it.
    await setMachine(machine.machineId, { pairedByUserId: null });
    expect(await check(f.owner.id, TERMINAL)).toEqual(refused(4403, "forbidden"));
  });

  test("the computer: here, on protocol 18, switched on and able to serve it; the agent may use its desktop", async () => {
    const { machine, local, check } = await start();
    const id = machine.machineId;
    local.delete(id);
    expect(await check(f.owner.id, WATCH)).toEqual(refused(4503, "offline"));
    await setMachine(id, { online: true, connectedReplica: "replica-b", lastSeenAt: new Date() });
    expect(await check(f.owner.id, WATCH)).toEqual(refused(4503, "other_server"));
    local.add(id);
    await setMachine(id, { protocol: DESKTOP_PROTOCOL - 1 });
    expect(await check(f.owner.id, WATCH)).toEqual(refused(4502, "runner_outdated"));
    await setMachine(id, {
      protocol: DESKTOP_PROTOCOL,
      access: { folders: [], tools: { claude: false, codex: false, commands: true, terminal: true } },
    });
    expect(await check(f.owner.id, WATCH)).toEqual(refused(4502, "not_allowed"));
    expect((await check(f.owner.id, TERMINAL)) as object).toHaveProperty("machineId", id);
    await setMachine(id, {
      access: { folders: [], tools: { claude: false, codex: false, commands: true, desktop: true, terminal: true } },
      executors: {
        desktop: { available: false, reason: "Install the desktop packages" },
        terminal: { available: true },
      },
    });
    expect(await check(f.owner.id, WATCH)).toEqual(refused(4502, "desktop_unavailable"));
    await f.db
      .delete(schema.agentScopes)
      .where(and(eq(schema.agentScopes.agentId, f.agent.id), eq(schema.agentScopes.scope, DESKTOP_SCOPE)));
    expect(await check(f.owner.id, WATCH)).toEqual(refused(4404, "no_desktop"));
    await f.db.update(schema.agents).set({ machineId: null }).where(eq(schema.agents.id, f.agent.id));
    expect(await check(f.owner.id, TERMINAL)).toEqual(refused(4404, "not_found"));
  });

  test("a held agent's desktop, or one in a workspace on hold, may be watched as it runs; nothing starts it", async () => {
    const { check, target } = await start();
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: true, reason: "Review" });
    expect(await check(f.owner.id, WATCH)).toEqual({ ...target, held: true });
    expect(await check(f.owner.id, TERMINAL)).toEqual(target);
    await setAgentHold(f.db, f.org.id, f.agent.id, { held: false, reason: null });
    expect(await check(f.owner.id, WATCH)).toEqual(target);
    await setOrgStanding({ db: f.db, pubsub: f.pubsub }, f.org.id, {
      state: "hold",
      reason: "Review",
      notice: "silent",
    });
    expect(await check(f.owner.id, WATCH)).toEqual({ ...target, held: true });
  });

  test("at most 30 opens a minute per person", async () => {
    const { check } = await start();
    const rateLimiter = createMemoryRateLimiter();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    for (let i = 0; i < 30; i++) expect(await check(f.owner.id, WATCH, rateLimiter)).toHaveProperty("machineId");
    expect(await check(f.owner.id, WATCH, rateLimiter)).toEqual(refused(4429, "rate_limited"));
    expect(await check(bia.id, WATCH, rateLimiter)).toHaveProperty("machineId");
  });
});

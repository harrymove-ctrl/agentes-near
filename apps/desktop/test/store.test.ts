import { expect, test } from "bun:test";
import type { ControlEvent, ControlStatus } from "@agenteschat/adapters/runner-control";
import type { ControlError } from "../src/control/client";
import { DesktopStore } from "../src/control/store";
import type { Host } from "../src/host/types";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function status(logoEtag?: string): ControlStatus {
  return {
    paired: true,
    org: { id: "o1", name: "Acme", ...(logoEtag ? { logoEtag } : {}) },
    connection: "online",
    version: "0.1.0",
    protocol: 10,
    paused: { paused: false, until: null },
    executors: {},
    agents: [],
  };
}

/** A host with one running home whose runner answers from `state`. */
function setup() {
  const state = { status: status('"a.png"'), logo: PNG as string | null, logoAsks: 0 };
  let onLine: (homeId: string, line: string) => void = () => {};
  const host = {
    window: "popover",
    fake: true,
    listRunners: async () => [{ homeId: "h1", dir: "/tmp/h1", running: true, hello: null }],
    onLine: (cb: typeof onLine) => {
      onLine = cb;
      return () => {};
    },
    onRunnerState: () => () => {},
    send: async (homeId: string, line: string) => {
      const req = JSON.parse(line) as { id: string; type: string };
      let data: unknown = {};
      if (req.type === "status") data = state.status;
      if (req.type === "jobs") data = { jobs: [] };
      if (req.type === "access.pending") data = { requests: [] };
      if (req.type === "access.get") data = { folders: [], tools: { claude: false, codex: false, commands: false } };
      if (req.type === "org.logo") {
        state.logoAsks += 1;
        data = { logo: state.logo };
      }
      queueMicrotask(() => onLine(homeId, JSON.stringify({ type: "reply", id: req.id, ok: true, data })));
    },
  } as unknown as Host;
  const store = new DesktopStore(host, { idPrefix: "t" });
  const event = (e: ControlEvent) => onLine("h1", JSON.stringify({ type: "event", event: e }));
  return { store, state, event };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("the org logo: asked once per etag, again when it changes, cleared when the runner has none", async () => {
  const { store, state, event } = setup();
  store.start();
  await settle();
  expect(store.home("h1")?.logo).toBe(PNG);
  expect(state.logoAsks).toBe(1);

  // Same etag: not asked again.
  event({ kind: "status", status: status('"a.png"') });
  await settle();
  expect(state.logoAsks).toBe(1);

  // A new logo: asked again.
  state.logo = "data:image/webp;base64,UklGRg==";
  event({ kind: "status", status: status('"b.webp"') });
  await settle();
  expect(state.logoAsks).toBe(2);
  expect(store.home("h1")?.logo).toBe("data:image/webp;base64,UklGRg==");

  // Removed on the site: back to the initial.
  event({ kind: "status", status: status() });
  await settle();
  expect(store.home("h1")?.logo).toBeNull();

  // Anything that isn't a PNG/JPEG/WebP data URL is not drawn.
  state.logo = "https://evil.example/logo.png";
  event({ kind: "status", status: status('"c.png"') });
  await settle();
  expect(store.home("h1")?.logo).toBeNull();
});

/** A home whose runner's replies wait until the test lets them out (in any order with events). */
function heldSetup() {
  const held: { type: string; send: () => void }[] = [];
  let onLine: (homeId: string, line: string) => void = () => {};
  let onShown: (name: string) => void = () => {};
  const asked: string[] = [];
  const reply = { status: { ...status(), seq: 1 } as ControlStatus };
  const host = {
    window: "prefs",
    fake: true,
    listRunners: async () => [{ homeId: "h1", dir: "/tmp/h1", running: true, hello: null }],
    onLine: (cb: typeof onLine) => {
      onLine = cb;
      return () => {};
    },
    onRunnerState: () => () => {},
    onShown: (cb: typeof onShown) => {
      onShown = cb;
      return () => {};
    },
    send: async (homeId: string, line: string) => {
      const req = JSON.parse(line) as { id: string; type: string };
      asked.push(req.type);
      let data: unknown = {};
      // The runner answers with the status it has when it reads the request.
      if (req.type === "status") data = reply.status;
      if (req.type === "jobs") data = { jobs: [] };
      if (req.type === "access.pending") data = { requests: [] };
      if (req.type === "access.get") data = { folders: [], tools: { claude: false, codex: false, commands: false } };
      const text = JSON.stringify({ type: "reply", id: req.id, ok: true, data });
      held.push({ type: req.type, send: () => onLine(homeId, text) });
    },
  } as unknown as Host;
  const store = new DesktopStore(host, { idPrefix: "t" });
  const line = (out: unknown) => onLine("h1", JSON.stringify(out));
  const event = (e: ControlEvent) => line({ type: "event", event: e });
  const release = (type?: string) => {
    for (let i = 0; i < held.length; ) {
      const h = held[i] as (typeof held)[number];
      if (!type || h.type === type) {
        held.splice(i, 1);
        h.send();
      } else i++;
    }
  };
  const drain = async () => {
    for (let i = 0; i < 5; i++) {
      release();
      await settle();
    }
  };
  return { store, reply, event, line, release, drain, asked, shown: (name: string) => onShown(name) };
}

const at = (seq: number, connection: ControlStatus["connection"]): ControlStatus => ({ ...status(), connection, seq });

test("status: a reply asked before a newer event never overwrites it, even when both are read in one go", async () => {
  const { store, reply, event, release, drain } = heldSetup();
  reply.status = at(3, "connecting");
  store.start();
  await drain();
  expect(store.home("h1")?.status?.connection).toBe("connecting");

  // Asked while connecting (the reply carries seq 4); the runner comes online right after answering
  // and both lines are read in the same task: the reply's promise settles after the event.
  reply.status = at(4, "connecting");
  void store.refresh("h1");
  await settle();
  release("status");
  event({ kind: "status", status: at(5, "online") });
  await drain();
  expect(store.home("h1")?.status).toMatchObject({ connection: "online", seq: 5 });

  // The same reply read on its own, after the event.
  reply.status = at(5, "online");
  void store.refresh("h1");
  await settle();
  event({ kind: "status", status: at(7, "offline") });
  await settle();
  release("status");
  await drain();
  expect(store.home("h1")?.status).toMatchObject({ connection: "offline", seq: 7 });

  // An older event is dropped too.
  event({ kind: "status", status: at(6, "online") });
  await settle();
  expect(store.home("h1")?.status?.connection).toBe("offline");
});

test("status: a restarted runner (new hello) starts its seq over; an older runner without seq is taken as is", async () => {
  const { store, reply, event, line, drain } = heldSetup();
  reply.status = at(40, "online");
  store.start();
  await drain();
  expect(store.home("h1")?.status?.seq).toBe(40);

  reply.status = at(1, "connecting");
  line({ type: "hello", control: 1, version: "0.1.0", protocol: 10, home: "/tmp/h1" });
  await drain();
  expect(store.home("h1")?.status).toMatchObject({ connection: "connecting", seq: 1 });
  event({ kind: "status", status: at(2, "online") });
  await settle();
  expect(store.home("h1")?.status?.connection).toBe("online");

  const { seq: _drop, ...legacy } = at(0, "offline");
  event({ kind: "status", status: legacy });
  await settle();
  expect(store.home("h1")?.status?.connection).toBe("offline");
});

test("status: showing this window reads every home again; another window being shown does not", async () => {
  const { store, reply, asked, shown, drain } = heldSetup();
  reply.status = at(1, "connecting");
  store.start();
  await drain();
  expect(store.home("h1")?.status?.connection).toBe("connecting");
  const before = asked.filter((t) => t === "status").length;

  // An event was missed while hidden; the runner now says online.
  reply.status = at(9, "online");
  shown("popover");
  await drain();
  expect(asked.filter((t) => t === "status").length).toBe(before);
  shown("prefs");
  await drain();
  expect(asked.filter((t) => t === "status").length).toBe(before + 1);
  expect(store.home("h1")?.status?.connection).toBe("online");
});

test("stopping: a request still waiting for its reply fails at once, so nothing waits on its timer after the window", async () => {
  const { store, drain } = heldSetup();
  const stop = store.start();
  await drain();
  const resume = store.request("h1", { type: "resume" }).catch((e: unknown) => e);
  stop();
  expect(((await resume) as ControlError).code).toBe("closed");
  expect(store.client.inFlight).toBe(0);
});

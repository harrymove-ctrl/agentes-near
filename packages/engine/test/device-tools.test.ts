import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { MachineReplies, MachineRequest } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  afterDeviceAccessDecided,
  createDeviceToolSource,
  type DeviceToolDeps,
  decideDeviceAccess,
  deviceWaitAction,
  drainOutbox,
  expireDeviceWait,
  ForbiddenError,
  getMessage,
  grantScopes,
  holdsMessages,
  type MachineCaller,
  type MachineHub,
  MachineRequestError,
  pickDevice,
  postPersonMessage,
  receiveMachineUpload,
  releaseRunPhones,
  removeMember,
  renderPush,
  resumeComputerWaits,
  resumePhoneWaits,
  secretsMayGo,
  stopPhone,
  type ToolContext,
} from "../src";
import { currentWaits, onMessageWhileWaiting } from "../src/waits";
import { addMember, type Fixture, setup } from "./fixtures";
import { connectedComputer, type FakeRunnerOptions, fakeRunner, pairMachine, RUNNER } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** The phone ops the fake host answers, and what it was asked. */
type PhoneAnswer = (req: MachineRequest) => unknown;

/**
 * Ana's agent @dev on its own computer, and Sam with his MacBook (online) reaching a Pixel 8. The device tools' hub
 * answers `phone.*` itself (`answer`) and passes everything else to the real hub, so files come back for real.
 */
async function world(
  options: {
    reply?: (req: ModelRequest) => { chunks: string[]; toolUses?: never[] };
    exec?: FakeRunnerOptions["exec"];
  } = {},
) {
  const devDeps = {} as DeviceToolDeps;
  f = await setup({
    machines: true,
    reply: (options.reply as never) ?? (() => ({ chunks: ["ok"] })),
    toolSources: [createDeviceToolSource(devDeps)],
  });
  await connectedComputer(f, { exec: options.exec });
  const sam = await addMember(f.db, f.org.id, "member", "Sam Rivera");
  const mac = await pairMachine({ db: f.db, pubsub: f.pubsub }, sam.id, f.org.id, {
    name: "Sam's MacBook",
    ...RUNNER,
    os: "darwin",
  });
  const runner = fakeRunner(f.machineHub as MachineHub, {
    exec: options.exec,
    async push(req, bytes, name) {
      await receiveMachineUpload(
        { db: f.db, artifacts: f.artifactDeps, pubsub: f.pubsub },
        {
          uploadId: req.uploadId,
          machineId: mac.machineId,
          name,
          contentType: "",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          body: bytes,
        },
      );
    },
  });
  await runner.hello(mac.token);
  const [phone] = await f.db
    .insert(schema.machinePhones)
    .values({
      orgId: f.org.id,
      machineId: mac.machineId,
      platform: "android",
      serial: "R5CT1234",
      name: "Pixel 8",
      model: "Pixel 8",
      osVersion: "15",
      ownerUserId: sam.id,
      lastSeenAt: new Date(),
    })
    .returning();
  if (!phone) throw new Error("no phone");
  const asked: MachineRequest[] = [];
  let answer: PhoneAnswer = () => ({});
  const real = f.machineHub as MachineHub;
  const hub: MachineCaller = {
    status: (id) => real.status(id),
    call: (async (id: string, req: MachineRequest) => {
      if (!req.op.startsWith("phone.")) return real.call(id, req as never);
      asked.push(req);
      return answer(req);
    }) as MachineCaller["call"],
  };
  Object.assign(devDeps, {
    db: f.db,
    machines: { hub },
    pubsub: f.pubsub,
    artifacts: f.artifactDeps,
    publicUrl: "http://localhost:3000",
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "drive:write" }]);
  return {
    sam,
    mac,
    runner,
    phone,
    asked,
    hub,
    devDeps,
    answer: (fn: PhoneAnswer) => {
      answer = fn;
    },
  };
}

async function runCtx(body = "@dev oi"): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: msg.id,
  };
}

const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
  if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
  return outcome.output;
};

const notificationsOf = (userId: string) =>
  f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));

describe("naming a device", () => {
  test("its id, its name in any case or an alias, then the one name it starts; several or none say which exist", () => {
    const mac = { id: "a", name: "Sam's MacBook" };
    const pc = { id: "b", name: "Build PC" };
    const list = [mac, pc, { id: "c", name: "Build box" }];
    expect(pickDevice(list, "b", "computer")).toEqual({ ok: true, item: pc });
    expect(pickDevice(list, "  sam's macbook ", "computer")).toEqual({ ok: true, item: mac });
    expect(pickDevice(list, "sam", "computer")).toEqual({ ok: true, item: mac });
    expect(pickDevice(list, "pixel", "computer", (i) => (i.id === "b" ? ["Pixel host"] : []))).toMatchObject({
      ok: false,
    });
    expect(pickDevice(list, "pixel host", "computer", (i) => (i.id === "b" ? ["Pixel host"] : []))).toEqual({
      ok: true,
      item: pc,
    });
    expect(pickDevice(list, "build", "computer")).toEqual({
      ok: false,
      message:
        '"build" matches several computers: "Build PC", "Build box". Ask the person which one, or use its exact name.',
    });
    expect(pickDevice(list, "windows", "computer")).toEqual({
      ok: false,
      message: `No computer is called "windows". The workspace's computers: "Sam's MacBook", "Build PC", "Build box".`,
    });
    expect(pickDevice([], "x", "phone")).toEqual({
      ok: false,
      message: 'No phone is called "x". The workspace has no phones.',
    });
  });
});

test("the owner's pushes say whose agent, for whom and which device, in their language", () => {
  const input = { waiting: false, actorName: "Lia", title: "Rui", label: "Pixel 8" };
  expect(renderPush("en", { ...input, kind: "device.in_use", text: "Recording a test video" })).toEqual({
    title: "Lia (for Rui) is using your Pixel 8",
    body: "Recording a test video",
  });
  expect(renderPush("pt-BR", { ...input, kind: "device.access_request", waiting: true })).toEqual({
    title: "Lia (para Rui) pede para usar seu Pixel 8",
    body: "Toque para permitir uma vez, sempre, ou dizer não.",
  });
  expect(renderPush("en", { ...input, kind: "device.waiting", label: "MacBook" }).title).toBe(
    "Rui's agent is waiting for your MacBook",
  );
});

describe("computer on someone else's device", () => {
  test("Only Sam: the owner is asked once; Allow once lets the agent work there and Sam hears it once", async () => {
    const w = await world();
    const ctx = await runCtx();
    const refused = await call(ctx, "run_code", { language: "bash", code: "uname -a", computer: "sam's macbook" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Sam's MacBook is set to Only Sam, so you can't use it for ana. Sam was asked");
    expect(refused.content).toContain('wait_for_device("Sam\'s MacBook")');
    // Asking again doesn't ask Sam twice.
    await call(ctx, "list_files", { computer: "Sam's MacBook" });
    const requests = await f.db.select().from(schema.deviceAccessRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ requesterUserId: f.owner.id, machineId: w.mac.machineId, status: "pending" });
    const asked = await notificationsOf(w.sam.id);
    expect(asked.filter((n) => n.kind === "device.access_request")).toHaveLength(1);
    expect(asked[0]).toMatchObject({ waiting: true, source: expect.objectContaining({ label: "Sam's MacBook" }) });

    // Only the owner answers.
    await expect(
      decideDeviceAccess({ db: f.db }, f.owner.id, f.org.id, requests[0]?.id ?? "", "always"),
    ).rejects.toThrow(ForbiddenError);
    await decideDeviceAccess({ db: f.db }, w.sam.id, f.org.id, requests[0]?.id ?? "", "once");
    const ran = await call(ctx, "run_code", { language: "bash", code: "uname -a", computer: "Sam's MacBook" });
    expect(ran.isError).toBeFalsy();
    expect(ran.content).toContain("exit code 0");
    expect(w.runner.sent.some((s) => s.type === "request" && s.op === "exec")).toBe(true);
    await call(ctx, "read_file", { path: "notes.md", computer: "Sam's MacBook" });
    const told = (await notificationsOf(w.sam.id)).filter((n) => n.kind === "device.in_use");
    expect(told).toHaveLength(1);
    expect(told[0]?.latest).toMatchObject({ title: "ana", text: "Running bash code" });
    // The agent's own computer needs nothing of anyone.
    expect((await call(ctx, "run_code", { language: "bash", code: "ls", computer: "Build box" })).isError).toBeFalsy();
    // Allowed or not, Sam's own device never gets ana's agent's Vault keys; its own computer does.
    expect(await secretsMayGo(ctx, w.mac.machineId)).toBe(false);
    const home = (await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id)))[0]?.machineId ?? "";
    expect(await secretsMayGo(ctx, home)).toBe(true);
  });

  test("computer_status lists the devices the agent may use for its person, phones nested, and the ones it may not", async () => {
    const w = await world();
    const ctx = await runCtx();
    const before = await call(ctx, "computer_status", {});
    expect(before.content).toContain("# Devices you may use for ana");
    expect(before.content).toContain('Not shared with ana (using one asks its owner): "Sam\'s MacBook".');
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    const phoneOnly = await call(ctx, "computer_status", {});
    expect(phoneOnly.content).toContain(
      '- "Sam\'s MacBook" (Linux x64; Sam\'s): ready. Only its phones are shared with ana.\n  Phone "Pixel 8" (Android 15): ready.',
    );
    await f.db.update(schema.machines).set({ audienceMode: "everyone" }).where(eq(schema.machines.id, w.mac.machineId));
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    const after = await call(ctx, "computer_status", {});
    expect(after.content).toContain("- \"Sam's MacBook\" (Linux x64; Sam's): ready.");
    expect(after.content).toContain('  Phone "Pixel 8" (Android 15): ready.');
    const one = await call(ctx, "computer_status", { computer: "pixel 8" });
    expect(one.content).toBe('- Phone "Pixel 8" (Android 15): ready, on "Sam\'s MacBook".\nYou may use it for ana.');
  });

  test("computer_status says which switches are off on a shared computer and who turns them on", async () => {
    const w = await world();
    const ctx = await runCtx();
    const machine = eq(schema.machines.id, w.mac.machineId);
    await f.db
      .update(schema.machines)
      .set({
        audienceMode: "everyone",
        os: "darwin",
        execAllowed: false,
        access: { folders: [], tools: { claude: false, codex: false, commands: false } },
        executors: { claude: { version: "2.1.0" } },
      })
      .where(machine);
    const mac = await call(ctx, "computer_status", { computer: "Sam's MacBook" });
    // Codex was never found there: nothing to turn on.
    expect(mac.content).toContain(
      "\n  Off there: shell commands, Claude Code. Only the person at it can turn them on, in the agentes.chat app there (Preferences › Tools).\n",
    );
    await f.db.update(schema.machines).set({ os: "linux" }).where(machine);
    expect((await call(ctx, "computer_status", {})).content).toContain(
      "  Off there: shell commands, Claude Code. Only the person at it can turn them on, with `agentes-runner tools enable commands` and `agentes-runner tools enable claude` there.",
    );
    await f.db
      .update(schema.machines)
      .set({ execAllowed: true, access: { folders: [], tools: { claude: true, codex: false, commands: true } } })
      .where(machine);
    expect((await call(ctx, "computer_status", {})).content).not.toContain("Off there");
  });

  test("a refusal on a person's computer points to that person; on the agent's own, to request_folder_access", async () => {
    const w = await world({
      exec: () => ({ fail: { code: "not_allowed", message: "Grok Build is turned off on this computer" } }),
    });
    const ctx = await runCtx();
    await f.db.update(schema.machines).set({ audienceMode: "everyone" }).where(eq(schema.machines.id, w.mac.machineId));
    const there = await call(ctx, "run_code", { language: "bash", code: "ls", computer: "Sam's MacBook" });
    expect(there.content).toContain(
      "On Sam's MacBook, only the person at it can allow folders or turn tools on: tell them.",
    );
    expect(there.content).not.toContain("request_folder_access");
    const own = await call(ctx, "run_code", { language: "bash", code: "ls", computer: "Build box" });
    expect(own.content).toContain("ask with request_folder_access");
  });
});

describe("phone tools", () => {
  test("a screenshot runs as the run's holder on the host, comes into the conversation, and the model sees it", async () => {
    const w = await world();
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    w.runner.files.set(".agentes/phone/shot.png", PNG);
    w.answer((req) =>
      req.op === "phone.screenshot"
        ? ({ path: ".agentes/phone/shot.png", width: 1080, height: 2400 } satisfies MachineReplies["phone.screenshot"])
        : {},
    );
    const ctx = await runCtx();
    const out = await call(ctx, "phone_screenshot", { phone: "pixel 8" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toStartWith("Took a screenshot of Pixel 8 (1080×2400). It is shown in this conversation");
    expect(out.images?.[0]?.mediaType).toBe("image/png");
    expect(w.asked[0]).toMatchObject({
      op: "phone.screenshot",
      platform: "android",
      serial: "R5CT1234",
      holder: { runId: ctx.runId, agentId: f.agent.id, userId: f.owner.id, label: "Taking a screenshot" },
      agent: { id: f.agent.id, handle: "dev" },
    });
    const told = (await notificationsOf(w.sam.id)).filter((n) => n.kind === "device.in_use");
    expect(told).toHaveLength(1);
    expect(told[0]?.source).toMatchObject({ phoneId: w.phone.id, label: "Pixel 8", runId: ctx.runId });
  });

  test("busy, missing and offline answers name the cause and point at wait_for_device", async () => {
    const w = await world();
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    const ctx = await runCtx();
    await f.db
      .update(schema.machinePhones)
      .set({
        holder: {
          runId: crypto.randomUUID(),
          agentId: f.agent.id,
          userId: w.sam.id,
          label: "testing checkout",
          since: new Date().toISOString(),
        },
      })
      .where(eq(schema.machinePhones.id, w.phone.id));
    w.answer(() => {
      throw new MachineRequestError("phone_busy", "held");
    });
    const busy = await call(ctx, "phone_launch", { phone: "Pixel 8", app: "com.acme.app" });
    expect(busy.content).toStartWith("Pixel 8 is in use by Dev (testing checkout for Sam) since ");
    expect(busy.content).toContain('wait_for_device("Pixel 8")');
    // Sam took control of its screen from the apps: it's Sam's until they give it back.
    await f.db
      .update(schema.machinePhones)
      .set({ holder: { runId: null, agentId: null, userId: w.sam.id, since: new Date().toISOString() } })
      .where(eq(schema.machinePhones.id, w.phone.id));
    const taken = await call(ctx, "phone_launch", { phone: "Pixel 8", app: "com.acme.app" });
    expect(taken.content).toStartWith("Sam took control of Pixel 8, so it's theirs for now. ");
    w.answer(() => {
      throw new MachineRequestError("phone_missing", "gone");
    });
    const missing = await call(ctx, "phone_logs", { phone: "Pixel 8" });
    expect(missing.content).toStartWith("Pixel 8 isn't connected to Sam's MacBook right now (last seen ");
    expect(missing.data).toMatchObject({ code: "device.phone_missing" });
    w.runner.disconnect();
    await Bun.sleep(5);
    await f.db
      .update(schema.machines)
      .set({ online: false, lastSeenAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.machines.id, w.mac.machineId));
    const offline = await call(ctx, "phone_record", { phone: "Pixel 8", seconds: 10 });
    expect(offline.content).toStartWith(
      "Sam's MacBook is offline (last seen 10 min ago), so Pixel 8 on it can't be reached.",
    );
  });

  test("a flow with its recording: the flow is saved, the video comes back, and the run's end lets the phone go", async () => {
    const w = await world();
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    w.runner.files.set(".agentes/phone/run.mp4", new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
    w.answer((req) =>
      req.op === "phone.flow"
        ? ({
            passed: true,
            output: "checkout ✓",
            seconds: 102,
            video: ".agentes/phone/run.mp4",
          } satisfies MachineReplies["phone.flow"])
        : { released: true },
    );
    const ctx = await runCtx();
    const out = await call(ctx, "phone_flow", {
      phone: "Pixel 8",
      flow_yaml: "appId: com.acme.app\n---\n- launchApp",
      record: true,
      save_as: ".maestro/checkout.yaml",
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toStartWith("The flow passed on Pixel 8 (2 min).\nSaved at .maestro/checkout.yaml.");
    expect(out.data).toMatchObject({ passed: true, artifact: expect.objectContaining({ id: expect.any(String) }) });
    expect(new TextDecoder().decode(w.runner.files.get(".maestro/checkout.yaml"))).toContain("launchApp");
    expect(w.asked[0]).toMatchObject({ op: "phone.flow", record: true, timeoutSeconds: 600 });
    // The host reports the run holding it; its end lets it go.
    await f.db
      .update(schema.machinePhones)
      .set({ holder: { runId: ctx.runId, agentId: f.agent.id, userId: f.owner.id, since: new Date().toISOString() } })
      .where(eq(schema.machinePhones.id, w.phone.id));
    expect(
      await releaseRunPhones({ db: f.db, hub: w.hub }, { id: ctx.runId, orgId: f.org.id, agentId: f.agent.id }),
    ).toBe(1);
    expect(w.asked.at(-1)).toMatchObject({ op: "phone.release", serial: "R5CT1234", holder: { runId: ctx.runId } });
  });

  test("a real iPhone whose test helper waits on the person says what to do; a missing app says to install it", async () => {
    const w = await world();
    await f.db.update(schema.machines).set({ audienceMode: "everyone" }).where(eq(schema.machines.id, w.mac.machineId));
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    await f.db.insert(schema.machinePhones).values({
      orgId: f.org.id,
      machineId: w.mac.machineId,
      platform: "ios",
      serial: "00008120-001A",
      name: "Sam's iPhone",
      model: "iPhone 16",
      osVersion: "26.1",
      ownerUserId: w.sam.id,
      followsHost: true,
      state: "needs_you",
      reason: "helper_untrusted",
    });
    w.answer((req) => {
      if (req.op === "phone.launch") throw new MachineRequestError("not_found", "com.acme.app is not installed");
      throw new MachineRequestError("phone_not_ready", "The iPhone doesn't trust the test helper yet.");
    });
    const ctx = await runCtx();
    const shot = await call(ctx, "phone_screenshot", { phone: "iphone 16" });
    expect(shot).toMatchObject({ isError: true, data: { code: "device.phone_not_ready" } });
    expect(shot.content).toStartWith(
      "Sam's iPhone doesn't trust the test helper yet. Ask the person to trust the developer on it: Settings → General → VPN & Device Management. Then ",
    );
    const launch = await call(ctx, "phone_launch", { phone: "Pixel 8", app: "com.acme.app" });
    expect(launch).toMatchObject({ isError: true, data: { code: "device.app_missing" } });
    expect(launch.content).toStartWith("That app isn't installed on Pixel 8: install it first with phone_install.");
  });

  test("a phone stopped by its owner for this run stays stopped", async () => {
    const w = await world();
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    const ctx = await runCtx();
    await f.db
      .update(schema.machinePhones)
      .set({ holder: { runId: ctx.runId, agentId: f.agent.id, userId: f.owner.id, since: new Date().toISOString() } })
      .where(eq(schema.machinePhones.id, w.phone.id));
    w.answer(() => ({ released: true }));
    await stopPhone({ db: f.db, pubsub: f.pubsub, hub: w.hub }, w.sam.id, f.org.id, w.phone.id);
    const out = await call(ctx, "phone_screenshot", { phone: "Pixel 8" });
    expect(out.content).toStartWith("Sam stopped this:");
    expect(w.asked.map((r) => r.op)).toEqual(["phone.release"]);
    // A stop is no request waiting on its owner.
    expect((await f.db.select().from(schema.deviceAccessRequests)).filter((r) => r.status === "pending")).toHaveLength(
      0,
    );
  });
});

describe("waiting for a device", () => {
  /** @dev waits for the Pixel when asked, and says it records once it is back. */
  const waitingReply = (req: ModelRequest) => {
    const last = lastText(req);
    if (last.includes("is back") || last.includes("allowed you")) return { chunks: ["Recording now."] };
    if (last.includes("tool_result")) return { chunks: ["ok"] };
    if (last.includes("pixel"))
      return {
        chunks: [],
        toolUses: [{ name: "wait_for_device", input: { device: "Pixel 8", note: "record checkout" } }],
      };
    return { chunks: ["ok"] };
  };

  const runOf = async (body: string) => {
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
    if (!run) throw new Error("no run");
    return run;
  };
  const cardMessageOf = async () => {
    const rows = await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, f.general.id));
    return rows.find((m) => (m.meta as { deviceWait?: unknown }).deviceWait);
  };
  const cardOf = async () => (await cardMessageOf())?.meta.deviceWait as Record<string, unknown>;

  test("an unplugged phone parks the run with a card; it goes on by itself once the host reports it free", async () => {
    const w = await world({ reply: waitingReply as never });
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone", state: "offline" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    const events = f.listen(f.general.id);
    const run = await runOf("@dev record the pixel");
    expect(run.status).toBe("waiting_input");
    const card = await cardOf();
    expect(card).toMatchObject({
      runId: run.id,
      reason: "missing",
      state: "waiting",
      requesterUserId: f.owner.id,
      note: "record checkout",
      device: {
        kind: "phone",
        id: w.phone.id,
        name: "Pixel 8",
        platform: "android",
        hostName: "Sam's MacBook",
        ownerUserId: w.sam.id,
      },
      deviceName: "Pixel 8",
      hostName: "Sam's MacBook",
    });
    expect(Date.parse(String(card.until)) - Date.parse(String(card.since))).toBe(24 * 3600_000);
    // The card's words, in the language of whom the agent works for.
    expect((await cardMessageOf())?.body).toBe(
      "Sam's MacBook não está vendo Pixel 8 agora. Começo quando ele for conectado de novo.",
    );
    // Sam's device is what someone else's agent waits on: Sam hears it.
    expect((await notificationsOf(w.sam.id)).map((n) => n.kind)).toContain("device.waiting");
    // The give-up job is queued for the day after.
    const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "device.wait_expired"));
    expect(job?.payload).toMatchObject({ runId: run.id, waitId: card.waitId });
    // A person's message takes the run on: the wait doesn't hold it.
    const [held] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    if (!held) throw new Error("no run");
    expect(await holdsMessages(f.db, held, f.owner.id)).toBe(false);
    expect((await currentWaits(f.db, held)).map((x: { kind: string }) => x.kind)).toEqual(["device"]);

    // A report with the phone still busy wakes nobody; once ready and free (or given back to this run by a person
    // who took control of it), the run goes on.
    expect(
      await resumePhoneWaits({ db: f.db }, { id: w.mac.machineId, orgId: f.org.id }, [
        { ...w.phone, state: "ready", holder: { runId: "x", agentId: null, userId: null, since: "" } },
      ]),
    ).toEqual([]);
    expect(await resumeComputerWaits({ db: f.db }, w.mac.machineId)).toEqual([]);
    expect(
      await resumePhoneWaits({ db: f.db, pubsub: f.pubsub }, { id: w.mac.machineId, orgId: f.org.id }, [
        { ...w.phone, state: "ready", holder: { runId: run.id, agentId: null, userId: null, since: "" } },
      ]),
    ).toEqual([run.id]);
    await drainOutbox(f.db, f.handlers);
    const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(done?.status).toBe("done");
    expect((await cardOf()).state).toBe("back");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "device_wait.updated", deviceWait: expect.objectContaining({ state: "back" }) }),
    );
    const waiting = (await notificationsOf(w.sam.id)).find((n) => n.kind === "device.waiting");
    expect(waiting?.doneAt).not.toBeNull();
    // It ended: the day-after job finds nothing to end.
    expect(await expireDeviceWait({ db: f.db }, run.id, String(card.waitId))).toBe(false);
  });

  test("the card's line reads in English for a person with no language", async () => {
    const w = await world({ reply: waitingReply as never });
    await f.db.update(schema.users).set({ locale: null }).where(eq(schema.users.id, f.owner.id));
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone", state: "offline" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    expect((await runOf("@dev record the pixel")).status).toBe("waiting_input");
    expect((await cardMessageOf())?.body).toBe(
      "Sam's MacBook doesn't see Pixel 8 right now. I'll start when it's plugged back in.",
    );
  });

  test("a person's message moves the run on; Stop waiting and the day's end each end a wait, by who may", async () => {
    const w = await world({ reply: waitingReply as never });
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone", state: "offline" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    const first = await runOf("@dev record the pixel");
    const [row] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, first.id));
    if (!row) throw new Error("no run");
    const posted = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "use the emulator instead",
    });
    const message = await getMessage(f.db, f.org.id, posted.id);
    if (!message) throw new Error("no message");
    expect(await onMessageWhileWaiting({ db: f.db, pubsub: f.pubsub }, row, message)).toEqual({
      waitKind: "device",
      outcome: "woke",
    });
    expect((await cardOf()).state).toBe("moved_on");
    await drainOutbox(f.db, f.handlers);

    const second = await runOf("@dev record the pixel again");
    expect(second.status).toBe("waiting_input");
    const stranger = await addMember(f.db, f.org.id, "member", "Rui Tanaka");
    await expect(deviceWaitAction({ db: f.db }, stranger.id, f.org.id, second.id, "stop")).rejects.toThrow(
      ForbiddenError,
    );
    expect(await deviceWaitAction({ db: f.db }, f.owner.id, f.org.id, second.id, "stop")).toEqual({ resumed: true });
    const [stopped] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, second.id));
    const calls = (stopped?.transcript as { pending?: { calls: { result?: { content: string } }[] } } | undefined)
      ?.pending?.calls;
    expect(calls?.[0]?.result?.content).toStartWith("ana stopped the wait for Pixel 8.");
    await drainOutbox(f.db, f.handlers);

    const third = await runOf("@dev record the pixel once more");
    const waitId = String(
      (
        await f.db
          .select()
          .from(schema.messages)
          .where(and(eq(schema.messages.channelId, f.general.id)))
      )
        .map((m) => m.meta.deviceWait as { runId?: string; waitId?: string } | undefined)
        .find((c) => c?.runId === third.id)?.waitId,
    );
    expect(await expireDeviceWait({ db: f.db }, third.id, waitId)).toBe(true);
    const [gave] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, third.id));
    const gaveCalls = (gave?.transcript as { pending?: { calls: { result?: { content: string } }[] } } | undefined)
      ?.pending?.calls;
    expect(gaveCalls?.[0]?.result?.content).toStartWith("Pixel 8 hasn't been back for a day, so you stopped waiting.");
  });

  test("a device that leaves with its owner ends the waits on it, and the agent says so", async () => {
    const w = await world({ reply: waitingReply as never });
    await f.db
      .update(schema.machinePhones)
      .set({ audienceMode: "everyone", state: "offline" })
      .where(eq(schema.machinePhones.id, w.phone.id));
    const run = await runOf("@dev record the pixel");
    expect(run.status).toBe("waiting_input");
    await removeMember(f.db, f.owner.id, f.org.id, w.sam.id, { pubsub: f.pubsub });
    const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    const calls = (after?.transcript as { pending?: { calls: { result?: { content: string } }[] } } | undefined)
      ?.pending?.calls;
    expect(calls?.[0]?.result?.content).toStartWith(
      "Pixel 8 left the workspace with Sam, so you stopped waiting for it.",
    );
    expect((await cardOf()).state).toBe("left");
  });

  test("a phone only its owner may use: waiting asks them, and their Always lets the agent go on", async () => {
    const w = await world({ reply: waitingReply as never });
    const run = await runOf("@dev record the pixel");
    expect(run.status).toBe("waiting_input");
    expect((await cardOf()).reason).toBe("asked");
    const [request] = await f.db.select().from(schema.deviceAccessRequests);
    expect(request).toMatchObject({ requesterUserId: f.owner.id, phoneId: w.phone.id, runId: run.id });
    // The phone being free answers nothing: the wait is for its owner.
    expect(
      await resumePhoneWaits({ db: f.db }, { id: w.mac.machineId, orgId: f.org.id }, [{ ...w.phone, holder: null }]),
    ).toEqual([]);
    expect((await notificationsOf(w.sam.id)).map((n) => n.kind)).toEqual(["device.access_request"]);
    const decided = await decideDeviceAccess({ db: f.db }, w.sam.id, f.org.id, request?.id ?? "", "always");
    expect(await afterDeviceAccessDecided({ db: f.db }, f.org.id, decided, "Sam")).toBe(true);
    const [phone] = await f.db.select().from(schema.machinePhones).where(eq(schema.machinePhones.id, w.phone.id));
    expect(phone).toMatchObject({ audienceMode: "people", audienceUserIds: [f.owner.id] });
    await drainOutbox(f.db, f.handlers);
    const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(done?.status).toBe("done");
    expect((await cardOf()).state).toBe("allowed");
  });
});

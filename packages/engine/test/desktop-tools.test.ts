import { afterEach, describe, expect, test } from "bun:test";
import { DESKTOP_USE_PROTOCOL, type MachineRequest } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  ARTIFACT_LIMITS,
  absorbToolData,
  agentDesktopUseStatus,
  createDesktopToolSource,
  createFakeJudge,
  DESKTOP_SCOPE,
  describeCapabilities,
  finishHandoff,
  grantScopes,
  type Judge,
  type MachineCaller,
  MachineOfflineError,
  MachineRequestError,
  type MachineStatus,
  type RunAuthority,
  SANDBOX_SCOPE,
  startTakeover,
  type ToolDefinition,
  type ToolSideEffects,
  toolDenyScope,
  toolPolicy,
  updateSandboxSettings,
} from "../src";
import { pickApp } from "../src/desktop/surface";
import { APPS, fakeHub, lookOf } from "./desktop-fixtures";
import { type Fixture, setup } from "./fixtures";
import { pairMachine, pushFromFolder } from "./machine-fixtures";
import { runContext } from "./mail-fixtures";
import { THUNAR } from "./screen-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as never;
});

const TOOLS = ["desktop_do", "desktop_read", "desktop_screenshot"];

async function desktopSetup(options: { judge?: Judge } = {}) {
  const holder: { hub?: MachineCaller } = {};
  const source = createDesktopToolSource({
    machines: {
      hub: {
        status: (id) => (holder.hub as MachineCaller).status(id),
        call: (id, request, o) => (holder.hub as MachineCaller).call(id, request, o),
        wake: (id, why) => (holder.hub as MachineCaller).wake?.(id, why) ?? Promise.resolve(),
      },
    },
    ...(options.judge ? { judge: options.judge } : {}),
    publicUrl: "http://localhost:3000",
  });
  f = await setup({ toolSources: [source] });
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Box" });
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
  const fake = fakeHub({ machineId: paired.machineId, orgId: f.org.id });
  holder.hub = fake.hub;
  const ctx = await runContext(f);
  const tools = f.tools as NonNullable<Fixture["tools"]>;
  const listed = async () => (await tools.list(ctx)).filter((t) => t.name.startsWith("desktop_"));
  const names = async () => (await listed()).map((t) => t.name).sort();
  const call = async (name: string, input: Record<string, unknown>) => {
    const r = await tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
    if (r.type !== "result") throw new Error("expected a result");
    return r.output;
  };
  /** The requests sent from now on. */
  const since = () => {
    const n = fake.calls.length;
    return () => fake.calls.slice(n);
  };
  const grant = (...scopes: string[]) =>
    grantScopes(
      f.db,
      f.org.id,
      f.agent.id,
      scopes.map((scope) => ({ connectionId: null, scope })),
    );
  return { ...fake, machineId: paired.machineId, source, ctx, listed, names, call, since, grant };
}

const acts = (calls: MachineRequest[]) =>
  calls.flatMap((c) => (c.op === "desktop.act" ? [{ action: c.action, settle: c.settle }] : []));

test("offered only with desktop:use and Run code, the org's code on, and a computer that serves desktop use", async () => {
  const d = await desktopSetup();
  expect(await d.names()).toEqual([]);
  await d.grant(DESKTOP_SCOPE);
  // Driving a desktop runs commands: not without Run code.
  expect(await d.names()).toEqual([]);
  await d.grant(SANDBOX_SCOPE);
  expect(await d.names()).toEqual(TOOLS);
  expect((await d.listed()).every((t) => !t.sensitive)).toBe(true);

  await d.grant(toolDenyScope("run_code"));
  expect(await d.names()).toEqual([]);
  await f.db
    .delete(schema.agentScopes)
    .where(and(eq(schema.agentScopes.agentId, f.agent.id), eq(schema.agentScopes.scope, toolDenyScope("run_code"))));
  await updateSandboxSettings(f.db, f.owner.id, f.org.id, { enabled: false });
  expect(await d.names()).toEqual([]);
  // Where every command asks a person first, so does each plan on the desktop.
  await updateSandboxSettings(f.db, f.owner.id, f.org.id, { enabled: true, requireApproval: true });
  const listed = await d.listed();
  expect(listed.find((t) => t.name === "desktop_do")?.sensitive).toBe(true);
  expect(listed.filter((t) => t.sensitive).map((t) => t.name)).toEqual(["desktop_do"]);

  const status = () => agentDesktopUseStatus(f.db, d.hub, f.org.id, f.agent.id);
  const access = (tools: Record<string, boolean>) => ({
    access: { folders: [], tools: { claude: false, codex: false, commands: true, desktop: true, ...tools } },
  });
  for (const [patch, code] of [
    [{ protocol: DESKTOP_USE_PROTOCOL - 1 }, "outdated"],
    [access({ desktop: false }), "switched_off"],
    [access({ commands: false }), "commands_off"],
    [{ executors: { desktop: { available: true } } }, "not_reported"],
  ] as const) {
    d.s.status = patch as Partial<MachineStatus>;
    expect(await d.names()).toEqual([]);
    expect(await status()).toMatchObject({ available: false, code });
  }
  d.s.status = { executors: { desktopUse: { available: false, reason: "Install python3-gi" } } };
  expect(await status()).toMatchObject({ code: "not_ready", detail: "Install python3-gi" });
  expect(await d.names()).toEqual([]);
  // An offline computer still offers them: the call says it's offline.
  d.s.status = { online: false };
  expect(await d.names()).toEqual(TOOLS);
  await f.db.update(schema.agents).set({ machineId: null }).where(eq(schema.agents.id, f.agent.id));
  expect(await d.names()).toEqual([]);
  expect(await status()).toMatchObject({ code: "no_machine" });
});

test("allowed on each call: a tool listed before the agent lost Run code refuses, and nothing reaches the computer", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  const read = (await d.source.tools(d.ctx)).find((t) => t.name === "desktop_read") as ToolDefinition;
  await f.db
    .delete(schema.agentScopes)
    .where(and(eq(schema.agentScopes.agentId, f.agent.id), eq(schema.agentScopes.scope, SANDBOX_SCOPE)));
  const sent = d.since();
  const out = await read.execute({}, d.ctx);
  expect(out.isError).toBe(true);
  expect(out.content).toContain("you may not run code");
  expect(sent()).toEqual([]);
});

test("a plan of three steps: an app by its name, a target by name, typing; each one desktop.act, settled", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  const sent = d.since();
  const out = await d.call("desktop_do", {
    steps: [
      { do: "open", app: "Files" },
      { do: "double_click", target: "Documents" },
      { do: "type", target: "Location", text: "/home/agent/Documents\n" },
    ],
  });
  expect(out.isError).toBeUndefined();
  expect(sent().map((c) => c.op)).toEqual(["desktop.apps", "desktop.act", "desktop.act", "desktop.act"]);
  expect(acts(sent())).toEqual([
    { action: { kind: "launch", app: "thunar.desktop" }, settle: true },
    { action: { kind: "double_click", at: { ref: "e32" } }, settle: true },
    { action: { kind: "type", text: "/home/agent/Documents\n", at: { ref: "e29" } }, settle: true },
  ]);
  expect(sent()[1]).toMatchObject({ agent: { id: f.agent.id, handle: "dev" } });
  expect(out.content).toContain("Done: all 3 steps.");
  // Screen text (window titles included) only inside the untrusted block.
  const [summary, screen] = out.content.split('<external_data source="desktop screen">');
  expect(summary).not.toContain("Files - Thunar");
  expect(screen).toContain("Now in desktop://thunar/main — Files - Thunar");
  expect(out.data?.desktopTrail).toEqual([
    { tool: "desktop_open", detail: "Files" },
    { tool: "desktop_double_click" },
    { tool: "desktop_type" },
  ]);
});

test("desktop_do takes the field a model guesses: `value` on a fill, `text` on a select", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  const sent = d.since();
  const out = await d.call("desktop_do", {
    steps: [
      { do: "fill", target: "e29", value: "/home/agent" },
      { do: "select", target: "e29", text: "Documents" },
    ],
  });
  expect(out.isError).toBeUndefined();
  expect(acts(sent()).map((a) => a.action)).toEqual([
    { kind: "fill", at: { ref: "e29" }, text: "/home/agent" },
    { kind: "select", at: { ref: "e29" }, value: "Documents" },
  ]);
});

test("words the screen doesn't name exactly go to the judge's Choice", async () => {
  const judge = createFakeJudge((kind, id, state) => {
    if (kind !== "screen_target") return undefined;
    if (id === "present") return 0.9;
    return state.target === "the PDF" ? { choice: "e31", probabilities: { e31: 0.9 } } : "none";
  });
  const d = await desktopSetup({ judge });
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  const sent = d.since();
  const out = await d.call("desktop_do", { steps: [{ do: "right_click", target: "the PDF" }] });
  expect(out.isError).toBeUndefined();
  expect(sent().map((c) => c.op)).toEqual(["desktop.look", "desktop.act"]);
  expect(acts(sent())).toEqual([{ action: { kind: "right_click", at: { ref: "e31" } }, settle: true }]);
  expect(judge.calls[0]).toMatchObject({ kind: "screen_target", orgId: f.org.id, agentId: f.agent.id });
});

describe("open", () => {
  test("an app by its exact name or entry, else its kind, else the closest by words; a tie or nothing lists them", () => {
    expect(pickApp("Mousepad", APPS)).toEqual({ id: "org.xfce.mousepad.desktop" });
    expect(pickApp("xfce4-terminal", APPS)).toEqual({ id: "xfce4-terminal.desktop" });
    expect(pickApp("the File Manager", APPS)).toEqual({ id: "thunar.desktop" });
    expect(pickApp("Files", APPS)).toEqual({ id: "thunar.desktop" });
    expect(pickApp("terminal app", APPS)).toEqual({ id: "xfce4-terminal.desktop" });
    expect(pickApp("Text Editor", APPS)).toEqual({
      error: '"Text Editor" could be "Mousepad", "gedit": name one as written',
    });
    expect(pickApp("Photoshop", APPS)).toEqual({
      error:
        'there is no app called "Photoshop" here; the apps: "Thunar File Manager", "Xfce Terminal", "Mousepad", "gedit"',
    });
  });

  test("a web address goes to the browser: nothing runs; an app nobody has stops with the list", async () => {
    const d = await desktopSetup();
    await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
    const sent = d.since();
    for (const step of [
      { do: "open", url: "https://shop.example/" },
      { do: "open", target: "https://shop.example/" },
    ]) {
      const out = await d.call("desktop_do", { steps: [{ do: "click", target: "e25" }, step] });
      expect(out.isError).toBe(true);
      expect(out.content).toContain("use browser_do");
    }
    expect(sent()).toEqual([]);
    const out = await d.call("desktop_do", { steps: [{ do: "open", app: "Photoshop" }] });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('there is no app called "Photoshop" here');
    expect(acts(sent())).toEqual([]);
  });
});

test("desktop_read: the screen as untrusted text; desktop_screenshot: a JPEG written into the agent's folder", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  const read = await d.call("desktop_read", {});
  expect(read.isError).toBeUndefined();
  expect(read.content.startsWith('<external_data source="desktop screen">')).toBe(true);
  expect(read.content).toContain('- listitem "Documents" [ref=e32]');

  let sent = d.since();
  const shot = await d.call("desktop_screenshot", { path: "shots/a.png" });
  expect(shot.content).toContain("Saved shots/a.jpg in your folder");
  expect(sent()).toMatchObject([
    { op: "desktop.capture", agent: { id: f.agent.id } },
    { op: "write", path: "shots/a.jpg", base64: "JPEG", agent: { id: f.agent.id } },
  ]);
  sent = d.since();
  expect((await d.call("desktop_screenshot", { path: "../secrets.jpg" })).isError).toBe(true);
  expect((await d.call("desktop_screenshot", { path: "/home/agent/a.jpg" })).isError).toBe(true);
  expect(sent()).toEqual([]);
  const defaulted = await d.call("desktop_screenshot", {});
  expect(defaulted.data?.path).toMatch(/^screenshots\/.+\.jpg$/);
});

test("desktop_screenshot with share: sent to the Drive and attached to the reply as upload_file does", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  // The agent's folder on the computer: the screenshot is written there and pushed from there.
  const folder = new Map<string, Uint8Array>();
  d.s.respond = (r) => {
    if (r.op === "write") folder.set(r.path, new Uint8Array(Buffer.from(r.base64, "base64")));
    if (r.op === "push") return pushFromFolder(f, d.machineId, folder, r);
    return undefined;
  };
  const kept = await d.call("desktop_screenshot", { path: "shots/kept.jpg" });
  expect(kept.content).toBe(
    "Saved shots/kept.jpg in your folder: the whole screen as a JPEG (1280×800). You can't see pictures from here: desktop_read tells what the screen says. To show a screenshot in this conversation, take it with share: true.",
  );
  // A computer brain (through the bridge) opens it with its own Read.
  const bridged = { ...d.ctx, bridge: { machineId: d.machineId } };
  const shotTool = (await d.source.tools(bridged)).find((t) => t.name === "desktop_screenshot");
  const own = await shotTool?.execute({ path: "shots/own.jpg" }, bridged);
  expect(own?.content).toStartWith(
    "Saved shots/own.jpg in your folder: the whole screen as a JPEG (1280×800). Open it with your own Read tool to look at it.",
  );

  const sent = d.since();
  const out = await d.call("desktop_screenshot", { path: "shots/a.png", share: true });
  expect(out.isError).toBeUndefined();
  const [a] = await f.db.select().from(schema.artifacts);
  expect(a).toMatchObject({ kind: "file", title: "a.jpg", channelId: f.general.id });
  expect(out.data).toEqual({ path: "shots/a.jpg", artifact: { id: a?.id, version: 1, title: "a.jpg" } });
  const reply: ToolSideEffects = {};
  absorbToolData(reply, out.data);
  expect(reply.artifacts).toEqual([{ id: a?.id as string, version: 1, title: "a.jpg" }]);
  expect(out.content).toContain(
    `It is shown in this conversation: its card goes with your reply ("a.jpg" in the Drive`,
  );
  const [up] = await f.db.select().from(schema.artifactUploads);
  expect(up).toMatchObject({
    status: "done",
    path: "shots/a.jpg",
    runId: d.ctx.runId,
    computer: `machine:${d.machineId}`,
  });
  // Pushed by the computer itself, for the same agent (so from the same folder) the screenshot was written in.
  const [capture, write, push] = sent();
  expect(capture?.op).toBe("desktop.capture");
  expect(write).toMatchObject({ op: "write", path: "shots/a.jpg" });
  expect(push).toEqual({
    op: "push",
    agent: write?.agent as MachineRequest["agent"],
    path: "shots/a.jpg",
    url: `http://localhost:3000/api/machines/uploads/${up?.id}`,
    uploadId: up?.id as string,
    maxBytes: ARTIFACT_LIMITS.fileBytes,
  });
});

test("desktop_screenshot with share but without Write files: saved, and the answer says how to ask for it", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  await f.db
    .delete(schema.agentScopes)
    .where(and(eq(schema.agentScopes.agentId, f.agent.id), eq(schema.agentScopes.scope, "drive:write")));
  const sent = d.since();
  const out = await d.call("desktop_screenshot", { path: "shots/b.jpg", share: true });
  expect(out.isError).toBeUndefined();
  expect(out.content).toBe(
    `Saved shots/b.jpg in your folder: the whole screen as a JPEG (1280×800). You can't see pictures from here: desktop_read tells what the screen says. It isn't shown in this conversation: that needs "Write files" (drive:write), which you don't have. Ask for it with request_permission, then take it again with share: true.`,
  );
  expect(out.data).toEqual({ path: "shots/b.jpg" });
  expect(sent().map((c) => c.op)).toEqual(["desktop.capture", "write"]);
  expect(await f.db.select().from(schema.artifactUploads)).toEqual([]);
});

test("the computer's refusals in the agent's words", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  d.s.error = new MachineRequestError("not_allowed", "desktop is off");
  expect((await d.call("desktop_read", {})).content).toContain("turned off on the computer Box");
  d.s.error = new MachineRequestError("desktop_unavailable", "The agent's desktop stopped. Try again.");
  const plan = await d.call("desktop_do", { steps: [{ do: "press", key: "ctrl+s" }] });
  expect(plan.isError).toBe(true);
  expect(plan.content).toContain("Your desktop isn't available on the computer Box: The agent's desktop stopped");
  d.s.error = null;
  // A step's own failure stays in the runner's words (the plan reads them).
  d.s.respond = (r) => {
    if (r.op === "desktop.act") throw new MachineRequestError("bad_request", "covered by window e40");
    return undefined;
  };
  const sent = d.since();
  const covered = await d.call("desktop_do", { steps: [{ do: "click", target: "e25" }] });
  expect(covered.content).toContain("covered by window e40: nothing was done");
  // It looks again, so the answer shows what covers the target, as untrusted screen text.
  expect(sent().map((c) => c.op)).toEqual(["desktop.act", "desktop.look"]);
  expect(covered.content).toContain('<external_data source="desktop screen">');
});

test("its computer asleep in standby: the desktop asks it to wake and waits, as the browser and the sandbox do", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  const slept = new Date(Date.now() - 6 * 3600_000).toISOString();
  d.s.status = { online: false, standby: true, kind: "managed", lastSeenAt: slept };
  const woke: string[] = [];
  d.hub.wake = async (_id, why) => {
    woke.push(why);
    d.s.status = { online: true };
  };
  // Sent while it sleeps, a request never leaves: nothing there takes it.
  d.s.respond = () => {
    if (d.s.status.online === false) throw new MachineOfflineError("Box", "managed");
    return undefined;
  };
  const sent = d.since();
  const read = await d.call("desktop_read", {});
  expect(read.isError).toBeFalsy();
  expect(read.content).toContain('<external_data source="desktop screen">');
  expect(woke).toEqual(["run"]);
  expect(sent().map((c) => c.op)).toEqual(["desktop.look", "desktop.look"]);
});

test("a person in control holds the desktop; after they hand it back, the agent reads it before acting", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  const held = await startTakeover({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id, null, "desktop");
  const sent = d.since();
  const waiting = await d.call("desktop_do", { steps: [{ do: "click", target: "e25" }] });
  expect(waiting.content).toContain("A person has control of your desktop");
  expect(waiting.data?.pause).toEqual({ kind: "input", id: held.id });
  expect(sent()).toEqual([]);

  await finishHandoff({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, held.id, { result: "done" });
  const stale = await d.call("desktop_do", { steps: [{ do: "click", target: "e25" }] });
  expect(stale.isError).toBe(true);
  expect(stale.content).toContain("Read the screen again first (a person changed it): call desktop_read");
  // Opening an app first doesn't rely on what the agent saw.
  expect((await d.call("desktop_do", { steps: [{ do: "open", app: "Mousepad" }] })).isError).toBeUndefined();
  expect((await d.call("desktop_read", {})).isError).toBeUndefined();
  expect((await d.call("desktop_do", { steps: [{ do: "click", target: "e25" }] })).isError).toBeUndefined();
});

test("a plan that stops with the agent's browser on the screen says its window is browser_do's", async () => {
  const d = await desktopSetup();
  await d.grant(DESKTOP_SCOPE, SANDBOX_SCOPE);
  d.s.look = lookOf(`${THUNAR}\n- window "Shop - Chromium" [agent browser: use browser_do]`, "Shop - Chromium");
  const out = await d.call("desktop_do", { steps: [{ do: "click", target: "the Buy now button" }] });
  expect(out.isError).toBe(true);
  expect(out.content).toContain("Your browser's window is on this screen: what is in it is for browser_do");
  expect(acts(d.calls)).toEqual([]);
});

test("routines that only read can't use the desktop, a run nobody is behind can; the prompt says how to", () => {
  const brief = (access: "read" | "act") => ({
    routineId: "00000000-0000-4000-8000-000000000001",
    routineRunId: "00000000-0000-4000-8000-000000000002",
    name: "Conferir o painel",
    creatorUserId: "user_creator",
    deliverTo: { channelId: "00000000-0000-4000-8000-000000000003", threadId: null },
    access,
    report: "when_new" as const,
    trigger: "schedule" as const,
    dueAt: new Date().toISOString(),
  });
  const routine = (access: "read" | "act"): RunAuthority => ({ kind: "routine", personId: null, brief: brief(access) });
  const unattended: RunAuthority = { kind: "unattended", personId: null, reason: "agent" };
  for (const name of TOOLS) {
    const tool = { name, scope: DESKTOP_SCOPE, connectionId: null };
    expect(toolPolicy(routine("read"), tool).action).toBe("allow");
    expect(toolPolicy(unattended, tool).action).toBe("allow");
    expect(toolPolicy(routine("act"), tool).action).toBe("allow");
  }
  const prompt = describeCapabilities(TOOLS.map((name) => ({ name, description: "", scope: DESKTOP_SCOPE })));
  expect(prompt).toContain("- Desktop: `desktop_do`, `desktop_read`, `desktop_screenshot`");
  expect(prompt).toContain("Web pages go to your browser (`browser_do`)");
});

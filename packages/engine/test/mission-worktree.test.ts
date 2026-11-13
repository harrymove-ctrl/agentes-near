import { afterEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  afterMissionRunEnded,
  closeMission,
  createMission,
  createMissionRunToolSource,
  drainOutbox,
  getMission,
  type MachineHub,
  missionBranchPrefix,
  missionTurnFor,
  missionTurnPermissions,
  missionWorktreePath,
  onlyReadsWhileWriting,
  resumeMission,
  retryMissionWorktree,
  START_PROMPT,
  setMissionMachine,
  startMission,
} from "../src";
import { deliverNotice } from "../src/delivery";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { ownerWrites, pairedMachine, RUNNER } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

type Request = Extract<ServerFrame, { type: "request" }>;
type TaskStart = Extract<Request, { op: "task.start" }>;
type Worktree = Extract<Request, { op: "mission.worktree" }> & { baseSha?: string; deleteBranch?: boolean };

const BASE = "0123456789abcdef0123456789abcdef01234567";

/** How the fake runner answers `mission.worktree ensure` (ADR 0044). */
interface EnsurePlan {
  error?: { code: string; message: string };
  created?: boolean;
  setupCommand?: string | null;
}

/** A runner on the hub that keeps its requests and answers worktree and task calls as told. */
function runner(hub: MachineHub) {
  const started: TaskStart[] = [];
  const worktree: Worktree[] = [];
  const acks: string[] = [];
  const state = {
    ensure: [] as EnsurePlan[],
    noSlot: false,
    baseBehind: undefined as number | undefined,
  };
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type === "task.ack") acks.push(frame.taskId);
      if (frame.type !== "request") return;
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        const fail = (code: string, message: string) =>
          void reply({ type: "result", id: frame.id, ok: false, error: { code, message } });
        if (frame.op === "mission.worktree") {
          worktree.push(frame);
          if (frame.action === "remove") return ok({ removed: true });
          const plan = state.ensure.shift() ?? {};
          if (plan.error) return fail(plan.error.code, plan.error.message);
          return ok({
            path: frame.path,
            branch: frame.branch,
            baseBranch: "main",
            baseSha: frame.baseSha ?? BASE,
            created: plan.created ?? !frame.baseSha,
            dirty: false,
            setupCommand: plan.setupCommand === undefined ? null : plan.setupCommand,
            copied: [".env"],
          });
        }
        if (frame.op === "task.start") {
          if (state.noSlot) return fail("no_slot", "all 3 task slots are busy");
          started.push(frame);
          return ok({
            taskId: frame.taskId,
            pid: 100 + started.length,
            startedAt: new Date().toISOString(),
            cwd: frame.cwd ?? "",
            command: frame.command ?? "claude -p",
            ...(state.baseBehind !== undefined && frame.baseCheck ? { baseBehind: state.baseBehind } : {}),
          });
        }
        if (frame.op === "task.cancel") return ok({ canceled: true });
        if (frame.op === "read") return ok({ base64: null, size: 0 });
        if (frame.op === "write") return ok({ size: 1 });
        return ok({});
      }, 1);
    },
    close() {
      void hub.close(conn);
    },
  };
  let conn = hub.open(socket);
  return {
    started,
    worktree,
    acks,
    state,
    hello: (token: string) => hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true })),
    /** The socket closes and a new one says hello (the computer came back). */
    async reconnect(token: string) {
      await hub.close(conn);
      conn = hub.open(socket);
      await hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true }));
    },
    done: (taskId: string, extra: Record<string, unknown> = {}) =>
      reply({ type: "task.done", taskId, exitCode: 0, seconds: 30, ...extra }),
  };
}

const missionRow = async () => (await f.db.select().from(schema.missions))[0] as typeof schema.missions.$inferSelect;
const taskRow = async (id: string) =>
  (await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, id)))[0];
/** What the mission told its main session (`meta.missionInbox` notices, plus item ends). */
const told = async () =>
  (
    await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, (await missionRow()).threadRootId))
  )
    .map((m) => (m.meta.missionInbox as { text?: string } | undefined)?.text ?? "")
    .filter(Boolean);
/** Waits for the hub's async online hooks (they run after `hello`). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
};

async function started(ensure: EnsurePlan[] = [], options: { start?: boolean } = {}) {
  f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
  const paired = await pairedMachine(f);
  const r = runner(f.machineHub as MachineHub);
  await r.hello(paired.token);
  const view = await createMission(f.missionDeps, f.owner.id, f.org.id, {
    agentId: f.agent.id,
    channelId: f.general.id,
    goal: "Build our mobile app",
    title: "Mobile app",
    repoDir: "app",
  });
  await drainOutbox(f.db, f.handlers);
  r.state.ensure.push(...ensure);
  if (options.start !== false) await startMission(f.missionDeps, f.owner.id, f.org.id, view.id);
  return { view, r, paired };
}

/** A turn of the main session (its run in the home thread) ends: write items queued behind it may start. */
async function endTurn(runId: string) {
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done", finishedAt: new Date() })
    .where(eq(schema.agentRuns.id, runId));
  await afterMissionRunEnded(f.missionDeps, runId);
}

/**
 * The main session (a computer brain's run in the home thread) calls
 * `start_task`; its turn then ends (unless `keepTurn`: the caller ends it).
 */
async function startTask(args: Record<string, unknown>, options: { keepTurn?: boolean } = {}) {
  const out = await startTaskInTurn(args);
  if (!options.keepTurn) await endTurn(out.runId);
  return out;
}

async function startTaskInTurn(args: Record<string, unknown>) {
  const mission = await missionRow();
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: mission.channelId,
      threadRootId: mission.threadRootId,
      triggerMessageId: await ownerWrites(f, mission),
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  const ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run?.id as string,
    channelId: mission.channelId,
    threadRootId: mission.threadRootId,
    triggerMessageId: run?.triggerMessageId as string,
    bridge: { machineId: mission.machineId as string },
  };
  const { db: _db, ...deps } = f.missionDeps;
  const tool = (await createMissionRunToolSource(deps).tools(ctx)).find((t) => t.name === "start_task");
  if (!tool) throw new Error("no start_task");
  const out = await tool.execute(args, ctx);
  return { ...out, content: String(out.content), runId: run?.id as string };
}

const taskIdOf = (text: string) => text.match(/task ([0-9a-f-]{36})/)?.[1] as string;

describe("one worktree per mission (ADR 0044)", () => {
  test("Start makes the copy, setup runs first, then the main session wakes there", async () => {
    const { view, r } = await started([{ created: true, setupCommand: "bun install" }]);
    const path = missionWorktreePath(view.id);
    const branch = `${missionBranchPrefix(view.id)}mobile-app`;
    expect(r.worktree[0]).toMatchObject({ action: "ensure", repo: "app", path, branch });
    expect(r.worktree[0]?.baseSha).toBeUndefined();
    let mission = await missionRow();
    expect(mission).toMatchObject({ worktreeState: "preparing", branch, baseBranch: "main", baseSha: BASE });
    const setupTask = r.started[0] as TaskStart;
    expect(setupTask).toMatchObject({ executor: "shell", command: "bun install", cwd: path, maxSeconds: 600 });
    expect(setupTask.mission).toBeUndefined();
    expect((await taskRow(setupTask.taskId))?.mode).toBe("setup");
    // The start prompt waits for the folder.
    expect((await told()).some((t) => t.startsWith(START_PROMPT))).toBe(false);
    expect(mission.inbox.some((e) => e.text.startsWith(START_PROMPT))).toBe(true);
    // A write item can't start in a folder being prepared.
    expect(await startTask({ title: "Tabs", prompt: "Build the tabs" })).toMatchObject({
      isError: true,
      data: { code: "mission.not_ready" },
    });

    await r.done(setupTask.taskId);
    await drainOutbox(f.db, f.handlers);
    mission = await missionRow();
    expect(mission.worktreeState).toBe("ready");
    expect(mission.worktreePath).toBe(path);
    expect((await told()).some((t) => t.startsWith(START_PROMPT))).toBe(true);
    // The main session's brain works in the mission's folder now.
    const turn = await missionTurnFor(f.db, {
      orgId: f.org.id,
      agentId: f.agent.id,
      threadRootId: mission.threadRootId,
      triggerMessageId: crypto.randomUUID(),
    });
    expect(turn?.session?.cwd).toBe(path);
    const v = await getMission(f.missionDeps, f.owner.id, f.org.id, view.id);
    expect(v).toMatchObject({ branch, baseBranch: "main", baseSha: BASE, worktreeState: "ready", worktreeError: null });
  });

  test("a failed setup pauses the mission with a card; Tentar de novo prepares again and resumes", async () => {
    const { view, r } = await started([{ created: true, setupCommand: "bun install" }]);
    const setupTask = r.started[0] as TaskStart;
    await r.done(setupTask.taskId, { exitCode: 1, lastLine: "error: lockfile had changes" });
    await drainOutbox(f.db, f.handlers);
    let mission = await missionRow();
    expect(mission).toMatchObject({ status: "paused", worktreeState: "failed" });
    expect(mission.worktreeError).toContain("lockfile had changes");
    const cards = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).filter(
      (m) => m.meta.missionSetup,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.meta).toMatchObject({
      missionSetup: { missionId: view.id, state: "failed", reason: "setup" },
      bodyCode: "mission_setup_failed",
    });
    expect(cards[0]?.body).not.toContain("worktree");

    r.state.ensure.push({ created: false, setupCommand: "bun install" });
    const out = await retryMissionWorktree(f.missionDeps, f.owner.id, f.org.id, view.id);
    expect(out).toMatchObject({ status: "active", worktreeState: "preparing" });
    // The folder is there (with its base): only the setup runs again.
    expect(r.worktree.at(-1)).toMatchObject({ action: "ensure", baseSha: BASE });
    const again = r.started.at(-1) as TaskStart;
    expect(again.taskId).not.toBe(setupTask.taskId);
    expect(again.command).toBe("bun install");
    await r.done(again.taskId);
    await drainOutbox(f.db, f.handlers);
    mission = await missionRow();
    expect(mission).toMatchObject({ status: "active", worktreeState: "ready", worktreeError: null });
    await expect(retryMissionWorktree(f.missionDeps, f.owner.id, f.org.id, view.id)).rejects.toMatchObject({
      code: "mission.worktree_not_failed",
    });
  });

  test("write items take turns and end in a commit; read items run alongside; the next starts on an end", async () => {
    const { view, r } = await started();
    expect((await missionRow()).worktreeState).toBe("ready");
    const path = missionWorktreePath(view.id);
    const a = await startTask({ title: "Tabs", prompt: "Build the tabs" });
    // Started during the main session's turn: it waits for the turn to end, then starts by itself.
    expect(a.content).toContain("Queued task");
    expect(a.content).toContain("this turn of yours ends");
    const first = r.started.at(-1) as TaskStart;
    expect(first.taskId).toBe(taskIdOf(a.content));
    expect(first).toMatchObject({
      cwd: path,
      commit: { message: "agentes: Tabs" },
      baseCheck: { branch: "main", sha: BASE },
    });
    expect((await taskRow(first.taskId))?.mode).toBe("write");
    // A second write item waits for the folder.
    const b = await startTask({ title: "Sign-in", prompt: "Add sign-in", mode: "write" });
    expect(b.content).toContain("Queued task");
    expect(b.content).toContain("one at a time");
    const queuedId = taskIdOf(b.content);
    expect(r.started.some((s) => s.taskId === queuedId)).toBe(false);
    expect(await taskRow(queuedId)).toMatchObject({ status: "queued", mode: "write" });
    // A read item runs now, read only, with no commit.
    const c = await startTask({ title: "Review", prompt: "Review the API", mode: "read" });
    expect(c.content).toContain("Started task");
    const read = r.started.at(-1) as TaskStart;
    expect(read.commit).toBeUndefined();
    expect(read.mission).toMatchObject({ mode: "plan" });

    await r.done(first.taskId, { startSha: "1111111aaaaaaa", endSha: "2222222bbbbbbb" });
    await drainOutbox(f.db, f.handlers);
    expect(await taskRow(first.taskId)).toMatchObject({ startSha: "1111111aaaaaaa", endSha: "2222222bbbbbbb" });
    expect((await told()).find((t) => t.includes('"Tabs"'))).toContain("Changed 1111111..2222222");
    // The queued write item started by itself.
    expect(r.started.at(-1)?.taskId).toBe(queuedId);
    expect((await taskRow(queuedId))?.status).toBe("running");

    await r.done(queuedId, { exitCode: 1, startSha: "2222222bbbbbbb", endSha: "3333333ccccccc" });
    await r.done(read.taskId);
    await drainOutbox(f.db, f.handlers);
    const notes = await told();
    expect(notes.find((t) => t.includes('"Sign-in"'))).toContain('"agentes: Sign-in (stopped)"');
    expect(notes.find((t) => t.includes('"Review"'))).not.toContain("Changed");
  });

  test("a full computer queues the item; it starts when a slot frees", async () => {
    const { r } = await started();
    const busy = await startTask({ title: "Lint", prompt: "Run the linter", mode: "read" });
    const busyId = (r.started.at(-1) as TaskStart).taskId;
    expect(busy.content).toContain("Started task");
    r.state.noSlot = true;
    const out = await startTask({ title: "Tests", prompt: "Run the tests", mode: "read" });
    expect(out.content).toContain("Queued task");
    expect(out.content).toContain("free slot");
    const waiting = taskIdOf(out.content);
    expect(await taskRow(waiting)).toMatchObject({ status: "queued" });
    expect((await taskRow(waiting))?.startRequest).not.toBeNull();
    r.state.noSlot = false;
    await r.done(busyId);
    await drainOutbox(f.db, f.handlers);
    expect(r.started.at(-1)?.taskId).toBe(waiting);
    expect((await taskRow(waiting))?.status).toBe("running");
  });

  test("the base moving is told to the main session once per new count", async () => {
    const { r } = await started();
    r.state.baseBehind = 3;
    await startTask({ title: "Tabs", prompt: "Build the tabs" });
    await startTask({ title: "Docs", prompt: "Read the docs", mode: "read" });
    const first = r.started.at(-2) as TaskStart;
    await r.done(first.taskId);
    await drainOutbox(f.db, f.handlers);
    await startTask({ title: "Tabs 2", prompt: "More tabs" });
    const moved = (await told()).filter((t) => t.includes("moved 3 commits ahead"));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toContain("main");
  });

  test("a folder without git: the mission works in repo_dir, no branch, no commits", async () => {
    await started([{ error: { code: "not_git", message: "not a git repository" } }]);
    const mission = await missionRow();
    expect(mission).toMatchObject({ worktreeState: "ready", worktreePath: "app", branch: null, baseSha: null });
    const r = (await startTask({ title: "Photos", prompt: "Resize them" })).content;
    expect(r).toContain("Queued task");
    const all = await f.db.select().from(schema.machineTasks);
    expect(all.at(-1)).toMatchObject({ cwd: "app", mode: "write", status: "running" });
  });

  test("the computer back: the folder is checked with its base; a lost branch pauses the mission", async () => {
    const { view, r, paired } = await started();
    r.state.ensure.push({ error: { code: "branch_missing", message: "the branch is gone" } });
    await r.reconnect(paired.token);
    await settle();
    expect(r.worktree.at(-1)).toMatchObject({ action: "ensure", baseSha: BASE });
    const mission = await missionRow();
    expect(mission).toMatchObject({ status: "paused", worktreeState: "failed" });
    const card = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
      (m) => m.meta.missionSetup,
    );
    expect(card?.meta).toMatchObject({
      bodyCode: "mission_branch_missing",
      missionSetup: { reason: "branch_missing" },
    });
    expect(await getMission(f.missionDeps, f.owner.id, f.org.id, view.id)).toMatchObject({
      worktreeFailReason: "branch_missing",
    });
    // Trying again starts over from the base (the person's choice).
    await retryMissionWorktree(f.missionDeps, f.owner.id, f.org.id, view.id);
    expect(r.worktree.at(-1)?.baseSha).toBeUndefined();
    expect(await missionRow()).toMatchObject({ worktreeState: "ready", worktreeFailReason: null });
  });

  test("conclude removes the folder and keeps the branch; cancel can delete everything", async () => {
    const one = await started();
    await closeMission(f.missionDeps, f.owner.id, f.org.id, one.view.id, { outcome: "done" });
    expect(one.r.worktree.at(-1)).toMatchObject({ action: "remove", path: missionWorktreePath(one.view.id) });
    expect(one.r.worktree.at(-1)?.deleteBranch).toBeUndefined();
    expect((await missionRow()).worktreeState).toBe("removed");
    await f.machineHub?.stop();
    await f.close();

    const two = await started();
    await closeMission(f.missionDeps, f.owner.id, f.org.id, two.view.id, { outcome: "canceled", deleteBranch: true });
    expect(two.r.worktree.at(-1)).toMatchObject({ action: "remove", deleteBranch: true });
    expect((await missionRow()).worktreeState).toBe("removed");
  });

  test("a folder inside a repository that starts outside the agent's folder fails; it never works in the checkout", async () => {
    const { view } = await started([
      {
        error: {
          code: "outside_workspace",
          message: "app is inside a git repository that starts outside the agent's folder",
        },
      },
    ]);
    const mission = await missionRow();
    expect(mission).toMatchObject({ status: "paused", worktreeState: "failed", worktreeFailReason: "ensure" });
    expect(mission.worktreePath).toBeNull();
    expect(await getMission(f.missionDeps, f.owner.id, f.org.id, view.id)).toMatchObject({
      worktreeFailReason: "ensure",
    });
  });

  test("Resume on a failed folder prepares it again (as Tentar de novo does)", async () => {
    const { view, r } = await started([{ created: true, setupCommand: "bun install" }]);
    await r.done((r.started[0] as TaskStart).taskId, { exitCode: 1, lastLine: "error: no network" });
    await drainOutbox(f.db, f.handlers);
    expect(await missionRow()).toMatchObject({
      status: "paused",
      worktreeState: "failed",
      worktreeFailReason: "setup",
    });
    r.state.ensure.push({ created: false, setupCommand: "bun install" });
    const out = await resumeMission(f.missionDeps, f.owner.id, f.org.id, view.id);
    expect(out).toMatchObject({ status: "active", worktreeState: "preparing", worktreeFailReason: null });
    const again = r.started.at(-1) as TaskStart;
    expect(again.command).toBe("bun install");
    await r.done(again.taskId);
    await drainOutbox(f.db, f.handlers);
    expect(await missionRow()).toMatchObject({ status: "active", worktreeState: "ready" });
  });

  test("closing while a write item runs: the folder goes away only after its stopped commit", async () => {
    const { view, r } = await started();
    await startTask({ title: "Tabs", prompt: "Build the tabs" });
    const item = r.started.at(-1) as TaskStart;
    await closeMission(f.missionDeps, f.owner.id, f.org.id, view.id, { outcome: "canceled", deleteBranch: true });
    // task.cancel went out; the runner still commits " (stopped)": nothing is removed yet.
    expect(r.worktree.some((w) => w.action === "remove")).toBe(false);
    expect(await missionRow()).toMatchObject({ status: "canceled", worktreeState: "ready" });
    await r.done(item.taskId, { exitCode: 130, startSha: "1111111aaaaaaa", endSha: "2222222bbbbbbb" });
    await drainOutbox(f.db, f.handlers);
    expect(r.worktree.at(-1)).toMatchObject({ action: "remove", deleteBranch: true });
    expect((await missionRow()).worktreeState).toBe("removed");
  });

  test("the computer back: an interrupted write item resumes through the queue, ahead of the next, once ready", async () => {
    const { r, paired } = await started();
    await startTask({ title: "Tabs", prompt: "Build the tabs" });
    const a = r.started.at(-1) as TaskStart;
    const b = taskIdOf((await startTask({ title: "Sign-in", prompt: "Add sign-in" })).content);
    expect(await taskRow(b)).toMatchObject({ status: "queued" });
    // The folder is gone too: made again from the branch, setup first.
    r.state.ensure.push({ created: true, setupCommand: "bun install" });
    const before = r.started.length;
    await r.reconnect(paired.token);
    await settle();
    expect((await taskRow(a.taskId))?.status).toBe("interrupted");
    const resumed = (await f.db.select().from(schema.machineTasks)).find((t) => t.resumedFromId === a.taskId);
    expect(resumed).toMatchObject({ status: "queued", mode: "write" });
    // Only the setup runs while the folder is prepared: neither the resumed item nor the next one.
    expect(r.started.slice(before).map((s) => s.command)).toEqual(["bun install"]);
    await r.done((r.started.at(-1) as TaskStart).taskId);
    await drainOutbox(f.db, f.handlers);
    expect((await missionRow()).worktreeState).toBe("ready");
    const next = r.started.slice(before + 1);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      taskId: resumed?.id,
      resume: true,
      session: a.session,
      commit: { message: "agentes: Tabs" },
    });
    expect((await taskRow(b))?.status).toBe("queued");
    await r.done(resumed?.id as string);
    await drainOutbox(f.db, f.handlers);
    expect(r.started.at(-1)?.taskId).toBe(b);
  });

  test("the main session only reads while a write item works in the folder", async () => {
    const { r } = await started();
    const mission = await missionRow();
    const turn = { orgId: f.org.id, agentId: f.agent.id, threadRootId: mission.threadRootId };
    expect(await missionTurnPermissions(f.db, turn)).toMatchObject({ mode: "work" });
    await startTask({ title: "Review", prompt: "Review the API", mode: "read" });
    expect(await missionTurnPermissions(f.db, turn)).toMatchObject({ mode: "work" });
    const out = await startTask({ title: "Tabs", prompt: "Build the tabs" });
    expect(out.content).toContain(onlyReadsWhileWriting(mission.executor));
    const item = r.started.at(-1) as TaskStart;
    expect(await missionTurnPermissions(f.db, turn)).toMatchObject({ mode: "plan" });
    await r.done(item.taskId);
    await drainOutbox(f.db, f.handlers);
    expect(await missionTurnPermissions(f.db, turn)).toMatchObject({ mode: "work" });
    expect(await missionTurnPermissions(f.db, { ...turn, threadRootId: crypto.randomUUID() })).toBeNull();
  });

  test("a run a routine's report woke in the mission's thread has the mission's profile but doesn't make it act", async () => {
    await started();
    const mission = await missionRow();
    const turn = { orgId: f.org.id, agentId: f.agent.id, threadRootId: mission.threadRootId };
    const delivered = await f.db.transaction((tx) =>
      deliverNotice(tx, {
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: mission.channelId,
        threadId: mission.threadRootId,
        hop: 0,
        stretchId: null,
        notice: { kind: "routine_handoff", text: "3 new errors in checkout.", from: "Routine «Sentry»" },
      }),
    );
    const woken = delivered.runs[0];
    expect(woken).toBeDefined();
    expect(await missionTurnPermissions(f.db, { ...turn, runId: woken?.id })).toMatchObject({ mode: "work" });
    // The mission's own run (woken by its inbox, nobody behind it) keeps the mission's profile.
    const own = (await f.db.select().from(schema.agentRuns)).find((r) => r.id !== woken?.id);
    expect(own).toBeDefined();
    expect(await missionTurnPermissions(f.db, { ...turn, runId: own?.id })).toMatchObject({ mode: "work" });
    // Nobody is behind the report, so it doesn't make the mission act: its machine tools say so, as its others do.
    const { db: _db, ...deps } = f.missionDeps;
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: woken?.id ?? "",
      channelId: mission.channelId,
      threadRootId: mission.threadRootId,
      triggerMessageId: woken?.triggerMessageId ?? "",
      bridge: { machineId: mission.machineId as string },
    };
    const tools = await createMissionRunToolSource(deps).tools(ctx);
    for (const [name, input] of [
      ["start_task", { title: "Corrigir o checkout", prompt: "Os 3 erros novos" }],
      ["upload_artifact", { path: "relatorio.md" }],
    ] as const) {
      expect(await tools.find((t) => t.name === name)?.execute(input, ctx)).toMatchObject({
        isError: true,
        data: { code: "mission.not_allowed" },
      });
    }
    const titles = (await f.db.select().from(schema.machineTasks)).map((t) => t.title);
    expect(titles).not.toContain("Corrigir o checkout");
  });

  test("moving to another computer removes the copy on the old one (the branch stays)", async () => {
    const { view, r } = await started();
    const old = await missionRow();
    const other = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "Studio",
      ...RUNNER,
      exec: true,
    });
    const r2 = runner(f.machineHub as MachineHub);
    await r2.hello(other.token);
    const out = await setMissionMachine(f.missionDeps, f.owner.id, f.org.id, view.id, { machineId: other.machineId });
    // Removed in the background: the request doesn't wait for the old computer.
    await settle();
    expect(r.worktree.at(-1)).toMatchObject({ action: "remove", path: old.worktreePath, branch: old.branch });
    expect(r.worktree.at(-1)?.deleteBranch).toBeUndefined();
    expect(out).not.toHaveProperty("code");
    // The new computer makes its copy from the branch.
    expect(r2.worktree.at(-1)).toMatchObject({ action: "ensure", branch: old.branch });
    expect(await missionRow()).toMatchObject({ machineId: other.machineId, worktreeState: "ready" });
  });

  test("a write item started mid-turn waits for the turn to end; the main session reads from start_task on", async () => {
    const { r } = await started();
    const mission = await missionRow();
    const turn = { orgId: f.org.id, agentId: f.agent.id, threadRootId: mission.threadRootId };
    const before = r.started.length;
    const out = await startTask({ title: "Tabs", prompt: "Build the tabs" }, { keepTurn: true });
    expect(out.content).toContain("this turn of yours ends");
    expect(out.content).toContain(onlyReadsWhileWriting(mission.executor));
    const id = taskIdOf(out.content);
    expect(r.started).toHaveLength(before);
    expect(await taskRow(id)).toMatchObject({ status: "queued", mode: "write" });
    // Queued counts: the next turns only read (#3).
    expect(await missionTurnPermissions(f.db, turn)).toMatchObject({ mode: "plan" });
    // A turn that began after the item was queued reads only: it doesn't hold the item back.
    const later = await startTaskInTurn({ title: "Look", prompt: "Look around", mode: "read" });
    // The first turn ends: the item starts, though the later turn still runs.
    await endTurn(out.runId);
    expect(r.started.at(-1)?.taskId).toBe(id);
    expect((await taskRow(id))?.status).toBe("running");
    await endTurn(later.runId);
    // A queued write item with a start request (a resumed one) counts too.
    await f.db
      .update(schema.machineTasks)
      .set({ status: "queued", startRequest: { x: 1 } as never })
      .where(eq(schema.machineTasks.id, id));
    expect(await missionTurnPermissions(f.db, turn)).toMatchObject({ mode: "plan" });
  });

  test("moving is refused while a task is live; away, the old copy is left there", async () => {
    const { view, r, paired } = await started();
    await startTask({ title: "Tabs", prompt: "Build the tabs" });
    const item = r.started.at(-1) as TaskStart;
    const other = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "Studio",
      ...RUNNER,
      exec: true,
    });
    const r2 = runner(f.machineHub as MachineHub);
    await r2.hello(other.token);
    await expect(
      setMissionMachine(f.missionDeps, f.owner.id, f.org.id, view.id, { machineId: other.machineId }),
    ).rejects.toMatchObject({ code: "mission.tasks_live" });
    expect(await missionRow()).toMatchObject({ machineId: paired.machineId });
    await r.done(item.taskId);
    await drainOutbox(f.db, f.handlers);
    // The old computer goes away: the move goes on, its copy stays there (the branch has the work).
    await f.db.update(schema.machines).set({ online: false }).where(eq(schema.machines.id, paired.machineId));
    const hub = f.machineHub as MachineHub;
    const status = hub.status.bind(hub);
    hub.status = async (id: string) => {
      const s = await status(id);
      return s && id === paired.machineId ? { ...s, online: false } : s;
    };
    const out = await setMissionMachine(f.missionDeps, f.owner.id, f.org.id, view.id, { machineId: other.machineId });
    expect(out).toMatchObject({ code: "mission.old_copy_left" });
    expect(r.worktree.some((w) => w.action === "remove")).toBe(false);
    const events = await f.db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, view.id));
    expect(events.some((e) => e.kind === "worktree_left_behind")).toBe(true);
  });

  test("the computer back: an active mission with no folder yet gets one, then its queued items start", async () => {
    const { r, paired } = await started();
    const id = taskIdOf((await startTask({ title: "Tabs", prompt: "Build the tabs" }, { keepTurn: true })).content);
    // As if Start happened while the computer was away: no folder yet.
    await f.db
      .update(schema.missions)
      .set({ worktreeState: "none", branch: null, worktreePath: null, baseSha: null, baseBranch: null })
      .where(eq(schema.missions.id, (await missionRow()).id));
    await f.db.update(schema.agentRuns).set({ status: "done" });
    const before = r.worktree.length;
    await r.reconnect(paired.token);
    await settle();
    expect(r.worktree.slice(before).some((w) => w.action === "ensure")).toBe(true);
    expect((await missionRow()).worktreeState).toBe("ready");
    expect(r.started.at(-1)?.taskId).toBe(id);
  });

  test("an interrupted item behind a failed folder: the notice says it resumes once the project is ready", async () => {
    const { r } = await started();
    await startTask({ title: "Tabs", prompt: "Build the tabs" });
    const item = r.started.at(-1) as TaskStart;
    await f.db
      .update(schema.missions)
      .set({ worktreeState: "failed", worktreeFailReason: "setup" })
      .where(eq(schema.missions.id, (await missionRow()).id));
    await r.done(item.taskId, { interrupted: true, session: item.session });
    await drainOutbox(f.db, f.handlers);
    await settle();
    const codes = (
      await f.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.threadId, (await missionRow()).threadRootId))
    ).map((m) => m.meta.bodyCode);
    expect(codes).toContain("machine_task_resume_waits");
    expect(codes).not.toContain("machine_task_resumed");
    const resumed = (await f.db.select().from(schema.machineTasks)).find((t) => t.resumedFromId === item.taskId);
    expect(resumed).toMatchObject({ status: "queued" });
  });

  test("an interrupted item's ack never waits for the queue walk", async () => {
    const { r } = await started();
    await startTask({ title: "Tabs", prompt: "Build the tabs" });
    const item = r.started.at(-1) as TaskStart;
    // A queue walk that never ends.
    (f.machineHub as MachineHub).setMissionHooks({ queue: () => new Promise(() => undefined) });
    await r.done(item.taskId, { interrupted: true, session: item.session });
    expect(r.acks).toContain(item.taskId);
  });

  test("a runner older than protocol 14 can't start a mission", async () => {
    const { view } = await started([], { start: false });
    const mission = await missionRow();
    await f.db
      .update(schema.machines)
      .set({ protocol: 13 })
      .where(eq(schema.machines.id, mission.machineId as string));
    await expect(startMission(f.missionDeps, f.owner.id, f.org.id, view.id)).rejects.toMatchObject({
      code: "mission.runner_outdated",
    });
  });
});

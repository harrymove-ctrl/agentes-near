import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters";
import { completeMission, getMissionRow, startSessionTask } from "@agenteschat/engine";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.5.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

type Request = Extract<ServerFrame, { type: "request" }>;

/**
 * A connected runner on the test server's hub that starts and cancels tasks and ends brain turns; `answer` replies
 * to the other requests (undefined: an empty reply).
 */
function fakeRunner(extra: Record<string, unknown> = {}, answer: (frame: Request) => unknown = () => undefined) {
  const hub = t.engine.machineHub;
  const started: Extract<Request, { op: "task.start" }>[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "task.start") {
          started.push(frame);
          return ok({
            taskId: frame.taskId,
            pid: 7,
            startedAt: new Date().toISOString(),
            cwd: frame.cwd ?? "",
            command: "claude -p",
          });
        }
        if (frame.op === "task.cancel") return ok({ canceled: true });
        if (frame.op === "task.output") return ok({ lines: ["Reading app/package.json"], truncated: false });
        if (frame.op === "brain.turn") {
          // A turn of a brain on this computer (a mission's main session) ends as a runner ends it: `brain.done`,
          // then the reply with its final event. A reply without them leaves the turn waiting out the brain's
          // grace for the stream's end, 1.5 s of real time.
          const final = { type: "done", text: "ok", session: { id: frame.session.id } };
          return void reply({ type: "brain.done", runId: frame.runId }).then(() => ok({ runId: frame.runId, final }));
        }
        if (frame.op === "read") return ok({ base64: null, size: 0 });
        return ok(answer(frame) ?? { size: 0 });
      }, 1);
    },
    close() {},
  });
  return {
    started,
    reply,
    hello: (token: string) => reply({ type: "hello", token, ...RUNNER, exec: true, ...extra }),
  };
}

interface Mission {
  id: string;
  threadId: string;
  status: string;
  role: string;
  canAct: boolean;
  plan: { total: number };
}

test("missions API: session and same origin; create, read, start (owner only), list, summary, stop, close", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  // A computer for the agent, its runner connected.
  const paired = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  expect(
    (await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: paired.machineId } })).status,
  ).toBe(200);
  const runner = fakeRunner();
  await runner.hello(paired.token);

  const anon = browser(t);
  expect((await anon(`/api/app/organizations/${orgId}/missions`)).status).toBe(401);
  const input = { agentId, channelId, goal: "Build our mobile app", title: "Mobile app" };
  expect((await api("/missions", { json: input, origin: "https://evil.example" })).status).toBe(403);

  const created = await api("/missions", { json: input });
  expect(created.status).toBe(201);
  const mission = (await created.json()) as Mission;
  expect(mission).toMatchObject({ status: "proposed", role: "owner", canAct: true });
  // The planning is the main session's run in the thread (ADR 0032 §6): nothing starts on the computer.
  expect(runner.started).toHaveLength(0);
  // An item session of the mission on the computer (what the main session's start_task starts).
  await startSessionTask(
    { db: t.db, hub: t.engine.machineHub },
    (await getMissionRow(t.db, mission.id)) as NonNullable<Awaited<ReturnType<typeof getMissionRow>>>,
    { title: "Explore", prompt: "Map the repo", sessionId: crypto.randomUUID(), cwd: "", resume: false },
  );
  expect(runner.started).toHaveLength(1);
  expect(runner.started[0]?.mission?.id).toBe(mission.id);

  const byThread = await api(`/threads/${mission.threadId}/mission`);
  expect(((await byThread.json()) as Mission).id).toBe(mission.id);
  const tasks = (await (await api(`/threads/${mission.threadId}/tasks`)).json()) as { tasks: { missionId: string }[] };
  expect(tasks.tasks.map((x) => x.missionId)).toEqual([mission.id]);
  const threads = (await (await api("/threads?tab=missions")).json()) as {
    threads: { id: string; mission: { id: string; status: string } | null }[];
  };
  expect(threads.threads).toEqual([
    expect.objectContaining({
      id: mission.threadId,
      mission: expect.objectContaining({ id: mission.id, status: "proposed" }),
    }),
  ]);

  // A member who reads the channel sees it, but can't start it, decide or stop it.
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  const { url } = (await (
    await api("/invitations", { json: { email: "bia@example.com", role: "member" } })
  ).json()) as {
    url: string;
  };
  await bia(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const asBia = (path: string, init?: Parameters<typeof bia>[1]) => bia(`/api/app/organizations/${orgId}${path}`, init);
  const seen = await asBia(`/missions/${mission.id}`);
  expect(seen.status).toBe(200);
  expect(((await seen.json()) as Mission).role).toBe("none");
  const refused = await asBia(`/missions/${mission.id}/start`, { json: {} });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("mission.not_owner");
  expect((await asBia(`/missions/${mission.id}/stop`, { json: {} })).status).toBe(403);
  expect((await asBia(`/missions/${mission.id}/close`, { json: { outcome: "done" } })).status).toBe(403);

  const startRes = await api(`/missions/${mission.id}/start`, { json: {} });
  expect(startRes.status).toBe(200);
  expect(((await startRes.json()) as Mission).status).toBe("active");
  expect((await api(`/missions/${mission.id}/start`, { json: {} })).status).toBe(409);

  const list = (await (await api("/missions?status=open")).json()) as { missions: Mission[] };
  expect(list.missions.map((m) => m.id)).toEqual([mission.id]);
  const summary = (await (await api(`/missions/${mission.id}/summary`)).json()) as { text: string };
  expect(summary.text).toContain('"Mobile app": active.');
  const plan = (await (await api(`/missions/${mission.id}/plan`)).json()) as {
    missionId: string;
    current: unknown;
    history: unknown[];
  };
  expect(plan).toEqual({ missionId: mission.id, current: null, history: [] });
  expect((await api(`/missions/${mission.id}/files`)).status).toBe(200);
  expect((await api(`/missions/${mission.id}/participants`)).status).toBe(200);
  expect((await api(`/missions/${mission.id}/decisions`)).status).toBe(200);

  // The list's counts and filters, the agents that can run a mission.
  const counted = (await (await api(`/missions?status=open&agentId=${agentId}&q=mobile`)).json()) as {
    missions: Mission[];
    counts: { active: number; waitingYou: number; closed: number };
  };
  expect(counted.counts).toEqual({ active: 1, waitingYou: 0, closed: 0 });
  expect(counted.missions).toHaveLength(1);
  expect(((await (await api("/missions?q=nothing-like-it")).json()) as { missions: Mission[] }).missions).toEqual([]);
  const eligible = (await (await api("/missions/eligible-agents")).json()) as {
    agents: { agentId: string; eligible: boolean; reason: string | null; machine: { online: boolean } | null }[];
  };
  expect(eligible.agents.filter((a) => a.eligible)).toEqual([
    expect.objectContaining({ agentId, reason: null, machine: expect.objectContaining({ online: true }) }),
  ]);

  // "Ver saída": anyone who reads the thread.
  const taskId = runner.started[0]?.taskId as string;
  const output = await asBia(`/tasks/${taskId}/output?tail=20`);
  expect(output.status).toBe(200);
  expect(await output.json()).toMatchObject({ source: "computer", lines: ["Reading app/package.json"] });

  // Bia asks to join; the owner sees it and accepts her as someone who decides.
  const asked = await asBia(`/missions/${mission.id}/join-requests`, { json: {} });
  expect(asked.status).toBe(200);
  expect(((await (await asBia(`/missions/${mission.id}`)).json()) as { joinRequested: boolean }).joinRequested).toBe(
    true,
  );
  const pending = (await (await api(`/missions/${mission.id}/join-requests`)).json()) as {
    requests: { userId: string; name: string }[];
  };
  expect(pending.requests).toHaveLength(1);
  const biaId = pending.requests[0]?.userId as string;
  expect((await asBia(`/missions/${mission.id}/join-requests/${biaId}/decline`, { json: {} })).status).toBe(403);
  const accepted = await api(`/missions/${mission.id}/join-requests/${biaId}/accept`, { json: { role: "decide" } });
  expect(accepted.status).toBe(200);
  expect(((await (await asBia(`/missions/${mission.id}`)).json()) as Mission).role).toBe("decide");
  expect((await asBia(`/missions/${mission.id}/join-requests`, { json: {} })).status).toBe(409);

  const stopped = await api(`/missions/${mission.id}/stop`, { json: {} });
  expect(stopped.status).toBe(200);
  expect((await stopped.json()) as { status: string; canceledTasks: number }).toMatchObject({
    status: "paused",
    canceledTasks: 1,
  });
  const closed = await api(`/missions/${mission.id}/close`, { json: { outcome: "canceled" } });
  expect(closed.status).toBe(200);
  expect(((await closed.json()) as Mission).status).toBe("canceled");
  expect((await api(`/missions/${mission.id}/resume`, { json: {} })).status).toBe(409);
});

test("missions API: who programs: eligible agents list it, POST takes it, the owner switches it before Start", async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const paired = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: paired.machineId } });
  // The runner found Claude Code on the machine.
  const runner = fakeRunner({ executors: { claude: { version: "2.1.300 (Claude Code)" } } });
  await runner.hello(paired.token);

  const eligible = (await (await api("/missions/eligible-agents")).json()) as {
    agents: { executors: string[]; defaultExecutor: string; codexTooOld: boolean }[];
  };
  expect(eligible.agents[0]).toMatchObject({
    executors: ["claude", "agent"],
    defaultExecutor: "claude",
    codexTooOld: false,
  });

  const bad = await api("/missions", { json: { agentId, channelId, goal: "Build it", executor: "codex" } });
  expect(bad.status).toBe(409);
  expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("mission.executor_unavailable");

  const created = await api("/missions", { json: { agentId, channelId, goal: "Build it", executor: "agent" } });
  expect(created.status).toBe(201);
  const mission = (await created.json()) as Mission & {
    executor: string;
    machine: { executors: string[] };
  };
  expect(mission.executor).toBe("agent");
  expect(mission.machine.executors).toEqual(["claude", "agent"]);
  // The agent plans it itself: no executor session on the machine.
  expect(runner.started).toHaveLength(0);

  const switched = await api(`/missions/${mission.id}/executor`, { method: "PUT", json: { executor: "claude" } });
  expect(switched.status).toBe(200);
  expect(((await switched.json()) as { executor: string }).executor).toBe("claude");
  // A new main session plans with the new brain: still nothing started on the computer by itself.
  expect(runner.started).toHaveLength(0);

  await api(`/missions/${mission.id}/start`, { json: {} });
  const late = await api(`/missions/${mission.id}/executor`, { method: "PUT", json: { executor: "agent" } });
  expect(late.status).toBe(409);
});

test("missions API: deliveries — list, check per person, Pedir ajustes (active again), Concluir (done)", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const paired = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: paired.machineId } });
  const runner = fakeRunner();
  await runner.hello(paired.token);
  const mission = (await (
    await api("/missions", { json: { agentId, channelId, goal: "Build our mobile app", title: "Mobile app" } })
  ).json()) as Mission;
  expect((await api(`/missions/${mission.id}/start`, { json: {} })).status).toBe(200);

  const deliver = async (summary: string) =>
    completeMission(
      { db: t.db },
      (await getMissionRow(t.db, mission.id)) as NonNullable<Awaited<ReturnType<typeof getMissionRow>>>,
      null,
      {
        summary,
        checklist: ["Open it on the phone"],
      },
    );
  const first = await deliver("The app builds");
  const view = (await (await api(`/missions/${mission.id}`)).json()) as Mission & { pending: { deliveries: number } };
  expect(view.status).toBe("awaiting_close");
  expect(view.pending.deliveries).toBe(1);

  const listed = await api(`/missions/${mission.id}/deliveries`);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual([
    expect.objectContaining({ id: first.id, status: "pending", auto: false, summary: "The app builds" }),
  ]);
  const checked = await api(`/missions/${mission.id}/deliveries/${first.id}/checks/c1`, {
    method: "PUT",
    json: { checked: true },
  });
  expect(checked.status).toBe(200);
  const body = (await checked.json()) as { checklist: { id: string; checkedBy: string[] }[] };
  expect(body.checklist[0]?.checkedBy).toHaveLength(1);
  expect(
    (await api(`/missions/${mission.id}/deliveries/${first.id}/checks/zz`, { method: "PUT", json: { checked: true } }))
      .status,
  ).toBe(404);
  const anon = browser(t);
  expect((await anon(`/api/app/organizations/${orgId}/missions/${mission.id}/deliveries`)).status).toBe(401);

  expect((await api(`/missions/${mission.id}/deliveries/${first.id}/changes`, { json: { note: "" } })).status).toBe(
    400,
  );
  const changed = await api(`/missions/${mission.id}/deliveries/${first.id}/changes`, {
    json: { note: "Bigger buttons" },
  });
  expect(changed.status).toBe(200);
  expect(((await changed.json()) as Mission).status).toBe("active");
  const again = await api(`/missions/${mission.id}/deliveries/${first.id}/accept`, { json: {} });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("mission.delivery_decided");

  const second = await deliver("Now with bigger buttons");
  const done = await api(`/missions/${mission.id}/deliveries/${second.id}/accept`, { json: { saveToWiki: false } });
  expect(done.status).toBe(200);
  expect(((await done.json()) as Mission).status).toBe("done");
  const all = (await (await api(`/missions/${mission.id}/deliveries`)).json()) as { status: string }[];
  expect(all.map((d) => d.status)).toEqual(["accepted", "changes_requested"]);
});

test("missions API: the copy of the project (ADR 0044) — DTO fields, setup failure, worktree/retry, cancel deleting the branch", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const paired = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "MacBook" });
  await api(`/agents/${agentId}/computer/target`, { method: "PUT", json: { machineId: paired.machineId } });
  // A runner whose setup fails once; it keeps its worktree requests.
  const worktree: Extract<Request, { op: "mission.worktree" }>[] = [];
  const runner = fakeRunner({}, (frame) => {
    if (frame.op !== "mission.worktree") return undefined;
    worktree.push(frame);
    if (frame.action === "remove") return { removed: true };
    return {
      path: frame.path,
      branch: frame.branch,
      baseBranch: "main",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      created: !frame.baseSha,
      dirty: false,
      setupCommand: "bun install",
      copied: [],
    };
  });
  await runner.hello(paired.token);
  const { started, reply } = runner;

  const created = (await (
    await api("/missions", { json: { agentId, channelId, goal: "Build our mobile app", title: "Mobile app" } })
  ).json()) as Mission & { worktreeState: string; branch: string | null };
  expect(created).toMatchObject({ worktreeState: "none", branch: null });
  const startRes = (await (await api(`/missions/${created.id}/start`, { json: {} })).json()) as Record<string, unknown>;
  expect(startRes).toMatchObject({ status: "active", worktreeState: "preparing", baseBranch: "main" });
  expect(String(startRes.branch)).toMatch(/^agentes\/[0-9a-f]{8}\/mobile-app$/);
  const setup = started[0];
  expect(setup).toMatchObject({ executor: "shell", command: "bun install" });
  // Moving it while its setup runs there: refused until the tasks stop.
  const studio = await pairComputer(t, api, { ...RUNNER, exec: true }, { name: "Studio" });
  const move = await api(`/missions/${created.id}/machine`, { method: "PUT", json: { machineId: studio.machineId } });
  expect(move.status).toBe(409);
  expect(((await move.json()) as { error: { code: string } }).error.code).toBe("mission.tasks_live");

  // Retry before anything failed: refused.
  expect((await api(`/missions/${created.id}/worktree/retry`, { json: {} })).status).toBe(409);
  await reply({ type: "task.done", taskId: setup?.taskId, exitCode: 1, seconds: 3, lastLine: "install failed" });
  await t.drain();
  const failed = (await (await api(`/missions/${created.id}`)).json()) as Record<string, unknown>;
  expect(failed).toMatchObject({ status: "paused", worktreeState: "failed" });
  expect(String(failed.worktreeError)).toContain("install failed");
  const tasks = (await (await api(`/threads/${created.threadId}/tasks`)).json()) as {
    tasks: { mode: string | null; startSha: string | null; endSha: string | null }[];
  };
  expect(tasks.tasks[0]).toMatchObject({ mode: "setup", startSha: null, endSha: null });

  const retried = await api(`/missions/${created.id}/worktree/retry`, { json: {} });
  expect(retried.status).toBe(200);
  expect((await retried.json()) as Record<string, unknown>).toMatchObject({
    status: "active",
    worktreeState: "preparing",
  });
  expect(started).toHaveLength(2);
  await reply({ type: "task.done", taskId: started[1]?.taskId, exitCode: 0, seconds: 3 });
  await t.drain();
  expect(((await (await api(`/missions/${created.id}`)).json()) as Record<string, unknown>).worktreeState).toBe(
    "ready",
  );

  const closed = await api(`/missions/${created.id}/close`, { json: { outcome: "canceled", deleteBranch: true } });
  expect(closed.status).toBe(200);
  expect(((await closed.json()) as Record<string, unknown>).worktreeState).toBe("removed");
  expect(worktree.at(-1)).toMatchObject({ action: "remove", deleteBranch: true });
});

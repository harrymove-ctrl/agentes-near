import {
  acceptDelivery,
  approveProvisionalDecisions,
  checkDeliveryItem,
  chooseDecision,
  closeMission,
  createMission,
  decideCommand,
  decideJoinRequest,
  decideReview,
  decideSuggestion,
  eligibleMissionAgents,
  getMission,
  getMissionBrain,
  getMissionByThread,
  getMissionFiles,
  getMissionPlan,
  getMissionSettings,
  getTaskOutput,
  listDecisions,
  listDeliveries,
  listJoinRequests,
  listMissionCommands,
  listMissions,
  listParticipants,
  listReviews,
  listThreadMachineTasks,
  type MissionDeps,
  machineTaskView,
  missionSummary,
  opineDecision,
  pauseMission,
  removeCommandRule,
  removeParticipant,
  requestDeliveryChanges,
  requestToJoin,
  resumeMission,
  retryBlockedCommand,
  retryMissionWorktree,
  sendMissionMessage,
  setAgentMissionApproval,
  setCommandApproval,
  setMissionBrain,
  setMissionExecutor,
  setMissionMachine,
  setMissionResumeTasks,
  setParticipant,
  startMission,
  stopMission,
  transferMission,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { BrainKind, CommandApproval, MissionBrain } from "./schemas";

const tags = ["Missions"];
const Status = z.enum(["proposed", "active", "paused", "done", "canceled", "awaiting_close"]).openapi({
  description: "awaiting_close: every plan item is done and nothing runs; it waits for its owner to conclude it.",
});
const Executor = z
  .enum(["claude", "codex", "agent"])
  .openapi({ description: "Who programs: Claude Code, Codex or the agent itself with its own tools." });
const Role = z.enum(["owner", "decide", "comment", "none"]);
const WorktreeState = z.enum(["none", "preparing", "ready", "failed", "removed"]).openapi({
  description:
    "The mission's copy of the project (ADR 0044): none (not made yet), preparing (made, setup running: work waits), ready, failed (the mission paused; retry with …/worktree/retry), removed (closed).",
});
const PlanItem = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["todo", "doing", "waiting_you", "done", "dropped"]),
  note: z.string().optional(),
});

const Mission = z
  .object({
    id: z.uuid(),
    threadId: z.uuid().openapi({ description: "The home thread (root message id)." }),
    channelId: z.uuid(),
    agentId: z.uuid(),
    ownerId: z.string().nullable(),
    executor: z.string(),
    title: z.string(),
    goal: z.string(),
    findings: z
      .array(
        z.object({
          kind: z.enum(["read", "data", "decision"]),
          text: z.string(),
          refs: z.array(z.string()).optional(),
        }),
      )
      .openapi({
        description:
          "What the agent found before proposing it (read only): `read` = code or files it read, `data` = numbers from analytics, logs, errors, `decision` = the one open question for the person. `refs`: files with lines, links, ids. Empty when a person started it and the planning hasn't recorded any yet.",
      }),
    openQuestion: z
      .string()
      .nullable()
      .openapi({ description: "The `decision` finding's text: the one question left for the person (null: none)." }),
    status: Status,
    repoDir: z.string(),
    branch: z.string().nullable().openapi({
      description:
        "The mission's own branch (`agentes/<id>/<slug>`), its copy of the project works on it; null before Start and for a folder without git.",
    }),
    baseBranch: z.string().nullable().openapi({ description: 'The branch it started from ("a partir de main").' }),
    baseSha: z
      .string()
      .nullable()
      .openapi({ description: "That branch's tip at Start: the whole change is baseSha..branch." }),
    worktreeState: WorktreeState,
    worktreeError: z
      .string()
      .nullable()
      .openapi({ description: "The last lines of a failed setup, or why the copy couldn't be made." }),
    worktreeFailReason: z.enum(["setup", "ensure", "branch_missing"]).nullable().openapi({
      description:
        "Why the copy is `failed`: setup (the install failed), ensure (it couldn't be made), branch_missing (the mission's branch is gone: trying again starts over); null otherwise.",
    }),
    resumeTasks: z.boolean(),
    commandApproval: CommandApproval,
    plan: z.object({
      version: z.number(),
      done: z.number(),
      total: z.number(),
      waiting: z.number(),
      doing: z.number(),
      items: z
        .array(PlanItem.omit({ note: true }))
        .openapi({ description: "The latest plan in order (at most 40), for the strip." }),
    }),
    pending: z.object({
      decisions: z.number(),
      provisional: z.number(),
      reviews: z.number(),
      suggestions: z.number(),
      joinRequests: z.number().openapi({ description: "Requests to join (0 unless you can answer them)." }),
      commands: z
        .number()
        .openapi({ description: "Command cards waiting for an answer (0 unless you can answer them)." }),
      deliveries: z
        .number()
        .openapi({ description: "Delivery cards waiting to be concluded (0 unless you can answer them)." }),
    }),
    joinRequested: z.boolean().openapi({ description: "You asked to join and nobody answered yet." }),
    runningTasks: z.number(),
    machine: z
      .object({
        id: z.uuid(),
        name: z.string(),
        online: z.boolean(),
        lentBy: z.string().nullable(),
        executors: z.array(Executor).openapi({ description: "Who can program on that computer." }),
        codexTooOld: z.boolean(),
      })
      .nullable(),
    needsComputer: z.boolean().openapi({ description: "Handed over without a computer: the owner sets one." }),
    role: Role.openapi({ description: "Your role in it." }),
    canAct: z.boolean().openapi({ description: "You may start work, decide, review, pause and stop." }),
    canManage: z.boolean().openapi({ description: "You may close it and change who takes part." }),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    pausedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    closeReason: z.string().nullable(),
    wikiPageId: z.string().nullable(),
  })
  .openapi("Mission");

const Decision = z
  .object({
    id: z.uuid(),
    missionId: z.uuid(),
    taskId: z.string().nullable(),
    messageId: z.string().nullable(),
    question: z.string(),
    options: z.array(z.string()),
    recommendation: z.string().nullable(),
    why: z.string().nullable(),
    impact: z.string().nullable(),
    blocking: z.boolean(),
    status: z.enum(["pending", "provisional", "taken"]),
    chosen: z.string().nullable(),
    chosenBy: z.string().nullable(),
    chosenAt: z.string().nullable(),
    opinions: z.array(z.object({ userId: z.string(), option: z.string(), at: z.string() })),
    createdAt: z.string(),
  })
  .openapi("MissionDecision");

const Review = z
  .object({
    id: z.uuid(),
    missionId: z.uuid(),
    taskId: z.string().nullable(),
    messageId: z.string().nullable(),
    title: z.string(),
    summary: z.string(),
    prUrl: z.string().nullable(),
    artifactIds: z.array(z.string()),
    status: z.enum(["pending", "approved", "changes_requested"]),
    note: z.string().nullable(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("MissionReview");

const Delivery = z
  .object({
    id: z.uuid(),
    missionId: z.uuid(),
    taskId: z.string().nullable(),
    messageId: z.string().nullable(),
    auto: z.boolean().openapi({ description: "Made by us: every plan item done and no complete_mission call." }),
    summary: z.string(),
    artifactIds: z.array(z.string()),
    paths: z.array(z.string()),
    checklist: z.array(z.object({ id: z.string(), text: z.string(), checkedBy: z.array(z.string()) })).openapi({
      description: '"O que conferir": each item with the people who checked it (each person checks alone).',
    }),
    status: z.enum(["pending", "accepted", "changes_requested", "superseded"]),
    note: z.string().nullable(),
    saveToWiki: z.boolean(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("MissionDelivery");

const Participants = z.object({
  owner: z.object({ userId: z.string(), name: z.string() }).nullable(),
  participants: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      role: z.enum(["decide", "comment"]),
      addedBy: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

const Task = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    machineId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.string().nullable(),
    missionId: z.string().nullable(),
    title: z.string(),
    executor: z.string(),
    status: z.enum(["queued", "running", "interrupted", "done", "failed", "canceled"]),
    exitCode: z.number().nullable(),
    seconds: z.number().nullable(),
    lastLine: z.string().nullable(),
    files: z.array(z.string()),
    prUrl: z.string().nullable().openapi({ description: "A pull request it opened." }),
    branch: z.string().nullable(),
    cwd: z.string().nullable(),
    mode: z.enum(["write", "read", "setup"]).nullable().openapi({
      description:
        "A mission task's kind: write (one at a time, ends in a commit), read (in parallel, read only), setup (prepares the copy of the project); null for other tasks. status queued = waiting its turn or a free slot.",
    }),
    startSha: z.string().nullable().openapi({ description: "A write item's HEAD when it started." }),
    endSha: z
      .string()
      .nullable()
      .openapi({ description: "Its HEAD after its commit at the end (equal to startSha: nothing changed)." }),
    resumedFromId: z.string().nullable(),
    resumedTaskId: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    lastEventAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("MachineTask");

const JoinRequest = z
  .object({
    id: z.uuid(),
    missionId: z.uuid(),
    userId: z.string(),
    name: z.string(),
    status: z.enum(["pending", "accepted", "declined"]),
    role: z.enum(["decide", "comment"]).nullable(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("MissionJoinRequest");

const EligibleAgent = z
  .object({
    agentId: z.uuid(),
    handle: z.string(),
    name: z.string(),
    eligible: z.boolean().openapi({ description: "It can run a mission for you." }),
    reason: z.enum(["no_computer", "exec_off", "runner_outdated", "not_in_audience"]).nullable().openapi({
      description: "Why not: no computer, commands off, an old runner, or it doesn't answer you.",
    }),
    canManage: z.boolean().openapi({ description: "You can choose its computer (an admin or its owner)." }),
    machine: z.object({ id: z.uuid(), name: z.string(), online: z.boolean() }).nullable(),
    ready: z.boolean(),
    executors: z.array(Executor).openapi({ description: 'Who can program on its computer ("Quem programa").' }),
    defaultExecutor: Executor.nullable(),
    codexTooOld: z.boolean().openapi({ description: "Codex is installed but too old for missions." }),
    commandApproval: CommandApproval.openapi({
      description: 'The autonomy its new missions start with ("Usar como padrão"; default low_risk_auto).',
    }),
  })
  .openapi("MissionEligibleAgent");

const Counts = z.object({ active: z.number(), waitingYou: z.number(), closed: z.number() });

const MissionParams = OrgParams.extend({ missionId: z.uuid() });
const ThreadParams = OrgParams.extend({ threadId: z.uuid() });
const Empty = body(z.object({}).openapi({ description: "Send `{}`." }));

/**
 * Missions (ADR 0029): long work driven by the executor on a connected
 * computer, in one thread. Everyone who reads the home conversation sees a
 * mission; its owner and those who can decide act (start, pause, stop,
 * decide, review, accept suggestions); its owner and admins close it and
 * change who takes part. The web composer's commands call these: `/mission`
 * (create), `/stop`, `/pause` (and resume), `/summary`, `/plan`.
 */
export function missionRoutes(deps: AppDeps) {
  const { db, adapters, config } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const missions = (): MissionDeps => ({
    db,
    pubsub: adapters.pubsub,
    hub: deps.extras?.sandbox?.machines?.hub ?? null,
    artifacts: deps.extras?.artifacts,
    search: deps.extras?.context,
    publicUrl: config.PUBLIC_URL,
    judge: deps.extras?.context?.judge,
  });
  const after = <T>(value: T) => {
    deps.wakeWorkers?.();
    return value;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions",
      tags,
      security,
      summary:
        "Missions you can see (the Threads page's Missions tab), most recently changed first; `counts` (same filters, any status) for the tabs and the sidebar",
      request: {
        params: OrgParams,
        query: z.object({
          status: z
            .enum([
              "open",
              "closed",
              "waiting_you",
              "proposed",
              "active",
              "paused",
              "done",
              "canceled",
              "awaiting_close",
            ])
            .optional(),
          channelId: z.uuid().optional(),
          agentId: z.uuid().optional(),
          q: z.string().max(200).optional().openapi({ description: "Words of the title or the goal." }),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: { 200: json(z.object({ missions: z.array(Mission), counts: Counts })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await listMissions(missions(), c.get("user").id, orgId, c.req.valid("query")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/eligible-agents",
      tags,
      security,
      summary:
        '"Nova missão": every agent, eligible ones first, each saying whether it can run a mission for you (a connected computer with commands on and a recent runner; you can talk to it) and why not',
      request: { params: OrgParams },
      responses: { 200: json(z.object({ agents: z.array(EligibleAgent) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ agents: await eligibleMissionAgents(missions(), c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions",
      tags,
      security,
      summary: "`/mission <goal>`: the agent's executor plans it on its computer; a plan card with Start follows",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            agentId: z.uuid(),
            goal: z.string().min(1).max(2000),
            title: z.string().max(120).optional(),
            channelId: z.uuid().optional().openapi({ description: "Where it starts (a new thread there)." }),
            threadId: z.uuid().optional().openapi({ description: "Or the thread that becomes its home." }),
            folder: z.string().max(300).optional().openapi({
              description: "The repository on the computer, relative to the agent's folder.",
            }),
            executor: Executor.optional().openapi({
              description: "Default: Claude Code when the computer has it, else the agent itself.",
            }),
            commandApproval: CommandApproval.optional().openapi({ description: "Default: low_risk_auto." }),
          }),
        ),
      },
      responses: { 201: json(Mission, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { folder, ...input } = c.req.valid("json");
      const mission = await createMission(missions(), c.get("user").id, orgId, { ...input, repoDir: folder });
      return c.json(after(mission), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}",
      tags,
      security,
      summary: "One mission",
      request: { params: MissionParams },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await getMission(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/threads/{threadId}/mission",
      tags,
      security,
      summary: "The mission of a thread (404 `mission.not_found` when it has none)",
      request: { params: ThreadParams },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, threadId } = c.req.valid("param");
      return c.json(await getMissionByThread(missions(), c.get("user").id, orgId, threadId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/threads/{threadId}/tasks",
      tags,
      security,
      summary: "The background tasks of a thread (newest first); live changes come as `machine.task` events",
      request: { params: ThreadParams },
      responses: { 200: json(z.object({ tasks: z.array(Task) })), ...errors },
    }),
    async (c) => {
      const { orgId, threadId } = c.req.valid("param");
      const rows = await listThreadMachineTasks(missions(), c.get("user").id, orgId, threadId);
      return c.json({ tasks: rows.map(machineTaskView) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/tasks/{taskId}/output",
      tags,
      security,
      summary:
        '"Ver saída": the last lines of a background task (from the computer when it is online, else the lines we kept); anyone who reads its conversation',
      request: {
        params: OrgParams.extend({ taskId: z.uuid() }),
        query: z.object({ tail: z.coerce.number().int().min(1).max(200).optional() }),
      },
      responses: {
        200: json(
          z.object({
            taskId: z.uuid(),
            status: Task.shape.status,
            source: z.enum(["computer", "saved"]),
            lines: z.array(z.string()),
            truncated: z.boolean(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, taskId } = c.req.valid("param");
      return c.json(await getTaskOutput(missions(), c.get("user").id, orgId, taskId, c.req.valid("query")), 200);
    },
  );

  const controls = [
    ["start", startMission, "Start (only its owner): the plan is approved and the work begins"],
    ["pause", pauseMission, "`/pause`: no new work starts for it"],
    ["resume", resumeMission, "Resume a paused mission (queued messages go out)"],
  ] as const;
  for (const [action, run, summary] of controls) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/missions/{missionId}/${action}`,
        tags,
        security,
        summary,
        request: { params: MissionParams, body: Empty },
        responses: { 200: json(Mission), ...errors },
      }),
      async (c) => {
        const { orgId, missionId } = c.req.valid("param");
        return c.json(after(await run(missions(), c.get("user").id, orgId, missionId)), 200);
      },
    );
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/stop",
      tags,
      security,
      summary: "`/stop`: its running tasks are canceled and it pauses",
      request: { params: MissionParams, body: Empty },
      responses: { 200: json(Mission.extend({ canceledTasks: z.number() })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(after(await stopMission(missions(), c.get("user").id, orgId, missionId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/close",
      tags,
      security,
      summary: "Close as done or canceled (its owner or an admin); optionally save decisions and lessons to the wiki",
      request: {
        params: MissionParams,
        body: body(
          z.object({
            outcome: z.enum(["done", "canceled"]),
            saveToWiki: z.boolean().optional(),
            note: z.string().max(500).optional(),
            deleteBranch: z.boolean().optional().openapi({
              description:
                'Canceled only: also delete the mission\'s branch ("apagar tudo"); by default the branch stays and only its copy of the project goes away.',
            }),
          }),
        ),
      },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(
        after(await closeMission(missions(), c.get("user").id, orgId, missionId, c.req.valid("json"))),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/worktree/retry",
      tags,
      security,
      summary:
        '"Tentar de novo" (owner or deciders): the copy of the project is made or prepared again after a failure, and the mission resumes (mission.worktree_not_failed unless it failed)',
      request: { params: MissionParams, body: Empty },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(after(await retryMissionWorktree(missions(), c.get("user").id, orgId, missionId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/messages",
      tags,
      security,
      summary: "Send something to the executor's main session (\"Mudar algo\"); queued when it can't hear now",
      request: { params: MissionParams, body: body(z.object({ text: z.string().min(1).max(8000) })) },
      responses: { 200: json(z.object({ delivered: z.boolean(), taskId: z.string().optional() })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      const out = await sendMissionMessage(missions(), c.get("user").id, orgId, missionId, c.req.valid("json").text);
      return c.json(after(out), 200);
    },
  );

  // ── Participants and ownership ─────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/participants",
      tags,
      security,
      summary: "Its owner and who can decide or comment",
      request: { params: MissionParams },
      responses: { 200: json(Participants), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await listParticipants(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/participants",
      tags,
      security,
      summary: '"Compartilhar missão": add someone who reads its conversation, with a role',
      request: {
        params: MissionParams,
        body: body(z.object({ userId: z.string().min(1).max(200), role: z.enum(["decide", "comment"]) })),
      },
      responses: { 200: json(Participants), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await setParticipant(missions(), c.get("user").id, orgId, missionId, c.req.valid("json")), 200);
    },
  );

  const ParticipantParams = MissionParams.extend({ userId: z.string().min(1).max(200) });
  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/missions/{missionId}/participants/{userId}",
      tags,
      security,
      summary: "Change someone's role",
      request: { params: ParticipantParams, body: body(z.object({ role: z.enum(["decide", "comment"]) })) },
      responses: { 200: json(Participants), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, userId } = c.req.valid("param");
      const out = await setParticipant(missions(), c.get("user").id, orgId, missionId, {
        userId,
        role: c.req.valid("json").role,
      });
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/missions/{missionId}/participants/{userId}",
      tags,
      security,
      summary: "Remove someone (or leave it yourself)",
      request: { params: ParticipantParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, missionId, userId } = c.req.valid("param");
      await removeParticipant(missions(), c.get("user").id, orgId, missionId, userId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/join-requests",
      tags,
      security,
      summary: "Requests to join waiting for an answer (the owner and deciders see all; others their own)",
      request: { params: MissionParams },
      responses: { 200: json(z.object({ requests: z.array(JoinRequest) })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json({ requests: await listJoinRequests(missions(), c.get("user").id, orgId, missionId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/join-requests",
      tags,
      security,
      summary:
        '"Pedir para participar": someone who sees it and takes no part asks to join (the owner and deciders are told; nothing is posted)',
      request: { params: MissionParams, body: Empty },
      responses: { 200: json(JoinRequest), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await requestToJoin(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  const JoinParams = MissionParams.extend({ userId: z.string().min(1).max(200) });
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/join-requests/{userId}/accept",
      tags,
      security,
      summary: "Accept a request to join with a role (owner or deciders)",
      request: { params: JoinParams, body: body(z.object({ role: z.enum(["decide", "comment"]) })) },
      responses: { 200: json(JoinRequest), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, userId } = c.req.valid("param");
      const out = await decideJoinRequest(missions(), c.get("user").id, orgId, missionId, userId, {
        outcome: "accepted",
        role: c.req.valid("json").role,
      });
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/join-requests/{userId}/decline",
      tags,
      security,
      summary: "Decline a request to join (owner or deciders)",
      request: { params: JoinParams, body: Empty },
      responses: { 200: json(JoinRequest), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, userId } = c.req.valid("param");
      const out = await decideJoinRequest(missions(), c.get("user").id, orgId, missionId, userId, {
        outcome: "declined",
      });
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/transfer",
      tags,
      security,
      summary:
        "Hand it over. The computer doesn't move: the new owner's own machine, the previous owner lending theirs (`lendMachine`), or it pauses with `code: mission.needs_computer`",
      request: {
        params: MissionParams,
        body: body(z.object({ userId: z.string().min(1).max(200), lendMachine: z.boolean().optional() })),
      },
      responses: { 200: json(Mission.extend({ code: z.string().optional() })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await transferMission(missions(), c.get("user").id, orgId, missionId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/missions/{missionId}/machine",
      tags,
      security,
      summary:
        "Its owner points it at a computer they paired (new sessions start from the mission files). Refused (409 `mission.tasks_live`) while any of its tasks is running or queued: stop them first. The old computer's copy is removed in the background; when it is away, `code: mission.old_copy_left` and `oldComputer` say the copy stays there",
      request: {
        params: MissionParams,
        body: body(z.object({ machineId: z.uuid(), repoDir: z.string().max(300).optional() })),
      },
      responses: {
        200: json(Mission.extend({ code: z.string().optional(), oldComputer: z.string().optional() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await setMissionMachine(missions(), c.get("user").id, orgId, missionId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/missions/{missionId}/executor",
      tags,
      security,
      summary: "Before Start, its owner switches who programs (the planning starts again with it)",
      request: { params: MissionParams, body: body(z.object({ executor: Executor })) },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      const view = await setMissionExecutor(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        c.req.valid("json").executor,
      );
      return c.json(after(view), 200);
    },
  );

  // ── Decisions, reviews, suggestions ─────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/decisions",
      tags,
      security,
      summary: "Its decisions, newest first",
      request: { params: MissionParams },
      responses: { 200: json(z.object({ decisions: z.array(Decision) })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json({ decisions: await listDecisions(missions(), c.get("user").id, orgId, missionId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/decisions/approve-provisional",
      tags,
      security,
      summary: "Take every provisional decision as the executor went with it",
      request: { params: MissionParams, body: Empty },
      responses: { 200: json(z.object({ decisions: z.array(Decision) })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      const decisions = await approveProvisionalDecisions(missions(), c.get("user").id, orgId, missionId);
      return c.json({ decisions }, 200);
    },
  );

  const Command = z
    .object({
      id: z.uuid(),
      missionId: z.uuid(),
      taskId: z.string(),
      tool: z.string(),
      command: z.string(),
      state: z.enum(["pending", "allowed", "denied", "expired"]),
      rules: z.array(z.string()).openapi({ description: '"Aprovar sempre": the rules it adds (`Bash(swift *)`).' }),
      decidedBy: z.string().nullable(),
      decidedAt: z.string().nullable(),
      always: z.boolean(),
      agentKind: z.string().nullable().openapi({
        description: '"Aprovar sempre para o agente" is offered: the kind of command it keeps (`gh issue create`).',
      }),
      forAgent: z.boolean(),
      createdAt: z.string(),
      expiresAt: z.string(),
    })
    .openapi("MissionCommand");

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/commands",
      tags,
      security,
      summary:
        "Commands the executor asked to run (Claude Code's permission prompts), newest first, and the commands allowed for the whole mission",
      request: { params: MissionParams },
      responses: {
        200: json(z.object({ commands: z.array(Command), rules: z.array(z.string()) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await listMissionCommands(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  const CommandParams = MissionParams.extend({ commandId: z.uuid() });
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/commands/{commandId}/decide",
      tags,
      security,
      summary:
        "Aprovar / Recusar / Aprovar sempre nesta missão (owner or deciders) / Aprovar sempre para o agente (`agent`: its owner or an admin); the waiting executor gets the answer within seconds",
      request: {
        params: CommandParams,
        body: body(z.object({ decision: z.enum(["allow", "deny", "always", "agent"]) })),
      },
      responses: { 200: json(Command), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, commandId } = c.req.valid("param");
      const out = await decideCommand(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        commandId,
        c.req.valid("json").decision,
      );
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/commands/retry",
      tags,
      security,
      summary:
        '"Liberar e repetir": commands a task was refused become allowed for the mission and its session is resumed once to retry them (mission.paused while paused, mission.closed once closed)',
      request: {
        params: MissionParams,
        body: body(
          z
            .object({
              taskId: z.uuid(),
              command: z.string().min(1).max(1000).optional(),
              commands: z
                .array(z.string().min(1).max(1000))
                .min(1)
                .max(20)
                .optional()
                .openapi({ description: "Several blocked commands of the task at once (one resume)." }),
            })
            .refine((v) => Boolean(v.command || v.commands?.length), { message: "command or commands" }),
        ),
      },
      responses: {
        200: json(z.object({ rules: z.array(z.string()), delivered: z.boolean() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      const out = await retryBlockedCommand(missions(), c.get("user").id, orgId, missionId, c.req.valid("json"));
      return c.json(after(out), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/missions/{missionId}/command-approval",
      tags,
      security,
      summary:
        '"Pedir aprovação de comandos" (owner or deciders; Revogar on an automatic approval sets always). Audited.',
      request: { params: MissionParams, body: body(z.object({ commandApproval: CommandApproval })) },
      responses: { 200: json(z.object({ commandApproval: CommandApproval })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      const out = await setCommandApproval(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        c.req.valid("json").commandApproval,
      );
      return c.json(after(out), 200);
    },
  );

  // ── Configurações da missão ─────────────────────────────────────────────────

  const Rule = z
    .object({
      id: z.uuid().openapi({ description: "The rule's id (remove it with DELETE …/command-rules/{ruleId})." }),
      rule: z.string().openapi({ description: "`Bash(swift build *)`." }),
      by: z.string().nullable().openapi({ description: "Who allowed it (user id)." }),
      createdAt: z.string(),
    })
    .openapi("MissionCommandRule");

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/settings",
      tags,
      security,
      summary:
        '"Configurações da missão": the rules allowed for the whole mission, what happened to its commands (allowed automatically, asked, blocked) and the agent\'s default autonomy for new missions',
      request: { params: MissionParams },
      responses: {
        200: json(
          z
            .object({
              missionId: z.uuid(),
              rules: z.array(Rule),
              stats: z.object({ auto: z.number(), asked: z.number(), blocked: z.number() }),
              agentDefault: z.object({
                commandApproval: CommandApproval,
                canSet: z.boolean().openapi({ description: "You can change it (an admin or the agent's owner)." }),
                ownerId: z.string().nullable(),
              }),
            })
            .openapi("MissionSettings"),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await getMissionSettings(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/brain",
      tags,
      security,
      summary:
        "Who does the work (ADR 0032): the mission's brain and model (its override, or what its executor and the agent use) and what its computer offers",
      request: { params: MissionParams },
      responses: { 200: json(MissionBrain), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await getMissionBrain(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/missions/{missionId}/brain",
      tags,
      security,
      summary:
        "Override the brain (before Start) or its model (any time while open); the owner or someone who decides; audited",
      request: {
        params: MissionParams,
        body: body(
          z.object({
            brain: BrainKind.nullable().optional().openapi({ description: "Null = from the executor." }),
            model: z.string().max(80).nullable().optional().openapi({ description: "Null = the default." }),
          }),
        ),
      },
      responses: { 200: json(MissionBrain), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await setMissionBrain(missions(), c.get("user").id, orgId, missionId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/missions/{missionId}/command-rules/{ruleId}",
      tags,
      security,
      summary:
        "Take back a command allowed for the whole mission (owner or deciders): it asks again; the computer gets the new list with its next task. Audited.",
      request: { params: MissionParams.extend({ ruleId: z.uuid() }) },
      responses: { 200: json(z.object({ rules: z.array(Rule) })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, ruleId } = c.req.valid("param");
      return c.json(await removeCommandRule(missions(), c.get("user").id, orgId, missionId, ruleId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/missions/{missionId}",
      tags,
      security,
      summary:
        '"Se o computador desligar": resumeTasks (interrupted tasks start again by themselves when it comes back). Owner or deciders; audited.',
      request: { params: MissionParams, body: body(z.object({ resumeTasks: z.boolean() })) },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      const view = await setMissionResumeTasks(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        c.req.valid("json").resumeTasks,
      );
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/mission-command-approval",
      tags,
      security,
      summary:
        "\"Usar como padrão\": the autonomy the agent's next missions start with (current ones don't change). An admin or the agent's owner; audited.",
      request: {
        params: OrgParams.extend({ agentId: z.uuid() }),
        body: body(z.object({ commandApproval: CommandApproval })),
      },
      responses: { 200: json(z.object({ commandApproval: CommandApproval })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const out = await setAgentMissionApproval(
        missions(),
        c.get("user").id,
        orgId,
        agentId,
        c.req.valid("json").commandApproval,
      );
      return c.json(out, 200);
    },
  );

  const DecisionParams = MissionParams.extend({ decisionId: z.uuid() });
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/decisions/{decisionId}/choose",
      tags,
      security,
      summary: "Choose (owner or deciders): the session that asked is resumed with it",
      request: { params: DecisionParams, body: body(z.object({ option: z.string().min(1).max(200) })) },
      responses: { 200: json(Decision), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, decisionId } = c.req.valid("param");
      const out = await chooseDecision(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        decisionId,
        c.req.valid("json").option,
      );
      return c.json(after(out), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/decisions/{decisionId}/opinion",
      tags,
      security,
      summary: 'Give an opinion ("Ana prefere tabs"): anyone taking part, comment included; never decides',
      request: { params: DecisionParams, body: body(z.object({ option: z.string().min(1).max(200) })) },
      responses: { 200: json(Decision), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, decisionId } = c.req.valid("param");
      const out = await opineDecision(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        decisionId,
        c.req.valid("json").option,
      );
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/reviews",
      tags,
      security,
      summary: "Its reviews, newest first",
      request: { params: MissionParams },
      responses: { 200: json(z.object({ reviews: z.array(Review) })), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json({ reviews: await listReviews(missions(), c.get("user").id, orgId, missionId) }, 200);
    },
  );

  const ReviewParams = MissionParams.extend({ reviewId: z.uuid() });
  const reviewActions = [
    ["approve", "approved", z.object({ note: z.string().max(4000).optional() }), "Approve: the session goes on"],
    [
      "changes",
      "changes_requested",
      z.object({ note: z.string().min(1).max(4000) }),
      "Ask for changes (with a note): the session is resumed with it",
    ],
  ] as const;
  for (const [action, outcome, schema, summary] of reviewActions) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/missions/{missionId}/reviews/{reviewId}/${action}`,
        tags,
        security,
        summary,
        request: { params: ReviewParams, body: body(schema) },
        responses: { 200: json(Review), ...errors },
      }),
      async (c) => {
        const { orgId, missionId, reviewId } = c.req.valid("param");
        const { note } = c.req.valid("json") as { note?: string };
        const out = await decideReview(missions(), c.get("user").id, orgId, missionId, reviewId, { outcome, note });
        return c.json(after(out), 200);
      },
    );
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/deliveries",
      tags,
      security,
      summary: "Its delivery cards (complete_mission, or the automatic one when every item is done), newest first",
      request: { params: MissionParams },
      responses: { 200: json(z.array(Delivery)), ...errors },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await listDeliveries(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  const DeliveryParams = MissionParams.extend({ deliveryId: z.uuid() });
  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/missions/{missionId}/deliveries/{deliveryId}/checks/{itemId}",
      tags,
      security,
      summary: '"O que conferir": check or uncheck one item for yourself (owner or deciders)',
      request: {
        params: DeliveryParams.extend({ itemId: z.string().min(1).max(40) }),
        body: body(z.object({ checked: z.boolean() })),
      },
      responses: { 200: json(Delivery), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, deliveryId, itemId } = c.req.valid("param");
      const out = await checkDeliveryItem(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        deliveryId,
        itemId,
        c.req.valid("json").checked,
      );
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/deliveries/{deliveryId}/accept",
      tags,
      security,
      summary: '"Concluir missão" (owner or deciders): the mission closes as done, optionally its lessons in the wiki',
      request: { params: DeliveryParams, body: body(z.object({ saveToWiki: z.boolean().optional() })) },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, deliveryId } = c.req.valid("param");
      const out = await acceptDelivery(missions(), c.get("user").id, orgId, missionId, deliveryId, c.req.valid("json"));
      return c.json(after(out), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/missions/{missionId}/deliveries/{deliveryId}/changes",
      tags,
      security,
      summary: '"Pedir ajustes" (owner or deciders): the mission is active again and the note goes to its main session',
      request: { params: DeliveryParams, body: body(z.object({ note: z.string().min(1).max(4000) })) },
      responses: { 200: json(Mission), ...errors },
    }),
    async (c) => {
      const { orgId, missionId, deliveryId } = c.req.valid("param");
      const out = await requestDeliveryChanges(
        missions(),
        c.get("user").id,
        orgId,
        missionId,
        deliveryId,
        c.req.valid("json"),
      );
      return c.json(after(out), 200);
    },
  );

  const SuggestionParams = MissionParams.extend({ messageId: z.uuid() });
  for (const [action, outcome] of [
    ["accept", "accepted"],
    ["decline", "declined"],
  ] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/missions/{missionId}/suggestions/{messageId}/${action}`,
        tags,
        security,
        summary:
          action === "accept"
            ? "Accept a suggestion (owner or deciders): forwarded to the main session"
            : "Decline a suggestion",
        request: { params: SuggestionParams, body: Empty },
        responses: {
          200: json(z.object({ messageId: z.uuid(), status: z.enum(["accepted", "declined"]) })),
          ...errors,
        },
      }),
      async (c) => {
        const { orgId, missionId, messageId } = c.req.valid("param");
        const out = await decideSuggestion(missions(), c.get("user").id, orgId, missionId, messageId, outcome);
        return c.json(after(out), 200);
      },
    );
  }

  // ── Reading: files, summary, plan ───────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/files",
      tags,
      security,
      summary: "The `.agentes/` files (latest content) and the edits found on the machine",
      request: { params: MissionParams },
      responses: {
        200: json(
          z.object({
            files: z.array(
              z.object({
                name: z.string(),
                content: z.string().nullable(),
                source: z.string().nullable(),
                writtenAt: z.string().nullable(),
                updatedAt: z.string().nullable(),
              }),
            ),
            editedOnMachine: z.array(z.record(z.string(), z.unknown())),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await getMissionFiles(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/summary",
      tags,
      security,
      summary: "`/summary`: where it stands, from the database (no model)",
      request: { params: MissionParams },
      responses: {
        200: json(
          z.object({
            missionId: z.uuid(),
            text: z.string(),
            plan: z.object({ done: z.number(), total: z.number(), doing: z.number(), waiting: z.number() }),
            running: z.number(),
            pendingDecisions: z.number(),
            provisionalDecisions: z.number(),
            pendingReviews: z.number(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await missionSummary(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  const PlanVersion = z.object({
    version: z.number(),
    items: z.array(PlanItem),
    source: z.string(),
    taskId: z.string().nullable(),
    createdAt: z.string(),
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/missions/{missionId}/plan",
      tags,
      security,
      summary: "`/plan`: the latest version and the history",
      request: { params: MissionParams },
      responses: {
        200: json(z.object({ missionId: z.uuid(), current: PlanVersion.nullable(), history: z.array(PlanVersion) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, missionId } = c.req.valid("param");
      return c.json(await getMissionPlan(missions(), c.get("user").id, orgId, missionId), 200);
    },
  );

  return app;
}

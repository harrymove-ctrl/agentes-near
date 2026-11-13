/**
 * Test fake — missions (apps/server/src/routes/app/missions.ts). In-memory
 * missions per organization, empty unless a test creates one (`create`, or
 * `seedMission` from the returned helpers). Reads are not logged (cards read
 * them on every render); changes are.
 */
import type {
  ApiClient,
  BrainKind,
  BrainOption,
  CommandApproval,
  MachineTask,
  Mission,
  MissionBrain,
  MissionCommand,
  MissionDecision,
  MissionDelivery,
  MissionJoinRequest,
  MissionParticipants,
  MissionPlanVersion,
  MissionReview,
  MissionSettings,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { clone, type MockContext, mockId, perOrg } from "./context";

interface Store {
  missions: Mission[];
  tasks: MachineTask[];
  decisions: MissionDecision[];
  reviews: MissionReview[];
  plans: Map<string, MissionPlanVersion[]>;
  people: Map<string, MissionParticipants["participants"]>;
  files: Map<string, Record<string, string>>;
  joins: MissionJoinRequest[];
  /** What "Ver saída" answers, per task. */
  outputs: Map<string, string[]>;
  commands: MissionCommand[];
  rules: Map<string, string[]>;
  deliveries: MissionDelivery[];
  /** "Nesta missão: …" per mission (zeros unless a test sets them). */
  stats: Map<string, MissionSettings["stats"]>;
  /** "Usar como padrão" per agent. */
  agentDefaults: Map<string, CommandApproval>;
  /** "Quem faz o trabalho": the brain override and its model, per mission. */
  brains: Map<string, { brain: BrainKind | null; model: string | null }>;
}

export function createFakeMissions(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
): ApiClient["missions"] {
  const store = perOrg(
    async (): Promise<Store> => ({
      missions: [],
      tasks: [],
      decisions: [],
      reviews: [],
      plans: new Map(),
      people: new Map(),
      files: new Map(),
      joins: [],
      outputs: new Map(),
      commands: [],
      rules: new Map(),
      deliveries: [],
      stats: new Map(),
      agentDefaults: new Map(),
      brains: new Map(),
    }),
  );
  const find = async (orgId: string, missionId: string) => {
    const m = (await store(orgId)).missions.find((x) => x.id === missionId);
    if (!m) throw new ApiError(404, "mission.not_found", "Mission not found");
    return m;
  };
  const touch = (m: Mission, patch: Partial<Mission>) => Object.assign(m, patch);
  const participants = async (orgId: string, m: Mission): Promise<MissionParticipants> => {
    const me = await ctx.lookup.me();
    return {
      owner: m.ownerId ? { userId: m.ownerId, name: me?.user.id === m.ownerId ? me.user.name : "Owner" } : null,
      participants: clone((await store(orgId)).people.get(m.id) ?? []),
    };
  };
  return {
    list: async (orgId, query = {}) => {
      const open = (m: Mission) => ["proposed", "active", "paused", "awaiting_close"].includes(m.status);
      const waiting = (m: Mission) =>
        m.canAct &&
        m.plan.waiting +
          m.pending.decisions +
          m.pending.provisional +
          m.pending.reviews +
          m.pending.suggestions +
          m.pending.joinRequests +
          m.pending.commands >
          0;
      const q = query.q?.trim().toLowerCase();
      const scope = (await store(orgId)).missions.filter(
        (m) =>
          (!query.channelId || m.channelId === query.channelId) &&
          (!query.agentId || m.agentId === query.agentId) &&
          (!q || `${m.title} ${m.goal}`.toLowerCase().includes(q)),
      );
      const status = query.status;
      const missions = scope.filter((m) =>
        !status
          ? true
          : status === "open"
            ? open(m)
            : status === "closed"
              ? !open(m)
              : status === "waiting_you"
                ? open(m) && waiting(m)
                : m.status === status,
      );
      return clone({
        missions: missions.slice(0, query.limit ?? 50),
        counts: {
          active: scope.filter(open).length,
          waitingYou: scope.filter((m) => open(m) && waiting(m)).length,
          closed: scope.filter((m) => !open(m)).length,
        },
      });
    },
    eligibleAgents: async (orgId) => {
      const defaults = (await store(orgId)).agentDefaults;
      return (await ctx.lookup.agents(orgId)).map((a) => ({
        agentId: a.id,
        handle: a.handle,
        name: a.name,
        eligible: true,
        reason: null,
        canManage: true,
        machine: { id: "machine_1", name: "MacBook", online: true },
        ready: true,
        executors: ["claude", "codex", "agent"] as ("claude" | "codex" | "agent")[],
        defaultExecutor: "claude" as const,
        codexTooOld: false,
        commandApproval: defaults.get(a.id) ?? ("low_risk_auto" as const),
      }));
    },
    taskOutput: async (orgId, taskId) => {
      const s = await store(orgId);
      const task = s.tasks.find((x) => x.id === taskId);
      if (!task) throw new ApiError(404, "task.not_found", "Task not found");
      const lines = s.outputs.get(taskId) ?? (task.lastLine ? [task.lastLine] : []);
      return { taskId, status: task.status, source: "computer" as const, lines: clone(lines), truncated: false };
    },
    joinRequests: async (orgId, missionId) =>
      clone((await store(orgId)).joins.filter((j) => j.missionId === missionId && j.status === "pending")),
    requestJoin: async (orgId, missionId) => {
      log("missions.requestJoin", orgId, missionId);
      const m = await find(orgId, missionId);
      const me = await ctx.lookup.me();
      const s = await store(orgId);
      const userId = me?.user.id ?? "";
      const existing = s.joins.find((j) => j.missionId === missionId && j.userId === userId && j.status === "pending");
      if (existing) return clone(existing);
      const row: MissionJoinRequest = {
        id: mockId("join"),
        missionId,
        userId,
        name: me?.user.name ?? "",
        status: "pending",
        role: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: ctx.now().toISOString(),
      };
      s.joins.push(row);
      touch(m, { joinRequested: true });
      return clone(row);
    },
    decideJoin: async (orgId, missionId, userId, outcome, role) => {
      log("missions.decideJoin", orgId, missionId, userId, outcome, role);
      const m = await find(orgId, missionId);
      const s = await store(orgId);
      const row = s.joins.find((j) => j.missionId === missionId && j.userId === userId && j.status === "pending");
      if (!row) throw new ApiError(404, "mission.join_not_found", "No request to join from this person");
      Object.assign(row, {
        status: outcome === "accept" ? "accepted" : "declined",
        role: outcome === "accept" ? (role ?? "comment") : null,
        decidedAt: ctx.now().toISOString(),
      });
      if (outcome === "accept") {
        const list = s.people.get(m.id) ?? [];
        list.push({
          userId,
          name: row.name,
          role: role ?? "comment",
          addedBy: null,
          createdAt: ctx.now().toISOString(),
        });
        s.people.set(m.id, list);
      }
      touch(m, { pending: { ...m.pending, joinRequests: Math.max(0, m.pending.joinRequests - 1) } });
      return clone(row);
    },
    create: async (orgId, input) => {
      log("missions.create", orgId, input);
      const me = await ctx.lookup.me();
      const now = ctx.now().toISOString();
      const mission: Mission = {
        id: mockId("mission"),
        threadId: input.threadId ?? mockId("root"),
        channelId: input.channelId ?? (await ctx.lookup.channels(orgId))[0]?.id ?? "",
        agentId: input.agentId,
        ownerId: me?.user.id ?? null,
        executor: input.executor ?? "claude",
        title: input.title ?? input.goal.slice(0, 60),
        goal: input.goal,
        findings: [],
        openQuestion: null,
        status: "proposed",
        repoDir: input.folder ?? "",
        resumeTasks: true,
        commandApproval:
          input.commandApproval ?? (await store(orgId)).agentDefaults.get(input.agentId) ?? "low_risk_auto",
        plan: { version: 0, done: 0, total: 0, waiting: 0, doing: 0, items: [] },
        pending: { decisions: 0, provisional: 0, reviews: 0, suggestions: 0, joinRequests: 0, commands: 0 },
        joinRequested: false,
        runningTasks: 1,
        machine: {
          id: "machine_1",
          name: "MacBook",
          online: true,
          lentBy: null,
          executors: ["claude", "codex", "agent"],
          codexTooOld: false,
        },
        needsComputer: false,
        role: "owner",
        canAct: true,
        canManage: true,
        createdAt: now,
        startedAt: null,
        pausedAt: null,
        closedAt: null,
        closeReason: null,
        wikiPageId: null,
      };
      (await store(orgId)).missions.unshift(mission);
      return clone(mission);
    },
    get: async (orgId, missionId) => clone(await find(orgId, missionId)),
    ofThread: async (orgId, threadId) => {
      const m = (await store(orgId)).missions.find((x) => x.threadId === threadId);
      if (!m) throw new ApiError(404, "mission.not_found", "This thread has no mission");
      return clone(m);
    },
    threadTasks: async (orgId, threadId) => clone((await store(orgId)).tasks.filter((x) => x.threadId === threadId)),
    control: async (orgId, missionId, action) => {
      log("missions.control", orgId, missionId, action);
      const m = await find(orgId, missionId);
      const now = ctx.now().toISOString();
      if (action === "start") {
        if (m.role !== "owner") throw new ApiError(403, "mission.not_owner", "Only the mission's owner can start it");
        touch(m, { status: "active", startedAt: now });
      }
      if (action === "pause") touch(m, { status: "paused", pausedAt: now });
      if (action === "resume") touch(m, { status: "active", pausedAt: null });
      if (action === "stop") {
        const canceledTasks = m.runningTasks;
        touch(m, { status: "paused", pausedAt: now, runningTasks: 0 });
        return { ...clone(m), canceledTasks };
      }
      return clone(m);
    },
    close: async (orgId, missionId, input) => {
      log("missions.close", orgId, missionId, input);
      const m = await find(orgId, missionId);
      touch(m, { status: input.outcome, closedAt: ctx.now().toISOString(), runningTasks: 0 });
      return clone(m);
    },
    retryWorktree: async (orgId, missionId) => {
      log("missions.retryWorktree", orgId, missionId);
      const m = await find(orgId, missionId);
      touch(m, { worktreeState: "preparing", worktreeError: null });
      return clone(m);
    },
    message: async (orgId, missionId, text) => {
      log("missions.message", orgId, missionId, text);
      await find(orgId, missionId);
      return { delivered: true };
    },
    participants: async (orgId, missionId) => participants(orgId, await find(orgId, missionId)),
    setParticipant: async (orgId, missionId, userId, role) => {
      log("missions.setParticipant", orgId, missionId, userId, role);
      const m = await find(orgId, missionId);
      const s = await store(orgId);
      const list = s.people.get(m.id) ?? [];
      const member = (await ctx.lookup.members(orgId)).find((x) => x.userId === userId);
      const at = list.findIndex((p) => p.userId === userId);
      const row = { userId, name: member?.name ?? userId, role, addedBy: null, createdAt: ctx.now().toISOString() };
      if (at >= 0) list[at] = row;
      else list.push(row);
      s.people.set(m.id, list);
      return participants(orgId, m);
    },
    removeParticipant: async (orgId, missionId, userId) => {
      log("missions.removeParticipant", orgId, missionId, userId);
      const s = await store(orgId);
      s.people.set(
        missionId,
        (s.people.get(missionId) ?? []).filter((p) => p.userId !== userId),
      );
    },
    transfer: async (orgId, missionId, input) => {
      log("missions.transfer", orgId, missionId, input);
      const m = await find(orgId, missionId);
      touch(m, { ownerId: input.userId, role: "decide", canManage: false });
      return clone(m);
    },
    setExecutor: async (orgId, missionId, executor) => {
      log("missions.setExecutor", orgId, missionId, executor);
      const m = await find(orgId, missionId);
      if (m.status !== "proposed")
        throw new ApiError(409, "mission.wrong_status", "Who programs is chosen before Start");
      touch(m, { executor });
      const brains = (await store(orgId)).brains;
      const b = brains.get(missionId);
      if (b) brains.set(missionId, { ...b, model: null });
      return clone(m);
    },
    setCommandApproval: async (orgId, missionId, commandApproval) => {
      log("missions.setCommandApproval", orgId, missionId, commandApproval);
      const m = await find(orgId, missionId);
      if (!m.canAct) throw new ApiError(403, "mission.not_allowed", "Only the owner or a decider");
      touch(m, { commandApproval });
      return { commandApproval };
    },
    setMachine: async (orgId, missionId, machineId) => {
      log("missions.setMachine", orgId, missionId, machineId);
      const m = await find(orgId, missionId);
      touch(m, {
        machine: {
          id: machineId,
          name: "Computer",
          online: true,
          lentBy: null,
          executors: ["claude", "agent"],
          codexTooOld: false,
        },
        needsComputer: false,
      });
      return clone(m);
    },
    settings: async (orgId, missionId) => {
      const m = await find(orgId, missionId);
      const s = await store(orgId);
      const me = await ctx.lookup.me();
      return clone({
        missionId,
        rules: (s.rules.get(missionId) ?? []).map((rule) => ({
          id: `rule:${rule}`,
          rule,
          by: me?.user.id ?? null,
          createdAt: ctx.now().toISOString(),
        })),
        stats: s.stats.get(missionId) ?? { auto: 0, asked: 0, blocked: 0 },
        agentDefault: {
          commandApproval: s.agentDefaults.get(m.agentId) ?? "low_risk_auto",
          canSet: true,
          ownerId: me?.user.id ?? null,
        },
      });
    },
    brain: async (orgId, missionId) => brainView(await find(orgId, missionId), await store(orgId)),
    setBrain: async (orgId, missionId, input) => {
      log("missions.setBrain", orgId, missionId, input);
      const m = await find(orgId, missionId);
      if (!m.canAct) throw new ApiError(403, "mission.not_allowed", "Only the owner or a decider");
      const s = await store(orgId);
      const cur = s.brains.get(missionId) ?? { brain: null, model: null };
      const brain = input.brain === undefined ? cur.brain : input.brain;
      if (brain !== cur.brain && m.status !== "proposed")
        throw new ApiError(409, "mission.wrong_status", "Chosen before Start");
      s.brains.set(missionId, { brain, model: input.model !== undefined ? input.model : cur.model });
      return brainView(m, s);
    },
    removeCommandRule: async (orgId, missionId, ruleId) => {
      log("missions.removeCommandRule", orgId, missionId, ruleId);
      const m = await find(orgId, missionId);
      if (!m.canAct) throw new ApiError(403, "mission.not_allowed", "Only the owner or a decider");
      const s = await store(orgId);
      const list = s.rules.get(missionId) ?? [];
      const rule = ruleId.replace(/^rule:/, "");
      if (!list.includes(rule)) throw new ApiError(404, "mission.rule_not_found", "Not allowed in this mission");
      s.rules.set(
        missionId,
        list.filter((r) => r !== rule),
      );
      const me = await ctx.lookup.me();
      return clone({
        rules: (s.rules.get(missionId) ?? []).map((r) => ({
          id: `rule:${r}`,
          rule: r,
          by: me?.user.id ?? null,
          createdAt: ctx.now().toISOString(),
        })),
      });
    },
    setResumeTasks: async (orgId, missionId, resumeTasks) => {
      log("missions.setResumeTasks", orgId, missionId, resumeTasks);
      const m = await find(orgId, missionId);
      if (!m.canAct) throw new ApiError(403, "mission.not_allowed", "Only the owner or a decider");
      touch(m, { resumeTasks });
      return clone(m);
    },
    setAgentDefault: async (orgId, agentId, commandApproval) => {
      log("missions.setAgentDefault", orgId, agentId, commandApproval);
      (await store(orgId)).agentDefaults.set(agentId, commandApproval);
      return { commandApproval };
    },
    decisions: async (orgId, missionId) =>
      clone((await store(orgId)).decisions.filter((d) => d.missionId === missionId)),
    commands: async (orgId, missionId) => {
      const s = await store(orgId);
      return clone({
        commands: s.commands.filter((c) => c.missionId === missionId),
        rules: s.rules.get(missionId) ?? [],
      });
    },
    decideCommand: async (orgId, missionId, commandId, decision) => {
      log("missions.decideCommand", orgId, missionId, commandId, decision);
      const s = await store(orgId);
      const c = s.commands.find((x) => x.id === commandId && x.missionId === missionId);
      if (!c) throw new ApiError(404, "mission.command_not_found", "Command not found");
      if (c.state !== "pending") throw new ApiError(409, "mission.command_decided", "Already answered");
      const me = await ctx.lookup.me();
      Object.assign(c, {
        state: decision === "deny" ? "denied" : "allowed",
        always: decision === "always",
        decidedBy: me?.user.id ?? null,
        decidedAt: ctx.now().toISOString(),
      });
      if (decision === "always") s.rules.set(missionId, [...(s.rules.get(missionId) ?? []), ...c.rules]);
      return clone(c);
    },
    retryCommand: async (orgId, missionId, input) => {
      log("missions.retryCommand", orgId, missionId, input);
      const m = await find(orgId, missionId);
      if (m.status === "paused") throw new ApiError(409, "mission.paused", "The mission is paused");
      if (m.status === "done" || m.status === "canceled") throw new ApiError(409, "mission.closed", "Closed");
      const list = input.commands ?? (input.command ? [input.command] : []);
      const rules = [...new Set(list.map((c) => `Bash(${c.split(" ")[0] ?? ""} *)`))];
      const s = await store(orgId);
      s.rules.set(missionId, [...(s.rules.get(missionId) ?? []), ...rules]);
      return { rules, delivered: true };
    },
    deliveries: async (orgId, missionId) =>
      clone((await store(orgId)).deliveries.filter((d) => d.missionId === missionId).reverse()),
    checkDelivery: async (orgId, missionId, deliveryId, itemId, checked) => {
      log("missions.checkDelivery", orgId, missionId, deliveryId, itemId, checked);
      const d = (await store(orgId)).deliveries.find((x) => x.id === deliveryId && x.missionId === missionId);
      const item = d?.checklist.find((c) => c.id === itemId);
      if (!d || !item) throw new ApiError(404, "mission.delivery_item_not_found", "Not found");
      const me = (await ctx.lookup.me())?.user.id ?? "";
      item.checkedBy = checked ? [...new Set([...item.checkedBy, me])] : item.checkedBy.filter((u) => u !== me);
      return clone(d);
    },
    acceptDelivery: async (orgId, missionId, deliveryId, input) => {
      log("missions.acceptDelivery", orgId, missionId, deliveryId, input);
      const m = await find(orgId, missionId);
      const d = (await store(orgId)).deliveries.find((x) => x.id === deliveryId);
      if (!d) throw new ApiError(404, "mission.delivery_not_found", "Not found");
      if (d.status !== "pending") throw new ApiError(409, "mission.delivery_decided", "Already answered");
      const me = await ctx.lookup.me();
      Object.assign(d, {
        status: "accepted",
        saveToWiki: Boolean(input.saveToWiki),
        decidedBy: me?.user.id ?? null,
        decidedAt: ctx.now().toISOString(),
      });
      touch(m, { status: "done", pending: { ...m.pending, deliveries: 0 } });
      return clone(m);
    },
    requestDeliveryChanges: async (orgId, missionId, deliveryId, note) => {
      log("missions.requestDeliveryChanges", orgId, missionId, deliveryId, note);
      const m = await find(orgId, missionId);
      const d = (await store(orgId)).deliveries.find((x) => x.id === deliveryId);
      if (!d) throw new ApiError(404, "mission.delivery_not_found", "Not found");
      if (!note.trim()) throw new ApiError(400, "mission.delivery_note_required", "A note is required");
      const me = await ctx.lookup.me();
      Object.assign(d, {
        status: "changes_requested",
        note,
        decidedBy: me?.user.id ?? null,
        decidedAt: ctx.now().toISOString(),
      });
      touch(m, { status: "active", pending: { ...m.pending, deliveries: 0 } });
      return clone(m);
    },
    choose: async (orgId, missionId, decisionId, option) => {
      log("missions.choose", orgId, missionId, decisionId, option);
      const d = (await store(orgId)).decisions.find((x) => x.id === decisionId);
      if (!d) throw new ApiError(404, "mission.decision_not_found", "Decision not found");
      const me = await ctx.lookup.me();
      Object.assign(d, {
        status: "taken",
        chosen: option,
        chosenBy: me?.user.id ?? null,
        chosenAt: ctx.now().toISOString(),
      });
      return clone(d);
    },
    opinion: async (orgId, missionId, decisionId, option) => {
      log("missions.opinion", orgId, missionId, decisionId, option);
      const d = (await store(orgId)).decisions.find((x) => x.id === decisionId);
      if (!d) throw new ApiError(404, "mission.decision_not_found", "Decision not found");
      const me = await ctx.lookup.me();
      d.opinions = [
        ...d.opinions.filter((o) => o.userId !== me?.user.id),
        { userId: me?.user.id ?? "", option, at: ctx.now().toISOString() },
      ];
      return clone(d);
    },
    approveProvisional: async (orgId, missionId) => {
      log("missions.approveProvisional", orgId, missionId);
      const list = (await store(orgId)).decisions.filter(
        (d) => d.missionId === missionId && d.status === "provisional",
      );
      for (const d of list) d.status = "taken";
      return clone(list);
    },
    reviews: async (orgId, missionId) => clone((await store(orgId)).reviews.filter((r) => r.missionId === missionId)),
    review: async (orgId, missionId, reviewId, outcome, note) => {
      log("missions.review", orgId, missionId, reviewId, outcome, note);
      const r = (await store(orgId)).reviews.find((x) => x.id === reviewId);
      if (!r) throw new ApiError(404, "mission.review_not_found", "Review not found");
      Object.assign(r, {
        status: outcome === "approve" ? "approved" : "changes_requested",
        note: note ?? null,
        decidedAt: ctx.now().toISOString(),
      });
      return clone(r);
    },
    suggestion: async (orgId, missionId, messageId, outcome) => {
      log("missions.suggestion", orgId, missionId, messageId, outcome);
      return { messageId, status: outcome === "accept" ? "accepted" : "declined" };
    },
    files: async (orgId, missionId) => {
      const f = (await store(orgId)).files.get(missionId) ?? {};
      return {
        files: ["mission.md", "decisions.md", "notes.md"].map((name) => ({
          name,
          content: f[name] ?? null,
          source: "server",
          writtenAt: null,
          updatedAt: null,
        })),
        editedOnMachine: [],
      };
    },
    summary: async (orgId, missionId) => {
      const m = await find(orgId, missionId);
      return {
        missionId,
        text: "",
        plan: { done: m.plan.done, total: m.plan.total, doing: 0, waiting: m.plan.waiting },
        running: m.runningTasks,
        pendingDecisions: m.pending.decisions,
        provisionalDecisions: m.pending.provisional,
        pendingReviews: m.pending.reviews,
      };
    },
    plan: async (orgId, missionId) => {
      const history = clone((await store(orgId)).plans.get(missionId) ?? []);
      return { missionId, current: history[0] ?? null, history };
    },
  };
}

const FAKE_BRAIN_OPTIONS: BrainOption[] = [
  { kind: "model", available: true, models: [], defaultModel: null },
  {
    kind: "claude_code",
    available: true,

    models: [
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet", recommended: true },
      { value: "haiku", label: "Haiku" },
    ],
    defaultModel: "sonnet",
  },
  {
    kind: "codex",
    available: true,

    models: [
      { value: "gpt-6-sol", label: "GPT-6 Sol", recommended: true },
      { value: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
    defaultModel: "gpt-6-sol",
  },
];

function brainView(m: Mission, s: Store): MissionBrain {
  const cur = s.brains.get(m.id) ?? { brain: null, model: null };
  const effectiveBrain: BrainKind =
    cur.brain ?? (m.executor === "codex" ? "codex" : m.executor === "agent" ? "model" : "claude_code");
  const option = FAKE_BRAIN_OPTIONS.find((o) => o.kind === effectiveBrain);
  return clone({
    missionId: m.id,
    brain: cur.brain,
    model: cur.model,
    effectiveBrain,
    effectiveModel: effectiveBrain === "model" ? null : (cur.model ?? option?.defaultModel ?? null),
    options: FAKE_BRAIN_OPTIONS,
    canSetBrain: m.canAct && m.status === "proposed",
    canSetModel: m.canAct,
  });
}

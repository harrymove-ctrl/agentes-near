import {
  allowedBy,
  type CommandScope,
  commandKind,
  commandOf,
  deniedMessage,
  forbiddenCode,
  forbiddenHint,
  forbiddenReason,
  inlineCodeCall,
  NO_TERMINAL_COMMANDS,
  outboundCallProblem,
  PERMISSION_TIMEOUT_MESSAGE,
  PERMISSION_WAIT_MS,
  readOnlyCall,
  rulesFor,
  SECRET_MESSAGE,
  secretRead,
  TASK_LIMITS,
} from "@agenteschat/adapters";
import { type Executor, rowsOf, schema, sql } from "@agenteschat/db";
import { getAgent } from "./agents";
import { addApprovalRules, COMMAND_RULE_TOOL, coveringRules, decidesAgentApprovals } from "./approval-rules";
import { recordAudit } from "./audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated, publishUserEvent } from "./events";
import { cutText } from "./format";
import type { MachineTaskRow } from "./machine-tasks";
import { messageView } from "./messages";
import { addMissionAllowRules, blockedOfTask, missionAllowRules } from "./mission-command-rules";
import {
  type CommandApproval,
  commandApprovalOf,
  isCommandApproval,
  latestPlan,
  type MissionDeps,
  type MissionRow,
  missionAnswerers,
  noMentions,
  postMissionMessage,
  publishMissionEvent,
  recordMissionEvent,
  requireAct,
  requireMission,
  requireOpen,
  tellSession,
} from "./missions";

const { missionEvents, machineTasks } = schema;

/**
 * Command approvals (ADR 0029): Claude Code asks our MCP tool
 * (`--permission-prompt-tool`) when a work turn wants to run a command off
 * its allow list. A mission rule ("Aprovar sempre nesta missão") allows it
 * at once; otherwise the command card goes to the thread and the runner asks
 * again every few seconds until the owner or someone who decides answers
 * (Aprovar / Recusar / Aprovar sempre), or `PERMISSION_WAIT_MS` passes.
 * Deny-list commands (merges, deploys, publishing) never get here: Claude
 * Code and the runner refuse them first (and so do we). Pushes the runner
 * reads with git first: one to the default branch or a force push to someone
 * else's branch is refused there, so a push that gets here is ordinary work.
 * Everything is in the mission's feed: `command_prompt`, `command_decided`,
 * `command_rule`, `command_auto`, `command_approval`.
 *
 * The order for a new prompt: the deny list (refused, never judged) → plain
 * reads (`readOnlyCall`, allowed silently) → the mission's rules → the
 * mission's `commandApproval`: `never` allows the rest; `low_risk_auto`
 * asks the judge whether it is low risk, and allows it at
 * `LOW_RISK_THRESHOLD` or more only when code allows it too
 * (`forbiddenReason`: no sudo, no deletes or writes outside the mission
 * folder, no uploads, remote shells or global installs). A judge error or
 * timeout means the card (fail closed). Every automatic approval posts one
 * quiet line in the thread, with Revogar (back to `always`).
 *
 * This is the one place a judge's answer lets something run (ADR 0029): the
 * owner chose the policy for the mission; the judge only classifies inside
 * what code allows, and the deny list and code rules stay hard.
 */

/** `always`: for the rest of the mission (its rules); `agent`: this kind of command for the agent, for good. */
export type CommandDecision = "allow" | "deny" | "always" | "agent";
export type CommandState = "pending" | "allowed" | "denied" | "expired";

/** Prompts per task in 10 minutes: a loop can't flood the thread. */
export const COMMAND_PROMPTS_PER_TASK = 30;
/** `low_risk_auto`: the judge's probability that a command is low risk and needed, to allow it without a card. */
export const LOW_RISK_THRESHOLD = 0.85;
/** The judge answers within this, or it is the card. */
export const COMMAND_JUDGE_TIMEOUT_MS = 8000;

/** Where the task runs, from the runner (absolute paths only); without it code allows no writes. */
function scopeOf(value: unknown): CommandScope | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const abs = (p: unknown): p is string => typeof p === "string" && p.startsWith("/") && p.length < 1000;
  if (!abs(v.cwd)) return null;
  const folders = Array.isArray(v.folders) ? v.folders.filter(abs).slice(0, 4) : [];
  return {
    cwd: v.cwd,
    folders: folders.length ? folders : [v.cwd],
    ...(abs(v.home) ? { home: v.home } : {}),
    ...(abs(v.runnerHome) ? { runnerHome: v.runnerHome } : {}),
  };
}
const NO_SCOPE: CommandScope = { cwd: "/nonexistent", folders: [] };

/**
 * The judge's question for `low_risk_auto`: is this command low risk and
 * needed for the work? A probability; null when the judge fails or is slow.
 */
export async function commandLowRisk(
  deps: Pick<MissionDeps, "db" | "judge">,
  mission: MissionRow,
  call: { tool: string; command: string },
): Promise<number | null> {
  if (!deps.judge) return null;
  const plan = await latestPlan(deps.db, mission.id).catch(() => null);
  const items = Array.isArray(plan?.items) ? plan.items : [];
  const current = items.find((i) => i.status === "doing") ?? items.find((i) => i.status === "todo");
  const ask = deps.judge.ask({
    orgId: mission.orgId,
    agentId: mission.agentId,
    kind: "mission_command_risk",
    state: {
      tool: call.tool,
      command: cutText(call.command, 2000),
      mission_goal: cutText(mission.goal, 2000),
      current_plan_item: current?.title ?? null,
    },
    questions: {
      low_risk: {
        type: "noul",
        instructions:
          "An AI coding agent working on `mission_goal` (now on `current_plan_item`) wants to run `command` with `tool` on a person's computer, inside the mission folder. Is running it low risk (no data loss outside the mission folder, no publishing, deploying or sending anything, no credential exposure, no system changes) and needed for the work?",
        criteria: {
          true: "Low risk and plausibly needed for the mission's work.",
          false:
            "It could lose data, publish, deploy or send something, expose credentials, change the system, or isn't needed.",
        },
      },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), COMMAND_JUDGE_TIMEOUT_MS);
  });
  try {
    const answers = await Promise.race([ask, timeout]);
    const p = answers?.low_risk?.noul;
    return typeof p === "number" && Number.isFinite(p) ? p : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** One quiet line in the thread for a command allowed without a card ("Aprovado automaticamente"). */
async function autoApproved(
  deps: MissionDeps,
  mission: MissionRow,
  task: PromptAsker,
  call: { tool: string; command: string },
  reason: "low_risk" | "never",
  probability: number | null,
) {
  const shown = cutText(noMentions(call.command), TASK_LIMITS.denial * 2);
  const rules = rulesFor(call.tool, call.tool === "Bash" ? { command: call.command } : {});
  await recordMissionEvent(deps.db, mission, "command_auto", {
    taskId: task.id,
    tool: call.tool,
    command: shown,
    reason,
    ...(probability !== null ? { probability } : {}),
  });
  await recordAudit(deps.db, {
    orgId: mission.orgId,
    actor: { type: "agent", id: mission.agentId },
    action: "mission.command_auto",
    target: { type: "mission", id: mission.id },
    details: { taskId: task.id, command: cutText(shown, 300), reason, probability },
  });
  await postMissionMessage(
    deps,
    mission,
    `Allowed automatically: \`${shown}\` (${reason === "never" ? "no approval asked" : "low risk"})`,
    {
      missionAutoApproved: { missionId: mission.id, taskId: task.id, tool: call.tool, command: shown, reason, rules },
      bodyCode: "mission_auto_approved",
      bodyParams: { command: shown, reason },
    },
  );
}

export interface MissionCommandView {
  id: string;
  missionId: string;
  taskId: string;
  tool: string;
  command: string;
  state: CommandState;
  /** "Aprovar sempre": the rules it would add. */
  rules: string[];
  decidedBy: string | null;
  decidedAt: string | null;
  /** The person chose "Aprovar sempre". */
  always: boolean;
  /** "Aprovar sempre para o agente" is offered: the kind it keeps (`gh issue create`); null: not offered. */
  agentKind: string | null;
  /** The person chose it. */
  forAgent: boolean;
  createdAt: string;
  expiresAt: string;
}

interface PromptRow {
  kind: string;
  data: Record<string, unknown> | string;
  created_at: Date | string;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The mission's prompts with their state, newest first (or one, by id). */
async function readPrompts(db: Executor, missionId: string, promptId?: string): Promise<MissionCommandView[]> {
  const rows = rowsOf<PromptRow>(
    await db.execute(sql`select kind, data, created_at from ${missionEvents}
      where mission_id = ${missionId}::uuid and kind in ('command_prompt', 'command_decided')
        ${promptId ? sql`and data->>'promptId' = ${promptId}` : sql``}
      order by created_at
      limit 2000`),
  );
  const byId = new Map<string, MissionCommandView>();
  for (const r of rows) {
    const d = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
    const id = str(d.promptId);
    if (!id) continue;
    if (r.kind === "command_prompt") {
      const created = iso(r.created_at);
      byId.set(id, {
        id,
        missionId,
        taskId: str(d.taskId),
        tool: str(d.tool),
        command: str(d.command),
        state: "pending",
        rules: Array.isArray(d.rules) ? d.rules.map(String) : [],
        decidedBy: null,
        decidedAt: null,
        always: false,
        agentKind: str(d.agentKind) || null,
        forAgent: false,
        createdAt: created,
        expiresAt: new Date(Date.parse(created) + PERMISSION_WAIT_MS).toISOString(),
      });
      continue;
    }
    const p = byId.get(id);
    if (p?.state !== "pending") continue;
    const decision = str(d.decision);
    p.state = decision === "expired" ? "expired" : decision === "deny" ? "denied" : "allowed";
    p.always = decision === "always";
    p.forAgent = decision === "agent";
    p.decidedBy = str(d.by) || null;
    p.decidedAt = iso(r.created_at);
  }
  const now = Date.now();
  // Past its wait with nobody answering: expired (the runner stopped asking).
  for (const p of byId.values()) if (p.state === "pending" && Date.parse(p.expiresAt) <= now) p.state = "expired";
  return [...byId.values()].reverse();
}

/**
 * The owner and the deciders hear a command card opened or was answered
 * (`mission.needs_you { kind: command }`): their Aprovações page refreshes
 * even outside the mission's conversation.
 */
async function notifyCommand(deps: Pick<MissionDeps, "db" | "pubsub">, mission: MissionRow, promptId: string) {
  for (const userId of await missionAnswerers(deps.db, mission)) {
    await publishUserEvent(deps.pubsub, mission.orgId, userId, {
      type: "mission.needs_you",
      kind: "command",
      missionId: mission.id,
      threadId: mission.threadRootId,
      promptId,
    });
  }
}

const allow = () => JSON.stringify({ behavior: "allow" });
/** A refusal: its message is for the agent; its code, for the apps to say why in the person's words. */
const deny = (message: string, code: string) => JSON.stringify({ behavior: "deny", message, code });

/**
 * `permission_prompt` from the runner: a new prompt (`tool_name`, `input`),
 * or the state of one it made (`request_id`). Answers JSON: `{behavior}`
 * when decided, `{status: "pending", request_id}` while it waits.
 */
/**
 * Who asks to run a command: a mission task, or (ADR 0032) a computer-brain
 * run in the mission's thread, keyed by its run id (`id`) with the mission's
 * main session.
 */
export type PromptAsker = Pick<MachineTaskRow, "id" | "sessionId" | "executor">;

export async function handlePermissionPrompt(
  deps: MissionDeps,
  mission: MissionRow,
  task: PromptAsker,
  args: Record<string, unknown>,
): Promise<string> {
  const requestId = str(args.request_id);
  if (requestId) {
    const [p] = await readPrompts(deps.db, mission.id, requestId);
    if (!p || p.taskId !== task.id) return deny("That request is unknown.", "unknown");
    if (p.state === "allowed") return allow();
    if (p.state === "denied")
      return deny("A person said no. Don't try this command again; continue another way or report.", "person");
    if (p.state === "expired") return deny(PERMISSION_TIMEOUT_MESSAGE, "expired");
    return JSON.stringify({ status: "pending", request_id: p.id });
  }
  const tool = str(args.tool_name).slice(0, 64);
  const input =
    typeof args.input === "object" && args.input !== null && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : {};
  const command = commandOf(tool, input);
  if (!tool || !command) return deny("Unknown tool.", "unknown");
  // The deny list: refused, never shown, never judged; the refusal names the kind and how to ask a person.
  const denied = deniedMessage(tool, input);
  if (denied) return deny(denied, "never");
  const outbound = outboundCallProblem(tool, input);
  if (outbound) return deny(outbound.message, outbound.code);
  const scope = scopeOf(args.scope);
  // Secrets, with any tool that reads: refused the same way (ADR 0053 §3).
  if (secretRead(tool, input, scope ?? undefined)) return deny(SECRET_MESSAGE, "secret");
  // Plain reads (`ls` of any folder, read-only git, a GET): allowed, nothing posted.
  if (scope && readOnlyCall(tool, input, scope)) return allow();
  if (mission.status !== "active" && mission.status !== "awaiting_close")
    return deny("The plan isn't approved yet: only read for now.", "plan");
  // "Aprovar sempre nesta missão" covers it.
  if (allowedBy(await missionAllowRules(deps.db, mission.id), tool, input)) return allow();
  // "Aprovar sempre para o agente" covers its kind (never the deny list, a push, a secret or what code refuses).
  const agentKind = agentCommandKind(tool, input, scope);
  if (agentKind && (await agentCommandRule(deps.db, mission, agentKind))) return allow();
  const recent = (await readPrompts(deps.db, mission.id)).filter((p) => p.taskId === task.id);
  // Asked again while the card is open (Claude Code retries): the same card.
  const open = recent.find((p) => p.state === "pending" && p.command === command && p.tool === tool);
  if (open) return JSON.stringify({ status: "pending", request_id: open.id });
  const mode = commandApprovalOf(mission.commandApproval);
  // Code given inline to an interpreter is never allowed without a person, whatever the mission's setting.
  if (mode === "never" && !inlineCodeCall(tool, input)) {
    await autoApproved(deps, mission, task, { tool, command }, "never", null);
    return allow();
  }
  if (mode === "low_risk_auto" && forbiddenReason(tool, input, scope ?? NO_SCOPE) === null) {
    const p = await commandLowRisk(deps, mission, { tool, command });
    if (p !== null && p >= LOW_RISK_THRESHOLD) {
      await autoApproved(deps, mission, task, { tool, command }, "low_risk", p);
      return allow();
    }
  }
  const lately = recent.filter((p) => Date.now() - Date.parse(p.createdAt) < 10 * 60_000);
  if (lately.length >= COMMAND_PROMPTS_PER_TASK) {
    return deny(
      `Too many commands to approve in a row (at most ${COMMAND_PROMPTS_PER_TASK} in 10 minutes). Continue with what is allowed, or report what you need and stop.`,
      "tooMany",
    );
  }
  const promptId = crypto.randomUUID();
  const rules = rulesFor(tool, input);
  const shown = cutText(noMentions(command), TASK_LIMITS.denial * 2);
  const message = await deps.db.transaction(async (tx) => {
    await recordMissionEvent(tx, mission, "command_prompt", {
      promptId,
      taskId: task.id,
      sessionId: task.sessionId,
      tool,
      command: shown,
      rules,
      ...(agentKind ? { agentKind } : {}),
    });
    return postMissionMessage(
      deps,
      mission,
      `${executorName(task.executor)} wants to run: \`${shown}\``,
      {
        missionCommand: { id: promptId, missionId: mission.id, taskId: task.id, tool, command: shown },
        bodyCode: "mission_command",
        bodyParams: { command: shown, executor: executorName(task.executor) },
      },
      tx,
    );
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  await publishMissionEvent(deps, mission, "command", { promptId });
  await notifyCommand(deps, mission, promptId);
  return JSON.stringify({ status: "pending", request_id: promptId });
}

/** The kind "Aprovar sempre para o agente" keeps for a shell command code would let run (`forbiddenReason`), or null. */
function agentCommandKind(tool: string, input: Record<string, unknown>, scope: CommandScope | null) {
  if (tool !== "Bash" || typeof input.command !== "string") return null;
  return forbiddenReason(tool, input, scope ?? NO_SCOPE) === null ? commandKind(input.command) : null;
}

/** The agent's rule for this kind of command, read fresh: a removed one asks at once. */
const agentCommandRule = (db: Executor, mission: MissionRow, kind: string) =>
  coveringRules(
    db,
    { orgId: mission.orgId, agentId: mission.agentId, connectionId: null },
    { tool: COMMAND_RULE_TOOL, actions: [kind] },
  );

const executorName = (e: string | null | undefined) => (e === "codex" ? "Codex" : "Claude Code");

/** The command cards of a mission (who reads its conversation). */
export async function listMissionCommands(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  return {
    commands: await readPrompts(deps.db, mission.id),
    rules: await missionAllowRules(deps.db, mission.id),
  };
}

/** Aprovar / Recusar / Aprovar sempre nesta missão: the owner or someone who decides. */
export async function decideCommand(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  promptId: string,
  decision: CommandDecision,
) {
  if (!["allow", "deny", "always", "agent"].includes(decision)) throw new ValidationError("Unknown decision");
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "answer the executor's commands");
  requireOpen(mission);
  const [p] = await readPrompts(deps.db, mission.id, promptId);
  if (!p) throw new NotFoundError("Command not found", "mission.command_not_found");
  if (p.state !== "pending") {
    throw new ConflictError(
      p.state === "expired" ? "Nobody answered in time, so the command was denied." : "Already answered",
      p.state === "expired" ? "mission.command_expired" : "mission.command_decided",
    );
  }
  if (decision === "agent") {
    // Only who decides the agent's approvals keeps something for it everywhere (its owner, `approve_actions`).
    const agent = p.agentKind ? await getAgent(deps.db, orgId, mission.agentId) : null;
    if (!agent) throw new ConflictError("This command can't be approved for good", "approval.always_unavailable");
    if (!(await decidesAgentApprovals(deps.db, orgId, userId, agent.ownerUserId))) {
      throw new ForbiddenError("Only the agent's owner or an admin can approve this for good");
    }
  }
  await deps.db.transaction(async (tx) => {
    await recordMissionEvent(tx, mission, "command_decided", { promptId, decision, by: userId });
    if (decision === "always") await addMissionAllowRules(tx, mission, p.rules, { userId, promptId });
    if (decision === "agent" && p.agentKind) {
      await addApprovalRules(
        tx,
        { orgId, agentId: mission.agentId, connectionId: null },
        { tool: COMMAND_RULE_TOOL, actions: [p.agentKind] },
        userId,
      );
    }
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: `mission.command_${decision}`,
    target: { type: "mission", id: mission.id },
    details: {
      promptId,
      command: cutText(p.command, 300),
      ...(decision === "always" ? { rules: p.rules } : {}),
      ...(decision === "agent" ? { agentId: mission.agentId, kind: p.agentKind } : {}),
    },
  });
  await publishMissionEvent(deps, mission, "command", { promptId });
  await notifyCommand(deps, mission, promptId);
  const [after] = await readPrompts(deps.db, mission.id, promptId);
  return after as MissionCommandView;
}

/**
 * "Liberar e repetir" on a task's end notice: the command it was refused
 * becomes a mission rule and its session is resumed to try again.
 */
export async function retryBlockedCommand(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  input: { taskId: string; command?: string; commands?: string[] },
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "allow the executor's commands");
  requireOpen(mission);
  if (mission.status === "paused") {
    throw new ConflictError("The mission is paused: resume it first", "mission.paused");
  }
  if (!/^[0-9a-f-]{36}$/i.test(input.taskId)) throw new NotFoundError("Task not found", "task.not_found");
  const wanted = [...new Set([...(input.command ? [input.command] : []), ...(input.commands ?? [])])].slice(0, 20);
  if (wanted.length === 0) throw new ValidationError("Say which command", "mission.invalid");
  const blocked = await blockedOfTask(deps.db, mission.id, input.taskId);
  const denials = wanted.map((c) => blocked.find((d) => d.command === c));
  if (denials.some((d) => !d)) throw new NotFoundError("That command wasn't blocked", "mission.command_not_found");
  const rows = rowsOf<{ session_id: string | null; cwd: string | null }>(
    await deps.db.execute(sql`select session_id, cwd from ${machineTasks}
      where id = ${input.taskId}::uuid and mission_id = ${mission.id}::uuid`),
  );
  const task = rows[0];
  if (!task?.session_id) throw new NotFoundError("Task not found", "task.not_found");
  const all: string[] = [];
  for (const denial of denials as NonNullable<(typeof denials)[number]>[]) {
    // A non-shell tool's line is "<Tool> <what>" (`WebFetch https://…`).
    const what = denial.command.slice(denial.tool.length).trim();
    const rules = rulesFor(denial.tool, denial.tool === "Bash" ? { command: denial.command } : { url: what });
    const added = await addMissionAllowRules(deps.db, mission, rules, { userId });
    all.push(...(added.length ? added : rules));
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "mission.command_retry",
      target: { type: "mission", id: mission.id },
      details: { taskId: input.taskId, command: cutText(denial.command, 300), rules },
    });
  }
  const list = (denials as { command: string }[]).map((d) => d.command);
  const sent = await tellSession(
    deps,
    mission,
    { sessionId: task.session_id, cwd: task.cwd },
    list.length === 1
      ? `The command was allowed; retry it: ${list[0]}`
      : `These commands were allowed; retry them:\n${list.map((c) => `- ${c}`).join("\n")}`,
    { requestedBy: userId, from: "a person", kind: "person" },
  );
  await publishMissionEvent(deps, mission, "command", { taskId: input.taskId });
  return { rules: [...new Set(all)], delivered: sent.delivered };
}

/**
 * "Pedir aprovação de comandos": the owner or someone who decides changes
 * it (Revogar on an automatic approval sets `always`). Audited.
 */
export async function setCommandApproval(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  value: unknown,
): Promise<{ commandApproval: CommandApproval }> {
  if (!isCommandApproval(value)) {
    throw new ValidationError("Choose always, low_risk_auto or never", "mission.invalid_command_approval");
  }
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "change how commands are approved");
  requireOpen(mission);
  const from = commandApprovalOf(mission.commandApproval);
  if (from === value) return { commandApproval: value };
  await deps.db.transaction(async (tx) => {
    await tx
      .update(schema.missions)
      .set({ commandApproval: value, updatedAt: new Date() })
      .where(sql`${schema.missions.id} = ${mission.id}::uuid`);
    await recordMissionEvent(tx, mission, "command_approval", { by: userId, from, to: value });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "mission.command_approval",
      target: { type: "mission", id: mission.id },
      details: { from, to: value },
    });
  });
  await publishMissionEvent(deps, mission, "settings", { commandApproval: value });
  return { commandApproval: value };
}

/**
 * A computer-brain run outside a mission (ADR 0032): Claude Code's
 * permission prompt, or one of Codex's approvals (ADR 0053 §3), with no
 * mission to post a card in. The deny list and secrets are refused; plain
 * reads are allowed; anything else is allowed only when the agent may run
 * commands on its computer (`canRun`: the sandbox scope) and code allows it
 * (`forbiddenReason`: no sudo, no deletes or writes outside its folder, no
 * uploads, remote shells, global installs or inline code). The rest is denied
 * with what to do instead (nothing waits for a person here).
 */
export function runPermissionPrompt(args: Record<string, unknown>, opts: { canRun: boolean }): string {
  if (str(args.request_id)) return deny("That request is unknown.", "unknown");
  const tool = str(args.tool_name).slice(0, 64);
  const input =
    typeof args.input === "object" && args.input !== null && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : {};
  const command = commandOf(tool, input);
  if (!tool || !command) return deny("Unknown tool.", "unknown");
  const denied = deniedMessage(tool, input);
  if (denied) return deny(denied, "never");
  const outbound = outboundCallProblem(tool, input);
  if (outbound) return deny(outbound.message, outbound.code);
  const scope = scopeOf(args.scope);
  if (secretRead(tool, input, scope ?? undefined)) return deny(SECRET_MESSAGE, "secret");
  if (scope && readOnlyCall(tool, input, scope)) return allow();
  if (!opts.canRun) {
    return deny(
      `Running commands on this computer is turned off for you. If the request needs it, ask for it with request_permission (sandbox:run). ${NO_TERMINAL_COMMANDS}`,
      "off",
    );
  }
  const reason = forbiddenReason(tool, input, scope ?? NO_SCOPE);
  if (reason === null) return allow();
  const hint = forbiddenHint(reason);
  return deny(
    `This command was refused because ${reason}.${hint ? ` ${hint}` : ""} Agents may not use sudo, delete or write outside their folder, upload, open remote shells or install globally. Do it another way; if there is none, tell the person in plain words what you couldn't do. ${NO_TERMINAL_COMMANDS}`,
    forbiddenCode(reason),
  );
}

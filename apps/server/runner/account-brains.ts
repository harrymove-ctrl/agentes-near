import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import {
  type AgentScope,
  type BrainRouteRequest,
  type BrainTurnRequest,
  type MachineRequest,
  MISSION_RULES_NO_GIT,
  type TaskStart,
  type ToolNotice,
  type TurnContext,
  type WireBrainEvent,
} from "@agenteschat/adapters/machine-protocol";
import { ACCOUNT_SIGNED_OUT, type AccountManager } from "./accounts";
import { ACCOUNT_STORES, type AccountUsers, type AgentUser, accountLauncher } from "./agent-users";
import { BrainManager, type DelegatedFrame, type DelegatedTurn, neutralizeCliInput, redactTokenShapes } from "./brain";
import { routeWithPlan } from "./brain-route";
import type { ClaudeSharedLogin } from "./config";
import type { DelegatedBridge } from "./delegated-tools";
import { RunnerError } from "./errors";
import type { RequestScope } from "./handlers";
import { cleanRules, missionBranchPrefix, redactDeep } from "./mcp";
import { accountOf, type WorkerLinkFrame } from "./supervisor";
import { type HostedExit, type HostedTask, TASK_MAX_SECONDS_CAP } from "./tasks";

/**
 * Root's side of a Claude sign-in several agents share (`AccountManager.isCliShared`). Its CLIs are the only processes
 * with that sign-in's store, so they run as its user, started and fed by root: an agent's own worker runs as a uid the
 * agent's code can ptrace, and whoever holds a CLI's stdin can make it add a server that reads the store. The rest of
 * the turn is that worker's: where it runs, what its folder says, and every tool (`delegated-tools.ts`).
 *
 * A background task is such a turn too, one-shot and on the task's own rules: its worker keeps the task (folder, branch,
 * journal, commit) and gets the CLI's lines. A route needs no tools at all, so only the CLI is here, in the agent's
 * network and an empty folder.
 */

/** How often a refresh's lock is looked for, and how long a spawn waits for it to go (a stale one must not stop turns). */
const REFRESH_POLL_MS = 200;
const REFRESH_WAIT_MS = 30_000;

export const SHARED_LOGIN_OFF =
  "This computer can't run this Claude sign-in right now. Try again later, or remove it in AI accounts and connect Claude again.";
/** Past this a line is lost, as in a task's own watcher. */
const TASK_LINE_MAX = 1024 * 1024;

type TaskRequest = TaskStart & { agent?: AgentScope };

const hostOf = (v: unknown): HostedTask | null => {
  const h = v as Partial<HostedTask> | null | undefined;
  return typeof h?.cwd === "string" &&
    typeof h.where === "string" &&
    typeof h.git === "boolean" &&
    typeof h.maxSeconds === "number"
    ? { cwd: h.cwd, where: h.where, git: h.git, maxSeconds: h.maxSeconds }
    : null;
};

/** The turn a task's CLI runs: from the request root has, but where it runs and what its folder is. */
function taskTurn(req: TaskRequest, host: HostedTask): BrainTurnRequest {
  const { mission } = req;
  const rules = mission?.rules && !host.git ? MISSION_RULES_NO_GIT : (mission?.rules ?? "");
  const allow = Array.isArray(mission?.allow) ? mission.allow.filter((r) => typeof r === "string") : [];
  const prompt = String(req.prompt ?? "");
  return {
    runId: req.taskId,
    kind: "claude_code",
    session: {
      id: typeof req.session === "string" && /^[a-fA-F0-9-]{36}$/.test(req.session) ? req.session : randomUUID(),
      resume: req.resume === true,
    },
    cwd: host.cwd,
    system: cleanRules(rules),
    prompt: host.where ? `${host.where}\n\n${prompt}` : prompt,
    mcp: { token: typeof mission?.mcpToken === "string" ? mission.mcpToken : "" },
    keepAlive: false,
    account: String(req.account),
    permissions: {
      mode: mission?.mode === "plan" ? "plan" : "work",
      ...(mission ? { branchPrefix: missionBranchPrefix(String(mission.id), mission.branchPrefix), allow } : {}),
    },
  };
}

/** What it needs of the agents' workers (`Supervisor`). */
export interface AgentWorkers {
  /** The agent's OS user with its network now, once its worker is up. */
  agentReady(agent: AgentScope, signal: AbortSignal): Promise<AgentUser>;
  turnContext(agent: AgentScope, ask: { cwd?: string; text?: boolean }, signal: AbortSignal): Promise<TurnContext>;
  bridge(bridge: DelegatedBridge): Promise<void>;
  tell(agentId: string, frame: WorkerLinkFrame): void;
  /**
   * Until the returned call, the agent's network waits for this turn; `dropped` hears its worker's session ended. A
   * `task` doesn't live on that session, so it hears only of the worker's own end.
   */
  hold(agentId: string, dropped: (err: RunnerError) => void, task?: boolean): () => void;
  reclaimBrains(spare?: string): Promise<boolean>;
}

export interface AccountBrainsOptions {
  /** `<runner home>/account-brains`: the system text each session began with. */
  root: string;
  accounts: Pick<AccountManager, "isCliShared" | "cliSharedState" | "sharedCommand" | "noteRateLimit">;
  users: Pick<AccountUsers, "ensure" | "room" | "bridge" | "carry">;
  workers: AgentWorkers;
  /** The folders the agent may use besides its own: root's own word, what a turn's cwd is checked against. */
  grants: (agentId: string) => Promise<string[]>;
  /** The runner's own command: the relay the CLI starts. */
  relay: string[];
  shared: () => ClaudeSharedLogin | undefined;
  idleMs?: number;
  maxProcesses?: number;
  log?: (line: string) => void;
  /** Tests. */
  stores?: string;
  launcher?: typeof accountLauncher;
  deltaMs?: number;
}

export class AccountBrains {
  readonly brains: BrainManager;
  /** Tasks whose CLI runs now. */
  private readonly tasks = new Map<string, { agentId: string; stop: AbortController }>();
  /** What ends each turn on purpose (`dropTurns`). */
  private readonly turns = new Set<{ agentId: string; drop: (err: RunnerError) => void }>();

  constructor(private readonly o: AccountBrainsOptions) {
    this.brains = new BrainManager({
      root: o.root,
      accounts: { accountDir: () => null, noteRateLimit: (key, info) => o.accounts.noteRateLimit(key, info) },
      ...(o.idleMs !== undefined ? { idleMs: o.idleMs } : {}),
      ...(o.maxProcesses !== undefined ? { maxProcesses: o.maxProcesses } : {}),
      ...(o.deltaMs !== undefined ? { deltaMs: o.deltaMs } : {}),
      ...(o.log ? { log: o.log } : {}),
    });
  }

  /** A request for such a sign-in that must run here. */
  takes(req: MachineRequest): req is Extract<MachineRequest, { op: "brain.turn" }> {
    return req.op === "brain.turn" && this.onSharedLogin(req);
  }

  /** Whether the CLI of this request is such a sign-in's, so no worker can start it. */
  onSharedLogin(req: MachineRequest) {
    const signIn = accountOf(req);
    return signIn?.kind === "claude_code" && this.o.accounts.isCliShared("claude_code", signIn.account);
  }

  private mustBeReady(account: string) {
    const state = this.o.accounts.cliSharedState(account);
    if (state === "off") throw new RunnerError("unsupported", SHARED_LOGIN_OFF);
    if (state === "signed_out") throw new RunnerError("not_found", ACCOUNT_SIGNED_OUT);
  }

  toolNotice(agentId: string, notice: ToolNotice) {
    this.brains.toolNotice(agentId, notice);
  }

  /**
   * The running turns of an agent, or of all, end now as `err`. Call it before stopping their scopes: a CLI that just
   * dies is a crash to its turn, which starts it again.
   */
  dropTurns(err: RunnerError, agentId?: string) {
    for (const t of [...this.turns]) if (agentId === undefined || t.agentId === agentId) t.drop(err);
  }

  /** Whether the session `key` (`brainKey`) has an open CLI here. */
  warm(key: string) {
    return this.brains.warm(key);
  }

  /** The computer is short of memory: an idle CLI closes, here or a worker's, the waiting turn's own (`spare`) last. */
  async reclaim(spare: string) {
    const idle = this.brains.idleCandidate(spare);
    if (idle && !idle.spare && (await this.brains.reclaimIdle(spare))) return true;
    return (await this.o.workers.reclaimBrains(spare)) || this.brains.reclaimIdle(spare);
  }

  /** One turn. A worker that goes away under it fails it as `dropped`, so the server resumes it as any agent's turn. */
  async turn(
    req: BrainTurnRequest,
    agent: AgentScope,
    scope: Pick<RequestScope, "signal">,
    emit: (e: WireBrainEvent) => void,
    task?: DelegatedTurn["task"],
  ): Promise<WireBrainEvent> {
    const account = String(req.account);
    const state = this.o.accounts.cliSharedState(account);
    if (state !== "ready") {
      const final: WireBrainEvent =
        state === "off"
          ? { type: "error", code: "unsupported", message: SHARED_LOGIN_OFF, retryable: true }
          : { type: "error", code: "not_logged_in", message: ACCOUNT_SIGNED_OUT, retryable: true };
      emit(final);
      return final;
    }
    const user = await this.o.workers.agentReady(agent, scope.signal);
    const stop = new AbortController();
    const cancel = () => stop.abort();
    scope.signal.addEventListener("abort", cancel, { once: true });
    if (scope.signal.aborted) cancel();
    let dropped: RunnerError | undefined;
    const drop = (err: RunnerError) => {
      dropped = err;
      stop.abort();
    };
    const release = this.o.workers.hold(agent.id, drop, task !== undefined);
    const held = { agentId: agent.id, drop };
    this.turns.add(held);
    try {
      const final = await this.brains.turn(req, {
        agent,
        folder: "",
        signal: stop.signal,
        emit: (e) => {
          if (!dropped) emit(e);
        },
        delegated: { ...(await this.delegated(account, agent, user, stop.signal)), ...(task ? { task } : {}) },
      });
      if (dropped) throw dropped;
      return final;
    } finally {
      this.turns.delete(held);
      release();
      scope.signal.removeEventListener("abort", cancel);
    }
  }

  /**
   * `task.start`. Its worker prepares the task first, so a refusal there (no such folder, the branch taken) is the
   * request's answer; the CLI then runs here, and the server hears of it as of any task, from the worker.
   */
  async startTask(
    req: TaskRequest,
    agent: AgentScope,
    prepare: () => Promise<unknown>,
    signedOut: (final: WireBrainEvent) => void,
  ) {
    this.mustBeReady(String(req.account));
    const { host, ...reply } = (await prepare()) as Record<string, unknown> & { host?: unknown };
    const hosted = hostOf(host);
    if (!hosted) throw new RunnerError("internal", "The agent's worker said nothing usable about this task");
    void this.runTask(req, agent, hosted, signedOut);
    return reply;
  }

  /** The worker of its task asked for its end (`task.stop`). */
  stopTask(agentId: string, taskId: string) {
    const task = this.tasks.get(taskId);
    if (task?.agentId === agentId) task.stop.abort();
  }

  private async runTask(
    req: TaskRequest,
    agent: AgentScope,
    host: HostedTask,
    signedOut: (final: WireBrainEvent) => void,
  ) {
    const { taskId } = req;
    const stop = new AbortController();
    this.tasks.set(taskId, { agentId: agent.id, stop });
    let timedOut = false;
    const limit = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, Math.min(host.maxSeconds, TASK_MAX_SECONDS_CAP) * 1000);
    const say = (stream: "stdout" | "stderr", line: string) =>
      this.o.workers.tell(agent.id, { type: "task.out", taskId, stream, line });
    const stopped = (): HostedExit | null =>
      stop.signal.aborted ? { exitCode: null, signal: "SIGTERM", reason: timedOut ? "timeout" : "canceled" } : null;
    const turn = taskTurn(req, host);
    let exit: HostedExit;
    try {
      const final = await this.turn(turn, agent, { signal: stop.signal }, () => {}, {
        kind: req.mission ? "mission" : "local",
        line: (line) => {
          // Partial messages say nothing a task reads, and are most of what the CLI prints.
          if (line.startsWith('{"type":"stream_event"') || line.length > TASK_LINE_MAX) return;
          say("stdout", redactTokenShapes(line));
        },
      });
      signedOut(final);
      if (final.type === "error") say("stderr", final.message.replace(/\s+/g, " "));
      exit = stopped() ?? { exitCode: final.type === "done" ? 0 : 1, signal: null, reason: null };
    } catch (err) {
      // Its worker went away: the next one finds the task with no CLI, and the server resumes it.
      exit = stopped() ?? { exitCode: null, signal: null, reason: "interrupted", error: String(err) };
    }
    clearTimeout(limit);
    this.tasks.delete(taskId);
    this.o.workers.tell(agent.id, { type: "task.exit", taskId, session: turn.session.id, ...exit });
  }

  /** `brain.route`: the prompt carries other people's messages, and the CLI runs with no tool and nothing of anyone's. */
  async route(req: BrainRouteRequest, agent: AgentScope, scope: Pick<RequestScope, "signal">) {
    const account = String(req.account);
    this.mustBeReady(account);
    const user = await this.o.workers.agentReady(agent, scope.signal);
    const stop = new AbortController();
    const signal = AbortSignal.any([scope.signal, stop.signal]);
    const release = this.o.workers.hold(agent.id, () => stop.abort());
    let room: string | undefined;
    try {
      const d = await this.delegated(account, agent, user, signal);
      const at = await d.where();
      room = mkdtempSync(path.join(d.room, "route-"));
      // Read by the sign-in's user through the default ACL on its room, which this mode unmasks.
      chmodSync(room, 0o750);
      const reply = await routeWithPlan(
        { ...req, prompt: neutralizeCliInput(req.prompt) },
        { brains: this.brains, signal, shared: { home: d.configDir, dir: room, launch: () => d.launch(at.cwd) } },
      );
      return redactDeep(reply, redactTokenShapes) as typeof reply;
    } finally {
      release();
      if (room) rmSync(room, { recursive: true, force: true });
    }
  }

  private async delegated(
    account: string,
    agent: AgentScope,
    user: AgentUser,
    signal: AbortSignal,
  ): Promise<DelegatedTurn> {
    const { users, workers, accounts } = this.o;
    const signIn = users.ensure(account);
    users.room(signIn, user.uid);
    const socketPath = users.bridge(signIn, user);
    const store = path.join(this.o.stores ?? ACCOUNT_STORES, account);
    const configDir = path.join(store, "config");
    const grants = await this.o.grants(agent.id);
    return {
      configDir,
      room: path.join(store, "run", String(user.uid)),
      relay: { socketPath, command: this.o.relay },
      where: (cwd) => workers.turnContext(agent, cwd ? { cwd } : {}, signal),
      text: async (cwd) => (await workers.turnContext(agent, { cwd, text: true }, signal)).text ?? "",
      launch: async (cwd) => {
        await this.refreshOver(configDir, signal);
        const l = (this.o.launcher ?? accountLauncher)(signIn, user, cwd, grants);
        return { command: accounts.sharedCommand(l.prefix), env: l.env, cwd: l.home };
      },
      carry: (from, to) => users.carry(signIn, from, to),
      bridge: (frame: DelegatedFrame) => workers.bridge({ ...frame, agent, socketPath }),
      cancel: (session) => workers.tell(agent.id, { type: "turn.cancel", session }),
      detach: (session) => workers.tell(agent.id, { type: "turn.detach", session }),
    };
  }

  /**
   * Refresh mode B, for a CLI version whose refreshes clash unless no new CLI starts during one. Only the lock's name
   * is looked at, never a file's content. A lock older than the wait is stale: turns go on.
   */
  private async refreshOver(configDir: string, signal: AbortSignal) {
    const shared = this.o.shared();
    if (shared?.refresh !== "B" || !shared.refreshLock) return;
    const lock = path.join(configDir, shared.refreshLock);
    const until = Date.now() + REFRESH_WAIT_MS;
    while (existsSync(lock) && Date.now() < until && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
    }
  }
}

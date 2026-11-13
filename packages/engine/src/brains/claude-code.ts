import { createHash, randomBytes } from "node:crypto";
import {
  ACCOUNTS_PROTOCOL,
  type AgentScope,
  BRAIN_PROFILES_PROTOCOL,
  BRAIN_PROTOCOL,
  type BrainTurnRequest,
  brainTopic,
  CONTEXT_LIMIT_PROTOCOL,
  CONVERSATION_PROTOCOL,
  LOCKED_BRAIN_PROTOCOL,
  type PubSub,
  parseBrainEvent,
  SPEED_PROTOCOL,
  STEER_PROTOCOL,
  type WireBrainEvent,
} from "@agenteschat/adapters";
import { type Database, schema } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import type { CodeSetup } from "../git/machine";
import { type MachineCaller, MachineRequestError, type MachineStatus } from "../machine-hub";
import { MachineDroppedError, MachineOfflineError, MachinePausedError, pausedMessage } from "../machines";
import { addPersonSpend } from "../person-usage";
import { apiNano } from "../plan-usage";
import { runnerUpdateWay } from "../runner-update";
import { computerPrompt, systemWithConversation } from "./prompt";
import {
  BRAIN_NAMES,
  BRAIN_PLAN_NAMES,
  type Brain,
  type BrainAccount,
  type BrainEvent,
  type BrainIO,
  type BrainTurn,
  type SteerMessage,
  type SteerReply,
} from "./types";

/**
 * The Claude Code brain (ADR 0032): an agent thinks with Claude Code on its
 * computer, on the owner's plan.
 *
 * - One turn = one `brain.turn` request to the machine (protocol 8) through
 *   the hub. The runner streams `brain.event` frames; the hub publishes them
 *   on `brainTopic(runId)` for whichever replica runs the turn, and the brain
 *   yields them as `BrainEvent`s. The request's result repeats the final event
 *   (`done` or `error`), so the turn ends even if a published event is lost.
 * - Tools: Claude Code calls them through the runner's MCP bridge (block 2),
 *   executed by the engine's Tool Gateway; here they only arrive as
 *   `tool_call` events with `executed` (for the transcript and the live view).
 * - Usage: `usage{source:"plan"}` (no cost; `recordPlanUsage` writes it).
 *   A plan limit: `limit{resetsAt}` and then `error{code:"plan_limit"}`.
 * - Before sending anything the machine is checked: offline, commands off,
 *   an older runner, no Claude Code, or not logged in (the agent's account,
 *   ADR 0041, when it has one) end the turn at once
 *   with an `error` whose `retryable: true` tells the engine it may fall back
 *   to the model brain (ADR 0032 §5).
 *
 * - Live steering (runner protocol 15): once the turn is sent, the brain
 *   hands the engine `steer` (`BrainIO.steerable`): a person's messages go to
 *   the turn in progress (`brain.steer`), Claude Code reads them at its next
 *   tool boundary, and `steer_read` events say which it read.
 *
 * Error codes (`retryable` = the turn may run on another brain):
 * `no_session`, `machine_offline`, `exec_disabled`, `runner_outdated`,
 * `cli_missing`, `not_logged_in`, `plan_limit`, `busy` (all retryable);
 * `claude_failed`, `canceled`, `timeout`, `runner_error`, `bad_request` (not).
 */

export interface ClaudeCodeBrainDeps {
  hub: Pick<MachineCaller, "call" | "status">;
  pubsub: PubSub;
  /** The agent as the runner names its folder (`agentScopeFromDb`). */
  agentScope: (turn: BrainTurn) => Promise<AgentScope>;
  /** Keep one Claude Code process per thread alive between turns (default true; false for a background run). */
  keepAlive?: boolean;
  /** Also load the machine owner's own MCP servers (default false: only our bridge). */
  personalMcp?: (turn: BrainTurn) => boolean | Promise<boolean>;
  /**
   * The turn's permission profile (missions: their own plan/work, branch prefix and allowed rules; other
   * runs: `work`, whoever woke them, ADR 0109). A `plan` turn needs `BRAIN_PROFILES_PROTOCOL` (an older runner's plan
   * reads secrets and loads project settings): below it the turn fails with `runner_outdated`.
   */
  permissions?: (
    turn: BrainTurn,
  ) => BrainTurnRequest["permissions"] | undefined | Promise<BrainTurnRequest["permissions"] | undefined>;
  /** The run's MCP bridge token (default: random per run). */
  mcpToken?: (turn: BrainTurn) => string;
  /**
   * Before a chat turn (ADR 0024 addendum): updates the agent's checkouts on
   * the machine and says where the turn starts and what to add to the
   * system text ("# Your code"). Null or a failure: the turn runs as before.
   */
  prepare?: (turn: BrainTurn, signal: AbortSignal) => Promise<CodeSetup | null>;
  /** How long a turn may take (default: the hub's, 3 h). */
  timeoutMs?: number;
  /** After the request's result, how long to wait for the stream's last events (default 1.5 s). */
  finalGraceMs?: number;
  /** How long a `brain.steer` may take (default `STEER_CALL_MS`). */
  steerTimeoutMs?: number;
}

/** A `brain.steer` answers at once (it only writes to the CLI's stdin): longer means the computer is in trouble. */
export const STEER_CALL_MS = 2000;

/** Hands messages to the turn of `runId` on its computer (`brain.steer`); a failed call is `no_turn` (they wait). */
export async function steerOnMachine(
  hub: Pick<MachineCaller, "call">,
  input: { machineId: string; runId: string; session: string; agent: AgentScope; timeoutMs?: number },
  messages: SteerMessage[],
): Promise<SteerReply> {
  try {
    const reply = await hub.call<"brain.steer">(
      input.machineId,
      {
        op: "brain.steer",
        runId: input.runId,
        session: input.session,
        messages: messages.map((m) => ({ uuid: m.uuid, text: m.text, ...(m.urgent ? { urgent: true } : {}) })),
        agent: input.agent,
      },
      { timeoutMs: input.timeoutMs ?? STEER_CALL_MS },
    );
    if (reply?.status === "accepted" && Array.isArray(reply.accepted)) {
      const sent = new Set(messages.map((m) => m.uuid));
      return { status: "accepted", accepted: reply.accepted.filter((u) => typeof u === "string" && sent.has(u)) };
    }
    if (reply?.status === "unsupported")
      return { status: "unsupported", ...(reply.reason ? { reason: reply.reason } : {}) };
    return { status: "no_turn", ...(reply && "reason" in reply && reply.reason ? { reason: reply.reason } : {}) };
  } catch (error) {
    return { status: "no_turn", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The agent's id and handle, as the runner names its folder (and its name, for the machine's activity log). */
export const agentScopeFromDb =
  (db: Database) =>
  async (turn: BrainTurn): Promise<AgentScope> => {
    const agent = await getAgentCached(db, turn.orgId, turn.agentId);
    return { id: turn.agentId, handle: agent?.handle ?? "agent", ...(agent ? { name: agent.name } : {}) };
  };

/**
 * A stable Claude Code session id for one agent in one conversation (a
 * thread, or a channel/DM without threads): a UUID derived from both, so the
 * engine needs to store nothing to resume it (the runner checks the
 * machine's disk to pick `--resume` or `--session-id`).
 */
export function brainSessionId(agentId: string, conversation: string, salt = "claude_code"): string {
  const h = createHash("sha256").update(`${salt}:${agentId}:${conversation}`).digest("hex");
  // RFC 4122 layout, version 5-style (name-based) and the variant bits.
  const v = `5${h.slice(13, 16)}`;
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}-${h.slice(20, 32)}`;
}

const err = (code: string, message: string, retryable: boolean): BrainEvent => ({
  type: "error",
  code,
  message,
  retryable,
});

/**
 * Why the agent's account can't take the turn (ADR 0041; null: it can): a
 * runner older than accounts, or an account its CLI signed out. It never
 * falls back to another account (the model fallback still may answer).
 */
export function accountUnavailable(
  status: { name?: string; protocol?: number; kind?: string; executors?: { mode?: string } } | null,
  account: BrainAccount | undefined,
  kind: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity",
): { code: string; message: string } | null {
  if (!account) return null;
  const name = BRAIN_PLAN_NAMES[kind];
  const where = status?.name ? ` on ${status.name}` : "";
  if (status?.protocol !== undefined && status.protocol < ACCOUNTS_PROTOCOL) {
    return {
      code: "runner_outdated",
      message: `The runner${where} is too old for agents with their own ${name} account. ${runnerUpdateWay(status)}`,
    };
  }
  if (account.status === "signed_out") {
    return {
      code: "not_logged_in",
      message: `The ${name} account "${account.label}"${where} is signed out. Its owner can sign in again in Settings, AI accounts.`,
    };
  }
  return null;
}

/** Sent only to a runner that knows accounts (protocol 13): older ones never see these fields. */
export function accountFields(
  protocol: number | undefined,
  turn: Pick<BrainTurn, "account" | "effort">,
): Pick<BrainTurnRequest, "account" | "effort"> {
  if (protocol !== undefined && protocol < ACCOUNTS_PROTOCOL) return {};
  return {
    ...(turn.account ? { account: turn.account.id } : {}),
    ...(turn.effort ? { effort: turn.effort } : {}),
  };
}

/** The agent's context limit, sent only to a runner that knows it (`CONTEXT_LIMIT_PROTOCOL`). */
export function contextFields(
  protocol: number | undefined,
  turn: Pick<BrainTurn, "contextTokens">,
): Pick<BrainTurnRequest, "contextTokens"> {
  if (!turn.contextTokens || (protocol !== undefined && protocol < CONTEXT_LIMIT_PROTOCOL)) return {};
  return { contextTokens: turn.contextTokens };
}

/** The turn's speed, sent only to a runner that knows it (`SPEED_PROTOCOL`). */
export function speedFields(
  protocol: number | undefined,
  turn: Pick<BrainTurn, "speed">,
): Pick<BrainTurnRequest, "speed"> {
  if (!turn.speed || (protocol !== undefined && protocol < SPEED_PROTOCOL)) return {};
  return { speed: turn.speed };
}

/** Why the turn can't go to this machine now (null: it can). With an account, the account decides the sign-in. */
export function claudeCodeAvailability(status: MachineStatus | null, account?: BrainAccount): BrainEvent | null {
  if (!status) return err("machine_offline", "The agent's computer is not connected to the organization.", true);
  if (!status.online) return err("machine_offline", `Claude Code on ${status.name} is offline.`, true);
  if (status.paused) {
    return err("machine_paused", pausedMessage(status.name, status.paused.until, status.paused.timezone), true);
  }
  // A machine that reports its tools (protocol 10, the desktop app) runs Claude Code when that tool is on,
  // whatever "commands" says (the runner checks the same); an older runner follows its `exec` switch.
  const off = toolOff(status, "claude");
  if (off) return err(off.code, off.message, true);
  if (status.protocol < BRAIN_PROTOCOL) {
    return err(
      "runner_outdated",
      `The runner on ${status.name} is too old for agents that think with Claude Code. ${runnerUpdateWay(status)}`,
      true,
    );
  }
  const ex = status.executors ?? {};
  if (ex.detectedAt && !ex.claude) return err("cli_missing", `Claude Code is not installed on ${status.name}.`, true);
  if (account) {
    const e = accountUnavailable(status, account, "claude_code");
    return e ? err(e.code, e.message, true) : null;
  }
  if (ex.claude?.loggedIn === false) {
    return err("not_logged_in", `Claude Code on ${status.name} is not logged in (run claude auth login there).`, true);
  }
  return null;
}

/**
 * Whether the machine refuses this coding CLI: its tool switched off (protocol
 * 10, `access.tools`), or commands off on a runner that doesn't report tools.
 */
export function toolOff(
  status: Pick<MachineStatus, "name" | "execAllowed" | "access">,
  tool: "claude" | "codex" | "cursor" | "opencode" | "grok" | "antigravity",
): { code: string; message: string } | null {
  const tools = status.access?.tools;
  const name = tool === "claude" ? "Claude Code" : BRAIN_NAMES[tool];
  if (tools) {
    // A runner before Cursor's switch (protocol 36) reports none: Cursor follows Codex's there, as on the runner.
    return (tool === "claude" || tool === "codex" ? tools[tool] : (tools[tool] ?? tools.codex)) === true
      ? null
      : {
          code: "tool_off",
          message: `${name} is turned off on ${status.name} (its owner can turn it on in the agentes app).`,
        };
  }
  return status.execAllowed ? null : { code: "exec_disabled", message: `Commands are turned off on ${status.name}.` };
}

/**
 * The folder a computer turn was to start in, when the runner refused the turn because it isn't on the computer
 * (`not_found`, which a Claude Code runner answers as `bad_request`, in every runner version); else null.
 */
export const missingTurnFolder = (message: string): string | null =>
  /^The folder (.+) doesn't exist$/.exec(message)?.[1] ?? null;

/**
 * The runner refused the turn before starting it, for lack of room (`no_slot`) or at its request ceiling
 * (`internal` "busy", every runner version): `busy`, and the engine waits for room.
 */
export function busyRefusal(error: unknown): BrainEvent | null {
  if (!(error instanceof MachineRequestError)) return null;
  if (error.code === "no_slot") return err("busy", error.message, true);
  if (error.code === "internal" && error.message === "busy") {
    return err("busy", "The computer is busy with other requests.", true);
  }
  return null;
}

/** A failed `brain.turn` request as the turn's error. */
export function claudeCodeCallError(error: unknown): BrainEvent {
  if (error instanceof MachineDroppedError && error.serverStop) {
    return { type: "error", code: "machine_offline", message: error.message, retryable: true, serverStop: true };
  }
  if (error instanceof MachineOfflineError) return err("machine_offline", error.message, true);
  if (error instanceof MachinePausedError) return err("machine_paused", error.message, true);
  const busy = busyRefusal(error);
  if (busy) return busy;
  if (error instanceof MachineRequestError) {
    switch (error.code) {
      case "canceled":
        return err("canceled", "The turn was canceled.", false);
      case "timeout":
        return err("timeout", error.message, false);
      case "exec_disabled":
        return err("exec_disabled", error.message, true);
      case "bad_request":
        if (/unknown op|no brain turns/i.test(error.message)) return err("runner_outdated", error.message, true);
        return err("bad_request", error.message, false);
      default:
        return err("runner_error", error.message, false);
    }
  }
  return err("runner_error", error instanceof Error ? error.message : String(error), false);
}

const toBrainEvent = (e: WireBrainEvent): BrainEvent => e as BrainEvent;
const isFinal = (e: BrainEvent) => e.type === "done" || e.type === "error";

type Item = { kind: "event"; event: BrainEvent } | { kind: "stream_end" } | { kind: "reply"; final: BrainEvent };

/** A tiny async queue with an optional wait limit. */
class Queue {
  private items: Item[] = [];
  private waiter: ((item: Item | null) => void) | null = null;

  push(item: Item) {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w(item);
    } else this.items.push(item);
  }

  next(timeoutMs?: number): Promise<Item | null> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.waiter = (i) => {
        if (timer) clearTimeout(timer);
        resolve(i);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiter = null;
          resolve(null);
        }, timeoutMs);
      }
    });
  }
}

export function createClaudeCodeBrain(deps: ClaudeCodeBrainDeps): Brain {
  return {
    kind: "claude_code",
    async *run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent> {
      const session = turn.session;
      if (!session) {
        yield err("no_session", "This agent has no computer for Claude Code.", true);
        return;
      }
      const status = await deps.hub.status(session.machineId).catch(() => null);
      const unavailable = claudeCodeAvailability(status, turn.account);
      if (unavailable) {
        yield unavailable;
        return;
      }
      const queue = new Queue();
      let steering = false;
      const off = deps.pubsub.subscribe(brainTopic(turn.runId), (e) => {
        // Only the agent's own computer speaks for this run.
        if (e.machineId !== session.machineId) return;
        if (e.type === "brain.done") return queue.push({ kind: "stream_end" });
        if (e.type !== "brain.event") return;
        const event = parseBrainEvent(e.event);
        if (event) queue.push({ kind: "event", event: toBrainEvent(event) });
      });
      try {
        const [agent, personalMcp] = await Promise.all([
          deps.agentScope(turn),
          Promise.resolve(deps.personalMcp?.(turn) ?? false),
        ]);
        const permissions = await deps.permissions?.(turn);
        // The team's right hand on a plan (ADR 0137 §4): only a runner that locks the CLI down to our tools gets it,
        // in its own empty folder, with no checkout and none of the owner's servers.
        const chat = permissions?.mode === "chat";
        if (chat && (status?.protocol ?? 0) < LOCKED_BRAIN_PROTOCOL) {
          yield err(
            "runner_outdated",
            `The runner on the computer is too old to keep Claude Code to the right hand's tools. ${runnerUpdateWay(status)}`,
            true,
          );
          return;
        }
        // An older runner's `plan` lets the CLI read secrets and loads the project's settings files: the
        // turn waits for an updated runner instead of reading with more power than asked for (§3).
        if (permissions?.mode === "plan" && (status?.protocol ?? 0) < BRAIN_PROFILES_PROTOCOL) {
          yield err(
            "runner_outdated",
            `The runner on the computer is too old to keep Claude Code within this agent's permissions. ${runnerUpdateWay(status)}`,
            true,
          );
          return;
        }
        const code = chat ? null : await (turn.code ?? deps.prepare?.(turn, io.signal))?.catch(() => null);
        // A runner that takes the conversation apart reads it at the start of the session: the system text stays the
        // agent's, the same in each of its conversations (and its cached prefix with it).
        const apart = (status?.protocol ?? 0) >= CONVERSATION_PROTOCOL;
        const request: BrainTurnRequest = {
          runId: turn.runId,
          kind: "claude_code",
          session: { id: session.id, resume: session.resume },
          cwd: code?.cwd || session.cwd,
          ...(turn.model ? { model: turn.model } : {}),
          system: apart ? turn.system : systemWithConversation(turn, code?.prompt),
          ...(apart ? { conversation: [turn.conversation, code?.prompt].filter(Boolean).join("\n\n") } : {}),
          prompt: computerPrompt(turn, code?.start),
          mcp: { token: deps.mcpToken?.(turn) ?? randomBytes(24).toString("base64url") },
          keepAlive: deps.keepAlive !== false,
          personalMcp: personalMcp && !chat,
          ...(permissions ? { permissions } : {}),
          ...accountFields(status?.protocol, turn),
          ...contextFields(status?.protocol, turn),
          ...(turn.personWaiting ? { personWaiting: true } : {}),
        };
        deps.hub
          .call<"brain.turn">(
            session.machineId,
            { op: "brain.turn", ...request, agent },
            { signal: io.signal, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) },
          )
          .then(
            (reply) => {
              const final = parseBrainEvent(reply?.final);
              queue.push({
                kind: "reply",
                final:
                  final && isFinal(toBrainEvent(final))
                    ? toBrainEvent(final)
                    : err("runner_error", "The computer answered without an end to the turn.", false),
              });
            },
            (error: unknown) => queue.push({ kind: "reply", final: claudeCodeCallError(error) }),
          );
        // The turn is on its way: a person's messages can reach it mid-turn (an older runner reads them at the end).
        if (io.steerable && (status?.protocol ?? 0) >= STEER_PROTOCOL) {
          const target = {
            machineId: session.machineId,
            runId: turn.runId,
            session: session.id,
            agent,
            ...(deps.steerTimeoutMs ? { timeoutMs: deps.steerTimeoutMs } : {}),
          };
          io.steerable((messages) => steerOnMachine(deps.hub, target, messages));
          steering = true;
        }
        let streamEnded = false;
        let replyFinal: BrainEvent | null = null;
        for (;;) {
          const item = await queue.next(replyFinal ? (streamEnded ? 0 : (deps.finalGraceMs ?? 1500)) : undefined);
          if (item === null) {
            if (replyFinal) yield replyFinal;
            return;
          }
          if (item.kind === "event") {
            yield item.event;
            if (isFinal(item.event)) return;
          } else if (item.kind === "stream_end") {
            streamEnded = true;
          } else {
            replyFinal = item.final;
          }
        }
      } finally {
        if (steering) io.steerable?.(null);
        off();
      }
    },
  };
}

/**
 * Records a computer brain's plan usage (source "plan"): tokens with the
 * run, agent and org, cost zero, billed to the owner's plan. The engine calls
 * it for each `usage` event with `source: "plan"` (the Model Gateway records
 * API usage itself), and the router for a plan that picked who answers
 * (kind `router`, no run).
 */
export async function recordPlanUsage(
  db: Database,
  input: {
    orgId: string;
    agentId: string;
    runId?: string;
    kind?: "agent" | "router";
    /** The person behind the run (ADR 0141): the row names them and their month counts the API-equivalent. */
    personId?: string | null;
    /** `claude_code` or `codex`. */
    provider: string;
    /** The computer the turn ran on and the account it spent; `accountId` null: that computer's own sign-in. */
    machineId?: string;
    accountId?: string | null;
    model?: string;
    /** Every input token the turn read, cache included. */
    inputTokens: number;
    outputTokens: number;
    /** How much of `inputTokens` was read from, or written to, the cache (older runners: unknown, 0). */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): Promise<string | null> {
  const cacheRead = Math.max(0, Math.round(input.cacheReadTokens ?? 0));
  const cacheWrite = Math.max(0, Math.round(input.cacheWriteTokens ?? 0));
  const [row] = await db
    .insert(schema.usageRecords)
    .values({
      orgId: input.orgId,
      agentId: input.agentId,
      kind: input.kind ?? "agent",
      runId: input.runId ?? null,
      credentialId: null,
      provider: input.provider,
      model: input.model ?? input.provider,
      requestedModel: input.model ?? input.provider,
      // Stored like API usage: uncached input apart from cache reads and writes (the totals are the same).
      inputTokens: Math.max(0, Math.round(input.inputTokens) - cacheRead - cacheWrite),
      outputTokens: Math.max(0, Math.round(input.outputTokens)),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costNanoUsd: 0,
      billedTo: "plan",
      machineId: input.machineId ?? null,
      brainAccountId: input.machineId ? (input.accountId ?? null) : null,
      personId: input.personId ?? null,
    })
    .returning({ id: schema.usageRecords.id, inputTokens: schema.usageRecords.inputTokens });
  if (row && input.personId) {
    // One unit for everything: a plan's tokens count at what they would cost through the API.
    const equivalent = apiNano(input.model ?? null, {
      input: row.inputTokens,
      output: Math.max(0, Math.round(input.outputTokens)),
      cacheRead,
      cacheWrite,
    });
    if (equivalent)
      await addPersonSpend(db, { orgId: input.orgId, personId: input.personId, amountNanoUsd: equivalent });
  }
  return row?.id ?? null;
}

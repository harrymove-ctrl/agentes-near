import {
  type AgentScope,
  ANTIGRAVITY_PROTOCOL,
  BRAIN_PROFILES_PROTOCOL,
  BRAIN_PROTOCOL,
  type BrainTurnRequest,
  brainTopic,
  CODEX_FOLDER_PROTOCOL,
  CURSOR_PROTOCOL,
  GROK_PROTOCOL,
  LOCKED_BRAIN_PROTOCOL,
  OPENCODE_PROTOCOL,
  type PubSub,
  parseBrainEvent,
  STEER_PROTOCOL,
} from "@agenteschat/adapters";
import type { CodeSetup } from "../git/machine";
import type { MachineCaller } from "../machine-hub";
import { MachineDroppedError, MachineOfflineError, MachinePausedError, pausedMessage } from "../machines";
import { CODEX_MIN_VERSION, versionOf } from "../missions";
import { runnerUpdateWay } from "../runner-update";
import {
  accountFields,
  accountUnavailable,
  busyRefusal,
  contextFields,
  speedFields,
  steerOnMachine,
} from "./claude-code";
import { computerPrompt, systemWithConversation } from "./prompt";
import type { Brain, BrainEvent, BrainIO, BrainTurn, SteerMessage, SteerReply } from "./types";

/**
 * The Codex brain (ADR 0032, ADR 0029 "Codex"): one agent turn runs on the
 * agent's connected computer (a long-lived `codex app-server`, or
 * `codex exec --json` where that can't run), through the runner's
 * `brain.turn` op. The runner owns the Codex side (command line, our session
 * → Codex thread id, JSONL → `BrainEvent`, the MCP bridge config); this brain
 * checks the computer can run it, builds the request (context on the first
 * turn, the new messages on a resumed one) and passes the events through,
 * making sure the turn ends with exactly one `done` or `error`.
 *
 * Tools run through the runner's MCP bridge (the engine's Tool Gateway with
 * the run's identity), so `io.executeTool` is never used here; Codex's own
 * commands and file edits arrive as `tool_call` with `executed` (transcript
 * only). Usage is the person's plan (`source: "plan"`, cost zero).
 *
 * Live steering (runner protocol 15): once the turn is sent, the brain hands
 * the engine `steer` (`BrainIO.steerable`, `brain.steer`); an app-server turn
 * takes the messages (`turn/steer`) and says which it read (`steer_read`); an
 * exec turn answers `unsupported` and they wait for its end, as before.
 *
 * Permissions (ADR 0053 §3): every turn carries its profile (`plan` reads in a
 * read-only sandbox without network; `work` has each of Codex's approvals
 * answered by the command policy) and a background turn `keepAlive: false`.
 * A runner older than `BRAIN_PROFILES_PROTOCOL` would run Codex with no
 * approvals and the network on: the turn fails with `runner_outdated` instead.
 */

/** `brain.turn` as the server sends it to the runner (the shared wire type, `machine-protocol.ts`). */
export type { BrainTurnRequest };

/** What the brain needs from the machine hub (the integrator wires it to `brain.turn` / `brain.event`). */
export interface ComputerBrainLink {
  status(machineId: string): Promise<{
    online: boolean;
    execAllowed: boolean;
    /** The runner's protocol (absent: not checked). */
    protocol?: number;
    executors: {
      codex?: { version: string };
      claude?: { version: string };
      cursor?: { version: string };
      opencode?: { version: string };
      grok?: { version: string };
      antigravity?: { version: string };
      /** Every agent as its own user (`runnerUpdateWay`). */
      mode?: "system";
    };
    /** `managed`: the workspace's own computer, which updates by itself. */
    kind?: string;
    /** The owner paused the computer (protocol 9; absent: not checked). */
    paused?: { until: string | null; timezone: string | null } | null;
    name?: string;
    /** Who connected the computer; null: nobody (a server), absent: not known. */
    pairedByUserId?: string | null;
    /** What the machine allows (protocol 10): with it, Codex needs its own tool on, not commands. */
    access?: {
      tools: {
        claude: boolean;
        codex: boolean;
        cursor?: boolean;
        opencode?: boolean;
        grok?: boolean;
        antigravity?: boolean;
        commands: boolean;
      };
    } | null;
  } | null>;
  /** Sends `brain.turn` and calls `onEvent` per `brain.event`; resolves on `brain.done`. */
  turn(
    machineId: string,
    request: BrainTurnRequest & { agent?: AgentScope },
    options: { signal: AbortSignal; onEvent: (event: BrainEvent) => void },
  ): Promise<void>;
  /**
   * Protocol 15: messages for the turn of `runId` in progress (`brain.steer`).
   * A runner whose Codex turn can't take them (`codex exec`) answers
   * `unsupported`; without it, Codex turns read new messages at their end.
   */
  steer?(
    machineId: string,
    target: { runId: string; session: string; agent: AgentScope },
    messages: SteerMessage[],
  ): Promise<SteerReply>;
}

export interface CodexBrainDeps {
  link: ComputerBrainLink;
  /** A fresh MCP bridge token for this run (and the bridge URL when it is HTTP). */
  mcp(turn: BrainTurn): Promise<{ token: string; url?: string }>;
  /** The agent's folder scope on the machine (id + handle). */
  agent?(turn: BrainTurn): Promise<AgentScope | undefined>;
  /** Before a chat turn: the agent's checkouts updated, where it starts and the "# Your code" block (`prepareAgentCode`). */
  prepare?(turn: BrainTurn, signal: AbortSignal): Promise<CodeSetup | null>;
  /** The turn's permission profile (missions: their own; other runs: `work`, ADR 0109). */
  permissions?(turn: BrainTurn): Promise<BrainTurnRequest["permissions"] | undefined>;
  /** False for a background run: the runner keeps no Codex process for it after the turn. */
  keepAlive?: boolean;
}

/** `codex-cli 0.163.0` is new enough (`CODEX_MIN_VERSION`). */
export function codexVersionOk(version: string | undefined): boolean {
  const have = versionOf(version);
  const want = versionOf(CODEX_MIN_VERSION) as number[];
  if (!have) return false;
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
}

/** Events pushed by a callback, read as an async iterable. */
function channel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(v: T) {
      queue.push(v);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *read(): AsyncGenerator<T> {
      for (;;) {
        while (queue.length) yield queue.shift() as T;
        if (ended) return;
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = null;
      }
    },
  };
}

/**
 * What tells one runner-driven CLI brain from another: Codex, or Cursor (ADR 0114: `agent -p` per turn on runner
 * protocol 36, no version gate, no live steering). Everything else, from the request to the events, is shared.
 */
interface CliBrainSpec {
  kind: "codex" | "cursor" | "opencode" | "grok" | "antigravity";
  name: string;
  /** The runner protocol it needs. */
  protocol: number;
  /** The CLI is installed (`hello.executors`) and new enough; else why not. */
  check(executors: {
    codex?: { version: string };
    cursor?: { version: string };
    opencode?: { version: string };
    grok?: { version: string };
    antigravity?: { version: string };
  }): BrainEvent | null;
}

const CODEX_CLI: CliBrainSpec = {
  kind: "codex",
  name: "Codex",
  protocol: BRAIN_PROTOCOL,
  check({ codex }) {
    if (!codex) {
      return {
        type: "error",
        code: "codex_missing",
        message: "Codex is not installed on the computer.",
        retryable: true,
      };
    }
    if (!codexVersionOk(codex.version)) {
      return {
        type: "error",
        code: "codex_too_old",
        message: `Codex on the computer is ${codex.version}. Agents need ${CODEX_MIN_VERSION} or newer (update it there).`,
        retryable: true,
      };
    }
    return null;
  },
};

const CURSOR_CLI: CliBrainSpec = {
  kind: "cursor",
  name: "Cursor",
  protocol: CURSOR_PROTOCOL,
  check: ({ cursor }) =>
    cursor
      ? null
      : {
          type: "error",
          code: "cursor_missing",
          message: "Cursor's CLI is not installed on the computer.",
          retryable: true,
        },
};

const OPENCODE_CLI: CliBrainSpec = {
  kind: "opencode",
  name: "OpenCode",
  protocol: OPENCODE_PROTOCOL,
  check: ({ opencode }) =>
    opencode
      ? null
      : {
          type: "error",
          code: "opencode_missing",
          message: "OpenCode's CLI is not installed on the computer.",
          retryable: true,
        },
};

const GROK_CLI: CliBrainSpec = {
  kind: "grok",
  name: "Grok Build",
  protocol: GROK_PROTOCOL,
  check: ({ grok }) =>
    grok
      ? null
      : {
          type: "error",
          code: "grok_missing",
          message: "Grok Build, xAI's CLI, is not installed on the computer.",
          retryable: true,
        },
};

const ANTIGRAVITY_CLI: CliBrainSpec = {
  kind: "antigravity",
  name: "Antigravity CLI",
  protocol: ANTIGRAVITY_PROTOCOL,
  check: ({ antigravity }) =>
    antigravity
      ? null
      : {
          type: "error",
          code: "antigravity_missing",
          message: "The Antigravity CLI, Google's, is not installed on the computer.",
          retryable: true,
        },
};

export class CodexBrain implements Brain {
  readonly kind: "codex" | "cursor" | "opencode" | "grok" | "antigravity";

  constructor(
    private readonly deps: CodexBrainDeps,
    private readonly cli: CliBrainSpec = CODEX_CLI,
  ) {
    this.kind = cli.kind;
  }

  async *run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent> {
    const session = turn.session;
    const { name } = this.cli;
    if (!session) {
      yield { type: "error", code: "no_session", message: `The ${name} brain needs a session on a computer.` };
      return;
    }
    const status = await this.deps.link.status(session.machineId);
    if (!status?.online) {
      yield { type: "error", code: "machine_offline", message: "The computer is offline.", retryable: true };
      return;
    }
    if (status.paused) {
      const message = pausedMessage(status.name ?? "", status.paused.until, status.paused.timezone);
      yield { type: "error", code: "machine_paused", message, retryable: true };
      return;
    }
    const tools = status.access?.tools;
    const toolOn = tools && (this.kind === "codex" ? tools.codex : (tools[this.kind] ?? tools.codex));
    if (tools ? toolOn !== true : !status.execAllowed) {
      yield tools
        ? {
            type: "error",
            code: "tool_off",
            message: `${name} is turned off on the computer (its owner can turn it on in the agentes app).`,
            retryable: true,
          }
        : {
            type: "error",
            code: "exec_disabled",
            message: "Commands are turned off on the computer (its runner was started with --no-exec).",
            retryable: true,
          };
      return;
    }
    if (status.protocol !== undefined && status.protocol < this.cli.protocol) {
      yield {
        type: "error",
        code: "runner_outdated",
        message: `The runner on the computer is too old for agents that think with ${name}. ${runnerUpdateWay(status)}`,
        retryable: true,
      };
      return;
    }
    const missing = this.cli.check(status.executors);
    if (missing) {
      yield missing;
      return;
    }
    const account = accountUnavailable(status, turn.account, this.kind);
    if (account) {
      yield { type: "error", code: account.code, message: account.message, retryable: true };
      return;
    }
    // OpenCode with no account on a computer nobody connected: its free tier, never a key the computer holds.
    const freeTier = this.kind === "opencode" && !turn.account && status.pairedByUserId === null;
    if (freeTier && turn.model && !turn.model.startsWith("opencode/")) {
      yield {
        type: "error",
        code: "not_logged_in",
        message: `${name} isn't signed in on ${status.name ?? "the computer"}: only OpenCode's own models work there. Choose one, or connect an OpenCode account on the agent's page.`,
        retryable: true,
      };
      return;
    }
    const permissions = await this.deps.permissions?.(turn);
    // An older runner ignores the profile (no approvals, network on): never more power than asked for.
    if (permissions && status.protocol !== undefined && status.protocol < BRAIN_PROFILES_PROTOCOL) {
      yield {
        type: "error",
        code: "runner_outdated",
        message: `The runner on the computer is too old to keep ${name} within this agent's permissions. ${runnerUpdateWay(status)}`,
        retryable: true,
      };
      return;
    }
    // The team's right hand (ADR 0137 §4): only a runner that locks the CLI down to our tools gets the turn, with no
    // checkout.
    const chat = permissions?.mode === "chat";
    if (chat && (status.protocol ?? 0) < LOCKED_BRAIN_PROTOCOL) {
      yield {
        type: "error",
        code: "runner_outdated",
        message: `The runner on the computer is too old to keep ${name} to the right hand's tools. ${runnerUpdateWay(status)}`,
        retryable: true,
      };
      return;
    }

    // An older runner never finds the agent's checkouts from a Codex turn: it stays in the agent's folder, and in
    // its session, instead of being refused there.
    const checkouts = status.protocol === undefined || status.protocol >= CODEX_FOLDER_PROTOCOL;
    const [mcp, agent, code] = await Promise.all([
      this.deps.mcp(turn),
      this.deps.agent?.(turn),
      checkouts && !chat ? (turn.code ?? this.deps.prepare?.(turn, io.signal))?.catch(() => null) : null,
    ]);
    // A kept-alive Codex lists our tools once, as its thread opens: the runner starts it again when a name is new.
    const toolNames = turn.tools.map((t) => t.name).sort();
    const request: BrainTurnRequest & { agent?: AgentScope } = {
      runId: turn.runId,
      kind: this.kind,
      session: { id: session.id, resume: session.resume },
      cwd: code?.cwd || session.cwd,
      ...(turn.model ? { model: turn.model } : {}),
      system: systemWithConversation(turn, code?.prompt),
      prompt: computerPrompt(turn, code?.start),
      mcp: { ...mcp, tools: toolNames.join(" ") },
      ...(agent ? { agent } : {}),
      ...accountFields(status.protocol, turn),
      ...contextFields(status.protocol, turn),
      ...speedFields(status.protocol, turn),
      ...(permissions ? { permissions } : {}),
      ...(this.deps.keepAlive === false ? { keepAlive: false } : {}),
      ...(freeTier ? { freeTier } : {}),
      ...(turn.personWaiting ? { personWaiting: true } : {}),
    };

    const events = channel<BrainEvent>();
    let text = "";
    let ended = false;
    const state: { failure?: unknown } = {};
    const sent = this.deps.link
      .turn(session.machineId, request, {
        signal: io.signal,
        onEvent: (event) => events.push(event),
      })
      .catch((error: unknown) => {
        state.failure = error ?? new Error("The runner failed");
      })
      .finally(() => events.end());

    // The turn is on its way: on a runner that runs Codex as an app-server, a person's messages reach it mid-turn.
    const steer = this.deps.link.steer?.bind(this.deps.link);
    let steering = false;
    if (io.steerable && steer && agent && (status.protocol ?? 0) >= STEER_PROTOCOL) {
      const target = { runId: turn.runId, session: session.id, agent };
      io.steerable((messages) => steer(session.machineId, target, messages));
      steering = true;
    }
    try {
      for await (const event of events.read()) {
        if (ended) continue;
        if (event.type === "text_delta") text += event.text;
        if (event.type === "done") {
          ended = true;
          yield { type: "done", text: event.text, session: { id: session.id } };
          continue;
        }
        if (event.type === "error") ended = true;
        yield event;
      }
    } finally {
      if (steering) io.steerable?.(null);
    }
    await sent;
    if (ended) return;
    if (io.signal.aborted) {
      yield { type: "error", code: "canceled", message: "The turn was canceled." };
    } else if (state.failure instanceof MachineOfflineError) {
      // The computer dropped mid-turn: the engine waits for it and resumes the turn there.
      yield {
        type: "error",
        code: "machine_offline",
        message: state.failure.message,
        retryable: true,
        ...(state.failure instanceof MachineDroppedError && state.failure.serverStop ? { serverStop: true } : {}),
      };
    } else if (state.failure instanceof MachinePausedError) {
      yield { type: "error", code: "machine_paused", message: state.failure.message, retryable: true };
    } else if (state.failure !== undefined) {
      const message = state.failure instanceof Error ? state.failure.message : String(state.failure);
      yield busyRefusal(state.failure) ?? { type: "error", code: "runner_failed", message, retryable: true };
    } else {
      // The runner finished without saying how: what it streamed is the answer.
      yield { type: "done", text, session: { id: session.id } };
    }
  }
}

/**
 * The Cursor brain (ADR 0114): Cursor's CLI on the agent's computer with a person's Cursor plan, through the same
 * `brain.turn` as Codex (`kind: "cursor"`, runner protocol 36, `brain-cursor.ts` there). A person's messages wait for
 * the turn's end: the runner answers `brain.steer` with `unsupported`.
 */
export class CursorBrain extends CodexBrain {
  constructor(deps: CodexBrainDeps) {
    super(deps, CURSOR_CLI);
  }
}

/**
 * The OpenCode brain (ADR 0132): OpenCode's CLI on the agent's computer, on OpenCode's free tier or a person's OpenCode
 * key, through the same `brain.turn` as Codex (`kind: "opencode"`, runner protocol 39, `brain-opencode.ts` there). A
 * person's messages wait for the turn's end: the runner answers `brain.steer` with `unsupported`.
 */
export class OpencodeBrain extends CodexBrain {
  constructor(deps: CodexBrainDeps) {
    super(deps, OPENCODE_CLI);
  }
}

/**
 * The Grok brain (ADR 0142): xAI's Grok Build CLI on the agent's computer with a person's SuperGrok or X Premium+
 * plan, through the same `brain.turn` as Codex (`kind: "grok"`, runner protocol 43, `brain-grok.ts` there). A person's
 * messages wait for the turn's end: the runner answers `brain.steer` with `unsupported`.
 */
export class GrokBrain extends CodexBrain {
  constructor(deps: CodexBrainDeps) {
    super(deps, GROK_CLI);
  }
}

/**
 * The Antigravity brain (ADR 0143): Google's Antigravity CLI (`agy`) on the agent's computer with a person's Google
 * AI Pro or Ultra plan or a Gemini Enterprise seat, through the same `brain.turn` as Codex (`kind: "antigravity"`,
 * runner protocol 44, `brain-antigravity.ts` there). A person's messages wait for the turn's end.
 */
export class AntigravityBrain extends CodexBrain {
  constructor(deps: CodexBrainDeps) {
    super(deps, ANTIGRAVITY_CLI);
  }
}

/**
 * The `ComputerBrainLink` over the machine hub: `brain.turn` goes to the
 * machine (whichever replica holds its socket), `brain.event` frames come
 * back on `brainTopic(runId)`; the request's result repeats the final event,
 * so the turn ends even if a published event is lost.
 */
export function hubBrainLink(deps: {
  hub: Pick<MachineCaller, "call" | "status">;
  pubsub: PubSub;
  timeoutMs?: number;
  /** After the request's result, how long to wait for the stream's last events (default 1.5 s). */
  finalGraceMs?: number;
}): ComputerBrainLink {
  return {
    status: (machineId) => deps.hub.status(machineId).catch(() => null),
    steer: (machineId, target, messages) => steerOnMachine(deps.hub, { machineId, ...target }, messages),
    async turn(machineId, request, options) {
      let streamEnded = false;
      let finalSeen = false;
      let wake: (() => void) | null = null;
      const off = deps.pubsub.subscribe(brainTopic(request.runId), (e) => {
        if (e.machineId !== machineId) return;
        if (e.type === "brain.done") {
          streamEnded = true;
          wake?.();
          return;
        }
        if (e.type !== "brain.event") return;
        const event = parseBrainEvent(e.event);
        if (!event) return;
        if (event.type === "done" || event.type === "error") finalSeen = true;
        options.onEvent(event as BrainEvent);
      });
      try {
        const reply = await deps.hub.call<"brain.turn">(
          machineId,
          { op: "brain.turn", ...request },
          { signal: options.signal, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) },
        );
        if (!streamEnded) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, deps.finalGraceMs ?? 1500);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        // The stream lost its last event: the reply carries it.
        const final = parseBrainEvent(reply?.final);
        if (!finalSeen && final && (final.type === "done" || final.type === "error"))
          options.onEvent(final as BrainEvent);
      } finally {
        off();
      }
    },
  };
}

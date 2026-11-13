import type { BrainEffort, BrainSpeed, ProviderFailureCause } from "@agenteschat/adapters";
import { planOf } from "@agenteschat/providers/plans";
import type { CodeSetup } from "../git/machine";

export type BrainKind = "model" | "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";

/** A brain that runs on the agent's computer with a person's plan (ADR 0114 adds Cursor). */
export type ComputerBrainKind = Exclude<BrainKind, "model">;

/** What people call each computer brain's CLI, in messages. */
export const BRAIN_NAMES: Readonly<Record<ComputerBrainKind, string>> = {
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok Build",
  antigravity: "Antigravity CLI",
};

/** The plan each computer brain thinks with, as people buy it. */
export const BRAIN_PLAN_NAMES: Readonly<Record<ComputerBrainKind, string>> = {
  claude_code: "Claude",
  codex: "ChatGPT",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
  antigravity: "Gemini",
};

/** Brains that run on the agent's computer with a person's plan. */
export const isComputerBrain = (v: unknown): v is ComputerBrainKind =>
  v === "claude_code" || v === "codex" || v === "cursor" || v === "opencode" || v === "grok" || v === "antigravity";

/**
 * Brains whose shell runs in a sandbox of the CLI's own (ADR 0053 §3, 0114, 0142, 0143), the limit of what their turns
 * do. Claude Code's own sandbox is never switched on here, and OpenCode has none.
 */
export const isSandboxedBrain = (v: unknown) => v === "codex" || v === "cursor" || v === "grok" || v === "antigravity";

/** The plan's name in a note: the coding plan's maker, else Claude's or ChatGPT's. */
export function planName(kind: BrainKind, provider?: string): string {
  const plan = planOf(provider);
  if (plan) return provider === "opencode" ? plan.name : plan.maker;
  return isComputerBrain(kind) ? BRAIN_PLAN_NAMES[kind] : "Claude";
}

/** The account a computer brain runs with (ADR 0041): a folder on the agent's machine. */
export interface BrainAccount {
  id: string;
  /** What people call it, for messages. */
  label: string;
  status: "active" | "signed_out";
  /** A key account's coding plan (`zai`…), which names the models it runs. */
  provider?: string;
}

/** A tool as the engine offers it to a brain (same data the Tool Gateway lists for the run). */
export interface BrainTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
  /** The same in every run of the agent (`ToolSpec.stable`): the model brain's cached start of the tool list. */
  stable?: boolean;
  /**
   * A computer brain's harness lists it with its schema from the first round instead of holding it behind its own
   * tool search (the bridge's `tools/list`).
   */
  upFront?: boolean;
}

/** What a computer brain needs to reach the agent's machine. */
export interface BrainSession {
  /** Stable per thread (or per mission session): the executor's session id. */
  id: string;
  /** True when the session already exists on the machine (resume), false to start it. */
  resume: boolean;
  machineId: string;
  /** Folder on the machine (relative to the agent folder), e.g. "" or a mission repo dir. */
  cwd: string;
  /** Start in the agent's own folder, never one of its checkouts: the folder of its session before was gone. */
  ownFolder?: boolean;
}

export interface BrainTurn {
  runId: string;
  orgId: string;
  agentId: string;
  /** The person behind the run (ADR 0141): the model brain's calls count for them; null: nobody's. */
  personId?: string | null;
  channelId: string;
  threadRootId: string | null;
  /** The engine-built context (context.ts): system text + conversation, same for every brain. */
  system: string;
  /**
   * Computer brains: what holds for this conversation only ("# This conversation", `conversationText`), left out of
   * `system` so that is the same in every conversation of the agent. Read once per session (`systemWithConversation`
   * where a brain takes none apart).
   */
  conversation?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Tools this run may use (from the Tool Gateway, scopes applied). */
  tools: BrainTool[];
  /** Model id or alias for this brain ("claude-opus-5-5", "opus", "sonnet", "gpt-…"); undefined = brain default. */
  model?: string;
  /** Computer brains only. */
  session?: BrainSession;
  /** Computer brains: the account to run with (absent: the computer's own sign-in). */
  account?: BrainAccount;
  /** How hard it thinks (absent: the CLI's or the API's default); the model brain only gets one from "Automático". */
  effort?: BrainEffort;
  /** Codex: `fast` on a conversation's turn of an agent set to it (`brainSpeedFor`); absent: standard speed. */
  speed?: BrainSpeed;
  /** Computer brains: the agent's context limit in tokens (`agents.context_tokens`); absent: the model's window. */
  contextTokens?: number;
  /** Computer brains: a person waits on this turn (the line's first rank); the runner holds a slot for one. */
  personWaiting?: boolean;
  /** The text the person/system sent that starts this turn (also the last user message). */
  trigger: string;
  /**
   * Computer brains: the checkouts' sync already started for this turn (during the quiet window), used instead of
   * starting one (`prepareAgentCode`).
   */
  code?: Promise<CodeSetup | null>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** The call is gated: the run pauses until a person decides (ADR 0015 approval or ask_user). */
  pause?: { kind: "approval" | "input"; id: string };
}

/** A person's message handed to a computer brain's turn in progress (live steering). */
export interface SteerMessage {
  /** A fresh UUID per handoff: `steer_read` names it once the turn read it. */
  uuid: string;
  /** Rendered as the loop renders messages read between turns. */
  text: string;
  /** "Parar e mandar": read now (the running tool moved to the background); a brain that can't is `unsupported`. */
  urgent?: boolean;
}

/**
 * `accepted`: handed to the turn (read later: `steer_read`). `unsupported`:
 * this turn can't take messages mid-turn (they wait for its end), or not an
 * urgent one (the turn is stopped and started again instead). `no_turn`: the
 * turn isn't there (just ended, or not started yet).
 */
export type SteerReply =
  | { status: "accepted"; accepted: string[] }
  | { status: "unsupported" | "no_turn"; reason?: string };

export interface BrainIO {
  signal: AbortSignal;
  /** Model brain: the engine executes tool calls through the Tool Gateway. */
  executeTool(call: { id: string; name: string; input: unknown }): Promise<ToolResult>;
  /**
   * Computer brains that can take messages mid-turn (Claude Code on runner
   * protocol 15) hand the engine a way to, once the turn is on its way, and
   * `null` when it ends. Brains that can't never call it.
   */
  steerable?(steer: ((messages: SteerMessage[]) => Promise<SteerReply>) | null): void;
}

export type BrainEvent =
  | { type: "text_delta"; text: string }
  /** `executed` present = already executed elsewhere (computer brains via the MCP bridge): the engine only records/displays it. */
  | { type: "tool_call"; id: string; name: string; input: unknown; executed?: ToolResult }
  | {
      type: "usage";
      /** Every input token the turn read (cache included); `cacheRead`/`cacheWrite` say how much of it was cache. */
      input: number;
      output: number;
      source: "api" | "plan";
      model?: string;
      cacheRead?: number;
      cacheWrite?: number;
      /** Claude Code: the API calls the turn made, and the most uncached input one of them read. */
      calls?: number;
      maxUncached?: number;
    }
  | { type: "limit"; resetsAt?: string }
  | { type: "done"; text: string; session?: { id: string } }
  | {
      type: "error";
      code: string;
      message: string;
      retryable?: boolean;
      /** The computer dropped because our own server stopped (a restart): never from the runner's wire. */
      serverStop?: boolean;
      /** A `plan_limit`: whether the turn used a tool before it was cut (absent: an older runner, counted as worked). */
      worked?: boolean;
      /** Claude Code (runner protocol 50): why the provider refused or failed it, and its HTTP status. */
      cause?: ProviderFailureCause;
      httpStatus?: number;
    }
  /** Messages handed mid-turn (`BrainIO.steerable`) that the turn read, by their `uuid`. */
  | { type: "steer_read"; uuids: string[] }
  /** Fast failed (`message`: the provider's words) and this turn answered at standard speed. */
  | { type: "speed_fallback"; message: string }
  /** A computer brain started a call of its own: shown only, its `tool_call` with `executed` follows. */
  | { type: "tool_started"; id: string; name: string };

export interface Brain {
  kind: BrainKind;
  run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent>;
}

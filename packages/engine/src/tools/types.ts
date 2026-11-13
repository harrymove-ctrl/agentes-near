import type { Database, schema } from "@agenteschat/db";
import type { ToolImage } from "@agenteschat/providers";
import type { OutcomeKind } from "../context/outcomes";
import type { JsonSchema } from "./json-schema";

type ApprovalRow = typeof schema.approvals.$inferSelect;

/** `schedule_action`'s ask (`ToolContext.prepareAhead`): one exact call of a connected app's tool, for a routine's run. */
export interface AheadRequest {
  /** The tool's name as listed (a big connector's real tool too). */
  tool: string;
  input: Record<string, unknown>;
  why: string;
  /** Makes or finds the run it is for, called only once the call passed every check. */
  slot(): Promise<{ routineId: string; runAt: Date }>;
}

export type AheadOutcome = { ok: true; approval: ApprovalRow } | { ok: false; message: string };

/** Who is calling a tool: always an agent inside a run. */
export interface ToolContext {
  db: Database;
  orgId: string;
  agentId: string;
  runId: string;
  channelId: string;
  threadRootId: string;
  triggerMessageId: string;
  /** The model's id of this tool call (set by the gateway): live output events refer to it. */
  toolUseId?: string;
  /** Aborted when a person cancels the run: long tools (running code) stop early. */
  signal?: AbortSignal;
  /**
   * The call came through the runner's `agentes` MCP bridge (ADR 0032): a
   * computer brain (Claude Code, Codex) on this machine. `taskId`: a mission
   * task's executor (its tools are the mission's, bound to that task). Tools
   * only for computer brains (`permission_prompt`) look at this.
   */
  bridge?: { machineId: string; taskId?: string };
  /**
   * Tools on demand (ADR 0043): the tool groups this run loaded (`Transcript.toolGroups`); the others sit
   * behind `find_tools` / `use_tool`. Undefined or null: every tool is listed as is.
   */
  loadedGroups?: readonly string[] | null;
  /**
   * A background run (`agent_runs.background`, a routine's): `hand_off` is offered to it. What it may
   * do is the run policy's (`run-policy.ts`), read from who is behind the run, never from this flag.
   */
  background?: boolean;
  /**
   * The call runs because a person approved it (`executeApproved`): the computer runs its command even
   * when its command policy would hold it. Never set from a call's input.
   */
  approved?: boolean;
  /**
   * Set by the gateway for our own tools, never a connected server's (`schedule_action`): asks a person now to
   * approve one exact call for a routine's run later, after every check that call meets then (ADR 0015, ahead).
   */
  prepareAhead?(request: AheadRequest): Promise<AheadOutcome>;
}

export interface ToolOutput {
  /** Text the model sees as the tool result. */
  content: string;
  isError?: boolean;
  /** Pictures the model sees with the text (base64 PNG, JPEG, GIF or WebP): model brains only, never kept in steps. */
  images?: ToolImage[];
  /** Structured result kept in the run steps, not sent to the model. */
  data?: Record<string, unknown>;
  /** Ground truth this call produced (tests passed, PR merged…), recorded by the gateway. */
  outcome?: { kind: OutcomeKind; subject?: string; summary?: string; details?: Record<string, unknown> };
  /** Built-in `ask_user` only: suspend the run until a person answers this question (its `why` is the gateway's). */
  waitForAnswer?: { text: string; choices: string[] | null; requestedForUserId: string | null };
  /** `request_secret` only: suspend the run until the person answers this request (ADR 0027). */
  waitForSecret?: { requestId: string };
  /** `schedule_action` only: suspend the run until a person decides this approval (`prepareAhead` made it). */
  waitForApproval?: ApprovalRow;
}

export type ConnectorVia = schema.ConnectorVia;

/**
 * A tool an agent can call, from any source (built-in, MCP connector,
 * sandbox). Every call goes through the Tool Gateway, which checks `scope`
 * against the agent's grants, validates the input against `inputSchema`, and
 * turns `sensitive` calls into approval requests.
 */
export interface ToolDefinition {
  /** Name shown to the model: `^[a-zA-Z0-9_-]{1,64}$`, unique within a run. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * Scope the agent must hold, e.g. `context:read` or `github:pr.merge`.
   * Empty only for built-in tools every agent has (`ask_user`).
   */
  scope: string;
  /** Org connector connection the scope belongs to; null/undefined for built-in tools. */
  connectionId?: string | null;
  /**
   * A built-in tool the agent must also be allowed to call for this one to work (the desktop runs commands:
   * `run_code`). Without it the gateway neither lists nor runs this tool, and names that tool's scope.
   */
  needs?: { name: string; scope: string };
  /**
   * The connector this tool reaches and how (ADR 0103): each call counts toward its usage under `key`
   * (`connectorKeyOf`). `tool` is the server's own tool name or our verb, never the name the model sees.
   * Built-in tools leave it unset and are never counted.
   */
  connector?: { key: string; via: ConnectorVia; tool: string };
  /** The app's name for connector tools ("GitHub", "himetrica"), for activity indicators. */
  connectorLabel?: string;
  /**
   * The service it works in, for its logo in the chat: a catalog connector's or one-click preset's id (`github`),
   * a mailbox's provider (`gmail`, `outlook`) or IMAP preset (`icloud`; `custom` for a server of its own), or
   * `postgres`.
   */
  service?: string;
  /** A server connected by address: its own icon (`/api/app/connector-icons/…`). */
  serviceIcon?: string;
  /** What a connection's tool names start with (`stripe_2`): a big connector's directory is named with it. */
  toolPrefix?: string;
  /** Needs a person's approval for every call. Merge, deploy and rollback always do. */
  sensitive?: boolean;
  /**
   * A call that carries `why` (in the tool's own schema) asks a person's approval first: how an agent asks for
   * a command the computer held for a person (ADR 0053 §3, amended 2026-10-30).
   */
  whyAsks?: boolean;
  /**
   * The output is third-party content (an MCP server's answer: issues, pages,
   * messages anyone can write). The gateway hands it to the model inside an
   * `<external_data>` block so instructions in it read as data. Tools that
   * frame their own untrusted part (mail, databases, browser_read) leave it off.
   */
  external?: boolean;
  /**
   * The output is text from outside the org that the tool frames itself (a web page, an email, a desktop
   * screen, a routine's event): like `external`, its tool_result step is marked `outside`, so what the run
   * posts next carries `meta.readOutside` (ADR 0117). It changes nothing about the call itself.
   */
  readsOutside?: true;
  /** A mission's tool (agent mode, ADR 0029): its approvals are bound to that mission too. */
  missionId?: string;
  /**
   * A tool that runs other actions by name (Composio's executor): the actions a call runs, or null when its
   * input isn't a shape we know. A call whose actions all only read runs as the connection's read (`readScope`).
   */
  actions?(input: Record<string, unknown>): string[] | null;
  /** With `actions`: the scope of the connection's reads. */
  readScope?: string;
  /**
   * The server's own name for this tool, set only where "Aprovar sempre" may be offered on its approvals (custom
   * servers: only Composio's executor, whose `actions` say what each call does). Rules are kept by it, so they
   * outlive a renamed connection. The gateway still decides each call (`rememberable`).
   */
  rememberAs?: string;
  /**
   * A tool whose every call names one exact target (`request_branch_push`: `owner/repo:branch`): "Aprovar sempre"
   * keeps the tool's name and that target, and only a call naming the same target runs without asking. Null: this
   * call names none and can't be remembered.
   */
  rememberTarget?(input: Record<string, unknown>): string | null;
  /**
   * A tool that runs one shell command on the agent's computer (`run_code` in bash, a shell task): the command, so
   * "Aprovar sempre" may keep its kind for the agent (`commandKind`, no connection). Null: this call runs no plain
   * command.
   */
  rememberCommand?(input: Record<string, unknown>): string | null;
  /**
   * A connected server's tool that runs the SQL in `arg` (Supabase's `execute_sql`), by the server's own name `tool`:
   * "Aprovar sempre leituras" may cover its calls the Postgres guard proves read-only (`provenReadOnly`), one rule per
   * set of other arguments (the project or database the call names). A call it can't prove still asks.
   */
  sqlReads?: { tool: string; arg: string };
  /**
   * A call of it may be approved ahead for a routine's run (`schedule_action`): set by the connector source on a
   * connected app's own tools, never on one that runs anything its input says (a code workbench, a raw request).
   */
  ahead?: boolean;
  /** Human summary of a call, for approval cards. */
  describe?(input: Record<string, unknown>): { title: string; detail?: string };
  /**
   * Our own tools only (`request_approval`, ADR 0126; a person's own mailbox, ADR 0038): who decides this call's
   * approval instead of the agent's owner and admins; `requestedBy` is the person behind the run. A message refuses
   * the call (a role that isn't there); null approvers: the usual rule.
   */
  approvers?(
    input: Record<string, unknown>,
    ctx: ToolContext,
    requestedBy: string | null,
  ): Promise<{ ok: true; approvers: schema.ApprovalApprovers | null } | { ok: false; message: string }>;
  /**
   * Rules about this call's arguments (which folders, recipients, daily cap…),
   * run by the gateway after the scope check and schema validation, before
   * running or asking anyone, and again before an approved action runs.
   * Connector-wide rules (GitHub repositories) live in `tools/checks.ts`.
   */
  checkCall?(input: Record<string, unknown>, ctx: ToolContext): Promise<CallCheck>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * Result of a per-call check. An allowed call's `data` is merged into the
 * tool result's data; a refusal's `message` is what the model sees and its
 * `data` is kept in the run step (e.g. `deniedRepo` for "Liberar").
 */
export type CallCheck =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; message: string; data?: Record<string, unknown> };

/** Supplies tools for a run. The gateway filters them by the agent's scopes. */
export interface ToolSource {
  readonly name: string;
  tools(ctx: ToolContext): Promise<ToolDefinition[]>;
}

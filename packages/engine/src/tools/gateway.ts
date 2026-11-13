import { ASK_AGAIN, commandKind, loneMerge, type MergeDone, PERMISSION_TOOL, type PubSub } from "@agenteschat/adapters";
import { startInFlight } from "@agenteschat/adapters/in-flight";
import { and, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { auditsCall, callSubject, callTitle, recordToolCall, type ToolCallSubject } from "../agent-audit";
import {
  COMMAND_RULE_TOOL,
  coveringRules,
  decidesAgentApprovals,
  MAX_OWN_ACTIONS,
  OWN_ACTION_NAME,
  type RememberedKind,
  rulesApprover,
  SQL_READS,
  sqlReadsTarget,
} from "../approval-rules";
import { fedByRoutine, type RunAuthority, runAuthorityById, UUID } from "../authority";
import { type CostKind, costlyGate, costlyKind, LONG_STEPS, unrequested } from "../brakes";
import { countToolCall } from "../connector-usage";
import { actionLevel, nameWords, openEnded } from "../connectors/classify";
import { missingConnectors, type ServerCatalog } from "../connectors/listing";
import { answersAgentsOnly, consultationOrigin } from "../consultations";
import { recordOutcome } from "../context/outcomes";
import { sha256 } from "../crypto";
import { provenReadOnly } from "../databases/guard";
import { isUnexpectedError } from "../errors";
import { cutMarked, cutText, pgSafeJson, pgSafeText } from "../format";
import { mergeReposOfCall, recordMergeDone, reposOfGithubCall } from "../git/repos";
import { recordRead } from "../outbound";
import { routineCreatorOf } from "../requester";
import { FIXED_GRANTS, RIGHT_HAND_REFUSAL } from "../right-hand";
import type { RoutineBrief } from "../routine-brief";
import { addRunStep } from "../runs";
import { describeWhen } from "../schedule";
import { REQUEST_SECRET_TOOL } from "../secrets";
import {
  callTargets,
  checkTeamAction,
  commandAction,
  forgetPendingCommand,
  isOutsideTool,
  recordTeamAction,
  summarizeCall,
  type TeamCheck,
} from "../team-actions";
import { carriesCredential, promptAnswer, toolCommand, toolDetail } from "../tool-detail";
import { untrustedBlock } from "../untrusted";
import { checkToolCall } from "./checks";
import { connectorFirst } from "./connector-first";
import { type BlockedTool, compactSchema, presentTools, resolveCall } from "./directory";
import { canonicalJson, validateJson } from "./json-schema";
import { missingPermissions, REQUEST_PERMISSION_TOOL } from "./permission";
import { approvalOrigin, type PolicyDecision, takeWhy, toolKind, toolPolicy, WHY_REFUSAL, withWhy } from "./run-policy";
import {
  accessWithNeeds,
  BUILTIN_SCOPES,
  freshGrantedKeys,
  grantedScopeKeys,
  grantKey,
  holdsConnection,
  isAllowed,
  NOT_IN_ALL,
  toolAccess,
} from "./scopes";
import type { AheadOutcome, AheadRequest, ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./types";

const { approvals, agents, agentRunSteps, routines } = schema;
type AuditOutcome = schema.AuditOutcome;

/** Merge, deploy and rollback always need a person, whatever a connector says. */
export const ALWAYS_SENSITIVE = /(^|[^a-z])(merge|deploy|rollback|revert_deploy|promote)([^a-z]|$)/i;

export const isSensitive = (tool: Pick<ToolDefinition, "name" | "scope" | "sensitive">) =>
  tool.sensitive === true || ALWAYS_SENSITIVE.test(tool.name) || ALWAYS_SENSITIVE.test(tool.scope);

/**
 * Also as a noun or under another name: a deployment, a build, a dispatch or a release (they start workflows), a
 * branch's reference, an alias or a rolling release (production traffic), a re-run, a restore. Never approved for good.
 */
const NEVER_FOR_GOOD =
  /^(merge|deploy|redeploy|rollback|revert|restore|promote|workflow|build|dispatch|reference|release|alias|rolling|rerun|rerequest)/;
/**
 * Verbs right after the app that start what then runs on its own (`RAILWAY_COMMIT_ENVIRONMENT_CHANGES` deploys) or
 * run whatever their arguments say (`VERCEL_EXECUTE_SANDBOX_COMMAND`).
 */
const NEVER_LEADS = new Set(["commit", "trigger", "run", "execute", "invoke"]);
/** An action slug (`VERCEL_CREATE_NEW_DEPLOYMENT`) or tool name that "Aprovar sempre" never covers. */
export const alwaysAsks = (name: string) => {
  const words = nameWords(name);
  return (
    ALWAYS_SENSITIVE.test(name) ||
    openEnded(name) ||
    NEVER_LEADS.has(words[1] ?? "") ||
    words.some((w) => NEVER_FOR_GOOD.test(w))
  );
};

/** Words of a tool that runs whatever its arguments say: a script, a shell, code, a raw request. */
const RUNS_ANYTHING = new Set([
  "exec",
  "eval",
  "bash",
  "shell",
  "script",
  "command",
  "code",
  "request",
  "http",
  "curl",
]);
/**
 * A custom server's own tool name, its verb first with no app before it (`run_script`), that "Aprovar sempre" never
 * covers: what `alwaysAsks` says, a leading verb that runs on its own, or a word that runs anything.
 */
export const customAlwaysAsks = (name: string) => {
  const words = nameWords(name);
  return alwaysAsks(name) || NEVER_LEADS.has(words[0] ?? "") || words.some((w) => RUNS_ANYTHING.has(w));
};

/** What a mailbox's scopes say is not high risk: a draft stays in the mailbox, reading and filing change nothing. */
const MAIL_QUIET = new Set(["mail:draft", "mail:read", "mail:organize"]);
/** Production, can't be undone, or leaves the company; mirrors the client's `approvalRisk` (`approval-kind.ts`). */
const RISKY_WORDS =
  /deploy|rollback|workflow|actions\.run|delete|remove|destroy|drop|purge|send|email|mail\b|sms|share|publish/i;
/**
 * Merge, deploy, rollback, sends, deletes and whatever "Aprovar sempre" never covers by its name (`alwaysAsks`): a
 * person covering someone decides these only when that person turned it on (`approval_covers.risky`).
 */
export const highRisk = (tool: string, scope: string) =>
  !MAIL_QUIET.has(scope) && (alwaysAsks(tool) || ALWAYS_SENSITIVE.test(scope) || RISKY_WORDS.test(`${tool} ${scope}`));

/**
 * The kind "Aprovar sempre" would cover for this call (`approval_rules`), or null when it is never offered: only
 * on a run that isn't a routine's, whose policy didn't make the call ask, for a tool its source lets be
 * remembered (`rememberAs`), whose wrapped actions, when it runs others, are a shape we know with none sensitive,
 * and with nothing in its names that always asks (merge, deploy, rollback and the rest above, GraphQL, SQL, a raw
 * request). A tool that names one exact target per call (`rememberTarget`) is remembered by that target, without
 * the name checks: they read connector actions, and a branch named release-x is still only that branch. A tool that
 * runs one shell command on the agent's computer (`rememberCommand`) is remembered by the command's kind
 * (`commandKind`, which never offers the deny list, pushes or anything sensitive), for that agent alone.
 */
export function rememberable(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  authority: RunAuthority | null,
  decision: PolicyDecision,
): RememberedKind | null {
  if (!authority || authority.kind === "routine" || decision.action === "approve") return null;
  if (tool.rememberCommand && !tool.connectionId) {
    const command = tool.rememberCommand(input);
    const kind = command ? commandKind(command) : null;
    return kind ? { tool: COMMAND_RULE_TOOL, actions: [kind] } : null;
  }
  if (tool.rememberTarget && tool.connectionId) {
    const target = tool.rememberTarget(input);
    return target ? { tool: tool.name, actions: [target] } : null;
  }
  if (!tool.rememberAs || !tool.connectionId) return null;
  const actions = tool.actions ? tool.actions(input) : [];
  if (!actions || actions.some((a) => actionLevel(a) === "sensitive")) return null;
  if ([tool.name, tool.rememberAs, tool.scope, ...actions].some(alwaysAsks)) return null;
  return { tool: tool.rememberAs, actions };
}

/**
 * Names of deletions, money and a pull request's approval, which "Sempre nesta rotina" never covers; a routine's send
 * or post is its job.
 */
const NEVER_IN_ROUTINE =
  /^(delete|deletes|deleted|remove|removes|destroy|drop|purge|erase|wipe|trash|truncate|overwrite|revoke|unbind|pay|pays|payment|payments|payout|payouts|refund|refunds|charge|charges|transfer|transfers|invoice|invoices|purchase|buy|renew|checkout|withdraw|withdrawal|approve|review|reviews)$/;
const neverInRoutine = (name: string) => nameWords(name).some((w) => NEVER_IN_ROUTINE.test(w));

/** The scope of the GitHub connector's `merge_pull_request`. */
const GITHUB_MERGE_SCOPE = "github:pr.merge";

/**
 * The kind "Aprovar sempre leituras" covers for a call of a tool that runs SQL (`sqlReads`), or null: the same runs
 * as `rememberable`, and only SQL the Postgres guard proves read-only, kept by the call's other arguments (its
 * project or database). A write is never offered and never covered: it asks every time.
 */
export async function rememberableSqlRead(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  authority: RunAuthority | null,
  decision: PolicyDecision,
): Promise<RememberedKind | null> {
  if (!tool.sqlReads || !tool.connectionId || ALWAYS_SENSITIVE.test(tool.name)) return null;
  if (!authority || authority.kind === "routine" || decision.action === "approve") return null;
  const sql = input[tool.sqlReads.arg];
  if (typeof sql !== "string" || !(await provenReadOnly(sql))) return null;
  return { tool: tool.sqlReads.tool, actions: [`${SQL_READS}${sqlReadsTarget(input, tool.sqlReads.arg)}`] };
}

/**
 * Approved ahead (ADR 0015 addendum, 2026-10-31): how long after its time the routine's run may still do an action
 * a person approved for it (a computer waking up, a slow start). Later it asks a person again.
 */
export const AHEAD_GRACE_MS = 30 * 60_000;

/** The built-in a routine's run does an action approved ahead with, by its id (the gateway runs the stored call). */
export const RUN_APPROVED_ACTION = "run_approved_action";

/** What a routine's run reads when it tries an action a person refused ahead of its time. */
export const AHEAD_REFUSED =
  "A person refused this exact action ahead of its time: don't do it, and don't try it another way. Say so in hand_off.";

/**
 * Why a call can't be approved ahead, or null when it can: a connected app's tool that allows it (`ahead`), whose
 * wrapped actions, when it runs others, are a shape we know, with nothing in its names, scope or actions that always
 * asks (merge, deploy, rollback and the rest of the never-for-good list above, GraphQL, SQL, a raw request).
 */
export function aheadRefusal(tool: ToolDefinition, input: Record<string, unknown>): string | null {
  if (!tool.ahead || !tool.connectionId) return "Only a connected app's own action can be approved ahead.";
  const actions = tool.actions ? tool.actions(input) : [];
  if (!actions) return "This call doesn't say which actions it runs, so it can't be approved ahead.";
  if ([tool.name, tool.rememberAs ?? "", tool.scope, ...actions].some((name) => name && alwaysAsks(name))) {
    return "Merge, deploy, rollback and the like always ask a person at the time: they can't be approved ahead.";
  }
  return null;
}

/** Hash an approval is bound to: tool, scope, connection and the exact parameters. */
export const actionHash = (action: {
  tool: string;
  scope: string;
  connectionId: string | null;
  params: Record<string, unknown>;
}) => sha256(canonicalJson(action));

export const APPROVAL_TTL_MS = 24 * 3600_000;
/** How much of a call's `describe().detail` an approval card keeps. */
export const APPROVAL_DETAIL_CHARS = 2000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** The most of a tool's output the model gets. */
export const MAX_RESULT_CHARS = 50_000;
/** Server-owned Git tools have a connection ID only to use that connection's credential. */
const serverGitTool = (tool: ToolDefinition) =>
  (tool.name === "git_clone" && tool.scope === "github:git.read") ||
  (tool.name === "open_pull_request" && tool.scope === "github:pr.write") ||
  ((tool.name === "delete_branches" || tool.name === "request_branch_push") && tool.scope === "github:git.write");

/**
 * An `external` tool's output (an MCP server's answer) reaches the model inside the one envelope for
 * outside content (`untrustedBlock`): markers in it neutralised, so the text can't close the block
 * early. The result is already capped (`MAX_RESULT_CHARS`), so the envelope doesn't cut it again.
 */
export const wrapExternal = (source: string, text: string) => untrustedBlock(source, text, MAX_RESULT_CHARS + 100);
/** What run steps and approvals keep: the text people see, without the model's envelope. */
const shown = (text: string) =>
  cutText(text.replace(/^<external_data source="[^"]*">\n([\s\S]*)\n<\/external_data>$/, "$1"), 4000);

/**
 * An approved action already claimed (it runs at most once): what it returned, or, with nothing recorded
 * (it still runs elsewhere, or a restart or a dropped connection cut it), that it may not have finished.
 */
const ranBefore = (approval: { result: unknown }): ToolOutput =>
  (approval.result as ToolOutput | null) ?? {
    content:
      "This approved action was already started and its result isn't recorded: it may still be running, or it was cut off before finishing. Check its state before doing it again.",
    isError: true,
  };

/** The answer to a call that carries a credential (`carriesCredential`) on a run a routine's reading feeds (`fedByRoutine`). */
export const CREDENTIAL_REFUSAL =
  "Refused: this call carries what looks like a key, token or private key. Work that comes from a routine's background work never sends credentials anywhere: leave the value out (you may say one was found, and where).";

/** `ask_user` (questions.ts): it waits for a person, so it carries a `why` like an approval. */
const ASK_USER = "ask_user";

const isBuiltIn = (tool: Pick<ToolDefinition, "scope" | "connectionId">) => tool.scope === "" && !tool.connectionId;

/** `input` with the text under `from` moved to `to`; blank text stays, for the refusal to say `to` is missing. */
function renamed(input: Record<string, unknown>, from: string, to: string) {
  const { [from]: value, ...rest } = input;
  return typeof value !== "string" || !value.trim() || to in input ? input : { ...rest, [to]: value };
}

/**
 * The names models guess for a field of our tools when a computer brain's harness held the schema back. Only these:
 * a call that also has the real field stays as it is, and any other mistake is refused with what the tool takes.
 */
const INPUT_ALIASES = new Map<string, (input: Record<string, unknown>) => Record<string, unknown>>([
  ["offer_connect_app", (input) => renamed(input, "reason", "why")],
  ["browser_ask_person", (input) => renamed(input, "message", "instructions")],
  [
    "browser_do",
    (input) =>
      Array.isArray(input.steps)
        ? {
            ...input,
            steps: input.steps.map((s) => (s && typeof s === "object" ? renamed(s, "action", "do") : s)),
          }
        : input,
  ],
]);

/** Whether a call of this tool waits for a person: an approval, or a built-in question. */
const asksPerson = (tool: ToolDefinition, decision: PolicyDecision) =>
  decision.action === "approve" || isSensitive(tool) || (tool.name === ASK_USER && isBuiltIn(tool));

/** A call that asks a person's approval because it says why (`whyAsks`: a command the computer held). */
const asksWithWhy = (tool: ToolDefinition, input: Record<string, unknown>) =>
  tool.whyAsks === true && input.why !== undefined;

/**
 * The card's reason for a command the computer held for a person (`command.approval_needed`), from what the computer
 * said (`approvalMessage`: "This is a merge: a person approves it first."); null for any other result. Also null when
 * the computer named a way that needs nobody (a push to the agent's own branch and a pull request), a secret read
 * (refused, never asked) or words it doesn't know (an older runner): the agent reads them and may still ask with why.
 */
function heldCommandReason(output: ToolOutput): string | null {
  if (output.data?.code !== "command.approval_needed") return null;
  const held = /^[^:]*: (.+?): a person approves it first\. (.*)$/s.exec(output.content);
  if (!held?.[1] || held[2]?.trim() !== ASK_AGAIN) return null;
  return `${held[1].trim()}, so the computer waits for a person's approval before running it.`;
}

/** A check that failed for any reason never stops the action (ADR 0064): it only misses a notice. */
const UNCHECKED: TeamCheck = { proceed: true, reason: null };

/**
 * Why the agent may not call a tool that exists, in words it can pass on: turned off by name, a connector it holds
 * with less access than the tool needs (`request_permission` only offers what it has none of), or a permission it
 * can ask for. Each says who can change it.
 */
/**
 * The gateway's own refusals carry `data.refusal`, a word the apps say in the person's language under the call's line
 * (`chat.work.refusal.<refusal>`, as a refused command's code): the text itself is the agent's, in English.
 */
async function refusalOf(
  ctx: ToolContext,
  tool: ToolDefinition,
  access: ReturnType<typeof accessWithNeeds>,
  granted: Set<string>,
) {
  const of = access.of;
  if (granted.has(grantKey(null, FIXED_GRANTS))) return RIGHT_HAND_REFUSAL;
  if (access.state === "denied") {
    return `${of === tool ? "this tool" : of.name} is turned off for this agent, not for good: an admin can turn it back on, on the agent's page in Tools and access (in Portuguese, Ferramentas e acesso). Say so in plain words (the person asking may be that admin), never that it can't be done`;
  }
  if (of === tool && holdsConnection(granted, tool.connectionId)) {
    const level = /^custom:[^:]+:(read|write)$/.exec(tool.scope)?.[1];
    return `${tool.name} exists, but this agent's access to ${tool.connectorLabel ?? "its connector"} doesn't cover it (it needs ${level ? `${level} access` : `the scope ${tool.scope}`}). Only an admin can change that, on the agent's page in Tools and access (in Portuguese, Ferramentas e acesso): say so (the person asking may be that admin), never that the tool doesn't exist`;
  }
  const permission = of === tool && tool.connectionId ? `connector:${tool.connectionId}` : of.scope;
  if ((await missingPermissions(ctx)).some((m) => m.id === permission)) {
    return `this agent lacks the scope ${of.scope}. If the request needs it, call ${REQUEST_PERMISSION_TOOL} now with permission "${permission}": a card asks a person and your work goes on once they decide. Never ask the person to try again`;
  }
  return `this agent lacks the scope ${of.scope}, which ${REQUEST_PERMISSION_TOOL} can't offer. Only an admin can give it, on the agent's page in Tools and access (in Portuguese, Ferramentas e acesso): say so, never ask the person to try again`;
}

/** `permission_prompt`'s question (Claude Code and Codex commands): a new command, or the state of one asked. */
function promptQuestion(input: Record<string, unknown>) {
  if (typeof input.request_id === "string" && input.request_id) return { poll: input.request_id, action: null };
  const inner = input.input;
  const action =
    typeof input.tool_name === "string" && inner && typeof inner === "object" && !Array.isArray(inner)
      ? commandAction(input.tool_name, inner as Record<string, unknown>)
      : null;
  return { poll: null, action };
}

/**
 * A computer command's ending for the audit: allowed, refused, or waiting for a person. Asking again
 * about one still waiting is no new action (nothing to record).
 */
function promptOutcome(prompt: { poll: string | null }, output: ToolOutput): AuditOutcome | undefined {
  const answer = promptAnswer(output.content);
  if (answer.behavior === "allow") return "done";
  if (answer.behavior === "deny") return "refused";
  if (answer.status === "pending") return prompt.poll ? undefined : "pending";
  return output.isError ? "failed" : undefined;
}

/**
 * A costly step of a run (ADR 0131 §3): the call's own (`costlyKind`), or a long run's (`LONG_STEPS` calls already),
 * counted only for runs the brakes apply to.
 */
async function costOf(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<CostKind | null> {
  const own = costlyKind(name, input);
  if (own) return own;
  // Polling a held prompt is no new step.
  if (name === PERMISSION_TOOL && typeof input.request_id === "string") return null;
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentRunSteps)
    .where(and(eq(agentRunSteps.runId, ctx.runId), eq(agentRunSteps.kind, "tool_call")));
  return Number(row?.n ?? 0) > LONG_STEPS ? "long" : null;
}

/** Who is behind the call's run (ADR 0053). Null for a mission task's call: no run, the mission's own gates. */
const authorityOf = (ctx: ToolContext): Promise<RunAuthority | null> =>
  ctx.runId ? runAuthorityById(ctx.db, ctx.orgId, ctx.runId) : Promise.resolve(null);

const ALLOWED: PolicyDecision = { action: "allow" };
const policyFor = (authority: RunAuthority | null, tool: ToolDefinition) =>
  authority ? toolPolicy(authority, tool) : ALLOWED;

/**
 * A tool as a run sees it: one the policy says asks a person becomes sensitive (its card, and the
 * "asks a person's approval" in a directory), and every tool that asks a person takes the required
 * `why` the card shows. The same list goes to the model loop and to the bridge.
 */
function asListed(tool: ToolDefinition, decision: PolicyDecision): ToolDefinition {
  if (!asksPerson(tool, decision)) return tool;
  return {
    ...tool,
    ...(decision.action === "approve" ? { sensitive: true } : {}),
    inputSchema: withWhy(tool.inputSchema),
  };
}

export type ToolCall = { toolUseId: string; name: string; input: Record<string, unknown> };
export type Approval = typeof approvals.$inferSelect;

export type InvokeResult =
  /**
   * `ran`: the action approved ahead this call did, as it is now (its cards are told, `invokeWithChip`).
   * `autoApproved`: a rule ("Aprovar sempre") let it run, whose person and whether a reads one (its live line).
   */
  | { type: "result"; output: ToolOutput; ran?: Approval; autoApproved?: { by: string | null; reads: boolean } }
  | { type: "approval"; approval: Approval }
  /** `ask_user`: the executor posts the question and suspends the run. */
  | { type: "question"; text: string; choices: string[] | null; requestedForUserId: string | null; why: string }
  /** `request_secret`: the executor posts the card and suspends the run. */
  | { type: "secret"; requestId: string };

/**
 * The only way an agent's tool call runs (docs/adr/0015). For each call:
 * 1. the tool is looked up by name in the run's tool set (never trusting the
 *    model's claim of what it is);
 * 2. the agent's scope for it is read from `agent_scopes` (a prompt can't change it);
 * 3. the input is validated against the tool's JSON Schema;
 * 4. the run's policy (`run-policy.ts`: who is behind the run) refuses it,
 *    lets it run, or makes it ask a person;
 * 5. a call that asks a person (an approval, `ask_user`) must say why: the
 *    `why` is taken out of the input and kept on the approval or question;
 * 6. sensitive tools (and a `whyAsks` tool's call that says why) create an
 *    `approvals` row bound to the action hash and stop there, unless a rule
 *    someone approved for good covers the call ("Aprovar sempre",
 *    `approval_rules`); others run, with errors turned into error results. A
 *    tool that runs other actions (Composio's executor) is the connection's
 *    read when every action it runs only reads;
 * 7. `tool_call` / `tool_result` / `approval` steps are recorded;
 * 8. an outside call (a connected app's write, a command that leaves the
 *    computer) is held once when the team already did it to the same target,
 *    and recorded for the team once it went out (ADR 0064, `team-actions.ts`).
 */
/** A tool's answer carries text from outside the org (ADR 0117): an external or reading tool that said something. */
const readsOutsideText = (tool: ToolDefinition, output: ToolOutput) =>
  Boolean(tool.external || tool.readsOutside) && output.content.trim() !== "";

export function createToolGateway(deps: {
  sources: ToolSource[];
  now?: () => Date;
  /** What this server can connect: `find_tools` names each connector a search asks for that the agent lacks. */
  catalog?: ServerCatalog;
  /**
   * Said after one of our own tools breaks with an error nobody wrote for the model (`isUnexpectedError`): where the
   * server takes feedback, that the agent may offer a report (`APP_FAULT_HINT`, ADR 0160 §12).
   */
  faultHint?: string;
  /** Live events (the autonomy brakes' proposal card, ADR 0131). */
  pubsub?: PubSub;
}) {
  const now = deps.now ?? (() => new Date());

  async function allTools(ctx: ToolContext) {
    const byName = new Map<string, ToolDefinition>();
    for (const source of deps.sources) {
      for (const tool of await source.tools(ctx)) {
        if (!TOOL_NAME.test(tool.name)) continue;
        const current = byName.get(tool.name);
        // A connected MCP server must not shadow one of our own tools just
        // because its source appears earlier in the list.
        if (!current || (current.connectionId && (!tool.connectionId || serverGitTool(tool))))
          byName.set(tool.name, tool);
      }
    }
    return byName;
  }

  /**
   * Every tool this agent may call now: every source, filtered by granted scopes and by the run's
   * policy (a refused tool isn't listed), by name. Tools that ask a person carry the required `why`.
   * `heldBack` collects the names its scopes grant that the run's policy refused.
   */
  async function granted(ctx: ToolContext, heldBack?: string[]): Promise<ToolDefinition[]> {
    return grantedFor(ctx, await authorityOf(ctx), undefined, heldBack);
  }

  /** `known`: this call's `allTools`, when already read. */
  async function grantedFor(
    ctx: ToolContext,
    authority: RunAuthority | null,
    known?: Map<string, ToolDefinition>,
    heldBack?: string[],
  ): Promise<ToolDefinition[]> {
    const [keys, all] = await Promise.all([grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId), known ?? allTools(ctx)]);
    return [...all.values()]
      .filter((t) => isAllowed(accessWithNeeds(keys, t).state))
      .flatMap((t) => {
        const decision = policyFor(authority, t);
        if (decision.action !== "refuse") return [asListed(t, decision)];
        heldBack?.push(t.name);
        return [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * What `find_tools` names as not allowed yet: every tool of this server's sources the agent may not use
   * (and the run could, once allowed), with each permission `request_permission` offers for it (its own,
   * and the one of a tool it `needs`), so the card can grant what the agent asks for; or none when an admin
   * turned that tool, or the one it needs, off by name; or an empty list for one more scope of a connector the
   * agent already has some of, which only an admin gives. Any other permission `request_permission` doesn't offer
   * (a mailbox's or a database's the agent has nothing of) isn't named.
   */
  async function notAllowed(
    ctx: ToolContext,
    authority: RunAuthority | null,
    all: Map<string, ToolDefinition>,
  ): Promise<BlockedTool[]> {
    const [keys, missing] = await Promise.all([
      grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId),
      missingPermissions(ctx),
    ]);
    const offered = new Map(missing.map((m) => [m.id, m]));
    return [...all.values()].flatMap((tool): BlockedTool[] => {
      const own = toolAccess(keys, tool);
      const needs = tool.needs && { scope: tool.needs.scope, state: toolAccess(keys, tool.needs) };
      const lacks = [
        ...(isAllowed(own) ? [] : [tool.connectionId ? `connector:${tool.connectionId}` : tool.scope]),
        ...(needs && !isAllowed(needs.state) ? [needs.scope] : []),
      ];
      if (lacks.length === 0 || policyFor(authority, tool).action === "refuse") return [];
      if (own === "denied" || needs?.state === "denied") return [{ tool, permissions: null }];
      const asked = lacks.flatMap((id) => offered.get(id) ?? []);
      // A connector the agent holds with less access than this tool needs: only an admin changes that.
      if (asked.length < lacks.length) {
        return !isAllowed(own) && holdsConnection(keys, tool.connectionId) ? [{ tool, permissions: [] }] : [];
      }
      // The computer's scopes ("all tools" never covers them) say what they give, for the person approving.
      const permissions = asked.map((m) => {
        const plain = NOT_IN_ALL.has(m.scope) ? BUILTIN_SCOPES[m.scope]?.description : undefined;
        return { id: m.id, label: plain ? `${m.label}: ${plain}` : m.label };
      });
      return [{ tool, permissions }];
    });
  }

  /**
   * Tools this agent may call now, as the model sees them: each big
   * connector listed as its directory, and with tools on demand
   * (`ctx.loadedGroups`, ADR 0043) the groups not loaded behind `find_tools` /
   * `use_tool` (tools/directory.ts).
   */
  async function list(ctx: ToolContext): Promise<ToolDefinition[]> {
    return presentTools(await granted(ctx), isSensitive, ctx.loadedGroups);
  }

  /** A connector's call counts toward its usage (ADR 0103), whatever it returned. `approvalsGiven` 1: an approved one. */
  async function run(
    tool: ToolDefinition,
    input: Record<string, unknown>,
    ctx: ToolContext,
    approvalsGiven = 0,
  ): Promise<ToolOutput> {
    const output = await outputOf(tool, input, ctx);
    if (tool.connector) {
      const { orgId, agentId } = ctx;
      const errors = output.isError ? 1 : 0;
      await countToolCall(ctx.db, { orgId, agentId, connector: tool.connector, calls: 1, errors, approvalsGiven });
    }
    return output;
  }

  async function outputOf(tool: ToolDefinition, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const done = startInFlight(`tool ${tool.name}`, ctx.runId);
    try {
      const output = await tool.execute(input, ctx);
      if (output.outcome) {
        await recordOutcome(ctx.db, {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId,
          channelId: ctx.channelId,
          threadRootId: ctx.threadRootId,
          source: "tool",
          ...output.outcome,
        }).catch(() => {});
      }
      // A NUL or a lone surrogate (a binary printed by a command) would make every save of this result fail.
      const text = pgSafeText(output.content);
      const capped = {
        ...output,
        content: text.length > MAX_RESULT_CHARS ? `${cutText(text, MAX_RESULT_CHARS)}\n[truncated]` : text,
      };
      return tool.external ? { ...capped, content: wrapExternal(tool.name, capped.content) } : capped;
    } catch (error) {
      const message = pgSafeText(error instanceof Error ? error.message : String(error));
      // Our own tool breaking in a way nobody foresaw is the app's fault, not the agent's nor an outside service's.
      const hint =
        deps.faultHint && !tool.external && !tool.connectionId && isUnexpectedError(error) ? deps.faultHint : "";
      // An MCP server's error text is its own words too.
      return {
        content: `Tool failed: ${tool.external ? wrapExternal(tool.name, message) : message}${hint && `\n${hint}`}`,
        isError: true,
      };
    } finally {
      done();
    }
  }

  /**
   * `schedule_action` (`ToolContext.prepareAhead`, ADR 0015 addendum): the call a routine's run will make at its
   * time, checked now as it will be then (a connected app's write that asks a person, the agent's scope, the input,
   * no credential, the arguments' rules), then asked now: an approval of that exact call for that run (`routine_id`,
   * `run_at`), where the person is. Deciding it resumes this run; the action itself waits for its time.
   */
  async function prepareAhead(
    ctx: ToolContext,
    authority: RunAuthority | null,
    request: AheadRequest,
  ): Promise<AheadOutcome> {
    const no = (message: string): AheadOutcome => ({ ok: false, message });
    if (authority?.kind !== "person") return no("Only a person's request can have an action approved ahead.");
    const tool = (await allTools(ctx)).get(request.tool.trim());
    if (!tool)
      return no(`No tool named "${request.tool}": use its exact name (a big connector's find_tools gives it).`);
    const input = takeWhy(tool.inputSchema, request.input).input;
    const refusal = aheadRefusal(tool, input);
    if (refusal) return no(refusal);
    const actions = tool.actions?.(input) ?? [];
    if (toolKind(tool).kind !== "external" || (actions.length > 0 && actions.every((a) => actionLevel(a) === "read"))) {
      return no("This doesn't ask a person at its time: there is nothing to approve ahead.");
    }
    const access = accessWithNeeds(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), tool);
    if (!isAllowed(access.state)) return no(`Not allowed: this agent lacks the scope ${access.of.scope}.`);
    const problems = validateJson(tool.inputSchema, input);
    if (problems.length > 0) {
      return no(
        `Invalid arguments: ${problems.join("; ")}\nInput schema of ${tool.name}: ${compactSchema(tool.inputSchema)}`,
      );
    }
    // The routine's run is nobody's: it never sends a credential (ADR 0053 §3).
    if (carriesCredential(input)) return no(CREDENTIAL_REFUSAL);
    const check = await checkToolCall(tool, input, ctx);
    if (!check.ok) return no(check.message);
    const slot = await request.slot();
    const [owner, origin] = await Promise.all([
      ownerOf(ctx),
      ctx.runId ? consultationOrigin(ctx.db, ctx.orgId, ctx.runId) : null,
    ]);
    const described = tool.describe?.(input) ?? { title: tool.name, detail: canonicalJson(input) };
    const connectionId = tool.connectionId ?? null;
    const [approval] = await ctx.db
      .insert(approvals)
      .values({
        orgId: ctx.orgId,
        runId: ctx.runId,
        agentId: ctx.agentId,
        channelId: origin?.channelId ?? ctx.channelId,
        threadRootId: origin?.threadRootId ?? ctx.threadRootId,
        toolUseId: ctx.toolUseId ?? crypto.randomUUID(),
        tool: tool.name,
        scope: tool.scope,
        connectionId,
        params: input,
        actionHash: actionHash({ tool: tool.name, scope: tool.scope, connectionId, params: input }),
        title: cutMarked(described.title, 300),
        detail: cutMarked(described.detail ?? "", APPROVAL_DETAIL_CHARS),
        why: request.why,
        ownerUserId: owner,
        requestedByUserId: authority.personId,
        highRisk: highRisk(tool.name, tool.scope),
        // Decided by its time at the latest (else its run asks then), and within a day like any request.
        expiresAt: new Date(Math.min(slot.runAt.getTime(), now().getTime() + APPROVAL_TTL_MS)),
        routineId: slot.routineId,
        runAt: slot.runAt,
      })
      .returning();
    if (!approval) throw new Error("approval insert returned nothing");
    if (tool.connector) {
      const { orgId, agentId } = ctx;
      await countToolCall(ctx.db, { orgId, agentId, connector: tool.connector, approvalsAsked: 1 });
    }
    return { ok: true, approval };
  }

  /**
   * What a person last decided ahead about this exact call (its hash) for this routine run's slot, while that slot
   * is within its grace: approved and not run yet, or refused. The latest decision wins: the same post refused and
   * then prepared again and approved goes out, and one approved and then refused on another card doesn't.
   */
  async function aheadFor(ctx: ToolContext, brief: RoutineBrief, hash: string) {
    const slot = new Date(brief.dueAt);
    if (!UUID.test(brief.routineId) || Number.isNaN(slot.getTime())) return null;
    if (slot.getTime() < now().getTime() - AHEAD_GRACE_MS) return null;
    const [row] = await ctx.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.orgId, ctx.orgId),
          eq(approvals.agentId, ctx.agentId),
          eq(approvals.routineId, brief.routineId),
          eq(approvals.runAt, slot),
          eq(approvals.actionHash, hash),
          inArray(approvals.status, ["approved", "refused"]),
          isNull(approvals.executedAt),
        ),
      )
      .orderBy(desc(approvals.decidedAt), desc(approvals.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** The routine a run works for, when it is still this agent's. */
  async function routineOf(ctx: ToolContext, brief: RoutineBrief) {
    const [row] = await ctx.db
      .select({
        ownActions: routines.ownActions,
        creator: routines.createdByUserId,
        owner: agents.ownerUserId,
        target: routines.target,
      })
      .from(routines)
      .innerJoin(agents, and(eq(agents.id, routines.agentId), eq(agents.orgId, routines.orgId)))
      .where(
        and(
          eq(routines.id, brief.routineId),
          eq(routines.orgId, ctx.orgId),
          eq(routines.agentId, ctx.agentId),
          isNull(routines.deletedAt),
        ),
      );
    return row ?? null;
  }

  /**
   * Whether a routine's run may do this call without a card (`routines.own_actions`, ADR 0053 §2 addendum of
   * 2026-11-03: setting the routine up approved its job, so it doesn't ask every run). Every action the call runs is one its creator
   * allowed for the routine, the call could be approved ahead at all (`aheadRefusal`: a connected app's own action,
   * nothing that runs whatever its input says, never merge, deploy, rollback and the like), and the creator still
   * decides this agent's approvals. Read fresh: a removed action or a creator who lost the right asks at once.
   */
  async function ownJobCovers(
    ctx: ToolContext,
    brief: RoutineBrief,
    tool: ToolDefinition,
    input: Record<string, unknown>,
  ) {
    if (!UUID.test(brief.routineId) || aheadRefusal(tool, input)) return false;
    const names = tool.actions ? tool.actions(input) : [tool.name];
    if (!names?.length) return false;
    const row = await routineOf(ctx, brief);
    if (!row?.creator || row.ownActions.length === 0) return false;
    const own = new Set(row.ownActions.map((a) => a.toLowerCase()));
    if (!names.every((n) => own.has(n.toLowerCase()))) return false;
    return decidesAgentApprovals(ctx.db, ctx.orgId, row.creator, row.owner);
  }

  /**
   * What "Sempre nesta rotina" keeps for a call a routine's run asks about, or null when it isn't offered. Its name
   * says it all: the actions `ownJobCovers` would then let run, none a merge, a deploy or the like (`aheadRefusal`) nor
   * a deletion or a payment (`neverInRoutine`), for a live routine with room for them, that isn't a widget's. Not for
   * a call with its own approvers (someone's mailbox: only they say yes). A creator who no longer decides this
   * agent's approvals makes own actions ask anyway, so it isn't offered either.
   */
  async function routineKind(
    ctx: ToolContext,
    brief: RoutineBrief,
    tool: ToolDefinition,
    input: Record<string, unknown>,
  ): Promise<RememberedKind | null> {
    if (!UUID.test(brief.routineId) || tool.approvers || aheadRefusal(tool, input)) return null;
    const names = tool.actions ? tool.actions(input) : [tool.name];
    if (!names?.length || !names.every((n) => OWN_ACTION_NAME.test(n))) return null;
    if ([tool.name, tool.scope, ...names].some(neverInRoutine)) return null;
    const row = await routineOf(ctx, brief);
    if (!row?.creator || row.target.type === "widget") return null;
    if (new Set([...row.ownActions, ...names]).size > MAX_OWN_ACTIONS) return null;
    if (!(await decidesAgentApprovals(ctx.db, ctx.orgId, row.creator, row.owner))) return null;
    return { tool: tool.name, actions: names, routineId: brief.routineId };
  }

  /**
   * "Pode fazer merge sem perguntar": the merge a call of the GitHub connector makes, when it is in a repository this
   * agent merges in without asking. A command on the computer is told the same list and decides there (`mergeRepos`).
   */
  async function connectorMerge(ctx: ToolContext, tool: ToolDefinition, input: Record<string, unknown>) {
    if (tool.scope !== GITHUB_MERGE_SCOPE) return null;
    const [repo, ...others] = reposOfGithubCall(input) ?? [];
    const pr = Number(input.pullNumber);
    if (!repo || others.length > 0 || !Number.isInteger(pr) || pr <= 0) return null;
    const allowed = await mergeReposOfCall(ctx);
    return allowed.some((r) => r.toLowerCase() === repo.toLowerCase()) ? { repo, pr, ref: null } : null;
  }

  /** The call an action approved ahead stores, by its id (`run_approved_action`), when it is this agent's. */
  async function storedAhead(ctx: ToolContext, id: unknown) {
    if (typeof id !== "string" || !UUID.test(id)) return null;
    const [row] = await ctx.db
      .select({ tool: approvals.tool, params: approvals.params, why: approvals.why, runAt: approvals.runAt })
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.orgId, ctx.orgId), eq(approvals.agentId, ctx.agentId)));
    return row?.runAt ? row : null;
  }

  /** What the run that asked reads once a person approved its action ahead: when it goes out by itself. */
  async function aheadNote(ctx: ToolContext, approval: Approval & { runAt: Date }) {
    const [routine] = approval.routineId
      ? await ctx.db
          .select({ timezone: routines.timezone })
          .from(routines)
          .where(and(eq(routines.id, approval.routineId), eq(routines.orgId, ctx.orgId)))
      : [];
    return `Approved ahead: «${approval.title}» goes out by itself ${describeWhen(approval.runAt, routine?.timezone ?? "UTC")}, without asking again. Tell the person it's set, with that day and time in their words. To change its content or time, call schedule_action again with replaces set to ${approval.id}.`;
  }

  /**
   * Runs an approved action, exactly as hashed: the stored params, the same tool and scope, at most once. Scope and
   * the arguments' rules are re-checked (they may have changed while it waited). `toolUseId`: the call it answers.
   */
  async function runApproved(ctx: ToolContext, approval: Approval, toolUseId: string): Promise<ToolOutput> {
    if (approval.status !== "approved") return { content: "This action was not approved", isError: true };
    if (approval.executedAt) return ranBefore(approval);
    const expected = actionHash({
      tool: approval.tool,
      scope: approval.scope,
      connectionId: approval.connectionId,
      params: approval.params,
    });
    const tool = (await allTools(ctx)).get(approval.tool);
    // Why the approved action can't run any more; null = it may.
    const refusal = async (): Promise<string | null> => {
      if (expected !== approval.actionHash) return "Approval does not match the action";
      if (!tool || tool.scope !== approval.scope || (tool.connectionId ?? null) !== approval.connectionId)
        return `The tool ${approval.tool} is no longer available (its connector was removed or changed since the approval): say so, and that once it's connected again, asking again runs it`;
      const access = accessWithNeeds(await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId), tool);
      if (!isAllowed(access.state))
        return `Not allowed: this agent lost the scope ${access.of.scope} since the approval. An admin can give it back on the agent's page in Tools and access (in Portuguese, Ferramentas e acesso); then asking again runs it`;
      // Rules about the arguments again: a repository or recipient may have been removed while waiting.
      const check = await checkToolCall(tool, approval.params, ctx);
      return check.ok ? null : check.message;
    };
    let output: ToolOutput;
    let outside = false;
    const refused = await refusal();
    if (refused || !tool) output = { content: refused ?? "Not allowed", isError: true };
    else {
      // Claim the execution first: a retried job never runs the action twice. One approved ahead may have been
      // withdrawn or lapsed since it was read: only a row still approved runs.
      const claimed = await ctx.db
        .update(approvals)
        .set({ executedAt: now() })
        .where(
          sql`${approvals.id} = ${approval.id} and ${approvals.executedAt} is null
            and (${approvals.runAt} is null or ${approvals.status} = 'approved')`,
        )
        .returning({ id: approvals.id });
      if (claimed.length === 0) {
        const [row] = await ctx.db
          .select({ result: approvals.result, status: approvals.status })
          .from(approvals)
          .where(sql`${approvals.id} = ${approval.id}`);
        if (approval.runAt && row?.status !== "approved") {
          return { content: "This action was not approved", isError: true };
        }
        return ranBefore(row ?? approval);
      }
      output = await run(tool, approval.params, { ...ctx, toolUseId, approved: true }, 1);
      outside = readsOutsideText(tool, output);
      // Team actions (ADR 0064): what a person approved and went out is the team's too.
      if (isOutsideTool(tool) && !output.isError) {
        await recordTeamAction(ctx.db, {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId || null,
          channelId: approval.channelId,
          source: "approval",
          tool: tool.name,
          summary: summarizeCall(tool, approval.params),
          targets: callTargets(approval.params, output.data),
        });
      }
    }
    await ctx.db
      .update(approvals)
      .set({ result: { content: shown(output.content), isError: output.isError === true } })
      .where(sql`${approvals.id} = ${approval.id}`);
    recordRead(ctx.runId, approval.tool, output.content, output.data, approval.params);
    await addRunStep(ctx.db, { id: ctx.runId, orgId: ctx.orgId }, "tool_result", {
      toolUseId,
      name: approval.tool,
      approvalId: approval.id,
      isError: output.isError === true,
      content: shown(output.content),
      ...(tool?.external ? { external: true } : {}),
      ...(output.data || outside ? { data: { ...output.data, ...(outside ? { outside: true } : {}) } } : {}),
    });
    // The audit: the approved action ran (or couldn't any more). Who approved it is the approval's row.
    if (tool) {
      const kind = toolKind(tool).kind;
      const outcome: AuditOutcome = refused ? "refused" : output.isError ? "failed" : "done";
      if (auditsCall(kind, tool, outcome)) {
        await recordToolCall(ctx.db, {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId || null,
          channelId: approval.channelId,
          authority: await authorityOf(ctx).catch(() => null),
          tool: tool.name,
          kind,
          connector: tool.connectorLabel ?? null,
          title: approval.title,
          input: approval.params,
          outcome,
          reason: outcome === "done" ? null : shown(output.content),
          approvalId: approval.id,
        });
      }
    }
    return output;
  }

  return {
    list,
    granted,

    async invoke(ctx: ToolContext, raw: ToolCall): Promise<InvokeResult> {
      // The model's arguments land in jsonb and text columns (steps, approvals, the audit): a NUL would fail them.
      const requested = { ...raw, input: pgSafeJson(raw.input) };
      // Who is behind the run decides what it may do: listing already hid refused tools, this is the call.
      const [all, authority] = await Promise.all([allTools(ctx), authorityOf(ctx)]);
      // A directory (tools/directory.ts): `use_tool` runs the tool it names by that tool's own name, so everything
      // below (steps, policy, scope, schema, checks, approval) is that tool's; `find_tools` runs as is. Any tool goes
      // through any `use_tool`, a directory's own and one already listed too: a computer brain's harness may still
      // list what it had when it started, and one the agent may not use is refused below, saying why.
      let call = requested;
      // An action approved ahead, by its id (`run_approved_action`): its stored call goes the way a direct call
      // does, with its reason, so the approval it meets below is the one a person gave for this run.
      const named = all.get(call.name);
      if (named?.name === RUN_APPROVED_ACTION && isBuiltIn(named)) {
        const stored = await storedAhead(ctx, call.input.id);
        if (stored) call = { ...call, name: stored.tool, input: { why: stored.why, ...stored.params } };
      }
      let directoryTool: ToolDefinition | undefined;
      let unknownInDirectory: string | null = null;
      if (!all.has(call.name)) {
        const usable = await grantedFor(ctx, authority, all);
        const blocked = async () => {
          const [tools, connectors] = await Promise.all([
            notAllowed(ctx, authority, all).catch(() => []),
            deps.catalog
              ? missingConnectors(ctx.db, ctx.orgId, deps.catalog, { usable, listed: all.values() }).catch(() => [])
              : [],
          ]);
          const ask = usable.some((t) => t.name === REQUEST_PERMISSION_TOOL) ? REQUEST_PERMISSION_TOOL : null;
          return { tools, ask, connectors };
        };
        const resolved = resolveCall(presentTools(usable, isSensitive, ctx.loadedGroups, blocked), all, call);
        if ("error" in resolved) unknownInDirectory = resolved.error;
        else {
          call = resolved.call;
          directoryTool = resolved.find;
        }
      }
      const viaDirectory = call !== requested;
      const step = { id: ctx.runId, orgId: ctx.orgId };
      // A mission task's call through the bridge has no run (ADR 0032): nothing to record steps on.
      const record: typeof addRunStep = (db, run, kind, data) =>
        ctx.runId ? addRunStep(db, run, kind, data) : Promise.resolve();
      let tool = unknownInDirectory ? undefined : (all.get(call.name) ?? directoryTool);
      const alias = tool && !tool.connectionId ? INPUT_ALIASES.get(tool.name) : undefined;
      if (alias) call = { ...call, input: alias(call.input) };
      // What the live chip shows (the short label of a built-in tool, never a connector's input; the app and its
      // service): the chat's line of this call says the same after the run. A permission check also keeps its
      // command, masked, to open.
      const detail = toolDetail(call.name, call.input);
      const command = toolCommand(call.name, call.input);
      await record(ctx.db, step, "tool_call", {
        toolUseId: call.toolUseId,
        name: call.name,
        input: call.input,
        ...(detail ? { detail } : {}),
        ...(command ? { command } : {}),
        ...(tool?.connectorLabel ? { connector: tool.connectorLabel } : {}),
        ...(tool?.service ? { service: tool.service } : {}),
        ...(tool?.serviceIcon ? { serviceIcon: tool.serviceIcon } : {}),
      });
      /** The rules ("Aprovar sempre") this call ran under instead of asking. */
      let approvedBy: string[] | null = null;
      /** What the call's line in the chat says of it: approved by a rule, whose person, a read-only SQL one or not. */
      let autoApproved: { by: string | null; reads: boolean } | null = null;
      // The audit (agent-audit.ts): every call that matters, with how it ended. A routine's belongs where it
      // delivers, never to its room.
      const actionChannel =
        authority?.kind === "routine" ? (authority.brief?.deliverTo.channelId ?? ctx.channelId) : ctx.channelId;
      const audit = (
        outcome: AuditOutcome,
        extra: {
          reason?: string | null;
          refusal?: string | null;
          approvalId?: string;
          secretRequestId?: string;
          about?: ToolCallSubject | null;
        } = {},
      ) => {
        if (!tool) return Promise.resolve();
        const kind = toolKind(tool).kind;
        if (!auditsCall(kind, tool, outcome)) return Promise.resolve();
        return recordToolCall(ctx.db, {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId || null,
          channelId: actionChannel || null,
          authority,
          tool: tool.name,
          kind,
          connector: tool.connectorLabel ?? null,
          title: callTitle(tool, call.input),
          input: call.input,
          outcome,
          approvalRules: approvedBy,
          ...extra,
        });
      };
      /**
       * `outcome`: what the audit says; none for a call that never really was one (a malformed input). `ran`: the
       * tool itself answered (not a gateway refusal).
       */
      const finish = async (output: ToolOutput, outcome?: AuditOutcome, ran = false) => {
        // A result read from outside marks the run (`runReadOutside`, ADR 0117), an error too: its text came from there.
        const outside = ran && tool && readsOutsideText(tool, output) ? { outside: true } : null;
        const data = output.data || outside ? { ...output.data, ...outside } : null;
        recordRead(ctx.runId, call.name, output.content, output.data, call.input);
        await record(ctx.db, step, "tool_result", {
          toolUseId: call.toolUseId,
          name: call.name,
          isError: output.isError === true,
          content: shown(output.content),
          // `shown` drops the outside-content envelope; learning still needs to know the text came from outside.
          ...(tool?.external ? { external: true } : {}),
          ...(data ? { data } : {}),
          ...(autoApproved ? { autoApproved } : {}),
        });
        const refusal = typeof output.data?.refusal === "string" ? output.data.refusal : null;
        if (outcome)
          await audit(
            outcome,
            outcome === "done" ? { about: callSubject(output) } : { reason: shown(output.content), refusal },
          );
        return { type: "result" as const, output, ...(autoApproved ? { autoApproved } : {}) };
      };

      if (unknownInDirectory) return finish({ content: unknownInDirectory, isError: true });
      if (!tool) return finish({ content: `Unknown tool ${call.name}`, isError: true });
      // A tool that runs other actions (Composio's executor): a call whose actions all only read is the
      // connection's read, when the agent may read the connection. Everything below then sees a read.
      if (tool.actions && tool.readScope) {
        const bare = takeWhy(tool.inputSchema, call.input).input;
        const actions = tool.actions(bare);
        if (actions?.length && actions.every((a) => actionLevel(a) === "read")) {
          const read: ToolDefinition = { ...tool, scope: tool.readScope, sensitive: false };
          const keys = await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId);
          if (isAllowed(accessWithNeeds(keys, read).state)) {
            tool = read;
            call = { ...call, input: bare };
          }
        }
      }
      const builtIn = isBuiltIn(tool);
      const decision = policyFor(authority, tool);
      if (decision.action === "refuse") {
        return finish(
          { content: decision.reason, isError: true, data: { code: "tool.not_allowed", refusal: "policy" } },
          "refused",
        );
      }
      // A directory's search lists only tools the agent already holds; each real tool is checked on its own.
      if (tool !== directoryTool) {
        const granted = await freshGrantedKeys(ctx.db, ctx.orgId, ctx.agentId);
        const access = accessWithNeeds(granted, tool);
        if (!isAllowed(access.state)) {
          const refusal = await refusalOf(ctx, tool, access, granted);
          return finish(
            { content: `Not allowed: ${refusal}`, isError: true, data: { refusal: "noAccess" } },
            "refused",
          );
        }
      }
      // A call that asks a person says why (shown on its card); the tool itself never sees it. It is
      // asked for last: a call refused for any other reason (its input, a repository outside the agent's
      // list) gets that reason first.
      let approves = decision.action === "approve" || isSensitive(tool) || asksWithWhy(tool, call.input);
      // Only its `why` makes it ask: a command the computer holds, or (a merge this agent does alone) doesn't.
      const askedByWhy = approves && decision.action !== "approve" && !isSensitive(tool);
      let why = "";
      let whyMissing = false;
      if (asksPerson(tool, decision) || asksWithWhy(tool, call.input)) {
        const taken = takeWhy(tool.inputSchema, call.input);
        why = taken.why ?? "";
        whyMissing = !taken.why;
        call = { ...call, input: taken.input };
      }
      // Team actions (ADR 0064): an outside call repeated after the agent was told the team already did it
      // may say why (kept on the record); the tool never sees it.
      const outside = isOutsideTool(tool);
      let repeatWhy: string | null = null;
      const schemaProps = tool.inputSchema.properties as Record<string, unknown> | undefined;
      if (outside && !asksPerson(tool, decision) && "why" in call.input && schemaProps?.why === undefined) {
        const { why: given, ...rest } = call.input;
        repeatWhy = typeof given === "string" ? given : null;
        call = { ...call, input: rest };
      }
      // A key for a service we connect natively opens no card: the agent gets the way in. `person_said` is only ever
      // offered by that answer, so the tool's schema doesn't carry it.
      if (tool.name === REQUEST_SECRET_TOOL && !tool.connectionId) {
        const { person_said: said, ...asked } = call.input;
        call = { ...call, input: asked };
        if (deps.catalog) {
          const tools = { usable: await grantedFor(ctx, authority, all), all: [...all.values()] };
          const way = await connectorFirst(ctx, deps.catalog, asked, String(said ?? ""), tools).catch(() => null);
          if (way) return finish({ content: way, data: { code: "secret.connector_first" } });
        }
      }
      const problems = validateJson(tool.inputSchema, call.input);
      if (problems.length > 0) {
        // Through a directory the model never saw the schema up front: show it, so the next call can be right.
        const listed = asListed(tool, decision);
        const schemaHint = viaDirectory ? `\nInput schema of ${tool.name}: ${compactSchema(listed.inputSchema)}` : "";
        // Everything the call lacks in one answer: told one field at a time, a model swaps one for the other.
        const needsWhy = whyMissing ? `. ${WHY_REFUSAL}` : "";
        return finish({ content: `Invalid input: ${problems.join("; ")}${needsWhy}${schemaHint}`, isError: true });
      }
      // A run a routine's reading feeds never sends a credential anywhere (ADR 0053 §3): a key it read on its
      // computer (a sandbox that can't keep it from being read) can't leave through any tool, on any brain. Any
      // other run uses the agent's own grants, as a person's does.
      if (fedByRoutine(authority) && carriesCredential(call.input)) {
        return finish(
          { content: CREDENTIAL_REFUSAL, isError: true, data: { code: "tool.credential", refusal: "credential" } },
          "refused",
        );
      }
      // The call's arguments (GitHub repositories, mail folders and recipients…), before running or asking anyone.
      const check = await checkToolCall(tool, call.input, ctx);
      if (!check.ok) return finish({ content: check.message, isError: true, data: check.data ?? {} }, "refused");
      // A brain's own merge is refused with "ask with run_code and why": whether it may run alone is the computer's to
      // say, so that one command goes there first. Held after all, it asks with this why, whatever the computer offered.
      const script = askedByWhy ? tool.rememberCommand?.(call.input) : null;
      const computerDecides = Boolean(script && loneMerge(script)) && (await mergeReposOfCall(ctx)).length > 0;
      if (computerDecides) approves = false;
      // "Aprovar sempre": a call of a kind someone approved for good runs like an allowed one, why or not.
      const remember = !approves
        ? null
        : tool.sqlReads
          ? await rememberableSqlRead(tool, call.input, authority, decision)
          : rememberable(tool, call.input, authority, decision);
      if (remember) {
        const at = { orgId: ctx.orgId, agentId: ctx.agentId, connectionId: tool.connectionId ?? null };
        approvedBy = await coveringRules(ctx.db, at, remember);
        if (approvedBy) {
          approves = false;
          autoApproved = {
            by: await rulesApprover(ctx.db, approvedBy),
            reads: remember.actions.some((a) => a.startsWith(SQL_READS)),
          };
        }
      }
      // The routine's own job: an action its creator allowed when they set it up runs like an allowed one, every run.
      const ownJob =
        approves && authority?.kind === "routine" && authority.brief
          ? await ownJobCovers(ctx, authority.brief, tool, call.input)
          : false;
      if (ownJob) approves = false;
      // "Pode fazer merge sem perguntar": a merge in a repository its owner or an admin chose, with no card.
      const mergeAlone: MergeDone | null = approves ? await connectorMerge(ctx, tool, call.input) : null;
      if (mergeAlone) approves = false;
      // Approved ahead: the exact call a person approved for this routine run's slot runs like an allowed one, why
      // or not; the one they refused never runs.
      const ahead =
        approves && authority?.kind === "routine" && authority.brief
          ? await aheadFor(
              ctx,
              authority.brief,
              actionHash({
                tool: tool.name,
                scope: tool.scope,
                connectionId: tool.connectionId ?? null,
                params: call.input,
              }),
            )
          : null;
      if (ahead?.status === "refused") {
        return finish({ content: AHEAD_REFUSED, isError: true, data: { code: "approval.ahead_refused" } }, "refused");
      }
      if (whyMissing && !approvedBy && !ahead && !ownJob && !mergeAlone)
        return finish({ content: WHY_REFUSAL, isError: true, data: { code: "tool.why_missing" } });
      // Costly work nobody asked for directly (ADR 0131 §3): a person's go first, on every brain.
      const isPrompt = tool.name === PERMISSION_TOOL && builtIn;
      const cost = ctx.runId && unrequested(authority) ? await costOf(ctx, tool.name, call.input) : null;
      if (cost) {
        const refusal = await costlyGate(
          { db: ctx.db, pubsub: deps.pubsub },
          {
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            runId: ctx.runId,
            channelId: ctx.channelId,
            threadRootId: ctx.threadRootId,
          },
          authority,
          cost,
          toolCommand(call.name, call.input) ?? callTitle(tool, call.input) ?? tool.name,
        );
        if (refusal) {
          const content = isPrompt
            ? JSON.stringify({ behavior: "deny", message: refusal.message, code: "autonomy" })
            : refusal.message;
          return finish({ content, isError: !isPrompt, data: { code: refusal.code } }, "refused");
        }
      }
      const withRepo = (output: ToolOutput): ToolOutput =>
        check.data ? { ...output, data: { ...output.data, ...check.data } } : output;

      // Team actions (ADR 0064): before acting outside, has the team already done this to the same target?
      const prompt = tool.name === PERMISSION_TOOL && builtIn ? promptQuestion(call.input) : null;
      const targets = outside ? callTargets(call.input) : (prompt?.action?.targets ?? []);
      let teamReason: string | null = null;
      if (outside || prompt?.action) {
        const seen = await checkTeamAction(ctx.db, ctx, {
          tool: prompt?.action?.tool ?? tool.name,
          targets,
          why: repeatWhy ?? (why || null),
        }).catch(() => UNCHECKED);
        if (!seen.proceed) {
          // A computer command is answered the way its prompt expects: a refusal with the notice.
          const content = prompt
            ? JSON.stringify({ behavior: "deny", message: seen.notice, code: "team" })
            : seen.notice;
          return finish({ content, isError: !prompt, data: { code: "team.action_seen" } }, "refused");
        }
        teamReason = seen.reason;
      }
      const recordAction = (input: {
        source: "tool" | "command";
        tool: string;
        summary: string;
        targets: string[];
        ref?: string;
      }) =>
        recordTeamAction(ctx.db, {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId || null,
          channelId: actionChannel || null,
          reason: teamReason,
          ...input,
        });

      // Its tool_result step, audit and team action are the approved action's own (`runApproved`).
      if (ahead) {
        const output = withRepo(await runApproved(ctx, ahead, call.toolUseId));
        const [ran] = await ctx.db.select().from(approvals).where(eq(approvals.id, ahead.id));
        return { type: "result", output, ...(ran ? { ran } : {}) };
      }
      const askPerson = async (why: string, remember: ReturnType<typeof rememberable>): Promise<InvokeResult> => {
        const owner = await ownerOf(ctx);
        // A routine's request goes to the conversation it reports to, never its room; one asked by another
        // agent (ADR 0034) where the person is, not in the agents' DM.
        // Consulted for a creator outside its agent's audience: it stays in the agents' DM (`answersAgentsOnly`).
        const deliverTo =
          authority?.kind === "routine" && !(ctx.runId && (await answersAgentsOnly(ctx.db, ctx.orgId, ctx.runId)))
            ? authority.brief?.deliverTo
            : undefined;
        const origin = deliverTo
          ? { channelId: deliverTo.channelId, threadRootId: deliverTo.threadId ?? ctx.threadRootId }
          : ctx.runId
            ? await consultationOrigin(ctx.db, ctx.orgId, ctx.runId)
            : null;
        const asked = tool.approvers
          ? await tool.approvers(
              call.input,
              ctx,
              authority ? (authority.personId ?? routineCreatorOf(authority)) : null,
            )
          : null;
        if (asked && !asked.ok) return finish({ content: asked.message, isError: true }, "refused");
        const described = tool.describe?.(call.input) ?? { title: `${tool.name}`, detail: canonicalJson(call.input) };
        const connectionId = tool.connectionId ?? null;
        const [approval] = await ctx.db
          .insert(approvals)
          .values({
            orgId: ctx.orgId,
            runId: ctx.runId,
            missionId: tool.missionId ?? null,
            agentId: ctx.agentId,
            channelId: origin?.channelId ?? ctx.channelId,
            threadRootId: origin?.threadRootId ?? ctx.threadRootId,
            toolUseId: call.toolUseId,
            tool: tool.name,
            scope: tool.scope,
            connectionId,
            params: call.input,
            actionHash: actionHash({ tool: tool.name, scope: tool.scope, connectionId, params: call.input }),
            title: cutMarked(described.title, 300),
            detail: cutMarked(described.detail ?? "", APPROVAL_DETAIL_CHARS),
            why,
            origin: authority ? approvalOrigin(authority) : null,
            ownerUserId: owner,
            expiresAt: new Date(now().getTime() + APPROVAL_TTL_MS),
            approveAlways: remember,
            approvers: asked?.approvers ?? null,
            requestedByUserId: authority ? (authority.personId ?? routineCreatorOf(authority)) : null,
            highRisk: highRisk(tool.name, tool.scope),
          })
          .onConflictDoNothing()
          .returning();
        // The same call asked again (a retried job) finds the first request: no second one to count.
        if (approval && tool.connector) {
          const { orgId, agentId } = ctx;
          await countToolCall(ctx.db, { orgId, agentId, connector: tool.connector, approvalsAsked: 1 });
        }
        const row =
          approval ??
          (
            await ctx.db
              .select()
              .from(approvals)
              .where(and(eq(approvals.runId, ctx.runId), eq(approvals.toolUseId, call.toolUseId)))
          )[0];
        if (!row) throw new Error("approval insert returned nothing");
        await record(ctx.db, step, "approval", { approvalId: row.id, toolUseId: call.toolUseId, title: row.title });
        await audit("pending", { reason: why || null, approvalId: row.id });
        return { type: "approval", approval: row };
      };
      if (approves) {
        // A routine's card offers "Sempre nesta rotina" instead: `rememberable` keeps "Aprovar sempre" off its runs.
        const kept =
          remember ??
          (authority?.kind === "routine" && authority.brief
            ? await routineKind(ctx, authority.brief, tool, call.input)
            : null);
        return askPerson(why, kept);
      }
      const runCtx: ToolContext = { ...ctx, toolUseId: call.toolUseId };
      // Our own tools only (`schedule_action`), never a connected server's.
      if (!tool.connectionId) runCtx.prepareAhead = (request) => prepareAhead(runCtx, authority, request);
      const output = withRepo(await run(tool, call.input, runCtx));
      // The computer held a command for a person (a merge, a deploy): the card goes out now, as a call with `why`
      // would have asked, so it never rests on the agent calling again. Approved, it runs the approved way.
      const held = tool.whyAsks && ctx.runId && !ctx.approved ? heldCommandReason(output) : null;
      const stillAsks = computerDecides && output.data?.code === "command.approval_needed";
      if (held || stillAsks) return askPerson(why || (held ?? ""), rememberable(tool, call.input, authority, decision));
      const merged = mergeAlone ?? (tool.whyAsks ? (output.data?.merge as MergeDone | undefined) : null);
      if (merged && !output.isError) await recordMergeDone(ctx, merged, tool.name).catch(() => {});
      if (outside && !output.isError) {
        await recordAction({
          source: "tool",
          tool: tool.name,
          summary: summarizeCall(tool, call.input),
          targets: callTargets(call.input, output.data),
        });
      }
      if (prompt) {
        const answer = promptAnswer(output.content);
        if (prompt.action && (answer.behavior === "allow" || answer.status === "pending")) {
          // A command waiting for a person counts already; it goes away if they say no.
          await recordAction({
            source: "command",
            tool: prompt.action.tool,
            summary: prompt.action.command,
            targets: prompt.action.targets,
            ...(answer.status === "pending" && answer.request_id ? { ref: answer.request_id } : {}),
          });
        }
        if (prompt.poll && answer.behavior === "deny") await forgetPendingCommand(ctx.db, ctx.orgId, prompt.poll);
      }
      if (builtIn && output.waitForAnswer?.text) {
        return { type: "question", ...output.waitForAnswer, why };
      }
      const asked = tool.connectionId ? undefined : output.waitForApproval;
      if (asked) {
        await record(ctx.db, step, "approval", { approvalId: asked.id, toolUseId: call.toolUseId, title: asked.title });
        await audit("pending", { reason: asked.why || null, approvalId: asked.id });
        return { type: "approval", approval: asked };
      }
      if (!tool.connectionId && output.waitForSecret?.requestId) {
        // The reader follows the request (delivered, declined, expired) from here.
        await audit("pending", { secretRequestId: output.waitForSecret.requestId });
        return { type: "secret", requestId: output.waitForSecret.requestId };
      }
      return finish(output, prompt ? promptOutcome(prompt, output) : output.isError ? "failed" : "done", true);
    },

    /**
     * What a decision resumes (the run that asked): the approved action, run once exactly as hashed. One approved
     * ahead waits for its time instead: the routine's run then does it (`aheadFor`), and this run hears when.
     */
    async executeApproved(ctx: ToolContext, approval: Approval): Promise<ToolOutput> {
      const runAt = approval.runAt;
      if (approval.status === "approved" && runAt) return { content: await aheadNote(ctx, { ...approval, runAt }) };
      return runApproved(ctx, approval, approval.toolUseId);
    },
  };

  async function ownerOf(ctx: ToolContext) {
    const rows = await ctx.db
      .select({ ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(sql`${agents.id} = ${ctx.agentId} and ${agents.orgId} = ${ctx.orgId}`);
    return rows[0]?.ownerUserId ?? null;
  }
}

export type ToolGateway = ReturnType<typeof createToolGateway>;

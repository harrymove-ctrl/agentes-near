import { and, type Executor, eq, type SQL, schema, sql } from "@agenteschat/db";
import { PROVIDERS, type ProviderCause, ProviderError, providerCause } from "@agenteschat/providers";
import { BRAIN_NAMES, type ComputerBrainKind, planName } from "./brains/types";
import { cutText, pgSafeJson } from "./format";
import { recordRunFinished } from "./operator-events";
import { standingErrorDetail } from "./standing";
import { cliErrorWords, redactCredentials } from "./tool-detail";

const { agentRuns, agentRunSteps } = schema;

export type AgentRun = typeof agentRuns.$inferSelect;
export type RunStatus = AgentRun["status"];

/**
 * For a select over `agent_runs`: parked on a provider outage (`transcript.outage`), it resumes by itself. The marker
 * stays until a turn answers, so a run that waits on its computer or its plan since (`waitingMachineId`,
 * `waitingForBrain`) reads as that wait, never as the provider being down.
 */
export const outageParkedSql = sql<boolean>`(${agentRuns.status} = 'waiting_input' and ${agentRuns.transcript} -> 'outage' is not null
  and ${agentRuns.waitingMachineId} is null and ${agentRuns.transcript} -> 'waitingForBrain' is null)`;

/** `outageParkedSql` for a loaded run. */
export function outageParkedOf(run: Pick<AgentRun, "status" | "waitingMachineId" | "transcript">): boolean {
  const t = run.transcript as { outage?: unknown; waitingForBrain?: unknown } | null;
  return run.status === "waiting_input" && !run.waitingMachineId && Boolean(t?.outage) && !t?.waitingForBrain;
}

/**
 * For a select over `agent_runs`: it ended without answering, so its receipt reads "didn't reply": it passed and posted
 * nothing anywhere (the `passed` step is `silent`, `endQuietly`), or it was canceled before it started.
 * `agent_runs.id` is spelled out: a one-table select renders columns unqualified, and a bare "id" in the
 * subquery would be the step's.
 */
export const passedSql = sql<boolean>`((${agentRuns.status} = 'done' and ${agentRuns.replyMessageId} is null
  and exists (select 1 from ${agentRunSteps} where ${agentRunSteps.runId} = agent_runs.id
  and ${agentRunSteps.kind} = 'context' and ${agentRunSteps.data}->'passed'->>'silent' = 'true'))
  or (${agentRuns.status} = 'canceled' and ${agentRuns.startedAt} is null))`;

/**
 * For a select over `agent_runs`: waiting for its computer, in line for room (`queued`) or for it to be back (`away`),
 * or long work waiting in the agent's line of work (`line`, ADR 0121): nobody is asked anything.
 */
export const computerWaitSql = sql<"queued" | "away" | "line" | null>`(case when ${agentRuns.status} = 'waiting_input'
  and ${agentRuns.waitingMachineId} is not null then (case when ${agentRuns.transcript}->'waitingForBrain'->>'code' = 'busy'
  then 'queued' else 'away' end)
  when ${agentRuns.status} = 'running' and ${agentRuns.waitingMachineId} is not null then 'queued'
  when ${agentRuns.status} = 'waiting_input' and ${agentRuns.transcript}->'waitingForBrain'->>'code' = 'work_queue' then 'line' end)`;

/**
 * `computerWaitSql` for a loaded run, for its computer only. The head of a computer's line asks for room by claiming
 * its run: `running` with its machine kept is that ask, until the computer takes the turn. Nothing changed for anyone
 * reading: it still waits.
 */
export function computerWaitOf(run: Pick<AgentRun, "status" | "waitingMachineId" | "transcript">) {
  if (!run.waitingMachineId) return null;
  if (run.status === "running") return "queued" as const;
  if (run.status !== "waiting_input") return null;
  const wait = (run.transcript as { waitingForBrain?: { code?: string } } | null)?.waitingForBrain;
  return wait?.code === "busy" ? ("queued" as const) : ("away" as const);
}

/** `r.status` as people read it (`computerWaitOf`), for a raw select over `agent_runs r`. */
export const shownStatusSql = sql`(case when r.status = 'running' and r.waiting_machine_id is not null
  then 'waiting_input' else r.status end)`;

/**
 * For a select over `agent_runs`: waiting on its plan's limit (`plan`) or its budget (`budget`), long work paused near
 * one too (`usage_pause`, by its `source`): it answers when that renews, nobody is asked.
 */
export const usageWaitSql = sql<"plan" | "budget" | null>`(case when ${agentRuns.status} = 'waiting_input'
  and ${agentRuns.waitingMachineId} is null then (case ${agentRuns.transcript}->'waitingForBrain'->>'code'
  when 'plan_limit' then 'plan' when 'budget' then 'budget'
  when 'usage_pause' then coalesce(${agentRuns.transcript}->'waitingForBrain'->>'source', 'plan') end) end)`;

/** `usageWaitSql` for a loaded run. */
export function usageWaitOf(run: Pick<AgentRun, "status" | "waitingMachineId" | "transcript">) {
  if (run.status !== "waiting_input" || run.waitingMachineId) return null;
  const wait = (run.transcript as { waitingForBrain?: { code?: string; source?: string } } | null)?.waitingForBrain;
  if (wait?.code === "plan_limit") return "plan" as const;
  if (wait?.code === "budget") return "budget" as const;
  if (wait?.code === "usage_pause") return wait.source === "budget" ? ("budget" as const) : ("plan" as const);
  return null;
}

/**
 * Where a run's replies go: asked in the main timeline (a channel or a
 * DM), it answers in the main timeline; asked in a thread, in
 * that thread. The run keeps `threadRootId` (its trigger, when top-level) as
 * the conversation it belongs to. The one rule for the engine, its tools and
 * the bridge: cards and events of a run always land where its replies do.
 */
export function replyThreadOf(run: Pick<AgentRun, "threadRootId" | "triggerMessageId">): string | null {
  return run.threadRootId === run.triggerMessageId ? null : run.threadRootId;
}

/**
 * Allowed transitions of `agent_runs.status` (docs/adr/0008-agent-runs.md):
 * `queued → running → ((waiting_approval | waiting_input) → running)* → done | failed`,
 * and any non-final state → `canceled` (a person stopped it). The last three are terminal. Suspending for an approval is a status
 * change; resuming is enqueueing a new `agent_run.execute` job.
 */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "failed", "canceled"],
  running: ["waiting_approval", "waiting_input", "done", "failed", "canceled"],
  waiting_approval: ["running", "failed", "canceled"],
  /** Waiting for a person to answer an `ask_user` question (or for it to expire). */
  waiting_input: ["running", "failed", "canceled"],
  done: [],
  failed: [],
  /** A person stopped it; whatever it wrote so far is kept. */
  canceled: [],
};

/** A run's error (and a routing decision's) when nobody could think: no AI connected. */
export const NO_AI = "no_ai" as const;
/** The `strategy` of a `no_ai` decision made on a billing hold: its receipt says `kept`, and it is answered after the plan. */
export const KEPT_ON_HOLD = "plan_hold";
/** A run's error when the person behind it is at their monthly AI limit (ADR 0141): its card says so. */
export const PERSON_LIMIT = "person_limit" as const;
/** An older run's error from when a run waited at most 30 minutes for room on its computer (still worded). */
export const COMPUTER_BUSY = "computer_busy" as const;
/** A run's error when it went in circles and its kind of run can't end with Continuar (a routine's). */
export const STUCK_ERROR = "stuck" as const;

/** A run's error when its server stopped in the middle of a tool call (a deploy, a crash, a reboot). */
export const INTERRUPTED_BY_RESTART = "Interrupted by a server restart";

/**
 * The computer's own failure codes (`BrainFailure.code`: its program, the call to it): worded as the computer's problem,
 * the code kept only as a detail. The ones that call for a different step (signed out, outdated program, missing CLI,
 * plan limit) keep their own code, and a CLI's failure is the CLI's (`CLI_CODES`).
 */
const COMPUTER_ERRORS = new Set(["runner_error", "runner_failed"]);
/** Any other code a computer turn failed with (`brain_failed`…): the computer's problem too. */
const OTHER_FAILED = /^[a-z]+(?:_[a-z]+)*_failed$/;

/** A CLI's failed turn (`BrainFailure.code`), by the brain whose CLI it is. */
const CLI_CODES: Readonly<Record<string, ComputerBrainKind>> = {
  claude_failed: "claude_code",
  codex_failed: "codex",
  cursor_failed: "cursor",
  opencode_failed: "opencode",
  grok_failed: "grok",
  antigravity_failed: "antigravity",
};
/** The runner's causes that are the provider's answer (runner protocol 50), never the CLI's or the computer's. */
const PROVIDER_CAUSES: ReadonlySet<string> = new Set([
  "quota",
  "billing",
  "provider_transient",
  "auth_rejected",
  "account_disabled",
]);
/** The status a provider's cause stands for when the CLI gave none, so it reads as a key's would. */
const CAUSE_STATUS: Readonly<Record<string, number>> = { quota: 429, billing: 402, provider_transient: 503 };
/** "API Error: 529 {…}": a provider's answer, as Claude Code words it. */
const API_ERROR = /\bAPI Error:? (\d{3})\b/;
/**
 * The runner's words when the CLI ended without its answer, how it ended then what it said on its way out: Claude
 * Code's (`ended without an answer (exit 1): …`) and the other CLIs' (`Codex exited with code 1: …`).
 */
const ENDED =
  /^\S.*? (?:ended without an answer \(((?:exit|signal) [^)]*)\)|exited with code (\S+?))(?::\s*([\s\S]*))?$/;
/**
 * The CLI's turn ended failed and it said nothing more: Claude Code's result (`error_during_execution`, `an error`),
 * another CLI that left with exit 0 short of its answer (`ended without finishing the turn`).
 */
const BARE_RESULT = /^\S.*? ended (?:with (?:\w+|an error)|without finishing the turn)$/;

/** A CLI's own failed turn (`claude_failed`, `codex_failed`…), as against its computer's or its plan's. */
export const isCliFailure = (code: string) => Object.hasOwn(CLI_CODES, code);

/** A CLI's failure, from its code and what it said (`BrainFailure`). */
export interface CliFailure {
  code: string;
  message: string;
  provider?: { cause?: string; httpStatus?: number };
}

/**
 * Grok Build's words when it fails closed at its start: on Linux without bubblewrap (1.0.70: "Install bubblewrap with
 * `apt install -y bubblewrap`. Refusing to start with denied paths unprotected."), outside its pinned version range.
 */
const REFUSED_START = /\brefus(?:e|es|ing) to start\b/i;

/**
 * A CLI that refused to start on its computer: every retry fails the same way until someone installs or updates
 * something there, whatever the runner called it.
 */
export const cliRefusedStart = (failure: CliFailure) =>
  isCliFailure(failure.code) && REFUSED_START.test(failure.message);

/**
 * Who failed a CLI's turn: the provider, when it refused or failed the CLI's call (a status, or the runner's cause), as
 * a key's failure would read on that plan; else the CLI itself, with what it said (`cliErrorWords`, safe for anyone in
 * the conversation; empty when it said nothing), and how it ended when it ended without its answer. Never the computer:
 * it ran the CLI. Null for any other code.
 */
export function cliFailureOf(
  failure: CliFailure,
  account?: { provider?: string },
): { provider: ProviderError } | { brain: string; words: string; ended?: string } | null {
  const kind = CLI_CODES[failure.code];
  if (!kind) return null;
  const { cause, httpStatus } = failure.provider ?? {};
  const status =
    httpStatus ?? (Number(API_ERROR.exec(failure.message)?.[1]) || (cause ? CAUSE_STATUS[cause] : undefined));
  if (status || (cause && PROVIDER_CAUSES.has(cause))) {
    const words = cliErrorWords(failure.message);
    const provider = new ProviderError(words, false, status, undefined, words || undefined);
    provider.provider = planName(kind, account?.provider);
    return { provider };
  }
  const brain = BRAIN_NAMES[kind];
  const said = failure.message;
  // The runner's own sentence about its CLI, never one the CLI said itself ("MCP server exited with code 1").
  const runner = said.startsWith(`${brain} `) || said.startsWith(`The ${brain} `);
  if (runner && BARE_RESULT.test(said)) return { brain, words: "" };
  const ended = runner ? ENDED.exec(said) : null;
  if (!ended) return { brain, words: cliErrorWords(said) };
  return { brain, words: cliErrorWords(ended[3] ?? ""), ended: ended[1] ?? `exit ${ended[2]}` };
}

/** What a CLI's failure said (`cliFailureOf`'s words), or how it ended when it said nothing; empty for neither. */
export function cliWords(failure: CliFailure): string {
  const of = cliFailureOf(failure);
  if (!of) return "";
  return "brain" in of ? of.words || (of.ended ?? "") : (of.provider.said ?? "");
}

/**
 * A CLI's failure as its run stores it (`runErrorDetail` reads it back): the provider's as a key's
 * (`provider_error: cause@Claude: …`, `gave_up: …` after the outage's waits), else `cli_failed: Claude Code: what it
 * said`, or `cli_closed: Claude Code: exit 1` when it ended without a word. Null for any other code.
 */
export function cliFailureText(
  failure: CliFailure,
  account?: { provider?: string },
  kind: "provider_error" | "gave_up" = "provider_error",
): string | null {
  const of = cliFailureOf(failure, account);
  if (!of) return null;
  if ("provider" in of) return providerFailureText(kind, of.provider);
  if (of.words) return `cli_failed: ${of.brain}: ${of.words}`;
  return of.ended ? `cli_closed: ${of.brain}: ${of.ended}` : `cli_failed: ${of.brain}`;
}

/** `cli_failed: Claude Code: what it said` (`cliFailureText`); `cli_closed` when it ended without a word. */
const CLI_FAILURE = /^cli_(failed|closed): ([^:]+?)(?:: ([\s\S]*))?$/;

/** A run that stopped on an error of ours that kept repeating (`gave up` in the executor): its stored text's start. */
export const OUR_ERROR = "Stopped after an error";

/** Starts a `provider_error:`'s detail in older rows, when the provider refused the key's account. */
const PROVIDER_ACCOUNT = "account: ";

const OUR_KEY_CAUSES: ReadonlySet<ProviderCause> = new Set(["no_credit", "invalid_key", "no_access", "rate_limit"]);

/**
 * A provider failure in the terms the apps word it: a known cause, `ours` (it came on the server's own key, so nothing
 * of the person's is wrong), or `said` (only the provider's own words, masked and cut, tell).
 */
export function providerFailureOf(error: ProviderError) {
  const found = providerCause(error);
  const ours = error.platformKey && found !== null && OUR_KEY_CAUSES.has(found);
  return {
    cause: ours ? "ours" : (found ?? "said"),
    provider: error.provider ?? "",
    detail: cutText(redactCredentials(error.said ?? error.message), 200),
  };
}

/** `cause@Provider: detail`, after a stored `provider_error:` or `gave_up:`. Older rows hold only the detail. */
const PROVIDER_FAILURE =
  /^(no_credit|invalid_key|no_access|model_unavailable|rate_limit|down|timeout|unreachable|said|ours)@(.*?): ([\s\S]*)$/;

/** A provider failure as a run stores it (`runErrorDetail` reads it back). */
export function providerFailureText(kind: "provider_error" | "gave_up", error: ProviderError) {
  const { cause, provider, detail } = providerFailureOf(error);
  return provider ? `${kind}: ${cause}@${provider}: ${detail}` : `${kind}: ${detail}`;
}

/** Older stored errors name Claude's provider by the company, "Anthropic": they read with today's label. */
const providerNow = (label: string) => (label === "Anthropic" ? PROVIDERS.anthropic.label : label);

/**
 * The stable code (and params) of a run's stored `error`, for the app to
 * word it in the person's language; the stored text stays as the fallback.
 */
export function runErrorDetail(error: string | null | undefined): {
  errorCode: string;
  errorParams?: Record<string, string>;
} | null {
  if (!error) return null;
  const simple = [
    "budget_exceeded",
    "too_many_tool_calls",
    "empty_reply",
    "model_refused",
    "agent_archived",
    NO_AI,
    PERSON_LIMIT,
    COMPUTER_BUSY,
    STUCK_ERROR,
  ];
  if (simple.includes(error)) return { errorCode: `run.${error}` };
  if (error === "timeout") return { errorCode: "run.computer_timeout", errorParams: { code: error } };
  const cli = CLI_FAILURE.exec(error);
  if (cli) {
    const [, how, brain = "", detail = ""] = cli;
    if (how === "closed") return { errorCode: "run.cli_closed", errorParams: { brain } };
    return detail
      ? { errorCode: "run.cli_failed", errorParams: { brain, detail } }
      : { errorCode: "run.cli_stopped", errorParams: { brain } };
  }
  // Older rows kept only the CLI's code: whose CLI it was, not what it said.
  const cliKind = CLI_CODES[error];
  if (cliKind) return { errorCode: "run.cli_stopped", errorParams: { brain: BRAIN_NAMES[cliKind] } };
  // The runner refused a request of ours: nothing on the computer or the plan is wrong.
  if (error === "bad_request") return { errorCode: "run.our_error" };
  if (COMPUTER_ERRORS.has(error) || OTHER_FAILED.test(error))
    return { errorCode: "run.computer_failed", errorParams: { code: error } };
  // The agent's account folder isn't on its computer anymore: choose another account or add it again.
  if (error === "account_missing") return { errorCode: "run.account_missing" };
  // Ours, not the person's: the detail (a driver's message) stays for the log, never shown as the reason.
  if (error.startsWith(OUR_ERROR)) return { errorCode: "run.our_error" };
  const coded = PROVIDER_FAILURE.exec(error.replace(/^(?:provider_error|gave_up):\s*/, ""));
  if (coded) {
    const [, cause, provider = "", detail = ""] = coded;
    return cause === "ours"
      ? { errorCode: "run.our_error", errorParams: { provider } }
      : { errorCode: `run.provider_${cause}`, errorParams: { provider, detail } };
  }
  if (error.startsWith("provider_error:")) {
    const detail = error.slice(15).trim();
    return detail.startsWith(PROVIDER_ACCOUNT)
      ? { errorCode: "run.provider_account", errorParams: { detail: detail.slice(PROVIDER_ACCOUNT.length) } }
      : { errorCode: "run.provider_error", errorParams: { detail } };
  }
  if (error.startsWith("gave_up:"))
    return { errorCode: "run.provider_unavailable", errorParams: { detail: error.slice(8).trim() } };
  if (error.startsWith("canceled_by:"))
    return { errorCode: "run.canceled", errorParams: { byUserId: error.slice(12) } };
  // A computer brain's background run cut after its tools ran, or with nothing to think with (`executor.ts`).
  const brain = /^(brain_interrupted|brain_unavailable): ?/.exec(error);
  if (brain) return { errorCode: `run.${brain[1]}`, errorParams: { detail: error.slice(brain[0].length) } };
  const standing = standingErrorDetail(error);
  if (standing) return standing;
  // Older rows hold the Portuguese texts these errors used to have, or an earlier wording: still recognized.
  if (
    error === INTERRUPTED_BY_RESTART ||
    error === "Interrupted by a server update" ||
    error === "Interrompida por uma atualização do servidor"
  ) {
    return { errorCode: "run.interrupted", errorParams: { reason: "deploy" } };
  }
  const none =
    /^Add an API key for (.+) in the workspace settings$/.exec(error) ??
    /^Configure uma chave da API da (.+) nas configurações do workspace$/.exec(error);
  if (none) return { errorCode: "run.missing_credential", errorParams: { provider: providerNow(none[1] as string) } };
  if (
    error.startsWith("This agent's API key was revoked") ||
    error.startsWith("A chave da API deste agente foi revogada")
  )
    return { errorCode: "run.credential_revoked" };
  const wrong =
    /^This agent's model is from (.+), but the chosen key is from (.+)$/.exec(error) ??
    /^O modelo deste agente é da (.+), mas a chave escolhida é da (.+)$/.exec(error);
  if (wrong) {
    return {
      errorCode: "run.credential_wrong_provider",
      errorParams: { modelProvider: providerNow(wrong[1] as string), keyProvider: providerNow(wrong[2] as string) },
    };
  }
  if (error.startsWith("No provider registered for ")) return { errorCode: "run.our_error" };
  const unlisted = /^OpenRouter doesn't list (.+) anymore\./.exec(error);
  if (unlisted) return { errorCode: "run.model_unlisted", errorParams: { model: unlisted[1] as string } };
  return { errorCode: "run.failed", errorParams: { detail: error.slice(0, 300) } };
}

/** The detail of a run error its AI provider caused, on the person's key or the server's: worth another try. */
export function providerFailure(error: string | null | undefined) {
  const detail = runErrorDetail(error);
  const provider =
    detail?.errorCode.startsWith("run.provider_") ||
    (detail?.errorCode === "run.our_error" && detail.errorParams?.provider);
  return provider ? detail : null;
}

/** Who canceled (stored on the run as `canceled_by:{userId}`). */
export const canceledBy = (error: string | null | undefined) =>
  error?.startsWith("canceled_by:") ? error.slice("canceled_by:".length) : null;

/**
 * Whether Continuar can go on from how a run ended (`continueRun`): a person stopped it, its reply says it reached its
 * step limit or was stuck (`meta.stepLimit`), or its AI provider cut its background work off. A work that ended any
 * other way is followed up instead (`endWork`).
 */
export function continuableEnd(
  run: Pick<AgentRun, "status" | "error" | "workId" | "transcript">,
  reply: { meta: Record<string, unknown> } | null | undefined,
) {
  if (!run.transcript) return false;
  if (run.status === "canceled") return canceledBy(run.error) !== null;
  if (run.status === "failed") return Boolean(run.workId) && providerFailure(run.error) !== null;
  return run.status === "done" && Boolean(reply?.meta.stepLimit);
}

export const isTerminal = (status: RunStatus) => RUN_TRANSITIONS[status].length === 0;
export const canTransition = (from: RunStatus, to: RunStatus) => RUN_TRANSITIONS[from].includes(to);

export class InvalidRunTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`agent run can't go from ${from} to ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

/**
 * Compare-and-set transition: succeeds only if the run is still in `from`.
 * Returns the updated run, or null when another worker moved it first.
 */
export async function transitionRun(
  db: Executor,
  runId: string,
  from: RunStatus,
  to: RunStatus,
  patch: {
    error?: string | null;
    replyMessageId?: string;
    /** A plain object, or `storedTranscript` (keeps what the bridge left on the row). */
    transcript?: Record<string, unknown> | SQL;
    /** Waiting for this computer (ADR 0032 §5), or asking it from its line; cleared by any move that doesn't name it. */
    waitingMachineId?: string | null;
    /** A failure: the brain's code and the provider's cause (`run.finished`; not stored on the run). */
    failure?: { code: string; cause?: string | null };
  } = {},
): Promise<AgentRun | null> {
  if (!canTransition(from, to)) throw new InvalidRunTransitionError(from, to);
  const { failure, ...set } = patch;
  const now = new Date();
  const [row] = await db
    .update(agentRuns)
    .set({
      status: to,
      updatedAt: now,
      ...(to === "running"
        ? { startedAt: sql`coalesce(${agentRuns.startedAt}, ${now.toISOString()}::timestamptz)`, heartbeatAt: now }
        : {}),
      // Back to work after waiting (a person, an approval, its computer): its "thinking for …" counts from here. A
      // first start keeps counting from when the run was created, as the person who wrote to it saw it.
      ...(to === "running" && from !== "queued" ? { workingSince: now } : {}),
      ...(isTerminal(to) ? { finishedAt: now } : {}),
      // Only a run waiting for its computer keeps the machine it waits for.
      waitingMachineId: null,
      ...set,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, from)))
    .returning();
  if (row && isTerminal(to)) {
    await recordRunFinished(
      db,
      row,
      to === "failed"
        ? { code: failure?.code ?? runErrorDetail(row.error)?.errorCode ?? null, cause: failure?.cause ?? null }
        : undefined,
    );
    await releaseProfileTurns(db, row.id);
  }
  return row ?? null;
}

/** A run's browser profile turns end with it (done, failed or canceled; ADR 0110 §4). */
export async function releaseProfileTurns(db: Executor, runId: string) {
  await db
    .update(schema.browserProfiles)
    .set({ heldByRunId: null, heldByAgentId: null, heldUntil: null, heldSince: null })
    .where(eq(schema.browserProfiles.heldByRunId, runId));
}

export type StepKind = (typeof schema.agentRunStepKindEnum.enumValues)[number];

/** Tries for a free number: tool calls that run side by side each lose at most to the others. */
const STEP_TRIES = 20;

/**
 * Appends a step to a run's trail (numbered in order). Two at once read the same last number, and the unique
 * `(run_id, seq)` would fail the whole run: the loser takes the next one.
 */
export async function addRunStep(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId">,
  kind: StepKind,
  data: Record<string, unknown>,
) {
  const safe = pgSafeJson(data);
  for (let i = 0; i < STEP_TRIES; i++) {
    const added = await db
      .insert(agentRunSteps)
      .values({
        orgId: run.orgId,
        runId: run.id,
        kind,
        data: safe,
        seq: sql`(select coalesce(max(${agentRunSteps.seq}), 0) + 1 from ${agentRunSteps} where ${agentRunSteps.runId} = ${run.id})`,
      })
      .onConflictDoNothing()
      .returning({ id: agentRunSteps.id });
    if (added.length > 0) return;
  }
  throw new Error(`No free step number on run ${run.id}`);
}

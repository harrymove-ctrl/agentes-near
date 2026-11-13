import { PERMISSION_TOOL, type PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { linkRunActions, publishMessageActions } from "./agent-actions";
import { followWork } from "./agent-status";
import { openApprovalCard, publishApproval } from "./approvals";
import { runAuthorityById } from "./authority";
import type { BrainTool, ToolResult } from "./brains/types";
import { readableChannelIds } from "./channels";
import { consultationCardThread, consultationOrigin } from "./consultations";
import { NotFoundError } from "./errors";
import { type MemoryUpdate, publishChannelEvent, publishMessageCreated, takeStepWords } from "./events";
import { type PendingFeedbackOffer, pendingFeedbackOfferOf } from "./feedback-offers";
import { pgSafeStringify } from "./format";
import type { Judge } from "./judge";
import { insertMessage, type Message, messageView } from "./messages";
import { notifyMissionApproval } from "./mission-tools";
import { notifyQuestion } from "./notification-producers";
import {
  type AgentQuestionRow,
  ASK_USER_TOOL,
  impliedAddressee,
  publishQuestion,
  QUESTION_TTL_MS,
  questionCardMeta,
  questionView,
  syncQuestionMessage,
} from "./questions";
import { routineBriefOf } from "./routine-brief";
import type { BridgeIdentity } from "./run-tool-tokens";
import { type AgentRun, replyThreadOf } from "./runs";
import { publishSecret, type SecretRequestRow, secretLabelOf, secretRequestView, syncSecretMessage } from "./secrets";
import { artifactToolDetail, promptAnswer, promptPoll, toolCode, toolCommand, toolDetail } from "./tool-detail";
import { directoryRole, HARNESS_PREFIX, ON_DEMAND_USE, resolveDirectoryTool } from "./tools/directory";
import { type Approval, type InvokeResult, isSensitive, type ToolGateway } from "./tools/gateway";
import { WIDGET_UP_FRONT_MAX, widgetUpFront, withWhy } from "./tools/run-policy";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tools/types";
import { withWikiLinks } from "./wiki-links";

const { agentRuns, agents, agentWorks, approvals, agentQuestions, secretRequests, machineTasks, messages } = schema;

/**
 * Tool access for runs, shared by the engine loop and the runner's `agentes`
 * MCP bridge (ADR 0032 block 2) so both behave the same: where a run's cards
 * and events go (`replyThreadOf` / `runWhere`), the live tool chip
 * (`invokeWithChip`), tool side effects (`absorbToolData`, kept for the
 * engine's next post), bridge identities (`bridgeToolsFor`), calls with error
 * codes (`invokeToolForRun`) and the suspend path for gated calls
 * (`suspendRunForTool`). The engine's contract functions (`toolsForRun` /
 * `executeToolForRun` in `executor.ts`) call these.
 */
export interface RunToolsDeps {
  db: Database;
  pubsub?: PubSub;
  /** The Tool Gateway the run's tools come from (a mission task's: the mission tools' own gateway). */
  tools?: ToolGateway | null;
}

/** A tool call's result for the bridge: the contract's `ToolResult` plus a stable error code. */
export interface BridgeCallResult {
  result: ToolResult;
  code?: string;
}

/** Where a run's events and cards go. */
export interface RunWhere {
  channelId: string;
  threadId: string | null;
  agentId: string;
  runId: string;
}

/** Where a run's events and cards go (`replyThreadOf`). */
export function runWhere(
  run: Pick<AgentRun, "id" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId">,
): RunWhere {
  return { channelId: run.channelId, threadId: replyThreadOf(run), agentId: run.agentId, runId: run.id };
}

/**
 * A body the server writes for an agent message (approval and secret cards,
 * closing lines): its code and params, so the app shows it in the person's
 * language (`chat.body.{code}`); the English body is the fallback.
 */
export const bodyCode = (code: string, params: Record<string, string> = {}) => ({
  bodyCode: code,
  bodyParams: params,
});

/**
 * A tool as a brain receives it (the model loop and the bridge alike). A tool that asks a person (an
 * approval, `ask_user`) takes the required `why` its card shows: the gateway's list already adds it,
 * and this keeps it so for any list that reaches a brain.
 */
export const brainToolOf = (t: ToolDefinition): BrainTool => ({
  name: t.name,
  description: t.description,
  inputSchema:
    isSensitive(t) || (t.name === ASK_USER_TOOL && t.scope === "" && !t.connectionId)
      ? withWhy(t.inputSchema)
      : t.inputSchema,
});

// ── Side effects of tools ────────────────────────────────────────────────────

/** What tools leave for the next message the run posts (cards), and how it ends (`react`, a GIF or a sticker). */
export interface ToolSideEffects {
  /** Memory changes, for the "memory updated" card (`meta.memoryUpdates`). */
  memoryUpdates?: MemoryUpdate[];
  /** Artifacts created or changed (`meta.artifacts`). */
  artifacts?: ArtifactLink[];
  /** A mission proposed with its home elsewhere: its link card (`meta.missionLink`). */
  missionLink?: { missionId: string; threadId: string } | null;
  /** The agent reacted (`react`) instead of replying. */
  reacted?: boolean;
  /** It sent a GIF or its sticker (`send_gif`, `send_sticker`, ADR 0091): an empty final reply posts nothing. */
  mediaSent?: boolean;
  /** A mission `report` card was posted: it is the answer, an empty final reply posts nothing. */
  reported?: boolean;
  /** Nobody called it by name and it called `pass` (reply-policy.ts): the run ends without a message. */
  passed?: { reason: string };
  /** The GitHub repository the run last worked in (`owner/name`), for "Trabalhando em" and Atividade. */
  repo?: string;
  /** A GitHub repository the run was refused (not in the agent's list): Atividade offers to add it. */
  deniedRepo?: string;
  /** Its browser calls since the last post, for the card of where it browsed (`meta.browser`). */
  browser?: BrowserTrailStep[];
  /** Its desktop calls since the last post (`meta.desktop`, ADR 0062), the same shape: the app an open started. */
  desktop?: BrowserTrailStep[];
  /** Tasks the right hand handed to an agent (`create_issue`), shown as chips on its reply (`meta.tasks`). */
  tasks?: HandedTask[];
  /** A report it offered about the app (`offer_feedback`, ADR 0160 §12), for its next reply (`meta.feedbackOffer`). */
  feedbackOffer?: PendingFeedbackOffer;
}

/** A task handed on, as a reply's chip reads it: the task, its agent and its conversation's root (the thread). */
export interface HandedTask {
  issueId: string;
  number: number;
  title: string;
  agentId: string;
  channelId: string;
  rootId: string;
}

/**
 * One call in the agent's browser (ADR 0040), as the chat keeps it after the run: the tool, the
 * site of an open (never the query string, `toolDetail`) and when. Nothing of the page itself.
 */
export interface BrowserTrailStep {
  tool: string;
  detail?: string;
  at: string;
  failed?: true;
  /** It ran in a shared browser profile (ADR 0110): its id and its name then (a renamed one still reads). */
  profileId?: string;
  profileName?: string;
}

/** The most browser steps one message keeps (the latest ones); as many desktop steps. */
export const BROWSER_TRAIL_MAX = 200;

/** The screens whose calls a message keeps as a trail, by their tools' prefix. */
type TrailScreen = "browser" | "desktop";

/** A plan's result carries its steps (`browserTrail`, `desktopTrail`): the plan call itself isn't one. */
const TRAIL_DATA: Record<TrailScreen, { data: string; plan: string }> = {
  browser: { data: "browserTrail", plan: "browser_do" },
  desktop: { data: "desktopTrail", plan: "desktop_do" },
};

/** A computer brain's call carries the bridge's prefix (`mcp__agentes__browser_open`); the screen whose trail it joins. */
const screenTool = (name: string): { tool: string; screen: TrailScreen } | null => {
  const tool = name.replace(HARNESS_PREFIX, "");
  if (tool.startsWith("browser_")) return { tool, screen: "browser" };
  if (tool.startsWith("desktop_")) return { tool, screen: "desktop" };
  return null;
};

const withTrail = (list: BrowserTrailStep[] | undefined, more: BrowserTrailStep[]) =>
  [...(list ?? []), ...more].slice(-BROWSER_TRAIL_MAX);

/**
 * Adds a browser or desktop call to `t`'s trail of that screen; any other tool
 * leaves it as it is. A plan (`browser_do`, `desktop_do`) isn't one step: its
 * steps come in its result (`absorbToolData`), each as the tool it stands for.
 */
export function absorbBrowserCall(
  t: ToolSideEffects,
  call: { name: string; input: unknown },
  failed: boolean,
  at = new Date(),
) {
  const found = screenTool(call.name);
  // A plan's steps come in its result; the profile switch is no step on the page.
  if (!found || found.tool === TRAIL_DATA[found.screen].plan || found.tool === "browser_profile") return;
  const { tool, screen } = found;
  const detail = toolDetail(tool, call.input as Record<string, unknown> | undefined);
  t[screen] = withTrail(t[screen], [
    { tool, ...(detail ? { detail } : {}), at: at.toISOString(), ...(failed ? { failed: true as const } : {}) },
  ]);
}

/**
 * A file on the reply (`meta.artifacts`), with its title: the agent reads its own message's files by name and id in
 * the conversation (context.ts `ownFilesNote`), from the meta written at post time, so "send it to Ana" finds that
 * file instead of a search. People's attachments carry the same shape (`attachmentRefsFor` in messages.ts).
 */
export type ArtifactLink = { id: string; version: number; title: string };

/** Adds files to the reply's cards: one per file, its newest version in the first one's place. */
function withArtifacts(list: ArtifactLink[] | undefined, more: ArtifactLink[]): ArtifactLink[] {
  const out = [...(list ?? [])];
  for (const a of more) {
    const i = out.findIndex((x) => x.id === a.id);
    if (i < 0) out.push(a);
    else if (a.version >= (out[i] as ArtifactLink).version) out[i] = a;
  }
  return out;
}

/**
 * Moves what a tool returned (`output.data`) onto `t`. Returns the memory
 * update, if any, for the caller to announce (`memory.updated`).
 */
export function absorbToolData(t: ToolSideEffects, data: Record<string, unknown> | undefined): MemoryUpdate | null {
  if (!data) return null;
  const artifact = data.artifact as ArtifactLink | undefined;
  if (artifact) t.artifacts = withArtifacts(t.artifacts, [artifact]);
  const link = data.missionLink as { missionId: string; threadId: string } | undefined;
  if (link?.missionId && link.threadId) t.missionLink = link;
  if (data.reacted) t.reacted = true;
  if (data.mediaSent) t.mediaSent = true;
  if (data.reported) t.reported = true;
  const passed = data.passed as { reason?: unknown } | undefined;
  if (passed) t.passed = { reason: typeof passed.reason === "string" ? passed.reason : "" };
  if (typeof data.repo === "string") t.repo = data.repo;
  if (typeof data.deniedRepo === "string") t.deniedRepo = data.deniedRepo;
  const at = new Date().toISOString();
  for (const screen of ["browser", "desktop"] as const) {
    const list = data[TRAIL_DATA[screen].data];
    if (!Array.isArray(list)) continue;
    const steps = list.flatMap((s): BrowserTrailStep[] => {
      const step = s as { tool?: unknown; detail?: unknown; failed?: unknown };
      if (typeof step.tool !== "string" || !step.tool.startsWith(`${screen}_`)) return [];
      return [
        {
          tool: step.tool,
          ...(typeof step.detail === "string" ? { detail: step.detail } : {}),
          at,
          ...(step.failed === true ? { failed: true as const } : {}),
        },
      ];
    });
    if (steps.length > 0) t[screen] = withTrail(t[screen], steps);
  }
  // The call ran in a profile: its steps (a plan's, else the call's own, absorbed just before) say which.
  const profile = data.browserProfile as { id?: unknown; name?: unknown } | undefined;
  if (profile && typeof profile.id === "string" && typeof profile.name === "string" && t.browser?.length) {
    const planned = Array.isArray(data.browserTrail) ? data.browserTrail.length : 1;
    for (const step of t.browser.slice(-Math.max(1, planned))) {
      step.profileId = profile.id;
      step.profileName = profile.name;
    }
  }
  const task = data.handedTask as HandedTask | undefined;
  if (task && typeof task.issueId === "string" && typeof task.rootId === "string")
    t.tasks = [...(t.tasks ?? []).filter((x) => x.issueId !== task.issueId), task];
  const offer = pendingFeedbackOfferOf(data.feedbackOffer);
  if (offer) t.feedbackOffer = offer;
  const update = data.memoryUpdate as MemoryUpdate | undefined;
  if (update) t.memoryUpdates = [...(t.memoryUpdates ?? []), update];
  return update ?? null;
}

/** Adds side effects gathered elsewhere (the bridge's) onto `t`. */
export function mergeToolEffects(t: ToolSideEffects, e: ToolSideEffects | null | undefined) {
  if (!e) return;
  if (e.artifacts?.length) t.artifacts = withArtifacts(t.artifacts, e.artifacts);
  if (e.memoryUpdates?.length) t.memoryUpdates = [...(t.memoryUpdates ?? []), ...e.memoryUpdates];
  if (e.missionLink) t.missionLink = e.missionLink;
  if (e.reacted) t.reacted = true;
  if (e.mediaSent) t.mediaSent = true;
  if (e.reported) t.reported = true;
  if (e.passed) t.passed = e.passed;
  if (e.repo) t.repo = e.repo;
  if (e.deniedRepo) t.deniedRepo = e.deniedRepo;
  if (e.browser?.length) t.browser = withTrail(t.browser, e.browser);
  if (e.desktop?.length) t.desktop = withTrail(t.desktop, e.desktop);
  if (e.tasks?.length) t.tasks = [...(t.tasks ?? []), ...e.tasks];
  if (e.feedbackOffer) t.feedbackOffer = e.feedbackOffer;
}

const hasEffects = (e: ToolSideEffects) =>
  Boolean(
    e.artifacts?.length ||
      e.memoryUpdates?.length ||
      e.missionLink ||
      e.reacted ||
      e.mediaSent ||
      e.reported ||
      e.passed ||
      e.repo ||
      e.deniedRepo ||
      e.browser?.length ||
      e.desktop?.length ||
      e.tasks?.length ||
      e.feedbackOffer,
  );

/** The transcript key where the bridge leaves a computer-brain turn's side effects for the engine. */
const BRIDGE_EFFECTS = "bridgeEffects";

/**
 * A bridged call's side effects (a computer brain's tool through the runner
 * bridge): kept on the run (`transcript.bridgeEffects`) until the engine ends
 * the turn and takes them (`takeBridgeEffects`), exactly as the loop keeps its
 * own (`absorbToolData`): the reply carries the cards, and a `react` closes the
 * turn silently. The memory update is announced now.
 */
async function recordBridgeEffects(
  deps: RunToolsDeps,
  run: AgentRun,
  where: RunWhere,
  call: { name: string; input: unknown },
  outcome: InvokeResult,
) {
  const effects: ToolSideEffects = {};
  absorbBrowserCall(effects, call, outcome.type === "result" && outcome.output.isError === true);
  const update = outcome.type === "result" ? absorbToolData(effects, outcome.output.data) : null;
  if (!hasEffects(effects)) return;
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
      .for("update");
    // No transcript: the engine never ran this run (it builds one before a computer turn), nothing to keep.
    const t = row?.transcript as Record<string, unknown> | null | undefined;
    if (!t) return;
    const kept = { ...((t[BRIDGE_EFFECTS] ?? {}) as ToolSideEffects) };
    mergeToolEffects(kept, effects);
    await tx
      .update(agentRuns)
      .set({ transcript: { ...t, [BRIDGE_EFFECTS]: kept }, updatedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
  });
  if (update) await publishChannelEvent(deps.pubsub, { type: "memory.updated", ...where, update });
}

/**
 * The run's transcript to store from the engine's own copy. The bridge keeps a
 * computer brain's side effects on the row (`bridgeEffects`) while the engine
 * holds that copy, so a save never writes the key from memory: a stale copy
 * would bring files it already took back (the same file twice on the reply) or
 * drop ones kept since. The row's value stays as it is.
 */
export function storedTranscript(t: object): SQL {
  const { [BRIDGE_EFFECTS]: _kept, ...rest } = t as Record<string, unknown>;
  return sql`(${pgSafeStringify(rest)}::jsonb || jsonb_strip_nulls(jsonb_build_object(${BRIDGE_EFFECTS}::text, ${agentRuns.transcript} -> ${BRIDGE_EFFECTS}::text)))`;
}

/** Takes (and clears) the side effects the bridge kept for this run (`recordBridgeEffects`). */
export async function takeBridgeEffects(db: Database, runId: string): Promise<ToolSideEffects | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    const t = row?.transcript as Record<string, unknown> | null | undefined;
    const kept = t?.[BRIDGE_EFFECTS] as ToolSideEffects | undefined;
    if (!t || !kept) return null;
    const { [BRIDGE_EFFECTS]: _taken, ...rest } = t;
    await tx.update(agentRuns).set({ transcript: rest, updatedAt: new Date() }).where(eq(agentRuns.id, runId));
    return kept;
  });
}

// ── Calls ────────────────────────────────────────────────────────────────────

/** What `invokeWithChip` needs: the run's tool context, where its events go and the tools of this turn. */
export interface RunToolScope {
  /** `judge`: checks an agent's own status line against its step (ADR 0084 §10); none, no check. */
  deps: { db: Database; pubsub?: PubSub; judge?: Judge | null };
  tools: ToolGateway;
  ctx: ToolContext;
  where: RunWhere;
  /**
   * The run's tool list (for the connector label of the live tool chip).
   * Null when unknown (a bridge call): the chip shows only the tool's name.
   */
  turnTools: ToolDefinition[] | null;
}

/** How a call ended, as its `agent.tool` end says it. */
type ChipEnd = {
  failed?: boolean;
  slip?: boolean;
  held?: boolean;
  why?: string;
  refusal?: string;
  requestId?: string;
  autoApproved?: { by: string | null; reads: boolean };
};

/** The end's fields that say something. */
const endFields = (end: ChipEnd) => ({
  ...(end.failed ? { failed: true } : {}),
  ...(end.slip ? { slip: true } : {}),
  ...(end.held ? { held: true } : {}),
  ...(end.why ? { why: end.why } : {}),
  ...(end.refusal ? { refusal: end.refusal } : {}),
  ...(end.requestId ? { requestId: end.requestId } : {}),
  ...(end.autoApproved ? { autoApproved: end.autoApproved } : {}),
});

/** The Tool Gateway's own refusal of a call (`data.refusal`), for the apps' words under its line. */
const gatewayRefusal = (output: ToolOutput): Pick<ChipEnd, "refusal"> =>
  output.isError && typeof output.data?.refusal === "string" ? { refusal: output.data.refusal.slice(0, 40) } : {};

/**
 * A permission check's end as the chat shows it: refused (the policy's own reason, and its code for the apps'
 * words), waiting on a person (its request, which the person's answer names), or allowed. Only a `deny` carries
 * its words: an error's text could hold anything.
 */
function promptEnd(output: ToolOutput): ChipEnd {
  if (output.isError) return { failed: true };
  const answer = promptAnswer(output.content);
  const why = typeof answer.message === "string" ? answer.message.slice(0, 500) : "";
  const refusal = typeof answer.code === "string" ? answer.code.slice(0, 40) : "";
  if (answer.behavior === "deny") return { failed: true, why, refusal };
  if (answer.status !== "pending") return {};
  return { held: true, ...(typeof answer.request_id === "string" ? { requestId: answer.request_id } : {}) };
}

/**
 * One tool call through the Tool Gateway, with the live tool chip
 * (`agent.tool` before and after). The gateway checks the scope, validates the
 * input, records the steps and gates sensitive calls (approval / question /
 * secret outcomes).
 */
export async function invokeWithChip(
  scope: RunToolScope,
  use: { id: string; name: string; input: unknown },
): Promise<InvokeResult> {
  const { deps, ctx, where } = scope;
  const input = use.input as Record<string, unknown> | undefined;
  const call = { toolUseId: use.id, name: use.name, input: input ?? {} };
  // The runner asking again about a command that waits on a person: no line of its own, the first ask has one,
  // and the person's answer, once there, ends that line (by its request).
  if (promptPoll(use.name, input)) {
    const outcome = await scope.tools.invoke(ctx, call);
    const end = outcome.type === "result" ? promptEnd(outcome.output) : { held: true };
    if (!end.held) {
      const requestId = String(input?.request_id);
      await publishChannelEvent(deps.pubsub, {
        type: "agent.tool",
        ...where,
        tool: null,
        ...endFields(end),
        requestId,
      });
    }
    return outcome;
  }
  const listed = scope.turnTools?.find((t) => t.name === use.name);
  // Through a big connector's directory: the chip shows the real tool (`use_tool` only points at it).
  const role = directoryRole(listed);
  const target =
    role?.kind === "use" && typeof (use.input as { tool?: unknown } | undefined)?.tool === "string"
      ? resolveDirectoryTool(role, String((use.input as { tool: string }).tool))
      : undefined;
  const def = target ?? listed;
  // The bridge has no turn list (`turnTools: null`): the name the model gave is the best label there.
  const givenTool = (use.input as { tool?: unknown } | undefined)?.tool;
  const shownName =
    target?.name ??
    (!listed && (use.name === ON_DEMAND_USE || use.name.endsWith("_use_tool")) && typeof givenTool === "string"
      ? givenTool
      : use.name);
  const connector = def?.connectorLabel;
  // A short label for the UI (skill, issue, file); built-in tools only, never connector inputs.
  const builtIn = scope.turnTools !== null && !(connector || def?.connectionId);
  // The agent's browser and desktop are ours on every brain (a computer brain's open names its site too), and so
  // is the computer's permission check, which only exists on the bridge: its line says the command it checked.
  const screen = screenTool(use.name)?.tool;
  const prompt = use.name === PERMISSION_TOOL;
  const detail = screen
    ? toolDetail(screen, input)
    : prompt
      ? toolDetail(use.name, input)
      : builtIn
        ? (toolDetail(use.name, input) ??
          (await artifactToolDetail(deps.db, ctx.orgId, ctx.channelId, use.name, input).catch(() => undefined)))
        : undefined;
  const code = builtIn ? toolCode(use.name, input) : undefined;
  const command = toolCommand(use.name, input);
  // The agent's line follows what it does now (ADR 0084 §10), beside the call, never in its way.
  if (def) void followWork(deps, ctx, def).catch(() => {});
  const said = takeStepWords(where.runId);
  await publishChannelEvent(deps.pubsub, {
    type: "agent.tool",
    ...where,
    tool: shownName,
    ...(said ? { said } : {}),
    ...(connector ? { connector } : {}),
    ...(def?.service ? { service: def.service } : {}),
    ...(def?.serviceIcon ? { serviceIcon: def.serviceIcon } : {}),
    ...(detail ? { detail } : {}),
    toolUseId: use.id,
    ...(code ? { code } : {}),
    ...(command ? { command } : {}),
  });
  // The end names its call and whether the tool answered with an error, or didn't run because it waits on a
  // person (an approval, a question, a secret): the chat marks that line.
  const ended = (end: ChipEnd) =>
    publishChannelEvent(deps.pubsub, {
      type: "agent.tool",
      ...where,
      tool: null,
      toolUseId: use.id,
      ...endFields(end),
    });
  return scope.tools.invoke(ctx, call).then(
    async (outcome) => {
      await ended(
        outcome.type !== "result"
          ? { held: true }
          : prompt
            ? promptEnd(outcome.output)
            : {
                failed: outcome.output.isError === true,
                slip: outcome.output.isError === true && codeOf(outcome.output.content) === "tool.invalid_input",
                ...gatewayRefusal(outcome.output),
                autoApproved: outcome.autoApproved,
              },
      );
      // An action approved ahead went out (or couldn't): its cards, Aprovações and its routine's page show it.
      if (outcome.type === "result" && outcome.ran && deps.pubsub) {
        await publishApproval({ db: deps.db, pubsub: deps.pubsub }, outcome.ran, "approval.decided").catch(() => {});
      }
      return outcome;
    },
    async (error: unknown) => {
      await ended({ failed: true });
      throw error;
    },
  );
}

type Located = { ctx: ToolContext; run: AgentRun | null };

/**
 * The tool context of an identity. A run: its row (org and agent must match).
 * A mission task (`taskId`): the task's channel and thread, no run (the
 * gateway records no steps), marked as the task's bridge call.
 */
async function locate(db: Database, id: BridgeIdentity): Promise<Located> {
  if (id.taskId) {
    const [task] = await db
      .select()
      .from(machineTasks)
      .where(
        and(eq(machineTasks.id, id.taskId), eq(machineTasks.orgId, id.orgId), eq(machineTasks.agentId, id.agentId)),
      );
    if (!task) throw new NotFoundError("Task not found");
    return {
      run: null,
      ctx: {
        db,
        orgId: task.orgId,
        agentId: task.agentId,
        runId: "",
        channelId: task.channelId,
        threadRootId: task.threadRootId ?? "",
        triggerMessageId: "",
        bridge: { machineId: id.machineId, taskId: task.id },
      },
    };
  }
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, id.runId), eq(agentRuns.orgId, id.orgId), eq(agentRuns.agentId, id.agentId)));
  if (!run) throw new NotFoundError("Run not found");
  return {
    run,
    ctx: {
      db,
      orgId: run.orgId,
      agentId: run.agentId,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
      ...(id.machineId ? { bridge: { machineId: id.machineId } } : {}),
      // Tools on demand (ADR 0043): the same list the run's turns see.
      loadedGroups: loadedGroupsOf(run.transcript),
      ...(run.background ? { background: true } : {}),
    },
  };
}

/** The tool groups a run listed up front (`Transcript.toolGroups`, ADR 0043); null = every tool. */
const loadedGroupsOf = (transcript: unknown): string[] | null => {
  const groups = (transcript as { toolGroups?: unknown } | null)?.toolGroups;
  return Array.isArray(groups) ? groups.filter((g): g is string => typeof g === "string") : null;
};

/**
 * The tools of a bridge identity, as `BrainTool[]`: a run's (the Tool Gateway
 * list with its scopes, mission tools when in a mission thread) or a mission
 * task's (its own gateway). `machineId` marks the context as a bridge call.
 * The run's policy applies as for the model loop (`run-policy.ts`): a tool the
 * run may not use isn't listed, and every call is checked again.
 */
export async function bridgeToolsFor(deps: RunToolsDeps, id: BridgeIdentity): Promise<BrainTool[]> {
  if (!deps.tools) return [];
  const { ctx, run } = await locate(deps.db, id);
  const tools = await deps.tools.list(ctx);
  // Our own tools before the connectors': a cap on the list (`MCP_TOOLS_MAX`) only ever drops connector tools.
  const ordered = [...tools.filter((t) => !t.connectionId), ...tools.filter((t) => t.connectionId)];
  const authority = run ? await runAuthorityById(deps.db, run.orgId, run.id) : null;
  if (!(authority?.kind === "routine" && authority.brief?.widget)) return ordered.map(brainToolOf);
  // A widget's refresh (ADR 0135 §5): what it reads with and answers through, in hand from the first round.
  let room = WIDGET_UP_FRONT_MAX;
  return ordered.map((t) => (widgetUpFront(t) && room-- > 0 ? { ...brainToolOf(t), upFront: true } : brainToolOf(t)));
}

/** The gateway's own refusals, as codes (the gateway returns them as plain error text). */
function codeOf(content: string, data?: Record<string, unknown>) {
  if (typeof data?.code === "string") return data.code;
  if (content.startsWith("Invalid input:")) return "tool.invalid_input";
  if (content.startsWith("Unknown tool")) return "tool.unknown";
  if (content.startsWith("Not allowed:")) return "tool.not_allowed";
  return "tool.failed";
}

/**
 * One call for a run or a mission task from outside the engine loop (the
 * runner bridge, `executeToolForRun`), with the error code the bridge answers
 * with. Same path as the loop: the live tool chip where the run's replies go,
 * the Tool Gateway, the side effects kept for the engine's next post
 * (`recordBridgeEffects`), and a gated call (approval, `ask_user`,
 * `request_secret`, a mission tool's own wait) suspends the run
 * (`suspendRunForTool`). A mission task's tools are never gated (their waits
 * are the mission's own).
 */
export async function invokeToolForRun(
  deps: RunToolsDeps,
  id: BridgeIdentity,
  call: { id: string; name: string; input: unknown },
): Promise<BridgeCallResult> {
  const tools = deps.tools;
  if (!tools) return { result: { content: "No tools are available in this run.", isError: true }, code: "tool.none" };
  const { ctx, run } = await locate(deps.db, id);
  const input = (
    call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input : {}
  ) as Record<string, unknown>;
  const where = run ? runWhere(run) : null;
  const use = { id: call.id, name: call.name, input };
  const outcome = where
    ? await invokeWithChip({ deps, tools, ctx, where, turnTools: null }, use)
    : await tools.invoke(ctx, { toolUseId: call.id, name: call.name, input });
  if (run && where) await recordBridgeEffects(deps, run, where, use, outcome);
  const wait = outcome.type === "result" && !outcome.output.isError ? waitOf(outcome.output.data) : null;
  const suspend = async (pause: RunPause, r: AgentRun): Promise<BridgeCallResult> => {
    const result = await suspendRunForTool(deps, r, { id: call.id, name: call.name }, pause);
    return result.isError ? { result, code: "bridge.run_not_running" } : { result };
  };
  if (wait && run) {
    return suspend(
      { type: "wait", id: wait.id, content: outcome.type === "result" ? outcome.output.content : "" },
      run,
    );
  }
  if (outcome.type === "result") {
    const isError = outcome.output.isError === true;
    return {
      result: { content: outcome.output.content, ...(isError ? { isError: true } : {}) },
      ...(isError ? { code: codeOf(outcome.output.content, outcome.output.data) } : {}),
    };
  }
  if (!run) {
    return { result: { content: "This call can't wait for a person here.", isError: true }, code: "tool.not_allowed" };
  }
  return suspend(outcome, run);
}

/**
 * A mission tool's own wait (ADR 0032 §6): a blocking `ask_decision` or a
 * `request_review` on the engine returns `data.pause` with the decision's or
 * review's id; the run waits on it (`waiting_input`) and resumes with the
 * answer (`resumeRunWithResult`).
 */
export function waitOf(data: Record<string, unknown> | undefined): { id: string } | null {
  const pause = data?.pause as { kind?: unknown; id?: unknown } | undefined;
  return pause && typeof pause.id === "string" && pause.id ? { id: pause.id } : null;
}

/** A gated call the run pauses on: the gateway's (approval, question, secret) or a mission tool's wait. */
export type RunPause = Exclude<InvokeResult, { type: "result" }> | { type: "wait"; id: string; content: string };

// ── Pause cards ──────────────────────────────────────────────────────────────

/** What a run pauses on in one step: approvals, questions (`ask_user`) and secret requests (ADR 0027). */
export interface PauseRequests {
  approvals: Approval[];
  /** `why`: the agent's required reason (ADR 0053 §8), shown on the card. */
  questions: {
    id: string;
    toolUseId: string;
    text: string;
    choices: string[] | null;
    /** The person the agent said it is for; else `impliedAddressee` reads it from the run. */
    requestedForUserId?: string | null;
    why?: string;
  }[];
  secretRequestIds: string[];
}

/** The cards one pause posted (in the caller's transaction): `publishPauseCards` announces them after the commit. */
export interface PostedPause {
  messages: Message[];
  approvals: Approval[];
  questions: AgentQuestionRow[];
  secrets: SecretRequestRow[];
  /** Cards that took the run's receipts (`message.actions` goes out with them). */
  withReceipts: string[];
}

/** A run's trigger, as its messages and cards read it. */
export type RunTriggerRow = Pick<Message, "id" | "authorType" | "authorAgentId" | "meta">;

/** The trigger of a run (null when it is gone). */
export async function runTriggerOf(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "triggerMessageId">,
): Promise<RunTriggerRow | null> {
  const [row] = await db
    .select({
      id: messages.id,
      authorType: messages.authorType,
      authorAgentId: messages.authorAgentId,
      meta: messages.meta,
    })
    .from(messages)
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
  return row ?? null;
}

/**
 * What every message a run posts carries, on every brain: the routine that called it (`viaRoutine`, a
 * small tag, since the routine's own call isn't shown), whether the router brought it in after another
 * agent spoke (`joined`, ADR 0034) and the agent whose message it answers (`toAgent`: the apps fold a long
 * one to its first paragraph, the rest a click away, ADR 0034). Only a person-authored trigger is a routine's
 * call; an event the agent's own conversation got (`meta.notice`) is its own message, not another agent's.
 */
export function runMessageMeta(
  run: Pick<AgentRun, "trigger" | "agentId">,
  trigger: Pick<Message, "authorType" | "authorAgentId" | "meta"> | null | undefined,
): Record<string, unknown> {
  const call =
    trigger?.authorType === "person" ? (trigger.meta.routine as { id?: unknown; name?: unknown } | undefined) : null;
  const viaRoutine =
    call && typeof call.id === "string" && typeof call.name === "string" ? { id: call.id, name: call.name } : null;
  const joined = run.trigger === "router" && trigger?.authorType === "agent";
  const toAgent =
    trigger?.authorType === "agent" &&
    trigger.authorAgentId &&
    trigger.authorAgentId !== run.agentId &&
    !trigger.meta.notice
      ? trigger.authorAgentId
      : null;
  return {
    ...(viaRoutine ? { viaRoutine } : {}),
    ...(joined ? { joined: true } : {}),
    ...(toAgent ? { toAgent } : {}),
  };
}

/**
 * The one way a run's pause cards are posted (ADR 0053 §10), for the model loop and for a computer brain's
 * bridged call alike: same meta, same receipts. Cards go where the run replies; a routine's background run
 * posts them where it reports (`brief.deliverTo`), never in its room. Each approval card carries the agent's
 * `why` and where it came from (`origin`); a consulted agent's approvals, questions and secret requests go to
 * whoever asked (ADR 0034), and its question and secret rows with them: answered from there, they resume it.
 * Runs inside the caller's transaction; nothing is published here (`publishPauseCards`).
 */
export async function postPauseCards(tx: Executor, run: AgentRun, requests: PauseRequests): Promise<PostedPause> {
  const out: PostedPause = { messages: [], approvals: [], questions: [], secrets: [], withReceipts: [] };
  if (requests.approvals.length + requests.questions.length + requests.secretRequestIds.length === 0) return out;
  const trigger = await runTriggerOf(tx, run);
  const extra = runMessageMeta(run, trigger);
  const brief = run.background ? routineBriefOf(trigger?.meta) : null;
  const home = brief?.deliverTo ?? { channelId: run.channelId, threadId: replyThreadOf(run) };
  // A consulted run asks from the agents' DM, which no person reads: its questions and secret requests go where
  // the person behind it asked, like its approvals (the gateway already placed those). Only a DM run answers one.
  const origin =
    !brief && run.trigger === "dm" && requests.questions.length + requests.secretRequestIds.length > 0
      ? await consultationOrigin(tx, run.orgId, run.id)
      : null;
  const asked = origin ? { channelId: origin.channelId, threadId: origin.threadId } : home;
  const card = async (
    to: { channelId: string; threadId: string | null },
    body: string,
    meta: Record<string, unknown>,
  ): Promise<Message> => {
    const message = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: to.channelId,
      threadId: to.threadId,
      author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
      body,
      meta: { ...meta, ...extra },
    });
    // Act with undo (ADR 0037): what the run changed so far rides on its first message (its receipts).
    if ((await linkRunActions(tx, run.orgId, run.id, message.id)) > 0) out.withReceipts.push(message.id);
    out.messages.push(message);
    return message;
  };

  const [asker] =
    requests.secretRequestIds.length > 0
      ? await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, run.agentId))
      : [];
  const agentName = asker?.name ?? "An agent";
  for (const requestId of requests.secretRequestIds) {
    const [request] = await tx
      .update(secretRequests)
      .set({ threadId: asked.threadId, ...(brief || origin ? { channelId: asked.channelId } : {}) })
      // One card per request: a second call that waits on the same open one (`requestSecretTool`) posts none.
      .where(and(eq(secretRequests.id, requestId), isNull(secretRequests.messageId)))
      .returning();
    if (!request) continue;
    // The card names the key itself: this text is for previews and notifications, a sentence of its own.
    const what = secretLabelOf(request);
    const message = await card(asked, `${agentName} asked for a key: ${what}`, {
      ...bodyCode("secret_request", { agent: agentName, name: what }),
      secretRequestId: request.id,
      secretRequest: secretRequestView(request),
    });
    const [linked] = await tx
      .update(secretRequests)
      .set({ messageId: message.id })
      .where(eq(secretRequests.id, request.id))
      .returning();
    if (linked) {
      await syncSecretMessage(tx, linked);
      message.meta = { ...message.meta, secretRequest: secretRequestView(linked) };
      out.secrets.push(linked);
    }
  }

  // A work's question names no one: it is its asker's, or another person's answer would move it on their access.
  const [work] = run.workId
    ? await tx.select({ asker: agentWorks.requestedByUserId }).from(agentWorks).where(eq(agentWorks.id, run.workId))
    : [];
  // Someone who can't read where the card goes could never answer it: it waits on the room instead.
  const reader = async (userId: string | null | undefined) =>
    userId && (await readableChannelIds(tx, run.orgId, userId, [asked.channelId])).size > 0 ? userId : null;
  for (const ask of requests.questions) {
    const requestedForUserId =
      (await reader(ask.requestedForUserId)) ??
      (await impliedAddressee(tx, run, asked, ask.text)) ??
      (await reader(work?.asker));
    const [inserted] = await tx
      .insert(agentQuestions)
      .values({
        id: ask.id,
        orgId: run.orgId,
        runId: run.id,
        agentId: run.agentId,
        // Whoever can read that conversation may answer it, unless it is for one person (`answerQuestion`).
        channelId: asked.channelId,
        threadId: asked.threadId,
        toolUseId: ask.toolUseId,
        text: ask.text,
        choices: ask.choices,
        requestedForUserId,
        expiresAt: new Date(Date.now() + QUESTION_TTL_MS),
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) continue;
    const message = await card(asked, ask.text, questionCardMeta(inserted, ask.why ?? ""));
    const [linked] = await tx
      .update(agentQuestions)
      .set({ messageId: message.id })
      .where(eq(agentQuestions.id, ask.id))
      .returning();
    if (linked) {
      await syncQuestionMessage(tx, linked);
      message.meta = { ...message.meta, question: questionView(linked) };
      out.questions.push(linked);
    }
  }

  for (const approval of requests.approvals) {
    const meta = {
      ...bodyCode("approval_request", { title: approval.title }),
      approvalId: approval.id,
      ...(approval.why ? { why: approval.why } : {}),
      ...(approval.origin ? { origin: approval.origin } : {}),
    };
    const to =
      !brief && approval.channelId !== run.channelId
        ? {
            channelId: approval.channelId,
            threadId: await consultationCardThread(tx, run.orgId, run.id, approval.threadRootId),
          }
        : home;
    // Several requests of the agent in one conversation share one card: this one joins it, live.
    const joined = await openApprovalCard(tx, {
      orgId: run.orgId,
      agentId: run.agentId,
      channelId: to.channelId,
      threadId: to.threadId,
      threadRootId: approval.threadRootId,
      exceptId: approval.id,
    });
    if (joined && (await linkRunActions(tx, run.orgId, run.id, joined)) > 0) out.withReceipts.push(joined);
    const messageId = joined ?? (await card(to, `Approval request: ${approval.title}`, meta)).id;
    const [linked] = await tx
      .update(approvals)
      .set({
        messageId,
        // A routine's approval lives where its card is: decided, announced and listed there.
        ...(brief ? { channelId: home.channelId, threadRootId: home.threadId ?? messageId } : {}),
      })
      .where(eq(approvals.id, approval.id))
      .returning();
    out.approvals.push(linked ?? approval);
  }
  return out;
}

/** After the commit: the cards show up with their receipts, and who decides or answers hears them. */
export async function publishPauseCards(deps: { db: Database; pubsub?: PubSub }, run: AgentRun, posted: PostedPause) {
  const { db, pubsub } = deps;
  if (pubsub) {
    for (const m of await withWikiLinks(db, run.orgId, posted.messages.map(messageView))) {
      await publishMessageCreated(pubsub, m);
    }
  }
  for (const id of posted.withReceipts) await publishMessageActions(deps, run.orgId, id).catch(() => {});
  if (pubsub) {
    for (const card of posted.approvals) {
      await publishApproval({ db, pubsub }, card, "approval.created");
      // A mission's approval (agent mode): its owner hears it waits.
      if (card.missionId) await notifyMissionApproval({ db, pubsub }, card).catch(() => undefined);
    }
  }
  for (const q of posted.questions) {
    await publishQuestion(pubsub, q, "question.asked");
    await notifyQuestion({ db, pubsub } as Parameters<typeof notifyQuestion>[0], q).catch(() => {});
  }
  for (const r of posted.secrets) await publishSecret({ db, pubsub }, r, "secret.requested");
}

/**
 * A computer brain's gated call (through the bridge) pauses the run exactly
 * like the model path does: the cards are posted by the same function
 * (`postPauseCards`), the call joins the transcript's pending calls, and the
 * run moves to `waiting_approval` / `waiting_input`. On the decision the
 * engine resumes the run, and the brain session gets the result
 * ("approved: …" / "refused: …").
 *
 * The run row is locked first and its state decides before anything is
 * posted: `running` → it suspends; already waiting on a call bridged in this
 * turn (two gated calls at once) → this call joins the pending calls; anything
 * else (ended, canceled, waiting for its computer) → nothing is posted, the
 * gated request is canceled and the brain reads an error.
 *
 * Returns the `ToolResult` the brain reads: stop and end the turn.
 */
export async function suspendRunForTool(
  deps: RunToolsDeps,
  run: AgentRun,
  call: { id: string; name: string },
  gated: RunPause,
): Promise<ToolResult> {
  const { db } = deps;
  const where = runWhere(run);
  const wanted = gated.type === "approval" ? "waiting_approval" : "waiting_input";
  const questionId = gated.type === "question" ? Bun.randomUUIDv7() : null;

  const posted = await db.transaction(async (tx) => {
    // Lock and decide first: the card is posted only when the pending call is kept too.
    const [locked] = await tx
      .select({ status: agentRuns.status, transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
      .for("update");
    const transcript = locked?.transcript as
      | (Record<string, unknown> & {
          pending?: { calls: Record<string, unknown>[] };
          postedCount?: number;
          waitingForBrain?: unknown;
        })
      | null
      | undefined;
    const joinsPause =
      (locked?.status === "waiting_approval" || locked?.status === "waiting_input") &&
      !transcript?.waitingForBrain &&
      (transcript?.pending?.calls ?? []).some((c) => c.bridged === true);
    if (!locked || (locked.status !== "running" && !joinsPause)) {
      // Nothing waits on it: the request the gateway made is canceled, nothing is posted.
      if (gated.type === "approval") {
        await tx
          .update(approvals)
          .set({ status: "canceled", decidedAt: new Date() })
          .where(and(eq(approvals.id, gated.approval.id), eq(approvals.status, "pending")));
      } else if (gated.type === "secret") {
        await tx
          .update(secretRequests)
          .set({ status: "canceled" })
          .where(and(eq(secretRequests.id, gated.requestId), eq(secretRequests.status, "pending")));
      }
      return null;
    }
    const pause = await postPauseCards(tx, run, {
      approvals: gated.type === "approval" ? [gated.approval] : [],
      questions:
        gated.type === "question" && questionId
          ? [
              {
                id: questionId,
                toolUseId: call.id,
                text: gated.text,
                choices: gated.choices,
                requestedForUserId: gated.requestedForUserId,
                why: gated.why,
              },
            ]
          : [],
      secretRequestIds: gated.type === "secret" ? [gated.requestId] : [],
    });
    // The engine's resume reads the pending calls from the transcript.
    const pendingCall = {
      toolUseId: call.id,
      name: call.name,
      // Its tool_use lives in the computer brain's session, not in the transcript: resumed as text.
      bridged: true,
      // Asked in a turn still running: a decision before it ends resumes the run only once it ends.
      inTurn: true,
      ...(gated.type === "approval" ? { approvalId: gated.approval.id } : {}),
      ...(questionId ? { questionId, askedAt: Date.now() } : {}),
      ...(gated.type === "secret" ? { secretRequestId: gated.requestId } : {}),
      ...(gated.type === "wait" ? { waitId: gated.id } : {}),
    };
    // Waiting on an answer as well as an approval: the run waits for input (the resume checks every call).
    const status: "waiting_approval" | "waiting_input" =
      locked.status === "waiting_input" || wanted === "waiting_input" ? "waiting_input" : wanted;
    await tx
      .update(agentRuns)
      .set({
        status,
        updatedAt: new Date(),
        // Without a transcript (never executed by the engine) there is nothing to resume from: state only.
        ...(transcript
          ? {
              transcript: {
                ...transcript,
                postedCount: (transcript.postedCount ?? 0) + pause.messages.length,
                pending: { calls: [...(transcript.pending?.calls ?? []), pendingCall] },
              },
            }
          : {}),
      })
      .where(
        and(eq(agentRuns.id, run.id), inArray(agentRuns.status, ["running", "waiting_approval", "waiting_input"])),
      );
    return { pause, status, changed: locked.status !== status };
  });

  if (!posted) {
    return {
      content: "This run isn't running anymore, so nothing was asked. Stop now and end your turn.",
      isError: true,
    };
  }
  await publishPauseCards(deps, run, posted.pause);
  if (posted.changed) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.run",
      ...where,
      status: posted.status,
      ...(run.background ? { background: true as const } : {}),
    });
  }

  if (gated.type === "approval") {
    return {
      content: `Waiting for a person to approve: ${gated.approval.title}. Stop now and end your turn; you'll be resumed with the decision.`,
      pause: { kind: "approval", id: gated.approval.id },
    };
  }
  if (gated.type === "secret") {
    return {
      content: "Waiting for a person to provide the secret. Stop now and end your turn; you'll be resumed.",
      pause: { kind: "input", id: gated.requestId },
    };
  }
  if (gated.type === "wait") {
    return {
      content: `${gated.content} Stop now and end your turn; you'll be resumed with the answer.`.trim(),
      pause: { kind: "input", id: gated.id },
    };
  }
  return {
    content: `Asked: ${gated.text} The person sees it as a card. Stop now and end your turn without writing anything more (don't repeat the question); you'll be resumed with the answer.`,
    pause: { kind: "input", id: questionId ?? call.id },
  };
}

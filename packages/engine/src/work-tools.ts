import type { PubSub } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { runAuthority } from "./authority";
import { cancelRun } from "./cancel";
import { andList } from "./format";
import { listsEveryTool } from "./tools/directory";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";
import {
  cleanPlan,
  liveWorksHere,
  moveToBackground,
  POST_UPDATE_TOOL,
  postWorkUpdate,
  STEER_WORK_TOOL,
  STOP_WORK_TOOL,
  steerWork,
  WORK_IN_BACKGROUND_TOOL,
  WORK_LIMITS,
  workEligible,
  workRunId,
} from "./works";

const { agentRuns } = schema;

const refused = (content: string): ToolOutput => ({ content, isError: true });

/** What the run reads once it is background work: the same words on every brain (§0). */
export const movedNote = (minutes: number) =>
  `This is now background work (people were told). Keep going. Post short progress with ${POST_UPDATE_TOOL}; your next update is due in ~${minutes} min. Your final message is your report: the result, what you checked, what is left.`;

export const queuedNote =
  "This is now background work (people were told), but it waits in line: enough of your work is already running. Stop here without a reply; you'll be resumed here by yourself when it starts.";

/** What a work that waited in line reads when its turn comes. */
export const workStartsNote = `Your background work's turn came: go on with it now. Post short progress with ${POST_UPDATE_TOOL}; your final message is your report.`;

const planSchema = {
  type: "array",
  maxItems: WORK_LIMITS.planMax,
  description: "Your plan as steps; resend the whole list to change it.",
  items: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 140 },
      state: { type: "string", enum: ["todo", "doing", "done"] },
    },
    required: ["text"],
    additionalProperties: false,
  },
} as const;

async function runOf(ctx: ToolContext) {
  if (!ctx.runId || ctx.background || ctx.bridge?.taskId) return null;
  const [run] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.agentId, ctx.agentId)));
  return run && !run.background ? run : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Whether the run may move to the background now (`work_in_background` would take it). */
export async function workMayStart(ctx: ToolContext) {
  const run = await runOf(ctx);
  return run !== null && !run.workId && (await workEligible(ctx.db, run));
}

/**
 * Long work's tools (ADR 0121), the same on every brain (the bridge lists them to Claude Code, Codex and Cursor):
 * `work_in_background` and `post_update` for a person's run in a conversation people read, `steer_work` and
 * `stop_work` for a run there while the agent has background work in that conversation. They act only on the
 * run's own work (`self` in the run policy).
 */
export function createWorkToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const move: ToolDefinition = {
    name: WORK_IN_BACKGROUND_TOOL,
    description: `Move what you are doing to the background, so this conversation is free again and the people can ask you other things meanwhile. Use it first for anything that takes more than ~2 minutes or several rounds of tools; never for a quick answer. \`say\`: one short line in their language that you're on it, without a time: the line under it shows when the next update comes, and when it finished. \`title\`: a few words naming the work. \`card\`: true when it is substantial (likely over ~15 min, a plan of 3 or more steps, or a deliverable someone will look at: a pull request, a document, a report, a migration, a data import): it goes on the Tasks board; \`card_issue\` links an issue you already have instead. Then keep working: post progress with ${POST_UPDATE_TOOL}, and your final message is your report.`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: WORK_LIMITS.titleMax },
        say: { type: "string", minLength: 1, maxLength: WORK_LIMITS.sayMax },
        next_update_minutes: { type: "integer", minimum: WORK_LIMITS.nextMin, maximum: WORK_LIMITS.nextMax },
        plan: planSchema,
        card: { type: "boolean" },
        card_issue: { type: "integer", minimum: 1 },
        description: { type: "string", maxLength: 4000, description: "What the card says, when there is a card." },
      },
      required: ["title", "say"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Work in the background", detail: str(input.title) }),
    async execute(input, ctx) {
      const run = await runOf(ctx);
      if (!run)
        return refused(
          "Only a conversation's run can go to the background: keep working here and answer when it's done.",
        );
      if (run.workId) return refused("This is already background work: keep going, and post_update when it's time.");
      if (!(await workEligible(ctx.db, run)))
        return refused("This conversation can't hold background work (no person asked here): just answer.");
      const next = typeof input.next_update_minutes === "number" ? input.next_update_minutes : WORK_LIMITS.nextDefault;
      const cardIssue = typeof input.card_issue === "number" ? input.card_issue : undefined;
      const moved = await moveToBackground({ db: ctx.db, pubsub: deps.pubsub }, run.id, {
        how: "agent",
        title: str(input.title),
        say: str(input.say),
        nextUpdateMin: next,
        plan: cleanPlan(input.plan),
        ...(cardIssue !== undefined ? { card: cardIssue } : input.card === true ? { card: true } : {}),
        ...(typeof input.description === "string" ? { description: input.description } : {}),
      });
      if (!moved) return refused("This run already moved or ended.");
      const minutes = moved.work.nextUpdateAt
        ? Math.round((moved.work.nextUpdateAt.getTime() - Date.now()) / 60_000)
        : next;
      return {
        content: moved.queued ? queuedNote : movedNote(minutes),
        data: { work: { id: moved.work.id, anchorMessageId: moved.anchor.id, queued: moved.queued } },
      };
    },
  };
  const update: ToolDefinition = {
    name: POST_UPDATE_TOOL,
    description: `Only in background work (after ${WORK_IN_BACKGROUND_TOOL}): post one short progress line where people follow it (what's done, what's next), at most every 5 minutes. \`next_update_minutes\` (5–20, default 10) is your next promise: keep it. \`plan\` replaces your plan's steps. \`important\` for a blocker, an early result or a changed plan (still at most one a minute). Plain text, no markdown, no mentions.`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: WORK_LIMITS.updateMax },
        next_update_minutes: { type: "integer", minimum: WORK_LIMITS.nextMin, maximum: WORK_LIMITS.nextMax },
        plan: planSchema,
        important: { type: "boolean" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Progress update", detail: str(input.text) }),
    async execute(input, ctx) {
      const run = await runOf(ctx);
      if (!run) return refused("Only background work posts updates.");
      const out = await postWorkUpdate({ db: ctx.db, pubsub: deps.pubsub }, run.id, {
        text: str(input.text),
        ...(typeof input.next_update_minutes === "number" ? { nextUpdateMin: input.next_update_minutes } : {}),
        plan: cleanPlan(input.plan),
        important: input.important === true,
      });
      if (!out.ok) return refused(out.reason);
      const due = out.work.nextUpdateAt?.toISOString().slice(11, 16);
      return { content: `Posted.${due ? ` Your next update is due at ${due} UTC.` : ""} Keep working.` };
    },
  };
  const steer: ToolDefinition = {
    name: STEER_WORK_TOOL,
    description:
      'Pass the person\'s message on, unchanged, to your background work it is about (by its id in "# Your background work here"). From who asked for the work, the work reads it as their words at its next step and keeps going; from anyone else, it runs once the work ends or is stopped, as them. Then tell them which in one short line, in their language.',
    scope: "",
    inputSchema: {
      type: "object",
      properties: { work_id: { type: "string", minLength: 36, maxLength: 36 } },
      required: ["work_id"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Pass on to background work" }),
    async execute(input, ctx) {
      const run = await runOf(ctx);
      if (!run) return refused("Only a conversation's run can pass a message on.");
      const out = await steerWork({ db: ctx.db, pubsub: deps.pubsub }, run, str(input.work_id));
      if (!out.ok) return refused(out.reason);
      const kept = out.kept.length
        ? `${andList(out.kept)} didn't ask for this work, so it doesn't take it: what they asked runs once it ends or is stopped, as them, with their own access, and a correction to it becomes their own step after it. Tell them so in one short line.`
        : "";
      return {
        content: [out.delivered > 0 ? "Passed on: the work reads it now." : "", kept].filter(Boolean).join(" "),
      };
    },
  };
  const stop: ToolDefinition = {
    name: STOP_WORK_TOOL,
    description:
      'Stop one of your background works here (by its id in "# Your background work here") when the person asks you to. Only who asked for it, your owner or an admin may stop it.',
    scope: "",
    inputSchema: {
      type: "object",
      properties: { work_id: { type: "string", minLength: 36, maxLength: 36 } },
      required: ["work_id"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Stop background work" }),
    async execute(input, ctx) {
      const run = await runOf(ctx);
      if (!run) return refused("Only a conversation's run can stop background work.");
      const personId = (await runAuthority(ctx.db, run)).personId;
      if (!personId) return refused("No person asked for this stop.");
      const target = await workRunId(ctx.db, run.orgId, run.agentId, str(input.work_id));
      if (!target) return refused("No background work of yours here has that id, or it already ended.");
      try {
        await cancelRun({ db: ctx.db, pubsub: deps.pubsub }, personId, run.orgId, target, { tell: false });
      } catch (error) {
        return refused(
          (error as { code?: string }).code === "run.cancel_forbidden"
            ? "Only who asked for that work, your owner or an admin can stop it: say so."
            : "It couldn't be stopped now (it may have just ended).",
        );
      }
      return { content: "Stopped. Its end is posted where it was asked." };
    },
  };
  return {
    name: "work",
    async tools(ctx) {
      // A run that lists every tool has both whatever the run is: each says why when it doesn't apply.
      const every = listsEveryTool(ctx);
      const run = await runOf(ctx);
      if (!run) return every ? [move, update] : [];
      const out: ToolDefinition[] = [];
      if (every) out.push(move, update);
      else if (run.workId) out.push(update);
      else if (await workEligible(ctx.db, run)) out.push(move, update);
      if (!run.workId && (await liveWorksHere(ctx.db, run)).length > 0) out.push(steer, stop);
      return out;
    },
  };
}

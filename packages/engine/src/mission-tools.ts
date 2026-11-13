import { MISSION_MCP_TOOLS } from "@agenteschat/adapters";
import { and, eq, inArray, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { getChannelCached } from "./context";
import { publishUserEvent } from "./events";
import { cutText } from "./format";
import { taskRequester } from "./machine-tasks";
import { getMessage } from "./messages";
import { missionOfRun, NOT_FOR_MISSION, type RunMission, runActsForMission } from "./mission-context";
import { completeMission } from "./mission-delivery";
import { MISSION_LIMITS } from "./mission-limits";
import {
  askDecision,
  checkMissionToolRate,
  getMissionRow,
  homeThreadOf,
  type MissionDeps,
  type MissionExecutor,
  type MissionRow,
  machineExecutors,
  noMentions,
  postMissionMessage,
  proposeMission,
  recordFindings,
  recordMissionEvent,
  requestReview,
  updatePlan,
} from "./missions";
import { replyThreadOf } from "./runs";
import { SANDBOX_SCOPE } from "./sandbox";
import { grantedScopeKeys, grantKey, toolAllowScope } from "./tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
  ...((error as { code?: unknown }).code ? { data: { code: (error as { code: string }).code } } : {}),
});

/** One finding of the investigation before a mission (ADR 0037 round 2). */
/** What `propose_mission` tells the model (also used by the behavior eval's fake). */
export const proposeMissionDescription = (computer: string) =>
  `Propose a mission when a request is long work on the computer "${computer}" (several deliverables, days, product decisions). Investigate FIRST with your read tools (code, logs, errors, analytics, issues, memory): reading needs no ok. Then propose with \`findings\` (what you found, citing files with lines, numbers, ids), at most one \`decision\` finding (the one question that is the person's; decide the rest yourself) and the \`plan\` (short item titles). The people get a card with the findings, the plan and a button to start; starting unlocks writing (branch, code, PR, anything outside reading). For one task, use start_task instead.`;

export const MISSION_FINDINGS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: MISSION_LIMITS.findings,
  items: {
    type: "object",
    properties: {
      kind: {
        enum: ["read", "data", "decision"],
        description:
          "read: code or files you read; data: numbers from analytics, logs, errors; decision: the one open question that is the person's",
      },
      text: { type: "string", minLength: 1, maxLength: MISSION_LIMITS.findingText },
      refs: {
        type: "array",
        maxItems: MISSION_LIMITS.findingRefs,
        items: { type: "string", minLength: 1, maxLength: MISSION_LIMITS.findingRef },
        description: "Files with lines (src/a.ts:41), links, ids you cite",
      },
    },
    required: ["kind", "text"],
    additionalProperties: false,
  },
  description:
    "What you found investigating with your read tools, citing files and lines, numbers, ids. At most one `decision`.",
};

/** The same JSON Schemas the executor's MCP tools have (one contract for both). */
const mcpSchema = (name: string) =>
  (MISSION_MCP_TOOLS.find((t) => t.name === name)?.inputSchema ?? { type: "object" }) as ToolDefinition["inputSchema"];

/**
 * The agent's side of missions (ADR 0029), scope `sandbox:run`:
 * `propose_mission` (the work is planned before the person presses Start).
 * The agent's run in its mission's thread is the mission's main session,
 * whatever its brain (ADR 0032 §6): there it gets the mission tools
 * (`update_plan`, `report`, `ask_decision`, `request_review`,
 * `complete_mission`, `request_approval`; files go to the Drive with
 * `upload_file`), bound to that mission. Each call needs the person behind the run to be the owner or
 * a decider, or the mission itself to have woken the run.
 */
export function createMissionToolSource(deps: Omit<MissionDeps, "db">): ToolSource {
  const missionDeps = (ctx: ToolContext): MissionDeps => ({ ...deps, db: ctx.db });

  const proposeTool = (computer: string, executors: MissionExecutor[]): ToolDefinition => ({
    name: "propose_mission",
    description: proposeMissionDescription(computer),
    scope: SANDBOX_SCOPE,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: MISSION_LIMITS.title, description: "A few words" },
        goal: {
          type: "string",
          minLength: 1,
          maxLength: MISSION_LIMITS.goal,
          description: "What the mission must achieve",
        },
        folder: {
          type: "string",
          maxLength: MISSION_LIMITS.repoDir,
          description: "The repository's folder inside your folder on the computer (default: your folder)",
        },
        executor: {
          enum: [...executors],
          description: `Who programs: ${executors
            .map((e) => (e === "agent" ? "agent (you, with your own tools)" : e))
            .join(", ")}. Only when the person asked for one.`,
        },
        findings: MISSION_FINDINGS_SCHEMA,
        plan: {
          type: "array",
          minItems: 1,
          maxItems: MISSION_LIMITS.proposedPlan,
          items: { type: "string", minLength: 1, maxLength: MISSION_LIMITS.itemTitle },
          description: "The plan's items in order (short titles), from what you found",
        },
      },
      required: ["title", "goal", "findings"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: `Propose the mission ${str(input.title)}`,
      detail: str(input.goal).slice(0, 500),
    }),
    async execute(input, ctx) {
      try {
        const owner = await taskRequester(ctx);
        if (!owner) return { content: "Only a person's request can become a mission.", isError: true };
        const channel = await getChannelCached(ctx.db, ctx.orgId, ctx.channelId);
        if (!channel) return { content: "Missions live in a channel or a DM.", isError: true };
        const flat = replyThreadOf(ctx) === null;
        const trigger = flat ? await getMessage(ctx.db, ctx.orgId, ctx.triggerMessageId) : null;
        // Asked in the main timeline: the mission gets a thread of its own, started from the message that asked.
        const home = flat
          ? await homeThreadOf(missionDeps(ctx), trigger?.authorUserId ?? owner, {
              orgId: ctx.orgId,
              channelId: ctx.channelId,
              messageId: ctx.triggerMessageId,
              title: str(input.title),
            })
          : ctx.threadRootId;
        const mission = await proposeMission(missionDeps(ctx), {
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          ownerId: owner,
          channelId: ctx.channelId,
          threadRootId: home,
          title: str(input.title),
          goal: str(input.goal),
          repoDir: str(input.folder) || null,
          executor: (str(input.executor) || null) as MissionExecutor | null,
          findings: input.findings,
          plan: Array.isArray(input.plan) ? input.plan.map(String) : null,
        });
        const planned = Array.isArray(input.plan) && input.plan.length > 0;
        // Its home is a new thread (asked in the main timeline): the reply here gets a link card to it.
        const elsewhere = home !== ctx.threadRootId;
        const shown = elsewhere
          ? "The app shows a link card to the mission's thread under your reply, and the plan card there has the button to start."
          : "The app shows the plan card in this thread, with the button to start.";
        const reply =
          "Reply briefly (one or two lines) in the person's language; don't name buttons or other parts of the app.";
        if (planned) {
          return {
            content: `Mission ${mission.id} proposed on ${computer}, already investigated and planned: ${
              elsewhere
                ? "a link card to its thread goes under your reply, and the card there"
                : "the card in this thread"
            } shows your findings, the open decision and the plan, with the button to start. Nothing is written until the person who asked starts it. ${reply} Then end your turn.`,
            data: {
              missionId: mission.id,
              threadId: home,
              executor: mission.executor,
              ...(elsewhere ? { missionLink: { missionId: mission.id, threadId: home } } : {}),
            },
          };
        }
        return {
          content:
            // The plan notice joins this run when the mission lives in this thread; a new thread gets its own run.
            elsewhere
              ? `Mission ${mission.id} proposed on ${computer}: it is being planned in its own thread now (read only); nothing changes until the person who asked starts it. ${shown} ${reply} Then end your turn.`
              : `Mission ${mission.id} proposed on ${computer}. Plan it now in this thread (read only: explore the folder, change nothing), then update_plan with the first items and report the goal, in the person's language; the person who asked starts it when the plan looks right. ${shown}`,
          data: {
            missionId: mission.id,
            threadId: home,
            executor: mission.executor,
            ...(elsewhere ? { missionLink: { missionId: mission.id, threadId: home } } : {}),
          },
        };
      } catch (error) {
        return failed(error);
      }
    },
  });

  /**
   * One mission tool of the main session: the mission is re-read (it may have paused
   * or closed), the run must act for it, and the hourly rate holds.
   */
  const bound = (
    run: RunMission,
    tool: Omit<ToolDefinition, "execute" | "scope"> & {
      run(input: Record<string, unknown>, ctx: ToolContext, mission: MissionRow): Promise<ToolOutput>;
      /** Also while proposed (the plan before Start). */
      whileProposed?: boolean;
    },
  ): ToolDefinition => {
    const { run: body, whileProposed, ...definition } = tool;
    return {
      ...definition,
      scope: SANDBOX_SCOPE,
      missionId: run.id,
      async execute(input, ctx) {
        try {
          const mission = await getMissionRow(ctx.db, run.id);
          if (!mission || !["proposed", "active", "paused", "awaiting_close"].includes(mission.status)) {
            return { content: "The mission is closed: stop here.", isError: true, data: { code: "mission.closed" } };
          }
          if (mission.status === "proposed" && !whileProposed) {
            return { content: "The plan isn't approved yet: wait for the people to start the mission.", isError: true };
          }
          if (!(await runActsForMission(ctx, run))) {
            return { content: NOT_FOR_MISSION, isError: true, data: { code: "mission.not_allowed" } };
          }
          await checkMissionToolRate(ctx.db, mission, tool.name, `agent:${ctx.agentId}`);
          const out = await body(input, ctx, mission);
          await recordAudit(ctx.db, {
            orgId: mission.orgId,
            actor: { type: "agent", id: mission.agentId },
            action: `mission.tool_${tool.name}`,
            target: { type: "mission", id: mission.id },
            details: { runId: ctx.runId },
          }).catch(() => undefined);
          return out;
        } catch (error) {
          return failed(error);
        }
      },
    };
  };

  const agentTools = (run: RunMission, computer: string): ToolDefinition[] => [
    bound(run, {
      name: "update_plan",
      description:
        "Replace this mission's plan: the whole checklist, every time (keep each item's id stable). Statuses: todo, doing, waiting_you (needs a person), done, dropped. Keep an item's title unless what it means changed. People see each change as one line in the thread. Write it in the language the people use in the thread.",
      inputSchema: mcpSchema("update_plan"),
      whileProposed: true,
      async run(input, ctx, mission) {
        const out = await updatePlan(missionDeps(ctx), mission, { items: input.items, source: "executor" });
        const c = out.change;
        return {
          content: `Plan saved (version ${out.version}: ${out.items.length} items; +${c.added.length} −${c.removed.length} ~${c.changed.length}).`,
        };
      },
    }),
    bound(run, {
      name: "record_findings",
      description:
        "Save what you found investigating this mission (read only), replacing what was saved: cite files with lines, numbers, ids; at most one `decision` (the one question that is the person's). People see it on the mission's card. Write it in the language the people use in the thread.",
      inputSchema: {
        type: "object",
        properties: { findings: MISSION_FINDINGS_SCHEMA },
        required: ["findings"],
        additionalProperties: false,
      },
      whileProposed: true,
      async run(input, ctx, mission) {
        const findings = await recordFindings(missionDeps(ctx), mission, input.findings);
        return { content: `Findings saved (${findings.length}).` };
      },
    }),
    bound(run, {
      name: "report",
      description:
        "Tell the people in this mission's thread where things stand: a milestone, what you found, what is next, as a status card. One short paragraph; at milestones, not for every step. pr_url: a pull request you opened. Write it in the language the people use in the thread.",
      inputSchema: mcpSchema("report"),
      whileProposed: true,
      async run(input, ctx, mission) {
        const summary = str(input.summary).trim().slice(0, 4000);
        const status = str(input.status) || "working";
        await postMissionMessage(missionDeps(ctx), mission, summary, {
          missionReport: { missionId: mission.id, taskId: null, status, executor: "agent", computer, main: true },
        });
        await recordMissionEvent(ctx.db, mission, "report", { runId: ctx.runId, status });
        return {
          content:
            "Reported in the mission's thread: the people read it there. Don't repeat it; end your turn with an empty final reply unless you have something new to say.",
          data: { reported: true },
        };
      },
    }),
    bound(run, {
      name: "ask_decision",
      description:
        "Ask the people a product or technical decision as a card with 2 to 4 options. blocking: true when you can't go on without it (then end your turn; you are woken with the answer). blocking: false to go on with your recommendation as a provisional decision they review later. Write it in the language the people use in the thread.",
      inputSchema: mcpSchema("ask_decision"),
      async run(input, ctx, mission) {
        const blocking = input.blocking === true;
        const decision = await askDecision(missionDeps(ctx), mission, null, {
          question: input.question,
          options: input.options,
          recommendation: input.recommendation,
          why: input.why,
          impact: input.impact,
          blocking,
        });
        return {
          content: blocking
            ? "Recorded. End your turn now; you'll be woken here with the decision."
            : "Recorded as provisional: continue with your recommendation.",
          // The run waits on this decision and resumes with the answer.
          ...(blocking && decision?.id ? { data: { pause: { kind: "input", id: decision.id } } } : {}),
        };
      },
    }),
    bound(run, {
      name: "request_review",
      description:
        "Ask the people to look at something you can show (screens, a prototype, a PR). Send files to the Drive first with upload_file and pass their artifact ids. Then end your turn: you are woken with their answer (approved, or the changes they want). Write it in the language the people use in the thread.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          summary: { type: "string", maxLength: 4000 },
          pr_url: { type: "string", maxLength: 500 },
          artifact_ids: { type: "array", maxItems: 10, items: { type: "string", minLength: 36, maxLength: 36 } },
        },
        required: ["title"],
        additionalProperties: false,
      },
      async run(input, ctx, mission) {
        const asked = (Array.isArray(input.artifact_ids) ? input.artifact_ids.map(String) : []).filter((id) =>
          /^[0-9a-f-]{36}$/i.test(id),
        );
        const found = asked.length
          ? await ctx.db
              .select({ id: schema.artifacts.id })
              .from(schema.artifacts)
              .where(and(eq(schema.artifacts.orgId, mission.orgId), inArray(schema.artifacts.id, asked)))
          : [];
        const review = await requestReview(missionDeps(ctx), mission, null, {
          title: input.title,
          summary: input.summary,
          prUrl: input.pr_url,
          artifactIds: found.map((a) => a.id),
        });
        return {
          content: `Review requested${found.length ? ` with ${found.length} file(s)` : ""}${
            found.length < asked.length ? `; ${asked.length - found.length} id(s) not found in the Drive` : ""
          } (${review.id}). End your turn; you'll be woken with the people's answer.`,
          // The run waits on this review and resumes with the answer.
          data: { pause: { kind: "input", id: review.id } },
        };
      },
    }),
    bound(run, {
      name: "complete_mission",
      description:
        "When every plan item is done: hand the mission over to the people as a delivery card. summary: what you delivered. checklist: what the person should check (short items). Send files to the Drive first with upload_file and pass their artifact ids. Then end your turn: the person concludes the mission or asks for changes (you are woken with them). Don't keep working. Write it in the language the people use in the thread.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 4000 },
          checklist: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } },
          artifact_ids: { type: "array", maxItems: 10, items: { type: "string", minLength: 36, maxLength: 36 } },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      async run(input, ctx, mission) {
        const asked = (Array.isArray(input.artifact_ids) ? input.artifact_ids.map(String) : []).filter((id) =>
          /^[0-9a-f-]{36}$/i.test(id),
        );
        const found = asked.length
          ? await ctx.db
              .select({ id: schema.artifacts.id })
              .from(schema.artifacts)
              .where(and(eq(schema.artifacts.orgId, mission.orgId), inArray(schema.artifacts.id, asked)))
          : [];
        const delivery = await completeMission(missionDeps(ctx), mission, null, {
          summary: input.summary,
          checklist: input.checklist,
          artifactIds: found.map((a) => a.id),
        });
        return {
          content: `Delivered${found.length ? ` with ${found.length} file(s)` : ""}${
            found.length < asked.length ? `; ${asked.length - found.length} id(s) not found in the Drive` : ""
          } (${delivery.id}). Stop now and wait for the person to check it: end your turn.`,
        };
      },
    }),
    bound(run, {
      name: "request_approval",
      description:
        "Ask a person to approve a merge, a deploy or a rollback before you do it. Never merge, deploy or roll back without an approval. Your run waits for the decision; once approved, do it.",
      inputSchema: mcpSchema("request_approval"),
      sensitive: true,
      describe: (input) => ({
        title: `${({ merge: "Merge", deploy: "Deploy", rollback: "Roll back" } as Record<string, string>)[str(input.action)] ?? "Approve"} ${noMentions(str(input.target)).slice(0, 280)}`,
        detail: noMentions(str(input.detail)).slice(0, 1000),
      }),
      async run(input, ctx, mission) {
        // Runs only after a person approved it (ADR 0015): the run resumes here.
        await recordMissionEvent(ctx.db, mission, "approval_granted", {
          runId: ctx.runId,
          action: str(input.action),
          target: cutText(str(input.target), 300),
        });
        return {
          content: `Approved: go ahead with the ${str(input.action)} of ${str(input.target)} now, then report it.`,
        };
      },
    }),
  ];

  return {
    name: "missions",
    async tools(ctx) {
      const keys = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
      const names = ["propose_mission", "update_plan", "report", "ask_decision", "request_review", "complete_mission"];
      const granted =
        keys.has(grantKey(null, SANDBOX_SCOPE)) || names.some((n) => keys.has(grantKey(null, toolAllowScope(n))));
      if (!granted || !deps.hub) return [];
      const out: ToolDefinition[] = [];
      const [agent, mission] = await Promise.all([getAgentCached(ctx.db, ctx.orgId, ctx.agentId), missionOfRun(ctx)]);
      if (agent?.machineId && !mission) {
        const status = await deps.hub.status(agent.machineId);
        if (status && status.orgId === ctx.orgId) {
          const { available } = machineExecutors(status);
          if (available.length > 0) out.push(proposeTool(status.name, available));
        }
      }
      // The run in the mission thread is its main session and does the work (ADR 0032 §6).
      if (mission) {
        const status = mission.machineId ? await deps.hub.status(mission.machineId) : null;
        out.push(...agentTools(mission, status?.name ?? "the computer"));
      }
      return out;
    },
  };
}

/** Tells the mission's owner an approval waits (the approval belongs to the main session's run). */
export async function notifyMissionApproval(
  deps: Pick<MissionDeps, "db" | "pubsub">,
  approval: { id: string; orgId: string; missionId: string | null },
) {
  if (!approval.missionId) return;
  const [m] = await deps.db
    .select({ ownerId: schema.missions.ownerId })
    .from(schema.missions)
    .where(eq(schema.missions.id, approval.missionId));
  if (!m?.ownerId) return;
  await publishUserEvent(deps.pubsub, approval.orgId, m.ownerId, {
    type: "mission.approval_requested",
    missionId: approval.missionId,
    approvalId: approval.id,
  });
}

import type { PubSub } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { withdrawHandoff } from "./browser/handoff";
import { hasOpenRequest, openRequestsOf, WITHDRAW_REQUEST_TOOL, WITHDRAW_RULE } from "./open-requests";
import { quietEnd, withdrawMoot } from "./parked-asks";
import { withdrawQuestion } from "./questions";
import { withdrawSecretRequest } from "./secrets";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agentRuns } = schema;

/**
 * `withdraw_request`: the agent takes back one of its own open requests (asked help on its screens, a secret, a
 * question) once it no longer needs it. Its card says so and the people asked stop waiting. Offered only while
 * the agent has one open in this conversation; only its own there (another agent's, or another conversation's, id is not found).
 */
export function createWithdrawRequestToolSource(deps: { pubsub?: PubSub } = {}): ToolSource {
  const tool: ToolDefinition = {
    name: WITHDRAW_REQUEST_TOOL,
    description: `Withdraw one of your own open requests (help in your browser or desktop, a secret, a question) by its id from "# Your open requests". ${WITHDRAW_RULE}`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 64 },
        reason: { type: "string", maxLength: 300, description: "Why it isn't needed anymore, short." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Withdraw a request" }),
    async execute(input, ctx) {
      const id = String(input.id ?? "").trim();
      const open = (await openRequestsOf(ctx.db, ctx.orgId, ctx.agentId, ctx.channelId)).find((r) => r.id === id);
      if (!open)
        return {
          content:
            "No open request of yours has that id: it was answered, ended, isn't yours or is in another conversation.",
        };
      const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 300) : null;
      const d = { db: ctx.db, pubsub: deps.pubsub };
      // Another of its runs still waits on it: nobody answered, so that run owes nobody for it and may stay quiet.
      const [waiting] =
        open.runId && open.runId !== ctx.runId
          ? await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, open.runId))
          : [];
      const moot =
        waiting &&
        (await withdrawMoot(
          d,
          waiting,
          open,
          `You withdrew this ${open.kind === "question" ? "question" : "request"} yourself${reason ? ` (${reason})` : ""}: nobody will answer it, and nobody waits on it. Go on without it; if nothing is left to do or say, ${quietEnd(waiting)}.`,
          reason,
        ));
      const done =
        moot ||
        (open.kind === "secret"
          ? await withdrawSecretRequest(d, ctx.agentId, id)
          : open.kind === "question"
            ? await withdrawQuestion(d, ctx.agentId, id)
            : await withdrawHandoff(d, id, ctx.runId, reason));
      if (!done) return { content: "It just ended or a person took it over: nothing to withdraw." };
      return { content: "Withdrawn: its card says you no longer need it, and nobody waits on it." };
    },
  };
  return {
    name: "withdraw-request",
    async tools(ctx) {
      // A routine's background run keeps to its task, as in its context.
      if (ctx.background) return [];
      return (await hasOpenRequest(ctx.db, ctx.orgId, ctx.agentId, ctx.channelId)) ? [tool] : [];
    },
  };
}

import type { RateLimiter } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { namesLabel, namesOf } from "./approvals";
import { FEEDBACK_MAX, FEEDBACK_PER_HOUR, queueFeedback } from "./feedback";
import {
  agentFeedback,
  FEEDBACK_SUMMARY_MAX,
  feedbackAutoOf,
  feedbackOfferRefusal,
  OFFER_FEEDBACK_TOOL,
  type PendingFeedbackOffer,
} from "./feedback-offers";
import { getMembership } from "./organizations";
import { personBehindCall } from "./requester";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { agents, users } = schema;

export const SEND_FEEDBACK_TOOL = "send_feedback";

const NOBODY =
  "Feedback goes in a person's name, and nobody asked for this one: nothing was sent. Say it in your reply instead.";

/**
 * `send_feedback` (ADR 0160 §11): a person asks an agent to send their feedback, and it goes as the form's does, one
 * email to whoever runs the server (`to`, `FEEDBACK_EMAIL`), in that person's name and within their ten an hour. It
 * leaves the workspace in their name, so they approve each one, reading its text on the card; only they do. The
 * email says an agent wrote it. Listed only where the server takes feedback; a run nobody is behind (a routine's, an
 * agent's own) sends none.
 */
export function createFeedbackToolSource(deps: {
  /** `FEEDBACK_EMAIL`; unset, the tool is not listed. */
  to?: string | null;
  /** This server's version. */
  version: string;
  /** The form's limiter, so both ways in count toward the same hour. */
  rateLimiter?: RateLimiter;
}): ToolSource {
  const tool: ToolDefinition = {
    name: SEND_FEEDBACK_TOOL,
    description:
      "Send the person's feedback about this app itself (a bug, something confusing, an idea) to whoever runs this server, by email in their name, only when they ask you to ('manda um feedback dizendo…', 'report this bug for me'). `text`: what they want said, in their words and language, plus what you saw yourself that helps whoever reads it (what was being done, the error as it appeared). Nothing from the conversation they didn't ask to send. They read it on a card and approve it before it goes.",
    scope: "",
    sensitive: true,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: FEEDBACK_MAX } },
      required: ["text"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: "Send feedback to whoever runs this server",
      detail: typeof input.text === "string" ? input.text.trim() : "",
    }),
    // In their name, so theirs alone to approve; a call nobody is behind has nobody to ask.
    async approvers(_input, ctx) {
      const person = await personBehindCall(ctx);
      if (!person || !(await getMembership(ctx.db, person, ctx.orgId))) return { ok: false, message: NOBODY };
      return {
        ok: true,
        approvers: {
          userIds: [person],
          label: namesLabel(await namesOf(ctx.db, [person])),
          requestedBy: null,
          requesterDecides: false,
          required: true,
        },
      };
    },
    async execute(input, ctx) {
      const to = deps.to;
      if (!to) return { content: "This server takes no feedback: nothing was sent.", isError: true };
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) return { content: "Give the feedback in `text`.", isError: true };
      const person = await personBehindCall(ctx);
      const member = person ? await getMembership(ctx.db, person, ctx.orgId) : null;
      const [user] = person
        ? await ctx.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, person))
        : [];
      if (!person || !member || !user) {
        return { content: NOBODY, isError: true };
      }
      if (deps.rateLimiter && !(await deps.rateLimiter.consume(`feedback:${person}`, FEEDBACK_PER_HOUR)).allowed) {
        return {
          content: "They sent too much feedback in the last hour: nothing was sent. Tell them to try again later.",
          isError: true,
        };
      }
      const [agent] = await ctx.db
        .select({ name: agents.name, handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId)));
      await queueFeedback(ctx.db, {
        orgId: ctx.orgId,
        // One email per call: the same call run again (a retry) goes once.
        key: `${person}:${ctx.runId}:${ctx.toolUseId ?? crypto.randomUUID()}`,
        feedback: {
          to,
          name: user.name,
          email: user.email,
          orgName: member.orgName,
          text,
          app: "agent",
          facts: [
            ["Role", member.role],
            ["Written by", agent ? `${agent.name} (@${agent.handle}), an agent, when they asked` : "an agent"],
          ],
          version: deps.version,
        },
      });
      return {
        content: "Sent to whoever runs this server, in their name; an answer goes to their email.",
      };
    },
  };
  /**
   * `offer_feedback` (ADR 0160 §12): the agent's own initiative, when the app itself failed or the person complained
   * about it. It sends nothing: the report rides on the reply as a row the person sends or turns down, so it needs no
   * approval and holds nothing. One a day in a conversation; a person who chose "Always send" gets it sent with the
   * reply, within their ten an hour.
   */
  const offer: ToolDefinition = {
    name: OFFER_FEEDBACK_TOOL,
    description:
      "Offer, on your own initiative, to report a problem with this app itself to whoever runs this server: a row under your reply with the report, which the person sends with one click or dismisses; nothing waits on it. Only when the app really failed: one of its own tools broke with an internal error, your browser or desktop crashed, you went in circles on the same app error, or the person complains that something of the app doesn't work and what you see confirms it. Never for an outside service's failure, a limit, a missing permission or setting, or your own mistake. `summary`: the problem in a few words, in their language, no capital letter and no period ('the browser closed while opening a page'). `text`: the report in their language: what was being done, what happened as it appeared, when; nothing else from the conversation. Still answer them as well as you can, and don't ask in words whether to send it: the row asks.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1, maxLength: FEEDBACK_SUMMARY_MAX },
        text: { type: "string", minLength: 1, maxLength: FEEDBACK_MAX },
      },
      required: ["summary", "text"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const to = deps.to;
      if (!to) return { content: "This server takes no feedback: nothing was offered.", isError: true };
      const summary = typeof input.summary === "string" ? input.summary.replace(/\s+/g, " ").trim() : "";
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!summary || !text)
        return { content: "Give the problem in `summary` and the report in `text`.", isError: true };
      const person = await personBehindCall(ctx);
      const member = person ? await getMembership(ctx.db, person, ctx.orgId) : null;
      if (!person || !member) {
        return {
          content: "A report goes in a person's name, and nobody is behind this run: nothing was offered.",
          isError: true,
        };
      }
      const refusal = await feedbackOfferRefusal(ctx.db, {
        orgId: ctx.orgId,
        channelId: ctx.channelId,
        userId: person,
      });
      if (refusal) return { content: refusal, isError: true };
      const pending: PendingFeedbackOffer = {
        view: {
          id: crypto.randomUUID(),
          forUserId: person,
          summary: summary.slice(0, FEEDBACK_SUMMARY_MAX),
          text: text.slice(0, FEEDBACK_MAX),
          state: "offered",
        },
      };
      // "Always send": it goes with the reply, while they are within their hour's ten; past it, the row asks.
      if (
        (await feedbackAutoOf(ctx.db, ctx.orgId, person)) &&
        (!deps.rateLimiter || (await deps.rateLimiter.consume(`feedback:${person}`, FEEDBACK_PER_HOUR)).allowed)
      ) {
        const [user] = await ctx.db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, person));
        const [agent] = await ctx.db
          .select({ name: agents.name, handle: agents.handle })
          .from(agents)
          .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId)));
        if (user) {
          pending.view = { ...pending.view, state: "sent", auto: true, decidedAt: new Date().toISOString() };
          pending.send = agentFeedback({
            to,
            version: deps.version,
            user,
            orgName: member.orgName,
            role: member.role,
            agent,
            text: pending.view.text,
            how: "on its own; they chose to always send these",
          });
        }
      }
      return {
        content: pending.send
          ? "It goes with your reply, in their name (they chose to always send these): a row under it says so. Finish your answer; don't mention the report."
          : "Offered: a row under your reply lets them send it or dismiss it. Finish your answer; don't ask them about the report in words.",
        data: { feedbackOffer: pending },
      };
    },
  };
  return { name: "feedback", tools: async () => (deps.to ? [tool, offer] : []) };
}

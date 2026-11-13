import { and, eq, gt, schema, sql } from "@agenteschat/db";
import { approverIds, deciderName, namesLabel, namesOf } from "./approvals";
import { findMember, plainName } from "./chat-tools";
import { cutText } from "./format";
import { MISSION_TOOL_RATES } from "./missions";
import { maySql } from "./permissions";
import type { ToolContext, ToolDefinition, ToolSource } from "./tools/types";

const { agents, approvals, organizationMemberRoles, organizationMembers, orgRoles } = schema;

export const REQUEST_APPROVAL_TOOL = "request_approval";

/** At most this many people named on one request. */
const PEOPLE_MAX = 10;

/** Requests per agent per hour, as a mission's `request_approval`: each one notifies and pushes every approver. */
const REQUESTS_PER_HOUR = MISSION_TOOL_RATES.request_approval ?? 5;

type Resolved = { ok: true; approvers: schema.ApprovalApprovers } | { ok: false; message: string };

/**
 * Who decides a `request_approval` (ADR 0126): the role and the people the agent named (the role by its name, a
 * person as `findMember` finds them), else the agent's owner and admins. The person behind the run is never asked
 * their own request, unless they hold the role named (or approve every action).
 */
export async function resolveApprovers(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId">,
  input: { role?: string; people?: string[] },
  requestedBy: string | null,
): Promise<Resolved> {
  const { db, orgId } = ctx;
  const [recent] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, orgId),
        eq(approvals.agentId, ctx.agentId),
        eq(approvals.tool, REQUEST_APPROVAL_TOOL),
        gt(approvals.createdAt, sql`now() - interval '1 hour'`),
      ),
    );
  if ((recent?.n ?? 0) >= REQUESTS_PER_HOUR) {
    return {
      ok: false,
      message: `Too many approval requests in the last hour (at most ${REQUESTS_PER_HOUR}). Tell the person to wait for the ones already asked, or to ask again later.`,
    };
  }
  const ids = new Set<string>();
  const labels: string[] = [];
  // An admin decides any approval, their own request too: the card says so (ADR 0126).
  const [requesterAdmin] = requestedBy
    ? await db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, requestedBy),
            maySql(orgId, organizationMembers.userId, "approve_actions"),
          ),
        )
    : [];
  let requesterDecides = !!requesterAdmin;
  const roleName = input.role?.trim();
  if (roleName) {
    const roles = await db
      .select({ id: orgRoles.id, name: orgRoles.name })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom")));
    const role = roles.find((r) => plainName(r.name) === plainName(roleName));
    if (!role) {
      return {
        ok: false,
        message: `No role named "${roleName}" in this workspace${
          roles.length ? ` (its roles: ${roles.map((r) => r.name).join(", ")})` : ""
        }. Name one of them, name the people, or leave both out to ask the agent's owner and admins.`,
      };
    }
    const holders = await db
      .select({ userId: organizationMemberRoles.userId })
      .from(organizationMemberRoles)
      .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.roleId, role.id)));
    if (holders.length === 0) {
      return {
        ok: false,
        message: `Nobody holds the role ${role.name} yet: name the people, or leave role out to ask the agent's owner and admins.`,
      };
    }
    for (const h of holders) ids.add(h.userId);
    requesterDecides ||= !!requestedBy && ids.has(requestedBy);
    labels.push(role.name);
  }
  const named: string[] = [];
  for (const who of input.people ?? []) {
    const found = await findMember(ctx, who);
    if (found.length === 0) return { ok: false, message: `Nobody in this workspace is named "${who}".` };
    if (found.length > 1) {
      return {
        ok: false,
        message: `"${who}" could be ${found.map((p) => `${p.name} (@${p.handle ?? p.email})`).join(" or ")}: name one by @handle.`,
      };
    }
    const [person] = found;
    if (person && !ids.has(person.userId)) {
      ids.add(person.userId);
      named.push(person.userId);
    }
  }
  if (named.length > 0) labels.push(...(await namesOf(db, named)));
  if (requestedBy && ids.has(requestedBy) && !requesterDecides) ids.delete(requestedBy);
  const approvers: schema.ApprovalApprovers = { userIds: [...ids], label: "", requestedBy, requesterDecides };
  if (labels.length > 0 && ids.size > 0) return { ok: true, approvers: { ...approvers, label: namesLabel(labels) } };
  // Nobody named (or only the requester): the agent's owner and admins.
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, ctx.agentId)));
  const asked = await approverIds(db, {
    orgId,
    ownerUserId: agent?.ownerUserId ?? null,
    tool: REQUEST_APPROVAL_TOOL,
    approvers,
  });
  return { ok: true, approvers: { ...approvers, label: namesLabel(await namesOf(db, asked)) } };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * `request_approval` (ADR 0126): the agent asks the people who decide to approve something before it does it, when
 * its instructions, the workspace's rules or the person say it needs someone's approval. A real approval (the card
 * in the conversation, Aprovações, the inbox and push of those asked); the run waits, and the decision wakes it with
 * who decided and their note. Every agent and brain has it (scope ""); a mission's own `request_approval` wins in
 * its thread (the missions source comes first).
 */
export function createApprovalRequestToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: REQUEST_APPROVAL_TOOL,
    description:
      "Ask the people who decide to approve something before you do it, whenever your instructions, the workspace's rules or the person say it needs someone's approval (a query, a discount, a refund, a publication). Never ask the person who made the request with ask_user instead: they can't approve their own request. A card goes to the approvers (their Approvals and phone); your turn pauses until one decides, then you are told who decided and their note. Leave role and people out to ask the agent's owner and admins; name a role of the workspace (the board, a department) or people when your instructions say who approves. Tools that already ask a person by themselves (merges, deploys, connected apps' writes) don't need this.",
    scope: "",
    sensitive: true,
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "What to approve, in one short line the approvers read first, in their language.",
        },
        details: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description:
            "Exactly what you will do once approved (the query, the amount, the recipient): the approval covers that and nothing else.",
        },
        role: {
          type: "string",
          maxLength: 60,
          description: "A role of the workspace whose people approve it (as your instructions name it).",
        },
        people: {
          type: "array",
          maxItems: PEOPLE_MAX,
          items: { type: "string", minLength: 1, maxLength: 100 },
          description: "People who approve it, by @handle or name.",
        },
      },
      required: ["summary", "details"],
      additionalProperties: false,
    },
    describe: (input) => ({
      title: str(input.summary).slice(0, 200),
      detail: str(input.details),
    }),
    approvers: (input, ctx, requestedBy) =>
      resolveApprovers(
        ctx,
        {
          role: str(input.role),
          people: Array.isArray(input.people) ? input.people.map(String) : [],
        },
        requestedBy,
      ),
    // Runs only once someone approved it (the gateway asked first): says who, and their note.
    async execute(input, ctx) {
      const [row] = await ctx.db
        .select({
          decidedBy: approvals.decidedByUserId,
          decidedFor: approvals.decidedForUserId,
          reason: approvals.reason,
          approvers: approvals.approvers,
        })
        .from(approvals)
        .where(and(eq(approvals.runId, ctx.runId), eq(approvals.toolUseId, ctx.toolUseId ?? "")));
      const name = row?.decidedBy ? await deciderName(ctx.db, row.decidedBy, row.decidedFor) : null;
      const self = !!row?.decidedBy && row.decidedBy === row.approvers?.requestedBy;
      return {
        content: `Approved by ${name ?? "a person"}${self ? " (who asked for it, as an approver by role)" : ""}${
          row?.reason ? `, with the note: ${row.reason}` : ""
        }. Do exactly what was approved now: ${cutText(str(input.details), 2000)}`,
      };
    },
  };
  return { name: "approval-requests", tools: async () => [tool] };
}

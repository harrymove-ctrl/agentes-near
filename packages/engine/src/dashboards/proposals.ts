import { and, eq, inArray, isNull, schema } from "@agenteschat/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { notifyDashboardProposal, resolveDashboardProposal } from "../notification-producers";
import { requireDashboard } from "./access";
import { publishDashboardChanged } from "./events";
import { dashboardView, setDashboardAudience, widensDashboardAudience } from "./service";
import { DASHBOARD_ERRORS, type DashboardDeps, type DashboardProposalDecision, type DashboardView } from "./types";

const { dashboards, orgRoles } = schema;

/** An agent never shows a board to more people by itself (ADR 0135 §11). */

/** How long the agent's reason may be (it shows on the board's banner and in "Waiting on you"). */
export const DASHBOARD_PROPOSAL_WHY_MAX = 500;

const nowOf = (deps: DashboardDeps) => deps.now?.() ?? new Date();

/** The workspace's custom roles among `roleIds` (a deleted one drops out), in the order given. */
async function liveRoles(deps: DashboardDeps, orgId: string, roleIds: readonly string[]) {
  const wanted = [...new Set(roleIds)];
  if (wanted.length === 0) return [];
  const rows = await deps.db
    .select({ id: orgRoles.id, name: orgRoles.name })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, wanted)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wanted.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Records the agent's request on the board (`dashboards.proposal`, replacing a pending one) and tells the person it
 * asks (the board's owner) with a waiting `dashboard_proposal` notification (group `dashboard-proposal:<id>…`). A
 * narrower or equal audience isn't a proposal: callers apply it.
 */
export async function proposeDashboardAudience(
  deps: DashboardDeps,
  input: {
    orgId: string;
    dashboardId: string;
    agentId: string;
    runId: string | null;
    audience: "workspace" | "roles";
    roleIds: string[];
    why: string;
  },
): Promise<void> {
  const { db } = deps;
  const [board] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.orgId, input.orgId), eq(dashboards.id, input.dashboardId), isNull(dashboards.deletedAt)));
  if (!board) throw new NotFoundError("Dashboard not found", DASHBOARD_ERRORS.notFound);
  if (board.kind === "home") throw new ValidationError("A home is always its owner's", DASHBOARD_ERRORS.homeFixed);
  const roles = input.audience === "roles" ? await liveRoles(deps, input.orgId, input.roleIds) : [];
  if (input.audience === "roles" && roles.length === 0) {
    throw new ValidationError("Pick at least one of the workspace's roles", DASHBOARD_ERRORS.rolesRequired);
  }
  const roleIds = roles.map((r) => r.id);
  const to = { audience: input.audience, roleIds };
  if (!widensDashboardAudience({ audience: board.audience, roleIds: board.audienceRoleIds }, to)) return;
  const at = nowOf(deps).toISOString();
  const proposal: schema.DashboardProposalRow = {
    audience: input.audience,
    roleIds,
    agentId: input.agentId,
    runId: input.runId,
    why: input.why.replace(/\s+/g, " ").trim().slice(0, DASHBOARD_PROPOSAL_WHY_MAX),
    at,
  };
  const [updated] = await db
    .update(dashboards)
    .set({ proposal, updatedAt: nowOf(deps) })
    .where(eq(dashboards.id, board.id))
    .returning();
  // A request it replaces is done; the new one waits on the person.
  await resolveDashboardProposal(deps, input.orgId, board.id).catch(() => {});
  await notifyDashboardProposal(deps, {
    orgId: input.orgId,
    userId: board.ownerUserId,
    dashboardId: board.id,
    agentId: input.agentId,
    title: board.title,
    audience: input.audience,
    roleNames: roles.map((r) => r.name),
    why: proposal.why,
    at,
  }).catch(() => {});
  await publishDashboardChanged(deps.pubsub, updated ?? board).catch(() => {});
}

/**
 * Publish or Keep only for me, by the person asked (`dashboard.proposal_not_yours` otherwise; `post` needed to
 * publish): `publish` sets the audience asked for (`setDashboardAudience`; roles deleted since drop out), `keep` leaves
 * it; either clears the request and resolves its notification.
 */
export async function decideDashboardProposal(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  dashboardId: string,
  decision: DashboardProposalDecision,
): Promise<DashboardView> {
  const { db } = deps;
  const { board, viewer } = await requireDashboard(db, actorId, orgId, dashboardId, "see");
  const proposal = board.proposal;
  if (!proposal) throw new ConflictError("No request is waiting on this dashboard", DASHBOARD_ERRORS.proposalNone);
  if (board.ownerUserId !== actorId) {
    throw new ForbiddenError("Only the person it was made for decides", DASHBOARD_ERRORS.proposalNotYours);
  }
  let next = board;
  if (decision === "publish") {
    if (!viewer.mayPublish) {
      throw new ForbiddenError(
        "Showing a dashboard to others needs permission to post",
        DASHBOARD_ERRORS.publishForbidden,
      );
    }
    const roles = proposal.audience === "roles" ? await liveRoles(deps, orgId, proposal.roleIds) : [];
    if (proposal.audience === "roles" && roles.length === 0) {
      throw new ValidationError("The roles it asked for are gone", DASHBOARD_ERRORS.rolesRequired);
    }
    next = await setDashboardAudience(
      deps,
      board,
      proposal.audience,
      roles.map((r) => r.id),
    );
  }
  const [cleared] = await db
    .update(dashboards)
    .set({ proposal: null, updatedAt: nowOf(deps) })
    .where(eq(dashboards.id, board.id))
    .returning();
  next = cleared ?? next;
  await resolveDashboardProposal(deps, orgId, board.id).catch(() => {});
  await publishDashboardChanged(deps.pubsub, next).catch(() => {});
  return dashboardView(db, next, viewer);
}

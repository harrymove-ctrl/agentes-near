import { and, type Database, desc, eq, isNull, schema, sql } from "@agenteschat/db";
import { type AgentActionView, actionView } from "./agent-actions";
import { getAgent } from "./agents";
import { type ApprovalView, listApprovals } from "./approvals";
import { type ArtifactKind, listArtifacts, requesterSharedChannels } from "./artifacts";
import { NotFoundError } from "./errors";
import { requirePermission } from "./organizations";

const { agentActions } = schema;

/**
 * "O que fez por você" (the agent's profile in the phone app): what one agent did
 * that involves this person, newest first. Three sources that already exist:
 * - receipts (`agent_actions`) of runs this person asked for, not undone
 *   (memory receipts stay out: "O que sabe sobre você" lists those);
 * - files the agent made in conversations this person shares with it (and
 *   can see);
 * - approvals of the agent this person decided, or that wait on them now.
 * Nothing new is stored: it is a view over those rows, scoped by org and viewer.
 */
export type ForYouItem =
  | { type: "action"; at: string; channelId: string; action: AgentActionView }
  | {
      type: "file";
      at: string;
      file: { id: string; kind: ArtifactKind; title: string; channelId: string | null; threadId: string | null };
    }
  | {
      type: "approval";
      at: string;
      approval: {
        id: string;
        title: string;
        status: ApprovalView["status"];
        channelId: string;
        /** Where its card is; null: the main timeline. */
        threadId: string | null;
        /** Pending and this person may decide it ("espera seu ok"). */
        waitingOnYou: boolean;
      };
    };

export interface ForYou {
  items: ForYouItem[];
  /** Items since the first day of this month (UTC), within what was looked at. */
  monthCount: number;
}

/** How far back each source is read (the list shows the newest; the month count needs this month). */
const PER_SOURCE = 100;

export async function agentWorkForViewer(
  db: Database,
  viewerId: string,
  orgId: string,
  agentId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<ForYou> {
  await requirePermission(db, viewerId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);

  const [actions, files, shared, approvals] = await Promise.all([
    db
      .select()
      .from(agentActions)
      .where(
        and(
          eq(agentActions.orgId, orgId),
          eq(agentActions.agentId, agentId),
          eq(agentActions.requestedByUserId, viewerId),
          isNull(agentActions.undoneAt),
          sql`${agentActions.kind} not like 'memory.%'`,
        ),
      )
      .orderBy(desc(agentActions.createdAt))
      .limit(PER_SOURCE),
    listArtifacts(db, { type: "person", userId: viewerId }, orgId, {
      author: { type: "agent", id: agentId },
      limit: PER_SOURCE,
    }),
    requesterSharedChannels(db, orgId, agentId, viewerId),
    listApprovals(db, viewerId, orgId, { agentId, limit: PER_SOURCE }),
  ]);

  const sharedSet = new Set(shared);
  const items: ForYouItem[] = [
    ...actions.map(
      (r): ForYouItem => ({
        type: "action",
        at: r.createdAt.toISOString(),
        channelId: r.channelId,
        action: actionView(r),
      }),
    ),
    ...files
      .filter((f) => f.channelId && sharedSet.has(f.channelId))
      .map(
        (f): ForYouItem => ({
          type: "file",
          at: f.createdAt,
          file: { id: f.id, kind: f.kind, title: f.title, channelId: f.channelId, threadId: f.threadId },
        }),
      ),
    ...approvals.flatMap((a): ForYouItem[] => {
      const waiting = a.status === "pending" && a.canDecide && new Date(a.expiresAt).getTime() > now.getTime();
      if (!waiting && a.decidedByUserId !== viewerId) return [];
      return [
        {
          type: "approval",
          at: waiting ? a.createdAt : (a.decidedAt ?? a.createdAt),
          approval: {
            id: a.id,
            title: a.title,
            status: a.status,
            channelId: a.channelId,
            threadId: a.threadId,
            waitingOnYou: waiting,
          },
        },
      ];
    }),
  ];
  items.sort((a, b) => b.at.localeCompare(a.at));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return { items: items.slice(0, limit), monthCount: items.filter((i) => i.at >= monthStart).length };
}

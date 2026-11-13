/**
 * A routine's background run and what it carries (ADR 0053).
 *
 * A routine fires a background run of its agent (`agent_runs.background`) in the routine's own room:
 * a private, agent-only conversation (`routineRoomKey`) that no person reads. The run's trigger there
 * is the routine's brief: its instructions, written by its creator, with `meta.routineBrief` set by the
 * server. Nothing of it reaches the routine's conversation; only `hand_off` does (by default the agent's
 * own message in `deliverTo`, tagged with the routine; with `wake_me`, a `routine_handoff` notice there that
 * wakes the agent to act on it), and the approval cards it asks for go there too.
 *
 * Nobody is behind a routine's run (`authority.ts`): the creator set it up and stays accountable
 * (notifications, approvals), but the run never acts as them.
 */

/**
 * What a routine may do while nobody watches: always `act`, the agent's own permissions (ADR 0109). `read`
 * (look and report) is only an old stored value, read as `act`; the column stays for now.
 */
export type RoutineAccess = "read" | "act";
/** When a routine speaks: `when_new` (its agent judges what is news) or `always` (a report every run). */
export type RoutineReport = "always" | "when_new";

export const ROUTINE_ACCESS: readonly RoutineAccess[] = ["read", "act"];
export const ROUTINE_REPORT: readonly RoutineReport[] = ["always", "when_new"];

/** A stored or sent access level: every routine acts (ADR 0109), whatever was stored or sent. */
export const routineAccessOf = (_value?: unknown): RoutineAccess => "act";
/** A stored or sent report policy, read safely: anything but `always` is `when_new`. */
export const routineReportOf = (value: unknown): RoutineReport => (value === "always" ? "always" : "when_new");

/** What a routine's background run carries on its brief (`meta.routineBrief`), set by the server when it fires. */
export interface RoutineBrief {
  routineId: string;
  /** The `routine_runs` row of this firing. */
  routineRunId: string;
  name: string;
  /** Who set it up (accountable for it, never "behind" its run). Null when they were deleted. */
  creatorUserId: string | null;
  /** The routine's conversation: where `hand_off` posts (or wakes the agent) and where its approval cards go. */
  deliverTo: { channelId: string; threadId: string | null };
  /** "Um documento no Drive" (target `artifact`): its files go to the shared Drive, whatever `deliverTo` is. */
  toDrive?: boolean;
  access: RoutineAccess;
  report: RoutineReport;
  /** How it fired: `schedule`, `manual` or `event`. */
  trigger: string;
  /** The slot it was due at (ISO); for a manual or event run, when it was asked. */
  dueAt: string;
  /**
   * A widget's refresh (ADR 0135 §4–§5): the routine redoes this widget in place and speaks only through
   * `update_widget`, never in a conversation.
   */
  widget?: { widgetId: string; dashboardId: string };
}

/** The brief of a message's meta (`meta.routineBrief`), when well formed; null for any other message. */
export function routineBriefOf(meta: Record<string, unknown> | null | undefined): RoutineBrief | null {
  const b = meta?.routineBrief as Partial<RoutineBrief> | undefined;
  if (!b || typeof b !== "object") return null;
  const to = b.deliverTo as Partial<RoutineBrief["deliverTo"]> | undefined;
  if (typeof b.routineId !== "string" || typeof b.routineRunId !== "string") return null;
  if (!to || typeof to.channelId !== "string") return null;
  return {
    routineId: b.routineId,
    routineRunId: b.routineRunId,
    name: typeof b.name === "string" ? b.name : "",
    creatorUserId: typeof b.creatorUserId === "string" ? b.creatorUserId : null,
    deliverTo: { channelId: to.channelId, threadId: typeof to.threadId === "string" ? to.threadId : null },
    ...(b.toDrive === true ? { toDrive: true } : {}),
    access: routineAccessOf(b.access),
    report: routineReportOf(b.report),
    trigger: typeof b.trigger === "string" ? b.trigger : "schedule",
    dueAt: typeof b.dueAt === "string" ? b.dueAt : "",
    ...widgetOf(b.widget),
  };
}

/** A brief's widget (ADR 0135 §4), when well formed. */
function widgetOf(raw: unknown): Pick<RoutineBrief, "widget"> {
  const w = raw as Partial<NonNullable<RoutineBrief["widget"]>> | undefined;
  if (!w || typeof w !== "object" || typeof w.widgetId !== "string" || typeof w.dashboardId !== "string") return {};
  return { widget: { widgetId: w.widgetId, dashboardId: w.dashboardId } };
}

/**
 * The routine room's key (`channels.dm_key`): an agent-only conversation of one, one per routine, never
 * a person's. A run reads only its own routine's room, never another routine's briefs or events.
 */
export const routineRoomKey = (agentId: string, routineId: string) => `routine|a:${agentId}|r:${routineId}`;

/** Whether a channel's `dm_key` is a routine room (hidden from people and from agents' channel lists). */
export const isRoutineRoomKey = (dmKey: string | null | undefined) => Boolean(dmKey?.startsWith("routine|"));

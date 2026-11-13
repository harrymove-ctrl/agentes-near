import type { Mission, WorkingRun } from "../api/types";

/**
 * Who is working now, the same on every app: runs in progress in the conversations the person is in and active
 * missions (the phone's Conversas and Agentes, the web's Início).
 */

const ACTIVE = new Set(["queued", "running", "waiting_approval", "waiting_input"]);

/** How often a page that shows who is working asks again: runs start and end in conversations it doesn't follow. */
export const WORKING_POLL_MS = 20_000;

/** Something an agent is on right now. */
export interface WorkItem {
  key: string;
  agentId: string;
  kind: "run" | "mission" | "work";
  /** Mission: its title. Run: its work's or thread's title, never its first message's words (null: say where instead). */
  what: string | null;
  channelId: string;
  /** Null: the main timeline (DMs are flat). */
  threadId: string | null;
  /** Where, for a run without a label: a channel's name, or a DM (no name). */
  where: { kind: "channel" | "dm"; name: string | null };
  missionId: string | null;
  plan: { done: number; total: number } | null;
  /** Since when (the mission's or the run's start, else when it was created). */
  since: string;
  /** A run stopped on a person (your ok, your answer): it isn't working, it waits ("espera seu ok"). */
  waiting: boolean;
}

/**
 * Active missions first (they are long work), then runs in progress (`GET
 * …/active-runs`, everyone's view of the conversations they are in), newest
 * first, one per agent and conversation. A routine's background runs are left out.
 */
export function workingNow(runs: WorkingRun[] | undefined, missions: Mission[] | undefined): WorkItem[] {
  const out: WorkItem[] = [];
  const seen = new Set<string>();
  const spot = (agentId: string, channelId: string, threadId: string | null) => `${agentId}:${threadId ?? channelId}`;
  for (const m of missions ?? []) {
    if (m.status !== "active") continue;
    out.push({
      key: `m:${m.id}`,
      agentId: m.agentId,
      kind: "mission",
      what: m.title,
      channelId: m.channelId,
      threadId: m.threadId,
      where: { kind: "channel", name: null },
      missionId: m.id,
      plan: { done: m.plan.done, total: m.plan.total },
      since: m.startedAt ?? m.createdAt,
      waiting: false,
    });
    seen.add(spot(m.agentId, m.channelId, m.threadId));
  }
  const newest = (r: WorkingRun) => r.startedAt ?? r.createdAt;
  for (const r of [...(runs ?? [])].sort((a, b) => newest(b).localeCompare(newest(a)))) {
    const at = spot(r.agentId, r.channelId, r.threadId);
    // A routine's background run holds no conversation: never "trabalhando" (its report comes as a notice).
    if (r.background || !ACTIVE.has(r.status) || seen.has(at)) continue;
    seen.add(at);
    out.push({
      key: `r:${r.runId}`,
      agentId: r.agentId,
      // Long work (ADR 0121): its title and plan, since it started.
      kind: r.work ? "work" : "run",
      what: r.work?.title || r.label?.trim() || null,
      channelId: r.channelId,
      threadId: r.threadId,
      where: { kind: r.channelKind, name: r.channelName },
      missionId: null,
      plan: r.work?.plan ?? null,
      since: r.work?.since ?? newest(r),
      waiting: r.status === "waiting_approval" || r.status === "waiting_input",
    });
  }
  return out;
}

/** What each working agent is on: its first item (missions come first in `workingNow`). */
export function workByAgent(work: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  return work.filter((w) => !seen.has(w.agentId) && Boolean(seen.add(w.agentId)));
}

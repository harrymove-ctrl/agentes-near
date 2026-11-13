import {
  useApprovals,
  useChannels,
  useDms,
  useMissionList,
  useNotificationCount,
  useTasksUnread,
  useThreadList,
  useWorkingRuns,
} from "@agenteschat/client";
import * as Notifications from "expo-notifications";
import { useEffect, useMemo } from "react";
import { useOrg } from "@/providers/org";
import { busyChannels, workingNow } from "../agents/logic";
import { waitingApprovals } from "../approvals/logic";
import {
  appBadgeCount,
  buildConversations,
  hiddenAgentIds,
  unreadConversationCount,
  unreadThreadCount,
} from "../chats/logic";
import { useDirectory, useNow, useOrgId } from "./hooks";

/**
 * Reads several screens share: who is working, the conversation list, what
 * waits on you (and the tab badges).
 */

/**
 * Everything agents are on: active missions, then agent runs in progress in the
 * conversations you are in (`GET …/active-runs`, for everyone), runs stopped on a person included.
 */
export function useActiveWork() {
  const orgId = useOrgId();
  const runs = useWorkingRuns(orgId);
  const missions = useMissionList(orgId, { status: "active" });
  return useMemo(() => workingNow(runs.data, missions.data?.missions), [runs.data, missions.data]);
}

/** Who is working now: the active work without the runs waiting on a person (those say "espera seu ok"). */
export function useWorkingNow() {
  const all = useActiveWork();
  return useMemo(() => all.filter((w) => !w.waiting), [all]);
}

/** My threads and missions, the latest 50 (Conversas' rows and the Threads tab). */
const THREAD_LIST = { tab: "all", mine: true, limit: 50 } as const;

/** The agents my lists leave out (`hiddenAgentIds`), and whether the directory that names them is still loading. */
export function useHiddenAgents() {
  const org = useOrg().org;
  const dir = useDirectory();
  const hidden = useMemo(() => hiddenAgentIds(org, dir.agents), [dir.agents, org]);
  return { hidden, loading: dir.loading };
}

/** Conversas: channels, DMs and my threads and missions, newest first (agent DMs say who is working). */
export function useConversations() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const threads = useThreadList(orgId, THREAD_LIST);
  const work = useWorkingNow();
  const { hidden, loading: agentsLoading } = useHiddenAgents();
  const rows = useMemo(
    () =>
      buildConversations({
        channels: channels.data ?? [],
        dms: dms.data ?? [],
        threads: threads.data?.pages.flatMap((p) => p.threads) ?? [],
        workingChannels: busyChannels(work),
        hiddenAgents: hidden,
      }),
    [channels.data, dms.data, threads.data, work, hidden],
  );
  const lists = [channels, dms];
  return {
    rows,
    // The directory too: before it names the agents a member doesn't see, their DMs would flash in.
    loading: channels.isLoading || dms.isLoading || agentsLoading,
    // The server didn't answer: nothing to show (`failed`), or the kept rows weren't loaded again (`stale`).
    failed: lists.some((q) => q.isError && !q.data),
    stale: lists.some((q) => q.isError && q.data),
    refetch: () => Promise.all([channels.refetch(), dms.refetch(), threads.refetch()]),
  };
}

/** The badge of Conversas: channels and DMs with something unread (the home's sections; threads have their tab). */
export function useUnreadConversations() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const { hidden, loading } = useHiddenAgents();
  // Like the home, it waits for the directory, so a DM the home leaves out never counts.
  return useMemo(
    () =>
      loading
        ? 0
        : unreadConversationCount({ channels: channels.data ?? [], dms: dms.data ?? [], hiddenAgents: hidden }),
    [channels.data, dms.data, hidden, loading],
  );
}

/** Keeps the app icon's number on the web tab title's total, live while the app runs; 0 once signed out. */
export function useAppIconBadge() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const { hidden, loading } = useHiddenAgents();
  const total =
    loading || !channels.data || !dms.data
      ? null
      : appBadgeCount({ channels: channels.data, dms: dms.data, hiddenAgents: hidden });
  useEffect(() => {
    if (total !== null) void Notifications.setBadgeCountAsync(total).catch(() => {});
  }, [total]);
  // Signed out (the app's stack goes away): no workspace's number stays on the icon.
  useEffect(() => () => void Notifications.setBadgeCountAsync(0).catch(() => {}), []);
}

/** The badge of Threads: thread and mission rows with something unread. */
export function useUnreadThreads() {
  const orgId = useOrgId();
  // The same query as Conversas' list (shared cache); channels and DMs aren't needed for these rows.
  const threads = useThreadList(orgId, THREAD_LIST);
  return useMemo(
    () =>
      unreadThreadCount(
        buildConversations({ channels: [], dms: [], threads: threads.data?.pages.flatMap((p) => p.threads) ?? [] }),
      ),
    [threads.data],
  );
}

/** Tarefas in Você: bold for a reply you haven't read in a task's conversation, its badge for a mention of you there. */
export function useTasksUnreadMarks() {
  return useTasksUnread(useOrgId());
}

/** Requests you may decide now, the one closest to expiring first. */
export function useWaitingApprovals() {
  const orgId = useOrgId();
  const approvals = useApprovals(orgId);
  const now = useNow();
  return useMemo(() => waitingApprovals(approvals.data ?? [], now), [approvals.data, now]);
}

/** The badge of Atividade: what waits on you (the inbox's own count, live through `notification.counts`). */
export function useWaitingCount() {
  const orgId = useOrgId();
  return useNotificationCount(orgId).data?.waiting ?? 0;
}

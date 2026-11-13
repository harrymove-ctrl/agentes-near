import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./context";
import { ApiError } from "./http";
import { keys } from "./keys";
import type {
  BrainKind,
  CommandApproval,
  MachineTask,
  Mission,
  MissionControl,
  MissionCreateInput,
  MissionExecutor,
  MissionListQuery,
  MissionParticipantRole,
} from "./types";

/**
 * React Query hooks for missions (ADR 0029). `mission.updated` and
 * `machine.task` keep them live (realtime/context.tsx); every write puts the
 * fresh mission in the cache and refreshes the lists and the thread.
 */

type QC = ReturnType<typeof useQueryClient>;

/** A mission view came back: the one, its thread's, and every list. */
export function cacheMission(qc: QC, orgId: string, mission: Mission) {
  qc.setQueryData(keys.mission(orgId, mission.id), mission);
  qc.setQueryData(keys.threadMission(orgId, mission.threadId), mission);
  void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "list"] });
  void qc.invalidateQueries({ queryKey: keys.threads(orgId), predicate: (q) => q.queryKey[3] !== "one" });
}

/** The sidebar's count of the missions waiting for me (`counts.waitingYou`): the device's snapshot keeps it. */
export const MISSIONS_WAITING_COUNT: MissionListQuery = { status: "waiting_you", limit: 1 };

/** The Missões tab (server filters) and the sidebar's count (`counts.waitingYou`): open missions by default. */
export function useMissionList(orgId: string, query: MissionListQuery = { status: "open" }, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.missionList(orgId, JSON.stringify(query)),
    queryFn: () => api.missions.list(orgId, query),
    enabled,
    staleTime: 15_000,
    placeholderData: (previous) => previous,
  });
}

/** "Nova missão": every agent, each saying whether it can run one for me and why not. */
export function useEligibleAgents(orgId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.missions(orgId), "eligible"],
    queryFn: () => api.missions.eligibleAgents(orgId),
    enabled,
    // Fresh each time the dialog opens: a computer just chosen for an agent shows at once.
    staleTime: 0,
  });
}

/** "Ver saída": the last lines of a task (from the computer when it is online). */
export function useTaskOutput(orgId: string, taskId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: [...keys.missions(orgId), "output", taskId],
    queryFn: () => api.missions.taskOutput(orgId, taskId, 100),
    enabled,
    staleTime: 5_000,
  });
}

export function useMission(orgId: string, missionId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.mission(orgId, missionId ?? ""),
    queryFn: () => api.missions.get(orgId, missionId ?? ""),
    enabled: Boolean(missionId),
    staleTime: 15_000,
  });
}

/** The mission of a thread: null when it has none (`mission.not_found`), no error. */
export function useThreadMission(orgId: string, threadId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.threadMission(orgId, threadId ?? ""),
    queryFn: async (): Promise<Mission | null> => {
      try {
        return await api.missions.ofThread(orgId, threadId ?? "");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(threadId) && enabled,
    staleTime: 15_000,
  });
}

/** The thread's background tasks (one row per session), newest first. */
export function useThreadTasks(orgId: string, threadId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: keys.threadTasks(orgId, threadId ?? ""),
    queryFn: () => api.missions.threadTasks(orgId, threadId ?? ""),
    enabled: Boolean(threadId) && enabled,
    staleTime: 30_000,
  });
}

/** A `machine.task` event: replace that task in the thread's list. */
export function cacheTask(qc: QC, orgId: string, task: MachineTask) {
  if (!task.threadId) return;
  qc.setQueryData<MachineTask[]>(keys.threadTasks(orgId, task.threadId), (old) =>
    old ? [task, ...old.filter((x) => x.id !== task.id)] : old,
  );
}

function useMissionPart<T>(
  orgId: string,
  missionId: string | null | undefined,
  name: string,
  load: () => Promise<T>,
  enabled = true,
) {
  return useQuery({
    queryKey: keys.missionPart(orgId, missionId ?? "", name),
    queryFn: load,
    enabled: Boolean(missionId) && enabled,
    staleTime: 15_000,
  });
}

export function useMissionDecisions(orgId: string, missionId: string | null | undefined) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "decisions", () => api.missions.decisions(orgId, missionId ?? ""));
}
/** The executor's command prompts (the command cards) and the commands allowed for the whole mission. */
export function useMissionCommands(orgId: string, missionId: string | null | undefined) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "commands", () => api.missions.commands(orgId, missionId ?? ""));
}
/** The delivery cards (`complete_mission`, or the automatic "Tudo pronto"), newest first. */
export function useMissionDeliveries(orgId: string, missionId: string | null | undefined) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "deliveries", () => api.missions.deliveries(orgId, missionId ?? ""));
}
export function useMissionReviews(orgId: string, missionId: string | null | undefined) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "reviews", () => api.missions.reviews(orgId, missionId ?? ""));
}
export function useMissionFiles(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "files", () => api.missions.files(orgId, missionId ?? ""), enabled);
}
export function useMissionPlan(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "plan", () => api.missions.plan(orgId, missionId ?? ""), enabled);
}
export function useMissionParticipants(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(
    orgId,
    missionId,
    "participants",
    () => api.missions.participants(orgId, missionId ?? ""),
    enabled,
  );
}

/** Pending requests to join (the Compartilhar dialog; the pinned card's count). */
export function useMissionJoinRequests(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(
    orgId,
    missionId,
    "joinRequests",
    () => api.missions.joinRequests(orgId, missionId ?? ""),
    enabled,
  );
}

/** "Pedir para participar". */
export function useRequestJoin(orgId: string, missionId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: () => api.missions.requestJoin(orgId, missionId),
    onSuccess: () => refreshMission(qc, orgId, missionId, ["joinRequests"]),
  });
}

/** Aceitar (with a role) or Recusar a request to join. */
export function useDecideJoin(orgId: string, missionId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({
      userId,
      outcome,
      role,
    }: {
      userId: string;
      outcome: "accept" | "decline";
      role?: MissionParticipantRole;
    }) => api.missions.decideJoin(orgId, missionId, userId, outcome, role),
    onSuccess: () => refreshMission(qc, orgId, missionId, ["joinRequests", "participants"]),
  });
}

/** Refetch what a mission change touches (one part, or all of them). */
export function refreshMission(qc: QC, orgId: string, missionId: string, parts?: string[]) {
  void qc.invalidateQueries({ queryKey: keys.mission(orgId, missionId) });
  void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "thread"] });
  void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "list"] });
  if (!parts) void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "part", missionId] });
  else for (const p of parts) void qc.invalidateQueries({ queryKey: keys.missionPart(orgId, missionId, p) });
}

export function useCreateMission(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (input: MissionCreateInput) => api.missions.create(orgId, input),
    onSuccess: (mission) => cacheMission(qc, orgId, mission),
  });
}

/** "Quem programa", before Start (the owner's). */
export function useSetMissionExecutor(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ missionId, executor }: { missionId: string; executor: MissionExecutor }) =>
      api.missions.setExecutor(orgId, missionId, executor),
    onSuccess: (mission) => {
      cacheMission(qc, orgId, mission);
      void qc.invalidateQueries({ queryKey: keys.threadTasks(orgId, mission.threadId) });
    },
  });
}

/** Autonomia (and Revogar on an automatic approval: back to always). The mission shows the new value at once. */
export function useSetCommandApproval(orgId: string, missionId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (commandApproval: CommandApproval) =>
      api.missions.setCommandApproval(orgId, missionId, commandApproval),
    onSuccess: (out) => {
      patchMission(qc, orgId, missionId, { commandApproval: out.commandApproval });
      refreshMission(qc, orgId, missionId, ["settings"]);
    },
  });
}

/** A field changed: the cached mission (by id and by thread) shows it before the refetch. */
function patchMission(qc: QC, orgId: string, missionId: string, patch: Partial<Mission>) {
  const one = qc.getQueryData<Mission>(keys.mission(orgId, missionId));
  if (one) qc.setQueryData(keys.mission(orgId, missionId), { ...one, ...patch });
  for (const [key, value] of qc.getQueriesData<Mission | null>({ queryKey: [...keys.missions(orgId), "thread"] })) {
    if (value && value.id === missionId) qc.setQueryData(key, { ...value, ...patch });
  }
}

/** "Configurações da missão": the allowed rules, what happened to its commands, the agent's default. */
export function useMissionSettings(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "settings", () => api.missions.settings(orgId, missionId ?? ""), enabled);
}

/** "Quem faz o trabalho": the brain and its model (the dialog's model select). */
export function useMissionBrain(orgId: string, missionId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useMissionPart(orgId, missionId, "brain", () => api.missions.brain(orgId, missionId ?? ""), enabled);
}

/** The model of who does the work (any time while open); the brain only before Start. */
export function useSetMissionBrain(orgId: string, missionId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (input: { brain?: BrainKind | null; model?: string | null }) =>
      api.missions.setBrain(orgId, missionId, input),
    onSuccess: (brain) => qc.setQueryData(keys.missionPart(orgId, missionId, "brain"), brain),
  });
}

/** The × in "O que já foi liberado". */
export function useRemoveCommandRule(orgId: string, missionId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (ruleId: string) => api.missions.removeCommandRule(orgId, missionId, ruleId),
    onSuccess: () => refreshMission(qc, orgId, missionId, ["settings", "commands"]),
  });
}

/** "Retomar sozinho quando ele voltar". */
export function useSetResumeTasks(orgId: string, missionId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (resumeTasks: boolean) => api.missions.setResumeTasks(orgId, missionId, resumeTasks),
    onSuccess: (mission) => cacheMission(qc, orgId, mission),
  });
}

/** "Usar como padrão" for the agent's next missions. */
export function useSetAgentMissionDefault(orgId: string, missionId: string, agentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: (commandApproval: CommandApproval) => api.missions.setAgentDefault(orgId, agentId, commandApproval),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.missionPart(orgId, missionId, "settings") });
      void qc.invalidateQueries({ queryKey: [...keys.missions(orgId), "eligible"] });
    },
  });
}

/** Começar, Pausar, Retomar, Parar. Errors are the caller's to say (translated by code). */
export function useMissionControl(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({ missionId, action }: { missionId: string; action: MissionControl }) =>
      api.missions.control(orgId, missionId, action),
    onSuccess: (mission) => {
      cacheMission(qc, orgId, mission);
      void qc.invalidateQueries({ queryKey: keys.threadTasks(orgId, mission.threadId) });
    },
  });
}

export function useCloseMission(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: ({
      missionId,
      ...input
    }: {
      missionId: string;
      outcome: "done" | "canceled";
      saveToWiki?: boolean;
      note?: string;
      /** Canceling: "Apagar tudo" (else the branch stays). */
      deleteBranch?: boolean;
    }) => api.missions.close(orgId, missionId, input),
    onSuccess: (mission) => {
      cacheMission(qc, orgId, mission);
      void qc.invalidateQueries({ queryKey: keys.threadInfo(orgId, mission.threadId) });
    },
  });
}

/** "Tentar de novo": prepare the mission's copy of the project again after it failed (ADR 0044). */
export function useRetryMissionWorktree(orgId: string, missionId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: () => api.missions.retryWorktree(orgId, missionId),
    onSuccess: (mission) => {
      cacheMission(qc, orgId, mission);
      void qc.invalidateQueries({ queryKey: keys.threadTasks(orgId, mission.threadId) });
    },
  });
}

/** Decide, review, suggestions, approve provisional: one mutation that refreshes the mission after. */
export function useMissionAct<I, O>(orgId: string, missionId: string, run: (input: I) => Promise<O>) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silent: true },
    mutationFn: run,
    onSuccess: () => refreshMission(qc, orgId, missionId),
  });
}

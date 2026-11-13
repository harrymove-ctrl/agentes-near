import type { LiveRun, Message } from "@agenteschat/client";
import { ApiError, continuedRunIdOf, keys, useContinuedRun, workingSinceOf } from "@agenteschat/client";
import { activityVerb, toolActivity } from "@agenteschat/client/lib/activity";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { playSound } from "@agenteschat/client/lib/sounds";
import { PixelStop, Spinner } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useLive, useLiveStore } from "@/realtime/context";

/** Still working (thinking, writing or running a tool), not stopped yet. */
export const isStoppable = (r: LiveRun) =>
  !r.provisional && (r.status === "thinking" || r.status === "queued" || r.status === "running");

/** What decides who may stop (or continue) a run: its agent and the message that started it. */
type RunOwner = Pick<LiveRun, "agentId" | "channelId" | "threadId"> & { triggerMessageId?: string | null };

/**
 * "Parar" for a run: who may press it (the person whose message started it,
 * the agent's owner, admins) and the stop itself. Stopping is immediate (no
 * confirmation): what the agent did stays, and "Continuar" picks it up again.
 */
export function useStopRun() {
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const live = useLiveStore();
  const dir = useDirectory(org.id);
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(org.id, runId),
    onMutate: (runId) => live.stopping(runId, me.user.id),
    onError: (err, runId) => {
      // 409 `run_finished`: it ended on its own meanwhile; its message is on the way (or already here).
      if (err instanceof ApiError && err.status === 409) {
        const r = live.get().streams.runs[runId];
        live.dismiss(runId);
        if (r) void qc.invalidateQueries({ queryKey: keys.messages(org.id, r.channelId) });
        return;
      }
      live.unstopping(runId);
    },
  });
  const startedByMe = (r: RunOwner) => {
    const list = qc.getQueryData<Message[]>(keys.messages(org.id, r.channelId)) ?? [];
    const root = list.find((m) => m.id === (r.triggerMessageId ?? r.threadId));
    return root?.author.type === "person" && root.author.id === me.user.id;
  };
  const canStop = (r: RunOwner) =>
    can(org, "manage_agents") || dir.agentById.get(r.agentId)?.ownerUserId === me.user.id || startedByMe(r);
  return {
    canStop,
    stop: (r: LiveRun) => {
      playSound("stop");
      stop.mutate(r.runId);
    },
  };
}

/**
 * "Continuar" under a stopped answer: a new run of the same agent picks up
 * from where it stopped. The button goes away for everyone once it is
 * continued (`run.continued`, or `meta.canceled.continuedRunId` on reload).
 */
export function useContinueRun() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const live = useLiveStore();
  const toast = useToast();
  return useMutation({
    mutationFn: (runId: string) => api.agents.continueRun(org.id, runId),
    onSuccess: (out, runId) => live.continued(runId, out.runId),
    onError: (err, runId) => {
      // 409: already continued (by someone else) or the agent is busy here: the button has no job left.
      if (err instanceof ApiError && err.status === 409) live.continued(runId, null);
      toast.show(errorText(t, err), "error");
    },
  });
}

/** This stopped run was already continued (here, by someone else, or before a reload). */
export function useWasContinued(runId: string | null | undefined, message?: Pick<Message, "id" | "meta">) {
  const here = useLive((s) => (runId ? s.continued[runId] : undefined));
  const heard = useContinuedRun(message?.id ?? "");
  return here !== undefined || Boolean(heard) || Boolean(message && continuedRunIdOf(message));
}

/** "rodando código há 2 min", "escrevendo a resposta", "pensando há 1 min". */
export function runContext(t: TFunction, run: LiveRun, now = Date.now()) {
  const ago = (since: number | undefined) => {
    const min = Math.floor((now - (since ?? now)) / 60_000);
    return min < 1 ? t("run.ctx.lessThanMin") : t("run.ctx.minutes", { count: min });
  };
  const call = [...(run.work ?? [])].reverse().find((w) => w.kind === "call" && w.running);
  if (call?.kind === "call") {
    const doing = toolActivity(call.tool, call.connector, call.detail, call);
    return call.code || doing.kind === "runningCode"
      ? t("run.ctx.code", { time: ago(call.since) })
      : t("run.ctx.tool", { doing: activityVerb(t, doing), time: ago(call.since) });
  }
  if (run.status === "running") return t("run.ctx.writing");
  return t("run.ctx.thinking", { time: ago(workingSinceOf(run)) });
}

/**
 * The small "Parar" (a pixel stop square; a danger tint only on hover). A
 * click stops right away; it spins with "Parando…" until the server says so.
 * The chat stops from its composer too; this one sits on a run's row and bar.
 */
export function StopButton({ run, onStop }: { run: LiveRun; onStop: (r: LiveRun) => void; place?: string }) {
  const { t } = useTranslation();
  return (
    <span className="stop-run-wrap">
      <button
        type="button"
        className="stop-run"
        title={t("run.stopHint")}
        aria-label={run.stopping ? t("run.stopping") : t("run.stop")}
        disabled={run.stopping}
        data-stopping={run.stopping || undefined}
        onClick={() => onStop(run)}
      >
        {run.stopping ? <Spinner size={14} /> : <PixelStop size={12} />}
      </button>
      {run.stopping && (
        <span className="stop-run__label small muted" aria-hidden="true">
          {t("run.stopping")}
        </span>
      )}
    </span>
  );
}

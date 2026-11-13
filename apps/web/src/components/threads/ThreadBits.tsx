import type { ThreadAction, ThreadInfo } from "@agenteschat/client";
import { keys, useThreadMutation } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { type ThreadStatus, threadStatus, threadTitle } from "@agenteschat/client/lib/threads";
import { Button, Chip, Dialog, DialogFooter, type IconName } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/**
 * Pieces every thread screen shares: the
 * state chip, and closing / archiving with a toast and "Desfazer" (plus the
 * question when an agent is still working there).
 */

const STATUS_ICON: Record<ThreadStatus, IconName> = {
  needsYou: "waiting",
  working: "spinner",
  open: "thread",
  closed: "check",
  archived: "archiveBox",
};

/** "Esperando você", "Trabalhando", "Aberta", "Fechada", "Arquivada": an icon and a word, never a dot. */
export function ThreadStatusChip({
  thread,
  className,
}: {
  thread: Pick<ThreadInfo, "state" | "working" | "needsYou">;
  className?: string;
}) {
  const { t } = useTranslation();
  const status = threadStatus(thread);
  return (
    <Chip icon={STATUS_ICON[status]} tone={status === "needsYou" ? "waiting" : "neutral"} className={className}>
      {t(`threads.status.${status}`)}
    </Chip>
  );
}

/** The action that undoes another (archive → unarchive goes back to open or closed on the server). */
const UNDO: Partial<Record<ThreadAction, ThreadAction>> = {
  close: "reopen",
  reopen: "close",
  archive: "unarchive",
  unarchive: "archive",
  move: "return",
  return: "move",
};

/**
 * Fechar / Reabrir / Arquivar / Desarquivar (and Tirar do canal / Devolver)
 * on one or more threads: the request, a glass toast with "Desfazer", and,
 * when an agent is still working in one of them, the question "Parar e
 * fechar / Deixar terminar e fechar depois / Cancelar" (`dialog`).
 *
 * "Deixar terminar" closes now: the run keeps going and its reply lands in
 * the closed thread without reopening it (only a person's reply reopens one).
 * The server has no "close when done" yet (ADR 0029, "Not yet").
 */
export function useThreadControls() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const mutation = useThreadMutation(org.id);
  const [asking, setAsking] = useState<{ threads: ThreadInfo[]; action: "close" | "archive" } | null>(null);

  /** Stops the agent runs still going in these threads (the same "Parar" as the chat's). */
  const stopWork = async (threads: ThreadInfo[]) => {
    for (const thread of threads.filter((x) => x.working)) {
      const runs = (await api.agents.activeRuns(org.id, thread.channelId).catch(() => null)) ?? [];
      await Promise.all(
        runs
          .filter((r) => r.threadId === thread.id)
          .map((r) => api.agents.cancelRun(org.id, r.runId).catch(() => undefined)),
      );
    }
    void qc.invalidateQueries({ queryKey: keys.threads(org.id) });
  };

  const run = async (threads: ThreadInfo[], action: ThreadAction, options: { undo?: boolean } = {}) => {
    const done: ThreadInfo[] = [];
    for (const thread of threads) {
      try {
        done.push((await mutation.mutateAsync({ type: "action", thread, action })) ?? thread);
      } catch (error) {
        toast.show(errorText(t, error), "error");
      }
    }
    if (done.length === 0 || options.undo === false) return done;
    const one = done.length === 1 ? done[0] : undefined;
    const back = UNDO[action];
    toast.show(
      one
        ? t(`threads.toast.${action}`, { title: threadTitle(one), channel: one.channelName })
        : t(`threads.toast.${action}Many`, { count: done.length }),
      "info",
      back ? { label: t("threads.undo"), run: () => void run(done, back, { undo: false }) } : undefined,
    );
    return done;
  };

  /** Asks first when someone is still working in a thread that would close or be archived. */
  const request = (threads: ThreadInfo[], action: ThreadAction) => {
    if ((action === "close" || action === "archive") && threads.some((x) => x.working)) {
      setAsking({ threads, action });
      return;
    }
    void run(threads, action);
  };

  const working = asking?.threads.filter((x) => x.working) ?? [];
  const dialog = (
    <Dialog
      open={Boolean(asking)}
      onOpenChange={(o) => !o && setAsking(null)}
      title={
        working.length === 1 && working[0]
          ? t("threads.work.titleOne", { title: threadTitle(working[0]) })
          : t("threads.work.titleMany", { count: working.length })
      }
      description={t(`threads.work.text.${asking?.action ?? "close"}`)}
      closeLabel={t("common.close")}
      width={520}
    >
      <DialogFooter>
        <Button onClick={() => setAsking(null)}>{t("common.cancel")}</Button>
        <Button
          icon="stop"
          onClick={() => {
            const a = asking;
            setAsking(null);
            if (a) void stopWork(a.threads).then(() => run(a.threads, a.action));
          }}
        >
          {t(`threads.work.stop.${asking?.action ?? "close"}`)}
        </Button>
        <Button
          variant="primary"
          icon="clock"
          onClick={() => {
            const a = asking;
            setAsking(null);
            if (a) void run(a.threads, a.action);
          }}
        >
          {t(`threads.work.later.${asking?.action ?? "close"}`)}
        </Button>
      </DialogFooter>
    </Dialog>
  );
  return { request, run, dialog, pending: mutation.isPending };
}

/**
 * After "Criar thread a partir daqui": open the thread and say so, with
 * "Ajustar" (the selection on the channel) and "Desfazer" (deletes it while
 * nobody replied). Built on the router, the API and the cache directly so the
 * toast still works after the channel it came from is gone.
 */
export function useThreadFlows() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const orgId = org.id;

  const openThread = (threadId: string) =>
    void router.navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId, threadId } });
  const adjust = (thread: ThreadInfo) =>
    void router.navigate({
      to: "/org/$orgId/c/$channelId",
      params: { orgId, channelId: thread.context?.channelId ?? thread.channelId },
      search: { adjust: thread.id },
    });
  const undoCreate = async (thread: ThreadInfo) => {
    try {
      await api.threads.remove(orgId, thread.id);
    } catch (error) {
      toast.show(errorText(t, error), "error");
      return;
    }
    qc.removeQueries({ queryKey: keys.threadInfo(orgId, thread.id) });
    void qc.invalidateQueries({ queryKey: keys.threads(orgId) });
    void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", thread.channelId] });
    if (router.state.location.pathname.includes(thread.id)) {
      void router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId, channelId: thread.channelId } });
    }
    toast.show(t("threads.toast.undone"));
  };
  const created = (thread: ThreadInfo) => {
    openThread(thread.id);
    toast.show(t("threads.toast.created", { count: thread.context?.count ?? 0 }), "info", [
      { label: t("threads.adjustAction"), run: () => adjust(thread) },
      { label: t("threads.undo"), run: () => void undoCreate(thread) },
    ]);
  };
  return { openThread, adjust, undoCreate, created };
}

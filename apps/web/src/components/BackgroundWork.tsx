import { type Issue, type Message, useChannels, type WorkView } from "@agenteschat/client";
import { heldBack } from "@agenteschat/client/lib/issues";
import { workLine, workPlanProgress, workWaitsOnPerson } from "@agenteschat/client/lib/long-work";
import { can } from "@agenteschat/client/lib/permissions";
import { WorkLine, WorkLineAction, WorkPlan } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useChannelActions } from "@/components/channel-actions";
import { useNow } from "@/components/missions/MissionBits";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/** The line of a long work (ADR 0121) and its actions, the same under the anchor and on the card. */
function useWorkLine(work: WorkView, inUpdatesThread = false) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const live = work.status === "live" || work.status === "queued";
  // A live work's minutes move every half minute.
  const now = new Date(useNow(live, 30_000));
  const agent = dir.agentById.get(work.agentId);
  // As `mayStopRun` decides (who asked, the agent's owner, an admin); the server has the last word, said in a toast.
  const canStop =
    can(org, "manage_agents") || agent?.ownerUserId === me.user.id || work.requestedByUserId === me.user.id;
  const stop = useMutation({
    mutationFn: (runId: string) => api.agents.cancelRun(org.id, runId),
    onError: () => toast.show(t("work.stopFailed"), "error"),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["org", org.id, "channel", work.channelId] }),
  });
  const view = workLine(t, work, {
    locale: i18n.language,
    now,
    meId: me.user.id,
    agentName: agent?.name ?? t("channel.unknownAgent"),
    nameOf: (id) => dir.memberById.get(id)?.name ?? null,
    canStop,
    inUpdatesThread,
  });
  return { view, stop, t };
}

/**
 * Under the agent's "Vou cuidar disso": how the work stands, its last update or what it asks, Tarefa #, Parar, Ver
 * resultado. Once its thread has replies, the thread's own line under it opens the thread (`threaded`): no second way
 * in, unless it waits on someone, who goes straight to the card in the panel. In a thread view (`inThread`) its
 * updates are the messages right under it: the line doesn't repeat the last one.
 */
export function MessageWorkLine({
  message,
  threaded,
  inThread,
}: {
  message: Message;
  threaded?: boolean;
  inThread?: boolean;
}) {
  const work = message.longWork;
  if (!work) return null;
  return <AnchorLine work={work} threaded={Boolean(threaded)} inThread={Boolean(inThread)} />;
}

function AnchorLine({ work, threaded, inThread }: { work: WorkView; threaded: boolean; inThread: boolean }) {
  const { org } = useOrg();
  const navigate = useNavigate();
  const actions = useChannelActions();
  const { view, stop, t } = useWorkLine(work, inThread);
  return (
    <WorkLine
      tone={view.tone}
      text={view.text}
      update={view.update}
      question={view.question?.text}
      actions={
        <>
          {view.threadId && (!threaded || workWaitsOnPerson(work)) && actions?.openThread && (
            <WorkLineAction
              onClick={() => actions.openThread?.(view.threadId as string, view.question?.messageId ?? undefined)}
            >
              {t("work.openThread")}
            </WorkLineAction>
          )}
          {view.task && (
            <WorkLineAction
              onClick={() =>
                void navigate({
                  to: "/org/$orgId/issues/$number",
                  params: { orgId: org.id, number: String(view.task?.number) },
                })
              }
            >
              {view.task.label}
            </WorkLineAction>
          )}
          {view.result && (
            <WorkLineAction onClick={() => actions?.jumpTo?.(view.result?.messageId as string)}>
              {view.result.label}
            </WorkLineAction>
          )}
          {view.stop && (
            <WorkLineAction danger disabled={stop.isPending} onClick={() => stop.mutate(view.stop?.runId as string)}>
              {t("work.stop")}
            </WorkLineAction>
          )}
        </>
      }
    />
  );
}

/** On a card that tracks background work: its line, the agent's plan, Abrir conversa, Parar, Mostrar para todos. */
export function IssueWorkBlock({ issue }: { issue: Issue }) {
  const work = issue.backgroundWork;
  if (!work) return null;
  return <CardBlock issue={issue} work={work} />;
}

function CardBlock({ issue, work }: { issue: Issue; work: WorkView }) {
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const { view, stop, t } = useWorkLine(work);
  const progress = workPlanProgress(work);
  const share = useMutation({
    mutationFn: () => api.issues.share(org.id, issue.id),
    onSuccess: () => {
      toast.show(t("work.shared"));
      void qc.invalidateQueries({ queryKey: ["org", org.id, "issues"] });
    },
    onError: () => toast.show(t("work.shareFailed"), "error"),
  });
  // Only a card a DM or a private channel holds back, for who may show it (who asked, its creator, an admin).
  const held = heldBack(issue, channels.data);
  const mayShare =
    work.requestedByUserId === me.user.id ||
    (issue.createdBy.type === "person" && issue.createdBy.id === me.user.id) ||
    can(org, "manage_agents");
  const openConversation = () =>
    view.threadId
      ? void navigate({
          to: "/org/$orgId/threads/$threadId",
          params: { orgId: org.id, threadId: view.threadId },
          search: view.question?.messageId ? { m: view.question.messageId } : {},
        })
      : void navigate({
          to: "/org/$orgId/c/$channelId",
          params: { orgId: org.id, channelId: work.channelId },
          search: { m: work.anchorMessageId },
        });
  return (
    <div className="issue-work-block">
      <WorkLine
        tone={view.tone}
        text={view.text}
        update={view.update ? `${t("work.lastUpdate")}: ${view.update}` : null}
        question={view.question?.text}
        actions={
          <>
            <WorkLineAction onClick={openConversation}>{t("work.openThread")}</WorkLineAction>
            {view.stop && (
              <WorkLineAction danger disabled={stop.isPending} onClick={() => stop.mutate(view.stop?.runId as string)}>
                {t("work.stop")}
              </WorkLineAction>
            )}
            {held && mayShare && (
              <WorkLineAction disabled={share.isPending} onClick={() => share.mutate()}>
                {t("work.shareEveryone")}
              </WorkLineAction>
            )}
          </>
        }
      />
      {work.plan.length > 0 && (
        <WorkPlan
          label={t("work.plan")}
          progress={progress ? t("work.planProgress", progress) : undefined}
          items={work.plan.map((p) => ({ key: p.id, text: p.text, state: p.state }))}
        />
      )}
    </div>
  );
}

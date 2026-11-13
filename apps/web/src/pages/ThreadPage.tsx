import { ApiError, useThreadInfo, useThreadMission } from "@agenteschat/client";
import { isOpenMission } from "@agenteschat/client/lib/missions";
import { EmptyState } from "@agenteschat/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState } from "@/components/Loading";
import { Main } from "@/components/Main";
import { MissionJoinNote, MissionThreadHeader } from "@/components/missions/MissionHeader";
import { useOrg } from "@/components/org-context";
import { TaskConversationHeader } from "@/components/TaskConversationHeader";
import { ArchivedNote, ContextBlock, ThreadHeader, ThreadOrigin } from "@/components/threads/ThreadView";
import { useEscClose } from "@/hooks/useEscClose";
import { ChannelPage, ChannelSkeleton } from "./ChannelPage";

/**
 * A thread: its header, where it came from and its
 * context block on top, then its conversation with the channel's own rows,
 * live runs and composer (ChannelPage in thread mode). Archived: read only.
 * A mission's thread has the mission as its header (plan strip, what runs, sessions).
 * `onClose`: shown in the panel beside its channel, not as a page.
 */
export function ThreadPage({
  threadId,
  reply,
  focusMessageId,
  onClose,
  onGone,
  onBack,
  onSeeInChannel,
}: {
  threadId: string;
  reply?: boolean;
  /** Open at this message (a card someone was sent to). */
  focusMessageId?: string;
  onClose?: () => void;
  /** In the panel: the thread doesn't exist or isn't mine to read (an old link), so the panel gives way. */
  onGone?: () => void;
  /** In the panel, opened from the search's results: back to them (Esc too). */
  onBack?: () => void;
  /** In the panel: "Ver em #canal" jumps to this message in the channel beside it instead of navigating (false: not
   * that channel's thread). */
  onSeeInChannel?: (messageId: string, channelId: string) => boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  useEscClose(onBack ?? onClose);
  const info = useThreadInfo(org.id, threadId);
  const thread = info.data;
  // A thread with a mission (ADR 0029): the mission header; who only reads gets a note.
  const mission = useThreadMission(org.id, threadId).data ?? null;
  const loaded = Boolean(thread);
  // "Responder" (a closed thread's line, a message in the channel): straight to the composer.
  useEffect(() => {
    if (!reply || !loaded) return;
    const timer = setTimeout(() => document.getElementById(`composer-${threadId}`)?.focus(), 80);
    return () => clearTimeout(timer);
  }, [reply, loaded, threadId]);
  const gone = info.error instanceof ApiError && (info.error.status === 404 || info.error.status === 403);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when found gone; the handler changes every render
  useEffect(() => {
    if (gone) onGone?.();
  }, [gone]);
  // Not in any list this device holds yet (a link, a notification): the thread's own skeleton, once.
  if (info.isPending) return <ChannelSkeleton thread panel={Boolean(onClose)} />;
  if (!thread) {
    const body = gone ? (
      <div className="page page--mid">
        <EmptyState icon="thread" title={t("threads.view.notFoundTitle")}>
          {t("threads.view.notFound")}
        </EmptyState>
      </div>
    ) : (
      <ErrorState error={info.error} onRetry={() => void info.refetch()} />
    );
    return onClose ? <section className="thread-panel__missing">{body}</section> : <Main>{body}</Main>;
  }
  const archived = thread.state === "archived";
  // A task's conversation (ADR 0145): its own header and box; the task's screen around it is its title and state.
  const task = thread.channelKind === "task";
  return (
    <ChannelPage
      channelId={thread.channelId}
      thread={thread}
      focusMessageId={focusMessageId}
      // A DM isn't in the channel list: the thread's own view of where it lives is enough here.
      fallback={{
        id: thread.channelId,
        name: thread.channelName,
        topic: "",
        visibility: "private",
        isMember: true,
        createdAt: thread.createdAt,
      }}
      chrome={{
        // A mission's thread: its header is the mission's (no card floating over the messages).
        header: task ? (
          <TaskConversationHeader thread={thread} onClose={onClose} />
        ) : mission && !onClose ? (
          <MissionThreadHeader thread={thread} mission={mission} />
        ) : (
          <ThreadHeader thread={thread} onClose={onClose} onBack={onBack} onSeeInChannel={onSeeInChannel} />
        ),
        top: (
          <>
            <ThreadOrigin thread={thread} />
            <ContextBlock thread={thread} />
          </>
        ),
        composerNote:
          mission && isOpenMission(mission) && mission.role === "none" ? (
            <MissionJoinNote mission={mission} />
          ) : undefined,
        composerLabel: task ? t("issues.commentPlaceholder") : t("threads.view.composer"),
        composerReplacement: archived ? <ArchivedNote thread={thread} /> : undefined,
        panel: Boolean(onClose),
        // A person's reply here makes it a "Responder" thread (its replies leave the channel's timeline),
        // except a mission's or a range's, which the channel already shows as their own card or marker.
        openThread: !task && !thread.mission && !thread.context,
        task,
      }}
    />
  );
}

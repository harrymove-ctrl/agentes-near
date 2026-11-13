import type { Actor, Message, ThreadInfo, ThreadStartMeta } from "@agenteschat/client";
import { runsInChannel, useChannelThreads } from "@agenteschat/client";
import { formatTime, relativeTime } from "@agenteschat/client/lib/format";
import { type ThreadStatus, threadMessageCount, threadStatus, threadTitle } from "@agenteschat/client/lib/threads";
import { AvatarStack, Button, CountBadge, Icon, Popover } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { actorKey, useActors } from "@/components/actors";
import { useChannelActions } from "@/components/channel-actions";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useStreams } from "@/realtime/context";
import { ThreadStatusChip } from "./ThreadBits";
import "./threads.css";

/**
 * What a channel shows of its threads:
 * the quiet marker where a range became a thread's context, the stub once it
 * left the channel, one line per closed thread, and "Threads (N)" in the header.
 */

export interface ChannelThreadsView {
  /** This channel's threads by root id (open and closed; archived ones aren't shown). */
  byId: Map<string, ThreadInfo>;
  /** Messages that are a thread's context and still in the channel: the gutter mark. */
  marks: Set<string>;
  /** The thread open in the panel beside the channel (its line shows pressed). */
  open: string | null;
  /** "Responder" threads by the message their line sits under, with how many replies went to the panel. */
  lines: Map<string, { thread: ThreadInfo; count: number }>;
}

export const ChannelThreadsContext = createContext<ChannelThreadsView | null>(null);
export const useChannelThreadsView = () => useContext(ChannelThreadsContext);

/**
 * "Abrir" for a thread: in a channel, the panel beside it; elsewhere, the
 * thread's own page. `reply` goes straight to its composer.
 */
function OpenThread({
  threadId,
  reply,
  pressed,
  className,
  children,
}: {
  threadId: string;
  reply?: boolean;
  /** Open in the panel right now. */
  pressed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { org } = useOrg();
  const actions = useChannelActions();
  if (actions?.openThread) {
    return (
      <button type="button" className={className} aria-pressed={pressed} onClick={() => actions.openThread?.(threadId)}>
        {children}
      </button>
    );
  }
  return (
    <Link
      className={className}
      to="/org/$orgId/threads/$threadId"
      params={{ orgId: org.id, threadId }}
      search={reply ? { reply: true } : undefined}
    >
      {children}
    </Link>
  );
}

/**
 * Under a message someone answered with "Responder":
 * who is in it, "N respostas", what it needs (Esperando você / Trabalhando) and the last reply's
 * time. Opens the thread in the panel beside the channel; pressed while open there.
 */
export function ThreadReplyLine({ thread, count }: { thread: ThreadInfo; count: number }) {
  const { t } = useTranslation();
  const view = useChannelThreadsView();
  // A run in the thread right now (the list's `working` lags until it refetches).
  const live = useStreams((s) => runsInChannel(s, thread.channelId).some((r) => r.threadId === thread.id));
  const status = threadStatus({ ...thread, working: thread.working || live });
  const people = thread.participants.flatMap((p) => (p.id ? [{ type: p.type, id: p.id }] : []));
  const at = thread.lastMessage?.createdAt ?? thread.lastActivityAt;
  const replies = t("threads.line.replies", { count });
  const open = view?.open === thread.id;
  return (
    <OpenThread threadId={thread.id} className="thread-line" pressed={open}>
      <ThreadLineBody people={people} label={replies} status={status} at={at} />
    </OpenThread>
  );
}

/**
 * The words of a thread line (inside `.thread-line`), for a "Responder" thread and a task's conversation alike: who
 * is in it (three framed faces, agents and people one size), the count, what it needs, when it last moved.
 */
export function ThreadLineBody({
  people,
  label,
  status,
  at,
}: {
  people: Actor[];
  label: string;
  status?: ThreadStatus;
  at?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  return (
    <>
      <span className="thread-line__who" aria-hidden="true">
        <AvatarStack>
          {people.slice(0, 3).map((p) => (
            <ActorAvatar key={actorKey(p)} actor={p} name={actors.name(p)} size="xs" framed />
          ))}
        </AvatarStack>
      </span>
      <b>{label}</b>
      {(status === "needsYou" || status === "working") && (
        <span className={`thread-line__state thread-line__state--${status}`}>
          <Icon name={status === "needsYou" ? "waiting" : "bolt"} size={14} />
          {t(`threads.status.${status}`)}
        </span>
      )}
      {at && (
        <span className="thread-line__when">
          <span className="thread-line__dot" aria-hidden="true">
            ·
          </span>
          <time dateTime={at}>{relativeTime(t, i18n.language, at)}</time>
        </span>
      )}
    </>
  );
}

/**
 * The root of a thread made from a range. In context: "Este trecho virou
 * contexto da thread …" under the range. Moved: the stub "N mensagens
 * movidas para a thread …". Never a normal message.
 */
export function ThreadStartLine({
  message,
  start,
  thread,
}: {
  message: Message;
  start: ThreadStartMeta;
  thread?: ThreadInfo;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const title = thread ? threadTitle(thread) : start.title;
  const moved = thread?.context?.moved ?? start.moved;
  const open = (
    <Button size="sm" variant={moved ? "default" : "ghost"} asChild>
      <OpenThread threadId={message.id}>
        <Icon name="thread" size={16} />
        {t("threads.line.open")}
      </OpenThread>
    </Button>
  );
  if (moved) {
    const count = start.movedCount || thread?.replyCount || start.count;
    return (
      <div className="thread-stub" data-message-id={message.id}>
        <span className="thread-stub__icon" aria-hidden="true">
          <Icon name="thread" size={16} />
        </span>
        <span className="thread-stub__text">
          {t("threads.line.moved", { count, title })}
          <small>
            {t("threads.line.by", {
              name: dir.authorName(message.author),
              time: formatTime(i18n.language, message.createdAt),
            })}
          </small>
        </span>
        {open}
      </div>
    );
  }
  // In context: one quiet line, its link as text (the range above stays the conversation).
  return (
    <div className="thread-marker ac-iconline" data-message-id={message.id}>
      <Icon name="link" size={14} />
      <span>{t("threads.line.context", { title })}</span>
      <span aria-hidden="true">·</span>
      <OpenThread className="thread-marker__open" threadId={message.id}>
        {t("threads.line.open")}
      </OpenThread>
    </div>
  );
}

/** A closed thread is one compact line in its channel: "Thread fechada · título · N mensagens". */
export function ClosedThreadLine({ thread }: { thread: ThreadInfo }) {
  const { t } = useTranslation();
  return (
    <div className="thread-closed" data-message-id={thread.id}>
      <span className="thread-closed__text ac-iconline">
        <Icon name="check" size={16} />
        <span>{t("threads.line.closed", { title: threadTitle(thread), count: threadMessageCount(thread) })}</span>
      </span>
      <span className="thread-closed__actions">
        <Button size="sm" variant="ghost" asChild>
          <OpenThread threadId={thread.id}>{t("threads.line.openShort")}</OpenThread>
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <OpenThread threadId={thread.id} reply>
            {t("threads.line.reply")}
          </OpenThread>
        </Button>
      </span>
    </div>
  );
}

/** Under the timeline: archived threads aren't shown here, and where to find them. */
export function ArchivedThreadsNote({ channelId, count }: { channelId: string; count: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  if (count === 0) return null;
  return (
    <div className="thread-closed thread-closed--quiet">
      <span className="thread-closed__text ac-iconline">
        <Icon name="archiveBox" size={16} />
        <span>{t("threads.line.archived", { count })}</span>
      </span>
      <span className="thread-closed__actions">
        <Button size="sm" variant="ghost" asChild>
          <Link to="/org/$orgId/threads" params={{ orgId: org.id }} search={{ tab: "archived", channel: channelId }}>
            {t("threads.line.see")}
          </Link>
        </Button>
      </span>
    </div>
  );
}

/** The channel header's "Threads (N)": a popover with this channel's threads and their state. */
export function ChannelThreadsButton({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const actions = useChannelActions();
  const [open, setOpen] = useState(false);
  const list = useChannelThreads(org.id, channelId, "all");
  const archived = useChannelThreads(org.id, channelId, "archived");
  const threads = list.data?.threads ?? [];
  const more = Boolean(list.data?.nextCursor);
  const count = more ? t("threads.popover.many", { count: threads.length }) : String(threads.length);
  const archivedCount = archived.data?.threads.length ?? 0;
  const go = (threadId: string) => {
    setOpen(false);
    if (actions?.openThread) actions.openThread(threadId);
    else void navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId: org.id, threadId } });
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      className="thread-pop"
      label={t("threads.popover.label", { channel: channelName })}
      trigger={
        <button
          type="button"
          className="ac-btn ac-btn--ghost ac-btn--icon channel__icon channel__threads"
          aria-label={t("threads.popover.button", { count: threads.length })}
          title={t("threads.popover.title")}
        >
          <Icon name="thread" />
          {threads.length > 0 && <CountBadge className="channel__icon-count">{count}</CountBadge>}
        </button>
      }
    >
      <div className="thread-pop__head">
        <b>{t("threads.popover.in", { channel: channelName })}</b>
        <small>
          {archivedCount > 0
            ? t("threads.popover.countArchived", { count: threads.length, archived: archivedCount })
            : threads.length}
        </small>
      </div>
      {threads.length === 0 && <p className="thread-pop__empty">{t("threads.popover.empty")}</p>}
      <div className="thread-pop__list">
        {threads.map((thread) => (
          <button key={thread.id} type="button" className="thread-pop__row ac-mediarow" onClick={() => go(thread.id)}>
            <span className="ac-mediarow__face">
              <span className="thread-kind" aria-hidden="true">
                <Icon name="thread" size={14} />
              </span>
            </span>
            <span className="ac-mediarow__head thread-pop__name">
              <b>{threadTitle(thread)}</b>
            </span>
            <span className="ac-mediarow__end">
              <ThreadStatusChip thread={thread} />
            </span>
            <small className="ac-mediarow__body thread-pop__sub">
              {t("threads.messages", { count: threadMessageCount(thread) })} ·{" "}
              {relativeTime(t, i18n.language, thread.lastActivityAt)}
            </small>
          </button>
        ))}
      </div>
      {/* TODO(missions): "Nova missão aqui" goes in this footer when missions land (ADR 0029 §3). */}
      <div className="thread-pop__foot">
        <Button size="sm" asChild>
          <Link
            to="/org/$orgId/threads"
            params={{ orgId: org.id }}
            search={{ channel: channelId }}
            onClick={() => setOpen(false)}
          >
            {t("threads.popover.seeAll")}
            <Icon name="chevronRight" size={16} />
          </Link>
        </Button>
      </div>
    </Popover>
  );
}

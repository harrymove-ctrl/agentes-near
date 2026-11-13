import type { ThreadInfo } from "@agenteschat/client";
import { useChannels, useDms, useThreadMutation, useThreadRange } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime, joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { quoteExcerpt } from "@agenteschat/client/lib/reply";
import { threadTitle, timeSpan } from "@agenteschat/client/lib/threads";
import { AvatarStack, Button, Chip, cx, Icon, Menu, MenuItem, MenuSeparator } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { NavToggle } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { ThreadStatusChip, useThreadControls, useThreadFlows } from "./ThreadBits";
import "./threads.css";

/**
 * The thread view's own parts: the header
 * with the title edited in place and the ⋯ menu, the context block on top,
 * and the read-only note of an archived thread. The conversation itself is
 * the channel's (ChannelPage in thread mode).
 */

/**
 * Where a thread lives, in people's words: "#produto", or "DM com Theo"
 * (the DM's other side; never "thread numa mensagem direta").
 */
export function useThreadWhere(thread: ThreadInfo) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dms = useDms(org.id);
  const dir = useDirectory(org.id);
  if (thread.channelKind !== "dm") return `#${thread.channelName}`;
  const dm = dms.data?.find((d) => d.channelId === thread.channelId);
  const others = thread.participants.flatMap((p) =>
    p.id && !(p.type === "person" && p.id === me.user.id)
      ? [dir.authorName({ type: p.type, id: p.id } as Parameters<typeof dir.authorName>[0])]
      : [],
  );
  const name = dm?.with.name ?? joinNames(others.slice(0, 3), t);
  return name ? t("threads.view.dmWith", { name }) : t("threads.dm");
}

/** "#produto · Walter, Ana e Dev". */
function useWho(thread: ThreadInfo) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const names = thread.participants.flatMap((p) =>
    p.id ? [dir.authorName({ type: p.type, id: p.id } as Parameters<typeof dir.authorName>[0])] : [],
  );
  return joinNames(names.slice(0, 4), t);
}

/** The title: a click (or Enter) edits it; Enter or leaving saves, Esc cancels. */
function ThreadTitle({ thread }: { thread: ThreadInfo }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const mutation = useThreadMutation(org.id);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  // The new title while the server saves it (no flash of the old one).
  const [saving, setSaving] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const title = threadTitle(thread);
  const canEdit = thread.canManage && thread.state !== "archived";
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const next = value.replace(/\s+/g, " ").trim();
    if (!next || next === title) return;
    setSaving(next);
    mutation.mutate(
      { type: "update", thread, patch: { title: next } },
      {
        onSuccess: () => toast.show(t("threads.view.renamed", { title: next })),
        onError: (error) => toast.show(errorText(t, error), "error"),
        onSettled: () => setSaving(null),
      },
    );
  };
  if (editing) {
    return (
      <input
        ref={input}
        className="thread-title__input"
        data-esc-own=""
        value={value}
        maxLength={200}
        aria-label={t("threads.view.titleLabel")}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
    );
  }
  if (!canEdit) return <span className="thread-title__text">{title}</span>;
  return (
    <button
      type="button"
      className="thread-title__button"
      title={t("threads.view.rename")}
      onClick={() => {
        setValue(title);
        setEditing(true);
      }}
    >
      {saving ?? title}
    </button>
  );
}

/**
 * The thread's header: back to the channel, who is in it (their faces, not a generic icon), the title,
 * where it lives with its replies and last activity, its state and ⋯. In the panel over a channel
 * (`onClose`): no way back (the channel is right there), "Abrir em tela cheia" and close; "Ver em #canal" there
 * (`onSeeInChannel`) closes the panel and jumps to the thread's message in the channel below, or returns false for a
 * thread of another channel, which navigates as on the full page.
 */
export function ThreadHeader({
  thread,
  onClose,
  onBack,
  onSeeInChannel,
}: {
  thread: ThreadInfo;
  onClose?: () => void;
  onBack?: (() => void) | undefined;
  onSeeInChannel?: (messageId: string, channelId: string) => boolean;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const { org } = useOrg();
  const toast = useToast();
  const controls = useThreadControls();
  const flows = useThreadFlows();
  const navigate = useNavigate();
  const who = useWho(thread);
  const channelParams = { orgId: org.id, channelId: thread.channelId };
  const where = useThreadWhere(thread);
  const archived = thread.state === "archived";
  const people = thread.participants.flatMap((p) => (p.id ? [{ type: p.type, id: p.id }] : []));
  const more = t("threads.view.more");
  return (
    <header className={onClose ? "channel__header thread-head thread-head--panel" : "channel__header thread-head"}>
      {!onClose && (
        <>
          <NavToggle />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronLeft"
            aria-label={t("threads.view.backTo", { where })}
            title={t("threads.view.backTo", { where })}
            onClick={() => void navigate({ to: "/org/$orgId/c/$channelId", params: channelParams })}
          />
        </>
      )}
      {onBack && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="chevronLeft"
          aria-label={t("threads.view.backToResults")}
          title={t("threads.view.backToResults")}
          onClick={onBack}
        />
      )}
      <span className="thread-head__who" aria-hidden="true">
        {people.length > 0 ? (
          <AvatarStack>{people.slice(0, 3).map((p) => actors.avatar(p, "sm"))}</AvatarStack>
        ) : (
          <Icon name="thread" size={18} />
        )}
      </span>
      <div className="thread-head__text">
        <h1 className="channel__title thread-title">
          <ThreadTitle thread={thread} />
        </h1>
        <span className="channel__topic thread-head__meta">
          <span className="thread-head__where">{who && thread.channelKind !== "dm" ? `${where} · ${who}` : where}</span>
          {thread.replyCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("threads.line.replies", { count: thread.replyCount })}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <time dateTime={thread.lastActivityAt}>{relativeTime(t, i18n.language, thread.lastActivityAt)}</time>
        </span>
      </div>
      {thread.state !== "open" && <ThreadStatusChip thread={thread} />}
      <Menu
        align="end"
        label={more}
        trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={more} />}
      >
        <MenuItem
          icon="channel"
          onSelect={() => {
            if (onSeeInChannel?.(thread.id, thread.channelId)) return;
            void navigate({ to: "/org/$orgId/c/$channelId", params: channelParams, search: { m: thread.id } });
          }}
        >
          {t("threads.view.seeInChannel", { channel: thread.channelName })}
        </MenuItem>
        <MenuItem
          icon="link"
          onSelect={async () => {
            await navigator.clipboard?.writeText(`${window.location.origin}/org/${org.id}/threads/${thread.id}`);
            toast.show(t("channel.linkCopied"));
          }}
        >
          {t("channel.copyLink")}
        </MenuItem>
        {thread.canManage && thread.context && !archived && (
          <MenuItem icon="edit" onSelect={() => flows.adjust(thread)}>
            {t("threads.context.adjust")}
          </MenuItem>
        )}
        {thread.canManage && (
          <>
            <MenuSeparator />
            {archived ? (
              <MenuItem icon="unarchive" onSelect={() => controls.request([thread], "unarchive")}>
                {t("threads.actions.unarchive")}
              </MenuItem>
            ) : (
              <>
                {thread.state === "closed" ? (
                  <MenuItem icon="refresh" onSelect={() => controls.request([thread], "reopen")}>
                    {t("threads.actions.reopen")}
                  </MenuItem>
                ) : (
                  <MenuItem
                    icon="check"
                    description={t("threads.actions.closeHint")}
                    onSelect={() => controls.request([thread], "close")}
                  >
                    {t("threads.actions.close")}
                  </MenuItem>
                )}
                <MenuItem icon="archiveBox" onSelect={() => controls.request([thread], "archive")}>
                  {t("threads.actions.archive")}
                </MenuItem>
              </>
            )}
          </>
        )}
      </Menu>
      {onClose && (
        <>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="external"
            aria-label={t("threads.side.expand")}
            title={t("threads.side.expand")}
            onClick={() =>
              void navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId: org.id, threadId: thread.id } })
            }
          />
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="close"
            aria-label={t("threads.side.close")}
            title={t("threads.side.close")}
            onClick={onClose}
          />
        </>
      )}
      {controls.dialog}
    </header>
  );
}

/**
 * On top of a thread made from a range: "Contexto: 10 mensagens de #produto,
 * 10:02–10:31", collapsible, the range listed compactly, and the actions
 * (Ajustar trecho, Tirar do canal / Devolver ao canal) for who manages it.
 */
export function ContextBlock({ thread }: { thread: ThreadInfo }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const controls = useThreadControls();
  const flows = useThreadFlows();
  const range = useThreadRange(org.id, thread);
  const channels = useChannels(org.id);
  const [open, setOpen] = useState(false);
  const ctx = thread.context;
  if (!ctx) return null;
  const list = range.data ?? [];
  const first = list[0];
  const last = list.at(-1);
  const channel =
    ctx.channelId === thread.channelId
      ? thread.channelName
      : (channels.data?.find((c) => c.id === ctx.channelId)?.name ?? t("threads.context.otherChannel"));
  const span = first && last ? timeSpan(i18n.language, first.createdAt, last.createdAt) : null;
  const canChange = thread.canManage && thread.state !== "archived";
  const sameChannel = ctx.channelId === thread.channelId;
  return (
    <section className="thread-context" aria-label={t("threads.context.label")}>
      <button
        type="button"
        className="thread-context__head ac-mediarow"
        aria-expanded={open}
        aria-controls={`thread-context-${thread.id}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ac-mediarow__face">
          <span className="thread-context__icon" aria-hidden="true">
            <Icon name="layers" size={16} />
          </span>
        </span>
        <span className="ac-mediarow__head">
          <b className="thread-context__title">
            {span
              ? t("threads.context.title", { count: ctx.count, channel, span })
              : t("threads.context.titleNoSpan", { count: ctx.count, channel })}
          </b>
        </span>
        <span className="ac-mediarow__end">
          <Icon name="chevronRight" size={16} className={cx("thread-context__chev", open && "is-open")} />
        </span>
        <small className="ac-mediarow__body thread-context__sub">
          <Chip icon={ctx.moved ? "thread" : "link"}>
            {ctx.moved ? t("threads.context.moved") : t("threads.context.reference")}
          </Chip>
          <span>{t("threads.context.agentsRead")}</span>
        </small>
      </button>
      {canChange && (
        <div className="thread-context__actions">
          <button type="button" className="thread-context__link" onClick={() => flows.adjust(thread)}>
            <Icon name="edit" size={14} />
            {t("threads.context.adjust")}
          </button>
          {sameChannel &&
            (ctx.moved ? (
              <button
                type="button"
                className="thread-context__link"
                onClick={() => controls.request([thread], "return")}
              >
                <Icon name="undo" size={14} />
                {t("threads.context.return")}
              </button>
            ) : (
              <button type="button" className="thread-context__link" onClick={() => controls.request([thread], "move")}>
                <Icon name="move" size={14} />
                {t("threads.context.move")}
              </button>
            ))}
        </div>
      )}
      {open && (
        <div className="thread-context__body" id={`thread-context-${thread.id}`}>
          {range.isLoading && <p className="thread-context__note">{t("common.loading")}</p>}
          {list.map((m) => {
            const name = dir.authorName(m.author);
            return (
              <Link
                key={m.id}
                className="thread-context__row"
                to="/org/$orgId/c/$channelId"
                params={{ orgId: org.id, channelId: m.channelId }}
                search={{ m: m.id }}
              >
                <span className="thread-context__who">
                  {m.author.id ? (
                    <ActorAvatar actor={{ type: m.author.type, id: m.author.id }} name={name} size="xs" />
                  ) : null}
                </span>
                <span>
                  <span className="thread-context__row-head">
                    <b>{name}</b>
                    <span>{formatTime(i18n.language, m.createdAt)}</span>
                  </span>
                  <span className="thread-context__excerpt">{quoteExcerpt(textOrMedia(t, m.body, m.meta))}</span>
                </span>
              </Link>
            );
          })}
          <p className="thread-context__note ac-iconline">
            <Icon name={ctx.moved ? "thread" : "link"} size={14} />
            <span>
              {ctx.moved
                ? t("threads.context.movedNote", { channel })
                : t("threads.context.referenceNote", { channel })}
            </span>
          </p>
        </div>
      )}
      {controls.dialog}
    </section>
  );
}

/** "Walter criou a thread a partir de 10 mensagens de #produto · 10:34". */
export function ThreadOrigin({ thread }: { thread: ThreadInfo }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (!thread.context) return null;
  const name = thread.createdBy
    ? (dir.memberById.get(thread.createdBy)?.name ?? t("threads.someone"))
    : t("threads.someone");
  return (
    <p className="thread-origin ac-iconline">
      <Icon name="thread" size={14} />
      <span>
        {t("threads.view.origin", {
          name,
          count: thread.context.count,
          channel: thread.channelName,
          time: formatTime(i18n.language, thread.createdAt),
        })}
      </span>
    </p>
  );
}

/** An archived thread is read only: a note (and Desarquivar for who may) in place of the composer. */
export function ArchivedNote({ thread }: { thread: ThreadInfo }) {
  const { t } = useTranslation();
  const controls = useThreadControls();
  return (
    <div className="thread-archived" role="note">
      <span className="ac-iconline">
        <Icon name="lock" size={16} />
        <span>
          <b>{t("threads.view.archivedTitle")}</b> {t("threads.view.archivedText")}
        </span>
      </span>
      {thread.canManage && (
        <Button size="sm" icon="unarchive" onClick={() => controls.request([thread], "unarchive")}>
          {t("threads.actions.unarchive")}
        </Button>
      )}
      {controls.dialog}
    </div>
  );
}

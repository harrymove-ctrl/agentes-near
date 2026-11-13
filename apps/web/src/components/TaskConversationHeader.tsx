import type { ThreadInfo } from "@agenteschat/client";
import { joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { AvatarStack, Button, cx, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { NavToggle } from "@/components/NavDrawer";

/**
 * The conversation's header in the panel: who is in it, "Conversa da tarefa", "Bruno, Walter e Theo · 5 mensagens
 * · agora", and close. No title to rename and no thread states: the task is its title and its state.
 */
export function TaskConversationHeader({ thread, onClose }: { thread: ThreadInfo; onClose?: () => void }) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const people = thread.participants.flatMap((p) => (p.id ? [{ type: p.type, id: p.id }] : []));
  const names = joinNames(
    people.slice(0, 4).map((p) => actors.name(p)),
    t,
  );
  return (
    <header className={cx("channel__header thread-head", onClose && "thread-head--panel")}>
      {!onClose && <NavToggle />}
      <span className="thread-head__who" aria-hidden="true">
        {people.length > 0 ? (
          <AvatarStack>{people.slice(0, 3).map((p) => actors.avatar(p, "sm"))}</AvatarStack>
        ) : (
          <Icon name="message" size={18} />
        )}
      </span>
      <div className="thread-head__text">
        <h1 className="channel__title thread-title">
          <span className="thread-title__text">{t("issues.conversation.title")}</span>
        </h1>
        <span className="channel__topic thread-head__meta">
          {names && <span className="thread-head__where">{names}</span>}
          {thread.replyCount > 0 && (
            <>
              {names && <span aria-hidden="true">·</span>}
              <span>{t("issues.conversation.messages", { count: thread.replyCount })}</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <time dateTime={thread.lastActivityAt}>{relativeTime(t, i18n.language, thread.lastActivityAt)}</time>
        </span>
      </div>
      {onClose && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("issues.conversation.close")}
          title={t("issues.conversation.close")}
          onClick={onClose}
        />
      )}
    </header>
  );
}

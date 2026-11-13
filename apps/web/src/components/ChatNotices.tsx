import type { Agent, Message } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { APP_BRANDS } from "@agenteschat/client/lib/apps";
import { seesDetails } from "@agenteschat/client/lib/audience";
import { pairItemOf } from "@agenteschat/client/lib/consult-group";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  consultationOfNotice,
  type NoticeView,
  noticeOf,
  noticeView,
  type StoppedNotice,
  stoppedNoticeOf,
} from "@agenteschat/client/lib/notices";
import type { RoutineReply } from "@agenteschat/client/lib/routines";
import type { AppVia } from "@agenteschat/client/lib/via";
import {
  cx,
  EventPill,
  EventPillAction,
  EventPillMore,
  Icon,
  type IconName,
  PixelStop,
  ProviderLogo,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { MessageBody } from "@/chat/MessageBody";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { ConsultPairRow } from "@/components/ConsultGroup";
import { DetailsLink } from "@/components/details-link";
import { useOrg } from "@/components/org-context";
import { SayWhy } from "@/components/tasks/TaskBits";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./chat-notices.css";

const NOTICE_ICON: Record<string, IconName> = {
  routine_handoff: "routines",
  consult_reply: "agent",
  agent_note: "message",
  wait_result: "check",
  follow_up: "clock",
  wake_skipped: "alert",
};

/**
 * One event pill (`EventPill`) with its text on demand ("Ver"): an automatic event of the conversation, not a voice.
 */
function EventLine({
  message,
  mark,
  label,
  detail,
  labels,
  action,
}: {
  message: Message;
  /** Its icon, or the service's own logo (GitHub's). */
  mark: ReactNode;
  label: ReactNode;
  /** What "Ver" opens (`noticeView`): never the words written for the agent. */
  detail: NoticeView["detail"];
  labels: { show: string; hide: string };
  /** What a person can still do about it ("Cancelar" on a follow-up): an `EventPillAction`. */
  action?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  const text = detail
    ? "content" in detail
      ? detail.content
      : t(detail.words.key as "chat.notice.wakeSkippedAudience", detail.words.values as { name: string })
    : "";
  return (
    <EventPill
      className="cn-pill"
      data-message-id={message.id}
      mark={mark}
      time={formatTime(i18n.language, message.createdAt)}
      actions={
        action || text ? (
          <>
            {action}
            {text && (
              <EventPillMore open={open} onClick={() => setOpen((o) => !o)}>
                {open ? labels.hide : labels.show}
              </EventPillMore>
            )}
          </>
        ) : undefined
      }
      below={
        open && text ? (
          <div className="cn-line__body">
            <MessageBody body={text} resolveMention={dir.mentionName} mentionTone={dir.mentionTone} />
          </div>
        ) : undefined
      }
    >
      {label}
    </EventPill>
  );
}

/**
 * In place of a conversation row, or a `part` of a message (a card, its receipts), that failed to draw
 * (`ErrorBoundary`): one pill, the rest keeps working.
 */
export function UnshownLine({ part = false }: { part?: boolean }) {
  const { t } = useTranslation();
  return (
    <EventPill className={cx("cn-pill", part && "cn-pill--part")} mark={<Icon name="alert" size={14} />}>
      {t(part ? "chat.unshownPart" : "chat.unshown")}
    </EventPill>
  );
}

/**
 * What reached an agent's conversation while it wasn't looking (`meta.notice`): "Rotina «Sentry»
 * entregou um relatório", "Infra respondeu", "Nota de Dev", "Chegou o resultado que Ada esperava".
 * The agent's own reply (if it has something to say) follows as a normal message.
 */
export function NoticeLine({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const notice = noticeOf(message.meta);
  if (!notice) return null;
  // A person stopped one of the agent's tasks (ADR 0128): its pill, with "Add a reason" for who stopped it. The
  // conversation hides it while the stopped reply is here: the reply's own pill says it (`Timeline`).
  const stopped = stoppedNoticeOf(message.meta);
  if (stopped) return <StoppedLine message={message} notice={stopped} />;
  // Another agent's answer with its consultation, its reply not here: the same pair row a reply has (who asked
  // whom), never the text written for the asking agent; a click opens what they said.
  const consulted = consultationOfNotice(message.meta);
  if (consulted)
    return (
      <div data-message-id={message.id}>
        <ConsultPairRow askerId={consulted.askerId} items={[pairItemOf(consulted.consultation)]} />
      </div>
    );
  const view = noticeView(
    message,
    {
      author: dir.authorName(message.author),
      agentByHandle: (handle) => dir.agentByHandle.get(handle.toLowerCase())?.name ?? null,
    },
    { time: (iso) => formatTime(i18n.language, iso), locale: i18n.language },
  );
  if (!view) return null;
  return (
    <EventLine
      message={message}
      mark={
        notice.kind === "github_event" ? (
          <ProviderLogo id="github" size="xs" />
        ) : (
          <Icon name={NOTICE_ICON[notice.kind] ?? "info"} size={14} />
        )
      }
      label={t(view.key as "chat.notice.other", view.values as { name: string })}
      detail={view.detail}
      labels={{ show: t("chat.notice.show"), hide: t("chat.notice.hide") }}
      action={
        view.pending ? (
          <CancelFollowUp messageId={message.id} />
        ) : view.answer ? (
          <AnswerGitHub messageId={message.id} />
        ) : undefined
      }
    />
  );
}

/** Under a reply that came at standard speed because Fast was refused (`meta.speedFallback`), with the way to the agent. */
export function SpeedFallbackLine({ agent }: { agent: Agent | undefined }) {
  const { t } = useTranslation();
  const openPanel = useOpenAgentPanel();
  return (
    <EventPill
      className="cn-pill cn-pill--part"
      mark={<Icon name="info" size={14} />}
      actions={
        openPanel && agent && seesDetails(agent) ? (
          <EventPillAction onClick={() => openPanel(agent.id)}>{t("chat.speedFallback.action")}</EventPillAction>
        ) : undefined
      }
    >
      {t("chat.speedFallback.text")}
    </EventPill>
  );
}

/** Who stopped a task, as its pill says it: the notice when there is one, else what the stopped reply knows. */
export interface StopWho {
  /** The notice the agent got (ADR 0128): who, their name, the reason, and "Dizer o motivo" for who stopped it. */
  notice?: StoppedNotice | null;
  /** When the notice came. */
  at?: string;
  /** Without a notice: the person in the reply's meta. */
  byUserId?: string | null;
}

/**
 * A stopped task as one pill: "You stopped Ada" (with the reason once said), its time, and its actions: Continuar
 * (`cont`, where the task can pick up again) and, for who stopped it while it has no reason, "Add a reason" opening a
 * field under it; the agent reads the reason on its next turn. `fallback`: its words when no person stopped it (the
 * step limit, stuck). Under the stopped reply when it is here (`run-canceled`), else in the notice's place.
 */
export function StopPill({
  agent,
  who,
  fallback,
  cont,
  channelId,
  className,
}: {
  agent: string;
  who: StopWho;
  fallback?: string | null;
  cont?: ReactNode;
  channelId: string;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  // Shown at once; the notice's own copy follows when the conversation hears of it.
  const [sent, setSent] = useState<string | null>(null);
  const notice = who.notice ?? null;
  const byUserId = notice?.byUserId || who.byUserId || null;
  const mine = Boolean(byUserId) && byUserId === me.user.id;
  const reason = notice?.reason ?? sent;
  const stopper = notice?.byName || (byUserId ? dir.memberById.get(byUserId)?.name : undefined) || "";
  const { context } = agentGrammar(agent);
  const sentence = mine
    ? t("taskManager.stopped.line", { agent, context })
    : stopper
      ? t("taskManager.stopped.lineBy", { name: stopper, agent, context })
      : byUserId || !fallback
        ? t("run.stopped")
        : fallback;
  const sayWhy = Boolean(notice) && mine && !reason && !asking;
  return (
    <EventPill
      className={cx("cn-pill", className)}
      mark={<PixelStop size={12} dim />}
      time={who.at ? formatTime(i18n.language, who.at) : undefined}
      actions={
        cont || sayWhy ? (
          <>
            {cont}
            {sayWhy && (
              <EventPillAction onClick={() => setAsking(true)}>{t("taskManager.stopped.sayWhy")}</EventPillAction>
            )}
          </>
        ) : undefined
      }
      below={
        notice && asking && !reason ? (
          <SayWhy
            runId={notice.runId}
            className="cn-stopped__why"
            autoFocus
            onCancel={() => setAsking(false)}
            onSent={(why) => {
              setSent(why);
              setAsking(false);
              void qc.invalidateQueries({ queryKey: keys.messages(org.id, channelId) });
            }}
          />
        ) : undefined
      }
    >
      {sentence}
      {reason && ` · ${t("taskManager.stopped.reason", { reason })}`}
    </EventPill>
  );
}

/** The stopped tasks of a conversation: each notice by run, and the runs whose stopped reply is drawn here. */
export interface StopsHere {
  notices: ReadonlyMap<string, { notice: StoppedNotice; at: string }>;
  replied: ReadonlySet<string>;
}

const StopsContext = createContext<StopsHere>({ notices: new Map(), replied: new Set() });
export const StopsProvider = StopsContext.Provider;

/**
 * One stop, one pill: a notice whose stopped reply is here (a saved reply that says it was canceled, or the run's live
 * block) is drawn in that reply's pill, never as a line of its own.
 */
export function stopsOf(messages: readonly Message[], liveRunIds: Iterable<string>): StopsHere {
  const notices = new Map<string, { notice: StoppedNotice; at: string }>();
  const replied = new Set<string>(liveRunIds);
  for (const m of messages) {
    const notice = stoppedNoticeOf(m.meta);
    if (notice) notices.set(notice.runId, { notice, at: m.createdAt });
    else if (m.author.type === "agent" && m.agentRunId && m.meta?.canceled) replied.add(m.agentRunId);
  }
  return { notices, replied };
}

/** The notice of the run a stopped reply belongs to, when the conversation has it. */
export const useStopNotice = (runId: string | null | undefined) => {
  const stops = useContext(StopsContext);
  return runId ? stops.notices.get(runId) : undefined;
};

/** Whether a stopped task's notice has its reply's pill here, so draws nothing. */
export const useStopShownInReply = (runId: string) => useContext(StopsContext).replied.has(runId);

/** A stopped task's notice where its reply isn't in the conversation (stopped before it wrote): its pill alone. */
function StoppedLine({ message, notice }: { message: Message; notice: StoppedNotice }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (useStopShownInReply(notice.runId)) return null;
  const agent = message.author.type === "agent" ? dir.authorName(message.author) : t("channel.unknownAgent");
  return (
    <div data-message-id={message.id}>
      <StopPill
        agent={agent}
        who={{ notice, at: message.createdAt }}
        channelId={message.channelId}
        className="cn-stopped"
      />
    </div>
  );
}

/** "Cancelar" on a follow-up still to come: the line changes in place once the server has it. */
function CancelFollowUp({ messageId }: { messageId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const { org } = useOrg();
  const [busy, setBusy] = useState(false);
  return (
    <EventPillAction
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void api.chat
          .cancelFollowUp(org.id, messageId)
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      {t("chat.notice.followUpCancel")}
    </EventPillAction>
  );
}

/**
 * "Pedir resposta" on what someone the agent doesn't answer wrote on GitHub: the agent answers them there, with this
 * person behind it. The line changes in place once the server has it; a refusal says why.
 */
function AnswerGitHub({ messageId }: { messageId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const { org } = useOrg();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <EventPillAction
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void api.chat
          .answerGitHub(org.id, messageId)
          .catch((error: unknown) => toast.show(errorText(t, error), "error"))
          .finally(() => setBusy(false));
      }}
    >
      {t("chat.notice.github.ask")}
    </EventPillAction>
  );
}

/**
 * The routine an agent's message answers (ADR 0053 §7): a small tag next to its name, "Rotina «X»",
 * that opens the routine's details in place (`DetailsLink`); with the report it answers loaded here, "Ver relatório" unfolds it
 * (the report's own line is folded into this message).
 */
export function RoutineTag({
  routine,
  report,
  open,
  onToggle,
}: {
  routine: RoutineReply;
  report: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DetailsLink
        item={{ kind: "routine", id: routine.id }}
        className="msg-reminder msg-reminder--link"
        title={t("channel.routineTagTip")}
      >
        <Icon name="routines" size={14} />
        {t("channel.routineTag", { name: routine.name })}
      </DetailsLink>
      {report && (
        <button type="button" className="cn-line__toggle cn-report__toggle" aria-expanded={open} onClick={onToggle}>
          {open ? t("channel.routineReportHide") : t("channel.routineReport")}
        </button>
      )}
    </>
  );
}

/** A person's message sent through a connected AI app (ADR 0119): "via Claude", with the app's mark when known. */
export function AppViaTag({ via, person }: { via: AppVia; person: string }) {
  const { t } = useTranslation();
  const mark = via.brand ? APP_BRANDS[via.brand] : undefined;
  return (
    <span className="msg-reminder msg-via" title={t("apps.viaTip", { person, name: via.name })}>
      {mark ? <ProviderLogo id={mark} size="xs" /> : <Icon name="link" size={14} />}
      {t("apps.via", { name: via.name })}
    </span>
  );
}

/** The report a routine's message answers, unfolded under it (its words, as the notice had them). */
export function RoutineReport({ text }: { text: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (
    <div className="cn-report">
      <MessageBody body={text} resolveMention={dir.mentionName} mentionTone={dir.mentionTone} />
    </div>
  );
}

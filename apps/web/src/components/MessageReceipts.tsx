import type { DecidedBy, Message, SteerState } from "@agenteschat/client";
import {
  type MessageReceipt,
  type ReceiptPhase,
  type ReceiptView,
  receiptTicks,
  receiptView,
  steerWords,
  useAiStatus,
  useApi,
  useReactions,
  useSteerState,
} from "@agenteschat/client";
import { errorText, runFailureLine } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { mayConnectAi } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { retryAnswer } from "@agenteschat/client/lib/retry-answer";
import { deciderOf } from "@agenteschat/client/lib/routing";
import { Icon, type IconName, PixelSpinner, Popover } from "@agenteschat/ui";
import { type ReactNode, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { useOpenBilling } from "@/components/BillingLinkButton";
import { FanOutStrip, QueuedWords } from "@/components/ComputerQueue";
import { useConnectAi } from "@/components/ConnectAi";
import { HelpLink } from "@/components/HelpLink";
import { useDirectory } from "@/hooks/useDirectory";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import { useLive } from "@/realtime/context";
import { CallAgentMenu, useChannelActions } from "./channel-actions";
import { useOrg } from "./org-context";

const TICK_ICON = { clock: "waiting", check: "check", checks: "checks" } as const satisfies Record<string, IconName>;

/** Which icon the receipt shows: alert for a failure, else its ticks (`receiptTicks`). */
export function receiptIcon(view: ReceiptView, receipt: MessageReceipt | undefined): IconName {
  const kind = view.status?.kind;
  if (kind === "failed" || kind === "no_ai") return "alert";
  return TICK_ICON[receiptTicks(receipt)];
}

/** A rule's line leads with what it follows: the reply, the one person with the agent, the talk. */
const RULE_ICON: Record<Exclude<Extract<DecidedBy, { step: "rule" }>["rule"], "coordinator" | "alone">, IconName> = {
  reply: "reply",
  only_agent: "person",
  follow_up: "thread",
  default: "check",
};

/** A dot and the action after it: one piece, which wraps whole. */
function ReceiptAction({ children }: { children: ReactNode }) {
  return (
    <span className="ac-receipt__then">
      <span className="ac-receipt__dot" aria-hidden="true">
        ·
      </span>
      {children}
    </span>
  );
}

/** The hold's way to the plans, on a kept message's line. */
function ReceiptPlanAction() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const open = useOpenBilling(org.id, "hold");
  return (
    <ReceiptAction>
      <button type="button" className="ac-receipt__action" disabled={open.isPending} onClick={() => open.mutate()}>
        {t("standing.billing.cta.payment")}
      </button>
    </ReceiptAction>
  );
}

/**
 * A channel message kept on a hold, once the plan and an AI are here: its author opening the conversation routes it,
 * once per tab, with "Responder agora" if that was refused. Until then, or anyone else's, the line as usual.
 */
function KeptAnswer({ message, kept, children }: { message: Message; kept: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const connect = useConnectAi();
  const ready = useAiStatus(org.id).data?.any === true;
  const starts = kept && ready && connect !== null && message.author.id === me.user.id;
  const answer = connect?.answered[message.id];
  // biome-ignore lint/correctness/useExhaustiveDependencies: `connect` changes with each answer; once per message here
  useEffect(() => {
    if (!starts) return;
    const key = `${STORAGE_KEYS.noAiOpened}.answer.${message.id}`;
    if (sessionStore.get(key)) return;
    sessionStore.set(key, "1");
    void connect?.answer(message.id);
  }, [starts, message.id]);
  if (!starts) return children;
  return (
    <span className="ac-receipt__words">
      {answer === "pending" || answer === "answering" ? (
        <span>{t("receipts.picking")}</span>
      ) : (
        <button type="button" className="ac-receipt__action" onClick={() => void connect?.answer(message.id)}>
          {t("noAi.card.answerNow")}
        </button>
      )}
    </span>
  );
}

/**
 * What became of a message sent into a task at work: the reader's face once it read it, else the spinner while it
 * waits for the next pause, the bolt when it stopped to read, a check once handed over, the clock while an approval
 * holds it.
 */
function SteerMark({ steer, name, size }: { steer: SteerState; name: string; size: 14 | 16 }) {
  if (steer.state === "read" || steer.state === "resolved")
    return <AgentAvatar agentId={steer.agentId} name={name} size="xs" state="idle" />;
  if (steer.state === "waiting") return <PixelSpinner size={size} />;
  return <Icon name={steer.state === "now" ? "bolt" : steer.state === "delivered" ? "check" : "waiting"} size={size} />;
}

/**
 * A person's message's receipt (and an agent's that mentions agents: whom it handed work to, and "Só mencionado"
 * with "Chamar um agente" for one it only mentioned, ADR 0089): a small muted mark at the end of its first line, or of
 * the time's line under my own turn (`part="check"`), never a line of its own, so it never changes the message's
 * height or the room before the next one. Clicking or focusing it opens a popover with each agent and its status, and
 * the rule that picked them. The mark is the clock, one tick or two (`receiptTicks`). While the author's own plan
 * picks, and when no agent will answer or every one it was for passed (an agent's reaction counts as acting), "Chamar
 * um agente" is in its popover: never a line in the timeline, which read as wrong beside an agent's reaction. A
 * message sent into a task at work wears what became of it there instead of the check ("Ada leu" is Ada's face), the
 * words said to screen readers as they change. Words only for what you can act on (a failure, no AI connected) or
 * what nobody can (the AI provider is down, it retries by itself; the plan or budget has to renew): then the whole
 * receipt is a line under the message (`part="line"`), so the text still follows the name.
 */
export function MessageReceipts({ message, part }: { message: Message; part: "check" | "line" }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useChannelActions();
  const api = useApi();
  const toast = useToast();
  const connect = useConnectAi();
  const held = usePlanHold() !== null;
  const steerId = useId();
  const [retrying, setRetrying] = useState(false);
  const receipt = useLive((s) => s.receipts[message.id]);
  // The pills' list (live through `message.reactions`), else the message's: an agent's reaction is its answer.
  const reactions = useReactions(org.id, message.id, false).data ?? message.reactions;
  const steer = useSteerState(org.id, message.channelId, part === "check" ? message.id : "");
  const steerName = steer ? dir.agentById.get(steer.agentId)?.name : undefined;
  const steered =
    steer && steerName
      ? { steer, name: steerName, text: t(`run.steer.${steerWords(steer, receipt)}`, { name: steerName }) }
      : null;
  const view = receiptView(receipt);
  const status = view.status;
  // One agent failed: while its failed row is in the conversation the row says why; once it's closed (its ×, a
  // reload), this line does.
  const failedAgent = status?.kind === "failed" && status.agents.length === 1 ? status.agents[0] : undefined;
  const failedRun = failedAgent ? receipt?.runOf?.[failedAgent] : undefined;
  const rowSaysWhy = useLive((s) => (failedRun ? s.streams.runs[failedRun]?.status === "failed" : false));
  const callAgent =
    actions && actions.channelAgents.length > 0 ? (
      <ReceiptAction>
        <CallAgentMenu />
      </ReceiptAction>
    ) : null;
  // Nobody will answer, or every agent it was for ended without answering: a person can call one.
  const nobody = status?.kind === "nobody" || status?.kind === "passed";
  // "Tentar de novo" answers my message again: never an agent's.
  const worded =
    status?.kind === "outage" ||
    status?.kind === "queued" ||
    status?.kind === "away" ||
    status?.kind === "plan" ||
    status?.kind === "budget" ||
    status?.kind === "no_ai" ||
    status?.kind === "platform_cap" ||
    (status?.kind === "failed" && actions !== null && message.author.type === "person");
  // An agent's message that called several: one strip says where each stands once they start (`fanShows`).
  const fanned = part === "line" && message.author.type === "agent" && message.mentionedAgentIds.length > 1;
  // The mark stays where a line says the rest (a failure, no AI): what became of it in the task is its own news.
  if (part === "line" ? !worded && !fanned : worded && !steered) return null;
  const marked = view.seen.length > 0 || view.picking === true || steered !== null;
  if (!marked && status?.kind !== "no_ai" && status?.kind !== "platform_cap") return null;

  const name = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const names = (ids: string[]) => joinNames(ids.map(name), t);
  const failure = failedAgent && !rowSaysWhy ? receipt?.failures?.[failedAgent] : undefined;
  const failedWhy = failedAgent && failure ? runFailureLine(t, name(failedAgent), failure, i18n.language) : null;
  const only = status?.kind === "no_ai" && status.agents.length === 1 ? status.agents[0] : undefined;
  const mayConnect = mayConnectAi(only ? dir.agentById.get(only) : null, me.user.id, org);
  const mentionNeeded = status?.kind === "nobody" && status.mentionNeeded === true;
  const statusText =
    status === null
      ? ""
      : status.kind === "nobody"
        ? t(mentionNeeded ? "receipts.mentionNeeded" : "receipts.nobody")
        : status.kind === "no_ai"
          ? held
            ? t("noAi.kept.receipt")
            : t("noAi.receipt")
          : status.kind === "platform_cap"
            ? t("receipts.platformCap")
            : t(`receipts.${status.kind}`, { count: status.agents.length, names: names(status.agents) });
  const label = [
    view.picking && t("receipts.picking"),
    view.seen.length > 0 && t("receipts.seenBy", { names: names(view.seen) }),
    statusText,
  ]
    .filter(Boolean)
    .join(". ");
  const phases = new Map<string, ReceiptPhase>(receipt?.agents ?? []);
  const reacted = new Set(reactions?.flatMap((r) => r.agentIds ?? []));
  const phaseText = (id: string) => {
    const phase = phases.get(id) ?? "seen";
    if (phase === "no_ai") return t(held ? "noAi.kept.receipt" : "noAi.chip");
    // A reaction was its answer, whatever its run's state says.
    if (reacted.has(id)) return t("receipts.status.reacted");
    return view.referenced.includes(id) && phase === "seen"
      ? t("receipts.status.referenced")
      : t(`receipts.status.${phase}`);
  };
  const by = deciderOf(t, view, { agent: name });

  const check = marked && (
    <Popover
      label={t("receipts.popoverTitle")}
      trigger={
        <button
          type="button"
          className="ac-receipt__check"
          aria-label={label || steered?.text}
          aria-describedby={steered && label ? steerId : undefined}
          data-state-kind={steered ? undefined : (status?.kind ?? "seen")}
          data-steer={steered?.steer.state}
        >
          {steered ? (
            // Keyed by the state: each new mark swaps in.
            <SteerMark key={steered.steer.state} steer={steered.steer} name={steered.name} size={16} />
          ) : (
            <Icon name={held && status?.kind === "no_ai" ? "waiting" : receiptIcon(view, receipt)} />
          )}
        </button>
      }
    >
      <div className="ac-popover__title">{t("receipts.popoverTitle")}</div>
      {view.seen.map((id) => (
        <div key={id} className="ac-popover__row">
          <AgentAvatar agentId={id} size="xs" name={name(id)} />
          <span>{name(id)}</span>
          <span className="ac-popover__row-status">{phaseText(id)}</span>
        </div>
      ))}
      {/* An agent mentioned another and the judge read no hand-off (ADR 0089): a person can call it. */}
      {message.author.type === "agent" && view.referenced.length > 0 && actions && actions.channelAgents.length > 0 && (
        <div className="who-by">
          <CallAgentMenu />
        </div>
      )}
      {view.picking && (
        <div className="who-by ac-iconline">
          <Icon name="waiting" size={14} />
          <span className="ac-receipt__words">
            <span>{t("receipts.picking")}</span>
            {callAgent}
          </span>
        </div>
      )}
      {steered && (
        <div className="who-by ac-iconline">
          <SteerMark steer={steered.steer} name={steered.name} size={14} />
          <span>{steered.text}</span>
        </div>
      )}
      {by && (
        <div className="who-by ac-iconline">
          <Icon name={RULE_ICON[by.rule]} size={14} />
          <span>{by.text}</span>
        </div>
      )}
      {nobody && (
        <div className="who-by">
          <span className="ac-receipt__words">
            <span>{statusText}</span>
            {callAgent}
          </span>
        </div>
      )}
      {mentionNeeded && (
        <div className="who-by">
          <span className="ac-receipt__words">{t("receipts.mentionNeededHint")}</span>
          <HelpLink slug="who-answers">{t("routing.how")}</HelpLink>
        </div>
      )}
    </Popover>
  );

  if (part === "check") {
    return (
      <div className="ac-receipt">
        {check}
        {steered && (
          <span id={steerId} className="ac-visually-hidden" aria-live="polite">
            {steered.text}
          </span>
        )}
      </div>
    );
  }
  const words = (
    <div className="ac-receipt">
      {check}
      {(status?.kind === "outage" ||
        status?.kind === "away" ||
        status?.kind === "plan" ||
        status?.kind === "budget") && (
        <span className="ac-receipt__words">
          <span>{statusText}</span>
        </span>
      )}
      {status?.kind === "queued" && (
        <span className="ac-receipt__words">
          <QueuedWords message={message} fallback={statusText} />
        </span>
      )}
      {status?.kind === "failed" && actions && (
        <span className="ac-receipt__words">
          <span>{failedWhy ?? t("receipts.failedShort")}</span>
          {/* Only who asked: anyone else's click would be refused (`run.answer_forbidden`). */}
          {message.author.id === me.user.id && (
            <ReceiptAction>
              <button
                type="button"
                className="ac-receipt__action"
                disabled={retrying}
                aria-busy={retrying || undefined}
                onClick={() => {
                  setRetrying(true);
                  void retryAnswer(api, org.id, message, () => actions.resend(message.body))
                    .catch((error) => toast.show(errorText(t, error), "error"))
                    .finally(() => setRetrying(false));
                }}
              >
                {retrying && <PixelSpinner size={14} />}
                {t(retrying ? "receipts.retrying" : "receipts.retry")}
              </button>
            </ReceiptAction>
          )}
        </span>
      )}
      {status?.kind === "platform_cap" && (
        <span className="ac-receipt__words">
          <span>{t("receipts.platformCap")}</span>
        </span>
      )}
      {/* On a billing hold the message is kept: the agent's card says so, or with none, this line does. */}
      {status?.kind === "no_ai" && held && (
        <span className="ac-receipt__words">
          <span>{t(status.agents.length > 0 ? "noAi.kept.receipt" : "noAi.kept.channel")}</span>
          {status.agents.length === 0 && can(org, "manage_billing") && <ReceiptPlanAction />}
        </span>
      )}
      {status?.kind === "no_ai" && !held && (
        <KeptAnswer message={message} kept={receipt?.server?.kept === true}>
          <span className="ac-receipt__words">
            <span>{t("noAi.receipt")}</span>
            {connect && mayConnect && (
              <ReceiptAction>
                <button
                  type="button"
                  className="ac-receipt__action"
                  onClick={() =>
                    connect.open({
                      intent: receipt?.noAi?.intent,
                      provider: receipt?.noAi?.provider,
                      agentId: status.agents.length === 1 ? status.agents[0] : undefined,
                      from: message.id,
                    })
                  }
                >
                  {t("noAi.action")}
                </button>
              </ReceiptAction>
            )}
          </span>
        </KeptAnswer>
      )}
    </div>
  );
  if (!fanned) return words;
  // The strip says where each agent stands; without it (fewer than two started, all done), the receipt as usual.
  return <FanOutStrip message={message} otherwise={worded ? words : null} />;
}

/**
 * "Visto" in a DM between people, in the receipt's place at the end of a turn's time line. The face is a button whose
 * popover says who read it, and its slot is a live region that is there before it, so screen readers hear it as it
 * shows.
 */
export function SeenMark({ personId }: { personId?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = personId ? (dir.memberById.get(personId)?.name ?? t("channel.unknownPerson")) : "";
  const words = t("receipts.seenBy", { names: name });
  const face = personId ? <ActorAvatar actor={{ type: "person", id: personId }} name={name} size="xs" /> : null;
  return (
    <span className="ac-receipt__seen" aria-live="polite">
      {face && (
        <Popover
          label={words}
          trigger={
            <button type="button" className="ac-receipt__check">
              {face}
              <span className="ac-visually-hidden">{words}</span>
            </button>
          }
        >
          <div className="ac-popover__row">
            {face}
            <span>{words}</span>
          </div>
        </Popover>
      )}
    </span>
  );
}

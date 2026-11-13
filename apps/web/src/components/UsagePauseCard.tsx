import type { CatchUpClosed, Message } from "@agenteschat/client";
import { keys, useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  answerAnywayOpen,
  mayAnswerAnyway,
  mayContinueUsage,
  type UsagePauseCard,
  type UsageWait,
  usagePauseText,
  usageWaitFix,
} from "@agenteschat/client/lib/usage-pause";
import { EventPillAction, Locked } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ButtonHTMLAttributes, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import { SeeUsageQueue } from "@/components/UsageQueue";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * A minor action under a note or in a queue row ("Não rodar", "Responder mesmo assim", "Ver fila"): words only, in the
 * agent's color, lined up with the text above. Greyed with its reason in `title` when the viewer may not press it.
 */
export function TextAction({
  pending,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean }) {
  return (
    <button
      type="button"
      className="cq-link"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    />
  );
}

/**
 * "Don't run it" on what waits for a plan's or budget's limit: cancels the run (`cancelRun`), so nothing runs when the
 * limit is back. For the person behind it, the agent's owner and admins; anyone else sees it greyed. The agent's
 * status and its queue follow.
 */
export function useDontRun(runId: string | null) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const run = async () => {
    if (!runId) return;
    setPending(true);
    try {
      await api.agents.cancelRun(org.id, runId);
      toast.show(t("usageCard.canceled"));
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setPending(false);
      void qc.invalidateQueries({ queryKey: keys.agentStatus(org.id) });
    }
  };
  return { run, pending };
}

export function DontRunButton({
  runId,
  may,
  count = 1,
  state,
}: {
  runId: string | null;
  may: boolean;
  count?: number;
  /** A card that locks its other buttons on it keeps the state itself. */
  state?: ReturnType<typeof useDontRun>;
}) {
  const { t } = useTranslation();
  const own = useDontRun(runId);
  const dontRun = state ?? own;
  if (!runId) return null;
  return (
    <TextAction
      pending={dontRun.pending}
      disabled={!may}
      title={t(may ? "usageCard.dontRunHint" : "usageCard.dontRunForbidden")}
      onClick={dontRun.run}
    >
      {count > 1 ? t("usageCard.dontRunThese", { count }) : t("usageCard.dontRun")}
    </TextAction>
  );
}

/**
 * Under an agent's "I'll answer when the plan resets": "Don't run it" ("Não rodar estas 3" for the later turns it
 * speaks for), while the run still waits, and "Ver fila": everything else it picks up when the limit is back.
 */
export function UsageWaitCancel({ message, wait }: { message: Message; wait: UsageWait }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const owner = dir.agentById.get(message.author.id ?? "")?.ownerUserId;
  const admin = can(org, "manage_agents");
  const may = mayContinueUsage(wait, me.user.id, owner, admin);
  const fix = usageWaitFix(message.meta, { admin, owner: owner === me.user.id });
  return (
    <span className="cq__acts">
      {fix && message.author.id && (
        <Link
          to="/org/$orgId/agents/$agentId"
          params={{ orgId: org.id, agentId: message.author.id }}
          search={{ tab: "settings", sec: fix === "raiseBudget" ? "budget" : "brain" }}
          className="ac-btn ac-btn--sm"
        >
          {t(`usageCard.${fix}`)}
        </Link>
      )}
      <DontRunButton runId={wait.runId} may={may} count={wait.count} />
      {message.author.id && <SeeUsageQueue agentId={message.author.id} />}
    </span>
  );
}

/**
 * "Responder mesmo assim" on a catch-up skipped as already handled (ADR 0136): the agent answers now, reading what was
 * posted since. Anyone who asked in it, the agent's owner and admins, for a week; anyone else sees it greyed.
 */
export function AnswerAnywayButton({
  runId,
  agentId,
  closed,
}: {
  runId: string;
  agentId: string | null;
  closed: CatchUpClosed;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const owner = dir.agentById.get(agentId ?? "")?.ownerUserId;
  const may = mayAnswerAnyway(closed, me.user.id, owner, can(org, "manage_agents"));
  if (!answerAnywayOpen(closed)) return null;
  return (
    <TextAction
      pending={pending}
      disabled={!may}
      title={t(may ? "usageCard.answerAnywayHint" : "usageCard.answerAnywayForbidden")}
      onClick={async () => {
        setPending(true);
        try {
          await api.agents.continueRun(org.id, runId);
        } catch (error) {
          toast.show(errorText(t, error), "error");
        } finally {
          setPending(false);
          void qc.invalidateQueries({ queryKey: keys.agentStatus(org.id) });
        }
      }}
    >
      {t("usageCard.answerAnyway")}
    </TextAction>
  );
}

/** Under a skipped catch-up's note: "Responder mesmo assim" until someone presses it, and "Ver fila" (on the skips). */
export function UsageWaitClosed({ message, wait }: { message: Message; wait: UsageWait & { closed: CatchUpClosed } }) {
  return (
    <span className="cq__acts">
      {!wait.continuedByUserId && (
        <AnswerAnywayButton runId={wait.runId} agentId={message.author.id ?? null} closed={wait.closed} />
      )}
      {message.author.id && <SeeUsageQueue agentId={message.author.id} tab="skipped" />}
    </span>
  );
}

/**
 * Long work paused near its plan's or budget's limit (ADR 0118), in place of its text, as a waiting pill: when it
 * picks up by itself under it, and "Continue now" (primary) or "Don't run it" for the person behind the work, the
 * agent's owner and admins. Anyone else sees them greyed, with who may press them. Continued, resumed, ended or
 * canceled, it turns into a decided pill saying so.
 */
export function UsagePauseCardView({ message, card }: { message: Message; card: UsagePauseCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const dontRun = useDontRun(card.runId);
  const agent = dir.agentById.get(card.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const { title, line } = usagePauseText(t, i18n.language, card, name);
  const may = mayContinueUsage(card, me.user.id, agent?.ownerUserId, can(org, "manage_agents"));
  const by = card.continuedByUserId;
  const time = card.continuedAt ? clockAt(i18n.language, card.continuedAt) : "";
  const go = async () => {
    setPending(true);
    try {
      await api.chat.answerNow(org.id, message.id);
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setPending(false);
    }
  };
  if (card.state === "continued" && by)
    return (
      <RequestDone done label={title}>
        {by === me.user.id
          ? t("stretchCard.continuedByYou", { time })
          : t("stretchCard.continued", { name: dir.memberById.get(by)?.name ?? t("channel.unknownPerson"), time })}
      </RequestDone>
    );
  if (card.state === "resumed" || card.state === "ended" || card.state === "canceled")
    return (
      <RequestDone done={card.state === "resumed"} label={title}>
        {t(`usageCard.${card.state}`, { agent: name })}
      </RequestDone>
    );
  return (
    <RequestOpen
      mine={may}
      icon="pause"
      label={title}
      action={
        <Locked when={pending || dontRun.pending}>
          <EventPillAction
            primary={may}
            disabled={!may}
            title={
              may ? t(card.source === "budget" ? "usageCard.hintBudget" : "usageCard.hint") : t("usageCard.forbidden")
            }
            onClick={go}
          >
            {t("usageCard.continue")}
          </EventPillAction>
          {card.runId && (
            <EventPillAction
              disabled={!may}
              title={t(may ? "usageCard.dontRunHint" : "usageCard.dontRunForbidden")}
              onClick={dontRun.run}
            >
              {t("usageCard.dontRun")}
            </EventPillAction>
          )}
        </Locked>
      }
      below={
        <>
          <span>{line}</span>
          {!may && <span>{t("usageCard.forbidden")}</span>}
        </>
      }
    >
      {title}
    </RequestOpen>
  );
}

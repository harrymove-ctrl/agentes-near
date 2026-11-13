import type { Agent, Approval, Member } from "@agenteschat/client";
import { useCancelApproval, useDecideApproval, useDecideApprovals } from "@agenteschat/client";
import {
  type ApprovalAction,
  aheadPhase,
  approvalAction,
  approvalRisk,
  approvalTraits,
  approveAlwaysOffered,
} from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalWhy } from "@agenteschat/client/lib/approval-origin";
import {
  aheadEndLine,
  alwaysRoutineName,
  approvalDetail,
  approvalSummary,
  approvalTitle,
  approvalWaitsFor,
  approveAlwaysHint,
  approveAlwaysLabel,
  decisionOutcome,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { nextLabel, timeLeft, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { ApprovalCard, Button, cx, EventPillAction, Icon, Tip } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useContext } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentWho } from "@/components/AgentAvatar";
import { OpenDetailsContext } from "@/components/details-link";
import { EmailLetter } from "@/components/EmailLetter";
import { RequestDone } from "@/components/RequestCard";
import { CardSky, colorOf, prepareBurst } from "@/components/Sky";
import { TYPED_VALUES } from "@/i18n";
import { useToast } from "@/lib/toast";
import { useOpenAgentPanel } from "./agent-panel-context";
import { useOrg } from "./org-context";

// Its title, what it wants to do, whether it only looks and its values: the phone's own rules too.
export {
  approvalDoing,
  approvalReadsOnly,
  approvalTitle,
  approvalValues,
} from "@agenteschat/client/lib/approval-words";
export { type ApprovalAction, approvalAction, approvalRisk, approvalTraits };

/** "Aprovado por você · agora" / "Recusado por João · ontem 18:02" / "Expirou · ontem". */
export function decisionLabel(
  t: TFunction,
  locale: string,
  approval: Approval,
  meId: string,
  members: Map<string, Member>,
  now = new Date(),
) {
  // Expired at its deadline (one approved ahead, at its time), not when someone decided it.
  const at =
    approval.status !== "expired"
      ? approval.decidedAt
      : aheadPhase(approval) === "lapsed"
        ? approval.runAt
        : approval.expiresAt;
  const when = at ? whenAt(t, locale, at, now) : t("common.now");
  if (approval.status === "expired") return t("approval.expiredChip", { when });
  if (approval.status === "canceled") return t("approval.canceledChip", { when });
  // Decided by someone covering (ADR 0139): "Aprovado por Bruno, cobrindo Ana · agora".
  if (approval.decidedForUserId)
    return `${decisionOutcome(t, approval, meId, (id) => members.get(id)?.name)} · ${when}`;
  const mine = approval.decidedByUserId === meId;
  const name = members.get(approval.decidedByUserId ?? "")?.name ?? "";
  if (approval.status === "approved")
    return mine ? t("approval.approvedByYou", { when }) : t("approval.approvedBy", { name, when });
  return mine ? t("approval.refusedByYou", { when }) : t("approval.refusedBy", { name, when });
}

/** Chip of a pending approval you can't decide: who it waits for. */
function waitingFor(t: TFunction, approval: Approval, agent: Agent | undefined, members: Map<string, Member>) {
  const owner = agent?.ownerUserId ? members.get(agent.ownerUserId) : undefined;
  const waits = approvalWaitsFor(approval, owner?.name);
  return waits ? t("approval.waitingFor", { name: waits }) : t("approval.waitingAdmin");
}

/**
 * "Aprovar sempre" ("Aprovar sempre leituras" for a SQL tool's reads), where the request offers it: approves this one
 * and the agent's next calls of its kind, and with it `also` (the requests of that kind waiting beside it,
 * `approveAlwaysAlso`). Its tip says exactly what that covers and where to undo it: the row holds only buttons.
 */
export function ApproveAlways({
  approval,
  agent,
  also = [],
}: {
  approval: Approval;
  agent: Agent | undefined;
  also?: string[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const openPanel = useOpenAgentPanel();
  const decide = useDecideApproval(org.id);
  const others = useDecideApprovals(org.id);
  const details = useContext(OpenDetailsContext);
  if (!approveAlwaysOffered(approval)) return null;
  const g = agentGrammar(agent?.name ?? t("channel.unknownAgent"));
  const kind = approval.approveAlways;
  const routine = alwaysRoutineName(t, approval);
  // In a conversation: the agent's Acesso in the panel beside it; elsewhere, its page.
  const open = () =>
    openPanel
      ? openPanel(approval.agentId, "access")
      : void navigate({
          to: "/org/$orgId/agents/$agentId",
          params: { orgId: org.id, agentId: approval.agentId },
          search: { tab: "access" },
        });
  const always = (el: HTMLElement) => {
    const burst = prepareBurst(el);
    // Not `mutate`'s own onSuccess: the decided event can unmount this button before the reply, and that callback
    // would then never send `also`. A failure is shown by the query client's mutation cache.
    decide.mutateAsync({ id: approval.id, decision: "approve", always: true }).then(
      () => {
        burst();
        if (also.length) others.mutate({ ids: also, decision: "approve" });
        if (routine && kind?.routineId) {
          const id = kind.routineId;
          toast.show(
            t("approval.always.doneRoutine", { routine }),
            "info",
            {
              label: t("approval.always.open"),
              run: () =>
                details
                  ? details({ kind: "routine", id })
                  : void navigate({ to: "/org/$orgId/routines", params: { orgId: org.id }, search: { open: id } }),
            },
            t("approval.always.undoRoutine"),
          );
          return;
        }
        toast.show(
          t("approval.always.done", { name: g.name }),
          "info",
          { label: t("approval.always.open"), run: open },
          t("approval.always.undoHere", { context: g.context, name: g.name }),
        );
      },
      () => {},
    );
  };
  return (
    <Tip tip={approveAlwaysHint(t, approval, g.name)} look="ac-hint__bubble ac-glass" align="center" button>
      <Button
        size="sm"
        icon="check"
        disabled={decide.isPending || others.isPending}
        loading={decide.isPending}
        onClick={(e) => always(e.currentTarget)}
      >
        {approveAlwaysLabel(t, approval)}
      </Button>
    </Tip>
  );
}

/** A request for an action prepared ahead: that approving covers a later run, and when (its card, its details). */
export function AheadLine({ approval, className }: { approval: Approval; className: string }) {
  const { t, i18n } = useTranslation();
  if (aheadPhase(approval) !== "asking" || !approval.runAt) return null;
  return (
    <p className={cx(className, "ac-iconline")}>
      <Icon name="calendar" size={16} />
      <span>{t("approval.ahead.line", { when: nextLabel(i18n.language, approval.runAt) })}</span>
    </p>
  );
}

/**
 * Withdraws an action approved ahead before its time (`canCancel`): its card in the chat, its routine's page; `pill`:
 * an action of the decided request's pill.
 */
export function CancelAhead({ id, pill = false }: { id: string; pill?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const cancel = useCancelApproval(org.id);
  if (pill)
    return (
      <EventPillAction
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(id, { onSuccess: () => toast.show(t("approval.ahead.canceled"), "info") })}
      >
        {t("approval.ahead.cancel")}
      </EventPillAction>
    );
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="close"
      disabled={cancel.isPending}
      loading={cancel.isPending}
      onClick={(e) => {
        // Inside a row that opens its details: canceling stays a click of its own.
        e.stopPropagation();
        cancel.mutate(id, { onSuccess: () => toast.show(t("approval.ahead.canceled"), "info") });
      }}
    >
      {t("approval.ahead.cancel")}
    </Button>
  );
}

function Actions({ approval, secondary }: { approval: Approval; secondary?: React.ReactNode }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const decide = useDecideApproval(org.id);
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "approve"}
        onClick={(e) => {
          // Approved: a burst of the agent's pixels from its avatar.
          const burst = prepareBurst(e.currentTarget);
          decide.mutate({ id: approval.id, decision: "approve" }, { onSuccess: burst });
        }}
      >
        {t(`approval.approve.${approvalAction(approval)}`)}
      </Button>
      <Button
        size="sm"
        disabled={decide.isPending}
        loading={decide.isPending && decide.variables?.decision === "refuse"}
        onClick={() => decide.mutate({ id: approval.id, decision: "refuse" })}
      >
        {t("approval.refuse")}
      </Button>
      {secondary}
    </>
  );
}

/** The approval card inside the channel: full while waiting, one line once decided. */
export function InlineApproval({
  approval,
  agent,
  members,
}: {
  approval: Approval;
  agent: Agent | undefined;
  members: Map<string, Member>;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const name = agent?.name ?? t("channel.unknownAgent");

  const ahead = aheadPhase(approval);
  const runAt = approval.runAt ? nextLabel(i18n.language, approval.runAt) : "";
  if (approval.status !== "pending") {
    // No one decided one that ran out: it expired at its deadline (one approved ahead, at its time).
    const ended =
      approval.decidedAt ??
      (approval.status !== "expired" ? null : ahead === "lapsed" ? approval.runAt : approval.expiresAt);
    const aheadText =
      ahead === "scheduled"
        ? t("approval.ahead.scheduled", { when: runAt })
        : ahead === "ran" && approval.executedAt
          ? t("approval.ahead.ran", { when: whenAt(t, i18n.language, approval.executedAt) })
          : aheadEndLine(t, approval);
    const summary = approvalSummary(approval, i18n.language);
    const requester = requesterDecidesLine(t, approval);
    // What was decided stays in the words, so several requests for one tool are told apart; who asked and why sit
    // behind "See details".
    const details = [requester, approval.reason ? t("approval.reasonLine", { reason: approval.reason }) : ""].filter(
      Boolean,
    );
    return (
      <RequestDone
        done={approval.status === "approved"}
        label={t(
          approval.status === "approved"
            ? "approval.groupDone"
            : approval.status === "expired"
              ? "approval.groupExpired"
              : approval.status === "canceled"
                ? "approval.groupCanceled"
                : "approval.groupRefused",
        )}
        more={details.length ? { label: t("approval.seeDetails"), content: details.join("\n") } : undefined}
        time={ended ? whenAt(t, i18n.language, ended) : undefined}
        note={aheadText || undefined}
        action={ahead === "scheduled" && approval.canCancel && <CancelAhead id={approval.id} pill />}
      >
        {decisionOutcome(t, approval, me.user.id, (id) => members.get(id)?.name)}: <b>{approvalTitle(t, approval)}</b>
        {summary && ` · ${summary}`}
      </RequestDone>
    );
  }
  const left = timeLeft(t, approval.expiresAt);
  const expires = left ? t("approval.expiresDetail", { time: left }) : "";
  const origin = approvalOriginShort(approval);
  const why = approvalWhy(approval);
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <ApprovalCard
      status="waiting"
      aria-label={t("approval.group")}
      sky={<CardSky color={colorOf(agent)} />}
      who={
        <Trans
          i18nKey="approval.asks"
          values={{ agent: name }}
          components={{ b: <AgentWho agentId={approval.agentId} name={name} /> }}
          {...TYPED_VALUES}
        />
      }
      statusLabel={approval.canDecide ? t("approval.waitingYou") : waitingFor(t, approval, agent, members)}
      origin={origin ? tt(origin.key, origin.values) : undefined}
      title={approvalTitle(t, approval)}
      action={approval.email ? <EmailLetter email={approval.email} /> : undefined}
      detail={
        approval.email
          ? expires || undefined
          : [approvalDetail(approval, i18n.language), requesterDecidesLine(t, approval), expires]
              .filter(Boolean)
              .join(" · ")
      }
      why={
        why ? (
          <Trans i18nKey="approval.said" values={{ name, text: why }} components={{ b: <b /> }} {...TYPED_VALUES} />
        ) : undefined
      }
      actions={approval.canDecide && <Actions approval={approval} />}
    />
  );
}

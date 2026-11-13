import type { CostlyDecision, Message } from "@agenteschat/client";
import { useApi } from "@agenteschat/client";
import { type CostlyProposalCard, mayDecideCostly, mayRememberCostly } from "@agenteschat/client/lib/action-cards";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { EventPillAction, Locked } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * An agent asks before costly work nobody asked for directly (ADR 0131 §3), as a waiting pill: its question, what it
 * wants to run under it, and "Go ahead" (primary), "Always", "Not now" or "Never" for this kind, for the person it is
 * for, the agent's owner or who manages agents (anyone else reads who it waits for). Then a decided pill says who
 * decided what, the command behind "See details".
 */
export function CostlyProposalCardView({ card }: { message: Message; card: CostlyProposalCard }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const toast = useToast();
  const [pending, setPending] = useState<CostlyDecision | null>(null);
  const ownerOf = (id: string) => dir.agentById.get(id)?.ownerUserId;
  const may = mayDecideCostly(card, me.user.id, ownerOf, can(org, "manage_agents"));
  const remembers = mayRememberCostly(card, me.user.id, ownerOf, can(org, "manage_agents"));
  const decide = async (decision: CostlyDecision) => {
    setPending(decision);
    try {
      await api.agents.decideCostly(org.id, card.signalId, decision);
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setPending(null);
    }
  };
  const decided = card.state !== "open";
  const by = card.decidedByUserId;
  const who =
    by === me.user.id ? t("costlyCard.you") : (dir.memberById.get(by ?? "")?.name ?? t("channel.unknownPerson"));
  const sentence = t(`chat.body.autonomy_proposal.${card.cost}`);
  const what = card.what ? <code className="small">{card.what}</code> : undefined;
  if (decided)
    return (
      <RequestDone
        done={card.state === "go" || card.state === "always"}
        label={sentence}
        more={what ? { label: t("approval.seeDetails"), content: what } : undefined}
      >
        {t(`costlyCard.decided.${card.state === "open" ? "go" : card.state}`, { name: who })}
      </RequestDone>
    );
  return (
    <RequestOpen
      mine={may}
      icon="shield"
      label={sentence}
      action={
        may ? (
          <Locked when={pending !== null}>
            <EventPillAction primary onClick={() => decide("go")}>
              {t("costlyCard.go")}
            </EventPillAction>
            {remembers && <EventPillAction onClick={() => decide("always")}>{t("costlyCard.always")}</EventPillAction>}
            <EventPillAction onClick={() => decide("not_now")}>{t("costlyCard.notNow")}</EventPillAction>
            {remembers && <EventPillAction onClick={() => decide("never")}>{t("costlyCard.never")}</EventPillAction>}
          </Locked>
        ) : undefined
      }
      below={
        what || !may ? (
          <>
            {what}
            {!may && <span>{t("costlyCard.waiting")}</span>}
          </>
        ) : undefined
      }
    >
      {sentence}
    </RequestOpen>
  );
}

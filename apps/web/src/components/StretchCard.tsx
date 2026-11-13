import type { Message } from "@agenteschat/client";
import { useApi, useSettings } from "@agenteschat/client";
import { mayContinueStretch, type StretchCard, stretchCardText } from "@agenteschat/client/lib/action-cards";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { EventPillAction } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usd } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * A stretch's pause (ADR 0089), in place of its text, as a waiting pill: the agents did what they may do on their own
 * since a person last acted, and wait here. "Continue" (primary, for who may) starts exactly the wake-ups it holds,
 * with a fresh allowance; the pill then turns into a decided one saying who let them go on and when. Money only for
 * people who can see costs; everyone else reads the percentage.
 */
export function StretchCardView({ message, card }: { message: Message; card: StretchCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const api = useApi();
  const toast = useToast();
  const settings = useSettings(org.id);
  const [pending, setPending] = useState(false);
  const names = card.agentIds.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent"));
  // The share of one agent's budget it stopped at, in money, when that budget is known to this viewer.
  const [first] = card.agentIds;
  const budget = first ? (dir.agentById.get(first)?.monthlyBudgetUsd ?? settings.data?.defaultAgentBudgetUsd) : null;
  const cost =
    card.reason === "spend" && can(org, "view_usage") && typeof budget === "number" && card.agentIds.length === 1
      ? usd(t, i18n.language, (budget * card.limit) / 100)
      : null;
  const continued = card.state === "continued";
  const by = card.continuedByUserId;
  const time = card.continuedAt ? clockAt(i18n.language, card.continuedAt) : "";
  const may = mayContinueStretch(
    card,
    me.user.id,
    (id) => dir.agentById.get(id)?.ownerUserId,
    can(org, "manage_agents"),
  );
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
  const text = stretchCardText(t, card, names, cost);
  if (continued) {
    return (
      <RequestDone done label={text}>
        {by === me.user.id
          ? t("stretchCard.continuedByYou", { time })
          : t("stretchCard.continued", {
              name: (by && dir.memberById.get(by)?.name) ?? t("channel.unknownPerson"),
              time,
            })}
      </RequestDone>
    );
  }
  return (
    <RequestOpen
      mine={may}
      icon="pause"
      label={text}
      action={
        may ? (
          <EventPillAction primary disabled={pending} onClick={go}>
            {t("run.continueRun")}
          </EventPillAction>
        ) : undefined
      }
    >
      {text}
    </RequestOpen>
  );
}

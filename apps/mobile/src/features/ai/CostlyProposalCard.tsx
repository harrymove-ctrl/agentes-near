import { type CostlyDecision, type Message, useApi } from "@agenteschat/client";
import { costlyProposalOf, mayDecideCostly, mayRememberCostly } from "@agenteschat/client/lib/action-cards";
import { can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { EventPillAction, EventPillText, Text, useTheme } from "@/ui";
import { AskDone, AskWaiting } from "../chat/asks";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";

/**
 * The web's request before costly work nobody asked for (ADR 0131 §3) in place of its text, as a waiting pill: what the
 * agent asks, what it wants to run under it, and "Go ahead" (tinted), "Always", "Not now" or "Never" for this kind, for
 * the person it is for, the agent's owner or an admin (anyone else reads who it waits for). Decided, a decided
 * request's pill says who decided what, the question and the command behind "See details".
 */
export function CostlyProposalCard({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const { fonts } = useTheme();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState<CostlyDecision | null>(null);
  const card = costlyProposalOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const ownerOf = (id: string) => dir.agentById.get(id)?.ownerUserId;
  const may = mayDecideCostly(card, meId ?? "", ownerOf, can(org, "manage_agents"));
  const remembers = mayRememberCostly(card, meId ?? "", ownerOf, can(org, "manage_agents"));
  const decide = async (decision: CostlyDecision) => {
    setPending(decision);
    try {
      await api.agents.decideCostly(orgId, card.signalId, decision);
    } catch (error) {
      failed(error);
    } finally {
      setPending(null);
    }
  };
  const decided = card.state !== "open";
  const by = card.decidedByUserId;
  const who = by === meId ? t("costlyCard.you") : (dir.memberById.get(by ?? "")?.name ?? t("channel.unknownPerson"));
  const sentence = t(`chat.body.autonomy_proposal.${card.cost}`);
  const what = card.what ? (
    <Text variant="footnote" tone="muted" style={{ fontFamily: fonts.mono }}>
      {card.what}
    </Text>
  ) : null;
  if (decided)
    return (
      <AskDone
        done={card.state === "go" || card.state === "always"}
        words={t(`costlyCard.decided.${card.state === "open" ? "go" : card.state}`, { name: who })}
        more={{
          label: t("approval.seeDetails"),
          content: (
            <>
              <Text variant="footnote" tone="ink2">
                {sentence}
              </Text>
              {what}
            </>
          ),
        }}
      />
    );
  // One answer at a time: while one is on its way, the others wait.
  const answer = (decision: CostlyDecision, label: string, primary = false) => (
    <EventPillAction
      key={decision}
      primary={primary}
      label={label}
      loading={pending === decision}
      disabled={pending !== null}
      onPress={() => void decide(decision)}
    />
  );
  return (
    <AskWaiting
      forMe={may}
      mark="shield"
      words={sentence}
      actions={
        may
          ? [
              answer("go", t("costlyCard.go"), true),
              remembers ? answer("always", t("costlyCard.always")) : null,
              answer("not_now", t("costlyCard.notNow")),
              remembers ? answer("never", t("costlyCard.never")) : null,
            ]
          : null
      }
      below={
        what || !may ? (
          <EventPillText>
            {what}
            {may ? null : (
              <Text variant="footnote" tone="muted">
                {t("costlyCard.waiting")}
              </Text>
            )}
          </EventPillText>
        ) : null
      }
    />
  );
}

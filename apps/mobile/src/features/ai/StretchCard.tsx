import { type Message, useApi } from "@agenteschat/client";
import { mayContinueStretch, stretchCardOf, stretchCardText } from "@agenteschat/client/lib/action-cards";
import { clockAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useOrg } from "@/providers/org";
import { EventPillAction } from "@/ui";
import { AskDone, AskWaiting } from "../chat/asks";
import { useFailed } from "../routines/hooks";
import { useDirectory, useMeId } from "../shared/hooks";

/**
 * The web's pause of a stretch (ADR 0089) in place of its text, as a waiting pill: the agents did what they may do on
 * their own since a person last acted, and wait. "Continue" (tinted) lets them go on, for who asked, the agents' owners
 * or an admin; then it is a decided request's pill: who did, and when. The phone says the budget share as a percentage
 * only.
 */
export function StretchCard({ message: m }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const meId = useMeId();
  const failed = useFailed();
  const [pending, setPending] = useState(false);
  const card = stretchCardOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  const names = card.agentIds.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent"));
  const continued = card.state === "continued";
  const by = card.continuedByUserId;
  const time = card.continuedAt ? clockAt(i18n.language, card.continuedAt) : "";
  const may = mayContinueStretch(card, meId, (id) => dir.agentById.get(id)?.ownerUserId, can(org, "manage_agents"));
  const go = async () => {
    setPending(true);
    try {
      await api.chat.answerNow(orgId, m.id);
    } catch (error) {
      failed(error);
    } finally {
      setPending(false);
    }
  };
  if (continued) {
    return (
      <View>
        <AskDone
          done
          words={
            by === meId
              ? t("stretchCard.continuedByYou", { time })
              : t("stretchCard.continued", {
                  name: (by && dir.memberById.get(by)?.name) ?? t("channel.unknownPerson"),
                  time,
                })
          }
        />
      </View>
    );
  }
  return (
    <AskWaiting
      forMe={may}
      mark="pause"
      words={stretchCardText(t, card, names)}
      actions={
        may ? (
          <EventPillAction
            key="continue"
            primary
            label={t("run.continueRun")}
            loading={pending}
            onPress={() => void go()}
          />
        ) : null
      }
    />
  );
}

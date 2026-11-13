import type { Message } from "@agenteschat/client";
import { useCalendarProposal } from "@agenteschat/client";
import type { CalendarProposalCard } from "@agenteschat/client/lib/action-cards";
import { slotText } from "@agenteschat/client/lib/calendar";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { EventPillAction } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { useOrg } from "@/components/org-context";
import { RequestDone, RequestOpen } from "@/components/RequestCard";
import { useToast } from "@/lib/toast";

/**
 * An agent's event proposal in its conversation (`propose_event`): who asked (or who configures the workspace)
 * confirms it there, which creates the event and invites the people, or asks for another time; anyone else reads
 * who confirms it. Decided, one line says how it ended.
 */
export function CalendarProposalCardView({ message, card }: { message: Message; card: CalendarProposalCard }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const actors = useActors();
  const toast = useToast();
  const decide = useCalendarProposal(org.id, { channelId: message.channelId, messageId: message.id });
  const p = card.proposal;
  const label = t("chat.body.calendar_proposal", { title: p.title });
  if (p.status !== "pending") {
    return (
      <RequestDone done={p.status === "confirmed"} label={label}>
        <b>{p.title}</b> · {t(p.status === "confirmed" ? "calendar.confirmed" : "calendar.proposalDismissed")}
      </RequestDone>
    );
  }
  const mine = p.requesterUserId === me.user.id || can(org, "configure");
  const run = (decision: "confirm" | "dismiss") =>
    decide.mutate(
      { proposal: p, decision },
      { onError: (error) => toast.show(errorText(t, error, i18n.language), "error") },
    );
  const requester = p.requesterUserId ? actors.name({ type: "person", id: p.requesterUserId }) : "";
  return (
    <RequestOpen
      mine={mine}
      icon="calendar"
      label={label}
      action={
        mine ? (
          <>
            <EventPillAction primary disabled={decide.isPending} onClick={() => run("confirm")}>
              {t("calendar.confirm")}
            </EventPillAction>
            <EventPillAction disabled={decide.isPending} onClick={() => run("dismiss")}>
              {t("calendar.otherTime")}
            </EventPillAction>
          </>
        ) : undefined
      }
      below={
        <>
          <p>
            {t("calendar.proposalDetail", {
              when: slotText(i18n.language, p.start, p.end),
              people: joinNames(p.participants.map(actors.name), t),
            })}
          </p>
          {p.note && <p>{p.note}</p>}
          {!mine && requester && <p>{t("calendar.proposalWaits", { name: requester })}</p>}
        </>
      }
    >
      {p.title}
    </RequestOpen>
  );
}

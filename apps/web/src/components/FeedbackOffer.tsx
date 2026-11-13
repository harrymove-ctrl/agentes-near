import { type Message, useAuthConfig, useFeedbackOffer, useMe, useSetChatPrefs } from "@agenteschat/client";
import { feedbackOfferFor } from "@agenteschat/client/lib/feedback-offer";
import { EventPillAction, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useOrg } from "./org-context";
import { RequestDone } from "./RequestCard";
import "./agent-actions.css";

/**
 * A report about the app the agent offered on its own (`meta.feedbackOffer`, ADR 0160 §12), under its reply and only
 * for the person it goes in the name of. While it waits: a row of the receipts' family with the problem in a few
 * words, "See the report" opening the agent's text inside the row, and Send and Not now at its end. Nothing waits on
 * it. Sent, it is a decided request's pill with "View" and "Always send"; one that went with the reply (they chose
 * Always send) says so and holds "Ask before sending". Put away, it is gone.
 */
export function FeedbackOfferRow({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const meId = useMe().data?.user.id;
  const cloud = useAuthConfig().data?.cloud === true;
  const offer = message.author.type === "agent" ? feedbackOfferFor(message.meta, meId) : null;
  const decide = useFeedbackOffer(org.id, {
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
  });
  const prefs = useSetChatPrefs(org.id);
  const [open, setOpen] = useState(false);
  if (!offer) return null;
  const always = org.chatPrefs?.feedbackAuto === true;
  const report = (
    <>
      <p className="ag-fb__text">{offer.text}</p>
      <p className="ag-fb__note">{t("feedback.offer.answer")}</p>
    </>
  );

  if (offer.state === "sent") {
    return (
      <RequestDone
        done
        label={t("feedback.offer.group")}
        more={{
          label: t("feedback.offer.view"),
          content: (
            <>
              {report}
              {always && (
                <button type="button" className="ag-fb__more" onClick={() => prefs.mutate({ feedbackAuto: false })}>
                  {t("feedback.offer.askFirst")}
                </button>
              )}
            </>
          ),
        }}
        action={
          // A server from before the choice can't keep it.
          !always && org.chatPrefs !== undefined ? (
            <EventPillAction disabled={prefs.isPending} onClick={() => prefs.mutate({ feedbackAuto: true })}>
              {t("feedback.offer.always")}
            </EventPillAction>
          ) : undefined
        }
        note={always && !offer.auto ? t("feedback.offer.alwaysOn") : undefined}
      >
        {offer.auto ? (
          <Trans i18nKey="feedback.offer.sentAuto" values={{ summary: offer.summary }} components={{ b: <b /> }} />
        ) : (
          <Trans i18nKey={cloud ? "feedback.offer.sentCloud" : "feedback.offer.sentServer"} components={{ b: <b /> }} />
        )}
      </RequestDone>
    );
  }

  const busy = decide.isPending;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ag-rcs" role="group" aria-label={t("feedback.offer.group")}>
      <div className="ag-rc ag-fb">
        <span className="ag-rc__ic" aria-hidden="true">
          <Icon name="flag" size={16} />
        </span>
        <span className="ac-actline">
          <span className="ag-rc__tx">
            <span className="ag-rc__sentence">
              <Trans i18nKey="feedback.offer.ready" values={{ summary: offer.summary }} components={{ b: <b /> }} />
            </span>
            <span className="ag-rc__by">
              {t(cloud ? "feedback.offer.goesCloud" : "feedback.offer.goesServer")}
              {" · "}
              <button type="button" className="ag-fb__more" aria-expanded={open} onClick={() => setOpen(!open)}>
                {t(open ? "feedback.offer.hide" : "feedback.offer.see")}
              </button>
            </span>
          </span>
          <span className="ag-fb__acts">
            <button
              type="button"
              className="ag-rc__btn ag-fb__send"
              disabled={busy}
              onClick={() => decide.mutate("send")}
            >
              {t("feedback.offer.send")}
            </button>
            <button
              type="button"
              className="ag-rc__btn ag-fb__no"
              disabled={busy}
              onClick={() => decide.mutate("dismiss")}
            >
              {t("feedback.offer.notNow")}
            </button>
          </span>
        </span>
        {open && <div className="ag-fb__open">{report}</div>}
      </div>
    </div>
  );
}

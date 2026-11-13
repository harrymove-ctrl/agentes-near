import { useAuthConfig } from "@agenteschat/client";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { Button, Dialog, DialogBody, DialogFooter, Icon, type IconName } from "@agenteschat/ui";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { sceneTeam, TeamScene } from "./TeamScene";
import "./arrival.css";

const POINTS: readonly { icon: IconName; key: "weekly" | "fails" | "feedback" }[] = [
  { icon: "bolt", key: "weekly" },
  { icon: "alert", key: "fails" },
  { icon: "message", key: "feedback" },
];

/**
 * The beta notice (ADR 0160), once, right after the onboarding: the product is in beta, what that means, and where
 * feedback goes when this server takes it. Every way out goes on (`onContinue`): there is nothing to refuse.
 */
export function BetaDialog({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const feedback = useAuthConfig().data?.feedback === true;
  const lead = rightHandOf(dir.agents);
  const go = useRef<HTMLButtonElement>(null);
  const where = feedback ? (
    <span className="ac-iconline">
      <Icon name="message" />
      <span>{t("arrival.beta.where")}</span>
    </span>
  ) : undefined;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onContinue()}
      title={t("arrival.beta.title")}
      closeLabel={t("common.close")}
      width={480}
      bare
      // Enter goes on: the dialog starts on its one action.
      initialFocus={go}
      className="arrival arrival-beta"
    >
      <div className="arrival-hero">
        <TeamScene agents={sceneTeam(dir.agents, lead)} lead={lead?.id} />
        <span className="arrival-beta__word" aria-hidden="true">
          {t("arrival.beta.word")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="arrival-hero__close"
          aria-label={t("common.close")}
          onClick={onContinue}
        />
      </div>
      {/* The dialog's name is its hidden title; this is the same sentence, drawn. */}
      <div className="arrival-lede">
        <p className="arrival-lede__title" aria-hidden="true">
          {t("arrival.beta.title")}
        </p>
        <p className="arrival-lede__text">{t("arrival.beta.text")}</p>
      </div>
      <DialogBody>
        <ul className="arrival-points">
          {/* Asking for feedback only where there is a form to send it. */}
          {POINTS.filter((p) => feedback || p.key !== "feedback").map((p) => (
            <li key={p.key} className="ac-iconline">
              <Icon name={p.icon} />
              <div>
                <b>{t(`arrival.beta.${p.key}.title`)}</b>
                <span>{t(`arrival.beta.${p.key}.text`)}</span>
              </div>
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter note={where}>
        <Button ref={go} variant="primary" kbd={["↵"]} onClick={onContinue}>
          {t("common.continue")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

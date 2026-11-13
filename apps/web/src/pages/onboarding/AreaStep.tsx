import { WORK_AREAS, type WorkArea, type WorkAreaAnswer } from "@agenteschat/client/lib/work-area";
import { Button, Icon, type IconName } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * "And you, what do you work on?": the person's own area, asked once per account (about them, never the workspace),
 * on a screen of its own right before the team step: the business step's chips (each with its icon), one picked at a
 * time, the step's Continue once one is, and "Skip this step" under it. The page saves the answer without waiting.
 */
export function AreaStep({ onAnswer }: { onAnswer: (area: WorkAreaAnswer) => void }) {
  const { t } = useTranslation();
  const [area, setArea] = useState<WorkArea | null>(null);
  return (
    <>
      <div className="onb__answer">
        <div className="tp-chips__row">
          {WORK_AREAS.map((a) => (
            <button key={a} type="button" className="tp-chip" aria-pressed={a === area} onClick={() => setArea(a)}>
              <Icon name={AREA_ICONS[a]} size={14} />
              <span>{t(`onboarding.flow.area.options.${a}`)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="onb__actions">
        <Button
          variant="primary"
          block
          kbd={["↵"]}
          data-enter=""
          disabled={!area}
          onClick={() => area && onAnswer(area)}
        >
          {t("onboarding.actions.continue")}
        </Button>
        <p className="onb__skip">
          <button type="button" className="ac-link" onClick={() => onAnswer("skipped")}>
            {t("onboarding.flow.area.skip")}
          </button>
        </p>
      </div>
    </>
  );
}

/** Each area's chip leads with its icon, chosen or not (the chip darkens when chosen). */
const AREA_ICONS: Record<WorkArea, IconName> = {
  dev: "code",
  marketing: "bulb",
  sales: "chart",
  finance: "wallet",
  ops: "cog",
  support: "message",
  other: "more",
};

import type { Agent } from "@agenteschat/client";
import { keys, useApplyTeamTemplate, useRoutines, useTeamTemplates } from "@agenteschat/client";
import type { PlanOffer } from "@agenteschat/client/lib/billing";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstJob } from "@agenteschat/client/lib/onboarding";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  aboutContext,
  aboutOf,
  BUSINESS_TYPES,
  type BusinessType,
  teamFailureText,
  templateFor,
} from "@agenteschat/client/lib/team-plan";
import { Button, Chip, Field, Icon, type IconName, Locked, Select, Skeleton, Spinner, Textarea } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOpenBilling } from "@/components/BillingLinkButton";
import { TeamAsleepSky } from "@/components/Sky";
import { TeamPlanBody } from "@/components/TeamPlan";
import { lookOf } from "@/lib/look";

/** The templates, the one step 3 shows (`business`'s, else the first), and the person's pick among them. */
export function useTemplate(orgId: string | null, business: BusinessType | null, enabled: boolean) {
  const { i18n } = useTranslation();
  const list = useTeamTemplates(orgId ?? "", i18n.language, orgId !== null && enabled);
  const [picked, pick] = useState<string | null>(null);
  const templates = list.data ?? [];
  return { templates, chosen: templateFor(templates, picked, business), pick, failed: list.isError };
}

/**
 * Step 2, "O que a Acme faz?": the business types to tap and one optional sentence, saved together as the workspace's
 * context, which every agent reads. "Outra coisa" asks for the sentence.
 */
export function BusinessStep({
  orgId,
  context,
  business,
  onDone,
}: {
  orgId: string;
  context: string;
  business: BusinessType | null;
  onDone: (business: BusinessType | null) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const [kind, setKind] = useState<BusinessType | null>(business);
  const [line, setLine] = useState(() => aboutOf(t, context).line);
  const other = kind === "other";
  const text = aboutContext(t, kind, line);
  const save = useMutation({
    mutationFn: () => api.orgs.updateSettings(orgId, { context: text }),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings(orgId), settings);
      onDone(kind);
    },
  });
  return (
    <>
      <Locked when={save.isPending}>
        <div className="onb__answer">
          <div className="tp-chips__row">
            {BUSINESS_TYPES.map((b) => (
              <button
                key={b}
                type="button"
                className="tp-chip"
                aria-pressed={b === kind}
                onClick={() => setKind(b === kind ? null : b)}
              >
                <Icon name={BUSINESS_ICONS[b]} size={14} />
                <span>{t(`teamPlan.business.${b}`)}</span>
              </button>
            ))}
          </div>
          <Field
            label={t("agentSetup.firstRun.about.line")}
            hint={{
              name: t("common.about", { label: t("agentSetup.firstRun.about.line") }),
              text: other ? undefined : t("agentSetup.firstRun.about.optional"),
            }}
          >
            <Textarea
              className="onb__line"
              rows={1}
              autoGrow
              value={line}
              onChange={(e) => setLine(e.target.value)}
              maxLength={500}
              required={other}
            />
          </Field>
          {save.isError && (
            <p className="onb__error" role="alert">
              {errorText(t, save.error)}
            </p>
          )}
        </div>
      </Locked>
      <div className="onb__actions">
        <Button
          variant="primary"
          block
          kbd={["↵"]}
          data-enter=""
          disabled={!text}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {t("onboarding.actions.continue")}
        </Button>
      </div>
    </>
  );
}

/**
 * Step 3, "Your team", once "Start with a ready-made team" answered how to start (`TeamStart`, ADR 0162 amended
 * 2026-11-11): the template for the workspace's business (another one from the select), made in one click with no model
 * call; its Back returns to how to start, where "Start from scratch" is the way on with no agents. Once the team exists,
 * it shows who is in it. A personal workspace never gets a template here (ADR 0159): its card in the right hand's DM
 * makes its agents later.
 */
export function TeamStep({
  orgId,
  team,
  waiting = false,
  template,
  reviewer,
  onContinue,
}: {
  orgId: string;
  team: Agent[];
  /** The team made, the page still reading where it goes next: the template stays, its button pending. */
  waiting?: boolean;
  template: ReturnType<typeof useTemplate>;
  reviewer: string;
  onContinue: () => void;
}) {
  const { t, i18n } = useTranslation();
  // Pending until the team is in the agents' list, then while the page places the next step: a second press never
  // makes a second team.
  const use = useApplyTeamTemplate(orgId);
  const pending = use.isPending || waiting;
  const [failed, setFailed] = useState<string | null>(null);
  const { chosen } = template;
  if (team.length > 0)
    return (
      <>
        <ul className="tp-agents onb__team">
          {team.map((a) => (
            <li key={a.id} className="tp-agent ac-mediarow">
              <span className="ac-mediarow__face">
                <AgentAvatar name={a.name} appearance={lookOf(a)} size="md" />
              </span>
              <span className="ac-mediarow__head">
                <b>{a.name}</b>
                <span className="ac-mediarow__meta">{a.role}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="onb__actions">
          <Button variant="primary" block kbd={["↵"]} data-enter="" onClick={onContinue}>
            {t("onboarding.actions.continue")}
          </Button>
        </div>
      </>
    );
  return (
    <>
      <Locked when={pending}>
        <div className="onb__answer">
          <Field label={t("teamPlan.templates.title")} id="onb-template">
            <Select
              id="onb-template"
              value={chosen?.id}
              onValueChange={(id) => {
                template.pick(id);
                setFailed(null);
              }}
              options={template.templates.map((x) => ({ value: x.id, label: x.name }))}
              disabled={!chosen}
            />
          </Field>
          {chosen ? (
            <TeamPlanBody plan={chosen.team} reviewer={reviewer} />
          ) : template.failed ? (
            <p className="onb__error" role="alert">
              {t("common.loadFailed")}
            </p>
          ) : (
            // The team's final shape while the templates load, so nothing moves when they arrive.
            <ul className="tp-agents onb__team-wait" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="tp-agent ac-mediarow">
                  <span className="ac-mediarow__face">
                    <Skeleton shape="square" width={32} height={32} />
                  </span>
                  <span className="ac-mediarow__head">
                    <Skeleton width="40%" />
                  </span>
                  <span className="ac-mediarow__body">
                    <Skeleton width="80%" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Locked>
      <div className="onb__actions">
        {failed && (
          <p className="onb__error" role="alert">
            {failed}
          </p>
        )}
        <Button
          variant="primary"
          block
          kbd={["↵"]}
          data-enter=""
          disabled={!chosen}
          loading={pending}
          onClick={() =>
            chosen &&
            use.mutate(
              { templateId: chosen.id, locale: i18n.language },
              {
                onSuccess: (out) => {
                  // A step that failed: its reason here, and the same button tries again.
                  if (out.state !== "created")
                    return setFailed(
                      out.error ? teamFailureText(t, out.error, i18n.language) : t("teamPlan.templates.failed"),
                    );
                  setFailed(null);
                },
                onError: (e) => setFailed(errorText(t, e)),
              },
            )
          }
        >
          {t(failed ? "teamPlan.card.retry" : "teamPlan.templates.create")}
        </Button>
      </div>
    </>
  );
}

/**
 * Step 4, "Turn the team on" (agentes.chat Cloud, a workspace waiting for its first plan): the team asleep until it,
 * what each one does (its first routine, else its role; the right hand, what it is to the person), the plan the
 * billing service recommends with its price when it says one, what comes after it (`next`: connecting an AI, ADR
 * 0162), and the way in without it, where the right hand's card keeps the plan. Back from paying (`confirming`), the
 * payment said as received until the hold lifts.
 */
export function PlanStep({
  orgId,
  team,
  offer,
  skipping,
  onSkip,
  next,
  confirming,
  personal,
}: {
  orgId: string;
  team: Agent[];
  offer: PlanOffer | null;
  skipping: boolean;
  onSkip: () => void;
  next: boolean;
  confirming: boolean;
  personal: boolean;
}) {
  const { t } = useTranslation();
  const routines = useRoutines(orgId).data;
  const turnOn = useOpenBilling(orgId, "onboarding", offer?.key);
  const allPlans = useOpenBilling(orgId, "onboarding");
  return (
    <>
      <section
        className="onb__plan"
        aria-label={t(personal ? "onboarding.flow.steps.planPersonal" : "onboarding.flow.steps.plan")}
      >
        {/* A picture of the list under it (each name, then what it does first): read once, from the list. */}
        <div className="onb__plan-faces" aria-hidden="true">
          <TeamAsleepSky />
          {team.map((a) => (
            <span key={a.id} className="onb__plan-face">
              <AgentAvatar name={a.name} appearance={lookOf(a)} size="lg" state="sleeping" />
              <Chip className="sky-chip">{a.name}</Chip>
            </span>
          ))}
          <Chip className="sky-chip onb__plan-zz">
            {t(personal ? "onboarding.flow.plan.asleepPersonal" : "onboarding.flow.plan.asleep")}
          </Chip>
        </div>
        <ul className="onb__plan-week">
          {team.map((a) => {
            // The right hand has no role of its own: it is said as what it is to the person. Nothing to say, no dot.
            const job = firstJob(a, routines) || (isRightHand(a) ? t("rightHand.labelCapitalized") : "");
            return (
              <li key={a.id} className="ac-iconline">
                <Icon name="check" size={14} />
                <span>
                  <b>{a.name}</b>
                  {job && ` · ${job}`}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="onb__plan-price">
          <span>
            {offer ? (
              <Trans
                i18nKey={offer.price ? "onboarding.flow.plan.price" : "onboarding.flow.plan.name"}
                values={{ name: offer.name, price: offer.price }}
                components={{ b: <b /> }}
              />
            ) : (
              t("onboarding.flow.plan.generic")
            )}
          </span>
          <span className="muted">{t("onboarding.flow.plan.cancel")}</span>
        </div>
        {confirming ? (
          // Back from paying: the billing service lifts the hold on its next pass, and the next step opens then. A line
          // of the card in place of its buttons, never a box inside it.
          <p className="onb__paid ac-iconline" role="status">
            <Spinner size={14} />
            <span>{t("standing.billing.paid")}</span>
          </p>
        ) : (
          <div className="onb__plan-acts">
            <Button variant="primary" loading={turnOn.isPending} disabled={skipping} onClick={() => turnOn.mutate()}>
              {t(personal ? "onboarding.flow.plan.ctaPersonal" : "onboarding.flow.plan.cta")}
            </Button>
            {offer && (
              <button
                type="button"
                className="ac-link"
                disabled={allPlans.isPending || skipping}
                onClick={() => allPlans.mutate()}
              >
                {t("onboarding.flow.plan.all")}
              </button>
            )}
            {next && <span className="muted">{t("onboarding.flow.plan.next")}</span>}
          </div>
        )}
      </section>
      {!confirming && (
        <p className="onb__skip">
          <button type="button" className="ac-link" disabled={skipping || turnOn.isPending} onClick={onSkip}>
            {t("onboarding.flow.plan.skip")}
          </button>
        </p>
      )}
    </>
  );
}

/** Each business type's chip leads with its icon, chosen or not (the chip darkens when chosen). */
const BUSINESS_ICONS: Record<BusinessType, IconName> = {
  agency: "bulb",
  store: "archiveBox",
  clinic: "calendar",
  software: "code",
  support: "message",
  services: "document",
  other: "more",
};

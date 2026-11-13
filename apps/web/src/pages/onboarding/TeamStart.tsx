import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  type AgentAppearance,
  Button,
  Icon,
  Locked,
  playAgentReaction,
  RadioCard,
  RadioGroup,
  Skeleton,
} from "@agenteschat/ui";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { lookOf } from "@/lib/look";
import type { useTemplate } from "./steps";
import type { TeamSourceState, TeamStartPick } from "./TeamSource";
import "./team-start.css";

/** Between the faces of a row hopping one after another as it is picked. */
const HOP_GAP_MS = 80;

/**
 * How a team with no agents yet starts (ADR 0162, amended 2026-11-11), after "I don't use any yet": two radio cards,
 * as the question's own "I don't use any yet", each with who comes in it. "Start with a ready-made team" (the
 * template for the workspace's business, named, with its agents) leads to the templates; "Start from scratch", picked
 * when the view opens, leaves the step with the right hand alone (`skip`, stored as `agents`). The picked row's agents
 * are awake and hop one after another as it is picked, the other's doze; the preview beside the step shows the
 * template's team while it is picked. Enter on a card presses the step's button (the page's `data-enter`).
 */
export function TeamStart({
  state,
  template,
  lodi,
}: {
  state: TeamSourceState;
  template: ReturnType<typeof useTemplate>;
  /** The right hand, as the rail shows it. */
  lodi: { name: string; look: AgentAppearance };
}) {
  const { t } = useTranslation();
  const { start, pickStart, skip, link } = state;
  const { chosen } = template;
  const agents = chosen?.team.agents ?? [];
  const grammar = agentGrammar(lodi.name);
  useHops(start, agents.length);
  // The picked row's faces awake, the other's dozing; each answers its own hop.
  const face = (pick: TeamStartPick, i: number) => ({
    state: start === pick ? undefined : ("sleeping" as const),
    reactionKey: `onb-start-${pick}-${i}`,
  });
  return (
    <>
      <Locked when={skip.isPending}>
        <div className="onb__answer">
          <RadioGroup<TeamStartPick>
            value={start}
            onValueChange={pickStart}
            aria-label={t("onboarding.flow.team.start.title")}
            className="onb-start"
          >
            <RadioCard
              value="template"
              id="onb-start-template"
              checked={start === "template"}
              title={t("onboarding.flow.team.start.template")}
              description={
                chosen ? (
                  t("onboarding.flow.team.start.templateText", { count: agents.length, template: chosen.name })
                ) : template.failed ? (
                  t("common.loadFailed")
                ) : (
                  <Skeleton width="80%" />
                )
              }
              detail={
                agents.length > 0 && (
                  <span className="onb-start__who">
                    <span className="onb-start__faces">
                      {agents.map((a, i) => (
                        <AgentAvatar
                          key={a.handle}
                          name={a.name}
                          appearance={lookOf(a)}
                          size="sm"
                          {...face("template", i)}
                        />
                      ))}
                    </span>
                    <span className="onb-start__names">
                      {joinNames(
                        agents.map((a) => a.name),
                        t,
                      )}
                    </span>
                  </span>
                )
              }
            />
            <RadioCard
              value="scratch"
              id="onb-start-scratch"
              checked={start === "scratch"}
              title={t("onboarding.flow.team.start.scratch")}
              description={t("onboarding.flow.team.start.scratchText", grammar)}
              detail={
                <span className="onb-start__who">
                  <span className="onb-start__faces">
                    <AgentAvatar name={lodi.name} appearance={lodi.look} size="sm" {...face("scratch", 0)} />
                    <span className="onb-start__seat" aria-hidden="true">
                      <Icon name="plus" size={14} />
                    </span>
                  </span>
                  <span className="onb-start__names">
                    {t("onboarding.flow.team.start.scratchWho", { name: lodi.name })}
                  </span>
                </span>
              }
            />
          </RadioGroup>
        </div>
      </Locked>
      <div className="onb__actions">
        <Button
          variant="primary"
          block
          kbd={["↵"]}
          data-enter=""
          disabled={start === "template" ? !chosen : false}
          loading={skip.isPending}
          onClick={() => (start === "template" ? link.go("template") : skip.mutate())}
        >
          {start === "template"
            ? t("onboarding.flow.team.start.see")
            : t("onboarding.flow.team.start.scratchGo", grammar)}
        </Button>
      </div>
    </>
  );
}

/**
 * The picked row's agents hop one after another (the agent engine's "up" reaction, as the first question's scene),
 * never on the view's first look: "Start from scratch" comes picked. With reduced motion the reaction only changes the
 * face (the engine's own rule).
 */
function useHops(start: TeamStartPick, count: number) {
  const shown = useRef(start);
  useEffect(() => {
    if (shown.current === start) return;
    shown.current = start;
    const faces = start === "template" ? count : 1;
    const timers = Array.from({ length: faces }, (_, i) =>
      setTimeout(() => playAgentReaction(`onb-start-${start}-${i}`, "up"), i * HOP_GAP_MS),
    );
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [start, count]);
}

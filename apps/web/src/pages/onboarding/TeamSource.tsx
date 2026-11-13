import { keys, type Me } from "@agenteschat/client";
import type { ImportCard, RequestCard } from "@agenteschat/client/lib/import/flow";
import { type OnboardingStepId, stepIndex } from "@agenteschat/client/lib/onboarding";
import { Skeleton } from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { useApi } from "@/api/context";
import type { PreviewAgent } from "./OnboardingPreview";
import "@/components/import-flow.css";
import "./team-source.css";

/**
 * The team step before a team exists (ADR 0162, amended 2026-11-10 and 2026-11-11): first the question (agents in
 * another app, or none yet), then bringing them (ADR 0055) inside the step, or, for a team with none yet, how to start
 * ("Start with a ready-made team", its templates next, or "Start from scratch", the step left with no agents); a team
 * may also skip the step from the question. This module stays light: the
 * import's screens, its hook and its readers (archives, every app's parser) load with `TeamSourceBody` only once the
 * step shows them, so the onboarding's first screens never carry them.
 */

/**
 * What the step shows: the question, a team's start and its templates (rendered by the page), the request or the files
 * to bring them, what was found, and the report of what came (kept on screen until its Continue when something stayed
 * behind).
 */
export type TeamSourceView = "ask" | "start" | "template" | "bring" | "found" | "report";

/** How a team with no agents yet starts: a template's team, or from scratch with the right hand alone. */
export type TeamStartPick = "template" | "scratch";

/** An answer to the question: one of the import's apps, or none yet. */
export type TeamSourceChoice = ImportCard | "none";

type Stage = "ask" | "start" | "template" | "import";

/** What the import holds now, as the page's heading, Lodi's line and the preview read it (the views publish it). */
export interface TeamSourceFacts {
  /** The card being brought from (the import's own picker can change it). */
  card: ImportCard | null;
  /** The app on screen: the card being brought from, then the app the answer came from. Null for any other app. */
  app: string | null;
  /** The agents in what was read. */
  count: number;
  /** Read and planned: the agents and channels that come with it. */
  coming: { agents: PreviewAgent[]; channels: string[] } | null;
  /** The apply's report is up. */
  report: boolean;
  /** The apply is running. */
  applying: boolean;
  /** The import's "Connect with MCP" steps are on screen: the app creates the agents here itself. */
  mcp: boolean;
}

const NO_FACTS: TeamSourceFacts = {
  card: null,
  app: null,
  count: 0,
  coming: null,
  report: false,
  applying: false,
  mcp: false,
};

/**
 * The apps that answer the export request in their own chat, so the step asks for that answer pasted. The others hand
 * back a file or a folder, which the import's own picker takes.
 */
const replyCardOf = (choice: TeamSourceChoice | null): RequestCard | null => (choice === "grok-bot" ? choice : null);

/**
 * The named apps that answer the export request (Grok Bot's answer pasted, ChatGPT dots' file dropped): Lodi says to
 * copy it there. "Another app" has no name to say it with, and ends on the same drop as the file apps.
 */
const asksFirst = (card: ImportCard | null) => card === "grok-bot" || card === "chatgpt-dots";

/**
 * The step's state, at the page's level so it outlives the step's own views and the rail's moves: the answer picked,
 * the view, and the hold that keeps the step on screen (`onHold`: the page pins the team step) while the import
 * applies and while its report waits. The answers are saved on the workspace's onboarding, so a resume knows them: a
 * team's "no agents yet" saves `step: "import"` and opens on how to start (a reload there or on the templates opens on
 * it again, "Start from scratch" picked); leaving the step with no agents saves `step: "agents"`, which answers it (a
 * personal workspace's "no agents yet", ADR 0159; a team's `skip`, ADR 0162 amended 2026-11-11).
 */
export function useTeamSource(
  orgId: string | null,
  o: { personal: boolean; passed: OnboardingStepId | undefined; onHold: (hold: boolean) => void },
) {
  const api = useApi();
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage | null>(null);
  const [chosen, choose] = useState<TeamSourceChoice | null>(null);
  // How a team with no agents yet starts: from scratch until the person picks the template's team.
  const [start, pickStart] = useState<TeamStartPick>("scratch");
  const [holding, setHolding] = useState(false);
  const [facts, setFacts] = useState<TeamSourceFacts>(NO_FACTS);
  const resetFlow = useRef<(() => void) | null>(null);
  // The page's latest `onHold`, for a hold set from a mutation that started renders ago.
  const onHold = useRef(o.onHold);
  onHold.current = o.onHold;
  const hold = useCallback((on: boolean) => {
    setHolding(on);
    onHold.current(on);
  }, []);
  const publish = useCallback((next: TeamSourceFacts | null) => setFacts(next ?? NO_FACTS), []);
  const bindReset = useCallback((reset: (() => void) | null) => {
    resetFlow.current = reset;
  }, []);

  // Read from the stored step on every render, never once at mount: the page renders before `/me` arrives. A team's
  // "no agents yet" opens on how to start (the templates are a view of this visit only); a step left with no agents
  // ("agents" and on) opens on the question again, to bring or build a team after all.
  const base: Stage = stage ?? (!o.personal && o.passed === "import" ? "start" : "ask");
  // The report only once the apply settled and kept the step (`TeamSourceBody`'s `reporting`): a clean one stays on
  // what was found, its button pending, until the rail moves on.
  const view: TeamSourceView =
    base !== "import" ? base : facts.report && holding && !facts.applying ? "report" : facts.coming ? "found" : "bring";
  const replyCard = replyCardOf(chosen);

  const saveStep = (step: "import" | "agents") =>
    orgId ? api.orgs.saveOnboarding(orgId, { step }) : Promise.resolve(null);
  /** The step saved, in `/me` as the server answered it, where the rail reads it. */
  const remember = (step: "import" | "agents", saved: { step: OnboardingStepId } | null) =>
    qc.setQueryData<Me>(
      keys.me,
      (me) =>
        me && {
          ...me,
          organizations: me.organizations.map((org) =>
            org.id === orgId && org.onboarding
              ? {
                  ...org,
                  onboarding: {
                    ...org.onboarding,
                    // It only moves forward, as the server keeps it.
                    step:
                      saved?.step ?? (stepIndex(org.onboarding.step) >= stepIndex(step) ? org.onboarding.step : step),
                  },
                }
              : org,
          ),
        },
    );

  // "No agents yet": a team's start, "Start from scratch" picked; a personal workspace's step answered.
  const noneStep = o.personal ? "agents" : "import";
  const none = useMutation({
    mutationFn: () => saveStep(noneStep),
    onSuccess: (saved) => {
      remember(noneStep, saved);
      if (!o.personal) {
        pickStart("scratch");
        setStage("start");
      }
      // A pin left from going back to this step lets go: the rail moves on by itself where the answer is enough. A
      // team that had left the step with no agents keeps it, on its templates: what is stored still answers the step.
      const left = stepIndex(saved?.step ?? noneStep) >= stepIndex("agents");
      if (o.personal || !left) hold(false);
    },
  });

  // A team's way out, the question's "Skip this step" or its start's "Start from scratch" (ADR 0162, amended
  // 2026-11-11): the step answered with no agents besides the right hand, and the rail on to the next one. Back on the
  // step later, the question again.
  const skip = useMutation({
    mutationFn: () => saveStep("agents"),
    onSuccess: (saved) => {
      remember("agents", saved);
      setStage("ask");
      hold(false);
    },
  });

  const ask = () => {
    resetFlow.current?.();
    setStage("ask");
    // An apply that failed half way left the step pinned: going back to the question lets it go.
    if (holding) hold(false);
  };
  const back =
    view === "template"
      ? () => setStage("start")
      : view === "start" || view === "bring"
        ? ask
        : view === "found" && !facts.applying && !facts.report
          ? () => {
              // Back to the request or the files; an apply that failed lets the step go with it.
              resetFlow.current?.();
              if (holding) hold(false);
            }
          : null;

  /** The step's heading and Lodi's line for the view on screen. */
  const head = (t: TFunction, _org: string): { title: string; lead: string; say: string } => {
    const app = facts.app ?? "";
    if (view === "bring")
      return {
        title: facts.app
          ? t(o.personal ? "onboarding.flow.team.bring.titlePersonal" : "onboarding.flow.team.bring.title", { app })
          : t(o.personal ? "onboarding.flow.team.bring.titleOtherPersonal" : "onboarding.flow.team.bring.titleOther"),
        lead: t("onboarding.flow.team.bring.lead"),
        say: facts.mcp
          ? t("onboarding.flow.lodi.bringMcp")
          : asksFirst(facts.card) && app
            ? t("onboarding.flow.lodi.bring", { app })
            : t("onboarding.flow.lodi.bringFiles"),
      };
    if (view === "found" || view === "report")
      return {
        title: t("onboarding.flow.team.found.title", { count: facts.count, app }),
        lead: t("onboarding.flow.team.found.lead"),
        say: t(o.personal ? "onboarding.flow.lodi.foundPersonal" : "onboarding.flow.lodi.found"),
      };
    if (view === "start")
      return {
        title: t("onboarding.flow.team.start.title"),
        lead: t("onboarding.flow.team.start.lead"),
        say: t("onboarding.flow.lodi.start"),
      };
    if (view === "template")
      return {
        title: t("onboarding.flow.team.title"),
        lead: t("teamPlan.templates.heldLead"),
        say: t("onboarding.flow.lodi.team"),
      };
    return {
      title: t("onboarding.flow.team.ask.title"),
      lead: t(o.personal ? "onboarding.flow.team.ask.leadPersonal" : "onboarding.flow.team.ask.lead"),
      say: t(o.personal ? "onboarding.flow.lodi.askPersonal" : "onboarding.flow.lodi.ask"),
    };
  };

  return {
    view,
    /** The answer picked on the question. */
    card: chosen,
    /** The step is pinned: the import applying, or its report waiting for Continue. */
    holding,
    /** The step's Back within its own views (the page draws it), null where there is none. */
    back,
    head,
    /** What was found, for the workspace's preview beside the step. */
    preview: view === "found" || view === "report" ? facts.coming : null,
    /** "No agents yet". */
    none,
    /** How a team with no agents yet starts, picked on its start ("Start from scratch" until changed). */
    start,
    pickStart,
    /** A team's "Skip this step" and "Start from scratch": the step left with no agents. */
    skip,
    /** Back to the question. */
    ask,
    /** For the step's views (`TeamSource`) only. */
    link: { stage: base, chosen, choose, go: setStage, hold, publish, bindReset, replyCard },
  };
}

export type TeamSourceState = ReturnType<typeof useTeamSource>;

const TeamSourceBody = lazy(() => import("./TeamSourceBody").then((m) => ({ default: m.TeamSourceBody })));

/** One tile per source card while the step's views load (the import's nine apps), so nothing moves when they come. */
const WAITING = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The step's body for the question, bringing and what came; the page draws its heading, Lodi's line and Back from
 * `state`. `org`: the workspace's name.
 */
export function TeamSource({
  state,
  orgId,
  personal,
  org,
}: {
  state: TeamSourceState;
  orgId: string;
  personal: boolean;
  org: string;
}) {
  return (
    <Suspense
      fallback={
        <div className="onb__answer" aria-hidden="true">
          <div className="imp-sources">
            {WAITING.map((i) => (
              <Skeleton key={i} shape="block" height={84} />
            ))}
          </div>
        </div>
      }
    >
      <TeamSourceBody state={state} orgId={orgId} personal={personal} org={org} />
    </Suspense>
  );
}

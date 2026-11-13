import { type Agent, type Me, type OrgSummary, useComputerSetup } from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type AiChoice, gateDims, planLabel, planMark } from "@agenteschat/client/lib/no-ai";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { Button, Icon, ProviderLogo } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePlanGates } from "@/components/ai/ConnectAiSteps";
import { ConnectChoices } from "@/components/arrival/ConnectChoices";
import { sceneTeam, TeamScene, useDawn } from "@/components/arrival/TeamScene";
import { ConnectAiProvider, type ConnectAiRequest, useConnectAi } from "@/components/ConnectAi";
import { OrgProvider, useOrg } from "@/components/org-context";
import "./ai-step.css";

/*
 * The rail's Connect an AI step (ADR 0162, amended), the last but a team's people: the arrival's choices as cards
 * (ADR 0160), each opening the same Connect dialog as anywhere in the app for the right hand and the whole team, and
 * the team asleep on its stage beside them until it thinks. The step is answered by the data (every agent ready or
 * waiting), never by the dialog closing, so a connect made in another tab moves it on too.
 */

/** Asked again this often while the choices show: this page opens no socket, so no event says a plan can sign in. */
const GATES_POLL_MS = 5000;

/**
 * What the step and the column beside it need from the workspace's shell, which this page is outside of: the
 * workspace and the person (`useOrg`), and the Connect dialog. Mounted only on this step.
 */
export function AiHost({ org, me, children }: { org: OrgSummary; me: Me; children: ReactNode }) {
  return (
    <OrgProvider org={org} me={me}>
      {/* No socket here: the dialog reads its status, computers and plans again as the step does. The workspace's
          pages open only after this step, so the dialog never leaves for one. */}
      <ConnectAiProvider poll={GATES_POLL_MS} settingUp>
        {children}
      </ConnectAiProvider>
    </OrgProvider>
  );
}

/**
 * The dialog a pick opens. For the team (the right hand and the others), Connect for the whole team on the card picked
 * (`start`), the key's included (ADR 0160 addendum, ADR 0162). The right hand alone is its own dialog, on the card
 * picked too.
 */
export function connectRequest(choice: AiChoice, agentIds: readonly string[]): ConnectAiRequest {
  const [first, ...rest] = agentIds;
  if (first === undefined || rest.length > 0) return { agentIds: [...agentIds], start: choice };
  return { agentId: first, start: choice };
}

/**
 * The step's body: the choices, with what not connecting means and Connect later beside it; once every agent thinks,
 * the AI picked here (when one was) and Go to the workspace, or Continue where a step comes after it (`next`: a team's
 * people, ADR 0162 amended 2026-11-11). `agents`: the right hand first, then the team.
 */
export function AiStep({
  orgId,
  agents,
  done,
  leaving,
  picked,
  next = false,
  onConnected,
  onLater,
  onEnter,
}: {
  orgId: string;
  agents: readonly Agent[];
  /** Every agent thinks: the connected screen. */
  done: boolean;
  /** The workspace is opening: both ways out wait. */
  leaving: boolean;
  /** What was connected, as the page names it (the connected screen's tile), when it can. */
  picked: AiChoice | null;
  /** A step comes after this one: the connected screen goes on to it instead of into the workspace. */
  next?: boolean;
  /**
   * What the dialog connected ("Claude"): the page names it on the rail and in the heading. Not the card picked, since
   * the dialog's Back leads to every other choice.
   */
  onConnected?: (choice: AiChoice) => void;
  /** Connect later: on to the next step, else the onboarding finishes as it is. */
  onLater: () => void;
  onEnter: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const connect = useConnectAi();
  const ids = agents.map((a) => a.id);
  // A plan's tile dims while it can't sign in (no computer yet, or the Cloud's still being prepared after paying):
  // read again while the choices show, the computer's setup too (the dialog reads the same), so they light up alone.
  // Read for the first agent other than the right hand, which never has a computer (ADR 0160 addendum), as the
  // dialog reads it; the right hand alone reads its own.
  const reader = agents.find((a) => !isRightHand(a)) ?? agents[0];
  const poll = done ? false : GATES_POLL_MS;
  const gates = usePlanGates(orgId, reader?.id, poll);
  useComputerSetup(orgId, true, poll);
  if (done)
    return (
      <>
        {picked && (
          <div className="arrival-opts">
            <div className="ac-option onb-ai__connected">
              {picked === "key" ? (
                <span className="arrival-opts__tile" aria-hidden="true">
                  <Icon name="key" />
                </span>
              ) : (
                <ProviderLogo id={planMark(picked)} size="tile" />
              )}
              <span className="ac-option__text">
                <span className="ac-option__title">
                  {picked === "key" ? t("connectAi.key.title") : planLabel(t, picked)}
                </span>
                <span className="ac-option__desc">
                  {picked === "key" ? t("connectAi.key.sub") : t(`connectAi.plan.${picked}.tiers`)}
                </span>
              </span>
              <span className="arrival-opts__tag">{t("onboarding.flow.ai.connected")}</span>
            </div>
          </div>
        )}
        <div className="onb__actions">
          <Button
            variant="primary"
            block
            kbd={["↵"]}
            data-enter=""
            onClick={onEnter}
            disabled={leaving}
            loading={leaving}
          >
            {t(next ? "onboarding.actions.continue" : "onboarding.flow.ai.enter")}
          </Button>
        </div>
      </>
    );
  return (
    <>
      <div className="onb__answer">
        <ConnectChoices
          mayAddKey={can(org, "manage_credentials")}
          dims={(c) => reader !== undefined && gateDims(gates.gateOf(c))}
          onPick={(choice) =>
            connect?.open({ ...connectRequest(choice, ids), ...(onConnected ? { onConnected } : {}) })
          }
        />
      </div>
      <p className="onb__skip">
        <span className="muted">{t("arrival.connect.without")}</span>
        <button type="button" className="ac-link" disabled={leaving} onClick={onLater}>
          {t("onboarding.flow.ai.later")}
        </button>
      </p>
    </>
  );
}

/**
 * Beside the step on wide screens, in place of the workspace's preview: the team on its sky, asleep until it thinks,
 * then waking as the night turns to day, with who answers now.
 */
export function AiStage({
  agents,
  lead,
  awake,
  personal,
}: {
  /** The right hand first, then the team. */
  agents: readonly Agent[];
  lead: Agent | undefined;
  /** Every agent thinks: the sky turns to day. */
  awake: boolean;
  /** A personal workspace has no team (ADR 0159): its agents, in words of its own. */
  personal: boolean;
}) {
  const { t } = useTranslation();
  const day = useDawn(awake);
  const names = agents.map((a) => a.name);
  // The right hand alone (a personal workspace's "no agents yet", a team step left with none): by its name.
  const alone = lead !== undefined && agents.length === 1 ? agentGrammar(lead.name) : null;
  const head = alone
    ? t(awake ? "onboarding.flow.ai.awakeAlone" : "onboarding.flow.ai.readyAlone", alone)
    : personal
      ? t(awake ? "onboarding.flow.ai.awakePersonal" : "onboarding.flow.ai.readyPersonal")
      : t(awake ? "onboarding.flow.ai.awake" : "arrival.stage.ready");
  return (
    <aside className="onb-stage">
      <div className="onb-stage__frame arrival-stage">
        <TeamScene
          shape="tall"
          quiet={0.22}
          agents={sceneTeam(agents, lead)}
          lead={lead?.id}
          asleep={!awake}
          day={day}
          expression={awake ? "happy" : undefined}
        />
        <div className="arrival-stage__cap">
          <b>{head}</b>
          <span>
            {awake
              ? t("onboarding.flow.ai.answer", { names: joinNames(names, t), count: agents.length })
              : t(personal || alone ? "onboarding.flow.ai.wakePersonal" : "arrival.stage.wake")}
          </span>
        </div>
      </div>
    </aside>
  );
}

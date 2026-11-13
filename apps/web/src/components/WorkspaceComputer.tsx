import type { Machine } from "@agenteschat/client";
import { useAgents, useAuthConfig, useComputerSetup, useMachines } from "@agenteschat/client";
import {
  agentsWaitingForComputer,
  computerEdition,
  computerName,
  etaLine,
  promisesEmail,
  SETUP_STEPS,
  type SetupView,
  setupEta,
  setupLines,
  setupNoticeKey,
  setupNoticeStatusKey,
  setupNoticeTitleKey,
  setupPending,
  setupPortrait,
  setupView,
  statusRestatesChip,
  useEtaNow,
  WORKSPACE_COMPUTER_KIND,
} from "@agenteschat/client/lib/computer";
import { joinNames, lowerFirst } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { namesComputers } from "@agenteschat/client/lib/machines";
import { around, endSentence } from "@agenteschat/client/lib/text";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Card,
  Chip,
  ComputerIcon,
  ComputerPortrait,
  Icon,
  type IconName,
  InfoHint,
  Spinner,
  Steps,
} from "@agenteschat/ui";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { Egress } from "./computer/Egress";

/**
 * The workspace's own computer (ADR 0056 §10), where a provisioner prepares one for each workspace: how far it
 * is and the time left, live from `machine.provisioning`. Words only a person needs: no system, address,
 * provider or tool list.
 */

/**
 * Which words the computers get here (`computerEdition`): the server's `workspaceComputer` until the workspace's
 * setup answers, so it is known from boot; null while neither has said.
 */
export function useComputerEdition(orgId: string) {
  return computerEdition(useComputerSetup(orgId).data, useAuthConfig().data?.workspaceComputer);
}

/** Whether lines about where things run name the computer here (`namesComputers`); false while the list loads. */
export function useNamesComputers(orgId: string) {
  return namesComputers(useMachines(orgId).data);
}

/** This workspace's computer on its way, or null where people connect their own (`pair`). */
export function useSetupView(orgId: string): SetupView | null {
  const q = useComputerSetup(orgId);
  return setupView(q.data, q.dataUpdatedAt);
}

/** Who reads the wait: owners hear of the email, at their address; a workspace on hold hears of neither. */
export interface WaitReader {
  owner: boolean;
  email: string;
  held: boolean;
}

/** The person reading, in a workspace's pages. */
export function useWaitReader(): WaitReader {
  const { org, me } = useOrg();
  return { owner: org.role === "owner", email: me.user.email, held: org.standing?.state === "hold" };
}

/**
 * The time left now, on the clock every time line shares (`useEtaNow`), and whether "we'll email you" holds; `now`:
 * that clock's time, while it waits. A workspace on hold shows neither: its hold banner speaks, and its provisioner
 * waits too.
 */
export function useSetupWait(view: SetupView | null, held: boolean) {
  const live = view && setupPending(view) && !held ? view : null;
  const now = useEtaNow(live !== null);
  return live
    ? { eta: setupEta(live, now), email: promisesEmail(live, now), now }
    : { eta: null, email: false, now: null };
}

/** Every wait leads with the orbit, as work under way does: the clock is for the "as soon as it's ready" lines. */
const PHASE_ICON: Record<SetupView["phase"], IconName> = {
  preparing: "spinner",
  waiting: "spinner",
  problem: "alert",
  ready: "check",
  paused: "pause",
};

/** How long each of the team's lines stays while it's prepared. */
const LINE_MS = 3500;

/**
 * While it's prepared, the team's lines about what it's doing (`setupLines`), one at a time, crossfading every 3.5 s;
 * with reduced motion the one shown stays until the step changes. Followed by its key, so a line that comes meanwhile
 * (its memory, once the size is known) waits for its turn instead of taking the shown one's place. Only for sighted
 * readers: the step under it is what's announced. With no line for this team, nothing: the step's label already says
 * where it is.
 */
function SetupSays({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const lines = setupLines(view, useAgents(org.id).data ?? []);
  const still = usePrefersReducedMotion();
  const [shown, setShown] = useState<string>();
  const on = lines.find((l) => l.key === shown) ?? lines[0];
  if (on && on.key !== shown) setShown(on.key);
  const said = lines.map((l) => l.key).join(" ");
  useEffect(() => {
    const keys = said.split(" ");
    if (still || keys.length < 2) return;
    const timer = setInterval(() => setShown((key) => keys[(keys.indexOf(key ?? "") + 1) % keys.length]), LINE_MS);
    return () => clearInterval(timer);
  }, [still, said]);
  if (!on) return null;
  return (
    <span className="setup-says" aria-hidden="true">
      {lines.map(({ key, agent }) => (
        <Chip
          key={key}
          className="setup-say"
          data-on={key === on.key || undefined}
          lead={<AgentAvatar agentId={agent.id} name={agent.name} size="xs" framed />}
        >
          {t(key, { ...agentGrammar(agent.name), gb: view.specs?.memoryGb })}
        </Chip>
      ))}
    </span>
  );
}

/**
 * While it's on its way: the team's line, then the four steps as bars ("Passo 2 de 4 · Iniciando"); or why it waits,
 * in one line. `said`: a chip or the window's head beside it says where it is, so a line that would only say it again
 * stays out.
 */
export function SetupProgress({ view, said = false }: { view: SetupView; said?: boolean }) {
  const { t } = useTranslation();
  if (view.step) {
    const step = t(view.textKey);
    const label = t("computerSetup.stepOf", { n: view.stepNumber, total: SETUP_STEPS.length, step });
    // The step's own words stay on one line where they fit (layout.css).
    const cut = around(label, step);
    return (
      <div className="setup-progress setup-progress--steps">
        <SetupSays key={view.textKey} view={view} />
        <div role="status">
          <Steps
            current={view.stepNumber}
            total={SETUP_STEPS.length}
            label={
              cut ? (
                <>
                  {cut[0]}
                  <span>{step}</span>
                  {cut[1]}
                </>
              ) : (
                label
              )
            }
          />
        </div>
      </div>
    );
  }
  if (said && statusRestatesChip(view)) return null;
  // The lines under it lead with 14px too, so every line's words start in one column.
  return (
    <p className="setup-progress setup-progress--line ac-iconline" role="status" data-phase={view.phase}>
      {PHASE_ICON[view.phase] === "spinner" ? <Spinner size={14} /> : <Icon name={PHASE_ICON[view.phase]} size={14} />}
      <span>{t(view.textKey)}</span>
    </p>
  );
}

/**
 * The wait in words, under the steps: the time left, then who hears when it's ready. Only owners get the
 * email, so only they are told so (`promisesEmail`); everyone else is told it shows here.
 */
export function SetupWaitLines({ view, reader }: { view: SetupView; reader: WaitReader }) {
  const { t } = useTranslation();
  const { eta, email } = useSetupWait(view, reader.held);
  if (!setupPending(view) || reader.held) return null;
  const emailed = email && reader.owner;
  return (
    <>
      {eta && (
        <p className="setup-eta" aria-live="polite">
          {etaLine(t, eta)}
        </p>
      )}
      <p className="setup-line ac-iconline">
        <Icon name={emailed ? "mail" : "bell"} size={14} />
        <span>{emailed ? t("computerSetup.email.you", { email: reader.email }) : t("computerSetup.email.here")}</span>
      </p>
    </>
  );
}

/** "4 CPUs · 8 GB de memória · 100 GB de disco", once the provisioner said. */
export function SetupFacts({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  if (!view.specs) return null;
  return (
    <p className="setup-line ac-iconline">
      <Icon name="computer" size={14} />
      <span>{t("computerSetup.specs", view.specs)}</span>
    </p>
  );
}

/**
 * The workspace computer's name with its ⓘ (one user per agent, each with its own folder), wherever the name
 * shows: the setup's card, Settings › Computers and the computer's own page.
 */
export function ComputerTitle({ children, name }: { children: ReactNode; name: string }) {
  const { t } = useTranslation();
  return (
    <span className="ac-hintline">
      {children}
      <InfoHint name={t("common.about", { label: name })}>{t("computerSetup.users")}</InfoHint>
    </span>
  );
}

/**
 * The preparing screen's parts, the same in the onboarding and the computer dialog: the steps, the time left, who
 * hears when it's ready, then the size. `said` as `SetupProgress`'s.
 */
export function SetupWait({ view, reader, said }: { view: SetupView; reader: WaitReader; said?: boolean }) {
  return (
    <div className="setup-wait">
      <SetupProgress view={view} said={said} />
      <SetupWaitLines view={view} reader={reader} />
      <SetupFacts view={view} />
    </div>
  );
}

/** The chip beside its name: online or not once ready (like any computer's), else where it is ("Sendo preparado"). */
function SetupChip({ view, machine }: { view: SetupView; machine: Machine | undefined }) {
  const { t } = useTranslation();
  if (view.phase !== "ready") return <Chip icon={PHASE_ICON[view.phase]}>{t(view.chipKey)}</Chip>;
  const online = machine?.online ?? false;
  return (
    <Chip icon={online ? "check" : "dash"} className="machine-chip">
      {online ? t("machines.online") : t("machines.offline")}
    </Chip>
  );
}

/** The workspace's computer row of the list, once the provisioner made it. */
export const managedOf = (machines: Machine[] | undefined) => machines?.find((m) => m.kind === "managed");

/**
 * Configurações → Computadores where the workspace gets its own computer: its card, with no hostname, system or
 * address, and no Remove. On its way: the steps, the time left, or why it waits; ready: online or not. Always
 * its size, one user per agent behind its name's ⓘ, and the agents on it.
 */
export function WorkspaceComputerCard({ view }: { view: SetupView }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const reader = useWaitReader();
  const machine = managedOf(useMachines(org.id).data);
  const title = computerName(t, org.name, machine, isPersonal(org));
  return (
    <Card aria-labelledby="sec-workspace-computer" className="setup-card" data-phase={view.phase}>
      <div className="computers-card__head">
        <ComputerPortrait
          kind={WORKSPACE_COMPUTER_KIND}
          state={setupPortrait(view, machine?.online ?? false)}
          size={96}
        />
        <span className="computers-card__title">
          <ComputerTitle name={title}>
            <h2 id="sec-workspace-computer" className="ac-card__title">
              {machine ? (
                <Link
                  to="/org/$orgId/settings/devices/$deviceId"
                  params={{ orgId: org.id, deviceId: machine.id }}
                  className="machine-row__name"
                >
                  {title}
                </Link>
              ) : (
                title
              )}
            </h2>
          </ComputerTitle>
          {/* The card says where it is only here, so here a screen reader hears it change. */}
          <span className="row" role="status" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <SetupChip view={view} machine={machine} />
          </span>
        </span>
      </div>
      {view.phase !== "ready" && <SetupProgress view={view} said />}
      <SetupWaitLines view={view} reader={reader} />
      <SetupFacts view={view} />
      <Egress machine={machine} />
      {machine && machine.agents.length > 0 && (
        <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="row" style={{ gap: 4 }}>
            {machine.agents.slice(0, 8).map((a) => (
              <AgentAvatar key={a.id} agentId={a.id} size="sm" name={a.name} />
            ))}
          </span>
          <span className="small muted">
            {t("machines.usedBy", {
              names: joinNames(
                machine.agents.map((a) => a.name),
                t,
              ),
            })}
          </span>
        </span>
      )}
    </Card>
  );
}

/**
 * "Preparando o computador da Acme" (in line, its name alone): the notice at the top of the work area while the
 * workspace's own computer is on its way: the step and the time left ("Passo 3 de 4 · Instalando os programas · faltam
 * uns 6 min"), or the wait for a computer, with "Avisamos por e-mail." after it for owners, and the faces of the agents
 * that wait for it, each named by its label. Everyone sees it, except on Settings › Computers, where its See leads and
 * the card says it; closed, it stays closed until the state (or the step) changes.
 */
export function ComputerSetupNotice() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const there = useMatchRoute()({
    to: "/org/$orgId/settings/$section",
    params: { orgId: org.id, section: "devices" },
  });
  const reader = useWaitReader();
  const view = useSetupView(org.id);
  const pending = setupPending(view);
  const agents = useAgents(org.id);
  const machines = useMachines(org.id, pending);
  const { eta, email } = useSetupWait(view, reader.held);
  const [hidden, setHidden] = useState(() => storage.get(STORAGE_KEYS.setupNoticeHidden));
  if (!pending || there) return null;
  const key = setupNoticeKey(org.id, view);
  if (hidden === key) return null;
  const waiting = agentsWaitingForComputer(agents.data ?? [], machines.data ?? []);
  const status = setupNoticeStatusKey(view);
  const where = view.step
    ? t("computerSetup.stepOf", { n: view.stepNumber, total: SETUP_STEPS.length, step: t(view.textKey) })
    : status && t(status);
  const left = eta ? etaLine(t, eta) : null;
  const data = [where, left && where ? lowerFirst(left, i18n.language) : left].filter(Boolean).join(" · ");
  const line =
    view.phase === "waiting" && email && reader.owner ? `${endSentence(data)} ${t("computerSetup.email.short")}` : data;
  return (
    <section className="outages" aria-label={t("computerSetup.notice.label")}>
      <div className="outage setup-notice" role="status" data-phase={view.phase}>
        <ComputerIcon kind={WORKSPACE_COMPUTER_KIND} size={20} className="outage__icon" />
        <span className="outage__text">
          <b>{t(modeKey(org, setupNoticeTitleKey(view)), { org: org.name })}</b>
          {line && <span>{line}</span>}
        </span>
        <span className="outage__crew">
          {waiting.slice(0, 4).map((a) => (
            <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="sm" state="idle" labelled />
          ))}
        </span>
        <span className="outage__acts">
          <Button asChild variant="ghost" size="sm">
            <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "devices" }}>
              {t("computerSetup.notice.see")}
            </Link>
          </Button>
        </span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="close"
          className="outage__close"
          aria-label={t("computerSetup.notice.hide")}
          onClick={() => {
            storage.set(STORAGE_KEYS.setupNoticeHidden, key);
            setHidden(key);
          }}
        />
      </div>
    </section>
  );
}

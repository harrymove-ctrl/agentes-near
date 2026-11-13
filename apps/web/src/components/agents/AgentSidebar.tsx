import type { Agent, Issue, Routine } from "@agenteschat/client";
import {
  agentStateIn,
  asksPicture,
  browserSiteUrl,
  useAgentDetail,
  useBrowserHandoffMutations,
  useDesktopPicture,
  useIssues,
  useRoutines,
  useUsage,
} from "@agenteschat/client";
import {
  entryButton,
  entryKind,
  entryLine,
  entryPortrait,
  entryState,
  pictureWhen,
  surfaceOf,
} from "@agenteschat/client/lib/agent-computer";
import { seesDetails } from "@agenteschat/client/lib/audience";
import { computerName } from "@agenteschat/client/lib/computer";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { formatPercent, formatUsd, relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { STATUS_ICON } from "@agenteschat/client/lib/issues";
import { can } from "@agenteschat/client/lib/permissions";
import { usageShown } from "@agenteschat/client/lib/plan-usage";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { siteHost } from "@agenteschat/client/lib/secret-requests";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  BrainIcon,
  Button,
  ComputerPortrait,
  GroupHeading,
  Icon,
  InfoHint,
  PresenceBadge,
  ProviderLogo,
  Switch,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usd } from "@/components/AgentFields";
import { stepText } from "@/components/browser/BrowserCard";
import { useAgentComputer } from "@/components/computer/facts";
import { useOpenComputer } from "@/components/computer/open";
import { OpensAgent } from "@/components/OpensAgent";
import { useOrg } from "@/components/org-context";
import { StatusLine } from "@/components/Presence";
import { RightHandMineRow, useRightHandMineHint } from "@/components/RightHandSettings";
import { SidePanel } from "@/components/SidePanel";
import { AgentCover, colorOf } from "@/components/Sky";
import { useAgentThinks } from "@/hooks/useAgentThinks";
import { useDirectory } from "@/hooks/useDirectory";
import { useEscClose } from "@/hooks/useEscClose";
import { useNow } from "@/hooks/useNow";
import { agentLine, useAgentPresence } from "@/hooks/usePresence";
import { useWindowActive } from "@/hooks/useWindowActive";
import { useToast } from "@/lib/toast";
import { hasFired, routineTitle, useRoutineControls, useWhen } from "@/pages/RoutinesPage";
import { useStreams } from "@/realtime/context";
import "./agent-sidebar.css";

/** While the sidebar shows, whether its screen started or stopped is asked again this often. */
const STATUS_POLL_MS = 30_000;
const ROWS = 3;

/**
 * The right side of a DM with an agent, under the header where a channel's members sit: who it is, its computer, its
 * routines, how it thinks and its recent tasks, in one scroll. What the viewer may not see isn't drawn: without the
 * details (`seesDetails`), only its head. `onClose`: it floats over the chat, as the app's panels do.
 */
export function AgentSidebar({ agent, onClose }: { agent: Agent; onClose?: () => void }) {
  const { t } = useTranslation();
  const mineHint = useRightHandMineHint(agent);
  const body = (
    <ErrorBoundary resetKey={agent} fallback={() => null}>
      <AgentHead agent={agent} />
      {isRightHand(agent) ? (
        // No computer of its own, and each person's DM thinks with their own plan (ADR 0137 §11).
        <Section title={t("agentSide.thinks")} hint={mineHint}>
          <RightHandMineRow agent={agent} />
        </Section>
      ) : (
        seesDetails(agent) && (
          <>
            <ComputerSection agent={agent} />
            <RoutinesSection agent={agent} />
            <ThinksSection agent={agent} />
            <TasksSection agent={agent} />
          </>
        )
      )}
    </ErrorBoundary>
  );
  if (!onClose) {
    return (
      <aside className="members-side dm-side" aria-label={t("agentSide.label")}>
        <div className="dm-side__scroll">{body}</div>
      </aside>
    );
  }
  return <FloatingSide onClose={onClose}>{body}</FloatingSide>;
}

function FloatingSide({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  useEscClose(onClose);
  return (
    <SidePanel className="dm-side dm-side--float" label={t("agentSide.label")} onClose={onClose}>
      <Button
        size="sm"
        iconOnly
        icon="close"
        className="agp-glass dm-side__close"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={onClose}
      />
      <div className="dm-side__scroll">{children}</div>
    </SidePanel>
  );
}

function Section({
  title,
  count,
  action,
  hint,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  /** What the section is for, behind an ⓘ after its title, on the title's capitals. */
  hint?: { name: string; text: ReactNode };
  children: ReactNode;
}) {
  return (
    <section className="dm-side__sec" aria-label={title}>
      <GroupHeading
        level={3}
        title={
          hint ? (
            <span className="ac-hintline">
              <span>{title}</span>
              <InfoHint name={hint.name}>{hint.text}</InfoHint>
            </span>
          ) : (
            title
          )
        }
        count={count}
        aside={action}
      />
      {children}
    </section>
  );
}

function AgentHead({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const shown = useAgentPresence(agent.id);
  const busy = useStreams((s) => agentStateIn(s, agent.id) !== "idle");
  const line = agentLine(t, shown?.line ?? null, i18n.language);
  const word = busy ? t("team.workingNow") : shown ? t(`presence.${shown.presence}`) : null;
  // The right hand's one role name, as the sidebar and its DM's header say it.
  const role = isRightHand(agent) ? t("rightHand.labelCapitalized") : agent.role || `@${agent.handle}`;
  return (
    <header className="dm-side__head">
      <div className="agp-cover dm-side__cover">
        <AgentCover color={colorOf(agent)} busy={busy} />
      </div>
      <span className="dm-side__face">
        <OpensAgent agentId={agent.id}>
          <AgentAvatar agentId={agent.id} name={agent.name} size="lg" />
        </OpensAgent>
      </span>
      <h2 className="dm-side__name">{agent.name}</h2>
      <p className="dm-side__role">{role}</p>
      {line ? (
        <StatusLine {...line} className="dm-side__status" />
      ) : (
        word && (
          <p className="dm-side__status">
            {/* The presence's own badge, as beside its face everywhere: away wears its clock, offline its outline. */}
            <PresenceBadge presence={busy ? "online" : (shown?.presence ?? "offline")} ring={false} />
            {word}
          </p>
        )
      )}
    </header>
  );
}

/**
 * The agent's computer: a recent picture of its screen (`useDesktopPicture`, asked only while the window is in use),
 * what it is using and since when, and the way in. Who may not watch it gets none of this.
 */
function ComputerSection({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const navigate = useNavigate();
  const openComputer = useOpenComputer();
  const actions = useBrowserHandoffMutations(org.id);
  const active = useWindowActive();
  const view = useAgentComputer(agent, { poll: active ? STATUS_POLL_MS : false, runs: true });
  const f = view.facts;
  const running = asksPicture(true, view.desktop);
  const shot = useDesktopPicture(org.id, agent.id, { enabled: active && running, working: Boolean(f?.working) });
  const nowMs = useNow(15_000);
  if (view.forbidden) return null;
  // Its place is kept: the sections under it are faster, and would jump down when it comes.
  if (!view.ready || !f) {
    return (
      <Section title={t("agentComputer.button")}>
        <div className="dm-side__noscreen" />
      </Section>
    );
  }
  const now = new Date(nowMs);
  const g = agentGrammar(agent.name);
  const state = entryState(f, nowMs);
  const surface = surfaceOf(f);
  const last = view.steps.at(-1);
  const line = entryLine(t, state, {
    edition: f.edition,
    locale: i18n.language,
    computer: computerName(t, org.name, view.machine, isPersonal(org)),
    lastSeenAt: view.machine?.lastSeenAt ?? null,
    person: (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
    step: last ? stepText(t, last, last.screen) : null,
    emailPromised: false,
    now,
  });
  // Out of focus none is asked, and the last stays with its time on it.
  const picture = running ? shot.data?.picture : null;
  const stopped = state.kind === "available" && view.desktop?.available === true && !view.desktop.running;
  const using = state.kind === "working" ? last : undefined;
  const site = using?.screen === "browser" ? browserSiteUrl(null, view.steps) : null;
  const startedAt = view.run?.startedAt;
  const since = startedAt ? relativeTime(t, i18n.language, new Date(startedAt).toISOString(), now) : null;
  const usingLine = [site && siteHost(site), since].filter(Boolean).join(" · ");
  const button = entryButton(state);
  const shows = surface === "screen" || surface === "page";
  // Only over a screen nobody holds, asks about or paused; the dialog says why in every other state.
  const takes =
    surface === "screen" && view.desktop?.canControl && (state.kind === "working" || state.kind === "available");
  const takeControl = () =>
    actions.takeover.mutate(
      { agentId: agent.id, screen: "desktop" },
      {
        onSuccess: () => openComputer(agent.id),
        onError: (err) =>
          toast.show(
            (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.live.actionFailed"),
            "error",
          ),
      },
    );
  const watch = t("browser.card.watch");
  return (
    <Section title={t("agentComputer.button")}>
      {picture ? (
        <button
          type="button"
          className="dm-side__screen"
          aria-label={t("agentComputer.openOf", g)}
          title={t("agentComputer.openOf", g)}
          onClick={() => openComputer(agent.id)}
        >
          <img src={`data:image/jpeg;base64,${picture.data}`} alt="" />
          <span className="dm-side__when">{pictureWhen(t, i18n.language, picture.capturedAt, now)}</span>
          <span className="dm-side__open">
            <Icon name="fullscreen" size={14} />
          </span>
        </button>
      ) : (
        shows && (
          <div className="dm-side__noscreen">
            <ComputerPortrait kind={entryKind(f.edition, view.machine)} state={entryPortrait(state, f.setup)} />
          </div>
        )
      )}
      <p className="dm-side__using">
        <b>
          {using
            ? t(using.screen === "browser" ? "agentSide.usingBrowser" : "agentSide.usingScreen")
            : stopped
              ? t("agentSide.screenOff")
              : line}
        </b>
        {using ? usingLine && <span>{usingLine}</span> : stopped && <span>{t("agentSide.screenOffHelp")}</span>}
      </p>
      <div className="dm-side__acts">
        {button === "help" ? (
          <Button size="sm" variant="primary" onClick={() => openComputer(agent.id)}>
            {t("agentComputer.help")}
          </Button>
        ) : button === "choose" ? (
          (can(org, "manage_agents") || agent.ownerUserId === me.user.id) && (
            <Button
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/org/$orgId/agents/$agentId",
                  params: { orgId: org.id, agentId: agent.id },
                  search: { tab: "settings", sec: "computer" },
                })
              }
            >
              {t("agentComputer.choose")}
            </Button>
          )
        ) : takes ? (
          <>
            <Button size="sm" icon="pointer" loading={actions.takeover.isPending} onClick={takeControl}>
              {t("desktop.takeover")}
            </Button>
            <Button
              size="sm"
              iconOnly
              icon="eye"
              aria-label={watch}
              title={watch}
              onClick={() => openComputer(agent.id)}
            />
          </>
        ) : shows ? (
          <Button size="sm" icon="eye" onClick={() => openComputer(agent.id)}>
            {watch}
          </Button>
        ) : (
          // Nothing to show: the line says why, and the computer's cover the way out (try again, what to run there).
          state.kind === "unavailable" && (
            <Button size="sm" icon="computer" onClick={() => openComputer(agent.id)}>
              {t("agentComputer.open")}
            </Button>
          )
        )}
      </div>
    </Section>
  );
}

function RoutinesSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const routines = useRoutines(org.id);
  const mine = (routines.data ?? []).filter((r) => r.agentId === agent.id);
  if (mine.length === 0) return null;
  return (
    <Section
      title={t("agentPage.overview.routines")}
      count={mine.length}
      action={
        <Link to="/org/$orgId/routines" params={{ orgId: org.id }} className="ac-link dm-side__all">
          {t("agentSide.seeAll")}
        </Link>
      }
    >
      <ul className="dm-side__rows">
        {mine.slice(0, ROWS).map((r) => (
          <RoutineLine key={r.id} routine={r} />
        ))}
      </ul>
    </Section>
  );
}

/** Its name and when it runs; its switch is the routine's own, and read-only for who may not change it. */
function RoutineLine({ routine: r }: { routine: Routine }) {
  const { t } = useTranslation();
  const when = useWhen();
  const controls = useRoutineControls(r);
  const title = routineTitle(r);
  return (
    <li className="dm-side__row">
      <span className="dm-side__text">
        <b>{title}</b>
        <span>{when(r)}</span>
      </span>
      {!hasFired(r) && (
        <Switch
          checked={r.active}
          disabled={!r.canManage}
          onCheckedChange={controls.setActive}
          aria-label={t("routines.activeLabel", { name: title })}
        />
      )}
    </li>
  );
}

function ThinksSection({ agent }: { agent: Agent }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const thinks = useAgentThinks(agent);
  const detail = useAgentDetail(org.id, agent.id);
  const admin = can(org, "manage_agents");
  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  const usage = useUsage(org.id);
  const used = detail.data?.budgetUsedPercent ?? 0;
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  return (
    <Section title={t("agentSide.thinks")}>
      <dl className="dm-side__facts">
        {thinks?.text && (
          <div>
            <dt>{t("agentSide.thinksWith")}</dt>
            <dd className="ac-iconline">
              {thinks.mark ? <ProviderLogo id={thinks.mark} size="xs" /> : <BrainIcon kind={thinks.kind} size={14} />}
              {thinks.text}
              {agent.brain?.speed && ` · ${t("agentPage.work.brain.speeds.fast")}`}
            </dd>
          </div>
        )}
        <div>
          <dt>{t("agentSide.owner")}</dt>
          <dd>{owner?.name ?? t("newAgent.noOwnerOption")}</dd>
        </div>
        {detail.data && usageShown(agent.brain, used).budget && (
          <div>
            <dt>{t("agentSide.usage")}</dt>
            <dd className="ac-num">
              {admin && spent !== undefined && limit !== undefined
                ? t("agentSide.spentOf", {
                    spent: formatUsd(i18n.language, spent),
                    limit: usd(t, i18n.language, limit),
                  })
                : formatPercent(i18n.language, used)}
            </dd>
          </div>
        )}
      </dl>
    </Section>
  );
}

function TasksSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const issues = useIssues(org.id);
  const recent = (issues.data ?? [])
    .filter((i) => i.assignee?.type === "agent" && i.assignee.id === agent.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, ROWS);
  if (recent.length === 0) return null;
  return (
    <Section
      title={t("agentSide.tasks")}
      action={
        <Link to="/org/$orgId/issues" params={{ orgId: org.id }} className="ac-link dm-side__all">
          {t("agentSide.seeAll")}
        </Link>
      }
    >
      <ul className="dm-side__rows">
        {recent.map((i) => (
          <TaskLine key={i.id} issue={i} />
        ))}
      </ul>
    </Section>
  );
}

function TaskLine({ issue }: { issue: Issue }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <li>
      <Link
        to="/org/$orgId/issues/$number"
        params={{ orgId: org.id, number: String(issue.number) }}
        className="dm-side__row dm-side__row--link"
      >
        <span className="dm-side__stage" data-status={issue.status}>
          <Icon name={STATUS_ICON[issue.status]} size={16} />
        </span>
        <span className="dm-side__text">
          <b>{issue.title}</b>
          <span>{t(`issues.status.${issue.status}`)}</span>
        </span>
      </Link>
    </li>
  );
}

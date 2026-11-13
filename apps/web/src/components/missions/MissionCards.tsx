import type {
  Message,
  Mission,
  MissionDecision,
  MissionExecutor,
  MissionFinding,
  MissionLinkMeta,
  MissionPlanMeta,
  MissionReportMeta,
  MissionSetupMeta,
  MissionSuggestionMeta,
} from "@agenteschat/client";
import {
  keys,
  useAgentRepos,
  useMachines,
  useMission,
  useMissionAct,
  useMissionControl,
  useMissionDecisions,
  useMissionDeliveries,
  useMissionPlan,
  useMissionReviews,
  useRetryMissionWorktree,
  useSetCommandApproval,
  useSetMissionExecutor,
  useThreadMission,
  useThreadTasks,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { folderName } from "@agenteschat/client/lib/machines";
import {
  executorName,
  findingRefUrl,
  findingsRepo,
  formatSpan,
  lastLines,
  machineTaskOf,
  missionAutoApprovedOf,
  missionCardRef,
  missionPlanChangeOf,
  planChangeParts,
  planCounts,
  summaryParts,
  taskNoticeOf,
  viaText,
} from "@agenteschat/client/lib/missions";
import {
  Button,
  Checkbox,
  Chip,
  EventPill,
  EventPillAction,
  EventPillMore,
  Icon,
  type IconName,
  Locked,
  RadioCard,
  RadioGroup,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { FoldedBody } from "@/chat/FoldedBody";
import { ActorAvatar, AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { useChannelActions } from "@/components/channel-actions";
import { CommandBlock, MachineIcon } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { ShowRequestsButton, useIsThisMac } from "@/components/ThisMac";
import { useNamesComputers } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { inlineWords } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { useStreams } from "@/realtime/context";
import {
  CommandApprovalSelect,
  ExecutorMark,
  executorOptions,
  MissionHead,
  MissionStatusChip,
  useMissionPanel,
} from "./MissionBits";
import { BlockedCommands } from "./MissionCommandCard";
import { SessionRows } from "./MissionSessions";

/**
 * The mission's cards and lines inside the thread: the plan card (Começar / Mudar algo), the decision card,
 * the review card ("Pronto para você ver"), the plan-change line, the
 * computer and task lines, a report's "via Claude Code no …", the
 * suggestion bar on a person's message, and the `/summary` and `/plan`
 * cards only the person who typed them sees.
 */

const firstSentence = (text: string) => {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return (m?.[1] ?? text).trim();
};

/** "Começou" over a card for a moment after a click (reduced motion: none). */
function useStamp() {
  const [stamp, setStamp] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A card that leaves takes its stamp's timer along.
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (text: string) => {
    setStamp(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStamp(null), 900);
  };
  const node = stamp ? (
    <div className="mi-stamp" role="status">
      <span className="mi-ok">
        <Icon name="check" size={16} />
      </span>
      {stamp}
    </div>
  ) : null;
  return { show, node };
}

// ── Plan card ─────────────────────────────────────────────────────────────────

/** A title cut from the goal ("criar um arquivo… com 3 d…"): the goal under it would repeat it. */
const sameAsTitle = (title: string, goal: string) => {
  const head = title.replace(/…$/, "").trim().toLowerCase();
  return head.length > 0 && goal.trim().toLowerCase().startsWith(head);
};

const PLAN_SHOWN = 5;

export function MissionPlanCard({ plan: meta }: { plan: MissionPlanMeta }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const panel = useMissionPanel();
  const actions = useChannelActions();
  const mission = useMission(org.id, meta.missionId);
  const plan = useMissionPlan(org.id, meta.missionId);
  const control = useMissionControl(org.id);
  const switchExecutor = useSetMissionExecutor(org.id);
  const stamp = useStamp();
  const m = mission.data;
  const agentName = dir.agentById.get(m?.agentId ?? "")?.name ?? "";
  const current = m?.executor ?? meta.executor;
  const executor = executorName(current, agentName);
  // "do Claude Code", "da Ada": its words in Portuguese.
  const xg = agentGrammar(executor);
  // Before Start the owner may switch who programs, among those the computer can run.
  const choices = m?.role === "owner" && m.status === "proposed" ? (m.machine?.executors ?? []) : [];
  const items = (plan.data?.current?.items ?? []).filter((i) => i.status !== "dropped");
  const computer = m?.machine?.name ?? meta.computer;
  // The computer by its name only where the workspace has more than one; else its state only when it's offline.
  const names = useNamesComputers(org.id);
  const offline = Boolean(m?.machine && !m.machine.online);
  // The main session is still drafting the plan (its run is live in the mission's thread).
  const drafting = useStreams((st) =>
    Object.values(st.runs).some((r) => r.agentId === m?.agentId && r.threadId === m?.threadId),
  );
  const waitPlan = drafting && items.length === 0;
  const seePlan = () => panel?.openFiles(meta.missionId, "mission.md");
  if (m && m.status !== "proposed") {
    return (
      <div className="mi-created">
        <span className="mi-ok">
          <Icon name={m.status === "canceled" ? "close" : "check"} size={16} />
        </span>
        <span className="mi-decided__t">
          <b>{t(`missions.plan.after.${m.status}`)}</b>
          <small>
            {names
              ? t("missions.plan.afterLine", { count: m.plan.total, computer })
              : t("missions.plan.afterLineNoComputer", { count: m.plan.total })}
          </small>
        </span>
        {panel && (
          <Button size="sm" icon="document" onClick={seePlan}>
            {t("missions.plan.see")}
          </Button>
        )}
      </div>
    );
  }
  const start = () =>
    control.mutate(
      { missionId: meta.missionId, action: "start" },
      {
        onSuccess: () => {
          stamp.show(t("missions.plan.started"));
          toast.show(
            t("missions.plan.startedToast"),
            "info",
            panel ? { label: t("missions.plan.see"), run: seePlan } : undefined,
          );
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  const owner = m?.ownerId ? dir.memberById.get(m.ownerId)?.name : undefined;
  // Proposed already investigated (ADR 0037 round 2): what it read, the numbers, the one decision left.
  const findings = m?.findings ?? [];
  const investigated = findings.length > 0;
  const adjust =
    m?.canAct && actions?.replyToMission
      ? () => actions.replyToMission?.(meta.missionId, t("missions.plan.label"))
      : null;
  return (
    <div className={investigated ? "mi-card mi-plan mi-plan--investigated" : "mi-card mi-plan"}>
      <div className="mi-plan__head">
        <span className="mi-cap">
          <ExecutorMark executor={current} agentId={m?.agentId} agentName={agentName} />
          {investigated ? t("missions.findings.proposed") : t("missions.plan.cap", { executor, context: xg.context })}
        </span>
        <h3>{meta.title}</h3>
        {!investigated && !sameAsTitle(meta.title, meta.goal) && <p>{firstSentence(meta.goal)}</p>}
      </div>
      {m && investigated && <MissionFindings mission={m} agentName={agentName} />}
      {investigated && items.length > 0 && (
        <p className="mi-plan__label mi-findings__plan">{t("missions.findings.plan", { count: items.length })}</p>
      )}
      {plan.isPending ? (
        <div className="mi-plan__list" aria-hidden="true">
          <Skeleton width="60%" />
          <Skeleton width="45%" />
        </div>
      ) : items.length > 0 ? (
        <ul className="mi-plan__list">
          {items.slice(0, PLAN_SHOWN).map((i) => (
            <li key={i.id}>
              <span className={i.status === "done" ? "mi-box mi-box--on" : "mi-box"} aria-hidden="true">
                {i.status === "done" && <Icon name="check" size={14} />}
              </span>
              {i.title}
            </li>
          ))}
        </ul>
      ) : waitPlan ? (
        <div className="mi-plan__drafting" role="status">
          <p>
            <AgentSpinner agentId={m?.agentId} />
            {names
              ? t("missions.plan.drafting", { executor, computer, context: xg.context })
              : t("missions.plan.draftingNoComputer", { executor, context: xg.context })}
          </p>
          <ul className="mi-plan__list mi-plan__list--ghost" aria-hidden="true">
            {["58%", "44%", "51%"].map((w) => (
              <li key={w}>
                <span className="mi-box" />
                <Skeleton width={w} />
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mi-plan__note mi-plan__note--empty">{t("missions.plan.empty", { executor })}</p>
      )}
      {items.length > 0 && (
        <p className="mi-plan__note">
          {items.length > PLAN_SHOWN ? `${t("missions.plan.more", { count: items.length - PLAN_SHOWN })} · ` : ""}
          {t("missions.plan.adjusts", { executor, context: xg.context })}
        </p>
      )}
      <div className="mi-plan__metas">
        {(names || offline) && (
          <div className="mi-plan__meta">
            <span className="mi-plan__label mi-plan__label--wide">
              <MachineIcon machineId={m?.machine?.id} />
              {names
                ? t("missions.plan.on", { computer, state: offline ? t("missions.offline") : t("missions.online") })
                : t("missions.computerOffline")}
            </span>
          </div>
        )}
        {m?.baseBranch && (
          <div className="mi-plan__meta">
            <span className="mi-plan__label mi-plan__label--wide">
              <Icon name="pullRequest" size={14} />
              {t("missions.plan.base", { base: m.baseBranch })}
            </span>
          </div>
        )}
        {m && choices.length > 1 && (
          <div className="mi-plan__meta">
            <span className="mi-plan__label">
              <Icon name="code" size={14} />
              {t("missions.new.who")}
            </span>
            <Select
              size="sm"
              className="mi-plan__who"
              aria-label={t("missions.new.who")}
              value={current}
              disabled={switchExecutor.isPending}
              onValueChange={(v) =>
                switchExecutor.mutate(
                  { missionId: m.id, executor: v as MissionExecutor },
                  {
                    onSuccess: () => toast.show(t("missions.plan.switched", { executor: executorName(v, agentName) })),
                    onError: (error) => toast.show(errorText(t, error), "error"),
                  },
                )
              }
              options={executorOptions(t, choices, agentName, m.agentId)}
            />
          </div>
        )}
        {m?.canAct && (
          <div className="mi-plan__meta">
            <span className="mi-plan__label">
              <Icon name="shield" size={14} />
              {t("missions.commandApproval.label")}
            </span>
            <PlanApprovalSelect mission={m} />
          </div>
        )}
      </div>
      <Locked when={control.isPending}>
        {investigated ? (
          <>
            {/* Start first, then Adjust: the plan's own card (below) and every request card lead with the main action. */}
            <div className="mi-plan__foot mi-findings__foot">
              {m?.role === "owner" && (
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  loading={control.isPending}
                  disabled={waitPlan}
                  onClick={start}
                >
                  {t("missions.findings.start")}
                </Button>
              )}
              {adjust && (
                <Button size="sm" icon="edit" onClick={adjust}>
                  {t("missions.findings.adjust")}
                </Button>
              )}
              {m && m.role !== "owner" && owner && (
                <span className="mi-hint">{t("missions.plan.ownerStarts", { name: owner })}</span>
              )}
            </div>
            <p className="mi-findings__note">{t("missions.findings.note")}</p>
          </>
        ) : (
          <div className="mi-plan__foot">
            {m?.role === "owner" && (
              <Button
                variant="primary"
                size="sm"
                icon="check"
                loading={control.isPending}
                disabled={waitPlan}
                onClick={start}
              >
                {t("missions.plan.start")}
              </Button>
            )}
            {m?.canAct && actions?.replyToMission && (
              <Button
                size="sm"
                icon="edit"
                onClick={() => actions.replyToMission?.(meta.missionId, t("missions.plan.label"))}
              >
                {t("missions.plan.change")}
              </Button>
            )}
            {m?.role === "owner" && waitPlan && <span className="mi-hint">{t("missions.plan.waitPlan")}</span>}
            {m && m.role !== "owner" && owner && (
              <span className="mi-hint">{t("missions.plan.ownerStarts", { name: owner })}</span>
            )}
          </div>
        )}
      </Locked>
      {stamp.node}
    </div>
  );
}

const FINDING_ICONS: Record<MissionFinding["kind"], IconName> = { read: "search", data: "chart", decision: "question" };

/**
 * What the agent found before proposing: what it read (files and lines), what the numbers say, and
 * the one decision left, highlighted. Refs are code chips; a file opens in
 * the repository when the agent's repository is known.
 */
export function MissionFindings({ mission, agentName }: { mission: Mission; agentName: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const repos = useAgentRepos(org.id, mission.agentId);
  const repo = findingsRepo(repos.data, mission.repoDir);
  const list = [...mission.findings].sort((a, b) => Number(a.kind === "decision") - Number(b.kind === "decision"));
  if (mission.openQuestion && !list.some((f) => f.kind === "decision"))
    list.push({ kind: "decision", text: mission.openQuestion });
  // The sentence around the decision's own words, which keep their code and bold.
  const decided = t("missions.findings.decisionText", { text: "\u0000" }).split("\u0000");
  return (
    <ul className="mi-findings" aria-label={t("missions.findings.label", { name: agentName })}>
      {list.map((f, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id and never reorder
          key={i}
          className={f.kind === "decision" ? "mi-finding mi-finding--decision ac-iconline" : "mi-finding ac-iconline"}
          data-kind={f.kind}
        >
          <Icon name={FINDING_ICONS[f.kind]} size={16} label={t(`missions.findings.${f.kind}`)} />
          <span className="mi-finding__tx">
            {f.kind === "decision" && decided[0]}
            {inlineWords(f.text, `f${i}`)}
            {f.kind === "decision" && decided[1]}
            {f.refs?.map((ref) => {
              const url = findingRefUrl(ref, repo);
              return url ? (
                <a
                  key={ref}
                  className="mi-ref"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  title={t("missions.findings.openRef", { ref })}
                >
                  <code>{ref}</code>
                </a>
              ) : (
                <code key={ref} className="mi-ref">
                  {ref}
                </code>
              );
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Autonomia on the plan card (the same choice as Nova missão and Configurações da missão). */
function PlanApprovalSelect({ mission }: { mission: Mission }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const set = useSetCommandApproval(org.id, mission.id);
  return (
    <span className="mi-plan__who">
      <CommandApprovalSelect
        size="sm"
        value={mission.commandApproval}
        disabled={set.isPending}
        onChange={(v) =>
          set.mutate(v, {
            onSuccess: () =>
              toast.show(t("missions.commandApproval.changed", { value: t(`missions.commandApproval.${v}`) })),
            onError: (error) => toast.show(errorText(t, error), "error"),
          })
        }
      />
    </span>
  );
}

/**
 * Commands allowed without a card (`meta.missionAutoApproved`): one quiet
 * line, or one line for several within a minute ("3 comandos", Ver
 * comandos), with Revogar for whoever decides (back to asking for every one).
 */
export function AutoApprovedLine({ messages }: { messages: Message[] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const items = messages.flatMap((m) => {
    const a = missionAutoApprovedOf(m.meta);
    return a ? [{ id: m.id, at: m.createdAt, ...a }] : [];
  });
  const first = items[0];
  const missionId = first?.missionId ?? "";
  const mission = useMission(org.id, missionId || undefined);
  const set = useSetCommandApproval(org.id, missionId);
  if (!first) return null;
  const m = mission.data;
  const reason = t(`missions.auto.${first.reason}` as const);
  const canRevoke = Boolean(m?.canAct && m.commandApproval !== "always" && !revoked);
  const revoke = () =>
    set.mutate("always", {
      onSuccess: () => {
        setRevoked(true);
        toast.show(t("missions.auto.revoked"));
      },
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  return (
    <EventPill
      className="mi-evt mi-evt--auto"
      data-message-id={first.id}
      mark={<Icon name="check" size={14} />}
      time={formatTime(i18n.language, first.at)}
      actions={
        items.length > 1 || canRevoke ? (
          <>
            {canRevoke && (
              <EventPillAction title={t("missions.auto.revokeHint")} disabled={set.isPending} onClick={revoke}>
                {t("missions.auto.revoke")}
              </EventPillAction>
            )}
            {items.length > 1 && (
              <EventPillMore open={open} onClick={() => setOpen((o) => !o)}>
                {open ? t("missions.auto.hide") : t("missions.auto.show")}
              </EventPillMore>
            )}
          </>
        ) : undefined
      }
      below={
        open && items.length > 1 ? (
          <ul className="mi-evt__list">
            {items.map((i) => (
              <li key={i.id}>
                <code>{i.command}</code>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      {t("missions.auto.label")}:{" "}
      {items.length === 1 ? <code>{first.command}</code> : t("missions.auto.many", { count: items.length })} · {reason}
    </EventPill>
  );
}

/** Auto approvals in a row, a minute apart at most from the first: one line (first id → the group; the rest hidden). */
export function groupAutoApproved(list: Message[]) {
  const groups = new Map<string, Message[]>();
  const hidden = new Set<string>();
  let current: Message[] | null = null;
  for (const m of list) {
    const a = missionAutoApprovedOf(m.meta);
    const head = current?.[0];
    if (
      a &&
      current &&
      head &&
      missionAutoApprovedOf(head.meta)?.missionId === a.missionId &&
      Date.parse(m.createdAt) - Date.parse(head.createdAt) <= 60_000
    ) {
      current.push(m);
      hidden.add(m.id);
      continue;
    }
    current = a ? [m] : null;
    if (current) groups.set(m.id, current);
  }
  return { groups, hidden };
}

// ── Decision card ─────────────────────────────────────────────────────────────

export function MissionDecisionCard({ message }: { message: Message }) {
  const ref = missionCardRef(message.meta, "missionDecision");
  const { org } = useOrg();
  const decisions = useMissionDecisions(org.id, ref?.missionId);
  const mission = useMission(org.id, ref?.missionId);
  const d = decisions.data?.find((x) => x.id === ref?.id);
  if (!ref) return null;
  if (!d || !mission.data) {
    return decisions.isPending || mission.isPending ? (
      <div className="mi-card" aria-hidden="true">
        <Skeleton width="55%" height={18} />
      </div>
    ) : null;
  }
  return <DecisionBody decision={d} mission={mission.data} />;
}

function DecisionBody({ decision: d, mission: m }: { decision: MissionDecision; mission: Mission }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const names = useNamesComputers(org.id);
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const panel = useMissionPanel();
  const stamp = useStamp();
  const [pick, setPick] = useState<string | null>(d.status === "provisional" ? d.chosen : null);
  const choose = useMissionAct(org.id, m.id, (option: string) => api.missions.choose(org.id, m.id, d.id, option));
  const opine = useMissionAct(org.id, m.id, (option: string) => api.missions.opinion(org.id, m.id, d.id, option));
  const name = (id: string | null) => (id ? (dir.memberById.get(id)?.name ?? t("missions.someone")) : "");
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  if (d.status === "taken") {
    return (
      <div className="mi-card">
        <div className="mi-decided">
          <span className="mi-ok">
            <Icon name="check" size={16} />
          </span>
          <span className="mi-decided__t">
            <b>{t("missions.decision.taken", { question: d.question, option: d.chosen ?? "" })}</b>
            <small>
              {t("missions.decision.takenBy", {
                name: name(d.chosenBy),
                time: d.chosenAt ? formatTime(i18n.language, d.chosenAt) : "",
              })}{" "}
              <code className="mi-mono">{DECISIONS_FILE}</code>
            </small>
          </span>
          {panel && (
            <Button size="sm" icon="document" onClick={() => panel.openFiles(m.id, "decisions.md")}>
              {t("missions.decision.seeFile")}
            </Button>
          )}
        </div>
      </div>
    );
  }
  const canDecide = m.canAct;
  const canOpine = !m.canAct && m.role === "comment";
  const interactive = canDecide || canOpine;
  const mine = d.opinions.find((o) => o.userId === me.user.id);
  const submit = () => {
    if (!pick) return;
    if (canDecide) {
      choose.mutate(pick, {
        onSuccess: () => {
          stamp.show(t("missions.decision.decided"));
          toast.show(
            t("missions.decision.decidedToast"),
            "info",
            panel
              ? { label: t("missions.decision.seeFile"), run: () => panel.openFiles(m.id, "decisions.md") }
              : undefined,
          );
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      });
    } else if (canOpine) {
      opine.mutate(pick, {
        onSuccess: () => toast.show(t("missions.decision.opinionToast", { option: pick })),
        onError: (error) => toast.show(errorText(t, error), "error"),
      });
    }
  };
  return (
    <div className="mi-card">
      <div className="mi-tags">
        {d.blocking ? (
          <Chip icon="lock">{t("missions.decision.blocking")}</Chip>
        ) : (
          <Chip icon="clock">{t("missions.decision.provisional", { option: d.chosen ?? "" })}</Chip>
        )}
        <span className="mi-pill mi-exec">
          <ExecutorMark executor={m.executor} agentId={m.agentId} agentName={agentName} />
          {viaText(t, m.executor, agentName, names ? m.machine?.name : null)}
        </span>
      </div>
      <div className="mi-q">
        <h3>{inlineWords(d.question, "dq")}</h3>
      </div>
      <Locked when={choose.isPending || opine.isPending}>
        <RadioGroup className="mi-opts" value={pick ?? ""} onValueChange={(v) => setPick(v)} aria-label={d.question}>
          {d.options.map((o, i) => (
            <RadioCard
              key={o}
              value={o}
              id={`decision-${d.id}-${i}`}
              checked={pick === o}
              disabled={!interactive}
              title={o}
              description={
                opinionsFor(d, o).length > 0
                  ? t("missions.decision.prefers", { names: opinionsFor(d, o).map(name).join(", ") })
                  : undefined
              }
              aside={d.recommendation === o ? <Chip icon="bolt">{t("missions.decision.recommended")}</Chip> : undefined}
            />
          ))}
        </RadioGroup>
      </Locked>
      {(d.why || d.impact) && (
        <div className="mi-why">
          {d.why && (
            <>
              <span className="mi-why__k">
                <AgentAvatar agentId={m.agentId} name={dir.agentById.get(m.agentId)?.name ?? ""} size="xs" />
                {t("missions.decision.why")}
              </span>
              <span>{inlineWords(d.why, "dw")}</span>
            </>
          )}
          {d.impact && (
            <>
              <span className="mi-why__k">{t("missions.decision.impact")}</span>
              <span>{d.impact}</span>
            </>
          )}
        </div>
      )}
      <div className="mi-foot">
        <Locked when={choose.isPending || opine.isPending}>
          {canDecide && (
            <Button
              variant="primary"
              size="sm"
              icon="check"
              disabled={!pick}
              loading={choose.isPending}
              onClick={submit}
            >
              {pick ? t("missions.decision.decide", { option: pick }) : t("missions.decision.pick")}
            </Button>
          )}
          {canOpine && (
            <Button size="sm" icon="message" disabled={!pick} loading={opine.isPending} onClick={submit}>
              {pick ? t("missions.decision.opine", { option: pick }) : t("missions.decision.pick")}
            </Button>
          )}
        </Locked>
        {!interactive && <span className="mi-hint">{t("missions.decision.readOnly")}</span>}
        {mine && canOpine && (
          <span className="mi-hint">{t("missions.decision.yourOpinion", { option: mine.option })}</span>
        )}
        <span className="mi-foot__grow" />
        <span className="mi-hint ac-iconline">
          <Icon name="document" size={14} />
          {t("missions.decision.goesTo")} <code>{DECISIONS_FILE}</code>
        </span>
      </div>
      {stamp.node}
    </div>
  );
}

const DECISIONS_FILE = ".agentes/decisions.md";
const opinionsFor = (d: MissionDecision, option: string) =>
  d.opinions.filter((o) => o.option === option).map((o) => o.userId);

// ── Review card ───────────────────────────────────────────────────────────────

export function MissionReviewCard({ message }: { message: Message }) {
  const ref = missionCardRef(message.meta, "missionReview");
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const reviews = useMissionReviews(org.id, ref?.missionId);
  const mission = useMission(org.id, ref?.missionId);
  const stamp = useStamp();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const missionId = ref?.missionId ?? "";
  const review = useMissionAct(
    org.id,
    missionId,
    ({ outcome, note: n }: { outcome: "approve" | "changes"; note?: string }) =>
      api.missions.review(org.id, missionId, ref?.id ?? "", outcome, n),
  );
  const r = reviews.data?.find((x) => x.id === ref?.id);
  const m = mission.data;
  if (!ref) return null;
  if (!r || !m) {
    return reviews.isPending ? (
      <div className="mi-card" aria-hidden="true">
        <Skeleton width="55%" height={18} />
      </div>
    ) : null;
  }
  const who = r.decidedBy ? (dir.memberById.get(r.decidedBy)?.name ?? t("missions.someone")) : "";
  if (r.status !== "pending") {
    return (
      <div className="mi-card">
        <div className="mi-decided">
          <span className="mi-ok">
            <Icon name={r.status === "approved" ? "check" : "edit"} size={16} />
          </span>
          <span className="mi-decided__t">
            <b>
              {r.status === "approved"
                ? t("missions.review.approved", { title: r.title })
                : t("missions.review.changesAsked", { title: r.title })}
            </b>
            <small>
              {t("missions.review.by", { name: who, time: r.decidedAt ? formatTime(i18n.language, r.decidedAt) : "" })}
              {r.note ? ` · ${r.note}` : ""}
            </small>
          </span>
        </div>
      </div>
    );
  }
  const send = (outcome: "approve" | "changes") =>
    review.mutate(
      { outcome, ...(outcome === "changes" ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          stamp.show(outcome === "approve" ? t("missions.review.approvedStamp") : t("missions.review.sentStamp"));
          setAsking(false);
          setNote("");
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  return (
    <div className="mi-card">
      <div className="mi-q">
        <h3>{t("missions.review.ready", { title: r.title })}</h3>
        {r.summary && <FoldedBody body={r.summary} />}
      </div>
      {r.artifactIds.length > 0 && (
        <div className="artifact-cards">
          {r.artifactIds.map((id) => (
            <ArtifactCard key={id} artifact={{ id }} />
          ))}
        </div>
      )}
      {r.prUrl && (
        <div className="mi-pills" style={{ marginTop: 10 }}>
          <a className="mi-pr" href={r.prUrl} target="_blank" rel="noreferrer">
            <Icon name="pullRequest" size={14} />
            {t("missions.review.openPr")}
          </a>
        </div>
      )}
      <Locked when={review.isPending}>
        {asking && (
          <div className="mi-note">
            <Textarea
              value={note}
              rows={3}
              autoFocus
              aria-label={t("missions.review.noteLabel")}
              placeholder={t("missions.review.notePlaceholder")}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
        {m.canAct ? (
          <div className="mi-foot">
            {asking ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  icon="send"
                  disabled={!note.trim()}
                  loading={review.isPending}
                  onClick={() => send("changes")}
                >
                  {t("missions.review.sendChanges")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
                  {t("common.cancel")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  icon="check"
                  loading={review.isPending}
                  onClick={() => send("approve")}
                >
                  {t("missions.review.approve")}
                </Button>
                <Button size="sm" icon="edit" onClick={() => setAsking(true)}>
                  {t("missions.review.askChanges")}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="mi-foot">
            <span className="mi-hint">{t("missions.review.readOnly")}</span>
          </div>
        )}
      </Locked>
      {stamp.node}
    </div>
  );
}

// ── Delivery card (the end of a mission) ──────────────────────────────────────

/**
 * The mission's end, like an approval (ADR 0029): what was delivered (the
 * summary, the files as thumbnails that open in the Drive), "O que conferir"
 * as items each person checks for themselves, and for the owner or deciders
 * "Concluir missão" (with "Salvar decisões e lições na wiki") or "Pedir
 * ajustes" (a note that resumes the work). Every plan item done and nothing
 * running without a call to complete_mission: the smaller "Tudo pronto" card.
 */
export function MissionDeliveryCard({ message }: { message: Message }) {
  const ref = missionCardRef(message.meta, "missionDelivery");
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const deliveries = useMissionDeliveries(org.id, ref?.missionId);
  const mission = useMission(org.id, ref?.missionId);
  const stamp = useStamp();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [wiki, setWiki] = useState(true);
  const missionId = ref?.missionId ?? "";
  const deliveryId = ref?.id ?? "";
  const accept = useMissionAct(org.id, missionId, (saveToWiki: boolean) =>
    api.missions.acceptDelivery(org.id, missionId, deliveryId, { saveToWiki }),
  );
  const changes = useMissionAct(org.id, missionId, (text: string) =>
    api.missions.requestDeliveryChanges(org.id, missionId, deliveryId, text),
  );
  const check = useMissionAct(org.id, missionId, ({ itemId, checked }: { itemId: string; checked: boolean }) =>
    api.missions.checkDelivery(org.id, missionId, deliveryId, itemId, checked),
  );
  const d = deliveries.data?.find((x) => x.id === ref?.id);
  const m = mission.data;
  if (!ref) return null;
  if (!d || !m) {
    return deliveries.isPending ? (
      <div className="mi-card" aria-hidden="true">
        <Skeleton width="55%" height={18} />
      </div>
    ) : null;
  }
  // A newer delivery replaced this one: it says so in one quiet line.
  if (d.status === "superseded") {
    return (
      <p className="mi-evt ac-iconline">
        <Icon name="refresh" size={14} />
        <span>{t("missions.delivery.superseded")}</span>
      </p>
    );
  }
  const who = d.decidedBy ? (dir.memberById.get(d.decidedBy)?.name ?? t("missions.someone")) : "";
  const time = d.decidedAt ? formatTime(i18n.language, d.decidedAt) : "";
  if (d.status !== "pending") {
    return (
      <section className="mi-card" aria-label={t("missions.delivery.label")}>
        <div className="mi-decided">
          <span className="mi-ok">
            <Icon name={d.status === "accepted" ? "check" : "edit"} size={16} />
          </span>
          <span className="mi-decided__t">
            <b>{d.status === "accepted" ? t("missions.delivery.accepted") : t("missions.delivery.changesAsked")}</b>
            <small>
              {t("missions.review.by", { name: who, time })}
              {d.note ? ` · ${d.note}` : ""}
            </small>
          </span>
        </div>
      </section>
    );
  }
  const decide = m.canAct && m.status !== "done" && m.status !== "canceled";
  const finish = () =>
    accept.mutate(wiki, {
      onSuccess: () => stamp.show(t("missions.delivery.acceptedStamp")),
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  const ask = () =>
    changes.mutate(note.trim(), {
      onSuccess: () => {
        stamp.show(t("missions.delivery.sentStamp"));
        setAsking(false);
        setNote("");
      },
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  const checked = d.checklist.filter((c) => c.checkedBy.includes(me.user.id)).length;
  return (
    <section
      className={d.auto ? "mi-card mi-delivery mi-delivery--auto" : "mi-card mi-delivery"}
      aria-label={t("missions.delivery.label")}
    >
      <div className="mi-tags">
        <Chip icon="flag" tone={decide ? "waiting" : "neutral"}>
          {decide ? t("missions.status.awaitingClose") : t("missions.status.readyToClose")}
        </Chip>
      </div>
      <div className="mi-q">
        <h3>{d.auto ? t("missions.delivery.allDone") : t("missions.delivery.title", { title: m.title })}</h3>
        {d.auto ? <p>{t("missions.delivery.allDoneText")}</p> : d.summary && <FoldedBody body={d.summary} />}
      </div>
      {d.artifactIds.length > 0 && (
        <div className="artifact-cards">
          {d.artifactIds.map((id) => (
            <ArtifactCard key={id} artifact={{ id }} />
          ))}
        </div>
      )}
      {d.checklist.length > 0 && (
        <section className="mi-delivery__check" aria-label={t("missions.delivery.check")}>
          <h4>
            {t("missions.delivery.check")}
            <span>{t("missions.delivery.checked", { done: checked, total: d.checklist.length })}</span>
          </h4>
          <ul>
            {d.checklist.map((c) => {
              const mine = c.checkedBy.includes(me.user.id);
              const others = c.checkedBy.filter((u) => u !== me.user.id);
              return (
                <li key={c.id} data-done={mine || undefined}>
                  <Checkbox
                    id={`dl-${d.id}-${c.id}`}
                    checked={mine}
                    disabled={!m.canAct}
                    onCheckedChange={(v) => check.mutate({ itemId: c.id, checked: v })}
                  />
                  <label htmlFor={`dl-${d.id}-${c.id}`}>{c.text}</label>
                  {others.length > 0 && (
                    <span className="mi-delivery__by" title={others.map((u) => dir.memberById.get(u)?.name).join(", ")}>
                      {others.slice(0, 3).map((u) => (
                        <ActorAvatar
                          key={u}
                          actor={{ type: "person", id: u }}
                          name={dir.memberById.get(u)?.name ?? ""}
                          size="xs"
                        />
                      ))}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <Locked when={changes.isPending || accept.isPending}>
        {asking && (
          <div className="mi-note">
            <Textarea
              value={note}
              rows={3}
              autoFocus
              aria-label={t("missions.delivery.noteLabel")}
              placeholder={t("missions.delivery.notePlaceholder")}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        )}
        {decide ? (
          <div className="mi-foot">
            {asking ? (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  icon="send"
                  disabled={!note.trim()}
                  loading={changes.isPending}
                  onClick={ask}
                >
                  {t("missions.delivery.sendChanges")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
                  {t("common.cancel")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="primary" size="sm" icon="check" loading={accept.isPending} onClick={finish}>
                  {t("missions.delivery.accept")}
                </Button>
                <Button size="sm" icon="edit" onClick={() => setAsking(true)}>
                  {t("missions.delivery.askChanges")}
                </Button>
                <span className="mi-delivery__wiki">
                  <Switch id={`dl-wiki-${d.id}`} checked={wiki} onCheckedChange={setWiki} />
                  <label htmlFor={`dl-wiki-${d.id}`}>{t("missions.delivery.saveToWiki")}</label>
                </span>
              </>
            )}
          </div>
        ) : (
          <div className="mi-foot">
            <span className="mi-hint">{t("missions.delivery.readOnly")}</span>
          </div>
        )}
      </Locked>
      {stamp.node}
    </section>
  );
}

// ── Lines in the thread ───────────────────────────────────────────────────────

/** A long change shows this many parts, then "+N itens editados" (the whole list is in the plan). */
export const PLAN_CHANGE_SHOWN = 3;

/** "Plano atualizado: + Notificações · − Drawer lateral · Ver plano" (the icon on the text's first line). */
export function MissionPlanChangeLine({ message }: { message: Message }) {
  const { t } = useTranslation();
  const panel = useMissionPanel();
  const change = missionPlanChangeOf(message.meta);
  if (!change) return null;
  const p = planChangeParts(change);
  const parts = [
    ...p.added.map((x) => `+ ${x}`),
    ...p.removed.map((x) => `− ${x}`),
    ...p.done.map((x) => t("missions.planChange.done", { title: x })),
    // Only the wording changed: the new title, marked edited (the old one in the tooltip).
    ...p.renamed.map((x) => t("missions.planChange.renamed", { to: x.to })),
  ];
  const before = p.renamed.map((x) => `${x.from} → ${x.to}`).join("\n");
  const long = parts.length > PLAN_CHANGE_SHOWN;
  const shown = long ? parts.slice(0, PLAN_CHANGE_SHOWN - 1) : parts;
  const rest = parts.length - shown.length;
  return (
    <EventPill
      className="mi-evt"
      data-message-id={message.id}
      mark={<Icon name="edit" size={14} />}
      actions={
        panel ? (
          <EventPillAction onClick={() => panel.openFiles(change.missionId, "mission.md")}>
            {t("missions.plan.see")}
          </EventPillAction>
        ) : undefined
      }
    >
      <span className="mi-evt__text" title={before || (long ? parts.join("\n") : undefined)}>
        <b>{t("missions.planChange.title")}</b>
        {shown.length > 0 ? `: ${shown.join(" · ")}` : ""}
        {long ? ` · ${t("missions.planChange.more", { count: rest })}` : ""}
      </span>
    </EventPill>
  );
}

const NOTICE_ICON: Record<string, IconName> = {
  machine_offline: "computer",
  machine_task_resumed: "refresh",
  machine_task_resume_waits: "waiting",
  machine_task_restarted: "refresh",
  machine_task_done: "check",
  machine_task_failed: "alert",
  machine_task_canceled: "stop",
  machine_task_interrupted: "pause",
  machine_access_requested: "waiting",
  machine_access_granted: "check",
  machine_access_denied: "close",
  machine_access_expired: "dash",
};

/**
 * The computer went offline, came back, a task ended: one event pill (what can be done about it under it). A task's end names its computer only where the
 * workspace has more than one (`useNamesComputers`).
 */
export function TaskNoticeLine({ message }: { message: Message }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const names = useNamesComputers(org.id);
  const dir = useDirectory(org.id);
  const notice = taskNoticeOf(message.meta);
  // A folder request to this very Mac (agentes for Mac): answered in the menu bar, one click away (ADR 0036).
  const asked = (message.meta as { machineAccess?: { machineId?: unknown } } | null)?.machineAccess?.machineId;
  const here = useIsThisMac(org.id, typeof asked === "string" ? asked : "");
  // A note from before the workspace's own computer stopped taking requests: nobody can run its command there.
  const managed = useMachines(org.id).data?.some((m) => m.id === asked && m.kind === "managed");
  if (!notice) return null;
  // A folder request (ADR 0036 §8): the server sends `path` and `computer`; the agent is the note's author.
  const author =
    message.author.type === "agent" && message.author.id ? (dir.agentById.get(message.author.id)?.name ?? "") : "";
  const p = notice.code.startsWith("machine_access_")
    ? { agent: author, folder: notice.params.path ? folderName(notice.params.path) : "", ...notice.params }
    : notice.params;
  const seconds = Number(p.seconds ?? 0);
  // Commands it was refused: one line, the list in a dialog.
  const task = machineTaskOf(message.meta);
  const blocked = task?.blocked ?? [];
  const key = `missions.notice.${notice.code}`;
  return (
    <EventPill
      className="mi-evt"
      data-message-id={message.id}
      mark={<Icon name={NOTICE_ICON[notice.code] ?? "computer"} size={14} />}
      time={formatTime(i18n.language, message.createdAt)}
      below={
        <>
          {blocked.length > 0 && task?.missionId && (
            <BlockedCommands missionId={task.missionId} taskId={task.id} blocked={blocked} />
          )}
          {notice.code === "machine_access_requested" && here && (
            <span className="mi-evt__act">
              <ShowRequestsButton />
            </span>
          )}
          {notice.code === "machine_access_requested" && p.command && !here && !managed && (
            <span className="mi-evt__command">
              <span className="small muted">{t("missions.notice.access_command")}</span>
              <CommandBlock command={p.command} />
            </span>
          )}
        </>
      }
    >
      {/* i18next takes the first key that exists: a notice with no `…NoComputer` words keeps its own. */}
      {t(names ? key : [`${key}NoComputer`, key], {
        ...p,
        count: Number(p.count ?? 1),
        span: Number.isFinite(seconds) ? formatSpan(t, seconds) : "",
        defaultValue: message.body,
      })}
    </EventPill>
  );
}

/**
 * Under an executor's report: "via Claude Code no MacBook do Walter" (the computer only where the workspace has more
 * than one) and its session row.
 */
export function MissionReportExtras({ report, message }: { report: MissionReportMeta; message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const names = useNamesComputers(org.id);
  const tasks = useThreadTasks(org.id, message.threadId);
  const task = report.main ? undefined : tasks.data?.find((x) => x.id === report.taskId);
  const dir = useDirectory(org.id);
  const agentName =
    message.author.type === "agent" && message.author.id ? (dir.agentById.get(message.author.id)?.name ?? "") : "";
  return (
    <>
      <span className="mi-tag mi-exec">
        <ExecutorMark executor={report.executor} agentId={message.author.id ?? undefined} agentName={agentName} />
        {viaText(t, report.executor, agentName, names ? report.computer : null)}
      </span>
      {task && <SessionRows tasks={[task]} defaultOpen />}
    </>
  );
}

/** A person's message that became a suggestion: Aceitar / Recusar for whoever can act. */
export function MissionSuggestionBar({ message, suggestion }: { message: Message; suggestion: MissionSuggestionMeta }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const mission = useMission(org.id, suggestion.missionId);
  const act = useMissionAct(org.id, suggestion.missionId, (outcome: "accept" | "decline") =>
    api.missions.suggestion(org.id, suggestion.missionId, message.id, outcome),
  );
  const [answered, setAnswered] = useState<"accepted" | "declined" | null>(null);
  const status = answered ?? suggestion.status;
  const m = mission.data;
  if (status !== "pending") {
    return (
      <div className="mi-suggest">
        <Chip icon={status === "accepted" ? "check" : "close"}>{t(`missions.suggestion.${status}`)}</Chip>
      </div>
    );
  }
  const answer = (outcome: "accept" | "decline") =>
    act.mutate(outcome, {
      onSuccess: (out) => {
        setAnswered(out.status);
        toast.show(t(`missions.suggestion.${out.status}Toast`));
      },
      onError: (error) => toast.show(errorText(t, error), "error"),
    });
  return (
    <div className="mi-suggest">
      <Chip icon="waiting" tone="waiting">
        {t("missions.suggestion.pending")}
      </Chip>
      {m?.canAct ? (
        <Locked when={act.isPending}>
          <Button size="sm" icon="check" loading={act.isPending} onClick={() => answer("accept")}>
            {t("missions.suggestion.accept")}
          </Button>
          <Button size="sm" variant="ghost" icon="close" onClick={() => answer("decline")}>
            {t("missions.suggestion.decline")}
          </Button>
        </Locked>
      ) : (
        <span>{t("missions.suggestion.waits")}</span>
      )}
    </div>
  );
}

/** In the channel: the root of a mission links to its thread (its work lives there). */
export function MissionStartLink({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Link
      to="/org/$orgId/threads/$threadId"
      params={{ orgId: org.id, threadId: message.id }}
      className="ac-link mi-tag mi-lnk"
    >
      <Icon name="flag" size={14} />
      {t("missions.openThread")}
    </Link>
  );
}

// ── The mission's link card, where it was asked ───────────────────────────────

/**
 * Under the agent's reply in the conversation where the person asked, when
 * the mission lives in another thread (a flat DM): its title, its state
 * (live via `mission.updated`), who works on which computer, and Abrir
 * thread / Ver plano.
 */
export function MissionLinkCard({ link }: { link: MissionLinkMeta }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const names = useNamesComputers(org.id);
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const panel = useMissionPanel();
  const mission = useMission(org.id, link.missionId);
  const m = mission.data;
  const threadLink = {
    to: "/org/$orgId/threads/$threadId" as const,
    params: { orgId: org.id, threadId: link.threadId },
  };
  if (!m) {
    return mission.isPending ? (
      <div className="mi-card mi-linkcard" aria-hidden="true">
        <Skeleton width="55%" height={18} />
      </div>
    ) : null;
  }
  const agentName = dir.agentById.get(m.agentId)?.name ?? "";
  const offline = Boolean(m.machine && !m.machine.online);
  // Before Start: still planning, or the plan is there and waits for the person who asked.
  const proposed = m.status === "proposed" ? (m.plan.total > 0 ? "ready" : "planning") : null;
  return (
    <section className="mi-card mi-linkcard" aria-label={t("missions.link.label", { title: m.title })}>
      <MissionHead
        agentId={m.agentId}
        agentName={agentName}
        running={m.runningTasks > 0 && !offline}
        title={<Link {...threadLink}>{m.title}</Link>}
        meta={[
          <span key="via" className="mi-exec">
            <ExecutorMark executor={m.executor} agentId={m.agentId} agentName={agentName} />
            {viaText(t, m.executor, agentName, names ? m.machine?.name : null)}
          </span>,
        ]}
        right={
          proposed ? (
            <Chip
              icon={proposed === "ready" ? "waiting" : "document"}
              tone={proposed === "ready" && m.role === "owner" ? "waiting" : "neutral"}
            >
              {proposed === "planning"
                ? t("missions.link.status.planning")
                : m.role === "owner"
                  ? t("missions.link.status.ready")
                  : t("missions.link.status.readyOther")}
            </Chip>
          ) : (
            <MissionStatusChip mission={m} />
          )
        }
      />
      <div className="mi-linkcard__foot">
        <Button size="sm" variant="primary" icon="thread" onClick={() => void navigate(threadLink)}>
          {t("missions.list.openThread")}
        </Button>
        <Button
          size="sm"
          icon="document"
          onClick={() => (panel ? panel.openFiles(m.id, "mission.md") : void navigate(threadLink))}
        >
          {t("missions.plan.see")}
        </Button>
      </div>
    </section>
  );
}

// ── `/summary` and `/plan`: only you see them ─────────────────────────────────

export function MissionEphemeral({
  kind,
  missionId,
  onClose,
}: {
  kind: "summary" | "plan";
  missionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const panel = useMissionPanel();
  const summary = useQuery({
    queryKey: keys.missionPart(org.id, missionId, "summary"),
    queryFn: () => api.missions.summary(org.id, missionId),
    enabled: kind === "summary",
    staleTime: 0,
  });
  const plan = useMissionPlan(org.id, missionId, kind === "plan");
  const items = plan.data?.current?.items ?? [];
  const counts = planCounts(items);
  return (
    <section className="mi-card mi-ephemeral" aria-label={t(`missions.ephemeral.${kind}`)}>
      <div className="mi-ephemeral__head">
        <Icon name={kind === "summary" ? "layers" : "document"} size={16} />
        <b>{t(`missions.ephemeral.${kind}`)}</b>
        <Button size="sm" variant="ghost" iconOnly icon="close" aria-label={t("common.close")} onClick={onClose} />
      </div>
      {kind === "summary" ? (
        summary.data ? (
          <ul>
            {summaryParts(summary.data).map((p) => (
              <li key={p.key}>{t(`missions.summary.${p.key}`, { count: p.count, total: p.total ?? 0 })}</li>
            ))}
          </ul>
        ) : (
          <Skeleton width="60%" />
        )
      ) : plan.data ? (
        <>
          <ul>
            {items.map((i) => (
              <li key={i.id}>
                <span className={i.status === "done" ? "mi-box mi-box--on" : "mi-box"} aria-hidden="true">
                  {i.status === "done" && <Icon name="check" size={14} />}
                </span>
                <span>
                  {i.title}{" "}
                  {i.status !== "todo" && i.status !== "done" && <small>{t(`missions.item.${i.status}`)}</small>}
                </span>
              </li>
            ))}
          </ul>
          <p className="mi-ephemeral__foot">
            {t("missions.ephemeral.planLine", {
              done: counts.done,
              total: counts.total,
              version: plan.data.current?.version ?? 0,
            })}
            {panel && (
              <>
                {" · "}
                <button type="button" className="mi-link" onClick={() => panel.openFiles(missionId, "mission.md")}>
                  {t("missions.files.open")}
                </button>
              </>
            )}
          </p>
        </>
      ) : (
        <Skeleton width="60%" />
      )}
      <p className="mi-ephemeral__foot">{t("missions.ephemeral.onlyYou")}</p>
    </section>
  );
}

/**
 * `meta.missionSetup` (ADR 0044): preparing the mission's copy of the project
 * failed. The end of the error in a code block and "Tentar de novo" for whoever
 * can act on the mission; once retried, the card says where it stands now.
 */
export function MissionSetupCard({ setup, threadId }: { setup: MissionSetupMeta; threadId: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const byId = useMission(org.id, setup.missionId);
  const ofThread = useThreadMission(org.id, threadId, !setup.missionId);
  const m = setup.missionId ? byId.data : ofThread.data;
  const retry = useRetryMissionWorktree(org.id, m?.id ?? "");
  const lost = setup.reason === "branch_missing";
  const tail = lost ? "" : lastLines(setup.error);
  const state = m?.worktreeState;
  const title = t(lost ? "missions.setup.lostTitle" : "missions.setup.failedTitle");
  const open = m ? m.status !== "done" && m.status !== "canceled" : false;
  return (
    <section className="mi-card mi-setup" aria-label={title}>
      <div className="mi-tags">
        <Chip icon="alert" tone={m?.canAct && state === "failed" && open ? "waiting" : "neutral"}>
          {t("missions.setup.cap")}
        </Chip>
      </div>
      <h3 className="mi-setup__title">{title}</h3>
      {lost && <p className="mi-hint">{t("missions.setup.lostText", { branch: setup.branch ?? m?.branch ?? "" })}</p>}
      {tail && (
        <pre className="mi-cmd__line mi-setup__error" role="log" aria-label={t("missions.setup.errorLabel")}>
          <code>{tail}</code>
        </pre>
      )}
      {state === "preparing" ? (
        <p className="mi-hint mi-setup__now ac-iconline">
          <AgentSpinner agentId={m?.agentId} />
          {t("missions.setup.preparing")}
        </p>
      ) : state === "ready" ? (
        <p className="mi-hint mi-setup__now ac-iconline">
          <Icon name="check" size={14} />
          {t("missions.setup.ready")}
        </p>
      ) : m && open && state === "failed" ? (
        m.canAct ? (
          <div className="mi-foot">
            <Button
              variant="primary"
              size="sm"
              icon="refresh"
              loading={retry.isPending}
              onClick={() =>
                retry.mutate(undefined, {
                  onSuccess: () => toast.show(t("missions.setup.retrying")),
                  onError: (error) => toast.show(errorText(t, error), "error"),
                })
              }
            >
              {t(lost ? "missions.setup.restart" : "missions.setup.retry")}
            </Button>
          </div>
        ) : (
          <p className="mi-hint mi-setup__now">{t("missions.setup.waiting")}</p>
        )
      ) : null}
    </section>
  );
}

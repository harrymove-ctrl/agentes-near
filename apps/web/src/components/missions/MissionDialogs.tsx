import type { CommandApproval, Mission, MissionExecutor, MissionParticipantRole } from "@agenteschat/client";
import {
  cacheMission,
  keys,
  refreshMission,
  useChannels,
  useCloseMission,
  useCreateMission,
  useDecideJoin,
  useEligibleAgents,
  useMissionJoinRequests,
  useMissionParticipants,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { computerNameOf } from "@agenteschat/client/lib/computer";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { executorName } from "@agenteschat/client/lib/missions";
import { can } from "@agenteschat/client/lib/permissions";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  GroupHeading,
  Icon,
  InfoHint,
  Locked,
  Menu,
  MenuItem,
  MenuSeparator,
  RadioCard,
  RadioGroup,
  SearchField,
  Segmented,
  Select,
  Switch,
  Textarea,
  Toolbar,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { MachineIcon } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { ThisMacButton } from "@/components/ThisMac";
import { useComputerEdition, useNamesComputers } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { CommandApprovalSelect, executorOptions } from "./MissionBits";
import "./missions.css";

/**
 * The mission dialogs: "Nova missão" (objective, agent, where
 * it lives, the computer it runs on where the workspace has more than one), closing it (Concluída / Cancelada,
 * "Salvar decisões e lições na wiki"), and "Compartilhar" (who can decide or
 * comment, handing it over; the computer never moves by itself).
 */

/** The composer command (English, like the server's). */
const MISSION_COMMAND = "/mission";

// ── Nova missão ───────────────────────────────────────────────────────────────

export function NewMissionDialog({
  open,
  onOpenChange,
  initialGoal = "",
  initialAgentId,
  initialChannelId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialGoal?: string;
  initialAgentId?: string;
  initialChannelId?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // On the Cloud every agent works on the workspace's own computer: missions wait for it, nobody connects one.
  const cloud = useComputerEdition(org.id) === "cloud";
  const waitWords = t("missions.waitingCloud", {
    computer: t(modeKey(org, "computerSetup.titleInSentence"), { org: org.name }),
  });
  // Its computer by name only where there are two to tell apart; else only one that is offline says so.
  const names = useNamesComputers(org.id);
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const create = useCreateMission(org.id);
  // Every agent I can talk to; the ones that can't run a mission say why (the server checks audience and runner).
  const eligible = useEligibleAgents(org.id, open);
  const choices = (eligible.data ?? []).flatMap((e) => {
    const a = dir.agentById.get(e.agentId);
    if (!a || e.reason === "not_in_audience") return [];
    return [
      {
        ...a,
        eligible: e.eligible !== false && Boolean(e.machine),
        reason: e.reason ?? null,
        canManage: e.canManage === true,
        machine: e.machine,
        executors: e.executors ?? [],
        defaultExecutor: e.defaultExecutor,
        codexTooOld: e.codexTooOld,
        commandApproval: e.commandApproval,
      },
    ];
  });
  const agents = choices.filter((a) => a.eligible);
  const blocked = choices.filter((a) => !a.eligible);
  const [goal, setGoal] = useState(initialGoal);
  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  const memberChannels = (channels.data ?? []).filter((c) => c.isMember);
  const [home, setHome] = useState<"channel" | "dm">(initialChannelId || memberChannels.length ? "channel" : "dm");
  const [channelId, setChannelId] = useState(initialChannelId ?? memberChannels[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  // Autonomia: the agent's default for new missions until the person picks one.
  const [pickedApproval, setApproval] = useState<CommandApproval | null>(null);
  // The one asked for when it can run a mission, else the first that can.
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const machine = agent?.machine ?? null;
  const approval: CommandApproval = pickedApproval ?? agent?.commandApproval ?? "low_risk_auto";
  // "Quem programa": only who can work on that computer; default Claude Code when it's there, else the agent.
  const [picked, setPicked] = useState<MissionExecutor | null>(null);
  const executor: MissionExecutor | undefined =
    agent && picked && agent.executors.includes(picked) ? picked : (agent?.defaultExecutor ?? undefined);
  // Nobody can run one yet: where to connect a computer (an agent I can talk to, mine first).
  const setupAgent =
    dir.agentById.get(blocked.find((a) => a.canManage)?.id ?? "") ?? dir.agents.find((a) => canTalk(a));
  const none = eligible.isSuccess && agents.length === 0;
  const goalId = useId();
  const submit = async () => {
    if (!agent || !goal.trim()) return;
    setError(null);
    let where = channelId;
    if (home === "dm") {
      try {
        where = (await api.dms.open(org.id, { agentId: agent.id })).channelId;
      } catch (e) {
        setError(errorText(t, e));
        return;
      }
    }
    create.mutate(
      {
        agentId: agent.id,
        goal: goal.trim(),
        channelId: where,
        ...(pickedApproval ? { commandApproval: pickedApproval } : {}),
        ...(executor ? { executor } : {}),
      },
      {
        onSuccess: (mission) => {
          onOpenChange(false);
          setGoal("");
          toast.show(t("missions.new.created", { name: agent.name }));
          void navigate({
            to: "/org/$orgId/threads/$threadId",
            params: { orgId: org.id, threadId: mission.threadId },
          });
        },
        onError: (e) => setError(errorText(t, e)),
      },
    );
  };
  const approvalsNote = (
    <span className="ac-iconline">
      <Icon name="shield" size={14} />
      <span>{t("missions.new.approvals")}</span>
    </span>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("missions.new.title")}
      description={t("missions.new.text")}
      closeLabel={t("common.close")}
    >
      <Locked when={create.isPending}>
        <DialogBody>
          <div className="ac-field">
            <label className="ac-field__label" htmlFor={goalId}>
              {t("missions.new.goal")}
            </label>
            <Textarea
              id={goalId}
              rows={3}
              value={goal}
              maxLength={2000}
              placeholder={t("missions.new.goalPlaceholder")}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
          {none ? (
            <div className="mi-notes mi-agent-empty" role="status">
              <span className="ac-iconline">
                <Icon name="computer" size={14} />
                <b>{t("missions.new.noEligibleTitle")}</b>
              </span>
              <span>{cloud ? waitWords : t("missions.new.noEligibleText")}</span>
              {/* agentes for Mac: this Mac first, then the agent points at it (ADR 0036). */}
              {!cloud && <ThisMacButton orgId={org.id} canPair={can(org, "pair_computers")} folders={false} />}
              {setupAgent && !cloud && (
                <Link
                  className="ac-link mi-lnk"
                  to="/org/$orgId/agents/$agentId"
                  params={{ orgId: org.id, agentId: setupAgent.id }}
                  search={{ tab: "settings", sec: "computer" }}
                  onClick={() => onOpenChange(false)}
                >
                  <Icon name="settings" size={14} />
                  {t("missions.new.connectComputer", agentGrammar(setupAgent.name))}
                </Link>
              )}
            </div>
          ) : (
            <div className={names ? "mi-grid2" : undefined}>
              <div className="ac-field">
                <span className="ac-field__label">{t("missions.new.agent")}</span>
                <Select
                  aria-label={t("missions.new.agent")}
                  value={agent?.id}
                  onValueChange={setAgentId}
                  placeholder={eligible.isPending ? "…" : undefined}
                  options={[...agents, ...blocked].map((a) => ({
                    value: a.id,
                    label: a.name,
                    disabled: !a.eligible,
                    description:
                      a.eligible && a.machine
                        ? names
                          ? t("missions.new.agentOn", {
                              computer: computerNameOf(t, org.name, a.machine.name, isPersonal(org)),
                              state: a.machine.online ? t("missions.online") : t("missions.offline"),
                            })
                          : a.machine.online
                            ? undefined
                            : t("missions.computerOffline")
                        : cloud && (a.reason ?? "no_computer") === "no_computer"
                          ? waitWords
                          : t(`missions.new.reason.${a.reason ?? "no_computer"}`, {
                              computer: computerNameOf(t, org.name, a.machine?.name ?? "", isPersonal(org)),
                            }),
                    leading: <AgentAvatar agentId={a.id} name={a.name} size="sm" />,
                  }))}
                />
              </div>
              {names && (
                <div className="ac-field">
                  <span className="ac-field__label">{t("missions.new.computer")}</span>
                  <span className="mi-pill mi-pill--field">
                    <MachineIcon machineId={machine?.id} />
                    {machine ? machine.name : eligible.isPending ? "…" : t("missions.new.noMachine")}
                    {machine && <small>{machine.online ? t("missions.online") : t("missions.offline")}</small>}
                  </span>
                </div>
              )}
            </div>
          )}
          {!none && blocked.some((a) => a.canManage) && (
            <ul className="mi-blocked" aria-label={t("missions.new.blockedLabel")}>
              {blocked
                .filter((a) => a.canManage)
                .map((a) => (
                  <li key={a.id} className="mi-blocked__row ac-mediarow ac-mediarow--row">
                    <span className="ac-mediarow__face">
                      <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                    </span>
                    <span className="ac-mediarow__head">
                      <b>{a.name}</b>
                    </span>
                    <span className="ac-mediarow__body mi-blocked__text">
                      {cloud && (a.reason ?? "no_computer") === "no_computer"
                        ? waitWords
                        : t(`missions.new.reason.${a.reason ?? "no_computer"}`, {
                            computer: computerNameOf(t, org.name, a.machine?.name ?? "", isPersonal(org)),
                          })}
                    </span>
                    {!cloud && (
                      <span className="ac-mediarow__end">
                        <Link
                          className="ac-link mi-lnk"
                          to="/org/$orgId/agents/$agentId"
                          params={{ orgId: org.id, agentId: a.id }}
                          search={{ tab: "settings", sec: "computer" }}
                          onClick={() => onOpenChange(false)}
                        >
                          {t("missions.new.connect")}
                        </Link>
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          )}
          {agent && agent.executors.length > 0 && (
            <div className="ac-field">
              <span className="ac-field__label">{t("missions.new.who")}</span>
              <Select
                aria-label={t("missions.new.who")}
                value={executor}
                onValueChange={(v) => setPicked(v as MissionExecutor)}
                options={executorOptions(t, agent.executors, agent.name, agent.id)}
              />
              {agent.codexTooOld && (
                <span className="mi-hint ac-iconline">
                  <Icon name="info" size={14} />
                  {t("missions.new.codexOld", {
                    computer: computerNameOf(t, org.name, agent.machine?.name ?? "", isPersonal(org)),
                  })}
                </span>
              )}
            </div>
          )}
          {!none && (
            <div className="ac-field">
              <span className="ac-field__label">{t("missions.commandApproval.label")}</span>
              <CommandApprovalSelect value={approval} onChange={setApproval} />
            </div>
          )}
          <div className="ac-field">
            <span className="ac-hintline">
              <span className="ac-field__label">{t("missions.new.home")}</span>
              <InfoHint name={t("common.about", { label: t("missions.new.home") })}>
                {t("missions.new.homeHint", agentGrammar(agent?.name ?? ""))}
              </InfoHint>
            </span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Segmented
                size="sm"
                label={t("missions.new.home")}
                value={home}
                onValueChange={setHome}
                options={[
                  { value: "channel", label: t("missions.new.channel") },
                  { value: "dm", label: t("missions.new.dm") },
                ]}
              />
              {home === "channel" ? (
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Select
                    size="sm"
                    aria-label={t("missions.new.channel")}
                    value={channelId || undefined}
                    onValueChange={setChannelId}
                    placeholder={t("missions.new.pickChannel")}
                    options={memberChannels.map((c) => ({ value: c.id, label: `#${c.name}` }))}
                  />
                </div>
              ) : (
                <span className="mi-hint">{t("missions.new.dmWith", { name: agent?.name ?? "" })}</span>
              )}
            </div>
          </div>
          {machine && !machine.online && (
            <div className="mi-notes ac-iconline">
              <MachineIcon machineId={machine.id} />
              <span>{t("missions.new.offline", { name: machine.name })}</span>
            </div>
          )}
          <div className="mi-notes ac-iconline">
            <Icon name="bolt" size={14} />
            <span>
              {t("missions.new.commandHint")} <code className="mi-mono">{MISSION_COMMAND}</code>
            </span>
          </div>
          {error && (
            <p className="ac-field__error" role="alert">
              {error}
            </p>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter note={approvalsNote}>
        <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!goal.trim() || !agent || (home === "channel" && !channelId)}
          loading={create.isPending}
          onClick={() => void submit()}
        >
          {t("missions.new.start")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── Fechar a missão ───────────────────────────────────────────────────────────

export function CloseMissionDialog({
  mission,
  open,
  onOpenChange,
}: {
  mission: Mission;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const names = useNamesComputers(org.id);
  const dir = useDirectory(org.id);
  const toast = useToast();
  const close = useCloseMission(org.id);
  const [outcome, setOutcome] = useState<"done" | "canceled">("done");
  const [wiki, setWiki] = useState(true);
  // Canceling: keep the mission's branch (default) or delete it with the copy of the project (ADR 0044).
  const [branch, setBranch] = useState<"keep" | "delete">("keep");
  const wikiId = useId();
  const agent = dir.agentById.get(mission.agentId)?.name ?? "";
  const hasBranch = Boolean(mission.branch);
  const submit = () =>
    close.mutate(
      {
        missionId: mission.id,
        outcome,
        saveToWiki: wiki,
        ...(outcome === "canceled" && hasBranch ? { deleteBranch: branch === "delete" } : {}),
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.show(
            wiki
              ? t(`missions.close.toastWiki.${outcome}`, { name: agent, title: mission.title })
              : t(`missions.close.toast.${outcome}`),
          );
        },
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={520}
      title={t("missions.close.title")}
      description={t("missions.close.text", {
        title: mission.title,
        done: mission.plan.done,
        total: mission.plan.total,
      })}
      closeLabel={t("common.cancel")}
    >
      <Locked when={close.isPending}>
        <DialogBody>
          <RadioGroup
            value={outcome}
            onValueChange={setOutcome}
            aria-label={t("missions.close.outcome")}
            style={{ display: "grid", gap: 8 }}
          >
            <RadioCard
              value="done"
              id="mission-close-done"
              checked={outcome === "done"}
              title={t("missions.close.done")}
              description={t("missions.close.doneText")}
            />
            <RadioCard
              value="canceled"
              id="mission-close-canceled"
              checked={outcome === "canceled"}
              title={t("missions.close.canceled")}
              description={t("missions.close.canceledText")}
            />
          </RadioGroup>
          {outcome === "canceled" && hasBranch && (
            <RadioGroup
              value={branch}
              onValueChange={setBranch}
              aria-label={t("missions.close.branch")}
              style={{ display: "grid", gap: 8 }}
            >
              <RadioCard
                value="keep"
                id="mission-close-keep"
                checked={branch === "keep"}
                title={t("missions.close.keepBranch")}
                description={t("missions.close.keepBranchText", { branch: mission.branch })}
              />
              <RadioCard
                value="delete"
                id="mission-close-delete"
                checked={branch === "delete"}
                title={t("missions.close.deleteBranch")}
                description={t("missions.close.deleteBranchText", { branch: mission.branch })}
              />
            </RadioGroup>
          )}
          <div className="mi-optrow">
            <div>
              <label htmlFor={wikiId}>{t("missions.close.wiki")}</label>
              <small>{t("missions.close.wikiText", { name: agent, title: mission.title })}</small>
            </div>
            <Switch id={wikiId} checked={wiki} onCheckedChange={setWiki} />
          </div>
          {mission.runningTasks > 0 && (
            <div className="mi-notes ac-iconline">
              <Icon name="stop" size={14} />
              <span>
                {names
                  ? t("missions.close.running", {
                      count: mission.runningTasks,
                      computer: computerNameOf(t, org.name, mission.machine?.name ?? "", isPersonal(org)),
                    })
                  : t("missions.close.runningNoComputer", { count: mission.runningTasks })}
              </span>
            </div>
          )}
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={close.isPending} onClick={submit}>
          {outcome === "done" ? t("missions.close.confirmDone") : t("missions.close.confirmCanceled")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── Compartilhar ──────────────────────────────────────────────────────────────

export function ShareMissionDialog({
  mission,
  open,
  onOpenChange,
}: {
  mission: Mission;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const people = useMissionParticipants(org.id, mission.id, open);
  const [q, setQ] = useState("");
  const [role, setRole] = useState<MissionParticipantRole>("decide");
  const [handing, setHanding] = useState<{ userId: string; name: string } | null>(null);
  const [lend, setLend] = useState(true);
  const [busy, setBusy] = useState(false);
  const lendId = useId();
  const executor = executorName(mission.executor, dir.agentById.get(mission.agentId)?.name ?? "");
  const list = people.data;
  const taken = new Set([list?.owner?.userId, ...(list?.participants ?? []).map((p) => p.userId)].filter(Boolean));
  const query = q.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query
        ? dir.members
            .filter((m) => !taken.has(m.userId))
            .filter((m) => `${m.name} ${m.handle} ${m.email}`.toLowerCase().includes(query))
            .slice(0, 6)
        : [],
    [dir.members, query, taken],
  );
  const manage = mission.canManage;
  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      const out = await work();
      if (out && typeof out === "object" && "owner" in out) {
        qc.setQueryData(keys.missionPart(org.id, mission.id, "participants"), out);
      }
      refreshMission(qc, org.id, mission.id, ["participants"]);
      if (done) toast.show(done);
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setBusy(false);
    }
  };
  const roleOptions = [
    { value: "decide" as const, label: t("missions.share.decide") },
    { value: "comment" as const, label: t("missions.share.comment") },
  ];
  const handOver = async () => {
    const target = handing;
    if (!target) return;
    setBusy(true);
    try {
      const out = await api.missions.transfer(org.id, mission.id, {
        userId: target.userId,
        ...(mission.machine ? { lendMachine: lend } : {}),
      });
      cacheMission(qc, org.id, out);
      refreshMission(qc, org.id, mission.id);
      setHanding(null);
      onOpenChange(false);
      toast.show(
        out.code === "mission.needs_computer"
          ? t("missions.share.handedNeedsComputer", { name: target.name })
          : t("missions.share.handed", { name: target.name }),
      );
    } catch (error) {
      toast.show(errorText(t, error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open={open && !handing}
        onOpenChange={onOpenChange}
        title={t("missions.share.title")}
        description={t("missions.share.text")}
        closeLabel={t("common.close")}
        width={520}
      >
        <Locked when={busy}>
          <DialogBody>
            {manage && (
              <>
                <Toolbar
                  size="sm"
                  search={
                    <SearchField
                      size="sm"
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder={t("missions.share.search")}
                      aria-label={t("missions.share.search")}
                      onClear={() => setQ("")}
                      clearLabel={t("filters.clearSearch")}
                    />
                  }
                >
                  <Segmented
                    size="sm"
                    label={t("missions.share.newRole")}
                    value={role}
                    onValueChange={setRole}
                    options={roleOptions}
                  />
                </Toolbar>
                {matches.length > 0 && (
                  <ul className="mi-people" style={{ marginTop: 8 }}>
                    {matches.map((m) => (
                      <li key={m.userId} className="mi-person">
                        <ActorAvatar actor={{ type: "person", id: m.userId }} name={m.name} size="sm" />
                        <span className="mi-person__name">{m.name}</span>
                        <Button
                          size="sm"
                          icon="plus"
                          onClick={() =>
                            void run(
                              () => api.missions.setParticipant(org.id, mission.id, m.userId, role),
                              t("missions.share.added", { name: m.name }),
                            ).then(() => setQ(""))
                          }
                        >
                          {t("missions.share.add")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {query && matches.length === 0 && <p className="mi-hint">{t("missions.share.noMatch")}</p>}
              </>
            )}
            {mission.canAct && <JoinRequests mission={mission} enabled={open} />}
            <GroupHeading level={3} title={t("missions.share.who")} />
            <ul className="mi-people">
              {list?.owner && (
                <li className="mi-person">
                  <ActorAvatar actor={{ type: "person", id: list.owner.userId }} name={list.owner.name} size="sm" />
                  <span className="mi-person__name">
                    {list.owner.name}
                    {list.owner.userId === me.user.id && <small> · {t("missions.share.you")}</small>}
                  </span>
                  <span className="mi-hint">{t("missions.share.owner")}</span>
                </li>
              )}
              {(list?.participants ?? []).map((p) => (
                <li key={p.userId} className="mi-person">
                  <ActorAvatar actor={{ type: "person", id: p.userId }} name={p.name} size="sm" />
                  <span className="mi-person__name">
                    {p.name}
                    {p.userId === me.user.id && <small> · {t("missions.share.you")}</small>}
                  </span>
                  {manage ? (
                    <>
                      <div style={{ width: 150 }}>
                        <Select
                          size="sm"
                          aria-label={t("missions.share.roleOf", { name: p.name })}
                          value={p.role}
                          onValueChange={(v) =>
                            void run(() => api.missions.setParticipant(org.id, mission.id, p.userId, v, true))
                          }
                          options={roleOptions}
                        />
                      </div>
                      <Menu
                        align="end"
                        label={t("missions.share.more", { name: p.name })}
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon="more"
                            aria-label={t("missions.share.more", { name: p.name })}
                          />
                        }
                      >
                        {mission.role === "owner" && (
                          <MenuItem icon="arrowRight" onSelect={() => setHanding({ userId: p.userId, name: p.name })}>
                            {t("missions.share.handOver")}
                          </MenuItem>
                        )}
                        {mission.role === "owner" && <MenuSeparator />}
                        <MenuItem
                          icon="trash"
                          onSelect={() =>
                            void run(
                              () => api.missions.removeParticipant(org.id, mission.id, p.userId),
                              t("missions.share.removed", { name: p.name }),
                            )
                          }
                        >
                          {t("missions.share.remove")}
                        </MenuItem>
                      </Menu>
                    </>
                  ) : (
                    <span className="mi-hint">{t(`missions.share.${p.role}`)}</span>
                  )}
                </li>
              ))}
            </ul>
            {list && list.participants.length === 0 && <p className="mi-hint">{t("missions.share.onlyOwner")}</p>}
            <div className="mi-notes ac-iconline">
              <Icon name="lock" size={14} />
              <span>{t("missions.share.seeing")}</span>
            </div>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t("missions.share.done")}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={Boolean(handing)}
        onOpenChange={(o) => !o && setHanding(null)}
        width={480}
        title={t("missions.share.handTitle", { name: handing?.name ?? "" })}
        description={t("missions.share.handText", {
          executor,
          context: agentGrammar(executor).context,
          name: handing?.name ?? "",
        })}
        closeLabel={t("common.cancel")}
      >
        <Locked when={busy}>
          <DialogBody>
            {mission.machine && (
              <div className="mi-optrow">
                <div>
                  <label htmlFor={lendId}>
                    {t("missions.share.lend", {
                      computer: computerNameOf(t, org.name, mission.machine.name, isPersonal(org)),
                    })}
                  </label>
                  <small>{t("missions.share.lendText", { name: handing?.name ?? "" })}</small>
                </div>
                <Switch id={lendId} checked={lend} onCheckedChange={setLend} />
              </div>
            )}
            <div className="mi-notes ac-iconline">
              <Icon name="info" size={14} />
              <span>{t("missions.share.handNote")}</span>
            </div>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={() => setHanding(null)}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={() => void handOver()}>
            {t("missions.share.handConfirm", { name: handing?.name ?? "" })}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/** Requests to join, for the owner and those who decide: Aceitar (with a role) or Recusar. */
function JoinRequests({ mission, enabled }: { mission: Mission; enabled: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const requests = useMissionJoinRequests(org.id, mission.id, enabled && mission.pending.joinRequests > 0);
  const decide = useDecideJoin(org.id, mission.id);
  const [roles, setRoles] = useState<Record<string, MissionParticipantRole>>({});
  const list = (requests.data ?? []).filter((r) => r.status === "pending");
  if (list.length === 0) return null;
  const roleOptions = [
    { value: "decide" as const, label: t("missions.share.decide") },
    { value: "comment" as const, label: t("missions.share.comment") },
  ];
  const answer = (userId: string, name: string, outcome: "accept" | "decline") =>
    decide.mutate(
      { userId, outcome, role: roles[userId] ?? "comment" },
      {
        onSuccess: () =>
          toast.show(
            outcome === "accept" ? t("missions.join.accepted", { name }) : t("missions.join.declined", { name }),
          ),
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  return (
    <>
      <GroupHeading level={3} title={t("missions.join.title", { count: list.length })} />
      <ul className="mi-people">
        {list.map((r) => (
          <li key={r.id} className="mi-person">
            <ActorAvatar actor={{ type: "person", id: r.userId }} name={r.name} size="sm" />
            <span className="mi-person__name">{r.name}</span>
            <span className="mi-person__actions">
              <div style={{ width: 150 }}>
                <Locked when={decide.isPending}>
                  <Select
                    size="sm"
                    aria-label={t("missions.join.roleOf", { name: r.name })}
                    value={roles[r.userId] ?? "comment"}
                    onValueChange={(v) => setRoles((prev) => ({ ...prev, [r.userId]: v }))}
                    options={roleOptions}
                  />
                </Locked>
              </div>
              <Button
                size="sm"
                variant="primary"
                disabled={decide.isPending}
                onClick={() => answer(r.userId, r.name, "accept")}
              >
                {t("missions.join.accept")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={decide.isPending}
                onClick={() => answer(r.userId, r.name, "decline")}
              >
                {t("missions.join.decline")}
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

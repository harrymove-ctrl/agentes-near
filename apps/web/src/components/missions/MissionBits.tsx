import type {
  CommandApproval,
  Mission,
  MissionExecutor,
  MissionFileName,
  ThreadMissionSummary,
} from "@agenteschat/client";
import { engineOfExecutor } from "@agenteschat/client/lib/brain";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { executorOnText, type PlanCell, tickFor } from "@agenteschat/client/lib/missions";
import { Chip, type IconName, PlanStrip, ProviderLogo, Select } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { MachineIcon } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useNamesComputers } from "@/components/WorkspaceComputer";
import { useDirectory } from "@/hooks/useDirectory";
import { MissionFilesPanel } from "./MissionFiles";
import "./missions.css";

/**
 * Pieces every mission screen shares: the plan strip in the agent's tones,
 * the state chip (an icon and a word, never a dot), the computer chip, a
 * ticking clock, and the files panel any card can open.
 */

/**
 * Who programs, as a mark: Claude Code's and Codex's makers' marks, or the
 * agent's small pixel avatar when it does the work itself.
 */
export function ExecutorMark({
  executor,
  agentId,
  agentName,
}: {
  executor: string;
  agentId?: string;
  agentName?: string;
}) {
  const engine = engineOfExecutor(executor);
  if (engine !== "agent") return <ProviderLogo id={engine} size="xs" />;
  return <AgentAvatar agentId={agentId} name={agentName ?? ""} size="xs" />;
}

/**
 * "[mark] Claude Code no mac": who programs and where, one quiet chip (offline says so). The computer only where
 * the workspace has more than one (`useNamesComputers`): else "[mark] Claude Code".
 */
export function ExecutorChip({
  mission,
  agentName,
}: {
  mission: Pick<Mission, "executor" | "agentId" | "machine">;
  agentName: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const names = useNamesComputers(org.id);
  return (
    <span className="mi-pill mi-exec">
      <ExecutorMark executor={mission.executor} agentId={mission.agentId} agentName={agentName} />
      {executorOnText(t, mission.executor, agentName, names ? mission.machine?.name : null)}
      {mission.machine && !mission.machine.online && <small>{t("missions.offline")}</small>}
    </span>
  );
}

/**
 * "Quem programa": Claude Code, Codex or the agent itself,
 * only those its computer can run, each with one line on what it means and
 * its mark (`leading`).
 */
export function executorOptions(t: TFunction, executors: MissionExecutor[], agentName: string, agentId?: string) {
  const g = agentGrammar(agentName);
  return executors.map((e) => ({
    value: e,
    label: t(`missions.executor.${e}` as const, g),
    description: t(`missions.executor.${e}Text` as const, g),
    leading: <ExecutorMark executor={e} agentId={agentId} agentName={agentName} />,
  }));
}

/** Autonomia, from asking the most to asking nothing; the middle one is recommended. */
export const COMMAND_APPROVALS: readonly CommandApproval[] = ["always", "low_risk_auto", "never"];

export function commandApprovalOptions(t: TFunction) {
  return COMMAND_APPROVALS.map((v) => ({
    value: v,
    label: t(`missions.commandApproval.${v}` as const),
    description: t(`missions.commandApproval.${v}Text` as const),
  }));
}

/** The same choice in Nova missão and on the plan card: a select with one line on each option. */
export function CommandApprovalSelect({
  value,
  onChange,
  disabled,
  size,
}: {
  value: CommandApproval;
  onChange: (value: CommandApproval) => void;
  disabled?: boolean;
  size?: "sm";
}) {
  const { t } = useTranslation();
  return (
    <Select
      {...(size ? { size } : {})}
      aria-label={t("missions.commandApproval.label")}
      value={value}
      disabled={disabled}
      onValueChange={(v) => onChange(v as CommandApproval)}
      options={commandApprovalOptions(t)}
    />
  );
}

/** Re-renders every `ms` while `active` (live durations). */
export function useNow(active: boolean, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/** A clock for "há 58 s": every second at first, coarser as the time grows (`tickFor`). */
export function useElapsedNow(since: string | null | undefined, active: boolean) {
  const start = since ? Date.parse(since) : Number.NaN;
  const [now, setNow] = useState(() => Date.now());
  const ms = tickFor(Number.isFinite(start) ? (now - start) / 1000 : 0);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/** "4 de 12 itens" as pixels, in the mission agent's own tones; `titles` (the items') give each cell a tooltip. */
export function MissionStrip({
  cells,
  agentId,
  label,
  titles,
}: {
  cells: PlanCell[];
  agentId: string;
  label: string;
  titles?: string[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (cells.length === 0) return null;
  const hints = cells.map((cell, i) => {
    const status = t(`missions.strip.${cell}` as const);
    const title = titles?.[i];
    return title ? t("missions.strip.cell", { title, status }) : status;
  });
  return <PlanStrip cells={cells} color={colorOf(dir.agentById.get(agentId))} label={label} titles={hints} />;
}

export type MissionStatusKey =
  | "needsYou"
  | "proposed"
  | "working"
  | "active"
  | "paused"
  | "awaitingClose"
  | "readyToClose"
  | "done"
  | "canceled";

export function missionStatusKey(m: Pick<Mission, "status" | "runningTasks" | "pending" | "canAct">): MissionStatusKey {
  if (m.status === "done" || m.status === "canceled" || m.status === "proposed" || m.status === "paused") {
    return m.status;
  }
  // Everything done, nothing runs: on whoever concludes it (the others read "Pronta para concluir").
  if (m.status === "awaiting_close") return m.canAct ? "awaitingClose" : "readyToClose";
  const waiting = m.canAct && m.pending.decisions + m.pending.reviews + m.pending.provisional + m.pending.commands > 0;
  if (waiting) return "needsYou";
  return m.runningTasks > 0 ? "working" : "active";
}

/** The same state from a thread row's summary (`working`: an agent run in the thread). */
export function missionSummaryStatusKey(m: Pick<ThreadMissionSummary, "status" | "waitingYou">, working: boolean) {
  if (m.status === "done" || m.status === "canceled" || m.status === "proposed" || m.status === "paused") {
    return m.status;
  }
  if (m.status === "awaiting_close") return m.waitingYou > 0 ? "awaitingClose" : "readyToClose";
  if (m.waitingYou > 0) return "needsYou";
  return working ? "working" : "active";
}

const STATUS_ICON: Record<MissionStatusKey, IconName> = {
  needsYou: "waiting",
  proposed: "document",
  working: "spinner",
  active: "play",
  paused: "pause",
  awaitingClose: "flag",
  readyToClose: "flag",
  done: "check",
  canceled: "close",
};

export function MissionStatusChip({
  mission,
  status,
  agentId,
}: {
  mission?: Pick<Mission, "status" | "runningTasks" | "pending" | "canAct" | "agentId">;
  /** A state already known (a thread row's summary). */
  status?: MissionStatusKey;
  /** Whose work it is ("Trabalhando" in that agent's tones); the mission's agent by default. */
  agentId?: string;
}) {
  const { t } = useTranslation();
  const key = status ?? (mission ? missionStatusKey(mission) : "active");
  const who = agentId ?? mission?.agentId;
  return (
    <Chip
      icon={STATUS_ICON[key]}
      lead={key === "working" && who ? <AgentSpinner agentId={who} /> : undefined}
      tone={key === "needsYou" || key === "awaitingClose" ? "waiting" : "neutral"}
    >
      {t(`missions.status.${key}`)}
    </Chip>
  );
}

/**
 * A mission card's header (the Missões tab, the link card in a conversation):
 * the agent's avatar | the title and, on the same left edge right under it,
 * one quiet meta line; `right` (the status chip, a menu) at the end.
 */
export function MissionHead({
  agentId,
  agentName,
  title,
  meta,
  right,
  running,
}: {
  agentId: string;
  agentName: string;
  /** The title (a link, or plain text). */
  title: ReactNode;
  /** The meta line's parts, joined by a quiet "·". */
  meta: ReactNode[];
  right?: ReactNode;
  running?: boolean;
}) {
  const parts = meta.filter(Boolean);
  return (
    <div className="mi-head ac-mediarow">
      <span className="ac-mediarow__face">
        <AgentAvatar agentId={agentId} name={agentName} size="md" running={running} />
      </span>
      <div className="ac-mediarow__head mi-head__t">
        <h3>{title}</h3>
      </div>
      {right && <div className="mi-head__r ac-mediarow__end ac-mediarow__end--wrap">{right}</div>}
      <div className="ac-mediarow__body">
        {parts.length > 0 && (
          <p className="mi-head__meta">
            {parts.map((part, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed parts in a fixed order
              <span key={i} className="mi-head__part">
                {i > 0 && (
                  <span className="mi-head__dot" aria-hidden="true">
                    ·
                  </span>
                )}
                {part}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

/** "MacBook do Walter · online": neutral (no green), the word says it. */
export function MachineChip({ machine }: { machine: Mission["machine"] }) {
  const { t } = useTranslation();
  return (
    <span className="mi-pill">
      <MachineIcon machineId={machine?.id} />
      {machine ? machine.name : t("missions.noComputer")}
      {machine && <small>{machine.online ? t("missions.online") : t("missions.offline")}</small>}
    </span>
  );
}

// ── The files panel, from any card ────────────────────────────────────────────

interface PanelApi {
  openFiles: (missionId: string, tab?: MissionFileName, options?: { diff?: boolean }) => void;
}
const PanelContext = createContext<PanelApi | null>(null);

/** Wraps a conversation: "Arquivos", "Ver plano", "Ver no arquivo" open the same panel. */
export function MissionPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ missionId: string; tab: MissionFileName; diff: boolean } | null>(null);
  const api: PanelApi = {
    openFiles: (missionId, tab = "mission.md", options = {}) =>
      setOpen({ missionId, tab, diff: Boolean(options.diff) }),
  };
  return (
    <PanelContext.Provider value={api}>
      {children}
      {open && (
        <MissionFilesPanel
          missionId={open.missionId}
          tab={open.tab}
          diff={open.diff}
          onTab={(tab) => setOpen((o) => (o ? { ...o, tab, diff: false } : o))}
          onClose={() => setOpen(null)}
        />
      )}
    </PanelContext.Provider>
  );
}

export const useMissionPanel = () => useContext(PanelContext);

import type { TFunction } from "i18next";
import type { ComputerBrain, MachineOutage, MachineOutages, OutageAgent, OutageTarget } from "../api/types";
import { joinNames } from "./format";

/**
 * "Computador desconectado": who waits for an offline computer, where
 * they could move, and the agent's waiting note in the chat. Platform-neutral (web and phone).
 */

/** The brain's product name (never translated). */
export const brainName = (brain: string | null | undefined) =>
  brain === "codex"
    ? "Codex"
    : brain === "cursor"
      ? "Cursor"
      : brain === "opencode"
        ? "OpenCode"
        : brain === "grok"
          ? "Grok Build"
          : brain === "antigravity"
            ? "Antigravity CLI"
            : "Claude Code";

/** `meta.brainUnavailable` of an agent's notice ("the computer brain can't answer; I'll answer when it's back"). */
export interface BrainUnavailable {
  brain: ComputerBrain;
  code: string | null;
  machineId: string | null;
  agentId: string | null;
  resetsAt: string | null;
}

/** Codes that mean the computer itself is gone (not paused or a tool turned off): the waiting card. */
const OFFLINE_CODES = new Set(["machine_offline", "no_session", "no_computer", "offline"]);

/** The notice in a message's meta, when it is one (`meta.bodyCode = "brain_unavailable"`). */
export function brainUnavailableOf(meta: Record<string, unknown> | null | undefined): BrainUnavailable | null {
  if (meta?.bodyCode !== "brain_unavailable") return null;
  const raw = meta.brainUnavailable;
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const params =
    meta.bodyParams && typeof meta.bodyParams === "object" ? (meta.bodyParams as Record<string, unknown>) : {};
  const brain =
    o.brain === "codex" || params.brain === "Codex"
      ? "codex"
      : o.brain === "cursor" || params.brain === "Cursor"
        ? "cursor"
        : o.brain === "opencode" || params.brain === "OpenCode"
          ? "opencode"
          : o.brain === "grok" || params.brain === "Grok Build"
            ? "grok"
            : o.brain === "antigravity" || params.brain === "Antigravity CLI"
              ? "antigravity"
              : "claude_code";
  return {
    brain,
    code: str(o.code),
    machineId: str(o.machineId),
    agentId: str(o.agentId),
    resetsAt: str(o.resetsAt),
  };
}

/** The notice is about the computer being offline (the card), not a pause or a tool turned off. */
export const isOfflineNotice = (n: BrainUnavailable) => n.code === null || OFFLINE_CODES.has(n.code);

/** The outage an agent waits in (by machine when the notice names it). */
export function outageOf(
  data: MachineOutages | undefined,
  agentId: string | null | undefined,
  machineId?: string | null,
): MachineOutage | undefined {
  if (!data) return undefined;
  if (machineId) return data.outages.find((o) => o.machineId === machineId);
  if (!agentId) return undefined;
  return data.outages.find((o) => o.agents.some((a) => a.agentId === agentId));
}

/** Agents (ids) waiting for any offline computer → that computer's name. */
export function waitingAgents(data: MachineOutages | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of data?.outages ?? []) for (const a of o.agents) if (!out.has(a.agentId)) out.set(a.agentId, o.name);
  return out;
}

/** The brains an outage's agents need (a target must have all the chosen agents' ones). */
export const brainsOf = (agents: Pick<OutageAgent, "brain">[]) => [...new Set(agents.map((a) => a.brain))];

/** Why a target can't take these agents now, or null when it can. */
export function targetBlock(target: OutageTarget, brains: ComputerBrain[]): "offline" | "noBrain" | "reason" | null {
  if (!target.online || target.reasonOff === "offline") return "offline";
  if (target.reasonOff) return "reason";
  return brains.every((b) => target.brains.includes(b)) ? null : "noBrain";
}

/** The targets offered for an outage: every computer but the offline one itself. */
export const targetsFor = (data: MachineOutages | undefined, machineId: string) =>
  (data?.targets ?? []).filter((x) => x.machineId !== machineId);

/** "2 rotinas e 1 conversa esperando"; null when nothing waits. */
export function waitingText(t: TFunction, waiting: OutageAgent["waiting"]): string | null {
  const parts = [
    waiting.routines > 0 ? t("outage.count.routines", { count: waiting.routines }) : null,
    waiting.conversations > 0 ? t("outage.count.conversations", { count: waiting.conversations }) : null,
  ].filter((x): x is string => Boolean(x));
  if (parts.length === 0) return null;
  return t("outage.count.waiting", { what: joinNames(parts, t) });
}

/** The key that keeps one outage's notice dismissed until that computer comes back (a new outage shows again). */
export const outageKey = (o: Pick<MachineOutage, "machineId" | "offlineSince">) => `${o.machineId}@${o.offlineSince}`;

import { DESKTOP_USE_PROTOCOL } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import type { MachineCaller } from "../machine-hub";
import { REMOVED_COMPUTER_MESSAGE } from "../machines";

/** Why the agent can't use its desktop, as a code (for the app) and a sentence (for the agent). */
export type DesktopUseUnavailable =
  | "no_machine"
  | "machine_removed"
  | "outdated"
  | "switched_off"
  | "commands_off"
  | "not_ready"
  | "not_reported";

export type AgentDesktopUseStatus =
  | { available: true; machineId: string; machineName: string; online: boolean }
  | {
      available: false;
      code: DesktopUseUnavailable;
      machineId: string | null;
      machineName: string | null;
      /** The runner's own reason ("Install what desktop use needs: …"). */
      detail: string | null;
    };

/**
 * Whether the agent may use its desktop on its own computer (ADR 0062 §3): a
 * connected machine on protocol 21 or later, its desktop and commands
 * switches on (driving a desktop runs commands) and its runner able to serve
 * it (`hello.desktopUse`: Linux, the agents' desktops, each agent its own OS
 * user, the packages). Offline machines still count: the call says it's
 * offline, as other tools do.
 */
export async function agentDesktopUseStatus(
  db: Database,
  hub: Pick<MachineCaller, "status"> | undefined,
  orgId: string,
  agentId: string,
): Promise<AgentDesktopUseStatus> {
  const none = (code: DesktopUseUnavailable, machineId: string | null = null, machineName: string | null = null) => ({
    available: false as const,
    code,
    machineId,
    machineName,
    detail: null,
  });
  const agent = await getAgentCached(db, orgId, agentId);
  const machineId = agent?.machineId ?? null;
  if (!machineId || !hub) return none("no_machine");
  const status = await hub.status(machineId);
  if (!status || status.orgId !== orgId) return none("machine_removed", machineId);
  if (status.protocol < DESKTOP_USE_PROTOCOL) return none("outdated", machineId, status.name);
  if (!status.access?.tools.desktop) return none("switched_off", machineId, status.name);
  if (!status.access.tools.commands) return none("commands_off", machineId, status.name);
  const info = status.executors.desktopUse;
  if (!info) return none("not_reported", machineId, status.name);
  if (!info.available) {
    return { ...none("not_ready", machineId, status.name), detail: info.reason?.slice(0, 500) ?? null };
  }
  return { available: true, machineId, machineName: status.name, online: status.online };
}

/** One sentence for the agent (tool errors) about a desktop it can't use. */
export function desktopUseUnavailableText(s: Extract<AgentDesktopUseStatus, { available: false }>) {
  const on = s.machineName ? `the computer ${s.machineName}` : "your computer";
  switch (s.code) {
    case "no_machine":
      return "Your desktop only runs on a connected computer, and you don't use one. Ask your owner or an admin to choose one for you.";
    case "machine_removed":
      return REMOVED_COMPUTER_MESSAGE;
    case "outdated":
      return `The runner on ${on} is too old for using your desktop. Tell the person: its owner should update it.`;
    case "switched_off":
      return `The desktop is turned off on ${on}. Only the person at that computer can turn it on; tell the people.`;
    case "commands_off":
      return `Commands are turned off on ${on}, and using your desktop runs them. Only the person at that computer can turn them on; tell the people.`;
    case "not_ready":
      return `Your desktop can't be used on ${on}${s.detail ? `: ${s.detail}` : ""}. Tell the person.`;
    default:
      return `${on.charAt(0).toUpperCase()}${on.slice(1)} hasn't said whether it can serve your desktop yet; try again after it reconnects.`;
  }
}

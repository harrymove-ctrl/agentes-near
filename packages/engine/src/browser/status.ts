import { BROWSER_PROTOCOL } from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import type { MachineCaller, MachineStatus } from "../machine-hub";
import { REMOVED_COMPUTER_MESSAGE } from "../machines";

/** Why the agent's browser isn't usable, as a code (for the app) and a sentence (for the agent). */
export type BrowserUnavailable =
  | "no_machine"
  | "machine_removed"
  | "outdated"
  | "switched_off"
  | "not_installed"
  | "not_reported";

export type AgentBrowserStatus =
  | {
      available: true;
      machineId: string;
      machineName: string;
      online: boolean;
      /** The runner's protocol (17 and later: batched commands and images, ADR 0054). */
      protocol: number;
      kind: MachineStatus["kind"];
    }
  | {
      available: false;
      code: BrowserUnavailable;
      machineId: string | null;
      machineName: string | null;
      /** The runner's own reason ("Chrome's libraries are missing: run …"). */
      detail: string | null;
    };

/**
 * Whether an agent's browser can be offered (ADR 0040 §3): its computer is a
 * connected machine on protocol 12 or later, the person turned the browser
 * on there (`access.tools.browser`) and the runner found it ready
 * (`hello.browser.available`, kept with the machine's executors). Offline
 * machines still count: the call says it's offline, as other tools do.
 */
export async function agentBrowserStatus(
  db: Database,
  hub: Pick<MachineCaller, "status"> | undefined,
  orgId: string,
  agentId: string,
  /** In a mission's thread: the mission's computer (ADR 0029). */
  machineOverride?: string | null,
): Promise<AgentBrowserStatus> {
  const none = (code: BrowserUnavailable, machineId: string | null = null, machineName: string | null = null) => ({
    available: false as const,
    code,
    machineId,
    machineName,
    detail: null,
  });
  const agent = await getAgentCached(db, orgId, agentId);
  const machineId = machineOverride ?? agent?.machineId ?? null;
  if (!machineId || !hub) return none("no_machine");
  const status = await hub.status(machineId);
  if (!status || status.orgId !== orgId) return none("machine_removed", machineId);
  if (status.protocol < BROWSER_PROTOCOL) return none("outdated", machineId, status.name);
  if (!status.access?.tools.browser) return none("switched_off", machineId, status.name);
  const info = status.executors.browser;
  if (!info) return none("not_reported", machineId, status.name);
  if (!info.available) {
    return { ...none("not_installed", machineId, status.name), detail: info.reason?.slice(0, 500) ?? null };
  }
  return {
    available: true,
    machineId,
    machineName: status.name,
    online: status.online,
    protocol: status.protocol,
    kind: status.kind,
  };
}

/** One sentence for the agent (tool errors) about an unavailable browser. */
export function browserUnavailableText(s: Extract<AgentBrowserStatus, { available: false }>) {
  const on = s.machineName ? `the computer ${s.machineName}` : "your computer";
  switch (s.code) {
    case "no_machine":
      return "The browser only runs on a connected computer, and you don't use one. Ask your owner or an admin to choose one for you.";
    case "machine_removed":
      return REMOVED_COMPUTER_MESSAGE;
    case "outdated":
      return `The runner on ${on} is out of date and has no browser. Tell the person: its owner should update it.`;
    case "switched_off":
      return `The browser is turned off on ${on}. Only the person at that computer can turn it on; tell the people.`;
    case "not_installed":
      return `The browser isn't ready on ${on}${s.detail ? `: ${s.detail}` : ""}. Tell the person.`;
    default:
      return `${on.charAt(0).toUpperCase()}${on.slice(1)} hasn't said whether it can run the browser yet; try again after it reconnects.`;
  }
}

import {
  ApiError,
  isOpenHandoff,
  keys,
  type LiveRun,
  useAgentAccess,
  useAgentBrowserSettings,
  useApi,
  useComputerSetup,
  useDesktopStatus,
  useMachines,
  useWorkingRuns,
} from "@agenteschat/client";
import type { AgentComputerFacts } from "@agenteschat/client/lib/agent-computer";
import { computerEdition, setupView } from "@agenteschat/client/lib/computer";
import { useQuery } from "@tanstack/react-query";
import { useOrg } from "@/providers/org";
import { browserGranted } from "../browser/logic";
import { useChatLive } from "../chat/live";
import { useMeId, useOrgId } from "../shared/hooks";
import { useActiveWork } from "../shared/queries";

/** Outside the agent's conversations no event says when its request changes: it's asked again this often. */
const HANDOFF_POLL_MS = 30_000;

/**
 * What the entry and the full-screen view know of an agent's computer, as on the web: the edition (from the
 * workspace's computer setup), its screen as this person may see it (`GET …/desktop`: a 403 means they may not
 * watch it, and see no entry), its computer, browser, open request and whether it works now. `poll`: how often
 * the screen's state is asked again.
 */
export function useAgentComputer(agentId: string, poll: number | false = false) {
  const orgId = useOrgId();
  const meId = useMeId();
  const { org } = useOrg();
  const api = useApi();
  const setupQ = useComputerSetup(orgId);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const desktopQ = useDesktopStatus(orgId, agentId, { poll });
  const forbidden = desktopQ.error instanceof ApiError && desktopQ.error.status === 403;
  const watches = desktopQ.isSuccess;
  const machines = useMachines(orgId);
  const machine = machines.data?.find((m) => m.agents.some((a) => a.id === agentId)) ?? null;
  const browserQ = useAgentBrowserSettings(orgId, agentId, watches);
  const access = useAgentAccess(orgId, agentId, watches);
  const handoffQ = useQuery({
    queryKey: keys.agentBrowserHandoff(orgId, agentId),
    queryFn: () => api.browser.agentHandoff(orgId, agentId),
    enabled: watches,
    retry: false,
    refetchInterval: HANDOFF_POLL_MS,
  });
  // A run going now, as the web says it: an active mission between its runs isn't at work on the computer.
  const working = (useWorkingRuns(orgId).data ?? []).some((r) => r.agentId === agentId && r.status === "running");
  const desktop = desktopQ.data ?? null;
  const browserOpen = handoffQ.data && isOpenHandoff(handoffQ.data) ? handoffQ.data : null;
  // The screen's own request or take over, or the browser's when its window is on the screen.
  const screenOpen = desktop?.handoff && isOpenHandoff(desktop.handoff) ? desktop.handoff : null;
  const facts: AgentComputerFacts | null =
    edition && meId
      ? {
          edition,
          held: desktop?.held === true || org?.standing?.state === "hold",
          setup,
          machine,
          desktop,
          browser: browserQ.data?.available === true,
          browserReason: browserQ.data?.reason ?? null,
          browserGranted: browserGranted(access.data),
          handoff: browserOpen ?? screenOpen,
          userId: meId,
          working,
        }
      : null;
  return {
    facts,
    setup,
    machine,
    desktopQ,
    /** This person may not watch the agent's computer. */
    forbidden,
    /** Known enough to say something: the edition, and whether this person may watch. */
    ready: facts !== null && (watches || forbidden || desktopQ.isError),
  };
}

export type AgentComputerView = ReturnType<typeof useAgentComputer>;

/**
 * The agent's run at work now, heard live in its conversation while the view is open: its steps, and whether
 * the latest was on its screen, outside its browser. Null while it works nowhere this person is.
 */
export function useAgentRun(agentId: string): LiveRun | null {
  const orgId = useOrgId();
  const where = useActiveWork().find((w) => w.agentId === agentId);
  const live = useChatLive(orgId, where?.channelId ?? "", Boolean(where));
  return live.runs.filter((r) => r.agentId === agentId).at(-1) ?? null;
}

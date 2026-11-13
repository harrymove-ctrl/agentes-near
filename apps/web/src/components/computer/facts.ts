import type { Agent, LiveRun } from "@agenteschat/client";
import {
  ApiError,
  agentStateOfRun,
  BROWSER_TOOL_SCOPE,
  isOpenHandoff,
  keys,
  screenSteps,
  useAgentBrowserSettings,
  useApi,
  useComputerSetup,
  useDesktopStatus,
  useMachines,
  usesScreen,
} from "@agenteschat/client";
import { type AgentComputerFacts, entryState } from "@agenteschat/client/lib/agent-computer";
import { computerEdition, setupView } from "@agenteschat/client/lib/computer";
import { can } from "@agenteschat/client/lib/permissions";
import { useQuery } from "@tanstack/react-query";
import { useOrg } from "@/components/org-context";
import { useStreams } from "@/realtime/context";

/** Outside the agent's conversations no event says when its request changes: it's asked again this often. */
const HANDOFF_POLL_MS = 30_000;
/** Nor when it starts or ends a run elsewhere: whether one is going is asked again this often. */
const RUNNING_POLL_MS = 30_000;

/** The agent's run at work on its computer now, among the conversations this tab listens to. */
function useScreenRun(agentId: string): LiveRun | undefined {
  const runId = useStreams(
    (s) =>
      Object.values(s.runs).find((r) => r.agentId === agentId && agentStateOfRun(r) !== "idle" && usesScreen(r))
        ?.runId ?? "",
  );
  return useStreams((s) => (runId ? s.runs[runId] : undefined));
}

/**
 * What the entry, the DM's button and the dialog know of an agent's computer: the edition (from the
 * workspace's computer setup), its screen as this person may see it (`GET …/desktop`: a 403 means they may
 * not watch it, and see no entry), its computer, browser, open request and live work. `poll`: how often the
 * screen's state is asked again; `runs`: also ask whether the agent has a run going (its runs list, which
 * admins and its owner may read).
 */
export function useAgentComputer(
  agent: Pick<Agent, "id" | "ownerUserId">,
  options: { poll?: number | false; runs?: boolean } = {},
) {
  const { org, me } = useOrg();
  const api = useApi();
  const setupQ = useComputerSetup(org.id);
  const edition = computerEdition(setupQ.data);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const desktopQ = useDesktopStatus(org.id, agent.id, { poll: options.poll });
  const forbidden = desktopQ.error instanceof ApiError && desktopQ.error.status === 403;
  const watches = desktopQ.isSuccess;
  const machines = useMachines(org.id);
  const machine = machines.data?.find((m) => m.agents.some((a) => a.id === agent.id)) ?? null;
  const browserQ = useAgentBrowserSettings(org.id, agent.id, watches);
  const scopesQ = useQuery({
    queryKey: keys.scopes(org.id, agent.id),
    queryFn: () => api.scopes.get(org.id, agent.id),
    enabled: watches,
    retry: false,
  });
  const handoffQ = useQuery({
    queryKey: keys.agentBrowserHandoff(org.id, agent.id),
    queryFn: () => api.browser.agentHandoff(org.id, agent.id),
    enabled: watches,
    retry: false,
    refetchInterval: HANDOFF_POLL_MS,
  });
  const readsRuns = can(org, "view_usage") || agent.ownerUserId === me.user.id;
  const runningQ = useQuery({
    queryKey: keys.runningRuns(org.id, agent.id),
    queryFn: () => api.agents.runs(org.id, { agentId: agent.id, status: "running", limit: 1 }),
    enabled: watches && options.runs === true && readsRuns,
    retry: false,
    refetchInterval: RUNNING_POLL_MS,
  });
  const run = useScreenRun(agent.id);
  const desktop = desktopQ.data ?? null;
  const browserOpen = handoffQ.data && isOpenHandoff(handoffQ.data) ? handoffQ.data : null;
  // The screen's own request or take over, or the browser's when its window is on the screen.
  const screenOpen = desktop?.handoff && isOpenHandoff(desktop.handoff) ? desktop.handoff : null;
  const facts: AgentComputerFacts | null = edition
    ? {
        edition,
        held: desktop?.held === true || org.standing?.state === "hold",
        setup,
        machine,
        desktop,
        browser: browserQ.data?.available === true,
        browserReason: browserQ.data?.reason ?? null,
        browserGranted: (scopesQ.data ?? []).some((s) => s.connectionId === null && s.scope === BROWSER_TOOL_SCOPE),
        handoff: browserOpen ?? screenOpen,
        userId: me.user.id,
        working: Boolean(run) || (runningQ.data?.length ?? 0) > 0,
      }
    : null;
  return {
    facts,
    edition,
    setup,
    desktop,
    desktopQ,
    /** This person may not watch the agent's computer. */
    forbidden,
    machine,
    browserSettings: browserQ.data ?? null,
    run,
    steps: screenSteps(run?.work),
    /** Known enough to say something: the edition, and whether this person may watch. */
    ready: facts !== null && (watches || forbidden || desktopQ.isError),
  };
}

export type AgentComputerView = ReturnType<typeof useAgentComputer>;

/**
 * Whether this person may open the agent's computer from a shortcut (its card): they may watch it and it has one. A
 * self-hosted agent with no computer yet has nothing to open there (its page offers to pick one).
 */
export function useOpensComputer(agent: Pick<Agent, "id" | "ownerUserId">): boolean {
  const view = useAgentComputer(agent);
  const f = view.facts;
  return Boolean(view.ready && !view.forbidden && f && entryState(f).kind !== "noComputer");
}

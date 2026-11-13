import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";
import { keys } from "../api/keys";
import type {
  Agent,
  AgentComputer,
  ChannelEvent,
  ComputerSetup,
  ComputerTarget,
  Machine,
  MachineAccess,
  MachinePause,
  Me,
  Member,
  OrgDeletion,
  OrgStanding,
} from "../api/types";
import { pacer } from "../lib/pace";
import { isWorkspaceMode } from "../lib/workspace-mode";

const MACHINE_EVENTS = new Set([
  "machine.status",
  "machine.paired",
  "machine.updated",
  "machine.state",
  "machine.access",
  "machine.deleted",
  "machine.agents_moved",
  "computer.queue",
  "devices.changed",
]);
const isMachineEvent = (type: string) => MACHINE_EVENTS.has(type);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * A pause state from an event: the server's `{ until }` (paused) or `null` (not paused); `{ paused: false }`
 * is understood too. Undefined when the event says nothing about it.
 */
export function pauseOf(v: unknown): MachinePause | undefined {
  if (v === null) return { paused: false };
  if (!isObject(v)) return undefined;
  if (v.paused === false) return { paused: false };
  const by =
    isObject(v.by) && typeof v.by.id === "string" && typeof v.by.name === "string"
      ? { id: v.by.id, name: v.by.name }
      : null;
  return { paused: true, until: typeof v.until === "string" ? v.until : null, ...(by ? { by } : {}) };
}

/** Access from an event (`{ folders, tools }`), checked; `null` when the machine stopped reporting it. */
export function accessOf(v: unknown): MachineAccess | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || !Array.isArray(v.folders) || !isObject(v.tools)) return undefined;
  const t = v.tools;
  return {
    folders: v.folders.flatMap((f) =>
      isObject(f) && typeof f.path === "string" && f.path
        ? [{ path: f.path, agents: Array.isArray(f.agents) ? f.agents.filter((a) => typeof a === "string") : [] }]
        : [],
    ),
    tools: {
      claude: t.claude === true,
      codex: t.codex === true,
      ...(typeof t.cursor === "boolean" ? { cursor: t.cursor } : {}),
      commands: t.commands === true,
      ...(t.browser === true ? { browser: true } : {}),
    },
  };
}

/** Every cached agent computer view whose target is this machine gets `patch`. */
function patchTargets(
  qc: QueryClient,
  orgId: string,
  machineId: string,
  patch: Partial<{ name: string; online: boolean }>,
) {
  qc.setQueriesData<AgentComputer>({ queryKey: keys.computers(orgId) }, (old) =>
    old?.target?.kind === "machine" && old.target.machineId === machineId
      ? { ...old, target: { ...old.target, ...patch } }
      : old,
  );
}

/**
 * Org events about connected computers (ADR 0025): the machines list and
 * the agents' computer views follow without a refetch where they can.
 * Returns whether the event was one of these.
 */
export function applyMachineEvent(qc: QueryClient, orgId: string, event: { type: string }): boolean {
  if (!isMachineEvent(event.type)) return false;
  // The devices list (`devices.changed`, and every computer's state, pause or name in it) is read again.
  void qc.invalidateQueries({ queryKey: keys.devices(orgId) });
  const e = event as {
    type: string;
    machineId?: unknown;
    online?: unknown;
    name?: unknown;
    paused?: unknown;
    access?: unknown;
    accounts?: unknown;
    executors?: unknown;
    egress?: unknown;
    networkTransition?: unknown;
  };
  if (typeof e.machineId !== "string") return true;
  const machineId = e.machineId;
  if (e.type === "computer.queue") {
    void qc.invalidateQueries({ queryKey: keys.machineQueue(orgId, machineId) });
    return true;
  }
  const list = keys.machines(orgId);
  // Who waits for an offline computer changes when one comes back, goes away or its agents move.
  if (e.type === "machine.status" || e.type === "machine.deleted" || e.type === "machine.agents_moved") {
    void qc.invalidateQueries({ queryKey: keys.machineOutages(orgId) });
  }
  // Whether agents can use their browser (ADR 0040) and what can think for them follow the computer: its
  // switches (the app's Ferramentas: `machine.updated` with `access`), a reconnect, a move. No reload needed.
  // ADR 0041: an account added, removed or signed out on the computer (`machine.updated` with `accounts`). The CLIs it
  // found since it connected (`executors`, protocol 41): a plan whose program was being installed signs in now.
  const accounts = e.type === "machine.updated" && e.accounts !== undefined;
  const executors = e.type === "machine.updated" && e.executors !== undefined;
  if ((e.type !== "machine.state" && e.type !== "machine.updated") || e.access !== undefined || accounts || executors) {
    void qc.invalidateQueries({ queryKey: keys.browser(orgId) });
    // The agents' screens too: a browser card on one goes back to its frames at once (ADR 0058 §7). Their states
    // only: each picture asked again is a capture on a computer.
    void qc.invalidateQueries({
      queryKey: keys.agentDesktops(orgId),
      predicate: (q) => q.queryKey.length === keys.agentDesktop(orgId, "").length,
    });
    void qc.invalidateQueries({ predicate: (q) => isAgentBrainKey(q.queryKey, orgId) });
    void qc.invalidateQueries({ queryKey: keys.aiAccounts(orgId) });
    void qc.invalidateQueries({ queryKey: keys.planUsage(orgId) });
  }
  // The agent list carries each plan's limits (ADR 0063 §5), and the server says only when they would show otherwise.
  if (accounts) void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
  switch (e.type) {
    case "machine.status": {
      const online = e.online === true;
      const now = new Date().toISOString();
      qc.setQueryData<Machine[]>(list, (old) =>
        old?.map((m) =>
          m.id === machineId ? { ...m, online, egress: null, lastSeenAt: online ? now : m.lastSeenAt } : m,
        ),
      );
      patchTargets(qc, orgId, machineId, { online });
      // A machine we don't know yet (paired in another tab): fetch it.
      if (!qc.getQueryData<Machine[]>(list)?.some((m) => m.id === machineId)) {
        void qc.invalidateQueries({ queryKey: list });
      }
      break;
    }
    case "machine.paired":
      void qc.invalidateQueries({ queryKey: list });
      break;
    case "machine.updated":
    case "machine.state":
    case "machine.access": {
      // A rename, a pause on the machine, or what it allows now (ADR 0036): patch what came, refetch otherwise.
      const patch: Partial<Machine> = {};
      if (e.networkTransition === null) patch.networkTransition = null;
      else if (
        isObject(e.networkTransition) &&
        (e.networkTransition.state === "draining" || e.networkTransition.state === "restart_required") &&
        typeof e.networkTransition.deadline === "string" &&
        Number.isFinite(Date.parse(e.networkTransition.deadline)) &&
        Array.isArray(e.networkTransition.agents) &&
        e.networkTransition.agents.every((id) => typeof id === "string")
      ) {
        patch.networkTransition = e.networkTransition as NonNullable<Machine["networkTransition"]>;
      }
      if (e.egress === null) patch.egress = null;
      else if (
        isObject(e.egress) &&
        typeof e.egress.ip === "string" &&
        e.egress.ip.length <= 45 &&
        /^[0-9a-f:.]+$/i.test(e.egress.ip) &&
        typeof e.egress.at === "string" &&
        Number.isFinite(Date.parse(e.egress.at))
      ) {
        patch.egress = {
          ip: e.egress.ip,
          at: e.egress.at,
          ...(typeof e.egress.country === "string" && /^[A-Z]{2}$/.test(e.egress.country)
            ? { country: e.egress.country }
            : {}),
        };
      }
      if (typeof e.name === "string") patch.name = e.name;
      const paused = pauseOf(e.paused);
      if (paused) patch.paused = paused;
      const access = accessOf(e.access);
      if (access !== undefined) patch.access = access;
      if (Object.keys(patch).length > 0) {
        qc.setQueryData<Machine[]>(list, (old) =>
          old?.map((m) =>
            m.id === machineId
              ? { ...m, ...patch, ...(m.kind !== "managed" ? { egress: null, networkTransition: null } : {}) }
              : m,
          ),
        );
        if (patch.name) patchTargets(qc, orgId, machineId, { name: patch.name });
      }
      // Nothing to patch, or `access: true` (it changed, and who may see it differs per person): refetch.
      if (Object.keys(patch).length === 0 || e.access === true) void qc.invalidateQueries({ queryKey: list });
      break;
    }
    case "machine.agents_moved":
      void qc.invalidateQueries({ queryKey: list });
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
      break;
    case "machine.deleted":
      qc.setQueryData<Machine[]>(list, (old) => old?.filter((m) => m.id !== machineId));
      // Its agents are left with no computer (`agent.computer` events follow; refetch anyway).
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
      // The server's own computer, stopped here, offers to come back.
      void qc.invalidateQueries({ queryKey: keys.hostComputer(orgId) });
      break;
  }
  return true;
}

/** `keys.agentBrain(orgId, *)`: "Quem pensa" of any agent of the org. */
const isAgentBrainKey = (key: readonly unknown[], orgId: string) =>
  key[0] === "org" && key[1] === orgId && key[2] === "agent" && key[4] === "brain";

/**
 * `agent.computer`: someone switched the agent's computer, or its computer was removed. The cached view takes the
 * new target, and what depends on the computer is asked again.
 */
export function applyComputerEvent(qc: QueryClient, orgId: string, event: { type: string }) {
  const e = event as { agentId?: unknown; target?: ComputerTarget };
  if (event.type !== "agent.computer" || typeof e.agentId !== "string") return;
  const key = keys.computer(orgId, e.agentId);
  if (e.target && typeof e.target.kind === "string") {
    const target = e.target;
    qc.setQueryData<AgentComputer>(key, (old) => (old ? { ...old, target } : old));
    void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
  }
  void qc.invalidateQueries({ queryKey: key });
  // A new computer changes what can think and whether the browser is there.
  void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, e.agentId) });
  void qc.invalidateQueries({ queryKey: keys.agentBrowser(orgId, e.agentId) });
  void qc.invalidateQueries({ queryKey: keys.agentDesktop(orgId, e.agentId), exact: true });
}

const SETUP_FIELDS = [
  "state",
  "step",
  "stage",
  "reason",
  "since",
  "requestedAt",
  "expectedReadyAt",
  "secondsLeft",
  "secondsWaited",
  "specs",
  "machineId",
] as const;

const isAgentPart = (k: readonly unknown[], orgId: string, part: string) =>
  k[0] === "org" && k[1] === orgId && k[2] === "agent" && k[4] === part && k.length === 5;

/** One read per list at the start of a burst (an import, a team), one at its end, however many events it sends. */
const READ_GAP_MS = 500;
const pacers = new WeakMap<QueryClient, ReturnType<typeof pacer>>();

function readList(qc: QueryClient, list: string, filters: InvalidateQueryFilters) {
  const pace = pacers.get(qc) ?? pacer(READ_GAP_MS);
  pacers.set(qc, pace);
  pace(list, () => void qc.invalidateQueries(filters));
}

/** Every channel's members, roster and hover card (the members column, the channel's details): read again. */
const refreshChannelMembers = (qc: QueryClient, orgId: string, channelId?: string) =>
  readList(qc, `${orgId}:members:${channelId ?? "all"}`, {
    predicate: ({ queryKey: k }) =>
      k[0] === "org" &&
      k[1] === orgId &&
      k[2] === "channel" &&
      (channelId === undefined || k[3] === channelId) &&
      (k[4] === "members" || k[4] === "roster" || k[4] === "card") &&
      k.length === 5,
  });

const askedFor = new WeakMap<QueryClient, Set<string>>();

/**
 * A channel's list read from the server names someone the app's directory lacks (an agent made a moment ago, a person
 * who just joined): the directory is read again, or their row would go missing with no trace. Once per id, so someone
 * nobody can name costs one read, not one per read of the list. A directory not loaded yet will have them when it is.
 */
export function readUnknownMembers(
  qc: QueryClient,
  orgId: string,
  members: readonly { type: "person" | "agent"; id: string }[],
) {
  const agents = qc.getQueryData<Agent[]>(keys.agents(orgId));
  const people = qc.getQueryData<Member[]>(keys.members(orgId));
  const asked = askedFor.get(qc) ?? new Set();
  askedFor.set(qc, asked);
  const unknown = (m: (typeof members)[number]) => {
    const known = m.type === "agent" ? agents?.some((a) => a.id === m.id) : people?.some((p) => p.userId === m.id);
    if (known !== false || asked.has(`${orgId}:${m.id}`)) return false;
    asked.add(`${orgId}:${m.id}`);
    return true;
  };
  const missing = members.filter(unknown);
  if (missing.some((m) => m.type === "agent")) readList(qc, `${orgId}:agents`, { queryKey: keys.agents(orgId) });
  if (missing.some((m) => m.type === "person")) readList(qc, `${orgId}:people`, { queryKey: keys.members(orgId) });
}

/**
 * `channel.member_added` / `_removed` / `_updated`, from anyone: the channel's members column and details read their
 * lists again (and that read asks for whoever the app doesn't know yet, `readUnknownMembers`).
 */
export function applyMembershipEvent(qc: QueryClient, orgId: string, event: ChannelEvent): boolean {
  if (
    event.type !== "channel.member_added" &&
    event.type !== "channel.member_removed" &&
    event.type !== "channel.member_updated"
  )
    return false;
  refreshChannelMembers(qc, orgId, event.channelId);
  return true;
}

/**
 * What the open conversation says about lists shown elsewhere too: a file saved, changed or deleted there (its cards,
 * the open viewer, the Drive; a deleted one's cards say so, from the conversation read again), and an agent changing its
 * memory there (its memory list). Returns whether the event was one of these.
 */
export function applyConversationEvent(qc: QueryClient, orgId: string, event: ChannelEvent): boolean {
  const type: string = event.type;
  if (type === "artifact.created" || type === "artifact.updated" || type === "artifact.deleted") {
    void qc.invalidateQueries({ queryKey: keys.artifacts(orgId) });
    const channelId = (event as { channelId?: unknown }).channelId;
    if (type === "artifact.deleted" && typeof channelId === "string")
      void qc.invalidateQueries({ queryKey: ["org", orgId, "channel", channelId] });
    return true;
  }
  if (event.type === "memory.updated") {
    void qc.invalidateQueries({ queryKey: keys.memory(orgId, event.agentId) });
    return true;
  }
  return false;
}

/**
 * The workspace's own computer, standing and limits (ADR 0056 §8, §10), live: `machine.provisioning` (the fields of
 * `GET …/computer-setup` but `mode`) replaces what the setup query holds, and the computer's first hello
 * (`ready`) refetches the computers; `org.standing` sets this workspace's standing in `GET /me`, so the banner
 * and the suspended screen follow without a reload, and asks for the setup again: a workspace on hold waits for no
 * computer, and one active again waits for one. `org.deleting` (an owner deleted it) sets its deletion there, so the
 * line on top shows at once and the workspace turns read-only. `org.limits` (a new plan, ADR 0079) asks for the
 * limits again, so a full workspace's invitations open by themselves. `agent.groups` (ADR 0083) says the groups of
 * agents changed: they are read again.
 * `member.status` and `agent.status` (ADR 0084) refetch the people and the agents' presence. `org.members` (someone
 * joined or left, a role changed, ADR 0085, or a person's name, handle or photo) refetches the people, Members, each
 * channel's roster, the roles, `me`, the agents, the
 * routines (roles decide whom an agent answers) and the channels (roles decide which ones are listed, ADR 0125), and the pages of the agents it names (their owner or brain changed
 * when someone left). `agents.changed` and `channels.changed` (the team, or the channels and who is in them) read
 * again every list that shows them, open or cached, whoever changed them and however, and so do `artifacts.changed`
 * (the Drive), `wiki.page.updated`, `calendar.changed` (with my own `calendar.invited` and `calendar.proposal`),
 * `routines.changed` and `memory.changed` (what agents learned on their own). Returns whether the event was one of
 * these.
 */
export function applyWorkspaceEvent(qc: QueryClient, orgId: string, event: { type: string }): boolean {
  if (event.type === "agents.changed") {
    // Under `agents`: the former ones. The DMs name each agent as the server knows it.
    readList(qc, `${orgId}:agents`, { queryKey: keys.agents(orgId) });
    readList(qc, `${orgId}:dms`, { queryKey: keys.dms(orgId) });
    readList(qc, `${orgId}:team`, { queryKey: keys.team(orgId) });
    readList(qc, `${orgId}:overview`, { queryKey: keys.overview(orgId) });
    // Each channel's roster names them too, and so does an agent's open page.
    refreshChannelMembers(qc, orgId);
    readList(qc, `${orgId}:agent-pages`, { predicate: (q) => isAgentPart(q.queryKey, orgId, "detail") });
    // The library and each agent's skills: an agent page saves its whole list, so a stale one would undo a card's.
    readList(qc, `${orgId}:skills`, { queryKey: keys.skills(orgId) });
    return true;
  }
  if (event.type === "channels.changed") {
    readList(qc, `${orgId}:channels`, { queryKey: keys.channels(orgId) });
    readList(qc, `${orgId}:dms`, { queryKey: keys.dms(orgId) });
    refreshChannelMembers(qc, orgId);
    readList(qc, `${orgId}:agent-channels`, { predicate: (q) => isAgentPart(q.queryKey, orgId, "channels") });
    return true;
  }
  if (event.type === "org.members") {
    // Who is in which channel follows who is in the workspace (a newcomer joins #general and the invited channels).
    refreshChannelMembers(qc, orgId);
    // Roles decide whom an agent answers: its `canTalk` and the routines shown follow them.
    for (const key of [
      keys.people(orgId),
      keys.members(orgId),
      keys.overview(orgId),
      keys.roles(orgId),
      keys.me,
      keys.agents(orgId),
      keys.routines(orgId),
      keys.channels(orgId),
      // Under `invitations`: the ones sent (one accepted leaves them) and the requests to join.
      keys.invitations(orgId),
    ])
      void qc.invalidateQueries({ queryKey: key });
    // A person's name, handle or photo: each channel's members column (`roster`) names them.
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === orgId && q.queryKey[4] === "roster" });
    const agents = (event as { agents?: unknown }).agents;
    if (Array.isArray(agents) && agents.length) {
      for (const id of agents.filter((a): a is string => typeof a === "string")) {
        void qc.invalidateQueries({ queryKey: keys.agentDetail(orgId, id) });
        void qc.invalidateQueries({ queryKey: keys.agentBrain(orgId, id) });
      }
    }
    return true;
  }
  if (event.type === "agent.groups") {
    void qc.invalidateQueries({ queryKey: keys.agentGroups(orgId) });
    return true;
  }
  if (event.type === "machine.provisioning") {
    const e = event as Partial<Record<(typeof SETUP_FIELDS)[number] | "notifyByEmail", unknown>>;
    const next = Object.fromEntries(SETUP_FIELDS.map((k) => [k, e[k] ?? null])) as Omit<
      ComputerSetup,
      "mode" | "notifyByEmail"
    >;
    qc.setQueryData<ComputerSetup>(keys.computerSetup(orgId), (old) => ({
      mode: "external",
      ...next,
      // Whether the server sends email is the server's, not the step's: an event without it keeps what was known.
      notifyByEmail: typeof e.notifyByEmail === "boolean" ? e.notifyByEmail : (old?.notifyByEmail ?? false),
    }));
    if (next.state === "ready") {
      void qc.invalidateQueries({ queryKey: keys.machines(orgId) });
      void qc.invalidateQueries({ queryKey: keys.computers(orgId) });
      // Every agent's screen is there now: an open computer dialog shows it at once.
      void qc.invalidateQueries({ queryKey: keys.agentDesktops(orgId) });
    }
    return true;
  }
  if (event.type === "org.standing") {
    const e = event as { orgId?: unknown; state?: unknown; reason?: unknown; cloud?: unknown };
    const state = e.state === "hold" || e.state === "suspended" ? e.state : "active";
    const standing: OrgStanding = {
      state,
      reason: typeof e.reason === "string" && e.reason ? e.reason : null,
      ...(e.cloud === true ? { cloud: true } : {}),
    };
    const target = typeof e.orgId === "string" ? e.orgId : orgId;
    qc.setQueryData<Me>(keys.me, (me) =>
      me ? { ...me, organizations: me.organizations.map((o) => (o.id === target ? { ...o, standing } : o)) } : me,
    );
    void qc.invalidateQueries({ queryKey: keys.computerSetup(target) });
    return true;
  }
  if (event.type === "org.mode") {
    // The workspace became personal or a team's (ADR 0159): its shape follows at once, in every member's apps.
    const e = event as { orgId?: unknown; mode?: unknown };
    const target = typeof e.orgId === "string" ? e.orgId : orgId;
    if (isWorkspaceMode(e.mode)) {
      const mode = e.mode;
      qc.setQueryData<Me>(keys.me, (me) =>
        me ? { ...me, organizations: me.organizations.map((o) => (o.id === target ? { ...o, mode } : o)) } : me,
      );
    }
    void qc.invalidateQueries({ queryKey: keys.me });
    void qc.invalidateQueries({ queryKey: keys.settings(target) });
    return true;
  }
  if (event.type === "org.deleting") {
    const e = event as { orgId?: unknown; dueAt?: unknown; by?: unknown };
    const by = isObject(e.by) ? e.by : {};
    setOrgDeletion(qc, typeof e.orgId === "string" ? e.orgId : orgId, {
      dueAt: typeof e.dueAt === "string" ? e.dueAt : null,
      requestedAt: new Date().toISOString(),
      requestedBy: typeof by.id === "string" && typeof by.name === "string" ? { id: by.id, name: by.name } : null,
    });
    // The server's own record replaces this one.
    void qc.invalidateQueries({ queryKey: keys.me });
    return true;
  }
  if (event.type === "org.limits") {
    void qc.invalidateQueries({ queryKey: keys.limits(orgId) });
    return true;
  }
  // Someone changed their availability or line, or an agent its line (ADR 0084): the lists follow.
  if (event.type === "member.status") {
    void qc.invalidateQueries({ queryKey: keys.people(orgId) });
    return true;
  }
  if (event.type === "agent.status") {
    void qc.invalidateQueries({ queryKey: keys.agentStatus(orgId) });
    return true;
  }
  // A routine's run was queued, started or ended, or a routine was made, changed or deleted: Rotinas follows.
  if (event.type === "routine.runs" || event.type === "routines.changed") {
    void qc.invalidateQueries({ queryKey: keys.routines(orgId) });
    return true;
  }
  // The Drive's lists and its trash; a file's own content follows its conversation (`applyConversationEvent`).
  if (event.type === "artifacts.changed") {
    readList(qc, `${orgId}:drive`, {
      predicate: ({ queryKey: k }) =>
        k[0] === "org" && k[1] === orgId && k[2] === "artifacts" && (k[3] === "list" || k[3] === "trash"),
    });
    return true;
  }
  if (event.type === "wiki.page.updated") {
    readList(qc, `${orgId}:wiki`, { queryKey: keys.wiki(orgId) });
    return true;
  }
  // Someone changed it, I was invited, or an agent proposes me an event.
  if (event.type === "calendar.changed" || event.type === "calendar.invited" || event.type === "calendar.proposal") {
    readList(qc, `${orgId}:calendar`, { queryKey: keys.calendar(orgId) });
    return true;
  }
  // What agents learned on their own: every agent's memory list (the event names none).
  if (event.type === "memory.changed") {
    readList(qc, `${orgId}:memory`, {
      predicate: ({ queryKey: k }) => k[0] === "org" && k[1] === orgId && k[2] === "agent" && k[4] === "memory",
    });
    return true;
  }
  return false;
}

/**
 * A workspace's deletion in `GET /me`, as the server will say it: set when an owner deletes it (a workspace being
 * deleted has no onboarding to resume), gone once restored.
 */
export function setOrgDeletion(qc: QueryClient, orgId: string, deletion: OrgDeletion | null) {
  qc.setQueryData<Me | null>(keys.me, (me) =>
    me
      ? {
          ...me,
          organizations: me.organizations.map((o) => {
            if (o.id !== orgId) return o;
            const { deletion: _, onboarding, ...rest } = o;
            if (deletion) return { ...rest, deletion };
            return onboarding ? { ...rest, onboarding } : rest;
          }),
        }
      : me,
  );
}

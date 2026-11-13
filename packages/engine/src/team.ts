import { and, asc, type Database, desc, eq, gte, inArray, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { type AgentStatusView, lineInEnglish, loadAgentStatuses } from "./agent-status";
import { currentHandles } from "./agents";
import { type AiStatusDeps, agentAiStates } from "./ai-status";
import type { AgentAppearance } from "./appearance";
import { canTalkTo, type Speaker, seesAgentDetails, speakerFor, speakerOf, viaAgent } from "./audience";
import { inLine, mayCall } from "./autonomy-settings";
import { agentBrowserStatus } from "./browser/status";
import { BROWSER_SCOPE, DESKTOP_SCOPE } from "./browser/types";
import { caches } from "./cache";
import { capabilityKeys, summarizeScopes } from "./capabilities";
import { channelAudienceSql } from "./channels";
import { agentDesktopUseStatus } from "./desktop/status";
import { cutText, editDistance } from "./format";
import type { MachineCaller, MachineStatus } from "./machine-hub";
import { parseMentionHandles } from "./messages";
import { requirePermission } from "./organizations";
import { maySql } from "./permissions";
import { personBehindCall, routineCreatorOfCall } from "./requester";
import { getSandboxSettings, SANDBOX_SCOPE } from "./sandbox";
import type { ToolContext, ToolDefinition, ToolSource } from "./tools/types";
import { inWorkspaceWords, isPersonalWorkspace } from "./workspace-mode";

const {
  agentConsultations,
  agentRuns,
  agentScopes,
  agents,
  channelMembers,
  channels,
  connectorConnections,
  organizationMembers,
  users,
} = schema;

/**
 * Each agent's scopes, with a whole-connection grant (`connector:*`) named
 * after its connector (`sentry:*`), so summaries say "Sentry", not "Connector".
 */
export async function agentScopeNames(db: Database, orgId: string, agentIds: string[]) {
  if (agentIds.length === 0) return [];
  const rows = await db
    .select({ agentId: agentScopes.agentId, scope: agentScopes.scope, connector: connectorConnections.connector })
    .from(agentScopes)
    .leftJoin(connectorConnections, eq(connectorConnections.id, agentScopes.connectionId))
    .where(and(eq(agentScopes.orgId, orgId), inArray(agentScopes.agentId, agentIds)));
  return rows.map((r) => ({
    agentId: r.agentId,
    scope: r.scope.startsWith("connector:") && r.connector ? `${r.connector}:${r.scope.slice(10)}` : r.scope,
  }));
}

/** Granted to every new agent, but each works only where the agent's computer serves it. */
const COMPUTER_SCOPES: ReadonlySet<string> = new Set([SANDBOX_SCOPE, BROWSER_SCOPE, DESKTOP_SCOPE]);

/**
 * Each agent's scopes as the other agents read them (the roster in a run's
 * context, `find_agent`): a computer's (Code, Browser, Desktop) only while the
 * agent's computer serves it, by the checks its own tools pass.
 */
export async function rosterScopeNames(
  db: Database,
  machines: Pick<MachineCaller, "status"> | null | undefined,
  orgId: string,
  agentIds: string[],
) {
  if (agentIds.length === 0) return [];
  // Every run's context reads this: one round trip, and one read per computer however many agents share it.
  const reads = new Map<string, Promise<MachineStatus | null>>();
  const hub = machines
    ? {
        status: (id: string) => {
          const read = reads.get(id) ?? machines.status(id);
          reads.set(id, read);
          return read;
        },
      }
    : undefined;
  const [rows, sandbox, statuses] = await Promise.all([
    agentScopeNames(db, orgId, agentIds),
    getSandboxSettings(db, orgId),
    Promise.all(
      agentIds.map(async (agentId) => {
        const [browser, desktop] = await Promise.all([
          agentBrowserStatus(db, hub, orgId, agentId),
          agentDesktopUseStatus(db, hub, orgId, agentId),
        ]);
        return { agentId, browser, desktop };
      }),
    ),
  ]);
  const served = new Map(
    statuses.map(({ agentId, browser, desktop }) => {
      // No computer, or a removed one, is what the browser's status checks first.
      const computer = browser.available || !["no_machine", "machine_removed"].includes(browser.code);
      const code = sandbox.enabled && computer && rows.some((r) => r.agentId === agentId && r.scope === SANDBOX_SCOPE);
      const scopes = [
        ...(code ? [SANDBOX_SCOPE] : []),
        ...(browser.available ? [BROWSER_SCOPE] : []),
        ...(code && desktop.available ? [DESKTOP_SCOPE] : []),
      ];
      return [agentId, new Set(scopes)] as const;
    }),
  );
  return rows.filter((r) => !COMPUTER_SCOPES.has(r.scope) || served.get(r.agentId)?.has(r.scope));
}

export const FIND_AGENT_TOOL = "find_agent";
/** Up to this many teammates are named in every prompt; above it, only a hint to use `find_agent`. */
export const TEAM_IN_PROMPT = 15;

type Teammate = Pick<
  typeof agents.$inferSelect,
  | "id"
  | "name"
  | "handle"
  | "role"
  | "instructions"
  | "ownerUserId"
  | "audienceMode"
  | "audienceUserIds"
  | "audienceRoleIds"
  | "consultable"
  | "brain"
  | "autonomyBrakes"
  | "reportsToAgentId"
>;

/** The org's active agents, oldest first (per-process cache; agent writes drop it). */
export function loadTeam(db: Database, orgId: string): Promise<Teammate[]> {
  return caches.agents.getOrLoad(`${orgId}:team`, () =>
    db
      .select({
        id: agents.id,
        name: agents.name,
        handle: agents.handle,
        role: agents.role,
        instructions: agents.instructions,
        ownerUserId: agents.ownerUserId,
        audienceMode: agents.audienceMode,
        audienceUserIds: agents.audienceUserIds,
        audienceRoleIds: agents.audienceRoleIds,
        consultable: agents.consultable,
        brain: agents.brain,
        autonomyBrakes: agents.autonomyBrakes,
        reportsToAgentId: agents.reportsToAgentId,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .orderBy(asc(agents.createdAt)),
  ) as Promise<Teammate[]>;
}

export const forgetTeam = (orgId: string) => caches.agents.delete(`${orgId}:team`);

/** Handles of the org's archived agents (per-process cache; archiving drops it). */
function loadArchived(db: Database, orgId: string): Promise<string[]> {
  return caches.agents.getOrLoad(`${orgId}:archived`, async () =>
    (
      await db
        .select({ handle: agents.handle })
        .from(agents)
        .where(
          and(
            eq(agents.orgId, orgId),
            isNotNull(agents.archivedAt),
            // A person may hold that handle now (people's handles don't check agents'): the @ is theirs.
            sql`not exists (select 1 from ${organizationMembers} om
              where om.org_id = ${orgId}::uuid and om.handle = ${agents.handle})`,
          ),
        )
    ).map((r) => r.handle),
  ) as Promise<string[]>;
}

/** Handles offered for one that no agent here has. */
const CLOSEST_HANDLES = 3;

/**
 * A tool's answer for `@handles` (lower case, without the @) that reach no agent here: an archived one says so,
 * so the run stops trying it and tells the person; any other gets the closest handles among the agents the
 * person behind the run can talk to (the ones `find_agent` lists).
 */
/** `viaAgent`: the tool asks the agent for the person (ask_agent, tell_agent), so agents that take consultations count. */
export async function noAgentText(
  ctx: ToolContext,
  handles: string[],
  options: { viaAgent?: boolean } = {},
): Promise<string> {
  const person = await personBehindCall(ctx);
  const [archived, team, talks] = await Promise.all([
    loadArchived(ctx.db, ctx.orgId),
    loadTeam(ctx.db, ctx.orgId),
    speakerFor(ctx.db, ctx.orgId, person),
  ]);
  const speaker = options.viaAgent ? viaAgent(talks) : talks;
  const others = team.filter((a) => a.id !== ctx.agentId && canTalkTo(a, person, speaker)).map((a) => a.handle);
  return handles
    .map((h) => {
      if (archived.includes(h)) {
        return `@${h} is archived: nothing you send reaches it. Don't try it again. If the work needs it, tell the person.`;
      }
      const closest = others
        .map((o) => ({ o, d: editDistance(h, o) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, CLOSEST_HANDLES)
        .map((x) => `@${x.o}`);
      return `No agent @${h} here.${closest.length > 0 ? ` Closest handles: ${closest.join(", ")}.` : ""}`;
    })
    .join(" ");
}

/**
 * "# Archived agents": the archived agents that what a run reads still names (its instructions, its notes, the
 * conversation), so it neither asks nor mentions them and tells the person when its work counted on one. Empty
 * when it names none.
 */
export async function archivedAgentsPrompt(db: Database, orgId: string, texts: string[]): Promise<string> {
  const named = new Set(texts.flatMap((t) => parseMentionHandles(t)));
  if (named.size === 0) return "";
  const gone = (await loadArchived(db, orgId)).filter((h) => named.has(h)).map((h) => `@${h}`);
  if (gone.length === 0) return "";
  const one = gone.length === 1;
  const them = one ? "it" : "them";
  return `# Archived agents\n${gone.join(", ")} ${one ? "is" : "are"} archived: nothing you send reaches ${them}. Don't ask or mention ${them}. If your instructions, notes or this conversation count on ${one ? "it" : "one"}, tell the person.`;
}

/**
 * "# Renamed agents": the old handles (`currentHandles`) that what a run reads still names (a routine's brief, its
 * notes, the conversation), each with the handle its agent has now, so the run asks and mentions it by that one.
 * Empty when it names none.
 */
export async function renamedAgentsPrompt(db: Database, orgId: string, texts: string[]): Promise<string> {
  const named = [...new Set(texts.flatMap((t) => parseMentionHandles(t)))];
  const now = await currentHandles(db, orgId, named);
  const renamed = named.flatMap((h, i) => (now[i] && now[i] !== h ? [`@${h} is @${now[i]}`] : []));
  if (renamed.length === 0) return "";
  return `# Renamed agents\nSome text here names agents by a handle they had before: ${renamed.join(", ")}. It is the same agent: ask and mention it by the handle it has now.`;
}

/**
 * The org's other agents a run may ask for the person behind it (they talk to them, or take consultations) and its
 * own settings let it call (ADR 0131 §8), `skip` left out: who "# Your team" lists.
 */
export const teammatesFor = (
  team: Teammate[],
  selfId: string,
  requester: string | null,
  skip: Set<string>,
  talks: Speaker,
) => {
  const self = team.find((a) => a.id === selfId);
  return team.filter(
    (a) =>
      a.id !== selfId &&
      !skip.has(a.id) &&
      canTalkTo(a, requester, viaAgent(talks)) &&
      ((!!self && inLine(self, a)) || mayCall(self?.autonomyBrakes, { id: a.id, autonomy: a.autonomyBrakes })),
  );
};

/**
 * The teammates a run can reach, as `@handle (role)` (at most 10), for its general means (ADR 0109): those the
 * person behind it, or its routine's creator, may talk to.
 */
export async function teammateMeans(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId" | "triggerMessageId">,
  /** Whose agents they are, when the caller knows it already (the executor, from its run in memory). */
  known?: string | null,
) {
  const person = known !== undefined ? known : ((await personBehindCall(ctx)) ?? (await routineCreatorOfCall(ctx)));
  const [team, talks] = await Promise.all([loadTeam(ctx.db, ctx.orgId), speakerFor(ctx.db, ctx.orgId, person)]);
  return teammatesFor(team, ctx.agentId, person, new Set(), talks)
    .slice(0, 10)
    .map((a) => `@${a.handle}${a.role ? ` (${cutText(a.role, 60)})` : ""}`);
}

/**
 * "# Your team" for the system prompt: the other agents the person
 * behind the run can talk to, one short line each, so an agent knows who
 * exists even in a DM. Details stay behind `find_agent`. Agents already
 * described in "Where you are" (channel members) are left out. In a personal workspace (ADR 0159) they are the
 * person's other agents, not a team.
 */
export function teamPrompt(
  team: Teammate[],
  selfId: string,
  requester: string | null,
  skip: Set<string>,
  /** The requester as the audience rule reads them (`speakerFor`). */
  talks: Speaker,
  personal = false,
) {
  const others = teammatesFor(team, selfId, requester, skip, talks);
  if (others.length === 0) return "";
  const where = personal ? "work for this person" : "work in this organization";
  const lines =
    others.length > TEAM_IN_PROMPT
      ? `${others.length} other agents ${where}.`
      : `Other agents ${personal ? "of this person" : "in this organization"}: ${others.map((a) => `@${a.handle}${a.role ? ` (${a.role})` : ""}`).join(", ")}.`;
  return `# ${personal ? "Your fellow agents" : "Your team"}\n${lines} Use \`${FIND_AGENT_TOOL}\` to see who knows or can do something and what each one can do. When you need another agent's answer for the task, ask it with \`ask_agent\`; to hand one work, use \`tell_agent\`, giving the whole job to the agent that owns it with everything it needs. Do this instead of saying you can't or sending the person to it. Either way the call returns at once and what comes of it reaches you here by itself.`;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);

/** `find_agent` as a personal workspace's agents read it (ADR 0159). */
const FIND_AGENT_PERSONAL = {
  [FIND_AGENT_TOOL]:
    "Find this person's other agents: who knows or can do something (e.g. bills, travel, training), what each one can do, who is responsible for it and whether it is busy now. Leave `query` empty to list them all. To ask one, use ask_agent.",
};

/**
 * The built-in `find_agent` tool: who else works here, searchable by
 * name, role or what they do. Lists only agents the person behind the run can
 * talk to or that take consultations for them, with what they can do (`rosterScopeNames`), who is responsible and
 * whether they are busy. Read-only; asking one is `ask_agent`.
 */
export function createFindAgentToolSource(deps: { machines?: Pick<MachineCaller, "status"> | null } = {}): ToolSource {
  const tool: ToolDefinition = {
    name: FIND_AGENT_TOOL,
    description:
      "Find the organization's other agents: who knows or can do something (e.g. deploys, finance, design), what each one can do, who is responsible for it and whether it is busy now. Leave `query` empty to list them all. To ask one, use ask_agent.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "What you need, e.g. 'staging deploy' or 'invoices'." },
      },
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Find agents", detail: String(input.query ?? "") }),
    async execute(input, ctx) {
      const { db } = ctx;
      const person = await personBehindCall(ctx);
      const talks = await speakerFor(db, ctx.orgId, person);
      const team = (await loadTeam(db, ctx.orgId)).filter(
        (a) => a.id !== ctx.agentId && canTalkTo(a, person, viaAgent(talks)),
      );
      const query = words(String(input.query ?? ""));
      const scored = team
        .map((a) => {
          const name = new Set(words(`${a.name} ${a.handle} ${a.role}`));
          const body = new Set(words(a.instructions));
          const score = query.reduce((s, w) => s + (name.has(w) ? 3 : 0) + (body.has(w) ? 1 : 0), 0);
          return { a, score };
        })
        .filter((x) => query.length === 0 || x.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 10);
      if (scored.length === 0) {
        return {
          content:
            team.length === 0
              ? "No other agent here works with this person."
              : `No agent matches that. The others: ${team.map((a) => `@${a.handle}${a.role ? ` (${a.role})` : ""}`).join(", ")}.`,
        };
      }
      const ids = scored.map((x) => x.a.id);
      const ownerIds = [...new Set(scored.map((x) => x.a.ownerUserId).filter((id): id is string => !!id))];
      const [scopes, owners, statuses] = await Promise.all([
        rosterScopeNames(db, deps.machines, ctx.orgId, ids),
        ownerIds.length
          ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))
          : Promise.resolve([]),
        loadAgentStatuses(db, ctx.orgId, new Date(), ids),
      ]);
      const statusOf = new Map(statuses.map((s) => [s.agentId, s]));
      const content = scored
        .map(({ a }) => {
          const about = a.instructions.trim().replace(/\s+/g, " ");
          const owner = owners.find((o) => o.id === a.ownerUserId)?.name;
          return [
            `@${a.handle}: ${a.name}${a.role ? `, ${a.role}` : ""}${presenceNote(statusOf.get(a.id))}`,
            `  Can: ${summarizeScopes(scopes.filter((s) => s.agentId === a.id).map((s) => s.scope))}`,
            owner ? `  Responsible person: ${owner}` : "",
            about ? `  About: ${about.length > 240 ? `${cutText(about, 237)}…` : about}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n");
      return { content };
    },
  };
  return {
    name: "team",
    tools: async (ctx) => inWorkspaceWords(ctx.db, ctx.orgId, [tool], FIND_AGENT_PERSONAL),
  };
}

/** "busy, on heavy work: Revisando o PR #12": what an agent is doing, its line in its own words. */
function presenceWords(s: AgentStatusView) {
  const what = {
    online: "online",
    busy: "busy, on heavy work",
    away: "away",
    out: "out of office",
    offline: "paused",
  }[s.presence];
  const line = s.status ? lineInEnglish(s.status) : null;
  return `${what}${line ? `: ${line.replace(/[()\n]/g, " ")}` : ""}`;
}

/** " (busy, on heavy work: Revisando o PR #12)" after an agent's name in `find_agent`. */
function presenceNote(s: AgentStatusView | undefined) {
  return s ? ` (${presenceWords(s)})` : "";
}

/**
 * "# Your teammates now": the live state of the agents a run's context lists ("Where you are", "# Your team"), in
 * that order: no AI yet, its computer away, paused, or else that it answers when called (busy with what, if so). Idle
 * isn't a state here: a mention or `ask_agent` wakes an idle agent at once (`find_agent` says its presence). It
 * outweighs older messages (a "no AI connected" card stays in the history after the agent gets one). Empty when none
 * of them is left.
 */
export async function teammatesNowPrompt(
  deps: Omit<AiStatusDeps, "db"> & { db: Database },
  orgId: string,
  listed: { id: string; handle: string }[],
): Promise<string> {
  const ids = listed.map((a) => a.id);
  if (ids.length === 0) return "";
  const [ai, presence, personal] = await Promise.all([
    agentAiStates(deps, orgId, ids),
    loadAgentStatuses(deps.db, orgId, new Date(), ids, {
      hasModel: (agent) => deps.gateway.hasModelCredential(agent),
    }),
    isPersonalWorkspace(deps.db, orgId),
  ]);
  const presenceOf = new Map(presence.map((s) => [s.agentId, s]));
  const lines = listed.flatMap((a) => {
    const s = presenceOf.get(a.id);
    if (!s) return [];
    const state = ai.get(a.id)?.state;
    // Out of office (ADR 0084 §12) says why and until when, so the agent asks someone else meanwhile.
    const now =
      state === "no_ai"
        ? "no AI connected yet"
        : s.presence === "out"
          ? presenceWords(s)
          : state === "waiting"
            ? "its computer is away for now"
            : s.presence === "offline"
              ? "paused"
              : s.presence === "busy"
                ? `${presenceWords(s)} (answers when called)`
                : "has an AI, answers when called";
    return [`- @${a.handle}: ${now}`];
  });
  if (lines.length === 0) return "";
  return `# ${personal ? "Your fellow agents now" : "Your teammates now"}\n${lines.join("\n")}\nThis is how they are now: it outweighs what older messages here say about them (a "no AI connected" card stays in the history after the agent gets one).`;
}

/** Consultations shown on the team screen: the last day. */
export const TEAM_CONSULTATIONS_MS = 24 * 60 * 60_000;

/**
 * The team screen: the org's agents grouped by their responsible person,
 * what each can do (stable capability keys), who is working now, and which
 * agents consulted each other in the last day. Questions and answers stay out:
 * a conversation between agents is private.
 */
export async function getTeam(db: Database, actorId: string, orgId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const talks = speakerOf(membership);
  const list = await db
    .select({
      id: agents.id,
      name: agents.name,
      handle: agents.handle,
      role: agents.role,
      appearance: agents.appearance,
      ownerUserId: agents.ownerUserId,
      audienceMode: agents.audienceMode,
      audienceUserIds: agents.audienceUserIds,
      audienceRoleIds: agents.audienceRoleIds,
      consultable: agents.consultable,
      brain: agents.brain,
      reportsToAgentId: agents.reportsToAgentId,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt));
  const ids = list.map((a) => a.id);
  const ownerIds = [...new Set(list.map((a) => a.ownerUserId).filter((id): id is string => !!id))];
  const since = new Date(Date.now() - TEAM_CONSULTATIONS_MS);
  const [scopes, owners, busy, consultations, seats] = ids.length
    ? await Promise.all([
        agentScopeNames(db, orgId, ids),
        ownerIds.length
          ? db
              .select({ id: users.id, name: users.name, image: users.image })
              .from(users)
              .where(inArray(users.id, ownerIds))
          : Promise.resolve([]),
        db
          .selectDistinct({ agentId: agentRuns.agentId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.orgId, orgId),
              inArray(agentRuns.agentId, ids),
              inArray(agentRuns.status, ["running", "waiting_approval", "waiting_input"]),
            ),
          ),
        db
          .select({
            id: agentConsultations.id,
            askerAgentId: agentConsultations.askerAgentId,
            targetAgentId: agentConsultations.targetAgentId,
            status: agentConsultations.status,
            createdAt: agentConsultations.createdAt,
          })
          .from(agentConsultations)
          .where(and(eq(agentConsultations.orgId, orgId), gte(agentConsultations.createdAt, since)))
          .orderBy(desc(agentConsultations.createdAt))
          .limit(50),
        // The channels each agent is in, among those the viewer may see: listChannels' rule.
        db
          .select({ agentId: channelMembers.agentId, channelId: channels.id })
          .from(channelMembers)
          .innerJoin(channels, eq(channels.id, channelMembers.channelId))
          .where(
            and(
              eq(channels.orgId, orgId),
              inArray(channelMembers.agentId, ids),
              eq(channels.kind, "channel"),
              isNull(channels.archivedAt),
              isNull(channels.deletedAt),
              sql`(${channels.visibility} = 'public' or exists (select 1 from ${channelMembers} me where me.channel_id = ${channels.id} and me.user_id = ${actorId}) or ${channelAudienceSql("channels", sql`${actorId}`)} or ${maySql(sql`${orgId}::uuid`, sql`${actorId}::text`, "administrator")})`,
            ),
          )
          .orderBy(asc(channels.position), asc(channels.name)),
      ])
    : [[], [], [], [], []];
  const busyIds = new Set(busy.map((r) => r.agentId));
  const active = new Set(ids);
  return {
    agents: list.map((a) => {
      const seesDetails = seesAgentDetails(a, actorId, membership);
      return {
        id: a.id,
        name: a.name,
        handle: a.handle,
        role: a.role,
        appearance: (a.appearance ?? null) as AgentAppearance | null,
        ownerUserId: a.ownerUserId,
        reportsToAgentId: a.reportsToAgentId,
        capabilities: seesDetails ? capabilityKeys(scopes.filter((s) => s.agentId === a.id).map((s) => s.scope)) : [],
        busy: busyIds.has(a.id),
        channelIds: seats.filter((r) => r.agentId === a.id).map((r) => r.channelId),
        canTalk: canTalkTo(a, actorId, talks),
        seesDetails,
      };
    }),
    people: owners.map((o) => ({ id: o.id, name: o.name, image: o.image ?? null })),
    // Only between agents still here (an archived one has no place in the sky).
    consultations: consultations.filter((c) => active.has(c.askerAgentId) && active.has(c.targetAgentId)),
  };
}

import { holdEvents, type PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { AppLocale } from "@agenteschat/i18n/locale";
import {
  agentsLike,
  agentsLikeText,
  checkRoutine,
  type DraftPlace,
  giveApps,
  type ProposedRoutine,
  suggestAgentAi,
} from "./agent-proposals";
import {
  type Agent,
  archiveAgent,
  createAgent,
  freeHandle,
  HANDLE_PATTERN,
  NEW_AGENT_DEFAULTS,
  takenHandles,
} from "./agents";
import type { AiStatusDeps } from "./ai-status";
import { AGENT_LOOK, type AgentAppearance, setAgentAppearance, validateAppearance } from "./appearance";
import { recordAudit } from "./audit";
import { setAgentBrain } from "./brain-settings";
import { invalidateOrg } from "./cache";
import {
  addChannelMember,
  archiveChannel,
  CHANNEL_NAME_PATTERN,
  createChannel,
  joinChannel,
  requireChannelAccess,
  unarchiveChannel,
} from "./channels";
import { cardPlace, NO_PERSON_READS } from "./consultations";
import type { ContextDeps } from "./context/summaries";
import { publishDelivery } from "./delivery";
import { openPersonAgentDm } from "./dms";
import { queuePlanWaiting } from "./email";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged, publishChannelEvent, publishMessageCreated } from "./events";
import { setAgentComputerTarget } from "./machines";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import type { Notice } from "./notices";
import { can, getMembership, requirePermission } from "./organizations";
import { personBehindCall, personLocale } from "./requester";
import { RIGHT_HAND } from "./right-hand";
import { createRoutine, deleteRoutine } from "./routines";
import { deliverNoticeToRun } from "./run-resume";
import { bodyCode } from "./run-tools";
import { SKILL_NAME } from "./skills";
import { billingHold } from "./standing";
import { APPROVAL_TTL_MS } from "./tools/gateway";
import type { JsonSchema } from "./tools/json-schema";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tools/types";
import { isPersonalWorkspace } from "./workspace-mode";

const { agentRuns, agentSkills, agents, channelMembers, channels, messages, skills, users } = schema;

/**
 * The right hand's team card (ADR 0137 §10): one card proposing several agents at once, each with its channel, its
 * routines and skills, created in one click as whoever clicks through the same calls the app's own screens make
 * (`createChannel`, `createAgent`, `addChannelMember`, `createRoutine`, skills), all in one transaction: a step that
 * fails creates nothing, and the card says which step it was.
 */
export const TEAM_PROPOSAL_CARD = "team_proposal";
export const PROPOSE_TEAM_TOOL = "propose_team";
/** A question with answers to tap under it (ADR 0137 §10): each tap is the person's own message. */
export const OFFER_ANSWERS_TOOL = "offer_answers";
export const MAX_TEAM_AGENTS = 6;
export const MAX_TEAM_SKILLS = 4;
export const MAX_ROUTINES_PER_AGENT = 3;
export const MAX_ANSWER_CHOICES = 8;
/** "Desfazer" on a created team works this long. */
export const TEAM_UNDO_MS = 24 * 3600_000;
/** Lodi's weekly check (concept C) is one of the team's routines: Fridays at 17h in the person's time zone. */
export const WEEKLY_CHECK_CRON = "0 17 * * 5";
const WEEKLY_CHECK_PROMPT =
  "Write this week's check of the team for the person in this conversation, in their language: four numbers (runs, failed runs, approvals waiting, questions nobody answered), what worked, then one fix per problem (an agent stuck or in no channel, a budget near its limit, a request made by hand more than once), each as one of your cards. When there is nothing to say, write one short line.";
/**
 * The same in a personal workspace (ADR 0159): how the person's own agents did. An agent there may live in its DM
 * with no channel, which is no problem to fix.
 */
const WEEKLY_CHECK_PROMPT_PERSONAL =
  "Write this week's look at how their agents did for the person in this conversation, in their language: four numbers (runs, failed runs, approvals waiting, questions nobody answered), what worked, then one fix per problem (an agent stuck, a budget near its limit, something they asked for by hand more than once), each as one of your cards. When there is nothing to say, write one short line.";

export interface TeamAgent {
  name: string;
  handle: string;
  role: string;
  /** One line on the card: what it does. */
  line: string;
  instructions: string;
  appearance: AgentAppearance | null;
  /**
   * The channel it lives in, by name (created with the team when it doesn't exist). Empty: no channel, it lives in its
   * DM with the person and its routines report there (a personal workspace's template, ADR 0159).
   */
  channel: string;
  routines: ProposedRoutine[];
  /** What the receipt's "Abrir com a tarefa" types in its DM, never sent. */
  firstTask: string | null;
}

export interface TeamSkill {
  /** Its kebab-case name (`SKILL_NAME`). */
  name: string;
  /** As the card shows it ("Tom de voz da Acme"). */
  title: string;
  description: string;
  body: string;
  /** Handles of the team's agents that get it. */
  agents: string[];
}

export interface TeamParams {
  /** The card's first line ("3 agentes para a Acme, cada um no seu canal."). */
  lead: string;
  agents: TeamAgent[];
  /** Channel names the team creates (the rest exist), as read when proposed. */
  newChannels: string[];
  skills: TeamSkill[];
  /** The right hand's own weekly check, reporting in this conversation. */
  weekly: ProposedRoutine | null;
  /** What waits for the person's approval, one line. */
  approvals: string;
  /** People named as working there, for "Convidar …" after it is created. */
  invite: string[];
  /** From "Usar este modelo": the template's id. */
  template?: string;
}

/** `failed` is never stored: a failure leaves it `pending` with `error`. */
export type TeamProposalState = "pending" | "creating" | "created" | "denied" | "superseded" | "undone";

/** What "Criar o time" made: what Desfazer takes back, and what it left for someone else. */
export interface TeamCreated {
  agentIds: string[];
  /** Created with the team (Desfazer archives them); channels that existed aren't here. */
  channelIds: string[];
  routineIds: string[];
  skillIds: string[];
  /** Lines the clicker may not give: `skills` (admins), `weekly` (who manages routines). */
  skipped: ("skills" | "weekly")[];
  /** Agents with nothing to think with yet (the app opens Connect for them). */
  noAi: string[];
}

export interface TeamProposalCard {
  kind: "team_proposal";
  forUserId: string | null;
  params: TeamParams;
  state: TeamProposalState;
  decidedByUserId: string | null;
  decidedAt: string | null;
  expiresAt: string;
  created?: TeamCreated;
  /**
   * The last "Criar o time" failed at `step` (a channel, an agent's or a skill's name) and created nothing: `reason`
   * in English, with the error's `status`, `code` and `params` the app says it with in its language.
   */
  error?: { step: string; reason: string; status?: number; code?: string; params?: TeamFailureParams } | null;
  undoneAt?: string;
}

type TeamFailureParams = Record<string, string | number | boolean | string[] | null>;

/** `meta.replyChips` of a right hand's question: answers to tap, each sent as the person's message. */
export interface ReplyChips {
  choices: string[];
  multiple: boolean;
  step: number;
  of: number;
}

export const teamProposalOf = (meta: Record<string, unknown> | null | undefined): TeamProposalCard | null => {
  const card = meta?.actionCard as Partial<TeamProposalCard> | undefined;
  return card?.kind === "team_proposal" && Array.isArray(card.params?.agents) ? (card as TeamProposalCard) : null;
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/** "Tom de voz da Acme" → `tom-de-voz-da-acme`; a script with no Latin letters gets `skill-<n>`. */
export function skillSlug(title: string, n: number) {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/, "");
  return SKILL_NAME.test(slug) ? slug : `skill-${n + 1}`;
}

/**
 * Where each named channel stands for this person: one that exists and they may see (`existing`; `outside` are the
 * public ones they aren't in yet, joined with the team, since an agent joins only channels its owner is in), or a
 * name that is free. Names stay taken by archived channels (one per name in a workspace), so those come back with
 * the team (`archived`) when this person may bring them back (its creator or `manage_channels`). The rest, private
 * channels they aren't in and archived ones of someone else's, are `blocked`: the team needs another name there.
 */
export async function channelPlaces(db: Database, orgId: string, personId: string | null, names: string[]) {
  const existing = new Map<string, string>();
  const archived = new Map<string, string>();
  const outside = new Set<string>();
  const blocked: string[] = [];
  if (names.length === 0) return { existing, archived, outside, blocked, fresh: [] as string[] };
  const [rows, membership] = await Promise.all([
    db
      .select({
        id: channels.id,
        name: channels.name,
        visibility: channels.visibility,
        archivedAt: channels.archivedAt,
        createdBy: channels.createdByUserId,
        member: channelMembers.userId,
      })
      .from(channels)
      .leftJoin(
        channelMembers,
        and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, personId ?? "")),
      )
      .where(and(eq(channels.orgId, orgId), inArray(channels.name, names))),
    personId ? getMembership(db, personId, orgId) : null,
  ]);
  for (const r of rows) {
    const hidden = r.visibility !== "public" && !r.member;
    const stuck = r.archivedAt !== null && r.createdBy !== personId && !can(membership, "manage_channels");
    if (hidden || stuck) blocked.push(r.name);
    else if (r.archivedAt) archived.set(r.name, r.id);
    else {
      existing.set(r.name, r.id);
      if (!r.member) outside.add(r.id);
    }
  }
  return { existing, archived, outside, blocked, fresh: names.filter((n) => !existing.has(n)) };
}

const blockedError = (names: string[]) =>
  new ValidationError(
    `${names.map((n) => `#${n}`).join(", ")}: a channel you can't name here (private, or archived by someone else). Pick another name.`,
  );

/** The channels the team's agents live in, each once: an agent with none lives in its DM with the person. */
const teamChannels = (agents: readonly Pick<TeamAgent, "channel">[]) => [
  ...new Set(agents.flatMap((a) => (a.channel ? [a.channel] : []))),
];

/** Where an agent lives, as the agents read it on a card or a notice. */
const livesIn = (a: Pick<TeamAgent, "channel"> | undefined) => (a?.channel ? `in #${a.channel}` : "in its DM");

/**
 * The team as the tool (or a template) wrote it, checked as the create-agent API checks each agent: names, free and
 * distinct handles, looks, a channel name each (existing or new), their routines' schedules read now in the person's
 * time zone, skills by kebab-case name for the team's own agents, and the weekly check. What it can't take is refused
 * with the reason, so the model gets it right the next time.
 */
export async function checkTeam(
  deps: { db: Database; context?: ContextDeps },
  at: DraftPlace,
  input: Record<string, unknown>,
  locale: AppLocale,
): Promise<TeamParams> {
  const raw = list(input.agents).map(obj);
  if (raw.length === 0 || raw.length > MAX_TEAM_AGENTS) {
    throw new ValidationError(`Propose 1 to ${MAX_TEAM_AGENTS} agents.`);
  }
  const taken = await takenHandles(deps.db, at.orgId);
  const seen = new Set<string>();
  const team: TeamAgent[] = [];
  for (const a of raw) {
    const name = str(a.name);
    if (!name || name.length > 80) throw new ValidationError("Give each agent a name of up to 80 characters.");
    const handle = str(a.handle).replace(/^@/, "").toLowerCase();
    if (!HANDLE_PATTERN.test(handle)) {
      throw new ValidationError(`@${handle}: a handle is 2–32 lower-case letters, digits, - or _.`);
    }
    if (taken.has(handle) || seen.has(handle)) throw new ValidationError(`@${handle} is already taken: pick another.`);
    seen.add(handle);
    const role = str(a.role).slice(0, 200);
    const line = str(a.line).slice(0, 300);
    if (!line) throw new ValidationError(`Say in \`line\` what ${name} does, in one line.`);
    // None: it lives in its DM with the person (a personal workspace's template, ADR 0159).
    const channel = str(a.channel).replace(/^#/, "").toLowerCase();
    if (channel && (!CHANNEL_NAME_PATTERN.test(channel) || channel.startsWith("dm-"))) {
      throw new ValidationError(`#${channel}: a channel name is lower-case letters, digits, - or _.`);
    }
    const routinesIn = list(a.routines);
    if (routinesIn.length > MAX_ROUTINES_PER_AGENT) {
      throw new ValidationError(`At most ${MAX_ROUTINES_PER_AGENT} routines for ${name}.`);
    }
    const routines: ProposedRoutine[] = [];
    for (const r of routinesIn) routines.push(await checkRoutine(deps, at, r));
    team.push({
      name,
      handle,
      role,
      line,
      instructions: (str(a.instructions) || [role, line].filter(Boolean).join(": ")).slice(0, 50_000),
      appearance: a.look && typeof a.look === "object" ? validateAppearance(a.look) : null,
      channel,
      routines,
      firstTask: str(a.first_task).slice(0, 500) || null,
    });
  }
  const { fresh, blocked } = await channelPlaces(deps.db, at.orgId, at.personId, teamChannels(team));
  if (blocked.length > 0) throw blockedError(blocked);
  const skillsIn = list(input.skills).map(obj);
  if (skillsIn.length > MAX_TEAM_SKILLS) throw new ValidationError(`At most ${MAX_TEAM_SKILLS} skills.`);
  const teamSkills: TeamSkill[] = skillsIn.map((s, i) => {
    const title = str(s.title).slice(0, 80);
    const description = str(s.line).slice(0, 200);
    if (!title || !description) throw new ValidationError("Each skill needs a `title` and a `line`.");
    const named = [...new Set(list(s.agents).map((h) => str(h).replace(/^@/, "").toLowerCase()))];
    const strangers = named.filter((h) => !seen.has(h));
    if (strangers.length > 0) {
      throw new ValidationError(
        `A skill goes to the team's own agents: no ${strangers.map((h) => `@${h}`).join(", ")}.`,
      );
    }
    return {
      name: skillSlug(str(s.name) || title, i),
      title,
      description,
      body: (str(s.instructions) || description).slice(0, 20_000),
      agents: named,
    };
  });
  // A personal workspace's weekly check looks at the person's own agents, named for them (ADR 0159).
  const personal = input.weekly_check === true && (await isPersonalWorkspace(deps.db, at.orgId));
  const weekly =
    input.weekly_check === true
      ? await checkRoutine(deps, at, {
          schedule: WEEKLY_CHECK_CRON,
          prompt: personal ? WEEKLY_CHECK_PROMPT_PERSONAL : WEEKLY_CHECK_PROMPT,
          title: serverText(locale, personal ? "teamPlan.weekly.namePersonal" : "teamPlan.weekly.name"),
        })
      : null;
  return {
    lead: str(input.lead).slice(0, 300),
    agents: team,
    newChannels: fresh,
    skills: teamSkills,
    weekly,
    approvals: str(input.approvals).slice(0, 300),
    invite: [...new Set(list(input.invite).map(str).filter(Boolean))].slice(0, 10),
    ...(str(input.template) ? { template: str(input.template) } : {}),
  };
}

/** What the agents (and a notification preview) read of the card. */
function teamBody(p: TeamParams) {
  const who = p.agents.map((a) => `${a.name} (@${a.handle}${a.role ? `, ${a.role}` : ""}) ${livesIn(a)}`);
  return `Proposed a team${p.template ? ` from the «${p.template}» template` : ""}: ${who.join("; ")}.`;
}

/** Posts the team card as the right hand (`runId` null: from a template, no run behind it). Older open ones go. */
export async function postTeamCard(
  deps: { db: Database; pubsub?: PubSub },
  place: {
    orgId: string;
    channelId: string;
    threadId: string | null;
    agentId: string;
    runId: string | null;
    hop: number;
  },
  params: TeamParams,
  forUserId: string | null,
  ttlMs = APPROVAL_TTL_MS,
  /** False: the caller tells the conversation itself, once the card is in its final state. */
  announce = true,
): Promise<Message> {
  const card: TeamProposalCard = {
    kind: "team_proposal",
    forUserId,
    params,
    state: "pending",
    decidedByUserId: null,
    decidedAt: null,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  const message = await insertMessage(deps.db, {
    orgId: place.orgId,
    channelId: place.channelId,
    threadId: place.threadId,
    author: place.runId
      ? { type: "agent", agentId: place.agentId, runId: place.runId, hop: place.hop }
      : { type: "agent", agentId: place.agentId, runId: null, hop: 0, stretchId: null },
    body: teamBody(params),
    meta: {
      ...bodyCode(TEAM_PROPOSAL_CARD, { names: params.agents.map((a) => a.name).join(", ") }),
      actionCard: card,
    },
  });
  if (deps.pubsub && announce) await publishMessageCreated(deps.pubsub, messageView(message));
  // A newer team in the same conversation takes the place of the open ones before it (the person revised it).
  const older = await deps.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, place.orgId),
        eq(messages.channelId, place.channelId),
        sql`${messages.meta}->'actionCard'->>'kind' = ${TEAM_PROPOSAL_CARD}`,
        sql`${messages.meta}->'actionCard'->>'state' = 'pending'`,
        sql`${messages.id} <> ${message.id}`,
      ),
    );
  for (const m of older) {
    const before = teamProposalOf(m.meta);
    if (before) await writeCard(deps, m, { ...before, state: "superseded" }, "pending");
  }
  return message;
}

/** Writes the card if it is still in state `from` (two clicks at once: one wins), and tells the conversation. */
async function writeCard(
  deps: { db: Database; pubsub?: PubSub },
  message: Pick<Message, "id" | "orgId" | "channelId" | "threadId">,
  card: TeamProposalCard,
  from: TeamProposalState,
) {
  const [row] = await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(card)}::jsonb)` })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.orgId, message.orgId),
        sql`${messages.meta}->'actionCard'->>'state' = ${from}`,
      ),
    )
    .returning({ id: messages.id });
  if (row) {
    await publishChannelEvent(deps.pubsub, {
      type: "team.proposal.updated",
      channelId: message.channelId,
      threadId: message.threadId,
      messageId: message.id,
      card,
    });
  }
  return row !== undefined;
}

/** The card behind a message the viewer can read, or 404. */
async function teamMessage(db: Database, userId: string, orgId: string, messageId: string) {
  const message = await getMessage(db, orgId, messageId);
  const card = message && !message.deletedAt && message.authorType === "agent" ? teamProposalOf(message.meta) : null;
  if (!message || !card || !message.authorAgentId) throw new NotFoundError("Team not found", "team_proposal.not_found");
  await requireChannelAccess(db, userId, orgId, message.channelId);
  return { message, card, proposedBy: message.authorAgentId };
}

const decided = () => new ConflictError("This team was already decided", "team_proposal.decided");

/** The right hand hears what happened to its card, in a run of its own (none for a template's card). */
async function tellProposer(deps: { db: Database; pubsub?: PubSub }, message: Message, text: string) {
  const [run] = message.agentRunId
    ? await deps.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, message.orgId), eq(agentRuns.id, message.agentRunId)))
    : [];
  if (!run) return;
  const notice: Notice = {
    kind: "proposal_result",
    from: (await isPersonalWorkspace(deps.db, message.orgId)) ? "Your card of agents" : "Your team card",
    text,
    refs: { messageId: message.id, runId: run.id },
  };
  const delivered = await deps.db.transaction((tx) => deliverNoticeToRun(tx, run, notice));
  await publishDelivery(deps.pubsub, delivered).catch(() => {});
}

export interface TeamDeps {
  db: Database;
  pubsub: PubSub;
  gateway?: AiStatusDeps["gateway"];
}

/** Runs `step`, naming it in the error that undoes everything. */
class StepError extends Error {
  constructor(
    readonly step: string,
    readonly failure: unknown,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/** The failure as the card keeps it: the step, the English reason, and the code and status the app translates. */
function teamFailure(step: string, error: unknown): NonNullable<TeamProposalCard["error"]> {
  const cause = error instanceof StepError ? error.failure : error;
  const status =
    cause instanceof ForbiddenError
      ? 403
      : cause instanceof NotFoundError
        ? 404
        : cause instanceof ConflictError
          ? 409
          : cause instanceof ValidationError
            ? 400
            : 500;
  // A driver's error says SQL and its parameters: the card, which members read, keeps none of it.
  if (status === 500) return { step, reason: "Something went wrong", status };
  const coded = cause as { code: string; params?: TeamFailureParams };
  return {
    step,
    reason: (cause as Error).message,
    status,
    code: coded.code,
    ...(coded.params ? { params: coded.params } : {}),
  };
}
const stepped = async <T>(step: string, run: () => Promise<T>) => {
  try {
    return await run();
  } catch (error) {
    throw error instanceof StepError ? error : new StepError(step, error);
  }
};

/**
 * "Criar o time" (`POST …/team-proposals/{messageId}/create`): everything on the card, as the person who clicks
 * (`create_agents`), in one transaction. Skills are an admin's (`manage_agents`) and the weekly check is for who may
 * manage the right hand's routines: without that right they are left out, named on the receipt, and the rest is made.
 * A step that fails undoes the whole team; the card stays open with that step and its reason. Its AI comes after,
 * as for a single proposal (an account of the clicker's that thinks for no agent, else the workspace's model).
 */
export async function createTeam(deps: TeamDeps, userId: string, orgId: string, messageId: string) {
  const found = await teamMessage(deps.db, userId, orgId, messageId);
  const membership = await requirePermission(deps.db, userId, orgId, "create_agents");
  const { message, card } = found;
  if (card.state !== "pending") throw decided();
  if (Date.parse(card.expiresAt) <= Date.now()) {
    throw new ConflictError("This team card expired", "team_proposal.expired");
  }
  const claimed: TeamProposalCard = { ...card, state: "creating", error: null };
  if (!(await writeCard(deps, message, claimed, "pending"))) throw decided();
  const p = card.params;
  const admin = can(membership, "manage_agents");
  const skipped: TeamCreated["skipped"] = [];
  let made: Omit<TeamCreated, "noAi" | "skipped"> & { agents: Agent[] };
  const events = holdEvents(deps.pubsub);
  try {
    made = await deps.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const out = {
        agentIds: [] as string[],
        channelIds: [] as string[],
        routineIds: [] as string[],
        skillIds: [] as string[],
        agents: [] as Agent[],
      };
      const names = teamChannels(p.agents);
      const channelStep = names.map((n) => `#${n}`).join(", ");
      const { existing, archived, outside, blocked } = await stepped(channelStep, () =>
        channelPlaces(tx, orgId, userId, names),
      );
      if (blocked.length > 0) throw new StepError(channelStep, blockedError(blocked));
      for (const id of outside) await stepped(channelStep, () => joinChannel(tx, userId, orgId, id, events));
      const channelOf = new Map(existing);
      const taken = await takenHandles(tx, orgId);
      for (const name of names) {
        if (channelOf.has(name)) continue;
        const back = archived.get(name);
        const id = await stepped(`#${name}`, async () => {
          if (!back) return (await createChannel(tx, userId, orgId, { name }, events)).id;
          await unarchiveChannel(tx, userId, orgId, back, events);
          return back;
        });
        channelOf.set(name, id);
        out.channelIds.push(id);
      }
      for (const a of p.agents) {
        const agent = await stepped(a.name, async () => {
          // Checked first: a unique violation inside this transaction would abort it before createAgent says why.
          if (taken.has(a.handle)) {
            const suggestion = freeHandle(a.handle, taken);
            throw new ConflictError(`@${a.handle} is already taken. How about @${suggestion}?`, "agent.handle_taken", {
              handle: a.handle,
              suggestion,
            });
          }
          let row = await createAgent(
            tx,
            userId,
            orgId,
            { name: a.name, handle: a.handle, role: a.role, instructions: a.instructions },
            NEW_AGENT_DEFAULTS,
            { via: found.proposedBy, pubsub: events.pubsub },
          );
          if (a.appearance) row = await setAgentAppearance(tx, userId, orgId, row.id, a.appearance, events);
          // An admin's team gets the apps every agent has; anyone else's starts without access (ADR 0085 §5).
          if (admin) await giveApps(tx, userId, orgId, row.id, []);
          // With no channel it lives in its DM with the person, where its routines report (ADR 0159).
          const channelId = a.channel ? (channelOf.get(a.channel) as string) : null;
          if (channelId) await addChannelMember(tx, userId, orgId, channelId, { agentId: row.id }, events);
          for (const r of a.routines) {
            const routine = await createRoutine({ db: tx, pubsub: events.pubsub }, userId, orgId, {
              name: r.name,
              agentId: row.id,
              prompt: r.prompt,
              target: channelId ? { type: "conversation", channelId, threadId: null, reminder: false } : { type: "dm" },
              trigger: r.rule
                ? { type: "schedule", rule: r.rule }
                : { type: "schedule", phrase: r.cron, timezone: r.timezone },
              access: r.access,
              report: r.report,
            });
            out.routineIds.push(routine.id);
          }
          return row;
        });
        out.agents.push(agent);
        out.agentIds.push(agent.id);
      }
      if (p.skills.length > 0 && !admin) skipped.push("skills");
      if (p.skills.length > 0 && admin) {
        const ids = new Map(out.agents.map((a) => [a.handle, a.id]));
        for (const s of p.skills) {
          const id = await stepped(s.title, () => insertSkill(tx, userId, orgId, s, found.proposedBy));
          out.skillIds.push(id);
          const on = s.agents.flatMap((h) => (ids.has(h) ? [ids.get(h) as string] : []));
          if (on.length > 0) {
            await tx.insert(agentSkills).values(on.map((agentId) => ({ orgId, agentId, skillId: id, enabled: true })));
          }
        }
      }
      if (p.weekly) {
        const w = p.weekly;
        // Who may manage the right hand's routines (its owner or `manage_routines`); else it is left out. Its
        // savepoint keeps a refusal from aborting the rest.
        const weekly = await raw
          .transaction(async (sp) =>
            createRoutine({ db: sp as unknown as Database, pubsub: events.pubsub }, userId, orgId, {
              name: w.name,
              agentId: found.proposedBy,
              prompt: w.prompt,
              target: { type: "dm" },
              trigger: w.rule
                ? { type: "schedule", rule: w.rule }
                : { type: "schedule", phrase: w.cron, timezone: w.timezone },
              access: w.access,
              report: w.report,
            }),
          )
          .catch((error) => {
            if (error instanceof ForbiddenError) return null;
            throw new StepError(w.name, error);
          });
        if (weekly) out.routineIds.push(weekly.id);
        else skipped.push("weekly");
      }
      return out;
    });
  } catch (error) {
    const step = error instanceof StepError ? error.step : p.agents.map((a) => a.name).join(", ");
    const back: TeamProposalCard = { ...card, error: teamFailure(step, error) };
    await writeCard(deps, message, back, "creating");
    return { card: back, noAi: [] as string[] };
  }
  // Cleared inside the transaction too: a run reading in between may have cached the team as it was.
  invalidateOrg(orgId);
  await events.flush();
  // Its AI, one agent after the other: an account of the clicker's thinks for one agent at most.
  const noAi: string[] = [];
  let thinking = false;
  for (const agent of made.agents) {
    const ai = await suggestAgentAi(deps, orgId, userId);
    if (ai.kind === "none") noAi.push(agent.id);
    if (ai.kind !== "account") continue;
    try {
      await setAgentComputerTarget({ db: deps.db, pubsub: deps.pubsub }, userId, orgId, agent.id, ai.machineId);
      await setAgentBrain({ db: deps.db }, userId, orgId, agent.id, {
        brain: ai.brain,
        account: ai.accountId,
      });
      thinking = true;
    } catch {
      noAi.push(agent.id);
    }
  }
  if (thinking) await publishAgentsChanged(deps.pubsub, orgId);
  const { agents: _agents, ...ids } = made;
  const done: TeamProposalCard = {
    ...card,
    state: "created",
    error: null,
    decidedByUserId: userId,
    decidedAt: new Date().toISOString(),
    created: { ...ids, skipped, noAi },
  };
  await writeCard(deps, message, done, "creating");
  if ((await billingHold(deps.db, orgId)) === "payment") await queuePlanWaiting(deps.db, orgId);
  const [person] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const who = made.agents.map((a, i) => `@${a.handle} (${a.name}) ${livesIn(p.agents[i])}`).join(", ");
  await tellProposer(
    deps,
    message,
    `${person?.name ?? "A person"} created ${(await isPersonalWorkspace(deps.db, orgId)) ? "their agents" : "the team"}: ${who}; ${ids.routineIds.length} routines${ids.skillIds.length ? `, ${ids.skillIds.length} skills` : ""}.${skipped.includes("skills") ? " The skills wait for an admin." : ""}${skipped.includes("weekly") ? " Your weekly check wasn't made: only who manages your routines makes it." : ""} The card already offers a first task per agent${(await isPersonalWorkspace(deps.db, orgId)) ? "" : " and inviting the people"}: say it is ready in one short line, without repeating them.`,
  );
  return { card: done, noAi };
}

/** A skill written on the card, as a person writes one in Settings › Skills (a taken name gets `-2`). */
async function insertSkill(db: Database, userId: string, orgId: string, s: TeamSkill, via: string) {
  const taken = new Set(
    (
      await db
        .select({ slug: skills.slug })
        .from(skills)
        .where(and(eq(skills.orgId, orgId), sql`${skills.slug} like ${`${s.name}%`}`))
    ).map((r) => r.slug),
  );
  let name = s.name;
  for (let n = 2; taken.has(name); n++) name = `${s.name}-${n}`;
  const [row] = await db
    .insert(skills)
    .values({
      orgId,
      slug: name,
      name,
      description: s.description,
      body: s.body,
      source: "manual",
      createdByUserId: userId,
      metadata: { title: s.title },
    })
    .returning({ id: skills.id });
  if (!row) throw new Error("skill insert returned nothing");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "skill.created",
    target: { type: "skill", id: row.id },
    details: { name, via },
  });
  return row.id;
}

/** "Descartar": whoever it was for, or who may create agents. */
export async function denyTeam(deps: TeamDeps, userId: string, orgId: string, messageId: string) {
  const { message, card } = await teamMessage(deps.db, userId, orgId, messageId);
  if (card.forUserId !== userId) await requirePermission(deps.db, userId, orgId, "create_agents");
  if (card.state !== "pending") throw decided();
  const next: TeamProposalCard = {
    ...card,
    state: "denied",
    decidedByUserId: userId,
    decidedAt: new Date().toISOString(),
  };
  if (!(await writeCard(deps, message, next, "pending"))) throw decided();
  const [person] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  await tellProposer(
    deps,
    message,
    `${person?.name ?? "A person"} dismissed it. Don't propose it again unless they ask.`,
  );
  return { card: next };
}

/**
 * "Desfazer" on the receipt, within a day, by whoever created it or who manages agents: its routines and skills go,
 * its agents and the channels it created are archived (they come back from Settings, as any archived ones).
 */
export async function undoTeam(deps: TeamDeps, userId: string, orgId: string, messageId: string) {
  const { message, card } = await teamMessage(deps.db, userId, orgId, messageId);
  const membership = await getMembership(deps.db, userId, orgId);
  const mine = card.decidedByUserId === userId;
  if (!mine && !can(membership, "manage_agents")) {
    throw new ForbiddenError("Only who created the team or an admin undoes it");
  }
  const made = card.created;
  if (card.state !== "created" || !made) throw decided();
  if (!card.decidedAt || Date.parse(card.decidedAt) + TEAM_UNDO_MS <= Date.now()) {
    throw new ConflictError("It is too late to undo this team", "team_proposal.undo_expired");
  }
  const events = holdEvents(deps.pubsub);
  await deps.db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    for (const id of made.routineIds) {
      await deleteRoutine({ db: tx, pubsub: events.pubsub }, userId, orgId, id).catch((e) => {
        if (!(e instanceof NotFoundError)) throw e;
      });
    }
    if (made.skillIds.length > 0) {
      await tx
        .update(skills)
        .set({ deletedAt: new Date() })
        .where(and(eq(skills.orgId, orgId), inArray(skills.id, made.skillIds)));
    }
    const live = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, made.agentIds), isNull(agents.archivedAt)));
    for (const a of live) await archiveAgent(tx, userId, orgId, a.id, events.pubsub, mine);
    for (const id of made.channelIds) {
      await archiveChannel(tx, userId, orgId, id, events).catch((e) => {
        if (!(e instanceof NotFoundError)) throw e;
      });
    }
  });
  invalidateOrg(orgId);
  await events.flush();
  const next: TeamProposalCard = { ...card, state: "undone", undoneAt: new Date().toISOString() };
  await writeCard(deps, message, next, "created");
  return { card: next };
}

/** "Ajustar" (`PATCH …/team-proposals/{messageId}/agents/{handle}`): one agent's draft edited before the team exists. */
export async function adjustTeamAgent(
  deps: TeamDeps,
  userId: string,
  orgId: string,
  messageId: string,
  handle: string,
  patch: { name?: string; role?: string; line?: string; instructions?: string; channel?: string; firstTask?: string },
) {
  const { message, card } = await teamMessage(deps.db, userId, orgId, messageId);
  await requirePermission(deps.db, userId, orgId, "create_agents");
  if (card.state !== "pending") throw decided();
  const at = card.params.agents.findIndex((a) => a.handle === handle);
  const current = card.params.agents[at];
  if (!current) throw new NotFoundError("No such agent on this card", "team_proposal.no_agent");
  const name = patch.name !== undefined ? str(patch.name) : current.name;
  if (!name || name.length > 80) throw new ValidationError("Give it a name of up to 80 characters.");
  const line = patch.line !== undefined ? str(patch.line).slice(0, 300) : current.line;
  if (!line) throw new ValidationError("Say in one line what it does.");
  // Empty keeps it in its DM with the person, with no channel (ADR 0159).
  const channel = patch.channel !== undefined ? str(patch.channel).replace(/^#/, "").toLowerCase() : current.channel;
  if (channel && (!CHANNEL_NAME_PATTERN.test(channel) || channel.startsWith("dm-"))) {
    throw new ValidationError("channel name: lower-case letters, digits, - or _ (max 80)", "channel.invalid_name");
  }
  const role = patch.role !== undefined ? str(patch.role).slice(0, 200) : current.role;
  const next: TeamAgent = {
    ...current,
    name,
    role,
    line,
    channel,
    instructions:
      patch.instructions !== undefined ? str(patch.instructions).slice(0, 50_000) || line : current.instructions,
    firstTask: patch.firstTask !== undefined ? str(patch.firstTask).slice(0, 500) || null : current.firstTask,
  };
  const team = card.params.agents.map((a, i) => (i === at ? next : a));
  const { fresh, blocked } = await channelPlaces(deps.db, orgId, userId, teamChannels(team));
  if (blocked.length > 0) throw blockedError(blocked);
  const updated: TeamProposalCard = { ...card, params: { ...card.params, agents: team, newChannels: fresh } };
  await writeCard(deps, message, updated, "pending");
  return { card: updated };
}

// ── The tools ───────────────────────────────────────────────────────────────

const LOOK_SCHEMA = {
  type: "object",
  properties: {
    color: { type: "string", enum: [...AGENT_LOOK.colors] },
    eyes: { type: "string", enum: [...AGENT_LOOK.eyes] },
    accessory: { type: "string", enum: [...AGENT_LOOK.accessories] },
  },
  required: ["color", "eyes"],
  additionalProperties: false,
} as const;

/**
 * What `propose_team` takes. `personal` (ADR 0159): an agent there usually lives in its DM with the person, so its
 * `channel` may be left out (`checkTeam` and `createTeam` take an empty one) and the examples speak of one person; a
 * team's right hand names a channel for each agent, as before.
 */
function teamSchema(personal: boolean): JsonSchema {
  const channel = personal
    ? {
        type: "string",
        maxLength: 81,
        description:
          "Leave it out: the agent lives in its DM with the person, where its routines report. A channel's name (an existing one, or a new one: lower-case, - or _) only when they asked for a group conversation for it.",
      }
    : {
        type: "string",
        minLength: 1,
        maxLength: 81,
        description: "The channel it lives in, by name (an existing one, or a new one: lower-case, - or _).",
      };
  return {
    type: "object",
    properties: {
      lead: {
        type: "string",
        minLength: 1,
        maxLength: 300,
        description: personal
          ? "The card's first line, in their language, e.g. '3 agents for your home, your money and your training. You talk to each one in its own chat.'"
          : "The card's first line, in their language: '3 agentes para a Acme, cada um no seu canal. Você e o Bruno falam com eles por lá.'",
      },
      agents: {
        type: "array",
        minItems: 1,
        maxItems: MAX_TEAM_AGENTS,
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            handle: { type: "string", pattern: "^@?[a-z0-9][a-z0-9_-]{1,31}$" },
            role: { type: "string", maxLength: 200, description: "One or two words: Atendimento, Cobrança, Dev." },
            line: {
              type: "string",
              minLength: 1,
              maxLength: 300,
              description: "What it does, one line in their language.",
            },
            instructions: { type: "string", maxLength: 50_000, description: "Its standing instructions." },
            look: LOOK_SCHEMA,
            channel,
            routines: {
              type: "array",
              maxItems: MAX_ROUTINES_PER_AGENT,
              items: {
                type: "object",
                properties: {
                  schedule: {
                    type: "string",
                    minLength: 1,
                    maxLength: 300,
                    description: "5-field cron in the person's time zone: '0 9 * * 1-5' is weekdays at 9.",
                  },
                  prompt: { type: "string", minLength: 1, maxLength: 10_000 },
                  title: { type: "string", maxLength: 120, description: "What it does, short, in their language." },
                },
                required: ["schedule", "prompt", "title"],
                additionalProperties: false,
              },
            },
            first_task: {
              type: "string",
              maxLength: 500,
              description: "A short first thing for it to do today, in their words: typed in its DM, never sent.",
            },
          },
          required: personal ? ["name", "handle", "role", "line"] : ["name", "handle", "role", "line", "channel"],
          additionalProperties: false,
        },
      },
      skills: {
        type: "array",
        maxItems: MAX_TEAM_SKILLS,
        items: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 80, description: "'Tom de voz da Acme'" },
            line: { type: "string", minLength: 1, maxLength: 200, description: "What it is, one line." },
            instructions: { type: "string", maxLength: 20_000, description: "The skill itself, in Markdown." },
            agents: { type: "array", items: { type: "string" }, maxItems: MAX_TEAM_AGENTS },
          },
          required: ["title", "line", "agents"],
          additionalProperties: false,
        },
      },
      approvals: {
        type: "string",
        maxLength: 300,
        description:
          "What waits for their approval, one line: 'As cobranças do Caio e os merges da Ada esperam a sua aprovação.'",
      },
      invite: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 120 },
        maxItems: 10,
        description: personal
          ? "Only people they asked to bring in (family, someone who helps them), by name or email, to invite once their agents exist."
          : "The people they said work there, by name or email, to invite once the team exists.",
      },
      weekly_check: {
        type: "boolean",
        description: personal
          ? "Add your own weekly look at how their agents did (Fridays at 17h, here). Yes for new agents."
          : "Add your own weekly check of the team (Fridays at 17h, here). Yes for a new team.",
      },
      also_new: {
        type: "boolean",
        description:
          "Only once the person said to make them although agents like them already exist (this tool names them).",
      },
    },
    required: ["lead", "agents"],
    additionalProperties: false,
  };
}

/** `propose_team` as a personal workspace's right hand reads it (ADR 0159): its agents may go without a channel. */
export const PROPOSE_TEAM_SCHEMA_PERSONAL = teamSchema(true);

/**
 * The right hand's team setup (ADR 0137 §10): `offer_answers` puts tappable answers under a question (each tap is the
 * person's own message; typing works too), and `propose_team` posts the one team card. Only the right hand has them.
 */
export function teamTools(deps: {
  pubsub?: PubSub;
  context?: ContextDeps;
  /** The run's card share (`cardsLeft` in setup-tools). */
  cardsLeft: (ctx: ToolContext, asks?: boolean) => Promise<ToolOutput | null>;
  hopOf: (ctx: ToolContext) => Promise<number>;
}): ToolDefinition[] {
  return [
    {
      name: OFFER_ANSWERS_TOOL,
      description:
        "Ask the person one short question with answers to tap under it, in this conversation: each tap sends the answer as their own message (several at once with `multiple`), and they can always type instead. Use it for the questions that set the team up (what the business does, what takes most of their time, who else works there), one per turn, with `step` and `of` ('Pergunta 2 de 3'). The question shows as your message: write nothing else in this turn and end it. Their answer comes as their next message.",
      scope: "setup:write",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 1000,
            description:
              "Your message with the question, in their language (Markdown; the question itself in **bold**), e.g. 'Boa, então vocês vendem um sistema para clínicas. **O que mais toma o seu tempo hoje?** Pode escolher mais de um.'",
          },
          choices: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 60 },
            maxItems: MAX_ANSWER_CHOICES,
            description:
              "Short answers that fit their business, in their language, the last one 'Outra coisa' (or its words in their language). None: they answer by typing.",
          },
          multiple: { type: "boolean", description: "They may pick several and send them together." },
          step: { type: "integer", minimum: 1, maximum: 5 },
          of: { type: "integer", minimum: 1, maximum: 5 },
        },
        required: ["text", "step", "of"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const at = await cardPlace(ctx);
          if (!at) return { content: NO_PERSON_READS, isError: true };
          const full = await deps.cardsLeft(ctx, true);
          if (full) return full;
          const of = Math.max(1, Number(input.of) || 1);
          const chips: ReplyChips = {
            choices: [...new Set(list(input.choices).map(str).filter(Boolean))].slice(0, MAX_ANSWER_CHOICES),
            multiple: input.multiple === true,
            step: Math.min(of, Math.max(1, Number(input.step) || 1)),
            of,
          };
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            ...at,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await deps.hopOf(ctx) },
            body: str(input.text),
            meta: { replyChips: chips },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          return {
            content:
              "Posted your question with its answers to tap. Write nothing else now and end your turn: their answer comes as their next message.",
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: PROPOSE_TEAM_TOOL,
      description:
        "Propose a whole team with ONE card in this conversation: each agent with its face, name, role, a line on what it does, the channel it lives in (a new channel is created with the team), 1 to 3 routines, plus 1 or 2 skills, a line on what waits for the person's approval and your own weekly check. Whoever may create agents creates it all in one click ('Criar o time'), adjusts an agent first or dismisses it. Use it to start or rebuild a team (2 to 4 agents usually), never one propose_agent card per agent then. Nothing exists until they click: never say it does. A newer team card here replaces the open one.",
      scope: "setup:write",
      inputSchema: teamSchema(false),
      async execute(input, ctx) {
        try {
          const at = await cardPlace(ctx);
          if (!at) return { content: NO_PERSON_READS, isError: true };
          const full = await deps.cardsLeft(ctx, true);
          if (full) return full;
          const forUserId = await personBehindCall(ctx);
          const drafts = list(input.agents).map(obj);
          const like = input.also_new === true ? [] : await agentsLike(ctx.db, ctx.orgId, drafts, forUserId);
          if (like.length > 0) return { content: agentsLikeText(like, PROPOSE_TEAM_TOOL) };
          const locale = await personLocale(ctx.db, forUserId);
          const params = await checkTeam(
            { db: ctx.db, context: deps.context },
            { orgId: ctx.orgId, channelId: at.channelId, personId: forUserId },
            input,
            locale,
          );
          const message = await postTeamCard(
            { db: ctx.db, pubsub: deps.pubsub },
            {
              orgId: ctx.orgId,
              ...at,
              agentId: ctx.agentId,
              runId: ctx.runId,
              hop: await deps.hopOf(ctx),
            },
            params,
            forUserId,
          );
          const routines = params.agents.reduce((n, a) => n + a.routines.length, 0) + (params.weekly ? 1 : 0);
          const where = params.agents.map((a) => `${a.name} ${livesIn(a)}`).join(", ");
          const made = `${where}${params.newChannels.length ? ` (new: ${params.newChannels.map((c) => `#${c}`).join(", ")})` : ""}, ${routines} routines, ${params.skills.length} skills.`;
          // A personal workspace's card is "Create the agents", for their own agents (ADR 0159).
          const content = (await isPersonalWorkspace(ctx.db, ctx.orgId))
            ? `Posted the card of their agents: ${made} Nothing exists until a person creates them from the card: you'll be told. Say in one short line that it is ready to review.`
            : `Posted the team card: ${made} Nothing exists until a person clicks 'Criar o time': you'll be told. Say in one short line that it is ready to review.`;
          return { content, data: { actionCard: { messageId: message.id } } };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
}

/** The right hand's DM with this person, where a template's card goes. */
export async function rightHandDm(db: Database, orgId: string, userId: string) {
  const [lodi] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.builtin, RIGHT_HAND), isNull(agents.archivedAt)));
  if (!lodi) throw new NotFoundError("This workspace has no right hand", "right_hand.missing");
  return { lodi, dm: await openPersonAgentDm(db, orgId, userId, lodi.id) };
}

import { isAccountKind, type PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  notInArray,
  schema,
  sql,
} from "@agenteschat/db";
import { AUTO_MODEL } from "@agenteschat/providers";
import { orgToolCatalog, setAgentAccess } from "./access";
import { type Agent, createAgent, getAgent, HANDLE_PATTERN, NEW_AGENT_DEFAULTS, takenHandles } from "./agents";
import { type AiStatusDeps, agentAiState } from "./ai-status";
import { type AgentAppearance, setAgentAppearance, validateAppearance } from "./appearance";
import { canTalkTo, speakerFor } from "./audience";
import { setAgentBrain } from "./brain-settings";
import { requireChannelAccess } from "./channels";
import { prefixService, toolPrefixOf, toolPrefixOfConnection } from "./connectors/connections";
import { customScope, isCustom } from "./connectors/custom";
import { normalizeNote } from "./consultations";
import { type ContextDeps, schedulesOf } from "./context/summaries";
import { publishDelivery } from "./delivery";
import { openPersonAgentDm } from "./dms";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishAgentsChanged, publishChannelEvent } from "./events";
import { setAgentComputerTarget } from "./machines";
import { DEFAULT_MAIL_POLICY, setAgentMail } from "./mail/policies";
import { setAgentChannels } from "./management";
import { getMessage, type Message } from "./messages";
import type { Notice } from "./notices";
import { notify, resolveNotifications } from "./notifications";
import { can, getMembership, requirePermission } from "./organizations";
import { maySql, type RolePermission } from "./permissions";
import { type RoutineAccess, type RoutineReport, routineAccessOf, routineReportOf } from "./routine-brief";
import { checkFrequency, createRoutine, routineTimezone } from "./routines";
import type { ScheduleRule } from "./rrule";
import { deliverNoticeToRun } from "./run-resume";
import { parseSchedule } from "./schedule";
import { isPersonalWorkspace } from "./workspace-mode";

const {
  agentRuns,
  agentScopes,
  agents,
  channelMembers,
  channels,
  connectorConnections,
  contextProposals,
  machineAccounts,
  machines,
  mailAccounts,
  messages,
  notifications,
  organizationMembers,
  users,
} = schema;

/** A proposal card's `bodyCode` (the apps say it with `chat.body.agent_proposal`). */
export const AGENT_PROPOSAL_CARD = "agent_proposal";

/**
 * The AI a proposed agent starts with (ADR 0081): an account of the person it is for that thinks for no agent,
 * else the workspace's model when it has a key, else none (connected after it is created).
 */
export type SuggestedAi =
  | {
      kind: "account";
      brain: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
      machineId: string;
      accountId: string;
      label: string;
    }
  | { kind: "model" }
  | { kind: "none" };

/** What the agent proposes, as the create-agent screen takes it. */
export interface AgentDraft {
  name: string;
  handle: string;
  role: string;
  instructions: string;
  /** Its look (the app's allow-list); null: the app's default. */
  appearance: AgentAppearance | null;
  /**
   * Channels it joins: public ones, and private ones of the person who asked that everyone who reads the card is in
   * (`offerableChannels`).
   */
  channelIds: string[];
  /** Its access to the workspace's connections (connected apps). */
  access: { connectionId: string; level: "read" | "write" }[];
  /** Mailboxes of the person who asked (ADR 0038): only a mailbox's owner gives an agent access to it. */
  mail?: ProposedMailbox[];
  /** A routine of its own, created with it (none on cards from before routines came with proposals). */
  routine?: ProposedRoutine | null;
  ai: SuggestedAi;
}

export interface ProposedMailbox {
  accountId: string;
  address: string;
  level: "read" | "write";
  /** Who connected it: the only one who gives an agent access to it. */
  ownerUserId: string;
}

/** The routine a proposal comes with, read when it was proposed: created as it is, nothing read again. */
export interface ProposedRoutine {
  name: string;
  /** What each run is told. */
  prompt: string;
  /** The schedule as the agent wrote it ("todo dia ao meio-dia", a cron). */
  schedule: string;
  /** The schedule read in the asker's time zone; null for a cron no rule holds (then `cron`). */
  rule: ScheduleRule | null;
  cron: string;
  timezone: string;
  /** When it runs, in English, for the agent (the apps say `rule` in the reader's language). */
  description: string;
  report: RoutineReport;
  access: RoutineAccess;
  /** The channel it reports in, which the agent must be in first (null: the creator's DM; absent on older cards). */
  reportsIn?: string | null;
}

/** What "Criar" on the card gave the agent of its draft (the rest waits for whoever may give it). */
export interface ProposalApplied {
  channelIds: string[];
  connectionIds: string[];
  mailAccountIds: string[];
}

/** `superseded`: a newer card of the same agent, for the same handle in the same conversation, took its place. */
export type AgentProposalState = "pending" | "creating" | "created" | "denied" | "superseded";

/**
 * `meta.actionCard` of an agent's proposal of a new agent (ADR 0081). Unlike the Connect card it keeps its
 * state: what a person decided can't come from live data. Only the decision routes write it, each from the
 * state it expects (`creating` holds it while the agent is made).
 */
export interface AgentProposalCard {
  kind: "agent_proposal";
  /** The person behind the run that proposed it; null when nobody was. */
  forUserId: string | null;
  /** `firstTask`: what "Criar e testar" puts in the composer of the clicker's DM with the new agent (ADR 0137). */
  params: { draft: AgentDraft; why: string; firstTask?: string };
  state: AgentProposalState;
  /** The agent made from it. */
  agentId: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  /** Past it, a pending proposal is expired (not stored). */
  expiresAt: string;
  /** Created in one click ("Criar" on the card): the lines it got. Absent when it was created from the review. */
  applied?: ProposalApplied;
  /** The routine made with it. */
  routineId?: string | null;
  /**
   * When the person it is for, who can't create agents, sent it to whoever may ("Pedir a um admin", ADR 0137): from
   * then on they may open the card from their inbox, though they aren't in its conversation.
   */
  askedAt?: string;
}

export interface AgentProposalView extends AgentProposalCard {
  messageId: string;
  channelId: string;
  threadId: string | null;
  proposedByAgentId: string;
  expired: boolean;
  /** The viewer may create it or say no (it is open and they may create agents). */
  canDecide: boolean;
}

export interface AgentProposalDeps {
  db: Database;
  pubsub?: PubSub;
}

export const agentProposalOf = (meta: Record<string, unknown> | null | undefined): AgentProposalCard | null => {
  const card = meta?.actionCard as Partial<AgentProposalCard> | undefined;
  return card?.kind === "agent_proposal" && card.params?.draft ? (card as AgentProposalCard) : null;
};

const expired = (card: AgentProposalCard, now = Date.now()) =>
  card.state === "pending" && Date.parse(card.expiresAt) <= now;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/** What the tool takes (the Tool Gateway already checked its JSON Schema). */
export interface AgentDraftInput {
  name?: unknown;
  handle?: unknown;
  role?: unknown;
  instructions?: unknown;
  look?: unknown;
  channels?: unknown;
  access?: unknown;
  routine?: unknown;
}

/** Where a draft is proposed: what it may name depends on who asked and who reads the card. */
export interface DraftPlace {
  orgId: string;
  /** The conversation the card goes in. */
  channelId: string;
  /** The person behind the run: their private channels, their mailboxes, their time zone. */
  personId: string | null;
}

/** What a draft may name here: channels, the workspace's connected apps, the asker's own mailboxes. */
interface Offer {
  channels: { id: string; name: string }[];
  apps: { id: string; connector: string; label: string; toolPrefix: string }[];
  mailboxes: { id: string; address: string; label: string; provider: string; ownerUserId: string }[];
  /** The conversation the card goes in, when it is a channel the agent can join (a routine reports there). */
  here: { id: string; name: string } | null;
}

/**
 * Every public channel, and the private ones of the person who asked that everyone who reads this conversation is in:
 * the card shows their names to its readers (a public conversation is anyone's to read, so none goes there).
 */
async function offerableChannels(db: Database, at: DraftPlace) {
  const all = await db
    .select({ id: channels.id, name: channels.name, visibility: channels.visibility })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, at.orgId),
        eq(channels.kind, "channel"),
        isNull(channels.dmKey),
        isNull(channels.archivedAt),
      ),
    )
    .orderBy(asc(channels.name));
  const open = all.filter((c) => c.visibility === "public");
  const closed = all.filter((c) => c.visibility !== "public");
  const [conversation] = await db
    .select({ kind: channels.kind, visibility: channels.visibility, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, at.orgId), eq(channels.id, at.channelId)));
  const publicHere =
    !conversation || (conversation.kind === "channel" && conversation.visibility === "public" && !conversation.dmKey);
  const person = at.personId;
  if (!person || closed.length === 0 || publicHere) return open;
  const people = await db
    .select({ channelId: channelMembers.channelId, userId: channelMembers.userId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.orgId, at.orgId),
        inArray(channelMembers.channelId, [at.channelId, ...closed.map((c) => c.id)]),
        isNotNull(channelMembers.userId),
      ),
    );
  const membersOf = (id: string) => new Set(people.filter((p) => p.channelId === id).map((p) => p.userId));
  const readers = membersOf(at.channelId);
  const shared = closed.filter((c) => {
    const members = membersOf(c.id);
    return members.has(person) && [...readers].every((r) => members.has(r));
  });
  return all.filter((c) => c.visibility === "public" || shared.includes(c));
}

async function offerOf(db: Database, at: DraftPlace): Promise<Offer> {
  const [named, apps, boxes] = await Promise.all([
    offerableChannels(db, at),
    db
      .select({
        id: connectorConnections.id,
        connector: connectorConnections.connector,
        label: connectorConnections.label,
        toolPrefix: connectorConnections.toolPrefix,
      })
      .from(connectorConnections)
      .where(and(eq(connectorConnections.orgId, at.orgId), isNull(connectorConnections.revokedAt)))
      .orderBy(asc(connectorConnections.createdAt)),
    at.personId
      ? db
          .select({
            id: mailAccounts.id,
            address: mailAccounts.address,
            label: mailAccounts.label,
            provider: mailAccounts.provider,
            ownerUserId: mailAccounts.createdByUserId,
          })
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.orgId, at.orgId),
              eq(mailAccounts.createdByUserId, at.personId),
              eq(mailAccounts.status, "active"),
              isNull(mailAccounts.revokedAt),
            ),
          )
          .orderBy(asc(mailAccounts.createdAt))
      : [],
  ]);
  return {
    channels: named.map(({ id, name }) => ({ id, name })),
    apps,
    mailboxes: boxes.flatMap((b) => (b.ownerUserId ? [{ ...b, ownerUserId: b.ownerUserId }] : [])),
    here: named.find((c) => c.id === at.channelId) ?? null,
  };
}

// A server by address (`custom:<id>`) goes by its name, which also tells its accounts apart.
const appName = (a: Offer["apps"][number]) => (isCustom(a) ? `"${a.label}"` : a.connector);

/** Everything a draft may name here, for the agent to get it right at once. */
const offerText = (o: Offer) =>
  [
    `Channels you can name here: ${o.channels.map((c) => `#${c.name}`).join(", ") || "none"}.`,
    `Connected apps: ${o.apps.map(appName).join(", ") || "none"}.`,
    o.mailboxes.length > 0
      ? `Mailboxes of the person who asked (in access, by address): ${o.mailboxes.map((m) => m.address).join(", ")}.`
      : "The person who asked has no mailbox connected: propose it without one and tell them to connect theirs.",
  ].join(" ");

/** Words that mean "my mailbox" when the asker has only one. */
const MAIL_WORDS = new Set(["mail", "email", "e-mail", "mailbox", "inbox", "emails", "e-mails"]);

/** One of the asker's mailboxes by its address or label, or by its kind ("gmail", "mail") when only one is. */
function mailboxNamed(boxes: Offer["mailboxes"], asked: string) {
  const exact = boxes.filter((b) => b.address.toLowerCase() === asked || b.label.toLowerCase() === asked);
  if (exact.length === 1) return exact[0];
  const kind = boxes.filter((b) => b.provider === asked || MAIL_WORDS.has(asked));
  return kind.length === 1 ? kind[0] : undefined;
}

/** A routine to create with the agent, read now in the asker's time zone. */
export async function checkRoutine(
  deps: { db: Database; context?: ContextDeps },
  at: DraftPlace,
  raw: unknown,
): Promise<ProposedRoutine> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!at.personId) {
    throw new ValidationError(
      "Only a person's request comes with a routine, and nobody is behind this run: propose the agent without it.",
    );
  }
  const prompt = str(r.prompt);
  if (!prompt) throw new ValidationError("Say in the routine's `prompt` what each run does.");
  const schedule = str(r.schedule);
  const timezone = await routineTimezone(deps.db, at.personId, at.orgId);
  const read = await parseSchedule(deps.context ? schedulesOf(deps.context) : null, {
    orgId: at.orgId,
    phrase: schedule,
    timezone,
  });
  if (!read.ok) {
    throw new ValidationError(
      `The routine's schedule: ${read.error} Write it as 5-field cron ("0 12 * * *"): words need the workspace's own model, which a workspace on a plan alone doesn't have.`,
    );
  }
  try {
    checkFrequency(
      {
        triggerType: "schedule",
        rule: read.rule as unknown as Record<string, unknown> | null,
        cron: read.cron,
        timezone: read.timezone,
      },
      { type: "dm" },
    );
  } catch (error) {
    throw new ValidationError(
      `The routine's schedule: ${error instanceof Error ? error.message : String(error)}. Propose one at most that often.`,
    );
  }
  return {
    name: str(r.title).slice(0, 120) || prompt.split("\n")[0]?.slice(0, 60) || "Routine",
    prompt: prompt.slice(0, 10_000),
    schedule,
    rule: read.rule,
    cron: read.cron,
    timezone: read.timezone,
    description: read.description,
    report: routineReportOf(r.report),
    access: routineAccessOf(r.access),
  };
}

/** An active agent a draft would repeat (`agentsLike`), and the draft's name. */
export interface AgentLike {
  draft: string;
  name: string;
  handle: string;
  role: string;
}

/**
 * Active agents that new ones would repeat: the same name, or the same role, case, accents and spacing aside. The
 * tools that propose agents post nothing then until the person says to make another (`also_new`), since a free
 * handle alone would put a second one on the team. One `personId` asked to remove, on a card still open, is on its
 * way out: starting the team over, its replacement is no repeat.
 */
export async function agentsLike(
  db: Database,
  orgId: string,
  drafts: { name?: unknown; role?: unknown }[],
  personId: string | null,
): Promise<AgentLike[]> {
  const leaving = personId
    ? sql`not exists (select 1 from ${contextProposals} where ${contextProposals.orgId} = ${agents.orgId}
        and ${contextProposals.agentId} = ${agents.id} and ${contextProposals.requestedByUserId} = ${personId}
        and ${contextProposals.status} = 'pending' and ${contextProposals.target} = 'agent_settings'
        and (${contextProposals.settings} @> '[{"field":"archive"}]' or ${contextProposals.settings} @> '[{"field":"delete"}]'))`
    : undefined;
  const team = await db
    .select({ name: agents.name, handle: agents.handle, role: agents.role })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNull(agents.deletedAt), leaving));
  const same = (have: string, asked: unknown) => {
    const plain = normalizeNote(have);
    return plain !== "" && plain === normalizeNote(str(asked));
  };
  return drafts.flatMap((d) => {
    const found = team.find((a) => same(a.name, d.name) || same(a.role, d.role));
    return found ? [{ draft: str(d.name), ...found }] : [];
  });
}

/** What a proposing tool answers when agents like its drafts exist: who they are, and to ask the person first. */
export function agentsLikeText(found: AgentLike[], tool: string) {
  const one = found.length === 1;
  const who = found
    .map(
      (a) =>
        `${a.name} (@${a.handle}${a.role ? `, ${a.role}` : ""})${normalizeNote(a.draft) === normalizeNote(a.name) ? "" : ` for ${a.draft}`}`,
    )
    .join(", ");
  const another = one ? "another" : "new ones";
  return `Not posted: ${one ? "an agent like this already exists" : "agents like these already exist"}: ${who}. Ask the person whether to change ${one ? "that one" : "those"} or make ${another}, then end your turn. Only once they say to make ${another}, call ${tool} again with also_new: true.`;
}

/**
 * The draft checked as the create-agent API checks an agent: the name, a free handle of the right shape, the
 * role, the instructions and the look; plus the channels it joins (by name: `offerableChannels`), its access to the
 * workspace's connected apps (by catalog id or name) and to the asker's mailboxes (by address), and a routine (its
 * schedule read now). What it can't name is refused with everything it can, so the agent gets it right the next
 * time. The AI is suggested apart (`suggestAgentAi`).
 */
export async function checkAgentDraft(
  deps: { db: Database; context?: ContextDeps },
  at: DraftPlace,
  input: AgentDraftInput,
): Promise<Omit<AgentDraft, "ai">> {
  const { db } = deps;
  const { orgId } = at;
  const name = str(input.name);
  if (!name || name.length > 80) throw new ValidationError("Give it a name of up to 80 characters.");
  const handle = str(input.handle).replace(/^@/, "").toLowerCase();
  if (!HANDLE_PATTERN.test(handle)) {
    throw new ValidationError("The handle must be 2–32 characters: lower-case letters, digits, - or _.");
  }
  if ((await takenHandles(db, orgId)).has(handle)) {
    throw new ValidationError(`@${handle} is already taken: pick another handle.`);
  }
  const role = str(input.role);
  const instructions = str(input.instructions);
  if (!instructions || instructions.length > 50_000) {
    throw new ValidationError("Say what it does in `instructions` (up to 50,000 characters).");
  }
  const appearance = input.look && typeof input.look === "object" ? validateAppearance(input.look) : null;

  const offer = await offerOf(db, { ...at, orgId });
  const wanted = [...new Set(list(input.channels).map((c) => str(c).replace(/^#/, "").toLowerCase()))].filter(Boolean);
  const unknownChannels = wanted.filter((n) => !offer.channels.some((c) => c.name === n));
  if (unknownChannels.length > 0) {
    throw new ValidationError(
      `No channel ${unknownChannels.map((n) => `#${n}`).join(", ")} you can name here. ${offerText(offer)}`,
    );
  }
  const access = new Map<string, "read" | "write">();
  const mail = new Map<string, ProposedMailbox>();
  for (const raw of list(input.access)) {
    const entry = (raw && typeof raw === "object" ? raw : {}) as { connector?: unknown; level?: unknown };
    const asked = str(entry.connector).trim().toLowerCase();
    const level = entry.level === "write" ? "write" : "read";
    // Its name ("Stripe (Acme)"), else the service: a catalog id, or the start of its tools' names (`stripe_2` is a
    // second Stripe account).
    const byName = offer.apps.filter((c) => c.label.toLowerCase() === asked);
    const service = toolPrefixOf(asked);
    const apps = byName.length
      ? byName
      : offer.apps.filter((c) => c.connector === asked || prefixService(toolPrefixOfConnection(c)) === service);
    if (apps.length > 1) {
      throw new ValidationError(
        `"${asked}" is connected more than once: name one of ${apps.map((c) => `"${c.label}"`).join(", ")}.`,
      );
    }
    const [app] = apps;
    const box = app ? undefined : mailboxNamed(offer.mailboxes, asked);
    if (app) access.set(app.id, level);
    else if (box) mail.set(box.id, { accountId: box.id, address: box.address, level, ownerUserId: box.ownerUserId });
    else throw new ValidationError(`No connected app or mailbox "${asked}". ${offerText(offer)}`);
  }
  const routine = input.routine ? await checkRoutine(deps, at, input.routine) : null;
  const channelIds = offer.channels.filter((c) => wanted.includes(c.name)).map((c) => c.id);
  // Its routine reports in this conversation: the agent is in it.
  if (routine && offer.here && !channelIds.includes(offer.here.id)) channelIds.push(offer.here.id);

  return {
    name,
    handle,
    role,
    instructions,
    appearance,
    channelIds,
    access: [...access].map(([connectionId, level]) => ({ connectionId, level })),
    mail: [...mail.values()],
    routine: routine && { ...routine, reportsIn: offer.here?.id ?? null },
  };
}

/**
 * The AI the draft suggests (ADR 0081): the first account of `userId`'s that thinks for no agent (an active
 * sign-in on a computer still there), else the workspace's model when a new agent on it would have a key, else
 * none. A plan thinks only for its owner's agents (ADR 0059 §3), so an account is suggested only to someone who
 * may create the agent and own it.
 */
export async function suggestAgentAi(
  deps: { db: Database; gateway?: AiStatusDeps["gateway"] },
  orgId: string,
  userId: string | null,
): Promise<SuggestedAi> {
  if (userId && (await mayCreateAgents(deps.db, orgId, userId))) {
    const used = deps.db
      .select({ id: agents.brainAccountId })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNotNull(agents.brainAccountId)));
    const [free] = await deps.db
      .select({
        id: machineAccounts.id,
        kind: machineAccounts.kind,
        label: machineAccounts.label,
        machineId: machineAccounts.machineId,
      })
      .from(machineAccounts)
      .innerJoin(machines, and(eq(machines.id, machineAccounts.machineId), isNull(machines.deletedAt)))
      .where(
        and(
          eq(machineAccounts.orgId, orgId),
          eq(machineAccounts.createdBy, userId),
          eq(machineAccounts.status, "active"),
          inArray(machineAccounts.kind, ["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"]),
          notInArray(machineAccounts.id, used),
        ),
      )
      .orderBy(asc(machineAccounts.createdAt))
      .limit(1);
    if (free) {
      return {
        kind: "account",
        brain: isAccountKind(free.kind) ? free.kind : "claude_code",
        machineId: free.machineId,
        accountId: free.id,
        label: free.label,
      };
    }
  }
  if (deps.gateway) {
    // A new agent as the create-agent screen makes it: "Automático" on the workspace's default key.
    const fresh: Parameters<typeof agentAiState>[1] = {
      orgId,
      model: AUTO_MODEL,
      credentialId: null,
      brain: "model",
      brainFallback: false,
      brainAccountId: null,
      machineId: null,
    };
    if ((await agentAiState({ db: deps.db, gateway: deps.gateway }, fresh)).state === "ready") return { kind: "model" };
  }
  return { kind: "none" };
}

/** Whether this person may create agents (`create_agents`), and so own the new one and give it their plan. */
export async function mayCreateAgents(db: Database, orgId: string, userId: string | null) {
  const membership = userId ? await getMembership(db, userId, orgId) : null;
  return can(membership, "create_agents");
}

/**
 * Whether someone who holds `permission` (by default, may create agents) can open this conversation, and so act on a
 * card in it (the decision routes read it as `requireChannelAccess` does): any of them in a public channel, which they
 * may join; in a DM or a private channel, only one of its members.
 */
export async function deciderCanOpen(
  db: Database,
  orgId: string,
  channelId: string,
  permission: RolePermission = "create_agents",
) {
  const [channel] = await db
    .select({ kind: channels.kind, visibility: channels.visibility, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, channelId)));
  if (!channel) return false;
  if (channel.kind === "channel" && channel.visibility === "public" && !channel.dmKey) return true;
  const members = await db
    .select({ may: maySql(orgId, channelMembers.userId, permission) })
    .from(channelMembers)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, channelMembers.orgId), eq(organizationMembers.userId, channelMembers.userId)),
    )
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId)));
  return members.some((m) => m.may);
}

/** The proposal behind a card message the viewer can read, or 404. */
async function proposalMessage(db: Database, userId: string, orgId: string, messageId: string) {
  const message = await getMessage(db, orgId, messageId);
  const card = message && !message.deletedAt && message.authorType === "agent" ? agentProposalOf(message.meta) : null;
  if (!message || !card || !message.authorAgentId) {
    throw new NotFoundError("Proposal not found", "agent_proposal.not_found");
  }
  const asked = card.askedAt ? await getMembership(db, userId, orgId) : null;
  const { membership } =
    asked && can(asked, "create_agents")
      ? { membership: asked }
      : await requireChannelAccess(db, userId, orgId, message.channelId);
  return { message, card, proposedBy: message.authorAgentId, membership };
}

const view = (
  message: Message,
  card: AgentProposalCard,
  proposedByAgentId: string,
  mayCreate: boolean,
): AgentProposalView => {
  const gone = expired(card);
  return {
    ...card,
    messageId: message.id,
    channelId: message.channelId,
    threadId: message.threadId,
    proposedByAgentId,
    expired: gone,
    canDecide: mayCreate && card.state === "pending" && !gone,
  };
};

/**
 * `GET …/agent-proposals/{messageId}`: the card's draft and state, for whoever reads its conversation. While the
 * viewer may decide, the AI is suggested for them, now: an account suggested to the asker is the asker's alone.
 */
export async function getAgentProposal(
  deps: { db: Database; gateway?: AiStatusDeps["gateway"] },
  userId: string,
  orgId: string,
  messageId: string,
) {
  const { message, card, proposedBy, membership } = await proposalMessage(deps.db, userId, orgId, messageId);
  const shown = view(message, card, proposedBy, can(membership, "create_agents"));
  if (!shown.canDecide) return shown;
  const draft = { ...card.params.draft, ai: await suggestAgentAi(deps, orgId, userId) };
  return { ...shown, params: { ...card.params, draft } };
}

/** Writes the card if it is still in state `from`: two people deciding at once, only one gets it. */
async function setCard(db: Database, message: Message, card: AgentProposalCard, from: AgentProposalState) {
  const [row] = await db
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
  return row !== undefined;
}

/** Only who may create agents decides (the create-agent rule), only while it is open. */
async function claim(
  deps: AgentProposalDeps,
  userId: string,
  orgId: string,
  messageId: string,
  to: "creating" | "denied",
) {
  const found = await proposalMessage(deps.db, userId, orgId, messageId);
  await requirePermission(deps.db, userId, orgId, "create_agents");
  // A crash between this claim and the agent leaves it `creating`, decided for good.
  const decided = () => new ConflictError("This proposal was already decided", "agent_proposal.decided");
  if (found.card.state !== "pending") throw decided();
  if (expired(found.card)) throw new ConflictError("This proposal expired", "agent_proposal.expired");
  const next: AgentProposalCard = {
    ...found.card,
    state: to,
    decidedByUserId: userId,
    decidedAt: new Date().toISOString(),
  };
  if (!(await setCard(deps.db, found.message, next, "pending"))) throw decided();
  return { ...found, card: next, before: found.card };
}

/**
 * Everyone in the conversation sees the card change; the agent that proposed it is told (a notice), with `got`: what
 * one click gave the new agent and what waits for someone else.
 */
async function settle(
  deps: AgentProposalDeps,
  found: { message: Message; card: AgentProposalCard; proposedBy: string },
  userId: string,
  agent: Agent | null,
  got?: string,
  /** The right hand's name when it decided for `userId` (ADR 0139). */
  by?: string,
) {
  const { message, card } = found;
  await resolveNotifications(deps, message.orgId, { groupKey: askGroup(message.id) }).catch(() => 0);
  await publishChannelEvent(deps.pubsub, {
    type: "agent.proposal.updated",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    state: card.state,
    agentId: card.agentId,
    decidedByUserId: card.decidedByUserId,
    decidedAt: card.decidedAt,
    ...(card.applied ? { applied: card.applied } : {}),
    ...(card.routineId ? { routineId: card.routineId } : {}),
  });
  const [run] = message.agentRunId
    ? await deps.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, message.orgId), eq(agentRuns.id, message.agentRunId)))
    : [];
  if (!run) return;
  const [person] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const who = by ? `${by}, on behalf of ${person?.name ?? "a person"},` : (person?.name ?? "A person");
  // A personal workspace has no team (ADR 0159): the agent joins its person's own.
  const personal = await isPersonalWorkspace(deps.db, message.orgId);
  const joined = personal ? "It is one of their agents now." : "It is on the team now.";
  const notice: Notice = {
    kind: "proposal_result",
    from: `Your proposal of the agent «${card.params.draft.name}»`,
    text: agent
      ? `${who} created it: @${agent.handle} (${agent.name}). ${joined}${got ? ` ${got}` : ""}`
      : `${who} said no. Don't propose it again unless someone asks.`,
    // `runId`: the run that proposed it, so what comes next is that run's work, for whoever is behind it.
    refs: { messageId: message.id, runId: run.id, ...(agent ? { agentId: agent.id } : {}) },
  };
  const delivered = await deps.db.transaction((tx) => deliverNoticeToRun(tx, run, notice));
  await publishDelivery(deps.pubsub, delivered).catch(() => {});
}

/**
 * Creates the agent a card proposed, with what the person edited (`create`, under their own permission: it
 * calls `createAgent` as them). The card is held while it runs and goes back to pending if it fails.
 */
export async function createAgentFromProposal(
  deps: AgentProposalDeps,
  userId: string,
  orgId: string,
  messageId: string,
  create: () => Promise<Agent>,
): Promise<Agent> {
  const found = await claim(deps, userId, orgId, messageId, "creating");
  let agent: Agent;
  try {
    agent = await create();
  } catch (error) {
    await setCard(deps.db, found.message, found.before, "creating");
    throw error;
  }
  const card: AgentProposalCard = { ...found.card, state: "created", agentId: agent.id };
  await setCard(deps.db, found.message, card, "creating");
  await settle(deps, { ...found, card }, userId, agent);
  return agent;
}

/** What creating a proposed agent in one click needs: its routine is published, its AI suggested. */
export interface ProposedAgentDeps {
  db: Database;
  pubsub: PubSub;
  gateway?: AiStatusDeps["gateway"];
}

/**
 * "Criar" on the card (ADR 0081 §7): the agent as proposed, created by the person who clicks, with each line of the
 * draft they may give it, each under its own rule: its AI (an account of theirs), its channels, its access to the
 * workspace's apps (an admin's), the mailboxes (only their owner's) and the routine (the agent's owner: them). A line
 * they can't give stays on the card for whoever can; the agent hears what it got and what waits.
 */
export async function createProposedAgent(
  deps: ProposedAgentDeps,
  userId: string,
  orgId: string,
  messageId: string,
  options: {
    test?: boolean;
    /**
     * The right hand approving for `userId` (ADR 0139): its name for the agent that proposed it, and the budget the
     * new agent gets (within their cap). It thinks with the workspace's key.
     */
    delegated?: { by: string; budgetNanoUsd: number };
  } = {},
) {
  const found = await claim(deps, userId, orgId, messageId, "creating");
  const { draft } = found.card.params;
  const { delegated } = options;
  let agent: Agent;
  try {
    agent = await createAgent(
      deps.db,
      userId,
      orgId,
      {
        name: draft.name,
        handle: draft.handle,
        role: draft.role,
        instructions: draft.instructions,
        ...(delegated ? { monthlyBudgetNanoUsd: delegated.budgetNanoUsd } : {}),
      },
      NEW_AGENT_DEFAULTS,
      { via: found.proposedBy, pubsub: deps.pubsub },
    );
    if (draft.appearance) agent = await setAgentAppearance(deps.db, userId, orgId, agent.id, draft.appearance, deps);
  } catch (error) {
    await setCard(deps.db, found.message, found.before, "creating");
    throw error;
  }
  const given = await giveLines(deps, userId, found.message, agent, draft, !!delegated);
  const card: AgentProposalCard = {
    ...found.card,
    state: "created",
    agentId: agent.id,
    applied: given.applied,
    routineId: given.routineId,
  };
  await setCard(deps.db, found.message, card, "creating");
  await settle(deps, { ...found, card }, userId, agent, given.said, delegated?.by);
  // "Criar e testar": their DM with it, where the app puts the first task in the composer. Never sent for them: the
  // right hand wrote it, and it would run with the clicker's permissions unread.
  const dm =
    options.test && found.card.params.firstTask ? await openPersonAgentDm(deps.db, orgId, userId, agent.id) : null;
  return {
    agent: (await getAgent(deps.db, orgId, agent.id)) ?? agent,
    proposal: view(found.message, card, found.proposedBy, true),
    /** The AI it got, which the clicker's accounts decide (not the one suggested when it was proposed). */
    ai: given.ai,
    /** "Criar e testar": the DM whose composer gets its first task. */
    testChannelId: dm?.id ?? null,
  };
}

/**
 * The routine a card proposed, for the agent created from it in the review (`POST …/agent-proposals/{id}/routine`),
 * once it is where the routine reports: created once, as the person who asks (the agent's owner or an admin).
 */
export async function createProposedRoutine(deps: ProposedAgentDeps, userId: string, orgId: string, messageId: string) {
  const found = await proposalMessage(deps.db, userId, orgId, messageId);
  const { message, card } = found;
  const routine = card.params.draft.routine;
  if (card.state !== "created" || !card.agentId || !routine) {
    throw new ConflictError("This proposal has no routine to create", "agent_proposal.no_routine");
  }
  // Held while it is made (two clicks make one), let go if it fails.
  const hold = (from: string | null, to: string | null) =>
    deps.db
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard,routineId}', ${JSON.stringify(to)}::jsonb)` })
      .where(
        and(
          eq(messages.id, message.id),
          eq(messages.orgId, orgId),
          from === null
            ? sql`coalesce(${messages.meta}->'actionCard'->>'routineId', '') = ''`
            : sql`${messages.meta}->'actionCard'->>'routineId' = ${from}`,
        ),
      )
      .returning({ id: messages.id });
  const MAKING = "making";
  if ((await hold(null, MAKING)).length === 0) {
    throw new ConflictError("Its routine was already created", "agent_proposal.routine_made");
  }
  let routineId: string;
  try {
    routineId = (await makeRoutine(deps, userId, message, card.agentId, routine)).id;
  } catch (error) {
    await hold(MAKING, null);
    throw error;
  }
  await hold(MAKING, routineId);
  const next: AgentProposalCard = { ...card, routineId };
  await publishChannelEvent(deps.pubsub, {
    type: "agent.proposal.updated",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    state: next.state,
    agentId: next.agentId,
    decidedByUserId: next.decidedByUserId,
    decidedAt: next.decidedAt,
    routineId,
  });
  return view(message, next, found.proposedBy, false);
}

/**
 * Where a proposed agent's routine reports: the conversation it was asked in when that is a channel (the agent is put
 * in it), else the creator's DM with the agent. Its schedule as it was read when proposed.
 */
async function makeRoutine(
  deps: ProposedAgentDeps,
  userId: string,
  message: Message,
  agentId: string,
  r: ProposedRoutine,
) {
  const [here] = await deps.db
    .select({ kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.orgId, message.orgId), eq(channels.id, message.channelId)));
  return createRoutine({ db: deps.db, pubsub: deps.pubsub }, userId, message.orgId, {
    name: r.name,
    agentId,
    prompt: r.prompt,
    target:
      here?.kind === "channel"
        ? { type: "conversation", channelId: message.channelId, threadId: message.threadId, reminder: false }
        : { type: "dm" },
    trigger: r.rule ? { type: "schedule", rule: r.rule } : { type: "schedule", phrase: r.cron, timezone: r.timezone },
    access: r.access,
    report: r.report,
  });
}

/** A connection's read level: its read scopes no sensitive tool needs (as `connectorResource` in the apps' access levels). */
const readScopesOf = (c: Awaited<ReturnType<typeof orgToolCatalog>>[number]) =>
  c.custom
    ? [customScope(c.connectionId, "read")]
    : c.scopes.filter((s) => /[.:]read$/.test(s.scope) && !s.tools.some((t) => t.sensitive)).map((s) => s.scope);

/**
 * The new agent's apps at their levels, in one save through the access API's own rule (giving access: an admin). An
 * app the lines don't name starts at "Ler e escrever", as every agent got it when it was connected
 * (`grantToEveryAgent`); a custom server's account starts with none, as on the new-agent page (`presetLevels`).
 */
export async function giveApps(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  lines: AgentDraft["access"],
) {
  const [catalog, own] = await Promise.all([
    orgToolCatalog(db, orgId),
    db
      .select({ scope: agentScopes.scope })
      .from(agentScopes)
      .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId), isNull(agentScopes.connectionId))),
  ]);
  const input = {
    all: false,
    connectors: {} as Record<string, boolean>,
    scopes: own.map((g) => ({ connectionId: null as string | null, scope: g.scope })),
    tools: { allow: [], deny: [] },
  };
  const given: string[] = [];
  for (const line of lines) {
    const c = catalog.find((x) => x.connectionId === line.connectionId);
    if (!c) continue;
    if (line.level === "write") input.connectors[c.connectionId] = true;
    else for (const scope of readScopesOf(c)) input.scopes.push({ connectionId: c.connectionId, scope });
    given.push(c.connectionId);
  }
  const opened = catalog.filter((c) => !c.custom && !given.includes(c.connectionId));
  for (const c of opened) {
    input.connectors[c.connectionId] = true;
    given.push(c.connectionId);
  }
  if (given.length > 0) await setAgentAccess(db, userId, orgId, agentId, input);
  return { given, opened: opened.map((c) => c.label) };
}

/**
 * Gives the new agent each line of its draft that `userId` may give, one by one (one refused leaves the others), and
 * says to the agent that proposed it what it got and what waits for whom. `apiOnly`: it thinks with the workspace's
 * key, never a plan of theirs (the right hand creating it for them, ADR 0139).
 */
async function giveLines(
  deps: ProposedAgentDeps,
  userId: string,
  message: Message,
  agent: Agent,
  draft: AgentDraft,
  apiOnly = false,
) {
  const { db } = deps;
  const orgId = message.orgId;
  const attempt = async <T>(step: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await step() };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  };
  // Its AI: an account of this person's that thinks for no agent (a plan thinks only for its owner's agents).
  const ai: SuggestedAi = apiOnly ? { kind: "model" } : await suggestAgentAi(deps, orgId, userId);
  const thinks =
    ai.kind !== "account" ||
    (
      await attempt(async () => {
        await setAgentComputerTarget(deps, userId, orgId, agent.id, ai.machineId);
        await setAgentBrain(deps, userId, orgId, agent.id, { brain: ai.brain, account: ai.accountId });
        // Who may talk to it moves with its AI, after the apps read it as it was made.
        await publishAgentsChanged(deps.pubsub, orgId);
      })
    ).ok;
  // Its channels, as the review puts them (an admin's): all of them or none.
  const joined =
    draft.channelIds.length > 0
      ? await attempt(() =>
          setAgentChannels(
            db,
            userId,
            orgId,
            agent.id,
            draft.channelIds.map((channelId) => ({ channelId })),
            { pubsub: deps.pubsub },
          ),
        )
      : null;
  const channelIds = joined?.ok ? draft.channelIds : [];
  const apps = await attempt(() => giveApps(db, userId, orgId, agent.id, draft.access));
  const connectionIds = apps.ok ? apps.value.given : [];
  const mailAccountIds: string[] = [];
  // Only a mailbox's owner gives an agent access to it.
  for (const box of draft.mail ?? []) {
    if (box.ownerUserId !== userId) continue;
    const given = await attempt(() =>
      setAgentMail(db, userId, orgId, agent.id, box.accountId, {
        level: box.level === "write" ? "read_write" : "read",
        canDelete: false,
        policy: DEFAULT_MAIL_POLICY,
      }),
    );
    if (given.ok) mailAccountIds.push(box.accountId);
  }
  const routine = draft.routine
    ? await attempt(() => makeRoutine(deps, userId, message, agent.id, draft.routine as ProposedRoutine))
    : null;

  // In words, for the agent that proposed it.
  const mail = draft.mail ?? [];
  // A plan thinks only for its owner's agents: a mailbox's owner who can't talk to it can't give it either, yet.
  const now = (await getAgent(db, orgId, agent.id)) ?? agent;
  const unheard = new Set<string>();
  for (const m of mail) {
    if (
      !mailAccountIds.includes(m.accountId) &&
      !canTalkTo(now, m.ownerUserId, await speakerFor(db, orgId, m.ownerUserId))
    )
      unheard.add(m.ownerUserId);
  }
  const [named, connected, owners] = await Promise.all([
    draft.channelIds.length > 0
      ? db.select({ id: channels.id, name: channels.name }).from(channels).where(inArray(channels.id, draft.channelIds))
      : [],
    draft.access.length > 0
      ? db
          .select({ id: connectorConnections.id, label: connectorConnections.label })
          .from(connectorConnections)
          .where(
            inArray(
              connectorConnections.id,
              draft.access.map((a) => a.connectionId),
            ),
          )
      : [],
    mail.length > 0
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(
            inArray(
              users.id,
              mail.map((m) => m.ownerUserId),
            ),
          )
      : [],
  ]);
  const channelName = (id: string) => `#${named.find((c) => c.id === id)?.name ?? "?"}`;
  const appName = (id: string) => connected.find((c) => c.id === id)?.label ?? "an app";
  const reads = (level: "read" | "write") => (level === "write" ? "reads and writes" : "reads");
  const got = [
    ...channelIds.map((id) => `joined ${channelName(id)}`),
    ...draft.access
      .filter((a) => connectionIds.includes(a.connectionId))
      .map((a) => `${reads(a.level)} ${appName(a.connectionId)}`),
    ...(apps.ok ? apps.value.opened.map((label) => `reads and writes ${label}`) : []),
    ...mail
      .filter((m) => mailAccountIds.includes(m.accountId))
      .map((m) => `${reads(m.level)} the mailbox ${m.address}`),
    ...(routine?.ok ? [`has its routine «${draft.routine?.name}» (${draft.routine?.description})`] : []),
  ];
  const waits = [
    ...draft.channelIds.filter((id) => !channelIds.includes(id)).map((id) => `${channelName(id)} (an admin)`),
    ...draft.access
      .filter((a) => !connectionIds.includes(a.connectionId))
      .map((a) => `${appName(a.connectionId)} (an admin)`),
    ...mail
      .filter((m) => !mailAccountIds.includes(m.accountId))
      .map((m) => {
        const owner = owners.find((o) => o.id === m.ownerUserId)?.name ?? "its owner";
        return unheard.has(m.ownerUserId)
          ? `the mailbox ${m.address} (only ${owner} gives it, once it answers ${owner}: it thinks with its owner's plan, so its owner lets ${owner} talk to it first)`
          : `the mailbox ${m.address} (only ${owner} gives it)`;
      }),
  ];
  const said = [
    got.length > 0 ? `It ${got.join(", ")}.` : "",
    waits.length > 0 ? `Not given yet: ${waits.join(", ")}.` : "",
    routine && !routine.ok ? `Its routine wasn't created: ${routine.error}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    applied: { channelIds, connectionIds, mailAccountIds },
    routineId: routine?.ok ? routine.value.id : null,
    said,
    ai: thinks ? ai.kind : ("none" as const),
  };
}

/**
 * A newer card of the same agent for the same handle, in the same conversation, takes the place of the open ones
 * before it ("Trocada pela proposta mais nova"): the person revised what they need. Cards for other handles stay,
 * so a whole team proposed at once keeps every card.
 */
export async function supersedeOlderProposals(deps: AgentProposalDeps, newer: Message, handle: string) {
  if (!newer.authorAgentId) return;
  const older = await deps.db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, newer.orgId),
        eq(messages.channelId, newer.channelId),
        eq(messages.authorAgentId, newer.authorAgentId),
        sql`${messages.id} <> ${newer.id}`,
        sql`${messages.meta}->'actionCard'->>'kind' = 'agent_proposal'`,
        sql`${messages.meta}->'actionCard'->>'state' = 'pending'`,
        sql`${messages.meta}->'actionCard'->'params'->'draft'->>'handle' = ${handle}`,
        isNull(messages.deletedAt),
      ),
    );
  for (const m of older) {
    const card = agentProposalOf(m.meta);
    if (!card || !(await setCard(deps.db, m, { ...card, state: "superseded" }, "pending"))) continue;
    await resolveNotifications(deps, m.orgId, { groupKey: askGroup(m.id) });
    await publishChannelEvent(deps.pubsub, {
      type: "agent.proposal.updated",
      channelId: m.channelId,
      threadId: m.threadId,
      messageId: m.id,
      state: "superseded",
      agentId: null,
      decidedByUserId: null,
      decidedAt: null,
    });
  }
}

const ASK_GROUP = "change_request:agent:";
const askGroup = (messageId: string) => `${ASK_GROUP}${messageId}`;

/**
 * Closes the inbox entries of sent cards that ran out or are gone (expiry is read, never stored), so no admin is left
 * waiting on a card nobody can create any more. Oldest first.
 */
export async function expireAgentProposalAsks(deps: { db: Database; pubsub?: PubSub }) {
  // ponytail: 200 open asks per tick, oldest first; page through them if a workspace ever holds more.
  const open = await deps.db
    .select({ orgId: notifications.orgId, groupKey: notifications.groupKey })
    .from(notifications)
    .where(
      and(
        eq(notifications.kind, "change_request"),
        isNull(notifications.doneAt),
        like(notifications.groupKey, `${ASK_GROUP}%`),
      ),
    )
    .groupBy(notifications.orgId, notifications.groupKey)
    .orderBy(sql`min(${notifications.createdAt})`)
    .limit(200);
  let closed = 0;
  for (const n of open) {
    const message = await getMessage(deps.db, n.orgId, n.groupKey.slice(ASK_GROUP.length));
    const card = message && !message.deletedAt ? agentProposalOf(message.meta) : null;
    if (card?.state === "pending" && !expired(card)) continue;
    closed += await resolveNotifications(deps, n.orgId, { groupKey: n.groupKey });
  }
  return closed;
}

/**
 * "Pedir a um admin" on a new agent's card (ADR 0137): the person it is for can't create agents, so it goes to
 * whoever may, as an inbox entry (waiting) that opens the card; their click creates it as them. Once per card.
 */
export async function askAgentProposal(deps: AgentProposalDeps, userId: string, orgId: string, messageId: string) {
  const found = await proposalMessage(deps.db, userId, orgId, messageId);
  const { message, card } = found;
  if (card.forUserId !== userId)
    throw new ForbiddenError("Only the person it was proposed for can send it", "agent_proposal.not_requester");
  if (card.state !== "pending") throw new ConflictError("This proposal was already decided", "agent_proposal.decided");
  if (expired(card)) throw new ConflictError("This proposal expired", "agent_proposal.expired");
  if (card.askedAt) throw new ConflictError("It was already sent", "agent_proposal.asked");
  if (can(found.membership, "create_agents"))
    throw new ConflictError("You can create it yourself", "agent_proposal.yours");
  const next: AgentProposalCard = { ...card, askedAt: new Date().toISOString() };
  const [row] = await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(next)}::jsonb)` })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.orgId, orgId),
        sql`${messages.meta}->'actionCard'->>'state' = 'pending'`,
        sql`not (${messages.meta}->'actionCard' ? 'askedAt')`,
      ),
    )
    .returning({ id: messages.id });
  if (!row) throw new ConflictError("It was already sent", "agent_proposal.asked");
  const deciders = await deps.db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), maySql(orgId, organizationMembers.userId, "create_agents")));
  await notify(deps, {
    orgId,
    userIds: deciders.map((d) => d.userId),
    kind: "change_request",
    groupKey: askGroup(message.id),
    waiting: true,
    actor: { type: "user", id: userId },
    source: { messageId: message.id, agentId: found.proposedBy, label: card.params.draft.name },
    latest: { text: card.params.why },
  }).catch(() => {});
  await publishChannelEvent(deps.pubsub, {
    type: "agent.proposal.updated",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    state: next.state,
    agentId: null,
    decidedByUserId: null,
    decidedAt: null,
    askedAt: next.askedAt,
  });
  return view(message, next, found.proposedBy, false);
}

/** "Recusar": the card stays, marked denied, and the agent that proposed it is told. */
export async function denyAgentProposal(deps: AgentProposalDeps, userId: string, orgId: string, messageId: string) {
  const found = await claim(deps, userId, orgId, messageId, "denied");
  await settle(deps, found, userId, null);
  return view(found.message, found.card, found.proposedBy, true);
}

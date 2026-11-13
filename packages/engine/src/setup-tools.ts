import { holdEvents, type PubSub } from "@agenteschat/adapters";
import { and, count, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { isKnownProvider, PROVIDERS } from "@agenteschat/providers";
import { actWithUndo, publishMessageActions } from "./agent-actions";
import {
  AGENT_PROPOSAL_CARD,
  type AgentProposalCard,
  agentsLike,
  agentsLikeText,
  checkAgentDraft,
  deciderCanOpen,
  mayCreateAgents,
  type SuggestedAi,
  suggestAgentAi,
  supersedeOlderProposals,
} from "./agent-proposals";
import { agentsByHandle, getAgentCached } from "./agents";
import type { AiStatusDeps } from "./ai-status";
import { AGENT_LOOK } from "./appearance";
import { listApprovals } from "./approvals";
import { addChannelMember, createChannel, listChannels } from "./channels";
import { findMember } from "./chat-tools";
import { CONNECTOR_CATALOG } from "./connectors/catalog";
import { connectorListing, type ServerCatalog } from "./connectors/listing";
import { MCP_PRESETS, presetForServer } from "./connectors/presets";
import { cardPlace, NO_PERSON_READS } from "./consultations";
import { ownWords } from "./context/learn";
import { decideProposal, proposeSettings, type SettingsProposalCard } from "./context/proposals";
import type { ContextDeps } from "./context/summaries";
import { publishMessageCreated } from "./events";
import { firstOf } from "./format";
import { insertMessage, messageView } from "./messages";
import { can, getMembership } from "./organizations";
import type { RolePermission } from "./permissions";
import { personBehindCall } from "./requester";
import { isRightHand } from "./right-hand";
import { queueRightHandLook } from "./right-hand-approvals";
import { bodyCode } from "./run-tools";
import { REPORT_SCHEMA, SCHEDULE_INPUT } from "./schedule-tools";
import { deletes, type WantedLine } from "./settings-proposals";
import { noAgentText } from "./team";
import { OFFER_ANSWERS_TOOL, PROPOSE_TEAM_SCHEMA_PERSONAL, PROPOSE_TEAM_TOOL, teamTools } from "./team-proposals";
import { SET_TEAM_WEEK_TOOL, setTeamWeekPrefs } from "./team-week";
import { OFFER_CONNECT_APP_TOOL } from "./tools/connector-first";
import { APPROVAL_TTL_MS } from "./tools/gateway";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";
import {
  actNow,
  changesThisRun,
  MAX_ACTIONS_PER_RUN,
  type ServerLinks,
  workspaceAction,
  workspaceActionTool,
} from "./workspace-actions";
import { isPersonalWorkspace } from "./workspace-mode";

const { agentActions, agentRuns, channels, machineAccounts, messages, orgRoles, skills } = schema;

/** The setup tools' scope: a tool group of its own, loaded when a message is about setting up (ADR 0043). */
export const SETUP_SCOPE = "setup:write";
export const OFFER_CONNECT_AI_TOOL = "offer_connect_ai";
export const CREATE_CHANNEL_TOOL = "create_channel";
export { OFFER_CONNECT_APP_TOOL };
export const PROPOSE_AGENT_TOOL = "propose_agent";
export const OFFER_INVITES_TOOL = "offer_invites";
/** Archiving or deleting teammates, one card for them all (ADR 0137 amendment): any agent with setup tools. */
export const PROPOSE_REMOVE_AGENTS_TOOL = "propose_remove_agents";
/** At most this many agents on one removal card. */
export const MAX_REMOVALS_PER_CARD = 20;
/** Teammates' settings on one card (ADR 0137): the right hand's, and any agent's with setup tools (ADR 0139). */
export const PROPOSE_SETTINGS_TOOL = "propose_settings_change";
/** An agent asking for its own settings on that card, in any run: every agent but the right hand (ADR 0137). */
export const REQUEST_SETTINGS_TOOL = "request_settings_change";
/** The right hand's cards for what a person does elsewhere in the app (ADR 0137 §4): no other agent has them. */
export const OFFER_APPROVALS_TOOL = "offer_approvals";
export const PROPOSE_MEMBER_CHANGES_TOOL = "propose_member_changes";
export const OFFER_OPEN_PAGE_TOOL = "offer_open_page";
/** At most this many approvals, or people's changes, on one card. */
export const MAX_ROWS_PER_CARD = 20;
/** The cards' `bodyCode`s (`chat.body.action_approvals`, `settings_proposal` with `names`, `action_open_page`). */
export const APPROVALS_CARD = "action_approvals";
export const MEMBER_CHANGES_CARD = "settings_proposal";
export const OPEN_PAGE_CARD = "action_open_page";
/**
 * The screens an "Abrir" card opens (`offer_open_page`), each with what it is for the model. The screen asks what
 * it always asks there (the email code and the typed name of a deletion, Stripe for billing, our dialogs for keys)
 * and checks the clicker's permissions. Mirrored in `@agenteschat/client/lib/app-pages` (their paths on the web and
 * the phone).
 */
export const APP_PAGES = {
  billing: "Billing: the plan, payment method and invoices (Stripe's checkout and portal open from there)",
  delete_workspace: "Deleting this workspace (owners): its email code, typed name and grace period",
  delete_account: "Deleting their whole account, not one workspace: it goes at once and for good after its email code",
  account: "Their profile, password and sign-in methods",
  ai_accounts: "AI accounts and API keys (Settings › AI and usage), typed only in our dialogs",
  workspace: "Workspace settings: name, logo, time zone and the context every agent reads",
  members: "People: members, invitations, requests to join",
  roles: "Roles and what each may do",
  audit: "The audit log",
  usage: "Usage and costs",
  computers: "Computers for the agents",
  task_manager: "Task manager: what each agent is doing now, what waits for room on the computer, stopping a task",
  connectors: "Apps, MCP servers, mailboxes and databases",
  skills: "Skills",
  storage: "File storage",
  notifications: "Their notifications",
  right_hand: "Your own settings (name, AI, budget, who may use you)",
  import: "Importing agents",
  approvals: "Approvals, waiting and decided",
  proposals: "Proposed changes to agents and the workspace context, waiting and decided (a tab of Approvals)",
  routines: "Routines",
  drive: "Drive (files)",
  wiki: "Wiki",
  issues: "Issues",
  calendar: "Calendar",
  vault: "The Vault: saved passwords and contact details, password managers, who may use each",
  ai_apps: "AI apps signed in to their account and their personal tokens (Settings › AI apps)",
  approval_settings: "Who approves for them while away, and whether you may approve for them (Settings › Approvals)",
  media: "GIFs and stickers for the workspace (Settings)",
  voice: "Voice messages and the speech key (Settings)",
  agent: "An agent's page (instructions, memory, access, its own delete): needs `agent`",
  channel: "A channel (its settings, members, archiving): needs `channel`",
} as const;
export type AppPage = keyof typeof APP_PAGES;
/** Who may use each screen, when not everyone (the screen still checks it). */
const PAGE_PERMISSION: Partial<Record<AppPage, RolePermission | "manage_owners">> = {
  billing: "manage_billing",
  delete_workspace: "manage_owners",
  workspace: "configure",
  roles: "manage_roles",
  audit: "view_audit",
  skills: "manage_agents",
  storage: "configure",
  right_hand: "manage_agents",
  import: "create_agents",
  media: "configure",
  voice: "configure",
};

/** What one run may make: enough for a request, never a flood (also all a prompt injection gets). */
export const MAX_CARDS_PER_RUN = 3;
/** The right hand sets a whole team up in one turn ("a team for my agency"): one card per agent, a few more. */
export const MAX_CARDS_PER_RUN_RIGHT_HAND = 10;
/** A settings card's `bodyCode` (`chat.body.settings_proposal`, with `names`). */
export const SETTINGS_PROPOSAL_CARD = "settings_proposal";
/** An agent's own settings card's `bodyCode` (`chat.body.settings_request`): no names, it is the author's. */
export const SETTINGS_REQUEST_CARD = "settings_request";
export const MAX_CHANNELS_PER_RUN = 5;
/** A Connect card's `bodyCode` (the apps say it with `chat.body.action_connect_ai`). */
export const CONNECT_AI_CARD = "action_connect_ai";
/** A connect-an-app card's `bodyCode` (`chat.body.action_connect_app`, with `name`); one with no name, `ADD_MCP_CARD`. */
export const CONNECT_APP_CARD = "action_connect_app";
export const ADD_MCP_CARD = "action_add_mcp";
/** An invite card's `bodyCode` (`chat.body.action_invite_people`). */
export const INVITE_CARD = "action_invite_people";
/** Addresses one invite card fills in. */
export const MAX_INVITES_PER_CARD = 20;

export type ConnectAiStep = "claude" | "chatgpt" | "api_key";

const STEPS: Record<ConnectAiStep, string> = {
  claude: "a Claude plan",
  chatgpt: "a ChatGPT plan",
  api_key: "an API key",
};

/**
 * `meta.actionCard` of an agent's card (ADR 0061): its button opens the app's own dialog, filled in. It
 * keeps no state: the app tells it's done from live data (its agents can think; for a plan, with that plan).
 */
export interface ActionCard {
  kind: "connect_ai";
  /** The person behind the run that offered it; null when nobody was. */
  forUserId: string | null;
  params: {
    /** The dialog's step; none = its first one (a plan or a key). */
    what?: ConnectAiStep;
    /** With `api_key`: the catalog provider. */
    provider?: string;
    /** The agents to connect; none = any agent the person may change. */
    agentIds: string[];
    /** The agent's line for the person, in their language. */
    why: string;
  };
}

/**
 * "Conectar Linear" or "Adicionar MCP": its button opens the app's own connect dialog, at the catalog entry (`connector`)
 * or at "connect by address" with `url` filled in (none: the person types it). Done from live data: a connection to it.
 */
export interface ConnectAppCard {
  kind: "connect_app";
  forUserId: string | null;
  params: { connector?: string; url?: string; why: string };
}

/** "Convidar pessoas": its button opens the app's invite dialog with the addresses filled in, as members. */
export interface InviteCard {
  kind: "invite_people";
  forUserId: string | null;
  params: { emails: string[]; why: string };
}

/** "Decidir aprovações": the approvals waiting for this person, each decided on the card as whoever clicks. */
export interface ApprovalsCard {
  kind: "approvals";
  forUserId: string;
  params: { approvalIds: string[]; why: string };
}

/**
 * One person's change on a people card: ownership, roles given or taken, or removal from the workspace. `name` as it
 * was then, so a removed person's row still reads who it was.
 */
export type MemberChangeRow = { userId: string; name: string } & (
  | { role: "owner" | "member" }
  | { addRoleIds: string[]; removeRoleIds: string[] }
  | { remove: true }
);

/** "Mudar pessoas": a row per change, applied with the members screen's own calls and confirmation. */
export interface MemberChangesCard {
  kind: "member_changes";
  forUserId: string;
  params: { rows: MemberChangeRow[]; why: string };
}

/** "Abrir …": opens one of the app's screens (`APP_PAGES`), at an agent or a channel for those two. */
export interface OpenPageCard {
  kind: "open_page";
  forUserId: string | null;
  params: { page: AppPage; agentId?: string; channelId?: string; why: string };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A catalog connector or one-click MCP server by its id or name ("GitHub", "google-drive"). With `server`, as this
 * server's "Adicionar conector" lists it, whether it connects here (`soon`: its vendor hasn't approved agentes.chat).
 */
export function catalogConnector(
  name: string,
  server?: ServerCatalog,
): { id: string; label: string; available: boolean; soon: boolean } | null {
  const key = slug(name);
  if (!key) return null;
  const all = server
    ? connectorListing(server)
    : [...Object.values(CONNECTOR_CATALOG), ...MCP_PRESETS].map((c) => ({ ...c, available: true, soon: false }));
  const hit = all.find((c) => slug(c.id) === key) ?? all.find((c) => slug(c.label) === key);
  return hit ? { id: hit.id, label: hit.label, available: hit.available, soon: hit.soon } : null;
}

/** Names of what "Adicionar conector" connects outside the catalog list: a mailbox (Email) or a database. */
const MAILBOX_NAMES = new Set([
  "email",
  "mail",
  "gmail",
  "outlook",
  "hotmail",
  "icloud",
  "yahoo",
  "imap",
  "mailbox",
  "inbox",
]);
const DATABASE_NAMES = new Set(["database", "db", "postgres", "postgresql", "banco", "bancodedados"]);

/** An MCP server's address as a card may carry it: https, with no user or password in it. */
export function mcpAddress(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether the person behind the run may do it themselves, and else whether someone who may can open the
 * conversation the card goes to (so the card is still of use): what the tool tells the agent to say.
 */
export async function whoActs(ctx: ToolContext, userId: string | null, permission: RolePermission, channelId: string) {
  const membership = userId ? await getMembership(ctx.db, userId, ctx.orgId) : null;
  if (can(membership, permission)) return "person" as const;
  return (await deciderCanOpen(ctx.db, ctx.orgId, channelId, permission)) ? ("admin_here" as const) : null;
}

/** A card with no place (`cardPlace`): nobody would see it. */
export const NOBODY_READS: ToolOutput = { content: NO_PERSON_READS, isError: true };
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
const noAgents = async (ctx: ToolContext, missing: string[]): Promise<ToolOutput> => ({
  content: await noAgentText(ctx, missing),
  isError: true,
});

export async function hopOf(ctx: ToolContext) {
  const [run] = await ctx.db.select({ hop: agentRuns.hop }).from(agentRuns).where(eq(agentRuns.id, ctx.runId));
  return run?.hop ?? 0;
}

/** What the right hand puts to the person for an answer: one a turn (`cardsLeft`). */
const ASKING_CARDS = ["connect_ai", "connect_app", "invite_people", "team_proposal"];

/**
 * The run's cards so far (Connect cards and proposals alike), or an error once it has made its share. `asks`: this
 * card waits on the person, and the right hand waits for one answer before the next thing (ADR 0137 §10), so a second
 * one in a turn tells it to stop, as no error: nothing failed, and the person can always type.
 */
export async function cardsLeft(ctx: ToolContext, asks = false): Promise<ToolOutput | null> {
  const here = and(eq(messages.orgId, ctx.orgId), eq(messages.agentRunId, ctx.runId));
  const [[made], [asked], self] = await Promise.all([
    ctx.db
      .select({ n: count() })
      .from(messages)
      .where(and(here, sql`${messages.meta} ? 'actionCard'`)),
    ctx.db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          here,
          or(sql`${messages.meta} ? 'replyChips'`, inArray(sql`${messages.meta}->'actionCard'->>'kind'`, ASKING_CARDS)),
        ),
      ),
    getAgentCached(ctx.db, ctx.orgId, ctx.agentId),
  ]);
  const rightHand = isRightHand(self);
  if (asks && rightHand && (asked?.n ?? 0) > 0) {
    return { content: "Not posted: one thing at a time. End your turn now and bring this up after they answer." };
  }
  const cap = rightHand ? MAX_CARDS_PER_RUN_RIGHT_HAND : MAX_CARDS_PER_RUN;
  return (made?.n ?? 0) >= cap ? { content: `You already offered ${cap} cards in this turn.`, isError: true } : null;
}

/** How the tool result names the suggested AI to the agent. */
const aiWords = (ai: SuggestedAi) =>
  ai.kind === "account"
    ? `${ai.label}, an account of theirs that thinks for no agent`
    : ai.kind === "model"
      ? "the workspace's model"
      : "none yet: the person connects one after creating it";

/**
 * Setting up the workspace from the chat, "anything the app can do" (ADR 0061 §8), under `setup:write`:
 * - `offer_connect_ai`: what needs a person's credentials or consent becomes a card in this conversation
 *   whose button opens the app's own dialog, filled in. The agent never holds a key or a sign-in.
 * - `create_channel`: internal and reversible, so it acts right away for the person who asked, with
 *   their rights, and the reply carries a receipt with Undo (archive).
 * - `propose_agent` (ADR 0081): a new agent is a card a person reviews, edits and creates (or says no to)
 *   with their own right to create agents. The tool creates nothing.
 */
export function createSetupToolSource(deps: {
  pubsub?: PubSub;
  /** The model gateway's key check, for the AI a proposed agent starts with. */
  ai?: { gateway: AiStatusDeps["gateway"] };
  /** Reads the schedule of the routine a proposed agent comes with (cron needs none). */
  context?: ContextDeps;
  /** What this server connects, so a card never offers a service it can't (none: the whole catalog). */
  catalog?: ServerCatalog;
  /** The server's address and secret, for the invitations the right hand's actions send. */
  server?: ServerLinks;
}): ToolSource {
  const tools: ToolDefinition[] = [
    {
      name: OFFER_CONNECT_AI_TOOL,
      description:
        "Offer to connect an AI with a card in this conversation: its Connect button opens the app's own dialog at that step (a Claude plan, a ChatGPT plan or an API key) for the agents you name. Use it when a person asks to connect or switch an AI ('usar meu plano do Claude', 'add my OpenAI key'), or when an agent has none. A person connects it in the dialog: never ask for keys, passwords or sign-in codes in the chat.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          what: {
            type: "string",
            enum: Object.keys(STEPS),
            description:
              "A Claude plan (Pro, Max, Ultra, Team, Enterprise), a ChatGPT plan (Plus, Pro, Business, Enterprise) or an API key. Gemini works only with an API key: Google's plans can't be used in other products. Leave it out when the person didn't say: the card offers them all.",
          },
          provider: {
            type: "string",
            enum: Object.keys(PROVIDERS),
            description: "With `api_key`: whose key it is.",
          },
          agents: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
            maxItems: 10,
            description:
              "@handles of the agents to connect (a plan thinks for one agent). Default: you, for a plan; for a key, none (keys are the organization's).",
          },
          why: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description: "One short line on the card for the person, in their language: why connect it.",
          },
        },
        required: ["why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const why = str(input.why).trim();
          if (!why) return { content: "Say in `why` why to connect it: one short line.", isError: true };
          const what = Object.hasOwn(STEPS, str(input.what)) ? (input.what as ConnectAiStep) : undefined;
          const provider = what === "api_key" && isKnownProvider(str(input.provider)) ? str(input.provider) : "";
          const named = await agentsByHandle(ctx.db, ctx.orgId, input.agents);
          if (named.missing.length > 0) return noAgents(ctx, named.missing);
          let targets = named.rows;
          if (targets.length === 0 && (what === "claude" || what === "chatgpt")) {
            const self = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
            if (self) targets = [{ id: self.id, handle: self.handle, name: self.name }];
          }
          const at = await cardPlace(ctx);
          if (!at) return NOBODY_READS;
          const full = await cardsLeft(ctx, true);
          if (full) return full;
          const card: ActionCard = {
            kind: "connect_ai",
            forUserId: await personBehindCall(ctx),
            params: {
              ...(what ? { what } : {}),
              ...(provider ? { provider } : {}),
              agentIds: targets.map((a) => a.id),
              why,
            },
          };
          const names = targets.map((a) => a.name).join(", ");
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            ...at,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Connect ${what ? STEPS[what] : "an AI"}${names ? ` for ${names}` : ""}: ${why}`,
            meta: { ...bodyCode(CONNECT_AI_CARD), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          return {
            content: `Posted the card${names ? ` for ${names}` : ""}: a person connects it from its button. Tell them in your reply; don't ask for keys or codes here.`,
            data: { actionCard: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: CREATE_CHANNEL_TOOL,
      description:
        "Create a channel when a person asks for one, with their rights, and add people (@handle, email or name) and agents (@handles) to it; the person who asked is always in it. No permission needed: the person sees it under your reply with Undo.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 81,
            description: "Lower-case letters, digits, - or _ (e.g. launch-q4), with or without #.",
          },
          topic: { type: "string", maxLength: 500, description: "What the channel is for." },
          people: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 20 },
          agents: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
            maxItems: 10,
            description: "Include yourself if you should be there.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const requester = await personBehindCall(ctx);
          if (!requester) return { content: "Only a person's request can create a channel.", isError: true };
          const [made] = await ctx.db
            .select({ n: count() })
            .from(agentActions)
            .where(
              and(
                eq(agentActions.orgId, ctx.orgId),
                eq(agentActions.runId, ctx.runId),
                eq(agentActions.kind, "channel.created"),
              ),
            );
          if ((made?.n ?? 0) >= MAX_CHANNELS_PER_RUN) {
            return { content: `You already created ${MAX_CHANNELS_PER_RUN} channels in this turn.`, isError: true };
          }
          const agents = await agentsByHandle(ctx.db, ctx.orgId, input.agents);
          if (agents.missing.length > 0) return noAgents(ctx, agents.missing);
          const people = new Map<string, string>();
          for (const who of Array.isArray(input.people) ? input.people.map(str) : []) {
            const matches = await findMember(ctx, who);
            if (matches.length === 0) return { content: `No one called "${who}" in this organization.`, isError: true };
            if (matches.length > 1) {
              const names = matches.map((m) => (m.handle ? `${m.name} (@${m.handle})` : m.name)).join(", ");
              return { content: `Several people match "${who}": ${names}. Ask which one.`, isError: true };
            }
            const [person] = matches;
            if (person && person.userId !== requester) people.set(person.userId, person.name);
          }
          const events = holdEvents(deps.pubsub);
          const channel = await actWithUndo(
            ctx,
            async (db) => {
              const created = await createChannel(
                db,
                requester,
                ctx.orgId,
                { name: str(input.name).trim().replace(/^#/, ""), topic: str(input.topic).trim() },
                events,
              );
              // Agents first: only they can be refused (their owner or an admin adds them), and a refusal
              // undoes the whole channel before anyone was told they're in it.
              for (const a of agents.rows) {
                await addChannelMember(db, requester, ctx.orgId, created.id, { agentId: a.id }, events);
              }
              for (const userId of people.keys()) {
                await addChannelMember(db, requester, ctx.orgId, created.id, { userId }, events);
              }
              return created;
            },
            (created) => ({
              kind: "channel.created",
              target: { type: "channel", id: created.id, title: created.name },
              params: { name: created.name },
              before: null,
              after: { name: created.name },
            }),
          );
          await events.flush();
          const members = [...people.values(), ...agents.rows.map((a) => `@${a.handle}`)];
          return {
            content: `Created #${channel.name}${members.length ? ` with ${members.join(", ")}` : ""}.`,
            data: { channel: { id: channel.id, name: channel.name } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: PROPOSE_AGENT_TOOL,
      description:
        "Propose a new agent for the team with one card in this conversation: a person creates it in one click (or reviews and edits it first), or says no. Use it when someone asks for a new agent or bot, or when work needs a role nobody on the team has. Put in this one call everything the request implies, so the agent works as soon as it is created: the channels it joins, its access to the connected apps and to the asker's own mailbox (by its address) when the job reads or sends their email, and `routine` when the job runs on a schedule ('todo dia ao meio-dia'). It creates nothing: never say the agent exists until you are told it was created. The card suggests an AI for it by itself.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80, description: "Its name, e.g. Ada." },
          handle: {
            type: "string",
            pattern: "^@?[a-z0-9][a-z0-9_-]{1,31}$",
            description: "Its @handle: 2–32 lower-case letters, digits, - or _ (e.g. ada).",
          },
          role: {
            type: "string",
            maxLength: 200,
            description:
              "What it does for the team, said plainly in the person's language (e.g. Email and calendar assistant).",
          },
          instructions: {
            type: "string",
            minLength: 1,
            maxLength: 50_000,
            description: "What it does and how: its standing instructions, in the person's language.",
          },
          look: {
            type: "object",
            properties: {
              color: { type: "string", enum: [...AGENT_LOOK.colors] },
              eyes: { type: "string", enum: [...AGENT_LOOK.eyes] },
              accessory: { type: "string", enum: [...AGENT_LOOK.accessories] },
            },
            required: ["color", "eyes"],
            additionalProperties: false,
          },
          channels: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 81 },
            maxItems: 20,
            description:
              "Channels it joins, by name (e.g. design): public ones, and private ones of the person who asked that everyone here is in (this conversation, when it should work here). Its routine's conversation is added by itself.",
          },
          access: {
            type: "array",
            items: {
              type: "object",
              properties: {
                connector: {
                  type: "string",
                  minLength: 1,
                  maxLength: 320,
                  description:
                    "A connected app (github, linear…) or a mailbox of the person who asked, by its address.",
                },
                level: { type: "string", enum: ["read", "write"] },
              },
              required: ["connector", "level"],
              additionalProperties: false,
            },
            maxItems: 20,
            description:
              "What it may use of the apps the workspace connected and of the asker's mailboxes. Writing that matters still asks a person. Only a mailbox's owner gives an agent access to it.",
          },
          routine: {
            type: "object",
            description:
              "Work it does on its own on a schedule, created with it: each run gets `prompt` and reports in this conversation (in a DM, in its creator's DM with it).",
            properties: {
              schedule: SCHEDULE_INPUT,
              prompt: {
                type: "string",
                minLength: 1,
                maxLength: 10_000,
                description: "What each run does, in the person's language.",
              },
              title: { type: "string", maxLength: 120 },
              report: REPORT_SCHEMA,
            },
            required: ["schedule", "prompt"],
            additionalProperties: false,
          },
          why: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description: "One short line on the card for the person, in their language: why this agent.",
          },
          first_task: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description:
              "A first thing for it to do, in the person's words and language: the card then offers 'Criar e testar', which creates it and sends this to it in the person's DM with it.",
          },
          also_new: {
            type: "boolean",
            description:
              "Only once the person said to make it although an agent like it already exists (this tool names it).",
          },
        },
        required: ["name", "handle", "instructions", "why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const why = str(input.why).trim();
          if (!why) return { content: "Say in `why` why this agent: one short line.", isError: true };
          const at = await cardPlace(ctx);
          if (!at) return NOBODY_READS;
          const full = await cardsLeft(ctx);
          if (full) return full;
          const forUserId = await personBehindCall(ctx);
          const like = input.also_new === true ? [] : await agentsLike(ctx.db, ctx.orgId, [input], forUserId);
          if (like.length > 0) return { content: agentsLikeText(like, PROPOSE_AGENT_TOOL) };
          // The right hand's card goes to whoever may create agents when the person who asked can't ("Pedir a um admin").
          const rightHand = isRightHand(await getAgentCached(ctx.db, ctx.orgId, ctx.agentId));
          if (!rightHand && !(await deciderCanOpen(ctx.db, ctx.orgId, at.channelId))) {
            return {
              content:
                "Nothing was posted: nobody who may create agents can open this conversation, so nobody could decide the card. Tell the person that an admin or owner creates agents: they can ask one, or ask you again in a public channel.",
              isError: true,
            };
          }
          const place = { orgId: ctx.orgId, channelId: at.channelId, personId: forUserId };
          const draft = {
            ...(await checkAgentDraft({ db: ctx.db, context: deps.context }, place, input)),
            ai: await suggestAgentAi({ db: ctx.db, gateway: deps.ai?.gateway }, ctx.orgId, forUserId),
          };
          const card: AgentProposalCard = {
            kind: "agent_proposal",
            forUserId,
            params: {
              draft,
              why,
              ...(str(input.first_task).trim() ? { firstTask: str(input.first_task).trim() } : {}),
            },
            state: "pending",
            agentId: null,
            decidedByUserId: null,
            decidedAt: null,
            expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
          };
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            ...at,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Proposed a new agent, ${draft.name}: ${why}`,
            meta: { ...bodyCode(AGENT_PROPOSAL_CARD, { name: draft.name }), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          await supersedeOlderProposals({ db: ctx.db, pubsub: deps.pubsub }, message, draft.handle);
          await queueRightHandLook(ctx.db, ctx.orgId, message.id, forUserId);
          const asks = rightHand
            ? " The person who asked can't create agents: the card lets them send it to an admin or owner, who creates it."
            : " The person who asked can't create agents: an admin or owner reviews it.";
          return {
            content: `Posted the proposal of ${draft.name} (@${draft.handle}). A person creates it from the card, in one click or after reviewing it: nothing exists until they do, and you'll be told what they decided and what it got.${(await mayCreateAgents(ctx.db, ctx.orgId, forUserId)) ? "" : asks}${draft.routine ? ` Its routine «${draft.routine.name}» runs: ${draft.routine.description}.` : ""} Suggested AI: ${aiWords(draft.ai)}.`,
            data: { agentProposal: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: PROPOSE_REMOVE_AGENTS_TOOL,
      description:
        "Propose archiving teammates (or deleting them for good) with one card in this conversation that lists them all: whoever may archive or delete agents applies it from the card as themselves, all at once or leaving some out, and archiving has Undo. A person who can't sends it from the card to an admin. Use it when someone asks to remove, archive, delete or start the team over ('apaga os outros agentes'). Never you or the workspace's assistant. Nothing changes until someone clicks: never say it is done. To rebuild the team after, propose the new agents with propose_agent.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
            minItems: 1,
            maxItems: MAX_REMOVALS_PER_CARD,
            description: "Their @handles.",
          },
          delete: {
            type: "boolean",
            description:
              "True only when the person asked to delete them for good (their instructions, memory and routines go; no Undo). Default: archive.",
          },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "One short line on the card, in the person's language: why.",
          },
        },
        required: ["agents", "reason"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const forUserId = await personBehindCall(ctx);
          if (!forUserId) return { content: "Only a person's request can propose removing agents.", isError: true };
          const reason = str(input.reason).trim();
          if (!reason) return { content: "Say in `reason` why: one short line.", isError: true };
          const field = input.delete === true ? "delete" : "archive";
          // An archived agent can still be deleted for good.
          const named = await agentsByHandle(ctx.db, ctx.orgId, input.agents, { archived: field === "delete" });
          if (named.missing.length > 0) return noAgents(ctx, named.missing);
          const left: string[] = [];
          const targets: { agentId: string; lines: WantedLine[] }[] = [];
          for (const row of named.rows) {
            if (row.id === ctx.agentId) left.push("you can't remove yourself");
            else if (isRightHand(await getAgentCached(ctx.db, ctx.orgId, row.id)))
              left.push(`@${row.handle} is the workspace's assistant and can't be archived or deleted`);
            else targets.push({ agentId: row.id, lines: [{ field, to: true }] });
          }
          if (targets.length === 0) return { content: `Nothing to propose: ${left.join("; ")}.`, isError: true };
          const at = await cardPlace(ctx);
          if (!at) return NOBODY_READS;
          const full = await cardsLeft(ctx);
          if (full) return full;
          const { proposals, skipped } = await proposeSettings(
            { db: ctx.db },
            { orgId: ctx.orgId, agentId: ctx.agentId, targets, rationale: reason, requesterId: forUserId },
          );
          if (proposals.length === 0) return { content: `Nothing to propose. ${skipped.join(" ")}`, isError: true };
          const card: SettingsProposalCard = {
            kind: "settings_proposal",
            forUserId,
            proposalIds: proposals.map((p) => p.id),
          };
          const who = proposals.map((p) => named.rows.find((r) => r.id === p.agentId)?.name ?? "").join(", ");
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            ...at,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Proposed ${field === "delete" ? "deleting" : "archiving"} ${who}: ${reason}`,
            meta: { ...bodyCode(SETTINGS_PROPOSAL_CARD, { names: who }), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          const decides = proposals.filter((p) => p.canDecide).length;
          const whoDecides =
            decides === proposals.length
              ? "the person who asked applies it from the card."
              : "the person who asked can't apply it all: the card lets them send it to an admin.";
          return {
            content: `Posted the card to ${field} ${who}; ${whoDecides} Nothing has changed yet.${[...left, ...skipped].length ? ` Left off: ${[...left, ...skipped].join("; ")}.` : ""} To ${(await isPersonalWorkspace(ctx.db, ctx.orgId)) ? "set up new agents" : "rebuild the team"}, propose the new agents now with propose_agent.`,
            data: { actionCard: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: OFFER_CONNECT_APP_TOOL,
      description:
        "Offer to connect an app or an MCP server with a card in this conversation: its button opens the app's own connect dialog (sign-in or key, then its tools and which agents use it). Use it when a person asks to connect a service ('conecta o Linear', 'connect https://mcp.acme.com/mcp', 'add an MCP', 'adicionar MCP'). Pass `app` for a service by name, or `url` for an MCP server's address. When they want an MCP server and gave no address, ask for it in one short line first, or post the card without one and its dialog asks. Never ask for keys, tokens or passwords in the chat: the person types them in the dialog.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "A service by name or id (GitHub, Linear, Notion…).",
          },
          url: {
            type: "string",
            minLength: 9,
            maxLength: 2000,
            description: "An MCP server's https address, as the person gave it.",
          },
          why: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description: "One short line on the card for the person, in their language: why connect it.",
          },
        },
        required: ["why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const why = str(input.why).trim();
          if (!why) return { content: "Say in `why` why to connect it: one short line.", isError: true };
          const rawUrl = str(input.url).trim();
          const url = rawUrl ? mcpAddress(rawUrl) : null;
          if (rawUrl && !url) {
            return {
              content:
                "That address can't be connected: it must start with https:// and carry no user or password. Ask the person for the server's https address.",
              isError: true,
            };
          }
          const app = str(input.app).trim();
          // A one-click server's address is that service: the card shows its name and icon.
          const preset = url ? presetForServer(url) : null;
          const listed = app && !url ? catalogConnector(app, deps.catalog) : null;
          const known = preset ? { id: preset.id, label: preset.label } : listed;
          if (app && !url && !listed) {
            const where = MAILBOX_NAMES.has(slug(app)) ? "Email" : DATABASE_NAMES.has(slug(app)) ? "Database" : null;
            return {
              content: where
                ? `This isn't connected with a card: a person who manages connectors does it in Settings › Connectors and MCPs › Add connector › ${where} (in Portuguese, Configurações › Conectores e MCPs › Adicionar conector › ${where === "Email" ? "Email" : "Banco de dados"}). Tell the person exactly this.`
                : `"${app}" isn't in the catalog. Ask the person for its MCP server's https address and pass it as \`url\`.`,
              isError: true,
            };
          }
          if (listed && !listed.available) {
            return {
              content: listed.soon
                ? `${listed.label} doesn't let agentes.chat connect in one click yet. If it gives an API key, ask the person for its MCP server's https address and pass it as \`url\` (the dialog asks for the key).`
                : `${listed.label} isn't available on this installation: whoever runs it has to turn it on first. Tell the person.`,
              isError: true,
            };
          }
          const at = await cardPlace(ctx);
          if (!at) return NOBODY_READS;
          const forUserId = await personBehindCall(ctx);
          const acts = await whoActs(ctx, forUserId, "manage_connectors", at.channelId);
          if (!acts) {
            return {
              content:
                "Nothing was posted: connecting apps is for admins, and none of them can open this conversation. Tell the person an admin connects it, and offer to ask one (request_approval, or in a channel an admin reads).",
              isError: true,
            };
          }
          const full = await cardsLeft(ctx, true);
          if (full) return full;
          const card: ConnectAppCard = {
            kind: "connect_app",
            forUserId,
            params: { ...(known ? { connector: known.id } : {}), ...(url && !preset ? { url } : {}), why },
          };
          const name = known?.label ?? (url ? new URL(url).host : null);
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            ...at,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Connect ${name ?? "an MCP server"}: ${why}`,
            meta: { ...(name ? bodyCode(CONNECT_APP_CARD, { name }) : bodyCode(ADD_MCP_CARD)), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          return {
            content: `Posted the card to connect ${name ?? "an MCP server"}: a person signs in or adds its key in the app's dialog, then picks its tools and which agents use it.${acts === "person" ? "" : " The person who asked can't connect apps: an admin here does it from the card. Say so, and offer to ask one."} Don't ask for keys or tokens here, and don't say it's connected until you can use its tools.`,
            data: { actionCard: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: OFFER_INVITES_TOOL,
      description:
        "Offer to invite people to the workspace with a card in this conversation: its button opens the app's invite dialog with these addresses filled in, as members. A person who may invite sends it there (and may change roles); you send nothing. Use it when someone asks to invite or add people by email.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          emails: {
            type: "array",
            items: { type: "string", minLength: 3, maxLength: 254 },
            minItems: 1,
            maxItems: MAX_INVITES_PER_CARD,
          },
          why: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description:
              "One short line on the card for the person, in their language: who they are or why invite them.",
          },
        },
        required: ["emails", "why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const why = str(input.why).trim();
          if (!why) return { content: "Say in `why` why to invite them: one short line.", isError: true };
          const emails = [
            ...new Set((Array.isArray(input.emails) ? input.emails : []).map((e) => str(e).trim().toLowerCase())),
          ];
          const bad = emails.filter((e) => !EMAIL.test(e));
          if (bad.length > 0) return { content: `Not an email address: ${bad.join(", ")}.`, isError: true };
          const forUserId = await personBehindCall(ctx);
          if (!forUserId) return { content: "Only a person's request can lead to invitations.", isError: true };
          const at = await cardPlace(ctx);
          if (!at) return NOBODY_READS;
          const acts = await whoActs(ctx, forUserId, "invite_people", at.channelId);
          if (!acts) {
            return {
              content:
                "Nothing was posted: the person who asked can't invite people, and nobody who can opens this conversation. Tell them an admin invites, and offer to ask one.",
              isError: true,
            };
          }
          const full = await cardsLeft(ctx, true);
          if (full) return full;
          const card: InviteCard = { kind: "invite_people", forUserId, params: { emails, why } };
          const message = await insertMessage(ctx.db, {
            orgId: ctx.orgId,
            ...at,
            author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
            body: `Invite ${emails.join(", ")}: ${why}`,
            meta: { ...bodyCode(INVITE_CARD), actionCard: card },
          });
          if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
          return {
            content: `Posted the invite card for ${emails.join(", ")}: nobody is invited until a person sends it from the dialog.${acts === "person" ? "" : " The person who asked can't invite: someone who may does it from the card. Say so."}`,
            data: { actionCard: { messageId: message.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  // Any agent that may set the team up proposes teammates' settings too: the right hand decides another agent's card
  // for the person who asked (ADR 0139), never its own.
  const all = [...tools, settingsTool(deps)];
  // The right hand changes its own settings with the card above; every other agent asks for its own here.
  const others = [...all, settingsTool(deps, true)];
  const rightHand = [
    ...all,
    ...rightHandCards(deps),
    ...teamTools({ ...deps, cardsLeft, hopOf }),
    workspaceActionTool({ ...deps, cardsLeft, hopOf }),
  ];
  return {
    name: "setup",
    // Only the right hand starts the rest of the app with cards (ADR 0137). A personal workspace reads them in its own
    // words (ADR 0159): the same tools, for one person and their agents, whose team card may leave an agent's channel
    // out (it lives in its DM with the person). Only words and that one field: a read that fails keeps the team's.
    tools: async (ctx) => {
      const listed = isRightHand(await getAgentCached(ctx.db, ctx.orgId, ctx.agentId)) ? rightHand : others;
      if (!(await isPersonalWorkspace(ctx.db, ctx.orgId).catch(() => false))) return listed;
      return listed.map((t) => {
        const description = SETUP_TOOLS_PERSONAL[t.name];
        const worded = description ? { ...t, description } : t;
        return t.name === PROPOSE_TEAM_TOOL ? { ...worded, inputSchema: PROPOSE_TEAM_SCHEMA_PERSONAL } : worded;
      });
    },
  };
}

/**
 * The setup tools as a personal workspace's agents read them (ADR 0159): one person, maybe their family, and their
 * agents. Each does what it does in a team workspace; only who it speaks of changes, and inviting is for when they ask.
 */
const SETUP_TOOLS_PERSONAL: Record<string, string> = {
  [PROPOSE_AGENT_TOOL]:
    "Propose a new agent for this person with one card in this conversation: a person creates it in one click (or reviews and edits it first), or says no. Use it when someone asks for a new agent or bot, or when work needs a role none of their agents has. Put in this one call everything the request implies, so the agent works as soon as it is created: its access to the connected apps and to the asker's own mailbox (by its address) when the job reads or sends their email, and `routine` when the job runs on a schedule ('todo dia ao meio-dia'). It lives in its DM with the person: leave `channels` out, unless they asked for it in a group conversation (a channel). It creates nothing: never say the agent exists until you are told it was created. The card suggests an AI for it by itself.",
  [PROPOSE_REMOVE_AGENTS_TOOL]:
    "Propose archiving agents (or deleting them for good) with one card in this conversation that lists them all: whoever may archive or delete agents applies it from the card as themselves, all at once or leaving some out, and archiving has Undo. A person who can't sends it from the card to an admin. Use it when someone asks to remove, archive, delete or start their agents over ('apaga os outros agentes'). Never you or the workspace's assistant. Nothing changes until someone clicks: never say it is done. To set up new agents after, propose them with propose_agent.",
  [OFFER_INVITES_TOOL]:
    "Offer to invite someone the person trusts (family, a partner, someone who helps them) to this workspace with a card in this conversation: its button opens the app's invite dialog with these addresses filled in, as members. A person who may invite sends it there (and may change roles); you send nothing. Use it when they ask to invite or add someone by email, never on your own.",
  [SET_TEAM_WEEK_TOOL]:
    "Stop, start again or move the card you post in this person's DM: the weekly look at how their agents did (Fridays at 17h in the workspace's time zone), or 'Resumo do dia', the same card every day at an hour ('me manda isso todo dia às 9h'). Use it when they ask you to stop it, send it again, or on another day or hour. It changes only their card.",
  [PROPOSE_SETTINGS_TOOL]:
    "Change agents' settings with one card in this conversation: the model, the AI account it thinks with, its monthly budget, its owner, who may talk to it, the channels it joins or leaves and whether it answers there without a mention, the skills it has on, its name, its look, who it reports to, or archiving it. A change the person who asked may make, with nothing read from outside this turn, applies at once with Undo. Any other waits on the card for who may make it, and one they can't make they send from there. The result says which: never say it is done before it does. Instructions, a role or apps go through propose_instruction_change.",
  [OFFER_ANSWERS_TOOL]:
    "Ask the person one short question with answers to tap under it, in this conversation: each tap sends the answer as their own message (several at once with `multiple`), and they can always type instead. Use it for the questions that set their agents up (what they want help with, what takes most of their time, when they want to hear from their agents), one per turn, with `step` and `of` ('Pergunta 2 de 3'). The question shows as your message: write nothing else in this turn and end it. Their answer comes as their next message.",
  [PROPOSE_TEAM_TOOL]:
    "Propose several agents for this person with ONE card in this conversation: each agent with its face, name, role, a line on what it does, 1 to 3 routines, plus 1 or 2 skills, a line on what waits for the person's approval and your own weekly look at how their agents did. Each agent lives in its DM with the person, where its routines report: leave its `channel` out, unless they asked for a group conversation for it (a new channel is then created with them). Whoever may create agents creates them all in one click on the card, adjusts an agent first or dismisses it. Use it to set up or redo their agents (2 to 4 agents usually), never one propose_agent card per agent then. Nothing exists until they click: never say it does. A newer card here replaces the open one.",
};

/** Posts an agent's card where it goes (`cardPlace`) and announces it. */
async function postCard(
  deps: { pubsub?: PubSub },
  ctx: ToolContext,
  at: { channelId: string; threadId: string | null },
  body: string,
  meta: Record<string, unknown>,
): Promise<string> {
  const message = await insertMessage(ctx.db, {
    orgId: ctx.orgId,
    ...at,
    author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
    body,
    meta,
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message.id;
}

/** A custom role by name, or the names there are. */
async function rolesByName(ctx: ToolContext, wanted: string[]): Promise<string[] | string> {
  if (wanted.length === 0) return [];
  const rows = await ctx.db
    .select({ id: orgRoles.id, name: orgRoles.name })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, ctx.orgId), eq(orgRoles.kind, "custom")));
  const picked = wanted.map((r) => rows.find((x) => x.name.toLowerCase() === r.toLowerCase()));
  return picked.every(Boolean)
    ? picked.map((r) => r?.id ?? "")
    : `No role ${wanted.filter((_, i) => !picked[i]).join(", ")}. Roles here: ${rows.map((r) => r.name).join(", ") || "none"}.`;
}

/**
 * What a person does elsewhere in the app, started by the right hand as a card (ADR 0137 §4): the approvals waiting
 * for them, people's ownership, roles and removal, and every other screen by an "Abrir" card. Each is applied by
 * whoever clicks, checked at the click, with the confirmation that screen asks for; it decides and moves nothing itself.
 */
function rightHandCards(deps: { pubsub?: PubSub }): ToolDefinition[] {
  return [
    {
      name: OFFER_APPROVALS_TOOL,
      description:
        "Show the approvals waiting for this person (an agent's merge, deploy, email…) as one card in this conversation: they approve or refuse each there, as themselves. Use it when they ask what waits for them or to approve something. You never decide one yourself.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 64 },
            maxItems: 10,
            description: "Only these agents' (@handles). Default: all.",
          },
          why: { type: "string", minLength: 1, maxLength: 300, description: "One short line on the card." },
        },
        required: ["why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const forUserId = await personBehindCall(ctx);
          if (!forUserId) return { content: "Only a person's request shows their approvals.", isError: true };
          const named = await agentsByHandle(ctx.db, ctx.orgId, input.agents);
          if (named.missing.length > 0) return noAgents(ctx, named.missing);
          const only = new Set(named.rows.map((a) => a.id));
          const waiting = (await listApprovals(ctx.db, forUserId, ctx.orgId, { status: "pending", limit: 200 }))
            .filter((a) => a.canDecide && (only.size === 0 || only.has(a.agentId)))
            .slice(0, MAX_ROWS_PER_CARD);
          if (waiting.length === 0) return { content: "Nothing waits for their decision: no card was posted." };
          const at = await cardPlace(ctx);
          if (!at) return NOBODY_READS;
          const full = await cardsLeft(ctx);
          if (full) return full;
          const card: ApprovalsCard = {
            kind: "approvals",
            forUserId,
            params: { approvalIds: waiting.map((a) => a.id), why: str(input.why).trim() },
          };
          // No titles in the body: in a channel everyone reads it (and its notifications), while each viewer's card
          // shows only the approvals they may see.
          const messageId = await postCard(deps, ctx, at, `Approvals waiting: ${waiting.length}`, {
            ...bodyCode(APPROVALS_CARD),
            actionCard: card,
          });
          return {
            content: `Posted ${waiting.length} approval${waiting.length > 1 ? "s" : ""} on a card: ${waiting.map((a) => a.title).join("; ")}. They decide each there; nothing is decided yet.`,
            data: { actionCard: { messageId } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: PROPOSE_MEMBER_CHANGES_TOOL,
      description:
        "Change people in the workspace, a row per change: making someone an owner or not (owners only), giving or taking roles, or removing them from the workspace. Roles the person who asked may give, asked in their own words, apply at once with Undo; the rest is one card whoever may applies row by row as themselves (removal with the members screen's confirmation). Inviting is offer_invites. The result says what changed: never say more is done.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            minItems: 1,
            maxItems: MAX_ROWS_PER_CARD,
            items: {
              type: "object",
              properties: {
                person: { type: "string", minLength: 1, maxLength: 200, description: "@handle, email or name." },
                owner: { type: "boolean", description: "True: make them an owner; false: no longer one." },
                add_roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
                remove_roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
                remove: { type: "boolean", description: "True: remove them from the workspace." },
              },
              required: ["person"],
              additionalProperties: false,
            },
          },
          why: { type: "string", minLength: 1, maxLength: 300, description: "One short line on the card." },
        },
        required: ["changes", "why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const forUserId = await personBehindCall(ctx);
          if (!forUserId) return { content: "Only a person's request can propose changing people.", isError: true };
          const changes = (Array.isArray(input.changes) ? input.changes : []) as Record<string, unknown>[];
          const rows: MemberChangeRow[] = [];
          for (const change of changes) {
            const found = await findMember(ctx, str(change.person), { includeBlocked: true });
            if (found.length !== 1)
              return {
                content: found.length
                  ? `Several people match "${str(change.person)}": ask which one.`
                  : `No one called "${str(change.person)}" in this workspace.`,
                isError: true,
              };
            const [person] = found;
            if (!person) continue;
            const who = { userId: person.userId, name: person.name };
            if (change.remove === true) rows.push({ ...who, remove: true });
            else {
              if (typeof change.owner === "boolean") rows.push({ ...who, role: change.owner ? "owner" : "member" });
              const add = await rolesByName(ctx, names(change.add_roles));
              if (typeof add === "string") return { content: add, isError: true };
              const take = await rolesByName(ctx, names(change.remove_roles));
              if (typeof take === "string") return { content: take, isError: true };
              if (add.length || take.length) rows.push({ ...who, addRoleIds: add, removeRoleIds: take });
            }
          }
          if (rows.length === 0)
            return { content: "Say what changes: owner, add_roles, remove_roles or remove.", isError: true };
          // Roles they may give, asked in their own words, apply at once with Undo (ADR 0137 amendment of
          // 2026-11-07); ownership and removal stay on the card, with the members screen's own confirmation.
          const applied: string[] = [];
          const giving = workspaceAction("set_member_roles");
          if (giving && (await ownWords(ctx)) === forUserId) {
            for (const r of [...rows]) {
              if (!("addRoleIds" in r)) continue;
              // The turn's cap on changes made at once (`workspace_action`'s too): the rest waits on the card.
              if ((await changesThisRun(ctx)) >= MAX_ACTIONS_PER_RUN) break;
              const done = await actNow(deps, ctx, forUserId, giving, {
                userId: r.userId,
                name: r.name,
                add: r.addRoleIds,
                remove: r.removeRoleIds,
              }).catch(() => null);
              if (!done || "refused" in done) continue;
              applied.push(`${r.name} (${done.words.change})`);
              rows.splice(rows.indexOf(r), 1);
            }
          }
          const now = applied.length ? `Applied at once, with Undo under your reply: ${applied.join("; ")}.` : "";
          if (rows.length === 0) return { content: `${now} Say it is done.` };
          const at = await cardPlace(ctx);
          if (!at) return NOBODY_READS;
          const full = await cardsLeft(ctx);
          if (full) return full;
          const kept = rows.slice(0, MAX_ROWS_PER_CARD);
          const card: MemberChangesCard = {
            kind: "member_changes",
            forUserId,
            params: { rows: kept, why: str(input.why).trim() },
          };
          const who = [...new Set(kept.map((r) => r.name))].join(", ");
          const messageId = await postCard(deps, ctx, at, `Proposed a change to ${who}: ${card.params.why}`, {
            ...bodyCode(MEMBER_CHANGES_CARD, { names: who }),
            actionCard: card,
          });
          const membership = await getMembership(ctx.db, forUserId, ctx.orgId);
          const may = kept.every((r) =>
            "role" in r ? membership?.role === "owner" : can(membership, "manage_members"),
          );
          return {
            content: `${now ? `${now} ` : ""}Posted the card for ${who}.${may ? " They apply each row there." : " Some rows need someone with more rights (an owner for ownership, an admin for the rest): say so."} ${now ? "Nothing on it has changed yet." : "Nothing has changed yet."}`,
            data: { actionCard: { messageId } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: OFFER_OPEN_PAGE_TOOL,
      description:
        "Open one of the app's screens for this person with a card whose button takes them there: billing, deleting the workspace or their account, their password, API keys, the audit log and the rest. Use it for what needs that screen's own dialog or what workspace_action and your other cards don't do, or when they ask to see a screen: it asks for what it always does (an email code and the typed name to delete, Stripe to pay, our dialog for a key) and checks who may. Never take a key, password or token in the chat.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          page: {
            type: "string",
            enum: Object.keys(APP_PAGES),
            description: Object.entries(APP_PAGES)
              .map(([k, v]) => `${k}: ${v}`)
              .join(". "),
          },
          agent: { type: "string", minLength: 1, maxLength: 64, description: "With `agent`: its @handle." },
          channel: { type: "string", minLength: 1, maxLength: 81, description: "With `channel`: its name." },
          why: { type: "string", minLength: 1, maxLength: 300, description: "One short line on the card." },
        },
        required: ["page", "why"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const page = str(input.page) as AppPage;
          if (!Object.hasOwn(APP_PAGES, page)) return { content: `No page "${page}".`, isError: true };
          const params: OpenPageCard["params"] = { page, why: str(input.why).trim() };
          if (page === "agent") {
            const named = await agentsByHandle(ctx.db, ctx.orgId, [input.agent]);
            if (named.missing.length > 0 || !named.rows[0]) return noAgents(ctx, named.missing);
            params.agentId = named.rows[0].id;
          }
          if (page === "channel") {
            const forUserId = await personBehindCall(ctx);
            const name = str(input.channel).trim().replace(/^#/, "").toLowerCase();
            const seen = forUserId ? await listChannels(ctx.db, forUserId, ctx.orgId) : [];
            const channel = seen.find((c) => c.name === name);
            if (!channel) return { content: `They see no channel #${name}.`, isError: true };
            params.channelId = channel.id;
          }
          const at = await cardPlace(ctx);
          if (!at) return NOBODY_READS;
          const full = await cardsLeft(ctx);
          if (full) return full;
          const forUserId = await personBehindCall(ctx);
          const card: OpenPageCard = { kind: "open_page", forUserId, params };
          const messageId = await postCard(deps, ctx, at, `Open ${page}: ${params.why}`, {
            ...bodyCode(OPEN_PAGE_CARD),
            actionCard: card,
          });
          const needs = PAGE_PERMISSION[page];
          const membership = forUserId ? await getMembership(ctx.db, forUserId, ctx.orgId) : null;
          const may = !needs || (needs === "manage_owners" ? membership?.role === "owner" : can(membership, needs));
          return {
            content: `Posted the card that opens ${APP_PAGES[page].split(":")[0]}.${may ? "" : " This person can't use that screen: say who can (an owner or an admin)."} Nothing changed: they act there.`,
            data: { actionCard: { messageId } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: SET_TEAM_WEEK_TOOL,
      description:
        "Stop, start again or move the card you post in this person's DM: the weekly 'Semana da equipe' (admins get it by default, Fridays at 17h in the workspace's time zone), or 'Resumo do dia', the same card every day at an hour, which anyone may ask for ('me manda isso todo dia às 9h'). Use it when they ask you to stop it, send it again, or on another day or hour. It changes only their card.",
      scope: SETUP_SCOPE,
      inputSchema: {
        type: "object",
        properties: {
          off: { type: "boolean", description: "True stops it; false starts it again." },
          daily: { type: "boolean", description: "True: every day at `hour`; false: back to weekly." },
          day: { type: "string", enum: [...WEEK_DAYS] },
          hour: { type: "integer", minimum: 0, maximum: 23, description: "In the workspace's time zone." },
        },
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const forUserId = await personBehindCall(ctx);
          if (!forUserId) return { content: "Only a person's request changes their card.", isError: true };
          const day = WEEK_DAYS.indexOf(str(input.day) as (typeof WEEK_DAYS)[number]);
          const next = await setTeamWeekPrefs(ctx.db, ctx.orgId, forUserId, {
            ...(typeof input.off === "boolean" ? { off: input.off } : {}),
            ...(typeof input.daily === "boolean" ? { daily: input.daily } : {}),
            ...(day >= 0 ? { day } : {}),
            ...(typeof input.hour === "number" ? { hour: input.hour } : {}),
          });
          const admin = can(await getMembership(ctx.db, forUserId, ctx.orgId), "administrator");
          return {
            content:
              next.off || (!next.daily && !admin)
                ? "Stopped: no card for them until they ask again or turn it on in Settings › Lodi."
                : next.daily
                  ? `Their 'Resumo do dia' now comes every day at ${next.hour}:00 (${next.timezone}), on days with something to say.`
                  : `Their weekly card now comes every ${WEEK_DAYS[next.day]} at ${next.hour}:00 (${next.timezone}), when there is something to say.`,
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
}

const WEEK_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** A setting's change as the tool takes it, for one agent. */
interface SettingsChangeInput {
  agent?: unknown;
  model?: unknown;
  ai_account?: unknown;
  budget_usd?: unknown;
  budget_default?: unknown;
  owner?: unknown;
  who_talks?: { everyone?: unknown; roles?: unknown; people?: unknown };
  join?: unknown;
  leave?: unknown;
  replies?: unknown;
  add_skills?: unknown;
  remove_skills?: unknown;
  name?: unknown;
  look?: unknown;
  reports_to?: unknown;
  archive?: unknown;
}

const NANO_PER_USD = 1_000_000_000;
/** Names a refusal lists, at most: a workspace may have hundreds of skills. */
const NAMES_SHOWN = 20;
const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : []);

/** Each change's names read as ids (people, channels, roles, AI accounts), or why one can't be. */
async function wantedLines(ctx: ToolContext, change: SettingsChangeInput): Promise<WantedLine[] | string> {
  const lines: WantedLine[] = [];
  if (typeof change.model === "string") lines.push({ field: "model", to: change.model.trim() });
  if (change.budget_default === true) lines.push({ field: "budget", to: null });
  else if (typeof change.budget_usd === "number")
    lines.push({ field: "budget", to: Math.round(change.budget_usd * NANO_PER_USD) });
  if (typeof change.owner === "string") {
    const found = await findMember(ctx, change.owner);
    if (found.length !== 1)
      return found.length
        ? `Several people match "${change.owner}": ask which one.`
        : `No one called "${change.owner}" here.`;
    const [person] = found;
    if (person) lines.push({ field: "owner", to: person.userId, label: { to: person.name } });
  }
  if (change.who_talks) {
    const roles = names(change.who_talks.roles);
    const named = names(change.who_talks.people);
    if (change.who_talks.everyone === true || roles.length + named.length === 0)
      lines.push({ field: "audience", to: { mode: "everyone", userIds: [], roleIds: [] } });
    else {
      const rows = await ctx.db
        .select({ id: orgRoles.id, name: orgRoles.name })
        .from(orgRoles)
        .where(and(eq(orgRoles.orgId, ctx.orgId), eq(orgRoles.kind, "custom")));
      const picked = roles.map((r) => rows.find((x) => x.name.toLowerCase() === r.toLowerCase()));
      if (picked.some((r) => !r)) return `Roles here: ${rows.map((r) => r.name).join(", ")}.`;
      const people: { userId: string; name: string }[] = [];
      for (const who of named) {
        const found = await findMember(ctx, who);
        if (found.length !== 1 || !found[0])
          return found.length ? `Several people match "${who}": ask which one.` : `No one called "${who}" here.`;
        people.push(found[0]);
      }
      lines.push({
        field: "audience",
        to: { mode: "people", userIds: people.map((p) => p.userId), roleIds: picked.map((r) => r?.id ?? "") },
        label: { to: [...picked.map((r) => r?.name), ...people.map((p) => p.name)].join(", ") },
      });
    }
  }
  if (typeof change.ai_account === "string") {
    const wanted = change.ai_account.trim().toLowerCase();
    const rows = await ctx.db
      .select()
      .from(machineAccounts)
      .where(and(eq(machineAccounts.orgId, ctx.orgId), eq(machineAccounts.status, "active")));
    const account = rows.find((a) => a.id === change.ai_account || a.label.toLowerCase() === wanted);
    if (!account) return `No AI account "${change.ai_account}" is connected.`;
    lines.push({
      field: "ai_account",
      to: { brain: account.kind, accountId: account.id },
      label: { to: account.label },
    });
  }
  const replies = (Array.isArray(change.replies) ? change.replies : []) as {
    channel?: unknown;
    without_mention?: unknown;
  }[];
  const wantedChannels = [...names(change.join), ...names(change.leave), ...replies.map((r) => str(r.channel))].map(
    (n) => n.replace(/^#/, "").toLowerCase(),
  );
  const found = wantedChannels.length
    ? await ctx.db
        .select({ id: channels.id, name: channels.name })
        .from(channels)
        .where(
          and(
            eq(channels.orgId, ctx.orgId),
            eq(channels.kind, "channel"),
            inArray(channels.name, wantedChannels),
            isNull(channels.archivedAt),
            isNull(channels.deletedAt),
          ),
        )
    : [];
  const channelOf = (n: string) => found.find((c) => c.name === n.replace(/^#/, "").toLowerCase());
  const missing = wantedChannels.filter((n) => !channelOf(n));
  if (missing.length > 0) return `No channel ${missing.map((n) => `#${n}`).join(", ")}.`;
  const seat = (field: WantedLine["field"], name: string, to: boolean | null) => {
    const c = channelOf(name);
    if (c) lines.push({ field, channelId: c.id, to, label: { to: `#${c.name}` } });
  };
  // Joining with a reply mode is one line: it joins answering that way.
  const replyIn = (n: string) => replies.find((r) => channelOf(str(r.channel))?.id === channelOf(n)?.id);
  for (const n of names(change.join)) seat("channel_add", n, replyIn(n) ? replyIn(n)?.without_mention === true : true);
  for (const n of names(change.leave)) seat("channel_remove", n, null);
  for (const r of replies)
    if (!names(change.join).some((n) => channelOf(n)?.id === channelOf(str(r.channel))?.id))
      seat("reply_mode", str(r.channel), r.without_mention === true);
  const wantedSkills = [...names(change.add_skills), ...names(change.remove_skills)];
  if (wantedSkills.length > 0) {
    const installed = await ctx.db
      .select({ id: skills.id, name: skills.name })
      .from(skills)
      .where(and(eq(skills.orgId, ctx.orgId), isNull(skills.deletedAt)))
      .orderBy(skills.name);
    // Exactly as written first: the slug drops hyphens, so "pdftools" would also match "pdf-tools".
    const skillOf = (n: string) =>
      installed.find((k) => k.name === n.trim().toLowerCase()) ?? installed.find((k) => slug(k.name) === slug(n));
    const unknown = wantedSkills.filter((n) => !skillOf(n));
    if (unknown.length > 0) {
      // The right hand has no skill tools: it opens the Skills screen, where any other agent offers the install card.
      const install = isRightHand(await getAgentCached(ctx.db, ctx.orgId, ctx.agentId))
        ? "someone who manages agents installs it on the Skills screen (offer_open_page, page skills)"
        : "offer to install it with offer_install_skill, by its GitHub link";
      const here = installed.map((k) => k.name);
      return installed.length
        ? `No skill ${firstOf(unknown, NAMES_SHOWN)}. Skills here: ${firstOf(here, NAMES_SHOWN)}. One not installed yet: ${install}.`
        : `No skill is installed here yet: ${install}.`;
    }
    const added = new Set(names(change.add_skills).map((n) => skillOf(n)?.id));
    const both = names(change.remove_skills).filter((n) => added.has(skillOf(n)?.id));
    if (both.length > 0)
      return `Each skill goes on or off, not both: ${firstOf(both, NAMES_SHOWN)} is in add_skills and remove_skills.`;
    for (const [list, on] of [
      [names(change.add_skills), true],
      [names(change.remove_skills), false],
    ] as const)
      for (const n of list) {
        const k = skillOf(n);
        if (k) lines.push({ field: "skill", skillId: k.id, to: on, label: { to: k.name } });
      }
  }
  if (typeof change.name === "string")
    lines.push({ field: "name", to: change.name.trim(), label: { to: change.name } });
  if (change.look) lines.push({ field: "look", to: change.look });
  if (typeof change.reports_to === "string") {
    const wanted = change.reports_to.trim().replace(/^@/, "").toLowerCase();
    if (wanted === "none") lines.push({ field: "reports_to", to: null });
    else {
      const sup = (await agentsByHandle(ctx.db, ctx.orgId, [wanted])).rowOf(wanted);
      if (!sup) return `No agent @${wanted} here.`;
      lines.push({ field: "reports_to", to: sup.id, label: { to: sup.name } });
    }
  }
  if (change.archive === true) lines.push({ field: "archive", to: true });
  return lines;
}

/** What one agent's change may hold, for both settings tools. */
const CHANGE_PROPERTIES = {
  model: { type: "string", minLength: 1, maxLength: 200, description: 'A model id, or "auto".' },
  ai_account: {
    type: "string",
    minLength: 1,
    maxLength: 200,
    description: "A Claude or ChatGPT plan signed in on a computer, by its name: only its owner gives it.",
  },
  budget_usd: { type: "number", minimum: 0, maximum: 100_000, description: "Monthly, in US dollars." },
  budget_default: { type: "boolean", description: "True: back to the workspace's default budget." },
  owner: {
    type: "string",
    minLength: 1,
    maxLength: 200,
    description: "A person's @handle, email or name.",
  },
  who_talks: {
    type: "object",
    properties: {
      everyone: { type: "boolean" },
      roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
      people: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 20 },
    },
    additionalProperties: false,
    description: "Everyone, or only people with these roles (by name) and these people (@handle, email or name).",
  },
  join: { type: "array", items: { type: "string", minLength: 1, maxLength: 81 }, maxItems: 10 },
  leave: { type: "array", items: { type: "string", minLength: 1, maxLength: 81 }, maxItems: 10 },
  replies: {
    type: "array",
    maxItems: 10,
    items: {
      type: "object",
      properties: {
        channel: { type: "string", minLength: 1, maxLength: 81 },
        without_mention: { type: "boolean", description: "False: it answers there only when @mentioned." },
      },
      required: ["channel", "without_mention"],
      additionalProperties: false,
    },
  },
  add_skills: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 80 },
    maxItems: 20,
    description: "Skills to turn on for it, by name as the Skills screen lists them.",
  },
  remove_skills: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 80 },
    maxItems: 20,
    description: "Skills to turn off for it.",
  },
  name: { type: "string", minLength: 1, maxLength: 80 },
  look: {
    type: "object",
    properties: {
      color: { type: "string", description: `${AGENT_LOOK.colors.join(", ")}, or #rrggbb.` },
      eyes: { enum: [...AGENT_LOOK.eyes] },
      accessory: { enum: [...AGENT_LOOK.accessories] },
    },
    required: ["color", "eyes"],
    additionalProperties: false,
  },
  reports_to: {
    type: "string",
    minLength: 1,
    maxLength: 64,
    description:
      'Responde a: the @handle of the agent it reports to, or "none". It says who it tells, never what it may do.',
  },
  archive: { type: "boolean", description: "True: archive it (it stops working; Undo brings it back)." },
};

const REASON = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  description: "One short line on the card, in the person's language: why.",
};

/**
 * `propose_settings_change` (ADR 0137, amending 0092 §5): a teammate's settings as one card in this conversation,
 * one row per agent and whoever decides it, applied by who clicks Aplicar. Rows the person who asked may decide, in
 * their own words (`ownWords`), apply as the card is posted: it shows them done with Desfazer. Never an agent's own row
 * (ADR 0139: an agent raising its own budget is the person's), nor deleting, which has no Undo.
 *
 * `own`: `request_settings_change`, the same card for the calling agent's own settings and nobody else's, granted in
 * every run of every agent but the right hand (no scope, as `request_permission`; on demand, `RARE_TOOLS`). Its rows
 * always wait for a click, and the right hand never looks at them for the person (ADR 0139 §2 keeps an agent's own
 * settings the person's).
 */
function settingsTool(deps: { pubsub?: PubSub }, own = false): ToolDefinition {
  return {
    name: own ? REQUEST_SETTINGS_TOOL : PROPOSE_SETTINGS_TOOL,
    description: own
      ? "Ask a person to change a setting of your own, with one card in this conversation: turn on or off a skill installed here, join or leave a channel or how you answer there, your model, the AI account you think with, your monthly budget, your owner, who may talk to you, your name, your look or who you report to. Use it whenever a request needs a setting of yours you don't have, instead of telling the person how to change it by hand or saying you can't ask. Nothing changes until a person clicks, even when the person who asked could change it: the card waits for whoever may (they send one they can't decide from there), and the result says which. Apps and permissions: request_permission. A skill not installed yet: offer_install_skill."
      : "Change teammates' settings with one card in this conversation: the model, the AI account it thinks with, its monthly budget, its owner, who may talk to it, the channels it joins or leaves and whether it answers there without a mention, the skills it has on, its name, its look, who it reports to, or archiving it. A change the person who asked may make, with nothing read from outside this turn, applies at once with Undo. Any other waits on the card for who may make it, and one they can't make they send from there. The result says which: never say it is done before it does. Instructions, a role or apps go through propose_instruction_change.",
    scope: own ? "" : SETUP_SCOPE,
    inputSchema: own
      ? {
          type: "object",
          properties: { ...CHANGE_PROPERTIES, reason: REASON },
          required: ["reason"],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: {
            changes: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: {
                type: "object",
                properties: {
                  agent: { type: "string", minLength: 1, maxLength: 64, description: "Its @handle." },
                  ...CHANGE_PROPERTIES,
                },
                required: ["agent"],
                additionalProperties: false,
              },
            },
            reason: REASON,
          },
          required: ["changes", "reason"],
          additionalProperties: false,
        },
    async execute(input, ctx) {
      try {
        const forUserId = await personBehindCall(ctx);
        if (!forUserId) return { content: "Only a person's request can propose a change.", isError: true };
        const self = own ? await getAgentCached(ctx.db, ctx.orgId, ctx.agentId) : null;
        const changes = (
          own ? [{ ...input, agent: self?.handle }] : Array.isArray(input.changes) ? input.changes : []
        ) as SettingsChangeInput[];
        const named = await agentsByHandle(
          ctx.db,
          ctx.orgId,
          changes.map((c) => c.agent),
        );
        if (named.missing.length > 0) return noAgents(ctx, named.missing);
        const targets: { agentId: string; lines: WantedLine[] }[] = [];
        for (const change of changes) {
          const lines = await wantedLines(ctx, change);
          if (typeof lines === "string") return { content: lines, isError: true };
          targets.push({ agentId: named.rowOf(change.agent)?.id ?? "", lines });
        }
        const at = await cardPlace(ctx);
        if (!at) return NOBODY_READS;
        const full = await cardsLeft(ctx);
        if (full) return full;
        // An agent's own row never applies at once (below): its own settings need no look at the person's words.
        const atOnce = !own && (await ownWords(ctx)) === forUserId;
        const { proposals, skipped } = await proposeSettings(
          { db: ctx.db },
          {
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            targets,
            rationale: str(input.reason).trim(),
            requesterId: forUserId,
          },
        );
        if (proposals.length === 0) return { content: `Nothing to propose. ${skipped.join(" ")}`, isError: true };
        const card: SettingsProposalCard = {
          kind: "settings_proposal",
          forUserId,
          proposalIds: proposals.map((p) => p.id),
        };
        const who = [...new Set(proposals.map((p) => named.rows.find((r) => r.id === p.agentId)?.name ?? ""))].join(
          ", ",
        );
        const message = await insertMessage(ctx.db, {
          orgId: ctx.orgId,
          ...at,
          author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await hopOf(ctx) },
          body: own
            ? `Asks for a change to its own settings: ${str(input.reason).trim()}`
            : `Proposed a change to ${who}: ${str(input.reason).trim()}`,
          meta: {
            ...(own ? bodyCode(SETTINGS_REQUEST_CARD) : bodyCode(SETTINGS_PROPOSAL_CARD, { names: who })),
            actionCard: card,
          },
        });
        // Before the card is announced, so it reads as done from its first frame; its receipts need the message.
        const open: typeof proposals = [];
        for (const p of proposals) {
          const now = atOnce && p.canDecide && !deletes(p) && p.agentId !== ctx.agentId;
          const done =
            now &&
            (await decideProposal(ctx.db, forUserId, ctx.orgId, p.id, "accept", { pubsub: deps.pubsub }).then(
              () => true,
              () => false,
            ));
          if (!done) open.push(p);
        }
        if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
        if (open.length < proposals.length)
          await publishMessageActions({ db: ctx.db, pubsub: deps.pubsub }, ctx.orgId, message.id);
        if (open.length > 0 && !own) await queueRightHandLook(ctx.db, ctx.orgId, message.id, forUserId);
        const decides = open.filter((p) => p.canDecide).length;
        const applied = open.length < proposals.length;
        const rest = applied ? "the rest" : "it";
        const whoDecides =
          open.length === 0
            ? ""
            : decides === open.length
              ? `the person who asked applies ${rest} from the card.`
              : decides === 0
                ? `the person who asked can't apply ${rest}: the card lets them send it to whoever may.`
                : "the person who asked applies some rows; the card lets them send the rest to whoever may.";
        const yours = open.some((p) => p.canDecide && p.agentId === ctx.agentId)
          ? " Your own settings wait for that click even when they could change them: say it waits for it."
          : "";
        return {
          content: `Posted the card for ${own ? "your settings" : who}; ${applied ? "applied at once, with Undo on the card, so say it is done. " : ""}${whoDecides}${yours}${applied ? "" : " Nothing has changed yet."}${skipped.length ? ` Left off the card: ${skipped.join(" ")}` : ""}`,
          data: { actionCard: { messageId: message.id } },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

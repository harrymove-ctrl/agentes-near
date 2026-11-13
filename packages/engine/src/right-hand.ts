import { LOCKED_BRAIN_PROTOCOL } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNotNull, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { appLocale } from "@agenteschat/i18n/locale";
import { AUTO_MODEL } from "@agenteschat/providers";
import type { Agent } from "./agents";
import { recordAudit } from "./audit";
import type { BrainUnavailability, ModelScope } from "./brains/select";
import { ForbiddenError } from "./errors";
import type { MachineStatus } from "./machine-hub";
import type { NoAiCardReason } from "./no-ai";
import { personBehindCall } from "./requester";
import { runnerUpdateWay } from "./runner-update";
import { type AgentRun, isCliFailure } from "./runs";
import { scrubSignIns } from "./tool-detail";
import type { ToolContext } from "./tools/types";

const {
  agents,
  agentBudgetPeriods,
  channelMembers,
  channels,
  machineAccounts,
  organizationMembers,
  organizations,
  users,
} = schema;

/**
 * The team's right hand (ADR 0137): one built-in agent per workspace that sets the team up and changes it, through
 * cards applied by whoever clicks, with the permissions of the person talking to it. Its row is an ordinary agent
 * (`agents.builtin`), so DMs, runs, the gateway's budget and accounting work as for any agent.
 */
export const RIGHT_HAND = "right_hand" as const;

export const isRightHand = (a: { builtin?: string | null } | null | undefined) => a?.builtin === RIGHT_HAND;

/** What it starts with. The name is the same in every language; admins may rename it and change its look. */
export const RIGHT_HAND_DEFAULTS = {
  name: "Lodi",
  handle: "lodi",
  model: AUTO_MODEL,
  appearance: { color: "teal", eyes: "happy", accessory: "headset" },
} as const;

/** What "Automático" reads of it (`chooseAutoModel`): small work first, so it starts on the cheap tier. */
export const RIGHT_HAND_AUTO = {
  role: "Workspace assistant",
  instructions:
    "Sets the team up with people through short questions and cards, and follows its work. A status, a greeting or a short question: the smallest tier and low effort. Handing work to an agent, following it up or reporting what came of it: the medium tier. More only when the person asks for something long or complex.",
} as const;

/** In `RIGHT_HAND_GRANTS`: nothing outside them can be turned on, so nobody is told to ask for it (`refusalOf`). */
export const FIXED_GRANTS = "fixed";

/** What it reads for a tool it doesn't have: a way forward, as no card or admin can give it one. */
export const RIGHT_HAND_REFUSAL =
  "this isn't one of your tools and nothing can turn it on: your tools are fixed. Hand the work to the agent whose job it is (ask_agent, tell_agent) or propose one, and never ask the person to try again";

/**
 * Its tools, fixed in code whatever its grant rows say (`loadScopeKeys`): the setup cards, reading context, reading
 * the Drive, the wiki and tasks as the person behind the run (ADR 0137 §12, §13), routines for any agent,
 * `propose_instruction_change` (under `memory:write`, whose memory tools are denied: its runs keep no memory, so
 * nothing one person tells it reaches another), `create_issue`, a task written as itself, never in a person's name
 * (§13), `update_issue` on a task its person sees, and wiki pages its person may edit (written as itself, at their
 * request). No writing Drive files, apps, web, computer, databases or mail, nor posting elsewhere (`share_artifact`
 * too), putting agents in channels without a card, or long work.
 */
export const RIGHT_HAND_GRANTS: readonly string[] = [
  FIXED_GRANTS,
  "setup:write",
  "context:read",
  "drive:read",
  "wiki:read",
  "wiki:write",
  "issues:read",
  "issues:write",
  "schedule:write",
  "memory:write",
  ...[
    "request_permission",
    "share_artifact",
    "remember",
    "update_memory",
    "forget",
    "save_how_to",
    "web_search",
    "web_fetch",
    "post_message",
    "send_dm",
    "add_agent_to_channel",
    "work_in_background",
    "post_update",
    "steer_work",
    "stop_work",
    "comment_issue",
  ].map((name) => `deny:${name}`),
];

/**
 * Its owner (the person accountable for it) is the workspace's longest-standing owner who can still sign in: set
 * again whenever the one it has is no longer an owner (a role change, leaving, an account deleted).
 */
export async function followOwner(db: Executor, orgId: string) {
  await db.execute(sql`update ${agents} a set owner_user_id = (
      select om.user_id from ${organizationMembers} om join ${users} u on u.id = om.user_id
      where om.org_id = ${orgId}::uuid and om.role = 'owner'
      order by u.blocked_at is not null or u.deletion_due_at is not null, om.created_at limit 1)
    where a.org_id = ${orgId}::uuid and a.builtin = ${RIGHT_HAND}
      and not exists (select 1 from ${organizationMembers} om join ${users} u on u.id = om.user_id
        where om.org_id = a.org_id and om.user_id = a.owner_user_id and om.role = 'owner'
          and u.blocked_at is null and u.deletion_due_at is null)`);
}

/**
 * Gives the workspace its right hand unless it has one (idempotent: the partial unique index decides between two at
 * once). The handle is `lodi`, or the first free one after it. Its budget is the workspace's default. No audit row: it
 * comes with the workspace, as the workspace itself does.
 */
export async function ensureRightHand(db: Executor, orgId: string): Promise<string | null> {
  const [had] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.builtin, RIGHT_HAND)));
  if (had) return null;
  const { freeHandle, takenHandles } = await import("./agents");
  const { FIRST_RUN_SETUP } = await import("./setup-checklist");
  const [taken, [other]] = await Promise.all([
    takenHandles(db, orgId),
    db.select({ id: agents.id }).from(agents).where(eq(agents.orgId, orgId)).limit(1),
  ]);
  const handle = taken.has(RIGHT_HAND_DEFAULTS.handle)
    ? freeHandle(RIGHT_HAND_DEFAULTS.handle, taken)
    : RIGHT_HAND_DEFAULTS.handle;
  const [made] = await db
    .insert(agents)
    .values({
      orgId,
      builtin: RIGHT_HAND,
      name: RIGHT_HAND_DEFAULTS.name,
      handle,
      model: RIGHT_HAND_DEFAULTS.model,
      brainModel: AUTO_MODEL,
      brainEffort: AUTO_MODEL,
      appearance: { ...RIGHT_HAND_DEFAULTS.appearance },
      // A workspace with no agent yet opens on its first-run checklist (ADR 0155 §6).
      ...(other ? {} : { setup: FIRST_RUN_SETUP }),
    })
    .onConflictDoNothing()
    .returning({ id: agents.id });
  if (!made) return null;
  await followOwner(db, orgId);
  await db
    .insert(agentBudgetPeriods)
    // The month's counter exists from the start, as for any new agent (`resyncBudgetCounter`): nothing spent yet.
    .values({ orgId, agentId: made.id, periodStart: sql`date_trunc('month', now() at time zone 'utc')::date` })
    .onConflictDoNothing();
  return made.id;
}

/** The workspace's right hand, where it opens after its onboarding: null once archived or deleted. */
export async function rightHandId(db: Executor, orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.orgId, orgId), eq(agents.builtin, RIGHT_HAND), isNull(agents.archivedAt), isNull(agents.deletedAt)),
    );
  return row?.id ?? null;
}

/**
 * Every workspace without a right hand gets one (boot): one query finds none once they all have it. Not one being
 * deleted, which nobody uses again.
 */
export async function ensureRightHands(db: Database, batch = 200): Promise<number> {
  let made = 0;
  for (;;) {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          isNull(organizations.deletionDueAt),
          sql`not exists (select 1 from ${agents} a where a.org_id = ${organizations.id} and a.builtin = ${RIGHT_HAND})`,
        ),
      )
      .limit(batch);
    for (const org of rows) if (await db.transaction((tx) => ensureRightHand(tx, org.id))) made++;
    if (rows.length < batch) return made;
  }
}

/** 403 `agent.right_hand_permanent`: it is part of the workspace, as its Settings say. */
export const rightHandPermanent = (what: string) =>
  new ForbiddenError(`The team's right hand can't be ${what}`, "agent.right_hand_permanent");

/** What admins may change on it (ADR 0137): its name and handle, AI and model, budget. Look and audience have their own calls. */
export const RIGHT_HAND_EDITABLE: ReadonlySet<string> = new Set([
  "name",
  "handle",
  "model",
  "credentialId",
  "monthlyBudgetNanoUsd",
]);

/** Refuses `what` for the right hand: archived, deleted. */
export async function refuseRightHand(db: Executor, orgId: string, agentId: string, what: string) {
  const [row] = await db
    .select({ builtin: agents.builtin })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  if (isRightHand(row)) throw rightHandPermanent(what);
}

/**
 * The right hand is in no channel: an @mention in any channel reaches it all the same (ADR 0137), never a DM between
 * people. Read wherever a run needs the agent in the conversation (the mention lookups, `eligibleChannelAgents`).
 */
export const rightHandReaches = (agent: SQL, channelId: SQL) =>
  sql`(${agent}.builtin = ${RIGHT_HAND} and exists (select 1 from ${schema.channels} rhc
    where rhc.id = ${channelId} and rhc.kind = 'channel' and rhc.archived_at is null and rhc.deleted_at is null))`;

/**
 * Its reply before it is posted (ADR 0137 §4): a sign-in or a key in it (`scrubSignIns`) becomes a note in the language
 * of the person behind the run, and the audit log says how many were taken out, never what. On a Codex or Cursor
 * plan a command could read the plan's own sign-in before the runner kills the turn: this is the last line.
 */
export async function scrubRightHandReply(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "id" | "agentId" | "channelId" | "triggerMessageId">,
  text: string,
): Promise<string> {
  if (scrubSignIns(text, "").found === 0) return text;
  const personId = await personBehindCall({
    db,
    orgId: run.orgId,
    runId: run.id,
    triggerMessageId: run.triggerMessageId,
  }).catch(() => null);
  const [person] = personId ? await db.select({ locale: users.locale }).from(users).where(eq(users.id, personId)) : [];
  const out = scrubSignIns(text, serverText(appLocale([person?.locale], true) ?? "en", "chat.body.redacted"));
  await recordAudit(db, {
    orgId: run.orgId,
    actor: { type: "agent", id: run.agentId },
    action: "right_hand.reply_redacted",
    target: { type: "agent", id: run.agentId },
    details: { found: out.found },
    runId: run.id,
    channelId: run.channelId,
    onBehalfOfUserId: personId,
  });
  return out.text;
}

/**
 * Who a run of the right hand reads for (ADR 0137 §13): the person behind it, in their own DM with it. Null anywhere
 * else, since others read a reply in a channel, and for any other agent.
 */
export async function rightHandReader(
  ctx: Pick<ToolContext, "orgId" | "agentId" | "channelId" | "runId" | "triggerMessageId"> & { db: Executor },
): Promise<string | null> {
  const [agent] = await ctx.db.select({ builtin: agents.builtin }).from(agents).where(eq(agents.id, ctx.agentId));
  if (!isRightHand(agent)) return null;
  const person = await personBehindCall(ctx);
  return person && (await readsAlone(ctx.db, ctx.channelId, person)) ? person : null;
}

/** Whether `person` is the one person who reads `channelId`: their own DM with an agent, where nobody else reads a reply. */
export async function readsAlone(db: Executor, channelId: string, person: string) {
  const people = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.channelId, channelId), eq(channels.kind, "dm"), isNotNull(channelMembers.userId)));
  return people.length === 1 && people[0]?.userId === person;
}

/** The right hand anywhere but a person's own DM with it: what only reads or writes for that person stays out. */
export async function rightHandAway(
  ctx: Pick<ToolContext, "orgId" | "agentId" | "channelId" | "runId" | "triggerMessageId"> & { db: Executor },
) {
  const [agent] = await ctx.db.select({ builtin: agents.builtin }).from(agents).where(eq(agents.id, ctx.agentId));
  return isRightHand(agent) && !(await rightHandReader(ctx));
}

/** Its computer turns' permission profile: the runner's locked-down `chat` (`LOCKED_BRAIN_PROTOCOL`). */
export const RIGHT_HAND_TURN = { mode: "chat" } as const;

type ThinkingAgent = Pick<Agent, "orgId" | "brainAccountId" | "machineId"> &
  Partial<Pick<Agent, "builtin" | "ownerUserId" | "brain" | "brainModel" | "brainEffort" | "brainAccountLentBy">> &
  Partial<Pick<Agent, "planForOthers" | "brainFallback" | "brainExtraUsage">>;

/** A person's own AI for the right hand (§11): their row, null when their DM thinks with the workspace's. */
export async function personalBrain(db: Executor, orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(schema.rightHandBrains)
    .where(and(eq(schema.rightHandBrains.orgId, orgId), eq(schema.rightHandBrains.userId, userId)));
  return row ?? null;
}

/** The right hand with `person`'s own AI (§11) in place of the workspace's brain, when they chose one. */
export async function withPersonalBrain<T extends ThinkingAgent>(
  db: Executor,
  agent: T,
  person: string | null | undefined,
): Promise<{ agent: T; own: boolean }> {
  const own = person && isRightHand(agent) ? await personalBrain(db, agent.orgId, person) : null;
  if (!own) return { agent, own: false };
  return {
    agent: {
      ...agent,
      brain: own.brain,
      brainModel: own.brainModel,
      brainEffort: own.brainEffort,
      brainAccountId: own.brainAccountId,
      brainAccountLentBy: own.brainAccountLentBy,
      brainFallback: false,
      brainExtraUsage: false,
    },
    own: true,
  };
}

/**
 * An agent as its brain sees it. The right hand is on no computer and its owner is the workspace's (`followOwner`):
 * on a plan it thinks on the computer where that plan's account is signed in, and the plan is its owner's (who pays,
 * as for any agent, ADR 0059 §3). With no account it has no computer. `person`: whose DM the run answers; their own
 * AI (§11) thinks for them in place of the workspace's, and serves them alone: their own plan, or one given to them
 * with `use_others_plans`. Every other agent is itself.
 */
export async function thinkingAgent<T extends ThinkingAgent>(
  db: Executor,
  agent: T,
  person?: string | null,
): Promise<T> {
  if (!isRightHand(agent)) return agent;
  const { agent: base, own } = await withPersonalBrain(db, agent, person);
  const [plan] = base.brainAccountId
    ? await db
        .select({ machineId: machineAccounts.machineId, ownerId: machineAccounts.createdBy })
        .from(machineAccounts)
        .where(and(eq(machineAccounts.orgId, agent.orgId), eq(machineAccounts.id, base.brainAccountId)))
    : [];
  const ownerUserId = plan?.ownerId ?? null;
  return {
    ...base,
    machineId: plan?.machineId ?? null,
    ownerUserId,
    // "Atende outras pessoas" is the workspace's plan's switch: a person's own serves that person.
    ...(own ? { planForOthers: base.brainAccountLentBy != null || ownerUserId === person } : {}),
  };
}

/** The person whose own AI a right hand's run thinks with (`thinkingAgent`); null for any other agent's run. */
export async function rightHandPerson(
  db: Executor,
  agent: { builtin?: string | null },
  run: Pick<AgentRun, "orgId" | "id" | "triggerMessageId">,
): Promise<string | null> {
  if (!isRightHand(agent)) return null;
  return personBehindCall({ db, orgId: run.orgId, runId: run.id, triggerMessageId: run.triggerMessageId }).catch(
    () => null,
  );
}

/**
 * Why its turn can't think on the plan now, beyond what any computer brain checks (null: it can): a runner that
 * can't lock the CLI down, or while "Atende outras pessoas" is off someone else's DM (`plan_not_shared`: their own
 * plan answers them) or a run nobody is behind (`plan_unattended`: no person's plan can answer it). `agent` is
 * `thinkingAgent`'s.
 */
export async function rightHandPlanRefusal(
  db: Executor,
  agent: Pick<Agent, "name" | "ownerUserId" | "planForOthers">,
  run: Pick<AgentRun, "orgId" | "id" | "triggerMessageId">,
  status: Pick<MachineStatus, "name" | "protocol" | "kind" | "executors"> | null,
): Promise<BrainUnavailability | null> {
  if (!agent.planForOthers) {
    const person = await personBehindCall({
      db,
      orgId: run.orgId,
      runId: run.id,
      triggerMessageId: run.triggerMessageId,
    });
    if (!person) {
      return {
        code: "plan_unattended",
        message: `${agent.name} thinks with a plan that answers only its owner, and no person asked for this.`,
      };
    }
    if (person !== agent.ownerUserId) {
      return { code: "plan_not_shared", message: `${agent.name} thinks with a plan that answers only its owner.` };
    }
  }
  if (status && status.protocol < LOCKED_BRAIN_PROTOCOL) {
    return {
      code: "runner_outdated",
      message: `The runner on ${status.name} is too old for ${agent.name} to think there. ${runnerUpdateWay(status)}`,
    };
  }
  return null;
}

/**
 * The line its DM shows when its plan can't think (ADR 0137 §7): it never falls back to an API key, nor waits with a
 * spinner. Its computer asleep or paused, the plan at its limit (or only its model's, the region that model needs, or
 * that model switched off for the key: `scope`), a plan that answers only its owner (to someone else, or to a run no
 * person asked for), a program to update or turned off there, the plan's CLI not installed, or what any agent says.
 */
export function rightHandNoAiReason(code: string, scope?: ModelScope): NoAiCardReason {
  if (code === "machine_offline" || code === "machine_paused") return "computer_away";
  if (code === "plan_limit")
    return scope === "region"
      ? "model_region"
      : scope === "inactive"
        ? "plan_inactive"
        : scope === "off"
          ? "model_off"
          : scope === "model"
            ? "model_limit"
            : "plan_limit";
  if (code === "plan_not_shared" || code === "plan_not_owner") return "plan_not_shared";
  if (code === "plan_unattended") return "plan_unattended";
  if (code === "runner_outdated" || code === "codex_too_old") return "runner_outdated";
  if (code === "exec_disabled" || code === "tool_off") return "commands_off";
  if (code === "tools_not_locked") return "plan_tools";
  if (code === "no_computer" || code === "no_session") return "no_computer";
  if (code === "not_logged_in") return "not_signed_in";
  if (code === "cli_missing" || code.endsWith("_missing")) return "cli_missing";
  // Only a failure that may pass is left (a retryable one): its card offers "Responder agora" once it can think. The
  // plan's CLI failing is its own, not its computer's.
  return isCliFailure(code) ? "cli_failed" : "computer_failed";
}

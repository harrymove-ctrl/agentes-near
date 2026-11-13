import { type BlobStoreResolver, holdEvents, type PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import {
  type AccessLine,
  accessInputOf,
  appHeldBy,
  grantsHash,
  hasApp,
  replaceableGrants,
  setAgentAccess,
  withAccessLines,
} from "../access";
import { recordAgentActions, UNDO_WINDOW_MS } from "../agent-actions";
import { type AgentDeletionDeps, deleteAgent } from "../agent-deletion";
import { type Agent, getAgent, updateAgent } from "../agents";
import { audienceNotice, canTalkTo, seesAgentDetails, speakerFor } from "../audience";
import { recordAudit } from "../audit";
import { caches, invalidateOrg } from "../cache";
import { sha256 } from "../crypto";
import { publishDelivery } from "../delivery";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { publishAgentsChanged, publishUserEvent } from "../events";
import { cutText } from "../format";
import type { Judge } from "../judge";
import { notify, resolveNotifications } from "../notifications";
import { can, type Membership, requirePermission } from "../organizations";
import { enqueue } from "../outbox";
import { maySql } from "../permissions";
import { isRightHand } from "../right-hand";
import { deliverNoticeToRun } from "../run-resume";
import { userVisibleChannels } from "../search";
import {
  agentApps,
  applySettings,
  deletes,
  maySettle,
  type ReceiptLine,
  recordSettingsReceipt,
  type SettingLine,
  settingLines,
  settingsDeciders,
  settingsRows,
  type WantedLine,
} from "../settings-proposals";
import { editedByAgents, pinBlobs, runsCode, skillFolderFiles, writeSkillBody, writeSkillChange } from "../skills";
import { ALL_TOOLS } from "../tools/scopes";
import type { ToolContext } from "../tools/types";
import {
  type ContextItem,
  checkContent,
  checkPermissionText,
  consolidateItem,
  getContextItems,
  itemVisibleIn,
  itemWords,
  REFUSED_CHANGE,
} from "./items";

const {
  agentRuns,
  channels,
  contextProposals,
  contextItems,
  agents,
  messages,
  notifications,
  organizations,
  organizationMembers,
  users,
} = schema;

export type Proposal = typeof contextProposals.$inferSelect;

/** The reason of a proposal whose agent gave none. */
export const ASKED_IN_CONVERSATION = "Asked in conversation.";
/** The team week's reasons for a settings row. */
export const OVER_BUDGET_REASON = "It stopped at its monthly budget this week.";
export const NO_CHANNEL_REASON = "It is in no channel.";
/** The reasons the server writes itself: the agent reads them as they are, people through `whyCode`, in their language. */
export const SERVER_REASONS: Record<string, "asked" | "budget" | "no_channel"> = {
  [ASKED_IN_CONVERSATION]: "asked",
  [OVER_BUDGET_REASON]: "budget",
  [NO_CHANNEL_REASON]: "no_channel",
};

/** When an item is strong enough to propose turning it into instructions or org context. */
export const PROMOTION = { minRecurrence: 2, minConfidence: 0.8, minRelevance: 0.7 };

export function isPromotable(item: ContextItem) {
  if (item.status !== "active" || item.supersededBy || item.proposedAt) return false;
  // A refusal teaches the agent what not to ask for: it is no rule to ask a person to accept.
  if (itemWords(item).how === "refused") return false;
  // Untrusted content and unverified lessons are never promoted (memory poisoning, echo chambers).
  if (item.trust !== "high" || !item.verified) return false;
  if (!["lesson", "preference", "decision", "fact"].includes(item.kind)) return false;
  return (
    item.recurrence >= PROMOTION.minRecurrence ||
    (item.confidence >= PROMOTION.minConfidence && item.relevance >= PROMOTION.minRelevance)
  );
}

/** A line diff (LCS) in unified style: ` ` kept, `-` removed, `+` added. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] ?? 0) + 1
          : Math.max((lcs[i + 1] as number[])[j] ?? 0, (lcs[i] as number[])[j + 1] ?? 0);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] ?? 0) >= ((lcs[i] as number[])[j + 1] ?? 0)) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n");
}

const LEARNED = "## Learned";

/** Text with one more bullet, under a "Learned" heading (deterministic, no model). */
export function withLearnedBullet(text: string, bullet: string) {
  const line = `- ${bullet.replace(/\s+/g, " ").trim()}`;
  if (text.includes(line)) return text;
  const base = text.trimEnd();
  return base.includes(LEARNED) ? `${base}\n${line}` : `${base}${base ? "\n\n" : ""}${LEARNED}\n${line}`;
}

/**
 * Turns a strong item into a proposal: the agent's lesson → its instructions;
 * a shared lesson or org-wide fact → the org context. Never applied here.
 * Notifies who can decide. Returns null when the item isn't promotable.
 */
export async function proposeFromItem(
  deps: { db: Database; pubsub?: PubSub },
  item: ContextItem,
): Promise<Proposal | null> {
  if (!isPromotable(item)) return null;
  const { db } = deps;
  // What came from a DM stays there: a proposal shows it to who decides, and once accepted every run reads it.
  if (item.scopeType === "person") return null;
  if (item.channelIds.length > 0) {
    const [dm] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(inArray(channels.id, item.channelIds), eq(channels.kind, "dm")))
      .limit(1);
    if (dm) return null;
  }
  let target: Proposal["target"];
  let current: string;
  let agentId: string | null = null;
  if (item.agentId) {
    const agent = await getAgent(db, item.orgId, item.agentId);
    if (!agent || agent.archivedAt) return null;
    target = "agent_instructions";
    current = agent.instructions;
    agentId = agent.id;
  } else {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, item.orgId));
    if (!org) return null;
    target = "org_context";
    current = org.context;
  }
  const proposedText = withLearnedBullet(current, itemWords(item).text);
  if (proposedText === current) return null;
  const diff = lineDiff(current, proposedText);
  const baseHash = sha256(current);
  // Already waiting, or already refused: asking again is the noise a refusal is meant to end.
  if (
    await sameChange(db, { orgId: item.orgId, target, agentId, baseHash, proposedText, diff }, ["pending", "rejected"])
  ) {
    await db.update(contextItems).set({ proposedAt: new Date() }).where(eq(contextItems.id, item.id));
    return null;
  }
  const evidence = item.evidence.map((e) => e.type).join(", ");
  const [proposal] = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(contextItems)
      .set({ proposedAt: new Date() })
      .where(and(eq(contextItems.id, item.id), eq(contextItems.status, "active")))
      .returning({ id: contextItems.id });
    if (claimed.length === 0) return [];
    return tx
      .insert(contextProposals)
      .values({
        orgId: item.orgId,
        target,
        agentId,
        proposedByAgentId: agentId,
        baseHash,
        proposedText,
        diff,
        rationale: `Seen ${item.recurrence}× (confidence ${item.confidence.toFixed(2)}, evidence: ${evidence || "none"}).`,
        itemIds: [item.id],
      })
      .returning();
  });
  if (!proposal) return null;
  await announce(deps, [proposal]);
  return proposal;
}

/** Each person's one inbox row for the proposals waiting on them: it stays until none does. */
export const WAITING_GROUP = "proposals-waiting";

/**
 * Tells who may decide them that proposals wait: one event per person, and the inbox row of whoever can see and decide
 * one (not the person who asked for it: its card is in front of them; one sent on with "Pedir a um admin" has its own).
 */
async function announce(deps: { db: Database; pubsub?: PubSub }, proposals: Proposal[]) {
  const [first] = proposals;
  if (!first) return;
  const people = new Set<string>();
  for (const p of proposals) for (const userId of await deciders(deps.db, p)) people.add(userId);
  const ids = proposals.map((p) => p.id);
  for (const userId of people)
    await publishUserEvent(deps.pubsub, first.orgId, userId, {
      type: "proposal.created",
      proposalId: first.id,
      proposalIds: ids,
    });
  if (first.askedAt) return;
  const waiting: string[] = [];
  for (const userId of people) {
    if (proposals.some((p) => p.requestedByUserId === userId)) continue;
    const mine = await listProposals(deps.db, userId, first.orgId, { status: "pending", ids });
    if (mine.some((p) => p.canDecide)) waiting.push(userId);
  }
  const proposer = first.proposedByAgentId ?? first.agentId;
  await notify(deps, {
    orgId: first.orgId,
    userIds: waiting,
    kind: "proposal_waiting",
    groupKey: WAITING_GROUP,
    waiting: true,
    actor: proposer ? { type: "agent", id: proposer } : undefined,
    source: {},
  }).catch(() => {});
}

/** How many proposals wait on this person: what the sidebar counts, and what its inbox row stays for. */
export async function proposalsWaitingFor(db: Database, actorId: string, orgId: string) {
  return (await listProposals(db, actorId, orgId, { status: "pending" })).filter((p) => p.canDecide).length;
}

/** Role and access are decided as on the agent's page: by who manages agents (its owner only takes access away). */
const isAgentSetting = (p: Pick<Proposal, "target">) =>
  p.target === "agent_role" || p.target === "agent_access" || p.target === "skill" || p.target === "agent_settings";

/** The agent's owner decides it too: its instructions, or access that only goes away. */
export const ownerDecides = (p: Pick<Proposal, "target" | "access">) =>
  p.target === "agent_instructions" || (p.target === "agent_access" && !p.access?.some((l) => l.on));

/**
 * Who decides: who reviews memory (instructions), configures the workspace (org context) or manages agents
 * (role, access), plus the agent's owner when `ownerDecides`.
 */
async function deciders(db: Database, p: Proposal) {
  if (p.target === "agent_settings") return settingsDeciders(db, p);
  const key = isAgentSetting(p) ? "manage_agents" : p.target === "org_context" ? "configure" : "review_memory";
  const admins = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, p.orgId), maySql(p.orgId, organizationMembers.userId, key)));
  const ids = new Set(admins.map((a) => a.userId));
  if (p.agentId && ownerDecides(p)) {
    const [agent] = await db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, p.agentId));
    if (agent?.owner) ids.add(agent.owner);
  }
  return [...ids];
}

/**
 * A proposal carries its items' text (the bullet in `proposedText`, the
 * evidence), so outside admins it is only for who may see every item behind
 * it, the same rule as `listContextItems`. An item that is gone counts as hidden.
 */
async function proposalsVisible<T extends Proposal>(db: Database, actorId: string, orgId: string, rows: T[]) {
  const ids = [...new Set(rows.flatMap((r) => r.itemIds))];
  if (ids.length === 0) return rows;
  const visible = await userVisibleChannels(db, orgId, actorId);
  const items = new Map((await getContextItems(db, orgId, ids)).map((i) => [i.id, i]));
  return rows.filter((r) =>
    r.itemIds.every((id) => {
      const item = items.get(id);
      return item !== undefined && itemVisibleIn(item, visible);
    }),
  );
}

/**
 * The workspace's context only for who configures it, and an agent's instructions, role and access only for who
 * sees how it works (`seesAgentDetails`), `review_memory` or not.
 */
async function proposalsShown<T extends Proposal>(db: Database, actorId: string, membership: Membership, rows: T[]) {
  const seen = new Map<string, boolean | null>();
  const out: T[] = [];
  for (const r of rows) {
    if (r.target === "org_context") {
      if (can(membership, "configure")) out.push(r);
      continue;
    }
    if (!r.agentId) {
      out.push(r);
      continue;
    }
    let sees = seen.get(r.agentId);
    if (sees === undefined) {
      const agent = await getAgent(db, r.orgId, r.agentId);
      sees = agent ? seesAgentDetails(agent, actorId, membership) : null;
      seen.set(r.agentId, sees);
    }
    // A deleted agent: the card that deleted it still says how it ended (only that row: its other settings stay hidden).
    if (sees ?? (r.target === "agent_settings" && r.status !== "pending" && deletes(r))) out.push(r);
  }
  return out;
}

/**
 * A settings row the right hand made from a person's request and not yet sent on (ADR 0137): until they send it,
 * only they and whoever reads the conversation its card is in hear of it.
 */
async function unsentHidden(db: Database, actorId: string, p: Proposal) {
  if (p.target !== "agent_settings" || p.askedAt || p.requestedByUserId === actorId) return false;
  const card = await cardOf(db, p);
  return !card || !(await userVisibleChannels(db, p.orgId, actorId)).includes(card.channelId);
}

async function mayDecide(db: Database, actorId: string, p: Proposal, known?: Membership) {
  const membership = known ?? (await requirePermission(db, actorId, p.orgId, "read"));
  if (p.target === "agent_settings") return !(await unsentHidden(db, actorId, p)) && maySettle(db, actorId, p);
  if (isAgentSetting(p)) {
    if (can(membership, "manage_agents")) return true;
    return ownerDecides(p) && !!p.agentId && (await getAgent(db, p.orgId, p.agentId))?.ownerUserId === actorId;
  }
  if (p.target === "org_context") return can(membership, "configure");
  // A file that runs on agents' computers is a skill change of its own: who manages skills, as an update from its
  // link that changes one (`approveSkillUpdate`).
  if (p.target === "skill" && p.skillPath && runsCode(p.skillPath)) return can(membership, "manage_agents");
  if (can(membership, "review_memory")) return true;
  if (p.target === "agent_instructions" && p.agentId) {
    const agent = await getAgent(db, p.orgId, p.agentId);
    return agent?.ownerUserId === actorId && (await proposalsVisible(db, actorId, p.orgId, [p])).length > 0;
  }
  return false;
}

export async function listProposals(
  db: Database,
  actorId: string,
  orgId: string,
  options: { status?: Proposal["status"]; agentId?: string; ids?: string[] } = {},
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const all = await db
    .select()
    .from(contextProposals)
    .where(
      and(
        eq(contextProposals.orgId, orgId),
        options.status ? eq(contextProposals.status, options.status) : undefined,
        options.agentId ? eq(contextProposals.agentId, options.agentId) : undefined,
        options.ids ? inArray(contextProposals.id, options.ids) : undefined,
      ),
    )
    // Pending first: decided ones are what the cap leaves out.
    .orderBy(desc(sql`${contextProposals.status} = 'pending'`), desc(contextProposals.createdAt))
    .limit(200);
  const shown = await proposalsShown(db, actorId, membership, all);
  const rows = can(membership, "review_memory") ? shown : await proposalsVisible(db, actorId, orgId, shown);
  const outdated = await outdatedIds(db, orgId, rows);
  const out: (Proposal & { canDecide: boolean })[] = [];
  for (const r of rows) {
    if (await unsentHidden(db, actorId, r)) continue;
    if (outdated.has(r.id)) out.push({ ...r, status: "stale", canDecide: false });
    else out.push({ ...r, canDecide: r.status === "pending" && (await mayDecide(db, actorId, r, membership)) });
  }
  return out;
}

/**
 * Open rows accepting can only fail: their text changed since, or their agent was archived (a settings row can still
 * delete it). They show as stale, and nobody is asked to decide.
 */
async function outdatedIds(db: Database, orgId: string, rows: Proposal[]) {
  const open = rows.filter((r) => r.status === "pending");
  const agentIds = [...new Set(open.flatMap((r) => (r.agentId ? [r.agentId] : [])))];
  const team = agentIds.length
    ? await db
        .select({ id: agents.id, instructions: agents.instructions, role: agents.role, archivedAt: agents.archivedAt })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  const byId = new Map(team.map((a) => [a.id, a]));
  const [org] = open.some((r) => r.target === "org_context")
    ? await db.select({ context: organizations.context }).from(organizations).where(eq(organizations.id, orgId))
    : [];
  const current = (r: Proposal) => {
    if (r.target === "org_context") return org?.context;
    if (r.target === "agent_instructions") return byId.get(r.agentId ?? "")?.instructions;
    if (r.target === "agent_role") return byId.get(r.agentId ?? "")?.role;
    return undefined;
  };
  return new Set(
    open
      .filter((r) => {
        if (r.target !== "agent_settings" && byId.get(r.agentId ?? "")?.archivedAt) return true;
        const text = current(r);
        return text !== undefined && sha256(text) !== r.baseHash;
      })
      .map((r) => r.id),
  );
}

/**
 * Accepts or rejects a proposal. Accepting applies it only if what it was
 * made against is still there, the agent included (else the proposal is
 * stale). This is the only way learned context changes instructions or the
 * org context. A role or access is applied as the person deciding, through
 * the agent page's own editors, so it never does more than they could there.
 * The agent that proposed it is told afterwards (`tellProposer`); that failing
 * never fails the decision.
 */
export async function decideProposal(
  db: Database,
  actorId: string,
  orgId: string,
  proposalId: string,
  decision: "accept" | "reject",
  options: {
    finalText?: string;
    judge?: Judge;
    pubsub?: PubSub;
    blobs?: BlobStoreResolver;
    /** The right hand's name when it accepted for `actorId` (ADR 0139): the proposer reads it decided for them. */
    via?: string;
    /** What deleting an agent from a card stops: its computer's work, its routines' mail. */
    deletion?: Omit<AgentDeletionDeps, "db" | "pubsub">;
  } = {},
): Promise<Proposal> {
  const [p] = await db
    .select()
    .from(contextProposals)
    .where(and(eq(contextProposals.id, proposalId), eq(contextProposals.orgId, orgId)));
  if (!p) throw new NotFoundError("Proposal not found");
  if (!(await mayDecide(db, actorId, p)))
    throw new ForbiddenError("Only the agent's owner or an admin can decide this");
  if (p.status !== "pending") throw new ConflictError("This proposal was already decided");
  if (options.finalText !== undefined && isAgentSetting(p))
    throw new ValidationError("Only instructions and the workspace context can be edited before accepting");
  // A person may adjust the text before accepting; it still can't carry secrets or permission rules.
  const finalText = options.finalText ?? p.proposedText;
  if (options.finalText !== undefined) {
    checkContent(options.finalText);
    await checkPermissionText(options.judge, orgId, options.finalText);
  }
  const blobs = options.blobs && p.skillPath ? await pinBlobs(options.blobs, orgId) : options.blobs;
  const events = holdEvents(options.pubsub);
  const decided = await db.transaction(async (tx) => {
    const as = tx as unknown as Database;
    let status: Proposal["status"] = decision === "accept" ? "accepted" : "rejected";
    if (decision === "accept" && p.target === "skill") {
      if (!(await appliedToSkill({ db: as, blobs }, p))) status = "stale";
    } else if (decision === "accept" && p.target === "org_context") {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for("update");
      if (!org || sha256(org.context) !== p.baseHash) status = "stale";
      else await tx.update(organizations).set({ context: finalText }).where(eq(organizations.id, orgId));
    } else if (decision === "accept") {
      const [agent] = p.agentId
        ? await tx
            .select()
            .from(agents)
            // An archived agent is still deleted (also on a retry after a delete that failed midway).
            .where(
              and(
                eq(agents.id, p.agentId),
                deletes(p) ? undefined : isNull(agents.archivedAt),
                isNull(agents.deletedAt),
              ),
            )
            .for("update")
        : [];
      if (!agent) status = "stale";
      else if (p.target === "agent_settings") {
        if (!(await applySettings({ db: as, pubsub: events.pubsub }, actorId, p, agent))) status = "stale";
        else {
          const card = await cardOf(tx, p);
          if (card) await recordSettingsReceipt(tx, p, actorId, card, agent.name, UNDO_WINDOW_MS);
        }
      } else if (!(await applied(as, actorId, p, agent, finalText))) status = "stale";
    }
    const [row] = await tx
      .update(contextProposals)
      .set({
        status,
        decidedByUserId: actorId,
        decidedAt: new Date(),
        ...(status === "accepted" ? { proposedText: finalText } : {}),
      })
      .where(and(eq(contextProposals.id, proposalId), eq(contextProposals.status, "pending")))
      .returning();
    // Someone decided it while this waited for the agent: their decision stands.
    if (!row) throw new ConflictError("This proposal was already decided");
    if (status !== "stale")
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: status === "accepted" ? "proposal.accepted" : "proposal.refused",
        target: p.agentId ? { type: "agent", id: p.agentId } : { type: "organization", id: orgId },
        details: {
          proposalId: p.id,
          target: p.target,
          proposedByAgentId: p.proposedByAgentId,
          // "Ver o que o Lodi fez": what a person applied from its cards (ADR 0137).
          ...(p.target === "agent_settings" ? { via: p.proposedByAgentId, settings: p.settings } : {}),
        },
      });
    if (status === "accepted" && (p.target === "agent_instructions" || p.target === "org_context"))
      await carryOpenRows(tx, p, finalText);
    // The lesson now lives in the instructions (or the org context): its memory item leaves memory,
    // or the prompt would carry it twice.
    if (status === "accepted" && p.itemIds.length > 0) {
      const promoted = await tx
        .update(contextItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(eq(contextItems.orgId, orgId), inArray(contextItems.id, p.itemIds), eq(contextItems.status, "active")),
        )
        .returning({ id: contextItems.id });
      for (const item of promoted)
        await enqueue(tx, { orgId, kind: "search.index", payload: { kind: "context_item", sourceId: item.id } });
    }
    return row;
  });
  if (decided.status === "accepted" && decided.agentId) {
    // Cleared inside the transaction too: a run reading in between may have cached the agent as it was.
    invalidateOrg(orgId);
    await publishAgentsChanged(events.pubsub, orgId);
  }
  await events.flush();
  // Deleting closes its missions and stops its work on its computer, which can't run inside the decision's
  // transaction; failing, the row is open again so someone can retry.
  if (decided.status === "accepted" && decided.agentId && deletes(decided)) {
    try {
      if (!options.pubsub)
        throw new ValidationError("Deleting an agent stops its work: the server's events are needed");
      await deleteAgent({ ...options.deletion, db, pubsub: options.pubsub }, actorId, orgId, decided.agentId);
    } catch (error) {
      await db
        .update(contextProposals)
        .set({ status: "pending", decidedByUserId: null, decidedAt: null })
        .where(eq(contextProposals.id, decided.id));
      throw error;
    }
  }
  if (decided.agentId) caches.agents.delete(`${orgId}:${decided.agentId}`);
  caches.orgs.delete(`${orgId}:`);
  // The editors cleared these inside this transaction: a run reading in between may have cached the old ones.
  if (decided.status === "accepted" && decided.agentId && isAgentSetting(decided)) {
    caches.agents.delete(`${orgId}:team`);
    caches.scopes.deletePrefix(`${orgId}:${decided.agentId}`);
  }
  // The right hand keeps no memory (ADR 0137): a refusal teaches it nothing one person could carry to another.
  if (decided.status === "rejected" && !isRightHand(await proposerOf(db, decided)))
    await recordRefusal(db, actorId, decided);
  // Also for a row gone stale: it may be the card's last open one.
  await tellProposer({ db, pubsub: options.pubsub }, decided, options.via).catch(() => {});
  await settled({ db, pubsub: options.pubsub }, decided).catch(() => {});
  if (decided.status === "stale")
    throw new ConflictError("What this was proposed against changed since, so it can't be applied.");
  return decided;
}

const proposerOf = async (db: Database, p: Proposal) =>
  p.proposedByAgentId ? getAgent(db, p.orgId, p.proposedByAgentId) : null;

/**
 * Accepting one change moves the text the others waiting on it were made against. One that only adds rules still
 * holds, so it moves onto the new text: of several, accepting the first must not end the rest. Any other reads as stale.
 */
async function carryOpenRows(tx: Executor, p: Proposal, text: string) {
  const open = await tx
    .select()
    .from(contextProposals)
    .where(
      and(
        eq(contextProposals.orgId, p.orgId),
        eq(contextProposals.target, p.target),
        p.agentId ? eq(contextProposals.agentId, p.agentId) : isNull(contextProposals.agentId),
        eq(contextProposals.status, "pending"),
        eq(contextProposals.baseHash, p.baseHash),
        ne(contextProposals.id, p.id),
      ),
    );
  const max = p.target === "org_context" ? TEXT_MAX.context : TEXT_MAX.instructions;
  for (const r of open) {
    const lines = r.diff.split("\n").filter((l) => /^[+-]/.test(l) && l.slice(1).trim() && l.slice(1) !== LEARNED);
    if (!lines.every((l) => l.startsWith("+- "))) continue;
    const proposedText = lines.reduce((next, l) => withLearnedBullet(next, l.slice(3)), text);
    if (proposedText === text || proposedText.length > max) continue;
    await tx
      .update(contextProposals)
      .set({ baseHash: sha256(text), proposedText, diff: lineDiff(text, proposedText) })
      .where(eq(contextProposals.id, r.id));
  }
}

/**
 * After a decision: the inbox entries asking for it are done, and the person who asked sees "Aplicado por …" or
 * "Recusado por …" on their card live (`proposal.decided`).
 */
async function settled(deps: { db: Database; pubsub?: PubSub }, p: Proposal) {
  await resolveNotifications(deps, p.orgId, { groupKey: askGroup(p.id) });
  const open = await deps.db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(eq(notifications.orgId, p.orgId), eq(notifications.groupKey, WAITING_GROUP), isNull(notifications.doneAt)),
    );
  const done: string[] = [];
  for (const { userId } of open) if ((await proposalsWaitingFor(deps.db, userId, p.orgId)) === 0) done.push(userId);
  await resolveNotifications(deps, p.orgId, { groupKey: WAITING_GROUP, userIds: done });
  // Who else could decide it has it in their count.
  const told = new Set([...(p.requestedByUserId ? [p.requestedByUserId] : []), ...(await deciders(deps.db, p))]);
  told.delete(p.decidedByUserId ?? "");
  for (const userId of told)
    await publishUserEvent(deps.pubsub, p.orgId, userId, {
      type: "proposal.decided",
      proposalId: p.id,
      status: p.status,
    });
}

const askGroup = (proposalId: string) => `change_request:${proposalId}`;

/**
 * "Pedir a um admin" (ADR 0137): the person who asked for a change they can't decide sends the row to whoever may.
 * Until then nobody else hears of it. Once per row; each decider gets an inbox entry (waiting) with who asked and why,
 * and the row's card shows it was sent (`askedAt`).
 */
export async function askProposal(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  proposalId: string,
) {
  const { db } = deps;
  const [p] = await db
    .select()
    .from(contextProposals)
    .where(and(eq(contextProposals.id, proposalId), eq(contextProposals.orgId, orgId)));
  if (!p) throw new NotFoundError("Proposal not found");
  await requirePermission(db, actorId, orgId, "read");
  if (p.requestedByUserId !== actorId)
    throw new ForbiddenError("Only the person who asked for it can send it", "proposal.not_requester");
  if (p.status !== "pending") throw new ConflictError("This proposal was already decided", "proposal.decided");
  if (p.askedAt) throw new ConflictError("It was already sent", "proposal.asked");
  if (await mayDecide(db, actorId, p)) throw new ConflictError("You can decide this yourself", "proposal.yours");
  const [row] = await db
    .update(contextProposals)
    .set({ askedAt: new Date() })
    .where(and(eq(contextProposals.id, p.id), eq(contextProposals.status, "pending"), isNull(contextProposals.askedAt)))
    .returning();
  if (!row) throw new ConflictError("It was already sent", "proposal.asked");
  await announce(deps, [row]);
  const [card, target] = await Promise.all([cardOf(db, row), row.agentId ? getAgent(db, orgId, row.agentId) : null]);
  await notify(deps, {
    orgId,
    userIds: await deciders(db, row),
    kind: "change_request",
    groupKey: askGroup(row.id),
    waiting: true,
    actor: { type: "user", id: actorId },
    source: {
      proposalId: row.id,
      ...(card ? { messageId: card.messageId, channelId: card.channelId } : {}),
      ...(target ? { agentId: target.id, label: target.name } : {}),
    },
    latest: SERVER_REASONS[row.rationale] ? {} : { text: cutText(row.rationale, 280) },
  }).catch(() => {});
  return row;
}

/** The skill a `skill` proposal changes: its id is the proposal's one access line (`proposeSkillChange`). */
export const proposalSkillId = (p: Pick<Proposal, "access">) => p.access?.[0]?.id ?? null;

/**
 * An agent's change to a skill a person made or installed (ADR 0120), or to a file of one (`file`: its path and its
 * text now, empty for a new file): the new text as a diff, applied only when a person who manages agents accepts it
 * and the skill (or the file) is still as it was. A script always comes here, whatever the skill's setting.
 */
export async function proposeSkillChange(
  deps: { db: Database; pubsub?: PubSub },
  input: {
    orgId: string;
    agentId: string;
    skill: { id: string; name: string; body: string };
    body: string;
    file?: { path: string; text: string };
    /** The person behind the run: the card is in front of them, so their inbox row isn't needed. */
    requesterId?: string | null;
  },
): Promise<Proposal | null> {
  checkContent(input.body);
  const base = input.file ? input.file.text : input.skill.body;
  if (input.body === base) return null;
  const row = {
    orgId: input.orgId,
    target: "skill" as const,
    agentId: input.agentId,
    baseHash: sha256(base),
    proposedText: input.body,
    diff: lineDiff(base, input.body),
    access: [
      {
        id: input.skill.id,
        label: input.file ? `${input.skill.name}/${input.file.path}` : input.skill.name,
        on: true,
      },
    ],
    skillPath: input.file?.path ?? null,
  };
  const waiting = await sameChange(deps.db, row, ["pending"]);
  if (waiting) return waiting;
  const [proposal] = await deps.db
    .insert(contextProposals)
    .values({
      ...row,
      proposedByAgentId: input.agentId,
      requestedByUserId: input.requesterId ?? null,
      rationale: input.file
        ? `A change to ${input.file.path} of the skill ${input.skill.name} from using it.`
        : `A fix to the skill ${input.skill.name} from using it.`,
    })
    .returning();
  if (!proposal) return null;
  await announce(deps, [proposal]);
  return proposal;
}

async function appliedToSkill(deps: { db: Database; blobs?: BlobStoreResolver }, p: Proposal) {
  const { db } = deps;
  const id = proposalSkillId(p);
  if (!id) return false;
  const edited = (was: typeof schema.skills.$inferSelect) =>
    db.update(schema.skills).set(editedByAgents(was)).where(eq(schema.skills.id, id));
  const [skill] = await db
    .select()
    .from(schema.skills)
    .where(and(eq(schema.skills.id, id), eq(schema.skills.orgId, p.orgId), isNull(schema.skills.deletedAt)))
    .for("update");
  if (!skill) return false;
  if (!p.skillPath) {
    if (sha256(skill.body) !== p.baseHash) return false;
    await writeSkillBody(db, skill, p.proposedText);
    await edited(skill);
    return true;
  }
  if (!deps.blobs) throw new ValidationError("Skill files can't be changed on this server (no storage)");
  const path = p.skillPath;
  const [kept] = await skillFolderFiles({ db, blobs: deps.blobs }, skill, [path]);
  const now = kept ? new TextDecoder().decode(kept.data) : "";
  if (sha256(now) !== p.baseHash) return false;
  await writeSkillChange(deps, skill, {
    body: skill.body,
    files: [{ path, data: new TextEncoder().encode(p.proposedText) }],
  });
  await edited(skill);
  return true;
}

/** Applies an accepted change to its agent (locked by the caller); false when what it was made against changed. */
async function applied(db: Database, actorId: string, p: Proposal, agent: Agent, finalText: string) {
  if (p.target === "agent_instructions") {
    if (sha256(agent.instructions) !== p.baseHash) return false;
    await db.update(agents).set({ instructions: finalText, updatedAt: new Date() }).where(eq(agents.id, agent.id));
    return true;
  }
  if (p.target === "agent_role") {
    if (sha256(agent.role) !== p.baseHash) return false;
    await updateAgent(db, actorId, p.orgId, agent.id, { role: p.proposedText });
    return true;
  }
  const grants = await replaceableGrants(db, p.orgId, agent.id);
  if (grantsHash(grants) !== p.baseHash) return false;
  try {
    await setAgentAccess(db, actorId, p.orgId, agent.id, accessInputOf(withAccessLines(grants, p.access ?? [])));
  } catch (error) {
    // An app disconnected since (the editor checks before it writes anything): the row went stale like any other.
    if (error instanceof ValidationError) return false;
    throw error;
  }
  return true;
}

type ProposedChange = Pick<Proposal, "target" | "diff" | "proposedText"> &
  Partial<Pick<Proposal, "settings" | "access">>;

/**
 * What a proposal asks for, in a line that is the same whichever agent it is for, so the rows of one card make one
 * lesson and the same change is known again: the lines it adds (the "Learned" heading aside) or removes, the role, or
 * the apps.
 */
function changeLine(p: ProposedChange) {
  const lines = (sign: string) =>
    p.diff
      .split("\n")
      .filter((l) => l.startsWith(sign))
      .map((l) => l.slice(1).trim())
      .filter((l) => l && l !== LEARNED)
      .join(" ");
  if (p.target === "agent_role") return `role: ${p.proposedText}`;
  if (p.target === "agent_settings")
    return `settings: ${(p.settings ?? [])
      .map((l) =>
        // A skill's label is its name, the same either way: on or off says what changed.
        l.field === "skill"
          ? `skill ${JSON.stringify(l.label?.to ?? "")} ${l.to === true ? "on" : "off"}`
          : `${l.field} ${JSON.stringify(l.label?.from ?? l.from)} → ${JSON.stringify(l.label?.to ?? l.to)}`,
      )
      .join(", ")}`;
  if (p.target === "skill") return `skill ${p.access?.[0]?.label ?? ""}: ${lines("+")}`.trim();
  if (p.target === "agent_access")
    return `access: ${(p.access ?? []).map((l) => `${l.label} ${l.on ? "on" : "off"}`).join(", ")}`;
  return lines("+") || (lines("-") ? `removing "${lines("-")}"` : "");
}

/**
 * A row of the same target with one of `statuses` asking for the same change as `row`. An open one made against an
 * older text doesn't count: it reads as stale (`outdatedIds`), so it can't stand for this one.
 */
async function sameChange(
  db: Database,
  row: ProposedChange & Pick<Proposal, "orgId" | "baseHash"> & { agentId?: string | null; skillPath?: string | null },
  statuses: Proposal["status"][],
): Promise<Proposal | undefined> {
  const rows = await db
    .select()
    .from(contextProposals)
    .where(
      and(
        eq(contextProposals.orgId, row.orgId),
        eq(contextProposals.target, row.target),
        inArray(contextProposals.status, statuses),
        row.agentId ? eq(contextProposals.agentId, row.agentId) : isNull(contextProposals.agentId),
        row.skillPath ? eq(contextProposals.skillPath, row.skillPath) : isNull(contextProposals.skillPath),
      ),
    );
  const line = changeLine(row);
  return rows.find((r) => changeLine(r) === line && (r.status !== "pending" || r.baseHash === row.baseHash));
}

/**
 * A refused proposal becomes a lesson of the agent that proposed it ("don't
 * propose this again"), so it learns from the refusal instead of proposing
 * the same change later. Best effort: the decision stands even if the lesson
 * can't be stored.
 */
async function recordRefusal(db: Database, actorId: string, p: Proposal) {
  const added = changeLine(p).slice(0, 400);
  if (!added) return;
  const agentId = p.proposedByAgentId ?? p.agentId;
  await consolidateItem(db, {
    orgId: p.orgId,
    kind: "lesson",
    scopeType: agentId ? "agent" : "org",
    agentId,
    subject: `refused: ${added.slice(0, 100)}`,
    content: `${REFUSED_CHANGE}${added}`,
    trust: "high",
    evidence: [{ type: "human", ref: p.id, at: new Date().toISOString() }],
    confidence: 0.9,
    createdByKind: "person",
    createdById: actorId,
  }).catch(() => {});
}

/** How much of one row a card's notice quotes. */
const NOTICE_ROW_CHARS = 300;

/** What the agent that proposed a card reads about its decided rows, by what became of them. */
async function cardResult(db: Executor, proposerId: string, rows: Proposal[], via?: string) {
  const ids = (list: (string | null)[]) => [...new Set(list.flatMap((id) => (id ? [id] : [])))];
  const team = await db
    .select({ id: agents.id, handle: agents.handle })
    .from(agents)
    .where(inArray(agents.id, ids(rows.map((r) => r.agentId))));
  const people = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids(rows.map((r) => r.decidedByUserId))));
  const handles = new Map(team.map((a) => [a.id, a.handle]));
  const names = new Map(people.map((u) => [u.id, u.name]));
  const line = (p: Proposal) => {
    const whose = !p.agentId ? "the" : p.agentId === proposerId ? "your" : `@${handles.get(p.agentId) ?? "agent"}'s`;
    const text = p.target === "agent_instructions" || p.target === "org_context";
    // A person may adjust the text before accepting, and the diff keeps what was proposed.
    const adjusted =
      p.status === "accepted" &&
      text &&
      p.diff.split("\n").some((l) => l.startsWith("+") && !p.proposedText.includes(l.slice(1)));
    const what =
      p.target === "org_context" ? "org context: " : p.target === "agent_instructions" ? "instructions: " : "";
    return `${whose} ${what}${cutText(changeLine(p), NOTICE_ROW_CHARS)}${adjusted ? " (with the wording a person adjusted)" : ""}`;
  };
  const decided = (status: Proposal["status"]) => {
    const those = rows.filter((r) => r.status === status);
    const who = ids(those.map((r) => r.decidedByUserId)).map((id) => names.get(id) ?? "A person");
    const people = who.join(" and ") || "A person";
    return { who: via ? `${via}, on behalf of ${people},` : people, lines: those.map(line).join("; ") };
  };
  const accepted = decided("accepted");
  const refused = decided("rejected");
  const stale = decided("stale");
  return [
    accepted.lines &&
      `${accepted.who} accepted: ${accepted.lines}. It is already applied and in effect now, even if your instructions above still show the old text (this notice wins until they refresh): don't propose or check it, say so here in a line.`,
    refused.lines && `${refused.who} refused: ${refused.lines}. Don't propose it again unless someone asks.`,
    stale.lines && `Not applied, what it was made against changed since: ${stale.lines}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The card a proposal is on, from the agent's message that shows it (`meta.memoryUpdates`, or a settings card's
 * `meta.actionCard`): the run that proposed it and every row on the card. None before that message is posted, or for
 * a proposal no message shows.
 */
async function cardOf(db: Executor, p: Proposal) {
  if (!p.proposedByAgentId) return null;
  const has = (update: Record<string, unknown>) =>
    sql`${messages.meta}->'memoryUpdates' @> ${JSON.stringify([update])}::jsonb`;
  const onSettingsCard = sql`${messages.meta}->'actionCard'->'proposalIds' @> ${JSON.stringify([p.id])}::jsonb`;
  const [message] = await db
    .select({ id: messages.id, channelId: messages.channelId, agentRunId: messages.agentRunId, meta: messages.meta })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, p.orgId),
        eq(messages.authorAgentId, p.proposedByAgentId),
        // Written after the proposal; the minute only covers clocks that disagree.
        gte(messages.createdAt, new Date(p.createdAt.getTime() - 60_000)),
        or(has({ proposalIds: [p.id] }), has({ proposalId: p.id }), onSettingsCard),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);
  if (!message) return null;
  // Lodi's weekly card (ADR 0137 §9) is posted by no run: its receipts carry none and no notice follows a decision.
  const at = { runId: message.agentRunId, messageId: message.id, channelId: message.channelId };
  const listed = (message.meta.actionCard as { proposalIds?: unknown } | undefined)?.proposalIds;
  if (Array.isArray(listed)) return { ...at, ids: listed.filter((id): id is string => typeof id === "string") };
  if (!at.runId) return null;
  const updates = (message.meta.memoryUpdates ?? []) as { proposalId?: string; proposalIds?: string[] }[];
  const update = updates.find((u) => u.proposalId === p.id || u.proposalIds?.includes(p.id));
  return { ...at, ids: update?.proposalIds?.length ? update.proposalIds : [p.id] };
}

/**
 * Tells the agent that proposed a card what people decided: a proposal suspends no run, so nothing else wakes
 * it (ADR 0092 §6). One notice per card, when its last open row is decided, in the conversation it proposed in.
 * A card that only went stale changed nothing to tell. After the commit.
 */
async function tellProposer(deps: { db: Database; pubsub?: PubSub }, p: Proposal, via?: string) {
  const card = await cardOf(deps.db, p);
  if (!card?.runId) return;
  const runId = card.runId;
  // The card's own key: a message may show several.
  const key = card.ids[0] ?? p.id;
  const delivered = await deps.db.transaction(async (tx) => {
    // Locked: of two rows decided at once, the second waits here and then finds the notice written.
    const rows = await tx
      .select()
      .from(contextProposals)
      .where(and(eq(contextProposals.orgId, p.orgId), inArray(contextProposals.id, card.ids)))
      .orderBy(asc(contextProposals.id))
      .for("update");
    if (rows.some((r) => r.status === "pending") || rows.every((r) => r.status === "stale")) return null;
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, p.orgId), eq(agentRuns.id, runId)));
    if (!run || run.agentId !== p.proposedByAgentId) return null;
    const [sent] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, p.orgId),
          eq(messages.channelId, run.channelId),
          eq(messages.authorAgentId, run.agentId),
          sql`${messages.meta}->'notice'->'refs'->>'proposalCardId' = ${key}`,
        ),
      )
      .limit(1);
    if (sent) return null;
    return deliverNoticeToRun(tx, run, {
      kind: "proposal_result",
      from: "Your proposed change",
      text: await cardResult(tx, run.agentId, rows, via),
      // `runId`: the run that proposed it, so what comes next is that run's work, for whoever is behind it.
      refs: { proposalCardId: key, runId },
    });
  });
  if (delivered) await publishDelivery(deps.pubsub, delivered).catch(() => {});
}

/** Agents on one card, at most. */
export const CARD_MAX_AGENTS = 25;
/** How much of a text a skipped swap returns, for the agent to retry with the exact words. */
const CURRENT_CHARS = 2000;
/** The editors' own limits (`PATCH …/agents/{id}`, the workspace settings): an accepted text must still save there. */
const TEXT_MAX = { instructions: 50_000, context: 20_000 };

/**
 * `text` with a change: a rule added under "Learned", or `replaces` swapped for `change`, only when it appears
 * exactly once (else null). Removing a whole line (`change` empty) takes the line, its bullet included.
 */
export function changedText(text: string, change: string, replaces?: string): string | null {
  if (replaces === undefined) return withLearnedBullet(text, change);
  const at = text.indexOf(replaces);
  if (at < 0 || text.includes(replaces, at + 1)) return null;
  let start = at;
  let end = at + replaces.length;
  if (!change.trim()) {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const newline = text.indexOf("\n", end);
    const lineEnd = newline < 0 ? text.length : newline;
    if (/^\s*(?:[-*]\s*)?$/.test(text.slice(lineStart, at)) && !text.slice(end, lineEnd).trim()) {
      start = newline < 0 ? Math.max(0, lineStart - 1) : lineStart;
      end = newline < 0 ? lineEnd : newline + 1;
    }
  }
  return text.slice(0, start) + change + text.slice(end);
}

/**
 * What a card's rows do to the texts, each line once across the card: the lines they put in (each new role is one)
 * and the lines they take out. A swap's own words are only a fragment, so the guards read these instead.
 */
function rowsChange(rows: { target: Proposal["target"]; proposedText: string; diff: string }[]) {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const r of rows) {
    if (r.target === "agent_role") added.add(r.proposedText);
    else
      for (const line of r.diff.split("\n")) {
        if (!line.slice(1).trim()) continue;
        if (line.startsWith("+")) added.add(line.slice(1));
        else if (line.startsWith("-")) removed.add(line.slice(1));
      }
  }
  return { added: [...added], removed: [...removed] };
}

/**
 * The agents a card changes: active ones (`archived`: archived ones too, to delete them) the person who asked can talk
 * to (the proposer always).
 */
async function cardAgents(
  db: Database,
  orgId: string,
  ids: string[],
  proposerId: string,
  requesterId: string,
  archived = false,
) {
  if (ids.length > CARD_MAX_AGENTS) throw new ValidationError(`At most ${CARD_MAX_AGENTS} agents on one card`);
  const rows = ids.length
    ? await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.orgId, orgId),
            inArray(agents.id, ids),
            archived ? undefined : isNull(agents.archivedAt),
            isNull(agents.deletedAt),
          ),
        )
    : [];
  if (rows.length !== ids.length) throw new NotFoundError("Agent not found");
  const talks = await speakerFor(db, orgId, requesterId);
  const out: string[] = [];
  for (const a of rows)
    if (a.id !== proposerId && !canTalkTo(a, requesterId, talks))
      out.push(`@${a.handle}: ${await audienceNotice(db, a)}`);
  if (out.length > 0)
    throw new ForbiddenError(
      `The person who asked can't talk to these agents, so nothing can be proposed for them. ${out.join(" ")}`,
    );
  return new Map(rows.map((a) => [a.id, a]));
}

/**
 * Proposals an agent makes because a person asked it in conversation: a
 * rule added to its own or other agents' instructions or to the org context
 * (or exact text swapped or removed there), and other agents' roles and apps.
 * One row per agent and kind of change, for one card; the agent never edits
 * any of them, a person who may make that change accepts each, or with `atOnce`
 * the person who asked, as it is made (`applyAsked`). Only agents the person who
 * asked can talk to; the text is checked once. What can't be proposed is left
 * off, with why in `skipped` (English, for the agent).
 */
export async function proposeChange(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge },
  input: {
    orgId: string;
    /** The agent proposing: the run's. */
    agentId: string;
    target: "agent_instructions" | "org_context";
    /** `agent_instructions`: whose instructions get `change` (the proposer's own when left out). */
    agentIds?: string[];
    /** The rule to add, or what takes the place of `replaces` (empty: removes it). */
    change: string;
    replaces?: string;
    roles?: { agentId: string; role: string }[];
    access?: { agentId: string; lines: AccessLine[] }[];
    rationale: string;
    requesterId: string;
    /** The run, when the person who asked may have what they decide applied now (`ownWords`). */
    atOnce?: ToolContext;
  },
): Promise<{ proposals: (Proposal & { canDecide: boolean })[]; applied: Proposal[]; skipped: string[] }> {
  const { db } = deps;
  const { orgId, change, replaces } = input;
  const roles = input.roles ?? [];
  const access = input.access ?? [];
  const base = {
    orgId,
    proposedByAgentId: input.agentId,
    rationale: input.rationale.slice(0, 1000) || ASKED_IN_CONVERSATION,
    requestedByUserId: input.requesterId,
  };
  const rows: (typeof contextProposals.$inferInsert)[] = [];
  const skipped: string[] = [];
  const textChange = (current: string, what: string, max: number) => {
    const next = changedText(current, change, replaces);
    if (next === null) {
      const where = current.includes(replaces ?? "") ? "appears more than once in" : "isn't in";
      skipped.push(`The text to swap ${where} ${what}. It reads: """${cutText(current, CURRENT_CHARS)}"""`);
    } else if (next === current) skipped.push(`${what} already says this.`);
    else if (next.length > max) skipped.push(`${what} would pass ${max} characters: shorten them first.`);
    else return { baseHash: sha256(current), proposedText: next, diff: lineDiff(current, next) };
    return null;
  };
  if (input.target === "org_context") {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw new NotFoundError("Organization not found");
    const text = textChange(org.context, "the org context", TEXT_MAX.context);
    if (text) rows.push({ ...base, target: "org_context", agentId: null, ...text });
  } else {
    const instructed = input.agentIds ?? [input.agentId];
    const ids = [...new Set([...instructed, ...roles.map((r) => r.agentId), ...access.map((a) => a.agentId)])];
    const team = await cardAgents(db, orgId, ids, input.agentId, input.requesterId);
    for (const id of ids) {
      const agent = team.get(id) as Agent;
      const who = `@${agent.handle}`;
      if (instructed.includes(id)) {
        const text = textChange(agent.instructions, `${who}'s instructions`, TEXT_MAX.instructions);
        if (text) rows.push({ ...base, target: "agent_instructions", agentId: id, ...text });
      }
      const role = roles
        .filter((r) => r.agentId === id)
        .at(-1)
        ?.role.trim();
      if (role === agent.role) skipped.push(`${who}'s role is already "${role}".`);
      else if (role)
        rows.push({
          ...base,
          target: "agent_role",
          agentId: id,
          baseHash: sha256(agent.role),
          proposedText: role,
          diff: lineDiff(agent.role, role),
        });
      const lines = [
        ...new Map(access.filter((a) => a.agentId === id).flatMap((a) => a.lines.map((l) => [l.id, l]))).values(),
      ];
      if (lines.length === 0) continue;
      if (id === input.agentId) {
        skipped.push(`Your own apps aren't proposed here: ask for one with request_permission.`);
        continue;
      }
      const grants = await replaceableGrants(db, orgId, id);
      const changing = lines.filter((l) => {
        const same = hasApp(grants, l.id, !l.on) === l.on;
        if (same) skipped.push(`${who} already has ${l.label} ${l.on ? "on" : "off"}.`);
        return !same;
      });
      const after = withAccessLines(grants, changing);
      const kept = changing.filter((l) => {
        const via = l.on ? null : appHeldBy(after, l.id);
        if (via)
          skipped.push(
            `${who} would keep ${l.label} through ${via === ALL_TOOLS ? "every tool being on" : via}: that is changed on its Access tab.`,
          );
        return !via;
      });
      if (kept.length > 0)
        rows.push({
          ...base,
          target: "agent_access",
          agentId: id,
          baseHash: grantsHash(grants),
          proposedText: "",
          diff: "",
          access: kept,
        });
    }
  }
  const fresh: typeof rows = [];
  for (const row of rows) {
    if (await sameChange(db, { access: null, settings: null, ...row }, ["pending"]))
      skipped.push("This same change is already waiting for a person's decision: no need to propose it again.");
    else fresh.push(row);
  }
  if (fresh.length === 0) return { proposals: [], applied: [], skipped: [...new Set(skipped)] };
  const { added, removed } = rowsChange(fresh);
  checkContent(added.join("\n"));
  await checkPermissionText(deps.judge, orgId, [...added, ...removed.map((l) => `Removes: ${l}`)].join("\n"));
  const proposals = await db.insert(contextProposals).values(fresh).returning();
  const out: (Proposal & { canDecide: boolean })[] = [];
  const applied: Proposal[] = [];
  for (const p of proposals) {
    const canDecide = await mayDecide(db, input.requesterId, p);
    if (canDecide && input.atOnce && (await applyAsked(deps, input.atOnce, input.requesterId, p))) applied.push(p);
    else out.push({ ...p, canDecide });
  }
  await announce(deps, out);
  return { proposals: out, applied, skipped };
}

/** The field a receipt names for a row applied at once. */
const RECEIPT_FIELD = { agent_instructions: "instructions", agent_role: "role", agent_access: "apps" } as const;

/**
 * Applies one row now, as the person who asked, with a receipt and Undo in place of a card (ADR 0092 §5, amended): the
 * caller checked `ownWords`. False when it can't be (it goes on as a card). The texts stay off the receipt's params,
 * which everyone in the conversation reads.
 */
async function applyAsked(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge },
  ctx: ToolContext,
  requesterId: string,
  p: Proposal,
) {
  if (p.target !== "agent_instructions" && p.target !== "agent_role" && p.target !== "agent_access") return false;
  const [before, target] = [await getAgent(deps.db, p.orgId, p.agentId ?? ""), RECEIPT_FIELD[p.target]];
  if (!before) return false;
  const apps = () => agentApps(deps.db, p.orgId, before.id);
  const from = target === "apps" ? await apps() : target === "role" ? before.role : before.instructions;
  try {
    await decideProposal(deps.db, requesterId, p.orgId, p.id, "accept", deps);
  } catch (error) {
    if (error instanceof ConflictError) return false;
    throw error;
  }
  const line: ReceiptLine = { field: target, from, to: target === "apps" ? await apps() : p.proposedText };
  await recordAgentActions(deps.db, ctx, [
    {
      kind: "agent.settings_changed",
      target: { type: "agent", id: before.id, title: before.name },
      params: { proposalId: p.id, agentName: before.name, fields: [target] },
      before: { lines: [line] },
    },
  ]);
  return true;
}

/** `meta.actionCard` of the right hand's settings card (ADR 0137): its rows, read live (`GET …/proposals?ids=`). */
export interface SettingsProposalCard {
  kind: "settings_proposal";
  forUserId: string | null;
  proposalIds: string[];
}

export const settingsCardOf = (meta: Record<string, unknown> | null | undefined): SettingsProposalCard | null => {
  const card = meta?.actionCard as Partial<SettingsProposalCard> | undefined;
  return card?.kind === "settings_proposal" && Array.isArray(card.proposalIds) ? (card as SettingsProposalCard) : null;
};

/**
 * The right hand's settings card (ADR 0137, amending 0092 §5): a teammate's model, AI account, budget, owner, who
 * talks to it, its channels and reply mode, or archiving it, one row per agent and decider group. Only agents the
 * person who asked can talk to. Nothing is applied here: whoever may make each change applies it as themselves, and a
 * row the person who asked can't decide waits until they send it ("Pedir a um admin", `askProposal`), so nobody else
 * is told now. What can't be proposed is left off, with why in `skipped`.
 */
export async function proposeSettings(
  deps: { db: Database },
  input: {
    orgId: string;
    agentId: string;
    targets: { agentId: string; lines: WantedLine[] }[];
    rationale: string;
    requesterId: string;
  },
): Promise<{ proposals: (Proposal & { canDecide: boolean })[]; skipped: string[] }> {
  const { db } = deps;
  const team = await cardAgents(
    db,
    input.orgId,
    [...new Set(input.targets.map((t) => t.agentId))],
    input.agentId,
    input.requesterId,
    input.targets.every((t) => t.lines.every((l) => l.field === "delete")),
  );
  const rows: (typeof contextProposals.$inferInsert)[] = [];
  const skipped: string[] = [];
  for (const [agentId, agent] of team) {
    const wanted = input.targets.filter((t) => t.agentId === agentId).flatMap((t) => t.lines);
    const checked = await settingLines(db, input.orgId, input.requesterId, agent, wanted);
    skipped.push(...checked.skipped);
    for (const row of settingsRows(checked.lines))
      rows.push({
        orgId: input.orgId,
        target: "agent_settings",
        agentId,
        proposedByAgentId: input.agentId,
        requestedByUserId: input.requesterId,
        baseHash: row.baseHash,
        proposedText: "",
        diff: "",
        settings: row.settings as SettingLine[],
        rationale: input.rationale.slice(0, 1000) || ASKED_IN_CONVERSATION,
      });
  }
  if (rows.length === 0) return { proposals: [], skipped };
  const proposals = await db.insert(contextProposals).values(rows).returning();
  const out: (Proposal & { canDecide: boolean })[] = [];
  for (const p of proposals) out.push({ ...p, canDecide: await mayDecide(db, input.requesterId, p) });
  return { proposals: out, skipped };
}

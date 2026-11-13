import { and, type Database, eq, inArray, like, schema } from "@agenteschat/db";
import { type Agent, getAgent } from "../agents";
import { audienceError, canTalkTo, speakerFor } from "../audience";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { NotFoundError, ValidationError } from "../errors";
import { requirePermission } from "../organizations";
import { levelOf, MAIL_SCOPES, mailboxAddresses, mailGrants, mailOwnerOnlyError, orgMailAccounts } from "./accounts";
import { isEmailAddress, normalizeAddress, normalizeAddressRule } from "./text";

const { mailAccounts, mailAgentPolicies, agentScopes } = schema;

/** What one agent may do with one mailbox beyond its scopes (checked per call). Empty lists = no limit. */
export interface MailPolicy {
  folders: string[];
  senders: string[];
  windowDays: number | null;
  allowedRecipients: string[];
  dailySendCap: number;
  sendWithoutAsking: boolean;
  fromAddress: string | null;
}

export type MailLevel = "none" | "read" | "read_write";

export interface AgentMailbox {
  accountId: string;
  level: MailLevel;
  canDelete: boolean;
  policy: MailPolicy;
}

export const DEFAULT_MAIL_POLICY: MailPolicy = {
  folders: [],
  senders: [],
  windowDays: null,
  allowedRecipients: [],
  dailySendCap: 25,
  sendWithoutAsking: false,
  fromAddress: null,
};

type PolicyRow = typeof mailAgentPolicies.$inferSelect;

const policyOf = (row: PolicyRow | undefined): MailPolicy =>
  row
    ? {
        folders: row.folders,
        senders: row.senders,
        windowDays: row.windowDays,
        allowedRecipients: row.allowedRecipients,
        dailySendCap: row.dailySendCap,
        sendWithoutAsking: row.sendWithoutAsking,
        fromAddress: row.fromAddress,
      }
    : { ...DEFAULT_MAIL_POLICY };

/** An agent's policies on the given mailboxes (defaults where none is saved). */
export async function agentMailPolicies(
  db: Database,
  orgId: string,
  agentId: string,
  accountIds: string[],
): Promise<Map<string, MailPolicy>> {
  const rows =
    accountIds.length === 0
      ? []
      : await db
          .select()
          .from(mailAgentPolicies)
          .where(
            and(
              eq(mailAgentPolicies.orgId, orgId),
              eq(mailAgentPolicies.agentId, agentId),
              inArray(mailAgentPolicies.accountId, accountIds),
            ),
          );
  const byAccount = new Map(rows.map((r) => [r.accountId, r]));
  return new Map(accountIds.map((id) => [id, policyOf(byAccount.get(id))]));
}

export async function agentMailPolicy(db: Database, orgId: string, agentId: string, accountId: string) {
  return (await agentMailPolicies(db, orgId, agentId, [accountId])).get(accountId) ?? { ...DEFAULT_MAIL_POLICY };
}

/** `GET …/agents/{agentId}/mail`: one entry per connected mailbox (not pending). */
export async function getAgentMail(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const accounts = (await orgMailAccounts(db, orgId)).filter((a) => a.status !== "pending");
  const ids = accounts.map((a) => a.id);
  const grants = await mailGrants(db, orgId, ids);
  const policies = await agentMailPolicies(db, orgId, agentId, ids);
  return accounts.map(
    (a): AgentMailbox => ({
      accountId: a.id,
      ...levelOf(grants.get(a.id)?.get(agentId) ?? new Set()),
      policy: policies.get(a.id) ?? { ...DEFAULT_MAIL_POLICY },
    }),
  );
}

function rulesOf(list: string[], field: string) {
  const out: string[] = [];
  for (const raw of list) {
    const rule = normalizeAddressRule(raw);
    if (!rule)
      throw new ValidationError(`${field}: "${raw}" is not an address or @domain`, "mail.invalid_rule", {
        field,
        value: raw,
      });
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

/** Normalised and checked policy fields; throws on anything invalid. */
export function normalizeMailPolicy(input: MailPolicy): MailPolicy {
  const folders = [...new Set(input.folders.map((f) => f.trim()).filter(Boolean))];
  if (folders.length > 50) throw new ValidationError("At most 50 folders", "mail.too_many_folders");
  const senders = rulesOf(input.senders, "senders");
  const allowedRecipients = rulesOf(input.allowedRecipients, "allowedRecipients");
  if (senders.length > 200 || allowedRecipients.length > 200) {
    throw new ValidationError("At most 200 addresses per list", "mail.too_many_addresses");
  }
  const windowDays = input.windowDays;
  if (windowDays !== null && (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 3650)) {
    throw new ValidationError("windowDays must be 1 to 3650 days, or null", "mail.window_days");
  }
  const cap = input.dailySendCap;
  if (!Number.isInteger(cap) || cap < 0 || cap > 1000) {
    throw new ValidationError("dailySendCap must be 0 to 1000", "mail.daily_send_cap");
  }
  if (input.sendWithoutAsking && allowedRecipients.length === 0) {
    throw new ValidationError(
      "Sending without asking needs a list of allowed recipients",
      "mail.send_without_asking_needs_recipients",
    );
  }
  const fromAddress = input.fromAddress ? normalizeAddress(input.fromAddress) : null;
  if (fromAddress && !isEmailAddress(fromAddress)) {
    throw new ValidationError("fromAddress is not an email address", "mail.invalid_from");
  }
  return {
    folders,
    senders,
    windowDays,
    allowedRecipients,
    dailySendCap: cap,
    sendWithoutAsking: input.sendWithoutAsking,
    fromAddress,
  };
}

/** The mail scopes a level gives. */
export function scopesFor(level: MailLevel, canDelete: boolean): string[] {
  if (level === "none") return [];
  const scopes: string[] =
    level === "read"
      ? [MAIL_SCOPES.read]
      : [MAIL_SCOPES.read, MAIL_SCOPES.draft, MAIL_SCOPES.send, MAIL_SCOPES.organize];
  if (canDelete) scopes.push(MAIL_SCOPES.delete);
  return scopes;
}

/**
 * Only the person who connected a mailbox gives an agent access to it, to an agent they can talk to (ADR 0038,
 * addendum). Anyone else who manages the agent (admins, its owner) may only take access away.
 */
/** Throws unless `actorId` may set these scopes; true when their policy input applies too. */
async function mayChangeMail(
  db: Database,
  actorId: string,
  orgId: string,
  agent: Agent,
  account: { address: string; createdByUserId: string | null },
  scopes: string[],
  held: Set<string>,
): Promise<boolean> {
  const lowering = scopes.every((s) => held.has(s));
  if (account.createdByUserId === actorId) {
    // Its rules can loosen at any level, for an agent that answers them; otherwise they may only lower it.
    if (canTalkTo(agent, actorId, await speakerFor(db, orgId, actorId))) return true;
    if (lowering) return false;
    throw await audienceError(db, agent);
  }
  if (!lowering) throw await mailOwnerOnlyError(db, account);
  if (agent.ownerUserId !== actorId) await requirePermission(db, actorId, orgId, "manage_agents");
  return false;
}

/**
 * `PUT …/agents/{agentId}/mail/{accountId}`: the level becomes mail scopes on that mailbox, the rest is saved as
 * the agent's policy there. Its owner sets anything; whoever else may only lower the scopes, and their policy input
 * is ignored (a looser rule would be access given).
 */
export async function setAgentMail(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  accountId: string,
  input: { level: MailLevel; canDelete: boolean; policy: MailPolicy },
): Promise<AgentMailbox> {
  await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const [account] = (await orgMailAccounts(db, orgId)).filter((a) => a.id === accountId && a.status !== "pending");
  if (!account) throw new NotFoundError("Mailbox not found", "mail.account_not_found");
  const scopes = scopesFor(input.level, input.canDelete);
  const held = (await mailGrants(db, orgId, [accountId])).get(accountId)?.get(agentId) ?? new Set<string>();
  const policy = (await mayChangeMail(db, actorId, orgId, agent, account, scopes, held))
    ? normalizeMailPolicy(input.policy)
    : await agentMailPolicy(db, orgId, agentId, accountId);
  if (policy.fromAddress && !mailboxAddresses(account).includes(policy.fromAddress)) {
    throw new ValidationError("fromAddress must be one of the mailbox's addresses", "mail.from_not_mailbox");
  }
  caches.scopes.delete(`${orgId}:${agentId}`);
  await db.transaction(async (tx) => {
    await tx
      .delete(agentScopes)
      .where(
        and(
          eq(agentScopes.orgId, orgId),
          eq(agentScopes.agentId, agentId),
          eq(agentScopes.connectionId, accountId),
          like(agentScopes.scope, "mail:%"),
        ),
      );
    if (scopes.length > 0) {
      await tx
        .insert(agentScopes)
        .values(scopes.map((scope) => ({ orgId, agentId, connectionId: accountId, scope, grantedByUserId: actorId })));
    }
    const values = { ...policy, updatedByUserId: actorId, updatedAt: new Date() };
    await tx
      .insert(mailAgentPolicies)
      .values({ orgId, agentId, accountId, ...values })
      .onConflictDoUpdate({ target: [mailAgentPolicies.agentId, mailAgentPolicies.accountId], set: values });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.mail_access_changed",
      target: { type: "agent", id: agentId },
      details: { accountId, level: input.level, canDelete: input.canDelete, ...policy },
    });
  });
  caches.scopes.delete(`${orgId}:${agentId}`);
  return { accountId, ...levelOf(new Set(scopes)), policy };
}

/** Whether `connectionId` is one of the org's mailboxes (connected or not). */
export async function isMailAccount(db: Database, orgId: string, connectionId: string) {
  const [row] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.id, connectionId), eq(mailAccounts.orgId, orgId)));
  return !!row;
}

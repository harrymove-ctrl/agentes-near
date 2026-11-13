import {
  and,
  arrayContained,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  inArray,
  isNull,
  like,
  ne,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { setsCredential } from "@agenteschat/ui/names";
import { getAgent } from "../agents";
import { agentIdsSeen, isPlaybook, readsPlaybook, seesAgentDetails } from "../audience";
import { caches, rulesPresenceKey } from "../cache";
import { isAgentOnlyDm } from "../dms";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { type Judge, triesToChangePermissions } from "../judge";
import { can, getMembership, type Membership, requirePermission } from "../organizations";
import { hasContact } from "../outside";
import { enqueueIndex, userVisibleChannels } from "../search";
import { type Plan, planConsolidation } from "./judgments";

const { agentActions, agents, contextItems, messages } = schema;

export type ContextItem = typeof contextItems.$inferSelect;
export type ContextKind = ContextItem["kind"];

/** A refused proposal in its agent's memory (`recordRefusal`): English, for the agent. */
export const REFUSED_CHANGE = "A person refused this change; don't propose it again: ";
const REFUSED_CHANGE_MARKS = new RegExp(
  `^(?:(?:## Learned|-)\\s+|${REFUSED_CHANGE}|(?:role|access|settings|skill [^:]*): )+`,
);
const REFUSED_APPROVAL = /^"(.*)" was refused(?:: (.*)| by a person\.)$/s;
const CORRECTION = /^A person corrected ".*?": (.*)$/s;

/**
 * What a person reads of a lesson the server wrote for its agent (`recordRefusal`, `learnFromRefusal`,
 * `correctAgentMessage`): the words it is about, and how they came for the apps to say in the person's language. The
 * template around them is for the agent's prompt only.
 */
export function itemWords({ content }: Pick<ContextItem, "content">): {
  text: string;
  how: "refused" | "corrected" | null;
} {
  if (content.startsWith(REFUSED_CHANGE))
    return { text: content.replace(REFUSED_CHANGE_MARKS, "").replace(/^removing "(.*)"$/s, "$1"), how: "refused" };
  const approval = REFUSED_APPROVAL.exec(content);
  if (approval) return { text: [approval[1], approval[2]].filter(Boolean).join(": "), how: "refused" };
  const correction = CORRECTION.exec(content);
  if (correction) return { text: correction[1] ?? "", how: "corrected" };
  return { text: content, how: null };
}
export type Evidence = ContextItem["evidence"][number];

// ── Guardrails ───────────────────────────────────────────────────────────────

/** Keys by their format. */
const KEY_FORMATS = [
  /\bsk-[a-z0-9_-]{16,}/i, // Anthropic/OpenAI-style keys
  /\bgh[pousr]_[a-z0-9._-]{20,}/i, // GitHub tokens (an App's: `ghs_<app id>_<JWT>`)
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access keys
  /\bxox[abprs]-[a-z0-9-]{10,}/i, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(bearer)\s+[a-z0-9._-]{20,}/i,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, // JWTs
];
const SECRET_PATTERNS = [...KEY_FORMATS, /\b(password|senha|passwd|secret|api[_ -]?key|token)\s*[:=]\s*\S{6,}/i];

/** Memories and context never carry credentials (docs/adr/0017). */
export const looksLikeSecret = (text: string) => SECRET_PATTERNS.some((p) => p.test(text));

/** How much of a file is read as text for credentials; past it, only a private key's header is looked for. */
const FILE_SCAN_BYTES = 8 * 1024 * 1024;
const PRIVATE_KEY = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A file that holds credentials, whatever its name or type: a private key's header anywhere in its bytes (PEM, PGP),
 * or a key or a password set in what reads as UTF-8 text (`setsCredential`: never a placeholder or code).
 */
export function holdsSecret(bytes: Uint8Array): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = buf.indexOf("-----BEGIN "); at >= 0; at = buf.indexOf("-----BEGIN ", at + 1)) {
    if (PRIVATE_KEY.test(buf.toString("latin1", at, at + 64))) return true;
  }
  if (bytes.byteLength > FILE_SCAN_BYTES) return false;
  try {
    const text = utf8.decode(bytes);
    return KEY_FORMATS.some((p) => p.test(text)) || setsCredential(text);
  } catch {
    return false;
  }
}

/** Refuses content that must never become context: credentials (by their format). */
export function checkContent(text: string) {
  if (looksLikeSecret(text))
    throw new ValidationError("This looks like a credential, so it can't be stored as context.");
}

/**
 * Refuses text that tries to change what agents may do (skip approvals, grant
 * scopes, "you are authorized to…"), in any language: the judge decides.
 * Permissions only ever come from scopes and approvals in the database, so
 * this only keeps such text out of memory; if the judge is unavailable, the
 * text is stored (it can't grant anything anyway).
 */
export async function checkPermissionText(judge: Judge | undefined, orgId: string, text: string) {
  if (!judge || !text.trim()) return;
  const changes = await triesToChangePermissions(judge, { orgId, text }).catch(() => false);
  if (changes) {
    throw new ValidationError(
      "Context can't change permissions or approvals. Ask an admin to change scopes instead.",
      "context.changes_permissions",
    );
  }
}

/** Like `checkPermissionText`, as a yes/no (jobs skip such text instead of failing). */
export async function changesPermissions(judge: Judge | undefined, orgId: string, text: string) {
  if (!judge || !text.trim()) return false;
  return triesToChangePermissions(judge, { orgId, text }).catch(() => false);
}

// ── Evidence ─────────────────────────────────────────────────────────────────

export const EVIDENCE_WEIGHT: Record<Evidence["type"], number> = { outcome: 4, human: 3, agent: 2, app: 2, self: 1 };

/**
 * Verified = backed by an observed outcome or a person. Claims by agents
 * (another agent's or the subject's own) never verify a lesson, however many
 * agents agree.
 */
export const isVerified = (evidence: Evidence[]) => evidence.some((e) => e.type === "outcome" || e.type === "human");

export const evidenceWeight = (evidence: Evidence[]) => Math.max(0, ...evidence.map((e) => EVIDENCE_WEIGHT[e.type]));

/** Merges evidence lists, dropping duplicates (same type and ref). */
export function mergeEvidence(a: Evidence[], b: Evidence[]) {
  const seen = new Set(a.map((e) => `${e.type}:${e.ref}`));
  return [...a, ...b.filter((e) => !seen.has(`${e.type}:${e.ref}`))];
}

/** Its content is a person's exact words (`quote` evidence): a model reads them without the agent's title (ADR 0167). */
export const isQuote = (i: Pick<ContextItem, "evidence">) =>
  i.evidence.some((e) => e.type === "human" && e.quote === true);

/**
 * Words of a fact about where and how things run (servers, hosts, addresses, deploys): such facts go stale, so past
 * `RECHECK_AFTER_DAYS` a model reads them marked to check first (ADR 0167).
 * ponytail: a word list in English and Portuguese; a kind of its own from the learning job if it misses too many.
 */
const INFRA_WORDS =
  /(?<![\p{L}\p{N}])(?:prod|production|produção|staging|servers?|servidor(?:es)?|hosts?|hosting|hospedagem|deploys?|deployed|infra|infrastructure|infraestrutura|database|banco de dados|dns|domain|domínio|ip|vps|cluster|region|região|bucket|cdn|kubernetes|k8s|docker)(?![\p{L}\p{N}])/iu;
export const RECHECK_AFTER_DAYS = 30;
export const isInfraFact = (i: Pick<ContextItem, "kind" | "subjectKey" | "title" | "content">) =>
  i.kind === "fact" && INFRA_WORDS.test(`${i.subjectKey} ${i.title} ${i.content}`);

/** A person stands behind it in their own words (human evidence), not only through an app or an agent's claim. */
export const personSaid = (i: Pick<ContextItem, "createdByKind" | "evidence">) =>
  i.createdByKind === "person" && i.evidence.some((e) => e.type === "human");

// ── Subjects and similarity ──────────────────────────────────────────────────

/**
 * The word a how-to's subject key carries (`howToSubject`). Edits keep the subject key, so a how-to stays one whoever
 * edits it, and no other note becomes one by who wrote it.
 */
export const HOW_TO_WORD = "howto";
export const howToSubject = (title: string) => `${HOW_TO_WORD} ${title}`;
export const isHowTo = (i: Pick<ContextItem, "kind" | "subjectKey">) =>
  i.kind === "note" && i.subjectKey.split(" ").includes(HOW_TO_WORD);
/**
 * The word a workspace fact about who holds which access carries (an agent signed in somewhere, a login, a connector,
 * a mailbox, a person who handles a service): every agent reads these in every run (`retrieveForRun`). One word no
 * plain subject has, so "access control" never becomes one.
 */
export const ACCESS_WORD = "whoholds";
export const accessSubject = (key: string) => `${ACCESS_WORD} ${key}`;
export const isAccess = (i: Pick<ContextItem, "kind" | "agentId" | "subjectKey">) =>
  i.kind === "fact" && !i.agentId && i.subjectKey.split(" ").includes(ACCESS_WORD);
export const accessSql = () =>
  sql`(${contextItems.kind} = 'fact' and ${contextItems.agentId} is null and ${ACCESS_WORD} = any(string_to_array(${contextItems.subjectKey}, ' ')))`;
/**
 * Learning with no chat receipt (ADR 0120): the agent's playbook, and anything it found on its own (no person's words
 * among the evidence), like where a script lives. It stays in the Memory tab and in later runs.
 */
/**
 * An item a run may read: not another agent's, and a person's preference only in a run that person is behind
 * (ADR 0120).
 */
export const personMayRead = (item: ContextItem | undefined, person: string | null, agentId: string) =>
  !item || ((!item.agentId || item.agentId === agentId) && (item.scopeType !== "person" || item.scopeId === person));

export const learnedQuietly = (i: Pick<ContextItem, "kind" | "agentId" | "scopeType" | "createdByKind" | "evidence">) =>
  isPlaybook(i) || !i.evidence.some((e) => e.type === "human");
/**
 * What a chat receipt for a saved memory says: its plain title, or a person's own words. None for what was learned
 * quietly (`learnedQuietly`), nor for an agent's untitled item (its text may be technical).
 */
export const receiptLine = (
  i: Pick<ContextItem, "title" | "content" | "kind" | "agentId" | "scopeType" | "createdByKind" | "evidence">,
) => (learnedQuietly(i) ? "" : i.title.trim() || (i.createdByKind === "person" ? itemWords(i).text : ""));
/**
 * The receipt line for a write, "" for none. A quiet write that replaces or disputes what a person said, or what a
 * person wrote (an app's import has no human evidence), still gets one: a person's memory never changes unseen.
 */
export function savedReceiptLine(res: Pick<ConsolidateResult, "action" | "item" | "previous">) {
  if (res.action !== "created" && res.action !== "superseded" && res.action !== "disputed") return "";
  const p = res.previous;
  if (!learnedQuietly(res.item) || !p || (p.createdByKind !== "person" && learnedQuietly(p)))
    return receiptLine(res.item);
  return res.item.title.trim() || p.title.trim() || p.content;
}
export const howToSql = () =>
  sql`(${contextItems.kind} = 'note' and ${HOW_TO_WORD} = any(string_to_array(${contextItems.subjectKey}, ' ')))`;

/** A text's words: lower case, accents and punctuation removed. */
const wordList = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Subject key: its words, once each, sorted. */
export function normalizeSubject(subject: string) {
  return [...new Set(wordList(subject))].sort().join(" ").slice(0, 200);
}

const words = (t: string) => new Set(normalizeSubject(t).split(" ").filter(Boolean));

/** Jaccard similarity of the word sets: ≥ 0.8 counts as the same item. */
export function similarity(a: string, b: string) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

export const SAME_ITEM_SIMILARITY = 0.8;

/**
 * The same sentence give or take a few words: the shorter one's words, in order, inside the longer one. `similarity`
 * reads a swapped word or a new order as close, and in a sentence that is another one ("loja 3", "loja 4").
 */
export function sameSentence(a: string, b: string) {
  const [x, y] = [wordList(a), wordList(b)];
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  let found = 0;
  for (const word of longer) if (word === shorter[found]) found++;
  return found > 0 && found === shorter.length && found / longer.length >= SAME_ITEM_SIMILARITY;
}

/**
 * Whether a text names someone (ADR 0167): a workspace member by a word of their name, or anyone by an email address
 * or a phone number. What names nobody is a method, safe to reach the agent's other conversations.
 * ponytail: customers aren't listed anywhere, so only their contact details catch them; a contacts list if it misses.
 */
export async function namesSomeone(db: Executor, orgId: string, text: string): Promise<boolean> {
  if (hasContact(text)) return true;
  const said = new Set(wordList(text));
  const people = await db
    .select({ name: schema.users.name })
    .from(schema.organizationMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMembers.userId))
    .where(eq(schema.organizationMembers.orgId, orgId));
  return people.some((p) => wordList(p.name).some((w) => w.length >= 3 && said.has(w)));
}

/**
 * Where a how-to saved in `channel` is read (ADR 0167): one worked out in an agents' DM that names nobody reaches the
 * agent's other work; anything else stays where it was worked out.
 */
export async function howToChannels(
  db: Executor,
  orgId: string,
  channel: { id: string; kind: string; dmKey: string | null },
  text: string,
): Promise<string[]> {
  return isAgentOnlyDm(channel) && !(await namesSomeone(db, orgId, text)) ? [] : [channel.id];
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface NewContextItem {
  orgId: string;
  kind: ContextKind;
  /** `person`: a person's preference (`scopeId` their user id), read only in runs they are behind (ADR 0120). */
  scopeType: "thread" | "channel" | "org" | "agent" | "entity" | "person";
  scopeId?: string | null;
  agentId?: string | null;
  subject?: string;
  title?: string;
  content: string;
  sourceIds?: string[];
  channelIds?: string[];
  trust?: "high" | "low";
  evidence?: Evidence[];
  confidence?: number;
  pinned?: boolean;
  coversUntil?: Date | null;
  createdByKind?: "job" | "agent" | "person";
  createdById?: string | null;
  /** Items on the same topic kept apart (related, or in conflict) (ADR 0028). */
  relatedIds?: string[];
  /** Contradicted by another item, until a person resolves it. */
  disputed?: boolean;
}

/** Inserts an item (content checked) and enqueues its indexing, in the caller's transaction. */
export async function insertContextItem(tx: Executor, input: NewContextItem): Promise<ContextItem> {
  checkContent(`${input.title ?? ""}\n${input.content}`);
  const evidence = input.evidence ?? [];
  const [row] = await tx
    .insert(contextItems)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      agentId: input.agentId ?? null,
      subjectKey: normalizeSubject(input.subject ?? input.title ?? input.content.slice(0, 120)),
      title: (input.title ?? "").slice(0, 300),
      content: input.content.slice(0, 8000),
      sourceIds: input.sourceIds ?? [],
      channelIds: [...new Set(input.channelIds ?? [])],
      trust: input.trust ?? "high",
      // Anything backed only by agent claims stays unverified (no evidence at all: job output, verified by construction).
      // A note is the agent's own reminder, not a claim about the world. Low trust never verifies (ADR 0120).
      verified:
        input.trust === "low" ? false : input.kind === "note" || evidence.length === 0 ? true : isVerified(evidence),
      evidence,
      confidence: Math.min(1, Math.max(0, input.confidence ?? 0.7)),
      pinned: input.pinned ?? false,
      coversUntil: input.coversUntil ?? null,
      createdByKind: input.createdByKind ?? "job",
      createdById: input.createdById ?? null,
      relatedIds: input.relatedIds ?? [],
      disputed: input.disputed ?? false,
    })
    .returning();
  if (!row) throw new Error("context item insert returned nothing");
  await enqueueIndex(tx, { orgId: input.orgId, kind: "context_item", sourceId: row.id });
  caches.contextPresence.delete(`${input.orgId}:`);
  if (row.kind === "rule" && row.agentId) caches.contextPresence.delete(rulesPresenceKey(row.orgId, row.agentId));
  return row;
}

/** Replaces `old` by a new version (history kept: `superseded_by`, archived). */
export async function supersede(tx: Executor, old: ContextItem, next: NewContextItem): Promise<ContextItem> {
  const row = await insertContextItem(tx, next);
  await tx
    .update(contextItems)
    .set({ version: old.version + 1 })
    .where(eq(contextItems.id, row.id));
  await tx
    .update(contextItems)
    .set({ supersededBy: row.id, status: "archived", updatedAt: new Date() })
    .where(eq(contextItems.id, old.id));
  await enqueueIndex(tx, { orgId: old.orgId, kind: "context_item", sourceId: old.id });
  return { ...row, version: old.version + 1 };
}

export type ConsolidateResult = {
  /**
   * `outweighed`: it contradicts an item with stronger evidence, so that one stays current
   * (`item`) and the new one is kept only as history (`previous`) (ADR 0028).
   */
  /** `disputed`: it contradicts an item it may not replace (`mayReplace`); both stay, marked disputed. */
  action: "created" | "merged" | "superseded" | "outweighed" | "disputed";
  item: ContextItem;
  previous?: ContextItem;
};

/**
 * How a write is judged: `judge` keeps permission-bending text out; with
 * `semantic` (every organization, `memoryJudging`) the judge also says how the
 * item relates to what exists (judgments.ts); without it words decide.
 */
export interface MemoryJudging {
  judge?: Judge;
  semantic?: boolean;
  /**
   * Whether this write may supersede `old`. No: the new item is kept beside it, both `disputed` until a person
   * decides (the background learning job never silently replaces what a person wrote, ADR 0120).
   */
  mayReplace?: (old: ContextItem) => boolean;
  /**
   * A rule a person gave in their own message, in a run that read nothing outside (ADR 0120, rules people gave): it
   * may hold a permission ("no need to ask me before each send"), so the permission check is skipped.
   */
  personsRule?: boolean;
}

/**
 * Adds a fact, decision, preference or lesson, consolidating with what
 * exists on the same subject in the same scope (same agent for lessons):
 * - near-identical content → merged (evidence united, recurrence +1, confidence max);
 * - different content on the same subject → the new one supersedes the old
 *   (a contradiction keeps history; nothing is deleted silently);
 * - otherwise → created.
 */
export async function consolidateItem(
  db: Database,
  input: NewContextItem,
  judging: MemoryJudging = {},
): Promise<ConsolidateResult> {
  const { judge } = judging;
  if (!judging.personsRule) await checkPermissionText(judge, input.orgId, `${input.title ?? ""}\n${input.content}`);
  // By meaning first (outside the transaction: the judge is a network call); words when it can't.
  if (judge && judging.semantic) {
    const plan = await planConsolidation(db, judge, input);
    if (plan) {
      const done = await db.transaction((tx) => applyPlan(tx, input, plan, judging.mayReplace));
      if (done) return done;
    }
  }
  const subjectKey = normalizeSubject(input.subject ?? input.title ?? input.content.slice(0, 120));
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(contextItems)
      .where(
        and(
          eq(contextItems.orgId, input.orgId),
          eq(contextItems.kind, input.kind),
          eq(contextItems.status, "active"),
          isNull(contextItems.supersededBy),
          input.agentId ? eq(contextItems.agentId, input.agentId) : isNull(contextItems.agentId),
          eq(contextItems.scopeType, input.scopeType),
          // A rule holds by its giver (`rulesForPerson`): the same words from someone else are their own rule.
          input.kind === "rule" ? eq(contextItems.createdById, input.createdById ?? "") : undefined,
          // One person's preference never merges into another's: it would read in that person's runs.
          input.scopeType === "person" ? eq(contextItems.scopeId, input.scopeId ?? "") : undefined,
          or(eq(contextItems.subjectKey, subjectKey), sql`${contextItems.content} = ${input.content}`),
        ),
      )
      .orderBy(desc(contextItems.createdAt))
      .limit(1)
      .for("update");
    const old = existing[0];
    if (!old) return { action: "created", item: await insertContextItem(tx, input) };

    if (similarity(old.content, input.content) >= SAME_ITEM_SIMILARITY) {
      return { action: "merged", item: await mergeInto(tx, old, input) };
    }
    if (judging.mayReplace && !judging.mayReplace(old)) return keepBeside(tx, old, input);
    const item = await supersede(tx, old, { ...input, subject: input.subject ?? old.subjectKey });
    return { action: "superseded", item, previous: old };
  });
}

/**
 * A write that may not replace `old`: both stay current, linked and disputed, until a person decides. A low-trust
 * write (read from a page, mail or a connected app) never weakens `old`: only the new one is disputed.
 */
async function keepBeside(tx: Executor, old: ContextItem, input: NewContextItem): Promise<ConsolidateResult> {
  const item = await insertContextItem(tx, {
    ...input,
    subject: input.subject ?? old.subjectKey,
    relatedIds: [old.id],
    disputed: true,
  });
  if (input.trust !== "low") await tx.update(contextItems).set({ disputed: true }).where(eq(contextItems.id, old.id));
  await linkBack(tx, [old.id], item.id);
  return { action: "disputed", item, previous: old };
}

/** The same item again: evidence united, recurrence +1, confidence max; low trust is sticky. */
async function mergeInto(tx: Executor, old: ContextItem, input: NewContextItem) {
  checkContent(input.content);
  const evidence = mergeEvidence(old.evidence, input.evidence ?? []);
  // A person saying it again in their own words vouches for what an untrusted source wrote alike (ADR 0167).
  const vouched =
    input.trust === "high" &&
    personSaid({ createdByKind: input.createdByKind ?? "job", evidence: input.evidence ?? [] });
  const low = input.trust === "low" || (old.trust === "low" && !vouched);
  const [merged] = await tx
    .update(contextItems)
    .set({
      evidence,
      verified: low
        ? false
        : vouched || (old.kind !== "note" && evidence.length > 0)
          ? isVerified(evidence)
          : old.verified,
      recurrence: old.recurrence + 1,
      confidence: Math.max(old.confidence, input.confidence ?? 0),
      // Low trust is sticky: one untrusted source taints the item, unless a person vouches for it.
      trust: low ? "low" : "high",
      sourceIds: [...new Set([...old.sourceIds, ...(input.sourceIds ?? [])])],
      channelIds: [...new Set([...old.channelIds, ...(input.channelIds ?? [])])],
      updatedAt: new Date(),
    })
    .where(eq(contextItems.id, old.id))
    .returning();
  if (!merged) throw new Error("merge returned nothing");
  await enqueueIndex(tx, { orgId: old.orgId, kind: "context_item", sourceId: old.id });
  return merged;
}

/** Links `ids` back to `itemId` (both directions). */
async function linkBack(tx: Executor, ids: string[], itemId: string) {
  if (ids.length === 0) return;
  await tx
    .update(contextItems)
    .set({
      relatedIds: sql`array_append(array_remove(${contextItems.relatedIds}, ${itemId}::uuid), ${itemId}::uuid)`,
      updatedAt: new Date(),
    })
    .where(inArray(contextItems.id, ids));
}

/**
 * Carries out the judge's plan. The target is read again under a row lock:
 * if it changed meanwhile (archived, superseded), returns null and the caller
 * falls back to words.
 */
async function applyPlan(
  tx: Executor,
  input: NewContextItem,
  plan: Plan,
  mayReplace?: MemoryJudging["mayReplace"],
): Promise<ConsolidateResult | null> {
  if (plan.action === "create") {
    const item = await insertContextItem(tx, { ...input, relatedIds: plan.related });
    await linkBack(tx, plan.related, item.id);
    return { action: "created", item };
  }
  const [target] = await tx
    .select()
    .from(contextItems)
    .where(
      and(eq(contextItems.id, plan.target.id), eq(contextItems.status, "active"), isNull(contextItems.supersededBy)),
    )
    .for("update");
  if (!target) return null;
  if (plan.action === "merge") return { action: "merged", item: await mergeInto(tx, target, input) };
  if (mayReplace && !mayReplace(target) && (plan.action === "supersede" || plan.winner === "new"))
    return keepBeside(tx, target, input);
  if (plan.action === "supersede") {
    const item = await supersede(tx, target, { ...input, subject: input.subject ?? target.subjectKey });
    return { action: "superseded", item, previous: target };
  }
  if (plan.winner === "new") {
    const item = await supersede(tx, target, { ...input, subject: input.subject ?? target.subjectKey });
    return { action: "superseded", item, previous: target };
  }
  // The existing item has stronger evidence: the new claim is kept as history behind it.
  const loser = await insertContextItem(tx, { ...input, subject: input.subject ?? target.subjectKey });
  await tx
    .update(contextItems)
    .set({ status: "archived", supersededBy: target.id, relatedIds: [target.id], updatedAt: new Date() })
    .where(eq(contextItems.id, loser.id));
  await linkBack(tx, [target.id], loser.id);
  return { action: "outweighed", item: target, previous: { ...loser, status: "archived", supersededBy: target.id } };
}

// ── Reading and editing (APIs: "What Ada knows") ────────────────────────────

/** A person's preferences: theirs, and who reviews memory. Undefined: every item. */
const preferencesSeenBy = (membership: Membership, actorId: string) =>
  can(membership, "review_memory")
    ? undefined
    : or(ne(contextItems.scopeType, "person"), eq(contextItems.scopeId, actorId));

const seesPreference = (membership: Membership, actorId: string, item: Pick<ContextItem, "scopeType" | "scopeId">) =>
  item.scopeType !== "person" || item.scopeId === actorId || can(membership, "review_memory");

/** Items a person may see: those whose every channel they can read (org-wide ones too). */
export async function listContextItems(
  db: Database,
  actorId: string,
  orgId: string,
  filter: {
    agentId?: string;
    kinds?: ContextKind[];
    includeArchived?: boolean;
    limit?: number;
    /** Who wrote them (`agent`, `job`, `person`): "What it learned" lists the agent's and the jobs' (ADR 0120). */
    createdBy?: ("agent" | "job" | "person")[];
  } = {},
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [visible, seen] = await Promise.all([
    userVisibleChannels(db, orgId, actorId),
    agentIdsSeen(db, actorId, orgId),
  ]);
  const rows = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        // An agent's memory is part of how it works: only for who sees its details.
        or(isNull(contextItems.agentId), inArray(contextItems.agentId, [...seen.details])),
        preferencesSeenBy(membership, actorId),
        filter.createdBy?.length ? inArray(contextItems.createdByKind, filter.createdBy) : undefined,
        filter.agentId ? eq(contextItems.agentId, filter.agentId) : undefined,
        filter.kinds?.length ? inArray(contextItems.kind, filter.kinds) : undefined,
        filter.includeArchived ? undefined : eq(contextItems.status, "active"),
        arrayContained(contextItems.channelIds, visible),
      ),
    )
    .orderBy(desc(contextItems.pinned), desc(contextItems.relevance), desc(contextItems.updatedAt))
    .limit(Math.min(filter.limit ?? 100, 500));
  return rows.filter((i) => !isPlaybook(i) || seen.playbook.has(i.agentId ?? ""));
}

/** Whether someone who reads `visible` may see an item: every channel it came from (org-wide ones too). */
export const itemVisibleIn = (item: Pick<ContextItem, "channelIds">, visible: readonly string[]) =>
  item.channelIds.every((c) => visible.includes(c));

/**
 * Every version of an agent's items a person may see (archived and superseded
 * included), with the channels they read, for "What Ada knows": the same rule
 * as `listContextItems`, so an item learned in a DM or private channel stays there.
 */
export async function listAgentMemoryRows(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [visible, agent] = await Promise.all([userVisibleChannels(db, orgId, actorId), getAgent(db, orgId, agentId)]);
  const rows = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.agentId, agentId),
        preferencesSeenBy(membership, actorId),
        arrayContained(contextItems.channelIds, visible),
      ),
    );
  const playbook = !!agent && readsPlaybook(agent, actorId, membership);
  return { items: rows.filter((i) => playbook || !isPlaybook(i)), visible };
}

/**
 * What all the agents know, for a map of the workspace's memory: the current items of agents still here, under the
 * same rule as `listAgentMemoryRows`, most recently changed first.
 */
export async function listOrgMemoryRows(db: Database, actorId: string, orgId: string, limit = 300) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const visible = await userVisibleChannels(db, orgId, actorId);
  const rows = await db
    .select({ item: contextItems, agent: agents })
    .from(contextItems)
    .innerJoin(agents, and(eq(agents.id, contextItems.agentId), isNull(agents.archivedAt)))
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        preferencesSeenBy(membership, actorId),
        arrayContained(contextItems.channelIds, visible),
      ),
    )
    .orderBy(desc(contextItems.updatedAt))
    .limit(limit);
  // An agent's memory is part of how it works: only for who sees its details.
  const items = rows
    .filter(
      (r) =>
        seesAgentDetails(r.agent, actorId, membership) &&
        (!isPlaybook(r.item) || readsPlaybook(r.agent, actorId, membership)),
    )
    .map((r) => r.item);
  return { items, visible };
}

/**
 * Agent memories: the agent's owner or admins (a rule people gave: its giver too). Org-wide items: admins (`configure`).
 * An owner who isn't an admin changes only items they can see (the edit answers
 * with the content); to them the others don't exist.
 */
async function requireEdit(db: Database, actorId: string, item: ContextItem) {
  const membership = await requirePermission(db, actorId, item.orgId, "read");
  if (can(membership, "review_memory")) return;
  // A rule people gave: its giver takes it back too.
  if (item.kind === "rule" && item.createdByKind === "person" && item.createdById === actorId) return;
  if (item.agentId) {
    const agent = await getAgent(db, item.orgId, item.agentId);
    if (agent?.ownerUserId === actorId) {
      if (item.channelIds?.length && !itemVisibleIn(item, await userVisibleChannels(db, item.orgId, actorId)))
        throw new NotFoundError("Item not found");
      return;
    }
  }
  throw new ForbiddenError("Only the agent's owner or an admin can change this");
}

/**
 * Whether `actorId`, still a member, said what the item holds: they wrote it, or wrote a message it was saved from
 * (its human evidence), where they still read it.
 */
async function saidBy(db: Database, actorId: string, item: ContextItem) {
  if (!(await getMembership(db, actorId, item.orgId))) return false;
  if (item.channelIds.length > 0 && !itemVisibleIn(item, await userVisibleChannels(db, item.orgId, actorId)))
    return false;
  if (item.createdByKind === "person" && item.createdById === actorId) return true;
  const refs = item.evidence.filter((e) => e.type === "human" && UUID_REF.test(e.ref)).map((e) => e.ref);
  if (refs.length === 0) return false;
  const [said] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.orgId, item.orgId), inArray(messages.id, refs), eq(messages.authorUserId, actorId)))
    .limit(1);
  return Boolean(said);
}

const UUID_REF = /^[0-9a-f-]{36}$/i;

/** Whether `actorId` may change or remove the item (`requireEdit`, as a yes/no). */
export const mayEditItem = (db: Database, actorId: string, item: ContextItem) =>
  requireEdit(db, actorId, item).then(
    () => true,
    () => false,
  );

async function loadItem(db: Database, orgId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.id, itemId), eq(contextItems.orgId, orgId)));
  if (!row) throw new NotFoundError("Item not found");
  return row;
}

/**
 * A person edits an item: content edits create a new version (history kept),
 * pin and archive change it in place. An edit by a person is human evidence.
 */
export async function editContextItem(
  db: Database,
  actorId: string,
  orgId: string,
  itemId: string,
  input: { content?: string; title?: string; pinned?: boolean; archived?: boolean; confirmed?: boolean },
  judge?: Judge,
): Promise<ContextItem> {
  const item = await loadItem(db, orgId, itemId);
  // Confirmar (ADR 0167): who may edit it, or the person who said it, for that alone.
  const onlyConfirms =
    input.confirmed === true &&
    input.content === undefined &&
    input.pinned === undefined &&
    input.archived === undefined;
  if (!onlyConfirms || !(await saidBy(db, actorId, item))) await requireEdit(db, actorId, item);
  // A rule passes `requireEdit` only for its giver, the agent's owner or an admin: people who may give it anyway.
  if (input.content !== undefined && input.content !== item.content && item.kind !== "rule") {
    await checkPermissionText(judge, orgId, `${input.title ?? item.title ?? ""}\n${input.content}`);
  }
  let current = item;
  if (input.content !== undefined && input.content !== item.content) {
    current = await db.transaction((tx) =>
      supersede(tx, item, {
        orgId,
        kind: item.kind,
        scopeType: item.scopeType as NewContextItem["scopeType"],
        scopeId: item.scopeId,
        agentId: item.agentId,
        subject: item.subjectKey,
        // A summary of the old text would sit above the new one: kept only when the person edited it too.
        title: input.title ?? "",
        content: input.content ?? item.content,
        sourceIds: item.sourceIds,
        channelIds: item.channelIds,
        trust: "high",
        evidence: mergeEvidence(item.evidence, [{ type: "human", ref: actorId, at: new Date().toISOString() }]),
        confidence: Math.max(item.confidence, 0.9),
        pinned: input.pinned ?? item.pinned,
        createdByKind: "person",
        // A rule holds by its giver (`rulesForPerson`): an owner's or admin's edit keeps it the giver's.
        createdById: item.kind === "rule" && item.createdByKind === "person" ? (item.createdById ?? actorId) : actorId,
      }),
    );
  }
  // Confirmar vouches for what came from outside or isn't verified yet (ADR 0167); saving an app-sent item's text
  // unchanged confirms it too (ADR 0119 item 5).
  const confirms =
    current === item &&
    ((input.confirmed === true && (item.trust === "low" || !item.verified)) ||
      (input.content !== undefined &&
        item.trust !== "low" &&
        item.evidence.some((e) => e.type === "app") &&
        !isVerified(item.evidence)));
  if (confirms || input.pinned !== undefined || input.archived !== undefined) {
    const evidence = confirms
      ? mergeEvidence(item.evidence, [{ type: "human", ref: actorId, at: new Date().toISOString() }])
      : undefined;
    const [row] = await db
      .update(contextItems)
      .set({
        ...(evidence
          ? { evidence, trust: "high" as const, verified: true, confidence: Math.max(item.confidence, 0.9) }
          : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.archived !== undefined
          ? { status: input.archived ? ("archived" as const) : ("active" as const) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(contextItems.id, current.id))
      .returning();
    if (row) current = row;
    await enqueueIndex(db, { orgId, kind: "context_item", sourceId: current.id });
  }
  return current;
}

/** A person deletes an item for good (explicit; automatic jobs only archive or supersede). */
export async function deleteContextItem(db: Database, actorId: string, orgId: string, itemId: string) {
  const item = await loadItem(db, orgId, itemId);
  await requireEdit(db, actorId, item);
  await db.transaction(async (tx) => {
    await tx.delete(contextItems).where(eq(contextItems.id, itemId));
    await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: itemId });
  });
}

/**
 * A person adds a fact or note by hand (org context items need `configure`; agent notes need ownership). `viaApp`:
 * the text came through a connected AI app (ADR 0119), so it is outside content: only an agent's own memory, kept
 * high trust for that agent but unverified, which keeps it out of every promotion until a person confirms it.
 */
export async function addContextItemByPerson(
  db: Database,
  actorId: string,
  orgId: string,
  input: {
    kind: ContextKind;
    content: string;
    title?: string;
    agentId?: string | null;
    pinned?: boolean;
    viaApp?: boolean;
  },
  judge?: Judge,
) {
  if (input.viaApp && !input.agentId) throw new ValidationError("An app writes only an agent's own memory");
  const fake = { orgId, agentId: input.agentId ?? null } as ContextItem;
  await requireEdit(db, actorId, fake);
  await checkPermissionText(judge, orgId, `${input.title ?? ""}\n${input.content}`);
  if (input.agentId && !(await getAgent(db, orgId, input.agentId))) throw new NotFoundError("Agent not found");
  return db.transaction((tx) =>
    insertContextItem(tx, {
      orgId,
      kind: input.kind,
      scopeType: input.agentId ? "agent" : "org",
      scopeId: input.agentId ?? orgId,
      agentId: input.agentId ?? null,
      title: input.title,
      content: input.content,
      pinned: input.pinned,
      trust: "high",
      evidence: [{ type: input.viaApp ? "app" : "human", ref: actorId, at: new Date().toISOString() }],
      confidence: input.viaApp ? 0.8 : 0.95,
      createdByKind: "person",
      createdById: actorId,
    }),
  );
}

// ── Team memory (ADR 0167) ──────────────────────────────────────────────────

/** What a team memory may be: what every agent keeps for the whole team. */
export const TEAM_KINDS = ["rule", "preference", "fact", "decision"] as const;

/** A team memory: no agent's, in a person's words (theirs, or an admin's who made it the team's). */
export const teamMemorySql = () =>
  sql`(${contextItems.agentId} is null and ${contextItems.createdByKind} = 'person' and ${contextItems.kind} in ('rule', 'preference', 'fact', 'decision'))`;

/** The team's rules and preferences for the whole workspace: every run reads them in its cached prompt. */
export const teamWideSql = () =>
  sql`(${teamMemorySql()} and ${contextItems.kind} in ('rule', 'preference') and ${contextItems.channelIds} = '{}')`;

/** `teamWideSql` for an item in hand. */
export const isTeamWide = (i: Pick<ContextItem, "agentId" | "createdByKind" | "kind" | "channelIds">) =>
  !i.agentId &&
  i.createdByKind === "person" &&
  (i.kind === "rule" || i.kind === "preference") &&
  i.channelIds.length === 0;

/** "Memória do time": the current team memories a member may see (the channels they read). */
export async function listTeamMemories(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const visible = await userVisibleChannels(db, orgId, actorId);
  const items = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        teamMemorySql(),
        arrayContained(contextItems.channelIds, visible),
      ),
    )
    .orderBy(desc(contextItems.createdAt))
    .limit(200);
  return { items, visible };
}

/**
 * "Tornar do time": an agent's fact, decision, preference or rule becomes the team's, read by every agent, and the
 * copies agents kept of the same thing go (archived behind it, restorable). Who reviews memory. The person who said
 * it stays its author.
 */
export async function makeTeamMemory(db: Database, actorId: string, orgId: string, itemId: string) {
  await requirePermission(db, actorId, orgId, "review_memory");
  const item = await loadItem(db, orgId, itemId);
  if (!item.agentId || item.status !== "active" || !(TEAM_KINDS as readonly string[]).includes(item.kind))
    throw new ValidationError("Only an agent's current fact, decision, preference or rule can become the team's");
  return db.transaction(async (tx) => {
    const team = await insertContextItem(tx, {
      orgId,
      kind: item.kind,
      scopeType: "org",
      scopeId: orgId,
      agentId: null,
      subject: item.subjectKey,
      title: item.title,
      content: item.content,
      sourceIds: item.sourceIds,
      channelIds: [],
      trust: "high",
      evidence: mergeEvidence(item.evidence, [{ type: "human", ref: actorId, at: new Date().toISOString() }]),
      confidence: Math.max(item.confidence, 0.9),
      createdByKind: "person",
      createdById: personSaid(item) && item.createdById ? item.createdById : actorId,
    });
    const copies = (
      await tx
        .select()
        .from(contextItems)
        .where(
          and(
            eq(contextItems.orgId, orgId),
            eq(contextItems.status, "active"),
            isNull(contextItems.supersededBy),
            eq(contextItems.kind, item.kind),
            sql`${contextItems.agentId} is not null`,
          ),
        )
    ).filter(
      (c) =>
        c.id === item.id ||
        c.subjectKey === item.subjectKey ||
        similarity(c.content, item.content) >= SAME_ITEM_SIMILARITY,
    );
    for (const c of copies) {
      await tx
        .update(contextItems)
        .set({ status: "archived", supersededBy: team.id, updatedAt: new Date() })
        .where(eq(contextItems.id, c.id));
      await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: c.id });
      if (c.kind === "rule" && c.agentId) caches.contextPresence.delete(rulesPresenceKey(orgId, c.agentId));
    }
    return team;
  });
}

/** Items by id regardless of status (for `expand`). */
export async function getContextItems(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, ids)));
}

/**
 * Undoes a memory change made in conversation (the "desfazer" of the
 * "memory updated" card): a forgotten item comes back, an updated one
 * goes back to its previous version, a newly remembered one is archived.
 * Who may edit it (`requireEdit`), or the person an agent changed it for,
 * while that change's undo window is open. Someone else's preference is
 * not found unless they review memory.
 */
export async function revertMemoryChange(
  db: Database,
  actorId: string,
  orgId: string,
  itemId: string,
  now = new Date(),
) {
  const item = await loadItem(db, orgId, itemId);
  const membership = await requirePermission(db, actorId, orgId, "read");
  const visible = await userVisibleChannels(db, orgId, actorId);
  if (!itemVisibleIn(item, visible) || !seesPreference(membership, actorId, item))
    throw new NotFoundError("Item not found");
  const [asked] = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(
      and(
        eq(agentActions.orgId, orgId),
        eq(agentActions.targetType, "memory"),
        eq(agentActions.targetId, item.id),
        like(agentActions.kind, "memory.%"),
        eq(agentActions.requestedByUserId, actorId),
        gt(agentActions.undoableUntil, now),
      ),
    )
    .limit(1);
  if (!asked) await requireEdit(db, actorId, item);
  const [previous] = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.orgId, orgId), eq(contextItems.supersededBy, item.id)))
    .orderBy(desc(contextItems.createdAt))
    .limit(1);
  return db.transaction(async (tx) => {
    let restored: ContextItem;
    if (item.status === "archived" && !item.supersededBy) {
      const [row] = await tx
        .update(contextItems)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(contextItems.id, item.id))
        .returning();
      restored = row ?? item;
    } else if (previous) {
      const [row] = await tx
        .update(contextItems)
        .set({ status: "active", supersededBy: null, updatedAt: new Date() })
        .where(eq(contextItems.id, previous.id))
        .returning();
      await tx
        .update(contextItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(contextItems.id, item.id));
      restored = row ?? previous;
    } else {
      const [row] = await tx
        .update(contextItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(contextItems.id, item.id))
        .returning();
      restored = row ?? item;
    }
    for (const id of new Set([item.id, restored.id]))
      await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: id });
    return restored;
  });
}

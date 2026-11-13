import {
  MailAuthError,
  MailError,
  type MailMessage,
  type MailProvider,
  type MailSummary,
  type OutgoingMail,
} from "@agenteschat/adapters";
import { and, type Database, eq, gte, schema, sql } from "@agenteschat/db";
import { getAgent } from "../agents";
import { namesLabel, namesOf } from "../approvals";
import { type ArtifactDeps, createFileArtifact, fileReach } from "../artifacts";
import { canTalkTo, speakerFor } from "../audience";
import { recordAudit } from "../audit";
import { accountablePerson, fedByRoutine, type RunAuthority, runAuthorityById } from "../authority";
import { mailboxConnector } from "../connector-usage";
import { cutText } from "../format";
import { recordOperatorEvent } from "../operator-events";
import { routineCreatorOf } from "../requester";
import { replyThreadOf } from "../runs";
import type { CallCheck, ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import {
  connectorFor,
  MAIL_SCOPES,
  type MailAccountRow,
  type MailDeps,
  mailboxAddresses,
  mailSlugs,
  markNeedsReconnect,
  openAccount,
  orgMailAccounts,
} from "./accounts";
import { agentMailPolicies, type MailPolicy } from "./policies";
import { type MailPreview, mailDetail, withoutReplyPrefix } from "./preview";
import {
  addressDomain,
  cutBody,
  formatAddress,
  isEmailAddress,
  matchesAddressRules,
  normalizeAddress,
  oneLine,
  wrapUntrusted,
} from "./text";

const { mailSends } = schema;

export interface MailToolDeps extends Omit<MailDeps, "db"> {
  /** Drive files, for `attachment` (absent = that tool is off). */
  artifacts?: ArtifactDeps;
}

/**
 * What each verb does to the mailbox. Sending is decided by this table,
 * never by a tool's name: a verb missing here counts as a send.
 */
type Effect = "read" | "draft" | "send" | "organize" | "delete";
const EFFECTS: Record<string, Effect> = {
  search: "read",
  read: "read",
  folders: "read",
  attachment: "read",
  draft: "draft",
  send: "send",
  reply: "send",
  forward: "send",
  move: "organize",
  mark: "organize",
  archive: "organize",
  trash: "delete",
};
const effectOf = (verb: string): Effect => EFFECTS[verb] ?? "send";

/** The action people turn on or off for a mailbox ("O que faz") that each verb belongs to. */
const ACTION_OF: Record<string, string> = {
  attachment: "read",
  move: "organize",
  mark: "organize",
  archive: "organize",
  trash: "delete",
};
const actionOf = (verb: string) => ACTION_OF[verb] ?? verb;
const SCOPE_OF: Record<Effect, string> = {
  read: MAIL_SCOPES.read,
  draft: MAIL_SCOPES.draft,
  send: MAIL_SCOPES.send,
  organize: MAIL_SCOPES.organize,
  delete: MAIL_SCOPES.delete,
};

const DETAIL_BODY_CHARS = 1500;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const addresses = (v: unknown) => list(v).map(normalizeAddress).filter(Boolean);
const shown = (rules: string[]) => rules.join(", ");

const ARRAY_OF_ADDRESSES = { type: "array", items: { type: "string", maxLength: 320 }, maxItems: 50 };
const MESSAGE_ID = { type: "string", minLength: 1, maxLength: 500, description: "The message id from search results." };

/** The day (UTC) a send counts toward the cap. */
const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Who decides an action in a person's own mailbox: that person (ADR 0038). Asked by them, admins may decide it too;
 * asked by anyone else (or nobody), only they do: an email in their name is theirs to approve. Once they left the
 * workspace nobody could, so the usual rule (the agent's owner, admins) applies.
 */
async function mailboxApprovers(db: Database, orgId: string, ownerId: string, requestedBy: string | null) {
  const [member] = await db
    .select({ id: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, ownerId)));
  if (!member) return { ok: true as const, approvers: null };
  const own = requestedBy === ownerId;
  return {
    ok: true as const,
    approvers: {
      userIds: [ownerId],
      label: namesLabel(await namesOf(db, [ownerId])),
      requestedBy: own ? null : requestedBy,
      requesterDecides: false,
      ...(own ? {} : { required: true }),
    },
  };
}

/**
 * Whether the person behind a run may use a person's own mailbox through this agent: its owner, or someone the agent
 * answers directly, as its owner gave it access for (a consultation by someone outside its audience doesn't count).
 * Nobody behind the run (an agent's own work, a watch): nobody's reach widens.
 */
async function mailboxUserCheck(ctx: ToolContext, authority: RunAuthority | null) {
  // A routine's run answers for its creator, as the gateway asks them (`routineCreatorOf`).
  const person = authority ? (accountablePerson(authority) ?? routineCreatorOf(authority)) : null;
  const agent = person ? await getAgent(ctx.db, ctx.orgId, ctx.agentId) : null;
  const direct = !person || (!!agent && canTalkTo(agent, person, await speakerFor(ctx.db, ctx.orgId, person)));
  return (account: Pick<MailAccountRow, "createdByUserId">) =>
    direct || !account.createdByUserId || account.createdByUserId === person;
}

/** Why a message is outside what the agent may read; null = inside. */
function messageRefusal(policy: MailPolicy, m: MailSummary, now: Date): string | null {
  if (policy.folders.length > 0 && (!m.folder || !policy.folders.includes(m.folder))) {
    return `Not allowed: this agent may only read mail in the folders ${shown(policy.folders)}.`;
  }
  if (policy.senders.length > 0 && (!m.from || !matchesAddressRules(policy.senders, m.from.address))) {
    return `Not allowed: this agent may only read mail from ${shown(policy.senders)}.`;
  }
  if (policy.windowDays !== null) {
    const since = now.getTime() - policy.windowDays * 86_400_000;
    const at = Date.parse(m.date);
    if (Number.isNaN(at) || at < since) {
      return `Not allowed: this agent may only read mail from the last ${policy.windowDays} days.`;
    }
  }
  return null;
}

function replyRecipients(original: MailMessage, own: string[], replyAll: boolean) {
  const mine = new Set(own.map(normalizeAddress));
  const first = original.replyTo.length > 0 ? original.replyTo : original.from ? [original.from] : [];
  const to = [...new Set(first.map((a) => normalizeAddress(a.address)))].filter((a) => !mine.has(a));
  const cc = replyAll
    ? [...new Set([...original.to, ...original.cc].map((a) => normalizeAddress(a.address)))].filter(
        (a) => !mine.has(a) && !to.includes(a),
      )
    : [];
  // A reply to our own sent message goes back to its recipients.
  if (to.length === 0 && original.from && mine.has(normalizeAddress(original.from.address))) {
    return { to: original.to.map((a) => normalizeAddress(a.address)).filter((a) => !mine.has(a)), cc };
  }
  return { to, cc };
}

/**
 * The mailbox address a message reached, so the answer goes out from it: our
 * own From (a message we sent), then To, then Cc, then where the server
 * delivered it (an alias only: servers deliver every alias to the main
 * address). Null = none of them is ours.
 */
export function arrivedAt(m: MailMessage, own: string[]): string | null {
  const mine = own.map(normalizeAddress);
  const ours = (a: string) => mine.includes(normalizeAddress(a));
  if (m.from && ours(m.from.address)) return normalizeAddress(m.from.address);
  const seen = [...m.to, ...m.cc].map((a) => a.address).find(ours);
  if (seen) return normalizeAddress(seen);
  const delivered = (m.deliveredTo ?? []).find((a) => ours(a) && normalizeAddress(a) !== mine[0]);
  return delivered ? normalizeAddress(delivered) : null;
}

const prefixed = (prefix: string, subject: string) =>
  subject.toLowerCase().startsWith(prefix.toLowerCase()) ? subject : `${prefix} ${subject}`;

/** The exact message a send verb will send (recipients computed from the original for replies). */
interface Planned {
  kind: "send" | "reply" | "forward";
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

function summaryLine(m: MailSummary) {
  const flags = [m.unread ? "unread" : null, m.flagged ? "flagged" : null, m.hasAttachments ? "attachments" : null]
    .filter(Boolean)
    .join(", ");
  return [
    `id: ${m.id}`,
    `date: ${m.date}`,
    `from: ${formatAddress(m.from)}`,
    `subject: ${oneLine(m.subject, 300)}`,
    ...(m.folder ? [`folder: ${m.folder}`] : []),
    ...(flags ? [`flags: ${flags}`] : []),
    `snippet: ${oneLine(m.snippet, 200)}`,
  ].join("\n");
}

function messageText(m: MailMessage) {
  return [
    `id: ${m.id}`,
    ...(m.threadId ? [`thread: ${m.threadId}`] : []),
    `date: ${m.date}`,
    `from: ${formatAddress(m.from)}`,
    `to: ${m.to.map(formatAddress).join(", ")}`,
    ...(m.cc.length > 0 ? [`cc: ${m.cc.map(formatAddress).join(", ")}`] : []),
    ...(m.replyTo.length > 0 ? [`reply-to: ${m.replyTo.map(formatAddress).join(", ")}`] : []),
    `subject: ${oneLine(m.subject, 500)}`,
    ...(m.folder ? [`folder: ${m.folder}`] : []),
    ...(m.attachments.length > 0
      ? [
          `attachments: ${m.attachments
            .map((a) => `${oneLine(a.filename, 120)} (id ${a.id}, ${a.contentType}, ${a.size} bytes)`)
            .join("; ")}`,
        ]
      : []),
    "",
    cutBody(m.text),
  ].join("\n");
}

/**
 * The org's mailboxes as tools (ADR 0038): `mail_<slug>_<verb>` per active
 * account, with `connectionId` = the account, so an agent sees only the
 * mailboxes and verbs it was granted. Every call's arguments are checked
 * against the agent's policy (`checkCall`) before running or asking anyone,
 * and again before an approved send. Mailbox text reaches the model only
 * wrapped as untrusted.
 */
export function createMailToolSource(deps: MailToolDeps): ToolSource {
  /** Originals read by `checkCall`, so `describe` can show a reply's exact recipients. */
  const originals = new Map<string, { at: number; message: MailMessage }>();
  const ORIGINAL_TTL_MS = 10 * 60_000;
  const now = () => deps.now?.() ?? new Date();

  const remember = (accountId: string, m: MailMessage) => {
    const t = Date.now();
    for (const [k, v] of originals) if (t - v.at > ORIGINAL_TTL_MS) originals.delete(k);
    originals.set(`${accountId}|${m.id}`, { at: t, message: m });
  };
  const recalled = (accountId: string, id: string) => originals.get(`${accountId}|${id}`)?.message ?? null;

  async function withMailbox<T>(db: Database, account: MailAccountRow, fn: (p: MailProvider) => Promise<T>) {
    const provider = await openAccount({ ...deps, db }, account);
    try {
      return await fn(provider);
    } finally {
      await provider.close().catch(() => {});
    }
  }

  async function read(db: Database, account: MailAccountRow, id: string) {
    const m = await withMailbox(db, account, (p) => p.read(id));
    remember(account.id, m);
    return m;
  }

  /** A mailbox failure as the model sees it; refused credentials mark the account for reconnecting. */
  async function failure(db: Database, account: MailAccountRow, error: unknown): Promise<ToolOutput> {
    if (error instanceof MailAuthError) {
      await markNeedsReconnect(db, account.id, error.message).catch(() => {});
      return {
        content: `The mailbox ${account.address} needs to be reconnected by a person (its sign-in expired or the password changed). Tell the person; don't retry.`,
        isError: true,
        data: { mailAccountId: account.id, needsReconnect: true },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const retry = error instanceof MailError && error.retryable ? " (temporary; you may retry later)" : "";
    return { content: `Mailbox error${retry}: ${message}`, isError: true };
  }

  async function checkFailure(db: Database, account: MailAccountRow, error: unknown): Promise<CallCheck> {
    const out = await failure(db, account, error);
    return { ok: false, message: out.content, data: out.data };
  }

  function toolsFor(account: MailAccountRow, slug: string, policy: MailPolicy, askToSend: boolean): ToolDefinition[] {
    const label = `[Email ${account.address}]`;
    const owner = account.createdByUserId;
    const own = [...new Set([...mailboxAddresses(account), ...(policy.fromAddress ? [policy.fromAddress] : [])])];
    /** The agent's own address, when a person pinned one: the only From it may use. */
    const pinned = policy.fromAddress;
    const allowedFrom = pinned ? [pinned] : own;
    /** New mail: the pinned address, else the mailbox's default. */
    const newFrom = pinned ?? account.defaultFrom ?? account.address;
    /** An answer (reply, forward, reply draft): the pinned address, else the one the message reached, else the default. */
    const answerFrom = (original: MailMessage | null) =>
      pinned ?? (original ? arrivedAt(original, own) : null) ?? account.defaultFrom ?? account.address;
    /** The From the model asked for, if any (checked against `allowedFrom` before anything runs). */
    const askedFrom = (input: Record<string, unknown>) => (str(input.from) ? normalizeAddress(str(input.from)) : null);
    const fromRefusal = (input: Record<string, unknown>): CallCheck | null => {
      const from = askedFrom(input);
      if (!from || allowedFrom.includes(from)) return null;
      return {
        ok: false,
        message: pinned
          ? `Not allowed: send from ${pinned} (the only From address this agent may use).`
          : `Not allowed: ${from} is not an address of this mailbox. Use one of ${shown(own)}.`,
      };
    };
    /** Only an address other than the mailbox's own goes to the provider (which sends as itself by default). */
    const fromField = (from: string) => (from !== account.address ? { from } : {});

    const make = (
      verb: string,
      description: string,
      inputSchema: Record<string, unknown>,
      extra: Pick<ToolDefinition, "execute"> & Partial<ToolDefinition>,
    ): ToolDefinition => {
      const effect = effectOf(verb);
      return {
        name: `mail_${slug}_${verb}`,
        description: `${label} ${description}`.slice(0, 1024),
        inputSchema: { type: "object", additionalProperties: false, ...inputSchema },
        scope: SCOPE_OF[effect],
        connectionId: account.id,
        connector: { ...mailboxConnector(account), tool: verb },
        connectorLabel: "Email",
        service: account.preset ?? account.provider,
        sensitive:
          effect === "delete" || (effect === "send" && askToSend) || account.askActions.includes(actionOf(verb)),
        ...(effect === "read" ? { readsOutside: true as const } : {}),
        ...(owner
          ? { approvers: (_input, ctx, requestedBy) => mailboxApprovers(ctx.db, ctx.orgId, owner, requestedBy) }
          : {}),
        ...extra,
      };
    };

    // ── Reading ──────────────────────────────────────────────────────────
    const folderAllowed = (folder: string | undefined): CallCheck =>
      folder && policy.folders.length > 0 && !policy.folders.includes(folder)
        ? { ok: false, message: `Not allowed: this agent may only use the folders ${shown(policy.folders)}.` }
        : { ok: true };

    const checkMessage = async (db: Database, id: string): Promise<CallCheck> => {
      try {
        const m = await read(db, account, id);
        const refused = messageRefusal(policy, m, now());
        return refused ? { ok: false, message: refused, data: { mailAccountId: account.id } } : { ok: true };
      } catch (error) {
        return checkFailure(db, account, error);
      }
    };

    const search = make(
      "search",
      "Search this mailbox (newest first). Returns ids, senders, subjects and short snippets; read a message with the read tool.",
      {
        properties: {
          folder: {
            type: "string",
            maxLength: 300,
            description: "Folder id from the folders tool; default the inbox.",
          },
          from: { type: "string", maxLength: 320, description: "Sender address or @domain." },
          to: { type: "string", maxLength: 320 },
          subject: { type: "string", maxLength: 300 },
          text: { type: "string", maxLength: 300, description: "Words in the subject or body." },
          since: { type: "string", maxLength: 40, description: "ISO date (inclusive)." },
          before: { type: "string", maxLength: 40, description: "ISO date (exclusive)." },
          unread_only: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      {
        checkCall: async (input) => folderAllowed(str(input.folder) || undefined),
        execute: async (input, ctx) => {
          try {
            const t = now();
            let since = str(input.since) || undefined;
            if (policy.windowDays !== null) {
              const floor = new Date(t.getTime() - policy.windowDays * 86_400_000).toISOString();
              if (!since || since < floor) since = floor;
            }
            const results = await withMailbox(ctx.db, account, (p) =>
              p.search({
                folder: str(input.folder) || policy.folders[0] || undefined,
                from: str(input.from) || undefined,
                to: str(input.to) || undefined,
                subject: str(input.subject) || undefined,
                text: str(input.text) || undefined,
                since,
                before: str(input.before) || undefined,
                unreadOnly: input.unread_only === true,
                limit: typeof input.limit === "number" ? input.limit : 20,
              }),
            );
            const visible = results.filter((m) => !messageRefusal(policy, m, t));
            if (visible.length === 0) return { content: "No messages found.", data: { count: 0 } };
            return {
              content: wrapUntrusted(visible.map(summaryLine).join("\n\n")),
              data: { count: visible.length },
            };
          } catch (error) {
            return failure(ctx.db, account, error);
          }
        },
      },
    );

    const readTool = make(
      "read",
      "Read one message in full (headers, text, attachment list).",
      { properties: { message_id: MESSAGE_ID }, required: ["message_id"] },
      {
        checkCall: (input, ctx) => checkMessage(ctx.db, str(input.message_id)),
        execute: async (input, ctx) => {
          try {
            const m =
              recalled(account.id, str(input.message_id)) ?? (await read(ctx.db, account, str(input.message_id)));
            return { content: wrapUntrusted(messageText(m)), data: { messageId: m.id } };
          } catch (error) {
            return failure(ctx.db, account, error);
          }
        },
      },
    );

    const folders = make(
      "folders",
      "List this mailbox's folders (ids to use in the other tools).",
      { properties: {} },
      {
        execute: async (_input, ctx) => {
          try {
            const all = await withMailbox(ctx.db, account, (p) => p.listFolders());
            const shownFolders = policy.folders.length > 0 ? all.filter((f) => policy.folders.includes(f.id)) : all;
            return {
              content: wrapUntrusted(
                shownFolders
                  .map((f) => `${f.id}${f.name !== f.id ? ` (${f.name})` : ""}${f.role ? ` [${f.role}]` : ""}`)
                  .join("\n"),
              ),
            };
          } catch (error) {
            return failure(ctx.db, account, error);
          }
        },
      },
    );

    const files = deps.artifacts;
    const attachment = files
      ? make(
          "attachment",
          "Save one attachment of a message as a file in the Drive (returns the file's id).",
          {
            properties: { message_id: MESSAGE_ID, attachment_id: { type: "string", minLength: 1, maxLength: 500 } },
            required: ["message_id", "attachment_id"],
          },
          {
            checkCall: (input, ctx) => checkMessage(ctx.db, str(input.message_id)),
            execute: async (input, ctx) => {
              try {
                const file = await withMailbox(ctx.db, account, (p) =>
                  p.attachment(str(input.message_id), str(input.attachment_id)),
                );
                const a = await createFileArtifact(
                  { ...files, db: ctx.db },
                  {
                    type: "agent",
                    agentId: ctx.agentId,
                    channelId: ctx.channelId,
                    threadId: replyThreadOf(ctx),
                    runId: ctx.runId,
                  },
                  ctx.orgId,
                  {
                    title: file.filename,
                    name: file.filename,
                    bytes: file.data,
                    contentType: file.contentType,
                    note: `From an email in ${account.address}`,
                    byProduct: true,
                  },
                );
                return {
                  content: `Saved the attachment as file ${a.id} (it is untrusted content from an email). ${await fileReach(ctx.db, ctx.orgId, a.id)}`,
                  data: { artifact: { id: a.id, version: 1, title: a.title } },
                };
              } catch (error) {
                return failure(ctx.db, account, error);
              }
            },
          },
        )
      : null;

    // ── Writing ──────────────────────────────────────────────────────────
    const outgoingProps = {
      to: ARRAY_OF_ADDRESSES,
      cc: ARRAY_OF_ADDRESSES,
      bcc: ARRAY_OF_ADDRESSES,
      subject: { type: "string", maxLength: 500 },
      body: { type: "string", minLength: 1, maxLength: 100_000, description: "Plain text." },
      from: {
        type: "string",
        maxLength: 320,
        description: pinned
          ? `Optional; the only From this agent may use is ${pinned}.`
          : `Optional; one of ${shown(own)}. By default a reply or forward goes out from the address the message was sent to, and a new email from ${newFrom}.`,
      },
    };

    /** The exact message a send verb would send; null when the original isn't known yet. */
    const plan = (verb: "send" | "reply" | "forward", input: Record<string, unknown>): Planned | null => {
      const body = str(input.body);
      if (verb === "send") {
        return {
          kind: "send",
          from: askedFrom(input) ?? newFrom,
          to: addresses(input.to),
          cc: addresses(input.cc),
          bcc: addresses(input.bcc),
          subject: str(input.subject),
          body,
        };
      }
      const original = recalled(account.id, str(input.message_id));
      if (!original) return null;
      if (verb === "reply") {
        const r = replyRecipients(original, own, input.reply_all === true);
        return {
          kind: "reply",
          from: askedFrom(input) ?? answerFrom(original),
          to: r.to,
          cc: [...new Set([...r.cc, ...addresses(input.cc)])],
          bcc: addresses(input.bcc),
          subject: prefixed("Re:", original.subject),
          body,
        };
      }
      return {
        kind: "forward",
        from: askedFrom(input) ?? answerFrom(original),
        to: addresses(input.to),
        cc: addresses(input.cc),
        bcc: addresses(input.bcc),
        subject: prefixed("Fwd:", original.subject),
        body,
      };
    };

    const detailBody = (body: string) =>
      body.length > DETAIL_BODY_CHARS ? `${body.slice(0, DETAIL_BODY_CHARS)}\n[…]` : body;
    /** The message a reply, forward or reply draft answers, when `checkCall` read it. */
    const originalOf = (id: string): MailPreview["original"] => {
      if (!id) return null;
      const m = recalled(account.id, id);
      return m ? { subject: m.subject, from: m.from?.address ?? null } : null;
    };

    const describeSend = (verb: "send" | "reply" | "forward") => (input: Record<string, unknown>) => {
      const p = plan(verb, input);
      if (!p) {
        return {
          title: `${verb === "reply" ? "Reply to" : "Forward"} email ${str(input.message_id)} from ${account.address}`,
          detail: `From: ${askedFrom(input) ?? answerFrom(null)}\n\n${str(input.body).slice(0, DETAIL_BODY_CHARS)}`,
        };
      }
      const action = verb === "send" ? "Send email to" : verb === "reply" ? "Reply by email to" : "Forward email to";
      return {
        title: `${action} ${[...p.to, ...p.cc, ...p.bcc].join(", ")}: "${oneLine(p.subject, 120)}"`,
        detail: mailDetail({
          from: p.from,
          to: p.to,
          cc: p.cc,
          bcc: p.bcc,
          subject: p.subject,
          body: detailBody(p.body),
          original: verb === "send" ? null : originalOf(str(input.message_id)),
        }),
      };
    };

    /** A draft's From: asked for, else as an answer to the message it replies to, else new mail's. */
    const draftFrom = (input: Record<string, unknown>) => {
      const replyTo = str(input.in_reply_to);
      return askedFrom(input) ?? (replyTo ? answerFrom(recalled(account.id, replyTo)) : newFrom);
    };

    /** A draft as its card shows it: From, To, Subject, the text and the message it answers. */
    const describeDraft = (input: Record<string, unknown>) => {
      const to = [...addresses(input.to), ...addresses(input.cc), ...addresses(input.bcc)];
      const replyTo = str(input.in_reply_to);
      const original = replyTo
        ? (originalOf(replyTo) ?? { subject: withoutReplyPrefix(str(input.subject)), from: null })
        : null;
      const verb = replyTo ? "Save a draft reply" : "Save a draft";
      return {
        title: `${verb}${to.length > 0 ? ` to ${to.join(", ")}` : ""} in ${account.address}: "${oneLine(str(input.subject), 120)}"`,
        detail: mailDetail({
          from: draftFrom(input),
          to: addresses(input.to),
          cc: addresses(input.cc),
          bcc: addresses(input.bcc),
          subject: str(input.subject),
          body: detailBody(str(input.body)),
          original,
        }),
      };
    };

    /** Recipients, From and the daily cap: every send verb, before asking anyone and again before sending. */
    const checkSend =
      (verb: "send" | "reply" | "forward") =>
      async (input: Record<string, unknown>, ctx: ToolContext): Promise<CallCheck> => {
        const refused = fromRefusal(input);
        if (refused) return refused;
        if (verb !== "send") {
          const read = await checkMessage(ctx.db, str(input.message_id));
          if (!read.ok) return read;
        }
        const p = plan(verb, input);
        if (!p) return { ok: false, message: "Could not read the original message." };
        const recipients = [...p.to, ...p.cc, ...p.bcc];
        if (p.to.length === 0) return { ok: false, message: "Give at least one recipient in to." };
        const invalid = recipients.find((a) => !isEmailAddress(a));
        if (invalid) return { ok: false, message: `"${invalid}" is not an email address.` };
        if (policy.allowedRecipients.length > 0) {
          const outside = recipients.filter((a) => !matchesAddressRules(policy.allowedRecipients, a));
          if (outside.length > 0) {
            return {
              ok: false,
              message: `Not allowed: ${outside.join(", ")} ${outside.length > 1 ? "are not allowed recipients" : "is not an allowed recipient"}. This agent may only email ${shown(policy.allowedRecipients)}.`,
              data: { deniedRecipients: outside },
            };
          }
        }
        const [row] = await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(mailSends)
          .where(
            and(
              eq(mailSends.agentId, ctx.agentId),
              eq(mailSends.accountId, account.id),
              gte(mailSends.sentAt, utcDayStart(now())),
            ),
          );
        if ((row?.n ?? 0) >= policy.dailySendCap) {
          return {
            ok: false,
            message: `Not allowed: this agent reached its limit of ${policy.dailySendCap} emails a day from ${account.address}. Try again tomorrow (UTC) or ask a person to raise the limit.`,
          };
        }
        return { ok: true, data: { mailAccountId: account.id, recipients } };
      };

    const executeSend =
      (verb: "send" | "reply" | "forward") => async (input: Record<string, unknown>, ctx: ToolContext) => {
        try {
          if (verb !== "send" && !recalled(account.id, str(input.message_id)))
            await read(ctx.db, account, str(input.message_id));
          const p = plan(verb, input);
          if (!p) return { content: "Could not read the original message.", isError: true };
          const mail: OutgoingMail = {
            ...fromField(p.from),
            to: p.to,
            cc: p.cc,
            bcc: p.bcc,
            subject: p.subject,
            text: p.body,
            ...(verb === "reply" ? { inReplyTo: str(input.message_id) } : {}),
            ...(verb === "forward" ? { forwardOf: str(input.message_id) } : {}),
          };
          const sent = await withMailbox(ctx.db, account, (provider) => provider.send(mail));
          const recipients = [...p.to, ...p.cc, ...p.bcc];
          await ctx.db.insert(mailSends).values({
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            accountId: account.id,
            runId: ctx.runId || null,
            kind: verb,
            recipients,
            subject: p.subject.slice(0, 500),
            providerMessageId: sent.id,
          });
          await recordAudit(ctx.db, {
            orgId: ctx.orgId,
            actor: { type: "agent", id: ctx.agentId },
            action: "mail.sent",
            target: { type: "mail_account", id: account.id },
            details: { kind: verb, recipients, subject: cutText(p.subject, 200), runId: ctx.runId },
          });
          await recordOperatorEvent(ctx.db, {
            type: "mail.sent",
            orgId: ctx.orgId,
            data: {
              agentId: ctx.agentId,
              runId: ctx.runId || null,
              kind: verb,
              recipients: recipients.length,
              domains: [...new Set(recipients.map(addressDomain))],
            },
          });
          return {
            content: `Sent "${oneLine(p.subject, 120)}" to ${recipients.join(", ")} from ${p.from}.`,
            data: { mailAccountId: account.id, recipients, providerMessageId: sent.id },
          };
        } catch (error) {
          return failure(ctx.db, account, error);
        }
      };

    const send = make(
      "send",
      "Send a new email. A person approves each send unless this agent was set up to send to these recipients without asking.",
      { properties: outgoingProps, required: ["to", "subject", "body"] },
      { describe: describeSend("send"), checkCall: checkSend("send"), execute: executeSend("send") },
    );
    const reply = make(
      "reply",
      "Reply to a message in its thread (recipients come from the original; reply_all adds its other recipients).",
      {
        properties: {
          message_id: MESSAGE_ID,
          body: outgoingProps.body,
          reply_all: { type: "boolean" },
          cc: ARRAY_OF_ADDRESSES,
          bcc: ARRAY_OF_ADDRESSES,
          from: outgoingProps.from,
        },
        required: ["message_id", "body"],
      },
      { describe: describeSend("reply"), checkCall: checkSend("reply"), execute: executeSend("reply") },
    );
    const forward = make(
      "forward",
      "Forward a message (with its attachments) to other people, with an optional note above it.",
      {
        properties: {
          message_id: MESSAGE_ID,
          to: ARRAY_OF_ADDRESSES,
          cc: ARRAY_OF_ADDRESSES,
          bcc: ARRAY_OF_ADDRESSES,
          body: { type: "string", maxLength: 100_000 },
          from: outgoingProps.from,
        },
        required: ["message_id", "to"],
      },
      { describe: describeSend("forward"), checkCall: checkSend("forward"), execute: executeSend("forward") },
    );

    const draft = make(
      "draft",
      "Save a draft in the mailbox for a person to review and send (never sends).",
      { properties: { ...outgoingProps, in_reply_to: MESSAGE_ID }, required: ["subject", "body"] },
      {
        describe: describeDraft,
        checkCall: async (input, ctx) => {
          const refused = fromRefusal(input);
          if (refused) return refused;
          // A reply draft answers a message this agent may read (and its card says which one).
          return str(input.in_reply_to) ? checkMessage(ctx.db, str(input.in_reply_to)) : { ok: true };
        },
        execute: async (input, ctx) => {
          try {
            const saved = await withMailbox(ctx.db, account, (p) =>
              p.createDraft({
                ...fromField(draftFrom(input)),
                to: addresses(input.to),
                cc: addresses(input.cc),
                bcc: addresses(input.bcc),
                subject: str(input.subject),
                text: str(input.body),
                ...(str(input.in_reply_to) ? { inReplyTo: str(input.in_reply_to) } : {}),
              }),
            );
            return { content: `Draft saved in ${account.address} (id ${saved.id}).`, data: { draftId: saved.id } };
          } catch (error) {
            return failure(ctx.db, account, error);
          }
        },
      },
    );

    // ── Organizing ───────────────────────────────────────────────────────
    const organize = (
      verb: "move" | "mark" | "archive" | "trash",
      description: string,
      properties: Record<string, unknown>,
      required: string[],
      run: (p: MailProvider, input: Record<string, unknown>) => Promise<void>,
      done: (input: Record<string, unknown>) => string,
      checkCall?: ToolDefinition["checkCall"],
    ) =>
      make(
        verb,
        description,
        { properties: { message_id: MESSAGE_ID, ...properties }, required: ["message_id", ...required] },
        {
          ...(checkCall ? { checkCall } : {}),
          ...(verb === "trash"
            ? {
                describe: (input: Record<string, unknown>) => {
                  const m = recalled(account.id, str(input.message_id));
                  return {
                    title: `Delete email${m ? ` "${oneLine(m.subject, 120)}" from ${m.from?.address ?? "?"}` : ` ${str(input.message_id)}`} in ${account.address}`,
                    detail: `Moves the message to the trash of ${account.address}.`,
                  };
                },
              }
            : {}),
          execute: async (input, ctx) => {
            try {
              await withMailbox(ctx.db, account, (p) => run(p, input));
              await recordAudit(ctx.db, {
                orgId: ctx.orgId,
                actor: { type: "agent", id: ctx.agentId },
                action: `mail.${verb}`,
                target: { type: "mail_account", id: account.id },
                details: { messageId: str(input.message_id), runId: ctx.runId },
              }).catch(() => {});
              return { content: done(input), data: { mailAccountId: account.id } };
            } catch (error) {
              return failure(ctx.db, account, error);
            }
          },
        },
      );

    const move = organize(
      "move",
      "Move a message to another folder.",
      { folder: { type: "string", minLength: 1, maxLength: 300, description: "Folder id from the folders tool." } },
      ["folder"],
      (p, input) => p.move(str(input.message_id), str(input.folder)),
      (input) => `Moved to ${str(input.folder)}.`,
      async (input) => folderAllowed(str(input.folder)),
    );
    const mark = organize(
      "mark",
      "Mark a message read or unread, flagged or not.",
      { read: { type: "boolean" }, flagged: { type: "boolean" } },
      [],
      (p, input) =>
        p.setFlags(str(input.message_id), {
          ...(typeof input.read === "boolean" ? { read: input.read } : {}),
          ...(typeof input.flagged === "boolean" ? { flagged: input.flagged } : {}),
        }),
      () => "Done.",
    );
    const archive = organize(
      "archive",
      "Archive a message (out of the inbox, kept).",
      {},
      [],
      (p, input) => p.archive(str(input.message_id)),
      () => "Archived.",
    );
    const trash = organize(
      "trash",
      "Move a message to the trash. A person approves every deletion.",
      {},
      [],
      (p, input) => p.trash(str(input.message_id)),
      () => "Moved to the trash.",
      async (input, ctx) => {
        // Read it first: the approval card says which message goes.
        try {
          await read(ctx.db, account, str(input.message_id));
          return { ok: true };
        } catch (error) {
          return checkFailure(ctx.db, account, error);
        }
      },
    );

    // Actions an admin turned off for this mailbox never become tools.
    const off = new Set(account.offActions);
    const prefix = `mail_${slug}_`;
    return [
      search,
      readTool,
      folders,
      ...(attachment ? [attachment] : []),
      draft,
      send,
      reply,
      forward,
      move,
      mark,
      archive,
      trash,
    ].filter((tool) => !off.has(actionOf(tool.name.slice(prefix.length))));
  }

  return {
    name: "mail",
    async tools(ctx) {
      if (!deps.mail?.composio && !deps.mail?.imap) return [];
      const accounts = await orgMailAccounts(ctx.db, ctx.orgId);
      if (accounts.length === 0) return [];
      const slugs = mailSlugs(accounts.filter((a) => a.address));
      const active = accounts.filter((a) => a.status === "active" && connectorFor(deps, a.via));
      if (active.length === 0) return [];
      const authority = ctx.runId ? await runAuthorityById(ctx.db, ctx.orgId, ctx.runId) : null;
      const usable = active.filter(await mailboxUserCheck(ctx, authority));
      if (usable.length === 0) return [];
      const policies = await agentMailPolicies(
        ctx.db,
        ctx.orgId,
        ctx.agentId,
        usable.map((a) => a.id),
      );
      // A routine's reading feeds this run (`fedByRoutine`): a send always asks a person, whatever the mailbox policy
      // says, since what it read (inbound mail included) can't approve its own sends (ADR 0038).
      const tainted = fedByRoutine(authority);
      return usable.flatMap((a) => {
        const policy = policies.get(a.id);
        if (!policy) return [];
        const askToSend = tainted || !(policy.sendWithoutAsking && policy.allowedRecipients.length > 0);
        return toolsFor(a, slugs.get(a.id) ?? "mailbox", policy, askToSend);
      });
    },
  };
}

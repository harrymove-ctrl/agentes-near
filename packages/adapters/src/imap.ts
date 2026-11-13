/**
 * IMAP/SMTP mail adapter (ADR 0038): iCloud, hosting mail, Fastmail, Zoho,
 * Yahoo and any IMAP server, with an app password. `imapflow` for IMAP,
 * `nodemailer` for SMTP and MIME building, `mailparser` for MIME parsing.
 *
 * - TLS always, with certificate verification (993 implicit TLS, 143 forced
 *   STARTTLS; SMTP 465 implicit TLS, anything else STARTTLS required).
 * - Read paths open folders with EXAMINE and fetch with BODY.PEEK: a bug here
 *   can't change the mailbox or mark mail as read. `ImapSession` has no fetch
 *   that isn't a peek.
 * - `checkHost` (the server's SSRF guard) runs for both hosts before any
 *   connection.
 * - The password never appears in errors or logs.
 */
import { randomUUID } from "node:crypto";
import type { ConnectionOptions } from "node:tls";
import { ImapFlow, type SearchObject } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import {
  classifyTestError,
  decodePartText,
  encodeMessageId,
  findTextPart,
  foldersWithRoles,
  forwardBody,
  forwardSubject,
  type ImapMailbox,
  type ImapMessageMeta,
  listAttachments,
  messageGone,
  parseMessage,
  parseMessageId,
  pickNewest,
  planPoll,
  queryToSearch,
  redact,
  replyHeaders,
  replySubject,
  searchLimit,
  summaryFromMeta,
  toMailError,
} from "./imap-parse";
import {
  type MailAccountRef,
  MailAuthError,
  type MailConnectionTester,
  type MailConnector,
  MailError,
  type MailFolder,
  type MailFolderRole,
  type MailMessage,
  type MailPoller,
  type MailProvider,
  type MailSummary,
  type OutgoingMail,
} from "./mail";

export type { ImapMailbox, ImapMessageMeta } from "./imap-parse";

// ---------------------------------------------------------------------------
// The IMAP and SMTP clients behind small interfaces (fakes in tests).

export interface ImapMailboxStatus {
  path: string;
  uidValidity: number;
  uidNext: number;
  exists: number;
  /** What the server confirmed ([READ-ONLY] after EXAMINE). */
  readOnly: boolean;
}

/** One IMAP connection. Every fetch is a peek (never sets \Seen). */
export interface ImapSession {
  list(): Promise<ImapMailbox[]>;
  /** `readOnly: true` = EXAMINE; false = SELECT (only for move, flags). */
  open(path: string, options: { readOnly: boolean }): Promise<ImapMailboxStatus>;
  /** UID SEARCH in the open folder. */
  search(criteria: SearchObject): Promise<number[]>;
  /** Flags, envelope, structure and internal date (UID FETCH). */
  fetchMeta(uids: number[]): Promise<ImapMessageMeta[]>;
  /** The first `maxBytes` of one raw body part per message (BODY.PEEK[part]<0.max>). */
  fetchPart(uids: number[], part: string, maxBytes: number): Promise<Map<number, Uint8Array>>;
  /** The full message (BODY.PEEK[]). */
  fetchSource(uid: number): Promise<Uint8Array | null>;
  /** One part, transfer encoding decoded (BODY.PEEK[part]). */
  download(uid: number, part: string, maxBytes: number): Promise<{ data: Uint8Array; contentType?: string } | null>;
  append(path: string, raw: Uint8Array, flags: string[]): Promise<{ uid?: number; uidValidity?: number }>;
  /** MOVE, or COPY + \Deleted + EXPUNGE when the server has no MOVE. Needs a SELECTed folder. */
  move(uid: number, destination: string): Promise<void>;
  addFlags(uid: number, flags: string[]): Promise<void>;
  removeFlags(uid: number, flags: string[]): Promise<void>;
  create(path: string): Promise<void>;
  logout(): Promise<void>;
}

export interface ImapConnectConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface SmtpConfig extends ImapConnectConfig {}

export interface SmtpClient {
  send(envelope: { from: string; to: string[] }, raw: Uint8Array): Promise<void>;
  verify(): Promise<void>;
  close(): void;
}

export interface ImapAdapterOptions {
  /** Connect/greeting timeout (default 15 s). */
  connectTimeoutMs?: number;
  /** The server's SSRF guard; throws for a blocked host. */
  checkHost?: (host: string) => Promise<void>;
  /** Warnings that don't fail a call (e.g. the sent copy couldn't be saved). */
  log?: (line: string, data: Record<string, unknown>) => void;
  /** Tests: replaces the real IMAP connection. */
  connectImap?: (config: ImapConnectConfig) => Promise<ImapSession>;
  /** Tests: replaces the real SMTP transport. */
  createSmtp?: (config: SmtpConfig) => SmtpClient;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const SNIPPET_BYTES = 4096;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** These servers save a sent copy themselves; appending one would duplicate it. */
const KEEPS_SENT_COPY = new Set(["imap.gmail.com", "outlook.office365.com", "imap-mail.outlook.com"]);

function tlsOptions(host: string): ConnectionOptions {
  return { rejectUnauthorized: true, servername: host, minVersion: "TLSv1.2" };
}

/** Real IMAP session over imapflow. */
export async function connectImapFlow(config: ImapConnectConfig): Promise<ImapSession> {
  const startTls = config.port === 143;
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: !startTls,
    doSTARTTLS: startTls ? true : undefined,
    auth: { user: config.username, pass: config.password },
    tls: tlsOptions(config.host),
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: Math.max(config.timeoutMs * 4, 60_000),
  });
  // Socket errors are also emitted as events; without a listener they would crash the process.
  client.on("error", () => {});
  await client.connect();
  const range = (uids: number[]) => uids.join(",");
  return {
    async list() {
      const rows = await client.list();
      return rows.map((r) => ({
        path: r.path,
        name: r.name,
        delimiter: r.delimiter,
        ...(r.specialUse ? { specialUse: r.specialUse } : {}),
        flags: [...r.flags],
      }));
    },
    async open(path, options) {
      const box = await client.mailboxOpen(path, { readOnly: options.readOnly });
      return {
        path: box.path,
        uidValidity: Number(box.uidValidity),
        uidNext: box.uidNext,
        exists: box.exists,
        readOnly: Boolean(box.readOnly),
      };
    },
    async search(criteria) {
      const result = await client.search(criteria, { uid: true });
      return Array.isArray(result) ? result : [];
    },
    async fetchMeta(uids) {
      if (!uids.length) return [];
      const rows = await client.fetchAll(
        range(uids),
        { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true },
        { uid: true },
      );
      return rows.map((r) => ({
        uid: r.uid,
        flags: [...(r.flags ?? [])],
        ...(r.envelope ? { envelope: r.envelope as ImapMessageMeta["envelope"] } : {}),
        ...(r.internalDate ? { internalDate: r.internalDate } : {}),
        ...(r.bodyStructure ? { bodyStructure: r.bodyStructure } : {}),
      }));
    },
    async fetchPart(uids, part, maxBytes) {
      const out = new Map<number, Uint8Array>();
      if (!uids.length) return out;
      const rows = await client.fetchAll(
        range(uids),
        { uid: true, bodyParts: [{ key: part, maxLength: maxBytes }] },
        { uid: true },
      );
      for (const r of rows) {
        const body = r.bodyParts?.get(part) ?? r.bodyParts?.values().next().value;
        if (body) out.set(r.uid, body);
      }
      return out;
    },
    async fetchSource(uid) {
      const row = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      return row ? (row.source ?? null) : null;
    },
    async download(uid, part, maxBytes) {
      const result = await client.download(String(uid), part, { uid: true, maxBytes });
      if (!("content" in result) || !result.content) return null;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of result.content) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > maxBytes) throw new MailError("Attachment is too large", false);
        chunks.push(buf);
      }
      const meta = result.meta;
      const contentType = meta?.contentType
        ? `${meta.contentType}${meta.charset && meta.contentType.startsWith("text/") ? `; charset=${meta.charset}` : ""}`
        : undefined;
      return { data: Buffer.concat(chunks), ...(contentType ? { contentType } : {}) };
    },
    async append(path, raw, flags) {
      const result = await client.append(path, Buffer.from(raw), flags);
      if (!result) throw new MailError(`Could not save the message in ${path}`, false);
      return {
        ...(result.uid ? { uid: result.uid } : {}),
        ...(result.uidValidity ? { uidValidity: Number(result.uidValidity) } : {}),
      };
    },
    async move(uid, destination) {
      const result = await client.messageMove(String(uid), destination, { uid: true });
      if (!result) throw new MailError(`Could not move the message to ${destination}`, false);
    },
    async addFlags(uid, flags) {
      await client.messageFlagsAdd(String(uid), flags, { uid: true });
    },
    async removeFlags(uid, flags) {
      await client.messageFlagsRemove(String(uid), flags, { uid: true });
    },
    async create(path) {
      await client.mailboxCreate(path);
    },
    async logout() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}

/** Real SMTP over nodemailer: 465 implicit TLS, otherwise STARTTLS required. */
export function createNodemailerSmtp(config: SmtpConfig): SmtpClient {
  const implicit = config.port === 465;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: implicit,
    requireTLS: !implicit,
    auth: { user: config.username, pass: config.password },
    tls: tlsOptions(config.host),
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: Math.max(config.timeoutMs * 4, 60_000),
    logger: false,
    debug: false,
  });
  return {
    async send(envelope, raw) {
      await transport.sendMail({ envelope, raw: Buffer.from(raw) });
    },
    async verify() {
      await transport.verify();
    },
    close() {
      transport.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers

function imapSettings(account: MailAccountRef) {
  if (!account.imap) throw new MailError("This mailbox has no IMAP settings", false);
  return account.imap;
}

async function checkHosts(options: ImapAdapterOptions, hosts: string[]): Promise<void> {
  if (!options.checkHost) return;
  for (const host of new Set(hosts)) {
    try {
      await options.checkHost(host);
    } catch {
      throw new MailError(`Mail server host is not allowed: ${host}`, false);
    }
  }
}

function configs(account: MailAccountRef, options: ImapAdapterOptions) {
  const imap = imapSettings(account);
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = { username: imap.username, password: imap.password, timeoutMs };
  return {
    imap: { ...base, host: imap.host, port: imap.port || 993 },
    smtp: { ...base, host: imap.smtpHost, port: imap.smtpPort || 587 },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Timed out"), { code: "ETIMEOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Summaries for these UIDs (peek), with snippets from the first text part of each. */
async function summarize(
  session: ImapSession,
  status: ImapMailboxStatus,
  uids: number[],
  order: "newest" | "oldest",
): Promise<MailSummary[]> {
  if (!uids.length) return [];
  const metas = await session.fetchMeta(uids);
  const byPart = new Map<string, number[]>();
  const nodes = new Map<number, ReturnType<typeof findTextPart>>();
  for (const meta of metas) {
    const node = findTextPart(meta.bodyStructure);
    nodes.set(meta.uid, node);
    if (!node?.part) continue;
    byPart.set(node.part, [...(byPart.get(node.part) ?? []), meta.uid]);
  }
  const snippets = new Map<number, string>();
  for (const [part, partUids] of byPart) {
    const raw = await session.fetchPart(partUids, part, SNIPPET_BYTES);
    for (const uid of partUids) {
      const bytes = raw.get(uid);
      const node = nodes.get(uid);
      if (!bytes || !node) continue;
      snippets.set(uid, await decodePartText(bytes, node).catch(() => ""));
    }
  }
  const sorted = [...metas].sort((a, b) => (order === "newest" ? b.uid - a.uid : a.uid - b.uid));
  return sorted.map((meta) => summaryFromMeta(meta, status.path, status.uidValidity, snippets.get(meta.uid) ?? ""));
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1).replace(/[^a-z0-9.-]/gi, "") : "";
  return domain || "localhost";
}

// ---------------------------------------------------------------------------
// MailConnector

export function createImapMailConnector(options: ImapAdapterOptions = {}): MailConnector {
  const connectImap = options.connectImap ?? connectImapFlow;
  const createSmtp = options.createSmtp ?? createNodemailerSmtp;
  return {
    async open(account) {
      const settings = imapSettings(account);
      const config = configs(account, options);
      await checkHosts(options, [config.imap.host, config.smtp.host]);
      const secret = settings.password;

      let session: Promise<ImapSession> | null = null;
      let folders: MailFolder[] | null = null;
      let chain: Promise<unknown> = Promise.resolve();
      let closed = false;

      const getSession = () => {
        session ??= connectImap(config.imap).catch((error) => {
          session = null;
          throw error;
        });
        return session;
      };

      /** Calls run one at a time on the single connection; failures become MailError/MailAuthError. */
      const run = <T>(fn: (s: ImapSession) => Promise<T>): Promise<T> => {
        const next = chain.then(async () => {
          if (closed) throw new MailError("Mailbox connection is closed", false);
          try {
            return await fn(await getSession());
          } catch (error) {
            const mapped = toMailError(error, secret);
            // A broken connection is replaced on the next call.
            if (mapped instanceof MailAuthError || mapped.retryable) {
              const old = session;
              session = null;
              void old?.then((s) => s.logout()).catch(() => {});
            }
            throw mapped;
          }
        });
        chain = next.catch(() => {});
        return next;
      };

      const loadFolders = async (s: ImapSession, refresh = false): Promise<MailFolder[]> => {
        if (folders && !refresh) return folders;
        folders = foldersWithRoles(await s.list()).map(({ id, name, role }) =>
          role ? { id, name, role } : { id, name },
        );
        return folders;
      };

      const roleFolder = async (s: ImapSession, role: MailFolderRole): Promise<string | null> =>
        (await loadFolders(s)).find((f) => f.role === role)?.id ?? null;

      /** The role folder, else a folder with this name, else a new one. */
      const ensureFolder = async (s: ImapSession, role: MailFolderRole, name: string): Promise<string> => {
        const found = await roleFolder(s, role);
        if (found) return found;
        const named = (await loadFolders(s)).find((f) => f.id.toLowerCase() === name.toLowerCase());
        if (named) return named.id;
        await s.create(name);
        await loadFolders(s, true);
        return name;
      };

      /** Opens the message's folder and checks UIDVALIDITY. */
      const openMessage = async (s: ImapSession, id: string, readOnly: boolean) => {
        const ref = parseMessageId(id);
        const status = await s.open(ref.folder, { readOnly });
        if (status.uidValidity !== ref.uidValidity) throw messageGone();
        return { ref, status };
      };

      const readMessage = async (s: ImapSession, id: string): Promise<MailMessage> => {
        const { ref, status } = await openMessage(s, id, true);
        const [meta] = await s.fetchMeta([ref.uid]);
        if (!meta) throw messageGone();
        const source = await s.fetchSource(ref.uid);
        if (!source) throw messageGone();
        return parseMessage(source, meta, status.path, status.uidValidity);
      };

      /** MIME for an outgoing mail: threading headers, forwarded text and attachments. */
      const compose = async (s: ImapSession, mail: OutgoingMail, keepBcc: boolean) => {
        const from = mail.from?.trim() || account.address;
        const options: Mail.Options = {
          from,
          to: mail.to,
          cc: mail.cc,
          bcc: mail.bcc,
          subject: mail.subject,
          text: mail.text,
          date: new Date(),
          messageId: `<${randomUUID()}@${domainOf(from)}>`,
        };
        if (mail.inReplyTo) {
          const original = await readMessage(s, mail.inReplyTo);
          const headers = replyHeaders(original);
          if (headers.inReplyTo) options.inReplyTo = headers.inReplyTo;
          if (headers.references) options.references = headers.references;
          options.subject = replySubject(mail.subject, original.subject);
        }
        if (mail.forwardOf) {
          const original = await readMessage(s, mail.forwardOf);
          const ref = parseMessageId(mail.forwardOf);
          options.subject = forwardSubject(mail.subject, original.subject);
          options.text = forwardBody(mail.text, original);
          const attachments: Mail.Attachment[] = [];
          let total = 0;
          for (const attachment of original.attachments) {
            const part = await s.download(ref.uid, attachment.id, MAX_ATTACHMENT_BYTES);
            if (!part) continue;
            total += part.data.length;
            if (total > MAX_ATTACHMENT_BYTES) throw new MailError("The forwarded attachments are too large", false);
            attachments.push({
              filename: attachment.filename,
              content: Buffer.from(part.data),
              contentType: attachment.contentType,
            });
          }
          if (attachments.length) options.attachments = attachments;
        }
        const node = new MailComposer(options).compile();
        node.keepBcc = keepBcc;
        const raw: Buffer = await node.build();
        return { raw, from, messageId: String(options.messageId) };
      };

      const provider: MailProvider = {
        listFolders: () => run((s) => loadFolders(s, true)),

        search: (query) =>
          run(async (s) => {
            const criteria = queryToSearch(query);
            const status = await s.open(query.folder ?? "INBOX", { readOnly: true });
            const uids = pickNewest(await s.search(criteria), searchLimit(query.limit));
            return summarize(s, status, uids, "newest");
          }),

        read: (id) => run((s) => readMessage(s, id)),

        attachment: (messageId, attachmentId) =>
          run(async (s) => {
            const { ref } = await openMessage(s, messageId, true);
            const [meta] = await s.fetchMeta([ref.uid]);
            if (!meta) throw messageGone();
            const found = listAttachments(meta.bodyStructure).find((a) => a.id === attachmentId);
            if (!found) throw new MailError("Attachment not found", false);
            const part = await s.download(ref.uid, found.id, MAX_ATTACHMENT_BYTES);
            if (!part) throw new MailError("Attachment not found", false);
            return { filename: found.filename, contentType: found.contentType, data: part.data };
          }),

        createDraft: (mail) =>
          run(async (s) => {
            const { raw, messageId } = await compose(s, mail, true);
            const drafts = await ensureFolder(s, "drafts", "Drafts");
            const saved = await s.append(drafts, raw, ["\\Draft", "\\Seen"]);
            if (saved.uid && saved.uidValidity) {
              return { id: encodeMessageId({ folder: drafts, uidValidity: saved.uidValidity, uid: saved.uid }) };
            }
            // No UIDPLUS: find the draft by its Message-ID.
            const status = await s.open(drafts, { readOnly: true });
            const [uid] = pickNewest(await s.search({ header: { "message-id": messageId } }), 1);
            return { id: uid ? encodeMessageId({ folder: drafts, uidValidity: status.uidValidity, uid }) : messageId };
          }),

        send: (mail) =>
          run(async (s) => {
            const recipients = [...mail.to, ...mail.cc, ...mail.bcc].map((r) => r.trim()).filter(Boolean);
            if (!recipients.length) throw new MailError("No recipients", false);
            const wire = await compose(s, mail, false);
            const smtp = createSmtp(config.smtp);
            try {
              await smtp.send({ from: wire.from, to: recipients }, wire.raw);
            } catch (error) {
              throw toMailError(error, secret);
            } finally {
              smtp.close();
            }
            // Sent already: a failure to keep the copy is only logged (retrying would send twice).
            if (!KEEPS_SENT_COPY.has(config.imap.host.toLowerCase())) {
              try {
                const sent = settings.sentFolder || (await roleFolder(s, "sent"));
                if (sent) {
                  await s.append(sent, withBcc(wire.raw, mail.bcc), ["\\Seen"]);
                } else {
                  options.log?.("mail: no sent folder, copy not saved", { accountId: account.id });
                }
              } catch (error) {
                options.log?.("mail: could not save the sent copy", {
                  accountId: account.id,
                  error: redact(String((error as Error)?.message ?? error), secret),
                });
              }
            }
            return { id: wire.messageId };
          }),

        move: (id, folder) =>
          run(async (s) => {
            const { ref } = await openMessage(s, id, false);
            if (folder === ref.folder) return;
            await s.move(ref.uid, folder);
          }),

        setFlags: (id, flags) =>
          run(async (s) => {
            const { ref } = await openMessage(s, id, false);
            const add: string[] = [];
            const remove: string[] = [];
            if (flags.read !== undefined) (flags.read ? add : remove).push("\\Seen");
            if (flags.flagged !== undefined) (flags.flagged ? add : remove).push("\\Flagged");
            if (add.length) await s.addFlags(ref.uid, add);
            if (remove.length) await s.removeFlags(ref.uid, remove);
          }),

        archive: (id) =>
          run(async (s) => {
            const destination = await ensureFolder(s, "archive", "Archive");
            const { ref } = await openMessage(s, id, false);
            if (ref.folder !== destination) await s.move(ref.uid, destination);
          }),

        trash: (id) =>
          run(async (s) => {
            const destination = await ensureFolder(s, "trash", "Trash");
            const { ref } = await openMessage(s, id, false);
            if (ref.folder !== destination) await s.move(ref.uid, destination);
          }),

        async close() {
          await chain;
          closed = true;
          const current = session;
          session = null;
          if (current) await current.then((s) => s.logout()).catch(() => {});
        },
      };
      return provider;
    },
  };
}

/**
 * The sent copy is the exact wire message (same Message-ID, Date, body) with
 * a Bcc header added on top, which the wire copy leaves out on purpose.
 */
export function withBcc(wire: Uint8Array, bcc: string[]): Uint8Array {
  const list = bcc.map((b) => b.replace(/[\r\n]/g, "").trim()).filter(Boolean);
  if (!list.length) return wire;
  const header = Buffer.from(`Bcc: ${list.join(", ")}\r\n`);
  return Buffer.concat([header, Buffer.from(wire)]);
}

// ---------------------------------------------------------------------------
// MailPoller

export function createImapPoller(options: ImapAdapterOptions = {}): MailPoller {
  const connectImap = options.connectImap ?? connectImapFlow;
  return {
    async newMessages(account, folder, state, pollOptions) {
      const config = configs(account, options);
      const secret = imapSettings(account).password;
      await checkHosts(options, [config.imap.host]);
      const limit = Math.min(200, Math.max(1, pollOptions?.limit ?? 50));
      let session: ImapSession | null = null;
      try {
        session = await connectImap(config.imap);
        const status = await session.open(folder, { readOnly: true });
        const plan = planPoll(state, status);
        const from = plan.fetchFrom;
        if (from === null) return { messages: [], state: plan.state };
        const found = await session.search({ uid: `${from}:*` });
        const uids = [...new Set(found)]
          .filter((uid) => uid >= from)
          .sort((a, b) => a - b)
          .slice(0, limit);
        if (!uids.length) return { messages: [], state: plan.state };
        const messages = await summarize(session, status, uids, "oldest");
        return {
          messages,
          state: { lastUid: uids[uids.length - 1] ?? plan.state.lastUid, uidValidity: status.uidValidity },
        };
      } catch (error) {
        throw toMailError(error, secret);
      } finally {
        await session?.logout().catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// MailConnectionTester

export function createImapConnectionTester(options: ImapAdapterOptions = {}): MailConnectionTester {
  const connectImap = options.connectImap ?? connectImapFlow;
  const createSmtp = options.createSmtp ?? createNodemailerSmtp;
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async test(account) {
      if (!account.imap?.host || !account.imap.smtpHost) return { ok: false, error: "unknown" };
      const config = configs(account, options);
      try {
        await checkHosts(options, [config.imap.host, config.smtp.host]);
      } catch {
        return { ok: false, error: "blocked_host" };
      }

      let sentFolder: string | null = null;
      let session: ImapSession | null = null;
      try {
        session = await withTimeout(connectImap(config.imap), timeoutMs);
        const folders = foldersWithRoles(await withTimeout(session.list(), timeoutMs));
        const configured = account.imap.sentFolder;
        sentFolder =
          (configured && folders.some((f) => f.id === configured) ? configured : null) ??
          folders.find((f) => f.role === "sent")?.id ??
          null;
      } catch (error) {
        return { ok: false, error: classifyTestError(error, "imap") };
      } finally {
        await session?.logout().catch(() => {});
      }

      const smtp = createSmtp(config.smtp);
      try {
        await withTimeout(smtp.verify(), timeoutMs);
      } catch (error) {
        return { ok: false, error: classifyTestError(error, "smtp") };
      } finally {
        smtp.close();
      }
      return { ok: true, sentFolder };
    },
  };
}

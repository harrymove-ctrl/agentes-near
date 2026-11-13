/**
 * Pure helpers of the IMAP/SMTP mail adapter (ADR 0038): message ids, search
 * criteria, folder roles, MIME → `MailMessage`, reply/forward headers, error
 * mapping. No sockets here, so all of it is unit-tested without a server.
 */
import type { MessageStructureObject, SearchObject } from "imapflow";
import { type AddressObject, type EmailAddress, simpleParser } from "mailparser";
import { htmlToText } from "./html-text";
import {
  type MailAddress,
  type MailAttachment,
  MailAuthError,
  MailError,
  type MailFolderRole,
  type MailMessage,
  type MailQuery,
  type MailSummary,
  type MailTestError,
} from "./mail";

/** Parsed text is capped here (a model never needs more of one message). */
export const MAX_TEXT_CHARS = 200_000;
export const SNIPPET_CHARS = 200;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

// ---------------------------------------------------------------------------
// Message ids: `<folder>:<uidValidity>:<uid>`, folder percent-encoded.

export interface ImapMessageRef {
  folder: string;
  uidValidity: number;
  uid: number;
}

export function encodeMessageId(ref: ImapMessageRef): string {
  return `${encodeURIComponent(ref.folder)}:${ref.uidValidity}:${ref.uid}`;
}

export function parseMessageId(id: string): ImapMessageRef {
  const match = /^([^:]+):(\d{1,20}):(\d{1,10})$/.exec(id);
  if (!match) throw new MailError("Invalid message id", false);
  let folder: string;
  try {
    folder = decodeURIComponent(match[1] ?? "");
  } catch {
    throw new MailError("Invalid message id", false);
  }
  const uidValidity = Number(match[2]);
  const uid = Number(match[3]);
  if (!folder || !Number.isSafeInteger(uidValidity) || !Number.isSafeInteger(uid) || uid < 1) {
    throw new MailError("Invalid message id", false);
  }
  return { folder, uidValidity, uid };
}

/** The folder was recreated (UIDVALIDITY changed): old UIDs point nowhere. */
export function messageGone(): MailError {
  return new MailError("Message no longer available", false);
}

// ---------------------------------------------------------------------------
// Search

export function searchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new MailError(`Invalid ${field} date`, false);
  return date;
}

/** MailQuery → IMAP SEARCH (FROM, TO, SUBJECT, TEXT, SINCE, BEFORE, UNSEEN). */
export function queryToSearch(query: MailQuery): SearchObject {
  const search: SearchObject = {};
  const text = (value: string | undefined) => value?.trim() || undefined;
  const from = text(query.from);
  const to = text(query.to);
  const subject = text(query.subject);
  const body = text(query.text);
  if (from) search.from = from;
  if (to) search.to = to;
  if (subject) search.subject = subject;
  if (body) search.text = body;
  if (query.since) search.since = parseDate(query.since, "since");
  if (query.before) search.before = parseDate(query.before, "before");
  if (query.unreadOnly) search.seen = false;
  if (Object.keys(search).length === 0) search.all = true;
  return search;
}

/** Newest first, at most `limit`. */
export function pickNewest(uids: number[], limit: number): number[] {
  return [...new Set(uids)].sort((a, b) => b - a).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Folders

export interface ImapMailbox {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  flags: string[];
}

const SPECIAL_USE: Record<string, MailFolderRole> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "spam",
  "\\archive": "archive",
  "\\all": "all",
};

const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Common folder names (en, pt-BR and a few others), accent-insensitive. */
const NAMES: [MailFolderRole, string[]][] = [
  [
    "sent",
    [
      "sent",
      "sent items",
      "sent messages",
      "sent mail",
      "enviados",
      "enviadas",
      "itens enviados",
      "mensagens enviadas",
      "e-mails enviados",
      "gesendet",
      "envoyes",
    ],
  ],
  ["drafts", ["drafts", "draft", "rascunhos", "rascunho", "entwurfe", "brouillons"]],
  [
    "trash",
    [
      "trash",
      "deleted",
      "deleted items",
      "deleted messages",
      "bin",
      "lixeira",
      "itens excluidos",
      "excluidos",
      "papierkorb",
      "corbeille",
    ],
  ],
  ["spam", ["spam", "junk", "junk e-mail", "junk email", "junk mail", "bulk mail", "lixo eletronico", "lixo"]],
  ["archive", ["archive", "archives", "arquivo", "arquivos", "arquivados", "arquivo morto"]],
  ["all", ["all mail", "todos os e-mails"]],
];

export function folderRole(
  mailbox: Pick<ImapMailbox, "path" | "name" | "specialUse" | "flags">,
): MailFolderRole | undefined {
  if (mailbox.path.toUpperCase() === "INBOX") return "inbox";
  for (const flag of [mailbox.specialUse, ...mailbox.flags]) {
    const role = flag ? SPECIAL_USE[flag.toLowerCase()] : undefined;
    if (role) return role;
  }
  const name = fold(mailbox.name);
  for (const [role, names] of NAMES) if (names.includes(name)) return role;
  return undefined;
}

/** Selectable folders with roles; a role goes to one folder only (special-use wins over names). */
export function foldersWithRoles(
  mailboxes: ImapMailbox[],
): { id: string; name: string; role?: MailFolderRole; bySpecialUse: boolean }[] {
  const selectable = mailboxes.filter((m) => !m.flags.some((f) => f.toLowerCase() === "\\noselect"));
  const rows = selectable.map((m) => {
    const role = folderRole(m);
    const bySpecialUse =
      m.path.toUpperCase() === "INBOX" ||
      [m.specialUse, ...m.flags].some((f) => (f ? f.toLowerCase() in SPECIAL_USE : false));
    const name =
      m.path.toUpperCase() === "INBOX" ? "Inbox" : m.delimiter ? m.path.split(m.delimiter).join("/") : m.path;
    return { id: m.path, name, role, bySpecialUse };
  });
  const taken = new Set<MailFolderRole>();
  for (const pass of [true, false]) {
    for (const row of rows) {
      if (!row.role || row.bySpecialUse !== pass) continue;
      if (taken.has(row.role)) row.role = undefined;
      else taken.add(row.role);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Addresses, structure, snippets

export function toAddress(value: { name?: string | null; address?: string | null } | undefined): MailAddress | null {
  const address = value?.address?.trim().toLowerCase();
  if (!address) return null;
  const name = value?.name?.trim();
  return name ? { name, address } : { address };
}

export function toAddresses(values: { name?: string | null; address?: string | null }[] | undefined): MailAddress[] {
  return (values ?? []).map(toAddress).filter((a): a is MailAddress => a !== null);
}

function flattenParsed(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: MailAddress[] = [];
  const walk = (entries: EmailAddress[]) => {
    for (const entry of entries) {
      if (entry.group) walk(entry.group);
      const address = toAddress(entry);
      if (address) out.push(address);
    }
  };
  for (const item of list) walk(item.value);
  return out;
}

function partFilename(node: MessageStructureObject): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name ?? undefined;
}

/** Leaf parts that count as attachments (inline images and body text don't). */
export function listAttachments(structure: MessageStructureObject | undefined): MailAttachment[] {
  const out: MailAttachment[] = [];
  const walk = (node: MessageStructureObject) => {
    const type = node.type.toLowerCase();
    const isMessage = type === "message/rfc822";
    if (node.childNodes?.length && !isMessage) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    const filename = partFilename(node);
    const disposition = node.disposition?.toLowerCase();
    const attached = disposition === "attachment" || (Boolean(filename) && disposition !== "inline") || isMessage;
    if (!attached) return;
    const encoded = node.size ?? 0;
    const size = node.encoding?.toLowerCase() === "base64" ? Math.floor((encoded * 3) / 4) : encoded;
    out.push({
      id: node.part ?? "1",
      filename: filename ?? (isMessage ? "message.eml" : "attachment"),
      contentType: type,
      size,
    });
  };
  if (structure) walk(structure);
  return out;
}

/** The part to read a snippet from: first text/plain body part, else first text/html. */
export function findTextPart(structure: MessageStructureObject | undefined): MessageStructureObject | null {
  let html: MessageStructureObject | null = null;
  const walk = (node: MessageStructureObject): MessageStructureObject | null => {
    const type = node.type.toLowerCase();
    if (node.childNodes?.length) {
      if (type === "message/rfc822") return null;
      for (const child of node.childNodes) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    }
    if (node.disposition?.toLowerCase() === "attachment") return null;
    if (type === "text/plain") return node;
    if (type === "text/html" && !html) html = node;
    return null;
  };
  if (!structure) return null;
  const plain = walk(structure);
  const found = plain ?? html;
  // A single-part message has no part number: IMAP calls its body part "1".
  return found ? { ...found, part: found.part ?? "1" } : null;
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function snippetOf(text: string): string {
  const flat = collapse(text);
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

/** Decodes a (possibly truncated) raw body part using its structure (transfer encoding, charset, HTML). */
export async function decodePartText(raw: Uint8Array, node: MessageStructureObject): Promise<string> {
  const params = Object.entries(node.parameters ?? {})
    .filter(([key]) => ["charset", "format", "delsp"].includes(key.toLowerCase()))
    .map(([key, value]) => `; ${key}="${value.replace(/["\r\n]/g, "")}"`)
    .join("");
  const type = node.type.toLowerCase() === "text/html" ? "text/html" : "text/plain";
  const encoding = (node.encoding ?? "7bit").replace(/[^a-z0-9-]/gi, "");
  const head = `Content-Type: ${type}${params}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`;
  const parsed = await simpleParser(Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(raw)]));
  if (type === "text/html") return htmlText(typeof parsed.html === "string" ? parsed.html : (parsed.text ?? ""));
  return parsed.text ?? "";
}

// ---------------------------------------------------------------------------
// HTML → text (one converter for all mail and web pages: html-text.ts)

export { decodeEntities, htmlToText } from "./html-text";

/** HTML → text within the message size cap. */
const htmlText = (html: string) => htmlToText(html.slice(0, MAX_TEXT_CHARS * 4)).slice(0, MAX_TEXT_CHARS);

// ---------------------------------------------------------------------------
// Summaries and full messages

export interface ImapMessageMeta {
  uid: number;
  flags: string[];
  envelope?: {
    date?: Date | string;
    subject?: string;
    messageId?: string;
    from?: { name?: string; address?: string }[];
    to?: { name?: string; address?: string }[];
    cc?: { name?: string; address?: string }[];
  };
  internalDate?: Date | string;
  bodyStructure?: MessageStructureObject;
}

function isoDate(...values: (Date | string | undefined)[]): string {
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

const hasFlag = (flags: string[], flag: string) => flags.some((f) => f.toLowerCase() === flag.toLowerCase());

export function summaryFromMeta(
  meta: ImapMessageMeta,
  folder: string,
  uidValidity: number,
  snippetText: string,
): MailSummary {
  const envelope = meta.envelope ?? {};
  return {
    id: encodeMessageId({ folder, uidValidity, uid: meta.uid }),
    folder,
    from: toAddress(envelope.from?.[0]),
    to: toAddresses(envelope.to),
    cc: toAddresses(envelope.cc),
    subject: envelope.subject ?? "",
    date: isoDate(envelope.date, meta.internalDate),
    snippet: snippetOf(snippetText),
    unread: !hasFlag(meta.flags, "\\Seen"),
    flagged: hasFlag(meta.flags, "\\Flagged"),
    hasAttachments: listAttachments(meta.bodyStructure).length > 0,
  };
}

function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[…truncated]` : text;
}

const EMAIL_IN_TEXT = /[^\s<>"',;:]+@[^\s<>"',;:]+\.[^\s<>"',;:]+/g;

/** `Delivered-To` and `X-Original-To` (parsed as addresses or kept as text, once or repeated), lowercase. */
function deliveredOf(headers: Map<string, unknown>): { deliveredTo?: string[] } {
  const out = new Set<string>();
  const take = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) take(v);
    } else if (typeof value === "string") {
      for (const m of value.match(EMAIL_IN_TEXT) ?? []) out.add(m.toLowerCase());
    } else if (value && typeof value === "object" && "value" in value) {
      for (const a of flattenParsed(value as AddressObject)) out.add(a.address);
    }
  };
  take(headers.get("delivered-to"));
  take(headers.get("x-original-to"));
  return out.size > 0 ? { deliveredTo: [...out] } : {};
}

/** Full MIME source → MailMessage. Attachments come from the IMAP structure (ids = part numbers). */
export async function parseMessage(
  source: Uint8Array,
  meta: ImapMessageMeta,
  folder: string,
  uidValidity: number,
): Promise<MailMessage> {
  const parsed = await simpleParser(Buffer.from(source), { skipImageLinks: true, skipTextToHtml: true });
  // The HTML part when there is one: it's what people see, and a text/plain part can say something else
  // (hidden instructions). Only mail without HTML falls back to mailparser's text.
  const plain = typeof parsed.html === "string" ? htmlText(parsed.html) : (parsed.text ?? "");
  const text = capText(plain.replace(/\r\n/g, "\n").trim());
  const references = parsed.references
    ? (Array.isArray(parsed.references) ? parsed.references : parsed.references.split(/\s+/)).filter(Boolean)
    : undefined;
  const attachments = listAttachments(meta.bodyStructure);
  const summary = summaryFromMeta(meta, folder, uidValidity, text);
  const from = flattenParsed(parsed.from)[0] ?? summary.from;
  return {
    ...summary,
    from,
    to: parsed.to ? flattenParsed(parsed.to) : summary.to,
    cc: parsed.cc ? flattenParsed(parsed.cc) : summary.cc,
    subject: parsed.subject ?? summary.subject,
    date: parsed.date ? isoDate(parsed.date) : summary.date,
    hasAttachments: attachments.length > 0,
    text,
    replyTo: flattenParsed(parsed.replyTo),
    ...deliveredOf(parsed.headers),
    ...(parsed.messageId ? { messageIdHeader: parsed.messageId } : {}),
    ...(references?.length ? { references } : {}),
    attachments,
  };
}

// ---------------------------------------------------------------------------
// Replies and forwards

const REPLY_PREFIX = /^\s*(re|res|aw|sv|antw)\s*:/i;
const FORWARD_PREFIX = /^\s*(fwd?|enc|tr|wg|rv)\s*:/i;

export function replySubject(subject: string, original: string): string {
  const base = subject.trim() || original.trim();
  return REPLY_PREFIX.test(base) ? base : `Re: ${base}`;
}

export function forwardSubject(subject: string, original: string): string {
  const base = subject.trim() || original.trim();
  return FORWARD_PREFIX.test(base) ? base : `Fwd: ${base}`;
}

/** `In-Reply-To` and `References` (the original's references, then its Message-ID). */
export function replyHeaders(original: Pick<MailMessage, "messageIdHeader" | "references">): {
  inReplyTo?: string;
  references?: string[];
} {
  if (!original.messageIdHeader) return original.references?.length ? { references: original.references } : {};
  const references = [...(original.references ?? []).filter((r) => r !== original.messageIdHeader)];
  references.push(original.messageIdHeader);
  return { inReplyTo: original.messageIdHeader, references: references.slice(-20) };
}

const formatAddress = (a: MailAddress | null) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : "");

/** The forwarded message quoted below the new text. */
export function forwardBody(text: string, original: MailMessage): string {
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${formatAddress(original.from)}`,
    `Date: ${original.date}`,
    `Subject: ${original.subject}`,
    `To: ${original.to.map(formatAddress).join(", ")}`,
  ];
  if (original.cc.length) lines.push(`Cc: ${original.cc.map(formatAddress).join(", ")}`);
  return `${text.trimEnd()}\n\n${lines.join("\n")}\n\n${original.text}`;
}

// ---------------------------------------------------------------------------
// Errors

interface ErrorLike {
  code?: string;
  message?: string;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
  serverResponseCode?: string;
  responseCode?: number;
  command?: string;
}

const RETRYABLE_CODES = new Set([
  "ETIMEOUT",
  "ETIMEDOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "ETHROTTLE",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNECTION",
  "ESOCKET",
  "LockTimeout",
]);

const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ClosedAfterConnectTLS",
  "ETLS",
]);

const UNREACHABLE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EDNS"]);

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : { message: String(error) };
}

export function isAuthError(error: unknown): boolean {
  const e = asErrorLike(error);
  if (e.authenticationFailed) return true;
  const code = e.serverResponseCode?.toUpperCase();
  if (code === "AUTHENTICATIONFAILED" || code === "AUTHORIZATIONFAILED") return true;
  if (e.code === "EAUTH") return true;
  return e.responseCode === 535 || e.responseCode === 534;
}

export function isTlsError(error: unknown): boolean {
  const e = asErrorLike(error);
  if (e.tlsFailed) return true;
  if (e.code && TLS_CODES.has(e.code)) return true;
  return /certificate|self[- ]signed|\bssl\b|\btls\b/i.test(e.message ?? "");
}

function isRetryable(error: unknown): boolean {
  const e = asErrorLike(error);
  if (e.code && RETRYABLE_CODES.has(e.code)) return true;
  const code = e.serverResponseCode?.toUpperCase();
  if (code === "UNAVAILABLE" || code === "INUSE" || code === "LIMIT" || code === "SERVERBUG") return true;
  if (typeof e.responseCode === "number" && e.responseCode >= 400 && e.responseCode < 500) return true;
  return /timed? ?out|throttl|too many|try again/i.test(e.message ?? "");
}

/** Removes the password (and its base64 form, as in AUTH PLAIN) from a message. */
export function redact(message: string, secret?: string): string {
  if (!secret) return message;
  let out = message.split(secret).join("***");
  const b64 = Buffer.from(secret).toString("base64");
  if (b64.length >= 4) out = out.split(b64).join("***");
  return out;
}

/** Any failure → MailAuthError / MailError(retryable). Never carries the password. */
export function toMailError(error: unknown, secret?: string): MailAuthError | MailError {
  if (error instanceof MailAuthError || error instanceof MailError) return error;
  if (isAuthError(error)) return new MailAuthError("The mail server refused the login");
  const e = asErrorLike(error);
  const detail = redact(String(e.message ?? "unknown error"), secret).slice(0, 300);
  const prefix = e.code ? `${e.code}: ` : "";
  return new MailError(`Mail server error: ${prefix}${detail}`, isRetryable(error));
}

/** A failed connection test → the reason shown to the person. */
export function classifyTestError(error: unknown, stage: "imap" | "smtp"): MailTestError {
  if (isAuthError(error)) return "auth";
  if (isTlsError(error)) return "tls";
  const e = asErrorLike(error);
  if (
    (e.code && (RETRYABLE_CODES.has(e.code) || UNREACHABLE_CODES.has(e.code))) ||
    /timed? ?out/i.test(e.message ?? "")
  ) {
    return stage === "imap" ? "imap_unreachable" : "smtp_unreachable";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Polling

export interface PollPlan {
  /** null = start from now: no fetch, return this state. */
  fetchFrom: number | null;
  state: { lastUid: number; uidValidity: number };
}

export function planPoll(
  state: { lastUid: number; uidValidity: number } | null,
  mailbox: { uidValidity: number; uidNext: number },
): PollPlan {
  if (!state || state.uidValidity !== mailbox.uidValidity) {
    return { fetchFrom: null, state: { lastUid: Math.max(0, mailbox.uidNext - 1), uidValidity: mailbox.uidValidity } };
  }
  if (mailbox.uidNext > 0 && mailbox.uidNext - 1 <= state.lastUid) return { fetchFrom: null, state };
  return { fetchFrom: state.lastUid + 1, state };
}

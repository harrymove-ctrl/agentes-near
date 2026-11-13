/**
 * Composio over its REST API v3.1 (`https://backend.composio.dev/api/v3.1`, `x-api-key` header): Gmail and Outlook
 * mailboxes (ADR 0038) and the connectors that go through it (ADR 0107).
 *
 * - `createComposioClient`: auth configs (one of this server's own, else Composio-managed, found or created once per
 *   toolkit), Connect Links, connected accounts, tools at a pinned version and their execution, "new message"
 *   triggers and signed webhooks.
 * - `createComposioMailConnector`: a `MailProvider` per account that runs
 *   only explicit Gmail/Outlook tools (never Composio's meta-tools).
 *
 * Permissions, approvals and per-call checks live in the engine; this file
 * only reaches the mailbox. The API key never appears in errors.
 */
import {
  arr,
  clampLimit,
  decodeBase64,
  decodeBase64Text,
  decodeEntities,
  graphRecipient,
  htmlToText,
  type Obj,
  obj,
  parseAddressList,
  snippetOf,
  str,
  toIsoDate,
  toPlainText,
} from "./composio-mail";
import {
  type ComposioAccount,
  ComposioActionError,
  type ComposioClient,
  ComposioKeyError,
  type ComposioMailToolkit,
  ComposioSignatureError,
  type ComposioTool,
  type ComposioToolkit,
  type ComposioWebhookEvent,
  FileTooLargeError,
  type MailAccountRef,
  type MailAttachment,
  MailAuthError,
  type MailConnector,
  MailError,
  type MailFolder,
  type MailFolderRole,
  type MailMessage,
  type MailProvider,
  type MailQuery,
  type MailSummary,
  type OutgoingMail,
} from "./mail";
import { readCapped } from "./read-capped";
import { withoutTokens } from "./redact";
import { verifyStandardWebhook } from "./standard-webhooks";

/** Composio trigger types for a new message. */
export const COMPOSIO_MAIL_TRIGGERS: Record<ComposioMailToolkit, string> = {
  gmail: "GMAIL_NEW_GMAIL_MESSAGE",
  outlook: "OUTLOOK_MESSAGE_TRIGGER",
};

/** One execution Composio answered, as `onExecute` hears of it. */
export interface ComposioExecution {
  userId: string;
  toolkit: string;
  slug: string;
  ok: boolean;
}

export interface ComposioClientOptions {
  apiKey: string;
  /** Signing secret of the project's webhook subscription; without it every webhook is refused. */
  webhookSecret?: string;
  /** Auth configs to use; absent = find or create a Composio-managed one per toolkit. */
  gmailAuthConfigId?: string;
  outlookAuthConfigId?: string;
  /** Auth configs of this server's own by toolkit (`COMPOSIO_AUTH_CONFIGS`): each wins over any other. */
  authConfigs?: Record<string, string>;
  /**
   * Runs before every tool call, the billed ones Composio counts (this server's per-workspace cap, ADR 0107 §7); a
   * throw stops the call before it reaches Composio.
   */
  beforeToolCall?: (call: { slug: string; userId: string }) => Promise<void>;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Clock for webhook timestamps (tests). */
  now?: () => number;
  /**
   * Told of every execution Composio answered (`ok` false: an error status or `successful: false`), never of one
   * that didn't reach it: what Composio bills, which it has no API to read back (ADR 0103). A hook that throws
   * changes nothing.
   */
  onExecute?: (execution: ComposioExecution) => void;
}

/** Tool results sometimes nest the provider response under `response_data`. */
const unwrap = (data: unknown): Obj => {
  const outer = obj(data);
  const inner = outer.response_data;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Obj) : outer;
};

/** A connection that needs reconnecting (expired, revoked, deleted, refused by the provider). */
const AUTH_BROKEN =
  /\b401\b|invalid_grant|unauthori[sz]ed|unauthenticated|invalid[_ ]credentials|token (has been |is )?(expired|revoked)|auth(entication)? refresh required|re-?auth|connected ?account[^.]*?(not active|inactive|expired|disabled|deleted|not found|revoked|failed)|no (active )?connected account/i;
const RETRYABLE =
  /\b(429|500|502|503|504)\b|rate.?limit|quota|too many requests|timed? ?out|timeout|temporar|unavailable|backend ?error|try again/i;

function cut(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

/** A failed tool run (`successful: false`) as our error types. */
function toolError(slug: string, message: string): Error {
  const text = `Composio ${slug} failed: ${cut(message)}`;
  if (AUTH_BROKEN.test(message)) return new MailAuthError(text);
  return new ComposioActionError(text, RETRYABLE.test(message));
}

/** Gmail search terms: drops characters Gmail can't take inside a term. */
function gmailTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s"(){}]+/g, "");
}

/** Gmail has no escape for quotes inside a phrase: they become spaces. */
function gmailPhrase(value: string): string {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * A routine's filter as a Gmail search (pushed to the trigger so unrelated
 * mail is never a billed event): `from:(a@x.com OR @b.com) subject:"x" "text"`.
 * Null when the filter is empty.
 */
export function gmailQueryFromFilter(filter: { from?: string[]; subject?: string; text?: string }): string | null {
  const parts: string[] = [];
  const from = (filter.from ?? []).map(gmailTerm).filter(Boolean);
  if (from.length === 1) parts.push(`from:${from[0]}`);
  else if (from.length > 1) parts.push(`from:(${from.join(" OR ")})`);
  const subject = gmailPhrase(filter.subject ?? "");
  if (subject) parts.push(`subject:"${subject}"`);
  const text = gmailPhrase(filter.text ?? "");
  if (text) parts.push(`"${text}"`);
  return parts.length ? parts.join(" ") : null;
}

/** A `MailQuery` as a Gmail search (folder goes in `label_ids`). Dates use epoch seconds, so they are exact. */
export function gmailSearchQuery(query: MailQuery): string {
  const parts: string[] = [];
  const from = gmailTerm(query.from ?? "");
  if (from) parts.push(`from:${from}`);
  const to = gmailTerm(query.to ?? "");
  if (to) parts.push(`to:${to}`);
  const subject = gmailPhrase(query.subject ?? "");
  if (subject) parts.push(`subject:"${subject}"`);
  const text = gmailPhrase(query.text ?? "");
  if (text) parts.push(`"${text}"`);
  const since = query.since ? Date.parse(query.since) : Number.NaN;
  if (Number.isFinite(since)) parts.push(`after:${Math.floor(since / 1000) - 1}`);
  const before = query.before ? Date.parse(query.before) : Number.NaN;
  if (Number.isFinite(before)) parts.push(`before:${Math.floor(before / 1000)}`);
  if (query.unreadOnly) parts.push("is:unread");
  return parts.join(" ");
}

export function createComposioClient(options: ComposioClientOptions): ComposioClient {
  const http = options.fetch ?? fetch;
  const base = (options.baseUrl ?? "https://backend.composio.dev/api/v3.1").replace(/\/$/, "");
  const now = options.now ?? Date.now;
  const authConfigs = new Map<ComposioToolkit, Promise<string>>();
  if (options.gmailAuthConfigId) authConfigs.set("gmail", Promise.resolve(options.gmailAuthConfigId));
  if (options.outlookAuthConfigId) authConfigs.set("outlook", Promise.resolve(options.outlookAuthConfigId));
  for (const [toolkit, id] of Object.entries(options.authConfigs ?? {})) authConfigs.set(toolkit, Promise.resolve(id));

  async function request(
    method: string,
    path: string,
    body?: unknown,
    opts: { allowNotFound?: boolean; answered?: () => void } = {},
  ): Promise<Obj | null> {
    let res: Response;
    try {
      res = await http(`${base}${path}`, {
        method,
        headers: {
          "x-api-key": options.apiKey,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new MailError(`could not reach Composio: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    opts.answered?.();
    if (opts.allowNotFound && res.status === 404) return null;
    const text = await res.text().catch(() => "");
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (res.ok) return obj(json);
    const error = obj(obj(json).error);
    const message = str(error.message) ?? str(obj(json).message) ?? res.statusText ?? "";
    const slug = str(error.slug);
    const text2 = `Composio ${method} ${path.split("?")[0]} failed (${res.status}${slug ? ` ${slug}` : ""}): ${cut(message)}`;
    if (res.status === 429 || res.status >= 500) throw new MailError(text2, true);
    // 401/403 here is our project key, not the person's connection.
    if (res.status === 401 || res.status === 403) throw new ComposioKeyError(text2);
    if (AUTH_BROKEN.test(`${message} ${slug ?? ""}`)) throw new MailAuthError(text2);
    throw new MailError(text2, false);
  }

  async function findOrCreateAuthConfig(toolkit: ComposioToolkit): Promise<string> {
    const list = await request(
      "GET",
      `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&is_composio_managed=true&limit=50`,
    );
    const found = arr(list?.items)
      .map(obj)
      .find(
        (item) =>
          str(obj(item.toolkit).slug)?.toLowerCase() === toolkit &&
          item.is_composio_managed !== false &&
          item.status !== "DISABLED" &&
          str(item.id),
      );
    if (found) return str(found.id) as string;
    const created = await request("POST", "/auth_configs", {
      toolkit: { slug: toolkit },
      auth_config: { type: "use_composio_managed_auth" },
    });
    const id = str(obj(created?.auth_config).id);
    if (!id) throw new MailError(`Composio did not return an auth config for ${toolkit}`, false);
    return id;
  }

  function authConfigId(toolkit: ComposioToolkit): Promise<string> {
    let pending = authConfigs.get(toolkit);
    if (!pending) {
      pending = findOrCreateAuthConfig(toolkit);
      authConfigs.set(toolkit, pending);
      pending.catch(() => authConfigs.delete(toolkit));
    }
    return pending;
  }

  /** `onExecute`, kept from changing what the execution returns or throws. */
  function executed(slug: string, account: ComposioAccount, ok: boolean) {
    try {
      options.onExecute?.({ userId: account.userId, toolkit: account.toolkit, slug, ok });
    } catch {}
  }

  async function executeTool(slug: string, account: ComposioAccount, args: Record<string, unknown>, version?: string) {
    await options.beforeToolCall?.({ slug, userId: account.userId });
    let answered = false;
    let result: Obj | null = null;
    try {
      result = await request(
        "POST",
        `/tools/execute/${encodeURIComponent(slug)}`,
        {
          connected_account_id: account.connectedAccountId,
          // Composio refuses a connected account without the user id it belongs to
          // (400 ActionExecute_ConnectedAccountEntityIdRequired).
          user_id: account.userId,
          arguments: Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)),
          ...(version ? { version } : {}),
        },
        {
          answered: () => {
            answered = true;
          },
        },
      );
    } finally {
      if (answered) executed(slug, account, result !== null && result.successful !== false);
    }
    if (!result || result.successful === false) {
      throw toolError(slug, str(result?.error) ?? "unknown error");
    }
    return withoutTokens(result.data ?? {});
  }

  async function listTools(toolkit: ComposioToolkit, version: string): Promise<ComposioTool[]> {
    const tools: ComposioTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({
        toolkit_slug: toolkit,
        toolkit_versions: version,
        include_deprecated: "true",
        limit: "1000",
        ...(cursor ? { cursor } : {}),
      });
      const result = await request("GET", `/tools?${query}`);
      for (const item of arr(result?.items).map(obj)) {
        const slug = str(item.slug);
        if (!slug) continue;
        const schema = obj(item.input_parameters);
        tools.push({
          slug,
          description: str(item.description) ?? str(item.human_description) ?? "",
          inputSchema: schema.type === "object" ? schema : { type: "object", ...schema },
          tags: arr(item.tags).filter((tag): tag is string => typeof tag === "string"),
        });
      }
      cursor = str(result?.next_cursor);
      if (!cursor) break;
    }
    return tools;
  }

  async function mailboxAddress(toolkit: string, account: ComposioAccount): Promise<string | null> {
    if (toolkit === "gmail") {
      const profile = unwrap(await executeTool("GMAIL_GET_PROFILE", account, { user_id: "me" }));
      return str(profile.emailAddress)?.toLowerCase() ?? str(profile.email_address)?.toLowerCase() ?? null;
    }
    if (toolkit === "outlook") {
      const profile = unwrap(await executeTool("OUTLOOK_GET_PROFILE", account, { user_id: "me" }));
      const address = str(profile.mail) ?? str(profile.userPrincipalName) ?? str(profile.user_principal_name);
      return address?.includes("@") ? address.toLowerCase() : null;
    }
    return null;
  }

  return {
    executeTool,
    listTools,

    async fetchFile(url, maxBytes = Number.POSITIVE_INFINITY) {
      if (!/^https:\/\//i.test(url)) throw new MailError("Composio returned a file URL that is not https", false);
      let res: Response;
      try {
        // A presigned link answers at its own address: a redirect could lead anywhere, our own network included.
        res = await http(url, { redirect: "error" });
      } catch (error) {
        throw new MailError(
          `could not download the file: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
      if (!res.ok) throw new MailError(`could not download the file (${res.status})`, res.status >= 500);
      const data = await readCapped(res, maxBytes);
      if (!data) throw new FileTooLargeError(maxBytes);
      return data;
    },

    async createConnectLink(input) {
      const result = await request("POST", "/connected_accounts/link", {
        auth_config_id: await authConfigId(input.toolkit),
        user_id: input.userId,
        callback_url: input.callbackUrl,
      });
      const connectedAccountId = str(result?.connected_account_id);
      const redirectUrl = str(result?.redirect_url);
      if (!connectedAccountId || !redirectUrl) throw new MailError("Composio did not return a connect link", false);
      return { connectedAccountId, redirectUrl };
    },

    async getConnectedAccount(id, userId, options) {
      const account = await request("GET", `/connected_accounts/${encodeURIComponent(id)}`, undefined, {
        allowNotFound: true,
      });
      if (!account) return { status: "failed", address: null };
      const raw = (str(account.status) ?? "").toUpperCase();
      if (raw === "INITIALIZING" || raw === "INITIATED") return { status: "pending", address: null };
      if (raw === "EXPIRED") return { status: "expired", address: null };
      if (raw !== "ACTIVE" || account.is_disabled === true) return { status: "failed", address: null };
      // Only the name from the account's state: the rest of it holds its credentials.
      const displayName =
        str(obj(obj(account.state).val).displayName)
          ?.trim()
          .slice(0, 120) || null;
      if (options?.readAddress === false) return { status: "active", address: null, displayName };
      try {
        const toolkit = (str(obj(account.toolkit).slug) ?? "").toLowerCase();
        // Not the `user_id` in this response: Composio deprecated it and stops returning it.
        const address = await mailboxAddress(toolkit, { connectedAccountId: id, userId, toolkit });
        return { status: "active", address, displayName };
      } catch (error) {
        if (error instanceof MailAuthError) return { status: "expired", address: null };
        throw error;
      }
    },

    async deleteConnectedAccount(id, options) {
      const revoke = options?.revoke !== false;
      await request("DELETE", `/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=${revoke}`, undefined, {
        allowNotFound: true,
      });
    },

    async createMailTrigger(input) {
      let triggerConfig: Obj = {};
      if (input.toolkit === "gmail") {
        const query = input.query?.trim();
        triggerConfig = query
          ? { query: /\b(in|label):/i.test(query) ? query : `in:inbox ${query}` }
          : { labelIds: "INBOX" };
      }
      const result = await request("POST", `/trigger_instances/${COMPOSIO_MAIL_TRIGGERS[input.toolkit]}/upsert`, {
        connected_account_id: input.connectedAccountId,
        // Checked against the connected account's owner on projects with 2FA on.
        user_id: input.userId,
        trigger_config: triggerConfig,
      });
      const triggerId = str(result?.trigger_id);
      if (!triggerId) throw new MailError("Composio did not return a trigger id", false);
      return { triggerId };
    },

    async deleteTrigger(triggerId) {
      await request("DELETE", `/trigger_instances/manage/${encodeURIComponent(triggerId)}`, undefined, {
        allowNotFound: true,
      });
    },

    verifyWebhook(headers, rawBody) {
      const secret = options.webhookSecret;
      if (!secret || !verifyStandardWebhook(secret, headers, rawBody, now())) throw new ComposioSignatureError();
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return { type: "other" };
      }
      return parseComposioEvent(payload);
    },
  };
}

/** Maps a verified V3 webhook payload to our event. */
export function parseComposioEvent(payload: unknown): ComposioWebhookEvent {
  const event = obj(payload);
  const data = obj(event.data);
  const metadata = obj(event.metadata);
  switch (event.type) {
    case "composio.trigger.message": {
      const triggerId = str(metadata.trigger_id);
      const connectedAccountId = str(metadata.connected_account_id);
      const slug = str(metadata.trigger_slug)?.toUpperCase();
      if (!triggerId || !connectedAccountId) return { type: "other" };
      let message: MailSummary | null = null;
      if (slug === COMPOSIO_MAIL_TRIGGERS.gmail) message = summaryOf(gmailMessage(data));
      else if (slug === COMPOSIO_MAIL_TRIGGERS.outlook) {
        const fields = obj(data.outlook_message ?? data.message);
        message = outlookSummary({ ...fields, id: str(data.id) ?? fields.id });
      }
      if (!message?.id) return { type: "other" };
      return { type: "mail.received", triggerId, connectedAccountId, message };
    }
    case "composio.connected_account.expired": {
      const connectedAccountId = str(data.id);
      return connectedAccountId ? { type: "account.expired", connectedAccountId } : { type: "other" };
    }
    case "composio.trigger.disabled": {
      const triggerId = str(data.id);
      return triggerId ? { type: "trigger.disabled", triggerId } : { type: "other" };
    }
    default:
      return { type: "other" };
  }
}

function summaryOf(message: MailMessage): MailSummary {
  const { text: _text, replyTo: _replyTo, messageIdHeader: _m, references: _r, attachments: _a, ...summary } = message;
  return summary;
}

// --- Gmail ---------------------------------------------------------------

const GMAIL_ROLES: Record<string, { name: string; role: MailFolderRole }> = {
  INBOX: { name: "Inbox", role: "inbox" },
  SENT: { name: "Sent", role: "sent" },
  DRAFT: { name: "Drafts", role: "drafts" },
  TRASH: { name: "Trash", role: "trash" },
  SPAM: { name: "Spam", role: "spam" },
};
/** Not a Gmail label: "All Mail" (no label filter). Archived mail lives here. */
const GMAIL_ALL = "ALL";

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

function gmailHeaders(payload: GmailPart | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of payload?.headers ?? []) {
    const name = header.name?.toLowerCase();
    if (name && typeof header.value === "string" && !(name in headers)) headers[name] = header.value;
  }
  return headers;
}

/** Every `Delivered-To` and `X-Original-To` of a Gmail message (they repeat), lowercase. */
function gmailDeliveredTo(payload: GmailPart | undefined): string[] {
  const out = new Set<string>();
  for (const header of payload?.headers ?? []) {
    const name = header.name?.toLowerCase();
    if ((name === "delivered-to" || name === "x-original-to") && typeof header.value === "string") {
      for (const a of parseAddressList(header.value)) out.add(a.address);
    }
  }
  return [...out];
}

function gmailParts(payload: GmailPart | undefined): GmailPart[] {
  const out: GmailPart[] = [];
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    out.push(part);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

function gmailBody(payload: GmailPart | undefined): string | null {
  const parts = gmailParts(payload).filter((part) => !part.filename && part.body?.data);
  const plain = parts.find((part) => part.mimeType?.toLowerCase() === "text/plain");
  if (plain?.body?.data) return decodeBase64Text(plain.body.data).replace(/\r\n/g, "\n").trim();
  const html = parts.find((part) => part.mimeType?.toLowerCase() === "text/html");
  if (html?.body?.data) return htmlToText(decodeBase64Text(html.body.data));
  return null;
}

/** Attachment ids are `<position>:<Gmail attachment id>`: Gmail's ids change between fetches, the position doesn't. */
function gmailAttachments(raw: Obj, payload: GmailPart | undefined): MailAttachment[] {
  const fromParts = gmailParts(payload).filter((part) => part.filename && part.body?.attachmentId);
  if (fromParts.length) {
    return fromParts.map((part, index) => ({
      id: `${index}:${part.body?.attachmentId}`,
      filename: part.filename ?? "attachment",
      contentType: part.mimeType ?? "application/octet-stream",
      size: Number(part.body?.size ?? 0),
    }));
  }
  return arr(raw.attachmentList ?? raw.attachment_list)
    .map(obj)
    .filter((item) => str(item.attachmentId ?? item.attachment_id))
    .map((item, index) => ({
      id: `${index}:${str(item.attachmentId ?? item.attachment_id)}`,
      filename: str(item.filename ?? item.name) ?? "attachment",
      contentType: str(item.mimeType ?? item.mime_type ?? item.mimetype) ?? "application/octet-stream",
      size: Number(item.size ?? 0) || 0,
    }));
}

/** A Gmail message (tool result or trigger payload, camelCase or snake_case) as our message. */
export function gmailMessage(raw: Obj): MailMessage {
  const payload = (raw.payload && typeof raw.payload === "object" ? raw.payload : undefined) as GmailPart | undefined;
  const headers = gmailHeaders(payload);
  const labels = arr(raw.labelIds ?? raw.label_ids).filter((label): label is string => typeof label === "string");
  const preview = obj(raw.preview);
  const fallbackText = str(raw.messageText ?? raw.message_text);
  const text = gmailBody(payload) ?? (fallbackText ? toPlainText(fallbackText) : "");
  const snippetSource = str(raw.snippet) ?? str(preview.body) ?? text;
  const attachments = gmailAttachments(raw, payload);
  const folder = labels.find((label) => label in GMAIL_ROLES);
  const deliveredTo = gmailDeliveredTo(payload);
  return {
    id: str(raw.messageId ?? raw.id ?? raw.message_id) ?? "",
    threadId: str(raw.threadId ?? raw.thread_id),
    ...(folder ? { folder } : {}),
    from: parseAddressList(headers.from ?? raw.sender ?? raw.from)[0] ?? null,
    to: parseAddressList(headers.to ?? raw.to),
    cc: parseAddressList(headers.cc ?? raw.cc),
    subject: decodeEntities(headers.subject ?? str(raw.subject) ?? str(preview.subject) ?? ""),
    date:
      toIsoDate(raw.internalDate ?? raw.internal_date) ??
      toIsoDate(raw.messageTimestamp ?? raw.message_timestamp) ??
      toIsoDate(headers.date) ??
      new Date(0).toISOString(),
    snippet: snippetOf(toPlainText(snippetSource)),
    unread: labels.includes("UNREAD"),
    flagged: labels.includes("STARRED"),
    hasAttachments: attachments.length > 0 || payload?.mimeType?.toLowerCase() === "multipart/mixed",
    text,
    replyTo: parseAddressList(headers["reply-to"]),
    ...(deliveredTo.length > 0 ? { deliveredTo } : {}),
    messageIdHeader: headers["message-id"],
    references: (headers.references ?? "").split(/\s+/).filter(Boolean),
    attachments,
  };
}

function gmailRecipients(mail: OutgoingMail): Obj {
  return {
    ...(mail.to.length ? { recipient_email: mail.to[0] } : {}),
    ...(mail.to.length > 1 ? { extra_recipients: mail.to.slice(1) } : {}),
    ...(mail.cc.length ? { cc: mail.cc } : {}),
    ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
  };
}

/** The forwarded message's text quoted below ours (where the tool can't forward natively). */
function forwardedText(text: string, original: MailMessage): string {
  const who = (address: { name?: string; address: string } | null) =>
    address ? (address.name ? `${address.name} <${address.address}>` : address.address) : "";
  return [
    text,
    "",
    "---------- Forwarded message ---------",
    `From: ${who(original.from)}`,
    `Date: ${original.date}`,
    `Subject: ${original.subject}`,
    `To: ${original.to.map(who).join(", ")}`,
    ...(original.cc.length ? [`Cc: ${original.cc.map(who).join(", ")}`] : []),
    "",
    original.text,
  ].join("\n");
}

function sentId(data: unknown): string | null {
  const result = unwrap(data);
  return str(result.id) ?? str(result.messageId) ?? str(result.message_id) ?? null;
}

function gmailProvider(client: ComposioClient, account: ComposioAccount): MailProvider {
  const exec = (slug: string, args: Obj = {}) => client.executeTool(slug, account, { user_id: "me", ...args });
  const read = async (id: string, format: "full" | "metadata" = "full") =>
    gmailMessage(unwrap(await exec("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", { message_id: id, format })));
  const modify = (id: string, add: string[], remove: string[]) =>
    exec("GMAIL_ADD_LABEL_TO_EMAIL", {
      message_id: id,
      ...(add.length ? { add_label_ids: add } : {}),
      ...(remove.length ? { remove_label_ids: remove } : {}),
    });
  const trash = async (id: string) => {
    await exec("GMAIL_MOVE_TO_TRASH", { message_id: id });
  };
  const threadOf = async (id: string) => {
    const threadId = (await read(id, "metadata")).threadId;
    if (!threadId) throw new MailError(`Gmail message ${id} has no thread`, false);
    return threadId;
  };

  return {
    async listFolders() {
      const data = unwrap(await exec("GMAIL_LIST_LABELS"));
      const folders: MailFolder[] = [];
      for (const label of arr(data.labels).map(obj)) {
        const id = str(label.id);
        if (!id) continue;
        const system = GMAIL_ROLES[id];
        if (system) folders.push({ id, ...system });
        else if (label.type !== "system") folders.push({ id, name: str(label.name) ?? id });
      }
      folders.push({ id: GMAIL_ALL, name: "All Mail", role: "all" });
      return folders;
    },

    async search(query) {
      const limit = clampLimit(query.limit);
      const folder = query.folder ?? "INBOX";
      const q = gmailSearchQuery(query);
      const data = unwrap(
        await exec("GMAIL_FETCH_EMAILS", {
          ...(q ? { query: q } : {}),
          ...(folder !== GMAIL_ALL ? { label_ids: [folder] } : {}),
          include_spam_trash: folder === "SPAM" || folder === "TRASH",
          max_results: limit,
          include_payload: true,
          verbose: false,
        }),
      );
      return arr(data.messages)
        .map((message) => summaryOf(gmailMessage(obj(message))))
        .filter((message) => message.id)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit);
    },

    read: (id) => read(id),

    async attachment(messageId, attachmentId) {
      const colon = attachmentId.indexOf(":");
      const gmailId = colon === -1 ? attachmentId : attachmentId.slice(colon + 1);
      const position = colon === -1 ? -1 : Number(attachmentId.slice(0, colon));
      const message = await read(messageId);
      const meta =
        message.attachments.find((item) => item.id === attachmentId) ??
        (position >= 0 ? message.attachments[position] : undefined) ??
        message.attachments.find((item) => item.id.endsWith(`:${gmailId}`));
      const freshId = meta ? meta.id.slice(meta.id.indexOf(":") + 1) : gmailId;
      const filename = meta?.filename ?? "attachment";
      const data = await exec("GMAIL_GET_ATTACHMENT", {
        message_id: messageId,
        attachment_id: freshId,
        file_name: filename,
      });
      const file = await composioFile(client, data);
      return {
        filename,
        contentType: meta?.contentType ?? file.contentType ?? "application/octet-stream",
        data: file.data,
      };
    },

    async createDraft(mail) {
      let body = mail.text;
      let thread: Obj = {};
      if (mail.forwardOf) body = forwardedText(mail.text, await read(mail.forwardOf));
      else if (mail.inReplyTo) thread = { thread_id: await threadOf(mail.inReplyTo) };
      const data = unwrap(
        await exec("GMAIL_CREATE_EMAIL_DRAFT", {
          ...gmailRecipients(mail),
          // In a thread, an empty subject keeps the draft in it (a subject starts a new thread).
          subject: thread.thread_id ? "" : mail.subject,
          body,
          is_html: false,
          include_signature: false,
          ...thread,
        }),
      );
      const id = str(data.id) ?? str(data.draft_id) ?? str(data.draftId) ?? str(obj(data.draft).id);
      if (!id) throw new MailError("Gmail did not return a draft id", false);
      return { id };
    },

    async send(mail) {
      if (mail.forwardOf) {
        // Gmail forwards natively: original body and attachments kept.
        return {
          id: sentId(
            await exec("GMAIL_FORWARD_MESSAGE", {
              message_id: mail.forwardOf,
              recipients: mail.to,
              ...(mail.cc.length ? { cc: mail.cc } : {}),
              ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
              additional_text: mail.text,
              include_signature: false,
            }),
          ),
        };
      }
      if (mail.inReplyTo) {
        return {
          id: sentId(
            await exec("GMAIL_REPLY_TO_THREAD", {
              thread_id: await threadOf(mail.inReplyTo),
              ...gmailRecipients(mail),
              message_body: mail.text,
              is_html: false,
              include_signature: false,
            }),
          ),
        };
      }
      return {
        id: sentId(
          await exec("GMAIL_SEND_EMAIL", {
            ...gmailRecipients(mail),
            subject: mail.subject,
            body: mail.text,
            is_html: false,
            include_signature: false,
            ...(mail.from ? { from_email: mail.from } : {}),
          }),
        ),
      };
    },

    async move(id, folder) {
      if (folder === "TRASH") return trash(id);
      if (folder === GMAIL_ALL) {
        await modify(id, [], ["INBOX"]);
        return;
      }
      if (folder === "INBOX") await modify(id, ["INBOX"], ["SPAM", "TRASH"]);
      else await modify(id, [folder], ["INBOX"]);
    },

    async setFlags(id, flags) {
      const add: string[] = [];
      const remove: string[] = [];
      if (flags.read !== undefined) (flags.read ? remove : add).push("UNREAD");
      if (flags.flagged !== undefined) (flags.flagged ? add : remove).push("STARRED");
      if (add.length || remove.length) await modify(id, add, remove);
    },

    async archive(id) {
      await modify(id, [], ["INBOX"]);
    },

    trash,

    async close() {},
  };
}

// --- Outlook -------------------------------------------------------------

const OUTLOOK_SELECT = [
  "id",
  "conversationId",
  "parentFolderId",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "subject",
  "receivedDateTime",
  "sentDateTime",
  "bodyPreview",
  "isRead",
  "flag",
  "hasAttachments",
];

/** Roles from Outlook folder names (English and Portuguese; Graph v1.0 doesn't return well-known names). */
const OUTLOOK_ROLES: [RegExp, MailFolderRole][] = [
  [/^(inbox|caixa de entrada)$/i, "inbox"],
  [/^(sent items|sent|itens enviados|enviados|enviadas)$/i, "sent"],
  [/^(drafts|rascunhos)$/i, "drafts"],
  [/^(deleted items|trash|itens exclu[ií]dos|lixeira)$/i, "trash"],
  [/^(junk email|junk e-mail|junk|spam|lixo eletr[oô]nico)$/i, "spam"],
  [/^(archive|arquivo morto|arquivo)$/i, "archive"],
];

function pick(raw: Obj, ...keys: string[]): unknown {
  for (const key of keys) if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  return undefined;
}

/** An Outlook (Graph) message, camelCase or snake_case, as our summary. */
export function outlookSummary(raw: Obj): MailSummary {
  const flag = obj(raw.flag);
  const preview = str(pick(raw, "bodyPreview", "body_preview")) ?? "";
  return {
    id: str(raw.id) ?? "",
    threadId: str(pick(raw, "conversationId", "conversation_id")),
    folder: str(pick(raw, "parentFolderId", "parent_folder_id")),
    from:
      graphRecipient(pick(raw, "from", "sender")) ??
      parseAddressList(pick(raw, "from_address", "sender_address"))[0] ??
      null,
    to: parseAddressList(pick(raw, "toRecipients", "to_recipients")),
    cc: parseAddressList(pick(raw, "ccRecipients", "cc_recipients")),
    subject: str(raw.subject) ?? "",
    date:
      toIsoDate(pick(raw, "receivedDateTime", "received_date_time", "sentDateTime", "sent_date_time")) ??
      new Date(0).toISOString(),
    snippet: snippetOf(toPlainText(preview)),
    unread: pick(raw, "isRead", "is_read") === false,
    flagged: (str(pick(flag, "flagStatus", "flag_status")) ?? "").toLowerCase() === "flagged",
    hasAttachments: pick(raw, "hasAttachments", "has_attachments") === true,
  };
}

function outlookText(body: unknown): string {
  const record = obj(body);
  const content = str(record.content) ?? "";
  return (str(record.contentType) ?? str(record.content_type) ?? "").toLowerCase() === "html"
    ? htmlToText(content)
    : toPlainText(content);
}

const odataString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const kqlPhrase = (value: string) => value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

function outlookProvider(client: ComposioClient, account: ComposioAccount): MailProvider {
  const exec = (slug: string, args: Obj = {}) => client.executeTool(slug, account, { user_id: "me", ...args });

  async function listAttachments(messageId: string): Promise<MailAttachment[]> {
    const data = unwrap(await exec("OUTLOOK_LIST_OUTLOOK_ATTACHMENTS", { message_id: messageId }));
    return arr(data.value ?? data.attachments)
      .map(obj)
      .filter((item) => {
        const type = str(item["@odata.type"]);
        return (!type || type.endsWith("fileAttachment")) && item.isInline !== true && str(item.id);
      })
      .map((item) => ({
        id: str(item.id) as string,
        filename: str(item.name) ?? "attachment",
        contentType: str(item.contentType) ?? "application/octet-stream",
        size: Number(item.size ?? 0) || 0,
      }));
  }

  /** Drafts a reply or forward with Graph (threading kept), then sets exactly our recipients and subject. */
  async function draftFrom(mail: OutgoingMail): Promise<string> {
    const created = unwrap(
      mail.inReplyTo
        ? await exec("OUTLOOK_CREATE_DRAFT_REPLY", { message_id: mail.inReplyTo, comment: mail.text })
        : await exec("OUTLOOK_CREATE_ME_FORWARD_DRAFT", { message_id: mail.forwardOf, comment: mail.text }),
    );
    const id = str(created.id);
    if (!id) throw new MailError("Outlook did not return a draft id", false);
    await exec("OUTLOOK_UPDATE_EMAIL", {
      message_id: id,
      subject: mail.subject,
      to_recipients: mail.to,
      cc_recipients: mail.cc,
      bcc_recipients: mail.bcc,
    });
    return id;
  }

  async function plainDraft(mail: OutgoingMail): Promise<string> {
    const created = unwrap(
      await exec("OUTLOOK_CREATE_DRAFT", {
        subject: mail.subject,
        body: mail.text,
        is_html: false,
        to_recipients: mail.to,
        ...(mail.cc.length ? { cc_recipients: mail.cc } : {}),
        ...(mail.bcc.length ? { bcc_recipients: mail.bcc } : {}),
      }),
    );
    const id = str(created.id);
    if (!id) throw new MailError("Outlook did not return a draft id", false);
    return id;
  }

  return {
    async listFolders() {
      const data = unwrap(await exec("OUTLOOK_LIST_MAIL_FOLDERS", { top: 100 }));
      return arr(data.value ?? data.folders)
        .map(obj)
        .filter((folder) => str(folder.id) && folder.isHidden !== true)
        .map((folder) => {
          const name = str(folder.displayName) ?? str(folder.display_name) ?? (str(folder.id) as string);
          const role = OUTLOOK_ROLES.find(([pattern]) => pattern.test(name.trim()))?.[1];
          return { id: str(folder.id) as string, name, ...(role ? { role } : {}) };
        });
    },

    async search(query) {
      const limit = clampLimit(query.limit);
      const from = query.from?.trim().toLowerCase() ?? "";
      const useSearch = Boolean(query.text?.trim() || query.to?.trim() || (from && !from.includes("@", 1)));
      const args: Obj = {
        folder: query.folder ?? "inbox",
        select: OUTLOOK_SELECT,
        top: query.unreadOnly && useSearch ? 50 : limit,
      };
      if (useSearch) {
        // $search can't be combined with $filter: dates and unread are checked here.
        const terms: string[] = [];
        if (from) terms.push(`from:${kqlPhrase(from.replace(/^@/, ""))}`);
        if (query.to?.trim()) terms.push(`to:${kqlPhrase(query.to.trim().toLowerCase().replace(/^@/, ""))}`);
        if (query.subject?.trim()) terms.push(`subject:"${kqlPhrase(query.subject)}"`);
        if (query.text?.trim()) terms.push(`"${kqlPhrase(query.text)}"`);
        if (query.since) terms.push(`received>=${day(query.since)}`);
        if (query.before) terms.push(`received<=${day(query.before)}`);
        args.search = terms.join(" AND ");
      } else {
        const filter: string[] = [];
        if (query.since) filter.push(`receivedDateTime ge ${new Date(query.since).toISOString()}`);
        if (query.before) filter.push(`receivedDateTime lt ${new Date(query.before).toISOString()}`);
        if (query.unreadOnly) filter.push("isRead eq false");
        if (from) filter.push(`from/emailAddress/address eq ${odataString(from)}`);
        if (query.subject?.trim()) filter.push(`contains(subject,${odataString(query.subject.trim())})`);
        if (filter.length) args.filter = filter.join(" and ");
      }
      const data = unwrap(await exec("OUTLOOK_LIST_MESSAGES", args));
      const since = query.since ? Date.parse(query.since) : Number.NaN;
      const before = query.before ? Date.parse(query.before) : Number.NaN;
      return arr(data.value ?? data.messages)
        .map((message) => outlookSummary(obj(message)))
        .filter((message) => {
          if (!message.id) return false;
          if (!useSearch) return true;
          const at = Date.parse(message.date);
          if (query.unreadOnly && !message.unread) return false;
          if (Number.isFinite(since) && at < since) return false;
          if (Number.isFinite(before) && at >= before) return false;
          return true;
        })
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit);
    },

    async read(id) {
      const raw = unwrap(
        await exec("OUTLOOK_GET_MESSAGE", {
          message_id: id,
          select: [...OUTLOOK_SELECT, "body", "replyTo", "internetMessageId", "internetMessageHeaders"],
        }),
      );
      const summary = outlookSummary(raw);
      const headers = arr(raw.internetMessageHeaders).map(obj);
      const header = (name: string) =>
        str(headers.find((item) => str(item.name)?.toLowerCase() === name)?.value) ?? undefined;
      const text = outlookText(raw.body);
      return {
        ...summary,
        snippet: summary.snippet || snippetOf(text),
        text,
        replyTo: parseAddressList(raw.replyTo),
        messageIdHeader: str(raw.internetMessageId) ?? header("message-id"),
        references: (header("references") ?? "").split(/\s+/).filter(Boolean),
        attachments: summary.hasAttachments ? await listAttachments(id) : [],
      };
    },

    async attachment(messageId, attachmentId) {
      const meta = (await listAttachments(messageId)).find((item) => item.id === attachmentId);
      const filename = meta?.filename ?? "attachment";
      const file = await composioFile(
        client,
        await exec("OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT", {
          message_id: messageId,
          attachment_id: attachmentId,
          file_name: filename,
        }),
      );
      return {
        filename,
        contentType: meta?.contentType ?? file.contentType ?? "application/octet-stream",
        data: file.data,
      };
    },

    async createDraft(mail) {
      return { id: mail.inReplyTo || mail.forwardOf ? await draftFrom(mail) : await plainDraft(mail) };
    },

    async send(mail) {
      if (!mail.inReplyTo && !mail.forwardOf && mail.to.length) {
        await exec("OUTLOOK_SEND_EMAIL", {
          to: mail.to.join(","),
          subject: mail.subject,
          body: mail.text,
          is_html: false,
          ...(mail.cc.length ? { cc_emails: mail.cc } : {}),
          ...(mail.bcc.length ? { bcc_emails: mail.bcc } : {}),
          ...(mail.from ? { from_address: mail.from } : {}),
          save_to_sent_items: true,
        });
        return { id: null };
      }
      const draftId = mail.inReplyTo || mail.forwardOf ? await draftFrom(mail) : await plainDraft(mail);
      await exec("OUTLOOK_SEND_DRAFT", { message_id: draftId });
      return { id: null };
    },

    async move(id, folder) {
      await exec("OUTLOOK_MOVE_MESSAGE", { message_id: id, destination_id: folder });
    },

    async setFlags(id, flags) {
      if (flags.read === undefined && flags.flagged === undefined) return;
      await exec("OUTLOOK_UPDATE_EMAIL", {
        message_id: id,
        ...(flags.read !== undefined ? { is_read: flags.read } : {}),
        ...(flags.flagged !== undefined ? { flag: { flagStatus: flags.flagged ? "flagged" : "notFlagged" } } : {}),
      });
    },

    async archive(id) {
      await exec("OUTLOOK_MOVE_MESSAGE", { message_id: id, destination_id: "archive" });
    },

    async trash(id) {
      await exec("OUTLOOK_MOVE_MESSAGE", { message_id: id, destination_id: "deleteditems" });
    },

    async close() {},
  };
}

/** A file from a tool result: inline base64 (`data`, `contentBytes`…) or a download URL (`s3url`…). */
export async function composioFile(
  client: Pick<ComposioClient, "fetchFile">,
  data: unknown,
): Promise<{ data: Uint8Array; contentType?: string }> {
  const outer = unwrap(data);
  const candidates = [obj(outer.file), outer];
  for (const candidate of candidates) {
    const contentType = str(
      candidate.mimetype ?? candidate.mimeType ?? candidate.contentType ?? candidate.content_type,
    );
    const inline = str(candidate.contentBytes ?? candidate.content_bytes ?? candidate.base64 ?? candidate.data);
    if (inline && !/^https?:\/\//i.test(inline)) return { data: decodeBase64(inline), contentType };
    const url = str(
      candidate.s3url ?? candidate.s3_url ?? candidate.url ?? candidate.download_url ?? candidate.downloadUrl,
    );
    if (url) return { data: await client.fetchFile(url), contentType };
  }
  if (typeof outer.file === "string" && /^https:\/\//i.test(outer.file)) {
    return { data: await client.fetchFile(outer.file) };
  }
  throw new MailError("Composio returned no attachment content", false);
}

/**
 * Gmail and Outlook mailboxes through Composio tools (`account.externalAccountId` is the connected
 * account, `account.externalUserId` the user id it belongs to).
 */
export function createComposioMailConnector(client: ComposioClient): MailConnector {
  return {
    async open(account: MailAccountRef) {
      if (account.via !== "composio" || !account.externalAccountId || !account.externalUserId) {
        throw new MailError(`mail account ${account.id} is not connected through Composio`, false);
      }
      const ref = {
        connectedAccountId: account.externalAccountId,
        userId: account.externalUserId,
        toolkit: account.provider,
      };
      if (account.provider === "gmail") return gmailProvider(client, ref);
      if (account.provider === "outlook") return outlookProvider(client, ref);
      throw new MailError(`Composio does not serve ${account.provider} mailboxes`, false);
    },
  };
}

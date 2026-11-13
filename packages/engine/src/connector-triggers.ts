import { parseAddressList } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { type ConnectorDeps, connectionHeaders, noteRefusedSignIn } from "./connectors/connections";
import { customScope } from "./connectors/custom";
import { connectOverHttp, type McpConnect, type McpSession } from "./connectors/mcp";
import { presetForServer } from "./connectors/presets";
import { ValidationError } from "./errors";
import { isEmailAddress, matchesAddressRules, normalizeAddressRule } from "./mail/text";
import { hasScope } from "./tools/scopes";

const { connectorConnections, routineHooks } = schema;

/**
 * A connector's natural events as routine triggers (ADR 0130): each one is a webhook routine (ADR 0106) whose
 * address the server registers at the provider through the connection itself, so a person picks "when an email
 * arrives" instead of copying an address. The provider's calls go down the webhook path (rate limits, dedupe,
 * the outside-content envelope); the event's filter drops what the person didn't ask for before any run.
 */
export const CONNECTOR_EVENTS = ["millionsend.email.received"] as const;
export type ConnectorEventId = (typeof CONNECTOR_EVENTS)[number];

/**
 * What a routine asks of the event: sent to this address (the inbox, "Quando chegar um e-mail em vendas@…"), from
 * these senders (addresses or `@domains`), a subject containing words.
 */
export interface ConnectorTriggerFilter {
  to?: string;
  from?: string[];
  subject?: string;
}

/** A routine's connector event, kept in `routine_hooks.source`. */
export interface ConnectorTriggerSource {
  connectionId: string;
  event: ConnectorEventId;
  /** MillionSend: one inbox of the team (its id); absent: every inbox. */
  inboxId?: string;
  filter: ConnectorTriggerFilter;
  /** The provider's webhook for this routine, while it has one. */
  externalId?: string | null;
  /** `error`: the provider refused the webhook (`lastError` says why); the routine waits for a save. */
  status?: "active" | "error";
  lastError?: string | null;
}

interface EventDef {
  /** The preset its connection is made from (`presetForServer`). */
  preset: string;
  /** The provider's own event names. */
  providerEvents: string[];
  register(session: McpSession, url: string, source: ConnectorTriggerSource): Promise<string | null>;
  unregister(session: McpSession, externalId: string): Promise<void>;
  /** The payload as the provider sends it: whether it is this event and passes the filter. */
  passes(payload: unknown, filter: ConnectorTriggerFilter): boolean;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** The id in a tool's answer: JSON's `id` (or `data.id`) when it is JSON, else the first id the text names. */
export function createdId(content: string): string | null {
  try {
    const o = JSON.parse(content) as { id?: unknown; data?: { id?: unknown } };
    const id = o?.id ?? o?.data?.id;
    if (typeof id === "string" && id) return id.slice(0, 200);
  } catch {
    // Text for a model: the id it names.
  }
  return content.match(UUID)?.[0] ?? null;
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Whether a received email's recipients, sender and subject pass the filter (an empty filter passes everything). */
export function emailPasses(mail: { to?: unknown; from?: unknown; subject?: unknown }, filter: ConnectorTriggerFilter) {
  const { to, from, subject } = mail;
  if (filter.to && !parseAddressList(to).some((a) => a.address.toLowerCase() === filter.to)) return false;
  if (filter.from?.length) {
    const address = parseAddressList(from)[0]?.address;
    if (!address || !matchesAddressRules(filter.from, address)) return false;
  }
  if (filter.subject) {
    if (typeof subject !== "string" || !subject.toLowerCase().includes(filter.subject.toLowerCase())) return false;
  }
  return true;
}

const EVENTS: Record<ConnectorEventId, EventDef> = {
  "millionsend.email.received": {
    preset: "millionsend",
    providerEvents: ["inbox.email.received"],
    async register(session, url, source) {
      const res = await session.callTool("create_webhook", {
        endpoint: url,
        events: ["inbox.email.received"],
        inbox_ids: source.inboxId ? [source.inboxId] : null,
      });
      if (res.isError) throw new Error(res.content.slice(0, 300) || "MillionSend refused the webhook");
      return createdId(res.content);
    },
    async unregister(session, externalId) {
      await session.callTool("delete_webhook", { id: externalId });
    },
    passes(payload, filter) {
      const o = record(payload);
      if (o?.type !== "inbox.email.received") return false;
      // The email sits under `data.email` (MillionSend's webhook payload); the thread carries the subject too.
      const data = record(o.data);
      const email = record(data?.email) ?? {};
      return emailPasses({ ...email, subject: email.subject ?? record(data?.thread)?.subject }, filter);
    },
  },
};

/** The events a connection's service has as routine triggers (none for most). */
export const connectorEventsOf = (serverUrl: string): ConnectorEventId[] => {
  const preset = presetForServer(serverUrl)?.id;
  return CONNECTOR_EVENTS.filter((e) => EVENTS[e].preset === preset);
};

export const isConnectorEvent = (v: unknown): v is ConnectorEventId =>
  typeof v === "string" && (CONNECTOR_EVENTS as readonly string[]).includes(v);

/** The source stored for a routine's address, when it has a valid one. */
export function sourceOf(v: unknown): ConnectorTriggerSource | null {
  const o = record(v);
  if (!o || typeof o.connectionId !== "string" || !isConnectorEvent(o.event)) return null;
  return o as unknown as ConnectorTriggerSource;
}

/** Normalised filter (lowercase sender rules, trimmed subject); throws on an invalid sender rule. */
export function normalizeConnectorFilter(filter: ConnectorTriggerFilter | undefined): ConnectorTriggerFilter {
  const out: ConnectorTriggerFilter = {};
  const to = filter?.to?.trim().toLowerCase();
  if (to) {
    if (!isEmailAddress(to)) throw new ValidationError(`"${to}" is not an address`, "mail.invalid_rule", { value: to });
    out.to = to;
  }
  const from: string[] = [];
  for (const raw of filter?.from ?? []) {
    const rule = normalizeAddressRule(raw);
    if (!rule) throw new ValidationError(`"${raw}" is not an address or @domain`, "mail.invalid_rule", { value: raw });
    if (!from.includes(rule)) from.push(rule);
  }
  if (from.length > 50) throw new ValidationError("At most 50 senders", "mail.too_many_addresses");
  if (from.length) out.from = from;
  const subject = filter?.subject?.trim().slice(0, 200);
  if (subject) out.subject = subject;
  return out;
}

/** Whether a call that reached a connector routine is its event and passes its filter. */
export function connectorCallPasses(source: ConnectorTriggerSource, body: Uint8Array) {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return false;
  }
  return EVENTS[source.event].passes(payload, source.filter);
}

/**
 * The connection a routine's agent may take this event from: active in the workspace, made from the event's
 * service, and one whose tools its owner let the agent read (ADR 0016 §2), so the agent never learns of mail it
 * couldn't read itself.
 */
export async function checkConnectorTrigger(
  db: Database,
  orgId: string,
  agentId: string,
  input: { connectionId: string; event: ConnectorEventId },
) {
  const [connection] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, input.connectionId),
        eq(connectorConnections.orgId, orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (!connection || presetForServer(connection.serverUrl)?.id !== EVENTS[input.event].preset) {
    throw new ValidationError("Pick a connected service", "routine.connector_not_found");
  }
  if (!(await hasScope(db, orgId, agentId, connection.id, customScope(connection.id, "read")))) {
    throw new ValidationError(
      "Let the agent read this connection before a routine can wait on it",
      "routine.connector_agent_cannot_read",
    );
  }
  return connection;
}

/**
 * Whether a routine may still take its connector event when a call arrives: the owner can revoke the connection or
 * the agent's read access after the routine was saved, and the provider keeps posting either way.
 */
export async function connectorTriggerAllowed(
  db: Database,
  orgId: string,
  routineId: string,
  source: ConnectorTriggerSource,
) {
  const [routine] = await db
    .select({ agentId: schema.routines.agentId })
    .from(schema.routines)
    .where(and(eq(schema.routines.id, routineId), eq(schema.routines.orgId, orgId)));
  if (!routine?.agentId) return false;
  return checkConnectorTrigger(db, orgId, routine.agentId, source).then(
    () => true,
    () => false,
  );
}

export type ConnectorTriggerDeps = ConnectorDeps & { connect?: McpConnect };

async function withSession<T>(deps: ConnectorTriggerDeps, connectionId: string, run: (s: McpSession) => Promise<T>) {
  const [connection] = await deps.db
    .select()
    .from(connectorConnections)
    .where(and(eq(connectorConnections.id, connectionId), isNull(connectorConnections.revokedAt)));
  if (!connection) throw new Error("connection_gone");
  try {
    const session = await (deps.connect ?? connectOverHttp)(connection, await connectionHeaders(deps, connection));
    try {
      return await run(session);
    } finally {
      await session.close().catch(() => undefined);
    }
  } catch (error) {
    await noteRefusedSignIn(deps.db, connection, error);
    throw error;
  }
}

/**
 * Keeps a routine's connector event in step with it, as `syncMailWatch` does a mail watch: the provider keeps a
 * webhook to its address only while the routine is active and waits on that event; a changed connection, inbox
 * or filter makes a new one. `next` null: the routine no longer waits on a connector event. Without `connectors`
 * (a caller that can't reach providers) the source is kept and nothing is registered.
 */
export async function syncConnectorTrigger(
  db: Database,
  connectors: ConnectorTriggerDeps | undefined,
  routine: { id: string; active: boolean; deletedAt?: Date | null },
  url: string | null,
  next: Omit<ConnectorTriggerSource, "externalId" | "status" | "lastError"> | null,
) {
  const [hook] = await db
    .select({ source: routineHooks.source })
    .from(routineHooks)
    .where(eq(routineHooks.routineId, routine.id));
  if (!hook) return;
  const current = sourceOf(hook.source);
  const wanted = next && !routine.deletedAt ? { ...next, filter: normalizeConnectorFilter(next.filter) } : null;
  const same =
    current !== null &&
    wanted !== null &&
    current.connectionId === wanted.connectionId &&
    current.event === wanted.event &&
    (current.inboxId ?? null) === (wanted.inboxId ?? null) &&
    JSON.stringify(current.filter) === JSON.stringify(wanted.filter);
  const keep = same && routine.active && Boolean(current?.externalId);
  if (!current && !wanted) return;
  if (connectors && current?.externalId && !keep) {
    const gone = current.externalId;
    await withSession(connectors, current.connectionId, (s) => EVENTS[current.event].unregister(s, gone)).catch(
      () => undefined,
    );
  }
  let stored: ConnectorTriggerSource | null = null;
  if (wanted && keep && current) stored = { ...current, ...wanted };
  else if (wanted && connectors && routine.active && url) {
    try {
      const externalId = await withSession(connectors, wanted.connectionId, (s) =>
        EVENTS[wanted.event].register(s, url, wanted),
      );
      stored = { ...wanted, externalId, status: "active", lastError: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stored = { ...wanted, externalId: null, status: "error", lastError: message.slice(0, 300) };
    }
  } else if (wanted) {
    stored = { ...wanted, externalId: connectors ? null : (current?.externalId ?? null) };
  }
  await db
    .update(routineHooks)
    .set({ source: stored, updatedAt: new Date() })
    .where(eq(routineHooks.routineId, routine.id));
}

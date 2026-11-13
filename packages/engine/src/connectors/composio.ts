import {
  type ComposioAccount,
  ComposioActionError,
  type ComposioClient,
  ComposioKeyError,
  ComposioLimitError,
  type ComposioTool,
  MailAuthError,
  MailError,
  type PubSub,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { caches } from "../cache";
import { randomToken, sha256 } from "../crypto";
import { ConflictError, ValidationError } from "../errors";
import { composioUserId } from "../mail/accounts";
import { notifyComposioLimit } from "../notification-producers";
import { requirePermission } from "../organizations";
import { actionLevel, POSTING_ACTIONS } from "./classify";
import {
  type ConnectOutcome,
  type ConnectorConnection,
  type ConnectorDeps,
  markToReconnect,
  OAUTH_STATE_TTL_MS,
  oauthRedirectUri,
} from "./connections";
import { reconnectTarget, storeCustomConnection } from "./custom";
import type { McpConnect, McpSession, McpTool } from "./mcp";
import { oauthReturnTo } from "./oauth-return";
import {
  type ComposioWay,
  composioAction,
  composioToolkitOf,
  composioToolkitUrl,
  composioToolName,
  type McpPreset,
  presetForServer,
} from "./presets";

/**
 * Services through Composio (ADR 0107): a connection is a server by address, at its toolkit's address
 * (`composioToolkitUrl`), with Composio's connected account and no secret of ours. A session runs the entry's
 * explicit actions for that account; nothing ever fetches the address.
 */

const { connectorConnections, oauthStates, composioUsage } = schema;

/** Composio for connectors on this server: its client. */
export interface ComposioConnectors {
  client: ComposioClient;
}

/** The preset and its Composio way a toolkit's address names, else null. */
export function composioServiceOf(
  serverUrl: string | null | undefined,
): { preset: McpPreset; way: ComposioWay } | null {
  if (!composioToolkitOf(serverUrl)) return null;
  const preset = presetForServer(serverUrl);
  return preset?.composio ? { preset, way: preset.composio } : null;
}

// Every account of a toolkit has the same schemas at a version: listed once per client.
const toolLists = new WeakMap<ComposioClient, Map<string, Promise<ComposioTool[]>>>();

function toolsOf(client: ComposioClient, way: ComposioWay): Promise<ComposioTool[]> {
  const lists = toolLists.get(client) ?? new Map<string, Promise<ComposioTool[]>>();
  toolLists.set(client, lists);
  const key = `${way.toolkit}@${way.version}`;
  let pending = lists.get(key);
  if (!pending) {
    pending = client.listTools(way.toolkit, way.version).then((tools) => {
      const mine = tools.filter((t) => way.actions.includes(t.slug));
      // An empty answer may be a moment's glitch: listed again next time instead of kept.
      if (mine.length === 0) lists.delete(key);
      return mine;
    });
    lists.set(key, pending);
    pending.catch(() => lists.delete(key));
  }
  return pending;
}

/**
 * An action as an MCP tool: our name for it, and Composio's hints read by our rules. It reads only when Composio says
 * so and nothing in it sends, deletes, pays or shares; it asks whenever Composio says it destroys (a post aside,
 * `POSTING_ACTIONS`), our words call it sensitive, or the entry's `ask` names it.
 */
export function composioMcpTool(way: ComposioWay, tool: ComposioTool): McpTool {
  const asks =
    (tool.tags.includes("destructiveHint") && !POSTING_ACTIONS.has(tool.slug)) ||
    actionLevel(tool.slug) === "sensitive" ||
    (way.ask ?? []).includes(tool.slug);
  return {
    name: composioToolName(way, tool.slug),
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnlyHint: !asks && tool.tags.includes("readOnlyHint") ? true : null,
    destructiveHint: asks ? true : null,
  };
}

/**
 * A connection's session through Composio, in place of MCP: its entry's actions (and its account action) for one
 * connected account, at the pinned version. A call's `data` is Composio's answer, files and all.
 */
export function composioSession(
  client: ComposioClient,
  service: { preset: McpPreset; way: ComposioWay },
  account: ComposioAccount,
): McpSession {
  const { preset, way } = service;
  return {
    async listTools() {
      return (await toolsOf(client, way)).map((t) => composioMcpTool(way, t));
    },
    async callTool(name, args) {
      const slug = name === preset.account?.tool ? name : composioAction(way, name);
      if (!slug) return { content: `Unknown tool ${name}`, isError: true };
      const data = await client.executeTool(slug, account, args, way.version);
      return { content: JSON.stringify(data ?? {}), isError: false, data };
    },
    close: async () => {},
  };
}

/** This server isn't set up for Composio (no `COMPOSIO_API_KEY`), or the connection has no account there. */
export class ComposioOffError extends MailError {
  constructor(message = "Composio is not set up on this server") {
    super(message, false);
    this.name = "ComposioOffError";
  }
}

/**
 * Opens a service through Composio by its toolkit's address with Composio's session, any other address with
 * `connect`. A Composio address never reaches `connect`: nothing fetches it.
 */
export function withComposio(connect: McpConnect, composio: ComposioConnectors | null | undefined): McpConnect {
  return async (connection, headers) => {
    if (!composioToolkitOf(connection.serverUrl)) return connect(connection, headers);
    const service = composioServiceOf(connection.serverUrl);
    if (!composio || !service) throw new ComposioOffError();
    if (!connection.orgId || !connection.composioAccountId)
      throw new ComposioOffError("Not connected through Composio");
    return composioSession(composio.client, service, {
      connectedAccountId: connection.composioAccountId,
      userId: composioUserId(connection.orgId),
      toolkit: service.way.toolkit,
    });
  };
}

/**
 * Starts connecting a service through Composio (ADR 0107 §4): a Connect Link for the workspace's Composio user, back
 * to our OAuth callback with our state, and the state kept with the link's account, the only one its return may
 * complete. Admins only (the caller checked).
 */
export async function beginComposioConnect(
  deps: ConnectorDeps,
  actorId: string,
  orgId: string,
  input: { serverUrl: string; label?: string; returnTo?: string; connectionId?: string },
): Promise<{ status: "oauth"; authorizeUrl: string }> {
  const service = composioServiceOf(input.serverUrl);
  const composio = deps.composio;
  if (!service || !composio) {
    throw new ValidationError(
      `${service?.preset.label ?? "This service"} can't be connected on this server`,
      "connector.unavailable",
    );
  }
  const serverUrl = composioToolkitUrl(service.way.toolkit);
  if (input.connectionId) await reconnectTarget(deps.db, orgId, input.connectionId, serverUrl);
  const state = randomToken(32);
  const link = await composio.client.createConnectLink({
    toolkit: service.way.toolkit,
    userId: composioUserId(orgId),
    callbackUrl: `${oauthRedirectUri(deps.publicUrl)}?state=${state}`,
  });
  await deps.db.insert(oauthStates).values({
    orgId,
    connector: "custom",
    userId: actorId,
    stateHash: sha256(state),
    serverUrl,
    returnTo: oauthReturnTo(input.returnTo),
    label: input.label?.trim() || service.preset.label,
    connectionId: input.connectionId ?? null,
    composioAccountId: link.connectedAccountId,
    expiresAt: new Date((deps.now?.() ?? new Date()).getTime() + OAUTH_STATE_TTL_MS),
  });
  // The phone app recognizes its return by the state on the link it opened.
  const url = new URL(link.redirectUrl);
  url.searchParams.set("state", state);
  return { status: "oauth", authorizeUrl: url.toString() };
}

/** Reads of the account before a return Composio hasn't finished is refused. */
const RETURN_READS = 10;

/**
 * Back from Composio's page (ADR 0107 §4): the account the person signed in to must be the one the link made
 * (Composio's return alone proves nothing), read until active, then stored as the connection. A sign-in the
 * connection refuses (another account on Reconectar) goes away at Composio.
 */
export async function completeComposioOAuth(
  deps: ConnectorDeps,
  user: { id: string },
  row: typeof oauthStates.$inferSelect,
  code: string,
): Promise<{ connection: ConnectorConnection; returnTo: string; outcome: ConnectOutcome }> {
  const composio = deps.composio;
  if (!composio) throw new ValidationError("Composio is not set up on this server", "connector.unavailable");
  if (!row.composioAccountId || code !== row.composioAccountId) {
    throw new ConflictError("This authorization link is invalid or expired");
  }
  const userId = composioUserId(row.orgId);
  let remote: Awaited<ReturnType<ComposioClient["getConnectedAccount"]>> = { status: "pending", address: null };
  for (let read = 1; read <= RETURN_READS; read++) {
    remote = await composio.client.getConnectedAccount(code, userId, { readAddress: false }).catch((error: unknown) => {
      if (read < RETURN_READS && error instanceof MailError && error.retryable) {
        return { status: "pending" as const, address: null };
      }
      throw error;
    });
    if (remote.status !== "pending") break;
    if (read < RETURN_READS) await Bun.sleep(deps.composioPollMs ?? 1000);
  }
  if (remote.status !== "active") {
    // Its state is used up, so nothing can finish it here: one still pending could turn active at Composio later,
    // holding a sign-in no connection knows.
    await forgetComposioAccount(composio.client, code);
    throw new ConflictError("The sign-in at Composio didn't finish", "connector.unfinished");
  }
  try {
    const stored = await storeCustomConnection(deps, {
      orgId: row.orgId,
      actorId: user.id,
      serverUrl: row.serverUrl ?? "",
      label: row.label ?? composioServiceOf(row.serverUrl)?.preset.label ?? "Composio",
      authType: "oauth",
      secret: null,
      connectionId: row.connectionId,
      composio: { accountId: code, name: remote.displayName ?? null },
    });
    return { ...stored, returnTo: row.returnTo };
  } catch (error) {
    await forgetComposioAccount(composio.client, code);
    throw error;
  }
}

/**
 * Composio said the sign-in failed: the account its link made goes away there and the state is spent, so nothing
 * pending stays at Composio.
 */
export async function abandonComposioOAuth(deps: ConnectorDeps, state: string) {
  const [row] = await deps.db
    .select({ id: oauthStates.id, accountId: oauthStates.composioAccountId })
    .from(oauthStates)
    .where(and(eq(oauthStates.stateHash, sha256(state)), isNull(oauthStates.usedAt)));
  if (!row?.accountId) return;
  if (deps.composio) await forgetComposioAccount(deps.composio.client, row.accountId);
  await deps.db.delete(oauthStates).where(eq(oauthStates.id, row.id));
}

/**
 * Composio drops an account and its tokens, best effort. Never revoked at the provider: Composio's Google and
 * Microsoft apps may share one grant across toolkits and workspaces, and a revoke would cut those too.
 */
export const forgetComposioAccount = (client: Pick<ComposioClient, "deleteConnectedAccount">, accountId: string) =>
  client.deleteConnectedAccount(accountId, { revoke: false }).catch(() => {});

/** Composio's webhook said an account expired: every live connection on it needs reconnecting. */
export async function markComposioAccountBroken(db: Database, accountId: string, reason: string) {
  const rows = await db
    .select({ id: connectorConnections.id, orgId: connectorConnections.orgId })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.composioAccountId, accountId), isNull(connectorConnections.revokedAt)));
  for (const row of rows) await markToReconnect(db, row, reason);
  return rows.length;
}

/**
 * Worker tick (with the mailboxes' reconcile): connections marked to reconnect whose Composio account works again go
 * back to active, so a wrong mark heals itself. Healthy ones aren't read.
 */
export async function reconcileComposioConnectors(db: Database, client: ComposioClient) {
  const failed: { orgId: string; connectionId: string; error: string }[] = [];
  const rows = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.status, "needs_reconnect"),
        isNotNull(connectorConnections.composioAccountId),
        isNull(connectorConnections.revokedAt),
      ),
    )
    .limit(500);
  let healed = 0;
  for (const row of rows) {
    try {
      const remote = await client.getConnectedAccount(row.composioAccountId ?? "", composioUserId(row.orgId), {
        readAddress: false,
      });
      if (remote.status !== "active") continue;
      await db
        .update(connectorConnections)
        .set({ status: "active", lastError: null, updatedAt: new Date() })
        .where(and(eq(connectorConnections.id, row.id), eq(connectorConnections.status, "needs_reconnect")));
      caches.connections.delete(`${row.orgId}:active`);
      healed++;
    } catch (error) {
      failed.push({ orgId: row.orgId, connectionId: row.id, error: String(error) });
    }
  }
  return { checked: rows.length, healed, failed };
}

/**
 * What a failed Composio call tells the agent (ADR 0107 §8): the account stopped working (the connection is marked,
 * someone reconnects it), the month's calls are used, this server's key was refused, Composio is busy, or the
 * action's own error, which is the service's untrusted text. Anything else is thrown.
 */
export async function composioFailure(
  deps: { db: Database; log?: { warn(message: string, data?: Record<string, unknown>): void } },
  connection: ConnectorConnection,
  error: unknown,
): Promise<{ content: string; isError: true; data: Record<string, unknown> }> {
  const fail = (code: string, content: string) => ({ content, isError: true as const, data: { code } });
  if (error instanceof ComposioLimitError) return fail(error.code, error.message);
  if (error instanceof MailAuthError) {
    await markToReconnect(deps.db, connection, error.message);
    return fail(
      "connector.needs_reconnect",
      `The ${connection.label} account stopped working (its sign-in expired or was removed). Someone who manages connectors must reconnect it in Settings › Connectors and MCPs.`,
    );
  }
  if (error instanceof ComposioKeyError) {
    deps.log?.warn("composio refused this server's key", { error: error.message });
    return fail(
      "composio.key_refused",
      "Composio refused this server's key: whoever runs this server must check COMPOSIO_API_KEY.",
    );
  }
  if (error instanceof ComposioOffError)
    return fail("composio.off", `${connection.label} can't be used on this server now.`);
  // Whatever its words say ("quota exceeded", "unavailable"), they are the service's answer, not Composio's health.
  if (error instanceof ComposioActionError) return fail("composio.action_failed", error.message);
  if (error instanceof MailError && error.retryable) {
    return fail("composio.busy", "Composio is busy or down right now. Try again in a minute.");
  }
  if (error instanceof MailError) return fail("composio.action_failed", error.message);
  throw error;
}

// ── Calls per workspace and month (ADR 0107 §7) ─────────────────────────────

const monthOf = (at: Date) => at.toISOString().slice(0, 7);

/** "November", for the agent (English, as every tool result). */
const monthName = (at: Date, ahead = 0) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + ahead, 1)).toLocaleString("en", {
    month: "long",
    timeZone: "UTC",
  });

/**
 * Counts each Composio tool call for its workspace (the call's user id, `org_<orgId>`) before it is made, in one
 * statement that adds one only under `cap` (0: no cap). At the cap the call never reaches Composio, and the
 * workspace's connector admins hear it once that month. The client runs it before every billed call.
 */
export function meterComposio(deps: {
  db: Database;
  cap: number;
  pubsub?: () => PubSub | undefined;
  now?: () => Date;
}): (call: { slug: string; userId: string }) => Promise<void> {
  return async ({ userId }) => {
    if (!userId.startsWith("org_")) return;
    const orgId = userId.slice("org_".length);
    const now = deps.now?.() ?? new Date();
    const month = monthOf(now);
    const [counted] = await deps.db
      .insert(composioUsage)
      .values({ orgId, month, calls: 1 })
      .onConflictDoUpdate({
        target: [composioUsage.orgId, composioUsage.month],
        set: { calls: sql`${composioUsage.calls} + 1` },
        ...(deps.cap > 0 ? { setWhere: sql`${composioUsage.calls} < ${deps.cap}` } : {}),
      })
      .returning({ calls: composioUsage.calls });
    if (counted) return;
    const [first] = await deps.db
      .update(composioUsage)
      .set({ cappedAt: now })
      .where(and(eq(composioUsage.orgId, orgId), eq(composioUsage.month, month), isNull(composioUsage.cappedAt)))
      .returning({ orgId: composioUsage.orgId });
    if (first) {
      await notifyComposioLimit({ db: deps.db, pubsub: deps.pubsub?.() }, orgId, month, deps.cap).catch(() => {});
    }
    throw new ComposioLimitError(
      `This workspace used its ${deps.cap.toLocaleString("en")} Composio calls for ${monthName(now)}. They come back on ${monthName(now, 1)} 1.`,
    );
  };
}

/** The workspace's Composio calls this month (UTC) and its cap (null: none), for any member: calls, not money. */
export async function composioUsageOf(db: Database, actorId: string, orgId: string, cap: number, now = new Date()) {
  await requirePermission(db, actorId, orgId, "read");
  const month = monthOf(now);
  const [row] = await db
    .select({ calls: composioUsage.calls })
    .from(composioUsage)
    .where(and(eq(composioUsage.orgId, orgId), eq(composioUsage.month, month)));
  return { calls: row?.calls ?? 0, limit: cap > 0 ? cap : null, month };
}

/** Composio for connectors: the mail adapters' client (one project key). */
export const composioConnectorsOf = (
  mail: { composio: { client: ComposioClient } | null } | null | undefined,
): ComposioConnectors | null => (mail?.composio ? { client: mail.composio.client } : null);

import { connectorOAuthApps } from "@agenteschat/config";
import {
  abandonComposioOAuth,
  acceptCustomSuggestion,
  appOAuthRedirect,
  BUILTIN_SCOPES,
  type ConnectorDeps,
  completeOAuth,
  composioConnectorsOf,
  composioUsageOf,
  connectionView,
  connectOverHttp,
  connectorGrantValidator,
  connectorListing,
  createApiKeyConnection,
  desktopOAuthRedirect,
  desktopReturnPath,
  GITHUB_APP_AUTH,
  getAgent,
  isAgentesCloud,
  isAppReturn,
  isCustom,
  isDesktopReturn,
  listAgentScopes,
  listConnections,
  listGitHubAppInstallations,
  NotFoundError,
  peekOAuthState,
  presetForServer,
  renameConnection,
  requirePermission,
  revokeAtProvider,
  revokeConnection,
  setAgentScopes,
  startOAuth,
  syncCustomTools,
  uninstallInstallation,
  withComposio,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { sessionUser } from "../../auth";
import { isExpectedError } from "../../http/errors";
import { githubAccess } from "../github-app";
import { Outcome } from "./connectors-custom";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  oauthFailedUrl,
  oauthFailure,
  requireSession,
  security,
  signInPage,
} from "./context";

const tags = ["Connectors"];
/** Refusals of one account's sign-in that the callback hands back as their code (`connector_error=other_account`). */
const ACCOUNT_REFUSALS = [
  "connector.other_account",
  "connector.account_unknown",
  "connector.gone",
  "connector.unfinished",
  "connector.unavailable",
];

const Connection = z
  .object({
    id: z.uuid(),
    connector: z.string(),
    label: z.string(),
    serverUrl: z.string(),
    authType: z.string().openapi({
      description:
        "`oauth`, `api_key`, `none`, or `github_app`: GitHub through the workspace's GitHub App installations alone (ADR 0156), whose accounts are `accountLabel`; it has no Reconectar.",
    }),
    accountLabel: z.string().nullable(),
    tokenExpiresAt: z.string().nullable(),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
    reconnectAdds: z.array(z.string()).openapi({
      description:
        "OAuth scopes this sign-in lacks that the connector asks for now (GitHub's `project`): reconnecting adds them.",
    }),
    status: z.enum(["active", "needs_reconnect"]).openapi({
      description:
        "`needs_reconnect`: its sign-in stopped working (a refresh refused, a 401): no tools until reconnected.",
    }),
  })
  .openapi("ConnectorConnection");

const ScopeInfo = z.object({ id: z.string(), label: z.string(), description: z.string(), sensitive: z.boolean() });

const CatalogEntry = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    kind: z.enum(["catalog", "remote_mcp"]).openapi({
      description:
        "`catalog`: our connector with its own scopes; `remote_mcp`: a server connected by its address in one click, the vendor's MCP server or the service through Composio (`via`).",
    }),
    category: z.enum([
      "dev",
      "product",
      "docs",
      "data",
      "payments",
      "sales",
      "support",
      "marketing",
      "automation",
      "social",
    ]),
    auth: z.array(z.enum(["oauth", "api_key"])),
    oauthConfigured: z
      .boolean()
      .openapi({ description: "Signs in with OAuth here: our OAuth app, the vendor's MCP OAuth, or Composio's." }),
    available: z.boolean().openapi({ description: "Can be connected on this server." }),
    soon: z.boolean().openapi({
      description: "A one-click server whose vendor hasn't approved agentes.chat yet: listed, not connectable.",
    }),
    via: z.literal("composio").optional().openapi({
      description:
        "Connects through Composio (ADR 0107): its page signs in. Unavailable when this server has no `COMPOSIO_API_KEY`.",
    }),
    serverUrl: z.string().openapi({
      description:
        "Where it connects, by the way this server picked: a `remote_mcp` entry's address goes to `POST …/connectors/custom`.",
    }),
    iconUrl: z.string().nullable().openapi({
      description:
        "Brand icon served by the web app, null for a monogram: `/connectors/…` has one color, drawn in `brandColor`, and `/brands/…` keeps its maker's colors.",
    }),
    brandColor: z.string().nullable().openapi({ description: "Tint of the icon; null = the ink." }),
    scopes: z.array(ScopeInfo),
    tools: z.array(z.object({ name: z.string(), scope: z.string(), sensitive: z.boolean() })),
  })
  .openapi("Connector");

const Grant = z.object({ connectionId: z.uuid().nullable(), scope: z.string() }).openapi("ScopeGrant");

/**
 * Connectors in two layers (ADR 0016): the organization connects an MCP server once
 * (OAuth or API key, stored encrypted); each agent gets a subset of its
 * scopes. Also lists the built-in scopes.
 */
export function connectorRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  // The OAuth callback is a browser navigation: from the web app it carries our session; from the phone app
  // (the system browser) it doesn't, and it only hands the code back to the app (see the callback).
  const session = requireSession(deps.auth);
  app.use("/connectors/*", (c, next) =>
    c.req.path.endsWith("/connectors/oauth/callback") ? next() : session(c, next),
  );
  const oauthApps = connectorOAuthApps(config);
  const composio = composioConnectorsOf(adapters.mail);
  const connectorDeps: ConnectorDeps = {
    db,
    keyWrappers: [adapters.keyWrapper, ...adapters.legacyKeyWrappers],
    oauthApps,
    publicUrl: config.PUBLIC_URL,
    http: deps.extras?.http,
    resolveHost: deps.extras?.resolveHost,
    // A sign-in's account is asked of the server before it's stored (two accounts are told apart by it).
    connect: withComposio(deps.extras?.mcpConnect ?? connectOverHttp, composio),
    composio,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/connectors/catalog",
      tags,
      security,
      summary:
        "Connectors agentes.chat knows (ours and one-click MCP servers), their scopes and tools; plus built-in scopes",
      responses: {
        200: json(z.object({ connectors: z.array(CatalogEntry), builtinScopes: z.array(ScopeInfo) })),
        401: errors[401],
      },
    }),
    (c) =>
      c.json(
        {
          connectors: connectorListing({
            oauthApps,
            mail: adapters.mail,
            composio,
            cloud: isAgentesCloud(config.PUBLIC_URL),
          }),
          builtinScopes: Object.entries(BUILTIN_SCOPES).map(([id, s]) => ({
            id,
            label: s.label,
            description: s.description,
            sensitive: s.sensitive === true,
          })),
        },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/connectors",
      tags,
      security,
      summary: "Connected MCP servers (no secrets)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ connections: z.array(Connection) })), ...errors },
    }),
    async (c) => {
      const rows = await listConnections(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ connections: rows.map(connectionView) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors",
      tags,
      security,
      summary: "Connect with an API key (admins)",
      description:
        "Replaces an existing connection of the same connector; agents keep their grants. A first connection is every agent's, whole (`connector:*`); sensitive tools still ask for approval.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            connector: z.string(),
            apiKey: z.string().min(8).max(2000).optional(),
            label: z.string().max(80).optional(),
          }),
        ),
      },
      responses: { 201: json(Connection, "Created"), ...errors },
    }),
    async (c) => {
      const row = await createApiKeyConnection(
        connectorDeps,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(connectionView(row), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/connectors/{connectionId}",
      tags,
      security,
      summary: "Rename a connection, any kind (admins)",
      description:
        "1 to 80 characters, and no other live connection of the workspace has it (409 `connector.label_taken`). Its tools keep their names, so grants and denials of single tools keep applying.",
      request: {
        params: OrgParams.extend({ connectionId: z.uuid() }),
        body: body(z.object({ label: z.string().max(200) })),
      },
      responses: { 200: json(Connection), ...errors },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      const row = await renameConnection(db, c.get("user").id, orgId, connectionId, c.req.valid("json").label);
      return c.json(connectionView(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/connectors/{connectionId}",
      tags,
      security,
      summary: "Disconnect (agents lose its scopes)",
      description:
        "GitHub (ADR 0156): an account's connection in a workspace with GitHub App installations stays as GitHub through the app alone (`authType: github_app`, the same id, grants kept); disconnecting that removes the installations too, and uninstalls the app from their GitHub accounts.",
      request: { params: OrgParams.extend({ connectionId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      const userId = c.get("user").id;
      await requirePermission(db, userId, orgId, "manage_connectors");
      const rows = await listConnections(db, userId, orgId);
      const github = githubAccess(deps);
      const githubApp = github.app;
      if (githubApp && rows.find((r) => r.id === connectionId)?.authType === GITHUB_APP_AUTH) {
        for (const i of await listGitHubAppInstallations(db, userId, orgId)) {
          await uninstallInstallation(githubApp, github.http, i.installationId);
        }
      }
      await revokeAtProvider(connectorDeps, orgId, connectionId).catch(() => false);
      await revokeConnection(db, c.get("user").id, orgId, connectionId, composio);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/{connector}/oauth/start",
      tags,
      security,
      summary: "Start connecting over OAuth (admins); open the returned URL",
      request: {
        params: OrgParams.extend({ connector: z.string() }),
        body: body(
          z.object({
            returnTo: z.string().max(500).optional().openapi({
              description:
                'Path to land on afterwards; "app:connectors" from the phone app, "desktop:" + the path from the desktop app\'s window (the callback hands the code back to the app, which finishes with `oauth/complete`).',
            }),
          }),
        ),
      },
      responses: { 200: json(z.object({ authorizeUrl: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId, connector } = c.req.valid("param");
      const { authorizeUrl } = await startOAuth(connectorDeps, c.get("user").id, orgId, connector, c.req.valid("json"));
      return c.json({ authorizeUrl }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/connectors/oauth/callback",
      tags,
      security,
      summary: "OAuth redirect target (browser navigation)",
      description:
        "Validates state and PKCE, stores the tokens encrypted, then redirects to the web app with `connected` and `outcome` (`connected`, `reconnected`, `same_account`). It lands back on the page that started it; a Reconectar that signed in to another account comes back with `connector_error=connector.other_account`, one whose account couldn't be checked with `connector.account_unknown` (try again), one for an account disconnected meanwhile with `connector.gone`. When the provider refuses this server's own OAuth app (its client id or secret is wrong, which is logged as an error), it comes back with `connector_error=misconfigured` and `connector`, the connector's id. Composio's return (ADR 0107) adds `status` and `connected_account_id`, which stands for the code: it must be the account the link made, and `status=failed` comes back as `connector.unfinished`.",
      request: {
        query: z.object({
          state: z.string().optional(),
          code: z.string().optional(),
          error: z.string().optional(),
          status: z.string().optional(),
          connected_account_id: z.string().max(200).optional(),
        }),
      },
      responses: { 302: { description: "Back to the web app" }, ...errors },
    }),
    async (c) => {
      const query = c.req.valid("query");
      // Composio's return: its account stands for the code, and a sign-in that failed there is an error.
      const q = {
        ...query,
        code: query.code ?? query.connected_account_id,
        error: query.error ?? (query.status === "failed" ? "connector.unfinished" : undefined),
      };
      const base = config.PUBLIC_URL.replace(/\/$/, "");
      // Started by the phone app: the system browser has no session of ours. Hand what the provider sent back
      // to the app, which finishes with its own session (the state stays bound to the person who started it).
      const started = q.state ? await peekOAuthState(connectorDeps, q.state) : null;
      if (query.status === "failed" && q.state) {
        await abandonComposioOAuth(connectorDeps, q.state);
      }
      if (started && isAppReturn(started.returnTo)) {
        if (q.error || !q.code) return c.redirect(appOAuthRedirect({ error: q.error ?? "missing_code" }), 302);
        return c.redirect(appOAuthRedirect({ state: q.state, code: q.code }), 302);
      }
      // Started in the desktop app's window: the browser the provider opened in isn't signed in either. The app
      // opens what the provider sent back in its window, which finishes with the window's session.
      if (started && isDesktopReturn(started.returnTo)) {
        const org = started.orgId;
        if (q.error || !q.code) return c.redirect(desktopOAuthRedirect({ org, error: q.error ?? "missing_code" }), 302);
        return c.redirect(desktopOAuthRedirect({ org, state: q.state, code: q.code }), 302);
      }
      // The web app's: back where it started (its state's page) while the state can still be read, else the start.
      // A misconfigured one names which connector's app it is, for the app to say.
      const fail = (reason: string) => {
        const url = oauthFailedUrl(base, started?.returnTo ?? "/", "connector_error", reason);
        const connector = reason === "misconfigured" ? started?.connector : undefined;
        return c.redirect(connector ? `${url}&connector=${encodeURIComponent(connector)}` : url, 302);
      };
      // Composio's failed sign-in says so; any other refusal at the provider is a cancel.
      if (q.error) return fail(q.error === "connector.unfinished" ? q.error : "cancelled");
      if (!q.state || !q.code) return fail("failed");
      const user = c.get("user") ?? (await sessionUser(deps.auth, c.req.raw.headers));
      // No session in this browser: the sign-in page first, and the return finishes once signed in.
      if (!user) return c.redirect(signInPage(config.PUBLIC_URL, c.req.url), 302);
      try {
        const { connection, returnTo, outcome } = await completeOAuth(connectorDeps, user, {
          state: q.state,
          code: q.code,
        });
        await afterConnected(connection, user.id);
        const sep = returnTo.includes("?") ? "&" : "?";
        const landing = `connected=${encodeURIComponent(connection.connector)}&outcome=${outcome}`;
        return c.redirect(`${base}${returnTo}${sep}${landing}`, 302);
      } catch (error) {
        // An account's own refusals go back as their code: the app says them in the person's language.
        const reason = oauthFailure(error, ACCOUNT_REFUSALS);
        if (reason === "failed" || reason === "misconfigured") {
          const log = isExpectedError(error) ? deps.log?.warn : deps.log?.error;
          log?.("connector oauth failed", { error });
        }
        return fail(reason);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/oauth/complete",
      tags,
      security,
      summary: "Finish an OAuth connection the phone app or the desktop app started (admins)",
      description:
        "The phone app opened the authorize URL in the system browser (`returnTo: \"app:connectors\"`), or the desktop app's window did (`returnTo: \"desktop:\"` + a path); the callback handed `state` and `code` back to the app, which sends them here with its own session. The state must be this person's and this organization's, unused and not expired. `returnTo`: the path a desktop authorization lands on. `connector.misconfigured` (500, with `provider`): the provider refused this server's own OAuth app, reported as an error.",
      request: {
        params: OrgParams,
        body: body(z.object({ state: z.string().min(1).max(200), code: z.string().min(1).max(2000) })),
      },
      responses: {
        200: json(
          z.object({
            connectionId: z.uuid(),
            connector: z.string(),
            outcome: Outcome,
            returnTo: z.string().optional(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const user = c.get("user");
      const started = await peekOAuthState(connectorDeps, input.state);
      // Another organization's (or an unknown) state reads as not found: nothing about it leaks.
      if (
        !started ||
        started.orgId !== orgId ||
        !(isAppReturn(started.returnTo) || isDesktopReturn(started.returnTo))
      ) {
        throw new NotFoundError("This authorization link is invalid or expired");
      }
      const { connection, returnTo, outcome } = await completeOAuth(connectorDeps, user, input);
      await afterConnected(connection, user.id);
      const landing = isDesktopReturn(returnTo) ? { returnTo: desktopReturnPath(returnTo) } : {};
      return c.json({ connectionId: connection.id, connector: connection.connector, outcome, ...landing }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage/composio",
      tags,
      security,
      summary: "The workspace's Composio calls this month (UTC) and its cap (any member: calls, not money)",
      description:
        "Every Composio tool call counts before it is made (connectors and mailboxes, ADR 0107 §7). `limit` is `COMPOSIO_CALLS_PER_MONTH`, null with none; `month` is `YYYY-MM`.",
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ calls: z.number().int(), limit: z.number().int().nullable(), month: z.string() })),
        ...errors,
      },
    }),
    async (c) => {
      const usage = await composioUsageOf(
        db,
        c.get("user").id,
        c.req.valid("param").orgId,
        config.COMPOSIO_CALLS_PER_MONTH,
      );
      return c.json(usage, 200);
    },
  );

  /** A server connected by address: its tools are read; a one-click one gets our classification right away. */
  async function afterConnected(connection: Awaited<ReturnType<typeof completeOAuth>>["connection"], userId: string) {
    if (!isCustom(connection)) return;
    const judge = deps.extras?.context?.judge;
    const custom = { ...connectorDeps, judge, blobs: adapters.platformBlobs, log: deps.log };
    await syncCustomTools(custom, connection).catch(() => {});
    if (presetForServer(connection.serverUrl)) {
      await acceptCustomSuggestion(connectorDeps, userId, connection.orgId, connection.id).catch(() => {});
    }
  }

  // ── Agent permissions (layer 2) ───────────────────────────────────────────
  const AgentParams = OrgParams.extend({ agentId: z.uuid() });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/scopes",
      tags,
      security,
      summary: "What an agent may do",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ scopes: z.array(Grant) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
      return c.json({ scopes: await listAgentScopes(db, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/scopes",
      tags,
      security,
      summary: "Replace an agent's scopes (admins)",
      description: "Only scopes from the built-in list or the connected connectors' catalogs can be granted.",
      request: { params: AgentParams, body: body(z.object({ scopes: z.array(Grant).max(200) })) },
      responses: { 200: json(z.object({ scopes: z.array(Grant) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await setAgentScopes(db, c.get("user").id, orgId, agentId, c.req.valid("json").scopes, connectorGrantValidator);
      return c.json({ scopes: await listAgentScopes(db, orgId, agentId) }, 200);
    },
  );

  return app;
}

import {
  APP_SCOPES,
  appsUrls,
  ConflictError,
  consentView,
  createPersonalToken,
  decideConsent,
  listApps,
  reachableFromInternet,
  revokeGrant,
  TOKEN_EXPIRY_DAYS,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { signedInLately } from "../../auth";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["AI apps"];

const Access = z.enum(APP_SCOPES).openapi({
  description:
    "`read`: reads. `write`: also sends tasks. `manage`: also creates and edits agents, routines and skills.",
});
const DisplayKind = z.enum(["verified", "https", "loopback", "app_scheme"]);
const Person = z.object({ id: z.string(), name: z.string() });

const ConsentView = z.object({
  request: z.object({
    id: z.string(),
    expiresAt: z.string(),
    access: z.object({ requested: z.array(z.enum(APP_SCOPES)) }),
    client: z.object({
      displayKind: DisplayKind,
      name: z.string().openapi({
        description: "As the app calls itself (unverified unless `verified`): show as text, never markup.",
      }),
      host: z.string().nullable(),
      brand: z
        .string()
        .nullable()
        .openapi({ description: "`claude`, `openai`, `cursor`, `vscode`: from a verified address only." }),
      returnsTo: z.string(),
      reservedNameWarning: z.boolean(),
    }),
  }),
  account: z.object({ name: z.string(), email: z.string() }),
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      logo: z.string().nullable(),
      paused: z.boolean(),
      createdAt: z.string().optional(),
      deletion: z.object({ dueAt: z.string() }).optional(),
      current: z.boolean(),
    }),
  ),
});

const AppsList = z.object({
  serverUrl: z.string().openapi({ description: "What people paste into their app: this server's `/mcp`." }),
  serverPublic: z.boolean().openapi({
    description:
      "Whether apps that call from their own servers (claude.ai, ChatGPT) can reach it: https on a public name. False on a self-hosted server on a private host.",
  }),
  apps: z.array(
    z.object({
      id: z.string(),
      kind: z.literal("oauth"),
      displayKind: z.string(),
      name: z.string(),
      host: z.string().nullable(),
      brand: z.string().nullable(),
      access: Access,
      person: Person.optional(),
      connectedAt: z.string(),
      lastUsedAt: z.string().nullable(),
    }),
  ),
  tokens: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      access: Access,
      createdAt: z.string(),
      expiresAt: z.string().nullable(),
      lastUsedAt: z.string().nullable(),
      person: Person.optional(),
    }),
  ),
});

const RequestParams = z.object({
  req: z
    .string()
    .max(64)
    .openapi({ param: { name: "req", in: "path" } }),
});

/**
 * AI apps (ADR 0119): the consent page's two calls, and Settings → AI apps (connected apps, personal tokens). A
 * consent answers once; the workspace and the access come from this form, checked again here.
 */
export function appRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  const oauth = { db, publicUrl: deps.config.PUBLIC_URL };
  app.use("/authorize/*", requireSession(deps.auth));
  app.use("/organizations/:orgId/apps/*", requireSession(deps.auth));
  app.use("/organizations/:orgId/apps", requireSession(deps.auth));
  app.use("/organizations/:orgId/tokens/*", requireSession(deps.auth));
  app.use("/organizations/:orgId/tokens", requireSession(deps.auth));

  /** A request past its 30 minutes is 410, the rest of the engine's refusals as they are. */
  const expired = (error: unknown) => error instanceof ConflictError && error.code === "request_expired";

  app.openapi(
    createRoute({
      method: "get",
      path: "/authorize/{req}",
      tags,
      security,
      summary: "What the consent page shows",
      description:
        "The app asking (shown from this request's return address: `verified` for an app whose metadata document was fetched, `https`, `loopback` for a program on this computer, `app_scheme` for Cursor), the access it asks for, the signed-in account and its workspaces (`paused` ones can't be picked). 404 `request_unknown`, 409 `request_used`, 410 `request_expired`.",
      request: { params: RequestParams },
      responses: { 200: json(ConsentView), 410: errorResponse("Expired"), ...errors },
    }),
    async (c) => {
      try {
        return c.json(await consentView(oauth, c.get("user").id, c.req.valid("param").req), 200);
      } catch (error) {
        if (expired(error)) return apiError(c, 410, "request_expired", "This request expired");
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/authorize/{req}",
      tags,
      security,
      summary: "Allow or deny the app",
      description:
        "Answers once. `allow` needs `orgId` (a workspace of yours that isn't paused) and `access` (`write` by default: reads and sends tasks; `read`: only reads; `manage`: also creates and edits agents, routines and skills, when the app asked for it). Either way `redirectTo` is where the browser goes, back in the app (with `error=access_denied` on deny); go there once. 403 `not_member`, 409 `workspace_paused` or `request_used`, 410 `request_expired`.",
      request: {
        params: RequestParams,
        body: body(
          z.object({ decision: z.enum(["allow", "deny"]), orgId: z.uuid().optional(), access: Access.optional() }),
        ),
      },
      responses: { 200: json(z.object({ redirectTo: z.string() })), 410: errorResponse("Expired"), ...errors },
    }),
    async (c) => {
      try {
        const { redirectTo } = await decideConsent(
          oauth,
          c.get("user").id,
          c.req.valid("param").req,
          c.req.valid("json"),
        );
        deps.wakeWorkers?.();
        return c.json({ redirectTo }, 200);
      } catch (error) {
        if (expired(error)) return apiError(c, 410, "request_expired", "This request expired");
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/apps",
      tags,
      security,
      summary: "Connected AI apps and personal tokens",
      description:
        "Yours in this workspace; `all=1` everyone's, with `person` on each (needs `manage_members`). Expired personal tokens are left out.",
      request: { params: OrgParams, query: z.object({ all: z.enum(["1", "0"]).optional() }) },
      responses: { 200: json(AppsList), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const list = await listApps(db, c.get("user").id, orgId, { all: c.req.valid("query").all === "1" });
      return c.json(
        {
          serverUrl: appsUrls(deps.config.PUBLIC_URL).resource,
          serverPublic: await reachableFromInternet(deps.config.PUBLIC_URL),
          ...list,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/apps/{grantId}",
      tags,
      security,
      summary: "Disconnect an app",
      description: "It loses access now. Yours, or anyone's with `manage_members` (they aren't told).",
      request: { params: OrgParams.extend({ grantId: z.uuid() }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, grantId } = c.req.valid("param");
      await revokeGrant(db, c.get("user").id, orgId, grantId, "oauth");
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/tokens",
      tags,
      security,
      summary: "Create a personal token",
      description:
        "For scripts and apps without OAuth sign-in: `Authorization: Bearer agp_…` on `/mcp`, in this workspace only. `secret` is returned here once. At most 10 live per person and workspace (409 `token_limit`). One with no expiry (`expiresInDays: null`) needs a sign-in in the last 10 minutes (403 `reauth.sign_in`): only a password reset or a revoke would end it, so a session alone can't make one.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            name: z.string().trim().min(1).max(60),
            access: Access,
            expiresInDays: z
              .union([
                z.literal(TOKEN_EXPIRY_DAYS[0]),
                z.literal(TOKEN_EXPIRY_DAYS[1]),
                z.literal(TOKEN_EXPIRY_DAYS[2]),
              ])
              .nullable(),
          }),
        ),
      },
      responses: {
        201: json(
          z.object({
            token: z.object({ id: z.string(), name: z.string(), access: Access, expiresAt: z.string().nullable() }),
            secret: z.string(),
          }),
          "Created",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      if (
        c.req.valid("json").expiresInDays === null &&
        !(await signedInLately(deps.auth, c.req.raw.headers, c.get("user").id))
      )
        return apiError(c, 403, "reauth.sign_in", "Sign in again to create a token with no expiry");
      const created = await createPersonalToken(
        db,
        deps.config.PUBLIC_URL,
        c.get("user").id,
        orgId,
        c.req.valid("json"),
      );
      deps.wakeWorkers?.();
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/tokens/{grantId}",
      tags,
      security,
      summary: "Revoke a personal token",
      description: "It stops working now. Yours, or anyone's with `manage_members`.",
      request: { params: OrgParams.extend({ grantId: z.uuid() }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, grantId } = c.req.valid("param");
      await revokeGrant(db, c.get("user").id, orgId, grantId, "token");
      return c.body(null, 204);
    },
  );

  return app;
}

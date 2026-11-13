import {
  browserProfileView,
  createBrowserProfile,
  deleteBrowserProfile,
  endProfileControl,
  listBrowserProfiles,
  openProfilePage,
  renameBrowserProfile,
  requestBrowserProfile,
  setAgentBrowserProfile,
  setBrowserProfileAgents,
  startProfileControl,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { PageTarget, pageTarget } from "./browser";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Browser profiles"];

const Holder = z.union([
  z.object({ type: z.literal("agent"), agentId: z.uuid(), since: z.string() }),
  z.object({ type: z.literal("person"), userId: z.string(), since: z.string() }),
]);

export const BrowserProfile = z
  .object({
    id: z.uuid(),
    machineId: z.uuid(),
    name: z.string(),
    createdAt: z.string(),
    agentIds: z.array(z.uuid()).openapi({ description: "The agents that may use it, oldest grant first." }),
    holder: Holder.nullable().openapi({
      description: "Who has the turn now (an agent's run or a person); null: free.",
    }),
    lastUsedAt: z.string().nullable(),
  })
  .openapi("BrowserProfile");

const ProfileParams = OrgParams.extend({ profileId: z.uuid() });
const AgentParams = OrgParams.extend({ agentId: z.uuid() });

/**
 * Browser profiles (ADR 0110): named, shared logins on one computer that the agents granted them use, one at a
 * time. Anyone in the workspace sees the list; creating, granting and deleting take `manage_connectors`; logging in
 * ("Fazer login", a person's control on the live view `profile:<id>`) also takes `control_browsers`. An agent's
 * owner chooses its default among the profiles it has and can ask for another, never grant one.
 */
export function browserProfileRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const hub = deps.extras?.sandbox?.machines?.hub;
  const control = { db, hub, pubsub: adapters.pubsub };
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/browser-profiles",
      tags,
      security,
      summary: "The workspace's browser profiles (names and who may use them)",
      request: { params: OrgParams, query: z.object({ machineId: z.uuid().optional() }) },
      responses: { 200: json(z.object({ profiles: z.array(BrowserProfile) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { machineId } = c.req.valid("query");
      const profiles = await listBrowserProfiles(db, c.get("user").id, orgId, machineId ? { machineId } : {});
      return c.json({ profiles }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser-profiles",
      tags,
      security,
      summary: "Create a browser profile on a computer, for the chosen agents",
      description:
        "`manage_connectors`, and only agents the person may edit. 409 `browser_profile.name_taken`; 400 `browser_profile.machine` when the computer's runner is too old. Every call about a system-mode computer, or a profile on one, is refused with 400 `browser_profile.system_mode` (the apps never show profiles there).",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            machineId: z.uuid(),
            name: z.string().min(1).max(60),
            agentIds: z.array(z.uuid()).max(500).optional(),
          }),
        ),
      },
      responses: { 200: json(BrowserProfile), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await createBrowserProfile({ db, hub }, c.get("user").id, orgId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/browser-profiles/{profileId}",
      tags,
      security,
      summary: "Rename a profile, or change who may use it",
      request: {
        params: ProfileParams,
        body: body(
          z.object({ name: z.string().min(1).max(60).optional(), agentIds: z.array(z.uuid()).max(500).optional() }),
        ),
      },
      responses: { 200: json(BrowserProfile), ...errors },
    }),
    async (c) => {
      const { orgId, profileId } = c.req.valid("param");
      const { name, agentIds } = c.req.valid("json");
      const userId = c.get("user").id;
      if (name === undefined && !agentIds) throw new ValidationError("Give a name or the agents");
      let view = name !== undefined ? await renameBrowserProfile(db, userId, orgId, profileId, name) : null;
      if (agentIds) view = await setBrowserProfileAgents(db, userId, orgId, profileId, agentIds);
      return c.json(view ?? (await browserProfileView(db, orgId, profileId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/browser-profiles/{profileId}",
      tags,
      security,
      summary: "Delete a profile: its logins leave the computer and its agents lose it",
      request: { params: ProfileParams },
      responses: { 204: { description: "Deleted" }, ...errors },
    }),
    async (c) => {
      const { orgId, profileId } = c.req.valid("param");
      await deleteBrowserProfile({ db, hub }, c.get("user").id, orgId, profileId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser-profiles/{profileId}/takeover",
      tags,
      security,
      summary: "Fazer login: take control of the profile (agents wait) and open its live view",
      description:
        '`manage_connectors` with `control_browsers`. The live view is `browser.watch` with `agentId: "profile:<id>"` on `/api/ws`. 409 `browser_profile.busy` while another person has it.',
      request: { params: ProfileParams },
      responses: { 200: json(BrowserProfile), ...errors },
    }),
    async (c) => {
      const { orgId, profileId } = c.req.valid("param");
      return c.json(await startProfileControl(control, c.get("user").id, orgId, profileId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser-profiles/{profileId}/handback",
      tags,
      security,
      summary: "Devolver: the person's control of the profile ends",
      request: { params: ProfileParams },
      responses: { 200: json(BrowserProfile), ...errors },
    }),
    async (c) => {
      const { orgId, profileId } = c.req.valid("param");
      return c.json(await endProfileControl(control, c.get("user").id, orgId, profileId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/browser-profiles/{profileId}/open",
      tags,
      security,
      summary: "Open a site in the profile (the person in control), or go back, forward or reload (`go`)",
      request: { params: ProfileParams, body: body(PageTarget) },
      responses: { 204: { description: "Opened" }, ...errors },
    }),
    async (c) => {
      const { orgId, profileId } = c.req.valid("param");
      await openProfilePage(control, c.get("user").id, orgId, profileId, pageTarget(c.req.valid("json")));
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/browser-profile",
      tags,
      security,
      summary: "The agent's default browser: a profile it may use, or null for its own",
      request: { params: AgentParams, body: body(z.object({ profileId: z.uuid().nullable() })) },
      responses: { 204: { description: "Saved" }, ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await setAgentBrowserProfile(db, c.get("user").id, orgId, agentId, c.req.valid("json").profileId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/browser-profile/request",
      tags,
      security,
      summary: "Pedir mais um perfil: ask the people who grant profiles to give this agent one",
      request: { params: AgentParams },
      responses: { 204: { description: "Asked" }, ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await requestBrowserProfile({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, agentId);
      return c.body(null, 204);
    },
  );

  return app;
}

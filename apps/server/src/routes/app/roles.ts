import {
  createRole,
  deleteRole,
  listRoles,
  ROLE_NAME_MAX,
  reorderRoles,
  setMemberRoles,
  updateRole,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
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

const tags = ["Roles"];

const OrgRole = z
  .object({
    id: z.uuid(),
    kind: z.enum(["custom", "everyone"]).openapi({
      description: "`everyone`: the base every member holds (the apps call it Todos / Everyone); always last.",
    }),
    name: z.string(),
    icon: z.string(),
    color: z.string(),
    position: z.number().int().openapi({ description: "Order, 0 the highest." }),
    permissions: z.array(z.string()).openapi({ description: "Its keys; `administrator` grants every other one." }),
    mentionable: z.boolean(),
    hoist: z.boolean().openapi({ description: "Its people are listed apart." }),
    people: z.number().int(),
    editable: z
      .boolean()
      .openapi({ description: "Whether you may change it: you manage roles and it is below your own." }),
    givable: z.boolean().openapi({
      description:
        "Whether you may give it to people (invitations, requests, a person's roles): it is below your own and you hold every key it has.",
    }),
  })
  .openapi("OrgRole");

const PermissionArea = z
  .object({
    id: z.string(),
    use: z.array(z.string()).openapi({ description: 'The keys of the area\'s "use" level.' }),
    keys: z.array(z.string()).openapi({ description: 'Every key of the area: its "manage" level.' }),
  })
  .openapi("PermissionArea");

const RoleInput = z.object({
  name: z.string().min(1).max(ROLE_NAME_MAX),
  icon: z.string().max(40).optional(),
  color: z.string().max(40).optional(),
  permissions: z.array(z.string().max(60)).max(60).optional(),
  mentionable: z.boolean().optional(),
  hoist: z.boolean().optional(),
});

const RoleParams = OrgParams.extend({ roleId: z.uuid().openapi({ param: { name: "roleId", in: "path" } }) });
const MemberParams = OrgParams.extend({ userId: z.string().openapi({ param: { name: "userId", in: "path" } }) });

/**
 * A workspace's roles (ADR 0085): read by every member, changed by who may manage roles (and only the ones below
 * their own), given to people by who may manage people.
 */
export function roleRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/roles",
      tags,
      security,
      summary: "The workspace's roles, top first, and the permission areas",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            roles: z.array(OrgRole),
            areas: z.array(PermissionArea),
            colors: z.array(z.string()),
            icons: z.array(z.string()),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { roles, areas, colors, icons } = await listRoles(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        {
          roles,
          areas: areas.map((a) => ({ id: a.id, use: [...a.use], keys: [...a.keys] })),
          colors: [...colors],
          icons: [...icons],
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/roles",
      tags,
      security,
      summary: "Create a role (at the bottom, above everyone)",
      description: "Needs `manage_roles`; you can only give keys you hold yourself.",
      request: { params: OrgParams, body: body(RoleInput) },
      responses: { 201: json(z.object({ id: z.uuid() }), "Created"), ...errors },
    }),
    async (c) => {
      const role = await createRole(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"), {
        pubsub,
      });
      return c.json({ id: role.id }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/roles/{roleId}",
      tags,
      security,
      summary: "Change a role below yours",
      description: "`everyone` keeps its name, icon and switches: only its keys and color change.",
      request: { params: RoleParams, body: body(RoleInput.partial()) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, roleId } = c.req.valid("param");
      await updateRole(db, c.get("user").id, orgId, roleId, c.req.valid("json"), { pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/roles/{roleId}",
      tags,
      security,
      summary: "Delete a role below yours",
      description: "Whoever held it keeps their other roles. `everyone` can't be deleted.",
      request: { params: RoleParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, roleId } = c.req.valid("param");
      await deleteRole(db, c.get("user").id, orgId, roleId, { pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/roles/order",
      tags,
      security,
      summary: "Put the roles in this order, top first",
      description: "Every role but `everyone`, once. Roles at or above your own stay where they are.",
      request: { params: OrgParams, body: body(z.object({ ids: z.array(z.uuid()).max(200) })) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await reorderRoles(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json").ids, { pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/members/{userId}/roles",
      tags,
      security,
      summary: "Set a person's roles",
      description:
        "Needs `manage_members`. You only touch people below you (yourself aside) and roles below your own; an owner's roles only owners change.",
      request: {
        params: MemberParams,
        // The right hand's people card it was applied from, for the audit's "via" (ADR 0137 §4).
        query: z.object({ via: z.uuid().optional() }),
        body: body(z.object({ roleIds: z.array(z.uuid()).max(100) })),
      },
      responses: { 200: json(z.object({ roleIds: z.array(z.string()) })), ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      const roleIds = await setMemberRoles(db, c.get("user").id, orgId, userId, c.req.valid("json").roleIds, {
        pubsub,
        via: c.req.valid("query").via,
      });
      return c.json({ roleIds }, 200);
    },
  );

  return app;
}
